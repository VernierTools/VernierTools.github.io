"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/analyze.worker.js
   decode.js と analyzer.js を繋ぎ、全フレームを流して基準別の判定を出す。

   ⚠ 設計上の必須事項（実測で確定。仕様書 §2.2.2）:
     - サンプルはデコード順で投入する
     - デコーダ出力が表示順とは限らないため、
       フレームごとの解析結果に timestamp を添えて記録し、
       時系列解析の前に timestamp で並べ替える
     - フレーム自体は保持しない（メモリを圧迫するため）。
       保持するのは1フレームあたり数十バイトの数値のみ。
   ========================================================================= */
importScripts("vendor/mp4box.all.min.js", "decode.js", "analyzer.js", "fft.js");

var A = self.FSAnalyze;

/* ---------------------------------------------------------------------
   基準ごとに EOTF が異なるため、同じフレームから複数の輝度マップを作る。
   これが「並列判定」の実体（§3.1）。
   --------------------------------------------------------------------- */
var EOTF_GROUPS = ["bt1886", "srgb"];

function stdEotf(id) { return A.STANDARDS[id].eotf; }

/* 解析解像度を決める（§2.5）。面積比が保存されればよいので小さくてよい。 */
function analysisSize(w, h, longSide) {
  var scale = longSide / Math.max(w, h);
  if (scale > 1) scale = 1;
  return {
    w: Math.max(8, Math.round(w * scale)),
    h: Math.max(8, Math.round(h * scale))
  };
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.cmd !== "analyze") return;

  var opts = msg.options || {};
  var marginPct = opts.marginPct == null ? 10 : opts.marginPct;
  var t0 = now();

  run(msg.buffer, opts, marginPct).then(function (result) {
    result.elapsedMs = Math.round(now() - t0);
    self.postMessage({ ok: true, result: result });
  }).catch(function (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  });
};

function now() { return (self.performance && performance.now) ? performance.now() : Date.now(); }

