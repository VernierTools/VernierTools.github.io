"use strict";
/* =========================================================================
   Vernier — tools/flash-safety/player.js
   プレビュープレイヤー + タイムライン描画（仕様書 §9.2）

   ⚠ 本ツールは「光過敏性発作を誘発しうる映像を再生する装置」でもある。
     §9.2.1 の安全要件は仕様であって推奨ではない。以下を必ず守る:
       1. 自動再生しない
       2. 抵触検出時は初回再生前に確認を挟む
       3. 危険区間スキップ / 輝度低減 / コマ送り専用 を提供する
       4. 1倍を超える再生速度を提供しない（早送りは点滅周波数を上げる）
   ========================================================================= */
(function (scope) {

  var LEVEL_NONE = 0, LEVEL_CAUTION = 1, LEVEL_FAIL = 2;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function fmtTime(us) {
    var s = us / 1e6;
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ":" + (r < 10 ? "0" : "") + r.toFixed(2);
  }
  function t(key, fallback) {
    if (typeof Shell !== "undefined" && Shell && Shell.t) {
      var v = Shell.t(key);
      if (v !== key) return v;
    }
    return fallback;
  }

  /* =======================================================================
     斜線パターン（抵触区間の塗り）
     ベタ塗りより、スクリーンショットや印刷でも識別しやすい。
     ======================================================================= */
  function makeStripe(ctx, color) {
    var c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    var g = c.getContext("2d");
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(-2, 10); g.lineTo(10, -2);
    g.moveTo(2, 14); g.lineTo(14, 2);
    g.stroke();
    return ctx.createPattern(c, "repeat");
  }

  /* ラベル領域の幅。描画側と入力側で必ず同じ値を使うこと。 */
  function gutterFor(cssW, narrow) {
    if (narrow) return 56;
    return cssW >= 780 ? 116 : 84;
  }

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  /* =======================================================================
     Player
     ======================================================================= */
  function Player(mount, opts) {
    this.mount = mount;
    this.file = opts.file;
    this.timeline = opts.timeline;
    this.verdicts = opts.verdicts || {};
    this.fps = opts.fps || 30;
    this.durationUs = (this.timeline && this.timeline.t1) || 0;

    this.skipDanger = false;
    this.dimmed = false;
    this.stepOnly = false;
    this.confirmed = false;
    this.hoverUs = null;
    this.seekError = null;        // コマ送りの実測誤差（秒）
    this.requestedTime = null;
    this.actualTime = null;
    this._rvfc = null;

    // 抵触区間（全基準の和集合）— スキップとオーバーレイに使う
    this.failSpans = this._collectSpans(LEVEL_FAIL);
    this.hasFail = this.failSpans.length > 0;

    this._build();
    this._wire();
    this.draw();
  }

  Player.prototype._collectSpans = function (level) {
    var out = [];
    (this.timeline.lanes || []).forEach(function (lane) {
      if (lane.reference) return;                  // 参考レーンは含めない
      (lane.spans || []).forEach(function (s) {
        if (s.level >= level) out.push({ t0: s.t0, t1: s.t1 });
      });
    });
    out.sort(function (a, b) { return a.t0 - b.t0; });
    // 重なりを統合
    var merged = [];
    out.forEach(function (s) {
      var last = merged[merged.length - 1];
      if (last && s.t0 <= last.t1 + 100000) last.t1 = Math.max(last.t1, s.t1);
      else merged.push({ t0: s.t0, t1: s.t1 });
    });
    return merged;
  };

  Player.prototype._build = function () {
    var m = this.mount;
    m.innerHTML = "";
    m.className = "player";

    /* --- プレビュー --- */
    var stage = el("div", "player__stage");
    this.video = document.createElement("video");
    this.video.className = "player__video";
    this.video.playsInline = true;
    this.video.preload = "metadata";
    this.video.src = URL.createObjectURL(this.file);
    // ⚠ 自動再生しない（§9.2.1-1）
    this.video.autoplay = false;
    stage.appendChild(this.video);

    this.overlay = el("div", "player__overlay", '<span>' + t("t.overlayHit", "抵触区間") + '</span>');
    this.overlay.hidden = true;
    stage.appendChild(this.overlay);
    m.appendChild(stage);

    /* --- トランスポート --- */
    var tr = el("div", "player__transport");
    this.btnStart = el("button", "pbtn", icon("start"));
    this.btnPrevHit = el("button", "pbtn", icon("prevhit"));
    this.btnStepBack = el("button", "pbtn", icon("stepb"));
    this.btnPlay = el("button", "pbtn pbtn--primary", icon("play"));
    this.btnStepFwd = el("button", "pbtn", icon("stepf"));
    this.btnNextHit = el("button", "pbtn", icon("nexthit"));
    this.btnStart.title = t("t.toStart", "最初に戻る");
    this.btnPrevHit.title = t("t.prevHit", "前の抵触へ");
    this.btnStepBack.title = t("t.prevFrame", "1コマ戻る");
    this.btnPlay.title = t("t.play", "再生 / 一時停止");
    this.btnStepFwd.title = t("t.nextFrame", "1コマ送る");
    this.btnNextHit.title = t("t.nextHit", "次の抵触へ");
    [this.btnStart, this.btnPrevHit, this.btnStepBack, this.btnPlay, this.btnStepFwd, this.btnNextHit]
      .forEach(function (b) { tr.appendChild(b); });

    this.timeLabel = el("span", "player__time", "0:00.00 / 0:00.00");
    tr.appendChild(this.timeLabel);

    // ⚠ 1倍を超える速度は提供しない（§9.2.1-7）
    this.speed = el("select", "select player__speed");
    [["0.25", "0.25x"], ["0.5", "0.5x"], ["1", "1x"]].forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0]; op.textContent = o[1];
      if (o[0] === "1") op.selected = true;
      this.speed.appendChild(op);
    }, this);
    tr.appendChild(this.speed);
    m.appendChild(tr);

    /* --- 安全オプション --- */
    var safe = el("div", "player__safety");
    this.cbSkip = toggle(t("t.skipDanger", "危険区間をスキップ"));
    this.cbDim = toggle(t("t.dimPlayback", "輝度を下げて再生"));
    this.cbStep = toggle(t("t.stepOnly", "静止画で送る"));
    safe.appendChild(this.cbSkip.root);
    safe.appendChild(this.cbDim.root);
    safe.appendChild(this.cbStep.root);
    m.appendChild(safe);

    /* 抵触があるときは「輝度を下げて再生」を初期ONにする（§9.2.1-4）
       内容の確認はできて刺激は大幅に減るため、これを既定の安全側とする。 */
    if (this.hasFail) {
      this.cbDim.input.checked = true;
      this.dimmed = true;
      this._applyDim();
    }

    /* --- タイムライン --- */
    this.canvas = document.createElement("canvas");
    this.canvas.className = "player__timeline";
    m.appendChild(this.canvas);

    this.legend = el("div", "player__legend",
      '<span class="lg lg--fail"></span>' + t("t.legendFail", "抵触") +
      '<span class="lg lg--caution"></span>' + t("t.legendCaution", "要注意") +
      '<span class="lg lg--ref"></span>' + t("t.legendRef", "参考（空間パターン等）"));
    m.appendChild(this.legend);

    function toggle(label) {
      var root = el("label", "toggle");
      var input = document.createElement("input");
      input.type = "checkbox";
      var track = el("span", "track");
      var txt = el("span", null, label);
      root.appendChild(input); root.appendChild(track); root.appendChild(txt);
      return { root: root, input: input };
    }
    function icon(kind) {
      var p = {
        start: '<path d="M6 5v14M19 5l-9 7 9 7z"/>',
        prevhit: '<path d="M11 5l-8 7 8 7z"/><path d="M19 5v14"/>',
        stepb: '<path d="M15 5l-8 7 8 7z"/>',
        play: '<path d="M7 4l13 8-13 8z"/>',
        pause: '<path d="M8 4v16M16 4v16"/>',
        stepf: '<path d="M9 5l8 7-8 7z"/>',
        nexthit: '<path d="M13 5l8 7-8 7z"/><path d="M5 5v14"/>'
      }[kind];
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
             'stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
    }
  };

  Player.prototype._wire = function () {
    var self = this;

    this.btnPlay.addEventListener("click", function () { self.toggle(); });
    this.btnStart.addEventListener("click", function () {
      self.video.pause(); self.video.currentTime = 0; self.draw();
    });
    this.btnStepBack.addEventListener("click", function () { self.step(-1); });
    this.btnStepFwd.addEventListener("click", function () { self.step(1); });
    this.btnPrevHit.addEventListener("click", function () { self.jumpHit(-1); });
    this.btnNextHit.addEventListener("click", function () { self.jumpHit(1); });

    this.speed.addEventListener("change", function () {
      var v = parseFloat(self.speed.value);
      if (v > 1) v = 1;                       // 保険: 1倍超は許可しない
      self.video.playbackRate = v;
    });

    this.cbSkip.input.addEventListener("change", function () {
      self.skipDanger = this.checked;
    });
    this.cbDim.input.addEventListener("change", function () {
      self.dimmed = this.checked; self._applyDim();
    });
    this.cbStep.input.addEventListener("change", function () {
      self.stepOnly = this.checked;
      if (self.stepOnly) { self.video.pause(); }
      self.btnPlay.disabled = self.stepOnly;   // 連続再生を禁止（§9.2.1-5）
      self.draw();
    });

    this.video.addEventListener("timeupdate", function () { self._onTime(); });
    this.video.addEventListener("play", function () { self._syncPlayBtn(); });
    this.video.addEventListener("pause", function () { self._syncPlayBtn(); });
    this.video.addEventListener("loadedmetadata", function () { self.draw(); });

    /* タイムラインのクリック / スクラブ */
    var dragging = false;
    /* 描画側と同じ左マージンを使う。ここを合わせないとクリック位置がずれる。 */
    function gutter() {
      return gutterFor(self.canvas.clientWidth || 600, window.innerWidth <= 760);
    }
    function fracFromEvent(ev) {
      var r = self.canvas.getBoundingClientRect();
      var padL = gutter(), padR = 8;
      var w = Math.max(10, r.width - padL - padR);
      var x = (ev.clientX - r.left - padL) / w;
      return Math.max(0, Math.min(1, x));
    }
    function seekFromEvent(ev) {
      var dur = self.video.duration || (self.durationUs / 1e6);
      self.video.currentTime = fracFromEvent(ev) * dur;
      self.draw();
    }
    this.canvas.addEventListener("pointerdown", function (ev) {
      ev.preventDefault(); dragging = true; seekFromEvent(ev);
      self.canvas.setPointerCapture(ev.pointerId);
    });
    this.canvas.addEventListener("pointermove", function (ev) {
      var dur = self.video.duration || (self.durationUs / 1e6);
      self.hoverUs = fracFromEvent(ev) * dur * 1e6;
      if (dragging) seekFromEvent(ev); else self.draw();
    });
    this.canvas.addEventListener("pointerleave", function () { self.hoverUs = null; self.draw(); });
    this.canvas.addEventListener("pointerup", function () { dragging = false; });

    /* キーボード操作（§9.2.2） */
    this.mount.tabIndex = 0;
    this.mount.addEventListener("keydown", function (ev) {
      switch (ev.key) {
        case " ": ev.preventDefault(); self.toggle(); break;
        case "ArrowLeft": ev.preventDefault(); self.step(-1); break;
        case "ArrowRight": ev.preventDefault(); self.step(1); break;
        case ",": ev.preventDefault(); self.jumpHit(-1); break;
        case ".": ev.preventDefault(); self.jumpHit(1); break;
        case "Home": ev.preventDefault(); self.video.currentTime = 0; break;
      }
    });

    window.addEventListener("resize", function () { self.draw(); });
    if (typeof Shell !== "undefined" && Shell && Shell.onSettingsChange) {
      Shell.onSettingsChange(function () { self.draw(); });
    }
  };

  Player.prototype._applyDim = function () {
    // 輝度差を実効的に下げる。内容の確認はできて刺激は大幅に減る（§9.2.1-4）
    this.video.style.filter = this.dimmed ? "brightness(0.35) contrast(0.7)" : "";
  };

  Player.prototype._syncPlayBtn = function () {
    var playing = !this.video.paused;
    this.btnPlay.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 4v16M16 4v16"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4l13 8-13 8z"/></svg>';
    if (playing) this._raf(); 
  };

  /* 再生。抵触があるときは初回に確認を挟む（§9.2.1-2） */
  Player.prototype.toggle = function () {
    if (this.stepOnly) return;
    if (!this.video.paused) { this.video.pause(); return; }
    this.seekError = null;                    // 再生を始めたら誤差表示は消す
    if (this.hasFail && !this.confirmed) { this._askConfirm(); return; }
    this.video.play();
  };

  Player.prototype._askConfirm = function () {
    var self = this;
    var back = el("div", "confirm");
    var box = el("div", "confirm__box");
    box.appendChild(el("h3", null, t("t.playWarnTitle", "点滅を含む映像を再生します")));
    box.appendChild(el("p", null, t("t.playWarnBody",
      "この動画には基準を超える点滅が検出されています。再生すると実際に点滅が表示されます。光感受性のある方はご注意ください。")));
    var row = el("div", "confirm__row");

    var bDim = el("button", "btn btn--primary", t("t.playDimmed", "輝度を下げて再生"));
    var bSkip = el("button", "btn btn--secondary", t("t.playSkipping", "危険区間をスキップして再生"));
    var bAny = el("button", "btn btn--ghost", t("t.playAnyway", "そのまま再生"));
    var bCancel = el("button", "btn btn--ghost", t("t.cancel", "やめる"));

    function close() { document.body.removeChild(back); }
    bDim.addEventListener("click", function () {
      self.cbDim.input.checked = true; self.dimmed = true; self._applyDim();
      self.cbSkip.input.checked = false; self.skipDanger = false;
      self.confirmed = true; close(); self.video.play();
    });
    bSkip.addEventListener("click", function () {
      self.cbSkip.input.checked = true; self.skipDanger = true;
      self.cbDim.input.checked = false; self.dimmed = false; self._applyDim();
      self.confirmed = true; close(); self.video.play();
    });
    bAny.addEventListener("click", function () {
      /* 「そのまま再生」は文字どおり無加工で再生する。
         抵触検出時は輝度低減を初期ONにしているが、ここで明示的に解除しないと
         「そのまま」を選んだのに減光されたままになる（利用者の選択と表示が食い違う）。
         スキップも同様に解除する。 */
      self.cbDim.input.checked = false; self.dimmed = false; self._applyDim();
      self.cbSkip.input.checked = false; self.skipDanger = false;
      self.confirmed = true; close(); self.video.play();
    });
    bCancel.addEventListener("click", close);

    [bDim, bSkip, bAny, bCancel].forEach(function (b) { row.appendChild(b); });
    box.appendChild(row);
    back.appendChild(box);
    document.body.appendChild(back);
    bDim.focus();
  };

  /* コマ送り。§9.2.5
     ⚠ video.currentTime へのシークはフレーム厳密ではない。
        キーフレームまで戻って前方デコードするため誤差が出る。
        requestVideoFrameCallback で「実際に表示されたフレームの時刻」を
        実測し、指定値とのずれを表示する。判定結果は解析側が正であり、
        プレビューの表示位置は参考値であることを利用者に見せるため。 */
  Player.prototype.step = function (dir) {
    this.video.pause();
    var d = 1 / (this.fps || 30);
    var target = Math.max(0, this.video.currentTime + dir * d);
    this.requestedTime = target;
    this.video.currentTime = target;
    this._measureSeek(target);
    this.draw();
  };

  Player.prototype._measureSeek = function (target) {
    var self = this;
    if (typeof this.video.requestVideoFrameCallback !== "function") {
      this.seekError = null;      // 非対応ブラウザでは表示しない
      return;
    }
    if (this._rvfc) { try { this.video.cancelVideoFrameCallback(this._rvfc); } catch (e) {} }
    this._rvfc = this.video.requestVideoFrameCallback(function (now, meta) {
      self._rvfc = null;
      if (meta && typeof meta.mediaTime === "number") {
        self.actualTime = meta.mediaTime;
        self.seekError = meta.mediaTime - target;
        self.draw();
      }
    });
  };

  Player.prototype.jumpHit = function (dir) {
    var cur = this.video.currentTime * 1e6;
    var spans = this.failSpans;
    if (!spans.length) return;
    var target = null;
    if (dir > 0) {
      for (var i = 0; i < spans.length; i++) {
        if (spans[i].t0 > cur + 1000) { target = spans[i].t0; break; }
      }
    } else {
      for (var j = spans.length - 1; j >= 0; j--) {
        if (spans[j].t0 < cur - 1000) { target = spans[j].t0; break; }
      }
    }
    if (target != null) {
      this.video.currentTime = target / 1e6;
      this.draw();
    }
  };

  Player.prototype._onTime = function () {
    var us = this.video.currentTime * 1e6;

    // 危険区間のスキップ（§9.2.1-3）
    if (this.skipDanger && !this.video.paused) {
      for (var i = 0; i < this.failSpans.length; i++) {
        var s = this.failSpans[i];
        if (us >= s.t0 - 50000 && us < s.t1) {
          this.video.currentTime = (s.t1 + 60000) / 1e6;
          this._toast(t("t.skipped", "危険区間をスキップしました"));
          break;
        }
      }
    }

    // 抵触区間のオーバーレイ
    var inFail = false;
    for (var j = 0; j < this.failSpans.length; j++) {
      if (us >= this.failSpans[j].t0 && us <= this.failSpans[j].t1) { inFail = true; break; }
    }
    this.overlay.hidden = !inFail;

    this.draw();
  };

  Player.prototype._toast = function (msg) {
    if (typeof Shell !== "undefined" && Shell && Shell.copy) {
      // Shell のトーストを流用できないため簡易表示
    }
    var el2 = document.querySelector(".tb-copied");
    if (!el2) {
      el2 = document.createElement("div");
      el2.className = "tb-copied";
      document.body.appendChild(el2);
    }
    el2.textContent = msg;
    el2.classList.add("show");
    clearTimeout(el2._t);
    el2._t = setTimeout(function () { el2.classList.remove("show"); }, 1100);
  };

  Player.prototype._raf = function () {
    var self = this;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    function loop() {
      self.draw();
      if (!self.video.paused) self._rafId = requestAnimationFrame(loop);
    }
    this._rafId = requestAnimationFrame(loop);
  };

  /* =======================================================================
     タイムライン描画
     ======================================================================= */
  Player.prototype.draw = function () {
    var c = this.canvas;
    var lanes = (this.timeline.lanes || []);
    var narrow = window.innerWidth <= 760;

    var laneH   = narrow ? 15 : 22;
    var laneGap = 3;
    var graphH  = narrow ? 56 : 88;
    var gap     = narrow ? 8 : 10;
    var axisH   = 16;
    /* ⚠ ラベル用の左マージンを必ず確保する。
       0にするとレーンの塗り（斜線）とラベルが重なって読めなくなる。
       全幅表示では基準名が省略されないよう広めに取る。 */
    var padL = gutterFor(c.clientWidth || 600, narrow);
    var padR = 8;
    var padT = 6;

    var cssW = c.clientWidth || c.parentNode.clientWidth || 600;
    var cssH = padT + graphH + gap + lanes.length * (laneH + laneGap) + axisH;
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.height = cssH + "px";

    var g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    var t0 = this.timeline.t0 || 0;
    var t1 = this.timeline.t1 || 1;
    var span = Math.max(1, t1 - t0);
    var W = Math.max(10, cssW - padL - padR);
    function xOf(us) { return padL + ((us - t0) / span) * W; }

    var cText   = cssVar("--text", "#16181D");
    var cText2  = cssVar("--text-2", "#565D66");
    var cText3  = cssVar("--text-3", "#8A919B");
    var cBorder = cssVar("--border", "#E7E9ED");
    var cNeg    = cssVar("--neg", "#E0484D");
    var cAccent = cssVar("--accent", "#5457E5");
    var cTint   = cssVar("--accent-tint", "#EEEFFE");
    var cSurf2  = cssVar("--surface-2", "#FBFCFD");
    var fontSans = '-apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", sans-serif';
    var fontMono = 'ui-monospace, "SF Mono", Menlo, monospace';

    /* ================= ① 1秒窓の遷移数グラフ ================= */
    var gTop = padT, gBot = padT + graphH;
    var maxC = 8;
    lanes.forEach(function (l) {
      (l.seriesC || []).forEach(function (v) { if (v > maxC) maxC = v; });
    });
    maxC = Math.ceil(maxC / 4) * 4;                    // 目盛りをきれいに

    g.fillStyle = cSurf2;
    g.fillRect(padL, gTop, W, graphH);
    g.strokeStyle = cBorder; g.lineWidth = 1;
    g.strokeRect(padL + .5, gTop + .5, W - 1, graphH - 1);

    function yOf(v) {
      var r = Math.min(1, v / maxC);
      return gBot - 3 - r * (graphH - 8);
    }

    // 警告ライン(4) と 閾値ライン(6)
    g.strokeStyle = cText3; g.globalAlpha = .55; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, yOf(4)); g.lineTo(padL + W, yOf(4)); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    g.strokeStyle = cNeg; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, yOf(6)); g.lineTo(padL + W, yOf(6)); g.stroke();

    // 系列（非参考レーンのうち最大のもの）
    var main = null;
    lanes.forEach(function (l) {
      if (!l.reference && (!main || l.maxTransitions > main.maxTransitions)) main = l;
    });
    if (main && main.seriesT && main.seriesT.length) {
      g.strokeStyle = cAccent; g.lineWidth = 1.4;
      g.beginPath();
      for (var i = 0; i < main.seriesT.length; i++) {
        var x = xOf(main.seriesT[i]), y = yOf(main.seriesC[i]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }

    // 左側の目盛りラベル（マージン内に描く）
    g.textAlign = "right"; g.textBaseline = "middle";
    g.font = "10px " + fontMono;
    g.fillStyle = cNeg;  g.fillText("6", padL - 6, yOf(6));
    g.fillStyle = cText3; g.fillText("4", padL - 6, yOf(4));
    g.fillText(String(maxC), padL - 6, yOf(maxC));
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillStyle = cText3; g.font = "9px " + fontSans;
    g.fillText(t("t.transPerSec", "遷移/秒"), padL + 4, gTop + 11);

    /* ================= ② 基準別レーン ================= */
    var stripeFail = makeStripe(g, cNeg);
    var y = gBot + gap;
    var lang = (typeof Shell !== "undefined" && Shell && Shell.lang) ? Shell.lang : "ja";

    lanes.forEach(function (lane) {
      // レーン本体
      g.fillStyle = cSurf2;
      g.fillRect(padL, y, W, laneH);
      g.strokeStyle = cBorder; g.lineWidth = 1;
      g.strokeRect(padL + .5, y + .5, W - 1, laneH - 1);

      (lane.spans || []).forEach(function (sp) {
        var x0 = xOf(sp.t0), x1 = xOf(sp.t1);
        // ⚠ 最小2px。1フレームだけの抵触が長尺で消えると偽陰性と同じ害になる
        var w = Math.max(2, x1 - x0);
        if (x0 + w > padL + W) w = padL + W - x0;
        if (sp.level >= LEVEL_FAIL) {
          g.fillStyle = stripeFail;
          g.fillRect(x0, y + 1, w, laneH - 2);
          g.strokeStyle = cNeg; g.globalAlpha = .55;
          g.strokeRect(x0 + .5, y + 1.5, Math.max(1, w - 1), laneH - 3);
          g.globalAlpha = 1;
        } else {
          g.fillStyle = cTint;
          g.fillRect(x0, y + 1, w, laneH - 2);
          g.strokeStyle = cAccent; g.globalAlpha = .5;
          g.strokeRect(x0 + .5, y + 1.5, Math.max(1, w - 1), laneH - 3);
          g.globalAlpha = 1;
        }
      });

      // 参考レーンは破線枠で区別
      if (lane.reference) {
        g.strokeStyle = cText3; g.setLineDash([4, 3]); g.globalAlpha = .85;
        g.strokeRect(padL + .5, y + .5, W - 1, laneH - 1);
        g.setLineDash([]); g.globalAlpha = 1;
      }

      /* ラベルは左マージン内に描く（レーンには重ねない） */
      var label = (lane.label && (lane.label[lang] || lane.label.ja || lane.label.en)) || lane.id;
      if (narrow || padL < 100) label = shortLabel(lane.id, label);
      g.fillStyle = lane.level >= LEVEL_FAIL ? cNeg : (lane.level === LEVEL_CAUTION ? cText : cText3);
      g.font = (lane.level >= LEVEL_FAIL ? "600 " : "") + (narrow ? "9px " : "10.5px ") + fontSans;
      g.textAlign = "right"; g.textBaseline = "middle";
      var maxLabelW = padL - 8;
      label = fitText(g, label, maxLabelW);
      g.fillText(label, padL - 6, y + laneH / 2);
      g.textAlign = "left"; g.textBaseline = "alphabetic";

      y += laneH + laneGap;
    });

    /* ================= ③ 時間軸 ================= */
    var axisY = y + 2;
    g.strokeStyle = cBorder; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, axisY + .5); g.lineTo(padL + W, axisY + .5); g.stroke();
    g.fillStyle = cText3; g.font = "9px " + fontMono;
    var ticks = Math.max(2, Math.min(8, Math.floor(W / 70)));
    for (var k = 0; k <= ticks; k++) {
      var tu = t0 + span * (k / ticks);
      var tx = xOf(tu);
      g.strokeStyle = cBorder;
      g.beginPath(); g.moveTo(tx + .5, axisY); g.lineTo(tx + .5, axisY + 3); g.stroke();
      g.textAlign = k === 0 ? "left" : (k === ticks ? "right" : "center");
      g.fillText(fmtTime(tu), tx, axisY + 12);
    }
    g.textAlign = "left";

    /* ================= ④ 再生ヘッド ================= */
    var curUs = (this.video.currentTime || 0) * 1e6;
    var px = xOf(curUs);
    if (px >= padL - 1 && px <= padL + W + 1) {
      g.strokeStyle = cAccent; g.lineWidth = 1;
      g.beginPath(); g.moveTo(px + .5, gTop); g.lineTo(px + .5, axisY); g.stroke();
      g.fillStyle = cAccent;
      g.beginPath();
      g.moveTo(px - 4, gTop - 5); g.lineTo(px + 4, gTop - 5); g.lineTo(px, gTop + 1);
      g.closePath(); g.fill();
    }

    /* ================= ⑤ ホバー ================= */
    if (this.hoverUs != null) {
      var hx = xOf(this.hoverUs);
      if (hx >= padL && hx <= padL + W) {
        g.strokeStyle = cText3; g.globalAlpha = .55; g.setLineDash([2, 2]);
        g.beginPath(); g.moveTo(hx + .5, gTop); g.lineTo(hx + .5, axisY); g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
      }
    }

    var dur = (this.video.duration && isFinite(this.video.duration))
      ? this.video.duration * 1e6 : (t1 - t0);
    var label = fmtTime(curUs) + " / " + fmtTime(dur);
    /* シーク誤差の実測値（コマ送り時のみ）。ミリ秒単位で併記する。 */
    if (this.seekError != null && Math.abs(this.seekError) >= 0.0005) {
      label += "  (" + (this.seekError > 0 ? "+" : "") +
               (this.seekError * 1000).toFixed(0) + "ms)";
    }
    this.timeLabel.textContent = label;

    /* 文字が収まらない場合に末尾を省略する */
    function fitText(ctx, str, maxW) {
      if (ctx.measureText(str).width <= maxW) return str;
      var out = str;
      while (out.length > 1 && ctx.measureText(out + "…").width > maxW) out = out.slice(0, -1);
      return out + "…";
    }
    function shortLabel(id, full) {
      return ({
        jba: "民放連", itu: "ITU-R", ofcom: "Ofcom",
        wcagA: "WCAG A", wcagAAA: "WCAG AAA", proposal2024: "2024提案"
      })[id] || full;
    }
  };

  Player.prototype.destroy = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    try { URL.revokeObjectURL(this.video.src); } catch (e) {}
    this.mount.innerHTML = "";
  };

  scope.FSPlayer = { Player: Player, fmtTime: fmtTime };

})(typeof window !== "undefined" ? window : this);
