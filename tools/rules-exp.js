// Deck mixes x rule tweaks, measured with the same fun metrics as the deck search.
// node tools/rules-exp.js [classic|endless|shared] > tools/results/rules-<table>.txt
const LP = require('../src/engine.js');
const { evaluate, specFrom, BASE } = require('./fun.js');

const table = process.argv[2] || 'classic';
const withW = (spec, k) => Object.assign({}, spec, { wrenchCards: k });
const balanced = specFrom(Object.assign({}, BASE, { total: 110, leaky: 0.22, copper: 0.45, elbow: 0.62, tee: 0.05, caps: 10, leakyCaps: 1 }));
const runs = [
  ['original deck', LP.DECK_SPEC, {}],
  ['original + 3 wrench tokens each', LP.DECK_SPEC, { wrenches: 3 }],
  ['original + 4 wrench cards', withW(LP.DECK_SPEC, 4), {}],
  ['original + 8 wrench cards', withW(LP.DECK_SPEC, 8), {}],
  ['climbed (near-solitaire)', specFrom({ total: 121, leaky: 0.13, copper: 0.418, elbow: 0.677, tee: 0, caps: 10, leakyCaps: 1 }), {}],
  ['balanced', balanced, {}],
  ['balanced, hand 6', balanced, { hand: 6 }],
  ['balanced + 4 wrench cards', withW(balanced, 4), {}],
  ['balanced + 6 wrench cards', withW(balanced, 6), {}],
  ['spicy (leaky .28) + 6 wrench cards', withW(specFrom(Object.assign({}, BASE, { total: 110, leaky: 0.28, copper: 0.45, elbow: 0.62, tee: 0.05, caps: 10, leakyCaps: 1 })), 6), {}],
];

(async () => {
  const fmt = (s, k, d) => [2, 3, 4].map((n) => (s[n] ? (+s[n][k]).toFixed(d) : '-')).join('/');
  console.log(`table=${table}   columns are 2p/3p/4p`);
  for (const [name, spec, rules] of runs) {
    const t0 = Date.now();
    const { sum, score } = await evaluate(spec, { table, rules, counts: { 2: 200, 3: 100, 4: 80 }, seedBase: 9000 });
    console.log(
      `${name.padEnd(36)} score ${score.toFixed(2).padStart(6)}  stuck ${fmt(sum, 'stuck', 2)}  drought ${fmt(sum, 'drought', 1)}  p90 ${fmt(sum, 'droughtP90', 0)}  rounds ${fmt(sum, 'rounds', 0)}  attacks ${fmt(sum, 'attacks', 2)}  leads ${fmt(sum, 'leads', 1)}  close ${fmt(sum, 'close', 1)}  stall ${fmt(sum, 'stall', 2)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`
    );
  }
})();
