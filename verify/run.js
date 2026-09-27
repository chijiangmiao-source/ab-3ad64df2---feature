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
const Audit = require(path.join(ROOT, 'audit.js'));
const Validate = require(path.join(ROOT, 'validate.js'));

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

/* ---------- 1b. 代码测试：复用判别树审计 ---------- */

function adjFrom(n, pairs) {
  const adj = new Array(n).fill(0);
  for (const [i, j] of pairs) {
    adj[i] |= 1 << j;
    adj[j] |= 1 << i;
  }
  return adj;
}

// 独立参考枚举：遍历全部 k-着色（恰好 k 色），规范化为受限增长串后去重
function brutePartitions(adj, n, k) {
  const seen = new Set();
  const out = [];
  const col = new Array(n).fill(-1);
  function canon() {
    const map = new Map();
    let next = 0;
    let key = '';
    for (const x of col) {
      if (!map.has(x)) map.set(x, next++);
      key += map.get(x) + ',';
    }
    return key;
  }
  function rec(v) {
    if (v === n) {
      if (new Set(col).size !== k) return;
      const key = canon();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key.slice(0, -1).split(',').map(Number));
      }
      return;
    }
    for (let c = 0; c < k; c++) {
      let m = adj[v];
      let ok = true;
      while (m) {
        const bit = m & -m;
        m ^= bit;
        let u = 0;
        let x = bit;
        while (x > 1) {
          x >>= 1;
          u++;
        }
        if (col[u] === c) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      col[v] = c;
      rec(v + 1);
      col[v] = -1;
    }
  }
  rec(0);
  return out;
}

test('候选划分数：完全图为 1、无干扰边为 Stirling 数、边+孤立点为 2', () => {
  const k3Edges = [[0, 1], [1, 2], [0, 2]];
  assert.strictEqual(Audit.enumerateOptimalPartitions(adjFrom(3, k3Edges), 3, 3).length, 1);
  // 空图 χ=1 时划分唯一；χ 更大时按第二类 Stirling 数 S(n,k)
  assert.strictEqual(Audit.enumerateOptimalPartitions(adjFrom(4, []), 4, 2).length, 7);
  assert.strictEqual(Audit.enumerateOptimalPartitions(adjFrom(4, []), 4, 3).length, 6);
  assert.strictEqual(Audit.enumerateOptimalPartitions(adjFrom(7, []), 7, 3).length, 301);
  // 一条边 + 一个孤立点，χ=2：孤立点二选一，恰 2 个规范划分
  assert.deepStrictEqual(Audit.enumerateOptimalPartitions(adjFrom(3, [[0, 1]]), 3, 2), [
    [0, 1, 0],
    [0, 1, 1],
  ]);
});

test('枚举均为合法 χ 色划分且无颜色置换重复（受限增长串）', () => {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'];
  const pairs = [['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']];
  const r = Audit.runAudit(ids, pairs); // C5 + 2 孤立点
  const n = 7;
  const adj = adjFrom(
    n,
    pairs.map(([a, b]) => [Number(a.slice(1)) - 1, Number(b.slice(1)) - 1])
  );
  const P = Audit.enumerateOptimalPartitions(adj, n, r.k);
  assert.strictEqual(P.length, r.candidateCount);
  const keys = new Set();
  P.forEach((part) => {
    // 每条干扰边两端不同色，且恰好使用 k 色
    for (const [i, j] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 0],
    ]) {
      assert.notStrictEqual(part[i], part[j]);
    }
    assert.strictEqual(new Set(part).size, r.k);
    // 受限增长串：每个颜色首次出现时编号连续（无颜色名称置换重复）
    let max = -1;
    part.forEach((c) => {
      assert.ok(c <= max + 1);
      if (c > max) max = c;
    });
    const key = part.join(',');
    assert.ok(!keys.has(key), '出现重复规范划分');
    keys.add(key);
  });
  assert.strictEqual(P.length, 45);
});

