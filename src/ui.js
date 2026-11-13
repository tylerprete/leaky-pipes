(function () {
  'use strict';
  const LP = window.LP;
  const OPP = LP.OPP;
  const SAVE_KEY = 'leaky-pipes-v1';
  const PREF_KEY = 'leaky-pipes-prefs';
  const BOT_NAMES = ['Rusty', 'Gasket', 'Spigot'];
  const CW = 50;
  const CH = 70;
  const GAP = 3;
  const BOT_DELAY = 800;
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ui = {
    game: null,
    demo: null,
    seats: [
      { name: 'You', kind: 'human' },
      { name: 'Rusty', kind: 'bot' },
    ],
    level: 'normal',
    table: 'classic',
    deck: 'tuned',
    sound: true,
    view: 0,
    viewer: 0,
    sel: null,
    flips: {},
    wrench: false,
    busy: false,
    modal: null,
    gen: 0,
    flash: -1,
    anim: null,
    botMark: null,
    hint: null,
    vb: null,
    drag: null,
    dragOver: -1,
    suppressClick: false,
    bots: {},
    since: {}, // per player: log seq right after their own last move
    shownAt: new Map(), // log entry -> when it first appeared on screen
  };
  const EVENT_SECS = 8; // how long an event line stays before fading out

  // ---------------------------------------------------------------- prefs
  try {
    const pr = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (typeof pr.sound === 'boolean') ui.sound = pr.sound;
    if (pr.level) ui.level = pr.level;
    if (pr.table) ui.table = pr.table;
    if (pr.deck) ui.deck = pr.deck;
  } catch (e) {
    /* no storage */
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ sound: ui.sound, level: ui.level, table: ui.table, deck: ui.deck }));
    } catch (e) {
      /* no storage */
    }
  }

  // ---------------------------------------------------------------- sound (synthesized, quiet)
  let actx = null;
  function audio() {
    if (!ui.sound) return null;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) {
      actx = null;
    }
    return actx;
  }
  function tone(freq, dur, opts) {
    const a = audio();
    if (!a) return;
    opts = opts || {};
    const t = a.currentTime + (opts.delay || 0);
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.vol || 0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function hiss(dur, vol) {
    const a = audio();
    if (!a) return;
    const n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2500;
    const g = a.createGain();
    g.gain.value = vol || 0.04;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
  }
  const sfx = {
    pick: () => tone(660, 0.05, { vol: 0.025 }),
    place: () => {
      tone(520, 0.07, { type: 'triangle', vol: 0.05 });
      tone(1040, 0.09, { type: 'sine', vol: 0.025, delay: 0.03 });
    },
    leak: () => {
      hiss(0.35, 0.05);
      tone(300, 0.2, { to: 140, type: 'sawtooth', vol: 0.015 });
    },
    repair: () => [0, 0.07, 0.14].forEach((d) => tone(1500, 0.03, { type: 'square', vol: 0.015, delay: d })),
    nope: () => tone(220, 0.12, { type: 'triangle', vol: 0.04, to: 160 }),
    win: () => [523, 659, 784, 1047].forEach((f, k) => tone(f, 0.22, { type: 'triangle', vol: 0.05, delay: k * 0.11 })),
    lose: () => [392, 330, 262].forEach((f, k) => tone(f, 0.25, { type: 'triangle', vol: 0.04, delay: k * 0.14 })),
  };

  // ---------------------------------------------------------------- art
  const MID = { N: [25, 0], S: [25, 70], E: [50, 35], W: [0, 35] };
  const MAT = {
    iron: { o: '#47515a', i: '#9aa5ad', s: '#e2e8ec', r: '#6a747c' },
    copper: { o: '#73370f', i: '#cc7438', s: '#f7bf8e', r: '#9b501f' },
  };
  MAT.leaky = MAT.iron;

  function pipePath(op) {
    if (op.length === 2) {
      const [a, b] = op;
      if (OPP[a] === b) return `M${MID[a]} L${MID[b]}`;
      return `M${MID[a]} Q25,35 ${MID[b]}`;
    }
    const through = [['N', 'S'], ['E', 'W']].find(([a, b]) => op.includes(a) && op.includes(b));
    const stub = op.find((d) => !through.includes(d));
    return `M${MID[through[0]]} L${MID[through[1]]} M25,35 L${MID[stub]}`;
  }
  function ring(d, m) {
    const r = { N: [14.5, 1, 21, 6], S: [14.5, 63, 21, 6], E: [43, 24.5, 6, 21], W: [1, 24.5, 6, 21] }[d];
    return `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" rx="1.5" fill="${m.r}" stroke="${m.o}" stroke-width="1"/>`;
  }
  function tube(path, m) {
    return (
      `<path d="${path}" fill="none" stroke="${m.o}" stroke-width="16"/>` +
      `<path d="${path}" fill="none" stroke="${m.i}" stroke-width="11.5"/>` +
      `<path d="${path}" fill="none" stroke="${m.s}" stroke-width="2.4" stroke-opacity=".75" transform="translate(-2,-2)"/>`
    );
  }
  function drop(x, y, s, cls, delay) {
    s = s || 1;
    return `<path class="${cls || ''}" style="${delay != null ? `animation-delay:${delay}s` : ''}" d="M${x},${y - 4 * s} C${x + 3 * s},${y} ${x + 3 * s},${y + 3 * s} ${x},${y + 3 * s} C${x - 3 * s},${y + 3 * s} ${x - 3 * s},${y} ${x},${y - 4 * s}Z" fill="#3aa0e6" stroke="#e9f6ff" stroke-width=".6"/>`;
  }
  function spray(op) {
    const free = ['N', 'E', 'S', 'W'].filter((d) => !op.includes(d));
    const d = free[0] || 'N';
    const off = { N: [[19, 12], [27, 7], [33, 14], [24, 17]], S: [[19, 56], [27, 62], [33, 55], [24, 52]], E: [[38, 26], [44, 33], [40, 42], [35, 34]], W: [[12, 26], [6, 33], [10, 42], [15, 34]] }[d];
    return off.map(([x, y], k) => drop(x, y, k % 2 ? 0.8 : 1.05, 'drip', (k * 0.37).toFixed(2))).join('') + `<path d="M21,31 L25,35 L23,38 L28,41" fill="none" stroke="#1d272e" stroke-width="1.6"/>`;
  }
  function wrenchIcon() {
    return `<g transform="translate(26 35) rotate(-38)" fill="#2b3238" stroke="#d5dde2" stroke-width="1"><rect x="-2" y="-2.6" width="21" height="5.2" rx="2.4"/><circle cx="-6" cy="0" r="6.4"/><rect x="-13.5" y="-2" width="7" height="4" fill="#b9d8ec" stroke="none"/></g>`;
  }
  function face() {
    return (
      `<rect x="1" y="1" width="48" height="68" rx="5" fill="url(#cardFace)" stroke="#8fb9d3" stroke-width="1"/>` +
      `<circle cx="8" cy="9" r="2.2" fill="#fff" opacity=".45"/><circle cx="12.5" cy="5.6" r="1.3" fill="#fff" opacity=".45"/>` +
      `<circle cx="42" cy="62" r="2" fill="#fff" opacity=".4"/><circle cx="38" cy="65.5" r="1.2" fill="#fff" opacity=".4"/>`
    );
  }
  function capArt(card, flip, usedSet) {
    let s = '';
    for (const d of ['N', 'E', 'S', 'W']) {
      const mat = LP.capAt(card, flip, d);
      const m = MAT[mat];
      const faded = usedSet && !usedSet.has(d);
      const g = {
        N: `<rect x="19" y="8" width="12" height="13" fill="${m.i}" stroke="${m.o}"/><rect x="15" y="1" width="20" height="8" rx="1.5" fill="${m.r}" stroke="${m.o}"/>`,
        S: `<rect x="19" y="49" width="12" height="13" fill="${m.i}" stroke="${m.o}"/><rect x="15" y="61" width="20" height="8" rx="1.5" fill="${m.r}" stroke="${m.o}"/>`,
        E: `<rect x="30" y="29" width="12" height="12" fill="${m.i}" stroke="${m.o}"/><rect x="41" y="25" width="8" height="20" rx="1.5" fill="${m.r}" stroke="${m.o}"/>`,
        W: `<rect x="8" y="29" width="12" height="12" fill="${m.i}" stroke="${m.o}"/><rect x="1" y="25" width="8" height="20" rx="1.5" fill="${m.r}" stroke="${m.o}"/>`,
      }[d];
      const live = usedSet && usedSet.has(d);
      const dr = mat === 'leaky' ? { N: drop(25, 26, 1, live ? 'drip' : '') + drop(30, 30, 0.7), S: drop(25, 46, 1, live ? 'drip' : '') + drop(20, 42, 0.7), E: drop(26, 30, 1, live ? 'drip' : '') + drop(24, 38, 0.7), W: drop(24, 30, 1, live ? 'drip' : '') + drop(26, 38, 0.7) }[d] : '';
      s += `<g opacity="${faded ? 0.3 : 1}">${g}${dr}</g>`;
    }
    return s;
  }
  function valveArt() {
    const m = MAT.iron;
    return (
      tube('M0,35 L27,35', m) +
      ring('W', m) +
      `<rect x="22" y="25" width="11" height="20" rx="2" fill="#8d979e" stroke="#47515a"/>` +
      `<rect x="32" y="32.5" width="7" height="5" fill="#7c868d" stroke="#47515a" stroke-width=".8"/>` +
      `<ellipse cx="42" cy="35" rx="4.5" ry="15" fill="#c8372b" stroke="#7d1c14" stroke-width="1.2"/>` +
      `<path d="M42,21 L42,49 M38.5,27 L45.5,43 M45.5,27 L38.5,43" stroke="#7d1c14" stroke-width="1.2"/>`
    );
  }
  function spoutArt(pouring) {
    const m = MAT.copper;
    const water = pouring
      ? `<g class="pour"><rect x="19" y="58" width="8" height="12" rx="3" fill="#3aa0e6" opacity=".85"/>${drop(17, 66, 0.8, 'drip', 0)}${drop(29, 67, 0.7, 'drip', 0.3)}</g>`
      : drop(20, 64, 0.9) + drop(26, 66, 0.8) + drop(23, 69, 0.6);
    return (
      tube('M50,35 L36,35 Q23,35 23,48 L23,51', m) +
      ring('E', m) +
      `<rect x="16" y="50" width="14" height="9" rx="1.5" fill="${m.r}" stroke="${m.o}"/>` +
      `<path d="M17,53 H29 M17,56 H29" stroke="${m.o}" stroke-width=".8"/>` +
      water
    );
  }
  const MIRROR = (inner) => `<g transform="translate(50 0) scale(-1 1)">${inner}</g>`;
  function tintMark(color) {
    // owner color on the shared table: a colored frame and corner tab
    return `<rect x="1" y="1" width="48" height="68" rx="5" fill="none" stroke="${color}" stroke-width="2.6" opacity=".9"/><path d="M1,14 V6 Q1,1 6,1 H14 Z" fill="${color}"/>`;
  }
  function cardArt(piece, opts) {
    opts = opts || {};
    const s = cardArtInner(piece, opts);
    return opts.tint ? s + tintMark(opts.tint) : s;
  }
  function cardArtInner(piece, opts) {
    const c = piece.card;
    let s = face();
    if (c.kind === 'valve') return s + (piece.flip ? MIRROR(valveArt()) : valveArt());
    if (c.kind === 'spout') return s + (opts.mirror || piece.flip ? MIRROR(spoutArt(opts.pouring)) : spoutArt(opts.pouring));
    if (c.kind === 'cap') return s + capArt(c, piece.flip, opts.usedCaps) + (piece.wrench ? wrenchIcon() : '');
    if (c.kind === 'wrench')
      return s + `<circle cx="25" cy="33" r="17" fill="rgba(95,197,143,.16)" stroke="#5fc58f" stroke-width="1.4"/><g transform="translate(5.5 13.5) scale(1.62)"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3.6 17.1a1.6 1.6 0 0 0 2.3 2.3l5.7-5.7a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.3-.6-.6-2.3z" fill="#6f7f8c" stroke="#3d4852" stroke-width=".7"/></g><text x="25" y="63" text-anchor="middle" font-size="7.5" font-weight="700" fill="#2f7a55" font-family="Barlow, sans-serif">FIX LEAK</text>`;
    const op = LP.openingsOf(c, piece.flip);
    const m = MAT[c.mat];
    s += tube(pipePath(op), m);
    if (op.length === 3) s += `<circle cx="25" cy="35" r="9.5" fill="${m.i}" stroke="${m.o}" stroke-width="1.6"/><circle cx="23" cy="33" r="3" fill="${m.s}" opacity=".55"/>`;
    s += op.map((d) => ring(d, m)).join('');
    if (c.mat === 'copper') s += `<rect x="20" y="31" width="10" height="8" rx="2" fill="none" stroke="${m.o}" stroke-width=".6" opacity=".5"/>`;
    if (c.mat === 'leaky' && !piece.repaired) s += spray(op);
    if (piece.wrench) s += wrenchIcon();
    return s;
  }
  function cardSVG(card, flip, extraClass) {
    return `<svg viewBox="0 0 50 70" class="${extraClass || ''}" aria-hidden="true">${cardArt({ card, flip, repaired: false, wrench: false })}</svg>`;
  }
  function cardLabel(card, flip) {
    if (card.kind === 'cap') return LP.describeCard(card);
    if (card.kind === 'wrench') return 'wrench card, fixes a leak on your pipeline';
    const names = { N: 'up', S: 'down', E: 'right', W: 'left' };
    return LP.describeCard(card) + ', open ' + LP.openingsOf(card, flip).map((d) => names[d]).join(' and ');
  }
  const ICON = {
    wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3.6 17.1a1.6 1.6 0 0 0 2.3 2.3l5.7-5.7a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.3-.6-.6-2.3z" fill="currentColor"/></svg>',
    drop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 3-6.8 6-11z" fill="currentColor"/></svg>',
    turn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 4v6h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  // ---------------------------------------------------------------- persistence
  function save() {
    if (ui.net) return; // online games live on the server
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ game: ui.game, seats: ui.seats, viewer: ui.viewer, level: ui.level, since: ui.since }, (k, v) => (k === 'lastAct' || k === 'prevAct' ? undefined : v)));
    } catch (e) {
      /* storage unavailable: play on without saving */
    }
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !d.game || !d.game.players) return null;
      return d;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- helpers
  const G = () => ui.game || ui.demo;
  const live = () => !!ui.game;
  const humans = () => G().players.filter((p) => p.kind === 'human').length;
  const isHumanTurn = () => live() && G().phase !== 'over' && G().players[G().turn].kind === 'human' && !ui.modal && !ui.busy;
  const botFor = (level) => ui.bots[level] || (ui.bots[level] = LP.bot.forLevel(level));

  function selMoves() {
    if (!ui.sel || !isHumanTurn()) return [];
    const g = G();
    const key = [ui.sel, g.turn, g.seq, g.phase].join('|');
    if (ui._mv && ui._mv.key === key) return ui._mv.list;
    const list = LP.legalMoves(g, g.turn, ui.sel).filter((m) => m.type !== 'discard');
    ui._mv = { key, list };
    return list;
  }
  function closeModal() {
    const m = ui.modal;
    if (m && m.type === 'rules' && m.back && m.back.type === 'setup') {
      ui.modal = m.back;
      return render();
    }
    ui.modal = null;
    if (live()) return proceed();
    ui.modal = { type: 'setup' };
    render();
  }
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function findCard(id) {
    const g = G();
    for (const p of g.players) {
      const c = p.hand.find((h) => h.id === id);
      if (c) return c;
    }
    return null;
  }
  function isSymmetric(cardId) {
    const c = findCard(cardId);
    return c && c.kind === 'pipe' && (c.shape === 'V' || c.shape === 'H');
  }
  function canTurn(c) {
    return c && c.kind !== 'wrench' && !(c.kind === 'pipe' && (c.shape === 'V' || c.shape === 'H'));
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    if (!ui.drag) clearGhosts();
    if (!G()) {
      renderOverlay();
      return;
    }
    layoutMode();
    renderMeta();
    renderChips();
    renderBoard();
    renderStatus();
    renderHand();
    renderActions();
    renderOverlay();
    ui.anim = null;
    ui.flash = -1;
  }

  function layoutMode() {
    const app = $('app');
    const many = live() && G().players.length > 1;
    app.classList.toggle('with-chips', !!(many && shared()));
    app.classList.toggle('with-others', !!(many && !shared()));
  }

  function renderMeta() {
    const g = G();
    $('meta').textContent = live() ? `Deck ${g.deck.length} · Need ${g.required}` : '';
    $('soundBtn').innerHTML = ui.sound ? ICON.speaker : ICON.mute;
    $('soundBtn').setAttribute('aria-label', ui.sound ? 'Sound on' : 'Sound off');
    $('soundBtn').setAttribute('aria-pressed', String(ui.sound));
  }

  // Zoom to the part of the table in use (plus a free ring around it), shaped to the screen.
  function computeView(boards, aspect, minCols, minRows, extra) {
    if (!Array.isArray(boards)) boards = [boards];
    const b = boards[0];
    let x0 = b.w, x1 = 0, y0 = b.h, y1 = 0;
    for (const i of extra || []) {
      const x = i % b.w;
      const y = Math.floor(i / b.w);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    for (const bb of boards) {
      bb.cells.forEach((p, i) => {
        if (!p) return;
        const x = i % b.w;
        const y = Math.floor(i / b.w);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      });
    }
    x0 = Math.max(0, x0 - 1); x1 = Math.min(b.w - 1, x1 + 1);
    y0 = Math.max(0, y0 - 1); y1 = Math.min(b.h - 1, y1 + 1);
    let flipCol = false;
    const addCol = () => {
      flipCol = !flipCol;
      if ((flipCol && x0 > 0) || x1 >= b.w - 1) x0--;
      else x1++;
    };
    let flipRow = false;
    const addRow = () => {
      flipRow = !flipRow;
      if ((flipRow && y0 > 0) || y1 >= b.h - 1) y0--;
      else y1++;
    };
    while (x1 - x0 + 1 < Math.min(minCols || 6, b.w)) addCol();
    while (y1 - y0 + 1 < Math.min(minRows || 5, b.h)) addRow();
    const px = () => ({ w: (x1 - x0 + 1) * CW + (x1 - x0) * GAP, h: (y1 - y0 + 1) * CH + (y1 - y0) * GAP });
    let s = px();
    if (s.w / s.h < aspect) {
      while (s.w / s.h < aspect && x1 - x0 + 1 < b.w) { addCol(); s = px(); }
    } else {
      while (s.w / s.h > aspect && y1 - y0 + 1 < b.h) { addRow(); s = px(); }
    }
    return [x0 * (CW + GAP) - 5, y0 * (CH + GAP) - 5, s.w + 10, s.h + 10];
  }
  function setViewBox(svg, target) {
    ui.vbTarget = target;
    const cur = ui.vb;
    const same = cur && cur.every((v, k) => Math.abs(v - target[k]) < 0.5);
    if (!cur || REDUCED || same || ui.vbView !== ui.view) {
      cancelAnimationFrame(ui.vbRaf);
      ui.vb = target;
      ui.vbView = ui.view;
      svg.setAttribute('viewBox', target.join(' '));
      return;
    }
    const from = cur.slice();
    const t0 = performance.now();
    cancelAnimationFrame(ui.vbRaf);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 350);
      const e = 1 - Math.pow(1 - k, 3);
      ui.vb = from.map((v, j) => v + (target[j] - v) * e);
      svg.setAttribute('viewBox', ui.vb.join(' '));
      if (k < 1) ui.vbRaf = requestAnimationFrame(step);
    };
    ui.vbRaf = requestAnimationFrame(step);
  }

  // Cells along the water's path from valve to spout (for the win animation).
  function waterPath(b) {
    if (b.spout < 0) return [];
    const into = LP.step(b, b.spout, OPP[b.spoutDir || 'W']);
    const adj = (i) => {
      const p = b.cells[i];
      const out = [];
      for (const d of LP.openingsOf(p.card, p.flip)) {
        const n = LP.step(b, i, d);
        const q = n >= 0 && b.cells[n];
        if (q && q.card.kind !== 'cap' && LP.openingsOf(q.card, q.flip).includes(OPP[d])) out.push(n);
      }
      return out;
    };
    let best = null;
    const seen = new Set([b.valve]);
    let budget = 20000;
    (function dfs(i, path) {
      if (budget-- < 0) return;
      if (i === into) {
        if (!best || path.length > best.length) best = path.slice();
        return;
      }
      for (const n of adj(i)) {
        if (seen.has(n) || n === b.spout) continue;
        seen.add(n);
        path.push(n);
        dfs(n, path);
        path.pop();
        seen.delete(n);
      }
    })(b.valve, [b.valve]);
    return best ? best.concat([b.spout]) : [];
  }

  // ---- player colors (used on the shared table and in panel headers)
  const PCOLOR = ['#3aa0e6', '#e0874a', '#5fc58f', '#c58be0'];
  const shared = () => G() && G().table === 'shared';
  // Which players' pipelines are drawn on the surface that shows player v
  const surfaceOf = (v) => (shared() ? G().players.map((_, i) => i) : [v]);

  function badgeHTML(i, opts) {
    opts = opts || {};
    const g = G();
    const pl = g.players[i];
    const b = pl.board;
    const prog = Math.min(LP.progressOf(b), g.required);
    const leak = LP.leakAt(b) >= 0;
    const dead = g.phase !== 'over' && !LP.analyze(b, g.required).viable;
    const playing = live() && ui.busy && i === g.turn;
    const you = live() && i === ui.viewer && humans() === 1;
    const tags = [
      `<span class="wr${pl.wrenches ? '' : ' none'}" title="${pl.wrenches} wrench${pl.wrenches === 1 ? '' : 'es'} left">${ICON.wrench}${pl.wrenches}</span>`,
      leak ? `<span class="tag-leak">${ICON.drop}<span> leak</span></span>` : '',
      dead ? '<span class="tag-dead">dead end</span>' : '',
      g.winner === i ? '<span class="tag-win">winner</span>' : '',
      playing ? '<span class="thinking"><i></i><i></i><i></i></span>' : '',
    ].join('');
    return `<span class="dot" style="background:${PCOLOR[i % 4]}"></span><span class="nm">${esc(you && opts.main ? 'Your pipeline' : pl.name)}${pl.kind === 'bot' ? ' <small>CPU</small>' : ''}${pl.away ? ' <small>away</small>' : ''}</span>
      <span class="ct">${prog}<small>/${g.required}</small></span>
      <span class="bar"><i style="width:${(100 * prog) / g.required}%;background:${PCOLOR[i % 4]}"></i></span>
      <span class="tags">${tags}</span>`;
  }

  function renderChips() {
    const g = G();
    const el = $('chips');
    if (!shared()) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    const moves = selMoves();
    const playable = new Set(moves.map((m) => m.target));
    if (ui.wrench) playable.add(g.turn);
    el.innerHTML = g.players
      .map((pl, i) => {
        const cls = ['chip', (shared() ? i === ui.focus : i === ui.view) ? 'viewing' : '', i === g.turn && g.phase !== 'over' ? 'turn' : '', playable.has(i) ? 'can-play' : '', i === ui.flash ? 'flash' : '', ui.dragOver === -2 - i ? 'dragover' : ''].join(' ');
        return `<button type="button" class="${cls}" data-view="${i}" aria-pressed="${i === ui.view}">${badgeHTML(i)}</button>`;
      })
      .join('');
  }

  // Draw the pipelines of `players` into `svg`. opts: {main, aspect, view}
  function drawSurface(svg, players, opts) {
    const g = G();
    const boards = players.map((i) => g.players[i].board);
    const b = boards[0];
    const W = b.w * CW + (b.w - 1) * GAP;
    const H = b.h * CH + (b.h - 1) * GAP;
    const vb = opts.view;
    const pos = (i) => [(i % b.w) * (CW + GAP), Math.floor(i / b.w) * (CH + GAP)];
    const boxes = opts.main ? [ui.vb, ui.vbTarget].filter(Boolean) : [vb];
    const cx0 = Math.max(0, Math.floor(Math.min(...boxes.map((v) => v[0])) / (CW + GAP)) - 1);
    const cy0 = Math.max(0, Math.floor(Math.min(...boxes.map((v) => v[1])) / (CH + GAP)) - 1);
    const cx1 = Math.min(b.w - 1, Math.ceil(Math.max(...boxes.map((v) => v[0] + v[2])) / (CW + GAP)) + 1);
    const cy1 = Math.min(b.h - 1, Math.ceil(Math.max(...boxes.map((v) => v[1] + v[3])) / (CH + GAP)) + 1);
    const inView = (i) => {
      const x = i % b.w;
      const y = Math.floor(i / b.w);
      return x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1;
    };
    const tinted = shared();
    // targets for the selected card on these pipelines
    const targets = new Map();
    const want = ui.sel ? !!ui.flips[ui.sel] : false;
    for (const m of selMoves()) {
      if (!players.includes(m.target)) continue;
      const t = targets.get(m.i);
      const match = !!m.flip === want || isSymmetric(ui.sel);
      if (!t || (match && !t.solid)) targets.set(m.i, { move: m, solid: match });
    }
    if (ui.wrench && players.includes(g.turn)) {
      const lk = LP.leakAt(g.players[g.turn].board);
      if (lk >= 0) targets.set(lk, { move: null, solid: true });
    }
    let out = `<rect class="tableedge" x="-3" y="-3" width="${W + 6}" height="${H + 6}" rx="7"/>`;
    const owner = new Map();
    players.forEach((pi, k) => boards[k].cells.forEach((p, i) => p && owner.set(i, pi)));
    for (let i = 0; i < b.cells.length; i++) {
      if (!inView(i)) continue;
      const [x, y] = pos(i);
      const pi = owner.get(i);
      if (pi == null) {
        out += `<rect class="slot" x="${x + 1.5}" y="${y + 1.5}" width="${CW - 3}" height="${CH - 3}" rx="5"/>`;
        continue;
      }
      const bb = g.players[pi].board;
      const p = bb.cells[i];
      const used = p.card.kind === 'cap' ? new Set(LP.capsInUse(bb, i).map((u) => u.d)) : null;
      const pop = ui.anim && ui.anim.target === pi && ui.anim.i === i;
      const pouring = g.phase === 'over' && g.winner === pi;
      out += `<g transform="translate(${x} ${y})"><g class="${pop ? 'pop' : ''}">${cardArt(p, { usedCaps: used, pouring, mirror: p.card.kind === 'spout' && bb.spoutDir === 'E', tint: tinted ? PCOLOR[pi % 4] : null })}</g></g>`;
    }
    const card = ui.sel ? findCard(ui.sel) : null;
    for (const [i, t] of targets) {
      const [x, y] = pos(i);
      if (opts.main && t.move && card) {
        const f = t.solid ? want : !want;
        out += `<g transform="translate(${x} ${y})" class="cardghost${ui.dragOver === i ? ' over' : ''}">${cardArt({ card, flip: card.kind === 'pipe' && isSymmetric(ui.sel) ? false : f })}</g>`;
      }
      out += `<rect class="target${t.solid ? '' : ' flipneed'}${opts.main && ui.dragOver === i ? ' over' : ''}" x="${x + 1}" y="${y + 1}" width="${CW - 2}" height="${CH - 2}" rx="5"/>`;
    }
    players.forEach((pi, k) => {
      const bb = boards[k];
      const leak = LP.leakAt(bb);
      if (leak >= 0) {
        const [x, y] = pos(leak);
        out += `<rect class="leakring" x="${x - 1}" y="${y - 1}" width="${CW + 2}" height="${CH + 2}" rx="6"/>`;
      }
      if (live() && pi !== ui.viewer && g.phase !== 'over' && (opts.main || (card && card.kind === 'pipe' && card.mat === 'leaky'))) {
        const [x, y] = pos(bb.last);
        out += `<path class="lastmark" d="M${x + CW - 14},${y + 2} h12 v12 z"><title>Last card played</title></path>`;
      }
      if (g.phase === 'over' && g.winner === pi) {
        const path = waterPath(bb);
        if (path.length > 1) {
          const pts = path.map((i) => {
            const [x, y] = pos(i);
            return [x + 25, y + 35];
          });
          const [sx, sy] = pos(bb.spout);
          pts[pts.length - 1] = [sx + (bb.spoutDir === 'E' ? 27 : 23), sy + 50];
          let len = 0;
          for (let q = 1; q < pts.length; q++) len += Math.abs(pts[q][0] - pts[q - 1][0]) + Math.abs(pts[q][1] - pts[q - 1][1]);
          const d = 'M' + pts.map((q) => q.join(',')).join(' L');
          out += `<g style="--len:${len.toFixed(0)};--dur:${Math.min(4, 0.18 * path.length).toFixed(2)}s"><path class="water" d="${d}"/><path class="water-shine" d="${d}"/></g>`;
        }
      }
    });
    if (ui.botMark && players.includes(ui.botMark.target) && ui.botMark.seq === g.seq) {
      const [x, y] = pos(ui.botMark.i);
      out += `<rect class="botmark" x="${x - 2}" y="${y - 2}" width="${CW + 4}" height="${CH + 4}" rx="7"/>`;
    }
    if (opts.main && ui.hint && players.includes(ui.hint.target) && ui.hint.seq === g.seq && ui.hint.i != null) {
      const [x, y] = pos(ui.hint.i);
      out += `<rect class="hintmark" x="${x - 3}" y="${y - 3}" width="${CW + 6}" height="${CH + 6}" rx="8"/>`;
    }
    if (opts.main) {
      for (let i = 0; i < b.cells.length; i++) {
        if (!inView(i)) continue;
        const [x, y] = pos(i);
        out += `<rect class="hit${targets.has(i) ? ' go' : ''}" data-i="${i}" x="${x}" y="${y}" width="${CW}" height="${CH}"/>`;
      }
    }
    svg.innerHTML = out;
    return targets.size;
  }

  // Shared table camera: everything if it fits at a readable size, else follow the action.
  // Shared table camera: show every pipeline if the cards stay big enough to read; otherwise
  // follow the action: whoever is playing, plus wherever the selected card could go.
  function sharedView(aspect, wPx, hPx) {
    const g = G();
    const all = g.players.map((p) => p.board);
    const px = (v) => Math.min(wPx / v[2], hPx / v[3]) * CW;
    if (ui.fitAll) {
      return computeView(all, aspect, 8, 6);
    }
    const focus = ui.focus != null ? ui.focus : ui.busy || g.phase === 'over' ? (g.phase === 'over' && g.winner >= 0 ? g.winner : g.turn) : ui.viewer;
    const fb = [g.players[focus].board];
    if (ui.focus != null) return computeView(fb, aspect, 6, 5);
    const ms = selMoves().filter((m) => m.i != null);
    const extra = ms.map((m) => m.i);
    if (ui.botMark && ui.botMark.seq === g.seq) extra.push(ui.botMark.i);
    const own = ms.filter((m) => m.target === focus).map((m) => m.i);
    // a card that can only go on someone else: frame that pipeline instead of mine
    const away = !own.length && ms.length ? ms[0].target : -1;
    const near = away >= 0 ? computeView([g.players[away].board], aspect, 6, 5, ms.filter((m) => m.target === away).map((m) => m.i)) : computeView(fb, aspect, 6, 5, own);
    // most to least context; take the first that keeps cards readable
    const options = [computeView(all, aspect, 8, 6, extra), computeView(fb, aspect, 6, 5, extra), near];
    return options.find((v) => px(v) >= 28) || near;
  }

  function renderBoard() {
    const g = G();
    const svg = $('board');
    const wrap = $('boardwrap');
    const pl = g.players[ui.view];
    const aspect = Math.max(0.3, svg.clientWidth / Math.max(1, svg.clientHeight) || (wrap.clientWidth - 20) / Math.max(1, wrap.clientHeight - 60));
    const players = surfaceOf(ui.view);
    const view = shared() ? sharedView(aspect, svg.clientWidth || wrap.clientWidth, svg.clientHeight || wrap.clientHeight - 40) : computeView(pl.board, aspect);
    setViewBox(svg, view);
    svg.setAttribute('aria-label', shared() ? 'The shared table' : pl.name + "'s pipeline");
    $('mainhead').innerHTML = !live() ? '' : shared() ? `<span class="nm">Shared table</span>${ui.focus != null ? `<span class="following" style="--pc:${PCOLOR[ui.focus % 4]}">${esc(g.players[ui.focus].name)}</span>` : ''}<button type="button" class="ghost tiny" data-act="fit">${ui.fitAll || ui.focus != null ? 'Follow play' : 'Whole table'}</button>` : badgeHTML(ui.view, { main: true });
    $('mainhead').style.setProperty('--pc', PCOLOR[ui.view % 4]);
    drawSurface(svg, players, { main: true, view });
    renderOthers();
  }

  // Live panels for everyone not on the main board (Classic and Endless).
  function renderOthers() {
    const g = G();
    const el = $('others');
    if (!live() || shared()) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const moves = selMoves();
    const playable = new Set(moves.map((m) => m.target));
    const ids = g.players.map((_, i) => i).filter((i) => i !== ui.view);
    el.style.setProperty('--n', ids.length);
    el.innerHTML = ids
      .map((i) => {
        const cls = ['panel', 'mini', i === g.turn && g.phase !== 'over' ? 'turn' : '', playable.has(i) ? 'can-play' : '', i === ui.flash ? 'flash' : '', ui.dragOver === -2 - i ? 'dragover' : ''].join(' ');
        return `<button type="button" class="${cls}" data-view="${i}" aria-label="Show ${esc(g.players[i].name)}'s pipeline"><span class="phead">${badgeHTML(i)}</span><svg class="minisvg" data-mini="${i}" aria-hidden="true"></svg></button>`;
      })
      .join('');
    el.querySelectorAll('svg.minisvg').forEach((svg) => {
      const i = +svg.dataset.mini;
      const aspect = Math.max(0.4, svg.clientWidth / Math.max(1, svg.clientHeight) || 1.4);
      const view = computeView(g.players[i].board, aspect, 4, 3);
      svg.setAttribute('viewBox', view.join(' '));
      drawSurface(svg, [i], { main: false, view });
    });
  }

  function renderStatus() {
    const g = G();
    if (!live()) {
      $('status').innerHTML = '';
      return;
    }
    const cur = g.players[g.turn];
    let prompt;
    if (g.phase === 'over') prompt = g.winner >= 0 ? `${g.players[g.winner].name} connected the spout.` : 'Game over.';
    else if (ui.busy) prompt = `${cur.name} is playing…`;
    else if (g.phase === 'wrenchDiscard') prompt = 'Wrench placed. Pick a card to discard to finish your turn.';
    else if (ui.wrench) prompt = 'Tap the leaking card to put your wrench on it.';
    else if (ui.sel && findCard(ui.sel) && findCard(ui.sel).kind === 'wrench')
      prompt = LP.leakAt(cur.board) >= 0 ? 'Drag or tap the wrench card onto your leak. No extra discard needed.' : 'A wrench card fixes a leak on your pipeline. Keep it for when you need it, or discard it.';
    else if (ui.sel) {
      const ms = selMoves();
      const viewName = ui.view === g.turn ? 'your pipeline' : g.players[ui.view].name + "'s pipeline";
      const here = ms.filter((m) => m.target === ui.view).length;
      if (shared()) {
        const atk = ms.filter((m) => m.target !== g.turn).map((m) => g.players[m.target].name);
        prompt = !ms.length ? "That card can't be played right now. Discard it or pick another." : atk.length ? `Drag or tap it onto a glowing slot to hit ${[...new Set(atk)].join(' or ')}.` : 'Drag or tap onto a glowing slot. Tap the card again to turn it.';
      } else prompt = !ms.length ? "That card can't be played right now. Discard it or pick another." : here ? `Drag or tap onto a glowing slot on ${viewName}. Tap the card again to turn it.` : 'That card goes on another pipeline. Tap a board with a blue dot.';
    } else {
      const mine = g.players[g.turn].board;
      prompt = LP.leakAt(mine) >= 0 ? 'Your pipeline is leaking. Cover it with the same shape, use a wrench, or discard.' : `${humans() > 1 ? cur.name + ', your' : 'Your'} turn. Pick a card.`;
    }
    // Event lines: what others did since this player's last move. Each fades out after a while.
    const me = ui.viewer;
    const from = ui.since[me] != null ? ui.since[me] : -1;
    const now = performance.now();
    let events = g.phase === 'over' ? g.log.slice(-1) : g.log.filter((l) => l.n > from && l.p !== me);
    events = events.filter((l) => {
      if (!ui.shownAt.has(l.n)) ui.shownAt.set(l.n, now);
      return g.phase === 'over' || (now - ui.shownAt.get(l.n)) / 1000 < EVENT_SECS + 1;
    });
    const extra = Math.max(0, events.length - 3);
    const lines = events
      .slice(-3)
      .reverse()
      .map((l) => {
        const left = EVENT_SECS - (now - ui.shownAt.get(l.n)) / 1000;
        const keep = g.phase === 'over' ? ' keep' : '';
        return `<div class="log ${l.kind}${keep}" style="animation-delay:${left.toFixed(2)}s">${esc(l.text)}</div>`;
      });
    if (extra) lines.push(`<div class="log more" style="animation-delay:${EVENT_SECS}s">+${extra} more · tap for the full log</div>`);
    $('status').innerHTML = `<div class="prompt">${esc(prompt)}</div>` + lines.join('');
    clearTimeout(ui.statusTimer);
    if (events.length && g.phase !== 'over') ui.statusTimer = setTimeout(() => G() && renderStatus(), (EVENT_SECS + 1.2) * 1000);
  }

  function renderHand() {
    const g = G();
    const el = $('hand');
    if (!live()) {
      el.innerHTML = '';
      return;
    }
    if (ui.modal && ui.modal.type === 'pass') {
      el.innerHTML = '<div class="hidden">Cards hidden until the next player is ready.</div>';
      return;
    }
    const owner = g.players[ui.viewer];
    const myTurn = isHumanTurn() && g.turn === ui.viewer;
    el.innerHTML = owner.hand
      .map((c, k) => {
        const flip = !!ui.flips[c.id];
        const hinted = ui.hint && ui.hint.seq === g.seq && ui.hint.cardId === c.id;
        const deal = myTurn && g.drawn === c.id && ui.lastDealt !== c.id;
        if (deal) ui.lastDealt = c.id;
        const cls = ['hcard', ui.sel === c.id ? 'sel' : '', myTurn && g.drawn === c.id ? 'new' : '', deal ? 'deal' : '', myTurn ? '' : 'dim', hinted ? 'hinted' : '', ui.drag && ui.drag.active && ui.drag.id === c.id ? 'lifted' : ''].join(' ');
        return `<button type="button" class="${cls}" data-card="${c.id}" ${myTurn ? '' : 'disabled'} aria-pressed="${ui.sel === c.id}" aria-label="${esc(cardLabel(c, flip))}" title="${k + 1}"><span class="spin${flip ? ' flipped' : ''}">${cardSVG(c, false)}</span></button>`;
      })
      .join('');
  }

  function renderActions() {
    const g = G();
    if (!live()) {
      $('actions').innerHTML = '';
      return;
    }
    const myTurn = isHumanTurn();
    const me = g.players[g.turn];
    const c = ui.sel ? findCard(ui.sel) : null;
    const turnable = myTurn && canTurn(c) && g.phase === 'play';
    const leak = myTurn && LP.leakAt(me.board) >= 0;
    const canWrench = myTurn && g.phase === 'play' && leak && me.wrenches > 0;
    const discardLabel = g.phase === 'wrenchDiscard' ? 'Discard to finish' : 'Discard';
    const wrenchCount = me.kind === 'human' ? me.wrenches : g.players[ui.viewer].wrenches;
    $('actions').innerHTML =
      `<button type="button" class="btn" data-act="turn" ${turnable ? '' : 'disabled'} title="Turn card (R)">${ICON.turn}Turn</button>` +
      `<button type="button" class="btn" data-act="discard" ${myTurn && c ? '' : 'disabled'} title="Discard (D)">${ICON.bin}${discardLabel}</button>` +
      `<button type="button" class="btn ${ui.wrench ? 'on' : ''}" data-act="wrench" ${canWrench ? '' : 'disabled'} title="Wrench (W)">${ICON.wrench}Wrench ${wrenchCount}</button>` +
      (myTurn && !me.hand.length && g.phase === 'play'
        ? `<button type="button" class="btn primary" data-act="pass">Pass (no cards)</button>`
        : `<button type="button" class="btn" data-act="hint" ${myTurn ? '' : 'disabled'} title="Hint (H)">${ICON.bulb}Hint</button>`);
  }

  // ---------------------------------------------------------------- overlays
  function renderOverlay() {
    const o = $('overlay');
    const m = ui.modal;
    document.body.classList.toggle('has-modal', !!m);
    if (!m) {
      o.innerHTML = '';
      return;
    }
    if (m.type === 'setup') o.innerHTML = setupHTML();
    else if (m.type === 'pass') o.innerHTML = passHTML();
    else if (m.type === 'warn') o.innerHTML = warnHTML(m);
    else if (m.type === 'over') o.innerHTML = overHTML();
    else if (m.type === 'rules') o.innerHTML = rulesHTML();
    else if (m.type === 'menu') o.innerHTML = menuHTML();
    else if (m.type === 'log') o.innerHTML = logHTML();
    else if (m.type === 'online') o.innerHTML = onlineHTML();
    o.className = 'show-' + m.type;
    const first = o.querySelector('[data-focus]') || o.querySelector('button');
    if (first && !o.contains(document.activeElement)) first.focus({ preventScroll: true });
  }

  function heroCards() {
    const mk = (card, flip) => cardSVG(card, flip);
    return `<div class="hero-art" aria-hidden="true">${mk({ kind: 'spout' })}${mk({ kind: 'pipe', mat: 'iron', shape: 'H' })}${mk({ kind: 'pipe', mat: 'leaky', shape: 'L1' }, true)}${mk({ kind: 'pipe', mat: 'copper', shape: 'T1' })}${mk({ kind: 'pipe', mat: 'iron', shape: 'H' })}${mk({ kind: 'valve' })}</div>`;
  }

  const TABLE_NOTES = {
    classic: 'Classic: each player has their own table. The valve sits at the right edge and the spout pours left, as in the rulebook.',
    endless: 'Endless: each player has their own table with no edge. The valve sits in the middle and the spout can pour left or right, pointing away from your valve.',
    shared: 'Shared: everyone builds on one endless table, valves facing each other. Pipes can’t run into another pipeline or block the spot right in front of its open end, so space gets tight. The spout pours away from your valve.',
  };
  function setupHTML() {
    const s = ui.seats;
    const saved = loadSaved();
    const canResume = saved && saved.game.phase !== 'over' && !ui.game;
    const inGame = ui.game && ui.game.phase !== 'over';
    const need = LP.REQUIRED[s.length];
    const seats = s
      .map(
        (seat, i) => `<div class="seat">
        <input id="seat-name-${i}" value="${esc(seat.name)}" maxlength="14" aria-label="Player ${i + 1} name" data-seat="${i}" autocomplete="off">
        <span class="seg" role="group" aria-label="Player ${i + 1} type">
          <button type="button" class="${seat.kind === 'human' ? 'on' : ''}" data-kind="${i}:human">Person</button>
          <button type="button" class="${seat.kind === 'bot' ? 'on' : ''}" data-kind="${i}:bot">Computer</button>
        </span>
        ${s.length > 2 ? `<button type="button" class="x" data-remove="${i}" aria-label="Remove player ${i + 1}">×</button>` : '<span></span>'}
      </div>`
      )
      .join('');
    const hasHuman = s.some((x) => x.kind === 'human');
    const hasBot = s.some((x) => x.kind === 'bot');
    const lv = (k, label, note) => `<button type="button" class="${ui.level === k ? 'on' : ''}" data-level="${k}" title="${note}">${label}</button>`;
    return `<div class="sheet setup" role="dialog" aria-modal="true" aria-labelledby="setup-h">
      ${heroCards()}
      <h2 id="setup-h">Leaky <span>Pipes</span></h2>
      <p>Race to pipe water from your valve to your spout while everyone else springs leaks in your line. Classic Waterworks rules for 2 to 4 players.</p>
      ${canResume ? `<div class="row"><button type="button" class="btn primary" data-act="resume" data-focus>Resume saved game</button></div>` : ''}
      ${inGame ? `<div class="row"><button type="button" class="btn" data-act="close">Back to the current game</button></div>` : ''}
      ${serverUrl() && !inGame ? `<div class="row"><button type="button" class="btn" data-act="online">Play online with friends</button></div>` : ''}
      <h3>Players</h3>
      ${seats}
      <div class="row">${s.length < 4 ? '<button type="button" class="btn" data-act="add-seat">Add a player</button>' : ''}</div>
      ${hasBot ? `<div class="levelrow"><span>Computer skill</span><span class="seg" role="group" aria-label="Computer skill">${lv('easy', 'Easy', 'Makes casual mistakes')}${lv('normal', 'Normal', 'Solid, a little unpredictable')}${lv('hard', 'Hard', 'Its best self-play-tuned play')}</span></div>` : ''}
      <div class="levelrow"><span>Table</span><span class="seg" role="group" aria-label="Table">
        <button type="button" class="${ui.table === 'classic' ? 'on' : ''}" data-table="classic" title="Valve at the table's right edge, spout pours left">Classic</button>
        <button type="button" class="${ui.table === 'endless' ? 'on' : ''}" data-table="endless" title="No edges, valve in the middle">Endless</button>
        <button type="button" class="${ui.table === 'shared' ? 'on' : ''}" data-table="shared" title="Everyone builds on one table">Shared</button></span></div>
      <p class="muted">${TABLE_NOTES[ui.table] || TABLE_NOTES.classic}</p>
      <div class="levelrow"><span>Deck</span><span class="seg" role="group" aria-label="Deck">
        <button type="button" class="${ui.deck === 'classic' ? 'on' : ''}" data-deck="classic" title="The card mix as in the box">Original</button>
        <button type="button" class="${ui.deck === 'tuned' ? 'on' : ''}" data-deck="tuned" title="Remixed with self-play for less waiting">Tuned</button></span></div>
      <p class="muted">${ui.deck === 'tuned' ? 'Tuned: more elbows, few T’s, slightly fewer leaks, plus 6 wrench cards you can hold and play to fix a leak. Less time stuck waiting for one exact card.' : 'Original: the card mix from the box.'}</p>
      <p class="muted">${s.length} players · ${need} pipe cards to win. For pass-and-play, give each person a seat and pass the device between turns.</p>
      ${hasHuman ? '' : '<p class="muted warn">Add at least one person.</p>'}
      <div class="row end">
        <button type="button" class="btn" data-act="rules">How to play</button>
        <button type="button" class="btn ${canResume ? '' : 'primary'}" data-act="start" ${hasHuman ? '' : 'disabled'} ${canResume ? '' : 'data-focus'}>Start new game</button>
      </div>
    </div>`;
  }

  function passHTML() {
    const name = G().players[G().turn].name;
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pass-h">
      <h2 id="pass-h">Pass to <span>${esc(name)}</span></h2>
      <p>Hands are hidden so nobody peeks. ${esc(G().log.length ? G().log[G().log.length - 1].text : '')}</p>
      <div class="row end"><button type="button" class="btn primary" data-act="pass-ok" data-focus>I'm ${esc(name)}. Show my cards</button></div>
    </div>`;
  }

  function warnHTML(m) {
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="warn-h">
      <h2 id="warn-h">Dead end <span>ahead</span></h2>
      <p>${esc(m.text)}</p>
      <p class="muted">The rulebook lets you make this move. Once it's down, it can't be moved.</p>
      <div class="row end">
        <button type="button" class="btn" data-act="warn-no" data-focus>Pick something else</button>
        <button type="button" class="btn danger" data-act="warn-yes">Place it anyway</button>
      </div>
    </div>`;
  }

  function statsFor(g, i) {
    const name = g.players[i].name;
    const sprang = g.log.filter((l) => l.kind === 'attack' && l.p === i).length;
    const fixed = g.log.filter((l) => l.kind === 'repair' && l.p === i).length;
    const hit = g.log.filter((l) => l.kind === 'attack' && l.p !== i && (l.text.includes(' ' + name + "'s") || (name === 'You' && l.text.includes(' your ')))).length;
    return { sprang, fixed, hit };
  }

  function overHTML() {
    const g = G();
    const w = g.winner;
    const solo = humans() === 1;
    const humanWon = w >= 0 && g.players[w].kind === 'human';
    const title = w < 0 ? 'No <span>winner</span>' : humanWon && solo ? 'You <span>win!</span>' : `${esc(g.players[w].name)} <span>wins</span>`;
    const rounds = Math.ceil(g.turns / g.players.length);
    const rows = g.players
      .map((pl, i) => {
        const s = statsFor(g, i);
        return `<tr class="${i === w ? 'won' : ''}"><th scope="row">${esc(pl.name)}</th><td>${Math.min(LP.progressOf(pl.board), 99)}</td><td>${s.sprang}</td><td>${s.hit}</td><td>${s.fixed}</td></tr>`;
      })
      .join('');
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="over-h">
      <h2 id="over-h">${title}</h2>
      <p>${w >= 0 ? `Water's flowing: ${LP.progressOf(g.players[w].board)} pipes from valve to spout in ${rounds} rounds.` : 'Nobody could finish.'}</p>
      <table class="stats"><thead><tr><th></th><th>Pipes</th><th>Leaks sprung</th><th>Leaks taken</th><th>Repairs</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="row end">
        <button type="button" class="btn" data-act="see-board">Look at the table</button>
        <button type="button" class="btn" data-act="setup">${ui.net ? 'Leave' : 'Change players'}</button>
        ${ui.net && !netHost() ? '<button type="button" class="btn primary" disabled>Waiting for the host</button>' : '<button type="button" class="btn primary" data-act="again" data-focus>Play again</button>'}
      </div>
    </div>`;
  }

  function menuHTML() {
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="menu-h">
      <h2 id="menu-h">Menu</h2>
      <div class="row">
        <button type="button" class="btn" data-act="rules">How to play</button>
        <button type="button" class="btn" data-act="log">Game log</button>
        <button type="button" class="btn" data-act="setup">${ui.net ? 'Leave game' : 'New game'}</button>
        <button type="button" class="btn primary" data-act="close" data-focus>Back to the game</button>
      </div>
      <p class="muted">Shortcuts: 1–6 pick a card, R turns it, D discards, W wrench, H hint.</p>
    </div>`;
  }

  function logHTML() {
    const g = G();
    const items = g.log
      .slice()
      .reverse()
      .map((l) => `<li class="${l.kind}">${esc(l.text)}</li>`)
      .join('');
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="log-h">
      <h2 id="log-h">Game <span>log</span></h2>
      <ol class="loglist">${items}</ol>
      <div class="row end"><button type="button" class="btn primary" data-act="close" data-focus>Back to the game</button></div>
    </div>`;
  }

  function rulesHTML() {
    return `<div class="sheet rules" role="dialog" aria-modal="true" aria-labelledby="rules-h">
      <h2 id="rules-h">How to <span>play</span></h2>
      <h3>Goal</h3>
      <p>Build a leak-free line from your valve to your spout with at least 12, 10 or 8 pipe cards (2, 3 or 4 players). Caps don't count.</p>
      <h3>Your turn</h3>
      <p>You draw a card automatically. Then do one thing: add a good pipe (copper or iron) to your pipeline, put a leaky pipe or leaky cap on an opponent, repair a leak, or discard. You end with five cards. The other pipelines are shown live beside or below yours; tap one to bring it up big.</p>
      <h3>Placing</h3>
      <p>On the classic table the valve sits at the right edge and you build leftward. Cards stay upright; tap a selected card again (or Turn) to spin it 180°. Pipes must line up on every side, nothing may point off the table, and no card may completely block a pipeline. Loops are fine as long as the pipeline can keep going.</p>
      <h3>Leaks</h3>
      <p>A leaky card goes next to the last card of an opponent's pipeline (marked with a copper corner), or on top of it if that card is iron and exactly the same shape. Copper never leaks. One leak per pipeline at a time, and a repaired pipe can't leak again.</p>
      <h3>Repairs</h3>
      <p>Cover the leak with a good card of the same shape, or use one of your two wrenches and then discard a card. Until it's fixed you can't build, except to put a good cap on one end of a leaky T.</p>
      <h3>T's and caps</h3>
      <p>A T splits the water. Before you can win, cap one end or loop it back into the line. Caps that don't touch a pipe are ignored; a leaky cap in use has to be repaired. You can't cap your last open end.</p>
      <h3>Winning</h3>
      <p>When your line is long enough, leak-free, has no other open ends and its last pipe points left, the spout goes on automatically, pouring left and down. (On the endless table it can point left or right, as long as the spout points away from your valve.)</p>
      <h3>Playing well</h3>
      <p>From thousands of self-play games: spring a leak whenever you can't build; fix leaks fast and spend your wrenches; treat T pieces as discards; keep cards that fit where your pipe is heading; and turn your pipe to point left before the end, budgeting a card or two for the turns. Stuck? Tap Hint to see what the Hard computer would do.</p>
      <h3>Endless table</h3>
      <p>An optional mode with no table edge. The valve sits in the middle, so you can build in any direction, and the spout can pour left or right as long as it points away from your valve (the rulebook's "away and down from your faucet").</p>
      <h3>Shared table</h3>
      <p>Everyone builds on one table with no edges, with valves facing each other across the middle. You can't put a card on top of another pipeline, run an open pipe into it, or take the spot right in front of one of its open ends, and no card may leave another pipeline with no way to finish. Each pipeline's cards carry its player's color. The spout pours away from your valve. Tap a player to follow their part of the table, or Whole table to see everything.</p>
      <h3>Tuned deck</h3>
      <p>The default deck is a remix found with self-play: more elbows, very few T's, slightly fewer leaky pipes and six wrench cards. A wrench card sits in your hand like any other card. Play it on your leak to fix it; the card is your discard, so you don't give up a second card the way you do with one of your two wrenches. In the original mix, most of the time spent stuck is a leak you can't fix because you're out of wrenches and waiting for one exact card; the tuned deck cuts that waiting by about two thirds while keeping most of the sabotage. Pick Original on the setup screen for the boxed mix.</p>
      <h3>House rules in this app</h3>
      <p class="muted">A leak can't leave someone's pipeline with no way to finish (the rulebook doesn't cover this). You get a warning before a move that would do that to your own pipeline. Pipes can't be run into a cap card that's already down. Winning Moves doesn't publish its card mix, so the 110-card Original deck here is an estimate.</p>
      <div class="row end"><button type="button" class="btn primary" data-act="rules-close" data-focus>Got it</button></div>
    </div>`;
  }

  // ---------------------------------------------------------------- game flow
  function startGame(seats) {
    if (ui.net) netLeave(); // a local game replaces any online one
    ui.gen++;
    const players = seats.map((s, i) => ({ name: (s.name || '').trim() || (s.kind === 'bot' ? BOT_NAMES[i % 3] : 'Player ' + (i + 1)), kind: s.kind }));
    ui.game = LP.newGame({ players, table: ui.table, deck: ui.deck });
    ui.focus = null;
    ui.fitAll = false;
    ui.game.level = ui.level;
    ui.demo = null;
    ui.sel = null;
    ui.flips = {};
    ui.wrench = false;
    ui.busy = false;
    ui.modal = null;
    ui.hint = null;
    ui.vb = null;
    ui.since = {};
    ui.shownAt = new Map();
    const firstHuman = players.findIndex((p) => p.kind === 'human');
    ui.viewer = firstHuman;
    ui.view = firstHuman;
    save();
    proceed(true);
  }

  function proceed(fresh) {
    const g = G();
    if (!live()) return render();
    if (g.phase === 'over') {
      ui.busy = false;
      ui.view = g.winner >= 0 ? g.winner : ui.view;
      render();
      const humanWon = g.winner >= 0 && g.players[g.winner].kind === 'human';
      (humanWon ? sfx.win : sfx.lose)();
      const gen = ui.gen;
      setTimeout(() => {
        if (gen !== ui.gen) return;
        ui.modal = { type: 'over' };
        render();
      }, REDUCED ? 200 : 2600);
      return;
    }
    if (ui.net) {
      // online: the server moves everyone else; just wait for my turn
      ui.busy = g.turn !== ui.viewer;
      if (ui.busy) {
        ui.sel = null;
        ui.wrench = false;
      }
      return render();
    }
    const cur = g.players[g.turn];
    if (cur.kind === 'bot') {
      ui.busy = true;
      ui.sel = null;
      ui.wrench = false;
      render();
      const gen = ui.gen;
      setTimeout(() => gen === ui.gen && botStep(), fresh ? 450 : BOT_DELAY);
      return;
    }
    ui.busy = false;
    if (humans() > 1 && ui.viewer !== g.turn) {
      ui.modal = { type: 'pass' };
      return render();
    }
    const fromBot = ui.lastActor != null && g.players[ui.lastActor] && g.players[ui.lastActor].kind === 'bot';
    ui.viewer = g.turn;
    if (ui.view !== g.turn && !(ui.botMark && ui.botMark.target === ui.view)) ui.view = g.turn;
    else if (ui.view !== g.turn && fromBot) {
      // let the player see what the bot just did on that board for a beat
      const gen = ui.gen;
      setTimeout(() => {
        if (gen === ui.gen && isHumanTurn() && !ui.sel) {
          ui.view = g.turn;
          render();
        }
      }, 900);
    }
    render();
  }

  function botStep() {
    const g = G();
    if (!g || g.phase === 'over') return proceed();
    const p = g.turn;
    const bot = botFor(g.level || 'normal');
    const m = bot.chooseMove(g, p);
    let r = LP.applyMove(g, p, m);
    if (!r.ok) r = LP.applyMove(g, p, g.players[p].hand.length ? { type: 'discard', cardId: g.players[p].hand[0].id } : { type: 'pass' });
    ui.lastActor = p;
    if (m.type !== 'discard' && m.i != null) {
      const target = m.target != null ? m.target : p;
      ui.anim = { target, i: m.i };
      ui.botMark = { target, i: m.i, seq: g.seq };
      if (target !== p) {
        ui.flash = target;
        sfx.leak();
        if (target === ui.viewer) {
          toast(g.log[g.log.length - 1].text);
          ui.view = target;
        }
      } else if (m.type === 'wrench' || m.type === 'cover') sfx.repair();
      else sfx.place();
    }
    save();
    if (g.phase === 'wrenchDiscard') {
      render();
      const gen = ui.gen;
      setTimeout(() => gen === ui.gen && botStep(), 450);
      return;
    }
    proceed();
  }

  function play(m) {
    const g = G();
    const p = g.turn;
    if (ui.net) {
      netSend({ t: 'move', move: m });
      if (m.cardId) delete ui.flips[m.cardId];
      ui.sel = null;
      ui.wrench = false;
      ui.hint = null;
      ui.botMark = null;
      ui.focus = null;
      ui.busy = true; // until the server answers
      return render();
    }
    const r = LP.applyMove(g, p, m);
    if (!r.ok) {
      sfx.nope();
      toast(r.reason);
      return;
    }
    ui.lastActor = p;
    ui.since[p] = g.seq;
    if (m.type !== 'discard' && m.type !== 'pass') {
      const target = m.target != null ? m.target : p;
      ui.anim = { target, i: m.i };
      if (target !== p) sfx.leak();
      else if (m.type === 'wrench' || m.type === 'cover') sfx.repair();
      else sfx.place();
    }
    if (m.cardId) delete ui.flips[m.cardId];
    ui.sel = null;
    ui.wrench = false;
    ui.hint = null;
    ui.botMark = null;
    ui.focus = null;
    save();
    if (g.phase === 'wrenchDiscard') return render();
    proceed();
  }

  function tryCell(i) {
    const g = G();
    if (!isHumanTurn()) return;
    if (ui.wrench) {
      if ((shared() || ui.view === g.turn) && LP.leakAt(g.players[g.turn].board) === i) play({ type: 'wrench', i, target: g.turn });
      else {
        sfx.nope();
        toast('Tap the leaking card on your own pipeline.');
      }
      return;
    }
    if (!ui.sel) {
      const who = cellOwner(i);
      const p = who >= 0 ? g.players[who].board.cells[i] : null;
      if (p) toast((shared() ? (who === ui.viewer && humans() === 1 ? 'Yours: ' : g.players[who].name + ': ') : '') + cardLabel(p.card, p.flip).replace(/^./, (c) => c.toUpperCase()) + '.');
      return;
    }
    if (g.phase !== 'play') return;
    const want = !!ui.flips[ui.sel];
    const here = selMoves().filter((m) => (shared() || m.target === ui.view) && m.i === i);
    if (!here.length) {
      sfx.nope();
      toast(whyNot(i, want));
      return;
    }
    const m = here.find((x) => !!x.flip === want) || here[0];
    if (!!m.flip !== want) ui.flips[ui.sel] = !!m.flip;
    const warn = LP.deadEndWarning(g, g.turn, m);
    if (warn) {
      ui.modal = { type: 'warn', text: warn, move: m };
      return render();
    }
    play(m);
  }

  // Which pipeline a cell belongs to: the one whose card is there, or on the shared table the
  // one whose open end points at it. Falls back to the board on screen.
  function cellOwner(i) {
    const g = G();
    if (!shared()) return g.players[ui.view].board.cells[i] ? ui.view : -1;
    return g.players.findIndex((pl) => pl.board.cells[i]);
  }
  function aimedAt(i) {
    const g = G();
    const own = cellOwner(i);
    if (own >= 0) return own;
    if (!shared()) return ui.view;
    const card = findCard(ui.sel);
    const leaky = card && (card.kind === 'pipe' ? card.mat === 'leaky' : card.kind === 'cap' && LP.capHasLeak(card));
    const ends = g.players.map((pl, k) => (LP.openEnds(pl.board).some((e) => e.t === i) ? k : -1)).filter((k) => k >= 0);
    if (leaky) {
      const opp = ends.find((k) => k !== g.turn);
      if (opp != null) return opp;
    }
    return g.turn;
  }
  function whyNot(i, flip) {
    const g = G();
    const card = findCard(ui.sel);
    const tgt = aimedAt(i);
    const b = g.players[tgt].board;
    const occupied = !!b.cells[i];
    const type = occupied ? 'cover' : card.kind === 'cap' ? 'cap' : 'pipe';
    const r = LP.checkMove(g, g.turn, { type, cardId: ui.sel, target: tgt, i, flip });
    if (r.ok) return 'Try turning the card.';
    if (!occupied && !LP.openEnds(b).some((e) => e.t === i)) return 'Cards have to attach to an open pipe end.';
    return r.reason;
  }

  function selectCard(id) {
    const g = G();
    if (!isHumanTurn()) return;
    ui.wrench = false;
    if (ui.sel === id) {
      const c = findCard(id);
      if (g.phase === 'play' && canTurn(c)) {
        ui.flips[id] = !ui.flips[id];
        sfx.pick();
      } else ui.sel = null;
      return render();
    }
    ui.sel = id;
    sfx.pick();
    if (g.phase === 'play') {
      const ms = selMoves();
      if (ms.length && !ms.some((m) => m.target === ui.view)) ui.view = ms[0].target;
    }
    render();
  }

  function showHint() {
    const g = G();
    if (!isHumanTurn()) return;
    // online, other hands are hidden from this page, so the hint uses the bot that only needs mine
    const m = (ui.net ? ui.hintBot || (ui.hintBot = LP.bot.makeBot()) : botFor('hard')).chooseMove(g, g.turn);
    ui.hint = { seq: g.seq, cardId: m.cardId, target: m.target != null ? m.target : g.turn, i: m.i };
    ui.wrench = false;
    if (m.type === 'pass') {
      toast('Hint: you have no cards, so pass.');
      return render();
    }
    if (m.type === 'discard') {
      ui.sel = m.cardId;
      toast(g.phase === 'wrenchDiscard' ? 'Hint: discard the highlighted card.' : 'Hint: nothing good to play. Discard the highlighted card.');
    } else if (m.type === 'wrench' && !m.cardId) {
      ui.sel = null;
      ui.wrench = true;
      ui.view = g.turn;
      toast('Hint: use a wrench on the leak.');
    } else {
      ui.sel = m.cardId;
      ui.flips[m.cardId] = !!m.flip;
      ui.view = ui.hint.target;
      const c = findCard(m.cardId);
      toast(m.target !== g.turn ? `Hint: hit ${g.players[m.target].name} with that ${LP.describeCard(c)}.` : m.type === 'cover' ? 'Hint: cover the leak with that card.' : 'Hint: play the highlighted card on the marked slot.');
    }
    render();
  }

  // ---------------------------------------------------------------- drag and drop from the hand
  // The hand is never re-rendered mid-drag: on iPad Safari, removing the touched element stops its
  // pointer events from reaching the document, which used to strand the floating card on screen.
  // The pointer is also captured by <body> once a drag starts, and stray ghosts are swept up.
  function renderDuringDrag() {
    renderMeta();
    renderChips();
    renderBoard();
    renderStatus();
    renderActions();
  }
  function clearGhosts() {
    document.querySelectorAll('.dragghost').forEach((el) => el.remove());
    document.querySelectorAll('.hcard.lifted').forEach((el) => el.classList.remove('lifted'));
  }
  document.addEventListener('pointerdown', (ev) => {
    if (ui.drag) cancelDrag();
    const card = ev.target.closest && ev.target.closest('.hcard');
    if (!card || card.disabled || !isHumanTurn()) return;
    ui.drag = { id: card.dataset.card, x: ev.clientX, y: ev.clientY, active: false, pid: ev.pointerId, btn: card };
  });
  document.addEventListener('pointermove', (ev) => {
    const d = ui.drag;
    if (!d || ev.pointerId !== d.pid) return;
    if (!d.active) {
      if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 10) return;
      d.active = true;
      try {
        document.body.setPointerCapture(d.pid);
      } catch (e) {
        /* capture unsupported: document listeners still work */
      }
      if (ui.sel !== d.id) {
        ui.sel = d.id;
        if (G().phase === 'play') {
          const ms = selMoves();
          if (ms.length && !ms.some((m) => m.target === ui.view)) ui.view = ms[0].target;
        }
      }
      clearGhosts();
      const c = findCard(d.id);
      const gh = document.createElement('div');
      gh.className = 'dragghost';
      gh.innerHTML = cardSVG(c, !!ui.flips[d.id]);
      document.body.appendChild(gh);
      d.el = gh;
      document.querySelectorAll('.hcard.sel').forEach((el) => el.classList.remove('sel'));
      if (d.btn) d.btn.classList.add('sel', 'lifted');
      renderDuringDrag();
    }
    d.el.style.transform = `translate(${ev.clientX - 30}px, ${ev.clientY - 60}px) rotate(-4deg)`;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    let over = -1;
    const hit = under && under.closest && under.closest('#board [data-i]');
    const chip = under && under.closest && under.closest('[data-view]');
    // Hovering another player's panel swaps it onto the main board. After a swap the panel under
    // the pointer shows someone else, so swapping stays off until the pointer is back on the board.
    if (under && under.closest && under.closest('#boardwrap')) d.armed = true;
    if (hit) over = +hit.dataset.i;
    else if (chip && d.armed !== false) {
      const v = +chip.dataset.view;
      if (shared()) {
        if (ui.focus !== v) {
          ui.focus = v;
          ui.fitAll = false;
          renderDuringDrag();
        }
      } else if (v !== ui.view) {
        ui.view = v;
        ui.dragOver = -1;
        d.armed = false;
        renderDuringDrag();
        return;
      }
    }
    if (over !== ui.dragOver) {
      ui.dragOver = over;
      renderBoard();
    }
  });
  function cancelDrag() {
    const d = ui.drag;
    ui.drag = null;
    ui.dragOver = -1;
    clearGhosts();
    if (d && d.active) render();
  }
  function endDrag(ev) {
    const d = ui.drag;
    if (d && ev.pointerId != null && ev.pointerId !== d.pid) return;
    ui.drag = null;
    clearGhosts();
    if (!d || !d.active) return;
    try {
      document.body.releasePointerCapture(d.pid);
    } catch (e) {
      /* already released */
    }
    ui.suppressClick = true;
    setTimeout(() => (ui.suppressClick = false), 50);
    const over = ui.dragOver;
    ui.dragOver = -1;
    if (ev.type === 'pointerup' && over >= 0) tryCell(over);
    else render();
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  document.addEventListener('lostpointercapture', (ev) => {
    if (ui.drag && ui.drag.active && ev.pointerId === ui.drag.pid) endDrag({ type: 'pointercancel', pointerId: ev.pointerId });
  });
  window.addEventListener('blur', () => ui.drag && cancelDrag());
  document.addEventListener('visibilitychange', () => document.hidden && ui.drag && cancelDrag());

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (ev) => {
    if (ui.suppressClick) return;
    const t = ev.target.closest('[data-act],[data-card],[data-view],[data-i],[data-kind],[data-remove],[data-level],[data-table],[data-deck],[data-netremove]');
    if (!t) return;
    audio();
    if (t.dataset.i != null && t.closest('#board')) return tryCell(+t.dataset.i);
    if (t.dataset.view != null) {
      if (shared()) {
        const v = +t.dataset.view;
        ui.focus = ui.focus === v ? null : v;
        ui.fitAll = false;
      } else ui.view = +t.dataset.view;
      return render();
    }
    if (t.dataset.card) return selectCard(t.dataset.card);
    if (t.dataset.table) {
      readSeatNames();
      ui.table = t.dataset.table;
      savePrefs();
      return renderOverlay();
    }
    if (t.dataset.netremove != null) return netSend({ t: 'remove', seat: +t.dataset.netremove });
    if (t.dataset.deck) {
      readSeatNames();
      ui.deck = t.dataset.deck;
      savePrefs();
      return renderOverlay();
    }
    if (t.dataset.level) {
      ui.level = t.dataset.level;
      savePrefs();
      return renderOverlay();
    }
    if (t.dataset.kind) {
      readSeatNames();
      const [i, k] = t.dataset.kind.split(':');
      const seat = ui.seats[+i];
      if (seat.kind !== k) {
        seat.kind = k;
        if (k === 'bot' && (/^(You|Player \d)$/.test(seat.name) || !seat.name)) seat.name = BOT_NAMES[(+i + 2) % 3];
        if (k === 'human' && BOT_NAMES.includes(seat.name)) seat.name = 'Player ' + (+i + 1);
      }
      return renderOverlay();
    }
    if (t.dataset.remove) {
      readSeatNames();
      ui.seats.splice(+t.dataset.remove, 1);
      return renderOverlay();
    }
    const act = t.dataset.act;
    const g = G();
    switch (act) {
      case 'turn':
        if (ui.sel) {
          ui.flips[ui.sel] = !ui.flips[ui.sel];
          sfx.pick();
        }
        return render();
      case 'discard':
        if (ui.sel && isHumanTurn()) play({ type: 'discard', cardId: ui.sel });
        return;
      case 'wrench':
        ui.wrench = !ui.wrench;
        ui.sel = null;
        if (ui.wrench) ui.view = g.turn;
        return render();
      case 'hint':
        return showHint();
      case 'fit':
        ui.fitAll = !(ui.fitAll || ui.focus != null);
        ui.focus = null;
        return render();
      case 'pass':
        return play({ type: 'pass' });
      case 'add-seat': {
        readSeatNames();
        const n = ui.seats.length;
        ui.seats.push({ name: BOT_NAMES[(n - 1) % 3], kind: 'bot' });
        return renderOverlay();
      }
      case 'start':
        readSeatNames();
        return startGame(ui.seats);
      case 'resume': {
        const d = loadSaved();
        if (!d) return;
        if (ui.net) netLeave();
        ui.gen++;
        ui.game = d.game;
        ui.demo = null;
        ui.seats = d.seats || ui.seats;
        ui.viewer = d.viewer || 0;
        ui.since = d.since || {};
        ui.shownAt = new Map();
        ui.view = ui.viewer;
        ui.modal = null;
        ui.vb = null;
        return proceed(true);
      }
      case 'rules':
        readSeatNames();
        ui.modal = { type: 'rules', back: ui.modal };
        return render();
      case 'rules-close':
        return closeModal();
      case 'log':
        ui.modal = { type: 'log' };
        return render();
      case 'online':
        readSeatNames();
        ui.modal = { type: 'online' };
        return render();
      case 'net-create':
        return netBegin({ t: 'create', name: netName(), opts: { table: ui.table, deck: ui.deck, level: ui.level } });
      case 'net-join': {
        const code = (($('net-code') || {}).value || '').toUpperCase().trim();
        if (code.length !== 4) return toast('Enter the 4-letter game code.');
        return netBegin({ t: 'join', code, name: netName() });
      }
      case 'net-addbot':
        return netSend({ t: 'addbot' });
      case 'net-start':
        return netSend({ t: 'start' });
      case 'net-copy':
        return netCopyLink();
      case 'net-leave':
        netLeave();
        ui.modal = { type: 'setup' };
        return render();
      case 'setup':
        if (ui.net) netLeave();
        ui.gen++;
        ui.busy = false;
        ui.modal = { type: 'setup' };
        return render();
      case 'close':
        return closeModal();
      case 'pass-ok':
        ui.modal = null;
        ui.viewer = g.turn;
        ui.view = g.turn;
        return render();
      case 'warn-no':
        ui.modal = null;
        return render();
      case 'warn-yes': {
        const m = ui.modal.move;
        ui.modal = null;
        return play(m);
      }
      case 'again':
        if (ui.net) return netSend({ t: 'again' });
        ui.seats = G().players.map((p) => ({ name: p.name, kind: p.kind }));
        return startGame(ui.seats);
      case 'see-board':
        ui.modal = null;
        return render();
    }
  });
  $('menuBtn').addEventListener('click', () => {
    if (!live()) {
      ui.modal = { type: 'setup' };
      return render();
    }
    if (ui.modal && ui.modal.type === 'over') return;
    ui.gen++; // pause bots while the menu is open
    ui.busy = false;
    ui.modal = G().phase === 'over' ? { type: 'over' } : { type: 'menu' };
    render();
  });
  $('soundBtn').addEventListener('click', () => {
    ui.sound = !ui.sound;
    savePrefs();
    if (ui.sound) sfx.place();
    renderMeta();
  });
  $('status').addEventListener('click', () => {
    if (!live() || ui.modal) return;
    ui.gen++;
    ui.busy = false;
    ui.modal = { type: 'log' };
    render();
  });
  document.addEventListener('input', (ev) => {
    const i = ev.target.dataset && ev.target.dataset.seat;
    if (i != null) ui.seats[+i].name = ev.target.value;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.target && ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Escape' && ui.modal && ['rules', 'menu', 'warn', 'log'].includes(ui.modal.type)) return closeModal();
    if (!isHumanTurn()) return;
    const g = G();
    const hand = g.players[ui.viewer].hand;
    if (/^[1-6]$/.test(ev.key) && hand[+ev.key - 1]) return selectCard(hand[+ev.key - 1].id);
    const k = ev.key.toLowerCase();
    if (k === 'r' && ui.sel) {
      ui.flips[ui.sel] = !ui.flips[ui.sel];
      return render();
    }
    if (k === 'd' && ui.sel) return play({ type: 'discard', cardId: ui.sel });
    if (k === 'h') return showHint();
    if (k === 'w' && LP.leakAt(g.players[g.turn].board) >= 0 && g.players[g.turn].wrenches > 0) {
      ui.wrench = !ui.wrench;
      ui.view = g.turn;
      return render();
    }
  });
  function readSeatNames() {
    document.querySelectorAll('[data-seat]').forEach((inp) => {
      ui.seats[+inp.dataset.seat].name = inp.value;
    });
  }
  window.addEventListener('resize', () => G() && renderBoard());

  // ---------------------------------------------------------------- online play
  // Needs a game server (server/server.js). The page learns its address from, in order: the
  // server that served it, a ?server= link, a saved address, or one baked in at build time.
  // Without one, none of this shows and the game is the same static page as ever.
  const NET_KEY = 'leaky-pipes-online-v1';
  const BUILT_SERVER = '__LEAKY_SERVER__';
  const QS = new URLSearchParams(location.search);
  function serverUrl() {
    let u = window.LEAKY_SERVER || QS.get('server') || '';
    try {
      if (QS.get('server')) localStorage.setItem('leaky-pipes-server', QS.get('server'));
      if (!u) u = localStorage.getItem('leaky-pipes-server') || '';
    } catch (e) {
      /* no storage */
    }
    if (!u && BUILT_SERVER.indexOf('LEAKY_SERVER') < 0) u = BUILT_SERVER;
    return u.replace(/^http/, 'ws').replace(/\/+$/, '');
  }
  const netStore = (v) => {
    try {
      if (v) localStorage.setItem(NET_KEY, JSON.stringify(v));
      else localStorage.removeItem(NET_KEY);
    } catch (e) {
      /* no storage */
    }
  };
  const netStored = () => {
    try {
      return JSON.parse(localStorage.getItem(NET_KEY) || 'null');
    } catch (e) {
      return null;
    }
  };
  const netHost = () => !!(ui.net && ui.net.room && ui.net.room.host === ui.net.room.seat);
  function netName() {
    const el = $('net-name');
    const n = ((el && el.value) || ui.netName || '').trim().slice(0, 14);
    ui.netName = n;
    try {
      localStorage.setItem('leaky-pipes-name', n);
    } catch (e) {
      /* no storage */
    }
    return n;
  }
  function netSend(msg) {
    const n = ui.net;
    if (n && n.ws && n.ws.readyState === 1) n.ws.send(JSON.stringify(msg));
    else toast('Not connected. Reconnecting…');
  }
  // Open a connection and send `first` (create / join / resume) once it is up.
  function netBegin(first) {
    if (ui.net && ui.net.ws) {
      ui.net.ws.onclose = null;
      ui.net.ws.close();
    }
    const n = (ui.net = Object.assign(ui.net || { room: null, tries: 0 }, { status: 'connecting', first }));
    let ws;
    try {
      ws = new WebSocket(serverUrl());
    } catch (e) {
      n.status = 'failed';
      return render();
    }
    n.ws = ws;
    ws.onopen = () => {
      n.status = 'open';
      n.tries = 0;
      ws.send(JSON.stringify(n.first));
      renderOverlay();
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      netMessage(m);
    };
    ws.onclose = () => {
      if (ui.net !== n) return;
      if (!n.code) {
        // never got into a game
        ui.net = null;
        toast("Couldn't reach the game server.");
        return render();
      }
      n.status = 'reconnecting';
      render();
      clearTimeout(n.retry);
      n.retry = setTimeout(() => ui.net === n && netBegin({ t: 'resume', code: n.code, token: n.token }), Math.min(8000, 600 * Math.pow(2, n.tries++)));
    };
    render();
  }
  function netLeave() {
    const n = ui.net;
    if (!n) return;
    clearTimeout(n.retry);
    ui.net = null;
    netStore(null);
    if (n.ws) {
      n.ws.onclose = null;
      try {
        if (n.ws.readyState === 1) n.ws.send(JSON.stringify({ t: 'leave' }));
        n.ws.close();
      } catch (e) {
        /* already closed */
      }
    }
    ui.gen++;
    ui.game = null;
    ui.busy = false;
    ui.sel = null;
    ui.vb = null;
    ui.view = 0;
    ui.viewer = 0;
  }
  function netMessage(m) {
    const n = ui.net;
    if (!n) return;
    if (m.t === 'joined') {
      n.code = m.code;
      n.token = m.token;
      netStore({ code: m.code, token: m.token, server: serverUrl() });
      return;
    }
    if (m.t === 'room') {
      n.room = m;
      if (!m.started && !ui.game) ui.modal = { type: 'online' };
      return ui.modal && ui.modal.type === 'online' ? renderOverlay() : render();
    }
    if (m.t === 'gone') {
      netLeave();
      ui.modal = { type: 'setup' };
      toast(m.text || 'That game is no longer available.');
      return render();
    }
    if (m.t === 'error') {
      sfx.nope();
      toast(m.text);
      if (ui.game) ui.busy = ui.game.turn !== ui.viewer || ui.game.phase === 'over';
      return render();
    }
    if (m.t === 'state') {
      const prev = ui.game;
      const g = m.game;
      const seat = n.room ? n.room.seat : 0;
      const fresh = !n.gotState || !prev || g.seq < prev.seq || g.turns < prev.turns;
      const stillOver = !fresh && prev.phase === 'over' && g.phase === 'over';
      n.gotState = true;
      ui.game = g;
      ui.demo = null;
      ui.viewer = seat;
      if (fresh) {
        ui.gen++;
        ui.view = seat;
        ui.sel = null;
        ui.flips = {};
        ui.wrench = false;
        ui.hint = null;
        ui.vb = null;
        ui.focus = null;
        ui.fitAll = false;
        ui.since = {};
        ui.shownAt = new Map();
        ui.botMark = null;
        ui.modal = null;
      } else if (ui.modal && ui.modal.type === 'online') ui.modal = null;
      const ev = m.ev;
      if (ev && ev.move) {
        const mv = ev.move;
        ui.lastActor = ev.p;
        if (ev.p === seat) ui.since[seat] = g.seq;
        if (mv.type !== 'discard' && mv.type !== 'pass' && mv.i != null) {
          const target = mv.target != null ? mv.target : ev.p;
          ui.anim = { target, i: mv.i };
          if (ev.p !== seat) ui.botMark = { target, i: mv.i, seq: g.seq };
          if (target !== ev.p) {
            ui.flash = target;
            sfx.leak();
            if (target === seat && ev.p !== seat) {
              toast(g.log[g.log.length - 1].text);
              ui.view = seat;
            }
          } else if (mv.type === 'wrench' || mv.type === 'cover') sfx.repair();
          else sfx.place();
        }
      }
      if (g.phase !== 'over' && g.turn === seat && ui.view !== seat && !(ui.botMark && ui.botMark.target === ui.view)) ui.view = seat;
      if (ui.modal && ui.modal.type === 'over' && g.phase !== 'over') ui.modal = null;
      return ui.modal || stillOver ? render() : proceed();
    }
  }
  function netCopyLink() {
    const n = ui.net;
    if (!n || !n.code) return;
    const u = new URL(location.href.split('?')[0]);
    u.searchParams.set('room', n.code);
    if (!window.LEAKY_SERVER && BUILT_SERVER.indexOf('LEAKY_SERVER') >= 0) u.searchParams.set('server', serverUrl());
    const done = () => toast('Invite link copied.');
    if (navigator.share && /Mobi|Android|iPad|iPhone/.test(navigator.userAgent)) return navigator.share({ title: 'Leaky Pipes', text: 'Join my Leaky Pipes game: ' + n.code, url: u.href }).catch(() => {});
    if (navigator.clipboard) return navigator.clipboard.writeText(u.href).then(done, () => toast(u.href));
    toast(u.href);
  }
  const OPT_LABEL = { classic: 'Classic table', endless: 'Endless table', shared: 'Shared table' };
  function onlineHTML() {
    const n = ui.net;
    const room = n && n.room;
    if (!room) {
      const busy = n && n.status === 'connecting';
      const code = (ui.modal && ui.modal.code) || '';
      return `<div class="sheet setup online" role="dialog" aria-modal="true" aria-labelledby="on-h">
        <h2 id="on-h">Play <span>online</span></h2>
        <p>Everyone plays in their own browser. One person creates a game and shares the 4-letter code.</p>
        <label class="field"><span>Your name</span><input id="net-name" maxlength="14" autocomplete="off" value="${esc(ui.netName || '')}" placeholder="Your name" ${code ? '' : 'data-focus'}></label>
        <h3>Join a game</h3>
        <div class="joinrow"><input id="net-code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" value="${esc(code)}" aria-label="Game code"><button type="button" class="btn ${code ? 'primary' : ''}" data-act="net-join" ${busy ? 'disabled' : ''} ${code ? 'data-focus' : ''}>Join</button></div>
        <h3>Or start one</h3>
        <p class="muted">${OPT_LABEL[ui.table]} · ${ui.deck === 'tuned' ? 'Tuned' : 'Original'} deck. Change these on the previous screen.</p>
        <div class="row end">
          <button type="button" class="btn" data-act="net-leave">Back</button>
          <button type="button" class="btn ${code ? '' : 'primary'}" data-act="net-create" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Create a game'}</button>
        </div>
      </div>`;
    }
    const host = room.host === room.seat;
    const seats = room.seats
      .map(
        (s, i) => `<div class="seat netseat"><span class="dot" style="background:${PCOLOR[i % 4]}"></span><span class="nm">${esc(s.name)}${i === room.seat ? ' <small>you</small>' : ''}${s.kind === 'bot' ? ' <small>computer</small>' : ''}${i === room.host ? ' <small>host</small>' : ''}${s.online ? '' : ' <small>away</small>'}</span>${host && i !== room.seat ? `<button type="button" class="x" data-netremove="${i}" aria-label="Remove ${esc(s.name)}">×</button>` : '<span></span>'}</div>`
      )
      .join('');
    return `<div class="sheet setup online" role="dialog" aria-modal="true" aria-labelledby="on-h">
      <h2 id="on-h">Game <span class="code">${esc(room.code)}</span></h2>
      <p>${host ? 'Share this code or the invite link. Start when everyone is in.' : `Waiting for ${esc(room.seats[room.host] ? room.seats[room.host].name : 'the host')} to start the game.`}${n.status === 'reconnecting' ? ' <b>Reconnecting…</b>' : ''}</p>
      <div class="row"><button type="button" class="btn" data-act="net-copy">Copy invite link</button></div>
      <h3>Players</h3>
      ${seats}
      <p class="muted">${room.seats.length} of 4 seats · ${OPT_LABEL[room.opts.table]} · ${room.opts.deck === 'tuned' ? 'Tuned' : 'Original'} deck${room.seats.some((s) => s.kind === 'bot') ? ' · Computers: ' + room.opts.level : ''}</p>
      <div class="row end">
        <button type="button" class="btn" data-act="net-leave">Leave</button>
        ${host && room.seats.length < 4 ? '<button type="button" class="btn" data-act="net-addbot">Add a computer</button>' : ''}
        ${host ? `<button type="button" class="btn primary" data-act="net-start" ${room.seats.length < 2 ? 'disabled' : 'data-focus'}>Start game</button>` : ''}
      </div>
    </div>`;
  }
  document.addEventListener('visibilitychange', () => {
    const n = ui.net;
    if (!document.hidden && n && n.code && (!n.ws || n.ws.readyState > 1)) {
      clearTimeout(n.retry);
      netBegin({ t: 'resume', code: n.code, token: n.token });
    }
  });

  // ---------------------------------------------------------------- boot
  const saved = loadSaved();
  if (saved && saved.seats) ui.seats = saved.seats;
  if (saved && saved.level) ui.level = saved.level;
  // A table mid-game behind the setup sheet, so the first screen isn't empty.
  try {
    const demo = LP.newGame({ players: [{ name: 'Rusty', kind: 'bot' }, { name: 'Gasket', kind: 'bot' }], seed: 20261031 });
    const bot = LP.bot.forLevel('normal');
    for (let k = 0; k < 34 && demo.phase !== 'over'; k++) LP.applyMove(demo, demo.turn, bot.chooseMove(demo, demo.turn));
    ui.demo = demo;
    ui.view = 0;
  } catch (e) {
    ui.demo = null;
  }
  ui.modal = { type: 'setup' };
  try {
    ui.netName = localStorage.getItem('leaky-pipes-name') || '';
  } catch (e) {
    ui.netName = '';
  }
  if (serverUrl()) {
    const back = netStored();
    const room = (QS.get('room') || '').toUpperCase().slice(0, 4);
    if (back && back.code && back.server === serverUrl() && (!room || room === back.code)) {
      // pick up the online game this browser was in
      ui.net = { room: null, tries: 0, code: back.code, token: back.token };
      netBegin({ t: 'resume', code: back.code, token: back.token });
    } else if (room) ui.modal = { type: 'online', code: room };
  }
  render();
  window.__leaky = ui;
  window.__leakyStart = (seats) => startGame(seats);
  window.__leakyRender = () => render();
  window.__leakyProceed = () => proceed();
  window.__leakyPlay = (m) => play(m);
})();
