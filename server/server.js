/* Leaky Pipes game server.
 *
 * Runs the same rules engine as the page. Each room holds one game; the server checks every
 * move, plays the computer seats, and sends each player a view with everyone else's hand
 * and the deck hidden. Players keep their seat across disconnects with a private token.
 *
 *   PORT=8787 node server/server.js
 *
 * It also serves the game page at / (already pointed at this server), so one deployment is
 * enough. The static GitHub Pages build keeps working on its own for games against computers.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');

const PORT = +process.env.PORT || 8787;
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const IDLE_MS = 2 * 60 * 60 * 1000; // rooms are dropped after two quiet hours
const AWAY_MS = +process.env.AWAY_MS || 30000; // a computer covers for an absent player after this
const BOT_MS = +process.env.BOT_MS || 900;
const BOT_NAMES = ['Rusty', 'Faucet', 'Gasket'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const rooms = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(raw, room, fallback) {
  let n = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || fallback;
  if (/^you$/i.test(n)) n = fallback; // "You" is reserved by the rules text
  const taken = new Set(room.seats.map((s) => s.name.toLowerCase()));
  let out = n;
  for (let k = 2; taken.has(out.toLowerCase()); k++) out = n.slice(0, 12) + ' ' + k;
  return out;
}
const pick = (v, list, d) => (list.includes(v) ? v : d);

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function roomInfo(room, seat) {
  return {
    t: 'room',
    code: room.code,
    seat,
    host: room.host,
    started: !!room.game,
    opts: room.opts,
    seats: room.seats.map((s) => ({ name: s.name, kind: s.kind, online: s.kind === 'bot' || !!s.ws })),
  };
}
// What one seat is allowed to see.
function viewFor(room, seat) {
  const g = room.game;
  return Object.assign({}, g, {
    rng: 0,
    deck: new Array(g.deck.length).fill(0),
    players: g.players.map((pl, i) => ({
      name: pl.name,
      kind: i === seat ? 'human' : room.seats[i].kind === 'bot' ? 'bot' : 'remote',
      away: room.seats[i].kind !== 'bot' && !room.seats[i].ws,
      wrenches: pl.wrenches,
      board: pl.board,
      hand: i === seat ? pl.hand : pl.hand.map((_, k) => ({ id: 'hidden' + i + '_' + k, kind: 'hidden' })),
    })),
  });
}
function broadcast(room, ev) {
  room.touched = Date.now();
  room.seats.forEach((s, i) => {
    if (!s.ws) return;
    send(s.ws, roomInfo(room, i));
    if (room.game) send(s.ws, { t: 'state', game: viewFor(room, i), ev: ev || null });
  });
}

function startGame(room) {
  const n = room.seats.length;
  room.game = LP.newGame({
    players: room.seats.map((s) => ({ name: s.name, kind: s.kind === 'bot' ? 'bot' : 'human' })),
    table: room.opts.table,
    deck: room.opts.deck,
    first: room.played % n,
  });
  room.game.level = room.opts.level;
  room.played++;
  broadcast(room, null);
  schedule(room);
}

// Whose move is it, and does the server need to make it?
function schedule(room) {
  clearTimeout(room.timer);
  const g = room.game;
  if (!g || g.phase === 'over') return;
  if (!room.seats.some((x) => x.ws)) return; // nobody is here: the game waits
  const s = room.seats[g.turn];
  if (s.kind === 'bot') room.timer = setTimeout(() => autoMove(room, room.opts.level), g.phase === 'wrenchDiscard' ? 450 : BOT_MS);
  else if (!s.ws) room.timer = setTimeout(() => autoMove(room, 'normal'), Math.max(BOT_MS, AWAY_MS - (Date.now() - (s.leftAt || 0))));
}
function autoMove(room, level) {
  const g = room.game;
  if (!g || g.phase === 'over') return;
  const p = g.turn;
  const s = room.seats[p];
  if (s.kind !== 'bot' && s.ws) return; // they came back
  const bot = room.bots[level] || (room.bots[level] = B.forLevel(level));
  let m = bot.chooseMove(g, p);
  let r = LP.applyMove(g, p, m);
  if (!r.ok) {
    m = g.players[p].hand.length ? { type: 'discard', cardId: g.players[p].hand[0].id } : { type: 'pass' };
    r = LP.applyMove(g, p, m);
  }
  broadcast(room, { p, move: m });
  schedule(room);
}

function handle(ws, msg) {
  const st = ws.state;
  let room = st.room;
  const fail = (text) => send(ws, { t: 'error', text });

  if (msg.t === 'create') {
    if (room) return fail('You are already in a game.');
    if (rooms.size >= MAX_ROOMS) return fail('The server is full right now. Try again later.');
    const o = msg.opts || {};
    room = {
      code: newCode(),
      seats: [],
      host: 0,
      game: null,
      played: 0,
      bots: {},
      touched: Date.now(),
      opts: { table: pick(o.table, ['classic', 'endless', 'shared'], 'classic'), deck: pick(o.deck, ['classic', 'tuned'], 'tuned'), level: pick(o.level, ['easy', 'normal', 'hard'], 'normal') },
    };
    rooms.set(room.code, room);
    const token = crypto.randomBytes(16).toString('hex');
    room.seats.push({ name: cleanName(msg.name, room, 'Player 1'), kind: 'human', ws, token });
    st.room = room;
    st.seat = 0;
    send(ws, { t: 'joined', code: room.code, token });
    return broadcast(room, null);
  }
  if (msg.t === 'join' || msg.t === 'resume') {
    if (room) return fail('You are already in a game.');
    room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'gone', text: "That game code doesn't exist (or the game has ended)." });
    if (msg.t === 'resume' || msg.token) {
      const seat = room.seats.findIndex((s) => s.kind !== 'bot' && s.token && s.token === msg.token);
      if (seat >= 0) {
        const old = room.seats[seat].ws;
        if (old && old !== ws) {
          old.state.room = null;
          send(old, { t: 'gone', text: 'This game was opened somewhere else.' });
          old.close();
        }
        room.seats[seat].ws = ws;
        st.room = room;
        st.seat = seat;
        send(ws, { t: 'joined', code: room.code, token: msg.token });
        broadcast(room, null);
        return schedule(room);
      }
      if (msg.t === 'resume') return send(ws, { t: 'gone', text: 'Your seat in that game is gone.' });
    }
    if (room.game) return fail('That game has already started.');
    if (room.seats.length >= 4) return fail('That game is full.');
    const token = crypto.randomBytes(16).toString('hex');
    room.seats.push({ name: cleanName(msg.name, room, 'Player ' + (room.seats.length + 1)), kind: 'human', ws, token });
    st.room = room;
    st.seat = room.seats.length - 1;
    send(ws, { t: 'joined', code: room.code, token });
    return broadcast(room, null);
  }
  if (!room) return fail('Join a game first.');
  const seat = st.seat;
  const isHost = seat === room.host;

  if (msg.t === 'opts' && isHost && !room.game) {
    const o = msg.opts || {};
    room.opts = { table: pick(o.table, ['classic', 'endless', 'shared'], room.opts.table), deck: pick(o.deck, ['classic', 'tuned'], room.opts.deck), level: pick(o.level, ['easy', 'normal', 'hard'], room.opts.level) };
    return broadcast(room, null);
  }
  if (msg.t === 'addbot' && isHost && !room.game) {
    if (room.seats.length >= 4) return fail('The table is full.');
    room.seats.push({ name: cleanName(BOT_NAMES[room.seats.filter((s) => s.kind === 'bot').length % 3], room, 'Computer'), kind: 'bot' });
    return broadcast(room, null);
  }
  if (msg.t === 'remove' && isHost && !room.game) {
    const k = msg.seat | 0;
    const s = room.seats[k];
    if (!s || k === room.host) return;
    if (s.ws) {
      s.ws.state.room = null;
      send(s.ws, { t: 'gone', text: 'The host removed you from the game.' });
    }
    room.seats.splice(k, 1);
    room.seats.forEach((x, i) => x.ws && (x.ws.state.seat = i));
    room.host = room.seats.findIndex((x) => x.kind !== 'bot');
    return broadcast(room, null);
  }
  if ((msg.t === 'start' || msg.t === 'again') && isHost) {
    if (room.game && room.game.phase !== 'over') return;
    if (room.seats.length < 2) return fail('You need at least two players. Add a computer or invite someone.');
    return startGame(room);
  }
  if (msg.t === 'move') {
    const g = room.game;
    if (!g || g.phase === 'over') return fail('The game is not running.');
    if (g.turn !== seat) return fail("It isn't your turn.");
    const m = msg.move || {};
    const move = { type: String(m.type), cardId: m.cardId == null ? undefined : String(m.cardId), target: m.target == null ? undefined : m.target | 0, i: m.i == null ? undefined : m.i | 0, flip: !!m.flip };
    const r = LP.applyMove(g, seat, move);
    if (!r.ok) return fail(r.reason || "That move isn't allowed.");
    broadcast(room, { p: seat, move });
    return schedule(room);
  }
  if (msg.t === 'leave') return leave(ws, true);
}

function leave(ws, forGood) {
  const st = ws.state;
  const room = st.room;
  if (!room) return;
  st.room = null;
  const s = room.seats[st.seat];
  if (!s || s.ws !== ws) return;
  s.ws = null;
  s.leftAt = Date.now();
  if (!room.game) {
    // in the lobby a seat is simply freed
    room.seats.splice(st.seat, 1);
    room.seats.forEach((x, i) => x.ws && (x.ws.state.seat = i));
    room.host = room.seats.findIndex((x) => x.kind !== 'bot');
  } else if (forGood) {
    // mid-game: a computer takes the seat for the rest of the game
    s.kind = 'bot';
    s.token = null;
    if (room.host === st.seat) room.host = room.seats.findIndex((x) => x.kind !== 'bot');
  }
  if (!room.seats.some((x) => x.kind !== 'bot' && (x.ws || (room.game && x.token)))) {
    clearTimeout(room.timer);
    if (!room.seats.some((x) => x.kind !== 'bot')) rooms.delete(room.code);
    return;
  }
  if (room.host < 0 || !room.seats[room.host] || !room.seats[room.host].ws) {
    const h = room.seats.findIndex((x) => x.kind !== 'bot' && x.ws);
    if (h >= 0) room.host = h;
  }
  broadcast(room, null);
  schedule(room);
}

// ---- http: health check and the game page ----
const PAGE = path.join(__dirname, '..', 'docs', 'index.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(PAGE, 'utf8').replace('<head>', '<head><script>window.LEAKY_SERVER = location.origin.replace(/^http/, "ws");</script>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500);
      return res.end('Run "npm run build" first.');
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: true });
wss.on('connection', (ws) => {
  ws.state = { room: null, seat: -1, n: 0, t0: Date.now() };
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data) => {
    // simple flood guard: 40 messages per 10 seconds
    const st = ws.state;
    if (Date.now() - st.t0 > 10000) {
      st.t0 = Date.now();
      st.n = 0;
    }
    if (++st.n > 40) return ws.close();
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('handler error', e);
      send(ws, { t: 'error', text: 'Something went wrong on the server.' });
    }
  });
  ws.on('close', () => leave(ws, false));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else {
      ws.alive = false;
      ws.ping();
    }
  }
  for (const [code, room] of rooms) {
    if (Date.now() - room.touched > IDLE_MS) {
      clearTimeout(room.timer);
      room.seats.forEach((s) => s.ws && s.ws.close());
      rooms.delete(code);
    }
  }
}, 25000).unref();

server.listen(PORT, () => console.log('Leaky Pipes server on port ' + PORT));
module.exports = { server, rooms };
