'use strict';

// ---------- constants ----------
const W = 960, H = 540;
const GROUND = 455;
const SECTION_LEN = 2600;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const WHEEL_R = 9;
const WHEEL_OFF = [-22, 0, 22];
const GRAVITY = 1300, JUMP_V = 560;
const SPEED = { slow: 95, normal: 150, fast: 240 };
const SCREEN_X = { slow: 140, normal: 210, fast: 320 };
const FONT = '"Press Start 2P", monospace';
const STEP = 1 / 60;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let viewSX = 1, viewSY = 1;

const isTouch = window.matchMedia('(pointer: coarse)').matches;
const TOUCH_GUTTER = 64 + 20; // button width + padding; see #touch in style.css

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // on touch screens in landscape, keep the side gutters free for the buttons
  const landscapeTouch = isTouch && window.innerWidth > window.innerHeight;
  const availW = window.innerWidth - (landscapeTouch ? 2 * TOUCH_GUTTER : 0);
  const scale = Math.min(availW / W, window.innerHeight / H);
  const cssW = Math.floor(W * scale), cssH = Math.floor(H * scale);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  viewSX = canvas.width / W;
  viewSY = canvas.height / H;
}
window.addEventListener('resize', resize);
resize();
document.fonts?.load(`16px ${FONT}`);

// ---------- utils ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash(i, seed) {
  let h = Math.imul((i | 0) ^ Math.imul(seed, 0x9E3779B1), 0x27d4eb2d);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function noiseLin(x, seed) {
  const i = Math.floor(x), f = x - i;
  return hash(i, seed) * (1 - f) + hash(i + 1, seed) * f;
}
function noiseSmooth(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const approach = (v, t, d) => v < t ? Math.min(t, v + d) : Math.max(t, v - d);

function loadHi() { try { return +localStorage.getItem('craterPatrolHi') || 0; } catch { return 0; } }
function saveHi(v) { try { localStorage.setItem('craterPatrolHi', String(v)); } catch { /* ignore */ } }

// ---------- audio ----------
// Chiptune song: NES-style channels (pulse lead + echo, pulse arpeggio, triangle bass, noise drums).
// Lead bars are written in 8th notes: a note name, '-' to hold the previous note, '.' for a rest.
const MUSIC_STEP = 60 / 140 / 4; // one 16th note at 140 BPM
const CHORDS = {
  Am: { root: 45, arp: [69, 72, 76] },
  F: { root: 41, arp: [65, 69, 72] },
  C: { root: 48, arp: [64, 67, 72] },
  G: { root: 43, arp: [62, 67, 71] },
  Dm: { root: 38, arp: [62, 65, 69] },
  E: { root: 40, arp: [64, 68, 71] },
};
const SONG_SECTIONS = {
  intro: { chords: ['Am', 'F', 'C', 'G'], intro: true },
  A: {
    chords: ['Am', 'F', 'C', 'G'],
    lead: ['E5 - A5 - G5 E5 D5 E5', 'C5 - A4 - C5 D5 E5 -', 'G5 - E5 - C5 - D5 E5', 'D5 - B4 - G4 - . .'],
  },
  A2: {
    chords: ['Am', 'F', 'C', 'G'],
    lead: ['E5 - A5 - G5 E5 D5 E5', 'C5 - A4 - C5 D5 E5 -', 'G5 - A5 G5 E5 - C5 D5', 'B4 - D5 - G5 - - -'],
  },
  B: {
    chords: ['Dm', 'Am', 'F', 'E'],
    lead: ['F5 - - E5 D5 - A4 -', 'C5 - - B4 A4 - E4 -', 'F4 - A4 - C5 - F5 -', 'E5 - - - G#5 - B5 -'],
  },
  B2: {
    chords: ['Dm', 'Am', 'F', 'E'],
    lead: ['A5 - - G5 F5 - D5 -', 'E5 - - D5 C5 - A4 -', 'C5 - D5 - E5 - F5 -', 'G#5 - - - B5 - - -'],
  },
};
const SONG_ORDER = ['intro', 'A', 'A2', 'B', 'B2'];
const SONG_LOOP = 1; // after the last section, jump back to 'A'

function noteToMidi(name) {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  return 12 * (+m[3] + 1) + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0);
}

// Turns a section into a list of { step, ch, midi, len } events (steps are 16th notes).
function compileSection(sec) {
  const ev = [];
  const bars = sec.chords.length;
  sec.chords.forEach((name, bar) => {
    const c = CHORDS[name], s0 = bar * 16, last = bar === bars - 1;
    // triangle bass: octave-jumping 8ths
    [0, 12, 0, 12, 0, 12, 7, 12].forEach((o, i) => ev.push({ step: s0 + i * 2, ch: 'bass', midi: c.root + o, len: 2 }));
    // pulse arpeggio over the chord
    if (!sec.intro) for (let i = 0; i < 16; i++) ev.push({ step: s0 + i, ch: 'arp', midi: c.arp[i % 3], len: 1 });
    // noise drums
    for (let i = 0; i < 16; i++) {
      const s = s0 + i;
      if (i === 0 || i === 8 || (i === 10 && bar % 2 === 1)) ev.push({ step: s, ch: 'kick' });
      const snareOn = !sec.intro || bar >= 2;
      if (snareOn && (i === 4 || i === 12)) ev.push({ step: s, ch: 'snare' });
      else if (snareOn && last && i >= 13) ev.push({ step: s, ch: 'snare', soft: true });
      else if (i % 2 === 0) ev.push({ step: s, ch: 'hat', open: i === 14 && !last });
    }
  });
  if (sec.lead) {
    sec.lead.forEach((barStr, bar) => {
      let cur = null;
      barStr.split(' ').forEach((tok, i) => {
        const step = bar * 16 + i * 2;
        if (tok === '-') { if (cur) cur.len += 2; return; }
        cur = null;
        if (tok === '.') return;
        cur = { step, ch: 'lead', midi: noteToMidi(tok), len: 2 };
        ev.push(cur);
      });
    });
  }
  ev.sort((a, b) => a.step - b.step);
  return { events: ev, length: bars * 16 };
}
const SONG = SONG_ORDER.map(name => compileSection(SONG_SECTIONS[name]));
const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);

