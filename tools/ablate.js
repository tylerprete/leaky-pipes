// Ablation study: knock out one habit at a time and see how much the full bot beats that version.
const { runMatch } = require('./arena.js');
const variants = [
  ['never springs leaks', { atk: 0, ammo: 0 }, [2, 3]],
  ['ignores whether its last card is copper', { exposed: 0 }, [2]],
  ['ignores whether its hand fits the pipeline', { fit: 0 }, [2]],
  ['spends wrenches as if free', { wrench: 0 }, [2]],
  ['hoards wrenches', { wrench: 3 }, [2]],
  ['plays T pieces like any other pipe', { tPenalty: -1 }, [2]],
  ['attacks twice as eagerly', { atk: 2 }, [2, 3]],
  ['attacks anyone, not just the leader', { nonLeader: 1 }, [3, 4]],
  ['ignores free space around its pipe', { space: 0 }, [2]],
];
(async () => {
  const seeds = +(process.argv[2] || 150);
  const rows = [];
  for (const [label, params, counts] of variants) {
    for (const n of counts) {
      const r = await runMatch({ kind: 'v2', params }, { kind: 'v2' }, n, Math.ceil(seeds * 2 / n), { seedBase: 777 });
      const row = { label, players: n, variantWinRate: +(100 * r.rate).toFixed(1), fair: +(100 / n).toFixed(1), ci: +(100 * r.ci).toFixed(1), games: r.n };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
})();
