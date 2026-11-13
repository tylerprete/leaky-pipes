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
  let VALUE = null;
  try {
    VALUE = typeof module !== 'undefined' && module.exports ? (process.env.LP_VALUE_FILE ? require(process.env.LP_VALUE_FILE) : null) : root.LP_VALUE;
  } catch (e) {
    VALUE = null;
  }
  // tiny feed-forward network: ReLU hidden layers, sigmoid out
  function netWinProb(x) {
    let a = x.map((v, i) => (VALUE.sd[i] > 1e-3 ? (v - VALUE.mu[i]) / VALUE.sd[i] : 0));
    for (let l = 0; l < VALUE.W.length; l++) {
      const W = VALUE.W[l];
      const b = VALUE.b[l];
      const o = new Array(W.length);
      for (let j = 0; j < W.length; j++) {
        let t = b[j];
        const w = W[j];
        for (let i = 0; i < a.length; i++) t += w[i] * a[i];
        o[j] = l === VALUE.W.length - 1 ? t : t > 0 ? t : 0;
      }
      a = o;
    }
    return 1 / (1 + Math.exp(-a[0]));
  }

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
    block: 0, // shared table: weight on how much a placement crowds other pipelines (0 = ignore)
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
      for (const c of hand) if (c.kind === 'wrench') wrenches++; // a wrench card is a wrench in waiting
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

    // ---- features for the learned evaluation (tools/train-value.py) ----
    // Describes one player's standing using their board AND their hand. In the Hard bot's
    // look-ahead every hand is filled in (a guessed deal), so this is fair to use there.
    const SIDE = 13;
    function sideFeatures(game, i, p) {
      const pl = game.players[i];
      const b = pl.board;
      const hand = pl.hand;
      const cost = analyzeCost(game, b);
      const dead = cost >= CAP;
      const leak = LP.leakAt(b);
      const wcards = hand.filter((c) => c.kind === 'wrench').length;
      let canFix = 0;
      if (leak >= 0) {
        const piece = b.cells[leak];
        const cover = hand.some((c) => (piece.card.kind === 'pipe' ? c.kind === 'pipe' && c.mat !== 'leaky' && sameShapeAs(c, piece) : c.kind === 'cap' && !LP.capHasLeak(c)));
        canFix = cover || wcards || pl.wrenches > 0 ? 1 : 0;
      }
      let fit = 0;
      for (const c of hand) if (c.kind === 'pipe' && c.mat !== 'leaky' && LP.SHAPE_KIND[c.shape] !== 'T' && fits(b, c)) fit++;
      const last = b.cells[b.last];
      const ends = LP.openEnds(b).length;
      const n = game.players.length;
      return [
        dead ? 14 : Math.min(cost, 14),
        dead ? 1 : 0,
        leak >= 0 ? 1 : 0,
        canFix,
        pl.wrenches,
        wcards,
        fit,
        hand.filter((c) => c.kind === 'pipe' && c.mat === 'leaky').length,
        hand.some((c) => c.kind === 'cap' && !LP.capHasLeak(c)) ? 1 : 0,
        ends > 1 ? 1 : 0,
        dead ? 0 : Math.log2(1 + Math.min(16, freeAround(b))),
        last && last.card.kind === 'pipe' && last.card.mat === 'iron' && !last.repaired ? 1 : 0,
        ((i - game.turn + n) % n) / n + (i === game.turn && game.phase === 'wrenchDiscard' ? 0.5 : 0),
      ];
    }
    // me, then my most dangerous opponent, then the table
    function features(game, p) {
      const n = game.players.length;
      let rival = -1;
      let rivalV = -Infinity;
      let second = 14;
      const vals = game.players.map((pl, i) => (i === p ? null : theirValue(game, i, pl.board)));
      vals.forEach((v, i) => {
        if (i !== p && v > rivalV) {
          rivalV = v;
          rival = i;
        }
      });
      game.players.forEach((pl, i) => {
        if (i !== p && i !== rival) second = Math.min(second, Math.min(14, analyzeCost(game, pl.board)));
      });
      return sideFeatures(game, p, p).concat(sideFeatures(game, rival, p), [n === 2 ? 1 : 0, n === 3 ? 1 : 0, n === 4 ? 1 : 0, second, game.deck.length / 100]);
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
          if (n < 0 || b.cells[n] || seen.has(n) || (b.foreign && (b.foreign[n] || b.reserved[n]))) continue;
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
          if (m.cardId) {
            consider(m, myValue(game, p, nb, without(m.cardId), me.wrenches) - base);
            continue;
          }
          const drop = worstCard(game, p, me.hand, nb, me.wrenches - 1);
          consider(m, myValue(game, p, nb, without(drop), me.wrenches - 1) - base);
          continue;
        }
        const card = me.hand.find((c) => c.id === m.cardId);
        if (m.target === p) {
          const nb = LP.boardAfter(me.board, m, card, p);
          let s = myValue(game, p, nb, without(m.cardId), me.wrenches) - base;
          if (LP.spoutCell(nb, game.required) >= 0) s += 100;
          consider(m, s + crowding(game, p, m, card, myCostNow, costs, theirBase));
        } else {
          const tp = game.players[m.target];
          const nb = LP.boardAfter(tp.board, m, card, p);
          const lost = theirBase[m.target] - theirValue(game, m.target, nb);
          const mine = myValue(game, p, me.board, without(m.cardId), me.wrenches) - base;
          consider(m, mine + attackWeight(game, p, m.target, myCostNow, costs) * lost + crowding(game, p, m, card, myCostNow, costs, theirBase));
        }
      }
      return scored;
    }

    // Shared table: a card on the grid also takes room from nearby pipelines.
    function crowding(game, p, m, card, myCostNow, costs, theirBase) {
      if (!P.block || game.table !== 'shared' || (m.type !== 'pipe' && m.type !== 'cap')) return 0;
      const ob = game.players[m.target].board;
      const x = m.i % ob.w;
      const y = Math.floor(m.i / ob.w);
      let total = 0;
      game.players.forEach((pl, r) => {
        if (r === p || r === m.target) return;
        const rb = pl.board;
        const near = LP.openEnds(rb).some((e) => e.t >= 0 && Math.abs((e.t % rb.w) - x) + Math.abs(Math.floor(e.t / rb.w) - y) <= 4);
        if (!near) return;
        const nb = LP.withForeignPiece(rb, ob, m.i, { card, flip: !!m.flip });
        // the path-length estimate ignores detours, so measure lost elbow room too
        const room = (b) => Math.log2(1 + Math.min(16, freeAround(b)));
        const lost = theirBase[r] - theirValue(game, r, nb) + 2 * P.space * (room(rb) - room(nb));
        if (lost > 0) total += P.block * attackWeight(game, p, r, myCostNow, costs) * lost;
      });
      return total;
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

    return { params: P, chooseMove, scoreMoves, fits, features, myValue };
  }

  // ---------------------------------------------------------------- search
  // Hard level: take the heuristic's best few moves and play each forward a few rounds against
  // randomized guesses of the hidden cards (opponents' hands and the deck), then keep the move
  // that ends up best on average. Hidden cards are re-dealt at random: no peeking.
  function makeSearchBot(overrides, opts) {
    opts = Object.assign({ k: 5, r: 10, rounds: 3, budgetMs: 450, tau: 0.4, filterDepth: 1 }, opts || {});
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
      const shuffle = (a) => {
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };
      if (opts.cheat === 'hands') {
        // ceiling test only: knows the real hands, not the deck order
        g.deck = shuffle(g.deck.slice());
        g.rng = (seed * 2654435761) >>> 0;
        return;
      }
      const pool = g.deck.slice();
      g.players.forEach((pl, i) => {
        if (i !== p) pool.push(...pl.hand);
      });
      shuffle(pool);
      g.players.forEach((pl, i) => {
        if (i === p) return;
        const n = pl.hand.length;
        const parts = g._parts && g._parts[i];
        if (parts) {
          // pick a believed hand in proportion to how well it explains what this player did
          for (let tries = 0; tries < 6; tries++) {
            let x = rand() * parts.total;
            let pick = parts.list[parts.list.length - 1];
            for (const q of parts.list) if ((x -= q.w) <= 0) { pick = q; break; }
            const idx = pick.hand.map((c) => pool.indexOf(c));
            if (idx.some((k) => k < 0)) continue; // overlaps a hand already dealt
            idx.sort((a, b) => b - a).forEach((k) => pool.splice(k, 1));
            pl.hand = pick.hand.slice();
            return;
          }
        }
        const no = opts.infer ? unlikely(pl) : null;
        if (!no) {
          pl.hand = pool.splice(0, n);
          return;
        }
        // deal around the cards this player has shown they probably don't hold
        const hand = [];
        for (let k = 0; k < pool.length && hand.length < n; ) {
          if (no(pool[k]) && rand() < opts.infer && pool.length - k > n - hand.length) k++;
          else hand.push(pool.splice(k, 1)[0]);
        }
        while (hand.length < n && pool.length) hand.push(pool.shift());
        pl.hand = hand;
      });
      shuffle(pool);
      g.deck = pool;
      g.rng = (seed * 2654435761) >>> 0;
    }
    // ---- belief about opponents' hands ----
    // Sample many hands an opponent could hold, and weight each by how likely a sensible player
    // holding it would have done what they just did (and, optionally, the turn before).
    const sameMv = (a, b) => a.type === b.type && a.cardId === b.cardId && a.target === b.target && a.i === b.i && !!a.flip === !!b.flip;
    function actLikelihood(g, o, act, hand) {
      const fake = Object.assign({}, g, {
        turn: o,
        phase: 'play',
        players: g.players.map((pl, i) => Object.assign({}, pl, { board: act.boards[i], wrenches: act.wr[i], hand: i === o ? hand : pl.hand })),
      });
      const sc = base.scoreMoves(fake, o);
      let max = -Infinity;
      let obs = null;
      for (const x of sc) {
        if (x.score > max) max = x.score;
        if (obs == null && sameMv(x.m, act.move)) obs = x.score;
      }
      if (obs == null) return 0.02;
      return Math.max(0.02, Math.exp((obs - max) / opts.tau));
    }
    function buildParticles(g, p, seed) {
      let s = (seed ^ 0x9e3779b9) >>> 0;
      const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      const pool = g.deck.slice();
      g.players.forEach((pl, i) => {
        if (i !== p) pool.push(...pl.hand);
      });
      const out = {};
      g.players.forEach((pl, o) => {
        const a = pl.lastAct;
        if (o === p || !a || !a.boards || pl.hand.length === 0 || pool.length <= pl.hand.length) return;
        const n = pl.hand.length;
        const list = [];
        let total = 0;
        for (let k = 0; k < opts.filter; k++) {
          // partial shuffle: n random cards from the pool
          for (let j = 0; j < n; j++) {
            const r = j + Math.floor(rand() * (pool.length - j));
            [pool[j], pool[r]] = [pool[r], pool[j]];
          }
          const hand = pool.slice(0, n);
          const then = hand.concat(a.card ? [a.card] : [], a.dropped ? [a.dropped] : []);
          let w = actLikelihood(g, o, a, then);
          const b = pl.prevAct;
          if (opts.filterDepth > 1 && b && b.boards && w > 0.05) {
            // the turn before: one of today's cards was drawn since, we don't know which
            const base6 = hand.concat(a.card ? [a.card] : [], a.dropped ? [a.dropped] : []);
            let acc = 0;
            for (let d = 0; d < base6.length; d++) {
              const h2 = base6.filter((_, q) => q !== d).concat(b.card ? [b.card] : [], b.dropped ? [b.dropped] : []);
              acc += actLikelihood(g, o, b, h2);
            }
            w *= acc / base6.length;
          }
          list.push({ hand, w });
          total += w;
        }
        out[o] = { list, total };
      });
      return out;
    }

    // Reading an opponent's last turn. Every card they hold now was in their hand when they
    // chose, so: sitting on a leak means no wrench card and no matching cover; discarding with a
    // clean pipeline means none of their good pipes fit it.
    function unlikely(pl) {
      const a = pl.lastAct;
      if (!a) return null;
      const b = a.board;
      const leak = LP.leakAt(b);
      if (leak >= 0) {
        if (a.type === 'wrench' || (a.type === 'cover' && a.own)) return null;
        const piece = b.cells[leak];
        return (c) => {
          if (c.kind === 'wrench') return true;
          if (piece.card.kind === 'cap') return c.kind === 'cap' && !LP.capHasLeak(c);
          return c.kind === 'pipe' && LP.coversLeak(b, leak, c);
        };
      }
      if (a.type !== 'discard' && a.type !== 'pass') return null;
      const memo = new Map();
      return (c) => {
        if (c.kind !== 'pipe' || c.mat === 'leaky') return false;
        if (!memo.has(c.shape)) memo.set(c.shape, base.fits(b, c));
        return memo.get(c.shape);
      };
    }
    function evaluate(g, p) {
      if (opts.value && VALUE) {
        if (g.phase === 'over') return g.winner === p ? 1 : g.winner >= 0 ? 0 : 0.5 / g.players.length;
        return netWinProb(base.features(g, p));
      }
      if (g.phase === 'over') return g.winner === p ? 50 : g.winner >= 0 ? -50 : 0;
      if (opts.leaf === 'hand') {
        // same scale as below, but each side is judged with its (dealt) hand too
        const hv = (i) => base.myValue(g, i, g.players[i].board, g.players[i].hand, g.players[i].wrenches);
        let best = -Infinity;
        g.players.forEach((_, i) => {
          if (i !== p) best = Math.max(best, hv(i));
        });
        return hv(p) - best;
      }
      if (opts.leaf === 'mix' && VALUE) {
        // today's evaluation nudged by the learned win chance (in log-odds, ~0.3 per card)
        const w = Math.min(0.98, Math.max(0.02, netWinProb(base.features(g, p))));
        return (1 - opts.mix) * evalOld(g, p) + opts.mix * (Math.log(w / (1 - w)) / 0.31);
      }
      return evalOld(g, p);
    }
    function evalOld(g, p) {
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
      if (opts.filter) g = Object.assign({}, g, { _parts: buildParticles(g, p, g.seq * 31 + p) });
      const totals = cands.map(() => 0);
      let n = 0;
      const plies = opts.rounds * g.players.length;
      for (let it = 0; it < opts.r; it++) {
        if (Date.now() - t0 > opts.budgetMs && n > 0) break;
        const seed = (g.seq * 7919 + it * 104729 + p) >>> 0;
        cands.forEach((m, ci) => {
          const c = clone(g);
          if (!opts.cheat) determinize(c, p, seed); // cheat: sees real hands and deck order (ceiling test only)
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
    return { params: P, chooseMove, search: true, buildParticles };
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
