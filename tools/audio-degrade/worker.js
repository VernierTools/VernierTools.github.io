/* =========================================================================
   Audio degradation simulator — worker.js
   劣化の計算を別スレッドで行う。index.html は Worker が使えない環境では
   同じ Degrade.render をメインスレッドで呼ぶ。
   ========================================================================= */
/* global importScripts, Degrade */
"use strict";
importScripts("dsp.js");

self.onmessage = function (e) {
  var d = e.data;
  try {
    var ch = d.channels.map(function (b) { return new Float32Array(b); });
    var out = Degrade.render(ch, d.fs, d.medium, d.params, {
      seed: d.seed, generations: d.generations, matchLevel: d.matchLevel,
      onProgress: function (f) { self.postMessage({ id: d.id, progress: f }); }
    });
    var bufs = out.map(function (x) { return x.buffer; });
    self.postMessage({ id: d.id, result: bufs }, bufs);
  } catch (err) {
    self.postMessage({ id: d.id, error: String(err && err.message || err) });
  }
};
