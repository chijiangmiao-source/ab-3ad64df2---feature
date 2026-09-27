/*
 * verify 服务入口：代码测试 + 构建检查 + 页面 HTTP 冒烟。
 * 全部完成后退出，退出码 0 表示通过、1 表示存在失败。
 *
 * 用法：node verify/run.js   （WEB_URL 环境变量指向被测页面，默认 http://127.0.0.1:8080）
 */
'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DSATUR = require(path.join(ROOT, 'dsatur.js'));
const Validate = require(path.join(ROOT, 'validate.js'));
const Audit = require(path.join(ROOT, 'audit.js'));

const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function report(ok, name, err) {
  if (ok) {
    passed++;
    console.log(`ok ${passed + failed} - ${name}`);
  } else {
    failed++;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(
      String((err && err.stack) || err)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    );
  }
}

function test(name, fn) {
  try {
    fn();
    report(true, name);
  } catch (err) {
    report(false, name, err);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    report(true, name);
  } catch (err) {
    report(false, name, err);
  }
}

/* ---------- 工具：确定性伪随机与重排 ---------- */

function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// 录入重排：打乱通道顺序、打乱边的顺序并随机交换端点
function reorder(ids, pairs, rand) {
  const ids2 = ids.slice();
  for (let i = ids2.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids2[i], ids2[j]] = [ids2[j], ids2[i]];
  }
  const pairs2 = pairs
    .map((p) => (rand() < 0.5 ? [p[1], p[0]] : [p[0], p[1]]))
    .sort(() => rand() - 0.5);
  return [ids2, pairs2];
}

// 测试专用暴力色数（仅用于交叉验证，不属于产品代码）
function bruteChi(n, pairs) {
  const nbr = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) {
    nbr[a].push(b);
    nbr[b].push(a);
  }
  const color = new Array(n).fill(-1);
  function rec(v, k) {
    if (v === n) return true;
    for (let c = 0; c < k; c++) {
      let ok = true;
      for (const u of nbr[v]) {
        if (color[u] === c) {
          ok = false;
          break;
        }
      }
      if (ok) {
        color[v] = c;
        if (rec(v + 1, k)) return true;
        color[v] = -1;
      }
    }
    return false;
  }
  for (let k = 1; k <= n; k++) {
    if (rec(0, k)) return k;
  }
  return n;
}

/* ---------- 1. 代码测试：DSATUR 精确求解 ---------- */

test('三角冲突需要 3 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']]);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.lb, 3, '最大团下界应为 3');
  assert.deepStrictEqual(r.bands, [['A'], ['B'], ['C']]);
});

test('四通道完全冲突需要 4 个频段', () => {
  const ids = ['C1', 'C2', 'C3', 'C4'];
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) pairs.push([ids[i], ids[j]]);
  }
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 4);
  assert.strictEqual(r.lb, 4);
});

test('二分链式关系需要 2 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  assert.strictEqual(r.k, 2);
  assert.deepStrictEqual(r.bands, [['A', 'C'], ['B', 'D']]);
  assert.strictEqual(DSATUR.verifyAssignment([['A', 'B'], ['B', 'C'], ['C', 'D']], r.bandOf).length, 0);
});

test('奇环 C5 需要 3 个频段（下界 2 < 3，须经分支定界证明）', () => {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5'];
  const pairs = [['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']];
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.lb, 2, 'C5 最大团为 2');
  assert.ok(r.nodes > 0, '应实际执行分支定界搜索');
});

test('无干扰边时只需 1 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C'], []);
  assert.strictEqual(r.k, 1);
  assert.deepStrictEqual(r.bands, [['A', 'B', 'C']]);
});

