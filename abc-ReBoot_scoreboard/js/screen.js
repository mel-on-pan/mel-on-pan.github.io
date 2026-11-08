/* メインスクリーン (screen.html) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const board = $('board');
  // 観客ビューアへの埋め込み (?embed=1): 状態は親ウィンドウから postMessage で受け取る
  const EMBED = new URLSearchParams(location.search).get('embed') === '1';
  if (EMBED) document.documentElement.classList.add('embed');
  const columns = new Map(); // playerId -> 列要素
  let lastSeq = null;
  let qrUrl = null;

  function createColumn(id) {
    const col = document.createElement('div');
    col.className = 'player-column';
    col.dataset.id = id;
    col.innerHTML =
      '<div class="status-badge"></div>' +
      '<div class="nameplate"><span class="name"></span><div class="fill"><span class="name"></span></div></div>' +
      '<div class="score-display"></div>' +
      '<div class="penalty-display"></div>';
    col.addEventListener('animationend', (e) => {
      if (e.target === col && !e.pseudoElement) col.classList.remove('anim-correct', 'anim-wrong', 'anim-win', 'anim-lose');
    });
    return col;
  }

  /** Swedish10: 2行×5列の○を、獲得済み=×、次の誤答で×になる分=－、残り=○ で表示 */
  function swedishHTML(p) {
    const next = QB.swedishPenalty(p.correct);
    let html = '';
    for (let i = 0; i < 10; i++) {
      if (i < p.wrong) html += '<span class="m x on">×</span>';
      else if (i < p.wrong + next) html += '<span class="m next">－</span>';
      else html += '<span class="m">●</span>';
    }
    return html;
  }

  function penaltyHTML(st, p) {
    const s = st.settings;
    if (s.rule === 'swedish10') return swedishHTML(p);
    // 10by10: 得点の式 ○ × (10 − ×) を表示
    if (s.rule === 'nbyn') {
      return '<span class="o">' + p.correct + '</span><span class="op">×</span>' +
        '<span class="x on">' + Math.max(0, 10 - p.wrong) + '</span>';
    }
    // Freeze10: バツ数のみ
    if (s.rule === 'freeze10') return '<span class="x on">×' + p.wrong + '</span>';
    const lossOnly = s.rule === 'nomx' || s.rule === 'renda' || s.rule === 'updown10';
    const loseMax = s.rule === 'updown10' ? 2 : s.lose;
    if (lossOnly && loseMax <= 7) {
      let html = '';
      for (let i = 0; i < loseMax; i++) html += '<span class="x' + (i < p.wrong ? ' on' : '') + '">×</span>';
      return html;
    }
    if (lossOnly) return '<span class="x on">×' + p.wrong + '</span>';
    return '<span class="o">○' + p.correct + '</span><span class="x on">×' + p.wrong + '</span>';
  }

  // ---------- タイマー ----------

  let curTimerState = null;

  function renderTimer() {
    const el = $('timer');
    const st = curTimerState;
    if (EMBED || !st || !QB.hasTimer(st.settings.rule)) {
      el.textContent = '';
      return;
    }
    const t = st.timer;
    const ms = QB.timerRemaining(t);
    el.textContent = QB.timerText(ms);
    el.classList.toggle('paused', !t.running && ms > 0);
    el.classList.toggle('over', ms <= 0);
    el.classList.toggle('warn', ms > 0 && ms <= 60000);
  }
  setInterval(renderTimer, 200);

  function render(st) {
    $('title').textContent = st.settings.title;
    $('rule').textContent = QB.ruleLabel(st.settings);
    $('survivors').textContent = QB.survivorsText(st);
    document.documentElement.style.setProperty('--count', st.players.length);

    const alive = new Set(st.players.map((p) => p.id));
    columns.forEach((col, id) => {
      if (!alive.has(id)) {
        col.remove();
        columns.delete(id);
      }
    });

    st.players.forEach((p, index) => {
      let col = columns.get(p.id);
      if (!col) {
        col = createColumn(p.id);
        columns.set(p.id, col);
      }
      // 並び順を state に合わせる (位置が同じなら動かさない: 演出が途切れるため)
      if (board.children[index] !== col) board.insertBefore(col, board.children[index] || null);

      const b = QB.badge(st, p);
      col.classList.toggle('is-win', p.status === 'win');
      col.classList.toggle('is-lose', p.status === 'lose');
      col.classList.toggle('is-rest', QB.isResting(st, p));

      const badgeEl = col.querySelector('.status-badge');
      // 状態表示が無いときは運営が設定した順位を出す
      if (p.status === 'win') {
        badgeEl.className = 'status-badge ' + b.cls;
        badgeEl.textContent = 'WIN';
      } else if (b.label) {
        badgeEl.className = 'status-badge ' + b.cls;
        badgeEl.textContent = b.label;
      } else if (p.seed > 0) {
        badgeEl.className = 'status-badge seed seed-' + QB.seedTier(p.seed);
        badgeEl.textContent = QB.ordinal(p.seed);
      } else {
        badgeEl.className = 'status-badge';
        badgeEl.textContent = '';
      }

      col.querySelectorAll('.name').forEach((el) => {
        el.textContent = p.name;
        el.style.setProperty('--len', Math.max(3, [...p.name].length));
      });
      col.querySelector('.nameplate').style.setProperty('--p', Math.round(QB.progress(st, p) * 100) + '%');

      const scoreEl = col.querySelector('.score-display');
      const score = p.status === 'win' ? QB.ordinal(p.rank) : String(QB.score(st, p));
      scoreEl.textContent = score;
      scoreEl.style.setProperty('--digits', Math.max(2, score.length + (p.status === 'win' ? 1 : 0)));

      const penEl = col.querySelector('.penalty-display');
      penEl.classList.toggle('swedish', st.settings.rule === 'swedish10');
      penEl.classList.toggle('formula', st.settings.rule === 'nbyn');
      penEl.innerHTML = penaltyHTML(st, p);
      // 横幅に収まる最大のバツの大きさを決めるため、並ぶバツの数を渡す
      penEl.style.setProperty('--xn', Math.max(3, penEl.querySelectorAll('.x').length));
    });

    curTimerState = st;
    renderTimer();
    renderQuestion(st.screenQ);
    playEvent(st.event, st);
    renderQr(st.screenQr);
  }

  // ---------- 問題・正解 (通信障害時用) ----------

  let lastQ = null;
  let qVisible = null; // null = 初回描画前
  let qTimer = 0;
  const cssMs = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

  function renderQuestion(sq) {
    const question = sq.blank ? QB.PLACEHOLDER.question : sq.question;
    const answer = sq.blank ? QB.PLACEHOLDER.answer : sq.answer;
    setQuestionVisible(!!sq.visible);
    const key = question + '\n' + answer;
    if (key === lastQ) return;
    lastQ = key;
    $('sq').textContent = question;
    $('sa').textContent = answer;
    fitQuestion();
  }

  /**
   * 表示切替。オン: 線が下がる → 問題・正解がフェードイン
   *            オフ: 問題・正解がフェードアウト → 線が元の位置に戻る
   */
  function setQuestionVisible(visible) {
    if (visible === qVisible) return;
    const body = document.body;
    const first = qVisible === null;
    qVisible = visible;
    clearTimeout(qTimer);

    if (first) {
      // 初回表示はアニメーションしない
      body.classList.add('no-anim');
      body.classList.toggle('show-q', visible);
      body.classList.toggle('q-in', visible);
      void body.offsetWidth;
      requestAnimationFrame(() => body.classList.remove('no-anim'));
      return;
    }
    if (visible) {
      // フェードアウト中に戻された場合は線が既に下にあるので、すぐフェードインする
      const lineDown = body.classList.contains('show-q');
      body.classList.add('show-q');
      fitQuestion();
      qTimer = setTimeout(() => body.classList.add('q-in'), lineDown ? 0 : cssMs('--line-ms'));
    } else {
      const shown = body.classList.contains('q-in');
      body.classList.remove('q-in');
      qTimer = setTimeout(() => body.classList.remove('show-q'), shown ? cssMs('--qfade-ms') : 0);
    }
  }

  /** 指定行数に収まる最大の文字サイズを二分探索で求める */
  function fitLines(el, maxVar, lhVar, lines) {
    const css = getComputedStyle(document.documentElement);
    const vh = window.innerHeight / 100;
    const max = parseFloat(css.getPropertyValue(maxVar)) * vh;
    const lh = parseFloat(css.getPropertyValue(lhVar));
    let lo = Math.max(10, max * 0.4);
    let hi = max;
    el.style.webkitLineClamp = 'unset';
    el.style.maxHeight = 'none';
    const fits = (size) => {
      el.style.fontSize = size + 'px';
      return el.scrollHeight <= Math.ceil(size * lh * lines) + 1;
    };
    if (!fits(hi)) {
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      el.style.fontSize = lo + 'px';
    }
    el.style.webkitLineClamp = '';
    el.style.maxHeight = '';
  }

  function fitQuestion() {
    if (!document.body.classList.contains('show-q')) return;
    const sq = $('sq');
    fitLines(sq, '--sq-max', '--sq-lh', 2);
    sq.parentElement.style.setProperty('--sq-line', parseFloat(getComputedStyle(sq).lineHeight) + 'px');
    fitLines($('sa'), '--sa-max', '--sa-lh', 1);
  }

  window.addEventListener('resize', fitQuestion);
  if (document.fonts) document.fonts.ready.then(fitQuestion);

  function playEvent(ev, st) {
    if (!ev) return;
    // 初回表示時や重複受信時は演出しない
    if (lastSeq === null || ev.seq <= lastSeq) {
      lastSeq = Math.max(lastSeq || 0, ev.seq);
      return;
    }
    lastSeq = ev.seq;
    if (ev.type === 'opening') {
      startOpening(st);
      return;
    }
    const col = ev.playerId && columns.get(ev.playerId);
    if (!col || !['correct', 'wrong', 'win', 'lose'].includes(ev.type)) return;
    col.classList.remove('anim-correct', 'anim-wrong', 'anim-win', 'anim-lose');
    void col.offsetWidth; // アニメーションを再始動させる
    col.classList.add('anim-' + ev.type);
  }

  // ---------- オープニング演出 ----------
  // 真っ暗 → 上部にルール名 → 大会名・問題番号 → プレイヤーを1人ずつ登場
  const OPENING = { black: 900, ruleToHead: 1400, headToPlayers: 800, step: 500, tail: 1400 };
  let openingTimers = [];

  function later(ms, fn) {
    openingTimers.push(setTimeout(fn, ms));
  }

  function endOpening() {
    openingTimers.forEach(clearTimeout);
    openingTimers = [];
    document.body.classList.remove('staging', 'rule-in', 'head-in');
    columns.forEach((col) => col.classList.remove('shown'));
  }

  function startOpening(st) {
    endOpening();
    document.body.classList.add('staging');

    let t = OPENING.black;
    later(t, () => document.body.classList.add('rule-in'));
    t += OPENING.ruleToHead;
    later(t, () => document.body.classList.add('head-in'));
    t += OPENING.headToPlayers;
    const count = st.players.length;
    for (let i = 0; i < count; i++) {
      later(t + i * OPENING.step, () => {
        const col = board.children[i];
        if (col) col.classList.add('shown');
      });
    }
    later(t + count * OPENING.step + OPENING.tail, endOpening);
  }

  function renderQr(qr) {
    const overlay = $('qrOverlay');
    overlay.hidden = !(qr && qr.visible && qr.url);
    if (overlay.hidden || qr.url === qrUrl) return;
    qrUrl = qr.url;
    const box = $('screenQr');
    box.innerHTML = '';
    if (typeof QRCode === 'undefined') {
      box.textContent = qr.url;
      return;
    }
    const size = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.55);
    new QRCode(box, { text: qr.url, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
  }

  // ---------- 受信 ----------

  let channel = { post() {} };
  if (EMBED) {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      if (e.data && e.data.type === 'QB_STATE' && e.data.state) render(QB.normalizeState(e.data.state));
    });
    render(QB.defaultState());
  } else {
    channel = QB.openChannel((msg) => {
      if (msg && msg.type === 'STATE' && msg.state) render(QB.normalizeState(msg.state));
    });
    render(QB.loadState() || QB.defaultState());
    channel.post({ type: 'HELLO' });
  }

  // ---------- 全画面 ----------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  document.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      // ブラウザ標準の F11 ではなく Fullscreen API を使う (タスクバーまで隠れる)
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
  setTimeout(() => $('hint').classList.add('fade'), 4000);
})();