const sfx = {
  ctx: null, master: null, music: null, noiseBuf: null, muted: false,
  pulse12: null, pulse25: null, nextNote: 0, songPos: 0, songStep: 0, songEv: 0,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    // gentle lowpass takes the harsh edge off the pulse waves without losing the chip sound
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 7000;
    lp.connect(this.master);
    this.music = this.ctx.createGain();
    this.music.gain.value = 0.55;
    this.music.connect(lp);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, len);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.pulse12 = this.pulseWave(0.125);
    this.pulse25 = this.pulseWave(0.25);
  },
  // band-limited pulse wave with the given duty cycle, like the NES pulse channels
  pulseWave(duty) {
    const n = 40, real = new Float32Array(n), imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = 2 * Math.sin(k * Math.PI * duty) / (k * Math.PI);
    return this.ctx.createPeriodicWave(real, imag);
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
  },
  tone(freq, dur, { type = 'square', vol = 0.15, slide = null, dest = null, at = null } = {}) {
    if (!this.ctx) return;
    const t = at ?? this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(dest || this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, { vol = 0.3, freq = 1200, slide = 200 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noiseBuf;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur);
  },
  shoot() { this.tone(880, 0.08, { vol: 0.05, slide: 440 }); },
  upShot() { this.tone(1200, 0.1, { type: 'triangle', vol: 0.06, slide: 1900 }); },
  jump() { this.tone(220, 0.25, { type: 'triangle', vol: 0.12, slide: 540 }); },
  boom(big) { this.noise(big ? 1.1 : 0.4, { vol: big ? 0.6 : 0.3, freq: big ? 1600 : 2600, slide: 70 }); },
  bigBoom() {
    if (!this.ctx) return;
    this.noise(1.6, { vol: 0.7, freq: 2200, slide: 50 });
    this.tone(90, 0.9, { type: 'sawtooth', vol: 0.18, slide: 28 });
    setTimeout(() => this.noise(0.6, { vol: 0.35, freq: 1200, slide: 60 }), 220);
  },
  thud() { this.tone(130, 0.08, { type: 'triangle', vol: 0.1, slide: 50 }); },
  ufoDie() { this.tone(700, 0.3, { type: 'sawtooth', vol: 0.07, slide: 60 }); this.noise(0.3, { vol: 0.2 }); },
  bombDrop() { this.tone(1500, 0.5, { type: 'sine', vol: 0.035, slide: 300 }); },
  tankFire() { this.tone(200, 0.15, { vol: 0.08, slide: 80 }); this.noise(0.12, { vol: 0.15, freq: 3000, slide: 400 }); },
  dive() { this.tone(1900, 0.9, { type: 'sine', vol: 0.05, slide: 350 }); },
  oneUp() {
    if (!this.ctx) return;
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.12, { vol: 0.07, at: this.ctx.currentTime + i * 0.07 }));
  },
  // triumphant A-major fanfare for finishing the course (steps are 0.13s)
  fanfare() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + 0.05, q = 0.13;
    const at = s => t0 + s * q;
    const lead = [[69, 0, 1], [73, 1, 1], [76, 2, 1], [81, 3, 4], [79, 7, 1], [79, 8, 1], [79, 9, 1], [81, 10, 12]];
    const harmony = [[73, 3, 4], [76, 3, 4], [71, 7, 3], [74, 7, 3], [73, 10, 12], [76, 10, 12]];
    const bass = [[45, 0, 3], [45, 3, 4], [43, 7, 3], [33, 10, 12]];
    for (const [m, s, l] of lead) this.voice(m, at(s), l * q * 0.95, 0.2, this.pulse25, true);
    for (const [m, s, l] of harmony) this.voice(m, at(s), l * q * 0.95, 0.06, this.pulse12, false);
    for (const [m, s, l] of bass) this.voice(m, at(s), l * q * 0.95, 0.35, 'triangle', false);
    for (const s of [7, 8, 9, 9.5]) this.drum('snare', at(s), { soft: s !== 9.5 });
    this.drum('kick', at(10));
    this.drum('snare', at(10));
    this.drum('hat', at(10), { open: true });
  },
  checkpoint() {
    if (!this.ctx) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, { vol: 0.08, at: this.ctx.currentTime + i * 0.09 }));
  },
  // ----- music instruments -----
  voice(midi, t, dur, vol, wave, vibrato) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    if (typeof wave === 'string') o.type = wave; else o.setPeriodicWave(wave);
    o.frequency.setValueAtTime(midiFreq(midi), t);
    if (vibrato && dur > 0.25) {
      const lfo = this.ctx.createOscillator(), lg = this.ctx.createGain();
      lfo.frequency.value = 6;
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(12, t + 0.25); // cents
      lfo.connect(lg); lg.connect(o.detune);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    }
    const end = t + dur;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.linearRampToValueAtTime(vol * 0.7, t + Math.min(0.12, dur * 0.5));
    g.gain.setValueAtTime(vol * 0.7, Math.max(t + 0.01, end - 0.03));
    g.gain.linearRampToValueAtTime(0, end);
    o.connect(g); g.connect(this.music);
    o.start(t); o.stop(end + 0.02);
  },
  drum(kind, t, opts = {}) {
    const ctx = this.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g); g.connect(this.music);
      o.start(t); o.stop(t + 0.16);
      return;
    }
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = kind === 'snare' ? 0.7 : 1; // lower rate = grittier, more "NES" noise
    let dur, vol;
    if (kind === 'snare') {
      f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 0.8;
      dur = opts.soft ? 0.07 : 0.13; vol = opts.soft ? 0.18 : 0.32;
    } else {
      f.type = 'highpass'; f.frequency.value = 7000;
      dur = opts.open ? 0.12 : 0.035; vol = 0.09;
    }
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.music);
    s.start(t, Math.random() * 0.5); s.stop(t + dur);
  },
  playEvent(e, t) {
    switch (e.ch) {
      case 'lead': {
        const dur = e.len * MUSIC_STEP * 0.92;
        this.voice(e.midi, t, dur, 0.16, this.pulse25, true);
        // NES-style echo: same note a dotted 8th later, quieter and thinner
        this.voice(e.midi, t + 3 * MUSIC_STEP, dur, 0.05, this.pulse12, false);
        break;
      }
      case 'arp': this.voice(e.midi, t, MUSIC_STEP * 0.8, 0.045, this.pulse12, false); break;
      case 'bass': this.voice(e.midi, t, e.len * MUSIC_STEP * 0.85, 0.32, 'triangle', false); break;
      default: this.drum(e.ch, t, e);
    }
  },
  resetMusic() {
    this.songPos = 0;
    this.songStep = 0;
    this.songEv = 0;
    this.nextNote = 0;
  },
  updateMusic(playing) {
    if (!this.ctx || !playing) { this.nextNote = 0; return; }
    const now = this.ctx.currentTime;
    if (this.nextNote < now) this.nextNote = now + 0.05;
    while (this.nextNote < now + 0.12) {
      const sec = SONG[this.songPos];
      while (this.songEv < sec.events.length && sec.events[this.songEv].step === this.songStep) {
        this.playEvent(sec.events[this.songEv++], this.nextNote);
      }
      this.nextNote += MUSIC_STEP;
      if (++this.songStep >= sec.length) {
        this.songStep = 0;
        this.songEv = 0;
        this.songPos = this.songPos + 1 < SONG.length ? this.songPos + 1 : SONG_LOOP;
      }
    }
  },
};

// ---------- input ----------
const keys = new Set();
const pressed = new Set();
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump',
  Space: 'fire', KeyZ: 'fire',
  Enter: 'start',
  KeyP: 'pause', Escape: 'pause',
  KeyM: 'mute',
  KeyC: 'coin', // secret: insert coin for 3 extra lives
};
window.addEventListener('keydown', e => {
  const a = KEYMAP[e.code];
  if (!a) return;
  e.preventDefault();
  sfx.init();
  if (!e.repeat) pressed.add(a);
  keys.add(a);
});
window.addEventListener('keyup', e => {
  const a = KEYMAP[e.code];
  if (a) keys.delete(a);
});
window.addEventListener('blur', () => {
  keys.clear();
  if (game.state === 'playing') game.paused = true;
});
document.querySelectorAll('#touch button').forEach(btn => {
  const a = btn.dataset.action;
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    sfx.init();
    keys.add(a); pressed.add(a);
    btn.classList.add('on');
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    btn.addEventListener(ev, () => { keys.delete(a); btn.classList.remove('on'); });
  }
});
canvas.addEventListener('pointerdown', () => { sfx.init(); pressed.add('start'); });

// ---------- state ----------
const game = {
  state: 'title', paused: false,
  score: 0, hi: loadHi(), lives: 3, nextLife: 10000, newHi: false,
  camX: 0, speed: 0, section: 0, sectionTime: 0, genUpTo: 0,
  shake: 0, banner: null, dieT: 0, stateT: 0, waveTimer: 0, dustT: 0,
};
const player = {
  sx: SCREEN_X.normal, h: 0, vy: 0, grounded: true, alive: true, visible: true,
  exploded: false, deathType: null, wheelY: [0, 0, 0], spin: 0, bob: 0, fireCd: 0, jumpBuf: 0,
};
let obstacles = [], ufos = [], bombs = [], shells = [], fwdShots = [], upShots = [], particles = [], texts = [], debris = [];

// banner hint the first time a new enemy shows up (keyed by checkpoint index)
const ENEMY_INTRO = {
  3: 'NEW: LAND MINES - JUMP OVER THEM',
  4: 'NEW: DIVER UFOS AIM THEIR BOMBS',
  6: 'NEW: TANKS - SHOOT THEM OR THEIR SHELLS',
  9: 'NEW: SEEKERS DIVE AT YOU - SHOOT FAST',
  12: 'NEW: BOUNCING BOULDERS',
};

const stars = Array.from({ length: 140 }, () => ({
  x: Math.random() * W, y: Math.random() * 330, b: Math.random(), tw: Math.random() * 6,
}));

const difficulty = () => Math.min(1.3, game.section / 20);
const worldX = () => game.camX + player.sx;

function chassisY() {
  const p = player;
  const avg = (p.wheelY[0] + p.wheelY[1] + p.wheelY[2]) / 3;
  return GROUND - p.h - 2 * WHEEL_R - 1 + avg * 0.6 + (p.grounded ? Math.sin(p.bob) * 0.7 : 0);
}

// ---------- level generation ----------
function genSection(s) {
  const rng = mulberry32(1234 + s * 7919);
  const d = Math.min(1.3, s / 20), dc = Math.min(d, 1);
  const end = (s + 1) * SECTION_LEN;
  let x = s * SECTION_LEN + (s === 0 ? 700 : 450);
  const rock = (x, big) => obstacles.push(big
    ? { type: 'rock', x, w: 36, h: 32, hp: 2, maxHp: 2, points: 200, passed: false }
    : { type: 'rock', x, w: 24, h: 22, hp: 1, maxHp: 1, points: 100, passed: false });
  const crater = (x, w) => obstacles.push({ type: 'crater', x, w, passed: false });
  const mine = x => obstacles.push({ type: 'mine', x, w: 16, h: 8, passed: false });

  // weighted menu of obstacle patterns; new enemy types unlock at later checkpoints
  const menu = [['crater', 4.2], ['rock', 2.8], ['combo', 1.5]];
  if (s >= 2) menu.push(['bigRock', 1.5]);
  if (s >= 3) menu.push(['mine', 1.8]);
  if (s >= 6) menu.push(['tank', 1.3]);
  if (s >= 8) menu.push(['mines', 1.0]);
  if (s >= 12) menu.push(['boulder', 1.5]);
  const total = menu.reduce((a, m) => a + m[1], 0);
  // the checkpoint that introduces a ground enemy always opens with it
  let forced = { 3: 'mine', 6: 'tank', 12: 'boulder' }[s];

  while (x < end - 300) {
    let r = rng() * total, kind = menu[0][0];
    for (const [k, wt] of menu) { if ((r -= wt) < 0) { kind = k; break; } }
    if (forced) { kind = forced; forced = null; }
    switch (kind) {
      case 'crater': {
        const w = 34 + rng() * (24 + 40 * d);
        crater(x, w); x += w;
        break;
      }
      case 'rock': rock(x, false); x += 24; break;
      case 'bigRock': rock(x, true); x += 36; break;
      case 'combo': {
        const w = 34 + rng() * 20;
        crater(x, w);
        x += w + 150 + rng() * 50;
        const big = s >= 3 && rng() < 0.4;
        rock(x, big); x += big ? 36 : 24;
        break;
      }
      case 'mine': mine(x); x += 16; break;
      case 'mines': mine(x); x += 70 + rng() * 30; mine(x); x += 16; break;
      case 'tank':
        x += 80;
        obstacles.push({ type: 'tank', x, w: 44, h: 24, hp: 2, maxHp: 2, points: 300, fireT: 0.6 + rng(), flash: 0, passed: false });
        x += 44 + 150;
        break;
      case 'boulder':
        x += 300; // it rolls toward you, so give it room
        obstacles.push({ type: 'boulder', x, w: 26, h: 26, hp: 1, maxHp: 1, points: 150, phase: rng() * 3, spin: 0, lift: 0, passed: false });
        x += 26;
        break;
    }
    x += (440 - 180 * dc) + rng() * (260 - 100 * dc);
  }
}

