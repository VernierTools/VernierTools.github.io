"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/fft.js
   空間パターン（縞）検出（仕様書 §5）— 参考枠

   ⚠ この結果は閃光判定と同格の合否バッジにしない。
     ガイドライン側が「縞」を定義しておらず（Wilkins 自身が自動判定には
     不十分と指摘）、実写背景・テクスチャ・圧縮ノイズによる誤検出が
     避けられないため、readout では別枠に「参考検出」として出す。

   ⚠ 視角（cycles/degree）は算出しない。
     画面の物理サイズと視距離が不明なため。ガイドライン側も同じ理由で
     「画面上の明暗の対の本数」で規定している（5対の縞は全画面でも
     画面の1/4でも影響割合がほぼ等しい＝本数指標で足りる）。
   ========================================================================= */
(function (scope) {

  /* =======================================================================
     1. FFT（radix-2。長さは2のべき乗であること）
     ======================================================================= */

  /* ビット反転並べ替え */
  function bitReverse(re, im, n) {
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
  }

  /* 1次元FFT（in-place） */
  function fft1d(re, im, n) {
    bitReverse(re, im, n);
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var i0 = i + k, i1 = i + k + len / 2;
          var ur = re[i0], ui = im[i0];
          var vr = re[i1] * cr - im[i1] * ci;
          var vi = re[i1] * ci + im[i1] * cr;
          re[i0] = ur + vr; im[i0] = ui + vi;
          re[i1] = ur - vr; im[i1] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  /* 2次元FFT（行→列の順。re/im は size*size のFloat64Array） */
  function fft2d(re, im, size) {
    var rowR = new Float64Array(size), rowI = new Float64Array(size);
    var y, x, o;
    for (y = 0; y < size; y++) {
      o = y * size;
      for (x = 0; x < size; x++) { rowR[x] = re[o + x]; rowI[x] = im[o + x]; }
      fft1d(rowR, rowI, size);
      for (x = 0; x < size; x++) { re[o + x] = rowR[x]; im[o + x] = rowI[x]; }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y < size; y++) { rowR[y] = re[y * size + x]; rowI[y] = im[y * size + x]; }
      fft1d(rowR, rowI, size);
      for (y = 0; y < size; y++) { re[y * size + x] = rowR[y]; im[y * size + x] = rowI[y]; }
    }
  }

  /* =======================================================================
     2. 窓関数（Hann）
     ======================================================================= */
  var _hannCache = {};
  function hann2d(size) {
    if (_hannCache[size]) return _hannCache[size];
    var w1 = new Float64Array(size);
    for (var i = 0; i < size; i++) w1[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
    var w = new Float64Array(size * size);
    for (var y = 0; y < size; y++)
      for (var x = 0; x < size; x++) w[y * size + x] = w1[y] * w1[x];
    _hannCache[size] = w;
    return w;
  }

  /* =======================================================================
     3. ブロック解析
     ======================================================================= */

  /* 周波数インデックスを符号付きに（size/2 を超えたら負とみなす） */
  function signedIdx(k, size) { return k > size / 2 ? k - size : k; }

  /* 1ブロックを解析し、縞の主成分を返す。縞と判定できなければ null。

     戻り値:
       k          ブロックあたりのサイクル数（＝縞の対の本数 / ブロック）
       theta      縞の法線方向（度。0=横縞が縦に並ぶ＝縦方向の変化）
       anisotropy 主方向 / 直交方向 のエネルギー比
       clarity    ピーク / 同半径の平均パワー
       pMax,pMin  ブロック内輝度の上位/下位パーセンタイル
       phase      主成分の位相（動きの分類に使う）
  */
  function analyzeBlock(lum, imgW, imgH, x0, y0, size, opts) {
    opts = opts || {};
    /* 異方性の閾値。
       実測値: 縦縞 = 10^9 オーダー / 市松 = 4.8 / 格子 = 0.94
       縞との差が桁違いなので、閾値を 3.0 → 25 に上げても真の縞は取りこぼさない。
       3.0 のままだと市松模様（誘発性はむしろ低い）を縞として誤検出する。 */
    var minAniso = opts.minAnisotropy != null ? opts.minAnisotropy : 25.0;
    var minClarity = opts.minClarity != null ? opts.minClarity : 4.0;

    var n = size * size;
    var re = new Float64Array(n), im = new Float64Array(n);
    var w = hann2d(size);

    /* --- 輝度の取り出し + 平均除去 + 窓かけ --- */
    var sum = 0, cnt = 0;
    var vals = new Float64Array(n);
    for (var y = 0; y < size; y++) {
      var sy = y0 + y; if (sy >= imgH) sy = imgH - 1;
      for (var x = 0; x < size; x++) {
        var sx = x0 + x; if (sx >= imgW) sx = imgW - 1;
        var v = lum[sy * imgW + sx];
        vals[y * size + x] = v;
        sum += v; cnt++;
      }
    }
    var mean = sum / cnt;
    for (var i = 0; i < n; i++) re[i] = (vals[i] - mean) * w[i];

    /* --- パーセンタイル（ゲート判定用。窓をかける前の生値で取る） --- */
    var sorted = Float64Array.from(vals).sort();
    var pMax = sorted[Math.floor(n * 0.95)];
    var pMin = sorted[Math.floor(n * 0.05)];

    fft2d(re, im, size);

    /* --- パワースペクトルのピーク探索（DC近傍を除外） --- */
    var best = -1, bx = 0, by = 0;
    var half = size / 2;
    for (var ky = 0; ky < size; ky++) {
      var sky = signedIdx(ky, size);
      for (var kx = 0; kx < size; kx++) {
        var skx = signedIdx(kx, size);
        if (Math.abs(skx) <= 1 && Math.abs(sky) <= 1) continue;   // DC近傍
        // 半分だけ見る（実信号のスペクトルは点対称）
        if (sky < 0 || (sky === 0 && skx < 0)) continue;
        var idx = ky * size + kx;
        var p = re[idx] * re[idx] + im[idx] * im[idx];
        if (p > best) { best = p; bx = skx; by = sky; }
      }
    }
    if (best <= 0) return null;

    var radius = Math.sqrt(bx * bx + by * by);
    if (radius < 1.5) return null;                    // 低すぎる周波数は縞とみなさない
    if (radius > half - 1) return null;               // Nyquist 際は折り返しの疑い

    /* --- 明瞭さ: ピーク / 同半径帯の平均パワー --- */
    var annSum = 0, annCnt = 0;
    for (var ky2 = 0; ky2 < size; ky2++) {
      var sky2 = signedIdx(ky2, size);
      if (sky2 < 0) continue;
      for (var kx2 = 0; kx2 < size; kx2++) {
        var skx2 = signedIdx(kx2, size);
        if (sky2 === 0 && skx2 < 0) continue;
        var r2 = Math.sqrt(skx2 * skx2 + sky2 * sky2);
        if (Math.abs(r2 - radius) > 1.5) continue;
        var id2 = ky2 * size + kx2;
        annSum += re[id2] * re[id2] + im[id2] * im[id2];
        annCnt++;
      }
    }
    var annMean = annCnt ? annSum / annCnt : 0;
    var clarity = annMean > 0 ? best / annMean : 0;
    if (clarity < minClarity) return null;

    /* --- 異方性: 主方向 vs 直交方向のエネルギー ---
       ⚠ Wilkins は「直交方向のエネルギーの追加はパターンの誘発性を
          増やすのではなく減らす」と明記している。市松模様や格子は縞より
          安全側なので、ピークだけを見ると過検出になる。 */
    var theta = Math.atan2(by, bx);                   // 主成分の方向（ラジアン）
    var eMain = 0, eOrth = 0;
    for (var ky3 = 0; ky3 < size; ky3++) {
      var sky3 = signedIdx(ky3, size);
      if (sky3 < 0) continue;
      for (var kx3 = 0; kx3 < size; kx3++) {
        var skx3 = signedIdx(kx3, size);
        if (sky3 === 0 && skx3 < 0) continue;
        if (Math.abs(skx3) <= 1 && Math.abs(sky3) <= 1) continue;
        var id3 = ky3 * size + kx3;
        var p3 = re[id3] * re[id3] + im[id3] * im[id3];
        var a3 = Math.atan2(sky3, skx3);
        var d = Math.abs(angDiff(a3, theta));
        if (d < Math.PI / 8) eMain += p3;
        else if (Math.abs(d - Math.PI / 2) < Math.PI / 8) eOrth += p3;
      }
    }
    var aniso = eOrth > 1e-20 ? eMain / eOrth : (eMain > 0 ? Infinity : 0);
    if (aniso < minAniso) return null;

    var pkIdx = ((by + size) % size) * size + ((bx + size) % size);
    var phase = Math.atan2(im[pkIdx], re[pkIdx]);

    return {
      k: radius,                                       // ブロックあたりのサイクル数
      theta: theta * 180 / Math.PI,
      anisotropy: aniso,
      clarity: clarity,
      pMax: pMax, pMin: pMin,
      contrast: pMax - pMin,
      phase: phase,
      kx: bx, ky: by
    };
  }

  function angDiff(a, b) {
    var d = a - b;
    while (d > Math.PI / 2) d -= Math.PI;              // 方向は180度周期
    while (d < -Math.PI / 2) d += Math.PI;
    return d;
  }

  /* =======================================================================
     4. フレーム全体の縞検出
     ======================================================================= */

  /* ゲート条件（仕様書 §5.4）。相対輝度（0..1、ピーク白200cd/m²前提）。
       縞として数える最小輝度差 : 3 cd/m²  → 0.015
       最明縞の輝度             : 50 cd/m² → 0.25
   */
  var GATE = { minContrast: 0.015, minBright: 0.25 };

  /* 1フレームを走査し、縞と判定されたブロックを連結して領域を返す */
  function detectFrame(lum, w, h, opts) {
    opts = opts || {};
    var B = opts.blockSize || 128;
    if (w < B || h < B) B = Math.pow(2, Math.floor(Math.log2(Math.min(w, h))));
    if (B < 16) return { regions: [], blocks: [] };
    var step = Math.floor(B / 2);                      // 50%オーバーラップ
    var gate = opts.gate || GATE;

    var blocks = [];
    for (var y = 0; y + B <= h; y += step) {
      for (var x = 0; x + B <= w; x += step) {
        var r = analyzeBlock(lum, w, h, x, y, B, opts);
        if (!r) continue;
        if (r.contrast < gate.minContrast) continue;   // 3 cd/m² 未満は縞とみなさない
        if (r.pMax < gate.minBright) continue;         // 最明縞 50 cd/m² 未満
        r.x = x; r.y = y; r.size = B;
        blocks.push(r);
      }
    }
    if (!blocks.length) return { regions: [], blocks: [] };

    /* --- 周波数・方向が整合する隣接ブロックを連結 --- */
    var used = new Array(blocks.length).fill(false);
    var regions = [];
    for (var i = 0; i < blocks.length; i++) {
      if (used[i]) continue;
      var queue = [i]; used[i] = true;
      var members = [];
      while (queue.length) {
        var ci = queue.pop();
        members.push(blocks[ci]);
        for (var j = 0; j < blocks.length; j++) {
          if (used[j]) continue;
          if (!adjacent(blocks[ci], blocks[j], step)) continue;
          if (!compatible(blocks[ci], blocks[j])) continue;
          used[j] = true; queue.push(j);
        }
      }
      regions.push(makeRegion(members, w, h, B));
    }
    regions.sort(function (a, b) { return b.areaRatio - a.areaRatio; });
    return { regions: regions, blocks: blocks };
  }

  function adjacent(a, b, step) {
    return Math.abs(a.x - b.x) <= step * 1.01 && Math.abs(a.y - b.y) <= step * 1.01;
  }
  function compatible(a, b) {
    if (Math.abs(a.k - b.k) / Math.max(a.k, b.k) > 0.15) return false;   // 周波数 ±15%
    var d = Math.abs(angDiff(a.theta * Math.PI / 180, b.theta * Math.PI / 180)) * 180 / Math.PI;
    return d <= 15;                                                       // 方向 ±15°
  }

  /* 領域を確定し、縞の対の本数を算出する。

     k はブロックあたりのサイクル数。1画素あたりのサイクル数は k/B。
     領域を縞の法線方向に横断する長さを L 画素とすると、
     その領域に見えている明暗の対の本数は (k/B) × L。 */
  function makeRegion(members, imgW, imgH, B) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var kSum = 0, thSum = 0, pMax = 0, cSum = 0;
    members.forEach(function (m) {
      x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y);
      x1 = Math.max(x1, m.x + m.size); y1 = Math.max(y1, m.y + m.size);
      kSum += m.k; cSum += m.contrast;
      if (m.pMax > pMax) pMax = m.pMax;
      thSum += m.theta;
    });
    x1 = Math.min(x1, imgW); y1 = Math.min(y1, imgH);
    var n = members.length;
    var k = kSum / n;
    var theta = thSum / n;
    var rad = theta * Math.PI / 180;
    var rw = x1 - x0, rh = y1 - y0;
    // 法線方向に領域を横断する長さ
    var L = Math.abs(rw * Math.cos(rad)) + Math.abs(rh * Math.sin(rad));
    var pairs = (k / B) * L;

    return {
      x0: x0, y0: y0, x1: x1, y1: y1,
      blocks: n,
      k: k, theta: theta,
      pairs: pairs,
      brightest: pMax,
      contrast: cSum / n,
      areaRatio: (rw * rh) / (imgW * imgH),
      phase: members[0].phase
    };
  }

  /* ---------------------------------------------------------------------
     画面全体を1枚のFFTで見るパス。

     ⚠ ブロック分割だけでは少ない本数の縞を正しく数えられない。
       128pxブロックには、画面全体で5対の縞なら 5×128/512 = 1.25 周期しか
       入らず、整数ビンに乗らないうえ低周波側の除外に引っかかる
       （実測で3〜5対がすべて検出できなかった）。
       ガイドラインが問題にするのは 5対・8対といった少ない本数なので、
       この帯域を落とすと検出器として意味をなさない。

     そこで画面全体を正方形にリサンプルして1回FFTし、
     そこで得た周波数を「画面あたりのサイクル数」＝縞の対の本数として扱う。
     ブロック分割は「どこに縞があるか（領域と面積）」の特定に使う。
     --------------------------------------------------------------------- */
  function detectGlobal(lum, w, h, opts) {
    opts = opts || {};
    var S = opts.globalSize || 256;                    // 2のべき乗
    var gate = opts.gate || GATE;

    // 面積平均で正方形にリサンプル
    var acc = new Float64Array(S * S), cnt = new Float64Array(S * S);
    var xs = S / w, ys = S / h;
    for (var y = 0; y < h; y++) {
      var dy = (y * ys) | 0; if (dy >= S) dy = S - 1;
      for (var x = 0; x < w; x++) {
        var dx = (x * xs) | 0; if (dx >= S) dx = S - 1;
        var di = dy * S + dx;
        acc[di] += lum[y * w + x]; cnt[di]++;
      }
    }
    var small = new Float32Array(S * S);
    for (var i = 0; i < S * S; i++) small[i] = acc[i] / (cnt[i] || 1);

    var r = analyzeBlock(small, S, S, 0, 0, S, opts);
    if (!r) return null;
    if (r.contrast < gate.minContrast) return null;
    if (r.pMax < gate.minBright) return null;

    /* リサンプル後の k は「画面あたりのサイクル数」そのもの。
       ただしアスペクト比を潰しているので、方向に応じて元の比率へ戻す。 */
    var rad = r.theta * Math.PI / 180;
    var kx = r.kx * (w / S) / (w / S);                  // x方向は画面幅あたり
    var pairs = r.k;                                    // 正方リサンプル後の対数
    // 縞が斜めのとき、画面上で実際に横切る本数は縦横比の影響を受ける
    var ax = Math.abs(r.kx), ay = Math.abs(r.ky);
    pairs = Math.sqrt(ax * ax + ay * ay);

    return {
      pairs: pairs,
      k: r.k,
      theta: r.theta,
      anisotropy: r.anisotropy,
      clarity: r.clarity,
      brightest: r.pMax,
      contrast: r.contrast,
      phase: r.phase,
      kx: r.kx, ky: r.ky
    };
  }

  /* =======================================================================
     5. 動きの分類（位相追跡・仕様書 §5.5）
     ======================================================================= */

  /* 主成分の位相 φ(t) をフレーム間で追う。
       φ がほぼ一定        → 静止        （上限 8対）
       φ が単調増加/減少   → 一方向ドリフト（上限 8対 / Wilkins原案 12対）
       φ が振動 / π跳躍    → 振動・反転  （上限 5対）*/
  function PhaseTracker(opts) {
    opts = opts || {};
    this.hist = [];
    this.maxLen = opts.maxLen || 24;
  }
  PhaseTracker.prototype.push = function (phase, tUs) {
    this.hist.push({ p: phase, t: tUs });
    if (this.hist.length > this.maxLen) this.hist.shift();
  };
  PhaseTracker.prototype.classify = function () {
    var h = this.hist;
    if (h.length < 4) return "static";
    var d = [], i;
    for (i = 1; i < h.length; i++) {
      var dp = h[i].p - h[i - 1].p;
      while (dp > Math.PI) dp -= 2 * Math.PI;
      while (dp < -Math.PI) dp += 2 * Math.PI;
      d.push(dp);
    }
    var absMean = 0, signSum = 0, flips = 0;
    for (i = 0; i < d.length; i++) {
      absMean += Math.abs(d[i]);
      signSum += d[i] > 0 ? 1 : (d[i] < 0 ? -1 : 0);
      if (i > 0 && d[i] * d[i - 1] < 0 && Math.abs(d[i]) > 0.3) flips++;
    }
    absMean /= d.length;
    if (absMean < 0.12) return "static";
    // 符号が揃っていれば一方向ドリフト
    if (Math.abs(signSum) >= d.length * 0.7) return "drift";
    if (flips >= 2) return "oscillating";
    return "drift";
  };

  /* 分類ごとの縞の上限（§5.5） */
  var PAIR_LIMIT = {
    ofcom:  { static: 5, drift: 5, oscillating: 5 },      // Ofcom は一律5対
    ef2005: { static: 8, drift: 8, oscillating: 5 },      // EF合意2005
    wilkins:{ static: 8, drift: 12, oscillating: 5 }      // Wilkins原案
  };

  scope.FSFft = {
    fft1d: fft1d,
    fft2d: fft2d,
    hann2d: hann2d,
    analyzeBlock: analyzeBlock,
    detectFrame: detectFrame,
    detectGlobal: detectGlobal,
    PhaseTracker: PhaseTracker,
    PAIR_LIMIT: PAIR_LIMIT,
    GATE: GATE
  };

})(typeof self !== "undefined" ? self : this);
