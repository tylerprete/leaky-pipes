// The Cloudflare Worker's guards against abuse, checked against `wrangler dev`.
// node test/cf-abuse.js   (starts and stops wrangler dev itself on port 8790)
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 8790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = async () => {
  const p = spawn('npx', ['wrangler', 'dev', '--port', PORT, '--var', 'BOT_MS:50', '--var', 'CLAIM_MS:1500'], { cwd: __dirname + '/..', stdio: 'ignore', detached: true });
  for (let k = 0; k < 60; k++) {
    await sleep(500);
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return p; } catch (e) { /* not up yet */ }
  }
  throw new Error('wrangler dev did not start');
};
const stop = async (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { /* gone */ } await sleep(1000); };
// A client that records what happened to it. `ip` stands in for the address Cloudflare reports.
function client(query, ip) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?${query}`, { headers: ip ? { 'cf-connecting-ip': ip } : {} });
  const c = { ws, msgs: [], code: null, token: null, gone: null, closed: null, told: null, refused: null, room: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    c.msgs.push(m);
    if (m.t === 'joined') { c.code = m.code; c.token = m.token; }
    if (m.t === 'room') c.room = m;
    if (m.t === 'gone') c.gone = m.text;
  });
  ws.on('close', (code) => (c.closed = code));
  ws.on('unexpected-response', (req, res) => { c.refused = res.statusCode; c.closed = -1; });
  ws.on('error', () => { if (c.closed == null) c.closed = -1; });
  c.send = (m) => { try { ws.send(JSON.stringify(m)); } catch (e) { /* closed */ } };
  // `told` is the close code the server sent; `closed` is set once the connection itself is down
  ws.on('open', () => ws._receiver.on('conclude', (code) => (c.told = code)));
  c.open = new Promise((r) => { ws.on('open', () => r(true)); ws.on('error', () => r(false)); ws.on('unexpected-response', () => r(false)); });
  return c;
}
const until = async (f, what) => { for (let k = 0; k < 80; k++) { if (f()) return; await sleep(100); } throw new Error('timed out: ' + what); };
let failed = 0;
const check = (ok, what) => { console.log((ok ? '  ok  ' : 'FAIL  ') + what); if (!ok) failed++; };

(async () => {
  const w = await start();
  try {
    // 1. a code nobody created: told so, and the socket is not kept
    const stray = client('room=QQQQ', '10.0.0.1');
    await stray.open;
    await until(() => stray.closed != null, 'stray socket closed');
    check(/doesn't exist/.test(stray.gone || ''), 'unknown code: told the game does not exist');
    check(stray.closed === 1000, 'unknown code: socket closed by the server (' + stray.closed + ')');

    // 2. a normal game still works, and a flood on one socket gets that socket dropped
    const a = client('create=1', '10.0.0.2');
    await a.open;
    a.send({ t: 'create', name: 'Ann', opts: { table: 'classic', deck: 'tuned', level: 'normal' } });
    await until(() => a.code, 'room created');
    const b = client('room=' + a.code, '10.0.0.3');
    await b.open;
    b.send({ t: 'join', name: 'Bob' });
    await until(() => b.token && a.room && a.room.seats.length === 2, 'second player joined');
    check(true, 'create and join still work');
    for (let k = 0; k < 30; k++) a.send({ t: 'opts', opts: { table: k % 2 ? 'shared' : 'classic' } });
    await sleep(600);
    check(a.closed == null, '30 quick messages are fine');
    for (let k = 0; k < 60; k++) b.send({ t: 'opts', opts: {} });
    await until(() => b.closed != null, 'flooding socket closed');
    check(b.closed === 1008, 'flood: socket closed with a policy code (' + b.closed + ')');
    await until(() => a.room && a.room.seats.length === 1, 'flooder left the lobby');
    check(a.closed == null, 'flood: the other player is untouched');
    const b2 = client('room=' + a.code, '10.0.0.3');
    await b2.open;
    b2.send({ t: 'join', name: 'Bob' });
    await until(() => b2.token, 'rejoined');
    check(true, 'flood: they can come back afterwards');

    // 3. sockets per room are capped
    const extra = [];
    for (let k = 0; k < 14; k++) { const c = client('room=' + a.code, '10.0.1.' + k); extra.push(c); await c.open; }
    await sleep(300);
    const turned = extra.filter((c) => c.refused === 429).length;
    check(turned === 4, 'room cap: 12 sockets allowed, the rest refused (refused ' + turned + ' of 14 with 2 already in)');
    extra.forEach((c) => c.ws.terminate());
    await sleep(500);

    // 4. a room that is opened but never created is closed (after a minute; 1.5 s in this test),
    //    while one that is created in time stays open
    const idle = client('create=1', '10.0.0.4');
    const kept = client('create=1', '10.0.0.5');
    await idle.open;
    await kept.open;
    kept.send({ t: 'create', name: 'Dee' });
    await until(() => idle.told != null, 'unclaimed room closed');
    await sleep(1500);
    check(idle.told === 1000, 'unclaimed room: the server closes the socket (' + idle.told + ')');
    check(kept.told == null && kept.closed == null && !!kept.code, 'a room created in time stays open');
    idle.ws.terminate();

    // 5. new games per address are limited; other addresses are unaffected
    const made = [];
    for (let k = 0; k < 14; k++) { const c = client('create=1', '10.0.0.9'); made.push(c); await c.open; }
    await sleep(500);
    const limited = made.filter((c) => /Too many new games/.test(c.gone || '')).length;
    check(limited >= 3 && limited <= 5, 'create limit: about 10 a minute per address (' + limited + ' of 14 turned away)');
    const other = client('create=1', '10.0.0.10');
    await other.open;
    other.send({ t: 'create', name: 'Cy' });
    await until(() => other.code, 'someone else can still create');
    check(true, 'create limit: another address is not affected');
    made.forEach((c) => c.ws.terminate());

    // 6. connections per address are limited too
    const many = [];
    for (let k = 0; k < 130; k++) { const c = client('room=' + a.code, '10.0.0.20'); many.push(c); }
    await Promise.all(many.map((c) => c.open));
    await sleep(500);
    const cut = many.filter((c) => c.refused === 429).length;
    check(cut >= 10, 'connect limit: a burst of 130 from one address is cut off (' + cut + ' refused)');
    many.forEach((c) => c.ws.terminate());
  } catch (e) {
    console.log('FAIL  ' + e.message);
    failed++;
  } finally {
    await stop(w);
  }
  console.log(failed ? `\n${failed} failed` : '\nall good');
  process.exit(failed ? 1 : 0);
})();
