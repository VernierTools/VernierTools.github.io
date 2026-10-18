/* =========================================================================
   Vernier — HDR 画像の読み込み（HdrImage）
   Radiance HDR（.hdr / RGBE）と OpenEXR（.exr）を、1 行ずつ RGB の実数で渡す。
   大きな HDRI（8K など）でも全体を実数の配列に展開しないで済むように、行ごとに onRow を呼ぶ。
     HdrImage.decode(arrayBuffer, onRow, onProgress, onStart) → Promise<{ W, H, format, compression }>
       onStart(W, H)       行を渡し始める前に一度だけ（大きさに合わせて受け側の配列を用意できる）
       onRow(y, r, g, b)   y は上からの行番号。r/g/b は長さ W の Float32Array（呼び出しのあとで再利用される）
       onProgress(0〜1)
   OpenEXR は scanline・single-part で、圧縮は 無し / RLE / ZIPS / ZIP、ピクセル型は half / float / uint。
   PIZ・PXR24・B44・DWA・tiled・multi-part は理由付きのエラーにする。
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
var LINES_PER_BLOCK = { 0: 1, 1: 1, 2: 1, 3: 16 };
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
    throw new Error("EXR compression " + (COMP_NAMES[comp] || comp) + " is not supported (use ZIP, ZIPS, RLE or none — or .hdr)");
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
    else ready = inflate(src).then(postprocess);
    return ready.then(function (data) {
      for (var r = 0; r < rows; r++) emitLine(data, r * lineBytes, row0 + r);
      if (onProgress && !(blk & 15)) onProgress(blk / nBlocks);
      return one();
    });
  }
  return one().then(function () { return { W: W, H: H, format: "EXR", compression: COMP_NAMES[comp] }; });
}

function decode(buf, onRow, onProgress, onStart) {
  try {
    var dv = new DataView(buf);
    if (buf.byteLength >= 4 && dv.getUint32(0, true) === 0x01312f76) return decodeEXR(buf, onRow, onProgress, onStart);
    return decodeHDR(buf, onRow, onProgress, onStart);
  } catch (e) { return Promise.reject(e); }
}

root.HdrImage = { decode: decode };
})(typeof self !== "undefined" ? self : this);
