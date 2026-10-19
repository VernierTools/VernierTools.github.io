/* =========================================================================
   Vernier — 結果プレビューの全画面表示の共通部品（FullView）
   使い方：
     var fv = FullView.attach({
       target: el,         // 全画面にする要素（プレビューのカード。中のボタンもそのまま使える）
       stage: el,          // その中で、残りの高さいっぱいに広げる部分（画像・動画・キャンバスの入れ物）
       into: el,           // 全画面ボタンを足す場所（button を渡すときは不要）
       button: el,         // 既にあるボタンを使うとき
       fit: "canvas, video",           // stage の中で、入る大きさまで拡大・縮小するもの（既定は stage 直下の canvas / img / video）
                                       // false：大きさは変えない（箱の大きさに合わせて自分で描き直すキャンバス）
       fitBox: el,                     // 代わりに、この箱を stage に入る大きさにする（前後比較のように、キャンバスを重ねた箱）
       fitSize: function(){ return [w, h]; },   // fitBox の縦横の画素数（既定は fitBox の中の最初の canvas）
       onChange: function(on){ ... }   // 切り替わったとき（キャンバスの大きさを描き直すツール用）
     });
     fv.refit();           // 全画面中に中身の大きさ（画素数）が変わったとき
     fv.toggle(); fv.on;   // 自分で切り替えるとき・今の状態
   ネイティブの Fullscreen API が使えるときはそれを使い、使えないとき（iPhone の Safari など）は
   画面いっぱいに広げる表示で代える。どちらも target に .fv-on が付くので、見た目は CSS 1 か所で揃う。
   fit の要素は、縦横比を保ったまま、親の箱に入るいちばん大きな表示サイズにする（小さい画像は拡大する）。
   見た目の大きさだけを変えるので、クリック位置を getBoundingClientRect で換算しているツールはそのまま動く。
   切り替えた後は window の resize も送るので、resize で描き直すツールは何もしなくてよい。
   ========================================================================= */
