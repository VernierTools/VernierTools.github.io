"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/consent.js
   利用に関する同意と免責事項のダイアログ。

   ⚠ このダイアログは「過去に開いたことがあるかに関わらず」毎回表示する。
     localStorage 等で既読を記録して省略してはならない。
     本ツールは光過敏性発作という健康被害に関わるため、
     位置づけ（認証ツールではないこと）と対応範囲（SDRのみ）を
     利用のたびに確認してもらう必要がある。
   ========================================================================= */
(function (scope) {

  function T(key, fallback) {
    if (typeof Shell !== "undefined" && Shell && Shell.t) {
      var v = Shell.t(key);
      if (v !== key) return v;
    }
    return fallback;
  }
  function isJa() {
    return (typeof Shell !== "undefined" && Shell && Shell.lang) ? Shell.lang !== "en" : true;
  }

  /* =======================================================================
     本文（日英）
     ======================================================================= */
  var TEXT = {
    ja: {
      title: "【利用に関する同意と免責事項】",
      lead: "本ツールをご利用いただく前に、以下の事項をご確認ください。",
      items: [
        ["ツールの位置づけ",
         "本ツールは<b>一次チェックを目的とした参考用ツール</b>です。医療用機器や、Harding FPA等のような公式な適合認証ツールではありません。"],
        ["精度と対応範囲",
         "本ツールの判定精度は<b>100%を保証するものではありません</b>。また、現在対応しているのは<b>SDR（標準ダイナミックレンジ）動画のみ</b>であり、HDR動画等の解析には対応していません。"],
        ["技術基盤について",
         "本ツールの解析ロジックは、複数の学術論文およびオープンソースソフトウェア（OSS）の技術をベースに構築されています。"],
        ["免責事項",
         "本ツールの利用により生じたいかなる直接的・間接的損害（映像による健康被害、放送・配信時のトラブル、業務の遅延など）について、開発者は一切の責任を負いません。<b>最終的な適合性や安全性の判断は、利用者自身の責任において行ってください。</b>"]
      ],
      privacy: "動画データはブラウザ上で処理され、外部サーバーへの送信や保存は一切行われません。",
      licTitle: "オープンソースライセンス表記",
      refTitle: "参考にした規格・論文",
      agree: "同意して利用する",
      close: "閉じる",
      openLabel: "同意事項・免責・出典"
    },
    en: {
      title: "Terms of Use and Disclaimer",
      lead: "Please read the following before using this tool.",
      items: [
        ["What this tool is",
         "This is a <b>reference tool for first-pass checking</b>. It is not a medical device, nor an official conformance-certification tool such as Harding FPA."],
        ["Accuracy and scope",
         "Accuracy is <b>not guaranteed to be 100%</b>. Only <b>SDR (standard dynamic range) video</b> is supported; HDR video cannot be analysed."],
        ["Technical basis",
         "The analysis logic is built on techniques from several academic papers and open-source software."],
        ["Disclaimer",
         "The developer accepts no liability for any direct or indirect damage arising from use of this tool (including health effects from video, problems during broadcast or streaming, and delays to your work). <b>Final judgements about conformance and safety remain your own responsibility.</b>"]
      ],
      privacy: "Video is processed entirely in your browser. Nothing is uploaded to or stored on any server.",
      licTitle: "Open-source licences",
      refTitle: "Standards and papers referenced",
      agree: "I understand — continue",
      close: "Close",
      openLabel: "Terms, disclaimer and sources"
    }
  };

  /* ライセンス表記（BSD-3-Clause 第1条により、著作権表示・条件・免責の保持が必要） */
  var LICENSES = [
    {
      name: "mp4box.js 0.5.2",
      role: { ja: "MP4のdemux（同梱）", en: "MP4 demuxing (bundled)" },
      url: "https://github.com/gpac/mp4box.js",
      license: "BSD 3-Clause",
      copyright: "Copyright (c) 2012. Telecom ParisTech/TSI/MM/GPAC Cyril Concolato",
      full: "vendor/LICENSE-mp4box.txt"
    },
    {
      name: "IRIS (Electronic Arts)",
      role: { ja: "検出手法の設計を参考（コードは非流用）",
              en: "Detection approach referenced (no code reused)" },
      url: "https://github.com/electronicarts/IRIS",
      license: "BSD 3-Clause",
      copyright: "Copyright (c) 2023 Electronic Arts Inc.",
      note: { ja: "累積差分による遷移検出・1秒スライディングウィンドウ・持続性ベースの警告という設計を参考にしました。本ツールはEAの承認・推奨を受けたものではありません。",
              en: "We referenced its accumulated-difference transition detection, one-second sliding window, and duration-based warnings. This tool is not endorsed by EA." }
    }
  ];

  /* 参考にした規格・論文 */
  var REFS = {
    standards: [
      "Recommendation ITU-R BT.1702-2 (10/2019), Guidance for the reduction of photosensitive epileptic seizures caused by television",
      "Ofcom / ITC, Guidance Note for Licensees on Flashing Images and Regular Patterns in Television",
      "日本放送協会・日本民間放送連盟「アニメーション等の映像手法に関するガイドライン」（1998年制定 / 2006・2020年改訂）",
      "W3C, Web Content Accessibility Guidelines (WCAG) 2.2 — SC 2.3.1 / 2.3.2",
      "Jordan, J. B. & Vanderheiden, G. C. (2024). Proposed Photosensitive Epilepsy Hazard guidance (CC BY 4.0)"
    ],
    papers: [
      "Harding, G. et al. (2005). Photic- and pattern-induced seizures: expert consensus of the Epilepsy Foundation of America Working Group. Epilepsia 46(9):1423–1425",
      "Fisher, R. S. et al. (2005). Photic- and pattern-induced seizures: a review. Epilepsia 46(9):1426–1441",
      "Wilkins, A., Emmett, J., & Harding, G. (2005). Characterizing the patterned images that precipitate seizures and optimizing guidelines to prevent them. Epilepsia 46(8):1212–1218",
      "Harding, G., Harding, P., & Wilkins, A. (2008). Wind turbines, flicker, and photosensitive epilepsy. Epilepsia 49(6):1095–1098",
      "Fisher, R. S. et al. (2022). Visually sensitive seizures: An updated review by the Epilepsy Foundation. Epilepsia 63(4):739–768",
      "Takahashi, Y. & Fujiwara, T. (2004). Effectiveness of broadcasting guidelines for photosensitive seizure prevention. Neurology 62(6):990–993",
      "Ishiguro, Y. et al. (2004). A follow-up survey on seizures induced by animated cartoon TV program \"Pocket Monster\". Epilepsia 45(4):377–383"
    ]
  };

  /* =======================================================================
     描画
     ======================================================================= */
  function buildHTML(mode) {
    var ja = isJa();
    var t = ja ? TEXT.ja : TEXT.en;
    var lang = ja ? "ja" : "en";
    var h = "";

    h += '<h2 class="cs__title">' + t.title + "</h2>";
    h += '<p class="cs__lead">' + t.lead + "</p>";

    h += '<ul class="cs__items">';
    t.items.forEach(function (it) {
      h += "<li><b>" + it[0] + "</b><span>" + it[1] + "</span></li>";
    });
    h += "</ul>";

    h += '<p class="cs__privacy">' + t.privacy + "</p>";

    h += '<details class="cs__more"><summary>' + t.licTitle + "</summary><div>";
    LICENSES.forEach(function (l) {
      h += '<div class="cs__lic">';
      h += "<b>" + l.name + "</b> — " + l.license + "<br>";
      h += '<span class="cs__role">' + (l.role[lang] || l.role.en) + "</span><br>";
      h += '<code>' + l.copyright + "</code><br>";
      h += '<a href="' + l.url + '" target="_blank" rel="noopener noreferrer">' + l.url + "</a>";
      if (l.full) h += ' / <a href="' + l.full + '" target="_blank" rel="noopener noreferrer">' +
                       (ja ? "ライセンス全文" : "full licence text") + "</a>";
      if (l.note) h += '<p class="cs__note">' + (l.note[lang] || l.note.en) + "</p>";
      h += "</div>";
    });
    h += "</div></details>";

    h += '<details class="cs__more"><summary>' + t.refTitle + "</summary><div>";
    h += "<ul class='cs__refs'>";
    REFS.standards.forEach(function (r) { h += "<li>" + r + "</li>"; });
    h += "</ul><ul class='cs__refs'>";
    REFS.papers.forEach(function (r) { h += "<li>" + r + "</li>"; });
    h += "</ul></div></details>";

    h += '<div class="cs__row">';
    h += '<button class="btn btn--primary" data-cs="ok">' +
         (mode === "info" ? t.close : t.agree) + "</button>";
    h += "</div>";
    return h;
  }

  var overlay = null;

  /* mode: "gate"（起動時の同意）/ "info"（後から見る） */
  function open(mode, onAgree) {
    close();
    overlay = document.createElement("div");
    overlay.className = "cs";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var box = document.createElement("div");
    box.className = "cs__box";
    box.innerHTML = buildHTML(mode);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    box.querySelector('[data-cs="ok"]').addEventListener("click", function () {
      close();
      if (typeof onAgree === "function") onAgree();
    });

    /* ⚠ 起動時の同意（gate）は外側クリック・Escで閉じない。
       読み飛ばしを容易にしないため、明示的なボタン操作のみで閉じる。 */
    if (mode === "info") {
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
      document.addEventListener("keydown", escHandler);
    }
    var btn = box.querySelector('[data-cs="ok"]');
    if (btn) btn.focus();
  }
  function escHandler(e) { if (e.key === "Escape") close(); }
  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.body.style.overflow = "";
    document.removeEventListener("keydown", escHandler);
  }

  function openLabel() {
    return isJa() ? TEXT.ja.openLabel : TEXT.en.openLabel;
  }

  scope.FSConsent = {
    open: open,
    close: close,
    openLabel: openLabel,
    LICENSES: LICENSES,
    REFS: REFS
  };

})(typeof window !== "undefined" ? window : this);
