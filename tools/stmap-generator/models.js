/* =========================================================================
   STMap generator — models.js
   レンズ歪みモデルと STMap 生成。ブラウザ（<script>）/ Worker / jsc の全部で動く。

   座標規約（Blender コンポジター・Nuke と一致）:
     - ピクセル座標は左下原点。ピクセル i の中心は i + 0.5
     - STMap の値 = 参照先のピクセル座標 ÷ 元画像の寸法（W, H）
   式は Blender の libmv（intern/libmv/libmv/simple_pipeline/distortion_models.h）を正とする。
   ========================================================================= */
(function (root) {
  "use strict";

  /* ---- モデル定義 ----
     norm: "focal" … 正規化座標 = (px − 中心) / 焦点距離(px)
           "half"  … 正規化座標 = (px − 中心) / (max(W, H) / 2)（焦点距離に依存しない）
     fwd:  "distort"   … 公式が「真っ直ぐ → 歪み」を表す（Polynomial・Division・Brown）
           "undistort" … 公式が「歪み → 真っ直ぐ」を表す（Nuke）
     f(k, x, y) は公式そのもの。反対向きはニュートン法で解く。 */
  var MODELS = {
    "blender-polynomial": {
      norm: "focal", fwd: "distort", params: ["k1", "k2", "k3"],
      f: function (k, x, y) {
        var r2 = x * x + y * y, rc = 1 + k.k1 * r2 + k.k2 * r2 * r2 + k.k3 * r2 * r2 * r2;
        return [x * rc, y * rc];
      }
    },
    "blender-division": {
      norm: "focal", fwd: "distort", params: ["k1", "k2"],
      f: function (k, x, y) {
        var r2 = x * x + y * y, d = 1 + k.k1 * r2 + k.k2 * r2 * r2;
        return [x / d, y / d];
      }
    },
    "blender-brown": {
      norm: "focal", fwd: "distort", params: ["k1", "k2", "k3", "k4", "p1", "p2"],
      f: function (k, x, y) {
        // libmv ApplyBrownDistortionModel: P1 が x 側の (r²+2x²) に掛かる（OpenCV とは P1/P2 が逆）
        var x2 = x * x, y2 = y * y, xy2 = 2 * x * y, r2 = x2 + y2;
        var rc = 1 + (((k.k4 * r2 + k.k3) * r2 + k.k2) * r2 + k.k1) * r2;
        return [x * rc + k.p1 * (r2 + 2 * x2) + k.p2 * xy2,
                y * rc + k.p2 * (r2 + 2 * y2) + k.p1 * xy2];
      }
    },
    "blender-nuke": {
      norm: "half", fwd: "undistort", params: ["k1", "k2", "p1", "p2"],
      f: function (k, x, y) {
        // libmv InvertNukeDistortionModel: P1/P2 は接線歪みではなく Nuke アナモフィックの k2/k3
        var x2 = x * x, y2 = y * y, r2 = x2 + y2, r4 = r2 * r2;
        return [x / (1 + k.k1 * r2 + k.k2 * r4 + k.p1 * y2),
                y / (1 + k.k1 * r2 + k.k2 * r4 + k.p2 * x2)];
      }
    }
  };
  var ALL_PARAMS = ["k1", "k2", "k3", "k4", "p1", "p2"];

  /* ---- カメラ ----
     opts: { model, W, H, focalPx, ppx, ppy, k1..k4, p1, p2 }
     ppx/ppy は Blender の光学中心（正規化 −1〜1。中心 + 値 × 寸法/2）。 */
  function camera(opts) {
    var m = MODELS[opts.model];
    if (!m) throw new Error("Unknown model: " + opts.model);
    var k = {};
    ALL_PARAMS.forEach(function (p) { k[p] = m.params.indexOf(p) >= 0 ? (+opts[p] || 0) : 0; });
    return {
      model: m, W: opts.W, H: opts.H, k: k,
      cx: opts.W / 2 * (1 + opts.ppx),
      cy: opts.H / 2 * (1 + opts.ppy),
      s: m.norm === "half" ? Math.max(opts.W, opts.H) / 2 : opts.focalPx
    };
  }

  /* 2次元ニュートン法: f(x, y) = (tx, ty) を解く。ヤコビアンは中心差分。
     戻り値 [x, y, ok]。初期値は (tx, ty)（歪みが無ければそのまま解）。 */
  var NEWTON_TOL = 1e-12, NEWTON_MAX = 30;
  function solve(f, k, tx, ty, gx, gy) {
    var x = gx, y = gy, h = 1e-7;
    for (var it = 0; it < NEWTON_MAX; it++) {
      var v = f(k, x, y), ex = v[0] - tx, ey = v[1] - ty;
      if (Math.abs(ex) < NEWTON_TOL && Math.abs(ey) < NEWTON_TOL) return [x, y, true];
      var ax = f(k, x + h, y), bx = f(k, x - h, y), ay = f(k, x, y + h), by = f(k, x, y - h);
      var j11 = (ax[0] - bx[0]) / (2 * h), j12 = (ay[0] - by[0]) / (2 * h);
      var j21 = (ax[1] - bx[1]) / (2 * h), j22 = (ay[1] - by[1]) / (2 * h);
      var det = j11 * j22 - j12 * j21;
      if (!isFinite(det) || Math.abs(det) < 1e-14) break;
      var dx = (j22 * ex - j12 * ey) / det, dy = (j11 * ey - j21 * ex) / det;
      x -= dx; y -= dy;
      if (!isFinite(x) || !isFinite(y)) break;
    }
    var v2 = f(k, x, y);
    return [x, y, Math.abs(v2[0] - tx) < 1e-9 && Math.abs(v2[1] - ty) < 1e-9];
  }

  /* ピクセル座標での変換。out に [x, y, ok] を返す（ok=false は反復が収束しなかった点） */
  function distortPx(cam, px, py) {                   // 真っ直ぐ → 歪み
    var x = (px - cam.cx) / cam.s, y = (py - cam.cy) / cam.s, r;
    if (cam.model.fwd === "distort") { r = cam.model.f(cam.k, x, y); r[2] = true; }
    else r = solve(cam.model.f, cam.k, x, y, x, y);
    return [r[0] * cam.s + cam.cx, r[1] * cam.s + cam.cy, r[2]];
  }
  function undistortPx(cam, px, py) {                 // 歪み → 真っ直ぐ
    var x = (px - cam.cx) / cam.s, y = (py - cam.cy) / cam.s, r;
    if (cam.model.fwd === "undistort") { r = cam.model.f(cam.k, x, y); r[2] = true; }
    else r = solve(cam.model.f, cam.k, x, y, x, y);
    return [r[0] * cam.s + cam.cx, r[1] * cam.s + cam.cy, r[2]];
  }

  /* STMap の各出力ピクセルが元画像のどこを参照するか。
     Undistort マップ: 出力は真っ直ぐな画像 → 歪んだ元画像のどこを見るか = distortPx
     Redistort マップ: 出力は歪んだ画像   → 真っ直ぐな元画像のどこを見るか = undistortPx */
  function sampler(cam, dir) { return dir === "redistort" ? undistortPx : distortPx; }
  function inverseSampler(cam, dir) { return dir === "redistort" ? distortPx : undistortPx; }

  /* ---- オーバースキャン ----
     mode "none": 元画像と同じ枠
     mode "auto": 元画像の枠の外周が出力側でどこに来るかを調べ、はみ出す分だけ枠を広げる
                  （広げるだけで縮めない）。左右・上下は対称にそろえる。
                  Blender は EXR の data window の位置を無視して画像を中央合わせで置くため、
                  非対称だとレンダー解像度で切り出したときに位置がずれる（2026-09-27 実測で約 1px）。
     mode "percent": 幅・高さそれぞれ pct% を左右・上下に均等に足す
     戻り値は左下原点のピクセル単位で { l, r, b, t }（各方向に足すピクセル数） */
  function overscan(opts) {
    var o = opts.overscan || { mode: "none" }, W = opts.W, H = opts.H;
    if (o.mode === "percent") {
      var ex = Math.ceil(W * (o.pct || 0) / 200), ey = Math.ceil(H * (o.pct || 0) / 200);
      return { l: ex, r: ex, b: ey, t: ey };
    }
    if (o.mode !== "auto") return { l: 0, r: 0, b: 0, t: 0 };
    var cam = camera(opts), inv = inverseSampler(cam, opts.dir);
    var minX = 0, maxX = W, minY = 0, maxY = H, step = Math.max(1, Math.floor(Math.max(W, H) / 2048));
    function probe(px, py) {
      var p = inv(cam, px, py); if (!p[2]) return;
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    for (var i = 0; i <= W; i += step) { probe(i, 0); probe(i, H); }
    for (var j = 0; j <= H; j += step) { probe(0, j); probe(W, j); }
    probe(W, 0); probe(0, H); probe(W, H);
    // 極端な歪みでの巨大化を防ぐため、各方向は元の寸法までに制限（Blender と同じ）
    var ex = Math.min(W, Math.max(0, Math.ceil(-minX), Math.ceil(maxX - W)));
    var ey = Math.min(H, Math.max(0, Math.ceil(-minY), Math.ceil(maxY - H)));
    return { l: ex, r: ex, b: ey, t: ey };
  }

  /* ---- STMap 本体 ----
     戻り値:
       W, H         … 元画像（表示枠）の寸法
       dw           … EXR の data window（上原点の EXR 座標系）{ x0, y0, x1, y1 }
       w, h         … data window の寸法
       R, G         … 上の行から並んだ Float32Array
       unconverged  … 反復が収束しなかったピクセル数 */
  function buildMap(opts, onProgress) {
    var cam = camera(opts), fn = sampler(cam, opts.dir), W = cam.W, H = cam.H;
    var os = overscan(opts);
    var w = W + os.l + os.r, h = H + os.b + os.t;
    var R = new Float32Array(w * h), G = new Float32Array(w * h), bad = 0;
    for (var row = 0; row < h; row++) {
      var py = (H + os.t - 1 - row) + 0.5;            // 上の行から。左下原点のピクセル中心
      var o = row * w;
      for (var c = 0; c < w; c++) {
        var s = fn(cam, c - os.l + 0.5, py);
        if (!s[2]) bad++;
        R[o + c] = s[0] / W;
        G[o + c] = s[1] / H;
      }
      if (onProgress && (row & 63) === 0) onProgress(row / h);
    }
    return {
      W: W, H: H, w: w, h: h, R: R, G: G, unconverged: bad,
      dw: { x0: -os.l, y0: -os.t, x1: W - 1 + os.r, y1: H - 1 + os.b }
    };
  }

  /* ---- ライブ表示用の軽い統計（外周だけ調べる） ----
     maxShift: 元画像の枠の外周ピクセルの最大移動量（px）
     outside : 外周のうち元画像の枠外を参照する割合（0〜1）
     overscan: overscan() の結果 */
  function edgeStats(opts) {
    var cam = camera(opts), fn = sampler(cam, opts.dir), W = cam.W, H = cam.H;
    var maxShift = 0, outside = 0, n = 0, bad = 0;
    var step = Math.max(1, Math.floor(Math.max(W, H) / 4096));
    function probe(px, py) {
      var s = fn(cam, px, py);
      if (!s[2]) bad++;
      var dx = s[0] - px, dy = s[1] - py, d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxShift) maxShift = d;
      if (s[0] < 0 || s[0] > W || s[1] < 0 || s[1] > H) outside++;
      n++;
    }
    for (var i = 0; i < W; i += step) { probe(i + 0.5, 0.5); probe(i + 0.5, H - 0.5); }
    for (var j = 1; j < H - 1; j += step) { probe(0.5, j + 0.5); probe(W - 0.5, j + 0.5); }
    return { maxShift: maxShift, outside: n ? outside / n : 0, unconverged: bad, overscan: overscan(opts) };
  }

  var api = {
    MODELS: MODELS, ALL_PARAMS: ALL_PARAMS,
    camera: camera, distortPx: distortPx, undistortPx: undistortPx,
    sampler: sampler, overscan: overscan, buildMap: buildMap, edgeStats: edgeStats
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STModels = api;
})(this);
