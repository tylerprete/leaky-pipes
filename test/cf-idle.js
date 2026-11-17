// The Cloudflare room's idle clean-up: a room in use stays open however old its alarm is, and a
// room nobody touches is closed. Uses a 4-second idle time in place of two hours.
// node test/cf-idle.js   (starts and stops wrangler dev itself on port 8792)
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 8792;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const w = spawn('npx', ['wrangler', 'dev', '--port', PORT, '--var', 'IDLE_MS:4000', '--var', 'CLAIM_MS:1000'], { cwd: __dirname + '/..', stdio: 'ignore', detached: true });
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? '  ok  ' : 'FAIL  ') + what); if (!ok) failed++; };
  try {
    for (let k = 0; k < 60; k++) { await sleep(500); try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch (e) { /* not up yet */ } }
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?create=1`);
    let told = null, code = null, rooms = 0;
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'joined') code = m.code; if (m.t === 'room') rooms++; });
    await new Promise((r) => ws.on('open', r));
    ws._receiver.on('conclude', (c) => (told = c));
    ws.send(JSON.stringify({ t: 'create', name: 'Ann', opts: { table: 'classic' } }));
    // in use for 9 seconds, more than twice the idle time
    for (let k = 0; k < 9; k++) { await sleep(1000); ws.send(JSON.stringify({ t: 'opts', opts: { table: k % 2 ? 'shared' : 'classic' } })); }
    check(told == null && code && rooms >= 9, 'a room in use stays open past the idle time');
    // then left alone
    const t0 = Date.now();
    while (told == null && Date.now() - t0 < 9000) await sleep(100);
    check(told === 1000, 'left alone, it is closed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s after the last message)');
    // and the room was deleted, not just disconnected: joining it now says the game is gone
    const again = new WebSocket(`ws://localhost:${PORT}/ws?room=${code}`);
    let gone = null;
    again.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'gone') gone = m.text; });
    await new Promise((r) => again.on('open', r));
    await sleep(500);
    check(/doesn't exist/.test(gone || ''), 'afterwards the room is gone from storage');
    again.terminate();
    ws.terminate();
  } catch (e) { console.log('FAIL  ' + e.message); failed++; }
  try { process.kill(-w.pid, 'SIGTERM'); } catch (e) { /* gone */ }
  await sleep(800);
  console.log(failed ? `\n${failed} failed` : '\nall good');
  process.exit(failed ? 1 : 0);
})();
