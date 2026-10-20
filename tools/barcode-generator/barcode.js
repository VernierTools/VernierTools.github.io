/* =========================================================================
   Barcode generator — barcode.js（符号化だけ。描画は index.html）
   Barcode.encode(type, text, opts) は次のどちらかを返す。読めない入力は Error を投げる（message は文言のキー）。
     1 次元: { dim:1, mods:[0/1…], guards:[true/false…], text:人が読む文字, hri:{…}, quiet:[左, 右], warn:[…] }
             mods はモジュール（いちばん細いバーの幅）ごとの黒白。guards は EAN/UPC で下へ伸ばすバー。
     2 次元: { dim:2, w, h, grid:Uint8Array(w*h)（1 = 黒）, quiet, info:{…}, warn:[…] }
   対応：EAN-13（JAN）・EAN-8・UPC-A・Code 128（GS1-128）・Code 39・ITF（ITF-14）・QR コード・Data Matrix（ECC 200、GS1）
   ========================================================================= */
(function (root) {
"use strict";

function fail(key, arg) { var e = new Error(key); e.arg = arg; throw e; }
function onlyDigits(s) { return /^[0-9]+$/.test(s); }

/* ---- GS1 のモジュラス 10（EAN・UPC・ITF-14・GTIN の検査数字） ---- */
function mod10(digits) {
  var sum = 0;
  for (var i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += (+digits[i]) * w;
  return (10 - sum % 10) % 10;
}
// n 桁の本体に検査数字を付ける。n+1 桁なら検査数字を確かめる
function withCheck(s, n, warn) {
  if (!onlyDigits(s)) fail("e.digits");
  if (s.length === n) return s + mod10(s);
  if (s.length === n + 1) {
    var c = mod10(s.slice(0, n));
    if (+s[n] !== c) fail("e.check", c);
    return s;
  }
  fail("e.len", n + " / " + (n + 1));
}

/* 幅の並び（バーから始まる）をモジュール列へ */
function widths(ws, mods, startBar) {
  var bar = startBar !== false;
  for (var i = 0; i < ws.length; i++) { for (var k = 0; k < ws[i]; k++) mods.push(bar ? 1 : 0); bar = !bar; }
}

/* =========================================================================
   EAN-13・EAN-8・UPC-A
   ========================================================================= */
var EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
var EAN_G = EAN_L.map(function (p) { return p.split("").map(function (b) { return b === "1" ? "0" : "1"; }).reverse().join(""); });
var EAN_R = EAN_L.map(function (p) { return p.split("").map(function (b) { return b === "1" ? "0" : "1"; }).join(""); });
var EAN_PAR = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function eanBits(parts) {   // parts: [[パターン, ガードか], …]
  var mods = [], guards = [];
  parts.forEach(function (p) { for (var i = 0; i < p[0].length; i++) { mods.push(+p[0][i]); guards.push(!!p[1]); } });
  return { mods: mods, guards: guards };
}
function ean13(s, upc) {
  var d = upc ? "0" + withCheck(s, 11) : withCheck(s, 12);
  var par = EAN_PAR[+d[0]], parts = [["101", true]];
  for (var i = 1; i <= 6; i++) parts.push([(par[i - 1] === "L" ? EAN_L : EAN_G)[+d[i]], upc && i === 1]);
  parts.push(["01010", true]);
  for (i = 7; i <= 12; i++) parts.push([EAN_R[+d[i]], upc && i === 12]);
  parts.push(["101", true]);
  var b = eanBits(parts);
  // 人が読む文字：EAN-13 は先頭の 1 桁を左の余白に、UPC-A は先頭と末尾の 1 桁を左右の余白に出す
  var hri = upc ? { kind: "upc", digits: d.slice(1) } : { kind: "ean13", digits: d };
  return { dim: 1, mods: b.mods, guards: b.guards, text: upc ? d.slice(1) : d, hri: hri, quiet: upc ? [9, 9] : [11, 7], warn: [] };
}
function ean8(s) {
  var d = withCheck(s, 7), parts = [["101", true]];
  for (var i = 0; i < 4; i++) parts.push([EAN_L[+d[i]]]);
  parts.push(["01010", true]);
  for (i = 4; i < 8; i++) parts.push([EAN_R[+d[i]]]);
  parts.push(["101", true]);
  var b = eanBits(parts);
  return { dim: 1, mods: b.mods, guards: b.guards, text: d, hri: { kind: "ean8", digits: d }, quiet: [7, 7], warn: [] };
}

/* =========================================================================
   GS1 の AI（アプリケーション識別子）。"(01)04912345678904(10)ABC" を、FNC1 と文字の並びへ
   あらかじめ長さが決まっている AI の後ろには区切りの FNC1 を入れない（GS1 一般仕様 7.8.5）
   ========================================================================= */
var FNC1 = -1;
var GS1_FIXED = { "00": 20, "01": 16, "02": 16, "03": 16, "04": 18, "11": 8, "12": 8, "13": 8, "14": 8, "15": 8, "16": 8,
  "17": 8, "18": 8, "19": 8, "20": 4, "31": 10, "32": 10, "33": 10, "34": 10, "35": 10, "36": 10, "41": 16 };
function gs1(text, warn) {
  var re = /\((\d{2,4})\)([^()]*)/g, m, out = [FNC1], last = 0, fields = [];
  text = text.trim();
  if (text[0] !== "(") fail("e.gs1");
  while ((m = re.exec(text))) {
    if (m.index !== last) fail("e.gs1");
    last = re.lastIndex;
    if (!m[2].length) fail("e.gs1empty", m[1]);
    fields.push([m[1], m[2]]);
  }
  if (last !== text.length || !fields.length) fail("e.gs1");
  fields.forEach(function (f, i) {
    var ai = f[0], v = f[1], fixed = GS1_FIXED[ai.slice(0, 2)];
    if (fixed && ai.length + v.length !== fixed) fail("e.gs1len", "(" + ai + ") " + (fixed - ai.length));
    if (/^(00|01|02)$/.test(ai)) {
      if (!onlyDigits(v)) fail("e.digits");
      if (mod10(v.slice(0, -1)) !== +v.slice(-1)) warn.push(["w.gs1check", "(" + ai + ") " + mod10(v.slice(0, -1))]);
    }
    for (var k = 0; k < (ai + v).length; k++) {
      var c = (ai + v).charCodeAt(k); if (c > 126 || c < 32) fail("e.ascii"); out.push(c);
    }
    if (!fixed && i < fields.length - 1) out.push(FNC1);
  });
  return { tokens: out, hri: text };
}
function asciiTokens(text, max) {
  var out = [];
  for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); if (c > max) fail("e.ascii"); out.push(c); }
  return out;
}

/* =========================================================================
   Code 128（A・B・C を、記号の数がいちばん少なくなるように切り替える）
   ========================================================================= */
var C128 = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 " +
  "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 " +
  "111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 " +
  "231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 " +
  "141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 " +
  "124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 " +
  "311141 411131 211412 211214 211232 2331112").split(" ");
