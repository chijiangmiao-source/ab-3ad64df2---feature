/*
 * 页面主逻辑：录入校验、Worker 调度、结论渲染、复用判别树审计。
 *
 * 过期任务防护：jobSeq 单调递增，任何「编辑 / 取消 / 再次提交 / 发起审计」都会
 * 使其前进并终止在跑的 Worker；Worker 回包必须携带当前 jobId 且仍是当前 Worker，
 * 否则一律丢弃 —— 迟到的旧任务（含旧审计的枚举与判别树）不得覆盖当前草稿或新结论。
 */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };
  var channelsEl = $('channels');
  var edgesEl = $('edges');
  var submitBtn = $('submit');
  var cancelBtn = $('cancel');
  var statusEl = $('status');
  var errorsEl = $('errors');
  var resultPanel = $('resultPanel');
  var staleEl = $('stale');
  var summaryEl = $('summary');
  var assignmentBody = document.querySelector('#assignment tbody');
  var bandsEl = $('bands');
  var verificationEl = $('verification');
  var auditBtn = $('audit');
  var auditStatusEl = $('auditStatus');
  var auditPanel = $('auditPanel');
  var auditSummaryEl = $('auditSummary');
  var auditTreeEl = $('auditTree');

  var jobSeq = 0; // 任务序号：编辑 / 取消 / 提交 / 发起审计时递增
  var worker = null; // 当前在跑的 Worker（若有）
  var lastInput = null; // 最近一次成功分配结论对应的输入（通道已按标识排序）

  function auditAllowed() {
    return !!lastInput && lastInput.channels.length <= Audit.MAX_AUDIT_CHANNELS;
  }

  function refreshAuditButton() {
    auditBtn.disabled = !auditAllowed();
  }

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    cancelBtn.disabled = true;
    refreshAuditButton(); // 结论仍有效时允许再次发起审计
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function setAuditStatus(text, cls) {
    auditStatusEl.textContent = text;
    auditStatusEl.className = cls || '';
  }

  function showErrors(messages) {
    errorsEl.textContent = '';
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      errorsEl.appendChild(li);
    });
  }

  function clearAudit() {
    auditPanel.hidden = true;
    auditTreeEl.textContent = '';
    auditSummaryEl.textContent = '';
    setAuditStatus('', '');
  }

  function clearResults() {
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    summaryEl.textContent = '';
    assignmentBody.textContent = '';
    bandsEl.textContent = '';
    verificationEl.textContent = '';
    lastInput = null;
    clearAudit();
    refreshAuditButton();
  }

  function markStale() {
    if (!resultPanel.hidden) {
      resultPanel.classList.add('stale-on');
      staleEl.hidden = false;
      lastInput = null; // 旧结论已失效，不得再对其发起审计
      clearAudit(); // 旧审计随旧结论一并失效
      refreshAuditButton();
    }
  }

  function onEdit() {
    jobSeq++; // 使任何在途旧任务的结论 / 审计失效
    stopWorker();
    markStale();
    setStatus('输入已修改，既有结论已失效，请重新提交。', 'muted');
  }
  channelsEl.addEventListener('input', onEdit);
  edgesEl.addEventListener('input', onEdit);

  cancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    clearAudit();
    setStatus('已取消本次任务。', 'muted');
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

    lastInput = { channels: msg.channels, edges: edges };
    refreshAuditButton();
  }

  /* ---------- 复用判别树审计渲染 ---------- */

  // 主线程复核叶子划分：各频段内部不得存在干扰边
  function leafBandOf(node) {
    var bandOf = {};
    node.bands.forEach(function (members, i) {
      members.forEach(function (id) {
        bandOf[id] = i + 1;
      });
    });
    return bandOf;
  }

  function renderLeaf(node, edges) {
    var box = document.createElement('div');
    box.className = 'audit-leaf';

    var title = document.createElement('p');
    title.className = 'audit-leaf-title';
    title.textContent = '✔ 叶子：唯一频段划分';
    box.appendChild(title);

    var ul = document.createElement('ul');
    node.bands.forEach(function (members, i) {
      var li = document.createElement('li');
      li.textContent = '频段 ' + (i + 1) + '：' + (members.length ? members.join('、') : '（空）');
      ul.appendChild(li);
    });
    box.appendChild(ul);

    var ev = document.createElement('p');
    ev.className = 'audit-evidence';
    if (node.evidence.length === 0) {
      ev.textContent = '已观测证据：候选划分唯一，无需任何现场测量。';
    } else {
      ev.textContent =
        '已观测证据：' +
        node.evidence
          .map(function (e) {
            return '测量（' + e.pair[0] + '，' + e.pair[1] + '）= ' + (e.same ? '相同' : '不同');
          })
          .join('；') +
        '。';
    }
    box.appendChild(ev);

    var bandOf = leafBandOf(node);
    var bad = edges.filter(function (pair) {
      return bandOf[pair[0]] === bandOf[pair[1]];
    });
    var check = document.createElement('p');
    if (bad.length === 0) {
      check.textContent = '主线程复核通过：该划分与全部干扰关系一致。';
      check.className = 'ok-text audit-check';
    } else {
      check.textContent = '主线程复核失败：叶子划分与干扰关系不一致。';
      check.className = 'error-text audit-check';
    }
    box.appendChild(check);
    return box;
  }

  function renderBranch(node, edges, open) {
    var box = document.createElement('div');
    box.className = 'audit-branch';

    var ask = document.createElement('p');
    ask.className = 'audit-ask';
    ask.innerHTML = '';
    ask.appendChild(document.createTextNode('测量 '));
    var strong = document.createElement('strong');
    strong.textContent = node.pair[0] + ' 与 ' + node.pair[1];
    ask.appendChild(strong);
    ask.appendChild(
      document.createTextNode(
        ' 是否被分到同一频段？（当前候选 ' +
          node.count +
          ' 个；该子树最坏再需 ' +
          node.depth +
          ' 次测量）'
      )
    );
    box.appendChild(ask);

    var children = document.createElement('div');
    children.className = 'audit-children';

    var sameDetails = document.createElement('details');
    if (open) sameDetails.open = true;
    var sameSummary = document.createElement('summary');
    sameSummary.textContent =
      '观测「相同」→ 保留候选 ' + node.same.count + ' 个，最坏再需 ' + node.same.depth + ' 次';
    sameDetails.appendChild(sameSummary);
    sameDetails.appendChild(renderNode(node.same, edges, false));
    children.appendChild(sameDetails);

    var diffDetails = document.createElement('details');
    if (open) diffDetails.open = true;
    var diffSummary = document.createElement('summary');
    diffSummary.textContent =
      '观测「不同」→ 保留候选 ' +
      node.different.count +
      ' 个，最坏再需 ' +
      node.different.depth +
      ' 次';
    diffDetails.appendChild(diffSummary);
    diffDetails.appendChild(renderNode(node.different, edges, false));
    children.appendChild(diffDetails);

    box.appendChild(children);
    return box;
  }

  function renderNode(node, edges, open) {
    return node.kind === 'leaf'
      ? renderLeaf(node, edges)
      : renderBranch(node, edges, open);
  }

  function renderAudit(msg, edges) {
    auditPanel.hidden = false;
    auditSummaryEl.textContent =
      '最小色数 χ = ' +
      msg.k +
      '；按通道标识规范化的不同最优划分共 ' +
      msg.candidateCount +
      ' 个；全局最少最坏测量次数 = ' +
      msg.depth +
      '；首个比较 = ' +
      (msg.tree.kind === 'branch'
        ? '（' + msg.tree.pair[0] + '，' + msg.tree.pair[1] + '）'
        : '无（候选划分唯一，零次测量即可确定）') +
      '；耗时 ' +
      msg.elapsed +
      ' ms。';
    auditTreeEl.textContent = '';
    auditTreeEl.appendChild(renderNode(msg.tree, edges, msg.tree.kind === 'branch'));
  }

  /* ---------- Worker 调度 ---------- */

  function startJob(kind, payload, onResult) {
    jobSeq++;
    stopWorker();
    var jobId = jobSeq;
    var w = new Worker('worker.js');
    worker = w;
    cancelBtn.disabled = false;
    auditBtn.disabled = true; // 任务在跑期间不得对旧结论发起审计

    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧任务，丢弃
      stopWorker();
      if (msg.type === 'error') {
        onResult(new Error(msg.message), null);
        return;
      }
      onResult(null, msg);
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      onResult(new Error((ev.message || '未知错误')), null);
    };
    var data = Object.assign({ jobId: jobId, kind: kind }, payload);
    w.postMessage(data);
    return jobId;
  }

  function submit() {
    showErrors([]);

    var v = validate();
    if (!v.ok) {
      jobSeq++;
      stopWorker();
      clearResults(); // 清除既有成功证据
      showErrors(v.errors);
      setStatus('输入校验失败：请按提示定位并修正后重新提交。', 'error');
      return;
    }

    clearAudit();
    lastInput = null; // 新结果未出前，旧结论不得再被审计
    refreshAuditButton();
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    setStatus('求解中（Worker 内执行确定性 DSATUR 分支定界）…', 'busy');

    startJob('solve', { channels: v.channels, edges: v.edges }, function (err, msg) {
      if (err) {
        setStatus('求解失败：' + err.message, 'error');
        return;
      }
      renderResult(msg, v.edges);
      setStatus('求解完成。', 'ok');
    });
  }
  submitBtn.addEventListener('click', submit);

  function audit() {
    if (!lastInput) return;
    if (lastInput.channels.length > Audit.MAX_AUDIT_CHANNELS) {
      // 超出范围只拒绝审计，普通分配结论保持可用
      clearAudit();
      setAuditStatus(
        '复用判别树审计至多接受 ' +
          Audit.MAX_AUDIT_CHANNELS +
          ' 个通道的结论（当前 ' +
          lastInput.channels.length +
          ' 个）；频段分配结论不受影响。',
        'error'
      );
      return;
    }
    var input = lastInput;
    clearAudit();
    setAuditStatus('审计中：枚举全部规范最优划分并构造精确自适应判别树…', 'busy');
    startJob('audit', { channels: input.channels, edges: input.edges }, function (err, msg) {
      if (err) {
        // 普通分配结论仍有效，只在审计状态行报错
        setAuditStatus('审计失败：' + err.message, 'error');
        return;
      }
      renderAudit(msg, input.edges);
      setAuditStatus('审计完成：判别树为全局最少最坏深度。', 'ok');
    });
  }
  auditBtn.addEventListener('click', audit);

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
