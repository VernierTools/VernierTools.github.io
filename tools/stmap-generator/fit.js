/* =========================================================================
   STMap generator — fit.js
   STMap（または別モデル）から歪み係数を当てはめる。models.js が先に読み込まれていること。

   手順:
     1. 対応点 (u, d) を集める。u = 真っ直ぐな画像上の位置、d = 歪んだ画像上の位置（ピクセル）
     2. 光学中心を固定すると、どのモデルも係数について一次式 → 最小二乗で初期値
     3. 実際のピクセル誤差を LM 法で最小化（光学中心を推定する場合はここで一緒に動かす）
     4. 外れ値（誤差が中央値の 8 倍超）を除いてもう一度 3
   ========================================================================= */
(function (root) {
  "use strict";
  var M = root.STModels;

  /* ---- 小さな線形代数 ---- */
  function solveLinear(A, b) {                       // A: n×n（配列の配列）、部分ピボット付きガウス消去
    var n = b.length, a = A.map(function (r, i) { return r.slice().concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-300) return null;
      var t = a[c]; a[c] = a[piv]; a[piv] = t;
      for (var r2 = c + 1; r2 < n; r2++) {
        var f = a[r2][c] / a[c][c];
        for (var k = c; k <= n; k++) a[r2][k] -= f * a[c][k];
      }
    }
    var x = new Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = a[i][n];
      for (var j = i + 1; j < n; j++) s -= a[i][j] * x[j];
      x[i] = s / a[i][i];
    }
    return x;
  }
  /* 最小二乗: rows = [[基底…], 目的値] の並び。列スケーリングで条件数を整える */
  function leastSquares(rows, n) {
    var scale = new Array(n).fill(0);
    rows.forEach(function (r) { for (var i = 0; i < n; i++) scale[i] = Math.max(scale[i], Math.abs(r[0][i])); });
    scale = scale.map(function (s) { return s > 0 ? s : 1; });
    var A = [], b = new Array(n).fill(0);
    for (var i = 0; i < n; i++) A.push(new Array(n).fill(0));
    rows.forEach(function (r) {
      var v = r[0].map(function (x, i) { return x / scale[i]; });
      for (var i = 0; i < n; i++) {
        b[i] += v[i] * r[1];
        for (var j = 0; j < n; j++) A[i][j] += v[i] * v[j];
      }
    });
    for (var d = 0; d < n; d++) A[d][d] += 1e-15;
    var x = solveLinear(A, b);
    return x ? x.map(function (v, i) { return v / scale[i]; }) : null;
  }

  /* ---- 対応点 ----
     STMap（exr.js / png16.js の読み込み結果）から、格子状に最大 maxN 点を取り出す。
     dir: "undistort" … 出力=真っ直ぐ、値=歪んだ元画像の位置 → u = p, d = s
          "redistort" … 出力=歪み、  値=真っ直ぐな元画像の位置 → u = s, d = p */
  function samplesFromMap(img, maxN) {
    var W = img.W, H = img.H, w = img.w, h = img.h, dw = img.dw;
    var step = Math.max(1, Math.floor(Math.sqrt(w * h / (maxN || 6000))));
    var out = [];
    for (var r = Math.floor(step / 2); r < h; r += step) {
      for (var c = Math.floor(step / 2); c < w; c += step) {
        var i = r * w + c, R = img.R[i], G = img.G[i];
        if (!isFinite(R) || !isFinite(G)) continue;
        if (R === 0 && G === 0) continue;                        // 他ソフトが無効領域を 0 で埋める場合
        if (R < -0.5 || R > 1.5 || G < -0.5 || G > 1.5) continue;
        var px = dw.x0 + c + 0.5, py = H - 1 - (dw.y0 + r) + 0.5;  // 左下原点のピクセル中心
        out.push({ p: [px, py], s: [R * W, G * H] });
      }
    }
    return out;
  }
  function pairs(samples, dir) {
    return samples.map(function (o) {
      return dir === "redistort" ? { u: o.s, d: o.p } : { u: o.p, d: o.s };
    });
  }

  /* ---- 一次式による初期値（光学中心は cam の値で固定） ---- */
  function linearInit(model, cam, prs) {
    var m = M.MODELS[model], names = m.params, rows = [];
    prs.forEach(function (q) {
      var xu = (q.u[0] - cam.cx) / cam.s, yu = (q.u[1] - cam.cy) / cam.s;
      var xd = (q.d[0] - cam.cx) / cam.s, yd = (q.d[1] - cam.cy) / cam.s;
      var bx = [], by = [], tx, ty;
      if (model === "blender-division") {
        // u = d (1 + k1 ru² + k2 ru⁴) → u − d = d (k1 ru² + k2 ru⁴)
        var ru2 = xu * xu + yu * yu;
        bx = [xd * ru2, xd * ru2 * ru2]; by = [yd * ru2, yd * ru2 * ru2];
        tx = xu - xd; ty = yu - yd;
      } else if (model === "blender-nuke") {
        // u = d / (1 + k1 rd² + k2 rd⁴ + p1 yd²) → d − u = u (k1 rd² + k2 rd⁴ + p1 yd²)（y は p2 xd²）
        var rd2 = xd * xd + yd * yd;
        bx = [xu * rd2, xu * rd2 * rd2, xu * yd * yd, 0];
        by = [yu * rd2, yu * rd2 * rd2, 0, yu * xd * xd];
        tx = xd - xu; ty = yd - yu;
      } else {
        // Polynomial / Brown: d − u = u (k1 r² + k2 r⁴ + …) + 接線項
        var r2 = xu * xu + yu * yu, pw = r2;
        for (var i = 0; i < names.length; i++) {
          var nm = names[i];
          if (nm[0] === "k") { bx.push(xu * pw); by.push(yu * pw); pw *= r2; }
          else if (nm === "p1") { bx.push(r2 + 2 * xu * xu); by.push(2 * xu * yu); }
          else if (nm === "p2") { bx.push(2 * xu * yu); by.push(r2 + 2 * yu * yu); }
        }
        tx = xd - xu; ty = yd - yu;
      }
      rows.push([bx, tx]); rows.push([by, ty]);
    });
    var x = leastSquares(rows, names.length);
    var k = {};
    names.forEach(function (nm, i) { k[nm] = x ? x[i] : 0; });
    return k;
  }

  /* ---- ピクセル誤差（予測した参照位置と実際の参照位置の差） ---- */
  function predict(opts, dir, p) {
    var cam = M.camera(opts);
    return M.sampler(cam, dir)(cam, p[0], p[1]);
  }
  function residuals(opts, dir, samples) {
    var cam = M.camera(opts), fn = M.sampler(cam, dir), out = new Float64Array(samples.length * 2);
    for (var i = 0; i < samples.length; i++) {
      var s = fn(cam, samples[i].p[0], samples[i].p[1]);
      out[2 * i] = s[0] - samples[i].s[0];
      out[2 * i + 1] = s[1] - samples[i].s[1];
    }
    return out;
  }
  function stats(res) {
    var n = res.length / 2, sum = 0, sq = 0, max = 0, all = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var d = Math.sqrt(res[2 * i] * res[2 * i] + res[2 * i + 1] * res[2 * i + 1]);
      if (!isFinite(d)) d = 1e9;
      all[i] = d; sum += d; sq += d * d; if (d > max) max = d;
    }
    var sorted = Array.prototype.slice.call(all).sort(function (a, b) { return a - b; });
    return { mean: sum / n, rms: Math.sqrt(sq / n), max: max, median: sorted[n >> 1] || 0, per: all };
  }

  /* ---- LM 法（数値微分） ---- */
  function refine(base, names, dir, samples, iters) {
    var opts = JSON.parse(JSON.stringify(base));
    function get() { return names.map(function (n) { return opts[n]; }); }
    function set(v) { names.forEach(function (n, i) { opts[n] = v[i]; }); }
    var x = get(), r = residuals(opts, dir, samples), cost = sumsq(r), lambda = 1e-3;
    for (var it = 0; it < (iters || 30); it++) {
      var J = names.map(function (n, j) {
        var h = Math.max(1e-7, Math.abs(x[j]) * 1e-6), xp = x.slice();
        xp[j] += h; set(xp);
        var rp = residuals(opts, dir, samples), col = new Float64Array(r.length);
        for (var i = 0; i < r.length; i++) col[i] = (rp[i] - r[i]) / h;
        return col;
      });
      set(x);
      var n = names.length, A = [], g = new Array(n).fill(0);
      for (var a = 0; a < n; a++) {
        A.push(new Array(n).fill(0));
        for (var i2 = 0; i2 < r.length; i2++) g[a] += J[a][i2] * r[i2];
        for (var b = 0; b <= a; b++) {
          var s = 0; for (var i3 = 0; i3 < r.length; i3++) s += J[a][i3] * J[b][i3];
          A[a][b] = A[b][a] = s;
        }
      }
      var improved = false;
      for (var tries = 0; tries < 8; tries++) {
        var Al = A.map(function (row, i) { var c = row.slice(); c[i] *= (1 + lambda); c[i] += 1e-30; return c; });
        var dx = solveLinear(Al, g.map(function (v) { return -v; }));
        if (!dx) { lambda *= 10; continue; }
        var xn = x.map(function (v, i) { return v + dx[i]; });
        set(xn);
        var rn = residuals(opts, dir, samples), cn = sumsq(rn);
        if (cn < cost) {
          var rel = (cost - cn) / Math.max(cost, 1e-300);
          x = xn; r = rn; cost = cn; lambda = Math.max(lambda / 10, 1e-12); improved = true;
          if (rel < 1e-12) it = 1e9;
          break;
        }
        set(x); lambda *= 10;
      }
      if (!improved) break;
    }
    set(x);
    return opts;
  }
  function sumsq(r) { var s = 0; for (var i = 0; i < r.length; i++) s += isFinite(r[i]) ? r[i] * r[i] : 1e18; return s; }

  /* ---- 1方向の当てはめ ----
     base: { model, W, H, focalPx, ppx, ppy }、estimateCenter: 光学中心も推定するか */
  function fitDir(base, dir, samples, estimateCenter) {
    var names = M.MODELS[base.model].params;
    var opts = JSON.parse(JSON.stringify(base));
    names.forEach(function (n) { opts[n] = 0; });
    var cam = M.camera(opts);
    var free = estimateCenter ? names.concat(["ppx", "ppy"]) : names.slice();
    var minN = free.length * 4;
    // 外れ値（壊れたピクセル）を除く: 「解く → 誤差が中央値の 5 倍超の点を捨てる」を繰り返す。
    // 一次式の段階から行うのは、極端な外れ値が初期値を大きく歪めるため。
    function trim(list, o, factor) {
      var st = stats(residuals(o, dir, list)), lim = Math.max(st.median * factor, 1e-3);
      var kept = list.filter(function (s, i) { return st.per[i] <= lim; });
      return kept.length >= minN ? kept : list;
    }
    var kept = samples;
    for (var pass = 0; pass < 3; pass++) {
      var k0 = linearInit(base.model, cam, pairs(kept, dir));
      names.forEach(function (n) { opts[n] = k0[n]; });
      var next = trim(kept, opts, 5);
      if (next.length === kept.length) break;
      kept = next;
    }
    opts = refine(opts, free, dir, kept);
    for (var pass2 = 0; pass2 < 2; pass2++) {
      var next2 = trim(kept, opts, 8);
      if (next2.length === kept.length) break;
      kept = next2;
      opts = refine(opts, free, dir, kept);
    }
    var fin = stats(residuals(opts, dir, kept));
    return { opts: opts, dir: dir, rms: fin.rms, mean: fin.mean, max: fin.max,
             used: kept.length, total: samples.length };
  }

  /* STMap から当てはめる。dir: "undistort" | "redistort" | "auto" */
  function fitMap(img, base, dir, estimateCenter) {
    var samples = samplesFromMap(img, 6000);
    if (samples.length < 50) throw new Error("Not enough valid pixels in the STMap");
    var dirs = dir === "auto" ? ["undistort", "redistort"] : [dir];
    var best = null;
    dirs.forEach(function (d) {
      var r = fitDir(base, d, samples, estimateCenter);
      if (!best || r.rms < best.rms) best = r;
    });
    return best;
  }

  /* 別モデルの係数から当てはめる（係数変換）。
     src: 変換元の opts（model と係数を含む）、dst: 変換先の { model, focalPx, ppx, ppy, W, H } */
  function convert(src, dst, estimateCenter) {
    var cam = M.camera(src), W = src.W, H = src.H, N = 64, samples = [];
    var ny = Math.max(8, Math.round(N * H / W));
    for (var j = 0; j <= ny; j++) {
      for (var i = 0; i <= N; i++) {
        var px = W * i / N, py = H * j / ny, s = M.distortPx(cam, px, py);
        if (s[2]) samples.push({ p: [px, py], s: [s[0], s[1]] });   // undistort マップと同じ形
      }
    }
    return fitDir(dst, "undistort", samples, estimateCenter);
  }

  var api = { fitMap: fitMap, convert: convert, samplesFromMap: samplesFromMap, predict: predict };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STFit = api;
})(this);
