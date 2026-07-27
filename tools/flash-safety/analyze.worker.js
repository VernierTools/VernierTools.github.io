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
importScripts("vendor/mp4box.all.min.js", "decode.js", "analyzer.js");

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
    var size = analysisSize(dx.width, dx.height, opts.longSide || 480);
    var n = size.w * size.h;
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
       CTD が同じでも EOTF が違えば輝度マップが違うため共有できない。 */
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

    /* 赤閃光用（赤飽和度の変化を追う）。EOTF に依らないので1つでよい。 */
    var redDet = new A.TransitionDetector(n, {
      ctd: 0.20, darkMax: 1.01, eligibleMs: 66, histLen: histLen
    });

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

            // 赤閃光（bt1886 のときだけ計算すれば足りる）
            if (eo === "bt1886") {
              var redMap = new Float32Array(pl.R.length);
              for (var i = 0; i < redMap.length; i++) {
                redMap[i] = A.redSaturation(pl.R, pl.G, pl.B, i);
              }
              redDet.step(redMap, tUs);
              rec.red = countMask(redDet.maskUp).n + countMask(redDet.maskDown).n;
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

      /* ---- ⑤ 基準ごとに 1秒窓で計数して判定 ---- */
      var verdicts = {};
      stdIds.forEach(function (id) {
        verdicts[id] = evaluate(id, records, size, n, marginPct);
      });

      return {
        aborted: false,
        container: containerInfo(dx),
        analysis: {
          width: size.w, height: size.h,
          frames: frameCount,
          fps: fps,
          marginPct: marginPct,
          acceleration: dec.fellBackToSoftware ? "software" : "no-preference"
        },
        verdicts: verdicts,
        timeline: buildTimeline(records, verdicts),
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
  var eo = std.eotf;
  var isRedRelevant = (id === "wcagA" || id === "wcagAAA" || id === "itu" ||
                       id === "ofcom" || id === "jba" || id === "proposal2024");

  var out = {
    id: id, label: std.label, reference: !!std.reference,
    level: 0,                 // 0=検出なし 1=要注意 2=抵触
    firstHitUs: null,
    spans: [],                // [{t0,t1,level}]
    maxTransitions: 0,
    hits: []
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
    if (r.red > 0 && isRedRelevant) winRed.push(t);

    // 1秒窓の外を捨てる
    var lo = t - 1000000;
    while (winOfficial.length && winOfficial[0] <= lo) winOfficial.shift();
    while (winMargin.length && winMargin[0] <= lo) winMargin.shift();
    while (winRed.length && winRed[0] <= lo) winRed.shift();

    var cOff = winOfficial.length, cMg = winMargin.length, cRed = winRed.length;
    if (cOff > out.maxTransitions) out.maxTransitions = cOff;

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

function buildTimeline(records, verdicts) {
  return {
    t0: records.length ? records[0].t : 0,
    t1: records.length ? records[records.length - 1].t : 0,
    lanes: Object.keys(verdicts).map(function (id) {
      return {
        id: id,
        label: verdicts[id].label,
        reference: verdicts[id].reference,
        spans: verdicts[id].spans
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
