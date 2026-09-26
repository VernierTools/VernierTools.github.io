/* =========================================================================
   STMap generator — worker.js
   tasks.js の処理を別スレッドで実行する受け口。
   ========================================================================= */
/* global importScripts */
"use strict";
importScripts("models.js", "exr.js", "png16.js", "fit.js", "tasks.js");

self.onmessage = function (e) {
  var d = e.data, id = d.id;
  function progress(f) { self.postMessage({ id: id, progress: f }); }
  Promise.resolve().then(function () { return self.STTasks[d.cmd](d.payload, progress); }).then(function (res) {
    var transfer = res && res.buffer ? [res.buffer] : [];
    self.postMessage({ id: id, result: res }, transfer);
  }, function (err) {
    self.postMessage({ id: id, error: String(err && err.message || err) });
  });
};