// moving / shooting ground enemies
function updateObstacles(dt) {
  const d = difficulty();
  for (const o of obstacles) {
    if (o.dead) continue;
    const sx = o.x - game.camX;
    if (o.type === 'boulder' && sx < W + 40) {
      o.x -= 90 * dt;
      o.phase += dt * 4.5;
      o.spin -= dt * 7;
      o.lift = Math.abs(Math.sin(o.phase)) * 22;
    } else if (o.type === 'tank') {
      o.flash = Math.max(0, o.flash - dt);
      if (player.alive && sx < W - 20 && sx > player.sx + 120) {
        o.fireT -= dt;
        if (o.fireT <= 0) {
          shells.push({ x: o.x, y: GROUND - 18 });
          o.fireT = rand(1.6, 2.6) - d * 0.4;
          o.flash = 0.12;
          sfx.tankFire();
        }
      }
      if (o.hp < o.maxHp && Math.random() < dt * 8) {
        particles.push({ x: o.x + 24, y: GROUND - 26, vx: rand(-10, 10), vy: rand(-40, -20), life: 0.8, max: 0.8, g: -10, world: true, size: rand(3, 5), color: '#555' });
      }
    }
  }
}

function updateShells(dt) {
  const p = player, wx = worldX(), cy = chassisY();
  for (const s of shells) {
    s.x -= 260 * dt;
    if (s.x < game.camX - 50) s.dead = true;
    if (p.alive && s.x > wx - 30 && s.x < wx + 36 && s.y > cy - 26 && s.y < GROUND - p.h + 2) {
      s.dead = true;
      killPlayer('crash');
    }
  }
  shells = shells.filter(s => !s.dead);
}

// a bomb or crashing seeker hits the ground; may leave a new crater ahead of the buggy
function groundBlast(wx) {
  explosion(wx, GROUND - 4, { n: 16, colors: ['#ffd23c', '#ff7a2f', '#c9a274'], spd: 160, world: true, life: 0.6 });
  sfx.boom(false);
  game.shake = Math.max(game.shake, 3);
  const clear = !obstacles.some(o => Math.abs(o.x + o.w / 2 - wx) < o.w / 2 + 44);
  if (player.alive && Math.random() < 0.6 && wx > worldX() + 70 && clear) {
    obstacles.push({ type: 'crater', x: wx - 14, w: 28, bomb: true, passed: false });
  }
}

function ensureTerrain() {
  while (game.genUpTo * SECTION_LEN < game.camX + W + 600) genSection(game.genUpTo++);
  obstacles = obstacles.filter(o => !o.dead && o.x + o.w > game.camX - 150);
}

// ---------- game flow ----------
function newGame() {
  sfx.init();
  sfx.resetMusic();
  game.score = 0;
  game.lives = 3;
  game.nextLife = 10000;
  game.newHi = false;
  startSection(0);
}

function startSection(s) {
  const p = player;
  game.section = s;
  game.sectionTime = 0;
  obstacles = []; ufos = []; bombs = []; shells = []; fwdShots = []; upShots = []; debris = [];
  Object.assign(p, {
    sx: SCREEN_X.normal, h: 0, vy: 0, grounded: true, alive: true, visible: true,
    exploded: false, deathType: null, wheelY: [0, 0, 0], fireCd: 0.3, jumpBuf: 0,
  });
  game.camX = s * SECTION_LEN + 40 - p.sx;
  game.speed = SPEED.normal;
  game.genUpTo = s;
  ensureTerrain();
  game.waveTimer = 3;
  game.state = 'playing';
  game.paused = false;
  game.banner = { text: s === 0 ? 'GET READY' : `POINT ${LETTERS[s % 26]}`, sub: '', t: 1.8 };
}

function gameOver() {
  game.state = 'gameover';
  game.stateT = 0;
  if (game.score > game.hi) {
    game.hi = game.score;
    game.newHi = true;
    saveHi(game.hi);
  }
}

function addScore(n, x, y, color = '#fff') {
  if (!player.alive) return;
  game.score += n;
  if (x !== undefined) texts.push({ x, y, str: String(n), t: 1, color });
  if (game.score >= game.nextLife) {
    game.nextLife += 10000;
    game.lives++;
    texts.push({ x: player.sx, y: chassisY() - 50, str: '1UP', t: 1.5, color: '#7fff7f' });
    sfx.oneUp();
  }
}

function reachedCheckpoint(sec) {
  const letter = LETTERS[sec % 26];
  const par = SECTION_LEN / 165;
  const t = game.sectionTime;
  let bonus = 100 + Math.max(0, Math.round(par - t)) * 50;
  game.sectionTime = 0;
  if (sec % 26 === 0) {
    // finished Z: stop the road for a big "mission accomplished" moment
    bonus += 5000;
    addScore(bonus);
    game.state = 'victory';
    game.stateT = 0;
    game.fireworkT = 0;
    game.victoryBonus = bonus;
    game.banner = null;
    for (const u of ufos) u.life = 0;
    bombs = [];
    shells = [];
    sfx.fanfare();
    return;
  }
  addScore(bonus);
  const note = ENEMY_INTRO[sec] || '';
  game.banner = { text: `POINT ${letter}`, sub: `TIME ${t.toFixed(1)}s  BONUS ${bonus}`, note, t: note ? 3.5 : 2.5 };
  sfx.checkpoint();
}

const VICTORY_TIME = 3.5;

function updateVictory(dt) {
  const p = player;
  game.stateT += dt;
  game.speed = approach(game.speed, 0, 300 * dt);
  game.camX += game.speed * dt;
  if (!p.grounded) { // finish a jump that was in progress
    p.vy -= GRAVITY * dt;
    p.h += p.vy * dt;
    if (p.h <= 0) { p.h = 0; p.vy = 0; p.grounded = true; }
  }
  animateBuggy(dt);
  updateShots(dt);
  updateUfos(dt, false);

  game.fireworkT -= dt;
  if (game.fireworkT <= 0 && game.stateT < VICTORY_TIME - 0.6) {
    game.fireworkT = rand(0.2, 0.4);
    const palette = [['#ff4d6d', '#ffd23c'], ['#7fff7f', '#fff'], ['#9ff', '#b84dff'], ['#ffd23c', '#ff7a2f']][(Math.random() * 4) | 0];
    explosion(rand(80, W - 80), rand(60, 260), { n: 36, colors: [...palette, '#fff'], spd: 170, life: 1.2, size: 3, g: 60 });
    sfx.tone(rand(150, 260), 0.25, { type: 'triangle', vol: 0.05, slide: 60 });
  }

  if (game.stateT >= VICTORY_TIME) {
    game.state = 'playing';
    game.sectionTime = 0;
    sfx.resetMusic();
    const round = Math.floor(game.section / 26) + 1;
    game.banner = { text: 'POINT A', sub: `ROUND ${round} - HARDER!`, note: '', t: 2.5 };
  }
}

function killPlayer(type) {
  const p = player;
  if (!p.alive) return;
  p.alive = false;
  p.deathType = type;
  game.state = 'dying';
  game.dieT = 0;
  game.speed = 0;
  for (const u of ufos) u.life = 0;
  if (type === 'crash') explodePlayer();
}

