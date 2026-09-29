/* =========================================================================
   Vernier — shared/retro-engine.js
   画像・映像の「媒体による劣化」を、見た目のフィルタではなく媒体の仕組みとして再現する共通エンジン。
   使うツール: tools/retro-graphics（映像）, tools/image-degrade（画像）

     crt     … 表示系の物理（帯域制限 → ビーム → 蛍光体マスク → 管面）
     vhs     … 符号化＋記録系（NTSC 符号化 → カラーアンダー記録 → 再生復調）
     net     … 量子化系（減色・ディザ・DCT 圧縮）
     film    … 写真フィルム（レンズ → ハレーション → 特性曲線 → 粒状）
     bw      … 昔の白黒（感色性 → 特性曲線 → 調色・経年）
     digicam … 初期のデジカメ（レンズ → 画素数 → カラーフィルタ配列 → ノイズ → 現像 → JPEG）

   crt / vhs / net は「信号の解像度」（横 1024 まで）で処理し、画像がそれより大きければ拡大する。
   走査線 480 本のような媒体の解像度は、写真の画素数とは関係なく決まっているため。
   film / bw は処理する画素数のまま。粒状はフィルムの大きさと画素の大きさから求める（Selwyn の法則）。
   digicam はセンサーの画素数で現像し、最後に出力の大きさへ拡大する。
   ========================================================================= */
