/* 后台 Worker：频段分配求解（DSATUR 分支定界）与复用判别树审计。 */
importScripts('dsatur.js', 'audit.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  try {
    var res;
    if (msg.kind === 'audit') {
      res = Audit.runAudit(msg.channels, msg.edges, msg.k);
      res.type = 'audit-result';
    } else {
      res = DSATUR.solveGraph(msg.channels, msg.edges);
      res.type = 'result';
    }
    res.jobId = msg.jobId;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: msg.jobId,
      message: String((err && err.message) || err),
    });
  }
};