function explodePlayer() {
  const p = player;
  p.exploded = true;
  p.visible = false;
  const cx = worldX(), cy = chassisY() - 8;
  game.flash = 0.18;
  game.shake = 16;
  sfx.bigBoom();

  // fireball: glowing flames that grow and rise
  for (let i = 0; i < 46; i++) {
    particles.push({
      kind: 'flame', world: true, x: cx + rand(-22, 22), y: cy + rand(-12, 8),
      vx: rand(-140, 140), vy: rand(-240, -30), g: -90, drag: 2,
      life: rand(0.45, 1.0), max: 1.0, size: rand(7, 15), grow: 22,
    });
  }
  // sparks
  explosion(cx, cy, { n: 30, colors: ['#fff', '#ffd23c', '#ff9a3c'], spd: 340, life: 0.7, size: 2.5, g: 500, world: true });
  // smoke clouds
  for (let i = 0; i < 18; i++) {
    particles.push({
      kind: 'smoke', world: true, x: cx + rand(-26, 26), y: cy + rand(-16, 6),
      vx: rand(-40, 40), vy: rand(-90, -30), g: -15, drag: 1,
      life: rand(1.4, 2.4), max: 2.4, size: rand(9, 16), grow: 18,
    });
  }

  // wreckage: wheels fly off and bounce, the body is flung up and keeps burning
  const wheelDir = [-1, 0.35, 1];
  for (let i = 0; i < 3; i++) {
    debris.push({
      kind: 'wheel', x: cx + WHEEL_OFF[i], y: GROUND - WHEEL_R - p.h + p.wheelY[i],
      vx: wheelDir[i] * rand(200, 320), vy: rand(-560, -380), rot: p.spin, vr: rand(-18, 18), r: WHEEL_R, t: 0,
    });
  }
  debris.push({ kind: 'body', x: cx, y: cy, vx: rand(-50, 50), vy: rand(-330, -260), rot: 0, vr: rand(-5, 5), r: 6, t: 0 });
  for (let i = 0; i < 5; i++) {
    debris.push({
      kind: 'chunk', x: cx + rand(-20, 20), y: cy, vx: rand(-280, 280), vy: rand(-480, -200),
      rot: rand(0, 6), vr: rand(-20, 20), r: 3, w: rand(4, 9), h: rand(3, 6), t: 0,
      color: ['#b84dff', '#6d23a8', '#9aa', '#e6e6e6'][i % 4],
    });
  }
}

function updateDebris(dt) {
  for (const d of debris) {
    d.t += dt;
    d.vy += 900 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    const floor = GROUND - d.r;
    if (d.y >= floor) {
      d.y = floor;
      if (d.vy > 80) {
        // bounce
        if (d.kind === 'wheel' && d.vy > 150) sfx.thud();
        for (let i = 0; i < (d.kind === 'chunk' ? 1 : 4); i++) dust(d.x + rand(-6, 6), 1.2);
        d.vy = -d.vy * (d.kind === 'body' ? 0.3 : 0.55);
        d.vx *= 0.75;
      } else {
        d.vy = 0;
        d.vx *= Math.max(0, 1 - (d.kind === 'wheel' ? 1.2 : 5) * dt);
      }
      if (d.kind === 'wheel') d.vr = d.vx / d.r; // roll along the ground
      else d.vr *= Math.max(0, 1 - 6 * dt);
      if (d.kind === 'body' && d.vy === 0) {
        // settle the wreck flat on its wheels-side
        const flat = Math.round(d.rot / (Math.PI * 2)) * Math.PI * 2;
        d.rot += (flat - d.rot) * Math.min(1, dt * 8);
      }
    }
    d.rot += d.vr * dt;

    // smoke trails while flying, flames on the wreck
    if (d.kind === 'wheel' && d.y < floor - 2 && Math.random() < dt * 30) {
      particles.push({ kind: 'smoke', world: true, x: d.x, y: d.y, vx: 0, vy: -10, g: -10, drag: 1, life: 0.7, max: 0.9, size: 4, grow: 10 });
    }
    if (d.kind === 'body' && Math.random() < dt * 28) {
      particles.push({
        kind: 'flame', world: true, x: d.x + rand(-14, 14), y: d.y - 6, vx: rand(-15, 15), vy: rand(-90, -40),
        g: -40, drag: 1, life: rand(0.3, 0.6), max: 0.6, size: rand(4, 8), grow: 6,
      });
      if (Math.random() < 0.3) {
        particles.push({ kind: 'smoke', world: true, x: d.x + rand(-10, 10), y: d.y - 18, vx: rand(-10, 10), vy: rand(-50, -30), g: -10, drag: 0.5, life: 1.5, max: 1.8, size: 6, grow: 14 });
      }
    }
  }
}

function explosion(x, y, { n = 20, colors = ['#fff', '#ffd23c', '#ff7a2f'], spd = 180, life = 0.7, size = 3, g = 300, world = false } = {}) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = Math.random() * spd;
    particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - spd * 0.3,
      life: life * rand(0.5, 1), max: life, g, world,
      size: size * rand(0.6, 1.2), color: colors[(Math.random() * colors.length) | 0],
    });
  }
}

// ---------- update ----------
function update(dt) {
  if (pressed.has('mute')) sfx.toggleMute();
  if (pressed.has('coin') && (game.state === 'playing' || game.state === 'dying') && !game.paused) {
    game.lives += 3;
    texts.push({ x: W / 2, y: 120, str: '+3 LIVES', t: 1.5, color: '#7fff7f' });
    sfx.oneUp();
  }
  const go = pressed.has('start') || pressed.has('fire') || pressed.has('jump');

  switch (game.state) {
    case 'title':
      game.camX += 60 * dt;
      game.speed = 60;
      animateBuggy(dt);
      if (go) newGame();
      break;
    case 'playing':
      if (pressed.has('pause')) game.paused = !game.paused;
      if (!game.paused) updatePlay(dt);
      break;
    case 'dying':
      updateDying(dt);
      break;
    case 'victory':
      updateVictory(dt);
      break;
    case 'gameover':
      game.stateT += dt;
      updateShots(dt); updateUfos(dt, false); updateBombs(dt); updateObstacles(dt); updateShells(dt);
      if (game.stateT > 1.2 && go) { game.state = 'title'; obstacles = []; ufos = []; bombs = []; shells = []; debris = []; Object.assign(player, { alive: true, visible: true, h: 0, deathType: null, sx: SCREEN_X.normal }); }
      break;
  }

  if (!game.paused) updateEffects(dt);
  sfx.updateMusic(game.state === 'playing' && !game.paused);
  pressed.clear();
}

function updatePlay(dt) {
  const p = player;
  game.sectionTime += dt;

  const mode = keys.has('right') ? 'fast' : keys.has('left') ? 'slow' : 'normal';
  game.speed = approach(game.speed, SPEED[mode], 260 * dt);
  p.sx = approach(p.sx, SCREEN_X[mode], 110 * dt);
  game.camX += game.speed * dt;

  if (pressed.has('jump')) p.jumpBuf = 0.12; else p.jumpBuf -= dt;
  if (p.jumpBuf > 0 && p.grounded) {
    p.vy = JUMP_V; p.grounded = false; p.jumpBuf = 0;
    sfx.jump();
  }
  if (!p.grounded) {
    p.vy -= GRAVITY * dt;
    p.h += p.vy * dt;
    if (p.h <= 0) {
      p.h = 0; p.vy = 0; p.grounded = true;
      for (let i = 0; i < 8; i++) dust(worldX() + rand(-30, 30), 1.4);
    }
  }

  p.fireCd -= dt;
  if (keys.has('fire') && p.fireCd <= 0) fire();

  // dust trail
  game.dustT -= dt;
  if (p.grounded && game.dustT <= 0) {
    game.dustT = 0.06;
    if (Math.random() < game.speed / 260) dust(worldX() - 30, 1);
  }

  animateBuggy(dt);
  ensureTerrain();
  updateObstacles(dt);
  updateShots(dt);
  updateUfos(dt, true);
  updateBombs(dt);
  updateShells(dt);
  checkObstacles();

  const sec = Math.floor(worldX() / SECTION_LEN);
  if (game.state === 'playing' && sec > game.section) {
    game.section = sec;
    reachedCheckpoint(sec);
  }
}

function updateDying(dt) {
  const p = player;
  game.dieT += dt;
  if (p.deathType === 'fall' && !p.exploded) {
    p.h = approach(p.h, -24, 90 * dt);
    if (game.dieT > 0.35) explodePlayer();
  }
  updateShots(dt);
  updateUfos(dt, false);
  updateBombs(dt);
  updateObstacles(dt);
  updateShells(dt);
  if (game.dieT > 3) {
    game.lives--;
    if (game.lives <= 0) gameOver();
    else startSection(game.section);
  }
}

function dust(wx, strength) {
  particles.push({
    x: wx, y: GROUND - 2, vx: rand(-40, 10) * strength, vy: rand(-50, -15) * strength,
    life: rand(0.3, 0.6), max: 0.6, g: 60, world: true, size: rand(2, 4), color: '#c9a274',
  });
}

function animateBuggy(dt) {
  const p = player;
  p.spin += game.speed * dt / WHEEL_R;
  p.bob += dt * 18;
  for (let i = 0; i < 3; i++) {
    const wx = game.camX + p.sx + WHEEL_OFF[i];
    let target;
    if (p.grounded && p.alive) {
      target = -(noiseSmooth(wx / 16, 3) - 0.5) * 4;
      for (const o of obstacles) {
        if (o.type === 'crater' && wx > o.x && wx < o.x + o.w) { target += 5; break; }
      }
    } else {
      target = 5;
    }
    p.wheelY[i] += (target - p.wheelY[i]) * Math.min(1, dt * 25);
  }
}

function fire() {
  const p = player;
  const cy = chassisY();
  let fired = false;
  if (fwdShots.length === 0) {
    fwdShots.push({ x: p.sx + 46, y: cy - 8, dist: 0 });
    sfx.shoot();
    fired = true;
  }
  if (upShots.length < 3) {
    upShots.push({ x: p.sx - 14, y: cy - 34 });
    sfx.upShot();
    fired = true;
  }
  if (fired) p.fireCd = 0.22;
}

