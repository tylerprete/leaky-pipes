/* Leaky Pipes computer opponent: builds toward a finishable line, caps its T's, repairs,
 * and throws leaks at whoever is closest to winning. */
(function (root) {
  'use strict';
  const LP = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.LP;

  function cost(game, b) {
    const a = LP.analyze(b, game.required);
    if (!a.viable) return Infinity;
    return a.cost + (LP.leakAt(b) >= 0 ? 1.5 : 0);
  }

  function cardById(pl, id) {
    return pl.hand.find((c) => c.id === id);
  }

  function chooseMove(game, p) {
    const me = game.players[p];
    const moves = LP.legalMoves(game, p);
    if (game.phase === 'wrenchDiscard') return { type: 'discard', cardId: worstCard(game, p, moves) };
    const rnd = () => LP.nextRand(game) * 0.01;

    const myBefore = cost(game, me.board);
    const leak = LP.leakAt(me.board);

    // 1. Repairs come first.
    if (leak >= 0) {
      const covers = moves.filter((m) => m.type === 'cover' && m.target === p);
      if (covers.length) {
        // Prefer covering with iron; keep copper for building.
        covers.sort((a, b) => (cardById(me, a.cardId).mat === 'copper') - (cardById(me, b.cardId).mat === 'copper'));
        return covers[0];
      }
      const caps = moves.filter((m) => m.type === 'cap' && m.target === p);
      let bestCap = null;
      for (const m of caps) {
        const after = cost(game, LP.boardAfter(me.board, m, cardById(me, m.cardId), p));
        if (after <= myBefore && (!bestCap || after < bestCap.after)) bestCap = { m, after };
      }
      if (bestCap) return bestCap.m;
      if (me.wrenches > 0) return { type: 'wrench', i: leak, target: p };
    }

    // 2. Building on our own pipeline.
    let bestOwn = null;
    const hasGoodCap = me.hand.some((c) => c.kind === 'cap' && !LP.capHasLeak(c));
    if (leak < 0 || moves.some((m) => m.target === p && m.type === 'cap')) {
      for (const m of moves) {
        if (m.target !== p || (m.type !== 'pipe' && m.type !== 'cap')) continue;
        const card = cardById(me, m.cardId);
        const nb = LP.boardAfter(me.board, m, card, p);
        const after = cost(game, nb);
        if (after === Infinity) continue;
        let score = (myBefore === Infinity ? 0 : myBefore) - after;
        if (myBefore === Infinity) score = 1;
        if (card.kind === 'pipe' && card.mat === 'copper') score += 0.05; // copper end can't be leaked on top
        if (card.kind === 'pipe' && LP.SHAPE_KIND[card.shape] === 'T') score += hasGoodCap ? 0.3 : -0.2;
        if (LP.spoutCell(nb, game.required) >= 0) score += 100;
        score += rnd();
        if (!bestOwn || score > bestOwn.score) bestOwn = { m, score };
      }
    }

    // 3. Attacks on opponents.
    let bestAtk = null;
    let leaderCost = Infinity;
    const oppCost = game.players.map((pl, i) => (i === p ? Infinity : cost(game, pl.board)));
    for (const c of oppCost) leaderCost = Math.min(leaderCost, c);
    for (const m of moves) {
      if (m.target === p || m.type === 'discard' || m.type === 'wrench') continue;
      const tp = game.players[m.target];
      const before = oppCost[m.target];
      if (before === Infinity) continue; // already stuck; leave them be
      const nb = LP.boardAfter(tp.board, m, cardById(me, m.cardId), p);
      const after = cost(game, nb);
      let damage = Math.min(after, before + 4) - before;
      if (tp.wrenches === 0) damage += 0.5;
      if (m.type === 'cover') damage += 0.3; // on-top leaks need the exact shape to fix
      const urgency = 1 / (1 + before);
      const score = damage * (1 + 3 * urgency) + rnd();
      if (!bestAtk || score > bestAtk.score) bestAtk = { m, score, damage, before };
    }

    const iCanFinishSoon = bestOwn && bestOwn.score >= 100;
    if (iCanFinishSoon) return bestOwn.m;
    if (bestAtk && bestAtk.damage > 0 && leaderCost <= 2 && leaderCost < myBefore) return bestAtk.m;
    if (bestOwn && bestOwn.score > 0.5) return bestOwn.m;
    if (bestAtk && bestAtk.damage > 0.5) return bestAtk.m;
    if (bestOwn && bestOwn.score > -0.1 && myBefore !== Infinity) return bestOwn.m;
    return { type: 'discard', cardId: worstCard(game, p, moves) };
  }

  // Lowest-value card in hand.
  function worstCard(game, p, moves) {
    const me = game.players[p];
    const ends = LP.openEnds(me.board).length;
    let worst = null;
    const leakyCount = me.hand.filter((c) => c.kind === 'pipe' && c.mat === 'leaky').length;
    for (const c of me.hand) {
      const playable = moves.some((m) => m.cardId === c.id && m.type !== 'discard');
      let v;
      if (c.kind === 'cap') v = ends > 1 ? 9 : 4;
      else if (c.mat === 'leaky') v = (playable ? 6 : 3) - (leakyCount > 2 ? 3 : 0);
      else if (LP.SHAPE_KIND[c.shape] === 'T') v = 3;
      else v = playable ? 7 : 4;
      if (c.kind === 'pipe' && c.mat === 'copper') v += 0.5;
      v += LP.nextRand(game) * 0.1;
      if (!worst || v < worst.v) worst = { id: c.id, v };
    }
    return worst ? worst.id : me.hand[0].id;
  }

  const api = { chooseMove };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LP = Object.assign(root.LP || {}, { bot: api });
})(typeof window !== 'undefined' ? window : globalThis);
