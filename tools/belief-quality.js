// How much does watching an opponent's moves tell you about their hand?
// Overlap = how many of the 5 cards in a believed hand match the real hand by kind (0-5).
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const key = (c) => (c.kind === 'pipe' ? (c.mat === 'leaky' ? 'L' : 'G') + LP.SHAPE_KIND[c.shape] + (c.kind === 'pipe' && LP.SHAPE_KIND[c.shape] !== 'straight' ? c.shape : c.shape) : c.kind);
const overlap = (a, b) => { const m = {}; a.forEach((c) => (m[key(c)] = (m[key(c)] || 0) + 1)); let n = 0; b.forEach((c) => { if (m[key(c)] > 0) { m[key(c)]--; n++; } }); return n; };
const has = (h, f) => (h.some(f) ? 1 : 0);
const F = { 'holds a leaky pipe': (c) => c.kind === 'pipe' && c.mat === 'leaky', 'holds a wrench card': (c) => c.kind === 'wrench', 'holds a cap': (c) => c.kind === 'cap' };
const opp = process.argv[2] || 'v2';
for (const depth of [0, 1, 2]) {
  let ov = 0, n = 0; const brier = {}; Object.keys(F).forEach((k) => (brier[k] = 0));
  for (let seed = 1; seed <= 12; seed++) {
    const g = LP.newGame({ players: [{ name: 'A', kind: 'bot' }, { name: 'B', kind: 'bot' }], seed, deck: 'tuned' });
    const s = B.makeSearchBot({}, { filter: 80, filterDepth: depth || 1, tau: depth ? 0.4 : 1e9 });
    const me = B.makeBot(), them = opp === 'v1' ? require('../bots/v1.js') : opp === 'normal' ? B.forLevel('normal') : B.makeBot();
    let guard = 0;
    while (g.phase !== 'over' && guard++ < 400) {
      if (g.turn === 0 && g.phase === 'play' && g.players[1].lastAct) {
        const parts = s.buildParticles(g, 0, seed * 1000 + g.seq)[1];
        if (parts) {
          const truth = g.players[1].hand; n++;
          let o = 0; parts.list.forEach((q) => (o += q.w * overlap(q.hand, truth))); ov += o / parts.total;
          for (const [k, f] of Object.entries(F)) { let pr = 0; parts.list.forEach((q) => (pr += q.w * has(q.hand, f))); pr /= parts.total; brier[k] += (pr - has(truth, f)) ** 2; }
        }
      }
      const r = LP.applyMove(g, g.turn, (g.turn === 0 ? me : them).chooseMove(g, g.turn)); if (!r.ok) throw new Error(r.reason);
    }
  }
  console.log(`${depth === 0 ? 'no inference        ' : 'last ' + depth + ' move(s) read '} vs ${opp}: overlap ${(ov / n).toFixed(2)}/5   error (lower is better): ${Object.entries(brier).map(([k, v]) => k + ' ' + (v / n).toFixed(3)).join(', ')}`);
}
