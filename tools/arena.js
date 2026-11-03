// Self-play arena: pit bot A against copies of bot B with seat rotation and shared seeds.
// Usage (CLI): node tools/arena.js '<specA json>' '<specB json>' [players] [seeds]
//   spec: {"kind":"v1"} | {"kind":"v2","params":{...}} | {"kind":"v2","level":"easy"}
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const path = require('path');

function makeBot(spec) {
  if (spec.kind === 'v1') return require('../bots/v1.js');
  const B = require('../src/bot.js');
  if (spec.level) return B.forLevel(spec.level);
  if (spec.kind === 'search') return B.makeSearchBot(spec.params || {}, spec.opts || {});
  return B.makeBot(spec.params || {});
}

function playOne(LP, bots, seed, record, table) {
  const g = LP.newGame({ players: bots.map((_, i) => ({ name: 'P' + i, kind: 'bot' })), seed, table });
  const rec = record ? [] : null;
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 3000) {
    const p = g.turn;
    const before = record ? snapshot(LP, g, p) : null;
    const m = bots[p].chooseMove(g, p);
    let r = LP.applyMove(g, p, m);
    if (!r.ok) r = LP.applyMove(g, p, g.players[p].hand.length ? { type: 'discard', cardId: g.players[p].hand[0].id } : { type: 'pass' });
    if (!r.ok) throw new Error('stuck: ' + r.reason);
    if (record) rec.push(Object.assign(before, describeMove(g, p, m)));
  }
  return { winner: g.winner, turns: g.turns, rec };
}

function snapshot(LP, g, p) {
  const me = g.players[p];
  const cost = (b) => { const a = LP.analyze(b, g.required); return a.viable ? a.cost : 99; };
  const last = me.board.cells[me.board.last];
  return {
    p, turn: g.turns, n: g.players.length,
    myCost: cost(me.board),
    oppCosts: g.players.map((pl, i) => (i === p ? null : cost(pl.board))),
    myLeak: LP.leakAt(me.board) >= 0,
    oppLeak: g.players.map((pl, i) => (i === p ? null : LP.leakAt(pl.board) >= 0)),
    wrenches: me.wrenches,
    lastMat: last && last.card.kind === 'pipe' ? (last.repaired ? 'repaired' : last.card.mat) : 'valve',
    hand: me.hand.map((c) => (c.kind === 'cap' ? 'cap' : c.mat + ':' + LP.SHAPE_KIND[c.shape])),
    ends: LP.openEnds(me.board).length,
    progress: LP.progressOf(me.board),
  };
}
function describeMove(g, p, m) {
  const me = g.players[p];
  const o = { type: m.type, own: m.target === p || m.type === 'discard' || m.type === 'wrench' };
  return o;
}

if (!isMainThread) {
  const LP = require('../src/engine.js');
  const { specA, specB, players, jobs, record, table } = workerData;
  const out = [];
  for (const [seed, seatA] of jobs) {
    // fresh bot objects per game keep caches small
    const bots = Array.from({ length: players }, (_, i) => makeBot(i === seatA ? specA : specB));
    const r = playOne(LP, bots, seed, record, table);
    out.push({ seed, seatA, winner: r.winner, turns: r.turns, aWon: r.winner === seatA, rec: r.rec });
  }
  parentPort.postMessage(out);
  return;
}

function runMatch(specA, specB, players, seeds, opts) {
  opts = opts || {};
  const jobs = [];
  for (let s = 0; s < seeds; s++) for (let k = 0; k < players; k++) jobs.push([(opts.seedBase || 1000) + s * 7 + players, k]);
  const nW = Math.min(os.cpus().length, 4);
  const chunks = Array.from({ length: nW }, (_, i) => jobs.filter((_, j) => j % nW === i));
  return Promise.all(chunks.map((c) => new Promise((res, rej) => {
    const w = new Worker(__filename, { workerData: { specA, specB, players, jobs: c, record: !!opts.record, table: opts.table || process.env.TABLE } });
    w.on('message', res); w.on('error', rej);
  }))).then((parts) => {
    const all = parts.flat();
    const wins = all.filter((r) => r.aWon).length;
    const n = all.length;
    const rate = wins / n;
    const se = Math.sqrt(rate * (1 - rate) / n);
    const turns = all.reduce((a, r) => a + r.turns, 0) / n;
    const draws = all.filter((r) => r.winner < 0).length;
    return { wins, n, rate, ci: 1.96 * se, fair: 1 / players, turns, draws, results: all };
  });
}

module.exports = { runMatch, playOne, makeBot };

if (require.main === module) {
  const a = JSON.parse(process.argv[2] || '{"kind":"v2"}');
  const b = JSON.parse(process.argv[3] || '{"kind":"v1"}');
  const players = +(process.argv[4] || 2);
  const seeds = +(process.argv[5] || 100);
  const t0 = Date.now();
  runMatch(a, b, players, seeds).then((r) => {
    console.log(`A win rate ${(100 * r.rate).toFixed(1)}% ± ${(100 * r.ci).toFixed(1)} (fair ${(100 * r.fair).toFixed(0)}%) over ${r.n} games, avg ${r.turns.toFixed(1)} turns, ${r.draws} draws, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  });
}
