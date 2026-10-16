/* =========================================================================
   Vernier — ファイル読み込みの共通部品（FileDrop）
   どのツールでも同じ方法でファイルを開けるようにする：
     ・ドロップ欄のクリック／Enter・Space でファイルを選ぶ
     ・ページのどこにドロップしても開く（ドラッグ中は画面全体に案内を出す）
     ・貼り付け（⌘V / Ctrl+V）で開く
     ・受け付けない形式はトーストで知らせる
     ・すでに開いているときにドロップ・貼り付けで別のファイルが来たら、置き換えてよいか確認する
     ・「別の〇〇を開く」ボタンはファイル選択を直接開く（自分で選ぶ操作なので確認しない）
   使い方：
     var fd = FileDrop.attach({
       accept: "image/*",            // <input type=file> の accept と同じ書き方
       kind: "image",                // image / video / audio / midi / json / exr（文言の切り替え）
       zone: el,                     // ドロップ欄（クリックで選択・ドラッグ中の強調）。無くてもよい
       fillZone: true,               // ドロップ欄の中身を共通の文言で描く
       formats: "JPEG, PNG, WebP",   // ドロップ欄に出す対応形式（fillZone のとき）
       replace: el,                  // 「別の〇〇を開く」ボタン。無くてもよい
       owner: el,                    // この中にドロップされたら、こちらが受け取る（読み込み口が複数あるページ用）
       multiple: true,               // 複数ファイルを一覧に足すツール。onFile には File の配列が渡る
       loaded: function(){ ... },    // multiple のとき、一覧に何か入っているか（欄の文言の切り替え用）
       openLabel: true,              // replace のボタンが読み込み前から見えているとき：開く前は「〇〇を開く」と出す
       restyle: false,               // ツールバーの中など、ボタンの大きさをまわりに合わせたいとき（文言とアイコンだけ共通にする）
       info: el,                     // 開いているファイルの行（ファイル名・情報・「別の〇〇を開く」）を描く場所
       hasFile: function(target){ return !!img; },          // target = ドロップした要素（貼り付け・選択では null）
       onFile: function(file, how, target){ ... }   // how = "pick" | "drop" | "paste"
     });
     fd.pick();   // ファイル選択を開く
     fd.show(file, [FileDrop.dims(w, h), FileDrop.time(sec)]);   // 読み込めたら、ファイル名・情報を出す（大きさは自動で足す）
                                                                 // 音声は FileDrop.audioOf(file, ch)（元のレートをファイルから読む Promise）
     fd.clear();  // 閉じたとき・読み込めなかったとき
   info を渡すと、replace のボタンはその行の右端へ移る（openLabel のボタンは、開くまでは元の場所に置き、開いたら行へ移る）。
   ページに読み込み口が複数あるときは、active: function(){ return 今これが表示中か } で
   ページ全体のドロップ・貼り付けを受ける方を決める。
   ========================================================================= */
