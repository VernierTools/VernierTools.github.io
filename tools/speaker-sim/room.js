/* =========================================================================
   Speaker playback simulator — room.js
   仮想スピーカー 1 本から、聴く人の両耳までのインパルス応答（BRIR）を作る。
     ・直接音と壁の反射（鏡像法、箱型の部屋、反射は 3 回まで）は、それぞれ届く向きに応じて
       ブラウザの頭部伝達関数（PannerNode の HRTF）で左右の耳に分ける。OfflineAudioContext で描く
     ・それより後の残響は、部屋の容積・表面積・吸音率から求めた残響時間（Eyring）で減衰する雑音を、
       低・中・高の 3 帯域に分けて作る（左右の耳は別の雑音＝拡散音場）
   座標は部屋基準（m）：x = 幅方向（左の壁が 0）、y = 高さ（床が 0）、z = 奥行き（前の壁が 0）。
   聴く人の頭の向き（yaw・pitch）で相対位置を回してから PannerNode に渡す（Web Audio の聴取者は −Z を向き、上が +Y）。
   ========================================================================= */
(function (root) {
"use strict";

var C = 343;   // 音速 m/s（20 ℃）
var GROUND_ABS = 0.2;   // 屋外の地面の吸音率（土・芝とアスファルトの間くらい）

/* ---- スピーカーの種類：周波数特性（再生前に BiquadFilter で掛ける）と、横・後ろへの高音の落ち方 ---- */
var SPEAKERS = {
  ideal:     { eq: [], beam: 0 },
  monitor:   { eq: [["highpass", 45, 0.71]], beam: 0.8 },
  bookshelf: { eq: [["highpass", 65, 0.9], ["peaking", 100, 1.0, 1.5]], beam: 1 },
  small:     { eq: [["highpass", 130, 1.0], ["peaking", 190, 1.2, 3], ["lowpass", 14000, 0.71]], beam: 1.1 },
  tv:        { eq: [["highpass", 170, 0.8], ["peaking", 2500, 1.0, 3.5], ["lowpass", 9000, 0.71]], beam: 1.3 },
  radio:     { eq: [["highpass", 150, 1.2], ["peaking", 1000, 0.8, 5], ["lowpass", 7000, 0.9]], beam: 1.2 },
  phone:     { eq: [["highpass", 550, 1.0], ["highpass", 550, 1.0], ["peaking", 3000, 1.0, 4], ["lowpass", 12000, 0.71]], beam: 0.7 }
};

/* ---- 部屋の大きさと、聴く人・スピーカーの位置 ----
   かんたん配置 s: { spacing（スピーカー間 m）, dist（各スピーカーから聴く人まで m）, front（スピーカーと前の壁の距離 m）,
        height（耳とスピーカーの高さ m）, room: null | { w, d, h, abs（平均吸音率 0〜1） }, ground（屋外で地面の反射） }
   自由配置 s.free: { L:[x,y,z], R:[x,y,z], ear:[x,y,z], yaw, pitch（頭の向き °）, aim（true = 聴く人に向ける）,
        aimL:[yaw, pitch], aimR:[yaw, pitch] }。部屋があれば壁から 0.1 m 内側に収める */
function layout(s) {
  var room = s.room ? { w: s.room.w, d: s.room.d, h: s.room.h, abs: s.room.abs } : null;
  if (s.free) return freeLayout(s, room);
  var half = s.spacing / 2, depth = Math.sqrt(Math.max(0, s.dist * s.dist - half * half)), grown = false;
  var hgt = s.height;
  if (room) {   // 入りきらなければ部屋を広げる（壁から 0.3 m は離す）
    var needW = s.spacing + 0.6, needD = s.front + depth + 0.5, needH = hgt + 0.3;
    if (room.w < needW) { room.w = needW; grown = true; }
    if (room.d < needD) { room.d = needD; grown = true; }
    if (room.h < needH) { room.h = needH; grown = true; }
  }
  var cx = room ? room.w / 2 : 0, fz = room ? Math.min(s.front, room.d - depth - 0.5) : 0;
  return finish({
    room: room, grown: grown, ground: !room && !!s.ground,
    listener: [cx, hgt, fz + depth],
    speakers: [[cx - half, hgt, fz], [cx + half, hgt, fz]],
    yaw: 0, pitch: 0, aims: [null, null]
  });
}
function freeLayout(s, room) {
  var f = s.free, clamped = false;
  function fit(p) {
    var q = p.slice();
    if (room) {
      var dims = [room.w, room.h, room.d];
      for (var k = 0; k < 3; k++) { var c = Math.min(dims[k] - 0.1, Math.max(0.1, q[k])); if (c !== q[k]) { q[k] = c; clamped = true; } }
    } else if (q[1] < 0.05) { q[1] = 0.05; clamped = true; }
    return q;
  }
  var L = { room: room, grown: false, ground: !room && !!s.ground,
    listener: fit(f.ear), speakers: [fit(f.L), fit(f.R)],
    yaw: f.yaw || 0, pitch: Math.max(-85, Math.min(85, f.pitch || 0)),
    aims: f.aim ? [null, null] : [dir(f.aimL[0], f.aimL[1]), dir(f.aimR[0], f.aimR[1])] };
  L.clamped = clamped;
  return finish(L);
}
function finish(L) {
  var a = sub(L.speakers[0], L.listener), b = sub(L.speakers[1], L.listener);
  var c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((len(a) * len(b)) || 1);
  L.angle = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  L.depth = Math.abs(L.listener[2] - (L.speakers[0][2] + L.speakers[1][2]) / 2);
  return L;
}
/* 向き（yaw：右回りが正、0 = 前の壁の方、pitch：上が正、°）→ 単位ベクトル */
function dir(yaw, pitch) {
  var y = yaw * Math.PI / 180, p = Math.max(-89, Math.min(89, pitch)) * Math.PI / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}
/* 部屋の向きの相対位置 → 頭の向きの座標（右 +x、上 +y、正面 −z。Web Audio の聴取者と同じ） */
function headFrame(L, v) {
  var f = dir(L.yaw, L.pitch), r = norm([-f[2], 0, f[0]]), u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return [v[0] * r[0] + v[1] * r[1] + v[2] * r[2], v[0] * u[0] + v[1] * u[1] + v[2] * u[2], -(v[0] * f[0] + v[1] * f[1] + v[2] * f[2])];
}
/* 聴く人から見た、スピーカーの方向（右が正の方位角・上が正の仰角、°）と距離 */
function seen(L, si) {
  var v = sub(L.speakers[si], L.listener), h = headFrame(L, v), r = len(v);
  return { az: Math.atan2(h[0], -h[2]) * 180 / Math.PI, el: Math.atan2(h[1], Math.sqrt(h[0] * h[0] + h[2] * h[2])) * 180 / Math.PI, dist: r };
}
function eyring(room) {
  var V = room.w * room.d * room.h, S = 2 * (room.w * room.d + room.w * room.h + room.d * room.h);
  var a = Math.min(0.99, Math.max(0.01, room.abs));
  return { V: V, S: S, rt: 0.161 * V / (-S * Math.log(1 - a)) };
}

/* ---- 鏡像法：直接音と反射音の一覧 [遅れ s, 強さ, 向き（聴く人からの相対）, 高音の減り dB] ---- */
function paths(L, si, opt) {
  var sp = L.speakers[si], ls = L.listener, room = L.room, out = [];
  var axis = L.aims && L.aims[si] ? L.aims[si] : norm(sub(ls, sp));   // 既定ではスピーカーは聴く人の方を向く
  var beam = SPEAKERS[opt.speaker] ? SPEAKERS[opt.speaker].beam : 1;
  var absorb = room ? room.abs : GROUND_ABS;
  function add(img, order, flips) {
    var v = sub(img, ls), r = len(v);
    if (r < 0.05) return;
    var beta = Math.pow(Math.sqrt(1 - Math.min(0.99, absorb)), order);
    var g = beta / r;
    // スピーカーから出た向き：聴く人へ向かう向きを、反射の回数が奇数の軸だけ折り返す
    var e = [-v[0] / r, -v[1] / r, -v[2] / r];
    for (var k = 0; k < 3; k++) if (flips[k] % 2) e[k] = -e[k];
    var cos = Math.max(-1, Math.min(1, e[0] * axis[0] + e[1] * axis[1] + e[2] * axis[2]));
    var hf = -6 * beam * (1 - cos)            // 横・後ろへは高音が出にくい（スピーカーの指向性）
      - order * (1 + 3 * absorb)                // 壁は高音をよく吸う
      - 0.012 * r;                             // 空気の吸収（4 kHz 付近、20 ℃・50%）
    out.push([r / C, g, headFrame(L, v), Math.max(-30, hf), order]);
  }
  if (!room) {
    add(sp, 0, [0, 0, 0]);
    if (L.ground) add([sp[0], -sp[1], sp[2]], 1, [0, 1, 0]);   // 地面での反射（地面を鏡にした像）
    return out;
  }
  var N = opt.order === undefined ? 3 : opt.order, dims = [room.w, room.h, room.d];
  for (var u = 0; u < 2; u++) for (var vv = 0; vv < 2; vv++) for (var w = 0; w < 2; w++)
    for (var l = -N; l <= N; l++) for (var m = -N; m <= N; m++) for (var n = -N; n <= N; n++) {
      var cnt = [Math.abs(l - u) + Math.abs(l), Math.abs(m - vv) + Math.abs(m), Math.abs(n - w) + Math.abs(n)];
      var order = cnt[0] + cnt[1] + cnt[2];
      if (order > N) continue;
      var img = [(1 - 2 * u) * sp[0] + 2 * l * dims[0], (1 - 2 * vv) * sp[1] + 2 * m * dims[1], (1 - 2 * w) * sp[2] + 2 * n * dims[2]];
      add(img, order, cnt);
    }
  return out;
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function len(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
function norm(v) { var l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

function Offline(ch, n, rate) {
  var O = root.OfflineAudioContext || root.webkitOfflineAudioContext;
  return new O(ch, n, rate);
}
function panner(ctx, v) {
  var p = ctx.createPanner();
  p.panningModel = "HRTF"; p.distanceModel = "linear"; p.rolloffFactor = 0; p.refDistance = 1; p.maxDistance = 1e4;
  p.coneInnerAngle = 360; p.coneOuterAngle = 360;
  if (p.positionX) { p.positionX.value = v[0]; p.positionY.value = v[1]; p.positionZ.value = v[2]; }
  else p.setPosition(v[0], v[1], v[2]);
  return p;
}
function render(ctx) {
  return new Promise(function (res, rej) {
    ctx.oncomplete = function (e) { res(e.renderedBuffer); };
    var p = ctx.startRendering(); if (p && p.then) p.then(res, rej);
  });
}

/* HRTF の処理の遅れ（ブラウザごとに違う）と、正面の音の両耳のエネルギーを測っておく（周波数ごとに 1 回） */
var calib = {};
function calibrate(rate) {
  if (calib[rate]) return calib[rate];
  var n = Math.round(rate * 0.05), ctx = Offline(2, n, rate), imp = ctx.createBuffer(1, 1, rate);
  imp.getChannelData(0)[0] = 1;
  var src = ctx.createBufferSource(); src.buffer = imp;
  src.connect(panner(ctx, [0, 0, -1])).connect(ctx.destination); src.start(0);
  calib[rate] = render(ctx).then(function (b) {
    var l = b.getChannelData(0), r = b.getChannelData(1), peak = 0, at = 0, e = 0;
    for (var i = 0; i < n; i++) { var a = Math.abs(l[i]) + Math.abs(r[i]); e += l[i] * l[i] + r[i] * r[i]; if (a > peak) { peak = a; at = i; } }
    // 立ち上がり：最大値の 1/10 を最初に超える所（HRTF のインパルス応答は最大の少し前から始まる）
    var on = 0; for (i = 0; i < n; i++) if (Math.abs(l[i]) + Math.abs(r[i]) > peak * 0.1) { on = i; break; }
    return { latency: on, energy: e };
  });
  return calib[rate];
}

/* ---- 1 本のスピーカーの BRIR（2 チャンネルの AudioBuffer 用の Float32Array 2 本）を作る ---- */
function brir(L, si, opt, rate) {
  return calibrate(rate).then(function (cal) {
    var ps = paths(L, si, opt), direct = Infinity;
    ps.forEach(function (p) { if (p[0] < direct) direct = p[0]; });
    var shift = opt.delay === false ? direct : 0;   // 届くまでの遅れを含めないときは、直接音が 0 になるようずらす
    var room = L.room, rt = room ? eyring(room).rt : 0;
    var lastEarly = 0, tailStart = 0;
    ps.forEach(function (p) {
      if (p[1] > 0.002) lastEarly = Math.max(lastEarly, p[0]);
      if (p[4] <= 2) tailStart = Math.max(tailStart, p[0]);   // 反射 2 回までが出そろった頃から残響を重ねる
    });
    var tailLen = room ? Math.min(6, rt * 1.3 * 1.25) : 0;
    var total = Math.ceil((lastEarly - shift + 0.02 + tailLen) * rate) + cal.latency + 512;
    var early = Math.ceil((lastEarly - shift + 0.02) * rate) + cal.latency + 512;
    var ctx = Offline(2, early, rate), imp = ctx.createBuffer(1, 1, rate);
    imp.getChannelData(0)[0] = 1;
    var src = ctx.createBufferSource(); src.buffer = imp;
    var maxD = lastEarly - shift + 0.01;
    ps.forEach(function (p) {
      if (p[1] < 0.002) return;
      var d = ctx.createDelay(Math.max(0.01, maxD)), g = ctx.createGain(), f = ctx.createBiquadFilter();
      d.delayTime.value = Math.max(0, p[0] - shift); g.gain.value = p[1];
      f.type = "highshelf"; f.frequency.value = 4000; f.gain.value = p[3];
      src.connect(d); d.connect(g); g.connect(f); f.connect(panner(ctx, p[2])).connect(ctx.destination);
    });
    src.start(0);
    return render(ctx).then(function (b) {
      var out = [new Float32Array(total), new Float32Array(total)];
      // HRTF の処理の遅れを取り除く（直接音がちょうど距離ぶんの遅れで届くように）
      for (var c = 0; c < 2; c++) { var x = b.getChannelData(c); out[c].set(x.subarray(Math.min(cal.latency, x.length))); }
      if (room) {
        var e = eyring(room), a = Math.min(0.99, room.abs);
        // 拡散音のエネルギー（直接音 1/r² に対して 16π r²(1−α)/(Sα) 倍 → r によらず 16π(1−α)/(Sα)）
        var Erev = cal.energy * 16 * Math.PI * (1 - a) / (e.S * a);
        tail(out, rate, direct - shift, tailStart - shift, e.rt, Erev, opt.seed || 1);
      }
      return out;
    });
  });
}

/* ---- 残響（後部残響）。t0 から 20 ms かけてフェードインし、帯域ごとの残響時間で減衰 ---- */
function tail(out, rate, tDirect, tStart, rt, Erev, seed) {
  var n = out[0].length, s0 = Math.max(0, Math.floor((tStart - 0.02) * rate));
  var bands = [[1.2, "lo"], [1, "mid"], [0.6, "hi"]];   // 残響時間の倍率（低音は長く、高音は短く）
  var rnd = seed >>> 0 || 1;
  function noise() { rnd = (rnd * 1664525 + 1013904223) >>> 0; var a = rnd / 4294967296; rnd = (rnd * 1664525 + 1013904223) >>> 0; return a + rnd / 4294967296 - 1; }
  var aLo = 1 - Math.exp(-2 * Math.PI * 250 / rate), aHi = 1 - Math.exp(-2 * Math.PI * 4000 / rate);
  for (var c = 0; c < 2; c++) {
    var buf = new Float32Array(n), lo = 0, lp4 = 0, en = 0;
    for (var i = s0; i < n; i++) {
      var x = noise(), t = i / rate - tDirect;
      lo += aLo * (x - lo); lp4 += aHi * (x - lp4);
      var vLo = lo, vHi = x - lp4, vMid = x - vLo - vHi;
      var y = vLo * Math.exp(-6.91 * t / (rt * bands[0][0])) + vMid * Math.exp(-6.91 * t / rt) + vHi * Math.exp(-6.91 * t / (rt * bands[2][0]));
      var fade = i < s0 + 0.02 * rate ? 0.5 - 0.5 * Math.cos(Math.PI * (i - s0) / (0.02 * rate)) : 1;
      buf[i] = y * fade; en += buf[i] * buf[i];
    }
    // 目標のエネルギー：t0 以降に残る分 = 全体 × exp(−13.8 (t0 − 直接音)/RT)、両耳で半分ずつ
    var target = Erev * Math.exp(-13.82 * Math.max(0, tStart - tDirect) / rt) / 2;
    var k = en > 0 ? Math.sqrt(target / en) : 0;
    for (i = s0; i < n; i++) out[c][i] += buf[i] * k;
  }
}

root.SpeakerRoom = { SPEAKERS: SPEAKERS, layout: layout, eyring: eyring, paths: paths, brir: brir, calibrate: calibrate, seen: seen, dir: dir, C: C };
})(window);
