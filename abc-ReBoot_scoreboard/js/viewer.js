/* 観客・プレイヤー用画面 (viewer.html) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const hostId = new URLSearchParams(location.search).get('host');
  const CACHE_KEY = 'quizboard.viewer.last';
  const relayUrl = ((window.QB_CONFIG && window.QB_CONFIG.relayUrl) || '').trim().replace(/\/+$/, '');
  const MAX_RETRY_MS = 15000;
  const HEARTBEAT_MS = 25000;
  const STALE_MS = 65000;

  let ws = null;
  let retryTimer = 0;
  let attempt = 0;
  let lastRecv = 0;
  let lastQNo = null;

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setConn(kind, text) {
    $('connDot').className = 'dot ' + kind;
    $('connText').textContent = text;
  }

  /** d.items: 現在の問題を先頭に、直近5問が新しい順で入っている */
  function render(d) {
    const items = Array.isArray(d.items) ? d.items : [];
    const cur = items[0];
    $('rule').textContent = d.rule || '';
    $('qno').textContent = d.qNo >= 1 && !d.blank ? 'Q.' + d.qNo : '';

    const q = $('question');
    // ルール変更・プレイヤー再設定の直後 (blank) は開始前と同じ表示にし、履歴も消す
    const started = !d.blank && d.qNo >= 1 && cur;
    q.textContent = started ? cur.question || '(問題文はありません)' : 'まもなく開始します';
    q.classList.toggle('waiting', !started);

    $('answerBox').hidden = !started;
    $('answer').textContent = started ? cur.answer || '—' : '';
    $('explanation').textContent = started ? cur.explanation || '' : '';
    $('explanation').hidden = !(started && cur.explanation);

    const past = d.blank ? [] : items.slice(1);
    $('historyBox').hidden = past.length === 0;
    $('history').innerHTML = past
      .map(
        (it) =>
          '<li class="hitem">' +
          '<div class="hno">Q.' + it.qNo + '</div>' +
          '<p class="hq">' + esc(it.question || '(問題文はありません)') + '</p>' +
          '<p class="ha"><span class="alabel">正解</span>' + esc(it.answer || '—') + '</p>' +
          (it.explanation ? '<p class="expl">' + esc(it.explanation) + '</p>' : '') +
          '</li>'
      )
      .join('');

    // 問題が切り替わったときだけ演出して先頭へ戻す
    if (lastQNo !== null && d.qNo !== lastQNo) {
      const card = $('current');
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    lastQNo = d.qNo;
    renderBoard(d.board);
  }

  // ---------- スコアボードタブ ----------
  // screen.html を iframe で埋め込み、受信した盤面を postMessage で渡す (表示は運営のスコアボードと同じ)

  const frame = $('boardFrame');
  let lastBoard = null;

  function renderBoard(b) {
    if (b) lastBoard = b;
    postBoard();
  }

  function postBoard() {
    if (!lastBoard || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'QB_STATE', state: lastBoard }, location.origin);
  }
  frame.addEventListener('load', postBoard);

  // 盤面は画面いっぱいの横長で描く (縦向きの端末では 90 度回転)。下限サイズは設けない
  function layoutBoard() {
    const tabsBottom = $('vheader').getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--board-top', Math.round(tabsBottom) + 'px');
    const availW = window.innerWidth;
    const availH = window.innerHeight - tabsBottom;
    const portrait = availH > availW;
    // 横向きに描く論理サイズ (縦向きの端末では 90 度回転するので幅と高さが入れ替わる)
    const fw = Math.max(1, portrait ? availH : availW);
    const fh = Math.max(1, portrait ? availW : availH);
    const stage = $('boardStage');
    stage.classList.toggle('rotated', portrait);
    stage.style.width = (portrait ? fh : fw) + 'px';
    stage.style.height = (portrait ? fw : fh) + 'px';
    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
    frame.style.left = portrait ? fh + 'px' : '0';
  }
  window.addEventListener('resize', layoutBoard);
  window.addEventListener('orientationchange', layoutBoard);

  // ---------- タブ ----------

  const TAB_KEY = 'quizboard.viewer.tab';
  function showTab(name) {
    const isB = name === 'b';
    $('paneQ').hidden = isB;
    $('paneB').hidden = !isB;
    $('tabQ').classList.toggle('active', !isB);
    $('tabB').classList.toggle('active', isB);
    $('tabQ').setAttribute('aria-selected', String(!isB));
    $('tabB').setAttribute('aria-selected', String(isB));
    try {
      sessionStorage.setItem(TAB_KEY, name);
    } catch (e) {
      /* ignore */
    }
    document.body.classList.toggle('on-board', isB);
    layoutBoard();
    if (isB && !frame.getAttribute('src')) frame.setAttribute('src', 'screen.html?embed=1&v=4');
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
  try {
    showTab(sessionStorage.getItem(TAB_KEY) === 'b' ? 'b' : 'q');
  } catch (e) {
    /* ignore */
  }

  // ---------- 接続 (Cloudflare 中継サーバー) ----------
  // 中継サーバーが落ちて全員が一斉に再接続しないよう、待ち時間は指数的に伸ばしてばらつかせる。

  function scheduleRetry() {
    clearTimeout(retryTimer);
    ws = null;
    const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** attempt);
    attempt += 1;
    setConn('wait', '再接続中…');
    retryTimer = setTimeout(connect, base / 2 + Math.random() * (base / 2));
  }

  function detach() {
    const old = ws;
    ws = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close();
    } catch (e) {
      /* ignore */
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    detach();
    if (!hostId) return;
    if (!relayUrl) {
      setConn('error', '未設定');
      $('question').textContent = '中継サーバーが設定されていません。運営にお知らせください。';
      return;
    }
    setConn('wait', attempt ? '再接続中…' : '接続中…');

    let s;
    try {
      s = new WebSocket(relayUrl + '/rooms/' + encodeURIComponent(hostId) + '/ws?role=viewer');
    } catch (e) {
      setConn('error', '接続できません');
      return;
    }
    ws = s;
    s.onopen = () => {
      attempt = 0;
      lastRecv = Date.now();
      setConn('ok', '接続中');
    };
    s.onmessage = (e) => {
      lastRecv = Date.now();
      if (e.data === 'pong') return;
      let d;
      try {
        d = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (d && d.type === 'EMPTY') {
        if (lastQNo === null) $('question').textContent = '運営の準備を待っています…';
        return;
      }
      if (!d || d.type !== 'STATE') return;
      render(d);
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(d));
      } catch (err) {
        /* ignore */
      }
    };
    s.onclose = () => {
      if (s === ws) scheduleRetry();
    };
  }

  function isStale(ms) {
    return Date.now() - lastRecv > ms;
  }

  // 生存確認: 一定時間なにも届かなければ (pong も来なければ) 張り直す
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (isStale(STALE_MS)) {
      detach();
      scheduleRetry();
      return;
    }
    ws.send('ping');
  }, HEARTBEAT_MS);

  // スマホのスリープ復帰・回線復帰時はすぐ確認する
  function wake() {
    const open = ws && ws.readyState === WebSocket.OPEN;
    if (open && !isStale(HEARTBEAT_MS + 5000)) return;
    attempt = 0;
    connect();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', (e) => e.persisted && wake());

  // ---------- 起動 ----------

  if (!hostId) {
    setConn('error', '未接続');
    $('question').textContent = '接続情報がありません。会場のQRコードから開き直してください。';
    return;
  }

  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (cached) render(cached);
  } catch (e) {
    /* ignore */
  }
  connect();
})();