function run(buffer, opts, marginPct) {
  return FSDecode.demux(buffer).then(function (dx) {

    /* ---- ① 色空間の判定。HDR / 判定不能なら解析しない（§2.3） ---- */
    var verdict = FSDecode.classifyColor({
      transfer: dx.container.transfer,
      bitDepth: dx.bitDepth
    });
    if (verdict.mode === "hdr" || verdict.mode === "unknown") {
      return {
        aborted: true,
        reason: verdict.reason,
        mode: verdict.mode,
        container: containerInfo(dx)
      };
    }

    /* ---- ② 解析パラメータの確定 ---- */
    /* ⚠ 解析解像度は用途で分ける（§2.5）。
       輝度・面積は縮小しても面積比が保存されるので 480px で足りるが、
       空間パターンは縮小すると縞そのものが消えるため、より高い解像度が要る。 */
    var size = analysisSize(dx.width, dx.height, opts.longSide || 480);
    var n = size.w * size.h;
    /* パターン検出は長辺720pに抑える。1280pは1フレーム約105msかかり、
       0.15秒間隔でも全体の主要因になっていた。720pなら縞の対の本数
       （ガイドラインが問題にするのは5〜12対）の計数には十分。 */
    var patSize = analysisSize(dx.width, dx.height, opts.patternLongSide || 720);
    var fps = dx.fpsMeasured || 30;
    var histLen = Math.max(2, Math.ceil(66 * fps / 1000) + 1);

    // 基準ごとの実効パラメータ（マージン適用後）
    var stdIds = Object.keys(A.STANDARDS);
    var effective = {};
    stdIds.forEach(function (id) {
      effective[id] = A.applyMargin(A.STANDARDS[id], marginPct);
    });
    // 公式値（マージンなし）— 「抵触」の判定はこちらで行う（§7.1）
    var official = {};
    stdIds.forEach(function (id) { official[id] = A.applyMargin(A.STANDARDS[id], 0); });

    /* 遷移検出器は EOTF ごと × (公式/マージン) ごとに持つ。
       CTD が同じでも EOTF が違えば輝度マップが違うため共有できない。

       ⚠ さらに 2024年提案だけは、暗部が 0.80 以上の領域でも
          Michelson コントラスト 1/17 で判定する（§3.3）。
          この分岐を持つ基準と持たない基準は検出器を共有できないため、
          "mich" グループを別に用意する。
          明るいシーンで 2024提案だけ抵触することがあるが、これは仕様どおり。 */
    var detectors = {};
    EOTF_GROUPS.forEach(function (eo) {
      detectors[eo] = {
        official: new A.TransitionDetector(n, {
          ctd: 0.10, darkMax: 0.80, eligibleMs: 66, histLen: histLen
        }),
        margin: new A.TransitionDetector(n, {
          ctd: 0.10 * (1 - marginPct / 100), darkMax: 0.80, eligibleMs: 66, histLen: histLen
        })
      };
    });
    /* 画素ごとの1秒窓カウンタ（検出器と同じ組み合わせで持つ）。
       規格の「同じものが3回超点滅」を正しく数えるために必要（§4.4）。 */
    var pixCounters = {};

    /* 民放連 1(3) 用: 輝度変化20%（=40cd/m²）以上の「強い」遷移だけを数える検出器。
       弱い点滅（10〜20%）は2秒以内なら5回/秒まで許容されるため、
       強弱を分けないと条件付き許容を判定できない。 */
    detectors["jbaStrong"] = {
      official: new A.TransitionDetector(n, {
        ctd: 0.20, darkMax: 0.80, eligibleMs: 66, histLen: histLen
      }),
      margin: new A.TransitionDetector(n, {
        ctd: 0.20 * (1 - marginPct / 100), darkMax: 0.80, eligibleMs: 66, histLen: histLen
      })
    };

    /* 民放連 2. 急激な場面転換の検出用（画面全体の平均輝度が20%超変化） */
    var prevMeanY = null;
    var sceneCuts = [];

    /* Michelson 分岐を持つグループ（2024年提案が使う） */
    var MICH = 1 / 17;
    detectors["mich"] = {
      official: new A.TransitionDetector(n, {
        ctd: 0.10, darkMax: 0.80, michelson: MICH, eligibleMs: 66, histLen: histLen
      }),
      margin: new A.TransitionDetector(n, {
        ctd: 0.10 * (1 - marginPct / 100), darkMax: 0.80,
        michelson: MICH * (1 - marginPct / 100), eligibleMs: 66, histLen: histLen
      })
    };

    Object.keys(detectors).forEach(function (grp) {
      pixCounters[grp] = {
        official: new PixelFlashCounter(n, 1000000),
        margin: new PixelFlashCounter(n, 1000000)
      };
    });
    var redPixCounter = new PixelFlashCounter(n, 1000000);


    /* 赤閃光用。⚠ 赤成分比の「変化量」ではなく、飽和赤（≥0.8）状態への／からの
       遷移で判定する（§3.4）。変化量方式では白黒点滅が赤閃光に化ける。 */
    var redDet = new A.RedFlashDetector(n, { satThresh: 0.8, ucsThresh: 0.2 });

    /* 空間パターン（縞）— 参考枠。§5
       全フレームではなく 0.15秒間隔でサンプリングする（継続0.5秒の判定に足りる）。 */
    var patternOn = opts.pattern !== false && typeof FSFft !== "undefined";
    var patTracker = patternOn ? new FSFft.PhaseTracker() : null;
    var patSamples = [];
    var lastPatUs = -1e9;

    var records = [];       // フレームごとの解析結果（timestamp 付き・小さい数値のみ）
    var frameCount = 0;
    var lastReported = 0;

    /* ---- ③ 全フレームを流す ---- */
    return FSDecode.decode(dx, {
      onInfo: function (m) { notes.push(m); },
      onProgress: function (c, total) {
        if (c - lastReported >= 30) {
          lastReported = c;
          self.postMessage({ ok: true, progress: { done: c, total: total } });
        }
      },
      onFrame: function (frame) {
        var fmt = frame.format;
        var packed = A.PACKED_RGB[fmt], planar = A.PLANAR[fmt];
        if (!packed && !planar) { frame.close(); return; }

        var allocSize = frame.allocationSize();
        var buf = new Uint8Array(allocSize);
        return frame.copyTo(buf).then(function (layout) {
          var vr = frame.visibleRect;
          var meta = {
            width: vr ? vr.width : frame.codedWidth,
            height: vr ? vr.height : frame.codedHeight,
            format: fmt,
            matrix: (frame.colorSpace && frame.colorSpace.matrix) || "bt709",
            fullRange: !!(frame.colorSpace && frame.colorSpace.fullRange),
            layout: layout
          };
          var tUs = frame.timestamp;

          var rec = { t: tUs, up: {}, down: {}, red: 0, redUp: 0, maxDelta: 0 };

          /* ⚠ EOTF をまとめて処理する toLinearPlanesMulti は採用しない。
             1回の走査で済むように見えるが、内側ループで配列の配列を
             間接参照するため JIT の最適化が効かず、実測で
             単体2回=16ms に対し Multi=75ms と逆に遅くなった。
             単純なループを2回まわす方が速い。 */
          /* ⚠ かつてここで全体の平行移動（スクロール）を推定し、
             「動いただけ」の画素を閃光から除外する実装を試みたが、**撤回した**。
             理由は §4.5 に記録。周期的なパターン（テキスト行など）では
             移動量が一意に定まらず（dy=1 と dy=19 が同じ残差になる）、
             誤った補償で**本物の点滅を消す危険**があったため。 */
          EOTF_GROUPS.forEach(function (eo) {
            var pl = A.toLinearPlanes(buf, meta, { dstW: size.w, dstH: size.h, eotf: eo });
            if (!pl) return;

            ["official", "margin"].forEach(function (kind) {
              var det = detectors[eo][kind];
              det.step(pl.lum, tUs);
              var up = countMask(det.maskUp), dn = countMask(det.maskDown);
              rec.up[eo + ":" + kind] = up;
              rec.down[eo + ":" + kind] = dn;

              /* WCAG の微細パターン例外を適用したマスクも作る。
                 ⚠ この例外は WCAG の条文にあるもので、放送系（ITU-R/Ofcom/民放連）
                    には該当条項がない。したがって sRGB グループ（WCAG が使う）
                    にのみ適用し、基準ごとに異なる結果になるのが正しい。 */
              var mu = det.maskUp, md2 = det.maskDown;
              if (eo === "srgb") {
                var fine = excludeFinePattern(det.maskUp, det.maskDown, size.w, size.h);
                mu = fine.up; md2 = fine.down;
                rec["fine:" + kind] = fine.excluded;
                rec.up[eo + ":" + kind] = { n: fine.keptUp };
                rec.down[eo + ":" + kind] = { n: fine.keptDown };
                if (fine.keptUp || fine.keptDown) {
                  rec["area:" + eo + ":" + kind] = areaInfo(mu, md2, size);
                } else {
                  delete rec["area:" + eo + ":" + kind];
                }
              }

              /* 画素ごとの1秒窓カウント（規格の「同じものが3回超」用） */
              rec["pix:" + eo + ":" + kind] =
                pixCounters[eo][kind].push(mu, md2, tUs);
              /* 面積は official / margin それぞれのマスクから別々に求める。
                 margin の方が遷移が多く検出されるため、official のマスクを
                 流用すると面積を過小評価し、マージン判定が甘くなる。 */
              if (up.n || dn.n) {
                rec["area:" + eo + ":" + kind] = areaInfo(det.maskUp, det.maskDown, size);
              }
            });

            /* 民放連 1(3) 用の強い遷移（bt1886 のみ） */
            if (eo === "bt1886") {
              ["official", "margin"].forEach(function (kind) {
                var sd = detectors["jbaStrong"][kind];
                sd.step(pl.lum, tUs);
                var su = countMask(sd.maskUp), sdn = countMask(sd.maskDown);
                rec.up["jbaStrong:" + kind] = su;
                rec.down["jbaStrong:" + kind] = sdn;
                if (su.n || sdn.n) {
                  rec["area:jbaStrong:" + kind] = areaInfo(sd.maskUp, sd.maskDown, size);
                }
              });

              /* 民放連 2. 急激な場面転換: 画面全体の平均輝度が20%超変化したフレーム */
              var sum = 0;
              for (var mi = 0; mi < pl.lum.length; mi++) sum += pl.lum[mi];
              var meanY = sum / pl.lum.length;
              if (prevMeanY !== null) {
                var dY = meanY - prevMeanY;
                if (dY < 0) dY = -dY;
                if (dY > 0.20) sceneCuts.push(tUs);
              }
              prevMeanY = meanY;
              rec.sceneCut = sceneCuts.length ? sceneCuts[sceneCuts.length - 1] === tUs : false;
            }

            /* 2024年提案用（Michelson 分岐あり）。EOTF は bt1886 を使う。 */
            if (eo === "bt1886") {
              ["official", "margin"].forEach(function (kind) {
                var md = detectors["mich"][kind];
                md.step(pl.lum, tUs);
                var mup = countMask(md.maskUp), mdn = countMask(md.maskDown);
                rec.up["mich:" + kind] = mup;
                rec.down["mich:" + kind] = mdn;
                rec["pix:mich:" + kind] =
                  pixCounters["mich"][kind].push(md.maskUp, md.maskDown, tUs);
                if (mup.n || mdn.n) {
                  rec["area:mich:" + kind] = areaInfo(md.maskUp, md.maskDown, size);
                }
              });
            }

            // 空間パターン（bt1886 のときだけ・0.15秒間隔）
            // ⚠ パターン専用の高解像度バッファを別に作る。輝度用(480px)を
            //    流用すると細かい縞が縮小段階で潰れる。
            if (eo === "bt1886" && patternOn && (tUs - lastPatUs) >= 150000) {
              lastPatUs = tUs;
              try {
                var plPat = (patSize.w === size.w && patSize.h === size.h)
                  ? pl
                  : A.toLinearPlanes(buf, meta, { dstW: patSize.w, dstH: patSize.h, eotf: "bt1886" });
                var pr = FSFft.detectGlobal(plPat.lum, patSize.w, patSize.h, {});
                if (pr) {
                  patTracker.push(pr.phase, tUs);
                  patSamples.push({ t: tUs, pairs: pr.pairs, theta: pr.theta,
                                    brightest: pr.brightest, contrast: pr.contrast });
                } else {
                  patSamples.push({ t: tUs, pairs: 0 });
                }
              } catch (e) { /* パターン検出の失敗で解析全体を止めない */ }
            }

            // 赤閃光（bt1886 のときだけ計算すれば足りる）
            if (eo === "bt1886") {
              redDet.step(pl.R, pl.G, pl.B, tUs);
              var redN = countMask(redDet.mask).n;
              rec.red = redN;
              rec.redPix = redPixCounter.push(redDet.mask, redDet.mask, tUs);
              /* 赤閃光にも面積判定をかける。輝度閃光と同じ扱いにしないと、
                 わずか数画素の色変化で全基準が抵触になる。 */
              if (redN) rec["area:red"] = areaInfo(redDet.mask, redDet.mask, size);
            }
          });

          records.push(rec);
          frameCount++;
          frame.close();
        }).catch(function () { frame.close(); });
      }
    }).then(function (dec) {

      /* ---- ④ timestamp で並べ替える（§2.2.2） ---- */
      records.sort(function (a, b) { return a.t - b.t; });

      /* ---- ④-2 先頭を 0 に正規化する ----
         Bフレームがあると先頭サンプルの CTS が 0 にならない
         （実測: timescale 15360 で cts=1024 → 66.7ms のオフセット）。
         そのままだとタイムラインが 0:00.07 から始まり、
         video.currentTime（0 始まり）と最大1フレーム以上ずれる。
         プレビューと突き合わせるため、先頭を 0 に揃える。 */
      var tOrigin = records.length ? records[0].t : 0;
      var el = dx.editList;
      /* edit list（elst）があれば、それが正規化の正しい根拠になる。
         media_time は「メディア時刻のどこを表示開始点とするか」であり、
         実測では先頭サンプルのCTSと完全に一致した（§9.2.5）。
         elst が無い場合や値が食い違う場合は、実測した先頭CTSを使う。 */
      if (el && el.offsetUs > 0) {
        if (Math.abs(el.offsetUs - tOrigin) > 1000) {
          notes.push("edit list の media_time（" + (el.offsetUs / 1000).toFixed(1) +
                     "ms）と先頭フレームの表示時刻（" + (tOrigin / 1000).toFixed(1) +
                     "ms）が一致しません。実測値を優先しました。");
        } else {
          notes.push("edit list（media_time=" + el.mediaTime + "）に基づき、" +
                     "タイムラインを0秒起点に正規化しました。");
        }
      } else if (tOrigin !== 0) {
        notes.push("先頭フレームの表示時刻が " + (tOrigin / 1000).toFixed(1) +
                   "ms だったため、タイムラインを0秒起点に正規化しました（edit list なし）。");
      }
      if (tOrigin !== 0) {
        for (var ri = 0; ri < records.length; ri++) records[ri].t -= tOrigin;
      }
      /* rate が 1 以外の edit list（早送り/スロー）は未対応。黙って誤判定しない。 */
      if (el && el.rate && el.rate !== 1) {
        notes.push("edit list の再生レートが " + el.rate +
                   " です。本ツールは等速のみを想定しているため、時刻がずれる可能性があります。");
      }
      if (el && el.entries > 1) {
        notes.push("edit list が " + el.entries +
                   " 個あります（分割編集）。2個目以降は考慮していません。");
      }

      /* ---- ⑤ 基準ごとに 1秒窓で計数して判定 ---- */
      var verdicts = {};
      stdIds.forEach(function (id) {
        verdicts[id] = evaluate(id, records, size, n, marginPct);
      });
      /* 空間パターン（参考枠）を評価してレーンに加える */
      if (patternOn && patSamples.length) {
        var motion = patTracker.classify();
        var pv = evaluatePattern(patSamples, motion, marginPct);
        verdicts.pattern = {
          id: "pattern",
          label: { ja: "空間パターン", en: "Spatial pattern (stripes)" },
          reference: true,
          level: pv.level,
          firstHitUs: pv.spans.length ? pv.spans[0].t0 : null,
          spans: pv.spans,
          maxTransitions: 0,
          motion: pv.motion,
          maxPairs: pv.maxPairs,
          pairLimit: pv.limit,
          seriesT: [], seriesC: []
        };
      }

      var timeline = buildTimeline(records, verdicts);
      // 生系列は timeline に間引いて入れたので、verdicts 側からは外す
      stdIds.forEach(function (id) { delete verdicts[id].seriesT; delete verdicts[id].seriesC; });

      return {
        aborted: false,
        container: containerInfo(dx),
        analysis: {
          timeOriginUs: tOrigin,
          editList: dx.editList || null,
          width: size.w, height: size.h,
          patternWidth: patSize.w, patternHeight: patSize.h,
          frames: frameCount,
          fps: fps,
          marginPct: marginPct,
          acceleration: dec.fellBackToSoftware ? "software" : "no-preference"
        },
        verdicts: verdicts,
        timeline: timeline,
        notes: notes,
        warnings: buildWarnings(dx, dec, verdict)
      };
    });
  });
}

