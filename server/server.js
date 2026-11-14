/* Leaky Pipes game server for Node.
 *
 * Runs the same rules engine as the page. Each room holds one game; the server checks every
 * move, plays the computer seats, and sends each player a view with everyone else's hand
 * and the deck hidden. Players keep their seat across disconnects with a private token.
 * The room logic is in room.js and is shared with the Cloudflare version (cloudflare/).
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
const { Room } = require('./room.js');

const PORT = +process.env.PORT || 8787;
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const IDLE_MS = 2 * 60 * 60 * 1000; // rooms are dropped after two quiet hours
const CFG = { awayMs: +process.env.AWAY_MS || 30000, botMs: +process.env.BOT_MS || 900, maxLevel: process.env.MAX_LEVEL || 'hard' };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const rooms = new Map(); // code -> { room, timer }
const conns = new Map(); // conn id -> ws
let nextConn = 1;

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
const sendTo = (conn, msg) => {
  const ws = conns.get(conn);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};
function makeRoom(code) {
  const entry = { room: null, timer: null };
  entry.room = new Room(
    {
      send: sendTo,
      close: (conn) => {
        const ws = conns.get(conn);
        if (ws) {
          ws.code = null;
          ws.close();
        }
      },
      timer: (ms) => {
        clearTimeout(entry.timer);
        if (ms != null) entry.timer = setTimeout(() => guard(() => entry.room.onTimer()), ms);
      },
      now: () => Date.now(),
      token: () => crypto.randomBytes(16).toString('hex'),
    },
    code,
    CFG
  );
  rooms.set(code, entry);
  return entry;
}
function guard(fn) {
  try {
    fn();
  } catch (e) {
    console.error('room error', e);
  }
}
function drop(code) {
  const e = rooms.get(code);
  if (!e) return;
  clearTimeout(e.timer);
  rooms.delete(code);
}

function handle(ws, msg) {
  if (!ws.code) {
    if (msg.t === 'create') {
      if (rooms.size >= MAX_ROOMS) return sendTo(ws.id, { t: 'error', text: 'The server is full right now. Try again later.' });
      ws.code = newCode();
      makeRoom(ws.code);
    } else if (msg.t === 'join' || msg.t === 'resume') {
      const code = String(msg.code || '').toUpperCase().trim();
      if (!rooms.has(code)) return sendTo(ws.id, { t: 'gone', text: "That game code doesn't exist (or the game has ended)." });
      ws.code = code;
    } else return sendTo(ws.id, { t: 'error', text: 'Join a game first.' });
  }
  const e = rooms.get(ws.code);
  if (!e) return;
  e.room.onMessage(ws.id, msg);
  if (e.room.seatOf(ws.id) < 0) ws.code = null; // not seated (refused, or just left)
  if (e.room.empty) drop(e.room.s.code);
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
  // the page's icon files
  const STATIC = { '/icon.svg': 'image/svg+xml', '/apple-touch-icon.png': 'image/png', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/manifest.webmanifest': 'application/manifest+json' };
  if (STATIC[url]) {
    try {
      const body = fs.readFileSync(path.join(__dirname, '..', 'docs', url.slice(1)));
      res.writeHead(200, { 'content-type': STATIC[url], 'cache-control': 'public, max-age=86400' });
      return res.end(body);
    } catch (e) {
      /* fall through to 404 */
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: true });
wss.on('connection', (ws) => {
  ws.id = 'c' + nextConn++;
  ws.code = null;
  ws.n = 0;
  ws.t0 = Date.now();
  ws.alive = true;
  conns.set(ws.id, ws);
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data) => {
    // simple flood guard: 40 messages per 10 seconds
    if (Date.now() - ws.t0 > 10000) {
      ws.t0 = Date.now();
      ws.n = 0;
    }
    if (++ws.n > 40) return ws.close();
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
      sendTo(ws.id, { t: 'error', text: 'Something went wrong on the server.' });
    }
  });
  ws.on('close', () => {
    const e = ws.code && rooms.get(ws.code);
    if (e) {
      guard(() => e.room.onClose(ws.id, false));
      if (e.room.empty) drop(ws.code);
    }
    conns.delete(ws.id);
  });
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
  for (const [code, e] of rooms) {
    if (Date.now() - e.room.s.touched > IDLE_MS) {
      e.room.s.seats.forEach((x) => x.conn && conns.get(x.conn) && conns.get(x.conn).close());
      drop(code);
    }
  }
}, 25000).unref();

server.listen(PORT, () => console.log('Leaky Pipes server on port ' + PORT));
module.exports = { server, rooms };