test('录入重排后规范分配保持一致（三角 / K4 / 链式 / 组合图）', () => {
  const cases = [
    { ids: ['A', 'B', 'C'], pairs: [['A', 'B'], ['B', 'C'], ['A', 'C']] },
    {
      ids: ['C1', 'C2', 'C3', 'C4'],
      pairs: [['C1', 'C2'], ['C1', 'C3'], ['C1', 'C4'], ['C2', 'C3'], ['C2', 'C4'], ['C3', 'C4']],
    },
    { ids: ['A', 'B', 'C', 'D'], pairs: [['A', 'B'], ['B', 'C'], ['C', 'D']] },
    {
      ids: ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6'],
      pairs: [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH6'], ['CH4', 'CH6']],
    },
  ];
  const rand = lcg(20260926);
  for (const c of cases) {
    const base = DSATUR.solveGraph(c.ids, c.pairs);
    for (let t = 0; t < 8; t++) {
      const [ids2, pairs2] = reorder(c.ids, c.pairs, rand);
      const r = DSATUR.solveGraph(ids2, pairs2);
      assert.strictEqual(r.k, base.k, '重排后色数改变');
      assert.deepStrictEqual(r.bandOf, base.bandOf, '重排后规范分配改变');
      assert.deepStrictEqual(r.bands, base.bands, '重排后频段清单改变');
    }
  }
});

test('随机小图上与暴力色数一致（精确性交叉验证）', () => {
  const rand = lcg(1234567);
  let searched = 0;
  for (let t = 0; t < 200; t++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 个顶点
    const p = 0.15 + rand() * 0.6;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < p) pairs.push([i, j]);
      }
    }
    const adj = new Array(n).fill(0);
    for (const [a, b] of pairs) {
      adj[a] |= 1 << b;
      adj[b] |= 1 << a;
    }
    const res = DSATUR.exactColor(adj, n);
    const expect = bruteChi(n, pairs);
    assert.strictEqual(res.k, expect, `图 ${t} 色数不符：${JSON.stringify({ n, pairs })}`);
    assert.ok(res.lb <= res.k && res.k <= res.ub0, '下界/上界应夹住色数');
    if (res.nodes > 0) searched++;
  }
  assert.ok(searched > 0, '应有样例实际触发分支定界搜索');
});

test('随机图上录入重排后规范分配保持一致', () => {
  const rand = lcg(2026);
  for (let t = 0; t < 30; t++) {
    const n = 2 + Math.floor(rand() * 8); // 2..9
    const ids = Array.from({ length: n }, (_, i) => 'CH' + (i + 1));
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.4) pairs.push([ids[i], ids[j]]);
      }
    }
    const base = DSATUR.solveGraph(ids, pairs);
    for (let s = 0; s < 4; s++) {
      const [ids2, pairs2] = reorder(ids, pairs, rand);
      const r = DSATUR.solveGraph(ids2, pairs2);
      assert.deepStrictEqual(r.bandOf, base.bandOf, `图 ${t} 重排后规范分配改变`);
    }
  }
});

test('求解确定性：同一输入重复求解结论一致', () => {
  const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'];
  const pairs = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH1']];
  const a = DSATUR.solveGraph(ids, pairs);
  const b = DSATUR.solveGraph(ids, pairs);
  assert.deepStrictEqual(a.bandOf, b.bandOf);
  assert.strictEqual(a.nodes, b.nodes);
});

test('复核器能发现同频段冲突（负例）', () => {
  const v = DSATUR.verifyAssignment([['A', 'B']], { A: 1, B: 1 });
  assert.strictEqual(v.length, 1);
});

/* ---------- 2. 代码测试：录入校验定位 ---------- */

test('自环被定位提示', () => {
  const r = Validate.parseEdges('A B\nA A', new Set(['A', 'B']));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 2 行/);
  assert.match(r.errors[0].message, /自环/);
});

test('重复无向关系被定位提示（A B 与 B A 视为重复）', () => {
  const r = Validate.parseEdges('A B\nB A', new Set(['A', 'B']));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 2 行/);
  assert.match(r.errors[0].message, /重复/);
});

test('不存在端点被定位提示', () => {
  const r = Validate.parseEdges('A Z', new Set(['A', 'B']));
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 1 行/);
  assert.match(r.errors[0].message, /「Z」/);
});

test('通道数量边界：少于 2 个、多于 26 个、重复标识', () => {
  assert.ok(Validate.parseChannels('ONLY1').errors.some((e) => /至少需要 2 个/.test(e.message)));
  const many = Array.from({ length: 27 }, (_, i) => 'C' + i).join(' ');
  assert.ok(Validate.parseChannels(many).errors.some((e) => /至多允许 26 个/.test(e.message)));
  const dup = Validate.parseChannels('A B A');
  assert.ok(dup.errors.some((e) => /重复/.test(e.message) && /第 3 个/.test(e.message)));
  assert.strictEqual(Validate.parseChannels('A B').errors.length, 0);
});

test('干扰关系条数上限 120 条', () => {
  const ids = Array.from({ length: 26 }, (_, i) => 'C' + i);
  const set = new Set(ids);
  const lines = [];
  outer: for (let i = 0; i < 26; i++) {
    for (let j = i + 1; j < 26; j++) {
      lines.push(`C${i} C${j}`);
      if (lines.length === 121) break outer;
    }
  }
  assert.strictEqual(Validate.parseEdges(lines.slice(0, 120).join('\n'), set).errors.length, 0);
  const over = Validate.parseEdges(lines.join('\n'), set);
  assert.ok(over.errors.some((e) => /至多允许 120 条/.test(e.message)));
});