test('随机小图上枚举与独立暴力（规范化去重）完全一致', () => {
  const rand = lcg(7777);
  let checked = 0;
  for (let t = 0; t < 300; t++) {
    const n = 2 + Math.floor(rand() * 6); // 2..7
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) if (rand() < 0.35) pairs.push([i, j]);
    }
    const adj = adjFrom(n, pairs);
    const k = DSATUR.exactColor(adj, n).k;
    const ours = Audit.enumerateOptimalPartitions(adj, n, k)
      .map((r) => r.join(','))
      .sort();
    const brute = brutePartitions(adj, n, k)
      .map((r) => r.join(','))
      .sort();
    assert.deepStrictEqual(ours, brute, `图 ${JSON.stringify({ n, pairs, k })} 枚举不一致`);
    checked++;
  }
  assert.ok(checked > 0);
});

test('判别树最坏深度全局最少（独立子集 DP 交叉验证）与稳定首个比较', () => {
  // 独立最小最坏深度：对指标子集做记忆化 minimax
  function independentSolver(P, n) {
    const full = (1 << P.length) - 1;
    const memo = new Map();
    function split(mask, i, j) {
      let s = 0;
      let d = 0;
      let m = mask;
      while (m) {
        const b = m & -m;
        m ^= b;
        let q = 0;
        let x = b;
        while (x > 1) {
          x >>= 1;
          q++;
        }
        if (P[q][i] === P[q][j]) s |= b;
        else d |= b;
      }
      return [s, d];
    }
    function dp(mask) {
      if ((mask & (mask - 1)) === 0) return mask === 0 ? Infinity : 0;
      if (memo.has(mask)) return memo.get(mask);
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const [s, d] = split(mask, i, j);
          if (s === 0 || d === 0) continue;
          const dep = 1 + Math.max(dp(s), dp(d));
          if (dep < best) best = dep;
        }
      }
      memo.set(mask, best);
      return best;
    }
    const opt = dp(full);
    // 根节点首个比较：达到最优深度的对中按 (i,j) 字典序最小者
    let first = null;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const [s, d] = split(full, i, j);
        if (s === 0 || d === 0) continue;
        if (1 + Math.max(dp(s), dp(d)) === opt) {
          first = [i, j];
          break outer;
        }
      }
    }
    return { opt: opt, first: first };
  }

  const rand = lcg(909);
  let compared = 0;
  for (let t = 0; t < 80; t++) {
    const n = 2 + Math.floor(rand() * 5); // 2..6，控制子集 DP 规模
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) if (rand() < 0.3) pairs.push([i, j]);
    }
    const adj = adjFrom(n, pairs);
    const k = DSATUR.exactColor(adj, n).k;
    const P = Audit.enumerateOptimalPartitions(adj, n, k);
    if (P.length < 2 || P.length > 20) continue;
    const tree = Audit.buildDecisionTree(P, n);
    const ref = independentSolver(P, n);
    assert.strictEqual(tree.depth, ref.opt, `图 ${t} 最坏深度非全局最少`);
    assert.deepStrictEqual([tree.i, tree.j], ref.first, `图 ${t} 平局首个比较不稳定`);
    compared++;
  }
  assert.ok(compared > 0, '应至少有一例多候选图参与深度交叉验证');
});

test('边+孤立点：首个比较按通道标识稳定裁决为孤立点比较（0,2）', () => {
  const P = Audit.enumerateOptimalPartitions(adjFrom(3, [[0, 1]]), 3, 2);
  const tree = Audit.buildDecisionTree(P, 3);
  assert.strictEqual(tree.i, 0);
  assert.strictEqual(tree.j, 2);
  assert.strictEqual(tree.depth, 1);
  assert.ok(tree.same.leaf === 0 || tree.same.leaf === 1);
  assert.ok(tree.different.leaf === 1 - tree.same.leaf);
});