function updateShots(dt) {
  for (const s of fwdShots) {
    s.x += 720 * dt;
    s.dist += 720 * dt;
    if (s.dist > 380) s.dead = true;
    for (const o of obstacles) {
      if (!o.hp || o.dead || s.dead) continue; // craters and mines can't be shot
      const rx = o.x - game.camX;
      const bottom = GROUND - (o.lift || 0), top = bottom - o.h;
      if (s.x + 8 >= rx && s.x <= rx + o.w && s.y > top - 22 && s.y < bottom + 4) {
        s.dead = true;
        o.hp--;
        if (o.hp <= 0) {
          o.dead = true;
          const tank = o.type === 'tank';
          const colors = tank ? ['#6b7a3a', '#3b3f2a', '#ffd23c', '#ff7a2f', '#fff'] : ['#9c8370', '#6e5a4a', '#ffd23c', '#fff'];
          explosion(o.x + o.w / 2, bottom - o.h / 2, { n: tank ? 34 : 22, colors, spd: tank ? 260 : 200, world: true, size: 4, g: 500 });
          addScore(o.points, rx + o.w / 2, top - 20);
          if (tank) game.shake = Math.max(game.shake, 6);
          sfx.boom(tank);
        } else {
          explosion(o.x, bottom - o.h / 2, { n: 6, colors: ['#ffd23c', '#fff'], spd: 120, world: true, life: 0.3, size: 2 });
          sfx.tone(300, 0.08, { vol: 0.08, slide: 120 });
        }
      }
    }
    for (const sh of shells) {
      if (sh.dead || s.dead) continue;
      const shx = sh.x - game.camX;
      if (s.x + 12 >= shx - 5 && s.x <= shx + 5 && Math.abs(s.y - sh.y) < 12) {
        s.dead = true;
        sh.dead = true;
        explosion(sh.x, sh.y, { n: 10, colors: ['#ff9a3c', '#fff'], spd: 120, world: true, life: 0.4, size: 2 });
        addScore(50, shx, sh.y - 16, '#ff9a3c');
        sfx.tone(900, 0.1, { vol: 0.06, slide: 200 });
      }
    }
    for (const u of ufos) {
      if (u.dead || s.dead || u.y < GROUND - 80) continue;
      if (Math.abs(s.x - u.x) < 20 && Math.abs(s.y - u.y) < 16) {
        s.dead = true;
        killUfo(u);
      }
    }
  }
  fwdShots = fwdShots.filter(s => !s.dead);

  for (const s of upShots) {
    s.y -= 620 * dt;
    if (s.y < -12) s.dead = true;
    for (const u of ufos) {
      if (u.dead || s.dead) continue;
      if (Math.abs(s.x - u.x) < 20 && Math.abs(s.y - u.y) < 14) {
        s.dead = true;
        killUfo(u);
      }
    }
    for (const b of bombs) {
      if (b.dead || s.dead) continue;
      if (Math.abs(s.x - b.x) < 10 && Math.abs(s.y - b.y) < 12) {
        s.dead = true;
        b.dead = true;
        explosion(b.x, b.y, { n: 10, colors: ['#ffea70', '#fff'], spd: 120, life: 0.4, size: 2 });
        addScore(50, b.x, b.y - 10, '#ffea70');
        sfx.tone(900, 0.1, { vol: 0.06, slide: 200 });
      }
    }
  }
  upShots = upShots.filter(s => !s.dead);
}

const UFO_STYLE = {
  saucer: { points: 100, colors: ['#7cf', '#cff', '#fff'] },
  diver: { points: 200, colors: ['#ff5a3c', '#ffd23c', '#fff'] },
  seeker: { points: 300, colors: ['#5dff7a', '#c8ffb0', '#fff'] },
};

function killUfo(u) {
  const st = UFO_STYLE[u.type];
  u.dead = true;
  explosion(u.x, u.y, { n: 26, colors: st.colors, spd: 220 });
  addScore(st.points, u.x, u.y - 10, '#9ff');
  sfx.ufoDie();
}

function spawnWave() {
  const d = difficulty();
  const n = 2 + Math.floor(Math.random() * (1 + d * 2.5));
  const diverChance = game.section < 4 ? 0 : 0.2 + d * 0.4;
  const seekerChance = game.section < 9 ? 0 : 0.15 + d * 0.2;
  const fromLeft = Math.random() < 0.7;
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    ufos.push({
      type: r < seekerChance ? 'seeker' : r < seekerChance + diverChance ? 'diver' : 'saucer',
      mode: 'hover',
      diveT: rand(1.5, 3.5) + i * 0.6,
      x: fromLeft ? -30 - i * 55 : W + 30 + i * 55,
      y: 60 + Math.random() * 90,
      tx: fromLeft ? 200 : W - 200, ty: 100,
      retarget: 0.6 + i * 0.25,
      bombT: 1.4 + Math.random() * 2 + i * 0.3,
      life: 11 + Math.random() * 6,
      t: Math.random() * 10,
      exit: false,
    });
  }
}

function updateUfos(dt, active) {
  const d = difficulty();
  if (active && game.section >= 1 && ufos.length === 0) {
    game.waveTimer -= dt;
    if (game.waveTimer <= 0) {
      spawnWave();
      game.waveTimer = rand(2.5, 5) - d * 1.2;
    }
  }
  for (const u of ufos) {
    u.t += dt;
    u.life -= dt;
    if (u.mode === 'dive') {
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      if (Math.random() < dt * 40) particles.push({ x: u.x, y: u.y, vx: rand(-20, 20), vy: rand(-20, 20), life: 0.3, max: 0.3, g: 0, size: 3, color: '#5dff7a' });
      const cy = chassisY();
      if (player.alive && u.x > player.sx - 32 && u.x < player.sx + 38 && u.y > cy - 30 && u.y < GROUND - player.h) {
        u.dead = true;
        explosion(u.x, u.y, { n: 20, colors: UFO_STYLE.seeker.colors, spd: 200 });
        killPlayer('crash');
      } else if (u.y >= GROUND - 6) {
        u.dead = true;
        groundBlast(game.camX + u.x);
      }
      continue;
    }
    if (u.type === 'seeker' && active && !u.exit && player.alive) {
      u.diveT -= dt;
      if (u.diveT <= 0) {
        const tx = player.sx + rand(-10, 50), ty = GROUND - 15;
        const dist = Math.hypot(tx - u.x, ty - u.y) || 1;
        const spd = 340 + d * 60;
        u.mode = 'dive';
        u.vx = (tx - u.x) / dist * spd;
        u.vy = (ty - u.y) / dist * spd;
        sfx.dive();
        continue;
      }
    }
    if (u.life <= 0 && !u.exit) {
      u.exit = true;
      u.tx = Math.random() < 0.5 ? -100 : W + 100;
      u.ty = -80;
    }
    if (!u.exit) {
      u.retarget -= dt;
      if (u.retarget <= 0) {
        u.tx = 80 + Math.random() * (W - 160);
        u.ty = 50 + Math.random() * (u.type === 'diver' ? 250 : u.type === 'seeker' ? 90 : 130);
        u.retarget = 0.7 + Math.random() * 1.3;
      }
    }
    const spd = (u.type === 'diver' ? 240 : 170) * (1 + d * 0.25);
    const dx = u.tx - u.x, dy = u.ty - u.y, dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(dist, spd * dt);
    u.x += dx / dist * step;
    u.y += dy / dist * step + Math.sin(u.t * 4) * 20 * dt;

    if (active && !u.exit && player.alive && u.type !== 'seeker') {
      u.bombT -= dt;
      if (u.bombT <= 0 && u.x > 30 && u.x < W - 30 && u.y < 330) {
        bombs.push({
          x: u.x, y: u.y + 8, vy: 40,
          vx: u.type === 'diver' ? clamp((player.sx - u.x) * 0.5, -120, 120) : 0,
        });
        sfx.bombDrop();
        u.bombT = (2.4 - d) * (0.6 + Math.random() * 0.8);
      }
    }
  }
  ufos = ufos.filter(u => !u.dead && !(u.exit && (u.y < -60 || u.x < -90 || u.x > W + 90)));
}

function updateBombs(dt) {
  const p = player;
  const cy = chassisY();
  for (const b of bombs) {
    b.vy += 300 * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (p.alive && b.x > p.sx - 30 && b.x < p.sx + 36 && b.y > cy - 26 && b.y < GROUND - p.h) {
      b.dead = true;
      killPlayer('crash');
      continue;
    }
    if (b.y >= GROUND - 3) {
      b.dead = true;
      groundBlast(game.camX + b.x);
    }
  }
  bombs = bombs.filter(b => !b.dead);
}

