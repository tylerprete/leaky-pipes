// A room on the Cloudflare Worker must survive losing its memory (hibernation, deploys).
// Start a game against `wrangler dev`, restart wrangler, and resume the same seat.
// node test/cf-restart.js   (starts and stops wrangler dev itself on port 8789)
const { spawn } = require('child_process');
const WebSocket = require('ws');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const PORT = 8789;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = async () => {
  const p = spawn('npx', ['wrangler', 'dev', '--port', PORT, '--var', 'BOT_MS:50'], { cwd: __dirname + '/../cloudflare', stdio: 'ignore', detached: true });
  for (let k = 0; k < 60; k++) {
    await sleep(500);
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return p; } catch (e) { /* not up yet */ }
  }
  throw new Error('wrangler dev did not start');
};
const stop = async (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { /* gone */ } await sleep(1500); };
function client(query) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?${query}`);
  const c = { ws, room: null, game: null, token: null, code: null, gone: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'joined') { c.token = m.token; c.code = m.code; }
    if (m.t === 'room') c.room = m;
    if (m.t === 'state') c.game = LP.unpackGame(m.game);
    if (m.t === 'gone') c.gone = m.text;
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.open = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return c;
}
const until = async (f, what) => { for (let k = 0; k < 100; k++) { if (f()) return; await sleep(100); } throw new Error('timed out: ' + what); };
(async () => {
  let w = await start();
  let ok = false;
  try {
    const a = client('create=1');
    await a.open;
    a.send({ t: 'create', name: 'Ann', opts: { table: 'shared', deck: 'tuned', level: 'hard' } });
    await until(() => a.room, 'room');
    if (a.room.opts.level !== 'normal') throw new Error('hard should be capped to normal by default, got ' + a.room.opts.level);
    a.send({ t: 'addbot' });
    await until(() => a.room.seats.length === 2, 'bot seat');
    a.send({ t: 'start' });
    await until(() => a.game, 'first state');
    const bot = B.makeBot();
    for (let k = 0; k < 6; k++) {
      await until(() => a.game.turn === 0 || a.game.phase === 'over', 'my turn');
      const before = a.game.seq;
      a.send({ t: 'move', move: bot.chooseMove(a.game, 0) });
      await until(() => a.game.seq !== before, 'move applied');
    }
    await until(() => a.game.turn === 0, 'my turn before restart');
    const snap = { seq: a.game.seq, turns: a.game.turns, hand: a.game.players[0].hand.map((c) => c.id).join(), cells: a.game.players.map((p) => p.board.cells.filter(Boolean).length).join() };
    a.ws.terminate();
    await stop(w);
    w = await start();
    const b = client('room=' + a.code);
    await b.open;
    b.send({ t: 'resume', code: a.code, token: a.token });
    await until(() => b.game || b.gone, 'resume');
    if (b.gone) throw new Error('room was lost: ' + b.gone);
    const now = { seq: b.game.seq, turns: b.game.turns, hand: b.game.players[0].hand.map((c) => c.id).join(), cells: b.game.players.map((p) => p.board.cells.filter(Boolean).length).join() };
    if (JSON.stringify(snap) !== JSON.stringify(now)) throw new Error('state changed across restart\n' + JSON.stringify(snap) + '\n' + JSON.stringify(now));
    // and the game carries on, computer included
    const before = b.game.turns;
    b.send({ t: 'move', move: bot.chooseMove(b.game, 0) });
    await until(() => b.game.turns >= before + 2 || b.game.phase === 'over', 'computer moved after restart');
    // a made-up code is refused
    const c = client('room=ZZZZ');
    await c.open;
    c.send({ t: 'join', code: 'ZZZZ', name: 'Cy' });
    await until(() => c.gone, 'unknown room refused');
    b.send({ t: 'leave' });
    ok = true;
    console.log('room survived a restart: seat, hand and boards intact; game continued');
  } catch (e) {
    console.log('FAILED', e.message);
  }
  await stop(w);
  process.exit(ok ? 0 : 1);
})();