var notes = [];

function countMask(mask) {
  var n = 0;
  for (var i = 0; i < mask.length; i++) if (mask[i]) n++;
  return { n: n };
}

/* 遷移マスクから、グローバル面積比とローカル窓の最大比を求める */
/* ---------------------------------------------------------------------
   画素ごとの「1秒窓内の遷移回数」を追う。

   ⚠ 「画面のどこかで1画素でも遷移したフレーム」を1回と数えてはならない。
     規格が求めるのは「同じものが1秒に3回を超えて点滅すること」であり、
     場所を問わず遷移を合算するのは別物。

     実測: 20px周期の横線が毎フレーム1pxずつスクロールするだけの映像
     （点滅ではない）で、旧方式は速度に関わらず一律60回/秒（＝全フレーム）
     を返し、判定として機能していなかった。画素ごとに数えれば
     1px/f=6回、3px/f=18回、8px/f=48回と速度差が正しく出る。

   実装: 1秒ぶんのマスクをリングバッファに保持し、加算・減算で
   画素ごとのカウントを維持する。毎フレーム全履歴を舐めない。
   --------------------------------------------------------------------- */
function PixelFlashCounter(n, windowUs) {
  this.n = n;
  this.windowUs = windowUs || 1000000;
  this.count = new Uint16Array(n);   // 各画素の窓内遷移回数
  this.frames = [];                  // {t, mask}
  this.pool = [];
  this.max = 0;
}
PixelFlashCounter.prototype.push = function (maskUp, maskDown, tUs) {
  var n = this.n, c = this.count;
  var m = this.pool.pop() || new Uint8Array(n);
  var any = 0;
  for (var i = 0; i < n; i++) {
    var v = (maskUp[i] || maskDown[i]) ? 1 : 0;
    m[i] = v;
    if (v) { c[i]++; any++; }
  }
  this.frames.push({ t: tUs, mask: m });

  // 窓外のフレームを引く
  var lo = tUs - this.windowUs;
  while (this.frames.length && this.frames[0].t <= lo) {
    var old = this.frames.shift();
    var om = old.mask;
    for (var j = 0; j < n; j++) if (om[j]) c[j]--;
    this.pool.push(om);
  }

  // 窓内の最大値（＝最も激しく点滅している画素の回数）
  var mx = 0;
  if (any || this.frames.length) {
    for (var k = 0; k < n; k++) if (c[k] > mx) mx = c[k];
  }
  this.max = mx;
  return mx;
};

