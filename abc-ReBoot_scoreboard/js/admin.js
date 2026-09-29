/* 運営パネル (index.html) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = QB.escapeHTML;
  const COLOR_BY_LABEL = { 赤: 'red', 青: 'blue', 緑: 'green', 黒: 'dark' };

  let state = QB.loadState() || QB.defaultState();
  let questions = QB.readJSON(QB.KEYS.questions) || [];

  const channel = QB.openChannel((msg) => {
    // スコアボードが後から開いたときに現在の状態を要求してくる
    if (msg && msg.type === 'HELLO') channel.post({ type: 'STATE', state });
  });

  // ---------- 状態更新 ----------

  function publish() {
    state.updatedAt = Date.now();
    QB.saveState(state);
    channel.post({ type: 'STATE', state });
    Net.broadcast();
    render();
  }

  /** 履歴を積んでから状態を変更し、全画面へ反映する */
  function commit(mutate) {
    QB.pushHistory(JSON.parse(JSON.stringify(state)));
    mutate(state);
    publish();
  }

  function emit(type, playerId) {
    state.seq += 1;
    state.event = { seq: state.seq, type, playerId: playerId || null };
  }

  function findPlayer(id) {
    return state.players.find((p) => p.id === id);
  }

  function currentQuestion() {
    return state.qNo >= 1 ? questions[state.qNo - 1] || null : null;
  }

  // ---------- 操作 ----------

  const actions = {
    correct(id) {
      const p = findPlayer(id);
      if (!p || p.status !== 'active') return;
      let result = null;
      commit((st) => {
        p.correct += 1;
        result = QB.evaluate(st, p);
        if (st.settings.autoReveal && st.qNo >= 1) st.revealed = true;
        emit(result === 'win' ? 'win' : 'correct', id);
      });
      Sound.play(result === 'win' ? 'win' : 'correct');
    },

    wrong(id) {
      const p = findPlayer(id);
      if (!p || p.status !== 'active') return;
      let result = null;
      commit((st) => {
        p.wrong += 1;
        result = QB.evaluate(st, p);
        if (result !== 'lose' && st.settings.rest > 0) p.restUntil = st.qNo + st.settings.rest;
        emit(result === 'lose' ? 'lose' : 'wrong', id);
      });
      Sound.play(result === 'lose' ? 'lose' : 'wrong');
    },

    adjust(id, field, delta) {
      const p = findPlayer(id);
      if (!p || p[field] + delta < 0) return;
      commit((st) => {
        p[field] += delta;
        QB.evaluate(st, p);
        emit('adjust', id);
      });
    },

    next() {
      if (questions.length && state.qNo >= questions.length) {
        toast('最後の問題です');
        return;
      }
      commit((st) => {
        st.qNo += 1;
        st.revealed = false;
        emit('question');
      });
      Sound.play('question');
    },

    through() {
      if (state.qNo < 1) return;
      commit((st) => {
        st.revealed = true;
        emit('through');
      });
      Sound.play('through');
    },

    reveal() {
      if (state.qNo < 1 || state.revealed) return;
      commit((st) => {
        st.revealed = true;
        emit('reveal');
      });
      Sound.play('reveal');
    },

    undo() {
      const prev = QB.popHistory();
      if (!prev) {
        toast('これ以上戻せません');
        return;
      }
      // 演出の再発火を防ぐため seq は単調増加させる
      prev.seq = state.seq + 1;
      prev.event = { seq: prev.seq, type: 'undo', playerId: null };
      state = prev;
      publish();
      toast('1つ前の状態に戻しました');
    },

    resetSet() {
      if (!confirm('全プレイヤーの得点・判定をリセットします。(元に戻すで復元できます)')) return;
      commit((st) => {
        st.players.forEach((p) => {
          p.correct = 0;
          p.wrong = 0;
          p.status = 'active';
          p.rank = 0;
          p.restUntil = -1;
        });
        emit('reset');
      });
    },
  };

  // ---------- 描画 ----------

  function render() {
    const s = state.settings;
    $('ruleLabel').textContent = QB.ruleLabel(s);
    Sound.setEnabled(s.sound);

    const q = currentQuestion();
    $('qNo').textContent = state.qNo >= 1 ? 'Q.' + state.qNo : '開始前';
    $('qTotal').textContent = questions.length ? '/ ' + questions.length + '問' : '(問題データ未読込)';
    $('revealState').textContent = state.qNo >= 1 ? (state.revealed ? '正解表示中' : '正解は非表示') : '';
    $('revealState').className = 'reveal-state' + (state.revealed ? ' on' : '');
    $('qText').textContent = q ? q.question : state.qNo >= 1 ? '(この番号の問題データはありません)' : '「次の問題」で第1問を出題します';
    $('qAnswer').textContent = q ? q.answer + (q.explanation ? ' — ' + q.explanation : '') : '—';

    $('revealBtn').disabled = state.qNo < 1 || state.revealed;
    $('throughBtn').disabled = state.qNo < 1;
    $('undoBtn').disabled = QB.historySize() === 0;
    $('screenQrToggle').checked = !!state.screenQr.visible;

    $('players').innerHTML = state.players.map((p) => playerCard(p)).join('');
  }

  function playerCard(p) {
    const s = state.settings;
    const b = QB.badge(state, p);
    const done = p.status !== 'active';
    const color = (QB.COLORS[p.color] || QB.COLORS.dark).hex;
    const scoreSub = s.rule === 'nomx' ? '×' + p.wrong + ' / ' + s.lose : '○' + p.correct + ' ×' + p.wrong;
    return (
      '<div class="pcard status-' + p.status + (QB.isResting(state, p) ? ' resting' : '') + '" data-id="' + p.id + '">' +
      '<div class="pcard-head" style="--pc:' + color + '">' +
      '<span class="pname">' + esc(p.name) + '</span>' +
      (b.label ? '<span class="badge ' + b.cls + '">' + b.label + '</span>' : '') +
      '</div>' +
      '<div class="pscore">' + QB.score(state, p) + '<small>' + scoreSub + '</small></div>' +
      '<div class="pbtns">' +
      '<button class="btn-correct" data-act="correct"' + (done ? ' disabled' : '') + '>○ 正解</button>' +
      '<button class="btn-wrong" data-act="wrong"' + (done ? ' disabled' : '') + '>× 誤答</button>' +
      '</div>' +
      '<div class="padj">' +
      '<button data-act="adj" data-field="correct" data-delta="-1">○−1</button>' +
      '<button data-act="adj" data-field="correct" data-delta="1">○+1</button>' +
      '<button data-act="adj" data-field="wrong" data-delta="-1">×−1</button>' +
      '<button data-act="adj" data-field="wrong" data-delta="1">×+1</button>' +
      '</div>' +
      '</div>'
    );
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2200);
  }

  // ---------- 問題データ ----------

  function setQuestions(list, source) {
    questions = QB.normalizeQuestions(list);
    QB.writeJSON(QB.KEYS.questions, questions);
    toast(questions.length + '問を読み込みました (' + source + ')');
    Net.broadcast();
    render();
    renderSettingsInfo();
  }

  function fetchQuestionsJson(silent) {
    return fetch('questions.json', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((data) => setQuestions(data, 'questions.json'))
      .catch((err) => {
        if (!silent) toast('questions.json を読み込めません。ファイル選択から読み込んでください (' + err.message + ')');
      });
  }

  // ---------- 観客スマホ接続 (PeerJS) ----------

  const Net = {
    peer: null,
    conns: new Set(),
    retryTimer: 0,

    hostId() {
      let id = null;
      try {
        id = localStorage.getItem(QB.KEYS.hostId);
      } catch (e) {
        /* ignore */
      }
      if (!id) {
        id = 'abcreboot-' + Math.random().toString(36).slice(2, 10);
        try {
          localStorage.setItem(QB.KEYS.hostId, id);
        } catch (e) {
          /* ignore */
        }
      }
      return id;
    },

    start() {
      if (typeof Peer === 'undefined') {
        setNetStatus('error', 'PeerJS を読み込めません (オフライン?)');
        return;
      }
      clearTimeout(this.retryTimer);
      if (this.peer) this.peer.destroy();
      this.conns.clear();
      updateViewerCount();
      setNetStatus('wait', 'サーバーに接続中…');

      const peer = new Peer(this.hostId(), { debug: 1 });
      this.peer = peer;

      peer.on('open', () => {
        setNetStatus('ok', '受付中');
        renderQr();
      });

      peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.conns.add(conn);
          conn.send(viewerPayload());
          updateViewerCount();
        });
        const drop = () => {
          this.conns.delete(conn);
          updateViewerCount();
        };
        conn.on('close', drop);
        conn.on('error', drop);
      });

      peer.on('disconnected', () => {
        // シグナリングサーバーとの接続のみ切れた状態。既存の観客接続は維持される。
        if (peer.destroyed) return;
        setNetStatus('wait', '再接続中…');
        this.retryTimer = setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });

      peer.on('error', (err) => {
        console.warn('PeerJS error:', err.type, err);
        if (err.type === 'unavailable-id') {
          // リロード直後は前回のIDがサーバー上にまだ残っていることがある
          setNetStatus('wait', '前回の接続の解放待ち…');
          this.retryTimer = setTimeout(() => this.start(), 5000);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          setNetStatus('error', '通信エラー。再試行します…');
          this.retryTimer = setTimeout(() => this.start(), 5000);
        }
      });
    },

    broadcast() {
      const payload = viewerPayload();
      this.conns.forEach((conn) => {
        if (conn.open) conn.send(payload);
      });
    },

    prune() {
      this.conns.forEach((conn) => {
        if (!conn.open) this.conns.delete(conn);
      });
      updateViewerCount();
    },
  };

  /** 観客に送る内容。正解は「正解表示」されるまで送らない。 */
  function viewerPayload() {
    const q = currentQuestion();
    return {
      type: 'STATE',
      title: state.settings.title,
      rule: QB.ruleLabel(state.settings),
      qNo: state.qNo,
      total: questions.length,
      question: q ? q.question : '',
      revealed: state.revealed,
      answer: state.revealed && q ? q.answer : null,
      explanation: state.revealed && q ? q.explanation : null,
    };
  }

  function setNetStatus(kind, text) {
    $('netDot').className = 'dot ' + kind;
    $('netStatus').textContent = text;
  }

  function updateViewerCount() {
    let n = 0;
    Net.conns.forEach((c) => c.open && n++);
    $('viewerCount').textContent = n;
  }

  function viewerBaseUrl() {
    let base = state.settings.viewerBaseUrl.trim();
    if (!base && /^https?:$/.test(location.protocol)) base = location.href.split(/[?#]/)[0];
    if (!base) return '';
    base = base.replace(/[^/]*\.html$/, '');
    return base.endsWith('/') ? base : base + '/';
  }

  function viewerUrl() {
    const base = viewerBaseUrl();
    return base ? base + 'viewer.html?host=' + encodeURIComponent(Net.hostId()) : '';
  }

  function renderQr() {
    const box = $('qrBox');
    const url = viewerUrl();
    box.innerHTML = '';
    if (!url) {
      $('viewerUrl').textContent = '設定 > 観客用スマホ接続 で viewer.html の公開URLを指定してください';
      return;
    }
    $('viewerUrl').textContent = url;
    if (typeof QRCode === 'undefined') {
      box.textContent = 'QRコードライブラリを読み込めません';
    } else {
      new QRCode(box, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
    }
    if (state.screenQr.url !== url) {
      state.screenQr.url = url;
      QB.saveState(state);
      channel.post({ type: 'STATE', state });
    }
  }

  // ---------- 設定ダイアログ ----------

  function fillSettings() {
    const s = state.settings;
    $('setTitle').value = s.title;
    $('setRule').value = s.rule;
    $('setWin').value = s.win;
    $('setLose').value = s.lose;
    $('setN').value = s.n;
    $('setRest').value = s.rest;
    $('setAutoReveal').checked = s.autoReveal;
    $('setSound').checked = s.sound;
    $('setViewerBase').value = s.viewerBaseUrl;
    $('setPlayers').value = state.players
      .map((p) => p.name + ',' + (QB.COLORS[p.color] || QB.COLORS.dark).label)
      .join('\n');
    $('jumpQNo').value = state.qNo;
    toggleRuleFields();
    renderSettingsInfo();
  }

  function renderSettingsInfo() {
    $('questionsInfo').textContent = questions.length
      ? questions.length + '問を読み込み済み'
      : '問題データが読み込まれていません';
    const files = Sound.loadedFiles();
    $('soundInfo').textContent = files.length
      ? '音声ファイル使用中: ' + files.join(', ') + ' (その他は合成音)'
      : 'sounds/ に音声ファイルが無いため合成音を使用します';
  }

  function toggleRuleFields() {
    const rule = $('setRule').value;
    document.querySelectorAll('[data-rule]').forEach((el) => {
      el.hidden = el.dataset.rule !== rule;
    });
  }

  function intIn(id, min, max, fallback) {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }

  function applyRule() {
    const s = state.settings;
    commit((st) => {
      Object.assign(st.settings, {
        title: $('setTitle').value.trim(),
        rule: $('setRule').value,
        win: intIn('setWin', 1, 99, s.win),
        lose: intIn('setLose', 1, 99, s.lose),
        n: intIn('setN', 1, 99, s.n),
        rest: intIn('setRest', 0, 20, s.rest),
        autoReveal: $('setAutoReveal').checked,
        sound: $('setSound').checked,
      });
      // ルール変更後の勝ち抜け/失格を再判定 (既存の順位は維持)
      st.players.forEach((p) => QB.evaluate(st, p));
      emit('settings');
    });
    toast('ルール・表示を適用しました');
  }

  function applyPlayers() {
    const lines = $('setPlayers').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      toast('プレイヤーを1人以上入力してください');
      return;
    }
    if (!confirm(lines.length + '人でプレイヤーを再設定します。得点はリセットされます。')) return;
    commit((st) => {
      st.players = lines.map((line, i) => {
        const [name, colorLabel] = line.split(/[,，、]/).map((x) => x.trim());
        return QB.createPlayer(i, name, COLOR_BY_LABEL[colorLabel] || colorLabel);
      });
      emit('players');
    });
    toast('プレイヤーを再設定しました');
  }

  // ---------- イベント ----------

  $('nextBtn').addEventListener('click', actions.next);
  $('throughBtn').addEventListener('click', actions.through);
  $('revealBtn').addEventListener('click', actions.reveal);
  $('undoBtn').addEventListener('click', actions.undo);
  $('resetSetBtn').addEventListener('click', actions.resetSet);

  $('players').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.pcard').dataset.id;
    const act = btn.dataset.act;
    if (act === 'correct') actions.correct(id);
    else if (act === 'wrong') actions.wrong(id);
    else if (act === 'adj') actions.adjust(id, btn.dataset.field, parseInt(btn.dataset.delta, 10));
  });

  $('openScreenBtn').addEventListener('click', () => {
    window.open('screen.html', 'quiz_screen', 'popup,width=1280,height=720');
  });

  $('screenQrToggle').addEventListener('change', (e) => {
    state.screenQr.visible = e.target.checked;
    state.screenQr.url = viewerUrl();
    publish();
  });

  $('openSettingsBtn').addEventListener('click', () => {
    fillSettings();
    $('settingsDialog').showModal();
  });
  $('setRule').addEventListener('change', toggleRuleFields);
  $('applyRuleBtn').addEventListener('click', applyRule);
  $('applyPlayersBtn').addEventListener('click', applyPlayers);

  $('questionsFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file
      .text()
      .then((text) => setQuestions(JSON.parse(text), file.name))
      .catch((err) => toast('読み込みに失敗しました: ' + err.message));
    e.target.value = '';
  });
  $('reloadQuestionsBtn').addEventListener('click', () => fetchQuestionsJson(false));

  $('jumpBtn').addEventListener('click', () => {
    const max = questions.length || 9999;
    const qNo = intIn('jumpQNo', 0, max, state.qNo);
    commit((st) => {
      st.qNo = qNo;
      st.revealed = false;
      emit('question');
    });
    toast(qNo ? '第' + qNo + '問に移動しました' : '開始前に戻しました');
  });

  $('applyViewerBtn').addEventListener('click', () => {
    state.settings.viewerBaseUrl = $('setViewerBase').value.trim();
    publish();
    renderQr();
    toast('観客用URLを更新しました');
  });

  $('regenIdBtn').addEventListener('click', () => {
    if (!confirm('接続IDを再発行します。接続中の観客は切断され、QRコードが変わります。')) return;
    try {
      localStorage.removeItem(QB.KEYS.hostId);
    } catch (e) {
      /* ignore */
    }
    Net.start();
    renderQr();
  });

  $('factoryResetBtn').addEventListener('click', () => {
    if (!confirm('設定・プレイヤー・得点・履歴をすべて初期化します。元に戻せません。')) return;
    state = QB.defaultState();
    QB.clearHistory();
    publish();
    fillSettings();
    renderQr();
    toast('初期化しました');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      actions.undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'n') actions.next();
    else if (key === 't') actions.through();
    else if (key === 'a') actions.reveal();
  });

  // ---------- 起動 ----------

  Sound.init();
  if (!questions.length) fetchQuestionsJson(true);
  publish();
  renderQr();
  Net.start();
  setInterval(() => Net.prune(), 5000);
})();
