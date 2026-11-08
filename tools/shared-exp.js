// Shared table: layouts x decks, with the usual fun metrics plus seat fairness.
// node tools/shared-exp.js > tools/results/shared.txt
const LP = require('../src/engine.js');
const { evaluate } = require('./fun.js');

const runs = [];
for (const table of ['classic', 'endless']) for (const deck of ['classic', 'tuned']) runs.push([table, deck, null]);
for (const layout of ['facing', 'stacked', 'center']) for (const deck of ['classic', 'tuned']) runs.push(['shared', deck, layout]);

(async () => {
  const fmt = (s, k, d) => [2, 3, 4].map((n) => (s[n] ? (+s[n][k]).toFixed(d) : '-')).join('/');
  console.log('columns are 2p/3p/4p');
  for (const [table, deck, layout] of runs) {
    const t0 = Date.now();
    const rules = layout ? { layout } : {};
    const { sum, score } = await evaluate(LP.DECKS[deck], { table, rules, counts: { 2: 160, 3: 90, 4: 72 }, seedBase: 4242 });
    const name = (table === 'shared' ? 'shared/' + layout : table) + ' + ' + deck + ' deck';
    console.log(
      `${name.padEnd(30)} score ${score.toFixed(2).padStart(6)}  stuck ${fmt(sum, 'stuck', 2)}  drought ${fmt(sum, 'drought', 1)}  p90 ${fmt(sum, 'droughtP90', 0)}  rounds ${fmt(sum, 'rounds', 0)}  attacks ${fmt(sum, 'attacks', 2)}  leads ${fmt(sum, 'leads', 1)}  stall ${fmt(sum, 'stall', 2)}  seat0 ${fmt(sum, 'firstSeat', 2)} spread ${fmt(sum, 'seatSpread', 2)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`
    );
  }
})();