function c128Val(set, c) {   // その文字の、その文字セットでの値（使えなければ -1）
  if (c === FNC1) return 102;
  if (set === 0) return c < 32 ? c + 64 : c < 96 ? c - 32 : -1;
  if (set === 1) return c >= 32 && c < 128 ? c - 32 : -1;
  return -1;
}
function code128(tokens) {
  var n = tokens.length, INF = 1e9;
  if (!n) fail("e.empty");
  function dig(i) { return i < n && tokens[i] >= 48 && tokens[i] <= 57; }
  // cost[i][s] = i 文字目から最後までを、今の文字セット s で始めたときの最少の記号数
  var cost = [], next = [];
  for (var i = n; i >= 0; i--) {
    cost[i] = [0, 0, 0]; next[i] = [null, null, null];
    if (i === n) continue;
    for (var s = 0; s < 3; s++) {
      var best = INF, how = null;
      for (var t = 0; t < 3; t++) {   // t: この文字を書く文字セット（s と違えば切り替えの記号を 1 つ足す）
        var sw = t === s ? 0 : 1, step, c;
        if (t === 2) {
          if (tokens[i] === FNC1) step = 1; else if (dig(i) && dig(i + 1)) step = 2; else continue;
        } else { if (c128Val(t, tokens[i]) < 0) continue; step = 1; }
        c = sw + 1 + cost[i + step][t];
        if (c < best) { best = c; how = [t, step]; }
      }
      cost[i][s] = best; next[i][s] = how;
    }
  }
  var start = 0, sc = INF;
  for (s = 0; s < 3; s++) if (cost[0][s] < sc) { sc = cost[0][s]; start = s; }
  if (sc >= INF) fail("e.ascii");
  var vals = [103 + start], cur = start;
  for (i = 0; i < n;) {
    var h = next[i][cur];
    if (h[0] !== cur) { vals.push(h[0] === 0 ? 101 : h[0] === 1 ? 100 : 99); cur = h[0]; }
    if (cur === 2) vals.push(tokens[i] === FNC1 ? 102 : (tokens[i] - 48) * 10 + (tokens[i + 1] - 48));
    else vals.push(c128Val(cur, tokens[i]));
    i += h[1];
  }
  var sum = vals[0];
  for (i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103); vals.push(106);
  var mods = [];
  vals.forEach(function (v) { widths(C128[v].split("").map(Number), mods); });
  return { mods: mods, symbols: vals.length };
}