test('干扰关系行格式错误被定位提示', () => {
  const r = Validate.parseEdges('A B C', new Set(['A', 'B', 'C']));
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 1 行/);
  assert.match(r.errors[0].message, /恰好两个/);
});

/* ---------- 2b. 代码测试：复用判别树审计 ---------- */

// 独立暴力枚举：给每顶点分配 0..k-1 标签，要求恰用 k 色且为合法着色，
// 再按首次出现顺序规范化去重 —— 与产品 RGS 枚举是两种独立写法，用于交叉验证。
function brutePartitions(n, pairs, k) {
  const nbr = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) {
    nbr[a].push(b);
    nbr[b].push(a);
  }
  const set = new Set();
  const color = new Array(n);
  function rec(v) {
    if (v === n) {
      if (new Set(color).size !== k) return;
      const map = new Map();
      let next = 0;
      const canon = color.map((c) => {
        if (!map.has(c)) map.set(c, next++);
        return map.get(c);
      });
      set.add(canon.join(','));
      return;
    }
    for (let c = 0; c < k; c++) {
      let ok = true;
      for (const u of nbr[v]) {
        if (u < v && color[u] === c) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      color[v] = c;
      rec(v + 1);
    }
  }
  rec(0);
  return set;
}

// 模拟判别树：让每个候选划分沿与其颜色码一致的回答路径下行
function simulateTree(tree, channels, code) {
  const idx = new Map(channels.map((id, i) => [id, i]));
  let node = tree;
  let depth = 0;
  const path = [];
  while (!node.leaf) {
    const a = idx.get(node.pair[0]);
    const b = idx.get(node.pair[1]);
    const outcome = code[a] === code[b] ? 'same' : 'diff';
    path.push({ pair: node.pair.slice(), outcome });
    node = outcome === 'same' ? node.same : node.diff;
    depth++;
  }
  return { leaf: node.candidate, depth, evidence: node.evidence, path };
}

function collectLeaves(node, acc) {
  if (node.leaf) acc.push(node);
  else {
    collectLeaves(node.same, acc);
    collectLeaves(node.diff, acc);
  }
  return acc;
}

// 校验树的全局性质：每候选唯一落到对应叶子、证据一致、最坏深度吻合、每次比较确有区分度
function assertTreeSound(audit) {
  const leaves = collectLeaves(audit.tree, []);
  assert.strictEqual(leaves.length, audit.candidateCount, '叶子数应等于候选数');
  assert.strictEqual(new Set(leaves.map((l) => l.candidate)).size, audit.candidateCount, '叶子必须一一对应候选');
  let maxDepth = 0;
  audit.candidates.forEach((cand, ci) => {
    const sim = simulateTree(audit.tree, audit.channels, cand.code);
    assert.strictEqual(sim.leaf, ci, `候选 ${ci} 未被判别到自身叶子`);
    maxDepth = Math.max(maxDepth, sim.depth);
    assert.strictEqual(sim.depth, sim.evidence.length, '叶子证据条数应等于实际测量次数');
    sim.path.forEach((step, t) => {
      assert.deepStrictEqual(step.pair, sim.evidence[t].pair, '证据比较对应与路径一致');
      assert.strictEqual(step.outcome, sim.evidence[t].outcome, '证据结论应与路径回答一致');
    });
  });
  assert.strictEqual(maxDepth, audit.worstDepth, '模拟得到的最坏深度应与建树结果一致');

  (function checkNode(node, candidateMask) {
    if (node.leaf) {
      assert.strictEqual(candidateMask.size, 1, '叶子候选必须唯一');
      return;
    }
    const sameSet = new Set();
    const diffSet = new Set();
    for (const ci of candidateMask) {
      const code = audit.candidates[ci].code;
      const pos = new Map(audit.channels.map((id, i) => [id, i]));
      const same = code[pos.get(node.pair[0])] === code[pos.get(node.pair[1])];
      (same ? sameSet : diffSet).add(ci);
    }
    assert.ok(sameSet.size > 0 && diffSet.size > 0, '内部节点每次比较必须同时分出相同 / 不同候选');
    checkNode(node.same, sameSet);
    checkNode(node.diff, diffSet);
    assert.strictEqual(node.depth, 1 + Math.max(node.same.depth, node.diff.depth), '节点最坏深度递归式不成立');
  })(audit.tree, new Set(audit.candidates.map((_, i) => i)));
}

