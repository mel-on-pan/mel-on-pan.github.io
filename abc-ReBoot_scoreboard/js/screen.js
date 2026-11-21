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
      '<div class="penalty-display"></div>' +
      '<div class="set-pips"></div>';
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
    if (s.rule === 'timerace') return ''; // SF: 試合中は正解・誤答を出さない
    if (s.rule === 'swedish10') return swedishHTML(p);
    // 10by10: 得点の式 ○ × (10 − ×) を表示
    if (s.rule === 'nbyn') {
      return '<span class="o">' + p.correct + '</span><span class="op">×</span>' +
        '<span class="x on">' + Math.max(0, 10 - p.wrong) + '</span>';
    }
    // Freeze10: バツ数のみ
    if (s.rule === 'freeze10') return '<span class="x on">' + p.wrong + '×</span>';
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

  function applyTimer(el, t) {
    const ms = QB.timerRemaining(t);
    el.textContent = QB.timerText(ms);
    el.classList.toggle('paused', !t.running && ms > 0);
    el.classList.toggle('over', ms <= 0);
    el.classList.toggle('warn', ms > 0 && ms <= 60000);
  }

  function renderTimer() {
    const el = $('timer');
    const st = curTimerState;
    const clock = document.getElementById('sceneClock'); // 大型タイマーの場面にだけある
    if (clock && st) applyTimer(clock, st.timer);
    // スコアボードの小さなタイマーは、スコアボードを出しているときだけ
    if (!st || !QB.hasTimer(st.settings.rule) || (st.scene && st.scene.type !== 'board')) {
      el.textContent = '';
      return;
    }
    applyTimer(el, st.timer);
  }
  setInterval(renderTimer, 200);

  // ---------- 場面 (待機・大型タイマー・ターンオーバー) ----------

  let sceneKey = '';

  // ---------- ルーレット (3R: 組ごとのルールを決める) ----------
  // どのルールになるかは運営パネル側で乱数により決まっていて、ここは結果をスロットで見せるだけ。
  // 演出中は、その組のルールを「？」にして隠し、スロットが止まってから見せる。

  const ROULETTE_RULES = ['nbyn', 'freeze10', 'updown10', 'swedish10'];
  const REEL_MS = 4500;
  let reelSeenN = null; // 最後に見たルーレットの回数 (null = 場面を開いた直後。そのときの回数は演出しない)
  let reelAnimating = null; // 演出中の回数
  let reelStartedAt = 0;
  let reelAnim = null; // スロットの回転アニメーション (Web Animations)
  let reelDoneTimer = 0; // 画面が見えていなくても結果を出すための保険のタイマー
  let reelPlan = null; // 今のリールの止まる位置 { fin }
  let reelJustLanded = false; // 止まった直後の描画だけ、止まった演出 (拡大) を付ける
  let prevAssign = null; // 直前の描画での配置 (id → 組)。新しく配置された人を目立たせる

  const ruleText = (rule) => QB.ruleLabel({ rule, win: 1, lose: 1, rest: 0, n: 10 });

  /** 順位を序数にする (1 → 1st, 13 → 13th)。数字を大きく、th などを小さく見せる。順位なしは空 */
  function ordHTML(n) {
    if (!(n > 0)) return '';
    const s = QB.ordinal(n);
    const num = String(n);
    return num + '<small>' + s.slice(num.length) + '</small>';
  }

  function resetRoulette() {
    if (reelAnim) reelAnim.cancel();
    reelAnim = null;
    clearTimeout(reelDoneTimer);
    reelSeenN = null;
    reelAnimating = null;
    prevAssign = null;
  }

  /** 新しいルーレットが来ていたら演出を始める状態にする (HTML を作る前に呼ぶ) */
  function updateReelState(data) {
    const spin = data && data.spin;
    // 場面を開いた時点の回数を覚える (まだ回していなければ 0。その後に来た回は演出する)
    if (reelSeenN === null) reelSeenN = spin ? spin.n : 0;
    if (!spin) return;
    if (spin.n > reelSeenN) {
      reelSeenN = spin.n;
      reelAnimating = spin.n;
      reelStartedAt = performance.now();
    }
  }

  function finishReel() {
    clearTimeout(reelDoneTimer);
    if (reelAnim) reelAnim.onfinish = null;
    reelAnim = null;
    reelAnimating = null;
    reelJustLanded = true;
    sceneKey = ''; // ルールの表示を再描画する
    if (curTimerState) renderScene(curTimerState);
  }

  // リールの帯: 上から下へ並べた項目 (0, 1, 2, …)。窓の中央に来ている項目が「いま見えている」ルール。
  // 回転は、帯が上から下へ流れる = 見える項目の番号が REEL_STEPS 個ぶん小さくなっていく。
  // 止まる項目 (REEL_STOP) には、決まったルールを置く。その上にも項目を置いて、止まったとき窓の上側が空かないようにする。
  const REEL_STOP = 2;
  const REEL_STEPS = 16; // 回転中に流れる項目の数 (多いほど速い。名前が読める速さ (最大 約7個/秒) にするため少なめ)

  /**
   * 回転中のリール: ルール名を縦に並べた帯を作る。候補は、まだ選ばれていないルールだけ
   */
  function reelStrip(spin) {
    const cands = spin.candidates && spin.candidates.length ? spin.candidates : ROULETTE_RULES;
    const labels = cands.map(ruleText);
    const len = labels.length;
    const start = REEL_STOP + REEL_STEPS; // 回り始めに見えている項目
    const resIdx = Math.max(0, cands.indexOf(spin.rule));
    const off = (((resIdx - REEL_STOP) % len) + len) % len; // REEL_STOP 番目が決まったルールになるようにずらす
    let html = '';
    for (let i = 0; i < start + 3; i++) html += '<div class="reel-item">' + QB.escapeHTML(labels[(i + off) % len]) + '</div>';
    reelPlan = { start, stop: REEL_STOP };
    return '<div class="reel-strip">' + html + '</div>';
  }

  /** リールを回す (上から下へ流れて、だんだん遅くなって止まる)。途中で再描画された場合も、経過時間の続きから回す */
  function runReel() {
    if (reelAnim) reelAnim.cancel();
    reelAnim = null;
    const win = document.getElementById('reel');
    const strip = win && win.querySelector('.reel-strip');
    const item = strip && strip.querySelector('.reel-item');
    if (!strip || !item || !reelPlan) return;
    // 高さは小数のまま使う (offsetHeight は整数に丸められ、項目の数ぶんだけずれが積み重なる)
    const h = item.getBoundingClientRect().height;
    const cs = getComputedStyle(win);
    const innerH = win.getBoundingClientRect().height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    const center = (innerH - h) / 2; // 項目 0 が窓の中央に来る位置
    const yAt = (i) => center - i * h; // 項目 i が窓の中央に来る位置
    const y0 = yAt(reelPlan.start);
    const y1 = yAt(reelPlan.stop);
    strip.style.transform = 'translateY(' + y0 + 'px)';
    reelAnim = strip.animate(
      [
        { transform: 'translateY(' + y0 + 'px)', offset: 0 },
        { transform: 'translateY(' + (y1 + h * 0.14) + 'px)', offset: 0.94 }, // 止まる位置を少し行き過ぎて…
        { transform: 'translateY(' + y1 + 'px)', offset: 1 }, // …戻る
      ],
      { duration: REEL_MS, easing: 'cubic-bezier(0.25, 0.1, 0.35, 1)', fill: 'forwards' } // 動き出して読める速さまで上がり、約4秒かけてだんだん遅くなって止まる
    );
    const elapsed = Math.min(REEL_MS, performance.now() - reelStartedAt);
    reelAnim.currentTime = elapsed;
    reelAnim.onfinish = finishReel;
    // 画面が隠れていてアニメーションの終了通知が来ない場合でも、時間が来たら結果を出す
    clearTimeout(reelDoneTimer);
    reelDoneTimer = setTimeout(() => reelAnimating !== null && finishReel(), REEL_MS - elapsed + 80);
  }

  function rouletteHTML(st) {
    const d = st.scene.data || {};
    const e = QB.escapeHTML;
    const spin = d.spin;
    const sets = d.sets || [];
    const animating = !!spin && reelAnimating === spin.n;
    const hidden = animating ? spin.setIndex : -1; // 演出中はこの組のルールを隠す
    const ruleOf = (si) => (sets[si] && sets[si].rule && si !== hidden ? ruleText(sets[si].rule) : '？');

    // スロット: 次に決める組 (演出前) / 直近に決めた組
    const nextSi = sets.findIndex((s, si) => !s.rule || si === hidden);
    const shownSi = spin ? spin.setIndex : nextSi;
    const label = shownSi >= 0 && sets[shownSi] ? sets[shownSi].title + ' のルール' : 'ルーレット';
    const reelText = animating ? '' : spin && sets[spin.setIndex] && sets[spin.setIndex].rule ? ruleText(sets[spin.setIndex].rule) : '？';

    // 候補のルール (決まったものは外れて、どの組になったかを出す)
    const chips = ROULETTE_RULES.map((r) => {
      const si = sets.findIndex((s, i) => s.rule === r && i !== hidden);
      return '<span class="rl-rule' + (si >= 0 ? ' used' : '') + '">' + e(ruleText(r)) + (si >= 0 ? '<small>' + e(sets[si].title) + '</small>' : '') + '</span>';
    }).join('');

    const assign = new Map();
    const plates = (d.players || [])
      .map((p) => {
        const hide = p.set >= 0 && p.set === hidden;
        const si = hide ? -1 : p.set;
        if (si >= 0) assign.set(p.id, si);
        const just = prevAssign && si >= 0 && prevAssign.get(p.id) !== si;
        const tier = QB.seedTier(p.seed);
        return (
          '<div class="rl-plate tier-' + tier + (si >= 0 ? ' assigned' : '') + (just ? ' just' : '') + '">' +
          '<span class="to-rank">' + ordHTML(p.seed) + '</span><span class="to-name">' + e(p.name) + '</span>' +
          (si >= 0 ? '<span class="rl-tag">' + e(sets[si].title) + '</span>' : '') +
          '</div>'
        );
      })
      .join('');
    prevAssign = assign;

    const cards = sets
      .map((s, si) => {
        const members = (d.players || []).filter((p) => p.set === si && si !== hidden);
        const rows = [];
        for (let i = 0; i < Math.max(5, members.length); i++) {
          const p = members[i];
          rows.push(p ? '<div class="rl-slot tier-' + QB.seedTier(p.seed) + ' filled"><span class="to-rank">' + ordHTML(p.seed) + '</span><span class="to-name">' + e(p.name) + '</span></div>' : '<div class="rl-slot"></div>');
        }
        return (
          '<div class="rl-card' + (s.status === 'done' ? ' done' : '') + '">' +
          '<div class="rl-card-head"><span>' + e(s.title) + '</span><b>' + e(ruleOf(si)) + '</b></div>' +
          rows.join('') +
          '</div>'
        );
      })
      .join('');

    return (
      '<div class="rl-top"><div class="rl-label">' + e(label) + '</div>' +
      '<div id="reel" class="rl-reel">' +
      (animating ? reelStrip(spin) : '<div class="reel-strip"><div class="reel-item' + (reelJustLanded ? ' landed' : '') + '">' + e(reelText) + '</div></div>') +
      '</div>' +
      '<div class="rl-rules">' + chips + '</div></div>' +
      '<div class="rl-main"><div class="rl-pool">' + plates + '</div><div class="rl-cards">' + cards + '</div></div>'
    );
  }

  function sceneHTML(st) {
    const sc = st.scene;
    const e = QB.escapeHTML;
    const logo = '<img class="scene-logo" src="reboot_logo_dark.png" alt="abc ReBoot">';
    if (sc.type === 'roulette') return rouletteHTML(st);
    if (sc.type === 'standby') {
      const n = (sc.data && sc.data.next) || {};
      const time = String(n.time || '').trim();
      const what = String(n.what || '').trim();
      const a = String(n.a || '').trim();
      // 時刻と開始予定の内容が両方入っているときだけ「Next→…」の文を出す (空なら出さない)
      const next = time && what ? '<div class="scene-next">Next→' + (a ? e(a) + '：' : '') + e(time) + 'から' + e(what) + 'を開始予定</div>' : '';
      return logo + next; // 大会名・ラウンド名などのタイトルは出さない (ロゴと「Next→…」の文だけ)
    }
    if (sc.type === 'timer') {
      return '<div class="scene-title">' + e(sc.title) + '</div><div id="sceneClock" class="scene-clock"></div>';
    }
    return '';
  }

  /** プレートの名前が枠に収まらないときは、文字サイズを少しずつ小さくして収める (下限は元の55%) */
  function fitNames(root) {
    root.querySelectorAll('.to-name').forEach((el) => {
      el.style.fontSize = '';
      const base = parseFloat(getComputedStyle(el).fontSize);
      let size = base;
      while (el.scrollWidth > el.clientWidth + 1 && size > base * 0.55) {
        size -= 1;
        el.style.fontSize = size + 'px';
      }
    });
  }
  window.addEventListener('resize', () => {
    const el = $('scene');
    if (!el.hidden) fitNames(el);
  });
  if (document.fonts) document.fonts.ready.then(() => !$('scene').hidden && fitNames($('scene')));

  // ---------- ターンオーバー (グループごとにまとめて) ----------
  // 黒い四角 (縁は順位の色、順位は白字) が、①回転しながら登場 → ②180度回って名前面に変わる → ③登場の逆再生の要領で、回転しながら消える。
  // グループの全員が同時に動く。43〜48位だけは裏返しを2回に分ける (全員登場 → 43〜47位を裏返す → 48位を裏返す → 全員退場)。
  // 運営パネルの「▶」で1段階ずつ進める (scene.step: 0 = 何もない / 1 = 登場後 / 2〜(1+裏返しの回数) = 裏返し / 最後 = 消えた後)。
  // 1つ進めたときだけ動かし、戻したときや場面を開いた直後は、動かさずにその状態にする。

  // 登場・退場の動きの設定。1位のターンオーバーだけは、ゆったり長く回る (最後にじっくり止まり、退場もゆっくり動き出す)。
  // それ以外の順位は、短く、減速の尾を短くして、スッと出てスッと消える。
  // 退場の曲線は、どちらも登場の曲線を時間の向きで反転したもの (登場の逆再生)。
  const TO_PROFILES = {
    // flip: 裏返し (180度)。ms = 長さ / ease = 曲線 / pop = 真横になる中間で手前に出て大きくなる倍率
    grand: { turns: 3, enter: 2200, exit: 2200, easeIn: 'cubic-bezier(0.2, 0.9, 0.3, 1)', easeOut: 'cubic-bezier(0.7, 0, 0.8, 0.1)', flip: { ms: 1000, ease: 'cubic-bezier(0.5, 0, 0.2, 1)', pop: 1.12 } },
    quick: { turns: 2, enter: 1000, exit: 1000, easeIn: 'cubic-bezier(0.3, 0.5, 0.5, 1)', easeOut: 'cubic-bezier(0.5, 0, 0.7, 0.5)', flip: { ms: 600, ease: 'cubic-bezier(0.25, 0.1, 0.35, 1)', pop: 1.06 } },
  };
  const TO_POSE = [
    { transform: 'rotateY(-90deg) scale(0.15)', opacity: 0 }, // 0: 何もない
    { transform: 'rotateY(0deg) scale(1)', opacity: 1 }, // 1: 順位面
    { transform: 'rotateY(180deg) scale(1)', opacity: 1 }, // 2: 名前面
    { transform: 'rotateY(90deg) scale(0.15)', opacity: 0 }, // 3: 消えた
  ];
  let toState = null; // { key, grand, flips, count, step } 今出しているグループと段階
  let toToken = 0; // 動きの途中で次の操作が来たとき、古いタイマーが姿勢を上書きしないための番号

  const toSlots = (el) => [...el.querySelectorAll('.to-slot')];
  const toExitStep = () => toState.flips.length + 2; // 退場の段階 (1 = 登場, 2〜 = 裏返し)

  /** 1枚のカードを、その姿勢 (0〜3) にする。動いている途中のものは止める */
  function setCardPose(slot, pose) {
    toToken++;
    const fade = slot.querySelector('.to-fade');
    const card = slot.querySelector('.to-card');
    fade.getAnimations().concat(card.getAnimations()).forEach((a) => a.cancel());
    slot.querySelectorAll('.to-spinwrap').forEach((w) => {
      w.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      w.remove();
    });
    card.style.transform = TO_POSE[pose].transform;
    fade.style.opacity = TO_POSE[pose].opacity;
  }

  /** ある段階での、i 番目のカードの姿勢 */
  function cardPoseAt(step, i) {
    if (step <= 0) return 0;
    if (step >= toExitStep()) return 3;
    if (step === 1) return 1;
    const batch = toState.flips.findIndex((b) => b.includes(i));
    return step >= 2 + Math.max(0, batch) ? 2 : 1;
  }

  /** 全員を、その段階の姿勢にする (動かさずに) */
  function setAllPoses(el, step) {
    toSlots(el).forEach((slot, i) => setCardPose(slot, cardPoseAt(step, i)));
  }

  /** 名前が面に収まらないときは文字を小さくする */
  function fitCardName(slot) {
    const name = slot.querySelector('.tc-name');
    if (!name) return;
    name.style.fontSize = '';
    const base = parseFloat(getComputedStyle(name).fontSize);
    let size = base;
    while (name.scrollWidth > name.clientWidth + 1 && size > base * 0.4) {
      size -= 1;
      name.style.fontSize = size + 'px';
    }
  }

  /**
   * 何回転もする登場・退場用の「回転用カード」。本体のカードは裏側が名前面なので、何回転もすると裏側 (名前) が見えてしまう。
   * そこで回転中は、表も裏も同じ面 (登場=順位の四角 / 退場=名前の横長) の両面カードに差し替える。
   * 回転の前後は本体のカードと見た目が同じなので、差し替えは分からない。
   */
  function makeSpinner(slot, kind) {
    const rank = slot.querySelector('.tc-rank');
    const name = slot.querySelector('.tc-name');
    const faces =
      kind === 'rank'
        ? '<div class="to-face to-front">' + rank.outerHTML + '</div><div class="to-face to-front" style="transform:rotateY(180deg)">' + rank.outerHTML + '</div>'
        : '<div class="to-face to-back" style="transform:none">' + name.outerHTML + '</div><div class="to-face to-back">' + name.outerHTML + '</div>';
    const wrap = document.createElement('div');
    wrap.className = 'to-spinwrap';
    wrap.innerHTML = '<div class="to-spin">' + faces + '</div>';
    slot.appendChild(wrap);
    return wrap;
  }

  /** 1枚のカードを動かす。kind = 'enter' | 'flip' | 'exit'。動きの長さ (ms) を返す */
  function playCard(slot, kind, prof) {
    const fade = slot.querySelector('.to-fade');
    const card = slot.querySelector('.to-card');
    if (kind === 'flip') {
      // 180度回って、順位面から名前面へ (真横になる中間で、少し手前に出て大きくなる)
      const f = prof.flip;
      card.animate([{ transform: 'rotateY(0deg) scale(1)' }, { transform: 'rotateY(90deg) scale(' + f.pop + ')', offset: 0.5 }, { transform: 'rotateY(180deg) scale(1)' }], { duration: f.ms, easing: f.ease, fill: 'forwards' });
      return f.ms;
    }
    if (kind === 'enter') {
      // 登場: 縦軸で何回転もしながら、小さな点から大きくなって現れる。最初は勢いよく、だんだん遅くなって順位面で止まる
      const wrap = makeSpinner(slot, 'rank');
      wrap.firstChild.animate([{ transform: 'rotateY(' + -360 * prof.turns + 'deg) scale(0.1)' }, { transform: 'rotateY(0deg) scale(1)' }], { duration: prof.enter, easing: prof.easeIn, fill: 'forwards' });
      wrap.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1 }], { duration: prof.enter, easing: 'linear', fill: 'forwards' });
      return prof.enter;
    }
    // 退場: 登場の逆再生。名前面のまま、登場と逆向きに何回転もしながら小さくなって消える (曲線も登場の時間反転)
    fade.style.opacity = 0; // 本体のカードは隠して、同じ見た目の回転用カードに替える
    const wrap = makeSpinner(slot, 'name');
    wrap.firstChild.animate([{ transform: 'rotateY(0deg) scale(1)' }, { transform: 'rotateY(' + -360 * prof.turns + 'deg) scale(0.1)' }], { duration: prof.exit, easing: prof.easeOut, fill: 'forwards' });
    wrap.animate([{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: prof.exit, easing: 'linear', fill: 'forwards' });
    return prof.exit;
  }

  /** 段階を1つ進めたときの動き (グループの全員、または裏返しの分担ぶんが同時に動く) */
  function playStep(el, step) {
    setAllPoses(el, step - 1); // 動かす前の姿勢にそろえる
    const token = ++toToken;
    const prof = toState.grand ? TO_PROFILES.grand : TO_PROFILES.quick;
    const slots = toSlots(el);
    let kind;
    let targets;
    if (step === 1) {
      kind = 'enter';
      targets = slots;
    } else if (step >= toExitStep()) {
      kind = 'exit';
      targets = slots;
    } else {
      kind = 'flip';
      targets = (toState.flips[step - 2] || []).map((i) => slots[i]).filter(Boolean);
    }
    let ms = 0;
    targets.forEach((slot) => {
      ms = Math.max(ms, playCard(slot, kind, prof));
    });
    // 終わったら姿勢を確定する (画面が隠れていて終了通知が来ない場合も、時間が来たら確定する)
    setTimeout(() => {
      if (toToken === token) setAllPoses(el, step);
    }, ms + 40);
  }

  /** 人数に合わせて、画面を分けて並べる (順位の小さい人が左上、右へ・下へ)。カードの大きさ (--k) は、1枚ぶんの区画に収まる倍率 */
  function layoutTurnover(el) {
    const stage = el.querySelector('.to-stage');
    if (!stage || !toState) return;
    const n = toState.count;
    const cols = n <= 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : n === 4 ? 2 : 3;
    const rows = Math.max(1, Math.ceil(n / cols));
    const W = window.innerWidth;
    const H = window.innerHeight;
    const pad = 0.05 * H;
    const gap = 0.03 * H;
    const cellW = (W - 2 * pad - (cols - 1) * gap) / cols;
    const cellH = (H - 2 * pad - (rows - 1) * gap) / rows;
    // 名前面 (横長) は 高さ38vh × 幅92vh。それが区画に収まる倍率 (1人のときは等倍)
    const k = Math.min(1, cellW / (0.92 * H), cellH / (0.38 * H)) * (n === 1 ? 1 : 0.94);
    stage.style.setProperty('--cols', cols);
    stage.style.setProperty('--rows', rows);
    stage.style.setProperty('--k', k.toFixed(4));
    toSlots(el).forEach(fitCardName);
  }
  window.addEventListener('resize', () => {
    const el = $('scene');
    if (!el.hidden && el.dataset.mode === 'turnover') layoutTurnover(el);
  });

  function renderTurnover(st, el) {
    const sc = st.scene;
    const g = sc.data && sc.data.group;
    if (!g || !g.players || !g.players.length) {
      el.className = 'scene scene-turnover';
      el.innerHTML = '';
      toState = null;
      el.dataset.mode = '';
      return;
    }
    const e = QB.escapeHTML;
    const key = g.label + '|' + g.players.map((p) => p.seed).join('/') + '|' + JSON.stringify(g.flips); // 名前は含めない (後から届いても作り直さない)
    if (el.dataset.mode !== 'turnover' || !toState || toState.key !== key) {
      el.className = 'scene scene-turnover';
      el.dataset.mode = 'turnover';
      el.innerHTML =
        '<div class="to-stage">' +
        g.players
          .map(
            (p) =>
              '<div class="to-slot tier-' + QB.seedTier(p.seed) + '"><div class="to-fade"><div class="to-card">' +
              '<div class="to-face to-front"><span class="tc-rank">' + ordHTML(p.seed) + '</span></div>' +
              '<div class="to-face to-back"><span class="tc-name">' + e(p.name) + '</span></div>' +
              '</div></div></div>'
          )
          .join('') +
        '</div>';
      toState = { key, grand: g.players.length === 1 && g.players[0].seed === 1, flips: g.flips, count: g.players.length, step: null };
      layoutTurnover(el);
    }
    // 名前が変わったら (観客用は、裏返す段階で届く) 名前だけ入れ替える。動きの前に済ませる
    toSlots(el).forEach((slot, i) => {
      const nm = slot.querySelector('.tc-name');
      const want = g.players[i] ? g.players[i].name : '';
      if (nm && nm.textContent !== want) {
        nm.textContent = want;
        fitCardName(slot);
      }
    });
    const target = Math.min(toExitStep(), Math.max(0, sc.step | 0));
    const prev = toState.step;
    if (prev === null || (target !== prev && target !== prev + 1)) setAllPoses(el, target);
    else if (target === prev + 1) playStep(el, target);
    toState.step = target;
  }

  function leaveTurnover(el) {
    toState = null;
    toToken++;
    if (el.dataset.mode === 'turnover') {
      el.dataset.mode = '';
      sceneKey = ''; // ほかの場面に戻ったときに作り直す
    }
  }

  // ---------- Extra Round 1st step (問題と解答の表示) ----------
  // 何もない → 1問目の問題 → 1問目の問題+解答 → 2問目の問題 → … と、運営パネルの▶で切り替わる。
  // scene.data = null (何もない。見出し (タイトルと水色の線) だけ出す) か { n, total, question, answer, showAnswer }。
  // 問題が替わったときだけ問題を出し直し、解答は、同じ問題のまま showAnswer になったときに静かに現れる。

  let rvKey = null; // 今出している問題 (n と問題文)
  let rvAnswerKey = null;

  /** 文字を、枠 (box) の高さに収まる最大の大きさにする。maxVh = 最大の大きさ (vh)、minVh = これ以下には小さくしない */
  function fitTextInBox(el, box, maxVh, minVh) {
    const vh = window.innerHeight / 100;
    let size = maxVh * vh;
    const min = minVh * vh;
    el.style.fontSize = size + 'px';
    while (size > min && (el.scrollHeight > box.clientHeight + 1 || el.scrollWidth > box.clientWidth + 1)) {
      size -= 2;
      el.style.fontSize = size + 'px';
    }
  }

  function fitRevival(el) {
    const qBox = el.querySelector('.rv-q');
    const aBox = el.querySelector('.rv-a');
    if (!qBox || !aBox) return;
    fitTextInBox(el.querySelector('.rv-qtext'), qBox, 9, 3);
    fitTextInBox(el.querySelector('.rv-atext'), aBox, 8, 3);
  }
  window.addEventListener('resize', () => {
    const el = $('scene');
    if (!el.hidden && el.dataset.mode === 'revival') fitRevival(el);
  });

  function renderRevival(st, el) {
    const d = st.scene.data;
    if (el.dataset.mode !== 'revival') {
      el.className = 'scene scene-revival';
      el.dataset.mode = 'revival';
      el.innerHTML =
        '<div class="rv-stage">' +
        '<div class="rv-head"><span class="rv-title">Extra Round 1st step</span><span class="rv-no"></span></div>' +
        '<div class="rv-q"><p class="rv-qtext"></p></div>' +
        '<div class="rv-a"><span class="rv-tag">A</span><p class="rv-atext"></p></div>' +
        '</div>';
      rvKey = null;
      rvAnswerKey = null;
    }
    const stage = el.querySelector('.rv-stage');
    if (!d) {
      // 最初の問題を出す前: 見出し (タイトルと水色の線) だけ出して、問題と解答の場所は空けておく
      stage.classList.add('on', 'blank');
      stage.classList.remove('show-a');
      stage.querySelector('.rv-no').textContent = '';
      rvKey = null;
      rvAnswerKey = null;
      return;
    }
    stage.classList.remove('blank');
    const qKey = d.n + '|' + d.question;
    const aKey = d.n + '|' + d.answer;
    if (qKey !== rvKey) {
      // 新しい問題: 問題を出し直す (解答は隠す)
      rvKey = qKey;
      stage.classList.remove('show-a');
      stage.querySelector('.rv-no').textContent = 'Q.' + d.n;
      stage.querySelector('.rv-qtext').textContent = d.question;
      const q = stage.querySelector('.rv-q');
      q.classList.remove('in');
      void q.offsetWidth; // アニメーションを再始動させる
      q.classList.add('in');
    }
    if (aKey !== rvAnswerKey) {
      rvAnswerKey = aKey;
      stage.querySelector('.rv-atext').textContent = d.answer;
    }
    stage.classList.add('on');
    fitRevival(el);
    stage.classList.toggle('show-a', !!d.showAnswer);
  }

  function leaveRevival(el) {
    if (el.dataset.mode === 'revival') {
      el.dataset.mode = '';
      sceneKey = ''; // ほかの場面に戻ったときに作り直す
    }
    rvKey = null;
    rvAnswerKey = null;
  }

  function renderScene(st) {
    const sc = st.scene || { type: 'board' };
    const el = $('scene');
    const on = sc.type !== 'board'; // 観客用の埋め込み (EMBED) でも、スクリーンと同じ場面を出す
    el.hidden = !on;
    if (!on || sc.type !== 'roulette') resetRoulette();
    const isTurnover = sc.type === 'turnover' || sc.type === 'turnover49'; // 49位のターンオーバーも、同じカードの描画を使う
    if (!on || !isTurnover) leaveTurnover(el);
    if (!on || sc.type !== 'revival1') leaveRevival(el);
    if (!on) {
      sceneKey = '';
      return;
    }
    if (isTurnover) {
      renderTurnover(st, el);
      return;
    }
    if (sc.type === 'revival1') {
      renderRevival(st, el);
      return;
    }
    if (sc.type === 'roulette') updateReelState(sc.data);
    // 内容が変わったときだけ作り直す (大型タイマーの時計は renderTimer が更新する)
    const key = JSON.stringify([sc.type, sc.step, sc.title, st.settings.title, sc.data, reelAnimating]);
    if (key === sceneKey) return;
    sceneKey = key;
    el.className = 'scene scene-' + sc.type;
    el.innerHTML = sceneHTML(st);
    fitNames(el);
    // スロットの演出中に作り直された場合も、続きから回す
    if (sc.type === 'roulette') {
      reelJustLanded = false;
      if (reelAnimating !== null && sc.data && sc.data.spin) runReel();
    }
  }

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
      // SF: 試合中は、ポイントを「？」と表示する (集計後に、運営が発表する)
      const hideScore = st.settings.rule === 'timerace' && st.scoreHidden && p.status === 'active'; // 前のセットで決まった人 (n番目 / 失格) の表示は、そのまま出す
      const score = hideScore ? '？' : p.status === 'win' ? QB.ordinal(p.rank) : String(QB.score(st, p));
      scoreEl.textContent = score;
      scoreEl.style.setProperty('--digits', Math.max(2, score.length + (p.status === 'win' ? 1 : 0)));

      // 決勝: 獲得セット数を ●(獲得) ○(未獲得) で出す
      const pips = col.querySelector('.set-pips');
      const nSets = st.settings.sets | 0;
      pips.textContent = nSets > 0 ? '●'.repeat(Math.min(nSets, p.setsWon | 0)) + '○'.repeat(Math.max(0, nSets - (p.setsWon | 0))) : '';
      const penEl = col.querySelector('.penalty-display');
      penEl.classList.toggle('swedish', st.settings.rule === 'swedish10');
      penEl.classList.toggle('formula', st.settings.rule === 'nbyn');
      penEl.innerHTML = penaltyHTML(st, p);
      // 横幅に収まる最大のバツの大きさを決めるため、並ぶバツの数を渡す
      penEl.style.setProperty('--xn', Math.max(3, penEl.querySelectorAll('.x').length));
    });

    curTimerState = st;
    renderScene(st);
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
