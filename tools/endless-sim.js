// Endless-table check: how far do pipelines wander from the valve, how long are games, how fast are bots?
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const N = +(process.argv[2] || 100);
const useSearch = process.argv[3] === 'search';
for (const n of [2, 3, 4]) {
  let maxReach = 0, turns = 0, slow = 0, dec = 0, t = 0, dead = 0;
  const reach = [];
  for (let s = 1; s <= N; s++) {
    const g = LP.newGame({ players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, kind: 'bot' })), seed: 4242 + s * 13 + n, table: 'endless', spoutRule: process.env.SPOUT || 'away' });
    const bots = g.players.map(() => (useSearch ? B.makeSearchBot({}) : B.makeBot()));
    let guard = 0;
    while (g.phase !== 'over' && guard++ < 3000) {
      const t0 = Date.now();
      const m = bots[g.turn].chooseMove(g, g.turn);
      const d = Date.now() - t0; t += d; dec++; slow = Math.max(slow, d);
      const r = LP.applyMove(g, g.turn, m);
      if (!r.ok) throw new Error(r.reason);
    }
    if (g.winner < 0) dead++;
    turns += g.turns;
    for (const pl of g.players) {
      const b = pl.board, vx = b.valve % b.w, vy = Math.floor(b.valve / b.w);
      let r = 0;
      b.cells.forEach((p, i) => { if (p) r = Math.max(r, Math.abs(i % b.w - vx), Math.abs(Math.floor(i / b.w) - vy)); });
      reach.push(r); maxReach = Math.max(maxReach, r);
    }
  }
  reach.sort((a, b) => a - b);
  console.log(`${n}p endless: avg rounds ${(turns / N / n).toFixed(1)}, no-winner ${dead}, reach median ${reach[reach.length >> 1]} p99 ${reach[Math.floor(reach.length * 0.99)]} max ${maxReach} (edge at ${Math.floor(LP.ENDLESS / 2)}), bot ${(t / dec).toFixed(1)}ms avg / ${slow}ms max`);
}
