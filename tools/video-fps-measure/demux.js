/* =========================================================================
   Actual frame rate — demux.js
   動画ファイル（MP4 / MOV / WebM / MKV）の中にある「フレームの一覧表」を直接読む。
   再生はしない。各フレームの表示時刻・ファイル内の位置・キーフレームかどうかと、
   WebCodecs の VideoDecoder に渡す設定（codec 文字列と description）を返す。

   Demux.open(reader) → Promise<{
     container, codecName, codec, description, width, height,
     image,               // PNG / Motion JPEG のように 1 フレームが 1 枚の画像なら、その MIME（画像として展開する）
     timebase,            // 時刻の最小刻み（秒）。MP4 は 1/timescale、WebM は TimecodeScale
     declaredFps,         // ファイルに書かれた fps（WebM の DefaultDuration）。無ければ null
     samples: [{ pos, size, pts, dts, key }]   // pts/dts は秒。並びはファイル（デコード）順
   }>
   reader: { size, read(pos, len) → Promise<Uint8Array> }
   ========================================================================= */
(function (root) {
  "use strict";

  function fail(code) { var e = new Error(code); e.code = code; throw e; }
  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
  function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
  function s32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
  function str4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
  function hex2(n) { return (n < 16 ? "0" : "") + n.toString(16); }
  function dec2(n) { return (n < 10 ? "0" : "") + n; }

  /* ---- File を 1 MB 単位でキャッシュしながら読む ---- */
  function fileReader(file) {
    var BLOCK = 1 << 20, cache = new Map();
    function block(i) {
      if (cache.has(i)) { var v = cache.get(i); cache.delete(i); cache.set(i, v); return v; }
      var p = file.slice(i * BLOCK, Math.min(file.size, (i + 1) * BLOCK)).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      cache.set(i, p);
      if (cache.size > 24) cache.delete(cache.keys().next().value);
      return p;
    }
    return {
      size: file.size,
      read: function (pos, len) {
        len = Math.max(0, Math.min(len, file.size - pos));
        if (len > BLOCK * 2) return file.slice(pos, pos + len).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
        var a = Math.floor(pos / BLOCK), z = Math.floor((pos + len - 1) / BLOCK), parts = [];
        if (len === 0) return Promise.resolve(new Uint8Array(0));
        for (var i = a; i <= z; i++) parts.push(block(i));
        return Promise.all(parts).then(function (bs) {
          if (bs.length === 1) { var o = pos - a * BLOCK; return bs[0].subarray(o, o + len); }
          var out = new Uint8Array(len), w = 0;
          bs.forEach(function (b, k) {
            var st = k === 0 ? pos - a * BLOCK : 0, en = Math.min(b.length, pos + len - (a + k) * BLOCK);
            out.set(b.subarray(st, en), w); w += en - st;
          });
          return out;
        });
      }
    };
  }

  /* =====================================================================
     codec 文字列（WebCodecs 用）
     ===================================================================== */
  function avcCodec(avcC) { return "avc1." + hex2(avcC[1]) + hex2(avcC[2]) + hex2(avcC[3]); }
  function hevcCodec(h, entry) {
    var space = h[1] >> 6, tier = (h[1] >> 5) & 1, prof = h[1] & 31, compat = u32(h, 2), rev = 0;
    for (var i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    var cons = Array.prototype.slice.call(h, 6, 12);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    return (entry === "hev1" ? "hev1" : "hvc1") + "." + ["", "A", "B", "C"][space] + prof + "." + (rev >>> 0).toString(16).toUpperCase() +
      "." + (tier ? "H" : "L") + h[12] + cons.map(function (c) { return "." + c.toString(16).toUpperCase(); }).join("");
  }
  function av1Codec(c) {
    var prof = c[1] >> 5, lvl = c[1] & 31, tier = c[2] >> 7, hbd = (c[2] >> 6) & 1, twelve = (c[2] >> 5) & 1;
    return "av01." + prof + "." + dec2(lvl) + (tier ? "H" : "M") + "." + (hbd ? (twelve ? "12" : "10") : "08");
  }
  function vp9Codec(profile, level, depth) { return "vp09." + dec2(profile || 0) + "." + dec2(level || 10) + "." + dec2(depth || 8); }

  /* =====================================================================
     MP4 / MOV（ISO BMFF）
     ===================================================================== */
  function boxes(b, start, end) {   // メモリ上のボックス列を列挙
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = u32(b, p), type = str4(b, p + 4), hdr = 8;
      if (size === 1) { size = u64(b, p + 8); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type: type, start: p, data: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }
  function child(b, box, type) { var l = boxes(b, box.data, box.end); for (var i = 0; i < l.length; i++) if (l[i].type === type) return l[i]; return null; }
  function path(b, box, types) { for (var i = 0; box && i < types.length; i++) box = child(b, box, types[i]); return box; }

  async function topBoxes(reader) {
    var list = [], p = 0;
    while (p + 8 <= reader.size) {
      var h = await reader.read(p, 16), size = u32(h, 0), type = str4(h, 4), hdr = 8;
      if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = reader.size - p;
      if (size < hdr) break;
      list.push({ type: type, start: p, hdr: hdr, size: size });
      p += size;
    }
    return list;
  }

  var MP4_CODECS = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", vp09: "VP9", vp08: "VP8", av01: "AV1",
    apch: "ProRes 422 HQ", apcn: "ProRes 422", apcs: "ProRes 422 LT", apco: "ProRes 422 Proxy", ap4h: "ProRes 4444", ap4x: "ProRes 4444 XQ",
    mp4v: "MPEG-4 Part 2", jpeg: "Motion JPEG", mjpa: "Motion JPEG", "png ": "PNG", "rle ": "QuickTime Animation", AVdn: "DNxHD / DNxHR", AVdh: "DNxHR",
    "raw ": "Uncompressed", v210: "Uncompressed 10-bit", "2vuy": "Uncompressed 8-bit", dvh1: "Dolby Vision", dvhe: "Dolby Vision", encv: "encrypted", cvid: "Cinepak", "SVQ3": "Sorenson Video 3" };

  async function openMp4(reader, tops) {
    var moovTop = tops.find(function (t) { return t.type === "moov"; });
    if (!moovTop) fail("nomoov");
    var mb = await reader.read(moovTop.start, moovTop.size), moov = { data: moovTop.hdr, end: moovTop.size };
    var traks = boxes(mb, moov.data, moov.end).filter(function (x) { return x.type === "trak"; }), trak = null, hdlr;
    for (var i = 0; i < traks.length; i++) {
      hdlr = path(mb, traks[i], ["mdia", "hdlr"]);
      if (hdlr && str4(mb, hdlr.data + 8) === "vide") { trak = traks[i]; break; }
    }
    if (!trak) fail("novideo");
    var tkhd = child(mb, trak, "tkhd"), trackId = u32(mb, tkhd.data + (mb[tkhd.data] === 1 ? 20 : 12));
    var mdhd = path(mb, trak, ["mdia", "mdhd"]), v1 = mb[mdhd.data] === 1;
    var timescale = u32(mb, mdhd.data + (v1 ? 20 : 12));
    var stbl = path(mb, trak, ["mdia", "minf", "stbl"]);
    var stsd = child(mb, stbl, "stsd"), entry = boxes(mb, stsd.data + 8, stsd.end)[0];
    var fourcc = entry.type, info = { container: "MP4", codecName: MP4_CODECS[fourcc] || fourcc.trim(), codec: null, description: null,
      image: fourcc === "png " ? "image/png" : fourcc === "jpeg" ? "image/jpeg" : null,
      width: u16(mb, entry.data + 24), height: u16(mb, entry.data + 26), timebase: 1 / timescale, declaredFps: null };
    var sub = boxes(mb, entry.data + 78, entry.end), cfg = {};
    sub.forEach(function (x) { cfg[x.type] = mb.slice(x.data, x.end); });
    if ((fourcc === "avc1" || fourcc === "avc3") && cfg.avcC) { info.codec = avcCodec(cfg.avcC); info.description = cfg.avcC; }
    else if ((fourcc === "hvc1" || fourcc === "hev1") && cfg.hvcC) { info.codec = hevcCodec(cfg.hvcC, fourcc); info.description = cfg.hvcC; }
    else if (fourcc === "vp09") { var vp = cfg.vpcC; info.codec = vp ? vp9Codec(vp[4], vp[5], vp[6] >> 4) : vp9Codec(); }
    else if (fourcc === "vp08") info.codec = "vp8";
    else if (fourcc === "av01" && cfg.av1C) { info.codec = av1Codec(cfg.av1C); info.description = cfg.av1C; }

    // ---- 通常の（断片化していない）サンプル表 ----
    var samples = [], stsz = child(mb, stbl, "stsz") || child(mb, stbl, "stz2");
    var count = stsz ? u32(mb, stsz.data + 8) : 0;
    if (count > 0) {
      var sizes = new Array(count), fixed = u32(mb, stsz.data + 4), k;
      if (stsz.type === "stsz") for (k = 0; k < count; k++) sizes[k] = fixed || u32(mb, stsz.data + 12 + k * 4);
      else {
        var fs = mb[stsz.data + 7];
        for (k = 0; k < count; k++) sizes[k] = fs === 16 ? u16(mb, stsz.data + 12 + k * 2) : fs === 8 ? mb[stsz.data + 12 + k] : ((mb[stsz.data + 12 + (k >> 1)] >> (k & 1 ? 0 : 4)) & 15);
      }
      // 時刻（stts）と表示のずれ（ctts）
      var stts = child(mb, stbl, "stts"), n = u32(mb, stts.data + 4), dts = 0, idx = 0, dtsArr = new Array(count);
      for (k = 0; k < n && idx < count; k++) {
        var c = u32(mb, stts.data + 8 + k * 8), d = u32(mb, stts.data + 12 + k * 8);
        for (var j = 0; j < c && idx < count; j++) { dtsArr[idx++] = dts; dts += d; }
      }
      while (idx < count) dtsArr[idx++] = dts;
      var ctsOff = new Array(count).fill(0), ctts = child(mb, stbl, "ctts");
      if (ctts) {
        var cv1 = mb[ctts.data] === 1; n = u32(mb, ctts.data + 4); idx = 0;
        for (k = 0; k < n && idx < count; k++) {
          var cc = u32(mb, ctts.data + 8 + k * 8), off = cv1 ? s32(mb, ctts.data + 12 + k * 8) : u32(mb, ctts.data + 12 + k * 8);
          for (var jj = 0; jj < cc && idx < count; jj++) ctsOff[idx++] = off;
        }
      }
      // キーフレーム（stss が無ければ全部キー）
      var keys = null, stss = child(mb, stbl, "stss");
      if (stss) { keys = new Uint8Array(count); n = u32(mb, stss.data + 4); for (k = 0; k < n; k++) { var s = u32(mb, stss.data + 8 + k * 4) - 1; if (s < count) keys[s] = 1; } }
      // チャンクの位置（stsc + stco/co64）
      var stsc = child(mb, stbl, "stsc"), stco = child(mb, stbl, "stco"), co64 = child(mb, stbl, "co64");
      var nChunks = u32(mb, (stco || co64).data + 4), chunkOff = function (ci) { return stco ? u32(mb, stco.data + 8 + ci * 4) : u64(mb, co64.data + 8 + ci * 8); };
      var nsc = u32(mb, stsc.data + 4), si = 0;
      for (k = 0; k < nsc; k++) {
        var first = u32(mb, stsc.data + 8 + k * 12) - 1, per = u32(mb, stsc.data + 12 + k * 12);
        var last = k + 1 < nsc ? u32(mb, stsc.data + 8 + (k + 1) * 12) - 1 : nChunks;
        for (var ch = first; ch < last && si < count; ch++) {
          var p = chunkOff(ch);
          for (var q = 0; q < per && si < count; q++, si++) {
            samples.push({ pos: p, size: sizes[si], dts: dtsArr[si] / timescale, pts: (dtsArr[si] + ctsOff[si]) / timescale, key: keys ? !!keys[si] : true });
            p += sizes[si];
          }
        }
      }
    }

    // ---- 断片化 MP4（moof）: 画面収録やブラウザ録画に多い ----
    var moofs = tops.filter(function (t) { return t.type === "moof"; });
    if (moofs.length) {
      var trex = null, mvex = child(mb, moov, "mvex");
      if (mvex) boxes(mb, mvex.data, mvex.end).forEach(function (x) { if (x.type === "trex" && u32(mb, x.data + 4) === trackId) trex = x; });
      var defDur = trex ? u32(mb, trex.data + 12) : 0, defSize = trex ? u32(mb, trex.data + 16) : 0, defFlags = trex ? u32(mb, trex.data + 20) : 0;
      var nextDts = 0;
      for (var m = 0; m < moofs.length; m++) {
        var fb = await reader.read(moofs[m].start, moofs[m].size), moof = { data: moofs[m].hdr, end: moofs[m].size };
        boxes(fb, moof.data, moof.end).forEach(function (traf) {
          if (traf.type !== "traf") return;
          var tfhd = child(fb, traf, "tfhd"); if (!tfhd || u32(fb, tfhd.data + 4) !== trackId) return;
          var tf = u32(fb, tfhd.data) & 0xffffff, o = tfhd.data + 8, base = moofs[m].start;
          if (tf & 1) { base = u64(fb, o); o += 8; }
          if (tf & 2) o += 4;
          var dDur = defDur, dSize = defSize, dFlags = defFlags;
          if (tf & 8) { dDur = u32(fb, o); o += 4; }
          if (tf & 0x10) { dSize = u32(fb, o); o += 4; }
          if (tf & 0x20) { dFlags = u32(fb, o); o += 4; }
          var tfdt = child(fb, traf, "tfdt");
          if (tfdt) nextDts = fb[tfdt.data] === 1 ? u64(fb, tfdt.data + 4) : u32(fb, tfdt.data + 4);
          boxes(fb, traf.data, traf.end).forEach(function (trun) {
            if (trun.type !== "trun") return;
            var ver = fb[trun.data], fl = u32(fb, trun.data) & 0xffffff, n = u32(fb, trun.data + 4), r = trun.data + 8, pos = base, firstFlags = null;
            if (fl & 1) { pos = base + s32(fb, r); r += 4; }
            if (fl & 4) { firstFlags = u32(fb, r); r += 4; }
            for (var t = 0; t < n; t++) {
              var dur = dDur, size = dSize, flags = t === 0 && firstFlags != null ? firstFlags : dFlags, cto = 0;
              if (fl & 0x100) { dur = u32(fb, r); r += 4; }
              if (fl & 0x200) { size = u32(fb, r); r += 4; }
              if (fl & 0x400) { flags = u32(fb, r); r += 4; }
              if (fl & 0x800) { cto = ver ? s32(fb, r) : u32(fb, r); r += 4; }
              samples.push({ pos: pos, size: size, dts: nextDts / timescale, pts: (nextDts + cto) / timescale, key: !(flags & 0x10000) });
              pos += size; nextDts += dur;
            }
          });
        });
      }
    }
    if (/^ap/.test(fourcc)) info.container = "MOV";
    else if (tops.some(function (t) { return t.type === "wide"; })) info.container = "MOV";
    info.samples = samples;
    return info;
  }

  /* =====================================================================
     WebM / MKV（EBML）
     ===================================================================== */
  function vint(b, o, keepMarker) {   // {value, len}。サイズ未定（全ビット 1）は value = -1
    var first = b[o], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    if (len > 8) return null;
    var v = keepMarker ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 255) allOnes = false; }
    return { value: !keepMarker && allOnes ? -1 : v, len: len };
  }
  function uint(b, o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; }
  function float(b, o, n) { var dv = new DataView(b.buffer, b.byteOffset + o, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); }
  function elements(b, start, end) {
    var out = [], p = start;
    while (p < end) {
      var id = vint(b, p, true); if (!id) break;
      var sz = vint(b, p + id.len); if (!sz) break;
      var data = p + id.len + sz.len, size = sz.value < 0 ? end - data : sz.value;
      out.push({ id: id.value, data: data, size: size, end: data + size });
      p = data + size;
    }
    return out;
  }
  var ID = { EBML: 0x1A45DFA3, Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Tracks: 0x1654AE6B, TrackEntry: 0xAE,
    TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2, DefaultDuration: 0x23E383, Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
    Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, ReferenceBlock: 0xFB };
  var TOP_LEVEL = [0x114D9B74, ID.Info, ID.Tracks, ID.Cluster, 0x1C53BB6B, 0x1043A770, 0x1254C367, 0x1941A469];
  var MKV_CODECS = { "V_MPEG4/ISO/AVC": "H.264", "V_MPEGH/ISO/HEVC": "HEVC", V_VP9: "VP9", V_VP8: "VP8", V_AV1: "AV1",
    V_PRORES: "ProRes", "V_MPEG2": "MPEG-2", "V_MJPEG": "Motion JPEG", "V_MS/VFW/FOURCC": "VfW", V_THEORA: "Theora", V_FFV1: "FFV1" };

  async function openMkv(reader) {
    var h = await reader.read(0, 64), p = 0, e = elements(h, 0, h.length)[0];
    if (!e || e.id !== ID.EBML) fail("unknown");
    var ebmlEnd = e.end, docType = "";
    elements(h, e.data, Math.min(e.end, h.length)).forEach(function (x) { if (x.id === 0x4282) docType = String.fromCharCode.apply(null, h.subarray(x.data, x.end)); });
    h = await reader.read(ebmlEnd, 16);
    var sid = vint(h, 0, true), ssz = vint(h, sid.len);
    if (sid.value !== ID.Segment) fail("unknown");
    var segStart = ebmlEnd + sid.len + ssz.len, segEnd = ssz.value < 0 ? reader.size : Math.min(reader.size, segStart + ssz.value);
    var tcScale = 1e6, track = null, samples = [];
    p = segStart;
    while (p < segEnd) {
      h = await reader.read(p, 16); if (h.length < 2) break;
      var id = vint(h, 0, true), sz = vint(h, id.len); if (!id || !sz) break;
      var data = p + id.len + sz.len;
      if (id.value === ID.Info || id.value === ID.Tracks) {
        var b = await reader.read(data, sz.value), list = elements(b, 0, b.length);
        if (id.value === ID.Info) list.forEach(function (x) { if (x.id === ID.TimecodeScale) tcScale = uint(b, x.data, x.size); });
        else list.forEach(function (te) {
          if (te.id !== ID.TrackEntry || track) return;
          var t = {};
          elements(b, te.data, te.end).forEach(function (x) {
            if (x.id === ID.TrackNumber) t.num = uint(b, x.data, x.size);
            else if (x.id === ID.TrackType) t.type = uint(b, x.data, x.size);
            else if (x.id === ID.CodecID) t.codecId = String.fromCharCode.apply(null, b.subarray(x.data, x.end)).replace(/\0+$/, "");
            else if (x.id === ID.CodecPrivate) t.priv = b.slice(x.data, x.end);
            else if (x.id === ID.DefaultDuration) t.defDur = uint(b, x.data, x.size);
            else if (x.id === ID.Video) elements(b, x.data, x.end).forEach(function (v) {
              if (v.id === ID.PixelWidth) t.w = uint(b, v.data, v.size); else if (v.id === ID.PixelHeight) t.h = uint(b, v.data, v.size);
            });
          });
          if (t.type === 1) track = t;
        });
        p = data + sz.value;
      } else if (id.value === ID.Cluster) {
        if (!track) fail("novideo");
        p = await readCluster(reader, data, sz.value, segEnd, track, tcScale, samples);
      } else {
        if (sz.value < 0) break;
        p = data + sz.value;
      }
    }
    if (!track) fail("novideo");
    var cid = track.codecId || "", info = { container: "WebM", codecName: MKV_CODECS[cid] || cid, codec: null, description: null,
      image: cid === "V_MJPEG" ? "image/jpeg" : null,
      width: track.w || 0, height: track.h || 0, timebase: tcScale / 1e9, declaredFps: track.defDur ? 1e9 / track.defDur : null, samples: samples };
    if (docType !== "webm") info.container = "MKV";
    if (cid === "V_MPEG4/ISO/AVC" && track.priv) { info.codec = avcCodec(track.priv); info.description = track.priv; }
    else if (cid === "V_MPEGH/ISO/HEVC" && track.priv) { info.codec = hevcCodec(track.priv, "hvc1"); info.description = track.priv; }
    else if (cid === "V_VP8") info.codec = "vp8";
    else if (cid === "V_VP9") {
      var prof = 0, lvl = 10, depth = 8;
      if (track.priv) for (var i = 0; i + 2 < track.priv.length; i += 2 + track.priv[i + 1]) {
        var fid = track.priv[i], val = track.priv[i + 2];
        if (fid === 1) prof = val; else if (fid === 2) lvl = val; else if (fid === 3) depth = val;
      }
      info.codec = vp9Codec(prof, lvl, depth);
    } else if (cid === "V_AV1" && track.priv && track.priv.length >= 4) { info.codec = av1Codec(track.priv); info.description = track.priv; }
    return info;
  }

  // クラスター 1 つ分のブロックを読む。サイズ未定（ブラウザ録画など）のときは、次の最上位要素までを 1 つとみなす
  async function readCluster(reader, start, size, segEnd, track, tcScale, samples) {
    var end = size < 0 ? segEnd : start + size, p = start, tc = 0;
    while (p < end) {
      var h = await reader.read(p, 16); if (h.length < 2) return end;
      var id = vint(h, 0, true), sz = vint(h, id.len); if (!id || !sz) return end;
      if (size < 0 && TOP_LEVEL.indexOf(id.value) >= 0) return p;
      var data = p + id.len + sz.len, len = sz.value;
      if (len < 0) return end;
      if (id.value === ID.Timecode) { var t = await reader.read(data, len); tc = uint(t, 0, len); }
      else if (id.value === ID.SimpleBlock) await block(reader, data, len, true, null);
      else if (id.value === ID.BlockGroup) {
        var g = await reader.read(data, Math.min(len, 64)), bl = null, ref = false;
        // ブロック本体の手前にある要素だけ見れば足りる（本体は位置だけ使う）
        var q = 0;
        while (q < g.length) {
          var gi = vint(g, q, true), gs = gi && vint(g, q + gi.len); if (!gi || !gs) break;
          if (gi.value === ID.Block) bl = { data: data + q + gi.len + gs.len, len: gs.value };
          else if (gi.value === ID.ReferenceBlock) ref = true;
          q += gi.len + gs.len + gs.value;
        }
        if (bl) await block(reader, bl.data, bl.len, false, ref);
      }
      p = data + len;
    }
    return end;

    async function block(r, pos, len, simple, ref) {
      var b = await r.read(pos, 12), tn = vint(b, 0); if (!tn || tn.value !== track.num) return;
      var rel = (b[tn.len] << 24 >> 16) | b[tn.len + 1], flags = b[tn.len + 2], hdr = tn.len + 3;
      var ts = (tc + rel) * tcScale / 1e9;
      samples.push({ pos: pos + hdr, size: len - hdr, pts: ts, dts: ts, key: simple ? !!(flags & 0x80) : !ref, laced: !!(flags & 0x06) });
    }
  }

  /* ===================================================================== */
  async function open(reader) {
    var h = await reader.read(0, 12);
    if (h.length >= 4 && u32(h, 0) === ID.EBML) return openMkv(reader);
    var t = h.length >= 8 ? str4(h, 4) : "";
    if (["ftyp", "moov", "mdat", "free", "wide", "skip", "styp", "pnot"].indexOf(t) < 0) fail("unknown");
    return openMp4(reader, await topBoxes(reader));
  }

  root.Demux = { open: open, fileReader: fileReader };
})(typeof self !== "undefined" ? self : this);