(function (root) {
"use strict";

var ACTIVE_LINE_US = 52.6;   // NTSC 有効走査期間 µs
var FSC = 3.579545;          // 色副搬送波 MHz
var REF_W = 1024;            // 信号系（crt/vhs/net）の処理幅の上限。映像ツールの表示幅と同じ

/* =========================================================================
   1. パラメーター定義
      キーは全モードで一意。i18n は p.<key> / o.<key>.<opt> / g.<group> / n.<key>
      v:1 = 映像のみ（時間方向）、i:1 = 画像のみ
   ========================================================================= */
var DEFS = {
  crt: [
    {k:"crtInput",   g:"sig",  t:"sel", d:0, o:["composite","svideo","rgb"]},
    {k:"crtHbw",     g:"sig",  t:"num", d:4.2,  min:0.5, max:12,  step:0.1,  u:"MHz"},
    {k:"crtScan",    g:"sig",  t:"sel", d:1, o:["p240","i480","off"]},
    {k:"crtSigma",   g:"beam", t:"num", d:0.32, min:0.12,max:0.70,step:0.01},
    {k:"crtBloom",   g:"beam", t:"num", d:0.45, min:0,   max:1,   step:0.01},
    {k:"crtHalo",    g:"beam", t:"num", d:0.22, min:0,   max:1,   step:0.01},
    {k:"crtHaloR",   g:"beam", t:"num", d:7,    min:1,   max:24,  step:0.5,  u:"px"},
    {k:"crtMask",    g:"mask", t:"sel", d:1, o:["none","grille","slot","triad"]},
    {k:"crtPitch",   g:"mask", t:"num", d:3,    min:1,   max:8,   step:0.25, u:"px"},
    {k:"crtMaskAmt", g:"mask", t:"num", d:0.5,  min:0,   max:1,   step:0.01},
    {k:"crtGamma",   g:"tube", t:"num", d:2.40, min:1.8, max:2.8, step:0.01},
    {k:"crtOverscan",g:"tube", t:"num", d:4,    min:0,   max:12,  step:0.5,  u:"%"},
    {k:"crtCurve",   g:"tube", t:"num", d:0.10, min:0,   max:0.40,step:0.01},
    {k:"crtConv",    g:"tube", t:"num", d:0.5,  min:0,   max:3,   step:0.05, u:"px"},
    {k:"crtVig",     g:"tube", t:"num", d:0.20, min:0,   max:1,   step:0.01},
    {k:"crtPersist", g:"time", t:"num", d:0.25, min:0,   max:0.90,step:0.01, v:1}
  ],
  vhs: [
    {k:"vhsLumaBw",     g:"band", t:"num", d:3.0, min:0.8, max:6,   step:0.05, u:"MHz"},
    {k:"vhsChromaBw",   g:"band", t:"num", d:400, min:60,  max:900, step:10,   u:"kHz"},
    {k:"vhsComb",       g:"band", t:"num", d:0.8, min:0,   max:1,   step:0.01},
    {k:"vhsDotCrawl",   g:"band", t:"num", d:0.3, min:0,   max:1,   step:0.01},
    {k:"vhsPreemp",     g:"rec",  t:"num", d:0.5, min:0,   max:1.5, step:0.01},
    {k:"vhsWhiteClip",  g:"rec",  t:"num", d:0.4, min:0,   max:1,   step:0.01},
    {k:"vhsLumaNoise",  g:"rec",  t:"num", d:0.28,min:0,   max:1,   step:0.01},
    {k:"vhsChromaNoise",g:"rec",  t:"num", d:0.38,min:0,   max:1,   step:0.01},
    {k:"vhsNoiseCorr",  g:"rec",  t:"num", d:0.0, min:0,   max:1,   step:0.01, v:1},
    {k:"vhsJitter",     g:"tape", t:"num", d:0.35,min:0,   max:1,   step:0.01},
    {k:"vhsJitterCorr", g:"tape", t:"num", d:0.6, min:0,   max:1,   step:0.01},
    {k:"vhsHeadSw",     g:"tape", t:"num", d:6,   min:0,   max:16,  step:1,    u:"line"},
    {k:"vhsDropout",    g:"tape", t:"num", d:0.12,min:0,   max:1,   step:0.01},
    {k:"vhsTracking",   g:"tape", t:"num", d:0.0, min:0,   max:1,   step:0.01},
    {k:"vhsGen",        g:"gen",  t:"num", d:1,   min:1,   max:5,   step:1}
  ],
  net: [
    {k:"netScale",     g:"src", t:"num", d:50, min:10, max:100, step:5, u:"%"},
    {k:"netUpscale",   g:"src", t:"sel", d:0, o:["nearest","bilinear"]},
    {k:"netPalette",   g:"pal", t:"sel", d:1, o:["none","websafe","adaptive","gray"]},
    {k:"netColors",    g:"pal", t:"num", d:64, min:2, max:256, step:1},
    {k:"netDither",    g:"pal", t:"sel", d:3, o:["none","bayer4","bayer8","floyd","atkinson"]},
    {k:"netDitherAmt", g:"pal", t:"num", d:1.0, min:0, max:1, step:0.01},
    {k:"netCodec",     g:"jpg", t:"sel", d:0, o:["none","jpeg"]},
    {k:"netJpegQ",     g:"jpg", t:"num", d:35, min:1, max:100, step:1},
    {k:"netSubsample", g:"jpg", t:"sel", d:2, o:["444","422","420"]},
    {k:"netPasses",    g:"jpg", t:"num", d:1, min:1, max:8, step:1},
    {k:"netBlockShift",g:"jpg", t:"num", d:0, min:0, max:7, step:1, u:"px"}
  ],
  film: [
    {k:"filmStock",   g:"stock",  t:"sel", d:0, o:["neg","slide","instant"]},
    {k:"filmIso",     g:"stock",  t:"num", d:400, min:25, max:3200, step:25},
    {k:"filmFormat",  g:"stock",  t:"sel", d:0, o:["f35","half","f110","f120","f16","s8"]},
    {k:"filmExpo",    g:"stock",  t:"num", d:0,    min:-3,  max:3,    step:0.1,  u:"EV"},
    {k:"filmContrast",g:"tone",   t:"num", d:1,    min:0.5, max:1.8,  step:0.01},
    {k:"filmSat",     g:"tone",   t:"num", d:1.1,  min:0,   max:1.8,  step:0.01},
    {k:"filmWarm",    g:"tone",   t:"num", d:0.1,  min:-1,  max:1,    step:0.01},
    {k:"filmShadow",  g:"tone",   t:"num", d:0.3,  min:-1,  max:1,    step:0.01},
    {k:"filmFade",    g:"tone",   t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"filmHalation",g:"optics", t:"num", d:0.08, min:0,   max:1,    step:0.01},
    {k:"filmHaloR",   g:"optics", t:"num", d:0.25, min:0.05,max:1.5,  step:0.05, u:"mm"},
    {k:"filmSoft",    g:"optics", t:"num", d:0.01, min:0,   max:0.12, step:0.002,u:"mm"},
    {k:"filmCorner",  g:"optics", t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"filmVig",     g:"optics", t:"num", d:0.25, min:0,   max:1,    step:0.01},
    {k:"filmDistort", g:"optics", t:"num", d:0,    min:-0.2,max:0.2,  step:0.01},
    {k:"filmGrain",   g:"grain",  t:"num", d:1,    min:0,   max:3,    step:0.05},
    {k:"filmGrainColor",g:"grain",t:"num", d:0.35, min:0,   max:1,    step:0.01},
    {k:"filmDust",    g:"wear",   t:"num", d:0.1,  min:0,   max:1,    step:0.01},
    {k:"filmScratch", g:"wear",   t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"filmStamp",   g:"extra",  t:"sel", d:0, o:["off","on"]},
    {k:"filmDate",    g:"extra",  t:"text",d:"'98 8 12"},
    {k:"filmFrame",   g:"extra",  t:"sel", d:0, o:["none","instant"], i:1},
    {k:"filmWeave",   g:"time",   t:"num", d:0.25, min:0,   max:1,    step:0.01, v:1},
    {k:"filmFlicker", g:"time",   t:"num", d:0.08, min:0,   max:1,    step:0.01, v:1},
    {k:"filmFps",     g:"time",   t:"sel", d:0, o:["src","f24","f18","f16"], v:1}
  ],
  bw: [
    {k:"bwSens",      g:"emul",   t:"sel", d:2, o:["blue","ortho","pan"]},
    {k:"bwIso",       g:"emul",   t:"num", d:200, min:1, max:3200, step:1},
    {k:"bwFormat",    g:"emul",   t:"sel", d:2, o:["plate","f120","f35","f16","s8"]},
    {k:"bwExpo",      g:"emul",   t:"num", d:0,    min:-3,  max:3,    step:0.1,  u:"EV"},
    {k:"bwContrast",  g:"tone",   t:"num", d:1,    min:0.5, max:2,    step:0.01},
    {k:"bwTone",      g:"tone",   t:"sel", d:0, o:["neutral","sepia","selenium","cyanotype","tintype","albumen"]},
    {k:"bwToneAmt",   g:"tone",   t:"num", d:1,    min:0,   max:1,    step:0.01},
    {k:"bwFade",      g:"tone",   t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"bwHalation",  g:"optics", t:"num", d:0.05, min:0,   max:1,    step:0.01},
    {k:"bwHaloR",     g:"optics", t:"num", d:0.3,  min:0.05,max:2,    step:0.05, u:"mm"},
    {k:"bwSoft",      g:"optics", t:"num", d:0.01, min:0,   max:0.3,  step:0.005,u:"mm"},
    {k:"bwSwirl",     g:"optics", t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"bwVig",       g:"optics", t:"num", d:0.3,  min:0,   max:1,    step:0.01},
    {k:"bwGrain",     g:"grain",  t:"num", d:1,    min:0,   max:3,    step:0.05},
    {k:"bwDust",      g:"wear",   t:"num", d:0.15, min:0,   max:1,    step:0.01},
    {k:"bwScratch",   g:"wear",   t:"num", d:0.05, min:0,   max:1,    step:0.01},
    {k:"bwStain",     g:"wear",   t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"bwSilver",    g:"wear",   t:"num", d:0,    min:0,   max:1,    step:0.01},
    {k:"bwWeave",     g:"time",   t:"num", d:0.4,  min:0,   max:1,    step:0.01, v:1},
    {k:"bwFlicker",   g:"time",   t:"num", d:0.25, min:0,   max:1,    step:0.01, v:1},
    {k:"bwFps",       g:"time",   t:"sel", d:0, o:["src","f24","f18","f16"], v:1}
  ],
  digicam: [
    {k:"dcRes",       g:"sensor", t:"sel", d:1, o:["r320","r640","r1024","r1280","r1600","r2048"]},
    {k:"dcNoise",     g:"sensor", t:"num", d:0.4,  min:0,   max:1,    step:0.01},
    {k:"dcDR",        g:"sensor", t:"num", d:7,    min:5,   max:10,   step:0.1,  u:"EV"},
    {k:"dcExpo",      g:"sensor", t:"num", d:0,    min:-3,  max:3,    step:0.1,  u:"EV"},
    {k:"dcWB",        g:"color",  t:"num", d:0.15, min:-1,  max:1,    step:0.01},
    {k:"dcTint",      g:"color",  t:"num", d:0,    min:-1,  max:1,    step:0.01},
    {k:"dcSat",       g:"color",  t:"num", d:1.1,  min:0,   max:1.8,  step:0.01},
    {k:"dcContrast",  g:"color",  t:"num", d:1.15, min:0.6, max:1.8,  step:0.01},
    {k:"dcSoft",      g:"lens",   t:"num", d:0.6,  min:0,   max:3,    step:0.05, u:"px"},
    {k:"dcCA",        g:"lens",   t:"num", d:0.8,  min:0,   max:4,    step:0.05, u:"px"},
    {k:"dcFringe",    g:"lens",   t:"num", d:0.4,  min:0,   max:1,    step:0.01},
    {k:"dcVig",       g:"lens",   t:"num", d:0.3,  min:0,   max:1,    step:0.01},
    {k:"dcDistort",   g:"lens",   t:"num", d:0.04, min:-0.2,max:0.2,  step:0.01},
    {k:"dcSharpen",   g:"proc",   t:"num", d:0.8,  min:0,   max:2,    step:0.05},
    {k:"dcNR",        g:"proc",   t:"num", d:0.3,  min:0,   max:1,    step:0.01},
    {k:"dcJpegQ",     g:"proc",   t:"num", d:60,   min:5,   max:95,   step:1},
    {k:"dcSubsample", g:"proc",   t:"sel", d:2, o:["444","422","420"]},
    {k:"dcStamp",     g:"extra",  t:"sel", d:0, o:["off","on"]},
    {k:"dcDate",      g:"extra",  t:"text",d:"'03 8 12"},
    {k:"dcUpscale",   g:"extra",  t:"sel", d:1, o:["nearest","bilinear"]},
    {k:"dcFps",       g:"time",   t:"sel", d:0, o:["src","f30","f15","f10"], v:1}
  ]
};
var GROUPS = {
  crt:["sig","beam","mask","tube","time"], vhs:["band","rec","tape","gen"], net:["src","pal","jpg"],
  film:["stock","tone","optics","grain","wear","extra","time"],
  bw:["emul","tone","optics","grain","wear","time"],
  digicam:["sensor","color","lens","proc","extra","time"]
};
var MODES = ["film","bw","digicam","crt","vhs","net"];

var PRESETS = {
  crt: {
    tv:     {crtInput:0,crtHbw:4.2,crtScan:1,crtSigma:0.34,crtBloom:0.5,crtHalo:0.28,crtHaloR:8,crtMask:3,crtPitch:3.5,crtMaskAmt:0.55,crtGamma:2.45,crtOverscan:6,crtCurve:0.14,crtConv:0.8,crtVig:0.28,crtPersist:0.30},
    trin:   {crtInput:1,crtHbw:6.0,crtScan:1,crtSigma:0.30,crtBloom:0.40,crtHalo:0.18,crtHaloR:6,crtMask:1,crtPitch:3,crtMaskAmt:0.45,crtGamma:2.40,crtOverscan:3,crtCurve:0.05,crtConv:0.30,crtVig:0.15,crtPersist:0.22},
    pc:     {crtInput:2,crtHbw:10, crtScan:2,crtSigma:0.45,crtBloom:0.25,crtHalo:0.12,crtHaloR:4,crtMask:3,crtPitch:2.5,crtMaskAmt:0.35,crtGamma:2.25,crtOverscan:1,crtCurve:0.06,crtConv:0.40,crtVig:0.10,crtPersist:0.12},
    arcade: {crtInput:2,crtHbw:8.0,crtScan:0,crtSigma:0.26,crtBloom:0.70,crtHalo:0.35,crtHaloR:10,crtMask:2,crtPitch:4,crtMaskAmt:0.60,crtGamma:2.50,crtOverscan:2,crtCurve:0.08,crtConv:0.60,crtVig:0.25,crtPersist:0.35}
  },
  vhs: {
    sp:   {vhsLumaBw:3.0,vhsChromaBw:400,vhsComb:0.80,vhsDotCrawl:0.30,vhsPreemp:0.50,vhsWhiteClip:0.40,vhsLumaNoise:0.28,vhsChromaNoise:0.38,vhsNoiseCorr:0,vhsJitter:0.35,vhsJitterCorr:0.60,vhsHeadSw:6,vhsDropout:0.12,vhsTracking:0,vhsGen:1},
    lp:   {vhsLumaBw:2.6,vhsChromaBw:340,vhsComb:0.85,vhsDotCrawl:0.35,vhsPreemp:0.55,vhsWhiteClip:0.50,vhsLumaNoise:0.42,vhsChromaNoise:0.52,vhsNoiseCorr:0,vhsJitter:0.50,vhsJitterCorr:0.55,vhsHeadSw:6,vhsDropout:0.20,vhsTracking:0,vhsGen:1},
    ep:   {vhsLumaBw:2.1,vhsChromaBw:280,vhsComb:0.90,vhsDotCrawl:0.40,vhsPreemp:0.60,vhsWhiteClip:0.60,vhsLumaNoise:0.60,vhsChromaNoise:0.70,vhsNoiseCorr:0,vhsJitter:0.70,vhsJitterCorr:0.50,vhsHeadSw:7,vhsDropout:0.32,vhsTracking:0.15,vhsGen:1},
    svhs: {vhsLumaBw:5.4,vhsChromaBw:400,vhsComb:0.60,vhsDotCrawl:0.00,vhsPreemp:0.30,vhsWhiteClip:0.25,vhsLumaNoise:0.15,vhsChromaNoise:0.22,vhsNoiseCorr:0,vhsJitter:0.20,vhsJitterCorr:0.70,vhsHeadSw:5,vhsDropout:0.06,vhsTracking:0,vhsGen:1},
    worn: {vhsLumaBw:2.4,vhsChromaBw:250,vhsComb:0.90,vhsDotCrawl:0.45,vhsPreemp:0.70,vhsWhiteClip:0.65,vhsLumaNoise:0.55,vhsChromaNoise:0.75,vhsNoiseCorr:0,vhsJitter:0.80,vhsJitterCorr:0.40,vhsHeadSw:8,vhsDropout:0.50,vhsTracking:0.40,vhsGen:3}
  },
  net: {
    w1996: {netScale:35,netUpscale:0,netPalette:1,netColors:216,netDither:3,netDitherAmt:1,netCodec:0,netJpegQ:35,netSubsample:2,netPasses:1,netBlockShift:0},
    gif:   {netScale:45,netUpscale:0,netPalette:2,netColors:32,netDither:1,netDitherAmt:1,netCodec:0,netJpegQ:35,netSubsample:2,netPasses:1,netBlockShift:0},
    dialup:{netScale:40,netUpscale:1,netPalette:0,netColors:64,netDither:0,netDitherAmt:1,netCodec:1,netJpegQ:18,netSubsample:2,netPasses:2,netBlockShift:0},
    w2000: {netScale:65,netUpscale:1,netPalette:0,netColors:64,netDither:0,netDitherAmt:1,netCodec:1,netJpegQ:55,netSubsample:2,netPasses:1,netBlockShift:0}
  },
  film: {
    consumer:  {filmStock:0,filmIso:400,filmFormat:0,filmExpo:0,filmContrast:1.0,filmSat:1.15,filmWarm:0.15,filmShadow:0.35,filmFade:0,filmHalation:0.08,filmHaloR:0.25,filmSoft:0.012,filmCorner:0.1,filmVig:0.3,filmDistort:0,filmGrain:1,filmGrainColor:0.35,filmDust:0.1,filmScratch:0,filmStamp:0,filmFrame:0},
    portrait:  {filmStock:0,filmIso:400,filmFormat:3,filmExpo:0.3,filmContrast:0.85,filmSat:0.9,filmWarm:0.2,filmShadow:0.15,filmFade:0,filmHalation:0.05,filmHaloR:0.3,filmSoft:0.008,filmCorner:0,filmVig:0.2,filmDistort:0,filmGrain:0.9,filmGrainColor:0.25,filmDust:0.05,filmScratch:0,filmStamp:0,filmFrame:0},
    slide:     {filmStock:1,filmIso:100,filmFormat:0,filmExpo:-0.2,filmContrast:1.05,filmSat:1.25,filmWarm:-0.05,filmShadow:-0.2,filmFade:0,filmHalation:0.04,filmHaloR:0.2,filmSoft:0.008,filmCorner:0,filmVig:0.25,filmDistort:0,filmGrain:0.8,filmGrainColor:0.3,filmDust:0.08,filmScratch:0,filmStamp:0,filmFrame:0},
    disposable:{filmStock:0,filmIso:400,filmFormat:0,filmExpo:0,filmContrast:1.05,filmSat:1.2,filmWarm:0.2,filmShadow:0.4,filmFade:0,filmHalation:0.1,filmHaloR:0.3,filmSoft:0.03,filmCorner:0.8,filmVig:0.8,filmDistort:0.08,filmGrain:1.2,filmGrainColor:0.4,filmDust:0.15,filmScratch:0,filmStamp:1,filmFrame:0},
    instant:   {filmStock:2,filmIso:640,filmFormat:3,filmExpo:0,filmContrast:0.8,filmSat:0.85,filmWarm:0.1,filmShadow:0.6,filmFade:0.15,filmHalation:0.05,filmHaloR:0.4,filmSoft:0.06,filmCorner:0.3,filmVig:0.35,filmDistort:0,filmGrain:0.6,filmGrainColor:0.2,filmDust:0.05,filmScratch:0,filmStamp:0,filmFrame:1},
    expired:   {filmStock:0,filmIso:400,filmFormat:0,filmExpo:-0.5,filmContrast:0.8,filmSat:0.75,filmWarm:0.35,filmShadow:0.5,filmFade:0.6,filmHalation:0.1,filmHaloR:0.3,filmSoft:0.015,filmCorner:0.1,filmVig:0.3,filmDistort:0,filmGrain:1.8,filmGrainColor:0.6,filmDust:0.3,filmScratch:0.15,filmStamp:0,filmFrame:0},
    noremjet:  {filmStock:0,filmIso:800,filmFormat:0,filmExpo:0,filmContrast:1.0,filmSat:1.1,filmWarm:-0.1,filmShadow:0.2,filmFade:0,filmHalation:0.75,filmHaloR:0.35,filmSoft:0.01,filmCorner:0,filmVig:0.2,filmDistort:0,filmGrain:1.2,filmGrainColor:0.35,filmDust:0.08,filmScratch:0,filmStamp:0,filmFrame:0},
    super8:    {filmStock:1,filmIso:50,filmFormat:5,filmExpo:0,filmContrast:1.15,filmSat:1.2,filmWarm:0.25,filmShadow:0.1,filmFade:0.2,filmHalation:0.1,filmHaloR:0.1,filmSoft:0.012,filmCorner:0.4,filmVig:0.5,filmDistort:0,filmGrain:1,filmGrainColor:0.4,filmDust:0.35,filmScratch:0.2,filmStamp:0,filmFrame:0,filmWeave:0.6,filmFlicker:0.2,filmFps:2}
  },
  bw: {
    wetplate:  {bwSens:0,bwIso:1,bwFormat:0,bwExpo:0,bwContrast:1.25,bwTone:4,bwToneAmt:1,bwFade:0.15,bwHalation:0.4,bwHaloR:1.2,bwSoft:0.08,bwSwirl:0.7,bwVig:0.65,bwGrain:0.5,bwDust:0.3,bwScratch:0.15,bwStain:0.4,bwSilver:0.5},
    albumen:   {bwSens:1,bwIso:25,bwFormat:1,bwExpo:0,bwContrast:1.05,bwTone:5,bwToneAmt:1,bwFade:0.45,bwHalation:0.2,bwHaloR:0.6,bwSoft:0.03,bwSwirl:0.2,bwVig:0.45,bwGrain:0.6,bwDust:0.25,bwScratch:0.1,bwStain:0.35,bwSilver:0.1},
    ortho:     {bwSens:1,bwIso:50,bwFormat:1,bwExpo:0,bwContrast:1.1,bwTone:1,bwToneAmt:0.8,bwFade:0.3,bwHalation:0.15,bwHaloR:0.5,bwSoft:0.02,bwSwirl:0.1,bwVig:0.4,bwGrain:0.9,bwDust:0.2,bwScratch:0.1,bwStain:0.2,bwSilver:0},
    silent:    {bwSens:1,bwIso:40,bwFormat:2,bwExpo:0,bwContrast:1.2,bwTone:0,bwToneAmt:1,bwFade:0.25,bwHalation:0.2,bwHaloR:0.4,bwSoft:0.02,bwSwirl:0,bwVig:0.45,bwGrain:1.4,bwDust:0.45,bwScratch:0.35,bwStain:0,bwSilver:0,bwWeave:0.6,bwFlicker:0.4,bwFps:2},
    pan:       {bwSens:2,bwIso:400,bwFormat:2,bwExpo:0,bwContrast:1.05,bwTone:0,bwToneAmt:1,bwFade:0,bwHalation:0.05,bwHaloR:0.3,bwSoft:0.01,bwSwirl:0,bwVig:0.25,bwGrain:1.1,bwDust:0.1,bwScratch:0,bwStain:0,bwSilver:0},
    selenium:  {bwSens:2,bwIso:100,bwFormat:1,bwExpo:0,bwContrast:1.15,bwTone:2,bwToneAmt:0.7,bwFade:0,bwHalation:0.03,bwHaloR:0.3,bwSoft:0.006,bwSwirl:0,bwVig:0.15,bwGrain:0.8,bwDust:0.05,bwScratch:0,bwStain:0,bwSilver:0},
    cyanotype: {bwSens:0,bwIso:25,bwFormat:1,bwExpo:0,bwContrast:1.0,bwTone:3,bwToneAmt:1,bwFade:0.15,bwHalation:0.1,bwHaloR:0.4,bwSoft:0.03,bwSwirl:0,bwVig:0.3,bwGrain:0.4,bwDust:0.1,bwScratch:0,bwStain:0.2,bwSilver:0}
  },
  digicam: {
    vga1998:  {dcRes:1,dcNoise:0.55,dcDR:6.5,dcExpo:0,dcWB:0.25,dcTint:0.1,dcSat:0.9,dcContrast:1.2,dcSoft:0.9,dcCA:1.2,dcFringe:0.5,dcVig:0.4,dcDistort:0.06,dcSharpen:0.5,dcNR:0.2,dcJpegQ:45,dcSubsample:2,dcStamp:1,dcDate:"'98 11 3",dcUpscale:1},
    mp1_2001: {dcRes:3,dcNoise:0.4,dcDR:7.2,dcExpo:0,dcWB:0.15,dcTint:0,dcSat:1.15,dcContrast:1.2,dcSoft:0.6,dcCA:0.9,dcFringe:0.6,dcVig:0.3,dcDistort:0.05,dcSharpen:1.0,dcNR:0.25,dcJpegQ:65,dcSubsample:2,dcStamp:0,dcDate:"'01 7 24",dcUpscale:1},
    mp2_2003: {dcRes:4,dcNoise:0.3,dcDR:7.6,dcExpo:0,dcWB:0.1,dcTint:0,dcSat:1.2,dcContrast:1.15,dcSoft:0.5,dcCA:0.7,dcFringe:0.45,dcVig:0.25,dcDistort:0.04,dcSharpen:0.9,dcNR:0.35,dcJpegQ:75,dcSubsample:2,dcStamp:0,dcDate:"'03 8 12",dcUpscale:1},
    keitai:   {dcRes:1,dcNoise:0.8,dcDR:5.8,dcExpo:0.2,dcWB:-0.1,dcTint:-0.3,dcSat:0.8,dcContrast:1.25,dcSoft:1.4,dcCA:0.6,dcFringe:0.3,dcVig:0.6,dcDistort:0.1,dcSharpen:0.6,dcNR:0.5,dcJpegQ:35,dcSubsample:2,dcStamp:0,dcDate:"'03 8 12",dcUpscale:1},
    webcam:   {dcRes:0,dcNoise:0.7,dcDR:6,dcExpo:0.3,dcWB:0.3,dcTint:0.2,dcSat:0.85,dcContrast:1.1,dcSoft:1.1,dcCA:0.5,dcFringe:0.2,dcVig:0.5,dcDistort:0.05,dcSharpen:0.3,dcNR:0.4,dcJpegQ:30,dcSubsample:2,dcStamp:0,dcDate:"'02 1 1",dcUpscale:1,dcFps:2}
  }
};

var FILM_MM = { f35:36, half:18, f110:17, f120:56, f16:10.26, s8:5.79, plate:127 };
var RES_W = { r320:320, r640:640, r1024:1024, r1280:1280, r1600:1600, r2048:2048 };
var FPS_OPT = { src:0, f30:30, f24:24, f18:18, f16:16, f15:15, f10:10 };

function defaults(){ var V = {}; for (var m in DEFS) DEFS[m].forEach(function(p){ V[p.k] = p.d; }); return V; }
function def(k){ for (var m in DEFS) for (var i = 0; i < DEFS[m].length; i++) if (DEFS[m][i].k === k) return DEFS[m][i]; return null; }

/* =========================================================================
   2. DSP — 帯域(MHz) から窓関数付き sinc の FIR 係数を作る
   ========================================================================= */
function sampleRateMHz(width){ return width / ACTIVE_LINE_US; }   // 1ライン = 52.6µs とみなす
function firLowpass(cutoffMHz, fsMHz, taps){
  taps = taps | 1;
  var fc = Math.max(0.0005, Math.min(cutoffMHz / fsMHz, 0.4995));
  var m = (taps - 1) / 2, h = new Float32Array(taps), sum = 0, i;
  for (i = 0; i < taps; i++){
    var n = i - m;
    var s = (n === 0) ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    var w = 0.42 - 0.5 * Math.cos(2*Math.PI*i/(taps-1)) + 0.08 * Math.cos(4*Math.PI*i/(taps-1)); // Blackman窓
    h[i] = s * w; sum += h[i];
  }
  for (i = 0; i < taps; i++) h[i] /= sum;   // DCゲイン=1
  return h;
}
function firResponse(h, fNorm){
  var m = (h.length - 1) / 2, re = 0, im = 0;
  for (var i = 0; i < h.length; i++){
    var a = -2 * Math.PI * fNorm * (i - m);
    re += h[i]*Math.cos(a); im += h[i]*Math.sin(a);
  }
  return Math.sqrt(re*re + im*im);
}
function tvLines(bwMHz){ return Math.round(bwMHz * ACTIVE_LINE_US * 2 * 0.75); } // 4:3の水平解像度(本)
function chromaStride(fs, bwC){ return Math.max(1, Math.min(32, Math.round(fs / Math.max(bwC * 6, 0.05)))); }

/* 疑似乱数（シード付き）。wear の傷など、CPU 側で決める配置に使う */
function rng(seed){ var s = (seed >>> 0) || 1; return function(){ s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/* =========================================================================
   3. シェーダ
   ========================================================================= */
var VS = '#version 300 es\nin vec2 a;out vec2 v;void main(){v=a*0.5+0.5;gl_Position=vec4(a,0,1);}';
var HEAD = '#version 300 es\nprecision highp float;in vec2 v;out vec4 o;uniform sampler2D u_tex;uniform vec2 u_texel;uniform vec2 u_size;\n';
var HASH = [
'float hash11(float p){p=fract(p*0.1031);p*=p+33.33;p*=p+p;return fract(p);}',
'float hash21(vec2 p){vec3 q=fract(vec3(p.xyx)*0.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}',
'vec3 s2l(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(0.04045,c));}',
'vec3 l2s(vec3 c){c=max(c,0.0);return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(0.0031308,c));}'
].join('\n');

/* ---- 既存（crt / vhs） ---- */
var FS_YIQ = HEAD + [
'void main(){vec3 c=texture(u_tex,v).rgb;',
'float y=dot(c,vec3(0.299,0.587,0.114));',
'float I=dot(c,vec3(0.5959,-0.2746,-0.3213));',
'float Q=dot(c,vec3(0.2115,-0.5227,0.3112));',
'o=vec4(y,I*0.7+0.5,Q*0.7+0.5,1.0);}'].join('\n');
var FS_YIQ2RGB = HEAD + [
'void main(){vec3 s=texture(u_tex,v).xyz;float I=(s.y-0.5)/0.7,Q=(s.z-0.5)/0.7;',
'o=vec4(clamp(vec3(s.x+0.956*I+0.619*Q,s.x-0.272*I-0.647*Q,s.x-1.106*I+1.703*Q),0.0,1.0),1.0);}'].join('\n');
var FS_HFIR = HEAD + [
'uniform float u_ty[33];uniform float u_tc[33];uniform int u_n;uniform float u_cs;',
'void main(){float m=float(u_n-1)*0.5;float y=0.0;vec2 c=vec2(0.0);',
'for(int i=0;i<33;i++){ if(i>=u_n) break; float d=float(i)-m;',
'  y+=texture(u_tex,vec2(v.x+d*u_texel.x,v.y)).x*u_ty[i];',
'  c+=texture(u_tex,vec2(v.x+d*u_cs*u_texel.x,v.y)).yz*u_tc[i];}',
'o=vec4(y,c,1.0);}'].join('\n');
var FS_TAPE = HEAD + HASH + '\n' + [
'uniform float u_time,u_frame,u_comb,u_preemp,u_lnoise,u_cnoise,u_ncorr;',
'uniform float u_jit,u_jitcorr,u_headsw,u_drop,u_track,u_dotcrawl,u_wclip,u_fscN;',
'void main(){float H=u_size.y,W=u_size.x;float line=floor(v.y*H);',
'float seedT=mix(u_frame,0.0,u_ncorr);',
'float slow=sin(line*0.021+u_time*3.1)*0.6+sin(line*0.0037+u_time*0.7)*0.4;',
'float rnd=hash21(vec2(line,u_frame))*2.0-1.0;',
'float jpx=u_jit*mix(rnd,slow,u_jitcorr)*3.0;',
'float fb=H-1.0-line;',
'float hs=u_headsw>0.0?clamp(1.0-fb/max(u_headsw,0.001),0.0,1.0):0.0;',
'jpx+=hs*hs*(10.0+18.0*hash11(u_frame));',
'float barY=fract(u_time*0.13);float barD=abs(fract(v.y-barY+0.5)-0.5);',
'float bar=u_track*(1.0-smoothstep(0.0,0.06,barD));',
'jpx+=bar*(hash21(vec2(line,u_frame*7.0))*2.0-1.0)*14.0;',
'vec2 uv=vec2(v.x+jpx*u_texel.x,v.y);',
'float seg=floor(v.x*16.0);',
'float dropped=step(hash21(vec2(line*13.0+seg,floor(u_frame*0.5))),u_drop*0.02);',
'uv.y-=dropped*u_texel.y;',
'vec3 s=texture(u_tex,uv).xyz;float y=s.x;vec2 c=s.yz;',
'vec2 cUp=texture(u_tex,uv-vec2(0.0,u_texel.y)).yz;',
'c=mix(c,(c+cUp)*0.5,u_comb);',
'float yl=texture(u_tex,uv-vec2(u_texel.x*2.0,0.0)).x;',
'float yr=texture(u_tex,uv+vec2(u_texel.x*2.0,0.0)).x;',
'y+=u_preemp*(y-(yl+yr)*0.5);',
'float t=0.75; if(y>t) y=t+(y-t)/(1.0+u_wclip*6.0*(y-t));',
'float camp=length(c-0.5);',
'float ph=6.2831853*(v.x*W*u_fscN)+3.14159*line+3.14159*u_frame;',
'y+=u_dotcrawl*camp*cos(ph)*0.35;',
'vec2 np=vec2(v.x*W,line+seedT*211.0);',
'float tri=hash21(np)-hash21(np-vec2(1.0,0.0));',
'y+=u_lnoise*tri*0.55;',
'c+=u_cnoise*vec2(hash21(np.yx*1.7)-0.5,hash21(np.yx*3.3)-0.5)*0.30*(0.3+camp*2.0);',
'y+=dropped*0.25+bar*0.12*(hash21(vec2(v.x*W,u_frame))-0.4);',
'float I=(c.x-0.5)/0.7,Q=(c.y-0.5)/0.7;',
'o=vec4(clamp(vec3(y+0.956*I+0.619*Q,y-0.272*I-0.647*Q,y-1.106*I+1.703*Q),0.0,1.0),1.0);}'].join('\n');
var FS_CRT = HEAD + [
'uniform vec2 u_res;uniform float u_lines,u_sigma,u_bloom,u_gamma,u_over,u_curve,u_conv;',
'uniform float u_maskType,u_pitch,u_maskAmt,u_inter,u_field;',
'vec2 warp(vec2 p,float k){p=p*2.0-1.0;p*=1.0+k*dot(p,p)*0.5;return p*0.5+0.5;}',
'vec3 lin3(vec3 c,float g){return vec3(pow(max(c.r,0.0),g),pow(max(c.g,0.0),g),pow(max(c.b,0.0),g));}',
'void main(){vec2 uv=warp(v,u_curve);float os=1.0-u_over*0.01;uv=(uv-0.5)/os+0.5;',
'if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){o=vec4(0,0,0,1);return;}',
'float cu=u_conv/u_res.x;vec3 acc=vec3(0.0);',
'if(u_lines<1.0){',
'  vec3 c=vec3(texture(u_tex,uv+vec2(cu,0)).r,texture(u_tex,uv).g,texture(u_tex,uv-vec2(cu,0)).b);',
'  acc=lin3(c,u_gamma);',
'}else{',
'  float ly=uv.y*u_lines;',
'  for(int k=-1;k<=1;k++){',
'    float row=floor(ly-0.5)+float(k)+0.5;float sy=row/u_lines;',
'    if(sy<0.0||sy>1.0) continue;',
'    if(u_inter>0.5&&abs(mod(row-0.5,2.0)-u_field)>0.5) continue;',
'    vec3 c=vec3(texture(u_tex,vec2(uv.x+cu,sy)).r,texture(u_tex,vec2(uv.x,sy)).g,texture(u_tex,vec2(uv.x-cu,sy)).b);',
'    vec3 L=lin3(c,u_gamma);',
'    float lum=dot(L,vec3(0.2126,0.7152,0.0722));',
'    float sg=u_sigma*(1.0+u_bloom*lum*1.6);',
'    float d=ly-0.5-row;',
'    acc+=L*exp(-0.5*(d/sg)*(d/sg))/(sg*2.5066);',
'  }',
'  if(u_inter>0.5) acc*=2.0;',
'}',
'vec3 mask=vec3(1.0);',
'if(u_maskType>0.5){',
'  float px=gl_FragCoord.x,py=gl_FragCoord.y,ph=u_pitch,ro=0.0,gate=1.0;',
'  if(u_maskType>1.5&&u_maskType<2.5){ro=mod(floor(py/(ph*2.0)),2.0)*1.5;gate=step(0.12,fract(py/(ph*2.0)));}',
'  if(u_maskType>2.5){ro=mod(floor(py/(ph*1.732)),2.0)*1.5;}',
'  float i=mod(floor(px/ph)+ro,3.0);',
'  mask=vec3(step(i,0.5),step(0.5,i)*step(i,1.5),step(1.5,i))*gate;',
'  mask=mix(vec3(1.0),mask*3.0,u_maskAmt)/(1.0+u_maskAmt*0.55);',
'}',
'o=vec4(acc*mask*0.5,1.0);}'].join('\n');
/* 分離ガウシアン（u_r = σ px）。17 タップで ±2σ を覆う */
var FS_BLUR = HEAD + [
'uniform vec2 u_dir;uniform float u_r;',
'void main(){float s=max(u_r,0.5);vec3 a=vec3(0.0);float w=0.0;',
'for(int i=-8;i<=8;i++){float d=float(i)*s/4.0;float g=exp(-0.5*(d/s)*(d/s));',
'a+=texture(u_tex,v+u_dir*d).rgb*g;w+=g;}o=vec4(a/w,1.0);}'].join('\n');
var FS_FINAL = HEAD + [
'uniform sampler2D u_halo;uniform sampler2D u_prev;',
'uniform float u_haloAmt,u_vig;uniform vec3 u_decay;',
'void main(){vec3 c=texture(u_tex,v).rgb*2.0+texture(u_halo,v).rgb*2.0*u_haloAmt;',
'vec2 d=v-0.5;c*=mix(1.0,clamp(1.0-dot(d,d)*2.2,0.0,1.0),u_vig);',
'vec3 p=pow(texture(u_prev,v).rgb,vec3(2.2));',
'c=max(c,p*u_decay);',
'o=vec4(pow(clamp(c,0.0,1.0),vec3(1.0/2.2)),1.0);}'].join('\n');
var FS_COPY = HEAD + 'void main(){o=texture(u_tex,v);}';

/* ---- 写真系の共通 ----
   光学系: 歪曲・倍率色収差・周辺減光・露出。出力はリニア光（half float）。
   u_mono=1 なら感色性 u_sens で 1 チャンネルにまとめる（白黒フィルム） */
var FS_OPTICS = HEAD + HASH + '\n' + [
'uniform float u_dist,u_ca,u_vig,u_expo,u_mono;uniform vec3 u_sens;uniform vec2 u_off;uniform vec4 u_crop;',
'vec2 warp(vec2 p,float k,float s){vec2 q=(p-0.5)*u_size/max(u_size.x,u_size.y);float r2=dot(q,q)*2.0;',
'  return 0.5+(p-0.5)*(1.0+k*r2)*s;}',
'void main(){vec2 p=v+u_off;',
'vec2 q=(p-0.5)*u_size/length(u_size)*2.0;float r2=dot(q,q);',   /* 対角の半分 = 1 */
'float sc=1.0/(1.0+max(u_dist,0.0)*0.5);',                         /* 樽型で四隅が欠けないよう少し拡大 */
'vec2 uvR=warp(p,u_dist,sc*(1.0+u_ca)),uvG=warp(p,u_dist,sc),uvB=warp(p,u_dist,sc*(1.0-u_ca));',
'vec2 m0=u_crop.xy,m1=u_crop.zw;',
'vec3 c=vec3(texture(u_tex,mix(m0,m1,uvR)).r,texture(u_tex,mix(m0,m1,uvG)).g,texture(u_tex,mix(m0,m1,uvB)).b);',
'vec3 L=s2l(c)*u_expo;',
'float vg=1.0/pow(1.0+u_vig*1.3*r2,2.0);',
'L*=vg;',
'if(u_mono>0.5){float y=dot(L,u_sens);L=vec3(y);}',
'o=vec4(L,1.0);}'].join('\n');

/* 位置で太さが変わる分離ガウシアン（レンズの甘さ＋四隅の流れ） */
var FS_VBLUR = HEAD + [
'uniform vec2 u_dir;uniform float u_s0,u_s1;',
'void main(){vec2 q=(v-0.5)*u_size/length(u_size)*2.0;float s=u_s0+u_s1*dot(q,q);',
'if(s<0.35){o=texture(u_tex,v);return;}',
'vec3 a=vec3(0.0);float w=0.0;',
'for(int i=-10;i<=10;i++){float d=float(i)*s/4.0;float g=exp(-0.5*(d/s)*(d/s));',
'a+=texture(u_tex,v+u_dir*d*u_texel).rgb*g;w+=g;}o=vec4(a/w,1.0);}'].join('\n');

/* 接線方向のぼけ（ペッツバール型レンズの周辺の「ぐるぐる」） */
var FS_SWIRL = HEAD + [
'uniform float u_amt;',
'void main(){vec2 q=(v-0.5)*u_size;float R=length(u_size)*0.5;float r=length(q)/R;',
'float L=u_amt*r*r*R*0.02;if(L<0.5){o=texture(u_tex,v);return;}',
'vec2 t=normalize(vec2(-q.y,q.x)+1e-6)*u_texel;vec3 a=vec3(0.0);float w=0.0;',
'for(int i=-8;i<=8;i++){float d=float(i)/8.0;float g=1.0-abs(d)*0.6;a+=texture(u_tex,v+t*d*L).rgb*g;w+=g;}',
'o=vec4(a/w,1.0);}'].join('\n');

/* 縮小（箱型の平均）。u_thr > 0 ならそれを超えた分だけ残す（ハイライトの抽出） */
var FS_DOWN = HEAD + [
'uniform vec2 u_srcTexel;uniform float u_k,u_thr;',
'void main(){vec3 a=vec3(0.0);float n=0.0;int K=int(clamp(u_k,1.0,8.0));',
'for(int j=0;j<8;j++){if(j>=K)break;for(int i=0;i<8;i++){if(i>=K)break;',
'  vec2 d=(vec2(float(i),float(j))+0.5-float(K)*0.5)*u_srcTexel*(u_k/float(K));',
'  vec3 c=texture(u_tex,v+d).rgb;a+=u_thr>0.0?max(c-u_thr,0.0):c;n+=1.0;}}',
'o=vec4(a/n,1.0);}'].join('\n');

/* 粒状のもと: 画素ごとに独立した分散 1 の雑音（RGB = 各色素層、A = 白黒・共通） */
var FS_NOISE = HEAD + HASH + '\n' + [
'uniform float u_seed;',
'float g(vec2 p){return (hash21(p)+hash21(p*1.37+11.3)+hash21(p*0.71+27.9)-1.5)*2.0;}',
'void main(){vec2 p=floor(gl_FragCoord.xy)+u_seed*61.7;',
'o=vec4(g(p),g(p+101.1),g(p+203.3),g(p+307.7));}'].join('\n');
/* 粒の大きさまでぼかす（整数タップのガウシアン）。重みの二乗和で割り、ぼかした後も分散 1 に保つ */
var FS_NBLUR = HEAD + [
'uniform float u_sig;uniform ivec2 u_d;',
'void main(){ivec2 p=ivec2(gl_FragCoord.xy),sz=textureSize(u_tex,0);int R=int(ceil(u_sig*3.0));vec4 a=vec4(0.0);float w2=0.0;',
'for(int i=-24;i<=24;i++){if(i<-R||i>R)continue;float w=exp(-0.5*float(i*i)/(u_sig*u_sig));',
'  a+=texelFetch(u_tex,clamp(p+u_d*i,ivec2(0),sz-1),0)*w;w2+=w*w;}',
'o=a/sqrt(w2);}'].join('\n');

/* 現像: 露光（＋ハレーション＋日付写し込み）→ 対数露光 → 特性曲線 → 粒状 → 調色・経年
   特性曲線はロジスティック。t は 18% グレーからの段数、出力は表示値（sRGB 相当） */
var FS_DEVELOP = HEAD + HASH + '\n' + [
'uniform sampler2D u_halo;uniform sampler2D u_stamp;uniform sampler2D u_noise;uniform float u_stampOn;',
'uniform float u_haloAmt,u_mono,u_sat,u_grainSig,u_grainColor,u_fade,u_toneAmt,u_flicker;',
'uniform vec3 u_haloCol,u_k,u_t0,u_floor,u_ceil,u_shadowCol,u_highCol,u_toneLo,u_toneHi,u_fadeCol;',
'void main(){vec3 e=texture(u_tex,v).rgb*u_flicker;',
'e+=texture(u_halo,v).rgb*u_haloAmt*u_haloCol;',
'if(u_stampOn>0.5){vec4 st=texture(u_stamp,v);e+=st.rgb*st.a*vec3(2.6,1.0,0.12);}',
'vec3 t=log2(max(e,vec3(1e-6))/0.18);',
'if(u_mono>0.5) t=vec3(t.x);',
'float m=dot(t,vec3(0.3333));t=m+(t-m)*u_sat;',     /* 色素の彩度（対数露光の上で） */
'vec4 nz=texelFetch(u_noise,ivec2(gl_FragCoord.xy),0);',
'vec3 n=u_mono>0.5?vec3(nz.a):(mix(vec3(nz.a),nz.rgb,u_grainColor)/sqrt(mix(1.0,1.0-2.0*u_grainColor*(1.0-u_grainColor),1.0)));',
't+=n*u_grainSig;',
'vec3 d=u_floor+(u_ceil-u_floor)/(1.0+exp(-u_k*(t-u_t0)));',
'd+=u_shadowCol*(1.0-d)*(1.0-d)+u_highCol*d*d;',
'if(u_mono>0.5){float y=d.x;vec3 tc=y*mix(u_toneLo,u_toneHi,y);d=mix(vec3(y),tc,u_toneAmt);}',
'd=mix(d,d*(1.0-0.28*u_fade)+0.1*u_fade+u_fadeCol*u_fade,step(0.001,u_fade));',
'o=vec4(clamp(d,0.0,1.0),1.0);}'].join('\n');

/* 仕上げ: ゴミ・傷・しみ・銀の浮き・インスタントの枠。u_img = 画像が入る範囲（キャンバス上の uv） */
var FS_FINISH = HEAD + HASH + '\n' + [
'uniform float u_dust,u_dustPol,u_dustSeed,u_stain,u_silver,u_frame,u_pxmm,u_seed;',
'uniform vec4 u_img;uniform vec4 u_scr[8];uniform float u_scrW[8];uniform int u_nscr;uniform float u_scrPol;',
'float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);',
'  return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),f.x),f.y);}',
/* オクターブごとに回転させて、格子に沿った角ばりを出さない */
'float fbm(vec2 p){mat2 R=mat2(0.8,0.6,-0.6,0.8);float a=vn(p)*0.5;p=R*p*2.1+7.3;a+=vn(p)*0.3;p=R*p*2.05+3.1;a+=vn(p)*0.2;return a;}',
'void main(){',
'vec2 iv=(v-u_img.xy)/(u_img.zw-u_img.xy);',
'bool inside=iv.x>=0.0&&iv.x<=1.0&&iv.y>=0.0&&iv.y<=1.0;',
'vec3 c;',
'if(inside){c=texture(u_tex,iv).rgb;',
'  vec2 isz=u_size*(u_img.zw-u_img.xy);vec2 px=iv*isz;',        /* 画像内の画素座標 */
'  float mm=1.0/max(u_pxmm,1e-3);',
/* ゴミ: 0.6 mm 格子に確率で 1 個、半径 0.02〜0.12 mm */
'  if(u_dust>0.0){float cell=0.6*u_pxmm;vec2 g=px/cell;vec2 id=floor(g);',
'    for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 cid=id+vec2(i,j);',
'      float h=hash21(cid+u_dustSeed*13.7);if(h>u_dust*0.07) continue;',
'      vec2 ctr=(cid+vec2(hash21(cid*1.3+u_dustSeed),hash21(cid*2.7+u_dustSeed)))*cell;',
'      float rad=(0.02+0.1*pow(hash21(cid*3.1+u_dustSeed),3.0))*u_pxmm;',
'      vec2 dd=px-ctr;dd.x*=1.0+hash21(cid*5.3)*1.5;',
'      float a=1.0-smoothstep(rad*0.6,rad+0.8,length(dd));',
'      c=mix(c,vec3(u_dustPol>0.0?0.97:0.03),a*0.9);}}',
/* 傷: 線分との距離 */
'  for(int k=0;k<8;k++){if(k>=u_nscr)break;vec2 a0=u_scr[k].xy*isz,a1=u_scr[k].zw*isz;',
'    vec2 pa=px-a0,ba=a1-a0;float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-6),0.0,1.0);',
'    float dl=length(pa-ba*h);float w=u_scrW[k]*u_pxmm;',
'    float a=(1.0-smoothstep(w*0.5,w*0.5+0.9,dl))*(0.55+0.45*vn(vec2(h*40.0,float(k))));',
'    c=mix(c,vec3(u_scrPol>0.0?0.95:0.05),a*0.8);}',
/* しみ（フォクシング・薬品むら）: 低周波の雲状ノイズ、縁に寄りやすい */
'  if(u_stain>0.0){vec2 e2=min(iv,1.0-iv);float edge=1.0-smoothstep(0.0,0.18,min(e2.x,e2.y));',
'    float f=fbm(px/(8.0*u_pxmm)+u_seed*3.1);float st=0.9-0.1*u_stain;float spots=smoothstep(st,st+0.04,fbm(px/(1.5*u_pxmm)+u_seed*7.7));',
'    float a=clamp((smoothstep(0.45,0.8,f)*edge*0.9+spots*0.45)*u_stain,0.0,1.0);',
'    c=mix(c,c*vec3(0.78,0.62,0.42),a);}',
/* 銀の浮き（ミラーリング）: 暗部の縁が青みの金属光沢に */
'  if(u_silver>0.0){vec2 e2=min(iv,1.0-iv);float edge=1.0-smoothstep(0.0,0.14,min(e2.x,e2.y));',
'    float f=smoothstep(0.3,0.85,fbm(px/(9.0*u_pxmm)+u_seed));float dark=1.0-dot(c,vec3(0.33));',
'    c=mix(c,vec3(0.55,0.6,0.68),clamp(edge*f*dark*u_silver,0.0,0.7));}',
'}else{',
/* インスタント写真の枠: わずかにざらついたオフホワイト、画像の縁に薄い影 */
'  vec2 px=v*u_size;float n=hash21(floor(px*0.7))*0.02;',
'  c=vec3(0.93,0.925,0.9)-n;',
'  vec2 dIn=max(u_img.xy-v,v-u_img.zw)*u_size;float dd=max(dIn.x,dIn.y);',
'  c*=1.0-0.12*exp(-dd/3.0);',
'}',
'o=vec4(c,1.0);}'].join('\n');

/* ---- デジカメ ----
   モザイク: センサーの画素数に縮小しながら、露出・飽和（チャンネルごとに頭打ち）・ノイズ・RGGB の取り出し */
var FS_MOSAIC = HEAD + HASH + '\n' + [
'uniform sampler2D u_fringe;uniform vec2 u_srcTexel;uniform float u_k,u_expo,u_read,u_shot,u_seed,u_fringeAmt;',
'void main(){vec3 a=vec3(0.0);float n=0.0;int K=int(clamp(u_k,1.0,6.0));',
'for(int j=0;j<6;j++){if(j>=K)break;for(int i=0;i<6;i++){if(i>=K)break;',
'  vec2 d=(vec2(float(i),float(j))+0.5-float(K)*0.5)*u_srcTexel*(u_k/float(K));a+=texture(u_tex,v+d).rgb;n+=1.0;}}',
'vec3 L=a/n*u_expo+texture(u_fringe,v).rgb*u_fringeAmt*vec3(0.55,0.08,1.0);',
'vec2 px=floor(gl_FragCoord.xy);int ix=int(mod(px.x,2.0)),iy=int(mod(px.y,2.0));',
'float s=(iy==1)?((ix==0)?L.r:L.g):((ix==0)?L.g:L.b);',   /* 上の行から R G / G B（GL は下から数えるので行を反転） */
'float sig=sqrt(u_read*u_read+u_shot*max(s,0.0));',
'float g=(hash21(px+u_seed*91.7)+hash21(px*1.37+u_seed*17.1)+hash21(px*0.71+u_seed*3.3)-1.5)*2.0;',
's=min(s+g*sig,1.0);',                                    /* 満杯になった画素は頭打ち */
'o=vec4(max(s,0.0),0.0,0.0,1.0);}'].join('\n');

/* 現像: 双一次補間でデモザイク → ホワイトバランス → 彩度 → ガンマとコントラスト */
var FS_DEMOSAIC = HEAD + [
'uniform vec3 u_wb;uniform float u_sat,u_contrast;',
'float S(ivec2 p){ivec2 sz=textureSize(u_tex,0);p=clamp(p,ivec2(0),sz-1);return texelFetch(u_tex,p,0).r;}',
'void main(){ivec2 p=ivec2(gl_FragCoord.xy);int ix=p.x&1,iy=p.y&1;vec3 c;',
'float C=S(p),N=S(p+ivec2(0,1)),Sx=S(p-ivec2(0,1)),E=S(p+ivec2(1,0)),Wx=S(p-ivec2(1,0));',
'float NE=S(p+ivec2(1,1)),NW=S(p+ivec2(-1,1)),SE=S(p+ivec2(1,-1)),SW=S(p+ivec2(-1,-1));',
'float cross4=(N+Sx+E+Wx)*0.25,diag4=(NE+NW+SE+SW)*0.25;',
'if(iy==1&&ix==0) c=vec3(C,cross4,diag4);',               /* R */
'else if(iy==0&&ix==1) c=vec3(diag4,cross4,C);',          /* B */
'else if(iy==1) c=vec3((E+Wx)*0.5,C,(N+Sx)*0.5);',        /* R 行の G */
'else c=vec3((N+Sx)*0.5,C,(E+Wx)*0.5);',                  /* B 行の G */
'c*=u_wb;',
'float y=dot(c,vec3(0.2126,0.7152,0.0722));c=max(y+(c-y)*u_sat,0.0);',
'vec3 s=mix(c*12.92,1.055*pow(max(c,0.0),vec3(1.0/2.4))-0.055,step(0.0031308,c));',
's=clamp(s,0.0,1.0);s=s+(u_contrast-1.0)*s*(1.0-s)*(s-0.5)*4.0;',
'o=vec4(clamp(s,0.0,1.0),1.0);}'].join('\n');

/* シャープネス（輝度のアンシャープマスク）と色ノイズの平滑化 */
var FS_SHARP = HEAD + [
'uniform float u_amt,u_nr;',
'vec3 toY(vec3 c){return vec3(dot(c,vec3(0.299,0.587,0.114)),dot(c,vec3(-0.1687,-0.3313,0.5)),dot(c,vec3(0.5,-0.4187,-0.0813)));}',
'vec3 toR(vec3 y){return vec3(y.x+1.402*y.z,y.x-0.3441*y.y-0.7141*y.z,y.x+1.772*y.y);}',
'void main(){vec3 c=toY(texture(u_tex,v).rgb);float b=0.0;vec2 ch=vec2(0.0);float w=0.0;',
'for(int j=-2;j<=2;j++)for(int i=-2;i<=2;i++){vec3 s=toY(texture(u_tex,v+vec2(i,j)*u_texel).rgb);',
'  if(abs(i)<=1&&abs(j)<=1) b+=s.x/9.0; ch+=s.yz;w+=1.0;}',
'c.x+=u_amt*(c.x-b);c.yz=mix(c.yz,ch/w,u_nr);',
'o=vec4(clamp(toR(c),0.0,1.0),1.0);}'].join('\n');

/* =========================================================================
   4. 昔のネット・デジカメの JPEG — CPU の量子化
      パレット/ディザは当時の実装どおり sRGB のガンマ空間で行う
   ========================================================================= */
var BAYER4 = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
var BAYER8 = (function(){
  var m = BAYER4, n = 4, out = new Array(64);
  for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++){
    var q = (y < n ? 0 : 2) + (x < n ? 0 : 1);
    out[y*8+x] = m[(y % n)*n + (x % n)] * 4 + [0, 2, 3, 1][q];
  }
  return out;
})();
function websafePalette(){
  var p = [], L = [0,51,102,153,204,255];
  for (var r=0;r<6;r++) for (var g=0;g<6;g++) for (var b=0;b<6;b++) p.push(L[r],L[g],L[b]);
  return new Uint8Array(p);
}
function grayPalette(n){
  var p = new Uint8Array(n*3);
  for (var i=0;i<n;i++){ var v = Math.round(i*255/(n-1)); p[i*3]=p[i*3+1]=p[i*3+2]=v; }
  return p;
}
function medianCut(data, n){
  var px = [], step = Math.max(1, Math.floor(data.length / 4 / 20000));
  for (var i = 0; i < data.length; i += 4*step) px.push([data[i],data[i+1],data[i+2]]);
  var boxes = [px];
  while (boxes.length < n){
    var bi = -1, best = -1, j, c, q;
    for (var b = 0; b < boxes.length; b++){
      if (boxes[b].length < 2) continue;
      var mn=[255,255,255], mx=[0,0,0];
      for (j=0;j<boxes[b].length;j++) for (c=0;c<3;c++){ q=boxes[b][j][c]; if(q<mn[c])mn[c]=q; if(q>mx[c])mx[c]=q; }
      var range = Math.max(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]) * boxes[b].length;
      if (range > best){ best = range; bi = b; }
    }
    if (bi < 0) break;
    var box = boxes[bi], mn2=[255,255,255], mx2=[0,0,0];
    for (j=0;j<box.length;j++) for (c=0;c<3;c++){ q=box[j][c]; if(q<mn2[c])mn2[c]=q; if(q>mx2[c])mx2[c]=q; }
    var ch = 0, sp = mx2[0]-mn2[0];
    if (mx2[1]-mn2[1] > sp){ ch = 1; sp = mx2[1]-mn2[1]; }
    if (mx2[2]-mn2[2] > sp){ ch = 2; }
    box.sort(function(a,bb){ return a[ch]-bb[ch]; });
    var half = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, half), box.slice(half));
  }
  var pal = new Uint8Array(boxes.length*3);
  for (b = 0; b < boxes.length; b++){
    var s=[0,0,0]; for (j=0;j<boxes[b].length;j++) for (c=0;c<3;c++) s[c]+=boxes[b][j][c];
    var L = Math.max(1, boxes[b].length);
    pal[b*3]=s[0]/L|0; pal[b*3+1]=s[1]/L|0; pal[b*3+2]=s[2]/L|0;
  }
  return pal;
}
function buildCube(pal){
  var cube = new Uint8Array(32*32*32), n = pal.length/3;
  for (var r=0;r<32;r++) for (var g=0;g<32;g++) for (var b=0;b<32;b++){
    var R=r*8+4, G=g*8+4, B=b*8+4, bi=0, bd=1e9;
    for (var i=0;i<n;i++){
      var dr=R-pal[i*3], dg=G-pal[i*3+1], db=B-pal[i*3+2];
      var d=dr*dr*0.30+dg*dg*0.59+db*db*0.11;
      if (d<bd){ bd=d; bi=i; }
    }
    cube[(r<<10)|(g<<5)|b] = bi;
  }
  return cube;
}
function quantize(img, palType, colors, dither, amt){
  var d = img.data, w = img.width, h = img.height;
  if (palType === 0) return;
  var pal, cube, i, x, y;
  if (palType === 1){ pal = websafePalette(); }
  else if (palType === 3){ pal = grayPalette(Math.max(2, colors)); }
  else { pal = medianCut(d, Math.max(2, colors)); }
  cube = buildCube(pal);
  function near(r,g,b){
    r = r<0?0:r>255?255:r; g = g<0?0:g>255?255:g; b = b<0?0:b>255?255:b;
    return cube[((r>>3)<<10)|((g>>3)<<5)|(b>>3)] * 3;
  }
  var step = 255 / Math.max(2, (palType===1?6:Math.cbrt(pal.length/3)));
  if (dither === 1 || dither === 2){
    var M = dither===1?BAYER4:BAYER8, N = dither===1?4:8, den = N*N;
    for (y=0;y<h;y++) for (x=0;x<w;x++){
      i=(y*w+x)*4; var t=(M[(y%N)*N+(x%N)]/den - 0.5)*step*amt;
      var p=near(d[i]+t, d[i+1]+t, d[i+2]+t);
      d[i]=pal[p]; d[i+1]=pal[p+1]; d[i+2]=pal[p+2];
    }
  } else if (dither === 3 || dither === 4){
    var buf = new Float32Array(w*h*3);
    for (i=0;i<w*h;i++){ buf[i*3]=d[i*4]; buf[i*3+1]=d[i*4+1]; buf[i*3+2]=d[i*4+2]; }
    var sp = dither===4 ? [[1,0,0.125],[2,0,0.125],[-1,1,0.125],[0,1,0.125],[1,1,0.125],[0,2,0.125]]
                        : [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]];
    for (y=0;y<h;y++){
      var rev = (y & 1) === 1, x0 = rev ? w-1 : 0, x1 = rev ? -1 : w, dx = rev ? -1 : 1;
      for (x=x0; x!==x1; x+=dx){
        var o3=(y*w+x)*3, R=buf[o3], G=buf[o3+1], B=buf[o3+2];
        var p2=near(R,G,B), nr=pal[p2], ng=pal[p2+1], nb=pal[p2+2];
        var er=(R-nr)*amt, eg=(G-ng)*amt, eb=(B-nb)*amt;
        buf[o3]=nr; buf[o3+1]=ng; buf[o3+2]=nb;
        for (var s=0;s<sp.length;s++){
          var nx=x+sp[s][0]*dx, ny=y+sp[s][1];
          if (nx<0||nx>=w||ny>=h) continue;
          var no=(ny*w+nx)*3, k=sp[s][2];
          buf[no]+=er*k; buf[no+1]+=eg*k; buf[no+2]+=eb*k;
        }
      }
    }
    for (i=0;i<w*h;i++){ d[i*4]=buf[i*3]; d[i*4+1]=buf[i*3+1]; d[i*4+2]=buf[i*3+2]; }
  } else {
    for (i=0;i<w*h;i++){ var qq=near(d[i*4],d[i*4+1],d[i*4+2]); d[i*4]=pal[qq]; d[i*4+1]=pal[qq+1]; d[i*4+2]=pal[qq+2]; }
  }
}
/* JPEG: 8×8 DCT + IJG 標準量子化テーブル（libjpeg と同じ品質の決め方） */
var QY = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,
          14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,
          49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