/* ---------------------------------------------------------------------
   微細パターン例外（WCAG）

   規格の例外条項:
     「白色ノイズや、一辺0.1度未満の細かくバランスの取れたパターン
       （交互の市松模様など）の明滅は、閾値に違反しない」

   0.1度は WCAG の基準（1024×768 で10度＝341px）から 3.41px。
   解析解像度480pxでは約1.6px に相当し、実質「隣接画素で反転する空間周波数」。

   ⚠ この例外を実装しないと、細かい模様やノイズ、スクロールする細字などが
     すべて点滅として計上される。仕様書には記載していたが未実装だった。

   判定: 遷移した画素のうち、上下左右の隣に「逆方向に遷移した画素」がある
         ものを微細パターンとみなして除外する。
         バランスが取れている（明暗が同数）ことも規格の要件なので、
         上昇と下降の画素数が拮抗していることを併せて確認する。
   --------------------------------------------------------------------- */
function excludeFinePattern(maskUp, maskDown, w, h) {
  var n = w * h;
  var outUp = new Uint8Array(n), outDown = new Uint8Array(n);
  var keptUp = 0, keptDown = 0, excluded = 0;

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = y * w + x;
      var isUp = maskUp[i], isDn = maskDown[i];
      if (!isUp && !isDn) continue;

      /* 縦横それぞれで、1画素隣が逆方向に遷移しているかを見る。
         ⚠ 4近傍をまとめて数えると横縞（横方向の隣は同方向）で判定が甘くなる。
            実測で1px横縞の除外率が3%しかなかった。
            どちらか一方の軸で1画素周期の反転があれば微細パターンとみなす。 */
      /* ⚠ 「片側だけ逆方向」では除外しない。
         それは太い模様の境界画素であり、除外すると本物の点滅を
         削ってしまう（偽陰性）。実測で 2px市松・4px横縞の境界が
         削られ、除外率が100%・44%になった。

         微細パターンの条件は「1画素周期で反転が続く」こと。
         したがって、ある軸で**両隣とも逆方向**のときだけ除外する。 */
      var axisFine = false;
      for (var ax = 0; ax < 2 && !axisFine; ax++) {
        var oppCount = 0, valid = 0;
        for (var side = -1; side <= 1; side += 2) {
          var nx = x + (ax === 0 ? side : 0);
          var ny = y + (ax === 1 ? side : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          valid++;
          var j = ny * w + nx;
          if (isUp ? maskDown[j] : maskUp[j]) oppCount++;
        }
        if (valid === 2 && oppCount === 2) axisFine = true;
      }
      if (axisFine) { excluded++; continue; }

      if (isUp) { outUp[i] = 1; keptUp++; }
      else { outDown[i] = 1; keptDown++; }
    }
  }
  return { up: outUp, down: outDown, keptUp: keptUp, keptDown: keptDown, excluded: excluded };
}