test('审计：无干扰 3 通道 χ=1 时候选唯一、无需测量', () => {
  const a = Audit.runAudit(['A', 'B', 'C'], [], 1);
  assert.strictEqual(a.candidateCount, 1);
  assert.strictEqual(a.worstDepth, 0);
  assert.strictEqual(a.firstPair, null);
  assert.deepStrictEqual(a.candidates[0].bands, [['A', 'B', 'C']]);
  assertTreeSound(a);
});

test('审计：单边 2 通道 χ=2 时候选唯一、无需测量', () => {
  const a = Audit.runAudit(['A', 'B'], [['A', 'B']], 2);
  assert.strictEqual(a.candidateCount, 1);
  assert.strictEqual(a.worstDepth, 0);
  assertTreeSound(a);
});

test('审计：三角冲突 χ=3 划分唯一', () => {
  const a = Audit.runAudit(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']], 3);
  assert.strictEqual(a.candidateCount, 1);
  assert.strictEqual(a.worstDepth, 0);
  assert.deepStrictEqual(a.candidates[0].bands, [['A'], ['B'], ['C']]);
});

test('审计：两条不相连边 AB、CD（χ=2）有 2 个候选，一次测量即可区分，首个比较稳定为 A-C', () => {
  const a = Audit.runAudit(['A', 'B', 'C', 'D'], [['A', 'B'], ['C', 'D']], 2);
  assert.strictEqual(a.candidateCount, 2);
  assert.strictEqual(a.worstDepth, 1);
  assert.deepStrictEqual(a.firstPair, ['A', 'C']);
  const bands = a.candidates.map((c) => c.bands.map((g) => g.join('')).join('|')).sort();
  assert.deepStrictEqual(bands, ['AC|BD', 'AD|BC']);
  assertTreeSound(a);
});

test('审计：单边 4 通道 χ=2 有 4 个候选，最少最坏 2 次，首个比较稳定为 A-C', () => {
  const a = Audit.runAudit(['A', 'B', 'C', 'D'], [['A', 'B']], 2);
  assert.strictEqual(a.candidateCount, 4);
  assert.strictEqual(a.worstDepth, 2);
  assert.deepStrictEqual(a.firstPair, ['A', 'C']);
  assertTreeSound(a);
});

test('审计：候选枚举与独立暴力枚举在随机小图上完全一致', () => {
  const rand = lcg(7654321);
  for (let t = 0; t < 120; t++) {
    const n = 2 + Math.floor(rand() * 6); // 2..7
    const p = 0.1 + rand() * 0.55;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < p) pairs.push([i, j]);
      }
    }
    const ids = Array.from({ length: n }, (_, i) => 'CH' + (i + 1));
    const namedPairs = pairs.map(([x, y]) => [ids[x], ids[y]]);
    const adj = new Array(n).fill(0);
    for (const [a, b] of pairs) {
      adj[a] |= 1 << b;
      adj[b] |= 1 << a;
    }
    const k = DSATUR.exactColor(adj, n).k;
    const a = Audit.runAudit(ids, namedPairs, k);
    const expected = brutePartitions(n, pairs, k);
    const actual = new Set(a.candidates.map((c) => c.code.join(',')));
    assert.strictEqual(actual.size, a.candidates.length, '候选不得因颜色置换重复');
    assert.strictEqual(a.candidateCount, expected.size, `图 ${t}（n=${n}）候选数与暴力枚举不符`);
    for (const key of expected) assert.ok(actual.has(key), `缺少候选 ${key}`);
    for (const key of actual) assert.ok(expected.has(key), `多出候选 ${key}`);
    assertTreeSound(a);
    // 页面展示的规范解必须属于候选集合（按频段串比对，与颜色名称无关）
    const solKey = DSATUR.solveGraph(ids, namedPairs)
      .bands.map((g) => g.join(''))
      .sort()
      .join('|');
    const hasSol = a.candidates.some(
      (c) =>
        c.bands
          .map((g) => g.join(''))
          .sort()
          .join('|') === solKey
    );
    assert.ok(hasSol, '当前规范解应在审计候选集合中');
  }
});

