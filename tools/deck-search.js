// Deck-mix study. Phase 1: sweep one knob at a time from the current deck to learn what each does.
// Phase 2: hill-climb the fun score from the best sweep values, on fresh seeds each step.
// Phase 3: re-check the winner and the baseline on a big shared sample.
// Output: tools/results/deck-*.jsonl
const fs = require('fs');
const { evaluate, specFrom, BASE } = require('./fun.js');
const table = process.argv[2] || undefined;
const tag = table || 'classic';
const sweepFile = `tools/results/deck-sweep-${tag}.jsonl`;
const climbFile = `tools/results/deck-climb-${tag}.jsonl`;
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
const RANGES = {
  total: [80, 92, 102, 115, 130],
  leaky: [0.12, 0.18, 0.25, 0.32, 0.4],
  copper: [0.25, 0.33, 0.41, 0.5, 0.6],
  elbow: [0.35, 0.45, 0.5, 0.6, 0.7, 0.8],
  tee: [0, 0.04, 0.08, 0.12, 0.16],
  caps: [4, 6, 8, 10, 12, 16],
  leakyCaps: [0, 1, 3, 5],
};
(async () => {
  fs.writeFileSync(sweepFile, '');
  const base = await evaluate(specFrom(BASE), { table, seedBase: 900 });
  fs.appendFileSync(sweepFile, JSON.stringify(round({ knob: 'base', value: null, knobs: BASE, ...base })) + '\n');
  const best = Object.assign({}, BASE);
  for (const [knob, vals] of Object.entries(RANGES)) {
    let top = null;
    for (const v of vals) {
      const k = Object.assign({}, BASE, { [knob]: v });
      const r = await evaluate(specFrom(k), { table, seedBase: 900 });
      fs.appendFileSync(sweepFile, JSON.stringify(round({ knob, value: v, knobs: k, ...r })) + '\n');
      if (!top || r.score > top.score) top = { v, score: r.score };
    }
    best[knob] = top.v;
  }
  // Phase 2: hill climb from the combination of per-knob bests.
  fs.writeFileSync(climbFile, '');
  let cur = Object.assign({}, best);
  let seed = 20000;
  let curR = await evaluate(specFrom(cur), { table, seedBase: seed });
  fs.appendFileSync(climbFile, JSON.stringify(round({ step: 'start', knobs: cur, ...curR })) + '\n');
  const keys = Object.keys(RANGES);
  for (let it = 0; it < 60; it++) {
    const cand = Object.assign({}, cur);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const vals = RANGES[key];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = (hi - lo) / 4;
    cand[key] = Math.min(hi * 1.1, Math.max(lo * 0.9, cur[key] + (Math.random() * 2 - 1) * span));
    if (key === 'caps' || key === 'leakyCaps' || key === 'total') cand[key] = Math.round(cand[key]);
    seed += 7777;
    // paired comparison on the same fresh seeds
    const a = await evaluate(specFrom(cand), { table, seedBase: seed });
    const b = await evaluate(specFrom(cur), { table, seedBase: seed });
    const accept = a.score > b.score + 0.05;
    fs.appendFileSync(climbFile, JSON.stringify(round({ step: it, key, value: cand[key], cand: a.score, cur: b.score, accept })) + '\n');
    if (accept) cur = cand;
  }
  // Phase 3: final check on a larger sample
  const big = { 2: 400, 3: 200, 4: 150 };
  const fin = await evaluate(specFrom(cur), { table, seedBase: 77777, counts: big });
  const fb = await evaluate(specFrom(BASE), { table, seedBase: 77777, counts: big });
  fs.appendFileSync(climbFile, JSON.stringify(round({ step: 'final', knobs: cur, tuned: fin, baseline: fb })) + '\n');
  console.log('done');
})();
