/* =========================================================================
   Video to GIF — gif.js
   アニメーション GIF の書き出し（外部ライブラリ不使用）。ブラウザ / Worker の両方で動く。
     減色   : メディアンカット（RGB 各 5bit のヒストグラム。代表色は元の色の加重平均）
     ディザ : Floyd–Steinberg（行ごとに向きを反転する serpentine）
     軽量化 : 前のコマと同じ色の画素を透明にし、変化した範囲だけを書く
     圧縮   : LZW（GIF89a）
   ========================================================================= */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------------
     減色（メディアンカット）
     --------------------------------------------------------------------- */
  function key5(r, g, b) { return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); }

  /* frames: Uint8ClampedArray(RGBA) の配列 → 色の数 maxColors 以下のパレット [[r,g,b], …] */
  function buildPalette(frames, maxColors) {
    var cnt = new Float64Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
    var total = 0;
    frames.forEach(function (px) { total += px.length / 4; });
    var stride = Math.max(1, Math.floor(total / 2e6));          // 大きいときは間引いて数える
    frames.forEach(function (px) {
      for (var i = 0; i < px.length; i += 4 * stride) {
        var r = px[i], g = px[i + 1], b = px[i + 2], k = key5(r, g, b);
        cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
      }
    });
    var bins = [];
    for (var k = 0; k < 32768; k++) if (cnt[k]) bins.push(k);
    if (bins.length <= maxColors) {
      return bins.map(function (k) { return [Math.round(sr[k] / cnt[k]), Math.round(sg[k] / cnt[k]), Math.round(sb[k] / cnt[k])]; });
    }
    function ch(k, c) { return c === 0 ? (k >> 10) & 31 : c === 1 ? (k >> 5) & 31 : k & 31; }
    function box(list) {
      var lo = [31, 31, 31], hi = [0, 0, 0], n = 0;
      list.forEach(function (k) {
        for (var c = 0; c < 3; c++) { var v = ch(k, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
        n += cnt[k];
      });
      var span = [hi[0] - lo[0], hi[1] - lo[1] * 1, hi[2] - lo[2]];
      span[1] *= 1.2;                                            // 緑の差に少しだけ敏感に
      var axis = span[0] >= span[1] && span[0] >= span[2] ? 0 : span[1] >= span[2] ? 1 : 2;
      return { list: list, n: n, axis: axis, score: Math.max.apply(null, span) * Math.sqrt(n) };
    }
    var boxes = [box(bins)];
    while (boxes.length < maxColors) {
      var bi = -1, best = 0;
      boxes.forEach(function (b, i) { if (b.list.length > 1 && b.score > best) { best = b.score; bi = i; } });
      if (bi < 0) break;
      var b = boxes[bi], ax = b.axis;
      b.list.sort(function (x, y) { return ch(x, ax) - ch(y, ax); });
      var half = b.n / 2, acc = 0, cut = 1;
      for (var i = 0; i < b.list.length - 1; i++) { acc += cnt[b.list[i]]; if (acc >= half) { cut = i + 1; break; } }
      boxes.splice(bi, 1, box(b.list.slice(0, cut)), box(b.list.slice(cut)));
    }
    return boxes.map(function (b) {
      var n = 0, r = 0, g = 0, bb = 0;
      b.list.forEach(function (k) { n += cnt[k]; r += sr[k]; g += sg[k]; bb += sb[k]; });
      return [Math.round(r / n), Math.round(g / n), Math.round(bb / n)];
    });
  }

  /* 最近傍の色（5bit キーごとにキャッシュ） */
  function Mapper(pal) {
    var cache = new Int16Array(32768).fill(-1);
    this.pal = pal;
    this.nearest = function (r, g, b) {
      var k = key5(r, g, b), v = cache[k];
      if (v >= 0) return v;
      var cr = (r & 0xf8) | 4, cg = (g & 0xf8) | 4, cb = (b & 0xf8) | 4, bd = 1e9, bi = 0;
      for (var i = 0; i < pal.length; i++) {
        var dr = pal[i][0] - cr, dg = pal[i][1] - cg, db = pal[i][2] - cb;
        var d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < bd) { bd = d; bi = i; }
      }
      cache[k] = bi;
      return bi;
    };
  }

  /* 1コマを色番号に。dither: Floyd–Steinberg */
  function quantize(px, w, h, mapper, dither) {
    var out = new Uint8Array(w * h), pal = mapper.pal;
    if (!dither) {
      for (var i = 0, j = 0; j < out.length; i += 4, j++) out[j] = mapper.nearest(px[i], px[i + 1], px[i + 2]);
      return out;
    }
    var er = new Float32Array((w + 2) * 2), eg = new Float32Array((w + 2) * 2), eb = new Float32Array((w + 2) * 2);
    for (var y = 0; y < h; y++) {
      var cur = (y & 1) * (w + 2), nxt = ((y + 1) & 1) * (w + 2), ltr = (y & 1) === 0;
      for (var z = 0; z < w + 2; z++) { er[nxt + z] = 0; eg[nxt + z] = 0; eb[nxt + z] = 0; }
      for (var xi = 0; xi < w; xi++) {
        var x = ltr ? xi : w - 1 - xi, p = (y * w + x) * 4, e = cur + x + 1;
        var r = px[p] + er[e], g = px[p + 1] + eg[e], b = px[p + 2] + eb[e];
        r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
        var idx = mapper.nearest(r | 0, g | 0, b | 0), c = pal[idx];
        out[y * w + x] = idx;
        var dr = r - c[0], dg = g - c[1], db = b - c[2], s = ltr ? 1 : -1;
        er[e + s] += dr * 7 / 16; eg[e + s] += dg * 7 / 16; eb[e + s] += db * 7 / 16;
        var n = nxt + x + 1;
        er[n - s] += dr * 3 / 16; eg[n - s] += dg * 3 / 16; eb[n - s] += db * 3 / 16;
        er[n] += dr * 5 / 16; eg[n] += dg * 5 / 16; eb[n] += db * 5 / 16;
        er[n + s] += dr / 16; eg[n + s] += dg / 16; eb[n + s] += db / 16;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------
     LZW（GIF の可変長コード）
     --------------------------------------------------------------------- */
  var dict = new Int16Array(1 << 20).fill(-1), used = [];
  function lzw(indices, minCode, out) {
    for (var u = 0; u < used.length; u++) dict[used[u]] = -1;
    used.length = 0;
    var clear = 1 << minCode, eoi = clear + 1, size = minCode + 1, next = eoi + 1;
    var buf = [], acc = 0, bits = 0;
    function emit(code) {
      acc |= code << bits; bits += size;
      while (bits >= 8) { buf.push(acc & 255); acc >>>= 8; bits -= 8; }
    }
    emit(clear);
    var prefix = indices[0];
    for (var i = 1; i < indices.length; i++) {
      var k = indices[i], key = (prefix << 8) | k, v = dict[key];
      if (v >= 0) { prefix = v; continue; }
      emit(prefix);
      if (next < 4096) {
        dict[key] = next; used.push(key); next++;
        if (next > (1 << size) && size < 12) size++;
      } else {                                                   // 辞書が満杯: クリアして作り直す
        emit(clear);
        for (var u2 = 0; u2 < used.length; u2++) dict[used[u2]] = -1;
        used.length = 0; size = minCode + 1; next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (bits > 0) buf.push(acc & 255);
    out.push(minCode);
    for (var p = 0; p < buf.length; p += 255) {
      var n = Math.min(255, buf.length - p);
      out.push(n);
      for (var q = 0; q < n; q++) out.push(buf[p + q]);
    }
    out.push(0);
  }

  /* ---------------------------------------------------------------------
     GIF の組み立て
     opts: { width, height, fps, loop(true/false), colors(2..256), dither, palette: "global"|"frame", onProgress }
     frames: Uint8ClampedArray(RGBA, width×height) の配列
     --------------------------------------------------------------------- */
  function tableBits(n) { var b = 1; while ((1 << b) < n) b++; return b; }   // 2^b 色の表
  function writeTable(out, pal, bits) {
    for (var i = 0; i < (1 << bits); i++) { var c = pal[i] || [0, 0, 0]; out.push(c[0], c[1], c[2]); }
  }
  function u16(out, v) { out.push(v & 255, (v >> 8) & 255); }

  function encodeGIF(frames, opts) {
    var W = opts.width, H = opts.height, N = frames.length, prog = opts.onProgress || function () {};
    var colors = Math.max(2, Math.min(256, opts.colors | 0));
    var usable = colors - 1;                              // 1 色ぶんは「前のコマと同じ（透明）」の番号に使う
    var globalPal = null, globalMap = null;
    if (opts.palette !== "frame") {
      globalPal = buildPalette(frames, usable);
      globalMap = new Mapper(globalPal);
    }
    var out = [];
    "GIF89a".split("").forEach(function (c) { out.push(c.charCodeAt(0)); });
    u16(out, W); u16(out, H);
    var gBits = globalPal ? tableBits(globalPal.length + 1) : 0;
    out.push(globalPal ? (0x80 | 0x70 | (gBits - 1)) : 0x70, 0, 0);
    if (globalPal) writeTable(out, globalPal, gBits);
    if (opts.loop) {
      out.push(0x21, 0xff, 0x0b);
      "NETSCAPE2.0".split("").forEach(function (c) { out.push(c.charCodeAt(0)); });
      out.push(0x03, 0x01, 0, 0, 0);                        // 0 = 無限ループ
    }

    var shown = new Int32Array(W * H).fill(-1);            // 画面に表示中の色（RGB を 24bit で）
    var pending = null, t = 0, emitted = 0;
    function centis(sec) { return Math.round(sec * 100); }

    function flush(delaySec) {
      if (!pending) return;
      var d = Math.max(2, centis(t + delaySec) - centis(t));
      t += delaySec;
      var f = pending; pending = null;
      out.push(0x21, 0xf9, 0x04, (1 << 2) | (f.trans >= 0 ? 1 : 0));   // disposal 1 = 残す
      u16(out, d); out.push(f.trans >= 0 ? f.trans : 0, 0);
      out.push(0x2c); u16(out, f.x); u16(out, f.y); u16(out, f.w); u16(out, f.h);
      if (f.pal) { var b = tableBits(f.pal.length + 1); out.push(0x80 | (b - 1)); writeTable(out, f.pal, b); f.bits = b; }
      else { out.push(0); f.bits = gBits; }
      lzw(f.idx, Math.max(2, f.bits), out);
      emitted++;
    }

    var frameDur = 1 / opts.fps, carry = 0;
    for (var n = 0; n < N; n++) {
      var px = frames[n], pal = globalPal, map = globalMap;
      if (!pal) { pal = buildPalette([px], usable); map = new Mapper(pal); }
      var q = quantize(px, W, H, map, opts.dither);
      var trans = pal.length;                              // 透明の番号（パレットの直後）
      // 変化した範囲
      var x0 = W, y0 = H, x1 = -1, y1 = -1, rgb = new Int32Array(W * H);
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = y * W + x, c = pal[q[i]], v = (c[0] << 16) | (c[1] << 8) | c[2];
        rgb[i] = v;
        if (v !== shown[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { carry += frameDur; prog((n + 1) / N); continue; }   // 変化なし: 前のコマを延長
      flush(frameDur + carry); carry = 0;
      var fw = x1 - x0 + 1, fh = y1 - y0 + 1, idx = new Uint8Array(fw * fh), useT = n > 0;
      for (var yy = 0; yy < fh; yy++) for (var xx = 0; xx < fw; xx++) {
        var j = (y0 + yy) * W + (x0 + xx);
        idx[yy * fw + xx] = useT && rgb[j] === shown[j] ? trans : q[j];
        shown[j] = rgb[j];
      }
      pending = { x: x0, y: y0, w: fw, h: fh, idx: idx, trans: useT ? trans : -1, pal: globalPal ? null : pal };
      prog((n + 1) / N);
    }
    flush(frameDur + carry);
    out.push(0x3b);
    return { bytes: new Uint8Array(out), frames: emitted };
  }

  var api = { encodeGIF: encodeGIF, buildPalette: buildPalette };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GIFEnc = api;
})(this);
