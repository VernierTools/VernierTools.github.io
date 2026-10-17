/* =========================================================================
   Vernier — Blender で使う形の色の値（BlenderColor）
   Blender のカラーピッカーは H・S・V（と H・S・L）をすべて 0–1 で表し、
   RGB の欄は「リニア」（sRGB のガンマを外した値）を 0–1 で表す。HEX は画面表示（sRGB）のまま。
   どのツールでも同じ書き方・同じ桁で出せるように、変換と書式をここにまとめる。
     BlenderColor.of(r, g, b)      // r, g, b は sRGB 0–255 → { hsv:[h,s,v], hsl:[h,s,l], lin:[r,g,b] }（すべて 0–1）
     BlenderColor.text([a, b, c])  // "0.639, 0.540, 0.890"（Blender の表示と同じ小数 3 桁）
     BlenderColor.fromHsv(h, s, v) / fromHsl(h, s, l) / fromLinear(r, g, b)   // 0–1 → sRGB 0–255（実数）
   ========================================================================= */
(function () {
"use strict";

function toLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function fromLin(c) { c = Math.max(0, Math.min(1, c)); return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); }

function of(r, g, b) {
  var R = r / 255, G = g / 255, B = b / 255;
  var mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn, h = 0;
  if (d > 0) {
    if (mx === R) h = ((G - B) / d) % 6;
    else if (mx === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  var l = (mx + mn) / 2;
  return {
    hsv: [h, mx ? d / mx : 0, mx],
    hsl: [h, d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l],
    lin: [toLin(r), toLin(g), toLin(b)]
  };
}
// 小数 3 桁。色相の 1.000 は 0.000 と同じ向きなので 0.000 にそろえる
function num(v, isHue) {
  var s = (Math.round(v * 1000) / 1000).toFixed(3);
  if (isHue && s === "1.000") s = "0.000";
  return s === "-0.000" ? "0.000" : s;
}
function text(a, hueFirst) { return [num(a[0], hueFirst), num(a[1]), num(a[2])].join(", "); }

function fromHsv(h, s, v) {
  h = ((h % 1) + 1) % 1 * 6;
  var c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
  if (h < 1) { r = c; g = x; } else if (h < 2) { r = x; g = c; } else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; } else if (h < 5) { r = x; b = c; } else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function fromHsl(h, s, l) {
  var c = (1 - Math.abs(2 * l - 1)) * s, v = l + c / 2;
  return fromHsv(h, v ? c / v : 0, v);
}
function fromLinear(r, g, b) { return { r: fromLin(r), g: fromLin(g), b: fromLin(b) }; }

window.BlenderColor = { of: of, text: text, num: num, toLinear: toLin, fromHsv: fromHsv, fromHsl: fromHsl, fromLinear: fromLinear };
})();
