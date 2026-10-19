/* =========================================================================
   Vernier — プリセットの書き出し・読み込みの共通部品（PresetFile）
   今の設定を小さな JSON ファイルに書き出し、そのファイルを読み込むと同じ設定に戻る。
   使い方：
     PresetFile.attach({
       tool: "image-degrade",                // ツールの id。別のツールのファイルは読み込まない
       into: el,                             // ここに「書き出す」「読み込む」のボタンを足す
       get: function(){ return {...}; },     // 今の設定（JSON にできる値だけ）
       set: function(s){ ... },              // 設定を当てはめる。当てはめられないときは false を返すか投げる
       name: function(){ return "film"; }    // ファイル名に入れる言葉（無くてもよい）
     });
   ファイルの形：{ "format": "vernier-preset", "version": 1, "tool": "…", "settings": {…} }
   FileDrop を使っているページでは、.json をドロップ・貼り付けしてもここで読み込む。
   ========================================================================= */
(function () {
"use strict";

var FORMAT = "vernier-preset", VERSION = 1;
var S = {
  en: { exp: "Export preset", imp: "Import preset", ok: "Preset loaded.",
        bad: "This isn't a Vernier preset file.", other: "This preset is for another tool ({tool}).",
        newer: "This preset was made by a newer version of the tool.", fail: "This preset couldn't be applied." },
  ja: { exp: "プリセットを書き出す", imp: "プリセットを読み込む", ok: "プリセットを読み込みました。",
        bad: "Vernier のプリセットファイルではありません。", other: "別のツール（{tool}）のプリセットです。",
        newer: "新しい版のツールで作られたプリセットです。", fail: "このプリセットを当てはめられませんでした。" }
};
function L() { return (window.Shell && Shell.lang === "ja") ? S.ja : S.en; }
function toast(msg) { if (window.FileDrop) FileDrop.toast(msg); else window.alert(msg); }

var ICON_EXP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>';
var ICON_IMP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/></svg>';

var current = null;   // ページで今使っているもの（ドロップされた .json の行き先）

function slug(s) {
  return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function attach(o) {
  var row = document.createElement("div");
  row.className = "pf-row";
  row.innerHTML = '<button type="button" class="btn btn--secondary pf-btn" data-pf="exp">' + ICON_EXP + '<span></span></button>' +
    '<button type="button" class="btn btn--secondary pf-btn" data-pf="imp">' + ICON_IMP + '<span></span></button>';
  var input = document.createElement("input");
  input.type = "file"; input.accept = ".json,application/json"; input.hidden = true;
  row.appendChild(input);
  o.into.appendChild(row);

  function relabel() {
    row.querySelector('[data-pf="exp"] span').textContent = L().exp;
    row.querySelector('[data-pf="imp"] span').textContent = L().imp;
  }
  relabel();
  if (window.Shell && Shell.onSettingsChange) Shell.onSettingsChange(relabel);

  function exportNow() {
    var data = { format: FORMAT, version: VERSION, tool: o.tool, saved: new Date().toISOString(), settings: o.get() };
    var blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a");
    var part = slug(o.name ? o.name() : "");
    a.href = URL.createObjectURL(blob);
    a.download = o.tool + "-preset" + (part ? "-" + part : "") + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function apply(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { toast(L().bad); return; }
    if (!d || d.format !== FORMAT || typeof d.settings !== "object" || !d.settings) { toast(L().bad); return; }
    if (d.tool !== o.tool) { toast(L().other.replace("{tool}", String(d.tool))); return; }
    if ((d.version || 1) > VERSION) { toast(L().newer); return; }
    var ok;
    try { ok = o.set(d.settings); } catch (e) { ok = false; }
    toast(ok === false ? L().fail : L().ok);
  }
  function read(file) {
    var r = new FileReader();
    r.onload = function () { apply(String(r.result)); };
    r.onerror = function () { toast(L().bad); };
    r.readAsText(file);
  }

  row.querySelector('[data-pf="exp"]').addEventListener("click", exportNow);
  row.querySelector('[data-pf="imp"]').addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () {
    var f = input.files && input.files[0]; input.value = "";
    if (f) read(f);
  });

  var h = { export: exportNow, read: read, el: row };
  current = h;
  return h;
}

// FileDrop から：ドロップ・貼り付けされたのがプリセットらしければ受け取る
function take(file) {
  if (!current || !file) return false;
  var json = /\.json$/i.test(file.name || "") || file.type === "application/json";
  if (!json) return false;
  current.read(file);
  return true;
}

window.PresetFile = { attach: attach, take: take };
})();
