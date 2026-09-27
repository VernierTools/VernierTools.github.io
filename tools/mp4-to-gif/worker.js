/* =========================================================================
   Video to GIF — worker.js
   GIF の減色・圧縮を別スレッドで行う。index.html は Worker が使えない環境では
   同じ GIFEnc.encodeGIF をメインスレッドで呼ぶ。
   ========================================================================= */
/* global importScripts, GIFEnc */
"use strict";
importScripts("gif.js");

self.onmessage = function (e) {
  var d = e.data;
  try {
    var frames = d.frames.map(function (b) { return new Uint8ClampedArray(b); });
    d.opts.onProgress = function (f) { self.postMessage({ progress: f }); };
    var r = GIFEnc.encodeGIF(frames, d.opts);
    self.postMessage({ result: { bytes: r.bytes.buffer, frames: r.frames } }, [r.bytes.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