function areaInfo(maskUp, maskDown, size) {
  var w = size.w, h = size.h, total = w * h;
  var upN = 0, dnN = 0;
  for (var i = 0; i < total; i++) { if (maskUp[i]) upN++; if (maskDown[i]) dnN++; }
  var domMask = upN >= dnN ? maskUp : maskDown;
  var domN = Math.max(upN, dnN);

  /* 遷移画素がゼロなら、積分画像も窓走査も不要。
     大半のフレームはここで抜けるため、全体のコストが大きく下がる。 */
  if (domN === 0) return { global: 0, local: 0, local2024: 0 };

  /* ローカル窓の判定は「窓面積の25%超」を探すもの。
     画面全体の遷移画素数が最小の窓面積の25%にも満たないなら、
     どの窓位置でも条件を満たしようがないので走査を省ける。 */
  var minWin = Math.min(
    Math.max(1, Math.round(w / 3)) * Math.max(1, Math.round(h / 3)),
    Math.max(1, Math.round(w * 416 / 1920)) * Math.max(1, Math.round(h * 416 / 1080))
  );
  if (domN < minWin * 0.25) {
    return { global: domN / total, local: 0, local2024: 0 };
  }

  var ii = new A.IntegralImage(domMask, w, h);
  // WCAG: 画面1/3四方の窓
  var wcagWin = { w: Math.max(1, Math.round(w / 3)), h: Math.max(1, Math.round(h / 3)) };
  var localBest = bestWindowRatio(ii, wcagWin.w, wcagWin.h);
  // 2024提案: 416/1920 × 416/1080
  var pw = Math.max(1, Math.round(w * 416 / 1920)), ph = Math.max(1, Math.round(h * 416 / 1080));
  var localBest2024 = bestWindowRatio(ii, pw, ph);

  return {
    global: domN / total,
    local: localBest,
    local2024: localBest2024
  };
}
function bestWindowRatio(ii, winW, winH) {
  if (winW > ii.w) winW = ii.w;
  if (winH > ii.h) winH = ii.h;
  var area = winW * winH, best = 0, step = 2;
  for (var y = 0; y + winH <= ii.h; y += step) {
    for (var x = 0; x + winW <= ii.w; x += step) {
      var s = ii.rectSum(x, y, x + winW, y + winH) / area;
      if (s > best) best = s;
    }
  }
  return best;
}

