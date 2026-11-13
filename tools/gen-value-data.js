// Self-play positions for training the learned evaluation.
// node tools/gen-value-data.js <seedStart> <games> <out.csv>
// Each row: features of a position from one player's side (hands included), then 1 if that
// player went on to win. Games mix player counts, tables and decks.
const fs = require('fs');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const [s0, games, out] = [+process.argv[2], +process.argv[3], process.argv[4]];
const fd = fs.openSync(out, 'w');
const f = B.makeBot();
let rows = 0;
for (let k = 0; k < games; k++) {
  const seed = s0 + k;
  const n = [2, 2, 2, 3, 4][seed % 5];
  const table = ['classic', 'classic', 'classic', 'endless', 'shared'][(seed >> 3) % 5];
  const deck = (seed >> 6) % 3 === 0 ? 'classic' : 'tuned';
  const g = LP.newGame({ players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, kind: 'bot' })), seed, table, deck });
  // a mix of sharp and sloppy players so positions are varied
  const bots = g.players.map((_, i) => B.makeBot({ noise: [0.35, 0.35, 0, 0.8][(seed + i * 7) % 4] }));
  const buf = [];
  let guard = 0;
  let r = (seed * 2654435761) >>> 0;
  while (g.phase !== 'over' && guard++ < 4000) {
    r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
    if (r / 4294967296 < 0.3) for (let p = 0; p < n; p++) buf.push([p, f.features(g, p)]);
    const res = LP.applyMove(g, g.turn, bots[g.turn].chooseMove(g, g.turn));
    if (!res.ok) throw new Error(res.reason);
  }
  if (g.winner < 0) continue;
  fs.writeSync(fd, buf.map(([p, x]) => seed + ',' + x.map((v) => +v.toFixed(3)).join(',') + ',' + (g.winner === p ? 1 : 0)).join('\n') + '\n');
  rows += buf.length;
}
fs.closeSync(fd);
console.log(out, rows, 'rows');