test('审计：判别树最坏深度达到信息论下界 ceil(log2(候选数))', () => {
  // 信息论下界：深度 d 的二叉树至多 2^d 个叶子
  const rand = lcg(999);
  for (let t = 0; t < 60; t++) {
    const n = 2 + Math.floor(rand() * 6);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.35) pairs.push([i, j]);
      }
    }
    const ids = Array.from({ length: n }, (_, i) => 'N' + (i + 1));
    const named = pairs.map(([x, y]) => [ids[x], ids[y]]);
    const k = DSATUR.solveGraph(ids, named).k;
    const a = Audit.runAudit(ids, named, k);
    const lbDepth = Math.ceil(Math.log2(a.candidateCount));
    assert.ok(a.worstDepth >= lbDepth, '最坏深度不得低于信息论下界');
    assertTreeSound(a);
  }
});

test('审计：重复运行与录入重排后枚举和判别树保持一致', () => {
  const cases = [
    { ids: ['A', 'B', 'C', 'D'], pairs: [['A', 'B']] },
    { ids: ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'], pairs: [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH5', 'CH1']] },
    { ids: ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7'], pairs: [['X1', 'X2'], ['X3', 'X4'], ['X5', 'X6']] },
  ];
  const rand = lcg(424242);
  for (const c of cases) {
    const k = DSATUR.solveGraph(c.ids, c.pairs).k;
    const base = Audit.runAudit(c.ids, c.pairs, k);
    const again = Audit.runAudit(c.ids, c.pairs, k);
    assert.strictEqual(again.candidateCount, base.candidateCount);
    assert.strictEqual(again.worstDepth, base.worstDepth);
    assert.deepStrictEqual(again.tree, base.tree, '判别树必须确定');
    for (let s = 0; s < 5; s++) {
      const [ids2, pairs2] = reorder(c.ids, c.pairs, rand);
      const r = Audit.runAudit(ids2, pairs2, k);
      assert.strictEqual(r.candidateCount, base.candidateCount);
      assert.strictEqual(r.worstDepth, base.worstDepth);
      assert.deepStrictEqual(r.firstPair, base.firstPair, '重排后首个比较应一致');
      assert.deepStrictEqual(r.tree, base.tree, '重排后判别树应一致');
    }
  }
});

test('审计：超过 7 个通道只拒绝审计（不影响普通求解）', () => {
  const ids = Array.from({ length: 8 }, (_, i) => 'C' + (i + 1));
  assert.throws(
    () => Audit.runAudit(ids, [], 1),
    /超过审计上限 7/,
  );
  const r = DSATUR.solveGraph(ids, []);
  assert.strictEqual(r.k, 1, '超范围审计不应影响普通分配结论');
});

/* ---------- 3. 构建检查 ---------- */

test('构建检查：关键文件存在、JS 语法有效、页面引用完整', () => {
  const files = [
    'index.html',
    'styles.css',
    'main.js',
    'worker.js',
    'dsatur.js',
    'audit.js',
    'validate.js',
    'server.js',
    'Dockerfile',
    'compose.yaml',
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少文件 ${f}`);
  }
  const jsFiles = ['main.js', 'worker.js', 'dsatur.js', 'audit.js', 'validate.js', 'server.js', 'verify/run.js'];
  for (const f of jsFiles) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('src="validate.js"') && html.includes('src="main.js"'), 'index.html 脚本引用缺失');
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(mainJs.includes("new Worker('worker.js')"), 'main.js 未在 Worker 中求解');
  const workerJs = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  assert.ok(workerJs.includes("importScripts('dsatur.js'"), 'worker.js 未加载求解器');
  assert.ok(workerJs.includes("'audit.js'"), 'worker.js 未加载审计模块');
});

/* ---------- 4. 页面 HTTP 冒烟 ---------- */

async function fetchWithRetry(url, attempts, delayMs) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

async function smoke() {
  const targets = [
    ['/', (body) => body.includes('束流诊断柜') && body.includes('id="channels"') && body.includes('id="edges"')],
    ['/main.js', (body) => body.includes('new Worker')],
    ['/worker.js', (body) => body.includes('importScripts')],
    ['/dsatur.js', (body) => body.includes('solveGraph')],
    ['/audit.js', (body) => body.includes('runAudit')],
    ['/validate.js', (body) => body.includes('parseChannels')],
    ['/styles.css', (body) => body.includes('resultPanel')],
    ['/healthz', (body) => body.includes('ok')],
  ];
  for (const [p, check] of targets) {
    await testAsync(`HTTP 冒烟 GET ${p}`, async () => {
      const res = await fetchWithRetry(WEB_URL + p, 12, 500);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(check(body), '响应缺少预期标记');
    });
  }
}

/* ---------- 主流程 ---------- */

(async () => {
  await smoke();
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
