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
    var patSize = analysisSize(dx.width, dx.height, opts.patternLongSide || 1280);
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

          // EOTF ごとに輝度マップを作り、遷移を検出する
          EOTF_GROUPS.forEach(function (eo) {
            var pl = A.toLinearPlanes(buf, meta, { dstW: size.w, dstH: size.h, eotf: eo });
            if (!pl) return;

            ["official", "margin"].forEach(function (kind) {
              var det = detectors[eo][kind];
              det.step(pl.lum, tUs);
              var up = countMask(det.maskUp), dn = countMask(det.maskDown);
              rec.up[eo + ":" + kind] = up;
              rec.down[eo + ":" + kind] = dn;
              /* 面積は official / margin それぞれのマスクから別々に求める。
                 margin の方が遷移が多く検出されるため、official のマスクを
                 流用すると面積を過小評価し、マージン判定が甘くなる。 */
              if (up.n || dn.n) {
                rec["area:" + eo + ":" + kind] = areaInfo(det.maskUp, det.maskDown, size);
              }
            });

            /* 2024年提案用（Michelson 分岐あり）。EOTF は bt1886 を使う。 */
            if (eo === "bt1886") {
              ["official", "margin"].forEach(function (kind) {
                var md = detectors["mich"][kind];
                md.step(pl.lum, tUs);
                var mup = countMask(md.maskUp), mdn = countMask(md.maskDown);
                rec.up["mich:" + kind] = mup;
                rec.down["mich:" + kind] = mdn;
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
      if (tOrigin !== 0) {
        for (var ri = 0; ri < records.length; ri++) records[ri].t -= tOrigin;
        notes.push("先頭フレームの表示時刻が " + (tOrigin / 1000).toFixed(1) +
                   "ms だったため、タイムラインを0秒起点に正規化しました。");
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
function areaInfo(maskUp, maskDown, size) {
  var w = size.w, h = size.h, total = w * h;
  var upN = 0, dnN = 0;
  for (var i = 0; i < total; i++) { if (maskUp[i]) upN++; if (maskDown[i]) dnN++; }
  var domMask = upN >= dnN ? maskUp : maskDown;
  var domN = Math.max(upN, dnN);

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

    var cOff = winOfficial.length, cMg = winMargin.length, cRed = winRed.length;
    if (cOff > out.maxTransitions) out.maxTransitions = cOff;
    out.seriesT.push(t);
    out.seriesC.push(cOff > cRed ? cOff : cRed);

    var lim = std.maxTransitionsPerSec;      // 6（=1秒3回の点滅）
    var level = 0;
    if (cOff > lim || cRed > lim) level = 2;
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
