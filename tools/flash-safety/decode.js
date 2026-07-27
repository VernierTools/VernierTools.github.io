"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/decode.js
   MP4 / MOV の demux と WebCodecs によるデコード。

   Worker 内で使用する。事前に次を実行しておくこと:
       importScripts("vendor/mp4box.all.min.js");

   ⚠ mp4box.js 0.5.2 は MP4Box と DataStream を「別々のグローバル」として
     公開する。MP4Box.DataStream は存在しない（新しい版とは異なる）。
   ========================================================================= */
(function (scope) {

  /* ---------------------------------------------------------------------
     CICP（ISO/IEC 23091-2）値の対応表。colr ボックスの nclx が返す数値。
     --------------------------------------------------------------------- */
  var TRANSFER = {
    1: "bt709", 4: "gamma22", 5: "gamma28", 6: "smpte170m", 7: "smpte240m",
    8: "linear", 11: "iec61966-2-4", 13: "iec61966-2-1", 14: "bt2020-10",
    15: "bt2020-12", 16: "pq", 17: "smpte428", 18: "hlg"
  };
  var PRIMARIES = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020", 12: "smpte432" };
  var MATRIX    = { 0: "rgb", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020-ncl" };

  /* ---------------------------------------------------------------------
     コーデック文字列からビット深度を推定する。
     10bit以上は HDR 意図の可能性があるため、色情報が無い場合の判断に使う。
     --------------------------------------------------------------------- */
  function bitDepthFromCodec(codec) {
    if (!codec) return null;
    var c = codec.toLowerCase();

    // avc1.PPCCLL / avc3.PPCCLL — PP は profile_idc（16進）
    var m = c.match(/^avc[13]\.([0-9a-f]{2})/);
    if (m) {
      var p = parseInt(m[1], 16);
      if (p === 110) return 10;                 // High 10
      if (p === 122 || p === 244) return null;  // High 4:2:2 / 4:4:4 は 8〜10bit 可変
      return 8;                                 // Baseline/Main/High 等
    }
    // hvc1.P.xx.Lxx.xx / hev1... — P=1:Main(8bit) 2:Main10 3:MainSP 4:RExt
    m = c.match(/^(?:hvc1|hev1)\.(\d+)/);
    if (m) {
      var hp = parseInt(m[1], 10);
      if (hp === 2) return 10;
      if (hp === 1) return 8;
      return null;
    }
    // vp09.PP.LL.DD
    m = c.match(/^vp09\.\d+\.\d+\.(\d+)/);
    if (m) return parseInt(m[1], 10);
    // av01.P.LLT.DD
    m = c.match(/^av01\.\d+\.\d+[a-z]?\.(\d+)/);
    if (m) return parseInt(m[1], 10);

    return null;
  }

  /* ---------------------------------------------------------------------
     色空間の分類と可否判定。仕様書 §2.3。

     結論:
       "sdr"     … 解析続行
       "sdr-assumed" … SDRと推定して続行（警告を出す）
       "hdr"     … HDR。解析せず停止
       "unknown" … 判定不能。停止
     --------------------------------------------------------------------- */
  function classifyColor(info) {
    var transfer = info.transfer || null;
    var depth    = info.bitDepth == null ? null : info.bitDepth;

    if (transfer === "pq" || transfer === "hlg" || transfer === "bt2020-10" || transfer === "bt2020-12") {
      return { mode: "hdr", transfer: transfer,
               reason: "HDR（" + transfer.toUpperCase() + "）映像です。本ツールはSDRのみ対応のため判定できません。" };
    }
    if (transfer === "linear" || transfer === "smpte428") {
      return { mode: "unknown", transfer: transfer,
               reason: "リニア／DCI系の伝達関数です。本ツールの前提（SDR・ピーク白200cd/m²）と異なるため判定できません。" };
    }
    if (transfer === "bt709" || transfer === "smpte170m" || transfer === "iec61966-2-1" ||
        transfer === "gamma22" || transfer === "gamma28" || transfer === "iec61966-2-4") {
      return { mode: "sdr", transfer: transfer, reason: null };
    }
    if (transfer === null) {
      // 実素材の多く（ffmpeg既定出力など）は色情報が無タグ。
      // ただし 10bit 以上の無タグは HDR 意図が壊れている可能性があるため停止する。
      if (depth != null && depth >= 10) {
        return { mode: "unknown", transfer: null, bitDepth: depth,
                 reason: depth + "bit映像ですが色空間のタグがありません。HDRの可能性を否定できないため判定できません。" };
      }
      return { mode: "sdr-assumed", transfer: null, bitDepth: depth,
               reason: "色空間のタグがありません。8bit映像のため BT.709 / SDR と推定して解析します。" };
    }
    return { mode: "unknown", transfer: transfer,
             reason: "未知の伝達関数（" + transfer + "）のため判定できません。" };
  }

  /* ---------------------------------------------------------------------
     画素値の実測レンジを取る。
     copyTo() が返す実データを解釈するには「どの経路が使えたか」だけでは
     不十分で、パックドRGB系（BGRX等）の場合はリミテッド/フルレンジのどちらで
     格納されているかが不明なため、実測 min/max で判定する。

     対応フォーマット:
       packed RGB系: RGBA / BGRA / RGBX / BGRX（4バイト/画素、4バイト目は無視）
       planar YUV系: I420 / I422 / I444 / NV12（先頭 width*height バイトが輝度面）
     --------------------------------------------------------------------- */
  var PACKED_RGB = { RGBA: [0, 1, 2], BGRA: [2, 1, 0], RGBX: [0, 1, 2], BGRX: [2, 1, 0] };
  var PLANAR_Y   = ["I420", "I420A", "I422", "I444", "NV12"];

  /* ⚠ layout（copyTo が返す PlaneLayout[]）を必ず使うこと。
     codedWidth × codedHeight でバッファを走査すると、H.264 のマクロブロック
     整列（例: 高さ360 → 368）により Y面を超えて UV面まで読み込み、
     クロマ値（例: 赤のCr=240）が輝度の最大値として混入する。
     実測でこの誤読を確認済み（§2.4.7）。 */
  function sampleRange(bytes, format, width, height, layout) {
    var plane0 = (layout && layout[0]) ? layout[0] : null;
    var offset = plane0 ? (plane0.offset || 0) : 0;

    if (PACKED_RGB[format]) {
      var order = PACKED_RGB[format];             // [R,G,B] のバイト位置
      var stride = plane0 ? plane0.stride : width * 4;
      var min = [255, 255, 255], max = [0, 0, 0], count = 0;
      var yStep = Math.max(1, Math.floor(height / 240));      // 行を間引く
      var xStep = Math.max(1, Math.floor(width / 240));       // 列を間引く
      for (var y = 0; y < height; y += yStep) {
        var rowBase = offset + y * stride;
        var xo = (y / yStep) % xStep;   // 行ごとにずらす（エイリアシング回避）
        for (var x = xo; x < width; x += xStep) {
          var o = rowBase + x * 4;
          if (o + 2 >= bytes.length) break;
          for (var c = 0; c < 3; c++) {
            var v = bytes[o + order[c]];
            if (v < min[c]) min[c] = v;
            if (v > max[c]) max[c] = v;
          }
          count++;
        }
      }
      return { channels: ["R", "G", "B"], min: min, max: max, sampled: count };
    }

    if (PLANAR_Y.indexOf(format) >= 0) {
      // I420 / NV12 いずれも先頭プレーンが輝度(Y)。stride で行を辿る。
      var ystride = plane0 ? plane0.stride : width;
      var yMin = 255, yMax = 0, n = 0;
      var ys = Math.max(1, Math.floor(height / 240));
      var xs = Math.max(1, Math.floor(width / 240));
      for (var yy = 0; yy < height; yy += ys) {
        var base = offset + yy * ystride;
        // 行ごとに開始位置をずらす。等間隔のままだと、画面の縞や市松模様と
        // 走査が同期して極値を取りこぼす（エイリアシング）。
        var xoff = (yy / ys) % xs;
        for (var xx = xoff; xx < width; xx += xs) {
          var idx = base + xx;
          if (idx >= bytes.length) break;
          var yv = bytes[idx];
          if (yv < yMin) yMin = yv;
          if (yv > yMax) yMax = yv;
          n++;
        }
      }
      return { channels: ["Y"], min: [yMin], max: [yMax], sampled: n };
    }
    return null;
  }

  /* 判定に使う伝達方向の厳しさ。数値が大きいほど「止める」方向。
     hdr/unknown = 2（停止）、sdr-assumed = 1（続行だが要警告）、sdr = 0（続行・確証あり） */
  function severity(mode) { return (mode === "hdr" || mode === "unknown") ? 2 : (mode === "sdr-assumed" ? 1 : 0); }

  /* ---------------------------------------------------------------------
     demux
     --------------------------------------------------------------------- */
  function demux(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      if (typeof MP4Box === "undefined") {
        reject(new Error("mp4box.js が読み込まれていません（importScripts を確認）"));
        return;
      }
      var file = MP4Box.createFile();
      var samples = [];
      var settled = false;

      file.onError = function (e) {
        if (settled) return; settled = true;
        reject(new Error("MP4の解析に失敗しました: " + e));
      };

      file.onReady = function (info) {
        var vt = (info.videoTracks || [])[0];
        if (!vt) {
          if (settled) return; settled = true;
          reject(new Error("映像トラックが見つかりません"));
          return;
        }
        file.setExtractionOptions(vt.id, null, { nbSamples: 100000 });
        file.onSamples = function (id, user, s) { samples = samples.concat(s); };
        file.start();
      };

      // mp4box は ArrayBuffer に fileStart プロパティを要求する
      var ab = arrayBuffer.slice(0);
      ab.fileStart = 0;
      file.appendBuffer(ab);
      file.flush();

      if (settled) return;
      settled = true;

      var info = file.getInfo ? file.getInfo() : null;
      var track = info && info.videoTracks && info.videoTracks[0];
      if (!track) { reject(new Error("映像トラックが見つかりません")); return; }

      var entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];

      /* --- decoder description（avcC / hvcC / vpcC / av1C）--- */
      var description = null, descName = null;
      var box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        var ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(ds);
        description = new Uint8Array(ds.buffer, 8); // 先頭8バイトのボックスヘッダを除く
        descName = box.type;
      }

      /* --- edit list（elst）--- §9.2.5
         media_time は「メディア時刻のどこを表示開始点とするか」を示す。
         Bフレームがあると先頭サンプルの CTS が 0 にならず、その分が
         media_time に入る（実測: media_time=1024 が CTS オフセットと一致）。
         これを見ずにタイムラインを作ると、video.currentTime とずれる。 */
      var editList = null;
      try {
        var trak = file.getTrackById(track.id);
        if (trak && trak.edts && trak.edts.elst && trak.edts.elst.entries &&
            trak.edts.elst.entries.length) {
          var e0 = trak.edts.elst.entries[0];
          editList = {
            entries: trak.edts.elst.entries.length,
            mediaTime: e0.media_time,
            segmentDuration: e0.segment_duration,
            rate: e0.media_rate_integer,
            // メディア時刻→表示時刻へのオフセット（µs）。media_time はトラック時間軸。
            offsetUs: (e0.media_time > 0)
              ? Math.round(1e6 * e0.media_time / track.timescale) : 0
          };
        }
      } catch (e) { editList = null; }

      /* --- colr ボックス（デコード前に色空間が分かる）--- */
      var container = { primaries: null, transfer: null, matrix: null, fullRange: null, source: "なし" };
      if (entry.colr && entry.colr.colour_type === "nclx") {
        container.primaries = PRIMARIES[entry.colr.colour_primaries] || null;
        container.transfer  = TRANSFER[entry.colr.transfer_characteristics] || null;
        container.matrix    = MATRIX[entry.colr.matrix_coefficients] || null;
        container.fullRange = !!entry.colr.full_range_flag;
        container.source    = "colr(nclx)";
      }

      /* --- ⚠ サンプルは「デコード順」で渡さなければならない ---
         mp4box が返す順序がデコード順（DTS昇順）であり、これが正しい投入順。
         Bフレームがあると CTS は単調増加しないため、CTS で並べ替えたものを
         デコーダに渡すと、参照先より先にBフレームを投入することになり、
         復号結果が壊れる（実測で確認・§2.2.2）。

         並べ替えが必要なのは「解析時のフレーム順」であって「投入順」ではない。 */
      var decodeOrder = samples;                                   // 投入用（DTS順）
      var presOrder = samples.slice().sort(function (a, b) { return a.cts - b.cts; });

      /* --- フレーム間隔は timescale の目盛りで比較する ---
         µs に換算してから比較すると 16666 / 16667 のような 1µs の丸め差が出て、
         完全なCFRでもVFRと誤判定する。目盛りのままなら誤差ゼロ。 */
      var tsUnit = track.timescale;
      var tickDeltas = [];
      for (var i = 1; i < presOrder.length; i++) tickDeltas.push(presOrder[i].cts - presOrder[i - 1].cts);

      var isCFR = true, medianTick = null;
      if (tickDeltas.length) {
        var sorted = tickDeltas.slice().sort(function (a, b) { return a - b; });
        medianTick = sorted[Math.floor(sorted.length / 2)];
        isCFR = (sorted[sorted.length - 1] === sorted[0]);
      }
      var uniqTicks = Object.keys(tickDeltas.reduce(function (a, v) { a[v] = 1; return a; }, {}))
                            .map(Number).sort(function (a, b) { return a - b; });
      var uniq = uniqTicks.map(function (t) { return Math.round(1e6 * t / tsUnit); });

      var durSec = track.duration / track.timescale;
      var fpsNominal = durSec > 0 ? track.nb_samples / durSec : null;
      var fpsMeasured = medianTick ? tsUnit / medianTick : null;

      resolve({
        file: file,
        track: track,
        samples: decodeOrder,          // ⚠ デコーダへはこの順で渡すこと（DTS順）
        presentationOrder: presOrder,  // 解析時のフレーム順（CTS順）
        description: description,
        descriptionName: descName,
        container: container,
        codec: track.codec,
        width: track.video.width,
        height: track.video.height,
        nbSamples: track.nb_samples,
        durationSec: durSec,
        fpsNominal: fpsNominal,
        fpsMeasured: fpsMeasured,
        bitDepth: bitDepthFromCodec(track.codec),
        frameIntervalsUs: uniq,
        frameIntervalTicks: uniqTicks,
        timescale: tsUnit,
        editList: editList,
        isCFR: isCFR,
        hasBFrames: decodeOrder.some(function (s, i) { return i > 0 && s.cts < decodeOrder[i - 1].cts; }),
        syncCount: samples.filter(function (s) { return s.is_sync; }).length
      });
    });
  }

  /* ---------------------------------------------------------------------
     デコード。フレームは表示順で onFrame に渡される。
     onFrame は VideoFrame を受け取り、処理後に自分で close() すること。
     --------------------------------------------------------------------- */
  function decode(dx, opts) {
    opts = opts || {};
    var maxFrames = opts.maxFrames || Infinity;
    var onFrame   = opts.onFrame || function (f) { f.close(); };
    var onProgress = opts.onProgress || function () {};
    var onInfo    = opts.onInfo || function () {};

    /* ハードウェアデコーダは、小さい解像度・特殊なプロファイル等を拒否することがある
       （実測: 320×192 の素材が Chrome/Edge で "Decoding error"、
        ソフトウェアデコードのブラウザでは成功）。
       そのため hardware → software の順で試す。§2.2.1 */
    function attempt(accel) {
      return new Promise(function (resolve, reject) {
        if (typeof VideoDecoder === "undefined") {
          reject(new Error("このブラウザは WebCodecs に対応していません"));
          return;
        }

        var count = 0, lastTs = -Infinity, outOfOrder = 0, stopped = false;
        var pending = Promise.resolve();

        var decoder = new VideoDecoder({
          output: function (frame) {
            if (stopped) { frame.close(); return; }
            /* デコード順で投入しているため、出力が表示順で返るかはブラウザ依存。
               ここで検出した順序違反は「解析前に timestamp で並べ替えが必要」
               という意味であり、異常ではない（§2.2.2）。 */
            if (frame.timestamp < lastTs) outOfOrder++;
            lastTs = frame.timestamp;
            count++;
            pending = pending.then(function () { return onFrame(frame, { index: count - 1 }); })
                             .catch(function (e) { try { frame.close(); } catch (x) {} throw e; });
            if (count % 10 === 0) onProgress(count, Math.min(dx.nbSamples, maxFrames));
          },
          error: function (e) { stopped = true; reject(e); }
        });

        var config = {
          codec: dx.codec,
          codedWidth: dx.width,
          codedHeight: dx.height,
          hardwareAcceleration: accel
        };
        if (dx.description) config.description = dx.description;

        VideoDecoder.isConfigSupported(config).then(function (support) {
          if (!support.supported) throw new Error("このコーデックは再生できません: " + dx.codec);
          decoder.configure(config);

          var i = 0;
          function pump() {
            if (stopped) return Promise.resolve();
            if (decoder.decodeQueueSize > 24) {
              return new Promise(function (r) { setTimeout(r, 4); }).then(pump);
            }
            if (i >= dx.samples.length || i >= maxFrames) return Promise.resolve();
            var s = dx.samples[i++];
            decoder.decode(new EncodedVideoChunk({
              type: s.is_sync ? "key" : "delta",
              timestamp: Math.round(1e6 * s.cts / s.timescale),
              duration: Math.round(1e6 * s.duration / s.timescale),
              data: s.data
            }));
            return pump();
          }
          return pump();
        }).then(function () {
          return decoder.flush();
        }).then(function () {
          return pending;
        }).then(function () {
          try { decoder.close(); } catch (e) {}
          resolve({ frames: count, outOfOrder: outOfOrder, acceleration: accel });
        }).catch(function (e) {
          stopped = true;
          try { decoder.close(); } catch (x) {}
          reject(e);
        });
      });
    }

    return attempt("no-preference").catch(function (err) {
      // ハードウェアデコーダ由来の失敗とみなし、ソフトウェアで再試行する
      onInfo("ハードウェアデコードに失敗したため、ソフトウェアデコードで再試行します（" +
             String((err && err.message) || err) + "）");
      return attempt("prefer-software").then(function (r) {
        r.fellBackToSoftware = true;
        return r;
      });
    });
  }

  /* ---------------------------------------------------------------------
     画素取得経路の可否を1フレームで調べる。仕様書 §2.4。
       native … copyTo() をそのまま（I420 なら一次経路が使える）
       i420   … copyTo({format:"I420"}) 強制
       rgba   … copyTo({format:"RGBA"}) 強制
     --------------------------------------------------------------------- */
  function probePixelPaths(frame) {
    var out = { format: frame.format, codedWidth: frame.codedWidth, codedHeight: frame.codedHeight, paths: {} };

    function tryPath(name, options) {
      try {
        var size = options ? frame.allocationSize(options) : frame.allocationSize();
        var buf = new Uint8Array(size);
        return (options ? frame.copyTo(buf, options) : frame.copyTo(buf)).then(function (layout) {
          out.paths[name] = {
            ok: true, bytes: size,
            layout: (layout || []).map(function (p) { return { offset: p.offset, stride: p.stride }; })
          };
        }).catch(function (e) {
          out.paths[name] = { ok: false, error: String((e && e.message) || e) };
        });
      } catch (e) {
        out.paths[name] = { ok: false, error: String((e && e.message) || e) };
        return Promise.resolve();
      }
    }

    return tryPath("native", null)
      .then(function () { return tryPath("i420", { format: "I420" }); })
      .then(function () { return tryPath("rgba", { format: "RGBA" }); })
      .then(function () { return out; });
  }

  /* ---------------------------------------------------------------------
     診断（probe）。demux → 色判定 → 必要なら数フレームだけデコード
     --------------------------------------------------------------------- */
  function probe(arrayBuffer, opts) {
    opts = opts || {};
    var sampleFrames = opts.sampleFrames || 60;

    return demux(arrayBuffer).then(function (dx) {
      var report = {
        container: {
          codec: dx.codec, width: dx.width, height: dx.height,
          nbSamples: dx.nbSamples, durationSec: dx.durationSec,
          fpsNominal: dx.fpsNominal, fpsMeasured: dx.fpsMeasured,
          isCFR: dx.isCFR, frameIntervalsUs: dx.frameIntervalsUs,
          hasBFrames: dx.hasBFrames, syncCount: dx.syncCount,
          description: dx.descriptionName ? dx.descriptionName + " (" + dx.description.length + " bytes)" : "なし",
          bitDepth: dx.bitDepth,
          colorSource: dx.container.source,
          colorPrimaries: dx.container.primaries,
          colorTransfer: dx.container.transfer,
          colorMatrix: dx.container.matrix,
          fullRange: dx.container.fullRange
        },
        verdictContainer: null,
        frame: null,
        verdictFrame: null,
        pixelPaths: null,
        pixelRange: null,
        acceleration: null,
        decoded: 0,
        outOfOrder: 0,
        warnings: [],
        notes: []
      };

      // ① コンテナ段階での判定（デコード不要）
      report.verdictContainer = classifyColor({
        transfer: dx.container.transfer,
        bitDepth: dx.bitDepth
      });

      if (report.verdictContainer.mode === "hdr") {
        report.warnings.push("コンテナ情報の時点でHDRと判定したため、デコードを行いませんでした。");
        return report;
      }

      // ② 数フレームデコードして VideoFrame 側の色情報・画素経路・実測レンジを確認
      var first = null;
      var rangePath = null;           // "native" | "rgba" | "i420" | null（採用する経路）
      var rangeMin = null, rangeMax = null, rangeChannels = null, rangeSampledFrames = 0;
      var width = dx.width, height = dx.height;

      function accumulate(frame, buf, format, layout) {
        // 可視領域のサイズを使う（codedWidth/Height はマクロブロック整列で
        // 実データより大きいことがあり、プレーンをまたいで誤読する原因になる）
        var vr = frame.visibleRect || null;
        var w = vr ? vr.width  : (frame.displayWidth  || frame.codedWidth  || width);
        var h = vr ? vr.height : (frame.displayHeight || frame.codedHeight || height);
        var r = sampleRange(buf, format, w, h, layout);
        if (!r) return;
        rangeChannels = r.channels;
        if (!rangeMin) { rangeMin = r.min.slice(); rangeMax = r.max.slice(); }
        else {
          for (var c = 0; c < r.min.length; c++) {
            if (r.min[c] < rangeMin[c]) rangeMin[c] = r.min[c];
            if (r.max[c] > rangeMax[c]) rangeMax[c] = r.max[c];
          }
        }
        rangeSampledFrames++;
      }

      return decode(dx, {
        maxFrames: sampleFrames,
        onInfo: function (msg) { report.notes.push(msg); },
        onFrame: function (frame) {
          var isFirst = !first;
          if (isFirst) {
            first = true;
            var cs = frame.colorSpace || {};
            report.frame = {
              format: frame.format,
              primaries: cs.primaries || null,
              transfer: cs.transfer || null,
              matrix: cs.matrix || null,
              fullRange: (cs.fullRange === undefined ? null : cs.fullRange)
            };
            report.verdictFrame = classifyColor({
              transfer: cs.transfer || null,
              bitDepth: dx.bitDepth
            });
          }

          // フレーム段階の判定が「停止」に転じた場合は、以後の画素取得を行わない。
          // （コンテナ通過後に初めて判明する食い違いへの安全弁。§2.3.1 参照）
          if (report.verdictFrame && report.verdictFrame.mode !== "sdr" && report.verdictFrame.mode !== "sdr-assumed") {
            frame.close();
            return;
          }

          if (isFirst) {
            return probePixelPaths(frame).then(function (p) {
              report.pixelPaths = p;
              // 採用する経路を決める: native が使えて解釈可能な形式ならそれを、
              // ダメなら明示RGBA、それもダメならi420、全滅なら計測しない。
              if (p.paths.native && p.paths.native.ok &&
                  (PACKED_RGB[p.format] || PLANAR_Y.indexOf(p.format) >= 0)) {
                rangePath = "native";
              } else if (p.paths.rgba && p.paths.rgba.ok) {
                rangePath = "rgba";
              } else if (p.paths.i420 && p.paths.i420.ok) {
                rangePath = "i420";
              }
              if (rangePath) {
                var fmt = rangePath === "native" ? p.format : (rangePath === "rgba" ? "RGBA" : "I420");
                var opt = rangePath === "native" ? null : { format: fmt };
                var size = opt ? frame.allocationSize(opt) : frame.allocationSize();
                var buf = new Uint8Array(size);
                return (opt ? frame.copyTo(buf, opt) : frame.copyTo(buf)).then(function (lay) {
                  accumulate(frame, buf, fmt, lay);
                  frame.close();
                }).catch(function () { frame.close(); });
              }
              frame.close();
            });
          }

          // 2フレーム目以降: 採用経路が決まっていれば同じ形式で取得してレンジに加算
          if (rangePath) {
            var fmt2 = rangePath === "native" ? frame.format : (rangePath === "rgba" ? "RGBA" : "I420");
            var opt2 = rangePath === "native" ? null : { format: fmt2 };
            try {
              var size2 = opt2 ? frame.allocationSize(opt2) : frame.allocationSize();
              var buf2 = new Uint8Array(size2);
              (opt2 ? frame.copyTo(buf2, opt2) : frame.copyTo(buf2)).then(function (lay2) {
                accumulate(frame, buf2, fmt2, lay2);
                frame.close();
              }).catch(function () { frame.close(); });
              return;
            } catch (e) { /* fall through to close below */ }
          }
          frame.close();
        }
      }).then(function (r) {
        report.decoded = r.frames;
        report.outOfOrder = r.outOfOrder;
        report.acceleration = r.fellBackToSoftware ? "software (ハードウェア失敗後の再試行)" : "no-preference";
        if (r.fellBackToSoftware) {
          report.warnings.push(
            "この素材はハードウェアデコーダで復号できず、ソフトウェアデコードで処理しました。" +
            "解析結果は有効ですが、長尺では処理時間が延びます。");
        }

        if (rangePath && rangeMin) {
          report.pixelRange = {
            path: rangePath, channels: rangeChannels,
            min: rangeMin, max: rangeMax, sampledFrames: rangeSampledFrames
          };
          // 経験則: リミテッドレンジ(16-235)は中心付近に偏り、フルレンジ(0-255)は両端に届く。
          // ここでは単純に「両端5刻み以内まで届いたか」で判定の目安を出す（確定診断ではない）。
          var reachesLow  = rangeMin.some(function (v) { return v <= 5; });
          var reachesHigh = rangeMax.some(function (v) { return v >= 250; });
          if (reachesLow && reachesHigh) {
            report.notes.push("画素値が 0〜255 付近まで届いています。フルレンジで格納されている可能性が高いです。");
          } else if (Math.min.apply(null, rangeMin) >= 10 && Math.max.apply(null, rangeMax) <= 240) {
            report.notes.push("画素値が概ね16〜235の範囲に収まっています。リミテッドレンジの可能性が高いです。輝度換算時に伸張が必要です。");
          } else {
            report.notes.push("画素値の範囲から判別できませんでした（素材の内容が単純な白黒でない可能性があります）。");
          }
        }

        // コンテナ推定とフレーム実測の食い違い評価。
        // 「厳しい方を採用」ではなく、フレーム実測が常に正（より確実な情報源）とし、
        // 実測により停止判定に転じた場合だけを警告として扱う。
        if (report.verdictFrame && report.verdictContainer) {
          var sevC = severity(report.verdictContainer.mode);
          var sevF = severity(report.verdictFrame.mode);
          if (sevF > sevC) {
            report.warnings.push(
              "コンテナ情報からは解析続行と判断していましたが、実際のフレーム(" +
              (report.verdictFrame.transfer || "不明") + ")では判定できないため停止しました。");
          } else if (sevF < sevC && report.verdictContainer.transfer !== report.verdictFrame.transfer) {
            report.notes.push(
              "コンテナに色情報のタグが無かったため推定していましたが、実際のフレームでは " +
              report.verdictFrame.transfer + "（SDR）と確認できました。");
          }
        }
        if (report.outOfOrder > 0) {
          report.notes.push(
            "デコーダ出力が表示順で返っていません（" + report.outOfOrder + "件）。" +
            "解析側で timestamp による並べ替えが必要です（異常ではありません）。");
        }
        if (dx.fpsMeasured && dx.fpsMeasured < 50) {
          report.warnings.push(
            "ソース " + dx.fpsMeasured.toFixed(2) + "fps — " +
            (dx.fpsMeasured / 2).toFixed(1) + "Hz を超える点滅は原理的に検証できません（Nyquist）。");
        }
        if (!dx.isCFR) {
          report.warnings.push("可変フレームレート（VFR）の可能性があります。1秒窓の計数に注意が必要です。");
        }
        // 無タグ素材のマトリクス曖昧性（実測により判明・§2.4.5）
        // コンテナに matrix タグが無い場合、エンコーダとデコーダで
        // BT.601 / BT.709 の取り違えが起こりうる。パックドRGB経路では
        // 変換済みの値しか得られないため、事後の補正は不可能。
        if (!dx.container.matrix && report.frame && PACKED_RGB[report.frame.format]) {
          report.warnings.push(
            "コンテナに色変換マトリクスのタグがありません。エンコード時(BT.601等)と" +
            "ブラウザの復号時(" + (report.frame.matrix || "不明") + ")で係数が食い違う可能性があり、" +
            "その場合の輝度誤差は実測で約1〜3%です（閾値0.10に対して約3.5%）。");
        }
        return report;
      });
    });
  }

  scope.FSDecode = {
    demux: demux,
    decode: decode,
    probe: probe,
    classifyColor: classifyColor,
    bitDepthFromCodec: bitDepthFromCodec,
    probePixelPaths: probePixelPaths,
    sampleRange: sampleRange,
    severity: severity,
    TRANSFER: TRANSFER
  };

})(typeof self !== "undefined" ? self : this);