(function () {
"use strict";

var S = {
  en: { on: "Fullscreen", off: "Exit fullscreen" },
  ja: { on: "全画面", off: "全画面を終了" }
};
function L() { return (window.Shell && Shell.lang === "ja") ? S.ja : S.en; }

var ICON_ON = '<svg class="fv-i-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
var ICON_OFF = '<svg class="fv-i-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M21 15h-4a2 2 0 0 0-2 2v4M3 15h4a2 2 0 0 1 2 2v4"/></svg>';

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || null;
}

function attach(o) {
  var el = o.target, btn = o.button;
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn btn--secondary fv-btn";
    o.into.appendChild(btn);
  }
  if (!btn.querySelector(".fv-i-on")) btn.innerHTML = ICON_ON + ICON_OFF + "<span></span>";
  if (o.stage) o.stage.classList.add("fv-stage");
  var native = false, fallback = false;

  function isOn() { return native || fallback; }

  /* ---- 中身を箱に合わせる ---- */
  function media() {
    if (!o.stage || o.fit === false) return [];
    var list = typeof o.fit === "string" ? o.stage.querySelectorAll(o.fit)
      : Array.prototype.filter.call(o.stage.children, function (c) { return /^(CANVAS|IMG|VIDEO)$/.test(c.tagName); });
    return Array.prototype.filter.call(list, function (m) { return !m.hidden; });
  }
  function natural(m) {
    if (m.tagName === "VIDEO") return [m.videoWidth, m.videoHeight];
    if (m.tagName === "IMG") return [m.naturalWidth, m.naturalHeight];
    return [m.width, m.height];
  }
  var fitted = [];   // [要素, 元の width, 元の height]（ツールが自分で付けていた style は戻す）
  function unfit() {
    fitted.forEach(function (f) { f[0].style.width = f[1]; f[0].style.height = f[2]; });
    fitted = [];
  }
  function keep(m) { fitted.push([m, m.style.width, m.style.height]); }
  function inner(box) {
    var cs = getComputedStyle(box);
    return [box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
            box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)];
  }
  function size(m, n, b) {
    var k = Math.min(b[0] / n[0], b[1] / n[1]);
    keep(m);
    m.style.setProperty("width", Math.floor(n[0] * k) + "px", "important");
    m.style.setProperty("height", Math.floor(n[1] * k) + "px", "important");
  }
  function refit() {
    unfit();
    if (!isOn()) return;
    if (o.fitBox) {
      var c = o.fitBox.querySelector("canvas"), n = o.fitSize ? o.fitSize() : c ? [c.width, c.height] : [0, 0], b = inner(o.stage);
      // 箱の枠線のぶんを引く（中身の縦横比を保つため）
      var bw = o.fitBox.offsetWidth - o.fitBox.clientWidth, bh = o.fitBox.offsetHeight - o.fitBox.clientHeight;
      if (n[0] && n[1] && b[0] > 0 && b[1] > 0) {
        var k = Math.min((b[0] - bw) / n[0], (b[1] - bh) / n[1]);
        keep(o.fitBox);
        o.fitBox.style.setProperty("width", Math.floor(n[0] * k + bw) + "px", "important");
        o.fitBox.style.setProperty("height", Math.floor(n[1] * k + bh) + "px", "important");
      }
      return;
    }
    media().forEach(function (m) {
      var n = natural(m), b = inner(m.parentElement);
      if (n[0] && n[1] && b[0] > 0 && b[1] > 0) size(m, n, b);
    });
  }
  window.addEventListener("resize", function () { if (isOn()) refit(); });
  // 中身の画素数が変わったら（読み込み直し・設定の変更）合わせ直す
  var watch = typeof MutationObserver === "function" && o.stage ? new MutationObserver(function () { if (isOn()) refit(); }) : null;
  if (watch) watch.observe(o.stage, { subtree: true, attributes: true, attributeFilter: ["width", "height", "hidden", "src"], childList: true });
  if (o.stage) o.stage.addEventListener("loadedmetadata", function () { if (isOn()) refit(); }, true);
  if (o.stage) o.stage.addEventListener("load", function () { if (isOn()) refit(); }, true);
  function sync() {
    var on = isOn();
    el.classList.toggle("fv-on", on);
    document.documentElement.classList.toggle("fv-open", fallback);
    btn.querySelector(".fv-i-on").hidden = on;
    btn.querySelector(".fv-i-off").hidden = !on;
    btn.querySelector("span").textContent = on ? L().off : L().on;
    btn.setAttribute("aria-pressed", String(on));
  }
  function changed() {
    sync();
    if (!isOn()) unfit();
    if (o.onChange) o.onChange(isOn());
    // 大きさが変わったので、resize で描き直すツールにも知らせる（レイアウトが落ち着いてから。refit もここで走る）
    requestAnimationFrame(function () { window.dispatchEvent(new Event("resize")); });
    setTimeout(refit, 250);   // 全画面への切り替えのアニメーションが終わった後にも合わせ直す
  }
  function enter() {
    var req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
    if (req) {
      try {
        var r = req.call(el);
        if (r && r.catch) r.catch(function () { if (!native) { fallback = true; changed(); } });
        // 埋め込み表示などで、断られも始まりもしないまま止まることがある。そのときは代わりの表示にする
        setTimeout(function () { if (!native && !fallback && fsElement() !== el) { fallback = true; changed(); } }, 700);
        return;
      } catch (e) { /* 下で代わりの表示にする */ }
    }
    fallback = true; changed();
  }
  function exit() {
    if (fsElement() === el) {
      var ex = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
      if (ex) ex.call(document);
    }
    if (fallback) { fallback = false; changed(); }
  }
  function toggle() { if (isOn()) exit(); else enter(); }

  btn.addEventListener("click", toggle);
  ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var now = fsElement() === el;   // Esc などブラウザ側で閉じられたときも追従する
      if (now !== native) { native = now; changed(); }
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && fallback) { fallback = false; changed(); }
  });
  if (window.Shell && Shell.onSettingsChange) Shell.onSettingsChange(sync);
  sync();

  return { toggle: toggle, exit: exit, refit: refit, get on() { return isOn(); }, button: btn };
}

window.FullView = { attach: attach };
})();
