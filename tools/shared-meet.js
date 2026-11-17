// Shared table, two players: how much do the two pipelines actually get in each other's way?
// Tries valve layouts and measures contact alongside the usual fun numbers.
// node tools/shared-meet.js [games] > tools/results/shared-meet.txt
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const GAMES = +process.argv[2] || 120;
const S = LP.SHARED;
const c = Math.floor(S / 2);
const facing = (gap, dy) => {
  const R = c + Math.ceil(gap / 2);
  const L = R - gap - 1;
  return { name: 'x', w: S, h: S, valves: [{ x: R, y: c, face: 'W' }, { x: L, y: c + (dy || 0), face: 'E' }] };
};
const LAYOUTS = {
  'facing gap 11 (now)': facing(11),
  'facing gap 7': facing(7),
  'facing gap 5': facing(5),
  'facing gap 3': facing(3),
  'facing gap 7, rows 1 apart': facing(7, 1),
  'facing gap 5, rows 1 apart': facing(5, 1),
  'facing gap 3, rows 2 apart': facing(3, 2),
  'side by side, same way, 2 apart': { name: 'x', w: S, h: S, valves: [{ x: c, y: c - 1, face: 'W' }, { x: c, y: c + 1, face: 'W' }] },
  'side by side, same way, 3 apart': { name: 'x', w: S, h: S, valves: [{ x: c, y: c - 2, face: 'W' }, { x: c, y: c + 1, face: 'W' }] },
  'facing gap 1': facing(1),
  'facing gap 2': facing(2),
  'facing gap 4': facing(4),
  'facing gap 3, rows 1 apart': facing(3, 1),
  'crossing paths (4 from the corner)': { name: 'x', w: S, h: S, valves: [{ x: c - 4, y: c, face: 'E' }, { x: c, y: c - 4, face: 'S' }] },
  'crossing paths (3 and 5)': { name: 'x', w: S, h: S, valves: [{ x: c - 3, y: c, face: 'E' }, { x: c, y: c - 5, face: 'S' }] },
};
const only = process.env.ONLY;
const BLOCK = +process.env.BLOCK || 0;
function play(layout, seed) {
  const g = LP.newGame({ players: [0, 1].map((i) => ({ name: 'P' + i, kind: 'bot' })), seed, deck: 'tuned', table: 'shared', layout, first: seed % 2 });
  const bots = [0, 1].map(() => B.makeBot(BLOCK ? { block: BLOCK } : {}));
  const w = g.players[0].board.w;
  let turns = 0, stuck = 0, blockedTurns = 0, touch = 0, closest = 99, attacks = 0, guard = 0, firstTouch = -1;
  while (g.phase !== 'over' && guard++ < 3000) {
    const p = g.turn;
    const wasWrench = g.phase === 'wrenchDiscard';
    const b = g.players[p].board;
    // did the other pipeline take options away this turn? Count my own-pipeline placements with
    // it on the table and with it lifted off.
    let blocked = false;
    if (!wasWrench) {
      const own = (gm) => LP.legalMoves(gm, p).filter((m) => (m.type === 'pipe' || m.type === 'cap') && m.target === p && !gm.players[p].board.cells[m.i]).length;
      const alone = Object.assign({}, g, { table: 'endless', players: g.players.map((pl, i) => (i === p ? Object.assign({}, pl, { board: Object.assign({}, pl.board, { foreign: null, reserved: null }) }) : pl)) });
      blocked = own(g) < own(alone);
    }
    const m = bots[p].chooseMove(g, p);
    const r = LP.applyMove(g, p, m);
    if (!r.ok) throw new Error(r.reason);
    if (wasWrench) continue;
    turns++;
    if (blocked) blockedTurns++;
    if (m.type === 'discard' || m.type === 'pass') stuck++;
    if (m.target != null && m.target !== p && m.type !== 'wrench') attacks++;
    // distance between the two pipelines
    const A = LP.occOf(g.players[0].board), Bc = LP.occOf(g.players[1].board);
    let d = 99;
    for (const i of A) for (const j of Bc) d = Math.min(d, Math.abs((i % w) - (j % w)) + Math.abs(Math.floor(i / w) - Math.floor(j / w)));
    closest = Math.min(closest, d);
    if (d <= 1 && firstTouch < 0) firstTouch = turns;
  }
  return { rounds: turns / 2, stuck: stuck / turns, blocked: blockedTurns / turns, anyBlocked: blockedTurns > 0 ? 1 : 0, touch: closest <= 1 ? 1 : 0, closest, stall: g.winner < 0 ? 1 : 0, first: g.winner === seed % 2 ? 1 : 0, seat0: g.winner === 0 ? 1 : 0, attacks: attacks / turns, firstTouch };
}
console.log(`2 players, tuned deck, ${GAMES} games each${BLOCK ? ', computers that crowd on purpose (block ' + BLOCK + ')' : ''}`);
console.log('touch = games where the pipelines end up side by side; squeezed = share of turns where the other pipeline left the mover fewer places to build');
for (const [name, layout] of Object.entries(LAYOUTS)) {
  if (only && !name.includes(only)) continue;
  const t0 = Date.now();
  const rs = [];
  for (let s = 0; s < GAMES; s++) rs.push(play(layout, 7000 + s * 37));
  const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  const ft = rs.filter((r) => r.firstTouch > 0).map((r) => r.firstTouch);
  console.log(`${name.padEnd(36)} touch ${(avg('touch') * 100).toFixed(0).padStart(3)}%  games with a squeeze ${(avg('anyBlocked') * 100).toFixed(0).padStart(3)}%  squeezed turns ${(avg('blocked') * 100).toFixed(1).padStart(4)}%  closest ${avg('closest').toFixed(1).padStart(4)}  first touch turn ${ft.length ? (ft.reduce((a, x) => a + x, 0) / ft.length).toFixed(0) : '-'} | stuck ${avg('stuck').toFixed(2)} rounds ${avg('rounds').toFixed(1)} stall ${avg('stall').toFixed(3)} first-player wins ${avg('first').toFixed(2)} seat0 ${avg('seat0').toFixed(2)} attacks ${avg('attacks').toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
