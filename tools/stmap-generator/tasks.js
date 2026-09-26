/* =========================================================================
   STMap generator — tasks.js
   重い処理の本体。worker.js（別スレッド）とメインスレッド（Worker が使えない環境）の両方から呼ぶ。
   models.js / exr.js / png16.js / fit.js が先に読み込まれていること。
   ========================================================================= */
(function (root) {
  "use strict";
  var STModels = root.STModels, STExr = root.STExr, STPng = root.STPng, STFit = root.STFit;
  var cache = null;   // 最後に読み込んだ STMap（{ id, img }）
  root.STTasks = {
    /* p: { opts, format: "exr-zip" | "exr" | "png16", blue: 0|1, meta } → { buffer, name, clipped, unconverged } */
    build: function (p, progress) {
      var map = STModels.buildMap(p.opts, function (f) { progress(f * 0.7); });
      map.blue = p.blue ? 1 : 0;
      if (p.format === "png16") {
        return STPng.writeStmapPNG16(map, function (f) { progress(0.7 + f * 0.3); }).then(function (r) {
          return { buffer: r.buffer, clipped: r.clipped, unconverged: map.unconverged };
        });
      }
      return STExr.writeStmapEXRAsync(map, p.meta, {
        compression: p.format === "exr" ? "none" : "zip",
        onProgress: function (f) { progress(0.7 + f * 0.3); }
      }).then(function (buf) { return { buffer: buf, clipped: 0, unconverged: map.unconverged }; });
    },
    /* p: { fileId, buffer?, base?, dir, estimateCenter }
       buffer を渡すと読み込んでキャッシュする（以後は fileId だけで当てはめをやり直せる）。
       base を省くとファイル情報だけ返す。 */
    analyze: function (p, progress) {
      var ready;
      if (p.buffer) {
        var u8 = new Uint8Array(p.buffer, 0, 8), isPng = u8[0] === 137 && u8[1] === 80;
        ready = (isPng ? STPng.readPNG(p.buffer) : STExr.readEXR(p.buffer)).then(function (img) {
          img.isPng = isPng;
          cache = { id: p.fileId, img: img };
          return img;
        });
      } else if (cache && cache.id === p.fileId) ready = Promise.resolve(cache.img);
      else return Promise.reject(new Error("File is no longer loaded"));
      return ready.then(function (img) {
        progress(0.3);
        var info = {
          W: img.W, H: img.H, w: img.w, h: img.h, dw: img.dw,
          format: img.isPng ? "PNG " + img.bitDepth + "-bit" : "EXR " + img.pixelType + " · " + img.compression,
          lowPrecision: img.isPng ? img.bitDepth < 16 : img.pixelType === "half",
          meta: img.attrs && img.attrs.vernierStmap || null
        };
        if (!p.base) return { info: info };
        var base = JSON.parse(JSON.stringify(p.base)); base.W = img.W; base.H = img.H;
        if (base.focalMm) base.focalPx = base.focalMm * img.W / base.sensorMm;
        return { info: info, fit: STFit.fitMap(img, base, p.dir, p.estimateCenter) };
      });
    },
    /* p: { src, dst } → 係数変換（軽いが、Nuke/逆方向は反復があるので同じ経路で回す） */
    convert: function (p) {
      return STFit.convert(p.src, p.dst, false);
    }
  };
})(this);