/* ---------------------------------------------------------------------
   基準1つぶんの判定。1秒スライディングウィンドウで遷移を数える。
   --------------------------------------------------------------------- */
function evaluate(id, records, size, n, marginPct) {
  var std = A.STANDARDS[id];
  /* 2024年提案は Michelson 分岐を持つ専用グループを参照する（§3.3）。
     他の基準は EOTF 名がそのままグループ名になる。 */
  var eo = (id === "proposal2024") ? "mich" : std.eotf;
  var isRedRelevant = (id === "wcagA" || id === "wcagAAA" || id === "itu" ||
                       id === "ofcom" || id === "jba" || id === "proposal2024");

  var out = {
    id: id, label: std.label, reference: !!std.reference,
    level: 0,                 // 0=検出なし 1=要注意 2=抵触
    firstHitUs: null,
    spans: [],                // [{t0,t1,level}]
    maxTransitions: 0,
    hits: [],
    seriesT: [],              // 各フレームの時刻(µs)
    seriesC: []               // その時刻の1秒窓内の遷移数
  };

  var winOfficial = [], winMargin = [], winRed = [];
  var winStrong = [], winCuts = [];              // 民放連 1(3) / 2 用
  var weakRunStart = null, weakRunLast = 0;
  var curSpan = null;

  for (var i = 0; i < records.length; i++) {
    var r = records[i], t = r.t;

    var offUp = (r.up[eo + ":official"] || { n: 0 }).n;
    var offDn = (r.down[eo + ":official"] || { n: 0 }).n;
    var mgUp  = (r.up[eo + ":margin"] || { n: 0 }).n;
    var mgDn  = (r.down[eo + ":margin"] || { n: 0 }).n;
    var areaOff = r["area:" + eo + ":official"] || null;
    var areaMg  = r["area:" + eo + ":margin"] || null;

    // 面積条件を満たすときだけ遷移として計上する
    var passOfficial = areaPasses(std, areaOff, size, false);
    var passMargin   = areaPasses(std, areaMg, size, true, marginPct);

    if ((offUp > 0 || offDn > 0) && passOfficial) winOfficial.push(t);
    if ((mgUp > 0 || mgDn > 0) && passMargin) winMargin.push(t);
    if (r.red > 0 && isRedRelevant && areaPasses(std, r["area:red"], size, false)) winRed.push(t);

    // 1秒窓の外を捨てる
    var lo = t - 1000000;
    while (winOfficial.length && winOfficial[0] <= lo) winOfficial.shift();
    while (winMargin.length && winMargin[0] <= lo) winMargin.shift();
    while (winRed.length && winRed[0] <= lo) winRed.shift();

    /* ---- 面積規定を持たない基準（WCAG 2.3.2）の計数 ----
       ⚠ 面積条件が無いからといって「どこかで1画素でも遷移したフレーム」を
         数えてはならない。規格が禁じるのは「同じものが1秒に3回超点滅」すること。
         場所を問わず合算すると、スクロールするだけの画面が
         毎フレーム計上され、常に抵触になる（実測で確認）。
         面積規定を持つ基準は、面積条件そのものが「まとまった領域が同時に
         遷移すること」を要求するため、フレーム単位の計数で問題ない。 */
    var pixOff = r["pix:" + eo + ":official"] || 0;
    var pixMg  = r["pix:" + eo + ":margin"] || 0;
    if (std.area.mode === "none") {
      winOfficial.length = 0;
      winMargin.length = 0;
      for (var po = 0; po < pixOff; po++) winOfficial.push(t);
      for (var pm = 0; pm < pixMg; pm++) winMargin.push(t);
      if (isRedRelevant) {
        winRed.length = 0;
        for (var pr = 0; pr < (r.redPix || 0); pr++) winRed.push(t);
      }
    }

    var cOff = winOfficial.length, cMg = winMargin.length, cRed = winRed.length;

    /* ---- 民放連 1(3) の条件付き許容 ----
       輝度変化が10〜20%の弱い点滅は、2秒以内かつ5回/秒までなら許容される。
       強い点滅（20%超）は原則どおり3回/秒まで。 */
    if (id === "jba" && std.conditional) {
      var cond = std.conditional;
      var strongUp = (r.up["jbaStrong:official"] || { n: 0 }).n;
      var strongDn = (r.down["jbaStrong:official"] || { n: 0 }).n;
      var strongArea = r["area:jbaStrong:official"];
      if ((strongUp > 0 || strongDn > 0) && areaPasses(std, strongArea, size, false)) {
        winStrong.push(t);
      }
      while (winStrong.length && winStrong[0] <= lo) winStrong.shift();

      /* 弱い点滅だけが基準を超えている状態が続いた時間を測る */
      if (cOff > std.maxTransitionsPerSec) {
        if (weakRunStart === null) weakRunStart = t;
        weakRunLast = t;
      } else {
        weakRunStart = null;
      }
      var weakRunUs = (weakRunStart !== null) ? (weakRunLast - weakRunStart) : 0;

      var strongExceeds = winStrong.length > std.maxTransitionsPerSec;   // 20%超が3回/秒超
      var redPresent = cond.requiresNoRedFlash && cRed > 0;
      var tooMany = cOff > cond.maxTransitions;                          // 5回/秒超
      var tooLong = weakRunUs > cond.maxDurationUs;                      // 連続2秒超

      /* 条件付き許容が効くのは、強い点滅も赤も無く、5回/秒以内で2秒以内のときだけ */
      var allowed = !strongExceeds && !redPresent && !tooMany && !tooLong;
      if (allowed) {
        cOff = Math.min(cOff, std.maxTransitionsPerSec);   // 抵触に至らない扱い
        if (cMg > std.maxTransitionsPerSec) cMg = std.maxTransitionsPerSec + 1;  // 要注意は残す
      }
    }

    /* ---- 民放連 2. 急激な場面転換 ---- */
    if (id === "jba" && std.sceneCut && r.sceneCut) winCuts.push(t);
    while (winCuts.length && winCuts[0] <= lo) winCuts.shift();
    var cutsExceed = (id === "jba" && std.sceneCut) &&
                     winCuts.length > std.sceneCut.maxPerSec;
    if (cOff > out.maxTransitions) out.maxTransitions = cOff;
    out.seriesT.push(t);
    out.seriesC.push(cOff > cRed ? cOff : cRed);

    var lim = std.maxTransitionsPerSec;      // 6（=1秒3回の点滅）
    var level = 0;
    if (cOff > lim || cRed > lim || cutsExceed) level = 2;
    else if (cMg > lim) level = 1;
    // 持続性による要注意（§7.3 警告A / ITUの5秒注記）
    else if (cOff >= 4) level = Math.max(level, sustained(winOfficial) ? 1 : 0);

    if (level === 2 && out.firstHitUs === null) out.firstHitUs = t;
    if (level > out.level) out.level = level;

    // 区間をまとめる
    if (level > 0) {
      if (curSpan && curSpan.level === level && t - curSpan.t1 < 500000) {
        curSpan.t1 = t;
      } else {
        if (curSpan) out.spans.push(curSpan);
        curSpan = { t0: t, t1: t, level: level };
      }
    } else if (curSpan) {
      out.spans.push(curSpan); curSpan = null;
    }
  }
  if (curSpan) out.spans.push(curSpan);
  return out;
}