var QC = [17,18,24,47,99,99,99,99,18,21,26,66,99,99,99,99,24,26,56,99,99,99,99,99,
          47,66,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,
          99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99];
var COS = (function(){ var c = new Float32Array(64);
  for (var u=0;u<8;u++) for (var x=0;x<8;x++) c[u*8+x] = Math.cos((2*x+1)*u*Math.PI/16) * (u===0?Math.SQRT1_2:1) * 0.5;
  return c; })();
function scaleTable(base, q){
  var s = q < 50 ? 5000/q : 200 - 2*q, t = new Float32Array(64);
  for (var i=0;i<64;i++) t[i] = Math.max(1, Math.min(255, Math.floor((base[i]*s + 50)/100)));
  return t;
}
function dctQuantPlane(pl, w, h, tbl, ox, oy){
  var blk = new Float32Array(64), tmp = new Float32Array(64);
  for (var by = -oy; by < h; by += 8) for (var bx = -ox; bx < w; bx += 8){
    var x, y, u, i, s, sx, sy;
    for (y=0;y<8;y++) for (x=0;x<8;x++){
      sx = Math.min(w-1, Math.max(0, bx+x)); sy = Math.min(h-1, Math.max(0, by+y));
      blk[y*8+x] = pl[sy*w+sx] - 128;
    }
    for (y=0;y<8;y++) for (u=0;u<8;u++){ s=0; for (x=0;x<8;x++) s+=blk[y*8+x]*COS[u*8+x]; tmp[y*8+u]=s; }
    for (x=0;x<8;x++) for (u=0;u<8;u++){ s=0; for (y=0;y<8;y++) s+=tmp[y*8+x]*COS[u*8+y]; blk[u*8+x]=s; }
    for (i=0;i<64;i++) blk[i] = Math.round(blk[i]/tbl[i]) * tbl[i];
    for (y=0;y<8;y++) for (u=0;u<8;u++){ s=0; for (x=0;x<8;x++) s+=blk[y*8+x]*COS[x*8+u]; tmp[y*8+u]=s; }
    for (x=0;x<8;x++) for (u=0;u<8;u++){ s=0; for (y=0;y<8;y++) s+=tmp[y*8+x]*COS[y*8+u]; blk[u*8+x]=s; }
    for (y=0;y<8;y++) for (x=0;x<8;x++){
      sx = bx+x; sy = by+y; if (sx<0||sy<0||sx>=w||sy>=h) continue;
      pl[sy*w+sx] = blk[y*8+x] + 128;
    }
  }
}
function subsample(pl, w, h, sx, sy){
  if (sx===1 && sy===1) return;
  for (var y=0;y<h;y+=sy) for (var x=0;x<w;x+=sx){
    var s=0,n=0,i,j;
    for (j=0;j<sy && y+j<h;j++) for (i=0;i<sx && x+i<w;i++){ s+=pl[(y+j)*w+x+i]; n++; }
    s/=n;
    for (j=0;j<sy && y+j<h;j++) for (i=0;i<sx && x+i<w;i++) pl[(y+j)*w+x+i]=s;
  }
}
function jpegSim(img, q, sub, passes, shift){
  var d = img.data, w = img.width, h = img.height, n = w*h, i;
  var Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (i=0;i<n;i++){
    var r=d[i*4], g=d[i*4+1], b=d[i*4+2];
    Y[i]  =  0.299*r + 0.587*g + 0.114*b;
    Cb[i] = -0.168736*r - 0.331264*g + 0.5*b + 128;
    Cr[i] =  0.5*r - 0.418688*g - 0.081312*b + 128;
  }
  var ty = scaleTable(QY, q), tc = scaleTable(QC, q);
  var sx = sub===0?1:2, sy = sub===2?2:1;
  for (var p=0;p<passes;p++){
    var ox = p===0 ? shift : 0, oy = p===0 ? shift : 0;
    subsample(Cb, w, h, sx, sy); subsample(Cr, w, h, sx, sy);
    dctQuantPlane(Y, w, h, ty, ox, oy);
    dctQuantPlane(Cb, w, h, tc, ox, oy);
    dctQuantPlane(Cr, w, h, tc, ox, oy);
  }
  for (i=0;i<n;i++){
    var yy=Y[i], cb=Cb[i]-128, cr=Cr[i]-128;
    d[i*4]   = Math.max(0, Math.min(255, yy + 1.402*cr));
    d[i*4+1] = Math.max(0, Math.min(255, yy - 0.344136*cb - 0.714136*cr));
    d[i*4+2] = Math.max(0, Math.min(255, yy + 1.772*cb));
  }
}

