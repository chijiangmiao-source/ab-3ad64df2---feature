/*
 * 复用判别树审计（Worker 与 Node 测试共用）。
 *
 * 两步精确构造：
 *  1. 枚举：以现有最小色数 χ 枚举全部可行的最优频段划分。DFS 按通道标识升序
 *     逐顶点着色，采用「限制增长串（RGS）」规范形式 —— 顶点只能加入已有色类
 *     或按序开新类，因此同一集合划分恰好生成一次，颜色名称置换不会重复计数；
 *     同时以色类顶点掩码强制每个色类都是独立集（组内无干扰边）。
 *  2. 判别树：对候选划分集合构造精确的自适应二叉决策树。每个内部节点选择一个
 *     通道对 (i,j)，现场测量结果二分为「相同 / 不同」两个候选子集；递归求出
 *     全局最少的最坏深度 1 + max(d(相同), d(不同))。通道对按通道标识升序枚举、
 *     仅以严格更优深度替换当前最优，故深度相同时按通道标识及分支顺序稳定裁决。
 *
 * 审计范围不超过 7 个通道（候选为集合划分，Bell(7)=877 上界，规模可控）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Audit = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MAX_AUDIT_CHANNELS = 7;

  function sortChannels(ids) {
    return ids.slice().sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  function buildAdj(sorted, pairs) {
    var n = sorted.length;
    var index = new Map();
    sorted.forEach(function (id, i) {
      index.set(id, i);
    });
    var adj = new Array(n).fill(0);
    pairs.forEach(function (pair) {
      var i = index.get(pair[0]);
      var j = index.get(pair[1]);
      if (i === undefined || j === undefined) {
        throw new Error('干扰关系包含未知端点: ' + pair[0] + ' ' + pair[1]);
      }
      adj[i] |= 1 << j;
      adj[j] |= 1 << i;
    });
    return adj;
  }

  /*
   * 枚举全部使用恰好 k 个非空独立色类的规范划分（限制增长串）。
   * 返回若干颜色码数组，code[v] 为顶点 v 所在色类（0..k-1）。
   */
  function enumerateCodes(adj, n, k) {
    var codes = [];
    var color = new Array(n).fill(-1);
    var classMask = new Array(k).fill(0); // 每个色类当前包含的顶点掩码

    function rec(i, used) {
      if (i === n) {
        if (used === k) codes.push(color.slice());
        return;
      }
      if (used + (n - i) < k) return; // 剩余顶点全部开新类也凑不齐 k 个非空色类
      // 加入已有色类（编号升序；与该色类已有顶点存在干扰边则禁止）
      for (var c = 0; c < used; c++) {
        if (adj[i] & classMask[c]) continue;
        color[i] = c;
        classMask[c] |= 1 << i;
        rec(i + 1, used);
        classMask[c] &= ~(1 << i);
        color[i] = -1;
      }
      // 开下一个规范新色类（RGS 保证每个集合划分只生成一次）
      if (used < k) {
        color[i] = used;
        classMask[used] = 1 << i;
        rec(i + 1, used + 1);
        classMask[used] = 0;
        color[i] = -1;
      }
    }

    rec(0, 0);
    return codes;
  }

  function compareCode(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function bigPopCount(x) {
    var c = 0;
    while (x) {
      x &= x - 1n;
      c++;
    }
    return c;
  }

  function singleBitIndex(x) {
    var i = 0;
    while ((x & 1n) === 0n) {
      x >>= 1n;
      i++;
    }
    return i;
  }

  /*
   * 精确自适应二叉决策树。
   * candidates: [{code, bands}]，候选子集以候选下标的 BigInt 位掩码表示。
   * 通道对按 (i 升序, j 升序) 排列，遍历时严格取最小最坏深度，首个即稳定最优。
   */
  function buildTree(candidates, n) {
    var m = candidates.length;
    var pairs = [];
    var i, j, t;
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) pairs.push([i, j]);
    }

    // 每个通道对的「相同」候选掩码；干扰边对在任何合法着色中恒为不同，掩码自然为 0
    var sameMasks = pairs.map(function (p) {
      var mask = 0n;
      for (t = 0; t < m; t++) {
        if (candidates[t].code[p[0]] === candidates[t].code[p[1]]) {
          mask |= 1n << BigInt(t);
        }
      }
      return mask;
    });

    var memo = new Map();
    function solve(mask) {
      var hit = memo.get(mask);
      if (hit !== undefined) return hit;
      var node;
      if (bigPopCount(mask) === 1) {
        node = { leaf: true, depth: 0, index: singleBitIndex(mask) };
      } else {
        node = null;
        for (var pi = 0; pi < pairs.length; pi++) {
          var same = mask & sameMasks[pi];
          var diff = mask & ~sameMasks[pi];
          if (same === 0n || diff === 0n) continue; // 该对在当前候选集上结论恒定，测量无信息量
          var ns = solve(same);
          var nd = solve(diff);
          var depth = 1 + Math.max(ns.depth, nd.depth);
          if (node === null || depth < node.depth) {
            node = { leaf: false, depth: depth, pair: pi, same: ns, diff: nd };
          }
        }
      }
      memo.set(mask, node);
      return node;
    }

    var full = (1n << BigInt(m)) - 1n;
    return { root: solve(full), pairs: pairs };
  }

  // 序列化为可 postMessage 的纯数据；path 记录沿程已观测证据（相同 / 不同）
  function serialize(node, pairs, channels, path) {
    if (node.leaf) {
      return {
        leaf: true,
        depth: 0,
        candidate: node.index,
        evidence: path.map(function (e) {
          return { pair: e.pair.slice(), outcome: e.outcome };
        }),
      };
    }
    var p = pairs[node.pair];
    var pairIds = [channels[p[0]], channels[p[1]]];
    return {
      leaf: false,
      depth: node.depth,
      pair: pairIds.slice(),
      same: serialize(node.same, pairs, channels, path.concat([{ pair: pairIds, outcome: 'same' }])),
      diff: serialize(node.diff, pairs, channels, path.concat([{ pair: pairIds, outcome: 'diff' }])),
    };
  }

  /*
   * 高层入口：通道标识 + 无向干扰关系 + 现有最小色数 -> 枚举结论与判别树。
   */
  function runAudit(ids, pairs, k) {
    var started = Date.now();
    var sorted = sortChannels(ids);
    var n = sorted.length;
    k = Number(k);
    if (!Number.isInteger(k) || k < 1 || k > n) {
      throw new Error('审计色数非法：' + String(k));
    }
    if (n > MAX_AUDIT_CHANNELS) {
      throw new Error('通道数为 ' + n + '，超过审计上限 ' + MAX_AUDIT_CHANNELS + '，拒绝审计。');
    }

    var adj = buildAdj(sorted, pairs);
    var codes = enumerateCodes(adj, n, k).sort(compareCode);
    if (codes.length === 0) {
      throw new Error('枚举失败：不存在使用 ' + k + ' 个频段的可行最优划分，结论可能已过期。');
    }

    var seen = new Set();
    var candidates = codes.map(function (code) {
      var key = code.join(',');
      if (seen.has(key)) throw new Error('枚举内部错误：划分重复 ' + key);
      seen.add(key);
      var bands = [];
      for (var c = 0; c < k; c++) bands.push([]);
      code.forEach(function (cv, v) {
        bands[cv].push(sorted[v]);
      });
      return { code: code.slice(), bands: bands };
    });

    var built = buildTree(candidates, n);
    var tree = serialize(built.root, built.pairs, sorted, []);
    return {
      channels: sorted,
      k: k,
      candidateCount: candidates.length,
      candidates: candidates,
      worstDepth: built.root.depth,
      firstPair: tree.leaf ? null : tree.pair,
      tree: tree,
      elapsed: Date.now() - started,
    };
  }

  return {
    MAX_AUDIT_CHANNELS: MAX_AUDIT_CHANNELS,
    runAudit: runAudit,
    enumerateCodes: enumerateCodes,
  };
});
