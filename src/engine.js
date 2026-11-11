/* Leaky Pipes rules engine — follows the Winning Moves "Classic Waterworks" (2–4 player) rulebook.
 * Pure logic, no DOM. Works in the browser (window.LP) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const DIRS = ['N', 'E', 'S', 'W'];
  const DX = { N: 0, E: 1, S: 0, W: -1 };
  const DY = { N: -1, E: 0, S: 1, W: 0 };
  const OPP = { N: 'S', E: 'W', S: 'N', W: 'E' };

  // Six pipe shapes. Cards can only be turned 180°, which maps every opening to its opposite.
  const SHAPES = {
    V: ['N', 'S'],
    H: ['E', 'W'],
    L1: ['N', 'E'],
    L2: ['N', 'W'],
    T1: ['E', 'S', 'W'],
    T2: ['N', 'E', 'S'],
  };
  const SHAPE_KIND = { V: 'straight', H: 'straight', L1: 'elbow', L2: 'elbow', T1: 'T', T2: 'T' };
  const SYMMETRIC = { V: true, H: true };

  // Rulebook: 2 players 12, 3 players 10, 4 players 8 pipe cards between valve and spout.
  const REQUIRED = { 2: 12, 3: 10, 4: 8 };
  const BOARD_W = 14;
  const BOARD_H = 7;
  // Endless table: a grid big enough that no pipeline gets near its edge, valve in the middle.
  const ENDLESS = 41;

  // Winning Moves doesn't publish the card mix. This is an estimate of the 110-card deck:
  // 4 valves + 4 spouts + 102 cards below. Edit freely.
  const DECK_SPEC = {
    iron: { V: 8, H: 8, L1: 8, L2: 8, T1: 3, T2: 3 },
    copper: { V: 6, H: 6, L1: 5, L2: 5, T1: 2, T2: 2 },
    leaky: { V: 7, H: 7, L1: 6, L2: 6, T1: 2, T2: 2 },
    caps: [
      { caps: { N: 'iron', E: 'iron', S: 'copper', W: 'iron' }, count: 3 },
      { caps: { N: 'copper', E: 'iron', S: 'iron', W: 'copper' }, count: 2 },
      { caps: { N: 'leaky', E: 'iron', S: 'copper', W: 'iron' }, count: 1 },
      { caps: { N: 'iron', E: 'leaky', S: 'iron', W: 'copper' }, count: 1 },
      { caps: { N: 'copper', E: 'iron', S: 'leaky', W: 'leaky' }, count: 1 },
    ],
  };

  // A remix found by self-play (tools/deck-search.js, tools/rules-exp.js). Same idea as the
  // original, tuned against long stretches where nobody can play: more elbows, very few T's,
  // a few fewer leaks, and wrench cards: hold one in your hand and play it to fix a leak.
  const DECK_TUNED = {
    iron: { V: 7, H: 7, L1: 12, L2: 12, T1: 1, T2: 1 },
    copper: { V: 5, H: 5, L1: 10, L2: 10, T1: 1, T2: 1 },
    leaky: { V: 5, H: 5, L1: 8, L2: 8, T1: 1, T2: 1 },
    caps: [
      { caps: { N: 'iron', E: 'iron', S: 'copper', W: 'iron' }, count: 5 },
      { caps: { N: 'copper', E: 'iron', S: 'iron', W: 'copper' }, count: 4 },
      { caps: { N: 'leaky', E: 'iron', S: 'copper', W: 'iron' }, count: 1 },
    ],
    wrenchCards: 6,
  };
  const DECKS = { classic: DECK_SPEC, tuned: DECK_TUNED };

  // ---------- random ----------
  function nextRand(game) {
    // mulberry32, state kept in the game so saved games stay reproducible
    let t = (game.rng = (game.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function shuffle(game, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(nextRand(game) * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- cards ----------
  function buildDeck(spec) {
    spec = spec || DECK_SPEC;
    const deck = [];
    let n = 0;
    for (const mat of ['iron', 'copper', 'leaky']) {
      for (const shape of Object.keys(spec[mat])) {
        for (let k = 0; k < spec[mat][shape]; k++) deck.push({ id: 'c' + n++, kind: 'pipe', mat, shape });
      }
    }
    for (const c of spec.caps) {
      for (let k = 0; k < c.count; k++) deck.push({ id: 'c' + n++, kind: 'cap', caps: Object.assign({}, c.caps) });
    }
    // Optional wrench cards: held in hand like any card; playing one repairs your leak and the
    // card itself is the discard, so no extra discard is needed.
    for (let k = 0; k < (spec.wrenchCards || 0); k++) deck.push({ id: 'c' + n++, kind: 'wrench' });
    return deck;
  }

  function openingsOf(card, flip) {
    if (card.kind === 'pipe') {
      const base = SHAPES[card.shape];
      return flip ? base.map((d) => OPP[d]) : base.slice();
    }
    if (card.kind === 'valve') return [flip ? 'E' : 'W'];
    if (card.kind === 'spout') return [flip ? 'W' : 'E'];
    return [];
  }
  function capAt(card, flip, d) {
    return card.caps[flip ? OPP[d] : d];
  }
  function sameSet(a, b) {
    return a.length === b.length && a.every((d) => b.includes(d));
  }
  function isGoodPipe(card) {
    return card.kind === 'pipe' && card.mat !== 'leaky';
  }
  // Could this good pipe go over the leaking pipe at cell i (either way up)?
  function coversLeak(b, i, card) {
    const t = b.cells[i];
    return !!t && isGoodPipe(card) && [false, true].some((f) => sameSet(openingsOf(card, f), pieceOpenings(t)));
  }
  function capHasLeak(card) {
    return card.kind === 'cap' && DIRS.some((d) => card.caps[d] === 'leaky');
  }
  function describeCard(card) {
    if (card.kind === 'cap') return capHasLeak(card) ? 'cap card (with a leaky cap)' : 'cap card';
    if (card.kind === 'valve') return 'valve';
    if (card.kind === 'wrench') return 'wrench card';
    if (card.kind === 'spout') return 'spout';
    return card.mat + ' ' + SHAPE_KIND[card.shape];
  }

  // ---------- board ----------
  function newBoard(owner, w, h, valveX, valveY, face) {
    w = w || BOARD_W;
    h = h || BOARD_H;
    const cells = new Array(w * h).fill(null);
    const valve = (valveY != null ? valveY : Math.floor(h / 2)) * w + (valveX != null ? valveX : w - 1);
    cells[valve] = { card: { id: 'valve' + owner, kind: 'valve' }, flip: face === 'E', repaired: false, wrench: false, under: [], by: owner };
    return { w, h, cells, valve, last: valve, owner, spout: -1 };
  }
  function cloneBoard(b) {
    return Object.assign({}, b, { cells: b.cells.slice() });
  }

  // ---------- shared table ----------
  // On the shared table every pipeline lives on one grid. Each board keeps only its own cards;
  // b.foreign marks cells holding someone else's card (owner + 1) and b.reserved marks empty cells
  // that someone else's open end points into. Neither may be built on, and no opening may face
  // another pipeline's card or point at a reserved cell.
  const foreignAt = (b, n) => (b.foreign ? b.foreign[n] : 0);
  const reservedAt = (b, n) => (b.reserved ? b.reserved[n] : 0);
  function syncShared(game) {
    if (game.table !== 'shared') return;
    const P = game.players;
    const size = P[0].board.cells.length;
    const occ = P.map((pl) => pl.board.cells.map((c) => (c ? 1 : 0)));
    const ends = P.map((pl) => openEnds(pl.board).filter((e) => e.t >= 0).map((e) => e.t));
    P.forEach((pl, k) => {
      const f = new Array(size).fill(0);
      const r = new Array(size).fill(0);
      P.forEach((q, j) => {
        if (j === k) return;
        for (let i = 0; i < size; i++) if (occ[j][i]) f[i] = j + 1;
        for (const t of ends[j]) r[t] = j + 1;
      });
      pl.board = Object.assign({}, pl.board, { foreign: f, reserved: r });
    });
  }
  // Board r as it would look if `piece` landed on cell i of someone else's pipeline (board ob).
  function withForeignPiece(rb, ob, i, piece) {
    const f = rb.foreign.slice();
    const r = rb.reserved.slice();
    f[i] = ob.owner + 1;
    r[i] = 0;
    for (const d of pieceOpenings(piece)) {
      const n = step(ob, i, d);
      if (n >= 0 && !ob.cells[n] && !foreignAt(ob, n)) r[n] = ob.owner + 1;
    }
    return Object.assign({}, rb, { foreign: f, reserved: r });
  }
  const STRAND_OTHER_MSG = "That would leave another pipeline with no way to finish.";
  // On the shared table, a card may not wall off another pipeline completely.
  function strandsOthers(game, t, move, card) {
    if (game.table !== 'shared' || !['pipe', 'cap'].includes(move.type)) return -1;
    const ob = game.players[t].board;
    const piece = { card, flip: !!move.flip };
    const x = move.i % ob.w;
    const y = Math.floor(move.i / ob.w);
    for (let r = 0; r < game.players.length; r++) {
      if (r === t) continue;
      const rb = game.players[r].board;
      const ends = openEnds(rb).filter((e) => e.t >= 0);
      const room = game.required - progressOf(rb) + 4;
      const near = ends.some((e) => Math.abs((e.t % rb.w) - x) + Math.abs(Math.floor(e.t / rb.w) - y) <= room);
      if (!near) continue;
      if (!analyze(rb, game.required).viable) continue;
      if (!analyze(withForeignPiece(rb, ob, move.i, piece), game.required, { budget: 3000 }).viable) return r;
    }
    return -1;
  }
  function step(b, i, d) {
    const x = (i % b.w) + DX[d];
    const y = Math.floor(i / b.w) + DY[d];
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) return -1;
    return y * b.w + x;
  }
  // Which way may the last pipe point into the spout? Classic: left only (the spout pours left and
  // down). Endless: away from the faucet, left or right. 'any' is kept for experiments.
  function spoutDirOk(b, d, s) {
    const rule = b.spoutRule || (b.spoutAny ? 'any' : 'west');
    if (rule === 'any') return true;
    if (rule === 'west') return d === 'W';
    if (d !== 'W' && d !== 'E') return false;
    const sx = s % b.w;
    const vx = b.valve % b.w;
    // 'cross' (shared table): pour away from your valve, on the far half of the table
    if (rule === 'cross') return d === 'W' ? sx <= vx && sx < b.w / 2 - 0.5 : sx >= vx && sx > b.w / 2 - 0.5;
    return d === 'W' ? sx <= vx : sx >= vx;
  }
  function pieceOpenings(p) {
    return openingsOf(p.card, p.flip);
  }
  function isPipeLike(p) {
    return p && p.card.kind !== 'cap';
  }

  // Openings that face an empty cell: places the pipeline can still grow.
  function openEnds(b) {
    const ends = [];
    for (let i = 0; i < b.cells.length; i++) {
      const p = b.cells[i];
      if (!isPipeLike(p)) continue;
      for (const d of pieceOpenings(p)) {
        const n = step(b, i, d);
        if (n < 0 || foreignAt(b, n)) ends.push({ i, d, t: -1 });
        else if (!b.cells[n]) ends.push({ i, d, t: n });
      }
    }
    return ends;
  }

  function neighborsConnected(b, i) {
    const p = b.cells[i];
    const out = [];
    if (!isPipeLike(p)) return out;
    for (const d of pieceOpenings(p)) {
      const n = step(b, i, d);
      if (n < 0) continue;
      const q = b.cells[n];
      if (isPipeLike(q) && pieceOpenings(q).includes(OPP[d])) out.push(n);
    }
    return out;
  }

  function capsInUse(b, i) {
    const p = b.cells[i];
    const used = [];
    if (!p || p.card.kind !== 'cap') return used;
    for (const d of DIRS) {
      const n = step(b, i, d);
      if (n < 0) continue;
      const q = b.cells[n];
      if (isPipeLike(q) && pieceOpenings(q).includes(OPP[d])) used.push({ d, n, mat: capAt(p.card, p.flip, d) });
    }
    return used;
  }

  function pieceLeaks(b, i) {
    const p = b.cells[i];
    if (!p || p.repaired) return false;
    if (p.card.kind === 'pipe') return p.card.mat === 'leaky';
    if (p.card.kind === 'cap') return capsInUse(b, i).some((u) => u.mat === 'leaky');
    return false;
  }
  function leakAt(b) {
    for (let i = 0; i < b.cells.length; i++) if (pieceLeaks(b, i)) return i;
    return -1;
  }

  // Longest simple path (in pipe cards, valve excluded) from the valve to cell `target`.
  // Loops are allowed by the rulebook, so every card a loop carries water through counts.
  function longestPath(b, target) {
    if (target === b.valve) return 0;
    const adj = new Map();
    for (let i = 0; i < b.cells.length; i++) if (isPipeLike(b.cells[i])) adj.set(i, neighborsConnected(b, i));
    let best = -1;
    let budget = 50000;
    const seen = new Set([b.valve]);
    (function dfs(i, len) {
      if (budget-- <= 0) return;
      if (i === target) {
        if (len > best) best = len;
        return;
      }
      for (const n of adj.get(i) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        dfs(n, len + 1);
        seen.delete(n);
      }
    })(b.valve, 0);
    return best;
  }

  function progressOf(b) {
    const ends = openEnds(b).filter((e) => e.t >= 0);
    let best = 0;
    const done = new Set();
    for (const e of ends) {
      if (done.has(e.i)) continue;
      done.add(e.i);
      best = Math.max(best, longestPath(b, e.i));
    }
    if (b.spout >= 0) {
      const into = step(b, b.spout, b.spoutDir === 'E' ? 'W' : 'E');
      best = Math.max(best, longestPath(b, into));
    }
    return best;
  }

  // ---------- placement checks (pure geometry) ----------
  function fail(reason) {
    return { ok: false, reason };
  }

  function evalPipe(b, i, card, flip) {
    if (i < 0 || b.cells[i] || foreignAt(b, i)) return fail('That spot is taken.');
    if (reservedAt(b, i)) return fail("That spot is in front of another pipeline's open end.");
    const O = openingsOf(card, flip);
    const conns = [];
    for (const d of DIRS) {
      const n = step(b, i, d);
      const open = O.includes(d);
      if (n < 0) {
        if (open) return fail("A pipe can't point off the edge of the table.");
        continue;
      }
      if (foreignAt(b, n)) {
        if (open) return fail("A pipe can't run into another pipeline.");
        continue;
      }
      const q = b.cells[n];
      if (!q) {
        if (open && reservedAt(b, n)) return fail('That would point at a spot another pipeline needs.');
        continue;
      }
      if (q.card.kind === 'cap') {
        if (open) return fail("A pipe can't run into a cap card.");
        continue;
      }
      const qOpen = pieceOpenings(q).includes(OPP[d]);
      if (open && qOpen) conns.push({ d, n });
      else if (open !== qOpen) return fail("The pipes don't line up.");
    }
    if (!conns.length) return fail('It has to connect to an open pipe end.');
    const nb = cloneBoard(b);
    nb.cells[i] = { card, flip, repaired: false, wrench: false, under: [], by: -1 };
    if (!openEnds(nb).length) return fail('That would completely block the pipeline.');
    return { ok: true, conns };
  }

  function evalCap(b, i, card, flip) {
    if (i < 0 || b.cells[i] || foreignAt(b, i)) return fail('That spot is taken.');
    if (reservedAt(b, i)) return fail("That spot is in front of another pipeline's open end.");
    const used = [];
    for (const d of DIRS) {
      const n = step(b, i, d);
      if (n < 0) continue;
      const q = b.cells[n];
      if (isPipeLike(q) && pieceOpenings(q).includes(OPP[d])) used.push({ d, n, mat: capAt(card, flip, d) });
    }
    if (!used.length) return fail('A cap has to close an open pipe end.');
    const nb = cloneBoard(b);
    nb.cells[i] = { card, flip, repaired: false, wrench: false, under: [], by: -1 };
    if (!openEnds(nb).length) return fail("A cap can't stop the water: another open end must remain.");
    return { ok: true, used };
  }

  // Ends an opponent may attack: those of the last card played, or any end if that card has none left.
  function attackCells(b) {
    const ends = openEnds(b).filter((e) => e.t >= 0);
    const fromLast = ends.filter((e) => e.i === b.last);
    return new Set((fromLast.length ? fromLast : ends).map((e) => e.i));
  }

  // House rule for a gap in the rulebook: a leak may slow an opponent down, but it may not
  // steer their pipeline into a spot where it can never be finished.
  const STRAND_MSG = "House rule: a leak can't leave their pipeline with no way to finish.";
  function strandsOpponent(game, b, move, card, actor) {
    if (!analyze(b, game.required).viable) return false;
    return !analyze(boardAfter(b, move, card, actor), game.required, { budget: 4000 }).viable;
  }

  // ---------- move legality (rules for owner vs opponent) ----------
  // move: {type:'pipe'|'cap'|'cover'|'wrench'|'discard', cardId, target, i, flip}
  function checkMove(game, p, move) {
    const me = game.players[p];
    if (game.phase === 'over') return fail('The game is over.');
    if (game.turn !== p) return fail("It isn't your turn.");
    if (game.phase === 'wrenchDiscard' && move.type !== 'discard') return fail('Discard a card to finish your wrench repair.');

    if (move.type === 'wrench') {
      const b = me.board;
      const leak = leakAt(b);
      if (leak < 0) return fail('Nothing on your pipeline is leaking.');
      if (move.i !== leak) return fail('Put the wrench on the leaking card.');
      if (move.cardId) {
        const c = me.hand.find((x) => x.id === move.cardId);
        if (!c || c.kind !== 'wrench') return fail('That is not a wrench card.');
        return { ok: true };
      }
      if (me.wrenches <= 0) return fail('You have no wrenches left.');
      return { ok: true };
    }

    if (move.type === 'pass') return me.hand.length === 0 ? { ok: true } : fail('You still have cards to play or discard.');
    const card = me.hand.find((c) => c.id === move.cardId);
    if (!card) return fail("That card isn't in your hand.");
    if (move.type === 'discard') return { ok: true };
    if (card.kind === 'wrench') return fail('A wrench card can only repair a leak on your own pipeline.');

    const tp = game.players[move.target];
    if (!tp) return fail('No such player.');
    const b = tp.board;
    const own = move.target === p;
    const leak = leakAt(b);

    if (move.type === 'pipe') {
      if (card.kind !== 'pipe') return fail('That is not a pipe card.');
      if (own) {
        if (card.mat === 'leaky') return fail("You can't put a leaky pipe on your own pipeline.");
        if (leak >= 0) return fail('Repair your leak before adding to your pipeline.');
        const r = evalPipe(b, move.i, card, move.flip);
        if (r.ok && strandsOthers(game, p, move, card) >= 0) return fail(STRAND_OTHER_MSG);
        return r;
      }
      if (card.mat !== 'leaky') return fail("You can't play a good pipe on an opponent's pipeline.");
      if (leak >= 0) return fail('That pipeline already has a leak.');
      const r = evalPipe(b, move.i, card, move.flip);
      if (!r.ok) return r;
      const atk = attackCells(b);
      if (!r.conns.some((c) => atk.has(c.n))) return fail('A leaky pipe must go next to the last card played.');
      if (strandsOpponent(game, b, move, card, p)) return fail(STRAND_MSG);
      if (strandsOthers(game, move.target, move, card) >= 0) return fail(STRAND_OTHER_MSG);
      return r;
    }

    if (move.type === 'cap') {
      if (card.kind !== 'cap') return fail('That is not a cap card.');
      const r = evalCap(b, move.i, card, move.flip);
      if (!r.ok) return r;
      if (own) {
        if (leak >= 0) {
          const lp = b.cells[leak];
          const leakyT = lp.card.kind === 'pipe' && pieceOpenings(lp).length === 3;
          if (!leakyT) return fail('Repair your leak before adding to your pipeline.');
          if (!r.used.every((u) => u.n === leak && u.mat !== 'leaky')) return fail('Only a good cap on the leaky T is allowed until it is repaired.');
        }
        if (strandsOthers(game, p, move, card) >= 0) return fail(STRAND_OTHER_MSG);
        return r;
      }
      if (leak >= 0) return fail('That pipeline already has a leak.');
      if (!r.used.some((u) => u.mat === 'leaky')) return fail('On an opponent you can only play a leaky cap.');
      const atk = attackCells(b);
      if (!r.used.some((u) => atk.has(u.n))) return fail('A leaky cap must go next to the last card played.');
      if (strandsOpponent(game, b, move, card, p)) return fail(STRAND_MSG);
      if (strandsOthers(game, move.target, move, card) >= 0) return fail(STRAND_OTHER_MSG);
      return r;
    }

    if (move.type === 'cover') {
      const target = b.cells[move.i];
      if (!target) return fail('There is no card there.');
      if (own) {
        if (move.i !== leak) return fail('You can only cover the leaking card.');
        if (target.card.kind === 'pipe') {
          if (!isGoodPipe(card)) return fail('Cover a leak with a good pipe of the same shape.');
          if (!sameSet(openingsOf(card, move.flip), pieceOpenings(target))) return fail('It must be exactly the same shape.');
          return { ok: true };
        }
        if (target.card.kind === 'cap') {
          if (card.kind !== 'cap') return fail('Cover a leaky cap with a good cap card.');
          const used = capsInUse(b, move.i);
          if (used.some((u) => capAt(card, move.flip, u.d) === 'leaky')) return fail('The caps in use must all be good.');
          return { ok: true };
        }
        return fail("That card can't be covered.");
      }
      if (card.kind !== 'pipe' || card.mat !== 'leaky') return fail('Only a leaky pipe can go on top of an opponent card.');
      if (leak >= 0) return fail('That pipeline already has a leak.');
      if (move.i !== b.last) return fail('A leaky pipe can only go on top of the last card played.');
      if (target.card.kind !== 'pipe') return fail('Only a pipe card can be made to leak.');
      if (target.card.mat === 'copper') return fail("Copper pipes can't leak.");
      if (target.card.mat !== 'iron' || target.repaired) return fail('A repaired pipe can\'t leak again.');
      if (!sameSet(openingsOf(card, move.flip), pieceOpenings(target))) return fail('It must be exactly the same shape.');
      return { ok: true };
    }
    return fail('Unknown move.');
  }

  // Apply a placement to a board (no hand/turn bookkeeping). Returns the new board.
  function boardAfter(b, move, card, actor) {
    const nb = cloneBoard(b);
    if (move.type === 'pipe') {
      nb.cells[move.i] = { card, flip: !!move.flip, repaired: false, wrench: false, under: [], by: actor };
      nb.last = move.i;
    } else if (move.type === 'cap') {
      nb.cells[move.i] = { card, flip: !!move.flip, repaired: false, wrench: false, under: [], by: actor };
    } else if (move.type === 'cover') {
      const old = nb.cells[move.i];
      const ownRepair = actor === b.owner;
      nb.cells[move.i] = {
        card,
        flip: !!move.flip,
        repaired: ownRepair,
        wrench: false,
        under: old.under.concat([{ card: old.card, flip: old.flip, wrench: old.wrench }]),
        by: actor,
      };
    } else if (move.type === 'wrench') {
      const old = nb.cells[move.i];
      nb.cells[move.i] = Object.assign({}, old, { wrench: true, repaired: true });
    }
    return nb;
  }

  // ---------- winning ----------
  // Returns the cell where the spout goes, or -1. Rulebook: leak-free, no second open sections,
  // at least `required` pipe cards in one line, spout pouring left and down (line ends heading left).
  function spoutCell(b, required) {
    if (leakAt(b) >= 0) return -1;
    const ends = openEnds(b);
    if (ends.length !== 1) return -1;
    const e = ends[0];
    if (e.t < 0 || reservedAt(b, e.t) || !spoutDirOk(b, e.d, e.t)) return -1;
    if (longestPath(b, e.i) < required) return -1;
    return e.t;
  }

  // ---------- dead-end analysis ----------
  // Can this pipeline still be finished, given an unlimited supply of good cards and caps?
  // Searches, for each open end, for a free path of at least the needed length that ends
  // heading left into a free spout cell. Other open ends must be capped or merged with a T.
  function analyze(b, required, opts) {
    opts = opts || {};
    const ends = openEnds(b);
    const res = { viable: false, cost: Infinity };
    if (!ends.length) return res;
    if (ends.some((e) => e.t < 0)) return res;
    const byTarget = new Map();
    for (const e of ends) {
      if (!byTarget.has(e.t)) byTarget.set(e.t, []);
      byTarget.get(e.t).push(e);
    }
    const depthCache = new Map();
    const depth = (i) => {
      if (!depthCache.has(i)) depthCache.set(i, longestPath(b, i));
      return depthCache.get(i);
    };
    for (const E of ends) {
      const needed = Math.max(0, required - depth(E.i));
      const ok = pathSearch(b, E, needed, byTarget, opts.budget || 2500);
      if (!ok) continue;
      res.viable = true;
      const rule = b.spoutRule || (b.spoutAny ? 'any' : 'west');
      const turn = rule === 'any' ? 0 : rule === 'away' || rule === 'cross' ? (E.d === 'W' || E.d === 'E' ? 0 : 1) : E.d === 'W' ? 0 : E.d === 'E' ? 2 : 1;
      let reach = 0;
      if (rule === 'cross') {
        const tx = E.t % b.w;
        const west = b.valve % b.w > b.w / 2;
        const goal = west ? Math.ceil(b.w / 2 - 0.5) - 1 : Math.floor(b.w / 2 - 0.5) + 1;
        reach = Math.max(0, west ? tx - goal : goal - tx);
      }
      const others = new Set(ends.filter((x) => x !== E && x.t !== E.t).map((x) => x.t));
      const cost = Math.max(needed, turn, reach) + others.size;
      if (cost < res.cost) res.cost = cost;
    }
    return res;
  }

  function pathSearch(b, E, needed, byTarget, budget) {
    const free = (i) => i >= 0 && !b.cells[i] && !foreignAt(b, i) && !reservedAt(b, i);
    const othersAt = (i) => (byTarget.get(i) || []).filter((x) => x !== E);
    const spoutOk = (s, visited) => free(s) && !visited.has(s) && !byTarget.has(s);
    // Zero more cards: spout goes straight onto this end.
    if (needed === 0 && spoutDirOk(b, E.d, E.t) && othersAt(E.t).length === 0) return true;
    const visited = new Set([E.t]);
    let nodes = 0;
    let exhausted = false;
    const cellOk = (i) => othersAt(i).length <= 1; // one extra end can merge through a T
    if (!free(E.t) || !cellOk(E.t)) return false;

    function reach(from, cap) {
      // count free unvisited cells reachable from `from` (stop at cap)
      const q = [from];
      const seen = new Set([from]);
      let c = 0;
      while (q.length && c < cap) {
        const i = q.pop();
        for (const d of DIRS) {
          const n = step(b, i, d);
          if (!free(n) || seen.has(n) || visited.has(n)) continue;
          seen.add(n);
          c++;
          q.push(n);
        }
      }
      return c;
    }

    function dfs(cell, len, inSide) {
      if (++nodes > budget) {
        exhausted = true;
        return true; // be optimistic when the search runs long
      }
      if (len >= needed) {
        for (const d of DIRS) {
          if (d === inSide) continue;
          const sc = step(b, cell, d);
          if (spoutDirOk(b, d, sc) && spoutOk(sc, visited)) return true;
        }
      }
      const remaining = needed - len;
      if (remaining > 0 && reach(cell, remaining + 1) < remaining + 1) return false;
      if (len > needed + 8) return false;
      for (const d of ['W', 'N', 'S', 'E']) {
        if (d === inSide) continue;
        const n = step(b, cell, d);
        if (!free(n) || visited.has(n) || !cellOk(n)) continue;
        visited.add(n);
        if (dfs(n, len + 1, OPP[d])) return true;
        visited.delete(n);
      }
      return false;
    }
    const r = dfs(E.t, 1, OPP[E.d]);
    return r || exhausted;
  }

  // ---------- game ----------
  // The shared table has no edges: one big grid with the valves facing each other around the
  // middle, `gap` cells apart, so lines meet in the centre but can also run round the back.
  // Spacing picked with self-play (tools/results/shared-*.txt).
  const SHARED = 45;
  const SHARED_GAP = { 2: 11, 3: 11, 4: 11 };
  function sharedLayout(n, lay) {
    if (lay && typeof lay === 'object' && lay.valves) return lay; // custom {w,h,valves}
    const gap = (lay && lay.gap) || SHARED_GAP[n];
    const c = Math.floor(SHARED / 2);
    const R = c + Math.ceil(gap / 2);
    const L = R - gap - 1;
    const rows = { 2: [[R, 0, 'W'], [L, 0, 'E']], 3: [[R, -2, 'W'], [L, 0, 'E'], [R, 2, 'W']], 4: [[R, -2, 'W'], [L, -2, 'E'], [R, 2, 'W'], [L, 2, 'E']] }[n];
    return { name: 'facing', w: SHARED, h: SHARED, valves: rows.map(([x, dy, face]) => ({ x, y: c + dy, face })) };
  }

  function newGame(opts) {
    const specs = opts.players;
    const n = specs.length;
    if (n < 2 || n > 4) throw new Error('2–4 players');
    const endless = opts.table === 'endless';
    const shared = opts.table === 'shared';
    const lay = shared ? sharedLayout(n, opts.layout) : null;
    const bw = endless ? ENDLESS : shared ? lay.w : opts.w;
    const bh = endless ? ENDLESS : shared ? lay.h : opts.h;
    const vx = endless ? Math.floor(ENDLESS / 2) : undefined;
    const game = {
      v: 1,
      table: endless ? 'endless' : shared ? 'shared' : 'classic',
      layout: shared ? lay.name : undefined,
      rng: (opts.seed >>> 0) || (Math.floor(Math.random() * 4294967296) >>> 0),
      players: specs.map((s, i) => {
        const v = shared ? lay.valves[i] : null;
        const board = shared ? newBoard(i, bw, bh, v.x, v.y, v.face) : newBoard(i, bw, bh, vx);
        if (endless || shared) board.spoutRule = opts.spoutRule || 'away';
        return { name: s.name, kind: s.kind, hand: [], wrenches: opts.wrenches != null ? opts.wrenches : 2, board };
      }),
      deck: [],
      discard: [],
      turn: 0,
      phase: 'play',
      required: REQUIRED[n],
      log: [],
      winner: null,
      turns: 0,
      drawn: null,
      seq: 0,
    };
    syncShared(game);
    game.deckName = opts.deckSpec ? 'custom' : DECKS[opts.deck] ? opts.deck : 'classic';
    game.deck = shuffle(game, buildDeck(opts.deckSpec || DECKS[game.deckName]));
    for (let k = 0; k < (opts.hand || 5); k++) for (const pl of game.players) drawInto(game, pl, true);
    game.turn = opts.first != null ? opts.first : 0;
    startTurn(game, opts.firstDraw === false);
    return game;
  }

  const poss = (n) => (n === 'You' ? 'your' : n + "'s");
  const an = (w) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;

  function log(game, text, kind) {
    game.seq++;
    game.log.push({ n: game.seq, text, kind: kind || 'info', p: game.turn });
    if (game.log.length > 60) game.log.shift();
  }

  function drawCard(game) {
    if (!game.deck.length && game.discard.length) {
      game.deck = shuffle(game, game.discard);
      game.discard = [];
      log(game, 'The discard pile was shuffled into a new draw pile.');
    }
    return game.deck.pop() || null;
  }

  function drawInto(game, pl) {
    const c = drawCard(game);
    if (c) pl.hand.push(c);
    return c;
  }

  function startTurn(game, noDraw) {
    const pl = game.players[game.turn];
    game.phase = 'play';
    game.turns++;
    const c = noDraw ? null : drawInto(game, pl);
    game.drawn = c ? c.id : null;
  }

  function removeFromHand(pl, id) {
    const k = pl.hand.findIndex((c) => c.id === id);
    return k >= 0 ? pl.hand.splice(k, 1)[0] : null;
  }

  function applyMove(game, p, move) {
    const chk = checkMove(game, p, move);
    if (!chk.ok) return chk;
    const me = game.players[p];
    const who = me.name;
    // What everyone at the table saw: the board this player faced and what they chose to do.
    // (Boards are never mutated, so keeping the reference is free.) Used by the Hard bot to
    // reason about what the player is probably holding.
    if (game.phase === 'play') {
      me.prevAct = me.lastAct;
      me.lastAct = {
        type: move.type,
        own: move.target == null || move.target === p,
        move,
        card: move.cardId ? me.hand.find((c) => c.id === move.cardId) : null,
        board: me.board,
        wrenches: me.wrenches,
        boards: game.players.map((q) => q.board),
        wr: game.players.map((q) => q.wrenches),
      };
    } else if (game.phase === 'wrenchDiscard' && me.lastAct) me.lastAct.dropped = me.hand.find((c) => c.id === move.cardId);
    if (move.type === 'discard') {
      const c = removeFromHand(me, move.cardId);
      game.discard.push(c);
      log(game, who + ' discarded ' + an(describeCard(c)) + '.');
      return endTurn(game);
    }
    if (move.type === 'pass') {
      log(game, who + ' has no cards and passes.');
      return endTurn(game);
    }
    if (move.type === 'wrench') {
      me.board = boardAfter(me.board, move, null, p);
      syncShared(game);
      if (move.cardId) {
        game.discard.push(removeFromHand(me, move.cardId));
        log(game, who + ' fixed a leak with a wrench card.', 'repair');
        return endTurn(game);
      }
      me.wrenches--;
      log(game, who + ' fixed a leak with a wrench.', 'repair');
      if (!me.hand.length) return endTurn(game);
      game.phase = 'wrenchDiscard';
      return { ok: true, needDiscard: true };
    }
    const card = removeFromHand(me, move.cardId);
    const tp = game.players[move.target];
    tp.board = boardAfter(tp.board, move, card, p);
    syncShared(game);
    const own = move.target === p;
    if (own) {
      if (move.type === 'cover') log(game, who + ' repaired a leak with ' + an(describeCard(card)) + '.', 'repair');
      else log(game, who + ' added ' + an(describeCard(card)) + '.');
    } else {
      const whom = tp.name;
      if (move.type === 'cover') log(game, who + ' made ' + poss(whom) + ' pipe leak!', 'attack');
      else log(game, who + ' put ' + an(describeCard(card)) + ' on ' + poss(whom) + ' pipeline!', 'attack');
    }
    return endTurn(game);
  }

  function endTurn(game) {
    const p = game.turn;
    const me = game.players[p];
    const s = spoutCell(me.board, game.required);
    if (s >= 0) {
      const nb = cloneBoard(me.board);
      const dir = openEnds(me.board)[0].d;
      nb.cells[s] = { card: { id: 'spout' + p, kind: 'spout' }, flip: dir === 'E', repaired: false, wrench: false, under: [], by: p };
      nb.spout = s;
      nb.spoutDir = dir;
      me.board = nb;
      syncShared(game);
      game.winner = p;
      game.phase = 'over';
      log(game, me.name + ' added the spout and ' + (me.name === 'You' ? 'win' : 'wins') + '!', 'win');
      return { ok: true, won: true };
    }
    // Everyone stuck with nothing left to draw: call it.
    if (game.turns > 600) {
      game.phase = 'over';
      game.winner = -1;
      log(game, 'The game ran out of steam. No winner.', 'win');
      return { ok: true, over: true };
    }
    game.turn = (p + 1) % game.players.length;
    startTurn(game);
    return { ok: true };
  }

  // Every legal move for player p (used by bots and to highlight targets).
  function legalMoves(game, p, onlyCardId) {
    const me = game.players[p];
    const moves = [];
    if (game.phase === 'over' || game.turn !== p) return moves;
    if (game.phase === 'wrenchDiscard') {
      for (const c of me.hand) if (!onlyCardId || c.id === onlyCardId) moves.push({ type: 'discard', cardId: c.id });
      return moves;
    }
    const seen = new Set();
    const push = (m) => {
      const key = [m.type, m.cardId, m.target, m.i, m.flip ? 1 : 0].join('|');
      if (seen.has(key)) return;
      if (checkMove(game, p, m).ok) {
        seen.add(key);
        moves.push(m);
      }
    };
    const targetsOf = (b) => [...new Set(openEnds(b).filter((e) => e.t >= 0).map((e) => e.t))];
    const flipsFor = (c) => (c.kind === 'pipe' && SYMMETRIC[c.shape] ? [false] : [false, true]);
    for (const c of me.hand) {
      if (onlyCardId && c.id !== onlyCardId) continue;
      game.players.forEach((tp, t) => {
        const b = tp.board;
        const targets = targetsOf(b);
        for (const flip of flipsFor(c)) {
          if (c.kind === 'pipe') {
            for (const i of targets) push({ type: 'pipe', cardId: c.id, target: t, i, flip });
            if (t === p) {
              const leak = leakAt(b);
              if (leak >= 0) push({ type: 'cover', cardId: c.id, target: t, i: leak, flip });
            } else push({ type: 'cover', cardId: c.id, target: t, i: b.last, flip });
          } else if (c.kind === 'cap') {
            for (const i of targets) push({ type: 'cap', cardId: c.id, target: t, i, flip });
            if (t === p) {
              const leak = leakAt(b);
              if (leak >= 0) push({ type: 'cover', cardId: c.id, target: t, i: leak, flip });
            }
          }
        }
      });
      if (c.kind === 'wrench') {
        const leak = leakAt(me.board);
        if (leak >= 0) moves.push({ type: 'wrench', cardId: c.id, i: leak, target: p });
      }
      moves.push({ type: 'discard', cardId: c.id });
    }
    if (!onlyCardId && me.wrenches > 0) {
      const leak = leakAt(me.board);
      if (leak >= 0) moves.push({ type: 'wrench', i: leak, target: p });
    }
    if (!onlyCardId && !me.hand.length) moves.push({ type: 'pass' });
    return moves;
  }

  // Would this own-pipeline move turn a finishable pipeline into one that can't be finished?
  function deadEndWarning(game, p, move) {
    if (move.target !== p || !['pipe', 'cap', 'cover'].includes(move.type)) return null;
    const me = game.players[p];
    const card = me.hand.find((c) => c.id === move.cardId);
    const before = analyze(me.board, game.required);
    if (!before.viable) return null;
    const after = analyze(boardAfter(me.board, move, card, p), game.required, { budget: 6000 });
    if (after.viable) return null;
    return "After this move there's no way to finish your pipeline: it can't reach a spot where the spout fits with enough cards.";
  }

  const api = {
    DIRS, OPP, SHAPES, SHAPE_KIND, REQUIRED, DECK_SPEC, DECK_TUNED, DECKS, BOARD_W, BOARD_H, ENDLESS,
    buildDeck, openingsOf, capAt, describeCard, capHasLeak,
    newBoard, cloneBoard, step, openEnds, capsInUse, leakAt, pieceLeaks, longestPath, progressOf,
    evalPipe, evalCap, attackCells, checkMove, boardAfter, spoutCell, analyze,
    newGame, applyMove, legalMoves, deadEndWarning, nextRand, syncShared, sharedLayout, coversLeak, SHARED, withForeignPiece,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LP = Object.assign(root.LP || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