/* ---- 日付の写し込み（7 セグメントの数字を描く） ---- */
var SEG = { "0":"abcdef","1":"bc","2":"abged","3":"abgcd","4":"fgbc","5":"afgcd","6":"afgedc","7":"abc","8":"abcdefg","9":"abcfgd","-":"g" };
function drawStamp(ctx, text, W, H, color, glow){
  var hgt = Math.max(8, Math.round(Math.min(W, H) * 0.045)), w = hgt * 0.55, th = Math.max(1.2, hgt * 0.12), gap = hgt * 0.22, sl = 0.12;
  var chars = String(text || "").slice(0, 16).split(""), total = 0;
  chars.forEach(function(c){ total += c === " " ? w * 0.6 : c === "'" ? w * 0.35 : w + gap; });
  var x = W - total - W * 0.06, y0 = H - H * 0.07 - hgt;
  ctx.save(); ctx.fillStyle = color;
  if (glow){ ctx.shadowColor = color; ctx.shadowBlur = hgt * 0.15; }
  function seg(x1, y1, x2, y2){   // 斜体にした太い線分
    var sx1 = x1 + (y0 + hgt - y1) * sl, sx2 = x2 + (y0 + hgt - y2) * sl;
    ctx.beginPath(); ctx.lineCap = "round"; ctx.lineWidth = th; ctx.strokeStyle = color;
    ctx.moveTo(sx1, y1); ctx.lineTo(sx2, y2); ctx.stroke();
  }
  chars.forEach(function(c){
    if (c === " "){ x += w * 0.6; return; }
    if (c === "'"){ seg(x + w * 0.15, y0, x + w * 0.05, y0 + hgt * 0.22); x += w * 0.35; return; }
    var s = SEG[c] || "", m = th * 0.5, xl = x + m, xr = x + w - m, yt = y0 + m, ym = y0 + hgt / 2, yb = y0 + hgt - m;
    if (s.indexOf("a") >= 0) seg(xl + m, yt, xr - m, yt);
    if (s.indexOf("b") >= 0) seg(xr, yt + m, xr, ym - m);
    if (s.indexOf("c") >= 0) seg(xr, ym + m, xr, yb - m);
    if (s.indexOf("d") >= 0) seg(xl + m, yb, xr - m, yb);
    if (s.indexOf("e") >= 0) seg(xl, ym + m, xl, yb - m);
    if (s.indexOf("f") >= 0) seg(xl, yt + m, xl, ym - m);
    if (s.indexOf("g") >= 0) seg(xl + m, ym, xr - m, ym);
    x += w + gap;
  });
  ctx.restore();
}