/* =========================================================================
   Code 39（モジュラス 43 の検査文字は任意）・ITF（ITF-14）
   太いバーは細いバーの ratio 倍（モジュールに割り切れるよう、細い = 2 モジュールで描く）
   ========================================================================= */
var C39_CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";
var C39 = ("nnnwwnwnn wnnwnnnnw nnwwnnnnw wnwwnnnnn nnnwwnnnw wnnwwnnnn nnwwwnnnn nnnwnnwnw wnnwnnwnn nnwwnnwnn " +
  "wnnnnwnnw nnwnnwnnw wnwnnwnnn nnnnwwnnw wnnnwwnnn nnwnwwnnn nnnnnwwnw wnnnnwwnn nnwnnwwnn nnnnwwwnn " +
  "wnnnnnnww nnwnnnnww wnwnnnnwn nnnnwnnww wnnnwnnwn nnwnwnnwn nnnnnnwww wnnnnnwwn nnwnnnwwn nnnnwnwwn " +
  "wwnnnnnnw nwwnnnnnw wwwnnnnnn nwnnwnnnw wwnnwnnnn nwwnwnnnn nwnnnnwnw wwnnnnwnn nwwnnnwnn nwnwnwnnn " +
  "nwnwnnnwn nwnnnwnwn nnnwnwnwn").split(" ");
var C39_STAR = "nwnnwnwnn";
function nw(pattern, wide, mods, narrow) {
  widths(pattern.split("").map(function (c) { return c === "w" ? wide : narrow; }), mods);
}
function code39(text, check, ratio) {
  text = text.toUpperCase();
  if (!text.length) fail("e.empty");
  var sum = 0;
  for (var i = 0; i < text.length; i++) { var k = C39_CH.indexOf(text[i]); if (k < 0) fail("e.c39", text[i]); sum += k; }
  var full = text + (check ? C39_CH[sum % 43] : "");
  var W = Math.round(ratio * 2), mods = [];
  [C39_STAR].concat(full.split("").map(function (c) { return C39[C39_CH.indexOf(c)]; })).concat([C39_STAR]).forEach(function (p, j, all) {
    nw(p, W, mods, 2);
    if (j < all.length - 1) { mods.push(0); mods.push(0); }   // 文字間の隙間（細いスペース 1 本）
  });
  return { dim: 1, mods: mods, text: full, hri: { kind: "plain", text: "*" + full + "*" }, quiet: [10, 10], unit: 2, warn: [] };
}
var ITF = ["nnwwn", "wnnnw", "nwnnw", "wwnnn", "nnwnw", "wnwnn", "nwwnn", "nnnww", "wnnwn", "nwnwn"];
function itf(s, mode, ratio, warn) {
  if (!onlyDigits(s)) fail("e.digits");
  if (mode === "itf14") s = withCheck(s, 13);
  else if (s.length % 2) { s = "0" + s; warn.push(["w.itfpad"]); }
  if (!s.length) fail("e.empty");
  var W = Math.round(ratio * 2), mods = [];
  nw("nnnn", W, mods, 2);
  for (var i = 0; i < s.length; i += 2) {
    var a = ITF[+s[i]], b = ITF[+s[i + 1]], p = "";
    for (var k = 0; k < 5; k++) p += a[k] + b[k];   // 1 桁目をバー、2 桁目をスペースに交互に
    nw(p, W, mods, 2);
  }
  nw("wnn", W, mods, 2);
  return { dim: 1, mods: mods, text: s, hri: { kind: "plain", text: s }, quiet: [10, 10], unit: 2, bearer: mode === "itf14", warn: [] };
}

/* =========================================================================
   リード・ソロモン（GF(256)）。QR は原始多項式 0x11D・根 α^0〜、Data Matrix は 0x12D・根 α^1〜
   ========================================================================= */
