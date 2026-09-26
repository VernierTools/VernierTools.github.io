/* =========================================================================
   STMap generator — exr.js
   OpenEXR の書き出しと読み込み（scanline・single-part のみ）。
     書き出し: float32、チャンネル B/G/R（B = 1.0。Blender の Map UV は3番目の成分を透明度として扱う）、
               圧縮は無し / ZIP（16行ブロック）。data window と display window を正しく記録する。
     読み込み: 圧縮は無し / RLE / ZIPS / ZIP、ピクセル型は half / float / uint。
               PIZ・DWAA・DWAB・tiled・multi-part は非対応（理由付きでエラーを返す）。
   zlib はブラウザ標準の CompressionStream / DecompressionStream("deflate") を使う。
   ========================================================================= */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------------
     zlib（非同期）
     --------------------------------------------------------------------- */
  function streamBytes(u8, stream) {
    var s = new Blob([u8]).stream().pipeThrough(stream);
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function zlibDeflate(u8) { return streamBytes(u8, new CompressionStream("deflate")); }
  function zlibInflate(u8) { return streamBytes(u8, new DecompressionStream("deflate")); }

  /* EXR の ZIP/RLE 前処理: 偶数・奇数バイトの振り分け + 差分予測 */
  function preprocess(raw) {
    var n = raw.length, t = new Uint8Array(n), half = (n + 1) >> 1, i1 = 0, i2 = half;
    for (var i = 0; i < n; i++) { if (i & 1) t[i2++] = raw[i]; else t[i1++] = raw[i]; }
    var p = t[0];
    for (var j = 1; j < n; j++) { var c = t[j]; t[j] = (c - p + 384) & 255; p = c; }
    return t;
  }
  function postprocess(t) {
    var n = t.length, j;
    for (j = 1; j < n; j++) t[j] = (t[j - 1] + t[j] - 128) & 255;
    var out = new Uint8Array(n), half = (n + 1) >> 1, i1 = 0, i2 = half;
    for (var i = 0; i < n; i++) out[i] = (i & 1) ? t[i2++] : t[i1++];
    return out;
  }
  function rleDecode(src, expected) {
    var out = new Uint8Array(expected), o = 0, i = 0;
    while (i < src.length && o < expected) {
      var c = (src[i] << 24) >> 24; i++;              // 符号付き
      if (c < 0) { var n = -c; out.set(src.subarray(i, i + n), o); o += n; i += n; }
      else { var v = src[i++]; for (var r = 0; r <= c; r++) out[o++] = v; }
    }
    if (o !== expected) throw new Error("RLE: corrupt data");
    return out;
  }

  /* ---------------------------------------------------------------------
     書き出し
     --------------------------------------------------------------------- */
  function Writer(size) {
    this.buf = new ArrayBuffer(size); this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf); this.p = 0;
  }
  Writer.prototype.u8w = function (v) { this.dv.setUint8(this.p, v); this.p += 1; };
  Writer.prototype.i32 = function (v) { this.dv.setInt32(this.p, v, true); this.p += 4; };
  Writer.prototype.f32 = function (v) { this.dv.setFloat32(this.p, v, true); this.p += 4; };
  Writer.prototype.u64 = function (v) {            // オフセットは 2^53 未満なので分割して書く
    this.dv.setUint32(this.p, v % 4294967296, true);
    this.dv.setUint32(this.p + 4, Math.floor(v / 4294967296), true); this.p += 8;
  };
  Writer.prototype.str0 = function (s) {
    for (var i = 0; i < s.length; i++) this.u8w(s.charCodeAt(i) & 0x7f);
    this.u8w(0);
  };
  Writer.prototype.bytes = function (b) { this.u8.set(b, this.p); this.p += b.length; };

  function attr(name, type, bytes) { return { name: name, type: type, bytes: bytes }; }
  function bytesOf(fn, size) { var w = new Writer(size); fn(w); return w.u8; }

  var COMP = { none: 0, rle: 1, zips: 2, zip: 3 };

  function headerBytes(W, H, dw, comp, meta) {
    var chans = ["B", "G", "R"];                    // チャンネル名はアルファベット順が規約
    var list = [
      attr("channels", "chlist", bytesOf(function (w) {
        chans.forEach(function (c) {
          w.str0(c); w.i32(2);                      // pixel type 2 = FLOAT
          w.u8w(0); w.u8w(0); w.u8w(0); w.u8w(0);   // pLinear + reserved
          w.i32(1); w.i32(1);
        });
        w.u8w(0);
      }, chans.length * 18 + 1)),
      attr("compression", "compression", new Uint8Array([comp])),
      attr("dataWindow", "box2i", bytesOf(function (w) { w.i32(dw.x0); w.i32(dw.y0); w.i32(dw.x1); w.i32(dw.y1); }, 16)),
      attr("displayWindow", "box2i", bytesOf(function (w) { w.i32(0); w.i32(0); w.i32(W - 1); w.i32(H - 1); }, 16)),
      attr("lineOrder", "lineOrder", new Uint8Array([0])),       // INCREASING_Y（上の行から）
      attr("pixelAspectRatio", "float", bytesOf(function (w) { w.f32(1); }, 4)),
      attr("screenWindowCenter", "v2f", bytesOf(function (w) { w.f32(0); w.f32(0); }, 8)),
      attr("screenWindowWidth", "float", bytesOf(function (w) { w.f32(1); }, 4))
    ];
    if (meta) {                                     // 生成条件を文字列属性で残す（読み込み時の復元用）
      var s = String(meta).replace(/[^\x20-\x7e]/g, "?");
      list.push(attr("vernierStmap", "string", bytesOf(function (w) {
        for (var i = 0; i < s.length; i++) w.u8w(s.charCodeAt(i));
      }, s.length)));
    }
    var size = 8 + 1;
    list.forEach(function (a) { size += a.name.length + 1 + a.type.length + 1 + 4 + a.bytes.length; });
    var w = new Writer(size);
    w.u8w(0x76); w.u8w(0x2f); w.u8w(0x31); w.u8w(0x01);         // magic
    w.i32(2);                                                     // version 2, single-part scanline
    list.forEach(function (a) { w.str0(a.name); w.str0(a.type); w.i32(a.bytes.length); w.bytes(a.bytes); });
    w.u8w(0);
    return w.u8;
  }

  function mapWindow(map) {
    var dw = map.dw || { x0: 0, y0: 0, x1: map.W - 1, y1: map.H - 1 };
    return { dw: dw, w: dw.x1 - dw.x0 + 1, h: dw.y1 - dw.y0 + 1 };
  }

  /* rows 行ぶんの非圧縮ブロック（行ごとに B, G, R の順） */
  function rawBlock(map, w, row0, rows) {
    var line = w * 12, out = new Uint8Array(line * rows), f = new Float32Array(w), fb = new Uint8Array(f.buffer);
    for (var r = 0; r < rows; r++) {
      var o = (row0 + r) * w, base = r * line;
      f.fill(1); out.set(fb, base);
      f.set(map.G.subarray(o, o + w)); out.set(fb, base + w * 4);
      f.set(map.R.subarray(o, o + w)); out.set(fb, base + w * 8);
    }
    return out;
  }

  /* 同期版（無圧縮のみ）。map: { W, H, dw?, R, G }（R/G は data window の上の行から） */
  function writeStmapEXR(map, meta) {
    var win = mapWindow(map), w = win.w, h = win.h, dw = win.dw;
    var head = headerBytes(map.W, map.H, dw, COMP.none, meta);
    var line = w * 12, chunk = 8 + line, total = head.length + h * 8 + h * chunk;
    var out = new Writer(total);
    out.bytes(head);
    var first = head.length + h * 8;
    for (var y = 0; y < h; y++) out.u64(first + y * chunk);
    for (var row = 0; row < h; row++) {
      out.i32(dw.y0 + row); out.i32(line);
      out.bytes(rawBlock(map, w, row, 1));
    }
    return out.buf;
  }

  /* 非同期版。opts.compression: "none" | "zip"（既定 "zip"）。Promise<ArrayBuffer> */
  function writeStmapEXRAsync(map, meta, opts) {
    var comp = (opts && opts.compression) || "zip";
    if (comp === "none") return Promise.resolve(writeStmapEXR(map, meta));
    var win = mapWindow(map), w = win.w, h = win.h, dw = win.dw, LINES = 16;
    var nBlocks = Math.ceil(h / LINES), blocks = new Array(nBlocks);
    var onProgress = opts && opts.onProgress;
    var i = 0;
    function next() {
      if (i >= nBlocks) return Promise.resolve();
      var bi = i++, row0 = bi * LINES, rows = Math.min(LINES, h - row0);
      var raw = rawBlock(map, w, row0, rows);
      return zlibDeflate(preprocess(raw)).then(function (z) {
        blocks[bi] = { y: dw.y0 + row0, data: z.length < raw.length ? z : raw };   // 縮まなければ生で格納（仕様）
        if (onProgress) onProgress(i / nBlocks);
        return next();
      });
    }
    return next().then(function () {
      var head = headerBytes(map.W, map.H, dw, COMP.zip, meta);
      var total = head.length + nBlocks * 8;
      blocks.forEach(function (b) { total += 8 + b.data.length; });
      var out = new Writer(total);
      out.bytes(head);
      var pos = head.length + nBlocks * 8;
      blocks.forEach(function (b) { out.u64(pos); pos += 8 + b.data.length; });
      blocks.forEach(function (b) { out.i32(b.y); out.i32(b.data.length); out.bytes(b.data); });
      return out.buf;
    });
  }

  /* ---------------------------------------------------------------------
     読み込み
     --------------------------------------------------------------------- */
  var COMP_NAMES = ["none", "RLE", "ZIPS", "ZIP", "PIZ", "PXR24", "B44", "B44A", "DWAA", "DWAB"];
  var LINES_PER_BLOCK = { 0: 1, 1: 1, 2: 1, 3: 16 };

  function halfToFloat(h) {
    var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 5.960464477539063e-8;            // 2^-24
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * Math.pow(2, e - 15);
  }

  /* buffer: ArrayBuffer → Promise<{ W, H, dw, w, h, R, G, compression, pixelType, attrs }>
     R/G は data window の上の行から並んだ Float32Array。 */
  function readEXR(buffer) {
    try {
      var dv = new DataView(buffer), u8 = new Uint8Array(buffer), p = 0;
      if (dv.getUint32(0, true) !== 0x01312f76) throw new Error("Not an OpenEXR file");
      var ver = dv.getUint32(4, true);
      if (ver & 0x200) throw new Error("Tiled EXR is not supported");
      if (ver & 0x1000) throw new Error("Multi-part EXR is not supported");
      if (ver & 0x800) throw new Error("Deep EXR is not supported");
      p = 8;
      function str() { var s = ""; while (u8[p] !== 0) s += String.fromCharCode(u8[p++]); p++; return s; }
      var attrs = {}, chans = [];
      for (;;) {
        var name = str(); if (!name) break;
        var type = str(), size = dv.getInt32(p, true); p += 4;
        var start = p;
        if (type === "chlist") {
          while (u8[p] !== 0) {
            var cn = str(), pt = dv.getInt32(p, true); p += 16;
            chans.push({ name: cn, type: pt });
          }
        } else if (type === "box2i") {
          attrs[name] = { x0: dv.getInt32(p, true), y0: dv.getInt32(p + 4, true),
                          x1: dv.getInt32(p + 8, true), y1: dv.getInt32(p + 12, true) };
        } else if (type === "compression" || type === "lineOrder") {
          attrs[name] = u8[p];
        } else if (type === "string") {
          var s2 = ""; for (var q = 0; q < size; q++) s2 += String.fromCharCode(u8[p + q]);
          attrs[name] = s2;
        }
        p = start + size;
      }
      var comp = attrs.compression || 0;
      if (!(comp in LINES_PER_BLOCK))
        throw new Error("EXR compression " + (COMP_NAMES[comp] || comp) + " is not supported (use ZIP or none)");
      var dw = attrs.dataWindow, disp = attrs.displayWindow || dw;
      var w = dw.x1 - dw.x0 + 1, h = dw.y1 - dw.y0 + 1;
      // チャンネルはファイル内で名前順。R/G は末尾一致（レイヤー付き "xxx.R" 等も拾う）
      chans.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      function find(sfx) {
        for (var i = 0; i < chans.length; i++) {
          var n = chans[i].name;
          if (n === sfx || n.slice(-sfx.length - 1) === "." + sfx) return i;
        }
        return -1;
      }
      var iR = find("R"), iG = find("G");
      if (iR < 0 || iG < 0) throw new Error("R and G channels were not found");
      var bpp = chans.map(function (c) { return c.type === 1 ? 2 : 4; });
      var lineBytes = 0; bpp.forEach(function (b) { lineBytes += b * w; });
      var lpb = LINES_PER_BLOCK[comp], nBlocks = Math.ceil(h / lpb);
      var offsets = [];
      for (var b = 0; b < nBlocks; b++) {
        offsets.push(dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296); p += 8;
      }
      var R = new Float32Array(w * h), G = new Float32Array(w * h);
      var blk = 0;
      var decodeLine = function (data, lineOff, rowIdx) {
        var ddv = new DataView(data.buffer, data.byteOffset, data.byteLength), o = lineOff;
        for (var c = 0; c < chans.length; c++) {
          var target = c === iR ? R : c === iG ? G : null, t = chans[c].type, base = rowIdx * w;
          if (target) {
            for (var x = 0; x < w; x++) {
              target[base + x] = t === 2 ? ddv.getFloat32(o + x * 4, true)
                               : t === 1 ? halfToFloat(ddv.getUint16(o + x * 2, true))
                               : ddv.getUint32(o + x * 4, true);
            }
          }
          o += bpp[c] * w;
        }
      };
      function one() {
        if (blk >= nBlocks) return Promise.resolve();
        var off = offsets[blk++];
        var y = dv.getInt32(off, true), size = dv.getInt32(off + 4, true);
        var row0 = y - dw.y0, rows = Math.min(lpb, h - row0), expected = rows * lineBytes;
        var src = u8.subarray(off + 8, off + 8 + size);
        var ready;
        if (comp === 0 || size === expected) ready = Promise.resolve(src);
        else if (comp === 1) ready = Promise.resolve(postprocess(rleDecode(src, expected)));
        else ready = zlibInflate(src).then(postprocess);
        return ready.then(function (data) {
          for (var r = 0; r < rows; r++) decodeLine(data, r * lineBytes, row0 + r);
          return one();
        });
      }
      return one().then(function () {
        return {
          W: disp.x1 - disp.x0 + 1, H: disp.y1 - disp.y0 + 1,
          dw: { x0: dw.x0 - disp.x0, y0: dw.y0 - disp.y0, x1: dw.x1 - disp.x0, y1: dw.y1 - disp.y0 },
          w: w, h: h, R: R, G: G,
          compression: COMP_NAMES[comp], pixelType: chans[iR].type === 1 ? "half" : chans[iR].type === 2 ? "float" : "uint",
          attrs: attrs
        };
      });
    } catch (e) { return Promise.reject(e); }
  }

  var api = { writeStmapEXR: writeStmapEXR, writeStmapEXRAsync: writeStmapEXRAsync, readEXR: readEXR,
              zlibDeflate: zlibDeflate, zlibInflate: zlibInflate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STExr = api;
})(this);
