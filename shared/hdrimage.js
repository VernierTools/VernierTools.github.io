/* =========================================================================
   Vernier — HDR 画像の読み込み（HdrImage）
   Radiance HDR（.hdr / RGBE）と OpenEXR（.exr）を、1 行ずつ RGB の実数で渡す。
   大きな HDRI（8K など）でも全体を実数の配列に展開しないで済むように、行ごとに onRow を呼ぶ。
     HdrImage.decode(arrayBuffer, onRow, onProgress, onStart) → Promise<{ W, H, format, compression }>
       onStart(W, H)       行を渡し始める前に一度だけ（大きさに合わせて受け側の配列を用意できる）
       onRow(y, r, g, b)   y は上からの行番号。r/g/b は長さ W の Float32Array（呼び出しのあとで再利用される）
       onProgress(0〜1)
   OpenEXR は scanline・single-part で、圧縮は 無し / RLE / ZIPS / ZIP / PIZ、ピクセル型は half / float / uint。
   PXR24・B44・DWA・tiled・multi-part は理由付きのエラーにする。
   ワーカーからも読めるように window / self のどちらにも置く。
   ========================================================================= */
(function (root) {
"use strict";

/* ---------------- Radiance HDR（RGBE） ---------------- */
function decodeHDR(buf, onRow, onProgress, onStart) {
  var u8 = new Uint8Array(buf), p = 0, n = u8.length;
  function line() {
    var s = "";
    while (p < n && u8[p] !== 10) s += String.fromCharCode(u8[p++]);
    p++; return s;
  }
  var first = line();
  if (first.indexOf("#?") !== 0) throw new Error("Not a Radiance HDR file");
  var fmt = "32-bit_rle_rgbe";
  for (;;) {
    if (p >= n) throw new Error("HDR header is incomplete");
    var l = line();
    if (l === "") break;
    var m = l.match(/^FORMAT=(.*)$/); if (m) fmt = m[1].trim();
  }
  if (fmt !== "32-bit_rle_rgbe") throw new Error("HDR format " + fmt + " is not supported (only RGBE)");
  var res = line().trim().split(/\s+/);
  // 標準は "-Y H +X W"（上の行から）。"+Y H +X W" は下の行から
  if (res.length !== 4 || res[2] !== "+X" || (res[0] !== "-Y" && res[0] !== "+Y")) throw new Error("Unsupported HDR orientation: " + res.join(" "));
  var H = parseInt(res[1], 10), W = parseInt(res[3], 10), flip = res[0] === "+Y";
  if (!(W > 0 && H > 0)) throw new Error("Bad HDR size");
  if (onStart) onStart(W, H);
  var scan = new Uint8Array(W * 4), R = new Float32Array(W), G = new Float32Array(W), B = new Float32Array(W);
  var EXP = new Float32Array(256);
  for (var e = 1; e < 256; e++) EXP[e] = Math.pow(2, e - 136);

  function readFlat(start) {      // 古い形式（無圧縮か、1,1,1,n の繰り返し）
    var x = start, shift = 0;
    while (x < W) {
      if (p + 4 > n) throw new Error("HDR data is truncated");
      var a = u8[p], b = u8[p + 1], c = u8[p + 2], d = u8[p + 3]; p += 4;
      if (a === 1 && b === 1 && c === 1) {
        var cnt = d << shift;
        for (var k = 0; k < cnt && x < W; k++, x++) scan.set(scan.subarray((x - 1) * 4, x * 4), x * 4);
        shift += 8;
      } else {
        scan[x * 4] = a; scan[x * 4 + 1] = b; scan[x * 4 + 2] = c; scan[x * 4 + 3] = d; x++; shift = 0;
      }
    }
  }
  for (var y = 0; y < H; y++) {
    if (W >= 8 && W < 32768 && u8[p] === 2 && u8[p + 1] === 2 && ((u8[p + 2] << 8) | u8[p + 3]) === W && !(u8[p + 2] & 0x80)) {
      p += 4;   // 新しい形式の RLE：チャンネルごとに並ぶ
      for (var ch = 0; ch < 4; ch++) {
        var x = 0;
        while (x < W) {
          if (p >= n) throw new Error("HDR data is truncated");
          var count = u8[p++];
          if (count > 128) {
            count -= 128; var v = u8[p++];
            if (x + count > W) throw new Error("HDR data is corrupt");
            for (var r = 0; r < count; r++) scan[(x++) * 4 + ch] = v;
          } else {
            if (count === 0 || x + count > W) throw new Error("HDR data is corrupt");
            for (var q = 0; q < count; q++) scan[(x++) * 4 + ch] = u8[p++];
          }
        }
      }
    } else readFlat(0);
    for (var i = 0; i < W; i++) {
      var ex = scan[i * 4 + 3];
      if (!ex) { R[i] = G[i] = B[i] = 0; continue; }
      var f = EXP[ex];
      R[i] = (scan[i * 4] + 0.5) * f; G[i] = (scan[i * 4 + 1] + 0.5) * f; B[i] = (scan[i * 4 + 2] + 0.5) * f;
    }
    onRow(flip ? H - 1 - y : y, R, G, B);
    if (onProgress && !(y & 63)) onProgress(y / H);
  }
  return Promise.resolve({ W: W, H: H, format: "HDR", compression: "RLE" });
}

/* ---------------- OpenEXR ---------------- */
var COMP_NAMES = ["none", "RLE", "ZIPS", "ZIP", "PIZ", "PXR24", "B44", "B44A", "DWAA", "DWAB"];
var LINES_PER_BLOCK = { 0: 1, 1: 1, 2: 1, 3: 16, 4: 32 };
function inflate(u8) {
  var s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
}
function postprocess(t) {        // ZIP / RLE の前処理（差分予測 + 偶数・奇数バイトの振り分け）を戻す
  var n = t.length, j;
  for (j = 1; j < n; j++) t[j] = (t[j - 1] + t[j] - 128) & 255;
  var out = new Uint8Array(n), half = (n + 1) >> 1, i1 = 0, i2 = half;
  for (var i = 0; i < n; i++) out[i] = (i & 1) ? t[i2++] : t[i1++];
  return out;
}
function rleDecode(src, expected) {
  var out = new Uint8Array(expected), o = 0, i = 0;
  while (i < src.length && o < expected) {
    var c = (src[i] << 24) >> 24; i++;
    if (c < 0) { var k = -c; out.set(src.subarray(i, i + k), o); o += k; i += k; }
    else { var v = src[i++]; for (var r = 0; r <= c; r++) out[o++] = v; }
  }
  if (o !== expected) throw new Error("EXR RLE data is corrupt");
  return out;
}
var HALF = (function () {
  var t = new Float32Array(65536);
  for (var h = 0; h < 65536; h++) {
    var s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = e === 0 ? s * m * Math.pow(2, -24) : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * Math.pow(2, e - 15);
  }
  return t;
})();

/* ---------------- OpenEXR の PIZ（ハフマン符号 + ウェーブレット） ----------------
   OpenEXR の ImfPizCompressor・ImfHuf・ImfWav と同じ手順で戻す：
   ビットマップ → 逆引き表、ハフマン符号を 16 ビット列に展開、チャンネルごとに 2D ウェーブレットを戻し、
   逆引き表を当て、行ごとに「チャンネル順・横 1 行ぶん」へ並べ直す。 */
var HUF_ENCSIZE = 65537, HUF_DECBITS = 14, HUF_DECSIZE = 1 << HUF_DECBITS, HUF_DECMASK = HUF_DECSIZE - 1;
var SHORT_ZEROCODE_RUN = 59, LONG_ZEROCODE_RUN = 63, SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;
function pizErr() { return new Error("EXR PIZ data is corrupt"); }

function hufUncompress(u8, p0, nCompressed, out, nRaw) {
  if (nCompressed === 0) { if (nRaw) throw pizErr(); return; }
  var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  var im = dv.getUint32(p0, true), iM = dv.getUint32(p0 + 4, true), nBits = dv.getUint32(p0 + 12, true);
  if (im >= HUF_ENCSIZE || iM >= HUF_ENCSIZE) throw pizErr();
  var p = p0 + 20, end = p0 + nCompressed;
  // 符号の長さの表（6 ビットずつ、0 の連続は短い / 長い連続の記号でまとめてある）
  var len = new Uint8Array(HUF_ENCSIZE), c = 0, lc = 0;
  function bits(n) {
    while (lc < n) { if (p >= end) throw pizErr(); c = ((c << 8) | u8[p++]) >>> 0; lc += 8; }
    lc -= n; return (c >>> lc) & ((1 << n) - 1);
  }
  for (var i = im; i <= iM; i++) {
    var l = bits(6);
    if (l === LONG_ZEROCODE_RUN) {
      var zr = bits(8) + SHORTEST_LONG_RUN; if (i + zr > iM + 1) throw pizErr();
      i += zr - 1;                                   // len は 0 のまま
    } else if (l >= SHORT_ZEROCODE_RUN) {
      var zs = l - SHORT_ZEROCODE_RUN + 2; if (i + zs > iM + 1) throw pizErr();
      i += zs - 1;
    } else len[i] = l;
  }
  // 正規ハフマン符号（長い符号から順に番号を振る）。符号の値は 2^53 を超えない範囲で実数に持つ
  var count = new Float64Array(59), code = new Float64Array(HUF_ENCSIZE);
  for (i = 0; i < HUF_ENCSIZE; i++) count[len[i]]++;
  var cc = 0;
  for (i = 58; i > 0; i--) { var nc = Math.floor((cc + count[i]) / 2); count[i] = cc; cc = nc; }
  for (i = 0; i < HUF_ENCSIZE; i++) if (len[i]) code[i] = count[len[i]]++;
  // 復号表：14 ビット以下の符号は表を直接引き、長い符号は候補の一覧を持つ
  var decLen = new Uint8Array(HUF_DECSIZE), decLit = new Int32Array(HUF_DECSIZE), decList = new Array(HUF_DECSIZE);
  for (i = im; i <= iM; i++) {
    var L = len[i]; if (!L) continue;
    var C = code[i];
    if (C >= Math.pow(2, L)) throw pizErr();
    if (L > HUF_DECBITS) {
      var k = Math.floor(C / Math.pow(2, L - HUF_DECBITS));
      if (decLen[k]) throw pizErr();
      (decList[k] || (decList[k] = [])).push(i);
    } else {
      var base = C * (1 << (HUF_DECBITS - L));
      for (var q = 0; q < (1 << (HUF_DECBITS - L)); q++) {
        if (decLen[base + q] || decList[base + q]) throw pizErr();
        decLen[base + q] = L; decLit[base + q] = i;
      }
    }
  }
  // 本体の復号。iM は「直前の値を繰り返す」記号（続く 8 ビットが回数）
  var rlc = iM, o = 0, inEnd = p + ((nBits + 7) >> 3);
  if (inEnd > end) throw pizErr();
  c = 0; lc = 0;
  function emit(sym) {
    if (sym === rlc) {
      if (lc < 8) { c = ((c << 8) | u8[p++]) >>> 0; lc += 8; }
      lc -= 8;
      var cs = (c >>> lc) & 0xff;
      if (o + cs > nRaw || o === 0) throw pizErr();
      var v = out[o - 1]; while (cs-- > 0) out[o++] = v;
    } else if (o < nRaw) out[o++] = sym;
    else throw pizErr();
  }
  // c は下位 lc ビットだけが意味を持つ（32 ビットを超えた上位は >>> 0 で捨てる。25 ビットを超える符号は実際にはまず現れない）
  while (p < inEnd) {
    c = ((c << 8) | u8[p++]) >>> 0; lc += 8;
    while (lc >= HUF_DECBITS) {
      var idx = (c >>> (lc - HUF_DECBITS)) & HUF_DECMASK;
      if (decLen[idx]) { lc -= decLen[idx]; emit(decLit[idx]); continue; }
      var list = decList[idx]; if (!list) throw pizErr();
      var hit = false;
      for (var j = 0; j < list.length; j++) {
        var sym = list[j], sl = len[sym];
        while (lc < sl && p < inEnd) { c = ((c << 8) | u8[p++]) >>> 0; lc += 8; }
        if (lc >= sl && sl <= 32) {
          var got = (c >>> (lc - sl)) % Math.pow(2, sl);
          if (got === code[sym]) { lc -= sl; emit(sym); hit = true; break; }
        }
      }
      if (!hit) throw pizErr();
    }
  }
  var rest = (8 - nBits) & 7;
  c >>>= rest; lc -= rest;
  while (lc > 0) {
    var ix = (c << (HUF_DECBITS - lc)) & HUF_DECMASK;
    if (!decLen[ix] || decLen[ix] > lc) throw pizErr();
    lc -= decLen[ix]; emit(decLit[ix]);
  }
  if (o !== nRaw) throw pizErr();
}

// ウェーブレットの 1 段を戻す（結果は WA・WB に入れる。画素ごとに配列を作らないため）
var WA = 0, WB = 0;
function wdec14(l, h) {
  var hs = (h << 16) >> 16, ai = ((l << 16) >> 16) + (hs & 1) + (hs >> 1);
  WA = ai & 0xffff; WB = (ai - hs) & 0xffff;
}
function wdec16(l, h) {
  var bb = (l - (h >> 1)) & 0xffff;
  WA = (h + bb - 32768) & 0xffff; WB = bb;
}
function wav2Decode(buf, j, nx, ox, ny, oy, mx) {
  var dec = mx < (1 << 14) ? wdec14 : wdec16;
  var n = nx > ny ? ny : nx, p = 1, p2;
  while (p <= n) p <<= 1;
  p >>= 1; p2 = p; p >>= 1;
  while (p >= 1) {
    var py = 0, ey = oy * (ny - p2), oy1 = oy * p, oy2 = oy * p2, ox1 = ox * p, ox2 = ox * p2;
    for (; py <= ey; py += oy2) {
      var px = py, ex = py + ox * (nx - p2);
      for (; px <= ex; px += ox2) {
        var a0 = px + j, a1 = px + ox1 + j, b0 = px + oy1 + j, b1 = b0 + ox1;
        dec(buf[a0], buf[b0]); var i00 = WA, i10 = WB;
        dec(buf[a1], buf[b1]); var i01 = WA, i11 = WB;
        dec(i00, i01); buf[a0] = WA; buf[a1] = WB;
        dec(i10, i11); buf[b0] = WA; buf[b1] = WB;
      }
      if (nx & p) {
        var c0 = px + j, c1 = px + oy1 + j;
        dec(buf[c0], buf[c1]); buf[c0] = WA; buf[c1] = WB;
      }
    }
    if (ny & p) {
      var qx = py, qe = py + ox * (nx - p2);
      for (; qx <= qe; qx += ox2) {
        var d0 = qx + j, d1 = qx + ox1 + j;
        dec(buf[d0], buf[d1]); buf[d0] = WA; buf[d1] = WB;
      }
    }
    p2 = p; p >>= 1;
  }
}

// src: 1 ブロックの圧縮データ、rows: 行数、w: 横の画素数、sizes: チャンネルごとの 16 ビット語数（half 1・float/uint 2）
function pizDecode(src, rows, w, sizes, expected) {
  var dv = new DataView(src.buffer, src.byteOffset, src.byteLength), p = 0;
  var minNZ = dv.getUint16(0, true), maxNZ = dv.getUint16(2, true); p = 4;
  if (maxNZ >= 8192) throw pizErr();
  var bitmap = new Uint8Array(8192);
  if (minNZ <= maxNZ) { bitmap.set(src.subarray(p, p + maxNZ - minNZ + 1), minNZ); p += maxNZ - minNZ + 1; }
  var lut = new Uint16Array(65536), k = 0;
  for (var i = 0; i < 65536; i++) if (i === 0 || (bitmap[i >> 3] & (1 << (i & 7)))) lut[k++] = i;
  var maxValue = k - 1;
  var total = 0; sizes.forEach(function (s) { total += w * rows * s; });
  var tmp = new Uint16Array(total);
  var hl = dv.getInt32(p, true); p += 4;
  hufUncompress(src, p, hl, tmp, total);
  var starts = [], off = 0;
  sizes.forEach(function (s) {
    starts.push(off);
    for (var j = 0; j < s; j++) wav2Decode(tmp, off + j, w, s, rows, w * s, maxValue);
    off += w * rows * s;
  });
  for (i = 0; i < total; i++) tmp[i] = lut[tmp[i]];
  // 行ごとに、チャンネル順で横 1 行ぶんずつ並べ直す（無圧縮のときと同じ並び）
  var out = new Uint16Array(total), o = 0;
  for (var y = 0; y < rows; y++) {
    for (var c = 0; c < sizes.length; c++) {
      var n = w * sizes[c], st = starts[c] + y * n;
      out.set(tmp.subarray(st, st + n), o); o += n;
    }
  }
  var bytes = new Uint8Array(out.buffer);
  if (bytes.length !== expected) throw pizErr();
  return bytes;
}

function decodeEXR(buf, onRow, onProgress, onStart) {
  var dv = new DataView(buf), u8 = new Uint8Array(buf), p = 8;
  if (dv.getUint32(0, true) !== 0x01312f76) throw new Error("Not an OpenEXR file");
  var ver = dv.getUint32(4, true);
  if (ver & 0x200) throw new Error("Tiled EXR is not supported (save it as scanline)");
  if (ver & 0x1000) throw new Error("Multi-part EXR is not supported");
  if (ver & 0x800) throw new Error("Deep EXR is not supported");
  function str() { var s = ""; while (u8[p] !== 0) s += String.fromCharCode(u8[p++]); p++; return s; }
  var attrs = {}, chans = [];
  for (;;) {
    var name = str(); if (!name) break;
    var type = str(), size = dv.getInt32(p, true); p += 4;
    var start = p;
    if (type === "chlist") {
      while (u8[p] !== 0) { var cn = str(), pt = dv.getInt32(p, true); p += 16; chans.push({ name: cn, type: pt }); }
    } else if (type === "box2i") {
      attrs[name] = { x0: dv.getInt32(p, true), y0: dv.getInt32(p + 4, true), x1: dv.getInt32(p + 8, true), y1: dv.getInt32(p + 12, true) };
    } else if (type === "compression" || type === "lineOrder") attrs[name] = u8[p];
    p = start + size;
  }
  var comp = attrs.compression || 0;
  if (!(comp in LINES_PER_BLOCK))
    throw new Error("EXR compression " + (COMP_NAMES[comp] || comp) + " is not supported (use ZIP, ZIPS, PIZ, RLE or none — or .hdr)");
  var dw = attrs.dataWindow, disp = attrs.displayWindow || dw;
  var W = disp.x1 - disp.x0 + 1, H = disp.y1 - disp.y0 + 1;
  var w = dw.x1 - dw.x0 + 1, h = dw.y1 - dw.y0 + 1, ox = dw.x0 - disp.x0, oy = dw.y0 - disp.y0;
  chans.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  function find(sfx) {
    for (var i = 0; i < chans.length; i++) { var nm = chans[i].name; if (nm === sfx || nm.slice(-sfx.length - 1) === "." + sfx) return i; }
    return -1;
  }
  var iR = find("R"), iG = find("G"), iB = find("B"), iY = find("Y");
  if ((iR < 0 || iG < 0 || iB < 0) && iY < 0) throw new Error("No R, G, B (or Y) channels were found");
  var bpp = chans.map(function (c) { return c.type === 1 ? 2 : 4; });
  var lineBytes = 0; bpp.forEach(function (b) { lineBytes += b * w; });
  var lpb = LINES_PER_BLOCK[comp], nBlocks = Math.ceil(h / lpb), offsets = [];
  for (var b = 0; b < nBlocks; b++) { offsets.push(dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296); p += 8; }
  var R = new Float32Array(W), G = new Float32Array(W), B = new Float32Array(W);
  if (onStart) onStart(W, H);
  function readChan(ddv, o, t, out) {
    for (var x = 0; x < w; x++) {
      var v = t === 2 ? ddv.getFloat32(o + x * 4, true) : t === 1 ? HALF[ddv.getUint16(o + x * 2, true)] : ddv.getUint32(o + x * 4, true);
      out[ox + x] = v > 0 && v < Infinity ? v : 0;      // 負・NaN・無限大は 0 として扱う
    }
  }
  function emitLine(data, lineOff, rowIdx) {
    var ddv = new DataView(data.buffer, data.byteOffset, data.byteLength), o = lineOff;
    R.fill(0); G.fill(0); B.fill(0);
    for (var c = 0; c < chans.length; c++) {
      if (iR >= 0 && iG >= 0 && iB >= 0) {
        if (c === iR) readChan(ddv, o, chans[c].type, R);
        else if (c === iG) readChan(ddv, o, chans[c].type, G);
        else if (c === iB) readChan(ddv, o, chans[c].type, B);
      } else if (c === iY) { readChan(ddv, o, chans[c].type, R); G.set(R); B.set(R); }
      o += bpp[c] * w;
    }
    var y = oy + rowIdx;
    if (y >= 0 && y < H) onRow(y, R, G, B);
  }
  var blk = 0;
  function one() {
    if (blk >= nBlocks) return Promise.resolve();
    var off = offsets[blk++];
    var y = dv.getInt32(off, true), size = dv.getInt32(off + 4, true);
    var row0 = y - dw.y0, rows = Math.min(lpb, h - row0), expected = rows * lineBytes;
    var src = u8.subarray(off + 8, off + 8 + size), ready;
    if (comp === 0 || size === expected) ready = Promise.resolve(src);
    else if (comp === 1) ready = Promise.resolve(postprocess(rleDecode(src, expected)));
    else if (comp === 4) ready = Promise.resolve(pizDecode(src, rows, w, chans.map(function (c, i) { return bpp[i] / 2; }), expected));
    else ready = inflate(src).then(postprocess);
    return ready.then(function (data) {
      for (var r = 0; r < rows; r++) emitLine(data, r * lineBytes, row0 + r);
      if (onProgress && !(blk & 15)) onProgress(blk / nBlocks);
      return one();
    });
  }
  return one().then(function () { return { W: W, H: H, format: "EXR", compression: COMP_NAMES[comp] }; });
}

// 壊れた・途中で切れたファイルでは、範囲外の読み取りなど JavaScript 自体のエラーになる。そのままでは意味が分からないので言い換える
function friendly(e) {
  if (e instanceof RangeError || e instanceof TypeError) return new Error("The file is damaged or incomplete");
  return e;
}
function decode(buf, onRow, onProgress, onStart) {
  try {
    var dv = new DataView(buf), p;
    if (buf.byteLength >= 4 && dv.getUint32(0, true) === 0x01312f76) p = decodeEXR(buf, onRow, onProgress, onStart);
    else p = decodeHDR(buf, onRow, onProgress, onStart);
    return p.catch(function (e) { throw friendly(e); });
  } catch (e) { return Promise.reject(friendly(e)); }
}

root.HdrImage = { decode: decode };
})(typeof self !== "undefined" ? self : this);
