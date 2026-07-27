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

      /* --- colr ボックス（デコード前に色空間が分かる）--- */
      var container = { primaries: null, transfer: null, matrix: null, fullRange: null, source: "なし" };
      if (entry.colr && entry.colr.colour_type === "nclx") {
        container.primaries = PRIMARIES[entry.colr.colour_primaries] || null;
        container.transfer  = TRANSFER[entry.colr.transfer_characteristics] || null;
        container.matrix    = MATRIX[entry.colr.matrix_coefficients] || null;
        container.fullRange = !!entry.colr.full_range_flag;
        container.source    = "colr(nclx)";
      }

      /* --- 表示順（CTS昇順）に並べ替える ---
         mp4box はデコード順で返す。Bフレームがあると CTS は単調増加しない。 */
      var ordered = samples.slice().sort(function (a, b) { return a.cts - b.cts; });

      /* --- フレーム間隔は timescale の目盛りで比較する ---
         µs に換算してから比較すると 16666 / 16667 のような 1µs の丸め差が出て、
         完全なCFRでもVFRと誤判定する。目盛りのままなら誤差ゼロ。 */
      var tsUnit = track.timescale;
      var tickDeltas = [];
      for (var i = 1; i < ordered.length; i++) tickDeltas.push(ordered[i].cts - ordered[i - 1].cts);

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
        samples: ordered,
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
        isCFR: isCFR,
        hasBFrames: samples.some(function (s, i) { return i > 0 && s.cts < samples[i - 1].cts; }),
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
          if (frame.timestamp < lastTs) outOfOrder++;
          lastTs = frame.timestamp;
          count++;
          // onFrame が非同期でも順序を保つ
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
        hardwareAcceleration: "no-preference"
      };
      if (dx.description) config.description = dx.description;

      VideoDecoder.isConfigSupported(config).then(function (support) {
        if (!support.supported) throw new Error("このコーデックは再生できません: " + dx.codec);
        decoder.configure(config);

        var i = 0;
        function pump() {
          if (stopped) return Promise.resolve();
          // バックプレッシャ制御
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
        resolve({ frames: count, outOfOrder: outOfOrder });
      }).catch(function (e) {
        stopped = true;
        try { decoder.close(); } catch (x) {}
        reject(e);
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
        decoded: 0,
        outOfOrder: 0,
        warnings: []
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

      // ② 1フレームだけデコードして VideoFrame 側の色情報と画素経路を確認
      var first = null;
      return decode(dx, {
        maxFrames: sampleFrames,
        onFrame: function (frame) {
          if (!first) {
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
            return probePixelPaths(frame).then(function (p) {
              report.pixelPaths = p;
              frame.close();
            });
          }
          frame.close();
        }
      }).then(function (r) {
        report.decoded = r.frames;
        report.outOfOrder = r.outOfOrder;

        if (report.verdictFrame && report.verdictContainer &&
            report.verdictFrame.transfer !== report.verdictContainer.transfer) {
          report.warnings.push(
            "コンテナ(" + (report.verdictContainer.transfer || "なし") +
            ")とデコード結果(" + (report.verdictFrame.transfer || "なし") +
            ")で伝達関数が食い違います。厳しい側を採用してください。");
        }
        if (report.outOfOrder > 0) {
          report.warnings.push("デコーダ出力が表示順になっていません（" + report.outOfOrder + "件）。並べ替えが必要です。");
        }
        if (dx.fpsMeasured && dx.fpsMeasured < 50) {
          report.warnings.push(
            "ソース " + dx.fpsMeasured.toFixed(2) + "fps — " +
            (dx.fpsMeasured / 2).toFixed(1) + "Hz を超える点滅は原理的に検証できません（Nyquist）。");
        }
        if (!dx.isCFR) {
          report.warnings.push("可変フレームレート（VFR）の可能性があります。1秒窓の計数に注意が必要です。");
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
    TRANSFER: TRANSFER
  };

})(typeof self !== "undefined" ? self : this);
