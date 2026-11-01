// Play instrumented self-play games and print the statistics behind the strategy guide.
// Usage: node tools/analyze.js [gamesPerCount]
const LP = require('../src/engine.js');
const B = require('../src/bot.js');

const N = +(process.argv[2] || 300);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function cost(g, b) {
  const a = LP.analyze(b, g.required);
  return a.viable ? a.cost : 99;
}

function play(n, seed, botFor) {
  const g = LP.newGame({ players: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, kind: 'bot' })), seed });
  const bots = Array.from({ length: n }, (_, i) => botFor(i));
  const per = Array.from({ length: n }, () => ({
    builds: 0, attacks: 0, onTop: 0, adjacent: 0, leakyCaps: 0, covers: 0, wrenches: 0, discards: 0, passes: 0,
    tPlayed: 0, copperPlayed: 0, ironPlayed: 0, capsPlayed: 0, leaksTaken: 0, copperEndTurns: 0, ironEndTurns: 0,
    hitOnTopWhileIronEnd: 0, attacksOnLeader: 0, attacksWhenTargetClose: 0, closeChances: 0, firstBuildTurn: null,
    discardKinds: {}, wrenchTurns: [],
  }));
  const leakOpen = new Map(); // victim -> turn leak landed
  const repairDelay = [];
  const repairMethod = { cover: 0, wrench: 0 };
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 3000) {
    const p = g.turn;
    const me = g.players[p];
    const st = per[p];
    // exposure bookkeeping at the start of my turn
    const last = me.board.cells[me.board.last];
    if (last && last.card.kind === 'pipe' && !last.repaired && last.card.mat === 'iron') st.ironEndTurns++;
    if (last && last.card.kind === 'pipe' && last.card.mat === 'copper') st.copperEndTurns++;
    const costs = g.players.map((pl) => cost(g, pl.board));
    const oppClose = costs.some((c, i) => i !== p && c <= 2 && LP.leakAt(g.players[i].board) < 0);
    const canAttackClose = oppClose && LP.legalMoves(g, p).some((m) => m.target != null && m.target !== p && costs[m.target] <= 2);
    if (canAttackClose) st.closeChances++;

    const m = bots[p].chooseMove(g, p);
    const card = m.cardId ? me.hand.find((c) => c.id === m.cardId) : null;
    const turnNo = g.turns;
    const r = LP.applyMove(g, p, m);
    if (!r.ok) throw new Error(r.reason);
    if (m.type === 'pass') st.passes++;
    else if (m.type === 'discard') {
      if (g.phase !== 'wrenchDiscard') {
        st.discards++;
        const k = card.kind === 'cap' ? 'cap' : card.mat === 'leaky' ? 'leaky' : LP.SHAPE_KIND[card.shape] === 'T' ? 'good T' : card.mat + ' ' + LP.SHAPE_KIND[card.shape];
        st.discardKinds[k] = (st.discardKinds[k] || 0) + 1;
      }
    } else if (m.type === 'wrench') {
      st.wrenches++;
      st.wrenchTurns.push(turnNo);
      repairMethod.wrench++;
      if (leakOpen.has(p)) repairDelay.push(Math.ceil((turnNo - leakOpen.get(p)) / g.players.length));
      leakOpen.delete(p);
    } else if (m.target === p) {
      if (m.type === 'cover') {
        st.covers++;
        repairMethod.cover++;
        if (leakOpen.has(p)) repairDelay.push(Math.ceil((turnNo - leakOpen.get(p)) / g.players.length));
        leakOpen.delete(p);
      } else {
        st.builds++;
        if (st.firstBuildTurn == null) st.firstBuildTurn = turnNo;
        if (card.kind === 'cap') st.capsPlayed++;
        else {
          if (LP.SHAPE_KIND[card.shape] === 'T') st.tPlayed++;
          if (card.mat === 'copper') st.copperPlayed++;
          else st.ironPlayed++;
        }
      }
    } else {
      st.attacks++;
      if (m.type === 'cover') {
        st.onTop++;
        per[m.target].hitOnTopWhileIronEnd++;
      } else if (card.kind === 'cap') st.leakyCaps++;
      else st.adjacent++;
      let leader = -1;
      costs.forEach((c, i) => {
        if (i !== p && (leader < 0 || c < costs[leader])) leader = i;
      });
      if (m.target === leader) st.attacksOnLeader++;
      if (costs[m.target] <= 2) st.attacksWhenTargetClose++;
      per[m.target].leaksTaken++;
      leakOpen.set(m.target, turnNo);
    }
  }
  return { g, per, repairDelay, repairMethod };
}