/* =========================================================================
   5. モードごとの物理量（CPU 側で計算してシェーダに渡す）
   ========================================================================= */
/* フィルムの種類ごとの特性。k = 特性曲線の傾き（段あたり）、floor/ceil = 最も黒い・白い表示値 */
var STOCK = {
  neg:     { k:0.9,  floor:0.035, ceil:0.975, halo:[1.0,0.32,0.06] },
  slide:   { k:1.3,  floor:0.012, ceil:0.985, halo:[1.0,0.35,0.08] },
  instant: { k:0.78, floor:0.09,  ceil:0.91,  halo:[1.0,0.4,0.12] }
};
/* 感色性（リニア RGB の重み）。RGB からの近似 */
var SENS = { blue:[0.0,0.07,0.93], ortho:[0.02,0.45,0.53], pan:[0.24,0.52,0.24] };
/* 調色: 暗部の色と明部の色（表示値に掛ける） */
var TONE = {
  neutral:  [[1,1,1],[1,1,1]],
  sepia:    [[0.78,0.52,0.32],[1.0,0.95,0.84]],
  selenium: [[0.72,0.58,0.62],[1.0,0.99,0.97]],
  cyanotype:[[0.12,0.3,0.62],[0.93,0.97,1.0]],
  tintype:  [[0.55,0.5,0.44],[0.86,0.83,0.76]],
  albumen:  [[0.72,0.45,0.36],[1.0,0.93,0.78]]
};
/* 粒状: 48 µm の開口で測った RMS 濃度（感度から）→ 画素の大きさへ Selwyn の法則で換算し、対数露光（段）に直す */
function grainParams(iso, frameMm, W, amt, mono){
  var pixUm = frameMm * 1000 / Math.max(1, W);
  var cellUm = 4 + 3 * Math.sqrt(Math.max(iso, 1) / 100);
  var sig48 = (mono ? 0.008 : 0.007) * Math.pow(Math.max(iso, 1) / 100, 0.45);
  var sigD = sig48 * 48 / Math.max(pixUm, cellUm);
  var gammaNeg = 0.65;
  return { stops: sigD / (gammaNeg * 0.30103) * amt, cellPx: cellUm / pixUm, pixUm: pixUm, sigD: sigD };
}
function fpsOf(mode, V){
  var k = mode === "film" ? "filmFps" : mode === "bw" ? "bwFps" : mode === "digicam" ? "dcFps" : null;
  return k ? FPS_OPT[def(k).o[V[k]]] || 0 : 0;
}

/* =========================================================================
   6. エンジン
   ========================================================================= */
