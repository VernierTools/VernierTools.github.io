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
    function seekFromEvent(ev) {
      var r = self.canvas.getBoundingClientRect();
      var x = (ev.clientX - r.left) / r.width;
      x = Math.max(0, Math.min(1, x));
      var dur = self.video.duration || (self.durationUs / 1e6);
      self.video.currentTime = x * dur;
      self.draw();
    }
    this.canvas.addEventListener("pointerdown", function (ev) {
      ev.preventDefault(); dragging = true; seekFromEvent(ev);
      self.canvas.setPointerCapture(ev.pointerId);
    });
    this.canvas.addEventListener("pointermove", function (ev) {
      var r = self.canvas.getBoundingClientRect();
      var dur = self.video.duration || (self.durationUs / 1e6);
      self.hoverUs = ((ev.clientX - r.left) / r.width) * dur * 1e6;
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
      self.confirmed = true; close(); self.video.play();
    });
    bSkip.addEventListener("click", function () {
      self.cbSkip.input.checked = true; self.skipDanger = true;
      self.confirmed = true; close(); self.video.play();
    });
    bAny.addEventListener("click", function () {
      self.confirmed = true; close(); self.video.play();
    });
    bCancel.addEventListener("click", close);

    [bDim, bSkip, bAny, bCancel].forEach(function (b) { row.appendChild(b); });
    box.appendChild(row);
    back.appendChild(box);
    document.body.appendChild(back);
    bDim.focus();
  };

  Player.prototype.step = function (dir) {
    this.video.pause();
    var d = 1 / (this.fps || 30);
    this.video.currentTime = Math.max(0, this.video.currentTime + dir * d);
    this.draw();
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
    var laneH = window.innerWidth <= 760 ? 14 : 18;
    var graphH = 54;
    var gap = 4;
    var padL = 0, padR = 0;

    var cssW = c.clientWidth || c.parentNode.clientWidth || 600;
    var cssH = graphH + gap + lanes.length * (laneH + 2) + 18;
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
    var W = cssW - padL - padR;
    function xOf(us) { return padL + ((us - t0) / span) * W; }

    var cText3 = cssVar("--text-3", "#8A919B");
    var cBorder = cssVar("--border", "#E7E9ED");
    var cNeg = cssVar("--neg", "#E0484D");
    var cAccent = cssVar("--accent", "#5457E5");
    var cSurface2 = cssVar("--surface-2", "#FBFCFD");

    /* --- ① 1秒窓の遷移数グラフ --- */
    var maxC = 12;
    lanes.forEach(function (l) {
      (l.seriesC || []).forEach(function (v) { if (v > maxC) maxC = v; });
    });
    g.fillStyle = cSurface2;
    g.fillRect(0, 0, cssW, graphH);

    // 閾値ライン（6超で抵触）と警告ライン（4）
    function yOf(v) { return graphH - (v / maxC) * (graphH - 6) - 2; }
    g.strokeStyle = cText3; g.globalAlpha = .5; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, yOf(4)); g.lineTo(cssW, yOf(4)); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    g.strokeStyle = cNeg; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, yOf(6)); g.lineTo(cssW, yOf(6)); g.stroke();

    // 系列（非参考レーンの最大値を描く）
    var main = null;
    lanes.forEach(function (l) { if (!l.reference && (!main || l.maxTransitions > main.maxTransitions)) main = l; });
    if (main && main.seriesT && main.seriesT.length) {
      g.strokeStyle = cAccent; g.lineWidth = 1.2; g.beginPath();
      for (var i = 0; i < main.seriesT.length; i++) {
        var x = xOf(main.seriesT[i]), y = yOf(main.seriesC[i]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.fillStyle = cText3; g.font = "10px ui-monospace, monospace";
    g.fillText("6", 3, yOf(6) - 2);

    /* --- ② 基準別レーン --- */
    var stripeFail = makeStripe(g, cNeg);
    var y = graphH + gap;
    var self = this;
    lanes.forEach(function (lane) {
      g.fillStyle = cSurface2;
      g.fillRect(0, y, cssW, laneH);
      g.strokeStyle = cBorder; g.lineWidth = 1;
      g.strokeRect(0.5, y + 0.5, cssW - 1, laneH - 1);

      (lane.spans || []).forEach(function (s) {
        var x0 = xOf(s.t0), x1 = xOf(s.t1);
        // ⚠ 最小2px。1フレームだけの抵触が長尺で消えると、見落としは偽陰性と同じ害になる
        var w = Math.max(2, x1 - x0);
        if (s.level >= LEVEL_FAIL) {
          g.fillStyle = stripeFail;
          g.fillRect(x0, y + 1, w, laneH - 2);
          g.strokeStyle = cNeg; g.globalAlpha = .5;
          g.strokeRect(x0 + .5, y + 1.5, w - 1, laneH - 3);
          g.globalAlpha = 1;
        } else {
          g.fillStyle = cssVar("--accent-tint", "#EEEFFE");
          g.fillRect(x0, y + 1, w, laneH - 2);
        }
      });

      // 参考レーンは破線枠で区別（§9.2.3）
      if (lane.reference) {
        g.strokeStyle = cText3; g.setLineDash([4, 3]); g.globalAlpha = .8;
        g.strokeRect(0.5, y + 0.5, cssW - 1, laneH - 1);
        g.setLineDash([]); g.globalAlpha = 1;
      }

      // ラベル
      var label = (lane.label && (lane.label[langCode()] || lane.label.ja || lane.label.en)) || lane.id;
      g.fillStyle = cText3;
      g.font = (window.innerWidth <= 760 ? "9px " : "10px ") + "-apple-system, sans-serif";
      g.fillText(label, 4, y + laneH - 5);

      y += laneH + 2;
    });

    /* --- ③ 再生ヘッド --- */
    var curUs = (this.video.currentTime || 0) * 1e6;
    var px = xOf(curUs);
    g.strokeStyle = cAccent; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, y); g.stroke();
    g.fillStyle = cAccent;
    g.beginPath(); g.moveTo(px - 4, 0); g.lineTo(px + 4, 0); g.lineTo(px, 6); g.closePath(); g.fill();

    /* --- ④ ホバー位置の時刻 --- */
    if (this.hoverUs != null) {
      var hx = xOf(this.hoverUs);
      g.strokeStyle = cText3; g.globalAlpha = .6;
      g.beginPath(); g.moveTo(hx, 0); g.lineTo(hx, y); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = cText3; g.font = "10px ui-monospace, monospace";
      g.fillText(fmtTime(this.hoverUs), Math.min(hx + 4, cssW - 40), y + 12);
    }

    /* 時刻表示 */
    var dur = (this.video.duration && isFinite(this.video.duration))
      ? this.video.duration * 1e6 : (t1 - t0);
    this.timeLabel.textContent = fmtTime(curUs) + " / " + fmtTime(dur);

    function langCode() {
      return (typeof Shell !== "undefined" && Shell && Shell.lang) ? Shell.lang : "ja";
    }
  };

  Player.prototype.destroy = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    try { URL.revokeObjectURL(this.video.src); } catch (e) {}
    this.mount.innerHTML = "";
  };

  scope.FSPlayer = { Player: Player, fmtTime: fmtTime };

})(typeof window !== "undefined" ? window : this);