(function () {
"use strict";

var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
var OPEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6m-3-3 3-3 3 3"/></svg>';
var S = {
  en: {
    kind: { image: "image", video: "video", audio: "audio file", midi: "MIDI file", json: "settings file", exr: "STMap", file: "file" },
    choose: "Click to choose, or drop it anywhere on the page",
    chooseAnother: "Click to choose another {kind}, or drop it anywhere on the page",
    open: "Open {kind}",
    paste: "You can also paste it ({key}).",
    local: "Nothing leaves your device.",
    another: "Open another {kind}",
    overlay: "Drop to open the {kind}",
    replaceT: "Replace the current {kind}?",
    replaceB: "“{name}” will be opened instead of the one you're working on.",
    replaceOk: "Replace", cancel: "Cancel",
    badType: "This file can't be opened here. Supported: {formats}",
    many: "Only the first file was opened.",
    mono: "mono", stereo: "stereo", ch: "{n} ch", tracks: "{n} tracks", track1: "1 track", notes: "{n} notes", note1: "1 note", pasted: "Pasted {kind}"
  },
  ja: {
    kind: { image: "画像", video: "動画", audio: "音声ファイル", midi: "MIDIファイル", json: "設定ファイル", exr: "STMap", file: "ファイル" },
    choose: "クリックして選ぶか、ページのどこかにドロップ",
    chooseAnother: "クリックして別の{kind}を選ぶか、ページのどこかにドロップ",
    open: "{kind}を開く",
    paste: "貼り付け（{key}）でも開けます。",
    local: "ファイルは端末の外に出ません。",
    another: "別の{kind}を開く",
    overlay: "ドロップして{kind}を開く",
    replaceT: "今の{kind}を置き換えますか？",
    replaceB: "作業中の{kind}の代わりに「{name}」を開きます。",
    replaceOk: "置き換える", cancel: "キャンセル",
    badType: "このファイルはここでは開けません。対応形式：{formats}",
    many: "最初のファイルだけを開きました。",
    mono: "モノラル", stereo: "ステレオ", ch: "{n} ch", tracks: "{n} トラック", track1: "1 トラック", notes: "{n} ノート", note1: "1 ノート", pasted: "貼り付けた{kind}"
  }
};
function L() { return (window.Shell && Shell.lang === "ja") ? S.ja : S.en; }
function fmt(s, o) { return s.replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); }
function kindName(k) { return L().kind[k] || L().kind.file; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

/* ---- ファイル情報の書き方（全ツール共通） ---- */
var KIND_ICON = {
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  midi: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v9M12 4v9M16 4v9M8 13v7M12 13v7M16 13v7"/>',
  json: '<path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1"/>',
  exr: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
};
function kindIcon(k) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (KIND_ICON[k] || KIND_ICON.file) + "</svg>";
}
function bytes(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(n < 104857600 ? 1 : 0) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function dims(w, h) { return (w && h) ? w + "×" + h : ""; }
// 長さ：1:05.3 / 0:04.0 / 1:02:03（1時間以上は小数を出さない）
function time(sec) {
  if (!isFinite(sec) || sec < 0) return "";
  var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (h) return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + Math.floor(s);
  var ss = s.toFixed(1); if (ss === "60.0") { m++; ss = "0.0"; }
  return m + ":" + (parseFloat(ss) < 10 ? "0" : "") + ss;
}
function audioFmt(rate, ch) {
  var l = L(), out = [];
  if (rate) out.push((rate / 1000).toLocaleString("en", { maximumFractionDigits: 3 }) + " kHz");
  if (ch) out.push(ch === 1 ? l.mono : ch === 2 ? l.stereo : fmt(l.ch, { n: ch }));
  return out.join(" · ");
}
function count(n, one, many) { return lazy(function () { return n === 1 ? L()[one] : fmt(L()[many], { n: n.toLocaleString() }); }); }
// 言葉を含む情報は、言語を切り替えたときに書き直せるよう、表示するときに文字にする
function lazy(f) { return { toString: f }; }

/* ---- 音声ファイルの元のサンプリングレートを、先頭のヘッダーから読む ----
   decodeAudioData は再生側のレート（44.1 kHz など）に変換してしまうので、元の値はファイルから直接読む。
   WAV / AIFF / FLAC / MP3 / Ogg Vorbis / M4A（AAC・ALAC）に対応。分からなければ 0 */
function mp4Rate(ab) {
  // 音声トラックの見本の説明（mp4a / alac）の中にある 16.16 固定小数のレート
  var v = new DataView(ab), n = ab.byteLength;
  for (var i = 4; i + 36 <= n; i++) {
    var a = v.getUint32(i);
    if (a === 0x6d703461 || a === 0x616c6163) {   // "mp4a" / "alac"
      var rate = v.getUint32(i + 28) >>> 16;
      if (rate >= 4000 && rate <= 384000 && v.getUint32(i - 4) > 36) return rate;
    }
  }
  return 0;
}
function sniffRate(file) {
  return file.slice(0, 65536).arrayBuffer().then(function (ab) {
    var v = new DataView(ab), n = ab.byteLength;
    function str(o, len) { var t = ""; for (var i = 0; i < len && o + i < n; i++) t += String.fromCharCode(v.getUint8(o + i)); return t; }
    var head = str(0, 4), form = str(8, 4);
    if (head === "RIFF" && form === "WAVE") {
      for (var o = 12; o + 8 <= n;) {
        var id = str(o, 4), sz = v.getUint32(o + 4, true);
        if (id === "fmt ") return v.getUint32(o + 12, true);
        o += 8 + sz + (sz & 1);
      }
    }
    if (head === "FORM" && (form === "AIFF" || form === "AIFC")) {
      for (var p = 12; p + 8 <= n;) {
        var cid = str(p, 4), csz = v.getUint32(p + 4);
        if (cid === "COMM") {   // 80 ビットの拡張精度で書かれている
          var e = v.getUint16(p + 16) & 0x7fff, hi = v.getUint32(p + 18), lo = v.getUint32(p + 22);
          return Math.round((hi * 4294967296 + lo) * Math.pow(2, e - 16383 - 63));
        }
        p += 8 + csz + (csz & 1);
      }
    }
    if (head === "fLaC" && n >= 21) return (v.getUint8(18) << 12 | v.getUint8(19) << 4 | v.getUint8(20) >> 4);
    if (head === "OggS") {
      for (var q = 0; q + 16 < n; q++) if (v.getUint8(q) === 1 && str(q + 1, 6) === "vorbis") return v.getUint32(q + 12, true);
      return 0;
    }
    if (str(4, 4) === "ftyp") {
      // moov が末尾にあるファイルも多いので、先頭で見つからなければ最後の 1 MB も見る
      var r0 = mp4Rate(ab);
      return r0 || file.slice(Math.max(0, file.size - 1048576)).arrayBuffer().then(mp4Rate);
    }
    // MP3：ID3 タグを飛ばして、最初のフレームヘッダーを読む
    var m = 0;
    if (str(0, 3) === "ID3" && n > 10) m = 10 + ((v.getUint8(6) & 127) << 21 | (v.getUint8(7) & 127) << 14 | (v.getUint8(8) & 127) << 7 | (v.getUint8(9) & 127));
    for (; m + 4 <= n; m++) {
      if (v.getUint8(m) !== 0xff || (v.getUint8(m + 1) & 0xe0) !== 0xe0) continue;
      var ver = (v.getUint8(m + 1) >> 3) & 3, layer = (v.getUint8(m + 1) >> 1) & 3, ri = (v.getUint8(m + 2) >> 2) & 3;
      if (ver === 1 || layer === 0 || ri === 3) continue;
      if (layer !== 1) return 0;   // MP3（Layer III）以外は扱わない（AAC の ADTS など）
      return [44100, 48000, 32000][ri] / (ver === 3 ? 1 : ver === 2 ? 2 : 4);
    }
    return 0;
  }).catch(function () { return 0; });
}
// 「48 kHz · ステレオ」。チャンネル数はデコード結果、レートはファイルの値（読めなければ出さない）
function audioOf(file, ch) {
  return sniffRate(file).then(function (rate) { return lazy(function () { return audioFmt(rate, ch); }); });
}

/* ---- accept の判定（MIME のワイルドカード・MIME・拡張子） ---- */
function accepts(file, accept) {
  if (!accept) return true;
  var name = (file.name || "").toLowerCase(), type = (file.type || "").toLowerCase();
  return accept.split(",").some(function (a) {
    a = a.trim().toLowerCase(); if (!a) return false;
    if (a[0] === ".") return name.slice(-a.length) === a;
    if (a.slice(-2) === "/*") return type.indexOf(a.slice(0, -1)) === 0;
    return type === a;
  });
}
function formatsOf(accept) {
  var ext = [];
  accept.split(",").forEach(function (a) {
    a = a.trim();
    if (a[0] === ".") ext.push(a.slice(1).toUpperCase());
    else if (a === "image/*") ext.push("JPEG", "PNG", "WebP");
    else if (a === "video/*") ext.push("MP4", "MOV", "WebM");
    else if (a === "audio/*") ext.push("WAV", "MP3", "M4A");
  });
  return ext.filter(function (v, i) { return ext.indexOf(v) === i; }).join(", ");
}

/* ---- トースト（Shell のコピー通知と同じ見た目） ---- */
var toastEl = null;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "tb-copied tb-toast-long"; toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
}

/* ---- 置き換えの確認ダイアログ ---- */
var dlg = null;
function confirmReplace(kind, name) {
  var l = L(), k = kindName(kind);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "tb-dialog";
    dlg.innerHTML = '<form method="dialog"><div class="tb-dialog__title"></div><p class="tb-dialog__body"></p>' +
      '<div class="tb-dialog__btns"><button class="btn btn--secondary" value="cancel"></button>' +
      '<button class="btn btn--primary" value="ok"></button></div></form>';
    document.body.appendChild(dlg);
  }
  dlg.querySelector(".tb-dialog__title").textContent = fmt(l.replaceT, { kind: k });
  dlg.querySelector(".tb-dialog__body").textContent = fmt(l.replaceB, { kind: k, name: name || "" });
  dlg.querySelector('[value="cancel"]').textContent = l.cancel;
  dlg.querySelector('[value="ok"]').textContent = l.replaceOk;
  if (typeof dlg.showModal !== "function") return Promise.resolve(window.confirm(fmt(l.replaceT, { kind: k })));
  return new Promise(function (resolve) {
    // ボタンを押した時点で決める（close イベントは遅れて届くことがあるので待たない）
    var done = false, form = dlg.querySelector("form");
    function finish(ok) {
      if (done) return; done = true;
      form.removeEventListener("submit", onSubmit); dlg.removeEventListener("cancel", onCancel); dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      resolve(ok);
    }
    function onSubmit(e) { e.preventDefault(); finish(!!(e.submitter && e.submitter.value === "ok")); }
    function onCancel(e) { e.preventDefault(); finish(false); }   // Esc
    function onClose() { finish(false); }
    form.addEventListener("submit", onSubmit); dlg.addEventListener("cancel", onCancel); dlg.addEventListener("close", onClose);
    dlg.showModal();
    dlg.querySelector('[value="ok"]').focus();
  });
}

