/* メインスクリーン (screen.html) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const board = $('board');
  const columns = new Map(); // playerId -> 列要素
  let lastSeq = null;
  let qrUrl = null;

  function createColumn(id) {
    const col = document.createElement('div');
    col.className = 'player-column';
    col.dataset.id = id;
    col.innerHTML =
      '<div class="status-badge"></div>' +
      '<div class="nameplate"><span class="name"></span></div>' +
      '<div class="score-display"></div>' +
      '<div class="penalty-display"></div>';
    col.addEventListener('animationend', (e) => {
      if (e.target === col && !e.pseudoElement) col.classList.remove('anim-correct', 'anim-wrong', 'anim-win', 'anim-lose');
    });
    return col;
  }

  function penaltyHTML(st, p) {
    const s = st.settings;
    if (s.rule === 'nomx' && s.lose <= 7) {
      let html = '';
      for (let i = 0; i < s.lose; i++) html += '<span class="x' + (i < p.wrong ? ' on' : '') + '">×</span>';
      return html;
    }
    if (s.rule === 'nomx') return '<span class="x on">×' + p.wrong + '</span>';
    return '<span class="o">○' + p.correct + '</span><span class="x on">×' + p.wrong + '</span>';
  }

  function render(st) {
    $('title').textContent = st.settings.title;
    $('rule').textContent = QB.ruleLabel(st.settings);
    $('qno').textContent = st.qNo >= 1 ? 'Q.' + st.qNo : '';
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
      col.style.setProperty('--plate', (QB.COLORS[p.color] || QB.COLORS.dark).hex);

      const badgeEl = col.querySelector('.status-badge');
      badgeEl.className = 'status-badge ' + b.cls;
      badgeEl.textContent = b.label;

      const nameEl = col.querySelector('.name');
      nameEl.textContent = p.name;
      nameEl.style.setProperty('--len', Math.max(3, [...p.name].length));

      const scoreEl = col.querySelector('.score-display');
      const score = String(QB.score(st, p));
      scoreEl.textContent = score;
      scoreEl.style.setProperty('--digits', Math.max(2, score.length));

      col.querySelector('.penalty-display').innerHTML = penaltyHTML(st, p);
    });

    playEvent(st.event);
    renderQr(st.screenQr);
  }

  function playEvent(ev) {
    if (!ev) return;
    // 初回表示時や重複受信時は演出しない
    if (lastSeq === null || ev.seq <= lastSeq) {
      lastSeq = Math.max(lastSeq || 0, ev.seq);
      return;
    }
    lastSeq = ev.seq;
    const col = ev.playerId && columns.get(ev.playerId);
    if (!col || !['correct', 'wrong', 'win', 'lose'].includes(ev.type)) return;
    col.classList.remove('anim-correct', 'anim-wrong', 'anim-win', 'anim-lose');
    void col.offsetWidth; // アニメーションを再始動させる
    col.classList.add('anim-' + ev.type);
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

  const channel = QB.openChannel((msg) => {
    if (msg && msg.type === 'STATE' && msg.state) render(QB.normalizeState(msg.state));
  });

  render(QB.loadState() || QB.defaultState());
  channel.post({ type: 'HELLO' });

  // ---------- 全画面 ----------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  document.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
  setTimeout(() => $('hint').classList.add('fade'), 4000);
})();
