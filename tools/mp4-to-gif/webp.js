/* =========================================================================
   Video to GIF — webp.js
   アニメーション WebP の組み立て（外部ライブラリ不使用）。
   各コマは canvas.toBlob("image/webp") で静止画 WebP にし、その中の画像データ
   （VP8 / VP8L / ALPH チャンク）を ANMF チャンクに詰め直す。
   仕様: https://developers.google.com/speed/webp/docs/riff_container
   ========================================================================= */
(function (root) {
  "use strict";

  function fourcc(u8, p) { return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]); }

  /* 静止画 WebP（ArrayBuffer）から画像データのチャンクを取り出す */
  function frameChunks(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf);
    if (fourcc(u8, 0) !== "RIFF" || fourcc(u8, 8) !== "WEBP") throw new Error("Not a WebP image");
    var p = 12, chunks = [], alpha = false;
    while (p + 8 <= u8.length) {
      var id = fourcc(u8, p), size = dv.getUint32(p + 4, true), total = 8 + size + (size & 1);
      if (id === "VP8 " || id === "VP8L" || id === "ALPH") {
        chunks.push(u8.subarray(p, p + total));
        if (id === "ALPH") alpha = true;
        if (id === "VP8L") alpha = alpha || !!(u8[p + 8 + 4] & 0x10);   // VP8L ヘッダの alpha_is_used
      }
      p += total;
    }
    if (!chunks.length) throw new Error("WebP image data not found");
    return { chunks: chunks, alpha: alpha };
  }

  function u24(out, v) { out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255); }
  function u32(out, v) { out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); }
  function str(out, s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); }

  /* frames: [{ buffer: 静止画 WebP の ArrayBuffer, ms: 表示時間 }]、全コマ同じ大きさ（width × height）
     loop: true で無限ループ、false で 1 回 */
  function muxAnimatedWebP(frames, width, height, loop) {
    var parts = [], anyAlpha = false;
    frames.forEach(function (f) {
      var fc = frameChunks(f.buffer);
      anyAlpha = anyAlpha || fc.alpha;
      var head = [];
      u24(head, 0); u24(head, 0);                         // X/2, Y/2
      u24(head, width - 1); u24(head, height - 1);
      u24(head, Math.max(1, Math.min(0xffffff, Math.round(f.ms))));
      head.push(0x02);                                     // 重ねない（上書き）・破棄しない
      var body = head.length; fc.chunks.forEach(function (c) { body += c.length; });
      var anmf = []; str(anmf, "ANMF"); u32(anmf, body);
      parts.push(new Uint8Array(anmf.concat(head)));
      fc.chunks.forEach(function (c) { parts.push(c); });
      if (body & 1) parts.push(new Uint8Array([0]));
    });
    var vp8x = []; str(vp8x, "VP8X"); u32(vp8x, 10);
    vp8x.push(0x02 | (anyAlpha ? 0x10 : 0), 0, 0, 0);    // animation (+ alpha)
    u24(vp8x, width - 1); u24(vp8x, height - 1);
    var anim = []; str(anim, "ANIM"); u32(anim, 6);
    u32(anim, 0);                                          // 背景色
    anim.push(loop ? 0 : 1, 0);                            // ループ回数（0 = 無限）
    var bodyLen = 4 + vp8x.length + anim.length;
    parts.forEach(function (p) { bodyLen += p.length; });
    var head2 = []; str(head2, "RIFF"); u32(head2, bodyLen); str(head2, "WEBP");
    var all = [new Uint8Array(head2), new Uint8Array(vp8x), new Uint8Array(anim)].concat(parts);
    var total = 0; all.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), q = 0;
    all.forEach(function (p) { out.set(p, q); q += p.length; });
    return out;
  }

  var api = { muxAnimatedWebP: muxAnimatedWebP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WebPMux = api;
})(this);
