/* =========================================================================
   STMap generator — exr.js
   OpenEXR 書き出し（scanline・無圧縮・float32・チャンネル B/G/R）。
   B は 1.0 固定（Blender の Map UV は3番目の成分を透明度として扱うため）。
   ブラウザと Node の両方で動く（ArrayBuffer を返す）。
   ========================================================================= */
(function (root) {
  "use strict";

  function Writer(size) {
    this.buf = new ArrayBuffer(size);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.p = 0;
  }
  Writer.prototype.u8w  = function (v) { this.dv.setUint8(this.p, v); this.p += 1; };
  Writer.prototype.i32  = function (v) { this.dv.setInt32(this.p, v, true); this.p += 4; };
  Writer.prototype.f32  = function (v) { this.dv.setFloat32(this.p, v, true); this.p += 4; };
  Writer.prototype.u64  = function (v) {           // オフセットは 2^53 未満なので分割して書く
    this.dv.setUint32(this.p, v % 4294967296, true);
    this.dv.setUint32(this.p + 4, Math.floor(v / 4294967296), true);
    this.p += 8;
  };
  Writer.prototype.str0 = function (s) {           // ASCII + NUL
    for (var i = 0; i < s.length; i++) this.u8w(s.charCodeAt(i) & 0x7f);
    this.u8w(0);
  };

  /* 属性ごとに「中身のバイト列」を作ってからヘッダーへ並べる */
  function attr(name, type, bytes) { return { name: name, type: type, bytes: bytes }; }
  function bytesOf(fn, size) { var w = new Writer(size); fn(w); return w.u8; }

  function headerAttrs(W, H, meta) {
    var chans = ["B", "G", "R"];                    // チャンネル名はアルファベット順が規約
    var list = [
      attr("channels", "chlist", bytesOf(function (w) {
        chans.forEach(function (c) {
          w.str0(c); w.i32(2);                      // pixel type 2 = FLOAT
          w.u8w(0); w.u8w(0); w.u8w(0); w.u8w(0);   // pLinear + reserved
          w.i32(1); w.i32(1);                       // x/y sampling
        });
        w.u8w(0);
      }, chans.length * 18 + 1)),
      attr("compression", "compression", new Uint8Array([0])),   // NO_COMPRESSION
      attr("dataWindow", "box2i", bytesOf(function (w) { w.i32(0); w.i32(0); w.i32(W - 1); w.i32(H - 1); }, 16)),
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
    return list;
  }

  /* map: { W, H, R, G }（R/G は上の行から並んだ Float32Array）→ ArrayBuffer */
  function writeStmapEXR(map, meta) {
    var W = map.W, H = map.H;
    var attrs = headerAttrs(W, H, meta);
    var headerSize = 8;
    attrs.forEach(function (a) { headerSize += a.name.length + 1 + a.type.length + 1 + 4 + a.bytes.length; });
    headerSize += 1;
    var lineBytes = W * 3 * 4, chunkSize = 8 + lineBytes;
    var total = headerSize + H * 8 + H * chunkSize;

    var w = new Writer(total);
    w.u8w(0x76); w.u8w(0x2f); w.u8w(0x31); w.u8w(0x01);   // magic
    w.i32(2);                                               // version 2, single-part scanline
    attrs.forEach(function (a) {
      w.str0(a.name); w.str0(a.type); w.i32(a.bytes.length);
      w.u8.set(a.bytes, w.p); w.p += a.bytes.length;
    });
    w.u8w(0);                                               // end of header

    var first = headerSize + H * 8;
    for (var y = 0; y < H; y++) w.u64(first + y * chunkSize);

    var f32 = new Float32Array(W);
    for (var row = 0; row < H; row++) {
      w.i32(row); w.i32(lineBytes);
      var o = row * W;
      f32.fill(1);                                            // B
      w.u8.set(new Uint8Array(f32.buffer), w.p); w.p += W * 4;
      f32.set(map.G.subarray(o, o + W));                      // G
      w.u8.set(new Uint8Array(f32.buffer), w.p); w.p += W * 4;
      f32.set(map.R.subarray(o, o + W));                      // R
      w.u8.set(new Uint8Array(f32.buffer), w.p); w.p += W * 4;
    }
    return w.buf;
  }

  var api = { writeStmapEXR: writeStmapEXR };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.STExr = api;
})(this);
