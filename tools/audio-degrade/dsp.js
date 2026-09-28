/* =========================================================================
   Audio degradation simulator — dsp.js
   媒体ごとの劣化を、実際に劣化が起きる仕組みに沿って組み立てる（外部ライブラリ不使用）。
   ブラウザ（Worker／メインスレッド）と jsc でのテストの両方から使う。

   入出力: channels = [Float32Array, …]（-1〜1）、fs = サンプリング周波数
   Degrade.render(channels, fs, medium, params, {seed, generations, matchLevel, onProgress}) → channels
   ========================================================================= */
(function (root) {
  "use strict";
  var TAU = Math.PI * 2;

  /* ---------------------------------------------------------------------
     乱数（再現できるように種つき）
     --------------------------------------------------------------------- */
  function rng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }
  function hash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // 工程ごとに独立した乱数（あるつまみを動かしても、他の工程の乱数の並びは変わらない）
  function rngFor(seed, name) { return rng((seed ^ hash(name)) >>> 0); }
  function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }
  function db(x) { return Math.pow(10, x / 20); }

  /* ---------------------------------------------------------------------
     フィルター（RBJ Audio EQ Cookbook の双2次）
     --------------------------------------------------------------------- */
  function coef(type, fs, f, Q, g) {
    var w = TAU * Math.min(Math.max(f, 1), fs * 0.49) / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q), A = Math.pow(10, (g || 0) / 40);
    var b0, b1, b2, a0, a1, a2, sq;
    switch (type) {
      case "lp": b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case "hp": b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case "peak": b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; break;
      case "hs":
        sq = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
        a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; break;
      default: throw new Error("filter " + type);
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function biquad(x, k) {                       // その場で処理（転置直接形 II）
    var b0 = k[0], b1 = k[1], b2 = k[2], a1 = k[3], a2 = k[4], z1 = 0, z2 = 0, n = x.length;
    for (var i = 0; i < n; i++) { var v = x[i], y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; x[i] = y; }
    return x;
  }
  // バターワース（次数は偶数）
  function butter(x, fs, type, f, order) {
    var N = order || 2;
    for (var k = 1; k <= N / 2; k++) biquad(x, coef(type, fs, f, 1 / (2 * Math.cos(Math.PI * (2 * k - 1) / (2 * N)))));
    return x;
  }
  function onePole(x, fs, fc, init) {           // 1次の低域通過（制御信号用）。init は最初の状態
    var a = Math.exp(-TAU * fc / fs), z = init || 0;
    for (var i = 0; i < x.length; i++) { z = x[i] + a * (z - x[i]); x[i] = z; }
    return x;
  }

  /* ---------------------------------------------------------------------
     小道具
     --------------------------------------------------------------------- */
  function rms(x) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }
  function peak(x) { var p = 0; for (var i = 0; i < x.length; i++) { var a = Math.abs(x[i]); if (a > p) p = a; } return p; }
  function scaleTo(x, target) { var r = rms(x); if (r > 0) { var g = target / r; for (var i = 0; i < x.length; i++) x[i] *= g; } return x; }
  function addTo(dst, src, g) { for (var i = 0; i < dst.length; i++) dst[i] += src[i] * g; }
  function toMono(ch) {
    var n = ch[0].length, m = new Float32Array(n), k = 1 / ch.length;
    ch.forEach(function (x) { for (var i = 0; i < n; i++) m[i] += x[i] * k; });
    return m;
  }
  function spread(m, count) { var out = [m]; for (var c = 1; c < count; c++) out.push(new Float32Array(m)); return out; }
  function white(n, r) { var x = new Float32Array(n); for (var i = 0; i < n; i++) x[i] = gauss(r); return x; }
  function pink(n, r) {                          // Paul Kellet のフィルター
    var x = new Float32Array(n), b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (var i = 0; i < n; i++) {
      var w = gauss(r);
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    }
    return x;
  }
  // なめらかな乱数（fc Hz 程度で揺れる、RMS 1）。制御用なので 1/32 の間隔で作って補間する
  function smoothNoise(n, fs, fc, r) {
    var step = 32, m = Math.ceil(n / step) + 2, c = white(m, r);
    onePole(c, fs / step, fc); onePole(c, fs / step, fc);
    scaleTo(c, 1);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) { var p = i / step, j = Math.floor(p), f = p - j; out[i] = c[j] + (c[j + 1] - c[j]) * f; }
    return out;
  }
  function hermite(x, p) {                        // 4点エルミート補間
    var i = Math.floor(p), f = p - i, n = x.length;
    if (i < 0 || i >= n) return 0;
    var xm = x[i > 0 ? i - 1 : 0], x0 = x[i], x1 = x[i + 1 < n ? i + 1 : n - 1], x2 = x[i + 2 < n ? i + 2 : n - 1];
    var c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  /* =====================================================================
     劣化の部品
     ===================================================================== */

  /* 回転むら（ワウ・フラッター）と速度のずれ。
     再生速度 v(t) = (1 + speed)(1 + s(t)) で元の音を読み進める。s(t) は正弦波と乱数の和で、平均 0
       sines:   [[周波数 Hz, 最大のずれ（割合）], …]  … 偏心・キャプスタンなど周期的なもの
       flutter: 最大のずれ（割合）  … 5〜15 Hz あたりの不規則な揺れ
       drift:   最大のずれ（割合）  … 0.3 Hz 前後のゆっくりした不規則な揺れ（テープの張力など） */
  function varispeed(ch, fs, o, r) {
    var n0 = ch[0].length, rate = 1 + (o.speed || 0);
    var outLen = Math.max(1, Math.floor((n0 - 1) / rate));
    var sines = (o.sines || []).filter(function (s) { return s[1] > 0; }).map(function (s) { return { w: TAU * s[0] / fs, a: s[1], ph: r() * TAU }; });
    var fl = o.flutter > 0 ? smoothNoise(outLen, fs, 9, r) : null, dr = o.drift > 0 ? smoothNoise(outLen, fs, 0.35, r) : null;
    var fla = (o.flutter || 0) / Math.SQRT2, dra = (o.drift || 0) / Math.SQRT2;   // RMS × √2 ≒ 最大のずれ
    if (!sines.length && !fl && !dr && rate === 1) return ch;
    var out = ch.map(function () { return new Float32Array(outLen); }), p = 0, C = ch.length;
    for (var i = 0; i < outLen; i++) {
      for (var c = 0; c < C; c++) out[c][i] = hermite(ch[c], p);
      var s = 0;
      for (var k = 0; k < sines.length; k++) s += sines[k].a * Math.sin(sines[k].w * i + sines[k].ph);
      if (fl) s += fla * fl[i];
      if (dr) s += dra * dr[i];
      p += rate * (1 + s);
    }
    return out;
  }

  /* 磁気テープの飽和。録音時の高域強調 → tanh で飽和 → 再生時に戻す。
     小さい音は変わらず、大きい音ほど（特に高域が）圧縮される。drive は録音レベル（dB） */
  function tapeSaturate(ch, fs, driveDb, knee) {
    var g = db(driveDb) * (knee || 0.7);
    var pre = coef("hs", fs, 3000, 0.7, 6), post = coef("hs", fs, 3000, 0.7, -6);
    ch.forEach(function (x) {
      biquad(x, pre);
      for (var i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * g) / g;
      biquad(x, post);
    });
  }

  /* 転写（プリントスルー）: 巻かれたテープの隣の層から、前後 T 秒の音が薄く写る */
  function printThrough(ch, fs, levelDb, sec) {
    if (levelDb <= -89) return;
    var T = Math.round(sec * fs), a = db(levelDb);
    ch.forEach(function (x) {
      var src = butter(new Float32Array(x), fs, "lp", 3000, 2), n = x.length;
      for (var i = 0; i < n; i++) {
        var v = 0;
        if (i + T < n) v += src[i + T];              // 前に聞こえる（プリエコー）
        if (i - T >= 0) v += 0.6 * src[i - T];        // 後ろに聞こえる
        x[i] += a * v;
      }
    });
  }

  /* ドロップアウト: 磁性体の欠けや、ほこりでヘッドが浮く。音が一瞬下がり、高域ほど深く落ちる */
  function dropouts(ch, fs, perMin, maxDb, r) {
    if (perMin <= 0) return;
    var n = ch[0].length, env = new Float32Array(n), t = 0;
    for (;;) {
      t += -Math.log(1 - r()) * 60 / perMin;
      var i0 = Math.floor(t * fs); if (i0 >= n) break;
      var len = Math.floor(fs * Math.exp(Math.log(0.006) + r() * Math.log(0.12 / 0.006)));   // 6〜120 ms（対数一様）
      var depth = 6 + r() * (Math.max(6, maxDb) - 6);
      for (var j = 0; j < len && i0 + j < n; j++) {
        var e = 0.5 - 0.5 * Math.cos(TAU * j / len);
        if (depth * e > env[i0 + j]) env[i0 + j] = depth * e;
      }
    }
    ch.forEach(function (x) {
      var lo = butter(new Float32Array(x), fs, "lp", 1500, 2);
      for (var i = 0; i < n; i++) {
        if (!env[i]) continue;
        var h = x[i] - lo[i];
        x[i] = lo[i] * db(-env[i] * 0.4) + h * db(-env[i]);
      }
    });
  }

  /* 左右の分離の悪さ（クロストーク）。sepDb だけ小さい量が反対側に漏れる */
  function crosstalk(ch, sepDb) {
    if (ch.length < 2) return;
    var a = db(-sepDb), L = ch[0], R = ch[1], k = 1 / (1 + a);
    for (var i = 0; i < L.length; i++) { var l = L[i], rr = R[i]; L[i] = (l + a * rr) * k; R[i] = (rr + a * l) * k; }
  }

  /* ヘッドの傾き（アジマスずれ）: 左右のトラックの読み取りタイミングがずれる */
  function interDelay(ch, fs, us) {
    if (ch.length < 2 || us <= 0) return;
    var d = us * 1e-6 * fs, R = ch[1], src = new Float32Array(R);
    for (var i = 0; i < R.length; i++) R[i] = hermite(src, i - d);
  }

  /* ヒス・表面ノイズなど（RMS が levelDb の雑音）。corr は左右の相関（0〜1） */
  function addNoise(ch, fs, levelDb, kind, r, shape, corr) {
    if (levelDb <= -89) return;
    var n = ch[0].length, gen = kind === "pink" ? pink : white, common = corr > 0 ? gen(n, r) : null;
    ch.forEach(function (x) {
      var nz = gen(n, r);
      if (common) { var a = Math.sqrt(corr), b = Math.sqrt(1 - corr); for (var i = 0; i < n; i++) nz[i] = a * common[i] + b * nz[i]; }
      if (shape) shape(nz);
      scaleTo(nz, db(levelDb));
      addTo(x, nz, 1);
    });
  }

  /* レコードのゴロゴロ（ランブル）: モーターの振動が針を上下に揺らすので、左右は逆相になる */
  function rumble(ch, fs, levelDb, r) {
    if (levelDb <= -89) return;
    var n = ch[0].length, x = white(n, r);
    onePole(x, fs, 12); butter(x, fs, "lp", 35, 4); butter(x, fs, "hp", 8, 2);
    scaleTo(x, db(levelDb));
    ch.forEach(function (c, k) { addTo(c, x, k % 2 ? -1 : 1); });
  }

  /* プチプチ・パチッ（クラックル・ポップ）: 溝のほこりや細かい傷に針が当たるインパルス。
     大きさはまれに大きいもの（べき分布）。音溝の片側の壁に当たることが多いので左右の強さはばらつく */
  function clicks(ch, fs, perSec, levelDb, r, kind) {
    if (perSec <= 0 || levelDb <= -89) return 0;
    var n = ch[0].length, L = db(levelDb), t = 0, pop = kind === "pop", count = 0;
    for (;;) {
      t += -Math.log(1 - r()) / perSec;
      var i0 = Math.floor(t * fs); if (i0 >= n) break;
      burst(ch, fs, i0, L * Math.min(6, Math.pow(1 - r(), -1 / 2.5)), pop, r);
      count++;
    }
    return count;
  }
  function burst(ch, fs, i0, amp, pop, r) {
    var n = ch[0].length, tau = (pop ? 0.0008 + r() * 0.0025 : 0.00004 + r() * 0.0003) * fs;
    var len = Math.min(Math.ceil(tau * 7), n - i0), sign = r() < 0.5 ? -1 : 1, pan = r();
    var gains = ch.length > 1 ? [Math.sqrt(1 - pan * 0.8), Math.sqrt(0.2 + pan * 0.8)] : [1];
    var lp = 0, a = pop ? Math.exp(-TAU * 900 / fs) : 0;
    for (var j = 0; j < len; j++) {
      var v = (j === 0 ? 3 : gauss(r)) * Math.exp(-j / tau);
      lp = v + a * (lp - v);                        // ポップは低めの音（1次の低域通過）
      var s = sign * amp * (pop ? lp * 2.2 : v);
      for (var c = 0; c < ch.length; c++) ch[c][i0 + j] += s * gains[c % 2];
    }
  }
  // 傷: 1回転ごとに同じ場所で鳴る
  function scratch(ch, fs, rpm, levelDb, r) {
    if (levelDb <= -89) return;
    var n = ch[0].length, period = 60 / rpm * fs, i = Math.floor(r() * period), L = db(levelDb);
    while (i < n) { burst(ch, fs, i, L * (0.8 + 0.4 * r()), true, r); i += Math.round(period * (1 + (r() - 0.5) * 0.004)); }
  }

  /* 高域だけの歪み（内周の歪み・トレースの歪み）: 針が細かい溝を追い切れない */
  function hfDistort(ch, fs, amount) {
    if (amount <= 0) return;
    var k = 1 + amount * 12;
    ch.forEach(function (x) {
      var h = butter(new Float32Array(x), fs, "hp", 2500, 2);
      for (var i = 0; i < x.length; i++) x[i] += Math.tanh(h[i] * k) / k * (1 + amount) - h[i];
    });
  }

  /* ホーンの共鳴（ラッパ吹き込み時代の録音）: 数か所の鋭い山 */
  function horn(ch, fs, amount, r) {
    if (amount <= 0) return;
    var peaks = [700, 1400, 2600].map(function (f) { return coef("peak", fs, f * (0.8 + r() * 0.4), 3 + r() * 3, amount * (6 + r() * 5)); });
    ch.forEach(function (x) { peaks.forEach(function (p) { biquad(x, p); }); });
  }

  /* μ-law（G.711）: 8 kHz・8 ビット（符号 + 7 ビット）に落として戻す */
  function mulaw8k(x, fs) {
    var ratio = fs / 8000, m = Math.floor((x.length - 1) / ratio), low = new Float32Array(m), MU = 255, LN = Math.log(1 + MU);
    for (var i = 0; i < m; i++) {
      var p = i * ratio, j = Math.floor(p), f = p - j, v = x[j] + ((x[j + 1] || 0) - x[j]) * f;
      v = Math.max(-1, Math.min(1, v));
      var q = Math.round(Math.sign(v) * Math.log(1 + MU * Math.abs(v)) / LN * 127) / 127;
      low[i] = Math.sign(q) * (Math.pow(1 + MU, Math.abs(q)) - 1) / MU;
    }
    for (i = 0; i < x.length; i++) x[i] = hermite(low, i / ratio);
    return x;
  }

  /* 放送局のコンプレッサー（振幅の揃った「ラジオっぽい」音） */
  function compress(x, fs, amount) {
    if (amount <= 0) return x;
    var ratio = 1 + amount * 9, th = db(-24 + amount * 6), att = Math.exp(-1 / (0.002 * fs)), rel = Math.exp(-1 / (0.2 * fs)), env = 0;
    for (var i = 0; i < x.length; i++) {
      var a = Math.abs(x[i]);
      env = a > env ? a + att * (env - a) : a + rel * (env - a);
      x[i] *= env > th ? Math.pow(th / env, 1 - 1 / ratio) : 1;
    }
    return x;
  }

  /* =====================================================================
     媒体
     params: 画面のつまみの定義（id は index.html の文言 t.p.<id> と対応）
     process(ch, fs, p, seed) は ch を加工して返す（長さが変わることがある）
     ===================================================================== */
  var MEDIA = {};

  /* ---- カセットテープ ---- */
  MEDIA.cassette = {
    params: [
      { id: "speed", min: -3, max: 3, step: 0.1, def: 0, unit: "%" },
      { id: "wow", min: 0, max: 1.5, step: 0.01, def: 0.12, unit: "%" },
      { id: "flutter", min: 0, max: 0.6, step: 0.01, def: 0.06, unit: "%" },
      { id: "drive", min: -6, max: 12, step: 0.5, def: 0, unit: "dB" },
      { id: "hiss", min: -90, max: -30, step: 1, def: -58, unit: "dB" },
      { id: "hf", min: 3000, max: 18000, step: 100, def: 12000, unit: "Hz" },
      { id: "azimuth", min: 0, max: 150, step: 1, def: 15, unit: "µs" },
      { id: "dropouts", min: 0, max: 30, step: 0.5, def: 1, unit: "/min" },
      { id: "print", min: -90, max: -30, step: 1, def: -66, unit: "dB" },
      { id: "sep", min: 10, max: 60, step: 1, def: 35, unit: "dB" }
    ],
    presets: {
      light: { wow: 0.06, flutter: 0.03, drive: -3, hiss: -66, hf: 15000, azimuth: 5, dropouts: 0, print: -90, sep: 45 },
      heavy: { speed: 1.5, wow: 0.45, flutter: 0.2, drive: 8, hiss: -46, hf: 7000, azimuth: 60, dropouts: 8, print: -48, sep: 22 }
    },
    process: function (ch, fs, p, seed) {
      tapeSaturate(ch, fs, p.drive);
      printThrough(ch, fs, p.print, 1.8);
      dropouts(ch, fs, p.dropouts, 24, rngFor(seed, "drop"));
      ch = varispeed(ch, fs, { speed: p.speed / 100, sines: [[1.1, p.wow / 100 * 0.6], [3.3, p.wow / 100 * 0.3]], drift: p.wow / 100 * 0.5, flutter: p.flutter / 100 }, rngFor(seed, "wow"));
      ch.forEach(function (x) { biquad(x, coef("peak", fs, 70, 1, 2.5)); butter(x, fs, "lp", p.hf, 2); butter(x, fs, "hp", 25, 2); });
      interDelay(ch, fs, p.azimuth);
      // 録音レベルを上げるほど、再生時に戻すぶんヒスは相対的に小さくなる
      addNoise(ch, fs, p.hiss - Math.max(0, p.drive), "white", rngFor(seed, "hiss"), function (nz) { butter(nz, fs, "lp", Math.min(p.hf * 1.2, fs * 0.45), 2); butter(nz, fs, "hp", 150, 2); }, 0);
      crosstalk(ch, p.sep);
      return ch;
    }
  };

  /* ---- レコード（33⅓・45 回転） ---- */
  function recordCommon(ch, fs, p, seed, rpm) {
    hfDistort(ch, fs, p.distortion);
    // 偏心: 1回転に1回、音程が上下する
    return varispeed(ch, fs, { sines: [[rpm / 60, p.wow / 100]], drift: p.wow / 100 * 0.2 }, rngFor(seed, "wow"));
  }
  MEDIA.vinyl = {
    params: [
      { id: "rpm", type: "choice", choices: ["33", "45"], def: "33" },
      { id: "crackle", min: 0, max: 60, step: 0.5, def: 5, unit: "/s" },
      { id: "crackleLv", min: -60, max: -10, step: 1, def: -34, unit: "dB" },
      { id: "pops", min: 0, max: 40, step: 0.5, def: 2, unit: "/min" },
      { id: "scratch", min: -90, max: -20, step: 1, def: -90, unit: "dB" },
      { id: "surface", min: -90, max: -30, step: 1, def: -58, unit: "dB" },
      { id: "rumble", min: -90, max: -30, step: 1, def: -62, unit: "dB" },
      { id: "wow", min: 0, max: 1, step: 0.01, def: 0.12, unit: "%" },
      { id: "distortion", min: 0, max: 1, step: 0.01, def: 0.1, unit: "" },
      { id: "hf", min: 6000, max: 20000, step: 100, def: 16000, unit: "Hz" },
      { id: "sep", min: 10, max: 45, step: 1, def: 26, unit: "dB" }
    ],
    presets: {
      light: { crackle: 1, crackleLv: -42, pops: 0.5, surface: -66, rumble: -70, wow: 0.05, distortion: 0, hf: 18000, sep: 30 },
      heavy: { crackle: 25, crackleLv: -24, pops: 10, scratch: -30, surface: -46, rumble: -50, wow: 0.4, distortion: 0.45, hf: 10000, sep: 18 }
    },
    process: function (ch, fs, p, seed) {
      var rpm = p.rpm === "45" ? 45 : 100 / 3;
      ch = recordCommon(ch, fs, p, seed, rpm);
      ch.forEach(function (x) { butter(x, fs, "lp", p.hf, 2); });
      crosstalk(ch, p.sep);
      addNoise(ch, fs, p.surface, "pink", rngFor(seed, "surf"), function (nz) { butter(nz, fs, "hp", 400, 2); butter(nz, fs, "lp", Math.min(p.hf, fs * 0.45), 2); }, 0.3);
      rumble(ch, fs, p.rumble, rngFor(seed, "rumble"));
      clicks(ch, fs, p.crackle, p.crackleLv, rngFor(seed, "crackle"), "crackle");
      clicks(ch, fs, p.pops / 60, p.crackleLv + 8, rngFor(seed, "pops"), "pop");
      scratch(ch, fs, rpm, p.scratch, rngFor(seed, "scratch"));
      return ch;
    }
  };

  /* ---- SP 盤（78 回転・シェラック、モノラル） ---- */
  MEDIA.sp = {
    mono: true,
    params: [
      { id: "lo", min: 60, max: 500, step: 5, def: 180, unit: "Hz" },
      { id: "hi", min: 2500, max: 10000, step: 100, def: 5000, unit: "Hz" },
      { id: "horn", min: 0, max: 1, step: 0.01, def: 0.5, unit: "" },
      { id: "crackle", min: 0, max: 80, step: 0.5, def: 20, unit: "/s" },
      { id: "crackleLv", min: -60, max: -10, step: 1, def: -28, unit: "dB" },
      { id: "pops", min: 0, max: 40, step: 0.5, def: 6, unit: "/min" },
      { id: "scratch", min: -90, max: -20, step: 1, def: -90, unit: "dB" },
      { id: "surface", min: -90, max: -25, step: 1, def: -40, unit: "dB" },
      { id: "wow", min: 0, max: 1.5, step: 0.01, def: 0.25, unit: "%" },
      { id: "distortion", min: 0, max: 1, step: 0.01, def: 0.25, unit: "" }
    ],
    presets: {
      light: { lo: 100, hi: 8000, horn: 0.2, crackle: 8, crackleLv: -34, pops: 2, surface: -50, wow: 0.12, distortion: 0.1 },
      heavy: { lo: 300, hi: 3500, horn: 0.9, crackle: 40, crackleLv: -20, pops: 15, scratch: -26, surface: -32, wow: 0.5, distortion: 0.5 }
    },
    process: function (ch, fs, p, seed) {
      horn(ch, fs, p.horn, rngFor(seed, "horn"));
      ch.forEach(function (x) { butter(x, fs, "hp", p.lo, 4); butter(x, fs, "lp", p.hi, 4); });
      ch = recordCommon(ch, fs, p, seed, 78);
      // 表面ノイズは帯域の広いザーッという音（シェラックは粒子が粗い）。モノラルなので左右同じ
      addNoise(ch, fs, p.surface, "pink", rngFor(seed, "surf"), function (nz) { butter(nz, fs, "hp", 250, 2); butter(nz, fs, "lp", Math.min(p.hi * 1.6, fs * 0.45), 2); }, 1);
      var mono = [ch[0]];
      clicks(mono, fs, p.crackle, p.crackleLv, rngFor(seed, "crackle"), "crackle");
      clicks(mono, fs, p.pops / 60, p.crackleLv + 8, rngFor(seed, "pops"), "pop");
      scratch(mono, fs, 78, p.scratch, rngFor(seed, "scratch"));
      return spread(ch[0], ch.length);
    }
  };

  /* ---- VHS ---- */
  function isLinear(p) { return p.mode === "linear"; }
  function isHifi(p) { return p.mode === "hifi"; }
  MEDIA.vhs = {
    params: [
      { id: "mode", type: "choice", choices: ["linear", "hifi"], def: "linear" },
      { id: "tape", type: "choice", choices: ["sp", "ep"], def: "sp", show: isLinear },
      { id: "tv", type: "choice", choices: ["ntsc", "pal"], def: "ntsc", show: isHifi },
      { id: "mono", type: "bool", def: true, show: isLinear },
      { id: "hiss", min: -90, max: -30, step: 1, def: -48, unit: "dB", show: isLinear },
      { id: "buzz", min: -90, max: -30, step: 1, def: -58, unit: "dB", show: isHifi },
      { id: "breathing", min: 0, max: 1, step: 0.01, def: 0.3, unit: "", show: isHifi },
      { id: "wow", min: 0, max: 1.5, step: 0.01, def: 0.15, unit: "%" },
      { id: "flutter", min: 0, max: 0.8, step: 0.01, def: 0.12, unit: "%" },
      { id: "dropouts", min: 0, max: 30, step: 0.5, def: 2, unit: "/min" }
    ],
    presets: {
      light: { wow: 0.08, flutter: 0.05, hiss: -56, dropouts: 0, buzz: -70, breathing: 0.1 },
      heavy: { tape: "ep", wow: 0.35, flutter: 0.3, hiss: -40, dropouts: 10, buzz: -44, breathing: 0.7 }
    },
    process: function (ch, fs, p, seed) {
      if (p.mode === "linear") {
        // ノーマル音声（テープの端の固定トラック）: テープ速度が遅いので帯域が狭くヒスが多い
        if (p.mono) ch = spread(toMono(ch), ch.length);
        tapeSaturate(ch, fs, 2, 0.8);
        dropouts(ch, fs, p.dropouts, 20, rngFor(seed, "drop"));
        ch = varispeed(ch, fs, { sines: [[0.5, p.wow / 100 * 0.5]], drift: p.wow / 100 * 0.5, flutter: p.flutter / 100 }, rngFor(seed, "wow"));
        var top = p.tape === "ep" ? 6000 : 10000;
        ch.forEach(function (x) { butter(x, fs, "hp", 80, 2); butter(x, fs, "lp", top, 4); });
        addNoise(ch, fs, p.hiss + (p.tape === "ep" ? 5 : 0), "white", rngFor(seed, "hiss"), function (nz) { butter(nz, fs, "lp", top, 4); butter(nz, fs, "hp", 200, 2); }, p.mono ? 1 : 0);
        return ch;
      }
      // Hi-Fi 音声（回転ヘッドで FM 記録）: 帯域は広いが、フィールドごとのヘッド切り替えでブーンという音が乗り、
      // 1:2 のコンパンダーで雑音が音の大きさにつれて浮き沈みする（ブリージング）
      dropouts(ch, fs, p.dropouts * 0.5, 14, rngFor(seed, "drop"));
      ch = varispeed(ch, fs, { drift: p.wow / 100 * 0.4, flutter: p.flutter / 100 * 0.4 }, rngFor(seed, "wow"));
      var n = ch[0].length, field = p.tv === "pal" ? 50 : 60000 / 1001, env = new Float32Array(n), mono = toMono(ch);
      var att = Math.exp(-1 / (0.005 * fs)), rel = Math.exp(-1 / (0.12 * fs)), e = 0, i;
      for (i = 0; i < n; i++) { var a = Math.abs(mono[i]); e = a > e ? a + att * (e - a) : a + rel * (e - a); env[i] = e; }
      var rr = rngFor(seed, "hifi"), buzz = new Float32Array(n), period = fs / field, t = rr() * period;
      while (t < n) {
        var i0 = Math.floor(t);
        for (var j = 0; j < 40 && i0 + j < n; j++) buzz[i0 + j] += Math.exp(-j / 6) * (j % 2 ? -1 : 1);
        t += period;
      }
      butter(buzz, fs, "hp", 400, 2); butter(buzz, fs, "lp", 6000, 2);
      scaleTo(buzz, p.buzz <= -89 ? 0 : db(p.buzz));
      var hiss = white(n, rr); butter(hiss, fs, "hp", 300, 2); scaleTo(hiss, db(-80));
      ch.forEach(function (x) {
        for (var i = 0; i < n; i++) {
          var mod = 1 - p.breathing + p.breathing * Math.min(1, env[i] * 12);
          x[i] += buzz[i] * (0.4 + 0.6 * mod) + hiss[i] * mod * (1 + p.breathing * 20);
        }
      });
      return ch;
    }
  };

  /* ---- 電話 ---- */
  MEDIA.phone = {
    mono: true,
    params: [
      { id: "line", type: "choice", choices: ["digital", "analog"], def: "digital" },
      { id: "lo", min: 100, max: 600, step: 10, def: 300, unit: "Hz" },
      { id: "hi", min: 2000, max: 4000, step: 50, def: 3400, unit: "Hz" },
      { id: "distortion", min: 0, max: 1, step: 0.01, def: 0.2, unit: "" },
      { id: "hum", min: -90, max: -30, step: 1, def: -70, unit: "dB", show: function (p) { return p.line === "analog"; } },
      { id: "mains", type: "choice", choices: ["50", "60"], def: "50", show: function (p) { return p.line === "analog"; } },
      { id: "noise", min: -90, max: -30, step: 1, def: -62, unit: "dB" }
    ],
    presets: {
      light: { distortion: 0, hum: -90, noise: -80 },
      heavy: { line: "analog", lo: 400, hi: 2800, distortion: 0.6, hum: -45, noise: -42 }
    },
    process: function (ch, fs, p, seed) {
      var x = toMono(ch), r = rngFor(seed, "phone"), i;
      // 送話器（カーボンマイク）の非対称な歪み
      if (p.distortion > 0) {
        var g = 1 + p.distortion * 6, b = 0.15 * p.distortion, off = Math.tanh(b * g);
        for (i = 0; i < x.length; i++) x[i] = (Math.tanh((x[i] + b) * g) - off) / g;
      }
      butter(x, fs, "hp", p.lo, 4); butter(x, fs, "lp", p.hi, 8);
      if (p.line === "digital") { mulaw8k(x, fs); butter(x, fs, "lp", Math.min(p.hi + 200, 3900), 4); }
      else if (p.hum > -89) {                          // 商用電源のハム（奇数倍音を含む）
        var f = +p.mains, hv = db(p.hum) * Math.SQRT2;
        for (i = 0; i < x.length; i++) { var ph = TAU * f * i / fs; x[i] += hv * (Math.sin(ph) + 0.5 * Math.sin(3 * ph) + 0.25 * Math.sin(5 * ph)) / 1.15; }
      }
      addNoise([x], fs, p.noise, "white", r, function (nz) { butter(nz, fs, "hp", p.lo, 2); butter(nz, fs, "lp", p.hi, 4); }, 0);
      return spread(x, ch.length);
    }
  };

  /* ---- AM ラジオ ----
     振幅変調した電波に雑音・空電・混信が加わり、受信機の包絡線検波と AGC で音に戻す、という流れをそのまま計算する。
     搬送波の周波数そのものは扱わず、搬送波からみた複素ベースバンド（I/Q）で計算する */
  MEDIA.am = {
    mono: true,
    params: [
      { id: "bw", min: 2000, max: 6000, step: 100, def: 4500, unit: "Hz" },
      { id: "snr", min: 6, max: 60, step: 1, def: 32, unit: "dB" },
      { id: "fade", min: 0, max: 1, step: 0.01, def: 0.25, unit: "" },
      { id: "fadeRate", min: 0.02, max: 1, step: 0.01, def: 0.15, unit: "Hz" },
      { id: "static", min: 0, max: 20, step: 0.1, def: 1.5, unit: "/s" },
      { id: "whistle", min: -90, max: -20, step: 1, def: -90, unit: "dB" },
      { id: "whistleHz", min: 100, max: 3000, step: 10, def: 800, unit: "Hz" },
      { id: "comp", min: 0, max: 1, step: 0.01, def: 0.6, unit: "" },
      { id: "mod", min: 0.5, max: 1.3, step: 0.01, def: 0.9, unit: "" }
    ],
    presets: {
      light: { snr: 44, fade: 0.05, static: 0.2, comp: 0.5 },
      heavy: { bw: 3000, snr: 16, fade: 0.7, fadeRate: 0.3, static: 8, whistle: -38, mod: 1.15 }
    },
    process: function (ch, fs, p, seed) {
      var x = toMono(ch), n = x.length, r = rngFor(seed, "am"), i;
      // 送信側: 帯域制限 → コンプレッサー → ピークを 1 にそろえて変調
      butter(x, fs, "hp", 90, 2); butter(x, fs, "lp", p.bw, 8);
      compress(x, fs, p.comp);
      var pk = peak(x) || 1; for (i = 0; i < n; i++) x[i] /= pk;
      var fadeN = p.fade > 0 ? smoothNoise(n, fs, p.fadeRate, r) : null;
      // 受信機の帯域内の雑音（I/Q）。SNR は無変調の搬送波の電力に対する比
      var nI = white(n, r), nQ = white(n, r);
      butter(nI, fs, "lp", p.bw, 4); butter(nQ, fs, "lp", p.bw, 4);
      var nr = Math.sqrt((rms(nI) * rms(nI) + rms(nQ) * rms(nQ)) / 2) || 1, ns = db(-p.snr) / Math.SQRT2 / nr;
      for (i = 0; i < n; i++) { nI[i] *= ns; nQ[i] *= ns; }
      // 空電（雷などの大きなインパルス）
      if (p.static > 0) {
        var sI = new Float32Array(n), sQ = new Float32Array(n), t = 0;
        for (;;) {
          t += -Math.log(1 - r()) / p.static;
          var i0 = Math.floor(t * fs); if (i0 >= n) break;
          var amp = 0.15 * Math.min(8, Math.pow(1 - r(), -1 / 2)), len = Math.floor(fs * (0.002 + r() * 0.03));
          for (var j = 0; j < len && i0 + j < n; j++) { var e = Math.exp(-3 * j / len); sI[i0 + j] += amp * e * gauss(r); sQ[i0 + j] += amp * e * gauss(r); }
        }
        butter(sI, fs, "lp", p.bw, 4); butter(sQ, fs, "lp", p.bw, 4);
        addTo(nI, sI, 1); addTo(nQ, sQ, 1);
      }
      var W = p.whistle <= -89 ? 0 : db(p.whistle), dw = TAU * p.whistleHz / fs, y = new Float32Array(n);
      for (i = 0; i < n; i++) {
        var A = fadeN ? 1 - p.fade * 0.95 * (0.5 + 0.5 * Math.tanh(1.5 * fadeN[i])) : 1;
        var car = A * Math.max(0, 1 + p.mod * x[i]);          // 変調度が 100% を超えると搬送波が途切れて歪む
        var I = car + nI[i] + W * Math.cos(dw * i), Q = nQ[i] + W * Math.sin(dw * i);   // 混信: 周波数の少しずれた別の搬送波
        y[i] = Math.sqrt(I * I + Q * Q);                       // 包絡線検波
      }
      // 受信側: AGC（ゆっくり追う搬送波の強さで割る）→ 直流分を除いて音に戻す。弱くなると雑音が浮き上がる
      var c0 = 0, nh = Math.min(n, Math.floor(fs * 0.3)); for (i = 0; i < nh; i++) c0 += y[i] / nh;   // 最初から搬送波の強さに合わせておく
      var c = new Float32Array(y); onePole(c, fs, 1.5, c0); onePole(c, fs, 1.5, c0);
      for (i = 0; i < n; i++) y[i] = (y[i] - c[i]) / (p.mod * Math.max(c[i], 0.05));
      butter(y, fs, "hp", 90, 2); butter(y, fs, "lp", p.bw, 4);
      return spread(y, ch.length);
    }
  };

  /* =====================================================================
     まとめて処理
     ===================================================================== */
  function defaults(medium) { var o = {}; MEDIA[medium].params.forEach(function (q) { o[q.id] = q.def; }); return o; }
  function preset(medium, level) {
    var o = defaults(medium), pr = MEDIA[medium].presets[level] || {};
    Object.keys(pr).forEach(function (k) { o[k] = pr[k]; });
    return o;
  }

  // opts: { seed, generations（ダビング回数）, matchLevel（元の音量に合わせる）, onProgress }
  function render(input, fs, medium, params, opts) {
    opts = opts || {};
    var M = MEDIA[medium], p = defaults(medium), seed = (opts.seed >>> 0) || 1, gens = Math.max(1, Math.min(8, opts.generations || 1));
    Object.keys(params || {}).forEach(function (k) { if (k in p) p[k] = params[k]; });
    var ch = input.map(function (x) { return new Float32Array(x); });
    if (M.mono) ch = spread(toMono(ch), ch.length);
    var inR = rms(toMono(input));
    for (var g = 0; g < gens; g++) {
      ch = M.process(ch, fs, p, (seed + g * 7919) >>> 0);   // ダビングのたびに別の乱数（別のテープ・別の盤）
      if (opts.onProgress) opts.onProgress((g + 1) / gens);
    }
    // 音量: 元の平均の大きさ（RMS）に合わせる。どちらの場合もピークが 0 dBFS を超えないようにする
    // 大きなプチ音などで全体の音量が下がらないよう、0.9 を超える瞬間だけを柔らかく抑える（0.989 を超えない）
    var outR = rms(toMono(ch)), gain = opts.matchLevel !== false && outR > 0 && inR > 0 ? inR / outR : 1, K = 0.9, R = 0.089;
    ch.forEach(function (x) {
      for (var i = 0; i < x.length; i++) {
        var v = x[i] * gain, a = Math.abs(v);
        x[i] = a <= K ? v : (v < 0 ? -1 : 1) * (K + R * Math.tanh((a - K) / R));
      }
    });
    return ch;
  }

  var api = {
    MEDIA: MEDIA, render: render, defaults: defaults, preset: preset,
    // テスト用に部品も公開しておく
    _: { rng: rng, gauss: gauss, coef: coef, biquad: biquad, butter: butter, varispeed: varispeed, mulaw8k: mulaw8k,
         rms: rms, peak: peak, clicks: clicks, white: white, pink: pink, db: db, tapeSaturate: tapeSaturate, crosstalk: crosstalk }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Degrade = api;
})(this);
