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
    hostKey: 'quizboard.hostKey.v1',
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
      n: 10, // NbyN の N (10by10 固定)
      winners: 0, // 勝ち抜け人数 (0 = 未設定)
      rest: 0, // 誤答後に休む問題数 (0 = なし)
      sound: true,
      viewerBaseUrl: '', // viewer.html を公開している URL (空なら自動判定)
    };
  }

  let idCounter = 0;
  function createPlayer(index, name, color, seed, advantage) {
    idCounter += 1;
    return {
      id: 'p' + Date.now().toString(36) + idCounter,
      name: name,
      color: COLORS[color] ? color : COLOR_ORDER[index % COLOR_ORDER.length],
      advantage: Number.isInteger(advantage) && advantage > 0 ? advantage : 0, // アド: セット開始時点で持つマル数
      correct: Number.isInteger(advantage) && advantage > 0 ? advantage : 0,
      wrong: 0,
      points: 0, // 連答付きルールの得点
      chain: false, // 連答権の有無 (連答付きルール)
      status: 'active', // 'active' | 'win' | 'lose'
      rank: 0, // 勝ち抜け順
      seed: Number.isInteger(seed) && seed > 0 ? seed : 0, // 運営が設定する順位 (0 = 未設定)
      restUntil: -1, // この問題番号まで休み
      restFrom: -1, // 休みが決まった (誤答した) 問題番号
    };
  }

  // ---------- タイマー (Number10 系ルール) ----------

  const TIMER_DEFAULT_SEC = 15 * 60;
  const TIMER_RULES = ['nbyn', 'freeze10', 'updown10', 'swedish10'];

  /** duration: 設定時間(秒) / remaining: 停止中の残り(ms) / endsAt: 動作中の終了時刻(ms) */
  function defaultTimer() {
    return { duration: TIMER_DEFAULT_SEC, remaining: TIMER_DEFAULT_SEC * 1000, running: false, endsAt: 0 };
  }

  function hasTimer(rule) {
    return TIMER_RULES.includes(rule);
  }

  /** 現在の残り時間 (ms) */
  function timerRemaining(t, now) {
    if (t.running) return Math.max(0, t.endsAt - (now == null ? Date.now() : now));
    return Math.max(0, t.remaining);
  }

  function timerText(ms) {
    const sec = Math.ceil(ms / 1000);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function defaultState() {
    const players = [];
    for (let i = 0; i < 8; i++) players.push(createPlayer(i, 'プレイヤー' + (i + 1)));
    return {
      v: 1,
      settings: defaultSettings(),
      players: players,
      qNo: 0, // 0 = 開始前
      qBlank: false, // ルール変更・プレイヤー再設定の直後 (次に問題を動かすまで問題表示を空にする)
      qFloor: 0, // 観客ビューアの履歴はこの番号より後の問題だけ出す
      screenQr: { visible: false, url: '' },
      screenQ: { visible: false, question: '', answer: '' }, // スコアボードへの問題表示 (通信障害時用)
      timer: defaultTimer(),
      event: null, // { seq, type, playerId } 演出用の直近イベント
      seq: 0,
      updatedAt: Date.now(),
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players)) return base;
    return Object.assign(base, raw, {
      settings: Object.assign(defaultSettings(), raw.settings || {}, { n: 10 }), // NbyN は 10by10 固定
      screenQr: Object.assign(base.screenQr, raw.screenQr || {}),
      screenQ: Object.assign(base.screenQ, raw.screenQ || {}),
      timer: Object.assign(base.timer, raw.timer || {}),
    });
  }

  // ---------- ルール判定 ----------

  function score(st, p) {
    if (st.settings.rule === 'nbyn') return p.correct * Math.max(0, st.settings.n - p.wrong);
    if (st.settings.rule === 'renda' || st.settings.rule === 'updown10') return p.points || 0;
    return p.correct;
  }

  function hasWon(st, p) {
    const s = st.settings;
    if (s.rule === 'nomx') return p.correct >= s.win;
    if (s.rule === 'renda') return score(st, p) >= s.win;
    if (s.rule === 'freeze10' || s.rule === 'swedish10') return p.correct >= 10;
    if (s.rule === 'updown10') return score(st, p) >= 10;
    if (s.rule === 'nbyn') return score(st, p) >= s.n * s.n;
    return false;
  }

  function hasLost(st, p) {
    const s = st.settings;
    if (s.rule === 'nomx' || s.rule === 'renda') return p.wrong >= s.lose;
    if (s.rule === 'updown10') return p.wrong >= 2;
    if (s.rule === 'swedish10') return p.wrong >= 10;
    if (s.rule === 'nbyn') return p.wrong >= s.n;
    return false;
  }

  /** 正解を記録する。連答付きは連答権の獲得・消費(+2点)・他者の連答権喪失も処理する。 */
  function applyCorrect(st, p) {
    p.correct += 1;
    if (st.settings.rule === 'updown10') p.points = (p.points || 0) + 1;
    if (st.settings.rule !== 'renda') return;
    st.players.forEach((q) => {
      if (q !== p) q.chain = false;
    });
    if (p.chain) {
      p.points = (p.points || 0) + 2;
      p.chain = false;
    } else {
      p.points = (p.points || 0) + 1;
      p.chain = true;
    }
  }

  /** 誤答を記録する。連答権を持っていれば失う。 */
  /** Swedish10: 誤答時の得点帯ごとの受ける×の数 */
  function swedishPenalty(points) {
    if (points <= 0) return 1;
    if (points <= 2) return 2;
    if (points <= 5) return 3;
    return 4;
  }

  function applyWrong(st, p) {
    p.wrong += st.settings.rule === 'swedish10' ? swedishPenalty(p.correct) : 1;
    p.chain = false;
    if (st.settings.rule === 'updown10') p.points = 0; // 誤答で0ポイントに戻る
  }

  /** 勝ち抜けまでの達成率 0〜1 (スコアボードのネームプレートの充填量) */
  function progress(st, p) {
    if (p.status === 'win') return 1;
    const s = st.settings;
    let cur, target;
    if (s.rule === 'nomx') [cur, target] = [p.correct, s.win];
    else if (s.rule === 'renda') [cur, target] = [score(st, p), s.win];
    else if (s.rule === 'nbyn') [cur, target] = [score(st, p), s.n * s.n];
    else if (s.rule === 'updown10') [cur, target] = [score(st, p), 10];
    else if (s.rule === 'freeze10' || s.rule === 'swedish10') [cur, target] = [p.correct, 10];
    else return 0;
    return Math.max(0, Math.min(1, cur / target));
  }

  function isResting(st, p) {
    const restable = st.settings.rest > 0 || st.settings.rule === 'freeze10';
    return p.status === 'active' && restable && p.restUntil >= st.qNo;
  }

  /**
   * 休みの残り問題数。誤答した問題の間は「これから休む問題数」、
   * 次の問題以降は「今の問題を含めて休む問題数」(最後の1問で 1)。
   */
  function restLeft(st, p) {
    const left = p.restUntil - st.qNo + (st.qNo === p.restFrom ? 0 : 1);
    return Math.max(1, left);
  }

  /** 「N>>M」表示用。N=解答権が残っている人数 / M=残りの勝ち抜け人数。未設定なら空文字。 */
  function survivorsText(st) {
    const w = st.settings.winners;
    if (!(w > 0)) return '';
    const n = st.players.filter((p) => p.status === 'active').length;
    const m = Math.max(0, w - st.players.filter((p) => p.status === 'win').length);
    return n + '>>' + m;
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

  /** 運営が設定した順位の色帯: 1-4 赤 / 5-12 青 / 13-24 黄 / 25-48 緑 / 49- 紫 */
  function seedTier(n) {
    if (n <= 4) return 'red';
    if (n <= 12) return 'blue';
    if (n <= 24) return 'yellow';
    if (n <= 48) return 'green';
    return 'purple';
  }

  /** 表示用バッジ { cls, label } */
  function badge(st, p) {
    if (p.status === 'win') return { cls: 'rank rank-' + Math.min(p.rank, 4), label: ordinal(p.rank) };
    if (p.status === 'lose') return { cls: 'lose', label: 'LOSE' };
    if (isResting(st, p)) return { cls: 'rest', label: restLeft(st, p) + '休' };
    if (st.settings.rule === 'renda' && p.chain) return { cls: 'chain', label: '連答' };
    return { cls: '', label: '' };
  }

  const PLACEHOLDER = { question: 'ここに問題が表示されます', answer: 'ここに解答が表示されます' };

  function ruleLabel(s) {
    let label;
    if (s.rule === 'nomx') label = s.win + '○' + s.lose + '×';
    else if (s.rule === 'renda') label = '連答付き ' + s.win + '○' + s.lose + '×';
    else if (s.rule === 'nbyn') label = s.n + 'by' + s.n;
    else if (s.rule === 'freeze10') label = 'Freeze10';
    else if (s.rule === 'updown10') label = '10Up-Down';
    else if (s.rule === 'swedish10') label = 'Swedish10';
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
    progress,
    applyCorrect,
    applyWrong,
    swedishPenalty,
    defaultTimer,
    hasTimer,
    timerRemaining,
    timerText,
    isResting,
    survivorsText,
    restLeft,
    evaluate,
    badge,
    ordinal,
    seedTier,
    ruleLabel,
    PLACEHOLDER,
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
