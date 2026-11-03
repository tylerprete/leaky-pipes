/* Leaky Pipes computer opponents.
 *
 * Every candidate move is scored by how it changes a single position value:
 *   my value     = -(turns I still need) + hand quality + safety
 *   their value  = -(turns they still need) - leak trouble
 * score(move) = Δ my value + attackWeight(target) × (their value lost)
 * The weights in PARAMS were tuned by self-play (see tools/arena.js and tools/tune.js).
 * Bots only use public information: boards, discards, their own hand.
 */
(function (root) {
  'use strict';
  const LP = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.LP;

  const PARAMS = {
    fit: 0.6, // value of holding cards that can extend the pipeline next turn
    fitDecay: 0.5, // each extra fitting card is worth this fraction of the previous one
    exposed: 0.25, // penalty: last card is iron (an opponent can drop a same-shape leak on it)
    space: 0.15, // value of free room around the growing end (log scale)
    ammo: 0.15, // value per leaky card held, up to ammoMax
    ammoMax: 2,
    capHeld: 0.3, // value of holding a good cap while a T is open
    wrench: 0.45, // value of each unused wrench
    leakMine: 1.2, // cost of a leak on my own pipeline (turns), more if no way to fix in hand
    leakTheirs: 1.0, // turns a leak costs an opponent who still has a wrench
    leakTheirsNoWrench: 1.8,
    atk: 1.0, // attack weight in 2-player games
    nonLeader: 0.45, // multiplier for hurting someone who isn't the leader (3–4 players)
    race: 0.25, // extra attack weight per turn the target is ahead of me
    tPenalty: 0.15,
    west: 0, // pull toward a left-heading line near the finish (set per table below)
    westWithin: 4,
    noise: 0,
  };

  const CAP = 30; // stand-in for "can't finish"

  function makeBot(overrides) {
    const P = Object.assign({}, PARAMS, overrides || {});
    const rnd = (game) => (P.noise ? (LP.nextRand(game) - 0.5) * P.noise : 0);

    const cache = new WeakMap();
    function analyzeCost(game, b) {
      let c = cache.get(b);
      if (c === undefined) {
        const a = LP.analyze(b, game.required);
        c = a.viable ? a.cost : CAP;
        cache.set(b, c);
      }
      return c;
    }

    // Can this card extend board b for its owner right now? (ignores leaks)
    function fits(b, card) {
      if (card.kind === 'pipe' && card.mat === 'leaky') return false;
      const targets = new Set(LP.openEnds(b).filter((e) => e.t >= 0).map((e) => e.t));
      const flips = card.kind === 'pipe' && (card.shape === 'V' || card.shape === 'H') ? [false] : [false, true];
      for (const i of targets) {
        for (const f of flips) {
          const r = card.kind === 'cap' ? LP.evalCap(b, i, card, f) : LP.evalPipe(b, i, card, f);
          if (!r.ok) continue;
          if (card.kind === 'cap') return LP.openEnds(b).length > 1;
          return true;
        }
      }
      return false;
    }

    function myValue(game, p, b, hand, wrenches) {
      const cost = analyzeCost(game, b);
      let v = -cost;
      // hand fit
      let n = 0;
      for (const c of hand) if (c.kind === 'pipe' && c.mat !== 'leaky' && LP.SHAPE_KIND[c.shape] !== 'T' && fits(b, c)) n++;
      v += P.fit * (n ? (1 - Math.pow(P.fitDecay, n)) / (1 - P.fitDecay) : 0);
      // leak on my pipeline
      const leak = LP.leakAt(b);
      if (leak >= 0) {
        const piece = b.cells[leak];
        const canCover = hand.some((c) =>
          piece.card.kind === 'pipe'
            ? c.kind === 'pipe' && c.mat !== 'leaky' && sameShapeAs(c, piece)
            : c.kind === 'cap' && !LP.capHasLeak(c)
        );
        v -= canCover || wrenches > 0 ? P.leakMine : P.leakMine + 1.2;
      }
      // exposure of the last card to an on-top leak
      const last = b.cells[b.last];
      if (last && last.card.kind === 'pipe' && last.card.mat === 'iron' && !last.repaired) v -= P.exposed;
      // room to grow
      if (cost < CAP) v += P.space * Math.log2(1 + Math.min(16, freeAround(b)));
      // Near the finish, a line already heading left is easy to cap with the spout.
      if (P.west && cost < CAP && cost <= P.westWithin) {
        let head = -Infinity;
        for (const e of LP.openEnds(b)) if (e.t >= 0) head = Math.max(head, e.d === 'W' ? 1 : e.d === 'E' ? -0.5 : 0.3);
        if (head > -Infinity) v += P.west * head;
      }
      // resources
      v += P.wrench * wrenches;
      const leaky = hand.filter((c) => c.kind === 'pipe' && c.mat === 'leaky').length;
      v += P.ammo * Math.min(leaky, P.ammoMax);
      const openEnds = LP.openEnds(b).length;
      if (openEnds > 1 && hand.some((c) => c.kind === 'cap' && !LP.capHasLeak(c))) v += P.capHeld;
      if (openEnds > 1) v -= P.tPenalty;
      return v;
    }

    function theirValue(game, t, b) {
      const pl = game.players[t];
      const cost = analyzeCost(game, b);
      let v = -cost;
      if (LP.leakAt(b) >= 0) v -= pl.wrenches > 0 ? P.leakTheirs : P.leakTheirsNoWrench;
      return v;
    }

    function sameShapeAs(card, piece) {
      const a = LP.openingsOf(card, false);
      const b = LP.openingsOf(piece.card, piece.flip);
      const c = LP.openingsOf(card, true);
      const same = (x, y) => x.length === y.length && x.every((d) => y.includes(d));
      return same(a, b) || same(c, b);
    }

    function freeAround(b) {
      // free cells reachable from the open ends (bounded)
      const seen = new Set();
      const q = LP.openEnds(b).filter((e) => e.t >= 0).map((e) => e.t);
      for (const i of q) seen.add(i);
      while (q.length && seen.size < 20) {
        const i = q.pop();
        for (const d of LP.DIRS) {
          const n = LP.step(b, i, d);
          if (n < 0 || b.cells[n] || seen.has(n)) continue;
          seen.add(n);
          q.push(n);
        }
      }
      return seen.size;
    }

    function attackWeight(game, p, t, myCostNow, costs) {
      const n = game.players.length;
      let leader = -1;
      let best = Infinity;
      costs.forEach((c, i) => {
        if (i !== p && c < best) {
          best = c;
          leader = i;
        }
      });
      let w = P.atk;
      if (n > 2 && t !== leader) w *= P.nonLeader;
      const ahead = Math.max(0, myCostNow - costs[t]);
      w *= 1 + P.race * ahead;
      return w;
    }

    function scoreMoves(game, p) {
      const me = game.players[p];
      const moves = LP.legalMoves(game, p);

      const base = myValue(game, p, me.board, me.hand, me.wrenches);
      const myCostNow = analyzeCost(game, me.board);
      const costs = game.players.map((pl, i) => (i === p ? myCostNow : analyzeCost(game, pl.board)));
      const theirBase = game.players.map((pl, i) => (i === p ? 0 : theirValue(game, i, pl.board)));

      const scored = [];
      const consider = (m, score) => {
        scored.push({ m, score: score + rnd(game) });
      };
      const without = (id) => me.hand.filter((c) => c.id !== id);

      for (const m of moves) {
        if (m.type === 'discard') {
          const hand = without(m.cardId);
          consider(m, myValue(game, p, me.board, hand, me.wrenches) - base);
          continue;
        }
        if (m.type === 'pass') continue;
        if (m.type === 'wrench') {
          const nb = LP.boardAfter(me.board, m, null, p);
          const drop = worstCard(game, p, me.hand, nb, me.wrenches - 1);
          consider(m, myValue(game, p, nb, without(drop), me.wrenches - 1) - base);
          continue;
        }
        const card = me.hand.find((c) => c.id === m.cardId);
        if (m.target === p) {
          const nb = LP.boardAfter(me.board, m, card, p);
          let s = myValue(game, p, nb, without(m.cardId), me.wrenches) - base;
          if (LP.spoutCell(nb, game.required) >= 0) s += 100;
          consider(m, s);
        } else {
          const tp = game.players[m.target];
          const nb = LP.boardAfter(tp.board, m, card, p);
          const lost = theirBase[m.target] - theirValue(game, m.target, nb);
          const mine = myValue(game, p, me.board, without(m.cardId), me.wrenches) - base;
          consider(m, mine + attackWeight(game, p, m.target, myCostNow, costs) * lost);
        }
      }
      return scored;
    }

    function chooseMove(game, p) {
      const me = game.players[p];
      if (game.phase === 'wrenchDiscard') return { type: 'discard', cardId: worstCard(game, p, me.hand, me.board, me.wrenches) };
      if (!me.hand.length) return LP.legalMoves(game, p).find((m) => m.type === 'wrench') || { type: 'pass' };
      const scored = scoreMoves(game, p);
      let best = null;
      for (const x of scored) if (!best || x.score > best.score) best = x;
      return best ? best.m : { type: 'discard', cardId: me.hand[0].id };
    }

    function worstCard(game, p, hand, board, wrenches) {
      let worst = null;
      for (const c of hand) {
        const rest = hand.filter((h) => h !== c);
        const v = myValue(game, p, board, rest, wrenches) + (LP.nextRand(game) - 0.5) * 1e-6;
        // dropping the card that leaves the best hand behind
        if (!worst || v > worst.v) worst = { id: c.id, v };
      }
      return worst ? worst.id : hand[0] && hand[0].id;
    }

    return { params: P, chooseMove, scoreMoves };
  }

  // ---------------------------------------------------------------- search
  // Hard level: take the heuristic's best few moves and play each forward a few rounds against
  // randomized guesses of the hidden cards (opponents' hands and the deck), then keep the move
  // that ends up best on average. Hidden cards are re-dealt at random: no peeking.
  function makeSearchBot(overrides, opts) {
    opts = Object.assign({ k: 5, r: 10, rounds: 3, budgetMs: 450 }, opts || {});
    const base = makeBot(overrides);
    const roll = makeBot(Object.assign({}, overrides, { noise: 0.35 }));
    const P = base.params;

    function clone(g) {
      return Object.assign({}, g, {
        players: g.players.map((pl) => Object.assign({}, pl, { hand: pl.hand.slice() })),
        deck: g.deck.slice(),
        discard: g.discard.slice(),
        log: [],
      });
    }
    function determinize(g, p, seed) {
      let s = seed >>> 0;
      const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      const pool = g.deck.slice();
      g.players.forEach((pl, i) => {
        if (i !== p) pool.push(...pl.hand);
      });
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      g.players.forEach((pl, i) => {
        if (i !== p) pl.hand = pool.splice(0, pl.hand.length);
      });
      g.deck = pool;
      g.rng = (seed * 2654435761) >>> 0;
    }
    function evaluate(g, p) {
      if (g.phase === 'over') return g.winner === p ? 50 : g.winner >= 0 ? -50 : 0;
      const cost = (b) => {
        const a = LP.analyze(b, g.required);
        return a.viable ? a.cost : CAP;
      };
      const val = (i) => {
        const pl = g.players[i];
        let v = -cost(pl.board);
        if (LP.leakAt(pl.board) >= 0) v -= pl.wrenches > 0 ? P.leakTheirs : P.leakTheirsNoWrench;
        return v + 0.3 * pl.wrenches;
      };
      const mine = val(p);
      let bestOpp = -Infinity;
      g.players.forEach((_, i) => {
        if (i !== p) bestOpp = Math.max(bestOpp, val(i));
      });
      return mine - bestOpp;
    }
    function candidates(g, p) {
      const scored = base.scoreMoves(g, p).sort((a, b) => b.score - a.score);
      const out = [];
      for (const x of scored) {
        if (out.some((m) => sameMove(m, x.m))) continue;
        out.push(x.m);
        if (out.length >= opts.k) break;
      }
      return out;
    }
    function chooseMove(g, p) {
      if (g.phase === 'wrenchDiscard' || !g.players[p].hand.length) return base.chooseMove(g, p);
      const t0 = Date.now();
      const cands = candidates(g, p);
      if (cands.length <= 1) return cands[0] || base.chooseMove(g, p);
      const totals = cands.map(() => 0);
      let n = 0;
      const plies = opts.rounds * g.players.length;
      for (let it = 0; it < opts.r; it++) {
        if (Date.now() - t0 > opts.budgetMs && n > 0) break;
        const seed = (g.seq * 7919 + it * 104729 + p) >>> 0;
        cands.forEach((m, ci) => {
          const c = clone(g);
          determinize(c, p, seed);
          let r = LP.applyMove(c, p, m);
          if (!r.ok) {
            totals[ci] -= 999;
            return;
          }
          let guard = 0;
          while (c.phase !== 'over' && guard++ < plies) {
            const q = c.turn;
            const mv = roll.chooseMove(c, q);
            r = LP.applyMove(c, q, mv);
            if (!r.ok) break;
          }
          totals[ci] += evaluate(c, p);
        });
        n++;
      }
      let bi = 0;
      totals.forEach((t, i) => {
        if (t > totals[bi] + 1e-9) bi = i;
      });
      return cands[bi];
    }
    function sameMove(a, b) {
      return a.type === b.type && a.cardId === b.cardId && a.target === b.target && a.i === b.i && !!a.flip === !!b.flip;
    }
    return { params: P, chooseMove, search: true };
  }

  const LEVELS = {
    easy: { noise: 1.6, fit: 0.2, atk: 0.5, exposed: 0, race: 0 },
    normal: { noise: 0.5 },
    hard: { search: true },
  };
  const defaultBot = makeBot();
  const api = {
    PARAMS,
    LEVELS,
    makeBot,
    makeSearchBot,
    forLevel: (lvl) => (lvl === 'hard' ? makeSearchBot({}) : makeBot(LEVELS[lvl] || {})),
    chooseMove: (game, p) => defaultBot.chooseMove(game, p),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LP = Object.assign(root.LP || {}, { bot: api });
})(typeof window !== 'undefined' ? window : globalThis);
