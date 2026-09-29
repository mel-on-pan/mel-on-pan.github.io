/*
 * 共通モジュール: 状態モデル / ルール判定 / 保存 / 画面間通信
 * index.html (運営) と screen.html (スコアボード) から読み込む。
 */
(function (global) {
  'use strict';

  const KEYS = {
    state: 'quizboard.state.v1',
    history: 'quizboard.history.v1',
    questions: 'quizboard.questions.v1',
    hostId: 'quizboard.hostId.v1',
  };
  const CHANNEL_NAME = 'quiz_channel';
  const HISTORY_LIMIT = 100;

  const COLORS = {
    red: { label: '赤', hex: '#CC0000' },
    blue: { label: '青', hex: '#0044CC' },
    green: { label: '緑', hex: '#008833' },
    dark: { label: '黒', hex: '#222222' },
  };
  const COLOR_ORDER = ['red', 'blue', 'green', 'dark'];

  // ---------- 状態 ----------

  function defaultSettings() {
    return {
      title: '',
      rule: 'nomx', // 'nomx' | 'nbyn' | 'free'
      win: 7, // N○M× の勝ち抜け正解数
      lose: 3, // N○M× の失格誤答数
      n: 10, // NbyN の N
      rest: 0, // 誤答後に休む問題数 (0 = なし)
      autoReveal: true, // 正解判定で自動的に正解表示
      sound: true,
      viewerBaseUrl: '', // viewer.html を公開している URL (空なら自動判定)
    };
  }

  let idCounter = 0;
  function createPlayer(index, name, color) {
    idCounter += 1;
    return {
      id: 'p' + Date.now().toString(36) + idCounter,
      name: name,
      color: COLORS[color] ? color : COLOR_ORDER[index % COLOR_ORDER.length],
      correct: 0,
      wrong: 0,
      status: 'active', // 'active' | 'win' | 'lose'
      rank: 0,
      restUntil: -1, // この問題番号まで休み
    };
  }

  function defaultState() {
    const players = [];
    for (let i = 0; i < 8; i++) players.push(createPlayer(i, 'プレイヤー' + (i + 1)));
    return {
      v: 1,
      settings: defaultSettings(),
      players: players,
      qNo: 0, // 0 = 開始前
      revealed: false,
      screenQr: { visible: false, url: '' },
      event: null, // { seq, type, playerId } 演出用の直近イベント
      seq: 0,
      updatedAt: Date.now(),
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players)) return base;
    return Object.assign(base, raw, {
      settings: Object.assign(defaultSettings(), raw.settings || {}),
      screenQr: Object.assign(base.screenQr, raw.screenQr || {}),
    });
  }

  // ---------- ルール判定 ----------

  function score(st, p) {
    if (st.settings.rule === 'nbyn') return p.correct * Math.max(0, st.settings.n - p.wrong);
    return p.correct;
  }

  function hasWon(st, p) {
    const s = st.settings;
    if (s.rule === 'nomx') return p.correct >= s.win;
    if (s.rule === 'nbyn') return score(st, p) >= s.n * s.n;
    return false;
  }

  function hasLost(st, p) {
    const s = st.settings;
    if (s.rule === 'nomx') return p.wrong >= s.lose;
    if (s.rule === 'nbyn') return p.wrong >= s.n;
    return false;
  }

  function isResting(st, p) {
    return p.status === 'active' && st.settings.rest > 0 && p.restUntil >= st.qNo;
  }

  function nextRank(st) {
    return st.players.reduce((max, p) => Math.max(max, p.rank || 0), 0) + 1;
  }

  /** 得点変化後に勝ち抜け/失格を再判定する。状態が変わったら 'win' / 'lose' を返す。 */
  function evaluate(st, p) {
    const won = hasWon(st, p);
    const lost = hasLost(st, p);
    if (p.status === 'win' && !won) {
      p.status = 'active';
      p.rank = 0;
    }
    if (p.status === 'lose' && !lost) p.status = 'active';
    if (p.status === 'active') {
      if (won) {
        p.status = 'win';
        p.rank = nextRank(st);
        return 'win';
      }
      if (lost) {
        p.status = 'lose';
        return 'lose';
      }
    }
    return null;
  }

  function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }

  /** 表示用バッジ { cls, label } */
  function badge(st, p) {
    if (p.status === 'win') return { cls: 'rank rank-' + Math.min(p.rank, 4), label: ordinal(p.rank) };
    if (p.status === 'lose') return { cls: 'lose', label: 'LOSE' };
    if (isResting(st, p)) return { cls: 'rest', label: '休み' };
    return { cls: '', label: '' };
  }

  function ruleLabel(s) {
    let label;
    if (s.rule === 'nomx') label = s.win + '○' + s.lose + '×';
    else if (s.rule === 'nbyn') label = s.n + 'by' + s.n;
    else label = 'FREE';
    if (s.rest > 0) label += ' / 誤答' + s.rest + '回休み';
    return label;
  }

  // ---------- 保存 ----------

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('保存に失敗しました', e);
    }
  }

  function loadState() {
    const raw = readJSON(KEYS.state);
    return raw ? normalizeState(raw) : null;
  }

  function pushHistory(st) {
    const hist = readJSON(KEYS.history) || [];
    hist.push(st);
    while (hist.length > HISTORY_LIMIT) hist.shift();
    writeJSON(KEYS.history, hist);
  }

  function popHistory() {
    const hist = readJSON(KEYS.history) || [];
    const prev = hist.pop();
    writeJSON(KEYS.history, hist);
    return prev ? normalizeState(prev) : null;
  }

  function historySize() {
    return (readJSON(KEYS.history) || []).length;
  }

  function clearHistory() {
    writeJSON(KEYS.history, []);
  }

  /** questions.json 形式の検証と正規化 */
  function normalizeQuestions(data) {
    if (!Array.isArray(data)) throw new Error('問題データは配列である必要があります');
    return data.map((q, i) => {
      if (!q || typeof q.question !== 'string' || typeof q.answer !== 'string') {
        throw new Error((i + 1) + '件目に question / answer がありません');
      }
      return {
        id: q.id != null ? q.id : i + 1,
        question: q.question,
        answer: q.answer,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
      };
    });
  }

  // ---------- 画面間通信 (同一PC) ----------

  /**
   * BroadcastChannel を主経路とし、storage イベントを予備経路として併用する。
   * (file:// で開いた場合など、環境により片方しか届かないことがあるため)
   */
  function openChannel(onMessage) {
    let ch = null;
    try {
      ch = new BroadcastChannel(CHANNEL_NAME);
      ch.onmessage = (e) => onMessage(e.data);
    } catch (e) {
      console.warn('BroadcastChannel が使えません。storage イベントのみで同期します。');
    }
    global.addEventListener('storage', (e) => {
      if (e.key !== KEYS.state || !e.newValue) return;
      try {
        onMessage({ type: 'STATE', state: normalizeState(JSON.parse(e.newValue)) });
      } catch (err) {
        /* 壊れたデータは無視 */
      }
    });
    return {
      post(msg) {
        if (ch) ch.postMessage(msg);
      },
    };
  }

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.QB = {
    KEYS,
    COLORS,
    COLOR_ORDER,
    defaultSettings,
    defaultState,
    createPlayer,
    normalizeState,
    score,
    hasWon,
    hasLost,
    isResting,
    evaluate,
    badge,
    ordinal,
    ruleLabel,
    readJSON,
    writeJSON,
    loadState,
    saveState: (st) => writeJSON(KEYS.state, st),
    pushHistory,
    popHistory,
    historySize,
    clearHistory,
    normalizeQuestions,
    openChannel,
    escapeHTML,
  };
})(typeof window !== 'undefined' ? window : globalThis);