function summarize(n, botFor, label) {
  const seatWins = new Array(n).fill(0);
  let rounds = [];
  const W = [];
  const L = [];
  const delays = [];
  const method = { cover: 0, wrench: 0 };
  let draws = 0;
  for (let s = 1; s <= N; s++) {
    const { g, per, repairDelay, repairMethod } = play(n, 90000 + s * 31 + n, botFor);
    if (g.winner < 0) {
      draws++;
      continue;
    }
    seatWins[g.winner]++;
    rounds.push(Math.ceil(g.turns / n));
    per.forEach((x, i) => {
      x.wrenchesLeft = g.players[i].wrenches;
      x.finalLen = LP.progressOf(g.players[i].board);
      (i === g.winner ? W : L).push(x);
    });
    delays.push(...repairDelay);
    method.cover += repairMethod.cover;
    method.wrench += repairMethod.wrench;
  }
  const S = (arr, f) => avg(arr.map(f));
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const all = W.concat(L);
  const out = {
    label,
    players: n,
    games: N,
    draws,
    seatWinRates: seatWins.map((w) => pct(w, N - draws)),
    avgRounds: avg(rounds).toFixed(1),
    perPlayerPerGame: {
      builds: [S(W, (x) => x.builds).toFixed(1), S(L, (x) => x.builds).toFixed(1)],
      attacks: [S(W, (x) => x.attacks).toFixed(2), S(L, (x) => x.attacks).toFixed(2)],
      discards: [S(W, (x) => x.discards).toFixed(1), S(L, (x) => x.discards).toFixed(1)],
      leaksTaken: [S(W, (x) => x.leaksTaken).toFixed(2), S(L, (x) => x.leaksTaken).toFixed(2)],
      wrenchesUsed: [S(W, (x) => x.wrenches).toFixed(2), S(L, (x) => x.wrenches).toFixed(2)],
      covers: [S(W, (x) => x.covers).toFixed(2), S(L, (x) => x.covers).toFixed(2)],
      tPlayed: [S(W, (x) => x.tPlayed).toFixed(2), S(L, (x) => x.tPlayed).toFixed(2)],
      copperShareOfBuilds: [pct(sum(W, (x) => x.copperPlayed), sum(W, (x) => x.copperPlayed + x.ironPlayed)), pct(sum(L, (x) => x.copperPlayed), sum(L, (x) => x.copperPlayed + x.ironPlayed))],
      finalLength: [S(W, (x) => x.finalLen).toFixed(1), S(L, (x) => x.finalLen).toFixed(1)],
      wrenchesLeftAtEnd: [S(W, (x) => x.wrenchesLeft).toFixed(2), S(L, (x) => x.wrenchesLeft).toFixed(2)],
    },
    attackMix: {
      onTop: pct(sum(all, (x) => x.onTop), sum(all, (x) => x.attacks)),
      adjacent: pct(sum(all, (x) => x.adjacent), sum(all, (x) => x.attacks)),
      leakyCap: pct(sum(all, (x) => x.leakyCaps), sum(all, (x) => x.attacks)),
      onLeader: pct(sum(all, (x) => x.attacksOnLeader), sum(all, (x) => x.attacks)),
      whenTargetWithin2: pct(sum(all, (x) => x.attacksWhenTargetClose), sum(all, (x) => x.attacks)),
    },
    exposure: {
      ironEndTurnShare: pct(sum(all, (x) => x.ironEndTurns), sum(all, (x) => x.ironEndTurns + x.copperEndTurns)),
      onTopHitsPer100IronEndTurns: ((100 * sum(all, (x) => x.hitOnTopWhileIronEnd)) / Math.max(1, sum(all, (x) => x.ironEndTurns))).toFixed(1),
    },
    repairs: { avgRoundsLeakStays: avg(delays).toFixed(2), byCover: pct(method.cover, method.cover + method.wrench), byWrench: pct(method.wrench, method.cover + method.wrench) },
    discardsByKind: (() => {
      const k = {};
      all.forEach((x) => Object.entries(x.discardKinds).forEach(([a, b]) => (k[a] = (k[a] || 0) + b)));
      const tot = Object.values(k).reduce((a, b) => a + b, 0);
      return Object.fromEntries(Object.entries(k).sort((a, b) => b[1] - a[1]).map(([a, b]) => [a, pct(b, tot)]));
    })(),
  };
  return out;
}

const normal = () => B.makeBot();
const res = [2, 3, 4].map((n) => summarize(n, normal, 'tuned heuristic self-play'));
console.log(JSON.stringify(res, null, 1));
