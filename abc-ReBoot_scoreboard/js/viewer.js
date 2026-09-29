/* 観客・プレイヤー用画面 (viewer.html) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const hostId = new URLSearchParams(location.search).get('host');
  const CACHE_KEY = 'quizboard.viewer.last';
  const RETRY_MS = 3000;
  const OPEN_TIMEOUT_MS = 10000;

  let peer = null;
  let conn = null;
  let retryTimer = 0;
  let openTimer = 0;
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
    $('title').textContent = d.title || 'クイズ';
    $('rule').textContent = d.rule || '';
    $('qno').textContent = d.qNo >= 1 ? 'Q.' + d.qNo : '';

    const q = $('question');
    const started = d.qNo >= 1 && cur;
    q.textContent = started ? cur.question || '(問題文はありません)' : 'まもなく開始します';
    q.classList.toggle('waiting', !started);

    $('answerBox').hidden = !started;
    $('answer').textContent = started ? cur.answer || '—' : '';
    $('explanation').textContent = started ? cur.explanation || '' : '';
    $('explanation').hidden = !(started && cur.explanation);

    const past = items.slice(1);
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
  }

  // ---------- 接続 ----------

  function scheduleRetry() {
    clearTimeout(retryTimer);
    clearTimeout(openTimer);
    setConn('wait', '再接続中…');
    retryTimer = setTimeout(connect, RETRY_MS);
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!peer || peer.destroyed) return startPeer();
    if (peer.disconnected) {
      peer.reconnect();
      return;
    }
    const old = conn;
    conn = null; // 古い接続の close イベントで再接続が走らないように先に外す
    if (old) old.close();

    conn = peer.connect(hostId, { reliable: true });
    const c = conn;
    openTimer = setTimeout(() => {
      if (c === conn && !c.open) scheduleRetry();
    }, OPEN_TIMEOUT_MS);

    c.on('open', () => {
      clearTimeout(openTimer);
      setConn('ok', '接続中');
    });
    c.on('data', (d) => {
      if (!d || d.type !== 'STATE') return;
      render(d);
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(d));
      } catch (e) {
        /* ignore */
      }
    });
    c.on('close', () => c === conn && scheduleRetry());
    c.on('error', () => c === conn && scheduleRetry());
  }

  function startPeer() {
    if (typeof Peer === 'undefined') {
      setConn('error', '通信ライブラリを読み込めません');
      return;
    }
    if (peer) peer.destroy();
    setConn('wait', '接続中…');
    peer = new Peer({ debug: 1 });
    peer.on('open', connect);
    peer.on('disconnected', () => {
      if (!peer.destroyed) scheduleRetry();
    });
    peer.on('error', (err) => {
      console.warn('PeerJS error:', err.type, err);
      if (err.type === 'peer-unavailable') {
        setConn('wait', '運営の準備を待っています…');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, RETRY_MS);
      } else {
        clearTimeout(retryTimer);
        setConn('error', '通信エラー。再接続します…');
        retryTimer = setTimeout(startPeer, RETRY_MS);
      }
    });
  }

  // スマホのスリープ復帰時はすぐ再接続を試みる
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !(conn && conn.open)) connect();
  });

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
  startPeer();
})();
