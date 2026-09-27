/*
 * 复用判别树审计（Worker 与 Node 测试共用）。
 *
 * 在既有最小色数 χ 下：
 *  1. 枚举全部「按通道标识规范化」的最优频段划分 —— 划分是集合意义上的，
 *     频段（颜色）名称置换不重复计数；每个划分以「受限增长串」表示
 *     （新频段按首次出现顺序编号），枚举本身即规范、无重复；
 *  2. 对候选划分集合构造精确的自适应二叉决策树：每一步选择一对通道做
 *     「是否被分到同一频段」的现场测量，按 相同 / 不同 分裂候选集合，
 *     递归求全局最少最坏深度；深度相同时按通道标识（i 再 j）稳定裁决，
 *     分支顺序固定为「相同」在前、「不同」在后。
 *
 * n ≤ 7 时候选划分数以 Bell 数 B7 = 877 为上界，子集用 BigInt 位掩码记忆化。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dsatur.js'));
  } else {
    root.Audit = factory(root.DSATUR);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (DSATUR) {
  'use strict';

  var MAX_AUDIT_CHANNELS = 7;

  // 32 位以内整数掩码的最低置位下标
  function lowbitIndex(x) {
    var i = 0;
    while ((x & 1) === 0) {
      x >>= 1;
      i++;
    }
    return i;
  }

  // BigInt 掩码的最低置位下标（候选数 ≤ 877）
  function bigLowbitIndex(b) {
    var i = 0;
    var x = b;
    while ((x & 1n) === 0n) {
      x >>= 1n;
      i++;
    }
    return i;
  }

  /*
   * 枚举恰使用 k 个频段的全部规范最优划分。
   * 顶点 v 只能：放入已有频段 c（要求与该频段内已着色顶点无干扰边），
   * 或在尚未用满 k 时开新频段（编号 = used，按首次出现顺序）。
   * 返回值为受限增长串数组（每项长度 n，取值 0..k-1），无颜色置换重复。
   */
  function enumerateOptimalPartitions(adj, n, k) {
    var partitions = [];
    var label = new Array(n).fill(-1);

    function rec(v, used) {
      if (used + (n - v) < k) return; // 剩余顶点全部开新频段也凑不满 k
      if (v === n) {
        if (used === k) partitions.push(label.slice());
        return;
      }
      var m = adj[v];
      for (var c = 0; c < used; c++) {
        var bits = m;
        var ok = true;
        while (bits) {
          var bit = bits & -bits;
          var u = lowbitIndex(bit);
          bits ^= bit;
          if (label[u] === c) {
            ok = false;
            break;
          }
        }
        if (ok) {
          label[v] = c;
          rec(v + 1, used);
          label[v] = -1;
        }
      }
      if (used < k) {
        label[v] = used;
        rec(v + 1, used + 1);
        label[v] = -1;
      }
    }

    rec(0, 0);
    return partitions;
  }

  /*
   * 精确自适应二叉决策树（最小最坏深度）。
   * 内部节点：{ i, j, same, different, depth }（same/different 为子树）
   * 叶子：{ leaf: 候选下标, depth: 0 }
   * 不分裂候选集合的测量对（结果预先确定，含干扰边两端）一律跳过；
   * 平局按 (i, j) 字典序裁决 —— 顶点下标即通道标识升序。
   */
  function buildDecisionTree(partitions, n) {
    var m = partitions.length;
    var full = 0n;
    for (var q0 = 0; q0 < m; q0++) full |= 1n << BigInt(q0);

    var pairMasks = [];
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        var sameMask = 0n;
        for (var q = 0; q < m; q++) {
          if (partitions[q][a] === partitions[q][b]) sameMask |= 1n << BigInt(q);
        }
        pairMasks.push({ i: a, j: b, same: sameMask, different: full ^ sameMask });
      }
    }

    var memo = new Map();
    function solve(mask) {
      if (mask !== 0n && (mask & (mask - 1n)) === 0n) {
        return { leaf: bigLowbitIndex(mask), depth: 0 };
      }
      var cached = memo.get(mask);
      if (cached) return cached;

      var best = null;
      for (var p = 0; p < pairMasks.length; p++) {
        var pm = pairMasks[p];
        var same = mask & pm.same;
        var different = mask & pm.different;
        if (same === 0n || different === 0n) continue; // 无信息量的测量
        var nodeSame = solve(same);
        var nodeDiff = solve(different);
        var depth = 1 + Math.max(nodeSame.depth, nodeDiff.depth);
        if (
          best === null ||
          depth < best.depth ||
          (depth === best.depth && (pm.i < best.i || (pm.i === best.i && pm.j < best.j)))
        ) {
          best = { i: pm.i, j: pm.j, same: nodeSame, different: nodeDiff, depth: depth };
        }
      }
      if (best === null) throw new Error('审计内部错误：存在多个候选却无任何可区分测量');
      memo.set(mask, best);
      return best;
    }

    return solve(full);
  }

  // 将内部树序列化为可传输 / 可渲染结构，并沿路径挂上已观测证据
  function serialize(root, partitions, n, k, channels) {
    function walk(node, evidence) {
      if (Object.prototype.hasOwnProperty.call(node, 'leaf')) {
        var part = partitions[node.leaf];
        var bands = [];
        for (var c = 0; c < k; c++) bands.push([]);
        for (var v = 0; v < n; v++) bands[part[v]].push(channels[v]);
        return {
          kind: 'leaf',
          count: 1,
          bands: bands,
          evidence: evidence.map(function (e) {
            return { pair: [channels[e.i], channels[e.j]], same: e.same };
          }),
        };
      }
      var sameNode = walk(node.same, evidence.concat([{ i: node.i, j: node.j, same: true }]));
      var diffNode = walk(
        node.different,
        evidence.concat([{ i: node.i, j: node.j, same: false }])
      );
      return {
        kind: 'branch',
        count: sameNode.count + diffNode.count,
        pair: [channels[node.i], channels[node.j]],
        depth: node.depth,
        same: sameNode,
        different: diffNode,
      };
    }
    return walk(root, []);
  }

  /*
   * 审计高层入口：通道标识（任意顺序）+ 无向干扰关系 ->
   * 最小色数、全部规范候选划分、最优判别树（含叶子证据）。
   * 超过 MAX_AUDIT_CHANNELS 个通道时拒绝审计（普通分配结论不受影响）。
   */
  function runAudit(ids, pairs) {
    var started = Date.now();
    if (ids.length > MAX_AUDIT_CHANNELS) {
      throw new Error(
        '复用判别树审计至多接受 ' + MAX_AUDIT_CHANNELS + ' 个通道的结论，当前为 ' + ids.length + ' 个。'
      );
    }
    var sorted = ids.slice().sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var n = sorted.length;
    var index = new Map();
    sorted.forEach(function (id, i) {
      index.set(id, i);
    });
    var adj = new Array(n).fill(0);
    pairs.forEach(function (pair) {
      var i = index.get(pair[0]);
      var j = index.get(pair[1]);
      adj[i] |= 1 << j;
      adj[j] |= 1 << i;
    });

    var k = DSATUR.exactColor(adj, n).k; // 既有最小色数
    var partitions = enumerateOptimalPartitions(adj, n, k);
    var root = buildDecisionTree(partitions, n);
    var tree = serialize(root, partitions, n, k, sorted);

    return {
      k: k,
      channels: sorted,
      candidateCount: partitions.length,
      depth: root.depth,
      tree: tree,
      elapsed: Date.now() - started,
    };
  }

  return {
    MAX_AUDIT_CHANNELS: MAX_AUDIT_CHANNELS,
    enumerateOptimalPartitions: enumerateOptimalPartitions,
    buildDecisionTree: buildDecisionTree,
    runAudit: runAudit,
  };
});