function GF(prim) {
  var exp = new Uint8Array(512), log = new Uint8Array(256), x = 1;
  for (var i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= prim; }
  for (i = 255; i < 512; i++) exp[i] = exp[i - 255];
  function mul(a, b) { return a && b ? exp[log[a] + log[b]] : 0; }
  return {
    // 生成多項式 Π(x - α^(first+i))、係数は高次から（先頭の 1 は省く）
    gen: function (n, first) {
      var g = [1];
      for (var i = 0; i < n; i++) {
        var r = exp[i + first], ng = new Array(g.length + 1).fill(0);
        for (var j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], r); }
        g = ng;
      }
      return g.slice(1);
    },
    ecc: function (data, g) {
      var r = new Array(g.length).fill(0);
      for (var i = 0; i < data.length; i++) {
        var f = data[i] ^ r[0];
        r.shift(); r.push(0);
        for (var j = 0; j < g.length; j++) r[j] ^= mul(g[j], f);
      }
      return r;
    }
  };
}
var GF_QR = GF(0x11D), GF_DM = GF(0x12D);

function utf8(text) {
  var b = [], s = unescape(encodeURIComponent(text));
  for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
  return b;
}

/* =========================================================================
   QR コード（モデル 2、型番 1〜40）
   ========================================================================= */
