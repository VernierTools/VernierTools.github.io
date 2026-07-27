"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/analyzer.js
   輝度・色の計算と、閃光（フラッシュ）検出の中核。

   前提（すべて実機検証で確定済み。仕様書 §2 参照）:
     - Chrome  : VideoFrame.format = "NV12"  → 経路A（生YUV自前変換）
     - Firefox : VideoFrame.format = "BGRX"  → 経路B（ブラウザ変換済みRGB）
     - 両者とも copyTo({format:"I420"}) は失敗する
     - copyTo が返す PlaneLayout（offset / stride）を必ず使う
     - 走査は visibleRect のサイズで行う（codedWidth/Height は整列で大きい）
     - フレームは timestamp で並べ替えてから時系列解析する

   ⚠ Y'（luma）は相対輝度 Y ではない。
     Y' はガンマ符号化値に係数を掛けたもの、相対輝度はリニア化後に掛けたもの。
     混同すると判定が根本から狂うため、必ず RGB へ戻してからリニア化する。
   ========================================================================= */
(function (scope) {

  /* =======================================================================
     1. EOTF（基準ごとに切り替える。仕様書 §3.1）
     ======================================================================= */

  // sRGB / IEC 61966-2-1（WCAG が参照する伝達関数）
  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  // BT.1886（放送系: ITU-R BT.1702-2 / Ofcom / 民放連）。L_B=0 なので単純なべき乗
  function bt1886ToLinear(v) {
    return v <= 0 ? 0 : Math.pow(v, 2.4);
  }

  var EOTF = { srgb: srgbToLinear, bt1886: bt1886ToLinear };

  // 8bit 入力なら 256 エントリの LUT で置換できる（フレームごとの pow を消す）
  function buildLUT(fn, fullRange) {
    var lut = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var v = fullRange ? (i / 255) : ((i - 16) / 219);
      if (v < 0) v = 0; else if (v > 1) v = 1;
      lut[i] = fn(v);
    }
    return lut;
  }

  /* 輝度係数（BT.709。primaries が bt709 の場合） */
  var KR = 0.2126, KG = 0.7152, KB = 0.0722;

  /* =======================================================================
     2. 画素の読み出し（経路A / 経路B）
     ======================================================================= */

  var PACKED_RGB = { RGBA: [0, 1, 2], BGRA: [2, 1, 0], RGBX: [0, 1, 2], BGRX: [2, 1, 0] };
  var PLANAR = { I420: "i420", I420A: "i420", I422: "i422", I444: "i444", NV12: "nv12" };

  /* YUV→RGB 係数（非線形 R'G'B' を得る） */
  var YUV_MATRIX = {
    "bt709":     { vr: 1.5748,  ug: -0.1873,   vg: -0.4681,   ub: 1.8556 },
    "smpte170m": { vr: 1.4020,  ug: -0.344136, vg: -0.714136, ub: 1.7720 },
    "bt470bg":   { vr: 1.4020,  ug: -0.344136, vg: -0.714136, ub: 1.7720 },
    "bt2020-ncl":{ vr: 1.4746,  ug: -0.16455,  vg: -0.57135,  ub: 1.8814 }
  };

  /* ---------------------------------------------------------------------
     フレームバッファ → リニアRGB平面（解析解像度へ面積平均で縮小）

     ⚠ 縮小は必ずリニア光で行う。ガンマ符号化値の平均は物理的に誤りで、
       平均輝度が系統的に低く出る（＝偽陰性方向）。

     戻り値: { w, h, R, G, B, lum }  いずれも Float32Array（リニア、0..1）
     --------------------------------------------------------------------- */
  function toLinearPlanes(buf, meta, opts) {
    var srcW = meta.width, srcH = meta.height;
    var dstW = opts.dstW, dstH = opts.dstH;
    var eotfName = opts.eotf || "bt1886";
    var eotf = EOTF[eotfName];
    var fullRange = !!meta.fullRange;

    // 経路B（パックドRGB）は R'G'B' がそのまま入っている
    var packed = PACKED_RGB[meta.format];
    var planar = PLANAR[meta.format];
    if (!packed && !planar) return null;

    var lut = buildLUT(eotf, packed ? true : fullRange);
    // ⚠ パックドRGBはブラウザが変換済み。実測でフルレンジと確認できた場合のみ
    //    fullRange=true 相当の LUT を使う。meta.packedFullRange で上書きできる。
    if (packed && meta.packedFullRange === false) lut = buildLUT(eotf, false);

    var accR = new Float64Array(dstW * dstH);
    var accG = new Float64Array(dstW * dstH);
    var accB = new Float64Array(dstW * dstH);
    var accN = new Float64Array(dstW * dstH);

    var layout = meta.layout || [];
    var p0 = layout[0] || { offset: 0, stride: packed ? srcW * 4 : srcW };

    var xScale = dstW / srcW, yScale = dstH / srcH;

    if (packed) {
      var oR = packed[0], oG = packed[1], oB = packed[2];
      for (var y = 0; y < srcH; y++) {
        var row = p0.offset + y * p0.stride;
        var dy = (y * yScale) | 0; if (dy >= dstH) dy = dstH - 1;
        var dbase = dy * dstW;
        for (var x = 0; x < srcW; x++) {
          var o = row + x * 4;
          var dx = (x * xScale) | 0; if (dx >= dstW) dx = dstW - 1;
          var di = dbase + dx;
          accR[di] += lut[buf[o + oR]];
          accG[di] += lut[buf[o + oG]];
          accB[di] += lut[buf[o + oB]];
          accN[di]++;
        }
      }
    } else {
      // planar / semi-planar YUV
      var m = YUV_MATRIX[meta.matrix] || YUV_MATRIX["bt709"];
      var yOff = p0.offset, yStride = p0.stride;
      var p1 = layout[1] || null, p2 = layout[2] || null;
      var isNV12 = (planar === "nv12");
      var subX = (planar === "i444") ? 1 : 2;
      var subY = (planar === "i420" || planar === "nv12") ? 2 : 1;

      // 色差の正規化（limited: (c-128)/224、full: (c-128)/255）
      var cDiv = fullRange ? 255 : 224;
      var yScaleN = fullRange ? (1 / 255) : (1 / 219);
      var yBias = fullRange ? 0 : 16;

      for (var yy = 0; yy < srcH; yy++) {
        var yrow = yOff + yy * yStride;
        var cy = (yy / subY) | 0;
        var dyy = (yy * yScale) | 0; if (dyy >= dstH) dyy = dstH - 1;
        var dbase2 = dyy * dstW;

        for (var xx = 0; xx < srcW; xx++) {
          var Y8 = buf[yrow + xx];
          var cx = (xx / subX) | 0;
          var U8 = 128, V8 = 128;

          if (isNV12 && p1) {
            var ci = p1.offset + cy * p1.stride + cx * 2;
            U8 = buf[ci]; V8 = buf[ci + 1];
          } else if (p1 && p2) {
            U8 = buf[p1.offset + cy * p1.stride + cx];
            V8 = buf[p2.offset + cy * p2.stride + cx];
          }

          var Yn = (Y8 - yBias) * yScaleN;
          var U = (U8 - 128) / cDiv;
          var V = (V8 - 128) / cDiv;

          var r = Yn + m.vr * V;
          var g = Yn + m.ug * U + m.vg * V;
          var b = Yn + m.ub * U;

          // クリップしてから LUT を引く（LUT は 0..255 の符号化値で引くため再量子化）
          r = r < 0 ? 0 : r > 1 ? 1 : r;
          g = g < 0 ? 0 : g > 1 ? 1 : g;
          b = b < 0 ? 0 : b > 1 ? 1 : b;

          var dxx = (xx * xScale) | 0; if (dxx >= dstW) dxx = dstW - 1;
          var di2 = dbase2 + dxx;
          accR[di2] += eotf(r);
          accG[di2] += eotf(g);
          accB[di2] += eotf(b);
          accN[di2]++;
        }
      }
    }

    var R = new Float32Array(dstW * dstH);
    var G = new Float32Array(dstW * dstH);
    var B = new Float32Array(dstW * dstH);
    var lum = new Float32Array(dstW * dstH);
    for (var i = 0; i < R.length; i++) {
      var n = accN[i] || 1;
      var rr = accR[i] / n, gg = accG[i] / n, bb = accB[i] / n;
      R[i] = rr; G[i] = gg; B[i] = bb;
      lum[i] = KR * rr + KG * gg + KB * bb;   // 相対輝度（リニア）
    }
    return { w: dstW, h: dstH, R: R, G: G, B: B, lum: lum };
  }

  /* =======================================================================
     3. 赤飽和度（仕様書 §3.4）
     ======================================================================= */

  /* R/(R+G+B) >= 0.8 を飽和赤とする。
     ⚠ 規格文言はリニア/ガンマのどちらか不明確なため、既定はリニア。
        opts.redLinear=false でガンマ符号化値による判定に切り替える。 */
  function redSaturation(R, G, B, i) {
    var s = R[i] + G[i] + B[i];
    return s > 1e-9 ? R[i] / s : 0;
  }

  /* CIE 1976 UCS 上の距離（赤遷移の第2条件） */
  function rgbToUCS(r, g, b) {
    // sRGB/BT.709 primaries, D65 → XYZ（リニア値を渡すこと）
    var X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    var Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    var Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    var d = X + 15 * Y + 3 * Z;
    if (d < 1e-9) return [0, 0];
    return [4 * X / d, 9 * Y / d];
  }
  function ucsDistance(a, b) {
    var du = a[0] - b[0], dv = a[1] - b[1];
    return Math.sqrt(du * du + dv * dv);
  }

  /* =======================================================================
     4. 面積判定（仕様書 §4.3）
     ======================================================================= */

  /* 積分画像。任意矩形の合計を O(1) で取得する。
     素朴な全窓走査は O(W·H·w·h) になり実用にならない。 */
  function IntegralImage(mask, w, h) {
    // (w+1) x (h+1) の累積和
    var S = new Int32Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var rowSum = 0;
      for (var x = 0; x < w; x++) {
        rowSum += mask[y * w + x] ? 1 : 0;
        S[(y + 1) * (w + 1) + (x + 1)] = S[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    this.S = S; this.w = w; this.h = h;
  }
  IntegralImage.prototype.rectSum = function (x0, y0, x1, y1) {
    // [x0,x1) × [y0,y1)
    var W = this.w + 1, S = this.S;
    return S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
  };
  IntegralImage.prototype.total = function () {
    return this.rectSum(0, 0, this.w, this.h);
  };
  /* 任意位置の窓で「窓面積の ratio 超」を満たすものがあるか。
     WCAG の「任意の10度視野の25%」判定に使う。 */
  IntegralImage.prototype.anyWindowExceeds = function (winW, winH, ratio, step) {
    step = step || 8;
    if (winW > this.w) winW = this.w;
    if (winH > this.h) winH = this.h;
    var need = winW * winH * ratio;
    for (var y = 0; y + winH <= this.h; y += step) {
      for (var x = 0; x + winW <= this.w; x += step) {
        if (this.rectSum(x, y, x + winW, y + winH) > need) {
          return { x: x, y: y, w: winW, h: winH };
        }
      }
    }
    return null;
  };

  /* =======================================================================
     5. 遷移検出（仕様書 §4.1）— 画素ごとの累積差分方式
     ======================================================================= */

  /* 単純なフレーム間差分は使わない。緩やかな遷移を取りこぼし、
     微小変動でカウントが暴発するため。

     遷移の成立条件（すべて満たすこと）:
       ① |lum(t) − S|              ≥ CTD   … 基準状態からの変化量
       ② |lum(t) − lum(t−66ms)|    ≥ CTD   … 変化の速さ（適格継続時間）
       ③ min(lum(t), S)            < darkMax … 暗部条件（§3.3）
       ④ 直前に成立した遷移と方向が逆        … 対向変化

     ②は ring buffer で判定する。ここを「基準値の最終更新時刻からの経過」で
     代用すると、値が一定の区間で基準が更新され続けた結果、
     直後の急変が棄却される（実測で 4Hz/60fps の点滅を取りこぼした）。
     ②があることで、1秒かけた緩やかなフェードは遷移として数えない。
   */
  function TransitionDetector(n, opts) {
    this.n = n;
    this.S = new Float32Array(n);              // 基準状態
    this.dir = new Int8Array(n);               // 直前の遷移方向
    this.started = false;
    this.ctd = opts.ctd;
    this.darkMax = opts.darkMax;
    this.eligibleUs = (opts.eligibleMs || 66) * 1000;
    this.maskUp = new Uint8Array(n);
    this.maskDown = new Uint8Array(n);
    // 適格時間ぶんの履歴（fps未知でも足りるよう既定8枚）
    this.histLen = Math.max(2, opts.histLen || 8);
    this.hist = [];
    this.histT = [];
  }
  TransitionDetector.prototype.reset = function (lum, tUs) {
    this.S.set(lum);
    this.dir.fill(0);
    this.hist = [Float32Array.from(lum)];
    this.histT = [tUs];
    this.started = true;
  };
  /* 適格時間窓内の各画素の min / max を求める。
     ②の判定は「窓内のいずれかの過去フレームとの差が CTD 以上か」であり、
     max(cur − minHist, maxHist − cur) ≥ CTD と等価。

     ⚠ 「66ms前の1枚だけ」と比較してはならない。毎フレーム交互に反転する
        高速な点滅では、66ms前が同位相になり「変化なし」と誤判定する
        （実測で 30Hz 相当の点滅を取りこぼした）。 */
  TransitionDetector.prototype._windowMinMax = function (tUs) {
    var lo = tUs - this.eligibleUs;
    var n = this.n;
    var mn = this._mn || (this._mn = new Float32Array(n));
    var mx = this._mx || (this._mx = new Float32Array(n));
    var any = false;
    for (var k = 0; k < this.hist.length; k++) {
      if (this.histT[k] < lo) continue;          // 窓外
      var h = this.hist[k];
      if (!any) {
        mn.set(h); mx.set(h); any = true;
      } else {
        for (var i = 0; i < n; i++) {
          var v = h[i];
          if (v < mn[i]) mn[i] = v;
          if (v > mx[i]) mx[i] = v;
        }
      }
    }
    if (!any) {
      // 窓内に履歴が無い（＝直前フレームすら窓外）→ 直近1枚を使う
      var last = this.hist[this.hist.length - 1];
      if (!last) return null;
      mn.set(last); mx.set(last);
    }
    return true;
  };
  TransitionDetector.prototype.step = function (lum, tUs) {
    if (!this.started) {
      this.reset(lum, tUs);
      this.maskUp.fill(0); this.maskDown.fill(0);
      return;
    }
    var S = this.S, dir = this.dir;
    var ctd = this.ctd, darkMax = this.darkMax;
    var mu = this.maskUp, md = this.maskDown;
    mu.fill(0); md.fill(0);

    var haveWindow = this._windowMinMax(tUs);
    var mn = this._mn, mx = this._mx;

    for (var i = 0; i < this.n; i++) {
      var cur = lum[i], base = S[i];
      var d = cur - base;
      var ad = d < 0 ? -d : d;

      if (ad >= ctd) {
        var darker = cur < base ? cur : base;
        var nd = d > 0 ? 1 : -1;
        // ② 変化の速さ: 窓内のいずれかのフレームとの差が CTD 以上か
        var fast = true;
        if (haveWindow) {
          var devLow = cur - mn[i];              // 窓内最小からの上昇量
          var devHigh = mx[i] - cur;             // 窓内最大からの下降量
          var maxDev = devLow > devHigh ? devLow : devHigh;
          if (maxDev < ctd) fast = false;
        }
        if (darker < darkMax && fast && nd !== dir[i]) {
          if (nd > 0) mu[i] = 1; else md[i] = 1;
          dir[i] = nd;
          S[i] = cur;                 // 遷移成立 → 基準を更新
        } else if (!fast) {
          // 緩やかな変化。基準だけ追従させ、遷移としては数えない
          S[i] = cur;
        }
      }
    }

    // 履歴を更新
    this.hist.push(Float32Array.from(lum));
    this.histT.push(tUs);
    while (this.hist.length > this.histLen) { this.hist.shift(); this.histT.shift(); }
  };

  /* =======================================================================
     6. 1秒スライディングウィンドウ（仕様書 §4.4）
     ======================================================================= */

  /* 固定の秒区切りは使わない。境界をまたぐ点滅を見逃すため。 */
  function SlidingWindow(windowUs) {
    this.windowUs = windowUs || 1000000;
    this.events = [];   // {t, dir}
  }
  SlidingWindow.prototype.push = function (tUs, dir) {
    this.events.push({ t: tUs, dir: dir });
  };
  SlidingWindow.prototype.countAt = function (tUs) {
    var lo = tUs - this.windowUs;
    var e = this.events, n = 0;
    // 古いものを捨てる
    while (e.length && e[0].t <= lo) e.shift();
    for (var i = 0; i < e.length; i++) if (e[i].t <= tUs) n++;
    return n;
  };

  /* =======================================================================
     7. 基準の定義（仕様書 §6）
     ======================================================================= */

  /* SDR: ピーク白 200 cd/m² 前提。20cd/m² = 相対輝度 0.10、160cd/m² = 0.80 */
  var STANDARDS = {
    jba: {
      label: { ja: "NHK・民放連", en: "NHK / JBA" },
      eotf: "bt1886", ctd: 0.10, darkMax: 0.80,
      area: { mode: "global", ratio: 0.25 },
      maxTransitionsPerSec: 6
    },
    itu: {
      label: { ja: "ITU-R BT.1702-2", en: "ITU-R BT.1702-2" },
      eotf: "bt1886", ctd: 0.10, darkMax: 0.80,
      area: { mode: "global", ratio: 0.25 },
      maxTransitionsPerSec: 6
    },
    ofcom: {
      label: { ja: "Ofcom (英)", en: "Ofcom (UK)" },
      eotf: "bt1886", ctd: 0.10, darkMax: 0.80,
      area: { mode: "global", ratio: 0.25 },
      maxTransitionsPerSec: 6
    },
    wcagA: {
      label: { ja: "WCAG 2.3.1 (A)", en: "WCAG 2.3.1 (A)" },
      eotf: "srgb", ctd: 0.10, darkMax: 0.80,
      area: { mode: "local", ratio: 0.25, winFrac: 1 / 3 },  // 10度視野 = 画面の1/3四方
      maxTransitionsPerSec: 6
    },
    wcagAAA: {
      label: { ja: "WCAG 2.3.2 (AAA)", en: "WCAG 2.3.2 (AAA)" },
      eotf: "srgb", ctd: 0.10, darkMax: 0.80,
      area: { mode: "none" },     // 面積による免除がない
      maxTransitionsPerSec: 6
    },
    proposal2024: {
      label: { ja: "2024年提案", en: "2024 proposal" },
      eotf: "bt1886", ctd: 0.10, darkMax: 0.80,
      michelson: 1 / 17,          // 暗部が明るい場合のみ適用
      area: { mode: "local", ratio: 0.25, winFracW: 416 / 1920, winFracH: 416 / 1080 },
      maxTransitionsPerSec: 6,
      reference: true
    }
  };

  /* マージン適用（仕様書 §7）。厳しくする方向にしか効かない。 */
  function applyMargin(std, marginPct) {
    var k = 1 - (marginPct || 0) / 100;
    var out = JSON.parse(JSON.stringify(std));
    out.ctd = std.ctd * k;                        // 輝度変化の閾値を下げる
    if (out.area && out.area.ratio) out.area.ratio = std.area.ratio * k;
    if (out.michelson) out.michelson = std.michelson * k;
    // darkMax は緩める方向になるため変更しない
    out.darkMax = std.darkMax;
    return out;
  }

  /* ---------------------------------------------------------------------
     赤閃光の検出（仕様書 §3.4）

     ⚠ 「赤成分比の変化量」で検出してはならない。
        規格の定義は **飽和赤（R/(R+G+B) ≥ 0.8）の状態への／からの遷移** であり、
        かつ CIE 1976 UCS 上の距離が 0.2 を超えること。

        変化量で判定すると、白（比 1/3 ≈ 0.333）と黒（比 0）の点滅が
        「0.333 の変化」として赤閃光に化ける。実測でこの誤検出を確認済み
        （白黒点滅の t5_center が全基準で抵触になった）。

     状態遷移で判定するため、直前フレームのリニアRGBを保持する。
     --------------------------------------------------------------------- */
  function RedFlashDetector(n, opts) {
    opts = opts || {};
    this.n = n;
    this.satThresh = opts.satThresh != null ? opts.satThresh : 0.8;
    this.ucsThresh = opts.ucsThresh != null ? opts.ucsThresh : 0.2;
    /* 色相が定義できない極端な暗部を除くための下限。
       ⚠ 低輝度の赤は実際に危険（ポケモン事件は低輝度の赤/青交替）なので、
          ここを大きくしてはならない。ゼロ除算回避の最小値にとどめる。 */
    this.minSum = opts.minSum != null ? opts.minSum : 1e-4;
    this.state = new Int8Array(n);      // 0=非飽和赤, 1=飽和赤
    this.dir = new Int8Array(n);        // 直前の遷移方向
    this.pR = new Float32Array(n);
    this.pG = new Float32Array(n);
    this.pB = new Float32Array(n);
    this.mask = new Uint8Array(n);      // このフレームで遷移した画素
    this.started = false;
  }
  RedFlashDetector.prototype._isRed = function (R, G, B, i) {
    var s = R[i] + G[i] + B[i];
    if (s < this.minSum) return 0;
    return (R[i] / s) >= this.satThresh ? 1 : 0;
  };
  RedFlashDetector.prototype.step = function (R, G, B, tUs) {
    var n = this.n, m = this.mask;
    m.fill(0);
    if (!this.started) {
      for (var i = 0; i < n; i++) this.state[i] = this._isRed(R, G, B, i);
      this.pR.set(R); this.pG.set(G); this.pB.set(B);
      this.started = true;
      return;
    }
    for (var j = 0; j < n; j++) {
      var cur = this._isRed(R, G, B, j);
      if (cur !== this.state[j]) {
        // UCS 距離（第2条件）
        var a = rgbToUCS(this.pR[j], this.pG[j], this.pB[j]);
        var b = rgbToUCS(R[j], G[j], B[j]);
        if (ucsDistance(a, b) > this.ucsThresh) {
          var nd = cur === 1 ? 1 : -1;
          if (nd !== this.dir[j]) {      // 対向変化のみ計上
            m[j] = 1;
            this.dir[j] = nd;
          }
        }
        this.state[j] = cur;
      }
    }
    this.pR.set(R); this.pG.set(G); this.pB.set(B);
  };

  scope.FSAnalyze = {
    EOTF: EOTF,
    buildLUT: buildLUT,
    toLinearPlanes: toLinearPlanes,
    redSaturation: redSaturation,
    rgbToUCS: rgbToUCS,
    ucsDistance: ucsDistance,
    IntegralImage: IntegralImage,
    TransitionDetector: TransitionDetector,
    RedFlashDetector: RedFlashDetector,
    SlidingWindow: SlidingWindow,
    STANDARDS: STANDARDS,
    applyMargin: applyMargin,
    KR: KR, KG: KG, KB: KB,
    PACKED_RGB: PACKED_RGB,
    PLANAR: PLANAR
  };

})(typeof self !== "undefined" ? self : this);