function create(canvas){
  var gl = canvas.getContext("webgl2", { preserveDrawingBuffer:true, antialias:false, alpha:false });
  if (!gl) return null;
  var half = !!gl.getExtension("EXT_color_buffer_float");
  var quad = gl.createVertexArray(); gl.bindVertexArray(quad);
  var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  var uniCache = new WeakMap();
  function sh(type, src){
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function prog(fs){
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "a"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    uniCache.set(p, {}); return p;
  }
  var P = {
    yiq:prog(FS_YIQ), hfir:prog(FS_HFIR), tape:prog(FS_TAPE), y2r:prog(FS_YIQ2RGB), crt:prog(FS_CRT),
    blur:prog(FS_BLUR), fin:prog(FS_FINAL), copy:prog(FS_COPY),
    optics:prog(FS_OPTICS), vblur:prog(FS_VBLUR), swirl:prog(FS_SWIRL), down:prog(FS_DOWN),
    develop:prog(FS_DEVELOP), noise:prog(FS_NOISE), nblur:prog(FS_NBLUR), finish:prog(FS_FINISH), mosaic:prog(FS_MOSAIC), demosaic:prog(FS_DEMOSAIC), sharp:prog(FS_SHARP)
  };
  function uloc(p, n){ var c = uniCache.get(p); if (!(n in c)) c[n] = gl.getUniformLocation(p, n); return c[n]; }
  function tex(filter, mip){
    var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : (filter || gl.LINEAR));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    return t;
  }
  function target(w, h, hdr, filter){
    var t = tex(filter);
    if (hdr && half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex:t, fb:f, w:w, h:h };
  }
  function free(t){ if (t){ gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }
  var pool = {};   // 名前 → target。大きさや種類が変われば作り直す
  function tg(name, w, h, hdr, filter){
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    var t = pool[name], key = w + "x" + h + (hdr ? "f" : "b") + (filter || 0);
    if (t && t.key === key) return t;
    free(t); t = target(w, h, hdr, filter); t.key = key; pool[name] = t; return t;
  }
  function T(t){ return { __tex:t }; }
  function pass(p, uni, dst){
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : canvas.width, dst ? dst.h : canvas.height);
    gl.useProgram(p);
    var unit = 0;
    for (var k in uni){
      var val = uni[k], l = uloc(p, k);
      if (l == null) continue;
      if (val && val.__tex){ gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, val.__tex); gl.uniform1i(l, unit); unit++; }
      else if (val instanceof Float32Array) gl.uniform1fv(l, val);
      else if (val && val.vec4) gl.uniform4fv(l, val.vec4);
      else if (val && val.ivec2) gl.uniform2i(l, val.ivec2[0], val.ivec2[1]);
      else if (Array.isArray(val)){ if (val.length===2) gl.uniform2f(l,val[0],val[1]); else if (val.length===3) gl.uniform3f(l,val[0],val[1],val[2]); else gl.uniform4f(l,val[0],val[1],val[2],val[3]); }
      else if (typeof val === "number"){ if (k === "u_n" || k === "u_nscr") gl.uniform1i(l, val); else gl.uniform1f(l, val); }
    }
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ---- 元画像 ---- */
  var srcTex = tex(gl.LINEAR, true), src = null, srcW = 1, srcH = 1, srcMip = false;
  var cpuCv = document.createElement("canvas"), cpuCtx = cpuCv.getContext("2d", { willReadFrequently:true });
  var cpuTex = tex(gl.LINEAR), stampCv = document.createElement("canvas"), stampCtx = stampCv.getContext("2d"), stampTex = tex(gl.LINEAR), stampKey = "";
  var emptyTex = tex(gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, emptyTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

  /* static = 静止画（1 回だけ送り、縮小用のミップマップを作る）。映像は毎フレーム送る */
  function upload(el, w, h, isStatic){
    // ImageBitmap は UNPACK_FLIP_Y_WEBGL が効かない（WebGL の仕様）ので、キャンバスに描いてから送る
    if (typeof ImageBitmap !== "undefined" && el instanceof ImageBitmap){
      var c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(el, 0, 0, w, h); el = c;
    }
    src = el; srcW = w; srcH = h;
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    srcMip = !!isStatic;
    if (srcMip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, srcMip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  }
  function uploadCanvas(t, cv, filter){
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  /* 描画結果を CPU に読む（上下を反転して ImageData に） */
  function readTarget(t){
    var n = t.w * t.h * 4, buf = new Uint8Array(n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    var img = new ImageData(t.w, t.h), row = t.w * 4;
    for (var y = 0; y < t.h; y++) img.data.set(buf.subarray((t.h - 1 - y) * row, (t.h - y) * row), y * row);
    return img;
  }

  /* 信号系の処理サイズ（横 1024 まで） */
  function signalSize(W, H){ var s = Math.min(1, REF_W / W); return { w: Math.max(2, Math.round(W * s)), h: Math.max(2, Math.round(H * s)) }; }

  /* ---- CRT / VHS / 昔のネット ---- */
  var prevIdx = 0;
  function firUniforms(bwY, bwC, taps, sw){
    var fs = sampleRateMHz(sw), stride = chromaStride(fs, bwC);
    var ty = firLowpass(bwY, fs, taps), tcv = firLowpass(bwC, fs / stride, taps);
    var A = new Float32Array(33), B = new Float32Array(33); A.set(ty); B.set(tcv);
    return { u_ty:A, u_tc:B, u_n:taps, u_cs:stride, _fs:fs };
  }
  function renderVHS(V, o, W, H){
    var s = signalSize(W, H), texel = [1/s.w, 1/s.h], size = [s.w, s.h];
    var f = firUniforms(V.vhsLumaBw, V.vhsChromaBw/1000, 25, s.w);
    var a = tg("a", s.w, s.h), b = tg("b", s.w, s.h), c = tg("c", s.w, s.h), d = tg("d", s.w, s.h);
    var cur = srcTex, gen = Math.round(V.vhsGen);
    for (var g = 0; g < gen; g++){
      pass(P.yiq, {u_tex:T(cur), u_texel:texel, u_size:size}, a);
      pass(P.hfir, {u_tex:T(a.tex), u_texel:texel, u_size:size, u_ty:f.u_ty, u_tc:f.u_tc, u_n:f.u_n, u_cs:f.u_cs}, b);
      pass(P.tape, {u_tex:T(b.tex), u_texel:texel, u_size:size, u_time:o.time, u_frame:o.frame + g*97,
        u_comb:V.vhsComb, u_preemp:V.vhsPreemp, u_lnoise:V.vhsLumaNoise, u_cnoise:V.vhsChromaNoise, u_ncorr:V.vhsNoiseCorr,
        u_jit:V.vhsJitter, u_jitcorr:V.vhsJitterCorr, u_headsw:V.vhsHeadSw, u_drop:V.vhsDropout, u_track:V.vhsTracking,
        u_dotcrawl:V.vhsDotCrawl, u_wclip:V.vhsWhiteClip, u_fscN:FSC/f._fs}, c);
      cur = c.tex;
      if (g < gen-1){ pass(P.copy, {u_tex:T(cur)}, d); cur = d.tex; }
    }
    pass(P.copy, {u_tex:T(cur)}, null);
  }
  function renderCRT(V, o, W, H){
    var s = signalSize(W, H), texel = [1/s.w, 1/s.h], size = [s.w, s.h], px = W / s.w;   // 画素単位の値は信号幅 1024 を基準に拡大
    var cbw = V.crtInput === 0 ? 0.6 : V.crtInput === 1 ? 1.3 : V.crtHbw;
    var fc = firUniforms(V.crtHbw, cbw, 25, s.w);
    var a = tg("a", s.w, s.h), b = tg("b", s.w, s.h), c = tg("c", s.w, s.h);
    var d = tg("crt_d", W, H), e = tg("crt_e", W, H), f = tg("crt_f", W, H), p0 = tg("p0", W, H), p1 = tg("p1", W, H);
    pass(P.yiq, {u_tex:T(srcTex), u_texel:texel, u_size:size}, a);
    pass(P.hfir, {u_tex:T(a.tex), u_texel:texel, u_size:size, u_ty:fc.u_ty, u_tc:fc.u_tc, u_n:fc.u_n, u_cs:fc.u_cs}, b);
    pass(P.y2r, {u_tex:T(b.tex), u_texel:texel, u_size:size}, c);
    var lines = V.crtScan === 0 ? 240 : V.crtScan === 1 ? 480 : 0;
    pass(P.crt, {u_tex:T(c.tex), u_texel:[1/W,1/H], u_size:[W,H], u_res:[W,H], u_lines:lines, u_sigma:V.crtSigma, u_bloom:V.crtBloom,
      u_gamma:V.crtGamma, u_over:V.crtOverscan, u_curve:V.crtCurve, u_conv:V.crtConv*px, u_maskType:V.crtMask, u_pitch:V.crtPitch*px,
      u_maskAmt:V.crtMaskAmt, u_inter:V.crtScan===1?1:0, u_field:o.frame % 2}, d);
    pass(P.blur, {u_tex:T(d.tex), u_dir:[1/W,0], u_r:V.crtHaloR*px}, e);
    pass(P.blur, {u_tex:T(e.tex), u_dir:[0,1/H], u_r:V.crtHaloR*px}, f);
    var prev = prevIdx ? p1 : p0, next = prevIdx ? p0 : p1, p = o.video ? V.crtPersist : 0;
    pass(P.fin, {u_tex:T(d.tex), u_halo:T(f.tex), u_prev:T(prev.tex), u_haloAmt:V.crtHalo, u_vig:V.crtVig,
      u_decay:[Math.pow(p,0.75), Math.pow(p,1.0), Math.pow(p,1.5)]}, next);
    pass(P.copy, {u_tex:T(next.tex)}, null);
    prevIdx ^= 1;
  }
  function renderNet(V, W, H){
    var s = signalSize(W, H), sc = Math.max(0.05, V.netScale/100);
    var sw = Math.max(8, Math.round(s.w*sc)), shh = Math.max(8, Math.round(s.h*sc));
    if (cpuCv.width !== sw || cpuCv.height !== shh){ cpuCv.width = sw; cpuCv.height = shh; }
    cpuCtx.imageSmoothingEnabled = true; cpuCtx.imageSmoothingQuality = "high";
    cpuCtx.drawImage(src, 0, 0, sw, shh);
    var img = cpuCtx.getImageData(0, 0, sw, shh);
    if (V.netCodec === 1) jpegSim(img, V.netJpegQ, V.netSubsample, Math.round(V.netPasses), Math.round(V.netBlockShift));
    quantize(img, V.netPalette, Math.round(V.netColors), V.netDither, V.netDitherAmt);
    cpuCtx.putImageData(img, 0, 0);
    uploadCanvas(cpuTex, cpuCv, V.netUpscale === 0 ? gl.NEAREST : gl.LINEAR);
    pass(P.copy, {u_tex:T(cpuTex)}, null);
  }

  /* ---- フィルム・白黒 ---- */
  function filmFrameLayout(V, W, H){
    // インスタント写真: 画面 79×77 mm、枠 88×107 mm（下が広い）。画像は 79:77 に中央を切り抜く
    var cropW = Math.min(W, H * 79 / 77), cropH = cropW * 77 / 79, fw = cropW * 88 / 79, fh = fw * 107 / 88;
    return { w: Math.round(fw), h: Math.round(fh), cropW: cropW, cropH: cropH,
      img: [4.5/88, (107-6-77)/107, (4.5+79)/88, (107-6)/107] };   // uv（下が 0）
  }
  function scratchLines(n, seed, vertical, frame){
    var r = rng(seed * 7919 + 13), out = new Float32Array(32), wd = new Float32Array(8), k = 0;
    for (var i = 0; i < n && k < 8; i++, k++){
      if (vertical){   // 映写機の縦傷: 位置がゆっくり揺れ、ときどき入れ替わる
        var life = Math.floor((frame + i * 37) / 60), rr = rng(life * 131 + i * 17 + seed), x = rr() * 0.9 + 0.05 + Math.sin(frame * 0.07 + i) * 0.003;
        out.set([x, 0, x + (rr() - 0.5) * 0.01, 1], k * 4); wd[k] = 0.02 + rr() * 0.04;
      } else {
        var x0 = r(), y0 = r(), ang = r() * Math.PI, len = 0.1 + r() * 0.5;
        out.set([x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len], k * 4); wd[k] = 0.01 + r() * 0.03;
      }
    }
    return { lines: out, widths: wd, n: k };
  }
  function renderFilm(bw, V, o, W, H){
    var P_ = bw ? {
      iso:V.bwIso, fmt:def("bwFormat").o[V.bwFormat], expo:V.bwExpo, k:0.95 * V.bwContrast, sat:1, soft:V.bwSoft, corner:0, vig:V.bwVig,
      dist:0, halo:V.bwHalation, haloR:V.bwHaloR, grain:V.bwGrain, dust:V.bwDust, scratch:V.bwScratch, stain:V.bwStain, silver:V.bwSilver,
      weave:V.bwWeave, flicker:V.bwFlicker, stock:STOCK.neg, sens:SENS[def("bwSens").o[V.bwSens]]
    } : {
      iso:V.filmIso, fmt:def("filmFormat").o[V.filmFormat], expo:V.filmExpo, k:STOCK[def("filmStock").o[V.filmStock]].k * V.filmContrast,
      sat:V.filmSat, soft:V.filmSoft, corner:V.filmCorner, vig:V.filmVig, dist:V.filmDistort, halo:V.filmHalation, haloR:V.filmHaloR,
      grain:V.filmGrain, dust:V.filmDust, scratch:V.filmScratch, stain:0, silver:0, weave:V.filmWeave, flicker:V.filmFlicker,
      stock:STOCK[def("filmStock").o[V.filmStock]]
    };
    var frame = !bw && o.image && V.filmFrame === 1 ? filmFrameLayout(V, W, H) : null;
    // フレームあり: キャンバスは枠の大きさ。画像部分の処理サイズは切り抜いた大きさ
    var IW = frame ? Math.round(frame.cropW) : W, IH = frame ? Math.round(frame.cropH) : H;
    var crop = [0, 0, 1, 1];
    if (frame){ var cw = frame.cropW / W, ch = frame.cropH / H; crop = [(1 - cw) / 2, (1 - ch) / 2, (1 + cw) / 2, (1 + ch) / 2]; }
    var frameMm = FILM_MM[P_.fmt] || 36, pxmm = IW / frameMm;
    var A = tg("fa", IW, IH, true), B = tg("fb", IW, IH, true), C = tg("fc", IW, IH);
    var qw = Math.max(2, Math.round(IW / 4)), qh = Math.max(2, Math.round(IH / 4));
    var H1 = tg("fh1", qw, qh, true), H2 = tg("fh2", qw, qh, true);
    // 映像: 映写機・カメラのゲートの揺れ（フレームごと）とちらつき
    var fr = o.frame || 0, rr = rng(fr * 2654435761 + 7);
    var off = o.video ? [ (rr() - 0.5) * 0.004 * P_.weave + Math.sin(fr * 0.31) * 0.0015 * P_.weave, (rr() - 0.5) * 0.006 * P_.weave ] : [0, 0];
    var flick = o.video ? 1 + (rr() - 0.5) * 0.3 * P_.flicker : 1;
    pass(P.optics, {u_tex:T(srcTex), u_size:[IW, IH], u_dist:P_.dist, u_ca:0.0006, u_vig:P_.vig, u_expo:Math.pow(2, P_.expo),
      u_mono:bw ? 1 : 0, u_sens:P_.sens || [0,0,0], u_off:off, u_crop:crop}, A);
    // レンズの甘さ（mm → 画素）と四隅の流れ
    var s0 = P_.soft * pxmm, s1 = P_.corner * 0.06 * pxmm, cur = A;
    if (s0 + s1 > 0.35){
      pass(P.vblur, {u_tex:T(A.tex), u_texel:[1/IW, 1/IH], u_size:[IW, IH], u_dir:[1, 0], u_s0:s0, u_s1:s1}, B);
      pass(P.vblur, {u_tex:T(B.tex), u_texel:[1/IW, 1/IH], u_size:[IW, IH], u_dir:[0, 1], u_s0:s0, u_s1:s1}, A);
    }
    if (bw && V.bwSwirl > 0){ pass(P.swirl, {u_tex:T(A.tex), u_texel:[1/IW, 1/IH], u_size:[IW, IH], u_amt:V.bwSwirl}, B); cur = B; }
    // ハレーション: 乳剤を抜けた光がベースで反射して戻る。赤感層（いちばん下）に最も強く出る
    // 元画像は白で頭打ちしているので、白に近い部分を「実際はもっと明るかった光」とみなし、そこだけを散乱させる
    pass(P.down, {u_tex:T(cur.tex), u_srcTexel:[1/IW, 1/IH], u_k:4, u_thr:0.45 * Math.pow(2, P_.expo)}, H1);
    var hr = Math.max(0.5, P_.haloR * pxmm / 4);
    pass(P.blur, {u_tex:T(H1.tex), u_dir:[1/qw, 0], u_r:hr}, H2);
    pass(P.blur, {u_tex:T(H2.tex), u_dir:[0, 1/qh], u_r:hr}, H1);
    // 日付の写し込み（フィルムの裏から LED で露光される）
    var stampOn = !bw && V.filmStamp === 1;
    if (stampOn) prepareStamp(V.filmDate, IW, IH, true);
    var gp = grainParams(P_.iso, frameMm, IW, P_.grain, bw);
    // 粒状: 画素ごとの白色雑音を、粒が画素より大きければその大きさまでぼかす（分散は 1 のまま）
    var N1 = tg("fn1", IW, IH, true, gl.NEAREST), N2 = tg("fn2", IW, IH, true, gl.NEAREST), noiseT = N1;
    pass(P.noise, {u_seed:(o.seed || 0) * 1.37 + (o.video ? fr * 0.618 : 0)}, N1);
    // ガウスでぼかした雑音の等価面積 4πσ² を粒の面積（cell²）に合わせる → 広い範囲で平均したときも Selwyn の法則どおり
    var gsig = gp.cellPx / (2 * Math.sqrt(Math.PI));
    if (gsig > 0.35){
      gsig = Math.min(gsig, 8);
      pass(P.nblur, {u_tex:T(N1.tex), u_sig:gsig, u_d:{ ivec2:[1, 0] }}, N2);
      pass(P.nblur, {u_tex:T(N2.tex), u_sig:gsig, u_d:{ ivec2:[0, 1] }}, N1);
    }
    var warm = bw ? 0 : V.filmWarm, sh = bw ? 0 : V.filmShadow;
    var tone = bw ? TONE[def("bwTone").o[V.bwTone]] : TONE.neutral;
    var fade = bw ? V.bwFade : V.filmFade;
    var st = P_.stock;
    pass(P.develop, {u_tex:T(cur.tex), u_halo:T(H1.tex), u_stamp:T(stampOn ? stampTex : emptyTex), u_stampOn:stampOn ? 1 : 0,
      u_haloAmt:P_.halo * 6, u_haloCol:bw ? [1,1,1] : st.halo, u_mono:bw ? 1 : 0, u_sat:P_.sat,
      u_noise:T(noiseT.tex), u_grainSig:gp.stops, u_grainColor:bw ? 0 : V.filmGrainColor,
      u_k:[P_.k, P_.k * (1 + sh * 0.04), P_.k * (1 - sh * 0.08)],
      u_t0:[-warm * 0.25, 0, warm * 0.3],
      u_floor:[st.floor, st.floor, st.floor + (bw ? 0 : sh * 0.01)], u_ceil:[st.ceil, st.ceil, st.ceil],
      u_shadowCol:[-0.03 * sh, 0.012 * sh, 0.025 * sh], u_highCol:[0.01 * warm, 0.004 * warm, -0.012 * warm],
      u_toneLo:tone[0], u_toneHi:tone[1], u_toneAmt:bw ? V.bwToneAmt : 0, u_fade:fade,
      u_fadeCol:bw ? [0.035, 0.02, -0.02] : [0.05, -0.025, -0.005], u_flicker:flick}, C);
    // ゴミ・傷は、ネガからのプリントなら白、映写（映像）やスライドなら黒
    var projected = o.video || (!bw && V.filmStock === 1);
    var nscr = Math.round(P_.scratch * 8), sc = scratchLines(nscr, (o.seed || 0) + 1, !!o.video, fr);
    var img = frame ? frame.img : [0, 0, 1, 1];
    pass(P.finish, {u_tex:T(C.tex), u_size:[canvas.width, canvas.height], u_img:img, u_pxmm:pxmm,
      u_dust:P_.dust, u_dustPol:projected ? -1 : 1, u_dustSeed:(o.seed || 0) + (o.video ? fr : 0),
      u_scr:{ vec4:sc.lines }, u_scrW:sc.widths, u_nscr:sc.n, u_scrPol:projected ? 1 : -1,
      u_stain:P_.stain, u_silver:P_.silver, u_seed:o.seed || 0}, null);
  }
  function prepareStamp(text, w, h, glow){
    var key = text + "|" + w + "x" + h + "|" + glow;
    if (key === stampKey) return;
    stampKey = key;
    stampCv.width = w; stampCv.height = h;
    stampCtx.clearRect(0, 0, w, h);
    drawStamp(stampCtx, text, w, h, "rgba(255,150,40,1)", glow);
    uploadCanvas(stampTex, stampCv, gl.LINEAR);
  }

  /* ---- デジカメ ---- */
  function dcSensor(V, W, H){ var sw = RES_W[def("dcRes").o[V.dcRes]] || 640; return { w: sw, h: Math.max(2, Math.round(sw * H / W / 2) * 2) }; }
  function renderDigicam(V, o, W, H){
    var S = dcSensor(V, W, H);
    // レンズを通す段階は、センサーの 2 倍（元画像がそれより小さければ元の大きさ）で処理する
    var Lw = Math.max(S.w, Math.min(srcW, S.w * 2)), Lh = Math.round(Lw * S.h / S.w), ls = Lw / S.w;
    var LA = tg("la", Lw, Lh, true), LB = tg("lb", Lw, Lh, true);
    var qw = Math.max(2, Math.round(Lw / 4)), qh = Math.max(2, Math.round(Lh / 4));
    var F1 = tg("lf1", qw, qh, true), F2 = tg("lf2", qw, qh, true);
    var M = tg("dm", S.w, S.h, true, gl.NEAREST), D = tg("dd", S.w, S.h), E = tg("de", S.w, S.h);
    var caUv = 2 * V.dcCA / S.w;   // 倍率色収差: 画面の端での R と B のずれ（センサー画素）
    pass(P.optics, {u_tex:T(srcTex), u_size:[Lw, Lh], u_dist:V.dcDistort, u_ca:caUv, u_vig:V.dcVig, u_expo:Math.pow(2, V.dcExpo),
      u_mono:0, u_sens:[0,0,0], u_off:[0, 0], u_crop:[0, 0, 1, 1]}, LA);
    var s0 = V.dcSoft * ls;
    if (s0 > 0.35){
      pass(P.vblur, {u_tex:T(LA.tex), u_texel:[1/Lw, 1/Lh], u_size:[Lw, Lh], u_dir:[1, 0], u_s0:s0, u_s1:s0 * 0.5}, LB);
      pass(P.vblur, {u_tex:T(LB.tex), u_texel:[1/Lw, 1/Lh], u_size:[Lw, Lh], u_dir:[0, 1], u_s0:s0, u_s1:s0 * 0.5}, LA);
    }
    // パープルフリンジ: 飽和したハイライトの周りに青紫のにじみ
    pass(P.down, {u_tex:T(LA.tex), u_srcTexel:[1/Lw, 1/Lh], u_k:4, u_thr:0.9}, F1);
    var fr = Math.max(0.5, 1.5 * ls / 4);
    pass(P.blur, {u_tex:T(F1.tex), u_dir:[1/qw, 0], u_r:fr}, F2);
    pass(P.blur, {u_tex:T(F2.tex), u_dir:[0, 1/qh], u_r:fr}, F1);
    // ノイズ: 読み出しノイズ（ダイナミックレンジの下限）＋光子のショットノイズ
    var read = Math.pow(2, -V.dcDR) * (0.6 + 1.6 * V.dcNoise), shot = 0.0004 + 0.012 * V.dcNoise * V.dcNoise;
    var seed = (o.seed || 0) + (o.video ? (o.frame || 0) * 0.37 : 0);
    pass(P.mosaic, {u_tex:T(LA.tex), u_fringe:T(F1.tex), u_srcTexel:[1/Lw, 1/Lh], u_k:ls, u_expo:1, u_read:read, u_shot:shot, u_seed:seed,
      u_fringeAmt:V.dcFringe * 6}, M);
    // 当時の安価な機種のホワイトバランスのずれ（暖色〜寒色、緑〜マゼンタ）
    var wb = [1 + V.dcWB * 0.22, 1 + V.dcTint * 0.12, 1 - V.dcWB * 0.25];
    pass(P.demosaic, {u_tex:T(M.tex), u_wb:wb, u_sat:V.dcSat, u_contrast:V.dcContrast}, D);
    pass(P.sharp, {u_tex:T(D.tex), u_texel:[1/S.w, 1/S.h], u_amt:V.dcSharpen, u_nr:V.dcNR}, E);
    // 日付を焼き込んでから JPEG で保存（本物と同じく、日付にもブロックノイズが乗る）
    var img = readTarget(E);
    if (cpuCv.width !== S.w || cpuCv.height !== S.h){ cpuCv.width = S.w; cpuCv.height = S.h; }
    cpuCtx.putImageData(img, 0, 0);
    if (V.dcStamp === 1){ drawStamp(cpuCtx, V.dcDate, S.w, S.h, "rgb(255,140,30)", false); img = cpuCtx.getImageData(0, 0, S.w, S.h); }
    jpegSim(img, Math.round(V.dcJpegQ), V.dcSubsample, 1, 0);
    cpuCtx.putImageData(img, 0, 0);
    uploadCanvas(cpuTex, cpuCv, V.dcUpscale === 0 ? gl.NEAREST : gl.LINEAR);
    pass(P.copy, {u_tex:T(cpuTex)}, null);
  }

  /* ---- 公開 ---- */
  var lastKey = null;
  return {
    webgl: gl, halfFloat: half,
    upload: upload,
    /* 出力（キャンバス）の大きさ。native = 媒体の実際の画素数で出す（デジカメ・昔のネット） */
    outputSize: function(mode, V, W, H, opts){
      opts = opts || {};
      if (mode === "film" && opts.image && V.filmFrame === 1){ var f = filmFrameLayout(V, W, H); return { w: f.w, h: f.h }; }
      if (opts.native && mode === "digicam") return dcSensor(V, W, H);
      if (opts.native && mode === "net"){ var s = signalSize(W, H), sc = V.netScale / 100; return { w: Math.max(8, Math.round(s.w * sc)), h: Math.max(8, Math.round(s.h * sc)) }; }
      return { w: W, h: H };
    },
    /* フレームを保持する fps（無声映画の 18fps など）。0 = 元の動画のまま */
    holdFps: fpsOf,
    /* o: { time, frame, seed, video, image, bypass, W, H }。W×H は画像部分の処理サイズ（キャンバスは outputSize） */
    render: function(mode, V, o){
      o = o || {};
      o.time = o.time || 0; o.frame = o.frame || 0; o.seed = o.seed || 0;   // 静止画では 0（NaN になるとノイズの計算が黒くなる）
      var W = o.W || canvas.width, H = o.H || canvas.height;
      if (o.bypass){ pass(P.copy, {u_tex:T(srcTex)}, null); return; }
      if (mode === "vhs") renderVHS(V, o, W, H);
      else if (mode === "crt") renderCRT(V, o, W, H);
      else if (mode === "net") renderNet(V, W, H);
      else if (mode === "film") renderFilm(false, V, o, W, H);
      else if (mode === "bw") renderFilm(true, V, o, W, H);
      else if (mode === "digicam") renderDigicam(V, o, W, H);
    },
    dispose: function(){ for (var k in pool) free(pool[k]); pool = {}; }
  };
}

/* =========================================================================
   7. 読み取り値（信号の帯域・フィルム上の画素の大きさなど）
   ========================================================================= */
function readout(mode, V, W, H){
  var s = { w: Math.min(W, REF_W) }, rows = [], fir = null;
  if (mode === "crt" || mode === "vhs"){
    var fs = sampleRateMHz(s.w), bwY, bwC;
    if (mode === "vhs"){ bwY = V.vhsLumaBw; bwC = V.vhsChromaBw / 1000; }
    else { bwY = V.crtHbw; bwC = V.crtInput === 0 ? 0.6 : V.crtInput === 1 ? 1.3 : V.crtHbw; }
    rows = [{k:"r.hres", v:tvLines(bwY) + " TVL"}, {k:"r.cres", v:tvLines(bwC) + " TVL"}, {k:"r.fs", v:fs.toFixed(2) + " MHz"}];
    fir = { bwY:bwY, bwC:bwC, fs:fs };
  } else if (mode === "net"){
    var eff = s.w * V.netScale / 100;
    rows = [{k:"r.hres", v:Math.round(eff * 0.75) + " px"}, {k:"r.cres", v:(V.netCodec === 1 ? (V.netSubsample === 0 ? "1:1" : V.netSubsample === 1 ? "1:2" : "1:4") : "1:1")},
      {k:"r.px", v:Math.round(eff) + "×" + Math.round(H * s.w / W * V.netScale / 100)}];
  } else if (mode === "film" || mode === "bw"){
    var bw = mode === "bw", fmt = bw ? def("bwFormat").o[V.bwFormat] : def("filmFormat").o[V.filmFormat], mm = FILM_MM[fmt];
    var gp = grainParams(bw ? V.bwIso : V.filmIso, mm, W, bw ? V.bwGrain : V.filmGrain, bw);
    rows = [{k:"r.frame", v:mm + " mm"}, {k:"r.pixum", v:gp.pixUm.toFixed(1) + " µm"}, {k:"r.grain", v:"σD " + gp.sigD.toFixed(3)}];
  } else if (mode === "digicam"){
    var sw = RES_W[def("dcRes").o[V.dcRes]], sh = Math.round(sw * H / W);
    rows = [{k:"r.sensor", v:sw + "×" + sh + " (" + (sw * sh / 1e6).toFixed(2) + " MP)"}, {k:"r.dr", v:V.dcDR.toFixed(1) + " EV"}, {k:"r.jpeg", v:"Q" + Math.round(V.dcJpegQ)}];
  }
  return { rows: rows, fir: fir };
}
function drawResponse(c, o, t){
  var x = c.getContext("2d"), W = c.width, H = c.height;
  var cs = getComputedStyle(document.body);
  var col = cs.getPropertyValue("--text-3").trim(), acc = cs.getPropertyValue("--accent").trim();
  var bg = cs.getPropertyValue("--surface").trim(), bd = cs.getPropertyValue("--border").trim();
  x.fillStyle = bg; x.fillRect(0,0,W,H);
  if (!o){ x.fillStyle = col; x.font = "12px sans-serif"; x.textAlign="center"; x.fillText(t("t.nofir"), W/2, H/2); return; }
  var FMAX = 6;
  x.strokeStyle = bd; x.lineWidth = 1;
  for (var m = 1; m <= FMAX; m++){ var px = m/FMAX*W; x.beginPath(); x.moveTo(px,0); x.lineTo(px,H); x.stroke(); }
  var fY = firLowpass(o.bwY, o.fs, 25), stride = chromaStride(o.fs, o.bwC), fC = firLowpass(o.bwC, o.fs/stride, 25);
  function curve(h, fsc, color, w){
    x.strokeStyle = color; x.lineWidth = w; x.beginPath();
    for (var i = 0; i <= W; i++){
      var f = i/W*FMAX, fn = f/fsc, y = fn > 0.5 ? 0 : firResponse(h, fn), py = H - 4 - y*(H-10);
      if (i) x.lineTo(i, py); else x.moveTo(i, py);
    }
    x.stroke();
  }
  curve(fC, o.fs/stride, col, 1.5);
  curve(fY, o.fs, acc, 2);
  x.fillStyle = col; x.font = "9px sans-serif"; x.textAlign="left"; x.fillText("0", 2, H-2); x.textAlign="right"; x.fillText("6 MHz", W-2, H-2);
}

/* =========================================================================
   8. パラメーターの UI（両ツール共通）
      opts: { video:bool, t:Shell.t, onChange(key) }
   ========================================================================= */
function visible(p, video){ return video ? !p.i : !p.v; }
function fmtVal(p, V, t){
  var v = V[p.k];
  if (p.t === "sel") return t("o." + p.k + "." + p.o[v]);
  if (p.t === "text") return "";
  var s = (p.step < 1) ? v.toFixed(String(p.step).split(".")[1].length) : String(Math.round(v));
  return "<b>" + s + "</b>" + (p.u ? " " + p.u : "");
}
function escHtml(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function buildParams(box, mode, V, opts){
  var t = opts.t, html = "";
  GROUPS[mode].forEach(function(g){
    var ps = DEFS[mode].filter(function(p){ return p.g === g && visible(p, opts.video); });
    if (!ps.length) return;
    html += '<div class="pgroup"><div class="pgroup__head"><span class="eyebrow">' + t("g." + g) + '</span><button type="button" data-rg="' + g + '">' + t("t.resetg") + '</button></div><div class="pgroup__body">';
    ps.forEach(function(p){
      html += '<div class="prow" data-k="' + p.k + '"><div class="prow__top"><span class="prow__lbl">' + t("p." + p.k) + '</span><span class="prow__val" data-v="' + p.k + '">' + fmtVal(p, V, t) + '</span></div>';
      if (p.t === "sel") html += '<select class="select" data-p="' + p.k + '">' + p.o.map(function(o, i){ return '<option value="' + i + '"' + (V[p.k] === i ? " selected" : "") + '>' + t("o." + p.k + "." + o) + '</option>'; }).join("") + '</select>';
      else if (p.t === "text") html += '<input class="input" data-p="' + p.k + '" maxlength="16" value="' + escHtml(V[p.k]) + '">';
      else html += '<input class="slider" type="range" data-p="' + p.k + '" min="' + p.min + '" max="' + p.max + '" step="' + p.step + '" value="' + V[p.k] + '">';
      var note = t("n." + p.k);
      if (note !== "n." + p.k) html += '<div class="prow__note">' + note + '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  });
  box.innerHTML = html;
  box.querySelectorAll("[data-p]").forEach(function(el){
    el.addEventListener("input", function(){
      var k = el.getAttribute("data-p"), p = def(k);
      V[k] = p.t === "text" ? el.value : parseFloat(el.value);
      var vEl = box.querySelector('[data-v="' + k + '"]'); if (vEl) vEl.innerHTML = fmtVal(p, V, t);
      opts.onChange(k);
    });
  });
  box.querySelectorAll("[data-rg]").forEach(function(b){
    b.addEventListener("click", function(){
      var g = b.getAttribute("data-rg");
      DEFS[mode].filter(function(p){ return p.g === g; }).forEach(function(p){ V[p.k] = p.d; });
      buildParams(box, mode, V, opts); opts.onChange(null);
    });
  });
}
function applyPreset(mode, name, V){ var ps = PRESETS[mode][name]; if (!ps) return false; for (var k in ps) V[k] = ps[k]; return true; }

/* =========================================================================
   9. 文言（パラメーター・プリセット・モード）。ツール側の Shell.init に混ぜて使う
   ========================================================================= */
var STRINGS = { en: {
  "t.mode":"Medium","t.preset":"Preset","t.custom":"Custom","t.resetg":"Reset","t.nofir":"No horizontal filter in this model",
  "m.film":"Film (colour)","m.bw":"Black & white (old)","m.digicam":"Early digital camera","m.crt":"CRT display","m.vhs":"VHS tape","m.net":"Early web",
  "note.film":"Exposure goes through the film's characteristic curve in log space; grain comes from the film size and pixel size (Selwyn's law), so it stays consistent at any resolution.",
  "note.bw":"Old emulsions only saw part of the spectrum: blue-sensitive plates render red as black and blue sky as white. Estimated from RGB.",
  "note.digicam":"The image is shrunk to the sensor's pixel count, split into an RGGB colour filter, given sensor noise, developed and saved as a real JPEG.",
  "note.crt":"Bandwidth limiting is horizontal only, because a CRT line is continuous in time but discrete vertically.",
  "note.vhs":"VHS records colour on a 629 kHz subcarrier, so chroma keeps roughly a sixth of the luma bandwidth.",
  "note.net":"Palette and dither run in gamma space, matching how the tools of the era actually worked.",
  "r.hres":"Luma resolution","r.cres":"Chroma resolution","r.fs":"Sample rate","r.px":"Pixels",
  "r.frame":"Frame width","r.pixum":"One pixel on the film","r.grain":"Grain per pixel (RMS density)",
  "r.sensor":"Sensor","r.dr":"Dynamic range","r.jpeg":"JPEG quality",
  "g.sig":"Signal","g.beam":"Electron beam","g.mask":"Phosphor mask","g.tube":"Tube & geometry","g.time":"Motion (video)",
  "g.band":"Bandwidth","g.rec":"Record / playback","g.tape":"Tape defects","g.gen":"Generations",
  "g.src":"Source","g.pal":"Palette","g.jpg":"JPEG",
  "g.stock":"Film","g.tone":"Tone & colour","g.optics":"Lens","g.grain":"Grain","g.wear":"Wear","g.extra":"Extras",
  "g.emul":"Emulsion","g.sensor":"Sensor","g.color":"Colour","g.lens":"Lens","g.proc":"Processing",
  "p.crtInput":"Input","p.crtHbw":"Luma bandwidth","p.crtScan":"Scanning","p.crtSigma":"Beam width","p.crtBloom":"Beam bloom","p.crtHalo":"Halation","p.crtHaloR":"Halation radius",
  "p.crtMask":"Mask type","p.crtPitch":"Dot pitch","p.crtMaskAmt":"Mask strength","p.crtGamma":"Tube gamma","p.crtOverscan":"Overscan","p.crtCurve":"Curvature",
  "p.crtConv":"Convergence error","p.crtVig":"Vignette","p.crtPersist":"Phosphor persistence",
  "p.vhsLumaBw":"Luma bandwidth","p.vhsChromaBw":"Chroma bandwidth","p.vhsComb":"Chroma comb","p.vhsDotCrawl":"Dot crawl","p.vhsPreemp":"Pre-emphasis overshoot","p.vhsWhiteClip":"White clip",
  "p.vhsLumaNoise":"Luma noise","p.vhsChromaNoise":"Chroma noise","p.vhsNoiseCorr":"Noise frame lock","p.vhsJitter":"Time-base error","p.vhsJitterCorr":"Jitter smoothness","p.vhsHeadSw":"Head switching",
  "p.vhsDropout":"Dropouts","p.vhsTracking":"Tracking noise","p.vhsGen":"Tape generations",
  "p.netScale":"Source scale","p.netUpscale":"Upscaling","p.netPalette":"Palette","p.netColors":"Colours","p.netDither":"Dither","p.netDitherAmt":"Dither strength","p.netCodec":"Compression",
  "p.netJpegQ":"JPEG quality","p.netSubsample":"Chroma subsampling","p.netPasses":"Re-saves","p.netBlockShift":"Block offset",
  "p.filmStock":"Type","p.filmIso":"Speed (ISO)","p.filmFormat":"Format","p.filmExpo":"Exposure","p.filmContrast":"Contrast","p.filmSat":"Dye saturation","p.filmWarm":"Colour balance (cool – warm)",
  "p.filmShadow":"Shadow crossover (cyan–green)","p.filmFade":"Fading","p.filmHalation":"Halation","p.filmHaloR":"Halation spread","p.filmSoft":"Lens softness","p.filmCorner":"Corner softness",
  "p.filmVig":"Vignetting","p.filmDistort":"Barrel distortion","p.filmGrain":"Grain amount","p.filmGrainColor":"Colour in grain","p.filmDust":"Dust","p.filmScratch":"Scratches",
  "p.filmStamp":"Date imprint","p.filmDate":"Date text","p.filmFrame":"Border","p.filmWeave":"Gate weave","p.filmFlicker":"Flicker","p.filmFps":"Frame rate",
  "p.bwSens":"Spectral sensitivity","p.bwIso":"Speed (ISO)","p.bwFormat":"Format","p.bwExpo":"Exposure","p.bwContrast":"Contrast","p.bwTone":"Toning","p.bwToneAmt":"Toning strength","p.bwFade":"Fading / yellowing",
  "p.bwHalation":"Halation","p.bwHaloR":"Halation spread","p.bwSoft":"Lens softness","p.bwSwirl":"Swirl at the edges","p.bwVig":"Vignetting","p.bwGrain":"Grain amount",
  "p.bwDust":"Dust","p.bwScratch":"Scratches","p.bwStain":"Stains & foxing","p.bwSilver":"Silver mirroring","p.bwWeave":"Gate weave","p.bwFlicker":"Flicker","p.bwFps":"Frame rate",
  "p.dcRes":"Resolution","p.dcNoise":"Sensor noise","p.dcDR":"Dynamic range","p.dcExpo":"Exposure","p.dcWB":"White balance error (cool – warm)","p.dcTint":"Tint (magenta – green)",
  "p.dcSat":"Saturation","p.dcContrast":"Contrast","p.dcSoft":"Lens softness","p.dcCA":"Colour fringing at the edges","p.dcFringe":"Purple fringing","p.dcVig":"Vignetting","p.dcDistort":"Barrel distortion",
  "p.dcSharpen":"In-camera sharpening","p.dcNR":"Colour noise smoothing","p.dcJpegQ":"JPEG quality","p.dcSubsample":"Chroma subsampling","p.dcStamp":"Date stamp","p.dcDate":"Date text",
  "p.dcUpscale":"Enlarging","p.dcFps":"Frame rate",
  "o.crtInput.composite":"Composite (4.2 MHz)","o.crtInput.svideo":"S-Video (6 MHz)","o.crtInput.rgb":"RGB / component",
  "o.crtScan.p240":"240p","o.crtScan.i480":"480i","o.crtScan.off":"No scanlines",
  "o.crtMask.none":"None","o.crtMask.grille":"Aperture grille","o.crtMask.slot":"Slot mask","o.crtMask.triad":"Dot triad",
  "o.netUpscale.nearest":"Nearest","o.netUpscale.bilinear":"Bilinear",
  "o.netPalette.none":"Full colour","o.netPalette.websafe":"Web-safe 216","o.netPalette.adaptive":"Adaptive (median cut)","o.netPalette.gray":"Greyscale",
  "o.netDither.none":"None","o.netDither.bayer4":"Bayer 4×4","o.netDither.bayer8":"Bayer 8×8","o.netDither.floyd":"Floyd–Steinberg","o.netDither.atkinson":"Atkinson",
  "o.netCodec.none":"None","o.netCodec.jpeg":"JPEG",
  "o.netSubsample.444":"4:4:4","o.netSubsample.422":"4:2:2","o.netSubsample.420":"4:2:0",
  "o.filmStock.neg":"Colour negative (printed)","o.filmStock.slide":"Slide (reversal)","o.filmStock.instant":"Instant film",
  "o.filmFormat.f35":"35mm (36×24)","o.filmFormat.half":"Half frame (18×24)","o.filmFormat.f110":"110 (17×13)","o.filmFormat.f120":"120 medium format (56 mm)","o.filmFormat.f16":"16mm cine","o.filmFormat.s8":"Super 8",
  "o.filmStamp.off":"Off","o.filmStamp.on":"On","o.filmFrame.none":"None","o.filmFrame.instant":"Instant photo frame",
  "o.filmFps.src":"Same as source","o.filmFps.f24":"24 fps","o.filmFps.f18":"18 fps","o.filmFps.f16":"16 fps",
  "o.bwSens.blue":"Blue-sensitive (1850s–1880s)","o.bwSens.ortho":"Orthochromatic (1880s–1920s)","o.bwSens.pan":"Panchromatic (1930s–)",
  "o.bwFormat.plate":"Glass plate (4×5 in)","o.bwFormat.f120":"120 medium format","o.bwFormat.f35":"35mm","o.bwFormat.f16":"16mm cine","o.bwFormat.s8":"8mm cine",
  "o.bwTone.neutral":"None","o.bwTone.sepia":"Sepia","o.bwTone.selenium":"Selenium","o.bwTone.cyanotype":"Cyanotype","o.bwTone.tintype":"Tintype","o.bwTone.albumen":"Albumen print",
  "o.bwFps.src":"Same as source","o.bwFps.f24":"24 fps","o.bwFps.f18":"18 fps","o.bwFps.f16":"16 fps",
  "o.dcRes.r320":"320×240 (0.08 MP)","o.dcRes.r640":"640×480 VGA (0.3 MP)","o.dcRes.r1024":"1024×768 (0.8 MP)","o.dcRes.r1280":"1280×960 (1.2 MP)","o.dcRes.r1600":"1600×1200 (2 MP)","o.dcRes.r2048":"2048×1536 (3 MP)",
  "o.dcSubsample.444":"4:4:4","o.dcSubsample.422":"4:2:2","o.dcSubsample.420":"4:2:0",
  "o.dcStamp.off":"Off","o.dcStamp.on":"On","o.dcUpscale.nearest":"Nearest","o.dcUpscale.bilinear":"Bilinear",
  "o.dcFps.src":"Same as source","o.dcFps.f30":"30 fps","o.dcFps.f15":"15 fps","o.dcFps.f10":"10 fps",
  "ps.crt.tv":"Consumer TV","ps.crt.trin":"Trinitron monitor","ps.crt.pc":"VGA monitor","ps.crt.arcade":"Arcade monitor",
  "ps.vhs.sp":"VHS SP","ps.vhs.lp":"VHS LP","ps.vhs.ep":"VHS EP","ps.vhs.svhs":"S-VHS","ps.vhs.worn":"Worn tape, 3rd gen",
  "ps.net.w1996":"Web 1996 (216 colours)","ps.net.gif":"GIF, 32 colours","ps.net.dialup":"Dial-up JPEG","ps.net.w2000":"Web 2000",
  "ps.film.consumer":"Consumer colour negative, ISO 400","ps.film.portrait":"Portrait negative, medium format","ps.film.slide":"Slide film, ISO 100","ps.film.disposable":"Disposable camera",
  "ps.film.instant":"Instant photo","ps.film.expired":"Expired film","ps.film.noremjet":"Cine film without anti-halation backing","ps.film.super8":"Super 8 home movie",
  "ps.bw.wetplate":"1860s wet-plate tintype","ps.bw.albumen":"1880s albumen print","ps.bw.ortho":"1910s orthochromatic, sepia","ps.bw.silent":"1920s silent film",
  "ps.bw.pan":"1950s panchromatic, ISO 400","ps.bw.selenium":"Selenium-toned darkroom print","ps.bw.cyanotype":"Cyanotype",
  "ps.digicam.vga1998":"1998 VGA camera","ps.digicam.mp1_2001":"2001 compact, 1.2 MP","ps.digicam.mp2_2003":"2003 compact, 2 MP","ps.digicam.keitai":"Early camera phone","ps.digicam.webcam":"Early webcam",
  "n.crtHbw":"Sets the horizontal FIR cutoff. 4.2 MHz is the NTSC broadcast limit.",
  "n.vhsChromaBw":"Colour is recorded on a 629 kHz subcarrier, which is what caps this so low.",
  "n.vhsGen":"Runs the whole record-and-play chain again, the way copying a tape does.",
  "n.netPalette":"Web-safe is the 6×6×6 cube every 256-colour browser shared.",
  "n.filmFormat":"Grain size is fixed on the film, so a smaller film shows more grain at the same print size.",
  "n.filmHalation":"Light that passes the emulsion reflects off the film base and exposes the red layer again — the red glow around highlights.",
  "n.filmShadow":"Colour negatives often lean cyan–green in the shadows once printed.",
  "n.bwSens":"Blue-sensitive plates render red as black and blue sky as white; orthochromatic film still misses red.",
  "n.bwSwirl":"Old portrait lenses blurred the edges in circles around the centre.",
  "n.bwSilver":"On old silver images, silver rises to the surface and shines bluish at the edges.",
  "n.dcDR":"How many stops fit between noise and clipping. Each channel clips on its own, so bright skies can shift colour.",
  "n.dcJpegQ":"The image is saved with real JPEG compression at this quality (IJG tables, as in the cameras of the time).",
  "n.dcDate":"Digits, spaces and ' only."
}, ja: {
  "t.mode":"媒体","t.preset":"プリセット","t.custom":"カスタム","t.resetg":"戻す","t.nofir":"このモデルには水平フィルタがありません",
  "m.film":"フィルム（カラー）","m.bw":"昔の白黒","m.digicam":"初期のデジカメ","m.crt":"CRT（ブラウン管）","m.vhs":"VHS（テープ）","m.net":"昔のネット",
  "note.film":"露光を対数の上でフィルムの特性曲線に通します。粒状はフィルムの大きさと画素の大きさから決めるので（Selwyn の法則）、解像度が変わっても粒の見え方が保たれます。",
  "note.bw":"昔の乳剤は一部の色にしか感光しません。青にだけ感光する湿板では、赤は黒く、青空は真っ白に写ります。RGB からの近似です。",
  "note.digicam":"センサーの画素数に縮小し、RGGB のカラーフィルタに分け、センサーのノイズを加えてから現像し、本物の JPEG で保存します。",
  "note.crt":"帯域制限は水平方向のみに掛かります。走査線は時間的に連続で、垂直方向だけが離散だからです。",
  "note.vhs":"VHSは色を629kHzの副搬送波に落として記録するため、色の帯域は輝度の約1/6しか残りません。",
  "note.net":"パレットとディザは当時の実装どおりガンマ空間で処理します（リニアではありません）。",
  "r.hres":"輝度解像度","r.cres":"色解像度","r.fs":"サンプリング周波数","r.px":"画素数",
  "r.frame":"フィルムの横幅","r.pixum":"フィルム上の1画素","r.grain":"1画素あたりの粒状（RMS濃度）",
  "r.sensor":"センサー","r.dr":"ダイナミックレンジ","r.jpeg":"JPEG品質",
  "g.sig":"信号","g.beam":"電子ビーム","g.mask":"蛍光体マスク","g.tube":"管面・幾何","g.time":"動き（映像のみ）",
  "g.band":"帯域","g.rec":"記録・再生","g.tape":"テープ欠陥","g.gen":"世代",
  "g.src":"元素材","g.pal":"パレット","g.jpg":"JPEG",
  "g.stock":"フィルム","g.tone":"階調・色","g.optics":"レンズ","g.grain":"粒状","g.wear":"傷み","g.extra":"その他",
  "g.emul":"乳剤","g.sensor":"センサー","g.color":"色","g.lens":"レンズ","g.proc":"画像処理",
  "p.crtInput":"入力端子","p.crtHbw":"輝度帯域","p.crtScan":"走査方式","p.crtSigma":"ビーム幅","p.crtBloom":"ブルーミング","p.crtHalo":"ハレーション","p.crtHaloR":"ハレーション半径",
  "p.crtMask":"マスク種別","p.crtPitch":"ドットピッチ","p.crtMaskAmt":"マスク強度","p.crtGamma":"管面ガンマ","p.crtOverscan":"オーバースキャン","p.crtCurve":"画面湾曲",
  "p.crtConv":"コンバージェンスずれ","p.crtVig":"周辺減光","p.crtPersist":"蛍光体残光",
  "p.vhsLumaBw":"輝度帯域","p.vhsChromaBw":"色差帯域","p.vhsComb":"クロマ垂直コーム","p.vhsDotCrawl":"ドット妨害","p.vhsPreemp":"エンファシスのオーバーシュート","p.vhsWhiteClip":"白ピーク圧縮",
  "p.vhsLumaNoise":"輝度ノイズ","p.vhsChromaNoise":"色ノイズ","p.vhsNoiseCorr":"ノイズのフレーム固定","p.vhsJitter":"タイムベースエラー","p.vhsJitterCorr":"ジッターの滑らかさ","p.vhsHeadSw":"ヘッドスイッチング",
  "p.vhsDropout":"ドロップアウト","p.vhsTracking":"トラッキングノイズ","p.vhsGen":"ダビング世代",
  "p.netScale":"元解像度","p.netUpscale":"拡大方式","p.netPalette":"パレット","p.netColors":"色数","p.netDither":"ディザ","p.netDitherAmt":"ディザ強度","p.netCodec":"圧縮",
  "p.netJpegQ":"JPEG品質","p.netSubsample":"クロマサブサンプリング","p.netPasses":"再保存回数","p.netBlockShift":"ブロックずれ",
  "p.filmStock":"種類","p.filmIso":"感度（ISO）","p.filmFormat":"フィルムの大きさ","p.filmExpo":"露出","p.filmContrast":"コントラスト","p.filmSat":"色素の彩度","p.filmWarm":"色の傾き（寒色〜暖色）",
  "p.filmShadow":"暗部の色かぶり（シアン〜グリーン）","p.filmFade":"退色","p.filmHalation":"ハレーション","p.filmHaloR":"ハレーションの広がり","p.filmSoft":"レンズの甘さ","p.filmCorner":"四隅の流れ",
  "p.filmVig":"周辺減光","p.filmDistort":"樽型の歪み","p.filmGrain":"粒状の量","p.filmGrainColor":"粒状の色味","p.filmDust":"ゴミ","p.filmScratch":"傷",
  "p.filmStamp":"日付の写し込み","p.filmDate":"日付の文字","p.filmFrame":"枠","p.filmWeave":"ゲートの揺れ","p.filmFlicker":"ちらつき","p.filmFps":"フレームレート",
  "p.bwSens":"感色性","p.bwIso":"感度（ISO）","p.bwFormat":"フィルム・乾板の大きさ","p.bwExpo":"露出","p.bwContrast":"コントラスト","p.bwTone":"調色","p.bwToneAmt":"調色の強さ","p.bwFade":"退色・黄ばみ",
  "p.bwHalation":"ハレーション","p.bwHaloR":"ハレーションの広がり","p.bwSoft":"レンズの甘さ","p.bwSwirl":"周辺のぐるぐるボケ","p.bwVig":"周辺減光","p.bwGrain":"粒状の量",
  "p.bwDust":"ゴミ","p.bwScratch":"傷","p.bwStain":"しみ・薬品むら","p.bwSilver":"銀の浮き","p.bwWeave":"ゲートの揺れ","p.bwFlicker":"ちらつき","p.bwFps":"フレームレート",
  "p.dcRes":"画素数","p.dcNoise":"センサーのノイズ","p.dcDR":"ダイナミックレンジ","p.dcExpo":"露出","p.dcWB":"ホワイトバランスのずれ（寒色〜暖色）","p.dcTint":"色かぶり（マゼンタ〜グリーン）",
  "p.dcSat":"彩度","p.dcContrast":"コントラスト","p.dcSoft":"レンズの甘さ","p.dcCA":"周辺の色ずれ","p.dcFringe":"パープルフリンジ","p.dcVig":"周辺減光","p.dcDistort":"樽型の歪み",
  "p.dcSharpen":"カメラ内シャープ","p.dcNR":"色ノイズの平滑化","p.dcJpegQ":"JPEG品質","p.dcSubsample":"クロマサブサンプリング","p.dcStamp":"日付の焼き込み","p.dcDate":"日付の文字",
  "p.dcUpscale":"拡大方式","p.dcFps":"フレームレート",
  "o.crtInput.composite":"コンポジット（4.2MHz）","o.crtInput.svideo":"S端子（6MHz）","o.crtInput.rgb":"RGB / コンポーネント",
  "o.crtScan.p240":"240p","o.crtScan.i480":"480i","o.crtScan.off":"走査線なし",
  "o.crtMask.none":"なし","o.crtMask.grille":"アパーチャグリル","o.crtMask.slot":"スロットマスク","o.crtMask.triad":"ドットトライアド",
  "o.netUpscale.nearest":"ニアレスト","o.netUpscale.bilinear":"バイリニア",
  "o.netPalette.none":"フルカラー","o.netPalette.websafe":"セーフカラー216","o.netPalette.adaptive":"適応（median cut）","o.netPalette.gray":"グレースケール",
  "o.netDither.none":"なし","o.netDither.bayer4":"Bayer 4×4","o.netDither.bayer8":"Bayer 8×8","o.netDither.floyd":"Floyd–Steinberg","o.netDither.atkinson":"Atkinson",
  "o.netCodec.none":"なし","o.netCodec.jpeg":"JPEG",
  "o.netSubsample.444":"4:4:4","o.netSubsample.422":"4:2:2","o.netSubsample.420":"4:2:0",
  "o.filmStock.neg":"カラーネガ（プリント）","o.filmStock.slide":"リバーサル（スライド）","o.filmStock.instant":"インスタントフィルム",
  "o.filmFormat.f35":"35mm（36×24）","o.filmFormat.half":"ハーフ判（18×24）","o.filmFormat.f110":"110（17×13）","o.filmFormat.f120":"120 中判（56mm）","o.filmFormat.f16":"16mm 映画","o.filmFormat.s8":"スーパー8",
  "o.filmStamp.off":"なし","o.filmStamp.on":"あり","o.filmFrame.none":"なし","o.filmFrame.instant":"インスタント写真の枠",
  "o.filmFps.src":"元の動画のまま","o.filmFps.f24":"24fps","o.filmFps.f18":"18fps","o.filmFps.f16":"16fps",
  "o.bwSens.blue":"青だけに感光（1850〜80年代）","o.bwSens.ortho":"オルソ（1880〜1920年代）","o.bwSens.pan":"パンクロ（1930年代〜）",
  "o.bwFormat.plate":"ガラス乾板（4×5インチ）","o.bwFormat.f120":"120 中判","o.bwFormat.f35":"35mm","o.bwFormat.f16":"16mm 映画","o.bwFormat.s8":"8mm 映画",
  "o.bwTone.neutral":"なし","o.bwTone.sepia":"セピア","o.bwTone.selenium":"セレン","o.bwTone.cyanotype":"サイアノタイプ（青写真）","o.bwTone.tintype":"ティンタイプ","o.bwTone.albumen":"鶏卵紙",
  "o.bwFps.src":"元の動画のまま","o.bwFps.f24":"24fps","o.bwFps.f18":"18fps","o.bwFps.f16":"16fps",
  "o.dcRes.r320":"320×240（8万画素）","o.dcRes.r640":"640×480 VGA（30万画素）","o.dcRes.r1024":"1024×768（80万画素）","o.dcRes.r1280":"1280×960（120万画素）","o.dcRes.r1600":"1600×1200（200万画素）","o.dcRes.r2048":"2048×1536（300万画素）",
  "o.dcSubsample.444":"4:4:4","o.dcSubsample.422":"4:2:2","o.dcSubsample.420":"4:2:0",
  "o.dcStamp.off":"なし","o.dcStamp.on":"あり","o.dcUpscale.nearest":"ニアレスト","o.dcUpscale.bilinear":"バイリニア",
  "o.dcFps.src":"元の動画のまま","o.dcFps.f30":"30fps","o.dcFps.f15":"15fps","o.dcFps.f10":"10fps",
  "ps.crt.tv":"家庭用テレビ","ps.crt.trin":"トリニトロン","ps.crt.pc":"VGAモニタ","ps.crt.arcade":"アーケード用モニタ",
  "ps.vhs.sp":"VHS 標準(SP)","ps.vhs.lp":"VHS 3倍(LP)","ps.vhs.ep":"VHS 6倍(EP)","ps.vhs.svhs":"S-VHS","ps.vhs.worn":"劣化テープ・3世代",
  "ps.net.w1996":"1996年のWeb（216色）","ps.net.gif":"GIF 32色","ps.net.dialup":"ダイヤルアップJPEG","ps.net.w2000":"2000年のWeb",
  "ps.film.consumer":"一般用カラーネガ ISO400","ps.film.portrait":"ポートレート用ネガ・中判","ps.film.slide":"リバーサル ISO100","ps.film.disposable":"使い捨てカメラ",
  "ps.film.instant":"インスタント写真","ps.film.expired":"期限切れフィルム","ps.film.noremjet":"ハレーション防止層のない映画用フィルム","ps.film.super8":"スーパー8の家庭用映画",
  "ps.bw.wetplate":"1860年代の湿板（ティンタイプ）","ps.bw.albumen":"1880年代の鶏卵紙","ps.bw.ortho":"1910年代のオルソ・セピア","ps.bw.silent":"1920年代の無声映画",
  "ps.bw.pan":"1950年代のパンクロ ISO400","ps.bw.selenium":"セレン調色のプリント","ps.bw.cyanotype":"サイアノタイプ（青写真）",
  "ps.digicam.vga1998":"1998年のVGAデジカメ","ps.digicam.mp1_2001":"2001年のコンデジ（120万画素）","ps.digicam.mp2_2003":"2003年のコンデジ（200万画素）","ps.digicam.keitai":"初期のカメラ付き携帯","ps.digicam.webcam":"初期のウェブカメラ",
  "n.crtHbw":"水平FIRのカットオフになります。4.2MHzがNTSC放送の上限です。",
  "n.vhsChromaBw":"色を629kHzの副搬送波に載せて記録するため、ここまでしか取れません。",
  "n.vhsGen":"記録・再生の全工程をもう一度通します。テープをダビングするのと同じ理屈です。",
  "n.netPalette":"セーフカラーは、256色環境のブラウザが共有していた6×6×6の色立方体です。",
  "n.filmFormat":"粒の大きさはフィルム上で決まっているので、小さいフィルムほど同じ大きさに伸ばしたときに粒が目立ちます。",
  "n.filmHalation":"乳剤を抜けた光がフィルムのベースで反射し、赤の層をもう一度感光させます。ハイライトの周りの赤いにじみです。",
  "n.filmShadow":"カラーネガはプリントすると、暗部がシアン〜グリーンに寄りがちです。",
  "n.bwSens":"青だけに感光する湿板では赤が黒く、青空が真っ白に写ります。オルソでも赤には感光しません。",
  "n.bwSwirl":"昔の肖像用レンズは、周辺が中心を囲むように流れてボケます。",
  "n.bwSilver":"古い銀の像では銀が表面に浮き出し、縁が青みを帯びて光ります。",
  "n.dcDR":"ノイズと白飛びの間に何段入るか。チャンネルごとに頭打ちになるので、明るい空は色が転びます。",
  "n.dcJpegQ":"この品質で本物の JPEG 圧縮に通します（当時のカメラと同じ IJG の量子化テーブル）。",
  "n.dcDate":"数字・空白・' が使えます。"
}};

root.RetroEngine = {
  DEFS: DEFS, GROUPS: GROUPS, PRESETS: PRESETS, MODES: MODES, STRINGS: STRINGS,
  defaults: defaults, def: def, create: create, readout: readout, drawResponse: drawResponse,
  buildParams: buildParams, applyPreset: applyPreset, visible: visible
};
})(window);
