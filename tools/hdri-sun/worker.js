/* =========================================================================
   HDRI sun finder — worker.js
   HDRI を読み込みながら、作業用の大きさ（横 maxW まで）に面積平均で縮める。
   面積平均は明るさの合計（= 光の量）を保つので、縮めても太陽の強さの推定に使える。
   あわせて元の解像度での最大の明るさと、その値に張り付いた画素の数（白飛びの手がかり）を数える。
   ========================================================================= */
importScripts("../../shared/hdrimage.js");

self.onmessage = function (ev) {
  var maxW = ev.data.maxW || 2048;
  var W = 0, H = 0, Wd = 0, Hd = 0, data = null, cnt = null, xmap = null, ymap = null;
  var maxL = 0, maxX = 0, maxY = 0, atMax = 0;
  HdrImage.decode(ev.data.buffer, function (y, r, g, b) {
    var o = ymap[y] * Wd;
    for (var i = 0; i < W; i++) {
      var R = r[i], G = g[i], B = b[i], L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      var t = o + xmap[i];
      data[t * 3] += R; data[t * 3 + 1] += G; data[t * 3 + 2] += B; cnt[t]++;
      if (L > maxL * 1.001) { maxL = L; maxX = i; maxY = y; atMax = 1; }
      else if (L >= maxL * 0.999) atMax++;
    }
  }, function (f) {
    self.postMessage({ type: "progress", value: f });
  }, function (w, h) {
    W = w; H = h; Wd = Math.min(W, maxW); Hd = Math.max(1, Math.round(Wd * H / W));
    data = new Float32Array(Wd * Hd * 3); cnt = new Float32Array(Wd * Hd);
    xmap = new Int32Array(W); ymap = new Int32Array(H);
    for (var x = 0; x < W; x++) xmap[x] = Math.min(Wd - 1, Math.floor(x * Wd / W));
    for (var y = 0; y < H; y++) ymap[y] = Math.min(Hd - 1, Math.floor(y * Hd / H));
  }).then(function (info) {
    for (var p = 0; p < Wd * Hd; p++) {
      var c = cnt[p] || 1; data[p * 3] /= c; data[p * 3 + 1] /= c; data[p * 3 + 2] /= c;
    }
    self.postMessage({ type: "done", W: W, H: H, Wd: Wd, Hd: Hd, data: data, format: info.format, compression: info.compression,
      maxL: maxL, maxX: maxX, maxY: maxY, atMax: atMax }, [data.buffer]);
  }).catch(function (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  });
};
