// Why do players get stuck? Classifies every discard/pass turn in self-play.
// node tools/why-stuck.js [games] [players]
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const { specFrom, BASE } = require('./fun.js');

const games = +process.argv[2] || 300;
const n = +process.argv[3] || 2;
const decks = {
  original: LP.DECK_SPEC,
  balanced: specFrom(Object.assign({}, BASE, { total: 110, leaky: 0.22, copper: 0.45, elbow: 0.62, tee: 0.05, caps: 10, leakyCaps: 1 })),
};

for (const [name, spec] of Object.entries(decks)) {
  const why = {};
  let turns = 0;
  let stuckTurns = 0;
  let leakyInHand = 0;
  let handCards = 0;
  let leakTurns = 0;
  let leakLen = [];
  for (let s = 0; s < games; s++) {
    const g = LP.newGame({ players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, kind: 'bot' })), seed: 7000 + s, deckSpec: spec });
    const bots = g.players.map(() => B.makeBot());
    const leakSince = new Array(n).fill(-1);
    let guard = 0;
    while (g.phase !== 'over' && guard++ < 4000) {
      const p = g.turn;
      const wasWrench = g.phase === 'wrenchDiscard';
      const me = g.players[p];
      const leaking = LP.leakAt(me.board) >= 0;
      const moves = wasWrench ? [] : LP.legalMoves(g, p);
      const m = bots[p].chooseMove(g, p);
      if (!wasWrench) {
        turns++;
        if (leaking) leakTurns++;
        if (m.type === 'discard' || m.type === 'pass') {
          stuckTurns++;
          const own = moves.filter((x) => (x.type === 'pipe' || x.type === 'cap') && (x.target == null || x.target === p)).length;
          const fix = moves.filter((x) => x.type === 'cover' || x.type === 'wrench').length;
          const atk = moves.filter((x) => x.target != null && x.target !== p && x.type !== 'wrench').length;
          let k;
          if (leaking) k = fix ? 'leaking, chose not to fix' : me.wrenches ? 'leaking, wrench but ?' : 'leaking: no wrench, no matching cover card';
          else if (own) k = 'had a move, chose to discard';
          else if (atk) k = 'only attacks available, chose to discard';
          else {
            const hasLeaky = me.hand.some((c) => c.kind === 'pipe' && c.mat === 'leaky');
            const onlyLeaky = me.hand.every((c) => c.kind === 'pipe' && c.mat === 'leaky');
            k = onlyLeaky ? 'no fit: hand is all leaky pipes, no target' : hasLeaky ? 'no fit: nothing fits own ends; leaky cards had no target' : 'no fit: nothing fits own ends (no leaky cards)';
          }
          why[k] = (why[k] || 0) + 1;
          for (const c of me.hand) {
            handCards++;
            if (c.kind === 'pipe' && c.mat === 'leaky') leakyInHand++;
          }
        }
      }
      const r = LP.applyMove(g, p, m);
      if (!r.ok) throw new Error(r.reason);
      // how long do leaks last?
      g.players.forEach((pl, i) => {
        const l = LP.leakAt(pl.board) >= 0;
        if (l && leakSince[i] < 0) leakSince[i] = g.turns;
        if (!l && leakSince[i] >= 0) {
          leakLen.push((g.turns - leakSince[i]) / n);
          leakSince[i] = -1;
        }
      });
    }
  }
  leakLen.sort((a, b) => a - b);
  console.log(`\n== ${name} deck, ${n}p, ${games} games: ${((100 * stuckTurns) / turns).toFixed(0)}% of turns are discards/passes`);
  for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${((100 * v) / stuckTurns).toFixed(0).padStart(3)}%  ${k}`);
  console.log(`  leaky pipes make up ${((100 * leakyInHand) / handCards).toFixed(0)}% of a stuck player's hand`);
  console.log(`  ${((100 * leakTurns) / turns).toFixed(0)}% of turns start with a leak on your own pipeline; leaks last median ${leakLen[leakLen.length >> 1].toFixed(1)} rounds, p90 ${leakLen[Math.floor(leakLen.length * 0.9)].toFixed(1)}`);
}
