// "Fun" metrics from self-play, for comparing deck mixes and table modes.
//
// The proxies (all measured on computer-vs-computer games):
//   stuck      share of turns where a player could only discard or pass
//   drought    longest run of consecutive stuck turns across the table, in rounds (everyone blocked)
//   personal   longest run of stuck turns by one player, in that player's turns
//   rounds     game length in rounds
//   stall      share of games that hit the safety cap with no winner
//   close      how far the runner-up was from finishing when the winner finished (lower = closer race)
//   leads      how many times the leader changed during the game
//   attacks    share of turns spent springing leaks
//
// Usage: const { evaluate, specFrom } = require('./fun.js')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

// Turn a handful of knobs into a full deck spec.
function specFrom(k) {
  const caps = Math.round(k.caps);
  const leakyCaps = Math.min(caps, Math.round(k.leakyCaps));
  const pipes = Math.round(k.total) - caps;
  const leakyN = Math.round(pipes * k.leaky);
  const good = pipes - leakyN;
  const copperN = Math.round(good * k.copper);
  const ironN = good - copperN;
  const split = (n) => {
    const L = Math.round(n * k.elbow);
    const T = Math.round(n * k.tee);
    const S = Math.max(0, n - L - T);
    return { V: Math.ceil(S / 2), H: Math.floor(S / 2), L1: Math.ceil(L / 2), L2: Math.floor(L / 2), T1: Math.ceil(T / 2), T2: Math.floor(T / 2) };
  };
  const goodCaps = [
    { N: 'iron', E: 'iron', S: 'copper', W: 'iron' },
    { N: 'copper', E: 'iron', S: 'iron', W: 'copper' },
  ];
  const badCaps = [
    { N: 'leaky', E: 'iron', S: 'copper', W: 'iron' },
    { N: 'iron', E: 'leaky', S: 'iron', W: 'copper' },
    { N: 'copper', E: 'iron', S: 'leaky', W: 'iron' },
    { N: 'iron', E: 'copper', S: 'iron', W: 'leaky' },
  ];
  const capList = [];
  for (let i = 0; i < caps - leakyCaps; i++) capList.push({ caps: goodCaps[i % 2], count: 1 });
  for (let i = 0; i < leakyCaps; i++) capList.push({ caps: badCaps[i % 4], count: 1 });
  return { iron: split(ironN), copper: split(copperN), leaky: split(leakyN), caps: capList, wrenchCards: Math.round(k.wrenchCards || 0) };
}

// The current default deck expressed as knobs (approximately).
const BASE = { total: 102, leaky: 0.32, copper: 0.41, elbow: 0.5, tee: 0.1, caps: 8, leakyCaps: 3 };

function playMeasured(LP, B, n, seed, spec, table, rules) {
  const g = LP.newGame(Object.assign({}, rules || {}, { players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, kind: 'bot' })), seed, deckSpec: spec, table }));
  const bots = Array.from({ length: n }, () => B.makeBot());
  const cost = (b) => {
    const a = LP.analyze(b, g.required);
    return a.viable ? a.cost : 30;
  };
  let turns = 0;
  let stuck = 0;
  let attacks = 0;
  let run = 0; // consecutive stuck turns, table-wide
  let drought = 0;
  const pRun = new Array(n).fill(0);
  let personal = 0;
  let leader = -1;
  let leads = 0;
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 4000) {
    const p = g.turn;
    const wasWrench = g.phase === 'wrenchDiscard';
    const m = bots[p].chooseMove(g, p);
    const r = LP.applyMove(g, p, m);
    if (!r.ok) throw new Error(r.reason);
    if (wasWrench) continue; // the discard that finishes a wrench turn
    turns++;
    const isStuck = m.type === 'discard' || m.type === 'pass';
    if (m.target != null && m.target !== p && m.type !== 'wrench') attacks++;
    if (isStuck) {
      stuck++;
      run++;
      pRun[p]++;
      drought = Math.max(drought, run);
      personal = Math.max(personal, pRun[p]);
    } else {
      run = 0;
      pRun[p] = 0;
    }
    if (p === n - 1 && g.phase !== 'over') {
      const cs = g.players.map((pl) => cost(pl.board));
      const best = Math.min(...cs);
      const who = cs.filter((c) => c === best).length === 1 ? cs.indexOf(best) : leader;
      if (leader >= 0 && who !== leader) leads++;
      leader = who;
    }
  }
  let close = 30;
  if (g.winner >= 0) close = Math.min(...g.players.map((pl, i) => (i === g.winner ? 99 : cost(pl.board))));
  return {
    rounds: turns / n,
    stuck: stuck / Math.max(1, turns),
    drought: drought / n,
    personal,
    stall: g.winner < 0 ? 1 : 0,
    winner: g.winner,
    close,
    leads,
    attacks: attacks / Math.max(1, turns),
  };
}