/* ---- ページ全体のドロップ・貼り付け（登録された中で active なものへ渡す） ---- */
var handlers = [], overlay = null, depth = 0;
function current() {
  for (var i = handlers.length - 1; i >= 0; i--) if (!handlers[i].o.active || handlers[i].o.active()) return handlers[i];
  return null;
}
// ドロップした場所がどれかの読み込み口（owner / zone）の中なら、そちらを優先する
function ownerOf(target) {
  for (var i = handlers.length - 1; i >= 0; i--) {
    var o = handlers[i].o, box = o.owner || o.zone;
    if (box && target && box.contains(target) && (!o.active || o.active())) return handlers[i];
  }
  return null;
}
function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, "Files") >= 0; }
function showOverlay(on) {
  var h = current();
  if (!overlay) { overlay = document.createElement("div"); overlay.className = "tb-dropover"; overlay.innerHTML = "<div><span></span></div>"; document.body.appendChild(overlay); }
  if (on && h) overlay.querySelector("span").textContent = fmt(L().overlay, { kind: kindName(h.o.kind) });
  overlay.classList.toggle("show", !!(on && h));
  handlers.forEach(function (x) { if (x.o.zone) x.o.zone.classList.toggle("dragover", !!(on && x === h)); });
}
function installPageHandlers() {
  document.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; showOverlay(true); });
  document.addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = current() ? "copy" : "none"; });
  document.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) showOverlay(false); });
  // 各ツールの古いドロップ処理より先に受け取り、二重に開かないようにする
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); depth = 0; showOverlay(false);
    var h = ownerOf(e.target) || current(); if (h) h.take(e.dataTransfer.files, "drop", e.target);
  }, true);
  // 各ツールに残っている貼り付け処理より先に受け取る
  window.addEventListener("paste", function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    var h = current(); if (!h) return;
    // 文字入力欄に文字も一緒に貼り付けようとしている場合は、文字の貼り付けを優先する
    var tg = e.target, editable = tg && (tg.isContentEditable || /^(INPUT|TEXTAREA)$/.test(tg.tagName));
    if (editable && e.clipboardData.types.indexOf("text/plain") >= 0 && !accepts(files[0], h.o.accept)) return;
    e.preventDefault(); e.stopPropagation();
    h.take(files, "paste");
  }, true);
}

