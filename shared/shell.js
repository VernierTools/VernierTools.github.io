/* =========================================================================
   Vernier — shared/shell.js
   全ページ・全ツールの共通機能。<body> 末尾で読み込む。
     <script src="{root}shared/shell.js"></script>
   ルートは自身の src から自動算出するので、ページ側でパスを書く必要はない。
   ========================================================================= */
(function () {
  "use strict";

  /* ---- サイトルートを自身の src から解決 ---- */
  var thisScript = document.currentScript ||
    (function () { var s = document.getElementsByTagName("script"); return s[s.length - 1]; })();
  var ROOT = thisScript.src.replace(/shared\/shell\.js(\?.*)?$/, "");

  /* ---- localStorage キー ---- */
  var K = { theme: "tb.theme", lang: "tb.lang", units: "tb.units" };
  function lsGet(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k,v){ try { localStorage.setItem(k,v); } catch (e) {} }
  function lsDel(k){ try { localStorage.removeItem(k); } catch (e) {} }

  /* ---- カテゴリー定義（§2）。増やすときはここへ1行 ---- */
  var CATEGORIES = [
    { id:"general", key:"cat.general" },
    { id:"text",    key:"cat.text" },
    { id:"image",   key:"cat.image" },
    { id:"video",   key:"cat.video" },
    { id:"audio",   key:"cat.audio" },
    { id:"3dcg",    key:"cat.3dcg" },
    { id:"blender", key:"cat.blender" }
  ];

  /* ---- 共通辞書（cat.* とヘッダー/一覧の文言） ---- */
  var COMMON = {
    en: {
      "cat.general":"General","cat.text":"Text","cat.image":"Image","cat.video":"Video","cat.3dcg":"3DCG","cat.blender":"Extensions","cat.audio":"Audio",
      "nav.home":"Home","nav.about":"About","hub.search":"Search tools…","hub.all":"All",
      "hub.empty":"No tools found.","badge.addonSuffix":" add-on",
      "theme.auto":"Theme: auto","theme.light":"Theme: light","theme.dark":"Theme: dark",
      "units.metric":"Metric","units.imperial":"Imperial","copied":"Copied"
    },
    ja: {
      "cat.general":"ジェネラル","cat.text":"文章","cat.image":"画像","cat.video":"映像","cat.3dcg":"3DCG","cat.blender":"拡張機能","cat.audio":"音声",
      "nav.home":"ホーム","nav.about":"About","hub.search":"ツールを検索…","hub.all":"すべて",
      "hub.empty":"該当するツールがありません。","badge.addonSuffix":"アドオン",
      "theme.auto":"テーマ: 自動","theme.light":"テーマ: ライト","theme.dark":"テーマ: ダーク",
      "units.metric":"メートル法","units.imperial":"ヤード・ポンド法","copied":"コピーしました"
    }
  };

  /* ---- 言語解決 ---- */
  function resolveLang(){
    var stored = lsGet(K.lang);
    if (stored) return stored;                       // 明示指定
    var nav = (navigator.language || "en").toLowerCase();
    return nav.indexOf("ja") === 0 ? "ja" : "en";    // ja* → ja、他 → en
  }
  var LANG = resolveLang();
  var STRINGS = { en: {}, ja: {} };                  // COMMON + ツール文言のマージ先
  function mergeStrings(dict){
    if (!dict) return;
    Object.keys(dict).forEach(function (lng){
      STRINGS[lng] = STRINGS[lng] || {};
      var d = dict[lng]; for (var k in d) if (d.hasOwnProperty(k)) STRINGS[lng][k] = d[k];
    });
  }
  mergeStrings(COMMON);

  function t(key){
    var byLang = STRINGS[LANG] || {};
    if (key in byLang) return byLang[key];
    var en = STRINGS.en || {};
    return (key in en) ? en[key] : key;              // 未翻訳は en → 無ければキー
  }

  /* ---- テーマ解決。tb.theme = light|dark、無ければ auto(OS追従) ---- */
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : { matches:false, addEventListener:function(){}, addListener:function(){} };
  function themeMode(){ return lsGet(K.theme) || "auto"; }           // auto|light|dark
  function applyTheme(){
    var mode = themeMode();
    var resolved = (mode === "auto") ? (mq.matches ? "dark" : "light") : mode;
    document.documentElement.setAttribute("data-theme", resolved);
    return resolved;
  }
  function cycleTheme(){                                              // auto → light → dark → auto
    var order = ["auto","light","dark"], i = order.indexOf(themeMode());
    var next = order[(i + 1) % order.length];
    if (next === "auto") lsDel(K.theme); else lsSet(K.theme, next);
    applyTheme(); updateThemeBtn(); notify();
  }
  if (mq.addEventListener) mq.addEventListener("change", function(){ if (themeMode()==="auto"){ applyTheme(); notify(); } });
  else if (mq.addListener) mq.addListener(function(){ if (themeMode()==="auto"){ applyTheme(); notify(); } });

  /* ---- 単位 ---- */
  function unitSystem(){ return lsGet(K.units) || "metric"; }        // metric|imperial
  function setUnits(sys){ lsSet(K.units, sys); syncUnitUI(); notify(); }
  var CONV = { // 内部保持は SI 基準（length=m, mass=kg）
    length: function(v, sys){
      if (sys === "imperial"){ var inch = v/0.0254; return inch < 12 ? { value: r(inch,2), unit:"in" } : { value: r(inch/12,2), unit:"ft" }; }
      if (v < 0.01) return { value: r(v*1000,1), unit:"mm" };
      if (v < 1)    return { value: r(v*100,1),  unit:"cm" };
      return { value: r(v,3), unit:"m" };
    },
    mass: function(v, sys){
      if (sys === "imperial") return { value: r(v/0.45359237,2), unit:"lb" };
      return v < 1 ? { value: r(v*1000,1), unit:"g" } : { value: r(v,3), unit:"kg" };
    }
  };
  function r(n,dp){ var m = Math.pow(10,dp); return Math.round(n*m)/m; }

  /* ---- 設定変更の通知（ツールの onSettingsChange と data-i18n 更新） ---- */
  var listeners = [];
  var redrawers = [];   // 一覧/カテゴリの再描画関数（言語・単位変更時に呼ぶ）
  function settings(){ return { lang:LANG, theme:applyThemeGet(), units:unitSystem() }; }
  function applyThemeGet(){ return document.documentElement.getAttribute("data-theme") || "light"; }
  function notify(){
    applyI18n();
    redrawers.forEach(function (fn){ try { fn(); } catch (e) {} });   // カード類を現在言語で描き直す
    var s = settings();
    listeners.forEach(function (fn){ try { fn(s); } catch (e) {} });
  }
  function applyI18n(){
    document.querySelectorAll("[data-i18n]").forEach(function (el){
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el){
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    document.documentElement.setAttribute("lang", LANG);
  }

  /* ---- クリップボード ---- */
  var toastEl = null;
  function copy(text, el){
    var done = function(){
      if (el){ toast(t("copied")); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(String(text)).then(done, function(){ fallbackCopy(String(text)); done(); });
    } else { fallbackCopy(String(text)); done(); }
  }
  function fallbackCopy(text){
    var ta = document.createElement("textarea"); ta.value = text;
    ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); } catch(e){} document.body.removeChild(ta);
  }
  function toast(msg){
    if (!toastEl){ toastEl = document.createElement("div"); toastEl.className="tb-copied"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastEl._t); toastEl._t = setTimeout(function(){ toastEl.classList.remove("show"); }, 1100);
  }

  /* =======================================================================
     HEADER 注入（fetch 不使用 → file:// でも動く）
     ======================================================================= */
  var svgGlobe = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>';
  var svgMoon  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';

  var GITHUB_URL = "https://github.com/VernierTools/VernierTools.github.io";

  var themeBtn, langBtn, menuPanel, segBtns = [];
  var brandBtn, brandMenu;
  var mqMobile = window.matchMedia ? window.matchMedia("(max-width:760px)") : { matches:false };
  function navLinks(prefix){ // prefix: '' from root, 'categories/…' 用に ROOT 基準で組む
    var home = '<a href="'+ROOT+'index.html" data-i18n="nav.home">'+t("nav.home")+'</a>';
    var cats = CATEGORIES.map(function(c){
      return '<a href="'+ROOT+'categories/'+c.id+'.html" data-cat="'+c.id+'" data-i18n="'+c.key+'">'+t(c.key)+'</a>';
    }).join("");
    return home + cats;
  }
  // Home + カテゴリー + About + GitHub（ブランドのドロップダウン用、および
  // モバイルではハンバーガーメニューにも同じ内容を統合して二重の入口を作らない）
  function navLinksExtended(){
    var about  = '<a href="'+ROOT+'about.html" data-i18n="nav.about">'+t("nav.about")+'</a>';
    var github = '<a href="'+GITHUB_URL+'" target="_blank" rel="noopener noreferrer">GitHub</a>';
    return navLinks() + about + github;
  }
  function buildHeader(){
    var h = document.createElement("header");
    h.className = "tb-header";
    h.innerHTML =
      '<div class="tb-header__in">'+
        '<div class="tb-brandwrap">'+
          '<button class="tb-brand" type="button" aria-haspopup="true" aria-expanded="false">'+
            '<span class="tb-brand__mark"></span><span class="tb-brand__label">Vernier</span>'+
          '</button>'+
          '<nav class="tb-brandmenu">'+navLinksExtended()+'</nav>'+
        '</div>'+
        '<nav class="tb-nav">'+navLinks()+'</nav>'+
        '<div class="tb-sp"></div>'+
        '<div class="tb-seg" role="group" aria-label="Units">'+
          '<button data-units="metric" data-i18n="units.metric">'+t("units.metric")+'</button>'+
          '<button data-units="imperial" data-i18n="units.imperial">'+t("units.imperial")+'</button>'+
        '</div>'+
        '<button class="tb-langbtn" aria-label="Language">'+svgGlobe+'<span class="tb-langlbl"></span></button>'+
        '<button class="tb-iconbtn tb-themebtn" aria-label="Theme">'+svgMoon+'</button>'+
      '</div>'+
      '<nav class="tb-menu">'+navLinksExtended()+'</nav>';
    document.body.insertBefore(h, document.body.firstChild);

    // refs
    themeBtn  = h.querySelector(".tb-themebtn");
    langBtn   = h.querySelector(".tb-langbtn");
    menuPanel = h.querySelector(".tb-menu");
    brandBtn  = h.querySelector(".tb-brand");
    brandMenu = h.querySelector(".tb-brandmenu");
    segBtns   = Array.prototype.slice.call(h.querySelectorAll(".tb-seg button"));

    // wire
    themeBtn.addEventListener("click", cycleTheme);
    langBtn.addEventListener("click", function(){ LANG = (LANG === "ja" ? "en" : "ja"); lsSet(K.lang, LANG); syncLangUI(); notify(); });
    segBtns.forEach(function(b){ b.addEventListener("click", function(){ setUnits(b.getAttribute("data-units")); }); });

    // ブランドボタン: PC幅ではドロップダウン(.tb-brandmenu)、モバイル幅では
    // アイコンがハンバーガーに差し替わり、既存のメニューパネル(.tb-menu)を開閉する
    // （入口を二重にしないため、同じボタンが両方の役割を兼ねる）
    brandBtn.addEventListener("click", function(e){
      e.stopPropagation();
      var panel = mqMobile.matches ? menuPanel : brandMenu;
      var open = panel.classList.toggle("open");
      brandBtn.setAttribute("aria-expanded", String(open));
      var other = mqMobile.matches ? brandMenu : menuPanel;
      other.classList.remove("open");
    });
    document.addEventListener("click", function(e){
      var panel = mqMobile.matches ? menuPanel : brandMenu;
      if (panel.classList.contains("open") && !panel.contains(e.target) && e.target !== brandBtn && !brandBtn.contains(e.target)){
        panel.classList.remove("open");
        brandBtn.setAttribute("aria-expanded","false");
      }
    });
    document.addEventListener("keydown", function(e){
      var panel = mqMobile.matches ? menuPanel : brandMenu;
      if (e.key === "Escape" && panel.classList.contains("open")){
        panel.classList.remove("open");
        brandBtn.setAttribute("aria-expanded","false");
        brandBtn.focus();
      }
    });

    // 現在ページのナビをハイライト
    var here = location.pathname.split("/").pop() || "index.html";
    var _catEl = document.querySelector("[data-tools-category]");
    var bodyCat = _catEl ? _catEl.getAttribute("data-tools-category") : null;
    h.querySelectorAll(".tb-nav a, .tb-menu a, .tb-brandmenu a").forEach(function(a){
      var cat = a.getAttribute("data-cat");
      if ((bodyCat && cat === bodyCat) || (!bodyCat && /index\.html$/.test(a.getAttribute("href")) && here === "index.html"))
        a.setAttribute("aria-current","page");
    });

    updateThemeBtn(); syncLangUI(); syncUnitUI();
  }
  function updateThemeBtn(){ if (themeBtn) themeBtn.title = t("theme." + themeMode()); }
  function syncLangUI(){ var l = langBtn && langBtn.querySelector(".tb-langlbl"); if (l) l.textContent = LANG.toUpperCase(); }
  function syncUnitUI(){ var sys = unitSystem(); segBtns.forEach(function(b){ b.setAttribute("aria-pressed", String(b.getAttribute("data-units") === sys)); }); }

  /* =======================================================================
     HUB / CATEGORY レンダリング（tools.json を fetch）
       <div data-tools-home></div>            → 検索 + チップ + グリッド
       <div data-tools-category="image"></div>→ 該当カテゴリのグリッド
     ======================================================================= */
  var defaultIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

  function loc(field){ // {en,ja} → 現在言語（無ければ en）
    if (field == null) return "";
    if (typeof field === "string") return field;
    return field[LANG] || field.en || Object.values(field)[0] || "";
  }
  function cardHTML(tool){
    var name = loc(tool.name), desc = loc(tool.description);
    var ico  = tool.icon ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="'+tool.icon+'"/></svg>' : defaultIcon;
    var tags = (tool.categories||[]).map(function(id){ return '<span class="tag">'+t("cat."+id)+'</span>'; }).join("");
    // アドオン系バッジ: tool.platform（"Blender"/"FreeCAD"等、ソフト名は翻訳しない固有名詞）
    // + 現在言語の「アドオン」接尾辞。platform 未指定時は cat.blender（"Extensions"/"拡張機能"）にフォールバック。
    var bl   = tool.type === "blender"
      ? '<span class="bl-badge">'+esc(tool.platform || t("cat.blender"))+t("badge.addonSuffix")+'</span>'
      : "";
    return '<a class="toolcard" href="'+ROOT+tool.path+'">'+bl+
      '<div class="toolcard__ico">'+ico+'</div>'+
      '<h3>'+esc(name)+'</h3><p>'+esc(desc)+'</p>'+
      '<div class="toolcard__tags">'+tags+'</div></a>';
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function haystack(tool){
    var parts = [tool.id];
    ["name","description"].forEach(function(f){ var v=tool[f]; if(v) Object.keys(v).forEach(function(k){ parts.push(v[k]); }); });
    (tool.keywords||[]).forEach(function(k){ parts.push(k); });
    return parts.join(" ").toLowerCase();
  }

  function renderHub(mount){
    var tools = [];
    var state = { q:"", cat:"all" };

    mount.innerHTML =
      '<div class="searchwrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>'+
      '<input class="search" data-i18n-ph="hub.search" placeholder="'+t("hub.search")+'"></div>'+
      '<div class="filterchips"></div>'+
      '<div class="hub-sections"></div>'+
      '<div class="empty" data-i18n="hub.empty" hidden>'+t("hub.empty")+'</div>';

    var input = mount.querySelector(".search");
    var chipsBox = mount.querySelector(".filterchips");
    var sections = mount.querySelector(".hub-sections");
    var empty = mount.querySelector(".empty");

    var chips = [{ id:"all", key:"hub.all" }].concat(CATEGORIES);
    chipsBox.innerHTML = chips.map(function(c){
      return '<button class="fchip" data-cat="'+c.id+'" data-i18n="'+c.key+'" aria-pressed="'+(c.id==="all")+'">'+t(c.key)+'</button>';
    }).join("");

    function draw(){
      var q = state.q.trim().toLowerCase();
      function matches(tl){ return !q || haystack(tl).indexOf(q) >= 0; }
      var anyShown = false, html = "";

      if (state.cat === "all"){
        // カテゴリー順（CATEGORIES配列の並び = ジェネラル→…→拡張機能）に、
        // 見出し + そのカテゴリーのグリッドを並べる。該当0件のカテゴリーは丸ごと省く。
        CATEGORIES.forEach(function(c){
          var shown = tools.filter(function(tl){ return (tl.categories||[]).indexOf(c.id) >= 0 && matches(tl); });
          if (!shown.length) return;
          anyShown = true;
          html += '<div class="section">'+
            '<div class="section__head"><h2 data-i18n="'+c.key+'">'+t(c.key)+'</h2></div>'+
            '<div class="grid">'+shown.map(cardHTML).join("")+'</div></div>';
        });
      } else {
        // 特定カテゴリーで絞り込み中は、見出し無しの単一グリッド
        var shown = tools.filter(function(tl){ return (tl.categories||[]).indexOf(state.cat) >= 0 && matches(tl); });
        anyShown = shown.length > 0;
        if (anyShown) html = '<div class="grid">'+shown.map(cardHTML).join("")+'</div>';
      }
      sections.innerHTML = html;
      empty.hidden = anyShown;
    }
    input.addEventListener("input", function(){ state.q = input.value; syncHash(); draw(); });
    chipsBox.addEventListener("click", function(e){
      var b = e.target.closest(".fchip"); if (!b) return;
      state.cat = b.getAttribute("data-cat");
      chipsBox.querySelectorAll(".fchip").forEach(function(x){ x.setAttribute("aria-pressed", String(x===b)); });
      syncHash(); draw();
    });
    function syncHash(){
      var p = [];
      if (state.q) p.push("q="+encodeURIComponent(state.q));
      if (state.cat !== "all") p.push("cat="+encodeURIComponent(state.cat));
      history.replaceState(null, "", p.length ? "#"+p.join("&") : location.pathname + location.search);
    }
    (function readHash(){
      var h = location.hash.replace(/^#/, "");
      h.split("&").forEach(function(kv){
        var m = kv.split("="); if (m[0]==="q") state.q = decodeURIComponent(m[1]||"");
        if (m[0]==="cat") state.cat = decodeURIComponent(m[1]||"");
      });
      if (state.q) input.value = state.q;
      if (state.cat !== "all"){
        var b = chipsBox.querySelector('[data-cat="'+state.cat+'"]');
        if (b){ chipsBox.querySelectorAll(".fchip").forEach(function(x){ x.setAttribute("aria-pressed", String(x===b)); }); }
      }
    })();

    redrawers.push(draw);   // 言語/単位変更時に再描画
    fetchTools(function(list){ tools = list; draw(); });
  }

  function renderCategory(mount, catId){
    var grid = document.createElement("div"); grid.className = "grid";
    var empty = document.createElement("div"); empty.className = "empty"; empty.setAttribute("data-i18n","hub.empty");
    empty.textContent = t("hub.empty"); empty.hidden = true;
    mount.appendChild(grid); mount.appendChild(empty);
    var _list = [];
    function draw(){
      var shown = _list.filter(function(tl){ return (tl.categories||[]).indexOf(catId) >= 0; });
      grid.innerHTML = shown.map(cardHTML).join(""); empty.hidden = shown.length > 0;
    }
    redrawers.push(draw);   // 言語/単位変更時に再描画
    fetchTools(function(list){ _list = list; draw(); });
  }

  var _toolsCache = null;
  function fetchTools(cb){
    if (_toolsCache){ cb(_toolsCache); return; }
    fetch(ROOT + "tools.json", { cache:"no-cache" })
      .then(function(r){ return r.json(); })
      .then(function(data){ _toolsCache = (data && data.tools) || []; cb(_toolsCache); })
      .catch(function(){
        var m = document.querySelector("[data-tools-home],[data-tools-category]");
        if (m) m.insertAdjacentHTML("beforeend",
          '<div class="empty">Could not load tools.json — open via a local server (not file://).</div>');
      });
  }

  /* =======================================================================
     公開 API
     ======================================================================= */
  var Shell = {
    root: ROOT,
    get lang(){ return LANG; },
    get theme(){ return applyThemeGet(); },
    t: t,
    copy: copy,
    units: {
      get system(){ return unitSystem(); },
      set: setUnits,
      format: function(value, kind){ var f = CONV[kind]; return f ? f(value, unitSystem()) : { value:value, unit:"" }; }
    },
    onSettingsChange: function(fn){ if (typeof fn === "function") listeners.push(fn); },
    init: function(opts){
      opts = opts || {};
      if (opts.strings) mergeStrings(opts.strings);
      if (typeof opts.onSettingsChange === "function") listeners.push(opts.onSettingsChange);
      applyI18n();
      // 数値クリックコピー（readout の [data-copy]）
      document.addEventListener("click", function(e){
        var el = e.target.closest("[data-copy]"); if (!el) return;
        copy(el.getAttribute("data-copy") || el.textContent.trim(), el);
      });
      // init 後、ツール側に一度現在設定を渡す
      if (typeof opts.onSettingsChange === "function") opts.onSettingsChange(settings());
    }
  };
  window.Shell = Shell;

  /* ---- 起動 ---- */
  applyTheme();
  function boot(){
    buildHeader();
    applyI18n();
    var home = document.querySelector("[data-tools-home]");
    if (home) renderHub(home);
    var cat = document.querySelector("[data-tools-category]");
    if (cat) renderCategory(cat, cat.getAttribute("data-tools-category"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
