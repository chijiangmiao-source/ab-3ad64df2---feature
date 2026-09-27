/*
 * 页面主逻辑：录入校验、Worker 调度、结论渲染、复用判别树审计。
 *
 * 过期任务防护：jobSeq 单调递增，任何「编辑 / 取消 / 再次提交（求解或审计）」都会
 * 使其前进并终止在跑的 Worker；Worker 回包必须携带当前 jobId 且仍是当前 Worker，
 * 否则一律丢弃 —— 迟到的旧任务（含旧审计的枚举与判别树）不得覆盖当前草稿或新结论。
 */
(function () {
  'use strict';

  var AUDIT_LIMIT = 7;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var channelsEl = $('channels');
  var edgesEl = $('edges');
  var submitBtn = $('submit');
  var cancelBtn = $('cancel');
  var auditBtn = $('audit');
  var auditHintEl = $('auditHint');
  var statusEl = $('status');
  var errorsEl = $('errors');
  var resultPanel = $('resultPanel');
  var staleEl = $('stale');
  var summaryEl = $('summary');
  var assignmentBody = document.querySelector('#assignment tbody');
  var bandsEl = $('bands');
  var verificationEl = $('verification');
  var auditPanel = $('auditPanel');
  var auditStaleEl = $('auditStale');
  var auditSummaryEl = $('auditSummary');
  var auditMetaEl = $('auditMeta');
  var auditTreeEl = $('auditTree');

  var jobSeq = 0; // 任务序号：编辑 / 取消 / 提交 / 审计时递增
  var worker = null; // 当前在跑的 Worker（若有）
  // 最近一次「新鲜」分配结论（编辑后即失效）；审计只能基于它发起
  var currentResult = null;

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    cancelBtn.disabled = true;
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function showErrors(messages) {
    errorsEl.textContent = '';
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      errorsEl.appendChild(li);
    });
  }

  function clearResults() {
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    summaryEl.textContent = '';
    assignmentBody.textContent = '';
    bandsEl.textContent = '';
    verificationEl.textContent = '';
    clearAudit();
    currentResult = null;
    auditBtn.disabled = true;
    auditHintEl.textContent = '';
  }

  function clearAudit() {
    auditPanel.hidden = true;
    auditPanel.classList.remove('stale-on');
    auditStaleEl.hidden = true;
    auditSummaryEl.textContent = '';
    auditMetaEl.textContent = '';
    auditTreeEl.textContent = '';
  }

  function markStale() {
    if (!resultPanel.hidden) {
      resultPanel.classList.add('stale-on');
      staleEl.hidden = false;
    }
    if (!auditPanel.hidden) {
      auditPanel.classList.add('stale-on');
      auditStaleEl.hidden = false;
    }
    // 结论一旦过期，审计入口关闭；旧审计面板仅作灰显留存，不代表当前草稿
    currentResult = null;
    auditBtn.disabled = true;
    auditHintEl.textContent = '结论已失效，请重新提交求解后再发起审计。';
  }

  function onEdit() {
    jobSeq++; // 使任何在途旧任务（含旧审计）的结果失效
    stopWorker();
    markStale();
    setStatus('输入已修改，既有结论已失效，请重新提交。', 'muted');
  }
  channelsEl.addEventListener('input', onEdit);
  edgesEl.addEventListener('input', onEdit);

  cancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    setStatus('已取消当前任务。', 'muted');
  });

  function validate() {
    var ch = Validate.parseChannels(channelsEl.value);
    var ed = Validate.parseEdges(edgesEl.value, new Set(ch.channels));
    var errors = ch.errors.concat(ed.errors).map(function (e) {
      return e.message;
    });
    return { ok: errors.length === 0, channels: ch.channels, edges: ed.edges, errors: errors };
  }

  function renderResult(msg, edges) {
    resultPanel.hidden = false;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;

    summaryEl.textContent =
      '最少频段数 χ = ' +
      msg.k +
      '；可证明下界（最大团）= ' +
      msg.lb +
      '；初始可行上界 = ' +
      msg.ub +
      '；分支定界节点 = ' +
      msg.nodes +
      '；耗时 ' +
      msg.elapsed +
      ' ms。';

    assignmentBody.textContent = '';
    msg.channels.forEach(function (id) {
      var tr = document.createElement('tr');
      var tdId = document.createElement('td');
      tdId.textContent = id;
      var tdBand = document.createElement('td');
      tdBand.textContent = '频段 ' + msg.bandOf[id];
      tr.appendChild(tdId);
      tr.appendChild(tdBand);
      assignmentBody.appendChild(tr);
    });

    bandsEl.textContent = '';
    msg.bands.forEach(function (members, i) {
      var li = document.createElement('li');
      li.textContent =
        '频段 ' + (i + 1) + '（' + members.length + ' 个通道）：' + members.join('、') + ' —— 组内无干扰边';
      bandsEl.appendChild(li);
    });

    // 主线程复核：每条干扰边两端必须落在不同频段，结论可复算
    var bad = edges.filter(function (pair) {
      return msg.bandOf[pair[0]] === msg.bandOf[pair[1]];
    });
    var covered = msg.channels.every(function (id) {
      return msg.bandOf[id] >= 1 && msg.bandOf[id] <= msg.k;
    });
    if (bad.length === 0 && covered && msg.bands.length === msg.k) {
      verificationEl.textContent =
        '复核通过：' + edges.length + ' 条干扰边的两端均分属不同频段，各频段内部不存在干扰边。';
      verificationEl.className = 'ok-text';
    } else {
      verificationEl.textContent = '复核失败：求解结果与输入不一致，请重新提交。';
      verificationEl.className = 'error-text';
    }

    // 审计入口：仅在结论新鲜时可用；超过 7 通道只拒绝审计，普通结论保持可用
    currentResult = { channels: msg.channels.slice(), edges: edges.map(function (p) { return p.slice(); }), k: msg.k };
    if (msg.channels.length <= AUDIT_LIMIT) {
      auditBtn.disabled = false;
      auditHintEl.textContent = '当前 ' + msg.channels.length + ' 个通道，可发起复用判别树审计。';
    } else {
      auditBtn.disabled = true;
      auditHintEl.textContent =
        '当前 ' + msg.channels.length + ' 个通道，超过 ' + AUDIT_LIMIT + ' 个，拒绝审计；普通分配结论仍可正常使用。';
    }
  }

  function partitionText(bands) {
    return bands
      .map(function (members, i) {
        return '频段' + (i + 1) + '{' + members.join('、') + '}';
      })
      .join(' | ');
  }

  function renderEvidence(evidence) {
    if (evidence.length === 0) {
      var none = document.createElement('p');
      none.className = 'evidence';
      none.textContent = '已观测证据：无（候选划分唯一，无需现场测量）。';
      return none;
    }
    var wrap = document.createElement('p');
    wrap.className = 'evidence';
    wrap.textContent = '已观测证据：';
    evidence.forEach(function (e, idx) {
      if (idx > 0) wrap.appendChild(document.createTextNode('；'));
      var code = document.createElement('code');
      code.textContent = e.pair[0] + ' 与 ' + e.pair[1] + (e.outcome === 'same' ? ' 同频段' : ' 不同频段');
      wrap.appendChild(code);
    });
    wrap.appendChild(document.createTextNode('。'));
    return wrap;
  }

  function renderTreeNode(node, candidates) {
    var div = document.createElement('div');
    if (node.leaf) {
      div.className = 'tree-node leaf';
      var title = document.createElement('p');
      title.className = 'leaf-title';
      title.textContent = '叶子：唯一频段划分';
      div.appendChild(title);

      var cand = candidates[node.candidate];
      var bands = document.createElement('p');
      bands.className = 'leaf-bands';
      bands.textContent = partitionText(cand.bands);
      div.appendChild(bands);

      div.appendChild(renderEvidence(node.evidence));
      return div;
    }

    div.className = 'tree-node internal';
    var details = document.createElement('details');
    details.open = true;
    var summary = document.createElement('summary');
    summary.textContent =
      '测量 ' +
      node.pair[0] +
      ' 与 ' +
      node.pair[1] +
      ' 是否同频段（该子树最坏还需 ' +
      node.depth +
      ' 次测量）';
    details.appendChild(summary);

    var branches = document.createElement('div');
    branches.className = 'branches';

    var sameBranch = document.createElement('div');
    sameBranch.className = 'branch same-branch';
    var sameTag = document.createElement('span');
    sameTag.className = 'tag tag-same';
    sameTag.textContent = '相同';
    sameBranch.appendChild(sameTag);
    sameBranch.appendChild(renderTreeNode(node.same, candidates));

    var diffBranch = document.createElement('div');
    diffBranch.className = 'branch diff-branch';
    var diffTag = document.createElement('span');
    diffTag.className = 'tag tag-diff';
    diffTag.textContent = '不同';
    diffBranch.appendChild(diffTag);
    diffBranch.appendChild(renderTreeNode(node.diff, candidates));

    branches.appendChild(sameBranch);
    branches.appendChild(diffBranch);
    details.appendChild(branches);
    div.appendChild(details);
    return div;
  }

  function renderAudit(msg) {
    auditPanel.hidden = false;
    auditPanel.classList.remove('stale-on');
    auditStaleEl.hidden = true;

    auditSummaryEl.textContent =
      '以最小色数 χ = ' +
      msg.k +
      ' 共枚举到 ' +
      msg.candidateCount +
      ' 个按通道标识规范化的不同最优频段划分（颜色名称置换不重复计数）；' +
      '区分全部划分的最少最坏测量次数 = ' +
      msg.worstDepth +
      (msg.firstPair ? '；首个比较：' + msg.firstPair[0] + ' 与 ' + msg.firstPair[1] + ' 是否同频段。' : '；候选划分唯一，无需测量。');

    auditMetaEl.textContent =
      '判别树为精确自适应二叉决策树：每步选择通道对后按现场测量「相同 / 不同」二分候选并递归求全局最少最坏深度；' +
      '深度相同时按通道标识及分支顺序稳定裁决。枚举与建树耗时 ' +
      msg.elapsed +
      ' ms。';

    auditTreeEl.textContent = '';
    auditTreeEl.appendChild(renderTreeNode(msg.tree, msg.candidates));

    // 完整候选集合可展开核对：审计针对全部枚举划分，而非当前展示的一种方案
    var allDetails = document.createElement('details');
    allDetails.className = 'candidate-list';
    var allSummary = document.createElement('summary');
    allSummary.textContent = '全部 ' + msg.candidateCount + ' 个候选最优频段划分（点击展开核对）';
    allDetails.appendChild(allSummary);
    var ol = document.createElement('ol');
    msg.candidates.forEach(function (cand) {
      var li = document.createElement('li');
      li.textContent = partitionText(cand.bands);
      ol.appendChild(li);
    });
    allDetails.appendChild(ol);
    auditTreeEl.appendChild(allDetails);
  }

  function submit() {
    jobSeq++;
    stopWorker();
    showErrors([]);

    var v = validate();
    if (!v.ok) {
      clearResults(); // 清除既有成功证据（含旧审计）
      showErrors(v.errors);
      setStatus('输入校验失败：请按提示定位并修正后重新提交。', 'error');
      return;
    }

    var jobId = jobSeq;
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    clearAudit(); // 旧审计的枚举 / 树不得覆盖或混入新结论
    auditBtn.disabled = true;
    auditHintEl.textContent = '';
    setStatus('求解中（Worker 内执行确定性 DSATUR 分支定界）…', 'busy');

    var w = new Worker('worker.js');
    worker = w;
    cancelBtn.disabled = false;

    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧任务，丢弃
      stopWorker();
      if (msg.type === 'error') {
        setStatus('求解失败：' + msg.message, 'error');
        return;
      }
      renderResult(msg, v.edges);
      setStatus('求解完成。', 'ok');
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      setStatus('Worker 执行异常：' + (ev.message || '未知错误'), 'error');
    };
    w.postMessage({ jobId: jobId, channels: v.channels, edges: v.edges });
  }
  submitBtn.addEventListener('click', submit);

  function submitAudit() {
    if (!currentResult) return; // 结论缺失或已失效，拒绝
    var base = currentResult;
    if (base.channels.length > AUDIT_LIMIT) {
      // 超范围只拒绝审计，不触碰普通分配结论
      setStatus('通道数超过 ' + AUDIT_LIMIT + ' 个，拒绝审计；普通分配结论保持可用。', 'error');
      return;
    }

    jobSeq++;
    stopWorker();
    var jobId = jobSeq;
    auditPanel.hidden = true;
    auditPanel.classList.remove('stale-on');
    auditStaleEl.hidden = true;
    setStatus('审计中（Worker 内枚举全部最优划分并构造精确自适应判别树）…', 'busy');

    var w = new Worker('worker.js');
    worker = w;
    cancelBtn.disabled = false;

    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧审计，丢弃
      stopWorker();
      if (msg.type === 'error') {
        setStatus('审计失败：' + msg.message, 'error');
        return;
      }
      renderAudit(msg);
      setStatus('审计完成。', 'ok');
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      setStatus('Worker 执行异常：' + (ev.message || '未知错误'), 'error');
    };
    w.postMessage({
      jobId: jobId,
      kind: 'audit',
      channels: base.channels,
      edges: base.edges,
      k: base.k,
    });
  }
  auditBtn.addEventListener('click', submitAudit);

  var EXAMPLES = {
    triangle: {
      channels: 'CH1 CH2 CH3',
      edges: 'CH1 CH2\nCH2 CH3\nCH1 CH3',
    },
    k4: {
      channels: 'CH1 CH2 CH3 CH4',
      edges: 'CH1 CH2\nCH1 CH3\nCH1 CH4\nCH2 CH3\nCH2 CH4\nCH3 CH4',
    },
    chain: {
      channels: 'CH1 CH2 CH3 CH4',
      edges: 'CH1 CH2\nCH2 CH3\nCH3 CH4',
    },
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-example]'), function (btn) {
    btn.addEventListener('click', function () {
      var ex = EXAMPLES[btn.getAttribute('data-example')];
      channelsEl.value = ex.channels;
      edgesEl.value = ex.edges;
      onEdit();
      setStatus('已载入示例，点击「提交求解」。', 'muted');
    });
  });
})();