function attach(o) {
  var input = o.input;
  if (!input) {
    input = document.createElement("input"); input.type = "file"; input.hidden = true;
    document.body.appendChild(input);
  }
  if (o.accept) input.setAttribute("accept", o.accept);
  var formats = o.formats || formatsOf(o.accept || "");
  var busy = false;

  var lastHow = "pick";
  function deliver(file, how, target) {
    lastHow = how;
    o.onFile(file, how, target || null);
    // 読み込みは非同期のことが多いので、少し後にも文言（「別の〇〇を開く」等）を更新する
    relabel(); setTimeout(relabel, 300); setTimeout(relabel, 1000); setTimeout(relabel, 3000);
  }
  var h = {
    o: o,
    take: function (files, how, target) {
      if (busy || !files || !files.length) return;
      if (o.multiple) {
        // 何件でも受け取るツール（一覧に足していく）。足すだけなので置き換えの確認はしない
        var ok = Array.prototype.filter.call(files, function (f) { return accepts(f, o.accept); });
        if (ok.length < files.length) toast(fmt(L().badType, { formats: formats }));
        if (ok.length) { o.onFile(ok, how, target || null); relabel(); setTimeout(relabel, 300); setTimeout(relabel, 1000); setTimeout(relabel, 3000); }
        return;
      }
      var file = files[0];
      if (!accepts(file, o.accept)) { toast(fmt(L().badType, { formats: formats })); return; }
      if (files.length > 1) toast(L().many);
      if (how !== "pick" && o.confirm !== false && o.hasFile && o.hasFile(target || null)) {
        busy = true;
        confirmReplace(o.kind, file.name).then(function (ok) { busy = false; if (ok) deliver(file, how, target); });
        return;
      }
      deliver(file, how, target);
    }
  };
  // 同じ input を各ツールが元から使っている場合もあるので、change は capture で先に受け、ツール側の処理は止める
  input.addEventListener("change", function (e) {
    e.stopImmediatePropagation();
    var f = input.files; if (f && f.length) h.take(f, "pick");
    input.value = "";
  }, true);
  function pick() { input.click(); }

  // 開いているファイルの行
  var bar = null, shown = null, home = null;
  if (o.info) {
    bar = o.info; bar.className = "fd-file"; bar.hidden = true;
    bar.innerHTML = '<span class="fd-file__icon">' + kindIcon(o.kind) + '</span><span class="fd-file__text"><span class="fd-file__name"></span><span class="fd-file__meta"></span></span>';
    if (o.replace && o.openLabel) { home = document.createComment("fd-open"); o.replace.parentNode.insertBefore(home, o.replace); }
    else if (o.replace) bar.appendChild(o.replace);
  }
  function paint() {
    if (!bar || !shown) return;
    var f = shown.file || {}, name = f.name || "";
    // 貼り付けた画像は「image.png」のような名前になるので、そのときは「貼り付けた画像」と出す
    if (!name || (shown.how === "paste" && /^image\.\w+$/i.test(name))) name = fmt(L().pasted, { kind: kindName(o.kind) });
    var parts = (shown.details || []).filter(function (x) { return x != null && !(x && typeof x.then === "function"); }).map(String)
      .filter(function (x) { return x !== ""; });
    if (f.size != null && o.showSize !== false) parts.push(bytes(f.size));
    bar.querySelector(".fd-file__name").textContent = name;
    bar.querySelector(".fd-file__name").title = name;
    bar.querySelector(".fd-file__meta").textContent = parts.join(" · ");
    bar.querySelector(".fd-file__meta").hidden = !parts.length;
  }
  function show(file, details) {
    if (!bar) return;
    var me = shown = { file: file, details: (details || []).slice(), how: lastHow }; bar.hidden = false; paint();
    // 後から分かる情報（Promise）は、届いたらその位置に入れる
    me.details.forEach(function (x, i) {
      if (x && typeof x.then === "function") x.then(function (val) { if (shown === me) { me.details[i] = val; paint(); } });
    });
    if (home) bar.appendChild(o.replace);
  }
  function clear() {
    shown = null; if (!bar) return;
    bar.hidden = true;
    if (home) home.parentNode.insertBefore(o.replace, home);
  }

  if (o.zone) {
    var z = o.zone;
    if (o.fillZone) fillZone(z, o.kind, formats);
    if (!/^(BUTTON|INPUT|A)$/.test(z.tagName) && !z.hasAttribute("tabindex")) z.setAttribute("tabindex", "0");
    if (!z.getAttribute("role") && z.tagName !== "BUTTON") z.setAttribute("role", "button");
    z.addEventListener("click", function (e) {
      if (o.zoneClickable && !o.zoneClickable(e)) return;
      if (e.target.closest("button, a, input, select, textarea") && e.target.closest("button, a, input, select, textarea") !== z) return;
      e.stopImmediatePropagation(); pick();
    }, true);
    z.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (o.zoneClickable && !o.zoneClickable(e)) return;
      if (e.target !== z) return;
      e.preventDefault(); pick();
    });
  }
  if (o.replace) {
    var b = o.replace;
    b.addEventListener("click", function (e) { e.stopImmediatePropagation(); pick(); }, true);
  }
  function relabel() {
    var loaded = !!(o.hasFile && o.hasFile(null)) || (o.multiple && !!o.loaded && o.loaded());
    if (o.zone && o.fillZone) fillZone(o.zone, o.kind, formats, loaded);
    if (o.replace) {
      // 「別の〇〇を開く」ボタンは、どのツールでも同じアイコンと文言にする（まだ何も開いていなければ「〇〇を開く」）
      var label = fmt(loaded || !o.openLabel ? L().another : L().open, { kind: kindName(o.kind) });
      o.replace.removeAttribute("data-i18n");   // 言語切り替えで Shell に上書きされないように
      // ボタンの中にファイル入力があれば（label の中など）、消さないように外へ出しておく
      Array.prototype.forEach.call(o.replace.querySelectorAll('input[type="file"]'), function (el) { el.hidden = true; document.body.appendChild(el); });
      o.replace.innerHTML = OPEN_ICON + "<span>" + esc(label) + "</span>";
      // 見た目も全ツールで同じボタンにそろえる（位置決めのためのクラスは残す）
      if (o.restyle !== false && /^(BUTTON|LABEL|A)$/.test(o.replace.tagName)) {
        o.replace.classList.remove("btn--ghost", "btn--primary", "btn--sm", "btn--block");
        o.replace.classList.add("btn", "btn--secondary", "fd-another");
      }
      o.replace.setAttribute("aria-label", label); o.replace.title = label;
    }
  }
  relabel();
  if (window.Shell && Shell.onSettingsChange) Shell.onSettingsChange(function () { relabel(); paint(); });

  if (!handlers.length) installPageHandlers();
  handlers.push(h);
  return { pick: pick, open: function (file) { h.take([file], "pick"); }, input: input, refresh: relabel, show: show, clear: clear };
}

function fillZone(z, kind, formats, loaded) {
  var l = L(), key = MAC ? "⌘V" : "Ctrl+V";
  var keep = Array.prototype.slice.call(z.querySelectorAll('input[type="file"]'));   // 欄の中にある input は残す
  z.classList.add("drop", "fd-zone");
  z.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/></svg>' +
    '<b>' + esc(loaded ? fmt(l.chooseAnother, { kind: kindName(kind) }) : l.choose) + '</b>' +
    '<small>' + esc(formats) + '</small>' +
    '<small>' + esc(fmt(l.paste, { key: key })) + ' ' + esc(l.local) + '</small>';
  keep.forEach(function (el) { z.appendChild(el); });
}

window.FileDrop = { attach: attach, accepts: accepts, confirmReplace: confirmReplace, toast: toast,
  bytes: bytes, dims: dims, time: time, audio: function (rate, ch) { return lazy(function () { return audioFmt(rate, ch); }); }, audioOf: audioOf, sampleRate: sniffRate, count: count };
})();
