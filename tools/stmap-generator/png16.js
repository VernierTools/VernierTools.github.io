/* =========================================================================
   STMap generator — png16.js
   PNG の書き出し（16bit RGB）と読み込み（8/16bit、グレー/RGB/RGBA、非インターレース）。
   ブラウザ標準の画像読み込みは 8bit に丸めるため、ここで自前にデコードする。
   zlib は exr.js の STExr.zlibDeflate / zlibInflate を使う。
   ========================================================================= */
(function (root) {
  "use strict";
  var Z = root.STExr;

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8, from, to) {
    var c = 0xffffffff;
    for (var i = from; i < to; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    var out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  }

  /* map: { W, H, R, G, blue? }（上の行から、0〜1 の範囲。範囲外はクランプ）。B は map.blue（既定 0）。
     戻り値 Promise<{ buffer, clipped }>（clipped = 0〜1 の範囲外でクランプしたピクセル数） */
  function writeStmapPNG16(map, onProgress) {
    var W = map.W, H = map.H, rowBytes = 1 + W * 6, raw = new Uint8Array(rowBytes * H), clipped = 0;
    var blue = map.blue ? 255 : 0;
    for (var y = 0; y < H; y++) {
      var o = y * rowBytes, s = y * W;
      raw[o] = 0;                                       // フィルタなし
      for (var x = 0; x < W; x++) {
        var r = map.R[s + x], g = map.G[s + x];
        if (!(r >= 0 && r <= 1 && g >= 0 && g <= 1)) clipped++;
        var ri = Math.round(Math.min(1, Math.max(0, r || 0)) * 65535);
        var gi = Math.round(Math.min(1, Math.max(0, g || 0)) * 65535);
        var q = o + 1 + x * 6;
        raw[q] = ri >> 8; raw[q + 1] = ri & 255;
        raw[q + 2] = gi >> 8; raw[q + 3] = gi & 255;
        raw[q + 4] = blue; raw[q + 5] = blue;
      }
      if (onProgress && (y & 127) === 0) onProgress(y / H * 0.5);
    }
    return Z.zlibDeflate(raw).then(function (z) {
      var ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
      dv.setUint32(0, W); dv.setUint32(4, H);
      ihdr[8] = 16; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 16bit RGB
      var parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
                   chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
      var total = 0; parts.forEach(function (p) { total += p.length; });
      var out = new Uint8Array(total), pos = 0;
      parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
      return { buffer: out.buffer, clipped: clipped };
    });
  }

  function paeth(a, b, c) {
    var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  }

  /* buffer → Promise<{ W, H, w, h, dw, R, G, bitDepth }>（R/G は上の行から、0〜1） */
  function readPNG(buffer) {
    try {
      var u8 = new Uint8Array(buffer), dv = new DataView(buffer);
      var sig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (var i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error("Not a PNG file");
      var p = 8, W, H, depth, ctype, interlace, idat = [], total = 0;
      while (p < u8.length) {
        var len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
        var data = u8.subarray(p + 8, p + 8 + len);
        if (type === "IHDR") {
          W = dv.getUint32(p + 8); H = dv.getUint32(p + 12);
          depth = u8[p + 16]; ctype = u8[p + 17]; interlace = u8[p + 20];
        } else if (type === "IDAT") { idat.push(data); total += len; }
        else if (type === "IEND") break;
        p += 12 + len;
      }
      if (interlace) throw new Error("Interlaced PNG is not supported");
      var chans = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
      if (!chans || ctype === 0 || ctype === 4) throw new Error("PNG must be RGB or RGBA");
      if (depth !== 8 && depth !== 16) throw new Error("PNG bit depth must be 8 or 16");
      var z = new Uint8Array(total), q = 0;
      idat.forEach(function (d) { z.set(d, q); q += d.length; });
      return Z.zlibInflate(z).then(function (raw) {
        var bpp = chans * depth / 8, stride = W * bpp, prev = new Uint8Array(stride), cur = new Uint8Array(stride);
        var R = new Float32Array(W * H), G = new Float32Array(W * H), max = depth === 16 ? 65535 : 255;
        for (var y = 0; y < H; y++) {
          var f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
          for (var x = 0; x < stride; x++) {
            var a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = src[x];
            cur[x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
          }
          for (var i2 = 0; i2 < W; i2++) {
            var o = i2 * bpp;
            if (depth === 16) {
              R[y * W + i2] = ((cur[o] << 8) | cur[o + 1]) / max;
              G[y * W + i2] = ((cur[o + 2] << 8) | cur[o + 3]) / max;
            } else {
              R[y * W + i2] = cur[o] / max; G[y * W + i2] = cur[o + 1] / max;
            }
          }
          var t = prev; prev = cur; cur = t;
        }
        return { W: W, H: H, w: W, h: H, dw: { x0: 0, y0: 0, x1: W - 1, y1: H - 1 }, R: R, G: G, bitDepth: depth };
      });
    } catch (e) { return Promise.reject(e); }
  }

  var api = { writeStmapPNG16: writeStmapPNG16, readPNG: readPNG };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STPng = api;
})(this);