test('判别树叶子给出唯一划分与已观测证据，且证据与划分一致', () => {
  const r = Audit.runAudit(['A', 'B', 'C'], [['A', 'B']]);
  assert.strictEqual(r.candidateCount, 2);
  assert.strictEqual(r.depth, 1);
  const leaves = [];
  (function walk(node, path) {
    if (node.kind === 'leaf') {
      leaves.push([path, node]);
      return;
    }
    walk(node.same, path.concat([[node.pair, true]]));
    walk(node.different, path.concat([[node.pair, false]]));
  })(r.tree, []);
  assert.strictEqual(leaves.length, 2);
  const seen = new Set();
  leaves.forEach(([path, leaf]) => {
    assert.strictEqual(leaf.count, 1);
    const key = JSON.stringify(leaf.bands);
    assert.ok(!seen.has(key));
    seen.add(key);
    assert.strictEqual(path.length, 1);
    const [[a, b], same] = path[0];
    // 叶子划分必须与沿程证据一致
    const bandOf = {};
    leaf.bands.forEach((members, i) => members.forEach((x) => (bandOf[x] = i + 1)));
    assert.strictEqual(bandOf[a] === bandOf[b], same);
  });
});

test('候选划分唯一时零测量：三角冲突 / 完全图 / 链式二分图', () => {
  const tri = Audit.runAudit(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']]);
  assert.strictEqual(tri.candidateCount, 1);
  assert.strictEqual(tri.depth, 0);
  assert.strictEqual(tri.tree.kind, 'leaf');
  assert.deepStrictEqual(tri.tree.bands, [['A'], ['B'], ['C']]);
  assert.strictEqual(tri.tree.evidence.length, 0);
  const chain = Audit.runAudit(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  assert.strictEqual(chain.candidateCount, 1);
  assert.strictEqual(chain.depth, 0);
});

test('C5 加两个孤立点：45 个候选、树可区分且结果对录入重排不变', () => {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'];
  const pairs = [['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']];
  const r = Audit.runAudit(ids, pairs);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.candidateCount, 45);
  assert.ok(r.depth >= Math.ceil(Math.log2(45))); // 信息下界
  // 录入重排（通道与端点顺序）后，按标识规范化结果一致
  const rand = lcg(31337);
  for (let t = 0; t < 4; t++) {
    const [ids2, pairs2] = reorder(ids, pairs, rand);
    const r2 = Audit.runAudit(ids2, pairs2);
    assert.strictEqual(r2.candidateCount, r.candidateCount);
    assert.strictEqual(r2.depth, r.depth);
    assert.deepStrictEqual(JSON.stringify(r2.tree), JSON.stringify(r.tree));
  }
});

test('超过 7 个通道只拒绝审计（普通分配结论不受影响）', () => {
  assert.strictEqual(Audit.MAX_AUDIT_CHANNELS, 7);
  const ids = Array.from({ length: 8 }, (_, i) => 'C' + (i + 1));
  assert.throws(() => Audit.runAudit(ids, []), /至多接受 7 个通道/);
  // 同一输入普通求解仍然可用
  const sol = DSATUR.solveGraph(ids, []);
  assert.strictEqual(sol.k, 1);
});

test('审计确定性：重复运行候选集合、最坏深度与树完全一致', () => {
  const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'];
  const pairs = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH1']];
  const a = Audit.runAudit(ids, pairs);
  const b = Audit.runAudit(ids, pairs);
  assert.strictEqual(a.candidateCount, b.candidateCount);
  assert.strictEqual(a.depth, b.depth);
  assert.deepStrictEqual(JSON.stringify(a.tree), JSON.stringify(b.tree));
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
  assert.ok(html.includes('src="audit.js"'), 'index.html 缺少 audit.js 引用');
  assert.ok(html.includes('id="auditPanel"'), '页面缺少审计结果面板');
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(mainJs.includes("new Worker('worker.js')"), 'main.js 未在 Worker 中求解');
  assert.ok(mainJs.includes("startJob('audit'"), 'main.js 未发起审计任务');
  const workerJs = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  assert.ok(workerJs.includes("importScripts('dsatur.js'"), 'worker.js 未加载求解器');
  assert.ok(workerJs.includes("audit.js"), 'worker.js 未加载审计模块');
  assert.ok(workerJs.includes("Audit.runAudit"), 'worker.js 未路由审计请求');
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
