// Self-play tuner: (1+1) evolution of bot weights. Each candidate plays the current champion
// in 2-, 3- and 4-player games on fresh shared seeds; it replaces the champion only if it wins clearly.
const fs = require('fs');
const { runMatch } = require('./arena.js');
const B = require('../src/bot.js');

const OUT = process.argv[2] || 'tools/tuned.json';
const ITER = +(process.argv[3] || 60);
let champ = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).params : Object.assign({}, B.PARAMS);
delete champ.noise;
const keys = Object.keys(champ).filter((k) => k !== 'noise' && k !== 'ammoMax');

let seedBase = 50000 + Math.floor(Math.random() * 1e6);
function perturb(p) {
  const q = Object.assign({}, p);
  const n = 1 + Math.floor(Math.random() * 3);
  const changed = [];
  for (let k = 0; k < n; k++) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    const v = q[key];
    q[key] = v === 0 ? Math.random() * 0.3 : +(v * Math.exp((Math.random() * 2 - 1) * 0.6)).toFixed(3);
    if (key === 'fitDecay') q[key] = Math.min(0.95, Math.max(0.05, q[key]));
    changed.push(key + '=' + q[key]);
  }
  return { q, changed };
}

(async () => {
  for (let it = 0; it < ITER; it++) {
    const { q, changed } = perturb(champ);
    const A = { kind: 'v2', params: q };
    const C = { kind: 'v2', params: champ };
    seedBase += 997;
    const r2 = await runMatch(A, C, 2, 250, { seedBase });
    const r3 = await runMatch(A, C, 3, 80, { seedBase: seedBase + 1 });
    const r4 = await runMatch(A, C, 4, 60, { seedBase: seedBase + 2 });
    const edge = (r2.rate - 0.5) / 0.5 + (r3.rate - 1 / 3) / (1 / 3) + (r4.rate - 0.25) / 0.25;
    const se = Math.sqrt((r2.ci / 1.96 / 0.5) ** 2 + (r3.ci / 1.96 / (1 / 3)) ** 2 + (r4.ci / 1.96 / 0.25) ** 2);
    const z = edge / se;
    const line = `${it} ${changed.join(',')} 2p ${(r2.rate * 100).toFixed(1)} 3p ${(r3.rate * 100).toFixed(1)} 4p ${(r4.rate * 100).toFixed(1)} z=${z.toFixed(2)}`;
    if (z > 1.6) {
      champ = q;
      fs.writeFileSync(OUT, JSON.stringify({ params: champ, updated: new Date().toISOString() }, null, 2));
      console.log(line + '  ACCEPT');
    } else console.log(line);
  }
})();