if (!isMainThread) {
  const LP = require('../src/engine.js');
  const B = require('../src/bot.js');
  const { jobs, spec, table, rules } = workerData;
  const out = jobs.map(([n, seed]) => Object.assign({ n }, playMeasured(LP, B, n, seed, spec, table, rules)));
  parentPort.postMessage(out);
  return;
}

const TARGET_ROUNDS = { 2: 20, 3: 16, 4: 13 };

function summarize(results) {
  const by = {};
  for (const r of results) (by[r.n] = by[r.n] || []).push(r);
  const avg = (xs, f) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
  const out = {};
  for (const n of Object.keys(by)) {
    const xs = by[n];
    out[n] = {
      games: xs.length,
      rounds: avg(xs, (x) => x.rounds),
      stuck: avg(xs, (x) => x.stuck),
      drought: avg(xs, (x) => x.drought),
      droughtP90: xs.map((x) => x.drought).sort((a, b) => a - b)[Math.floor(xs.length * 0.9)],
      personal: avg(xs, (x) => x.personal),
      stall: avg(xs, (x) => x.stall),
      close: avg(xs, (x) => x.close),
      leads: avg(xs, (x) => x.leads),
      attacks: avg(xs, (x) => x.attacks),
      firstSeat: xs.filter((x) => x.winner === 0).length / xs.length,
      seatSpread: (() => {
        const w = Array.from({ length: +n }, (_, k) => xs.filter((x) => x.winner === k).length / xs.length);
        return Math.max(...w) - Math.min(...w);
      })(),
    };
  }
  return out;
}

// One number to optimize. Penalties first: being blocked, droughts, stalls, games that run long;
// small rewards for close races and lead changes.
function funScore(sum) {
  let total = 0;
  let k = 0;
  for (const n of Object.keys(sum)) {
    const s = sum[n];
    const t = TARGET_ROUNDS[n];
    let f = 0;
    f -= 4 * s.stuck;
    f -= 0.6 * s.drought;
    f -= 0.12 * s.personal;
    f -= 15 * s.stall;
    f -= 1.5 * Math.max(0, s.rounds - t) / t + 0.5 * Math.max(0, t - s.rounds) / t;
    f -= 0.15 * Math.min(s.close, 6);
    f += 0.08 * Math.min(s.leads, 6);
    f -= 3 * Math.max(0, 0.08 - s.attacks) + 2 * Math.max(0, s.attacks - 0.25);
    total += f;
    k++;
  }
  return total / k;
}

function evaluate(spec, opts) {
  opts = opts || {};
  const counts = opts.counts || { 2: 120, 3: 60, 4: 45 };
  const jobs = [];
  for (const [n, games] of Object.entries(counts)) for (let s = 0; s < games; s++) jobs.push([+n, (opts.seedBase || 500) + s * 101 + +n]);
  const nW = Math.min(os.cpus().length, 4);
  const chunks = Array.from({ length: nW }, (_, i) => jobs.filter((_, j) => j % nW === i));
  return Promise.all(
    chunks.map(
      (c) =>
        new Promise((res, rej) => {
          const w = new Worker(__filename, { workerData: { jobs: c, spec, table: opts.table, rules: opts.rules } });
          w.on('message', res);
          w.on('error', rej);
        })
    )
  ).then((parts) => {
    const sum = summarize(parts.flat());
    return { sum, score: funScore(sum) };
  });
}

module.exports = { evaluate, specFrom, funScore, BASE, TARGET_ROUNDS };

if (require.main === module) {
  const LP = require('../src/engine.js');
  const t0 = Date.now();
  evaluate(LP.DECK_SPEC).then((r) => {
    console.log(JSON.stringify(r, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v), 1));
    console.log('took', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  });
}
