"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/probe.worker.js
   疎通確認用ワーカー。decode.js の probe() を呼ぶだけ。
   ========================================================================= */
importScripts("vendor/mp4box.all.min.js", "decode.js");

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.cmd !== "probe") return;

  var t0 = (self.performance && performance.now) ? performance.now() : Date.now();

  FSDecode.probe(msg.buffer, { sampleFrames: msg.sampleFrames || 60 })
    .then(function (report) {
      var t1 = (self.performance && performance.now) ? performance.now() : Date.now();
      report.elapsedMs = Math.round(t1 - t0);
      self.postMessage({ ok: true, report: report });
    })
    .catch(function (err) {
      self.postMessage({ ok: false, error: String((err && err.message) || err) });
    });
};
