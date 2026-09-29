/*
 * 効果音: sounds/<name>.mp3 があれば Howler.js で再生し、
 * 無ければ (または Howler が読み込めなければ) Web Audio の合成音で代用する。
 */
(function (global) {
  'use strict';

  const NAMES = ['correct', 'wrong', 'win', 'lose', 'question', 'reveal', 'through'];
  const howls = {};
  const missing = new Set();
  let ctx = null;
  let enabled = true;

  function init() {
    if (typeof global.Howl === 'undefined') {
      NAMES.forEach((n) => missing.add(n));
      return;
    }
    NAMES.forEach((name) => {
      howls[name] = new global.Howl({
        src: ['sounds/' + name + '.mp3'],
        html5: true, // file:// で開いても再生できるように <audio> を使う
        preload: true,
        onloaderror: () => missing.add(name),
      });
    });
  }

  function audioCtx() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 合成音の定義: [周波数Hz, 開始秒, 長さ秒, 波形]
  const SYNTH = {
    correct: [[1319, 0, 0.18, 'square'], [1047, 0.18, 0.45, 'square']],
    wrong: [[140, 0, 0.7, 'sawtooth']],
    win: [[523, 0, 0.14, 'square'], [659, 0.14, 0.14, 'square'], [784, 0.28, 0.14, 'square'], [1047, 0.42, 0.6, 'square']],
    lose: [[392, 0, 0.3, 'sawtooth'], [330, 0.3, 0.3, 'sawtooth'], [262, 0.6, 0.7, 'sawtooth']],
    question: [[880, 0, 0.12, 'sine'], [1175, 0.12, 0.2, 'sine']],
    reveal: [[784, 0, 0.15, 'triangle'], [988, 0.15, 0.15, 'triangle'], [1175, 0.3, 0.4, 'triangle']],
    through: [[440, 0, 0.25, 'triangle'], [330, 0.25, 0.4, 'triangle']],
  };

  function synth(name) {
    const ac = audioCtx();
    const notes = SYNTH[name];
    if (!ac || !notes) return;
    const t0 = ac.currentTime + 0.01;
    notes.forEach(([freq, start, dur, type]) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    });
  }

  function play(name) {
    if (!enabled) return;
    const howl = howls[name];
    if (howl && !missing.has(name)) {
      howl.stop();
      howl.play();
    } else {
      synth(name);
    }
  }

  global.Sound = {
    init,
    play,
    setEnabled(v) {
      enabled = !!v;
    },
    /** 読み込めた音声ファイル名の一覧 (設定画面の表示用) */
    loadedFiles() {
      return NAMES.filter((n) => howls[n] && !missing.has(n) && howls[n].state() === 'loaded');
    },
    NAMES,
  };
})(window);
