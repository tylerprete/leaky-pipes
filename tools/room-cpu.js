// Where does the server's CPU go per message? Plays games through the room logic with fake
// sockets and times each human move, split by part and by kind of move.
// node tools/room-cpu.js [classic|endless|shared] [players]
const { Room } = require('../server/room.js');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const table = process.argv[2] || 'classic';
const n = +process.argv[3] || 3;
const ms = () => Number(process.hrtime.bigint()) / 1e6;
const stats = {};
const add = (k, v) => (stats[k] || (stats[k] = [])).push(v);
const parts = { apply: [], views: [], save: [], load: [] };
for (let game = 0; game < 40; game++) {
  let t = 0;
  const sent = {};
  const room = new Room({ send: (c, m) => { if (m.t === 'state') sent[c] = m.game; }, close() {}, timer() {}, now: () => (t += 1000), token: () => 'tok' + Math.random() }, 'TEST', { maxLevel: 'normal' });
  room.onMessage('c0', { t: 'create', name: 'Ann', opts: { table, deck: 'tuned', level: 'normal' } });
  for (let i = 1; i < n; i++) room.onMessage('c0', { t: 'addbot' });
  room.onMessage('c0', { t: 'start' });
  const bot = B.makeBot();
  let guard = 0;
  while (room.game.phase !== 'over' && guard++ < 600) {
    const g = room.game;
    if (g.turn !== 0) { room.onTimer(); continue; }
    const view = LP.unpackGame(JSON.parse(JSON.stringify(sent.c0)));
    const m = bot.chooseMove(view, 0);
    const kind = m.type === 'pipe' || m.type === 'cap' ? (m.target != null && m.target !== 0 ? 'attack (leaky card on an opponent)' : m.type === 'pipe' ? 'pipe on my own line' : 'cap on my own line') : m.type;
    // split: rules check + apply, building everyone's view, serialising the room for storage
    const a = ms();
    const r = LP.applyMove(LP.unpackGame(JSON.parse(JSON.stringify(LP.packGame(g)))), 0, m); // same work on a copy, to time it alone
    const b = ms();
    if (!r.ok) throw new Error(r.reason);
    const t0 = ms();
    room.onMessage('c0', { t: 'move', move: m });
    const t1 = ms();
    const saved = JSON.stringify(room.save());
    const t2 = ms();
    Room.load(room.io, JSON.parse(saved), {});
    const t3 = ms();
    add(kind, t1 - t0 + (t2 - t1));
    parts.save.push(t2 - t1); parts.load.push(t3 - t2); parts.apply.push(t1 - t0);
  }
}
const q = (a, p) => { a = a.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
console.log(`table=${table} players=${n} (Node on this machine; the live Worker will differ, the ratios should not)`);
for (const [k, a] of Object.entries(stats).sort((x, y) => q(y[1], 0.95) - q(x[1], 0.95))) console.log(`  ${k.padEnd(36)} n=${String(a.length).padStart(4)}  median ${q(a, 0.5).toFixed(2)} ms  p95 ${q(a, 0.95).toFixed(2)}  max ${q(a, 1).toFixed(2)}`);
console.log(`  parts (median / p95 / max ms): move+views ${q(parts.apply, 0.5).toFixed(2)} / ${q(parts.apply, 0.95).toFixed(2)} / ${q(parts.apply, 1).toFixed(2)}   save ${q(parts.save, 0.5).toFixed(2)} / ${q(parts.save, 0.95).toFixed(2)}   reload after sleep ${q(parts.load, 0.5).toFixed(2)} / ${q(parts.load, 0.95).toFixed(2)}`);