var QR_ECC = {   // [ブロックあたりの誤り訂正コード語数, ブロック数]（型番 1〜40）
  L: [[7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
      [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25]],
  M: [[10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
      [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49]],
  Q: [[13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
      [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68]],
  H: [[17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
      [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]]
};
var QR_FMT = { L: 1, M: 0, Q: 3, H: 2 };
var ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function qrRawModules(v) {
  var r = (16 * v + 128) * v + 64;
  if (v >= 2) { var na = Math.floor(v / 7) + 2; r -= (25 * na - 10) * na - 55; if (v >= 7) r -= 36; }
  return r;
}
function qrDataCodewords(v, ecl) {
  return Math.floor(qrRawModules(v) / 8) - QR_ECC[ecl][0][v - 1] * QR_ECC[ecl][1][v - 1];
}
function qrAlign(v) {
  if (v === 1) return [];
  var na = Math.floor(v / 7) + 2, size = v * 4 + 17;
  var step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2, r = [];
  for (var p = size - 7; r.length < na - 1; p -= step) r.unshift(p);
  r.unshift(6);
  return r;
}

/* 文字列を区切り（数字・英数字・8 ビット）に分ける。長さの欄の分も含めて、ビット数がいちばん少なくなる分け方を選ぶ */
function qrSegments(text, gs1Tokens) {
  var units;   // [{c:文字コード, k:可能なモード（N=1,A=2,B=4）, bytes:[…]}]
  if (gs1Tokens) {
    // GS1 QR：先頭の FNC1 はモード指示子で表し、区切りの FNC1 は英数字モードでは %、8 ビットでは GS（29）になる
    units = gs1Tokens.slice(1).map(function (c) {
      if (c === FNC1) return { k: 2 | 4, a: "%", b: [29] };
      var ch = String.fromCharCode(c), k = 4;
      if (c >= 48 && c <= 57) k |= 1;
      if (ALNUM.indexOf(ch) >= 0) k |= 2;
      return { k: k, a: ch === "%" ? "%%" : ch, b: [c], n: ch };
    });
  } else {
    units = Array.from(text).map(function (ch) {
      var k = 4, c = ch.charCodeAt(0);
      if (ch.length === 1 && c >= 48 && c <= 57) k |= 1;
      if (ALNUM.indexOf(ch) >= 0) k |= 2;
      return { k: k, a: ch, b: utf8(ch), n: ch };
    });
  }
  return function (v) {   // 型番によって長さの欄のビット数が違うので、型番ごとに分け直す
    var cc = v <= 9 ? [10, 9, 8] : v <= 26 ? [12, 11, 16] : [14, 13, 16];
    var n = units.length, INF = 1e9;
    // 費用は 6 倍した整数で持つ（数字 3 文字 = 10 ビット、英数字 2 文字 = 11 ビット）
    var cost = [[0, 0, 0]], from = [[null, null, null]];
    var unitCost = function (m, u) { return m === 0 ? 20 : m === 1 ? 33 * u.a.length : 48 * u.b.length; };
    for (var i = 0; i < n; i++) {
      cost[i + 1] = [INF, INF, INF]; from[i + 1] = [null, null, null];
      for (var m = 0; m < 3; m++) {
        if (!(units[i].k & (1 << m))) continue;
        for (var p = 0; p < 3; p++) {
          var base = i === 0 ? 0 : cost[i][p];
          if (base >= INF) continue;
          var head = (i === 0 || p !== m) ? (4 + cc[m]) * 6 : 0;
          var c = base + head + unitCost(m, units[i]);
          if (c < cost[i + 1][m]) { cost[i + 1][m] = c; from[i + 1][m] = p; }
        }
      }
    }
    var bm = 0;
    for (m = 1; m < 3; m++) if (cost[n][m] < cost[n][bm]) bm = m;
    var modes = [];
    for (i = n, m = bm; i > 0; i--) { modes[i - 1] = m; m = from[i][m]; }
    var segs = [];
    for (i = 0; i < n; i++) {
      if (!segs.length || segs[segs.length - 1].m !== modes[i]) segs.push({ m: modes[i], u: [] });
      segs[segs.length - 1].u.push(units[i]);
    }
    var bits = [];
    function put(val, len) { for (var b = len - 1; b >= 0; b--) bits.push((val >>> b) & 1); }
    if (gs1Tokens) put(5, 4);   // FNC1（1 番目の位置）
    segs.forEach(function (s) {
      if (s.m === 0) {
        var d = s.u.map(function (u) { return u.n; }).join("");
        put(1, 4); put(d.length, cc[0]);
        for (var j = 0; j < d.length; j += 3) { var g = d.slice(j, j + 3); put(+g, g.length * 3 + 1); }
      } else if (s.m === 1) {
        var a = s.u.map(function (u) { return u.a; }).join("");
        put(2, 4); put(a.length, cc[1]);
        for (j = 0; j + 1 < a.length; j += 2) put(ALNUM.indexOf(a[j]) * 45 + ALNUM.indexOf(a[j + 1]), 11);
        if (a.length % 2) put(ALNUM.indexOf(a[a.length - 1]), 6);
      } else {
        var by = [];
        s.u.forEach(function (u) { by = by.concat(u.b); });
        put(4, 4); put(by.length, cc[2]);
        by.forEach(function (x) { put(x, 8); });
      }
    });
    return { bits: bits, segs: segs.map(function (s) { return s.m; }) };
  };
}

function qr(text, opt, warn) {
  var ecl = opt.ecl || "M", gs = null;
  if (opt.gs1) gs = gs1(text, warn).tokens;
  if (!text.length) fail("e.empty");
  var seg = qrSegments(text, gs), v, enc;
  for (v = Math.max(1, opt.minVer || 1); v <= 40; v++) {
    enc = seg(v);
    if (enc.bits.length <= qrDataCodewords(v, ecl) * 8) break;
  }
  if (v > 40) fail("e.toolong");
  // 誤り訂正を上げられる余裕があれば上げる（同じ大きさのまま強くなる）
  if (opt.boost) ["M", "Q", "H"].forEach(function (e) {
    if ("LMQH".indexOf(e) > "LMQH".indexOf(ecl) && seg(v).bits.length <= qrDataCodewords(v, e) * 8) ecl = e;
  });
  var bits = enc.bits.slice(), cap = qrDataCodewords(v, ecl) * 8;
  for (var t = 0; t < 4 && bits.length < cap; t++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  var data = [];
  for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var j = 0; j < 8; j++) x = (x << 1) | bits[i + j]; data.push(x); }
  for (var pad = 0xEC; data.length < cap / 8; pad ^= 0xEC ^ 0x11) data.push(pad);

  // ブロックに分けて誤り訂正を付け、交互に並べる
  var eccLen = QR_ECC[ecl][0][v - 1], nb = QR_ECC[ecl][1][v - 1], raw = Math.floor(qrRawModules(v) / 8);
  var nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), g = GF_QR.gen(eccLen, 0), blocks = [], k = 0;
  for (i = 0; i < nb; i++) {
    var dl = shortLen - eccLen + (i < nShort ? 0 : 1), d = data.slice(k, k + dl); k += dl;
    blocks.push({ d: d, e: GF_QR.ecc(d, g) });
  }
  var cw = [];
  for (i = 0; i <= shortLen - eccLen; i++) blocks.forEach(function (b) { if (i < b.d.length) cw.push(b.d[i]); });
  for (i = 0; i < eccLen; i++) blocks.forEach(function (b) { cw.push(b.e[i]); });

  // 機能パターン
  var size = v * 4 + 17, M = new Uint8Array(size * size), F = new Uint8Array(size * size);
  function set(x, y, on) { M[y * size + x] = on ? 1 : 0; F[y * size + x] = 1; }
  for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var xx = c[0] + dx, yy = c[1] + dy, dd = Math.max(Math.abs(dx), Math.abs(dy));
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dd !== 2 && dd !== 4);
    }
  });
  var al = qrAlign(v);
  al.forEach(function (ay, ii) {
    al.forEach(function (ax, jj) {
      if ((ii === 0 && jj === 0) || (ii === 0 && jj === al.length - 1) || (ii === al.length - 1 && jj === 0)) return;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  function drawFormat(mask) {
    var dat = (QR_FMT[ecl] << 3) | mask, rem = dat;
    for (var q = 0; q < 10; q++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var b = ((dat << 10) | rem) ^ 0x5412;
    var bit = function (q) { return (b >>> q) & 1; };
    for (q = 0; q <= 5; q++) set(8, q, bit(q));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (q = 9; q < 15; q++) set(14 - q, 8, bit(q));
    for (q = 0; q < 8; q++) set(size - 1 - q, 8, bit(q));
    for (q = 8; q < 15; q++) set(8, size - 15 + q, bit(q));
    set(8, size - 8, 1);
  }
  drawFormat(0);
  if (v >= 7) {
    var rem = v;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var vb = (v << 12) | rem;
    for (i = 0; i < 18; i++) {
      var on = (vb >>> i) & 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, on); set(b, a, on);
    }
  }
  // データを右下から 2 列ずつジグザグに置く
  var bi = 0;
  for (var right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
      var xx = right - j, up = ((right + 1) & 2) === 0, yy = up ? size - 1 - vert : vert;
      if (!F[yy * size + xx] && bi < cw.length * 8) { M[yy * size + xx] = (cw[bi >>> 3] >>> (7 - (bi & 7))) & 1; bi++; }
    }
  }
  // マスク：8 通りを試し、減点のいちばん少ないものにする
  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; },
    function (x) { return x % 3 === 0; }, function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
    function (x, y) { return x * y % 2 + x * y % 3 === 0; },
    function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }
  ];
  function applyMask(m) {
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!F[y * size + x] && MASKS[m](x, y)) M[y * size + x] ^= 1;
  }
  function penalty() {
    var p = 0, x, y, run, c, dark = 0;
    function lines(get) {
      for (var a = 0; a < size; a++) {
        run = 1;
        for (var b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        // 1:1:3:1:1 の並び（前後に白 4 つ）
        for (b = 0; b + 7 <= size; b++) {
          if (get(a, b) && !get(a, b + 1) && get(a, b + 2) && get(a, b + 3) && get(a, b + 4) && !get(a, b + 5) && get(a, b + 6)) {
            var before = true, after = true;
            for (var q = 1; q <= 4; q++) { if (b - q >= 0 && get(a, b - q)) before = false; if (b + 6 + q < size && get(a, b + 6 + q)) after = false; }
            if (before || after) p += 40;
          }
        }
      }
    }
    lines(function (a, b) { return M[a * size + b]; });
    lines(function (a, b) { return M[b * size + a]; });
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      c = M[y * size + x];
      if (c === M[y * size + x + 1] && c === M[(y + 1) * size + x] && c === M[(y + 1) * size + x + 1]) p += 3;
    }
    for (i = 0; i < size * size; i++) dark += M[i];
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  }
  var best = 0, bestP = Infinity;
  for (var m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    var pp = penalty();
    if (pp < bestP) { bestP = pp; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  var modeNames = enc.segs.map(function (s) { return ["N", "A", "B"][s]; });
  return { dim: 2, w: size, h: size, grid: M, quiet: 4, warn: warn,
    info: { kind: "qr", version: v, ecl: ecl, mask: best, modes: modeNames, capacity: qrDataCodewords(v, ecl), used: Math.ceil(enc.bits.length / 8) } };
}

/* =========================================================================
   Data Matrix（ECC 200）
   ========================================================================= */
// [行, 列, データ領域の行, 列（1 つあたり）, データのコード語数, 誤り訂正のコード語数, RS ブロック数]
var DM = [
  [10,10,8,8,3,5,1],[12,12,10,10,5,7,1],[14,14,12,12,8,10,1],[16,16,14,14,12,12,1],[18,18,16,16,18,14,1],
  [20,20,18,18,22,18,1],[22,22,20,20,30,20,1],[24,24,22,22,36,24,1],[26,26,24,24,44,28,1],[32,32,14,14,62,36,1],
  [36,36,16,16,86,42,1],[40,40,18,18,114,48,1],[44,44,20,20,144,56,1],[48,48,22,22,174,68,1],[52,52,24,24,204,84,2],
  [64,64,14,14,280,112,2],[72,72,16,16,368,144,4],[80,80,18,18,456,192,4],[88,88,20,20,576,224,4],[96,96,22,22,696,272,4],
  [104,104,24,24,816,336,6],[120,120,18,18,1050,408,6],[132,132,20,20,1304,496,8],[144,144,22,22,1558,620,10]
];
var DM_RECT = [[8,18,6,16,5,7,1],[8,32,6,14,10,11,1],[12,26,10,24,16,14,1],[12,36,10,16,22,18,1],[16,36,14,16,32,24,1],[16,48,14,22,49,28,1]];

/* ASCII（数字 2 つで 1 語、128 以上は上位シフト）と Base 256 のうち、短いほうで符号化する */
function dmEncode(bytesOrTokens, isGs1) {
  var ascii = [];
  for (var i = 0; i < bytesOrTokens.length; i++) {
    var c = bytesOrTokens[i], n = bytesOrTokens[i + 1];
    if (c === FNC1) ascii.push(232);
    else if (c >= 48 && c <= 57 && n >= 48 && n <= 57) { ascii.push(130 + (c - 48) * 10 + (n - 48)); i++; }
    else if (c < 128) ascii.push(c + 1);
    else { ascii.push(235); ascii.push(c - 127); }
  }
  if (isGs1) return { cw: ascii, mode: "ascii" };
  // Base 256：ラッチ（231）、長さ、バイト列。長さとバイトは位置に応じて 255 状態のランダム化をかける（位置は後で決まる）
  var L = bytesOrTokens.length, b256 = [231, { len: L }];
  if (L > 249) b256.push({ len2: L });
  for (i = 0; i < L; i++) b256.push({ byte: bytesOrTokens[i] });
  return b256.length < ascii.length ? { cw: b256, mode: "base256" } : { cw: ascii, mode: "ascii" };
}
function dmFinish(cw, cap) {
  var out = [];
  for (var i = 0; i < cw.length; i++) {
    var x = cw[i], pos = out.length + 1;
    if (typeof x === "number") { out.push(x); continue; }
    var v = x.len !== undefined ? (x.len > 249 ? Math.floor(x.len / 250) + 249 : x.len) : x.len2 !== undefined ? x.len2 % 250 : x.byte;
    var r = v + ((149 * pos) % 255) + 1;
    out.push(r <= 255 ? r : r - 256);
  }
  if (out.length < cap) {
    out.push(129);
    while (out.length < cap) { var p = out.length + 1, r2 = 129 + ((149 * p) % 253) + 1; out.push(r2 <= 254 ? r2 : r2 - 254); }
  }
  return out;
}
function dmPlacement(nrow, ncol) {
  var a = new Int32Array(nrow * ncol);
  function module(row, col, chr, bit) {
    if (row < 0) { row += nrow; col += 4 - ((nrow + 4) % 8); }
    if (col < 0) { col += ncol; row += 4 - ((ncol + 4) % 8); }
    a[row * ncol + col] = 10 * chr + bit;
  }
  function utah(row, col, chr) {
    module(row - 2, col - 2, chr, 1); module(row - 2, col - 1, chr, 2); module(row - 1, col - 2, chr, 3); module(row - 1, col - 1, chr, 4);
    module(row - 1, col, chr, 5); module(row, col - 2, chr, 6); module(row, col - 1, chr, 7); module(row, col, chr, 8);
  }
  function corner(chr, list) { for (var q = 0; q < 8; q++) module(list[q][0], list[q][1], chr, q + 1); }
  var chr = 1, row = 4, col = 0;
  do {
    if (row === nrow && col === 0) corner(chr++, [[nrow-1,0],[nrow-1,1],[nrow-1,2],[0,ncol-2],[0,ncol-1],[1,ncol-1],[2,ncol-1],[3,ncol-1]]);
    if (row === nrow - 2 && col === 0 && ncol % 4) corner(chr++, [[nrow-3,0],[nrow-2,0],[nrow-1,0],[0,ncol-4],[0,ncol-3],[0,ncol-2],[0,ncol-1],[1,ncol-1]]);
    if (row === nrow - 2 && col === 0 && ncol % 8 === 4) corner(chr++, [[nrow-3,0],[nrow-2,0],[nrow-1,0],[0,ncol-2],[0,ncol-1],[1,ncol-1],[2,ncol-1],[3,ncol-1]]);
    if (row === nrow + 4 && col === 2 && !(ncol % 8)) corner(chr++, [[nrow-1,0],[nrow-1,ncol-1],[0,ncol-3],[0,ncol-2],[0,ncol-1],[1,ncol-3],[1,ncol-2],[1,ncol-1]]);
    do { if (row < nrow && col >= 0 && !a[row * ncol + col]) utah(row, col, chr++); row -= 2; col += 2; } while (row >= 0 && col < ncol);
    row += 1; col += 3;
    do { if (row >= 0 && col < ncol && !a[row * ncol + col]) utah(row, col, chr++); row += 2; col -= 2; } while (row < nrow && col >= 0);
    row += 3; col += 1;
  } while (row < nrow || col < ncol);
  if (!a[nrow * ncol - 1]) { a[nrow * ncol - 1] = 1; a[nrow * ncol - ncol - 2] = 1; }
  return a;
}
function datamatrix(text, opt, warn) {
  if (!text.length) fail("e.empty");
  var enc = opt.gs1 ? dmEncode(gs1(text, warn).tokens, true) : dmEncode(utf8(text), false);
  var list = opt.shape === "rect" ? DM_RECT : opt.shape === "square" ? DM : DM.concat(DM_RECT).sort(function (a, b) { return a[0] * a[1] - b[0] * b[1]; });
  var S = null;
  for (var i = 0; i < list.length; i++) if (list[i][4] >= enc.cw.length) { S = list[i]; break; }
  if (!S) fail("e.toolong");
  var data = dmFinish(enc.cw, S[4]);
  // 誤り訂正：コード語をブロックへ順に振り分け、ブロックごとに計算して、同じ順で並べる
  var nb = S[6], eccPer = S[5] / nb, g = GF_DM.gen(eccPer, 1), all = data.slice();
  for (var b = 0; b < nb; b++) {
    var d = [];
    for (i = b; i < data.length; i += nb) d.push(data[i]);
    var e = GF_DM.ecc(d, g);
    for (i = 0; i < eccPer; i++) all[data.length + i * nb + b] = e[i];
  }
  var rh = S[2], rw = S[3], nRegY = Math.round(S[0] / (rh + 2)), nRegX = Math.round(S[1] / (rw + 2));
  var nrow = nRegY * rh, ncol = nRegX * rw, pl = dmPlacement(nrow, ncol);
  var W = S[1], H = S[0], grid = new Uint8Array(W * H);
  for (var ry = 0; ry < nRegY; ry++) for (var rx = 0; rx < nRegX; rx++) {
    var top = ry * (rh + 2), left = rx * (rw + 2);
    for (var x = 0; x < rw + 2; x++) { grid[(top + rh + 1) * W + left + x] = 1; grid[top * W + left + x] = x % 2 === 0 ? 1 : 0; }
    for (var y = 0; y < rh + 2; y++) { grid[(top + y) * W + left] = 1; grid[(top + y) * W + left + rw + 1] = y % 2 === 1 ? 1 : 0; }
    grid[(top + rh + 1) * W + left + rw + 1] = 1;
  }
  for (var r = 0; r < nrow; r++) for (var c = 0; c < ncol; c++) {
    var v = pl[r * ncol + c], on;
    if (v === 1) on = 1;
    else if (v === 0) on = 0;
    else on = (all[Math.floor(v / 10) - 1] >> (8 - v % 10)) & 1;
    var sy = r + 1 + 2 * Math.floor(r / rh), sx = c + 1 + 2 * Math.floor(c / rw);
    grid[sy * W + sx] = on;
  }
  return { dim: 2, w: W, h: H, grid: grid, quiet: 1, warn: warn,
    info: { kind: "dm", rows: H, cols: W, mode: enc.mode, capacity: S[4], used: enc.cw.length } };
}

/* =========================================================================
   入口
   ========================================================================= */
function encode(type, text, opt) {
  opt = opt || {};
  var warn = [], r;
  switch (type) {
    case "ean13": r = ean13(text.trim(), false); break;
    case "upca":  r = ean13(text.trim(), true); break;
    case "ean8":  r = ean8(text.trim()); break;
    case "code128": {
      var tk = opt.gs1 ? gs1(text, warn) : { tokens: asciiTokens(text, 127), hri: text };
      if (!opt.gs1 && !text.length) fail("e.empty");
      var c = code128(tk.tokens);
      r = { dim: 1, mods: c.mods, text: tk.hri, hri: { kind: "plain", text: tk.hri }, quiet: [10, 10], symbols: c.symbols, warn: warn };
      break;
    }
    case "code39": r = code39(text, !!opt.check, opt.ratio || 3); break;
    case "itf":    r = itf(text.trim(), opt.itfMode || "itf", opt.ratio || 2.5, warn); break;
    case "qr":     return qr(text, opt, warn);
    case "datamatrix": return datamatrix(text, opt, warn);
    default: fail("e.type");
  }
  r.warn = (r.warn || []).concat(warn);
  if (r.unit) {   // Code 39・ITF は細いバー = 2 モジュールで持っているので、余白も合わせる
    r.quiet = [r.quiet[0] * 2, r.quiet[1] * 2];
  }
  r.unit = r.unit || 1;
  return r;
}

root.Barcode = { encode: encode, mod10: mod10 };
})(typeof window !== "undefined" ? window : this);