function checkObstacles() {
  const p = player;
  const wx = worldX();
  for (const o of obstacles) {
    if (o.dead) continue;
    const overlap = wx + 28 > o.x + 3 && wx - 26 < o.x + o.w - 3;
    if (o.type === 'crater') {
      if (p.grounded && wx > o.x + 8 && wx < o.x + o.w - 8) { killPlayer('fall'); return; }
    } else if (o.type === 'mine') {
      if (overlap && p.h < 6) {
        o.dead = true;
        explosion(o.x + 8, GROUND - 4, { n: 20, colors: ['#ff3030', '#ffd23c', '#fff'], spd: 220, world: true });
        killPlayer('crash');
        return;
      }
    } else if (o.type === 'boulder') {
      // the boulder bounces, so the buggy can also slip underneath a high hop
      if (overlap && p.h < o.lift + o.h - 3 && p.h + 34 > o.lift + 3) { killPlayer('crash'); return; }
    } else if (overlap && p.h < o.h - 3) {
      killPlayer('crash');
      return;
    }
    if (!o.passed && o.x + o.w < wx - 30) {
      o.passed = true;
      addScore(50, o.x + o.w / 2 - game.camX, GROUND - 40, '#ffd23c');
    }
  }
}

function updateEffects(dt) {
  for (const pt of particles) {
    pt.life -= dt;
    pt.vy += pt.g * dt;
    if (pt.drag) { const k = Math.max(0, 1 - pt.drag * dt); pt.vx *= k; pt.vy *= k; }
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    if (pt.grow) pt.size += pt.grow * dt;
  }
  particles = particles.filter(pt => pt.life > 0);
  updateDebris(dt);
  game.flash = Math.max(0, (game.flash || 0) - dt);
  for (const t of texts) { t.t -= dt; t.y -= 30 * dt; }
  texts = texts.filter(t => t.t > 0);
  game.shake = Math.max(0, game.shake - 30 * dt);
  if (game.banner) {
    game.banner.t -= dt;
    if (game.banner.t <= 0) game.banner = null;
  }
}

// ---------- drawing ----------
const farH = x => noiseLin(x / 160, 11) * 0.65 + noiseLin(x / 55, 12) * 0.35;
const midH = x => noiseSmooth(x / 220, 21) * 0.7 + noiseSmooth(x / 70, 22) * 0.3;

