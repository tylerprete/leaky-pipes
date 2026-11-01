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
    return deck;
  }

  function openingsOf(card, flip) {
    if (card.kind === 'pipe') {
      const base = SHAPES[card.shape];
      return flip ? base.map((d) => OPP[d]) : base.slice();
    }
    if (card.kind === 'valve') return ['W'];
    if (card.kind === 'spout') return ['E'];
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
  function capHasLeak(card) {
    return card.kind === 'cap' && DIRS.some((d) => card.caps[d] === 'leaky');
  }
  function describeCard(card) {
    if (card.kind === 'cap') return capHasLeak(card) ? 'cap card (with a leaky cap)' : 'cap card';
    if (card.kind === 'valve') return 'valve';
    if (card.kind === 'spout') return 'spout';
    return card.mat + ' ' + SHAPE_KIND[card.shape];
  }

  // ---------- board ----------
  function newBoard(owner, w, h) {
    w = w || BOARD_W;
    h = h || BOARD_H;
    const cells = new Array(w * h).fill(null);
    const valve = Math.floor(h / 2) * w + (w - 1);
    cells[valve] = { card: { id: 'valve' + owner, kind: 'valve' }, flip: false, repaired: false, wrench: false, under: [], by: owner };
    return { w, h, cells, valve, last: valve, owner, spout: -1 };
  }
  function cloneBoard(b) {
    return Object.assign({}, b, { cells: b.cells.slice() });
  }
  function step(b, i, d) {
    const x = (i % b.w) + DX[d];
    const y = Math.floor(i / b.w) + DY[d];
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) return -1;
    return y * b.w + x;
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
        if (n < 0) ends.push({ i, d, t: -1 });
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
      const into = step(b, b.spout, 'E');
      best = Math.max(best, longestPath(b, into));
    }
    return best;
  }

  // ---------- placement checks (pure geometry) ----------
  function fail(reason) {
    return { ok: false, reason };
  }

  function evalPipe(b, i, card, flip) {
    if (i < 0 || b.cells[i]) return fail('That spot is taken.');
    const O = openingsOf(card, flip);
    const conns = [];
    for (const d of DIRS) {
      const n = step(b, i, d);
      const open = O.includes(d);
      if (n < 0) {
        if (open) return fail("A pipe can't point off the edge of the table.");
        continue;
      }
      const q = b.cells[n];
      if (!q) continue;
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
    if (i < 0 || b.cells[i]) return fail('That spot is taken.');
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
      if (me.wrenches <= 0) return fail('You have no wrenches left.');
      return { ok: true };
    }

    const card = me.hand.find((c) => c.id === move.cardId);
    if (!card) return fail("That card isn't in your hand.");
    if (move.type === 'discard') return { ok: true };

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
        return evalPipe(b, move.i, card, move.flip);
      }
      if (card.mat !== 'leaky') return fail("You can't play a good pipe on an opponent's pipeline.");
      if (leak >= 0) return fail('That pipeline already has a leak.');
      const r = evalPipe(b, move.i, card, move.flip);
      if (!r.ok) return r;
      const atk = attackCells(b);
      if (!r.conns.some((c) => atk.has(c.n))) return fail('A leaky pipe must go next to the last card played.');
      if (strandsOpponent(game, b, move, card, p)) return fail(STRAND_MSG);
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
        return r;
      }
      if (leak >= 0) return fail('That pipeline already has a leak.');
      if (!r.used.some((u) => u.mat === 'leaky')) return fail('On an opponent you can only play a leaky cap.');
      const atk = attackCells(b);
      if (!r.used.some((u) => atk.has(u.n))) return fail('A leaky cap must go next to the last card played.');
      if (strandsOpponent(game, b, move, card, p)) return fail(STRAND_MSG);
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
    if (e.d !== 'W' || e.t < 0) return -1;
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
      const turn = E.d === 'W' ? 0 : E.d === 'E' ? 2 : 1;
      const others = new Set(ends.filter((x) => x !== E && x.t !== E.t).map((x) => x.t));
      const cost = Math.max(needed, turn) + others.size;
      if (cost < res.cost) res.cost = cost;
    }
    return res;
  }

  function pathSearch(b, E, needed, byTarget, budget) {
    const free = (i) => i >= 0 && !b.cells[i];
    const othersAt = (i) => (byTarget.get(i) || []).filter((x) => x !== E);
    const spoutOk = (s, visited) => free(s) && !visited.has(s) && !byTarget.has(s);
    // Zero more cards: spout goes straight onto this end.
    if (needed === 0 && E.d === 'W' && othersAt(E.t).length === 0) return true;
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
        const s = step(b, cell, 'W');
        if (inSide !== 'W' && spoutOk(s, visited)) return true;
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
  function newGame(opts) {
    const specs = opts.players;
    const n = specs.length;
    if (n < 2 || n > 4) throw new Error('2–4 players');
    const game = {
      v: 1,
      rng: (opts.seed >>> 0) || (Math.floor(Math.random() * 4294967296) >>> 0),
      players: specs.map((s, i) => ({ name: s.name, kind: s.kind, hand: [], wrenches: 2, board: newBoard(i, opts.w, opts.h) })),
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
    game.deck = shuffle(game, buildDeck(opts.deckSpec));
    for (let k = 0; k < 5; k++) for (const pl of game.players) pl.hand.push(game.deck.pop());
    game.turn = opts.first != null ? opts.first : 0;
    startTurn(game);
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

  function startTurn(game) {
    const pl = game.players[game.turn];
    game.phase = 'play';
    game.turns++;
    const c = drawCard(game);
    game.drawn = c ? c.id : null;
    if (c) pl.hand.push(c);
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
    if (move.type === 'discard') {
      const c = removeFromHand(me, move.cardId);
      game.discard.push(c);
      log(game, who + ' discarded ' + an(describeCard(c)) + '.');
      return endTurn(game);
    }
    if (move.type === 'wrench') {
      me.board = boardAfter(me.board, move, null, p);
      me.wrenches--;
      game.phase = 'wrenchDiscard';
      log(game, who + ' fixed a leak with a wrench.', 'repair');
      return { ok: true, needDiscard: true };
    }
    const card = removeFromHand(me, move.cardId);
    const tp = game.players[move.target];
    tp.board = boardAfter(tp.board, move, card, p);
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
      nb.cells[s] = { card: { id: 'spout' + p, kind: 'spout' }, flip: false, repaired: false, wrench: false, under: [], by: p };
      nb.spout = s;
      me.board = nb;
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
      moves.push({ type: 'discard', cardId: c.id });
    }
    if (!onlyCardId && me.wrenches > 0) {
      const leak = leakAt(me.board);
      if (leak >= 0) moves.push({ type: 'wrench', i: leak, target: p });
    }
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
    return "After this move there's no way to finish your pipeline: it can't reach a spot where the spout pours left and down with enough cards.";
  }

  const api = {
    DIRS, OPP, SHAPES, SHAPE_KIND, REQUIRED, DECK_SPEC, BOARD_W, BOARD_H,
    buildDeck, openingsOf, capAt, describeCard, capHasLeak,
    newBoard, cloneBoard, step, openEnds, capsInUse, leakAt, pieceLeaks, longestPath, progressOf,
    evalPipe, evalCap, attackCells, checkMove, boardAfter, spoutCell, analyze,
    newGame, applyMove, legalMoves, deadEndWarning, nextRand,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LP = Object.assign(root.LP || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
