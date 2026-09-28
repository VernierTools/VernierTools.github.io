/* =========================================================================
   Actual frame rate — analyze.js
   1) タイムスタンプ: ファイルに入っているフレームの間隔から、ファイル上の fps と
      一定（CFR）か可変（VFR）かを調べる。
   2) 絵の変化: 前のフレームとの差の列から「同じ絵の繰り返し」を見つけ、
      中身のフレームレート（絵が 1 秒に何回変わるか）と繰り返しの並びを求める。
   DOM を使わない純粋な計算だけを置く（JavaScriptCore で単体検証できるように）。
   ========================================================================= */
(function (root) {
  "use strict";

  // よく使われるフレームレート（NTSC 系は 1000/1001 倍）
  var STANDARD = [
    [8, "8"], [10, "10"], [12, "12"], [12000 / 1001, "11.988"], [15, "15"], [15000 / 1001, "14.985"],
    [24000 / 1001, "23.976"], [24, "24"], [25, "25"], [30000 / 1001, "29.97"], [30, "30"],
    [48000 / 1001, "47.952"], [48, "48"], [50, "50"], [60000 / 1001, "59.94"], [60, "60"],
    [72, "72"], [90, "90"], [96, "96"], [100, "100"], [120000 / 1001, "119.88"], [120, "120"],
    [144, "144"], [165, "165"], [240, "240"]
  ];
  // v に一番近い標準値（相対誤差 tol 以内）。無ければ null
  function snap(v, tol) {
    var best = null, err = Infinity;
    STANDARD.forEach(function (s) { var e = Math.abs(v - s[0]) / s[0]; if (e < err) { err = e; best = s; } });
    return err <= tol ? { value: best[0], label: best[1], err: err } : null;
  }

  function median(a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /* =====================================================================
     1) タイムスタンプ
     pts: 各フレームの表示時刻（秒、順不同）、timebase: 時刻の最小刻み（秒）
     ===================================================================== */
  function timestamps(pts, timebase) {
    var t = Float64Array.from(pts).sort(), n = t.length;
    if (n < 2) return { frames: n, insufficient: true };
    var gaps = new Float64Array(n - 1);
    for (var i = 1; i < n; i++) gaps[i - 1] = t[i] - t[i - 1];
    var span = t[n - 1] - t[0];
    // 平均 fps は「フレーム数 ÷ かかった時間」で出す。WebM の 1 ms 刻みのように
    // 時刻が丸められていても、長い区間で割るので丸めの影響はほぼ消える
    var avg = (n - 1) / span, med = median(Array.from(gaps));
    // 丸め（± 刻み 1 つ分）を超えて中央値からずれた間隔を「不規則」と数える
    var tol = Math.max(1.5 * (timebase || 0), 0.02 * med), irregular = 0, minGap = Infinity, maxGap = 0;
    for (i = 0; i < gaps.length; i++) {
      if (Math.abs(gaps[i] - med) > tol) irregular++;
      if (gaps[i] > 0 && gaps[i] < minGap) minGap = gaps[i];
      if (gaps[i] > maxGap) maxGap = gaps[i];
    }
    // 1 秒ごとのフレーム数（グラフ用）
    var perSec = [], sec0 = t[0], bins = Math.max(1, Math.ceil(span + 1e-9));
    for (i = 0; i < bins; i++) perSec.push(0);
    for (i = 0; i < n; i++) { var k = Math.min(bins - 1, Math.floor(t[i] - sec0)); perSec[k]++; }
    var full = perSec.slice(0, Math.floor(span));       // 最後の端数秒は除く
    var ratio = irregular / gaps.length;
    return {
      frames: n, start: t[0], span: span, avgFps: avg, medianGap: med,
      minFps: maxGap > 0 ? 1 / maxGap : null, maxFps: isFinite(minGap) ? 1 / minGap : null,
      irregularRatio: ratio, vfr: ratio > 0.01,
      perSec: perSec, perSecMin: full.length ? Math.min.apply(null, full) : null, perSecMax: full.length ? Math.max.apply(null, full) : null,
      snapped: snap(avg, 0.002)
    };
  }

  /* =====================================================================
     2) 絵の変化
     windows: [{ pts: [...], diff: [...] }]（表示順。diff[0] は比較なしで null）
     fileFps: ファイル上の fps
     diff は「前のフレームとの差」（小さなブロックごとの平均差の最大値, 0〜255）
     ===================================================================== */
  // 判定の考え方:
  //  同じ絵を繰り返したフレームの差は、圧縮のノイズだけなのでほぼ 0（キーフレームの境目でも数程度）。
  //  絵が変わったフレームの差は、その場面の動きの大きさと同じくらいになる。
  //  そこで前後 0.5 秒の「動きの大きさ」（差の上位 10%）を物差しにして、その 1/4 以上なら
  //  「絵が変わった」とする。動きが小さすぎてノイズと見分けられない場面は判定に使わない。
  var LOW_MOTION = 3;     // 物差しがこれ未満の場面は「止まっている／判定できない」
  var REL = 0.25;         // 物差しに対するしきい値の割合
  var STATIC_SEC = 0.5;   // 同じ絵がこれより長く続いたら「止まった場面」として数えない

  function localMotion(diff, half) {
    var n = diff.length, out = new Float32Array(n), buf = [];
    for (var i = 0; i < n; i++) {
      buf.length = 0;
      for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (diff[j] != null) buf.push(diff[j]);
      if (!buf.length) { out[i] = 0; continue; }
      buf.sort(function (x, y) { return x - y; });
      out[i] = buf[Math.min(buf.length - 1, Math.floor(buf.length * 0.9))];
    }
    return out;
  }

  function cadence(windows, fileFps) {
    var half = Math.max(3, Math.round(fileFps * 0.5));
    var runs = [], durs = [], unclearSec = 0, changes = 0, compared = 0, perSec = [];
    windows.forEach(function (w) {
      var L = localMotion(w.diff, half), cur = 0, lastT = null, secs = {}, unclearFrom = null;
      function breakRun(t) { if (unclearFrom == null) unclearFrom = lastT != null ? lastT : t; lastT = null; cur = 0; }
      for (var i = 0; i < w.diff.length; i++) {
        var d = w.diff[i];
        if (d == null) continue;
        if (L[i] < LOW_MOTION) { breakRun(w.pts[i]); continue; }   // 動きが小さく判定できない
        if (unclearFrom != null) { unclearSec += w.pts[i] - unclearFrom; unclearFrom = null; }
        compared++;
        if (d >= REL * L[i]) {
          changes++;
          var s = Math.floor(w.pts[i]); secs[s] = (secs[s] || 0) + 1;
          if (lastT != null) {   // 区間の最初の並びは途中から始まるので捨てる
            var dur = w.pts[i] - lastT;
            if (dur > STATIC_SEC) unclearSec += dur; else { runs.push(cur); durs.push(dur); }
          }
          lastT = w.pts[i]; cur = 1;
        } else if (lastT != null) cur++;
      }
      if (unclearFrom != null) unclearSec += w.pts[w.pts.length - 1] - unclearFrom;
      Object.keys(secs).forEach(function (s) { perSec.push({ t: +s, n: secs[s] }); });
    });
    // 動き始めなど、小さな変化を見落として 2 つ以上の絵が 1 つに数えられた並びを外す
    // （典型的な並びの長さ＝中央値の 2.5 倍を超えるもの）
    if (runs.length) {
      var m = median(runs), lim = Math.max(2.5 * m, m + 2), kr = [], kd = [];
      runs.forEach(function (r, k) { if (r <= lim) { kr.push(r); kd.push(durs[k]); } else unclearSec += durs[k]; });
      runs = kr; durs = kd;
    }
    var res = { compared: compared, changes: changes, dupRatio: compared ? 1 - changes / compared : 0,
      staticSec: unclearSec, runs: runs.length, perSec: perSec };
    if (runs.length < 6) {
      res.insufficient = true;
      res.allStatic = compared < 8 || changes < 3;
      return res;
    }
    // 中身の fps = 1 つの絵が保たれた時間の平均の逆数（ファイルが VFR でも時刻で測るので正しく出る）
    var sum = 0, hist = {};
    durs.forEach(function (x) { sum += x; });
    runs.forEach(function (r) { hist[r] = (hist[r] || 0) + 1; });
    res.measured = durs.length / sum;
    res.hist = Object.keys(hist).map(Number).sort(function (a, b) { return a - b; })
      .map(function (k) { return { len: k, share: hist[k] / runs.length }; });
    res.sequence = runs.slice(0, 16);
    res.pattern = pattern(runs, res.hist);
    // 並びが規則的なら、ファイルの fps と並びから正確な値が決まる（3:2 なら 2/5 倍）。
    // 見落としが数か所あっても実測値に引きずられないよう、こちらを代表値にする
    var p = res.pattern, exact = p.kind === "every" ? fileFps : p.kind === "hold" ? fileFps / p.n : p.kind === "alt" ? fileFps * 2 / (p.a + p.b) : null;
    res.fromPattern = exact != null && Math.abs(exact - res.measured) / exact < 0.03;
    res.fps = res.fromPattern ? exact : res.measured;
    res.snapped = snap(res.fps, res.fromPattern ? 0.002 : 0.006);
    return res;
  }

  // 並びの名前: 「毎フレーム」「k 枚ずつ」「a:b の繰り返し」「不規則」
  function pattern(runs, hist) {
    var main = hist.filter(function (h) { return h.share >= 0.08; });
    if (main.length === 1 && main[0].share >= 0.9) return main[0].len === 1 ? { kind: "every" } : { kind: "hold", n: main[0].len };
    if (main.length === 2 && main[0].share + main[1].share >= 0.9 && Math.abs(main[0].len - main[1].len) === 1) {
      // 交互に並んでいるか（a の次が b になっている割合）
      var alt = 0;
      for (var i = 1; i < runs.length; i++) if (runs[i] !== runs[i - 1]) alt++;
      if (alt / (runs.length - 1) >= 0.7) return { kind: "alt", a: main[1].len, b: main[0].len };
    }
    return { kind: "irregular" };
  }

  root.FpsAnalyze = { timestamps: timestamps, cadence: cadence, snap: snap, STANDARD: STANDARD };
})(typeof self !== "undefined" ? self : this);