function draw() {
  ctx.setTransform(viewSX, 0, 0, viewSY, 0, 0);
  ctx.save();
  if (game.shake > 0) ctx.translate(rand(-1, 1) * game.shake, rand(-1, 1) * game.shake);
  drawSky();
  drawLayer(0.12, 360, 150, farH, '#2c3770', '#5868b0');
  drawLayer(0.35, 432, 72, midH, '#1f4f4a', '#47947f');
  drawDomes();
  drawGround();
  if (game.state !== 'title') drawSigns();
  for (const o of obstacles) {
    if (o.dead) continue;
    if (o.x - game.camX > W + 60 || o.x + o.w - game.camX < -60) continue;
    if (o.type === 'crater') drawCrater(o);
    else if (o.type === 'mine') drawMine(o);
    else if (o.type === 'tank') drawTank(o);
    else if (o.type === 'boulder') drawBoulder(o);
    else drawRock(o);
  }
  drawPlayer();
  drawDebris();
  drawShots();
  drawShells();
  for (const u of ufos) drawUfo(u);
  drawBombs();
  drawParticles();
  drawTexts();
  ctx.restore();
  if (game.flash > 0) {
    ctx.fillStyle = `rgba(255, 244, 210, ${game.flash / 0.18 * 0.6})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawHUD();
  drawOverlay();
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND);
  g.addColorStop(0, '#05060f');
  g.addColorStop(0.65, '#160f38');
  g.addColorStop(1, '#3a1d4f');
  ctx.fillStyle = g;
  ctx.fillRect(-20, -20, W + 40, GROUND + 40);

  const t = performance.now() / 1000;
  for (const s of stars) {
    const x = ((s.x - game.camX * 0.03) % W + W) % W;
    ctx.globalAlpha = 0.35 + 0.65 * s.b * (0.7 + 0.3 * Math.sin(t * 2 + s.tw));
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, s.y, s.b > 0.85 ? 2 : 1, s.b > 0.85 ? 2 : 1);
  }
  ctx.globalAlpha = 1;

  // Earth
  const ex = 820, ey = 105, er = 34;
  ctx.fillStyle = '#2f6fd6';
  ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#3fae5a';
  ctx.beginPath(); ctx.ellipse(ex - 10, ey - 8, 14, 9, 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(ex + 14, ey + 12, 10, 14, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(5,6,15,0.55)';
  ctx.beginPath(); ctx.arc(ex + 16, ey + 6, er, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function layerTops(factor, baseY, amp, fn) {
  const off = game.camX * factor;
  const pts = [];
  const x0 = Math.floor(off / 8) * 8 - 16;
  for (let x = x0; x - off <= W + 24; x += 8) pts.push([x - off, baseY - fn(x) * amp]);
  return pts;
}

function drawLayer(factor, baseY, amp, fn, color, rim) {
  const pts = layerTops(factor, baseY, amp, fn);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], H + 20);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], H + 20);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.stroke();
}

function drawDomes() {
  const off = game.camX * 0.35;
  const sp = 300;
  for (let k = Math.floor(off / sp) - 1; k * sp - off < W + sp; k++) {
    if (hash(k, 77) < 0.5) continue;
    const wx = k * sp + hash(k, 78) * 150;
    const x = wx - off;
    const r = 12 + hash(k, 79) * 14;
    const y = 432 - midH(wx) * 72 + 4;
    ctx.fillStyle = '#9fb4e8';
    ctx.beginPath(); ctx.arc(x, y, r, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#6c80b8';
    ctx.beginPath(); ctx.arc(x, y, r, Math.PI * 1.5, 0); ctx.lineTo(x, y); ctx.fill();
    ctx.fillStyle = '#ffe27a';
    for (let i = -1; i <= 1; i++) ctx.fillRect(x + i * r * 0.45 - 1.5, y - r * 0.4, 3, 3);
    ctx.fillStyle = '#1f4f4a';
    ctx.fillRect(x - r - 2, y, r * 2 + 4, 6);
  }
}

function drawGround() {
  const g = ctx.createLinearGradient(0, GROUND, 0, H);
  g.addColorStop(0, '#a87442');
  g.addColorStop(1, '#4e301b');
  ctx.fillStyle = g;
  ctx.fillRect(-20, GROUND, W + 40, H - GROUND + 20);
  ctx.fillStyle = '#d9a066';
  ctx.fillRect(-20, GROUND, W + 40, 3);

  // pebble rows, lower rows scroll faster for depth
  for (let r = 0; r < 4; r++) {
    const factor = 1 + r * 0.15;
    const sp = 37 + r * 13;
    const off = game.camX * factor;
    const y = GROUND + 12 + r * 20;
    ctx.fillStyle = r % 2 ? '#7a4f2c' : '#8c5c34';
    for (let k = Math.floor(off / sp) - 1; k * sp - off < W + sp; k++) {
      if (hash(k, 100 + r) < 0.5) continue;
      const x = k * sp + hash(k, 200 + r) * sp - off;
      const s = 2 + hash(k, 300 + r) * (3 + r);
      ctx.beginPath(); ctx.ellipse(x, y + hash(k, 400 + r) * 8, s * 1.6, s * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawSigns() {
  const first = Math.floor((game.camX - 60) / SECTION_LEN) + 1;
  for (let s = first; s * SECTION_LEN - game.camX < W + 60; s++) {
    const x = s * SECTION_LEN - game.camX;
    ctx.fillStyle = '#ddd';
    ctx.fillRect(x - 2, GROUND - 52, 4, 52);
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(x - 14, GROUND - 76, 28, 26);
    ctx.fillStyle = '#fff';
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(LETTERS[s % 26], x + 1, GROUND - 62);
  }
}

function drawCrater(o) {
  const x = o.x - game.camX, w = o.w;
  const d = o.bomb ? 22 : 30 + Math.min(10, w * 0.1);
  ctx.fillStyle = '#2a170c';
  ctx.beginPath();
  ctx.moveTo(x - 5, GROUND);
  ctx.quadraticCurveTo(x + 2, GROUND + d * 0.95, x + w / 2, GROUND + d);
  ctx.quadraticCurveTo(x + w - 2, GROUND + d * 0.95, x + w + 5, GROUND);
  ctx.closePath();
  ctx.fill();
  // lit far wall
  ctx.fillStyle = '#5a3720';
  ctx.beginPath();
  ctx.moveTo(x + w + 5, GROUND);
  ctx.quadraticCurveTo(x + w - 2, GROUND + d * 0.95, x + w / 2, GROUND + d);
  ctx.quadraticCurveTo(x + w - 8, GROUND + d * 0.6, x + w - 2, GROUND);
  ctx.closePath();
  ctx.fill();
  // rims
  ctx.fillStyle = '#c48a52';
  ctx.beginPath(); ctx.ellipse(x - 7, GROUND, 9, 3.5, 0, Math.PI, 0); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + w + 7, GROUND, 9, 3.5, 0, Math.PI, 0); ctx.fill();
}

function drawRock(o) {
  const x = o.x - game.camX, w = o.w, h = o.h;
  ctx.fillStyle = '#9c8370';
  ctx.beginPath();
  ctx.moveTo(x, GROUND);
  ctx.lineTo(x + 2, GROUND - h * 0.55);
  ctx.lineTo(x + w * 0.25, GROUND - h);
  ctx.lineTo(x + w * 0.7, GROUND - h * 0.92);
  ctx.lineTo(x + w, GROUND - h * 0.45);
  ctx.lineTo(x + w, GROUND);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6e5a4a';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.7, GROUND - h * 0.92);
  ctx.lineTo(x + w, GROUND - h * 0.45);
  ctx.lineTo(x + w, GROUND);
  ctx.lineTo(x + w * 0.55, GROUND);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#cdb6a0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + 3, GROUND - h * 0.55);
  ctx.lineTo(x + w * 0.25, GROUND - h + 1);
  ctx.lineTo(x + w * 0.6, GROUND - h * 0.93);
  ctx.stroke();
  if (o.hp < o.maxHp) {
    ctx.strokeStyle = '#2a1d14';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.4, GROUND - h * 0.95);
    ctx.lineTo(x + w * 0.5, GROUND - h * 0.6);
    ctx.lineTo(x + w * 0.35, GROUND - h * 0.35);
    ctx.lineTo(x + w * 0.5, GROUND - h * 0.1);
    ctx.stroke();
  }
}

function drawMine(o) {
  const x = o.x - game.camX + 8;
  ctx.strokeStyle = '#8a8f99';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const a of [-2.4, -1.57, -0.7]) { ctx.moveTo(x, GROUND - 3); ctx.lineTo(x + Math.cos(a) * 10, GROUND - 3 + Math.sin(a) * 10); }
  ctx.stroke();
  ctx.fillStyle = '#4b505a';
  ctx.beginPath(); ctx.ellipse(x, GROUND, 9, 7, 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#2c2f36';
  ctx.fillRect(x - 9, GROUND - 2, 18, 2);
  const on = Math.floor(performance.now() / 250) % 2 === 0;
  ctx.fillStyle = on ? '#ff3030' : '#601010';
  ctx.beginPath(); ctx.arc(x, GROUND - 7, 2.5, 0, Math.PI * 2); ctx.fill();
  if (on) {
    ctx.fillStyle = 'rgba(255, 48, 48, 0.25)';
    ctx.beginPath(); ctx.arc(x, GROUND - 7, 6, 0, Math.PI * 2); ctx.fill();
  }
}

function drawTank(o) {
  const x = o.x - game.camX;
  const hurt = o.hp < o.maxHp;
  // treads
  ctx.fillStyle = '#3b3f2a';
  ctx.beginPath(); ctx.roundRect(x, GROUND - 11, 44, 11, 5); ctx.fill();
  ctx.fillStyle = '#7d806e';
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(x + 7 + i * 10, GROUND - 5.5, 3.5, 0, Math.PI * 2); ctx.fill(); }
  // hull + turret
  ctx.fillStyle = hurt ? '#545f2e' : '#6b7a3a';
  ctx.beginPath();
  ctx.moveTo(x + 2, GROUND - 11); ctx.lineTo(x + 8, GROUND - 19); ctx.lineTo(x + 40, GROUND - 19); ctx.lineTo(x + 43, GROUND - 11);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = hurt ? '#64703a' : '#7f8f45';
  ctx.beginPath(); ctx.arc(x + 26, GROUND - 19, 8, Math.PI, 0); ctx.fill();
  // barrel points back at the buggy
  ctx.fillStyle = '#3b3f2a';
  ctx.fillRect(x - 6, GROUND - 22, 26, 3);
  if (o.flash > 0) {
    ctx.fillStyle = '#ffd23c';
    ctx.beginPath(); ctx.arc(x - 9, GROUND - 20.5, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x - 9, GROUND - 20.5, 3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawBoulder(o) {
  const cx = o.x - game.camX + o.w / 2, r = o.w / 2;
  const cy = GROUND - o.lift - r;
  ctx.fillStyle = `rgba(0, 0, 0, ${0.35 - o.lift / 100})`;
  ctx.beginPath(); ctx.ellipse(cx, GROUND + 1, r * (1 - o.lift / 60), 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(o.spin);
  ctx.fillStyle = '#a08c7a';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6e5a4a';
  ctx.beginPath(); ctx.arc(-4, -3, 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(5, 4, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(3, -7, 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255, 240, 220, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r - 2, Math.PI * 1.1, Math.PI * 1.6); ctx.stroke();
}

function drawShells() {
  for (const s of shells) {
    const x = s.x - game.camX;
    ctx.fillStyle = 'rgba(255, 154, 60, 0.35)';
    ctx.fillRect(x, s.y - 2, 14, 4);
    ctx.fillStyle = '#ff9a3c';
    ctx.beginPath(); ctx.arc(x, s.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x - 1, s.y - 1, 1.5, 0, Math.PI * 2); ctx.fill();
  }
}

function drawWheel(x, y, spin) {
  ctx.fillStyle = '#22222a';
  ctx.beginPath(); ctx.arc(x, y, WHEEL_R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#d8d8e0';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, WHEEL_R - 1, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#8a8a96';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = spin + k * Math.PI * 2 / 3;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * (WHEEL_R - 2), y + Math.sin(a) * (WHEEL_R - 2));
  }
  ctx.stroke();
  ctx.fillStyle = '#ddd';
  ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
}

function drawBuggy(cx, baseY, tilt, wy, spin) {
  ctx.strokeStyle = '#9aa';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const ox = cx + WHEEL_OFF[i];
    ctx.moveTo(ox, baseY - 2 + tilt * WHEEL_OFF[i]);
    ctx.lineTo(ox, wy[i]);
  }
  ctx.stroke();
  for (let i = 0; i < 3; i++) drawWheel(cx + WHEEL_OFF[i], wy[i], spin + i);

  ctx.save();
  ctx.translate(cx, baseY);
  ctx.rotate(tilt);
  // antenna
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-30, -12); ctx.lineTo(-38, -32); ctx.stroke();
  ctx.fillStyle = '#ff4d6d';
  ctx.beginPath(); ctx.arc(-38, -32, 2.5, 0, Math.PI * 2); ctx.fill();
  // turret
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(-16, -33, 4, 10);
  // body
  ctx.fillStyle = '#b84dff';
  ctx.beginPath();
  ctx.moveTo(-34, 0); ctx.lineTo(34, 0); ctx.lineTo(39, -7); ctx.lineTo(28, -13);
  ctx.lineTo(4, -13); ctx.lineTo(-2, -24); ctx.lineTo(-24, -24); ctx.lineTo(-28, -13);
  ctx.lineTo(-34, -11);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6d23a8';
  ctx.fillRect(-34, -5, 71, 5);
  // window
  ctx.fillStyle = '#7ff3ff';
  ctx.beginPath();
  ctx.moveTo(-4, -14); ctx.lineTo(-8, -21); ctx.lineTo(-20, -21); ctx.lineTo(-23, -14);
  ctx.closePath();
  ctx.fill();
  // front gun
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(34, -10, 12, 3);
  ctx.restore();
}

function drawPlayer() {
  const p = player;
  if (!p.visible) return;
  const baseY = chassisY();
  const tilt = (p.wheelY[2] - p.wheelY[0]) / 44;
  const wy = p.wheelY.map(o => GROUND - WHEEL_R - p.h + o);
  if (p.deathType === 'fall') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-50, -50, W + 100, GROUND + 75);
    ctx.clip();
  }
  drawBuggy(p.sx, baseY, tilt, wy, p.spin);
  if (p.deathType === 'fall') ctx.restore();
}

function drawShots() {
  ctx.fillStyle = '#fff6a0';
  for (const s of fwdShots) ctx.fillRect(s.x, s.y - 1.5, 12, 3);
  ctx.fillStyle = '#9ff';
  for (const s of upShots) ctx.fillRect(s.x - 1.5, s.y - 6, 3, 12);
}

function drawUfo(u) {
  const blink = Math.floor(u.t * 8) % 3;
  if (u.type === 'saucer') {
    ctx.fillStyle = '#cff';
    ctx.beginPath(); ctx.ellipse(u.x, u.y - 4, 8, 7, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#5ab8ff';
    ctx.beginPath(); ctx.ellipse(u.x, u.y, 20, 6, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === blink ? '#fff' : '#ffd23c';
      ctx.fillRect(u.x - 12 + i * 11, u.y - 1, 3, 3);
    }
  } else if (u.type === 'seeker') {
    const diving = u.mode === 'dive';
    ctx.save();
    ctx.translate(u.x, u.y);
    ctx.rotate(diving ? Math.atan2(u.vy, u.vx) - Math.PI / 2 : u.t * 3);
    ctx.fillStyle = diving ? '#c8ffb0' : '#5dff7a';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, rr = i % 2 ? 6 : 14;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = blink ? '#ff3030' : '#1a3a20';
    ctx.beginPath(); ctx.arc(u.x, u.y, 3.5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath();
    ctx.moveTo(u.x - 18, u.y - 2); ctx.lineTo(u.x, u.y - 9); ctx.lineTo(u.x + 18, u.y - 2);
    ctx.lineTo(u.x + 6, u.y + 8); ctx.lineTo(u.x - 6, u.y + 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = blink ? '#ffd23c' : '#fff';
    ctx.beginPath(); ctx.arc(u.x, u.y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
}

function drawBombs() {
  for (const b of bombs) {
    ctx.fillStyle = 'rgba(255, 200, 80, 0.35)';
    ctx.beginPath(); ctx.arc(b.x, b.y - 5, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffea70';
    ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

// flames cool from white-hot to yellow, orange and dark red as they burn out
function flameColor(f) {
  return f > 0.85 ? '#fff4c2' : f > 0.6 ? '#ffd23c' : f > 0.35 ? '#ff7a2f' : '#c0301a';
}

function drawParticles() {
  // smoke underneath, then debris squares, then additive flames on top
  for (const pt of particles) {
    if (pt.kind !== 'smoke') continue;
    const f = clamp(pt.life / pt.max, 0, 1);
    ctx.globalAlpha = f * 0.55;
    ctx.fillStyle = '#3a3540';
    ctx.beginPath(); ctx.arc(pt.world ? pt.x - game.camX : pt.x, pt.y, pt.size, 0, Math.PI * 2); ctx.fill();
  }
  for (const pt of particles) {
    if (pt.kind) continue;
    ctx.globalAlpha = clamp(pt.life / pt.max, 0, 1);
    ctx.fillStyle = pt.color;
    const x = pt.world ? pt.x - game.camX : pt.x;
    ctx.fillRect(x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  ctx.globalCompositeOperation = 'lighter';
  for (const pt of particles) {
    if (pt.kind !== 'flame') continue;
    const f = clamp(pt.life / pt.max, 0, 1);
    ctx.globalAlpha = Math.min(1, f * 1.6) * 0.6;
    ctx.fillStyle = flameColor(f);
    ctx.beginPath(); ctx.arc(pt.world ? pt.x - game.camX : pt.x, pt.y, pt.size, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawDebris() {
  for (const d of debris) {
    const x = d.x - game.camX;
    if (d.kind === 'wheel') { drawWheel(x, d.y, d.rot); continue; }
    ctx.save();
    ctx.translate(x, d.y);
    ctx.rotate(d.rot);
    if (d.kind === 'chunk') {
      ctx.fillStyle = d.color;
      ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
    } else {
      // charred body shell (origin at its bottom centre)
      ctx.translate(0, d.r);
      ctx.fillStyle = '#2e2134';
      ctx.beginPath();
      ctx.moveTo(-34, 0); ctx.lineTo(34, 0); ctx.lineTo(39, -7); ctx.lineTo(28, -13);
      ctx.lineTo(4, -13); ctx.lineTo(-2, -24); ctx.lineTo(-24, -24); ctx.lineTo(-28, -13);
      ctx.lineTo(-34, -11);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#151018';
      ctx.fillRect(-34, -5, 71, 5);
      ctx.beginPath();
      ctx.moveTo(-4, -14); ctx.lineTo(-8, -21); ctx.lineTo(-20, -21); ctx.lineTo(-23, -14);
      ctx.closePath();
      ctx.fill();
      // glowing embers
      const glow = 0.5 + 0.5 * Math.sin(d.t * 9);
      ctx.fillStyle = `rgba(255, ${120 + glow * 80 | 0}, 40, ${0.5 + glow * 0.4})`;
      ctx.fillRect(-26, -9, 6, 3);
      ctx.fillRect(8, -11, 5, 3);
      ctx.fillRect(-12, -3, 7, 2);
    }
    ctx.restore();
  }
}

function drawTexts() {
  for (const t of texts) {
    ctx.globalAlpha = clamp(t.t, 0, 1);
    text(t.str, t.x, t.y, 10, t.color, 'center');
  }
  ctx.globalAlpha = 1;
}

function text(str, x, y, size, color, align = 'left') {
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(str, x + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

const pad = n => String(n).padStart(6, '0');

function drawHUD() {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, 38);
  text('HI ' + pad(game.hi), W - 16, 12, 12, '#ff7a9c', 'right');
  if (game.state === 'title') return;
  text('SCORE ' + pad(game.score), 16, 12, 12, '#fff');

  // course progress
  const bx = 330, bw = 300, by = 10;
  ctx.fillStyle = '#333a5c';
  ctx.fillRect(bx, by + 6, bw, 4);
  const pos = ((worldX() / SECTION_LEN) % 26 + 26) % 26;
  ctx.fillStyle = '#7fff7f';
  ctx.fillRect(bx, by + 6, bw * pos / 26, 4);
  for (let i = 0; i <= 26; i++) {
    const x = bx + bw * i / 26;
    const major = i % 5 === 4 || i === 0;
    ctx.fillStyle = i <= pos ? '#7fff7f' : '#8890b8';
    ctx.fillRect(x - 0.5, by + (major ? 2 : 4), 1, major ? 12 : 8);
    if (major && i < 26) text(LETTERS[i], x, by + 17, 7, i <= pos ? '#7fff7f' : '#8890b8', 'center');
  }
  const mx = bx + bw * pos / 26;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(mx, by + 4); ctx.lineTo(mx - 4, by - 3); ctx.lineTo(mx + 4, by - 3); ctx.fill();

  // lives
  for (let i = 0; i < Math.min(game.lives - 1, 6); i++) {
    ctx.save();
    ctx.translate(26 + i * 34, 58);
    ctx.scale(0.4, 0.4);
    drawBuggy(0, 0, 0, [WHEEL_R + 1, WHEEL_R + 1, WHEEL_R + 1], 0);
    ctx.restore();
  }
  text(`POINT ${LETTERS[game.section % 26]}`, W - 16, 48, 10, '#9ff', 'right');
  text(`TIME ${game.sectionTime.toFixed(1)}`, W - 16, 64, 10, '#ccc', 'right');
  if (sfx.muted) text('MUTED', W / 2, 48, 8, '#888', 'center');
}

function centerBox(y, h) {
  ctx.fillStyle = 'rgba(5,6,20,0.7)';
  ctx.fillRect(0, y, W, h);
}

function drawOverlay() {
  const blink = Math.floor(performance.now() / 450) % 2 === 0;
  if (game.state === 'title') {
    centerBox(110, 250);
    text('CRATER PATROL', W / 2, 140, 40, '#b84dff', 'center');
    text('defend the lunar highway', W / 2, 196, 10, '#9ff', 'center');
    const lines = isTouch
      ? ['LEFT / RIGHT  slow / fast', 'JUMP  hop craters & rocks', 'FIRE  shoots ahead and up']
      : ['LEFT / RIGHT  slow down / speed up', 'UP or W  jump', 'SPACE or Z  fire ahead and up', 'P pause   M mute'];
    lines.forEach((l, i) => text(l, W / 2, 232 + i * 20, 10, '#ddd', 'center'));
    if (blink) text(isTouch ? 'TAP TO START' : 'PRESS ENTER', W / 2, 322, 14, '#ffd23c', 'center');
  } else if (game.state === 'gameover') {
    centerBox(160, 190);
    text('GAME OVER', W / 2, 190, 36, '#ff4d6d', 'center');
    text('SCORE ' + pad(game.score), W / 2, 250, 14, '#fff', 'center');
    if (game.newHi) text('NEW HIGH SCORE!', W / 2, 276, 12, '#7fff7f', 'center');
    if (game.stateT > 1.2 && blink) text(isTouch ? 'TAP TO CONTINUE' : 'PRESS ENTER', W / 2, 310, 12, '#ffd23c', 'center');
  } else if (game.state === 'victory') {
    const t = game.stateT;
    const fade = clamp(Math.min(t / 0.3, (VICTORY_TIME - t) / 0.4), 0, 1);
    ctx.globalAlpha = fade;
    centerBox(110, 230);
    // zoom in with a little overshoot, then pulse gently
    const pop = t < 0.45 ? 0.4 + 0.75 * Math.sin((t / 0.45) * Math.PI / 2) * (1 + 0.15 * Math.sin(t / 0.45 * Math.PI)) : 1 + 0.03 * Math.sin(t * 8);
    const hue = (t * 240) % 360;
    ctx.save();
    ctx.translate(W / 2, 175);
    ctx.scale(pop, pop);
    text('MISSION', 0, -38, 36, '#fff', 'center');
    text('ACCOMPLISHED!', 0, 10, 36, `hsl(${hue}, 100%, 65%)`, 'center');
    ctx.restore();
    if (t > 0.6) {
      const round = Math.floor(game.section / 26);
      text(`COURSE ${round} COMPLETE`, W / 2, 252, 14, '#9ff', 'center');
      text(`BONUS ${game.victoryBonus}`, W / 2, 280, 14, '#ffd23c', 'center');
      text('PREPARE FOR THE NEXT ROUND', W / 2, 312, 10, '#ddd', 'center');
    }
    ctx.globalAlpha = 1;
  } else if (game.paused) {
    centerBox(220, 90);
    text('PAUSED', W / 2, 246, 28, '#fff', 'center');
  }

  if (game.banner && game.state !== 'title') {
    ctx.globalAlpha = clamp(game.banner.t * 2, 0, 1);
    text(game.banner.text, W / 2, 150, 22, '#7fff7f', 'center');
    if (game.banner.sub) text(game.banner.sub, W / 2, 186, 10, '#fff', 'center');
    if (game.banner.note) text(game.banner.note, W / 2, 210, 10, '#ffd23c', 'center');
    ctx.globalAlpha = 1;
  }
}

// ---------- main loop ----------
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (acc >= STEP) {
    update(STEP);
    acc -= STEP;
  }
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
