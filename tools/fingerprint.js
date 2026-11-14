// Plays fixed-seed bot games and prints one fingerprint per game. Used to prove that an engine
// refactor changes nothing: run before and after, and diff.   node tools/fingerprint.js > out.txt
const crypto = require('crypto');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
for (const table of ['classic', 'endless', 'shared']) for (const n of [2, 3, 4]) for (let seed = 1; seed <= 12; seed++) {
  const g = LP.newGame({ players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, kind: 'bot' })), seed, table, deck: seed % 2 ? 'tuned' : 'classic' });
  const bot = B.makeBot();
  const h = crypto.createHash('sha1');
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 3000) {
    const m = bot.chooseMove(g, g.turn);
    h.update(JSON.stringify(m) + '|' + LP.legalMoves(g, g.turn).length + '|');
    const r = LP.applyMove(g, g.turn, m);
    if (!r.ok) throw new Error(r.reason);
    // also exercise the compact form on the way
    if (guard % 7 === 0) h.update(String(LP.legalMoves(LP.unpackGame(JSON.parse(JSON.stringify(LP.packGame(g)))), g.turn).length));
  }
  h.update(JSON.stringify(g.players.map((p) => [p.wrenches, p.hand.map((c) => c.id), p.board.cells.map((c, i) => (c ? i + c.card.id : '')).join('')])));
  console.log(table, n, seed, g.winner, g.turns, h.digest('hex').slice(0, 16));
}