/* 5秒を超えて点滅が続いているか（ITU-R BT.1702-2 の注記） */
function sustained(times) {
  if (times.length < 2) return false;
  return (times[times.length - 1] - times[0]) >= 5000000;
}

/* 面積条件（§4.3）。基準ごとに定義が異なるので統合しない。 */
function areaPasses(std, area, size, useMargin, marginPct) {
  if (!area) return false;
  var k = useMargin ? (1 - (marginPct || 0) / 100) : 1;
  var mode = std.area.mode;
  if (mode === "none") return true;                       // WCAG AAA は面積免除なし
  if (mode === "global") return area.global > std.area.ratio * k;
  if (mode === "local") {
    var r = (std.area.winFracW ? area.local2024 : area.local);
    return r > std.area.ratio * k;
  }
  return false;
}

/* 表示用に系列を間引く。長尺（30分×60fps ≒ 10万点）をそのまま送ると
   メッセージが肥大するため、バケットごとの最大値を取る。
   ⚠ 平均ではなく最大を取ること。1フレームだけの点滅を平滑化で消してはならない。 */
function downsampleSeries(ts, cs, maxPoints) {
  var n = ts.length;
  if (n <= maxPoints) return { t: ts.slice(), c: cs.slice() };
  var outT = [], outC = [];
  var bucket = n / maxPoints;
  for (var i = 0; i < maxPoints; i++) {
    var a = Math.floor(i * bucket), b = Math.floor((i + 1) * bucket);
    if (b <= a) b = a + 1;
    var mx = 0, at = ts[a];
    for (var j = a; j < b && j < n; j++) if (cs[j] > mx) { mx = cs[j]; at = ts[j]; }
    outT.push(at); outC.push(mx);
  }
  return { t: outT, c: outC };
}

