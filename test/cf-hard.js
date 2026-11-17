// Hard computers on the Cloudflare Worker: the search runs a piece per "tick" message.
// Plays a game against `wrangler dev` twice: once answering the server's requests for ticks (as
// the page does), once ignoring them (as an old cached page would).
// node test/cf-hard.js [players]   (starts and stops wrangler dev itself on port 8793)
const { spawn } = require('child_process');
const WebSocket = require('ws');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const PORT = 8793;
const N = +process.argv[2] || 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log((ok ? '  ok  ' : 'FAIL  ') + what); if (!ok) failed++; };
async function game(table, answerTicks, maxMoves) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?create=1`);
  const st = { game: null, room: null, thinks: 0, ticks: 0, botMoves: [], lastMine: 0, error: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'room') st.room = m;
    if (m.t === 'error') st.error = m.text;
    if (m.t === 'think') { st.thinks++; if (answerTicks) for (let k = 0; k < m.n; k++) { ws.send('{"t":"tick"}'); st.ticks++; } }
    if (m.t === 'state') { st.game = LP.unpackGame(m.game); if (m.ev && m.ev.p !== 0) { st.botMoves.push(Date.now() - st.mark); st.mark = Date.now(); } }
  });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'create', name: 'Ann', opts: { table, deck: 'tuned', level: 'hard' } });
  for (let k = 1; k < N; k++) send({ t: 'addbot' });
  send({ t: 'start' });
  const bot = B.makeBot();
  let mine = 0, lastSeq = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(20);
    const g = st.game;
    if (!g) continue;
    if (g.phase === 'over' || mine >= maxMoves) break;
    if (g.turn !== 0 || g.seq === lastSeq) continue;
    lastSeq = g.seq;
    st.mark = Date.now();
    send({ t: 'move', move: bot.chooseMove(g, 0) });
    mine++;
  }
  ws.close();
  const ms = st.botMoves.slice().sort((a, b) => a - b);
  return { level: st.room && st.room.opts.level, mine, thinks: st.thinks, ticks: st.ticks, bots: ms.length, median: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1], error: st.error, seq: st.game && st.game.seq };
}
(async () => {
  const w = spawn('npx', ['wrangler', 'dev', '--port', PORT], { cwd: __dirname + '/..', stdio: 'ignore', detached: true });
  try {
    for (let k = 0; k < 60; k++) { await sleep(500); try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch (e) { /* not up yet */ } }
    for (const table of ['classic', 'shared']) {
      const a = await game(table, true, 10);
      console.log(`${table}, ${N} players, ticks answered: ${a.bots} computer moves, ${a.thinks} searches, ${a.ticks} ticks sent (${Math.round(a.ticks / Math.max(1, a.thinks))} per search); a computer's move took median ${a.median} ms, longest ${a.max} ms`);
      check(a.level === 'hard', table + ': the room allows Hard');
      check(a.thinks >= 5 && a.bots >= 8 * (N - 1), table + ': the computer asked for ticks and kept moving');
      check(a.max < 900 + 2600 + 1200, table + ': no move took longer than the pause plus one extension');
      const b = await game(table, false, 6);
      console.log(`${table}, ticks ignored: ${b.bots} computer moves; median ${b.median} ms, longest ${b.max} ms`);
      check(b.bots >= 4 * (N - 1) && b.max < 1500, table + ': with no ticks it still moves on time (at Normal strength)');
    }
  } catch (e) { console.log('FAIL  ' + e.message); failed++; }
  try { process.kill(-w.pid, 'SIGTERM'); } catch (e) { /* gone */ }
  await sleep(800);
  console.log(failed ? `\n${failed} failed` : '\nall good');
  process.exit(failed ? 1 : 0);
})();
