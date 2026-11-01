(function () {
  'use strict';
  const LP = window.LP;
  const OPP = LP.OPP;
  const SAVE_KEY = 'leaky-pipes-v1';
  const BOT_NAMES = ['Rusty', 'Gasket', 'Spigot'];
  const CW = 50;
  const CH = 70;
  const GAP = 3;
  const BOT_DELAY = 750;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ui = {
    game: null,
    seats: [
      { name: 'You', kind: 'human' },
      { name: 'Rusty', kind: 'bot' },
    ],
    view: 0,
    viewer: 0,
    sel: null,
    flips: {},
    wrench: false,
    busy: false,
    modal: null,
    gen: 0,
    flash: -1,
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
  function drop(x, y, s) {
    s = s || 1;
    return `<path d="M${x},${y - 4 * s} C${x + 3 * s},${y} ${x + 3 * s},${y + 3 * s} ${x},${y + 3 * s} C${x - 3 * s},${y + 3 * s} ${x - 3 * s},${y} ${x},${y - 4 * s}Z" fill="#3aa0e6" stroke="#e9f6ff" stroke-width=".6"/>`;
  }
  function spray(op) {
    // spray away from the pipe arms
    const free = ['N', 'E', 'S', 'W'].filter((d) => !op.includes(d));
    const d = free[0] || 'N';
    const off = { N: [[19, 12], [27, 7], [33, 14], [24, 17]], S: [[19, 56], [27, 62], [33, 55], [24, 52]], E: [[38, 26], [44, 33], [40, 42], [35, 34]], W: [[12, 26], [6, 33], [10, 42], [15, 34]] }[d];
    return off.map(([x, y], k) => drop(x, y, k % 2 ? 0.8 : 1.05)).join('') + `<path d="M21,31 L25,35 L23,38 L28,41" fill="none" stroke="#1d272e" stroke-width="1.6"/>`;
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
      const dr = mat === 'leaky' ? { N: drop(25, 26) + drop(30, 30, 0.7), S: drop(25, 46) + drop(20, 42, 0.7), E: drop(26, 30) + drop(24, 38, 0.7), W: drop(24, 30) + drop(26, 38, 0.7) }[d] : '';
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
  function spoutArt() {
    const m = MAT.copper;
    return (
      tube('M50,35 L36,35 Q23,35 23,48 L23,51', m) +
      ring('E', m) +
      `<rect x="16" y="50" width="14" height="9" rx="1.5" fill="${m.r}" stroke="${m.o}"/>` +
      `<path d="M17,53 H29 M17,56 H29" stroke="${m.o}" stroke-width=".8"/>` +
      drop(20, 64, 0.9) + drop(26, 66, 0.8) + drop(23, 69, 0.6)
    );
  }
  // piece: {card, flip, repaired, wrench}; opts.usedCaps (Set) for cap cards on a board
  function cardArt(piece, opts) {
    opts = opts || {};
    const c = piece.card;
    let s = face();
    if (c.kind === 'valve') return s + valveArt();
    if (c.kind === 'spout') return s + spoutArt();
    if (c.kind === 'cap') return s + capArt(c, piece.flip, opts.usedCaps) + (piece.wrench ? wrenchIcon() : '');
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
    const names = { N: 'up', S: 'down', E: 'right', W: 'left' };
    return LP.describeCard(card) + ', open ' + LP.openingsOf(card, flip).map((d) => names[d]).join(' and ');
  }
  const ICON = {
    wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3.6 17.1a1.6 1.6 0 0 0 2.3 2.3l5.7-5.7a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.3-.6-.6-2.3z" fill="currentColor"/></svg>',
    drop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3 4.2 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 3-6.8 6-11z" fill="currentColor"/></svg>',
    turn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 4v6h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---------------------------------------------------------------- persistence
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ game: ui.game, seats: ui.seats, viewer: ui.viewer }));
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
  const G = () => ui.game;
  const humans = () => G().players.filter((p) => p.kind === 'human').length;
  const isHumanTurn = () => G() && G().phase !== 'over' && G().players[G().turn].kind === 'human' && !ui.modal && !ui.busy;
  const handOwner = () => ui.viewer;

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
    if (G()) return proceed();
    render();
  }
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    if (!G()) return renderOverlay();
    renderMeta();
    renderChips();
    renderBoard();
    renderStatus();
    renderHand();
    renderActions();
    renderOverlay();
  }

  function renderMeta() {
    const g = G();
    $('meta').textContent = `Deck ${g.deck.length} · Need ${g.required}`;
  }

  function renderChips() {
    const g = G();
    const moves = selMoves();
    const playable = new Set(moves.map((m) => m.target));
    if (ui.wrench) playable.add(g.turn);
    $('chips').innerHTML = g.players
      .map((pl, i) => {
        const b = pl.board;
        const prog = Math.min(LP.progressOf(b), g.required);
        const leak = LP.leakAt(b) >= 0;
        const dead = g.phase !== 'over' && !LP.analyze(b, g.required).viable;
        const wr = Array.from({ length: pl.wrenches }, () => ICON.wrench).join('');
        const cls = ['chip', i === ui.view ? 'viewing' : '', i === g.turn && g.phase !== 'over' ? 'turn' : '', playable.has(i) ? 'can-play' : '', i === ui.flash ? 'flash' : ''].join(' ');
        const tags = [wr ? `<span title="Wrenches left">${wr}</span>` : '<span>no wrenches</span>', leak ? `<span class="tag-leak">${ICON.drop} leak</span>` : '', dead ? '<span class="tag-dead">dead end</span>' : '', g.winner === i ? '<span class="tag-leak">winner</span>' : ''].join('');
        return `<button type="button" class="${cls}" data-view="${i}" aria-pressed="${i === ui.view}">
          <span class="nm">${esc(pl.name)}</span><span class="ct">${prog}/${g.required}</span>
          <span class="bar"><i style="width:${(100 * prog) / g.required}%"></i></span>
          <span class="tags">${tags}</span></button>`;
      })
      .join('');
    ui.flash = -1;
  }

  function renderBoard() {
    const g = G();
    const pl = g.players[ui.view];
    const b = pl.board;
    const W = b.w * CW + (b.w - 1) * GAP;
    const H = b.h * CH + (b.h - 1) * GAP;
    const svg = $('board');
    const wrap = $('boardwrap');
    const v = computeView(b, Math.max(0.3, (wrap.clientWidth - 20) / Math.max(1, wrap.clientHeight - 20)));
    svg.setAttribute('viewBox', `${v.x - 5} ${v.y - 5} ${v.w + 10} ${v.h + 10}`);
    svg.setAttribute('aria-label', pl.name + "'s pipeline");
    $('viewnote').textContent = ui.view === ui.viewer && pl.kind === 'human' && humans() === 1 ? 'Your pipeline' : pl.name + "'s pipeline";

    const targets = new Map(); // i -> {solid}
    const want = ui.sel ? !!ui.flips[ui.sel] : false;
    for (const m of selMoves()) {
      if (m.target !== ui.view) continue;
      const t = targets.get(m.i) || { solid: false };
      if (!!m.flip === want || isSymmetric(ui.sel)) t.solid = true;
      targets.set(m.i, t);
    }
    if (ui.wrench && ui.view === g.turn) {
      const lk = LP.leakAt(b);
      if (lk >= 0) targets.set(lk, { solid: true });
    }

    const leak = LP.leakAt(b);
    let out = `<rect class="tableedge" x="-3" y="-3" width="${W + 6}" height="${H + 6}" rx="7"/>`;
    for (let i = 0; i < b.cells.length; i++) {
      const x = (i % b.w) * (CW + GAP);
      const y = Math.floor(i / b.w) * (CH + GAP);
      const p = b.cells[i];
      if (p) {
        const used = p.card.kind === 'cap' ? new Set(LP.capsInUse(b, i).map((u) => u.d)) : null;
        out += `<g transform="translate(${x} ${y})">${cardArt(p, { usedCaps: used })}</g>`;
      } else {
        out += `<rect class="slot" x="${x + 1.5}" y="${y + 1.5}" width="${CW - 3}" height="${CH - 3}" rx="5"/>`;
      }
    }
    for (let i = 0; i < b.cells.length; i++) {
      const x = (i % b.w) * (CW + GAP);
      const y = Math.floor(i / b.w) * (CH + GAP);
      if (i === leak) out += `<rect class="leakring" x="${x - 1}" y="${y - 1}" width="${CW + 2}" height="${CH + 2}" rx="6"/>`;
      const t = targets.get(i);
      if (t) out += `<rect class="target${t.solid ? '' : ' flipneed'}" x="${x + 1}" y="${y + 1}" width="${CW - 2}" height="${CH - 2}" rx="5"/>`;
      if (ui.view !== ui.viewer && i === b.last && g.phase !== 'over') out += `<path class="lastmark" d="M${x + CW - 14},${y + 2} h12 v12 z"><title>Last card played</title></path>`;
      out += `<rect class="hit${t ? ' go' : ''}" data-i="${i}" x="${x}" y="${y}" width="${CW}" height="${CH}"/>`;
    }
    svg.innerHTML = out;
  }
  // Zoom to the part of the table in use (plus a free ring around it), shaped to the screen,
  // so cards stay big on a phone. Grows as the pipeline grows.
  function computeView(b, aspect) {
    let x0 = b.w, x1 = 0, y0 = b.h, y1 = 0;
    b.cells.forEach((p, i) => {
      if (!p) return;
      const x = i % b.w;
      const y = Math.floor(i / b.w);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    });
    x0 = Math.max(0, x0 - 1); x1 = Math.min(b.w - 1, x1 + 1);
    y0 = Math.max(0, y0 - 1); y1 = Math.min(b.h - 1, y1 + 1);
    const addCol = () => (x0 > 0 ? x0-- : x1++);
    let flipRow = false;
    const addRow = () => {
      flipRow = !flipRow;
      if ((flipRow && y0 > 0) || y1 >= b.h - 1) y0--;
      else y1++;
    };
    while (x1 - x0 + 1 < Math.min(6, b.w)) addCol();
    while (y1 - y0 + 1 < Math.min(5, b.h)) addRow();
    const px = () => ({ w: (x1 - x0 + 1) * CW + (x1 - x0) * GAP, h: (y1 - y0 + 1) * CH + (y1 - y0) * GAP });
    let s = px();
    if (s.w / s.h < aspect) {
      while (s.w / s.h < aspect && x1 - x0 + 1 < b.w) { addCol(); s = px(); }
    } else {
      while (s.w / s.h > aspect && y1 - y0 + 1 < b.h) { addRow(); s = px(); }
    }
    return { x: x0 * (CW + GAP), y: y0 * (CH + GAP), w: s.w, h: s.h };
  }
  window.addEventListener('resize', () => G() && renderBoard());

  function isSymmetric(cardId) {
    const c = findCard(cardId);
    return c && c.kind === 'pipe' && (c.shape === 'V' || c.shape === 'H');
  }
  function findCard(id) {
    const g = G();
    for (const p of g.players) {
      const c = p.hand.find((h) => h.id === id);
      if (c) return c;
    }
    return null;
  }

  function renderStatus() {
    const g = G();
    const cur = g.players[g.turn];
    let prompt;
    if (g.phase === 'over') prompt = g.winner >= 0 ? `${g.players[g.winner].name} connected the spout.` : 'Game over.';
    else if (ui.busy) prompt = `${cur.name} is playing…`;
    else if (g.phase === 'wrenchDiscard') prompt = 'Wrench placed. Pick a card to discard to finish your turn.';
    else if (ui.wrench) prompt = 'Tap the leaking card to put your wrench on it.';
    else if (ui.sel) {
      const n = selMoves().length;
      const viewName = ui.view === g.turn ? 'your pipeline' : g.players[ui.view].name + "'s pipeline";
      const here = selMoves().filter((m) => m.target === ui.view).length;
      prompt = !n ? "That card can't be played right now. Discard it or pick another." : here ? `Tap a glowing slot on ${viewName}.` : 'That card goes on another pipeline. Tap a highlighted name.';
    } else {
      const mine = g.players[g.turn].board;
      prompt = LP.leakAt(mine) >= 0 ? 'Your pipeline is leaking. Cover the leak with the same shape, use a wrench, or discard.' : `${humans() > 1 ? cur.name + ', your' : 'Your'} turn. Pick a card.`;
    }
    const logs = g.log.slice(-2).reverse();
    $('status').innerHTML = `<div class="prompt">${esc(prompt)}</div>` + logs.map((l) => `<div class="log ${l.kind}">${esc(l.text)}</div>`).join('');
  }

  function renderHand() {
    const g = G();
    const el = $('hand');
    if (ui.modal && ui.modal.type === 'pass') {
      el.innerHTML = '<div class="hidden">Cards hidden until the next player is ready.</div>';
      return;
    }
    const owner = g.players[handOwner()];
    const myTurn = isHumanTurn() && g.turn === handOwner();
    el.innerHTML = owner.hand
      .map((c) => {
        const flip = !!ui.flips[c.id];
        const cls = ['hcard', ui.sel === c.id ? 'sel' : '', myTurn && g.drawn === c.id ? 'new' : '', myTurn ? '' : 'dim'].join(' ');
        return `<button type="button" class="${cls}" data-card="${c.id}" ${myTurn ? '' : 'disabled'} aria-pressed="${ui.sel === c.id}" aria-label="${esc(cardLabel(c, flip))}">${cardSVG(c, flip)}</button>`;
      })
      .join('');
  }

  function renderActions() {
    const g = G();
    const myTurn = isHumanTurn();
    const me = g.players[g.turn];
    const c = ui.sel ? findCard(ui.sel) : null;
    const canTurn = myTurn && c && !(c.kind === 'pipe' && (c.shape === 'V' || c.shape === 'H')) && g.phase === 'play';
    const leak = myTurn && LP.leakAt(me.board) >= 0;
    const canWrench = myTurn && g.phase === 'play' && leak && me.wrenches > 0;
    const discardLabel = g.phase === 'wrenchDiscard' ? 'Discard to finish' : 'Discard';
    $('actions').innerHTML =
      `<button type="button" class="btn" data-act="turn" ${canTurn ? '' : 'disabled'}>${ICON.turn}Turn card</button>` +
      `<button type="button" class="btn" data-act="discard" ${myTurn && c ? '' : 'disabled'}>${ICON.bin}${discardLabel}</button>` +
      `<button type="button" class="btn ${ui.wrench ? 'on' : ''}" data-act="wrench" ${canWrench ? '' : 'disabled'}>${ICON.wrench}Wrench (${me.kind === 'human' ? me.wrenches : g.players[ui.viewer].wrenches})</button>`;
  }

  // ---------------------------------------------------------------- overlays
  function renderOverlay() {
    const o = $('overlay');
    const m = ui.modal;
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
    const first = o.querySelector('[data-focus]') || o.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function heroCards() {
    const mk = (card, flip) => cardSVG(card, flip);
    return `<div class="hero-art" aria-hidden="true">${mk({ kind: 'spout' })}${mk({ kind: 'pipe', mat: 'iron', shape: 'H' })}${mk({ kind: 'pipe', mat: 'leaky', shape: 'L1' }, true)}${mk({ kind: 'pipe', mat: 'copper', shape: 'T1' })}${mk({ kind: 'pipe', mat: 'iron', shape: 'H' })}${mk({ kind: 'valve' })}</div>`;
  }

  function setupHTML() {
    const s = ui.seats;
    const saved = loadSaved();
    const canResume = saved && saved.game.phase !== 'over' && !ui.game;
    const inGame = ui.game && ui.game.phase !== 'over';
    const need = LP.REQUIRED[s.length];
    const seats = s
      .map(
        (seat, i) => `<div class="seat">
        <input id="seat-name-${i}" value="${esc(seat.name)}" maxlength="14" aria-label="Player ${i + 1} name" data-seat="${i}">
        <span class="seg" role="group" aria-label="Player ${i + 1} type">
          <button type="button" class="${seat.kind === 'human' ? 'on' : ''}" data-kind="${i}:human">Person</button>
          <button type="button" class="${seat.kind === 'bot' ? 'on' : ''}" data-kind="${i}:bot">Computer</button>
        </span>
        ${s.length > 2 ? `<button type="button" class="x" data-remove="${i}" aria-label="Remove player ${i + 1}">×</button>` : '<span></span>'}
      </div>`
      )
      .join('');
    const hasHuman = s.some((x) => x.kind === 'human');
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="setup-h">
      ${heroCards()}
      <h2 id="setup-h">Leaky <span>Pipes</span></h2>
      <p>Race to pipe water from your valve to your spout while everyone else springs leaks in your line. Classic Waterworks rules for 2 to 4 players.</p>
      ${canResume ? `<div class="row"><button type="button" class="btn primary" data-act="resume" data-focus>Resume saved game</button></div>` : ''}
      ${inGame ? `<div class="row"><button type="button" class="btn" data-act="close">Back to the current game</button></div>` : ''}
      <h3>Players</h3>
      ${seats}
      <div class="row">${s.length < 4 ? '<button type="button" class="btn" data-act="add-seat">Add a player</button>' : ''}</div>
      <p class="muted">${s.length} players · ${need} pipe cards to win. Pass-and-play: give each person their own seat and pass the device between turns.</p>
      ${hasHuman ? '' : '<p class="muted" style="color:var(--danger)">Add at least one person.</p>'}
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

  function overHTML() {
    const g = G();
    const w = g.winner;
    const title = w < 0 ? 'No <span>winner</span>' : g.players[w].kind === 'human' && humans() === 1 ? 'You <span>win!</span>' : `${esc(g.players[w].name)} <span>wins</span>`;
    const rounds = Math.ceil(g.turns / g.players.length);
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="over-h">
      <h2 id="over-h">${title}</h2>
      <p>${w >= 0 ? `A leak-free line of ${LP.progressOf(g.players[w].board)} pipes from valve to spout, in ${rounds} rounds.` : 'Nobody could finish.'}</p>
      <div class="row end">
        <button type="button" class="btn" data-act="see-board">Look at the table</button>
        <button type="button" class="btn" data-act="setup">Change players</button>
        <button type="button" class="btn primary" data-act="again" data-focus>Play again</button>
      </div>
    </div>`;
  }

  function menuHTML() {
    return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="menu-h">
      <h2 id="menu-h">Menu</h2>
      <div class="row">
        <button type="button" class="btn" data-act="rules">How to play</button>
        <button type="button" class="btn" data-act="setup">New game</button>
        <button type="button" class="btn primary" data-act="close" data-focus>Back to the game</button>
      </div>
    </div>`;
  }

  function rulesHTML() {
    return `<div class="sheet rules" role="dialog" aria-modal="true" aria-labelledby="rules-h">
      <h2 id="rules-h">How to <span>play</span></h2>
      <h3>Goal</h3>
      <p>Build a leak-free line from your valve to your spout with at least 12, 10 or 8 pipe cards (2, 3 or 4 players). Caps don't count.</p>
      <h3>Your turn</h3>
      <p>You draw a card automatically. Then do one thing: add a good pipe (copper or iron) to your pipeline, put a leaky pipe or leaky cap on an opponent, repair a leak, or discard. You end with five cards.</p>
      <h3>Placing</h3>
      <p>The valve sits on the right and you build leftward. Cards stay upright; Turn card spins one 180°. Pipes must line up on every side, nothing may point off the table, and no card may completely block a pipeline. Loops are fine as long as the pipeline can keep going.</p>
      <h3>Leaks</h3>
      <p>A leaky card goes next to the last card of an opponent's pipeline (marked with a copper corner), or on top of it if that card is iron and exactly the same shape. Copper never leaks. One leak per pipeline at a time, and a repaired pipe can't leak again.</p>
      <h3>Repairs</h3>
      <p>Cover the leak with a good card of the same shape, or use one of your two wrenches and then discard a card. Until it's fixed you can't build, except to put a good cap on one end of a leaky T.</p>
      <h3>T's and caps</h3>
      <p>A T splits the water. Before you can win, cap one end or loop it back into the line. Caps that don't touch a pipe are ignored; a leaky cap in use has to be repaired. You can't cap your last open end.</p>
      <h3>Winning</h3>
      <p>When your line is long enough, leak-free, has no other open ends and its last pipe points left, the spout goes on automatically, pouring left and down.</p>
      <h3>House rules in this app</h3>
      <p class="muted">A leak can't leave someone's pipeline with no way to finish (the rulebook doesn't cover this). You get a warning before a move that would do that to your own pipeline. Pipes can't be run into a cap card that's already down. Winning Moves doesn't publish its card mix, so the 110-card deck here is an estimate.</p>
      <div class="row end"><button type="button" class="btn primary" data-act="rules-close" data-focus>Got it</button></div>
    </div>`;
  }

  // ---------------------------------------------------------------- game flow
  function startGame(seats) {
    ui.gen++;
    const players = seats.map((s, i) => ({ name: (s.name || '').trim() || (s.kind === 'bot' ? BOT_NAMES[i % 3] : 'Player ' + (i + 1)), kind: s.kind }));
    ui.game = LP.newGame({ players });
    ui.sel = null;
    ui.flips = {};
    ui.wrench = false;
    ui.busy = false;
    ui.modal = null;
    const firstHuman = players.findIndex((p) => p.kind === 'human');
    ui.viewer = firstHuman;
    ui.view = firstHuman;
    save();
    proceed(true);
  }

  function proceed(fresh) {
    const g = G();
    render();
    if (g.phase === 'over') {
      ui.busy = false;
      ui.view = g.winner >= 0 ? g.winner : ui.view;
      ui.modal = { type: 'over' };
      return render();
    }
    const cur = g.players[g.turn];
    if (cur.kind === 'bot') {
      ui.busy = true;
      ui.sel = null;
      ui.wrench = false;
      render();
      const gen = ui.gen;
      setTimeout(() => gen === ui.gen && botStep(), fresh ? 400 : BOT_DELAY);
      return;
    }
    ui.busy = false;
    if (humans() > 1 && ui.viewer !== g.turn) {
      ui.modal = { type: 'pass' };
      return render();
    }
    ui.viewer = g.turn;
    ui.view = g.turn;
    render();
  }

  function botStep() {
    const g = G();
    if (!g || g.phase === 'over') return proceed();
    const p = g.turn;
    let m = LP.bot.chooseMove(g, p);
    let r = LP.applyMove(g, p, m);
    if (!r.ok) r = LP.applyMove(g, p, { type: 'discard', cardId: g.players[p].hand[0].id });
    if (m.target != null && m.target !== p) {
      ui.flash = m.target;
      if (m.target === ui.viewer) toast(g.log[g.log.length - 1].text);
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
    const r = LP.applyMove(g, g.turn, m);
    if (!r.ok) {
      toast(r.reason);
      return;
    }
    if (m.cardId) delete ui.flips[m.cardId];
    ui.sel = null;
    ui.wrench = false;
    save();
    if (g.phase === 'wrenchDiscard') return render();
    proceed();
  }

  function tryCell(i) {
    const g = G();
    if (!isHumanTurn()) return;
    if (ui.wrench) {
      if (ui.view === g.turn && LP.leakAt(g.players[g.turn].board) === i) play({ type: 'wrench', i, target: g.turn });
      else toast('Tap the leaking card on your own pipeline.');
      return;
    }
    if (!ui.sel) {
      const p = g.players[ui.view].board.cells[i];
      if (p) toast(cardLabel(p.card, p.flip).replace(/^./, (c) => c.toUpperCase()) + '.');
      return;
    }
    if (g.phase !== 'play') return;
    const want = !!ui.flips[ui.sel];
    const here = selMoves().filter((m) => m.target === ui.view && m.i === i);
    if (!here.length) {
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

  function whyNot(i, flip) {
    const g = G();
    const card = findCard(ui.sel);
    const b = g.players[ui.view].board;
    const occupied = !!b.cells[i];
    const type = occupied ? 'cover' : card.kind === 'cap' ? 'cap' : 'pipe';
    const r = LP.checkMove(g, g.turn, { type, cardId: ui.sel, target: ui.view, i, flip });
    if (r.ok) return 'Try turning the card.';
    if (!occupied && !LP.openEnds(b).some((e) => e.t === i)) return 'Cards have to attach to an open pipe end.';
    return r.reason;
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act],[data-card],[data-view],[data-i],[data-kind],[data-remove]');
    if (!t) return;
    if (t.dataset.i != null && t.closest('#board')) return tryCell(+t.dataset.i);
    if (t.dataset.view != null) {
      ui.view = +t.dataset.view;
      return render();
    }
    if (t.dataset.card) {
      if (!isHumanTurn()) return;
      ui.wrench = false;
      ui.sel = ui.sel === t.dataset.card ? null : t.dataset.card;
      if (ui.sel && G().phase === 'play') {
        const ms = selMoves();
        if (ms.length && !ms.some((m) => m.target === ui.view)) ui.view = ms[0].target;
      }
      return render();
    }
    if (t.dataset.kind) {
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
      ui.seats.splice(+t.dataset.remove, 1);
      return renderOverlay();
    }
    const act = t.dataset.act;
    const g = G();
    switch (act) {
      case 'turn':
        if (ui.sel) ui.flips[ui.sel] = !ui.flips[ui.sel];
        return render();
      case 'discard':
        if (ui.sel && isHumanTurn()) play({ type: 'discard', cardId: ui.sel });
        return;
      case 'wrench':
        ui.wrench = !ui.wrench;
        ui.sel = null;
        if (ui.wrench) ui.view = g.turn;
        return render();
      case 'add-seat': {
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
        ui.gen++;
        ui.game = d.game;
        ui.seats = d.seats || ui.seats;
        ui.viewer = d.viewer || 0;
        ui.view = ui.viewer;
        ui.modal = null;
        return proceed(true);
      }
      case 'rules':
        readSeatNames();
        ui.modal = { type: 'rules', back: ui.modal };
        return render();
      case 'rules-close':
        return closeModal();
      case 'setup':
        ui.gen++;
        ui.busy = false;
        ui.modal = { type: 'setup' };
        return render();
      case 'close':
        ui.modal = null;
        return G() ? proceed() : render();
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
        ui.seats = G().players.map((p) => ({ name: p.name, kind: p.kind }));
        return startGame(ui.seats);
      case 'see-board':
        ui.modal = null;
        return render();
    }
  });
  $('menuBtn').addEventListener('click', () => {
    if (!G()) {
      ui.modal = { type: 'setup' };
      return render();
    }
    if (ui.modal && ui.modal.type === 'over') return;
    ui.gen++; // pause bots while the menu is open
    ui.busy = false;
    ui.modal = G().phase === 'over' ? { type: 'over' } : { type: 'menu' };
    render();
  });
  document.addEventListener('input', (ev) => {
    const i = ev.target.dataset && ev.target.dataset.seat;
    if (i != null) ui.seats[+i].name = ev.target.value;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ui.modal && ['rules', 'menu', 'warn'].includes(ui.modal.type)) closeModal();
  });
  function readSeatNames() {
    document.querySelectorAll('[data-seat]').forEach((inp) => {
      ui.seats[+inp.dataset.seat].name = inp.value;
    });
  }

  // ---------------------------------------------------------------- boot
  const saved = loadSaved();
  if (saved && saved.seats) ui.seats = saved.seats;
  ui.modal = { type: 'setup' };
  if (saved && saved.game && saved.game.phase !== 'over') {
    // Show the saved table behind the setup sheet.
    ui.game = null;
  }
  render();
  window.__leaky = ui; // handy for debugging
})();