/* ---------------------------------------------------------------------
   空間パターンの評価（§5）— 参考枠

   ⚠ これは閃光判定と同格の合否にしない。呼び出し側で reference:true の
     レーンとして扱い、readout でも別枠に出すこと。

   縞の上限は動きの分類で変わる（§5.5）:
     振動・コントラスト反転 → 5対 / 静止・一方向ドリフト → 8対（Wilkinsは12対）
   0.5秒未満のパターンで突発波が生じることは極めて稀なため、継続を要件とする。
   --------------------------------------------------------------------- */
function evaluatePattern(samples, motion, marginPct) {
  var out = { level: 0, motion: motion, spans: [], maxPairs: 0, limit: 0, reference: true };
  if (!samples || !samples.length) return out;

  var lim = FSFft.PAIR_LIMIT.ef2005[motion] || 5;
  out.limit = lim;
  var k = 1 - (marginPct || 0) / 100;
  var minDurUs = 500000;                       // 0.5秒
  var minDurMg = 500000 * k;

  var runStart = -1, runLast = -1, runLevel = 0;
  function flush() {
    if (runStart < 0) return;
    var dur = runLast - runStart;
    if (runLevel === 2 && dur >= minDurUs) {
      out.spans.push({ t0: runStart, t1: runLast, level: 2 });
      out.level = Math.max(out.level, 2);
    } else if (runLevel >= 1 && dur >= minDurMg) {
      out.spans.push({ t0: runStart, t1: runLast, level: 1 });
      out.level = Math.max(out.level, 1);
    }
    runStart = -1; runLevel = 0;
  }

  for (var i = 0; i < samples.length; i++) {
    var sp = samples[i];
    var pairs = sp.pairs || 0;
    if (pairs > out.maxPairs) out.maxPairs = pairs;
    var lv = 0;
    if (pairs > lim) lv = 2;
    else if (pairs > lim - 1) lv = 1;          // 上限−1対は要注意（§7.3 警告C）
    if (lv > 0) {
      if (runStart < 0) { runStart = sp.t; runLevel = lv; }
      else runLevel = Math.max(runLevel, lv);
      runLast = sp.t;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

function buildTimeline(records, verdicts) {
  var ids = Object.keys(verdicts);
  return {
    t0: records.length ? records[0].t : 0,
    t1: records.length ? records[records.length - 1].t : 0,
    lanes: ids.map(function (id) {
      var v = verdicts[id];
      var ds = downsampleSeries(v.seriesT, v.seriesC, 3000);
      return {
        id: id,
        label: v.label,
        reference: v.reference,
        level: v.level,
        firstHitUs: v.firstHitUs,
        maxTransitions: v.maxTransitions,
        spans: v.spans,
        seriesT: ds.t,
        seriesC: ds.c
      };
    })
  };
}

function containerInfo(dx) {
  return {
    codec: dx.codec, width: dx.width, height: dx.height,
    nbSamples: dx.nbSamples, durationSec: dx.durationSec,
    fpsMeasured: dx.fpsMeasured, isCFR: dx.isCFR,
    bitDepth: dx.bitDepth,
    colorSource: dx.container.source,
    colorTransfer: dx.container.transfer,
    colorMatrix: dx.container.matrix,
    fullRange: dx.container.fullRange
  };
}

function buildWarnings(dx, dec, verdict) {
  var w = [];
  if (verdict.mode === "sdr-assumed") w.push(verdict.reason);
  if (dx.fpsMeasured && dx.fpsMeasured < 50) {
    w.push("ソース " + dx.fpsMeasured.toFixed(2) + "fps — " +
           (dx.fpsMeasured / 2).toFixed(1) + "Hz を超える点滅は原理的に検証できません（Nyquist）。");
  }
  if (!dx.isCFR) w.push("可変フレームレートの可能性があります。1秒窓の計数精度が落ちます。");
  if (dec && dec.fellBackToSoftware) {
    w.push("ハードウェアデコードに失敗し、ソフトウェアで処理しました。");
  }
  if (!dx.container.matrix) {
    w.push("色変換マトリクスのタグがありません。BT.601/709 の取り違えにより約1〜3%の輝度誤差が乗りうります。");
  }
  return w;
}
