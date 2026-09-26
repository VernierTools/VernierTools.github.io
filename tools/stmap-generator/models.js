/* =========================================================================
   STMap generator — models.js
   レンズ歪みモデルと STMap 生成。ブラウザ（<script>）と Node（require）の両方で動く。
   座標規約: ピクセル中心 (i+0.5)/W、左下原点。Blender コンポジターと Nuke に一致。
   ========================================================================= */
(function (root) {
  "use strict";

  /* ---- Blender Polynomial（libmv ApplyPolynomialDistortionModel と同式）----
     正規化座標 x = (u - cx) / f（f はピクセル単位の焦点距離）。
     公式は「真っ直ぐ → 歪み」の向き。 */
  function polynomialDistort(k, x, y) {
    var r2 = x * x + y * y;
    var rc = 1 + k.k1 * r2 + k.k2 * r2 * r2 + k.k3 * r2 * r2 * r2;
    return [x * rc, y * rc];
  }

  /* ---- カメラ ----
     opts: { W, H, focalPx, ppx, ppy, k1, k2, k3 }
     ppx/ppy は Blender の光学中心（正規化 −1〜1。中心 + 値 × 寸法/2）。 */
  function camera(opts) {
    return {
      W: opts.W, H: opts.H, f: opts.focalPx,
      cx: opts.W / 2 * (1 + opts.ppx),
      cy: opts.H / 2 * (1 + opts.ppy),
      k: { k1: opts.k1, k2: opts.k2, k3: opts.k3 }
    };
  }

  /* 出力ピクセル中心（左下原点のピクセル座標）→ 元画像上の参照位置（同じくピクセル座標）。
     Undistort マップ: 出力は真っ直ぐな画像なので、歪みの公式をそのまま当てる。 */
  function undistortSample(cam, px, py) {
    var d = polynomialDistort(cam.k, (px - cam.cx) / cam.f, (py - cam.cy) / cam.f);
    return [cam.f * d[0] + cam.cx, cam.f * d[1] + cam.cy];
  }

  /* STMap 本体。戻り値は EXR の書き込み順（上の行から）に並べた R/G 平面。 */
  function buildUndistortMap(opts) {
    var cam = camera(opts), W = cam.W, H = cam.H;
    var R = new Float32Array(W * H), G = new Float32Array(W * H);
    for (var row = 0; row < H; row++) {
      var py = (H - 1 - row) + 0.5;                   // ファイル先頭行 = 画面上端
      var y = (py - cam.cy) / cam.f, o = row * W;
      for (var i = 0; i < W; i++) {
        var x = (i + 0.5 - cam.cx) / cam.f;
        var r2 = x * x + y * y;
        var rc = 1 + cam.k.k1 * r2 + cam.k.k2 * r2 * r2 + cam.k.k3 * r2 * r2 * r2;
        R[o + i] = (cam.f * x * rc + cam.cx) / W;
        G[o + i] = (cam.f * y * rc + cam.cy) / H;
      }
    }
    return { W: W, H: H, R: R, G: G };
  }

  /* 外周だけを調べる軽量統計（ライブ表示用）。
     maxShift: 外周ピクセルの最大移動量（px）
     outside: 外周のうち元画像の外を参照する割合（0〜1。オーバースキャンが要る目安） */
  function edgeStats(opts) {
    var cam = camera(opts), W = cam.W, H = cam.H;
    var maxShift = 0, outside = 0, n = 0;
    function probe(px, py) {
      var s = undistortSample(cam, px, py);
      var dx = s[0] - px, dy = s[1] - py, d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxShift) maxShift = d;
      if (s[0] < 0 || s[0] > W || s[1] < 0 || s[1] > H) outside++;
      n++;
    }
    for (var i = 0; i < W; i++) { probe(i + 0.5, 0.5); probe(i + 0.5, H - 0.5); }
    for (var j = 1; j < H - 1; j++) { probe(0.5, j + 0.5); probe(W - 0.5, j + 0.5); }
    return { maxShift: maxShift, outside: n ? outside / n : 0 };
  }

  var api = {
    polynomialDistort: polynomialDistort,
    camera: camera,
    undistortSample: undistortSample,
    buildUndistortMap: buildUndistortMap,
    edgeStats: edgeStats
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STModels = api;
})(this);
