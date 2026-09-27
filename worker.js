/* 频段分配求解 Worker：在后台线程执行确定性 DSATUR 分支定界与复用判别树审计。 */
importScripts('dsatur.js', 'audit.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  try {
    var res;
    if (msg.kind === 'audit') {
      res = Audit.runAudit(msg.channels, msg.edges);
    } else {
      res = DSATUR.solveGraph(msg.channels, msg.edges);
    }
    res.type = 'result';
    res.kind = msg.kind || 'solve';
    res.jobId = msg.jobId;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({
      type: 'error',
      kind: msg.kind || 'solve',
      jobId: msg.jobId,
      message: String((err && err.message) || err),
    });
  }
};
