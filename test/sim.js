const LP = require('../src/engine.js');
const bot = require('../src/bot.js');

function check(game) {
  let total = game.deck.length + game.discard.length;
  for (const pl of game.players) {
    total += pl.hand.length;
    if (pl.hand.length > 6) throw new Error('hand too big');
    const b = pl.board;
    let leaks = 0;
    for (let i = 0; i < b.cells.length; i++) {
      const p = b.cells[i];
      if (!p) continue;
      if (p.card.kind === 'pipe' || p.card.kind === 'cap') total += 1 + p.under.filter((u) => u.card.kind === 'pipe' || u.card.kind === 'cap').length;
      if (LP.pieceLeaks(b, i)) leaks++;
      if (p.card.kind === 'cap') continue;
      for (const d of LP.openingsOf(p.card, p.flip)) {
        const n = LP.step(b, i, d);
        if (n < 0) throw new Error('opening off the table');
        const q = b.cells[n];
        if (q && q.card.kind !== 'cap' && !LP.openingsOf(q.card, q.flip).includes(LP.OPP[d])) throw new Error('mismatched joint');
      }
    }
    if (leaks > 1) throw new Error('more than one leak');
  }
  if (total !== 102) throw new Error('card count ' + total);
}

function play(n, seed) {
  const g = LP.newGame({ players: Array.from({ length: n }, (_, i) => ({ name: 'Bot' + i, kind: 'bot' })), seed });
  let slow = 0;
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 5000) {
    const t0 = Date.now();
    const m = bot.chooseMove(g, g.turn);
    slow = Math.max(slow, Date.now() - t0);
    const r = LP.applyMove(g, g.turn, m);
    if (!r.ok) throw new Error('bot made illegal move: ' + r.reason + ' ' + JSON.stringify(m));
    check(g);
  }
  return { winner: g.winner, turns: g.turns, slow };
}

const N = +process.argv[2] || 60;
for (const n of [2, 3, 4]) {
  const wins = new Array(n).fill(0);
  let none = 0;
  let turns = 0;
  let slow = 0;
  const t0 = Date.now();
  for (let s = 1; s <= N; s++) {
    const r = play(n, s * 7919 + n);
    if (r.winner >= 0) wins[r.winner]++;
    else none++;
    turns += r.turns;
    slow = Math.max(slow, r.slow);
  }
  console.log(`${n} players: wins by seat ${wins.join('/')}, no winner ${none}, avg turns ${(turns / N).toFixed(1)} (${(turns / N / n).toFixed(1)} rounds), slowest bot move ${slow}ms, ${((Date.now() - t0) / N).toFixed(0)}ms/game`);
}
