/* Leaky Pipes on Cloudflare Workers.
 *
 * - The Worker (default export) serves the game page, and routes each WebSocket to the
 *   Durable Object for its room. A room's 4-letter code is the object's name.
 * - GameRoom (a Durable Object) is one room. It uses the same room logic as the Node server
 *   (server/room.js). What differs is the plumbing:
 *     sockets   WebSocket Hibernation API, so an idle room can be evicted from memory while
 *               its sockets stay open; each socket carries its connection id as a tag
 *     state     saved to the object's storage after every message, reloaded on wake-up
 *     timers    one alarm per room: the next computer move, or a clean-up when idle
 *
 * Guards against abuse (the page is public, so anyone can open sockets to it):
 *     Worker    per-address limits on new connections and on new games (Rate Limiting bindings)
 *     room      a cap on sockets per room, a per-socket message flood guard, no socket kept for
 *               a game code that doesn't exist, and a short deadline to actually create a game
 */
import { DurableObject } from 'cloudflare:workers';
import roomModule from '../server/room.js';

const { Room } = roomModule;
const IDLE_MS = 2 * 60 * 60 * 1000;
const CLAIM_MS = 60 * 1000; // a new room's socket must send "create" within this long
const MAX_SOCKETS = 12; // per room: four seats, plus reconnects that overlap the socket they replace
const FLOOD_N = 40; // messages allowed per socket ...
const FLOOD_MS = 10 * 1000; // ... in this window (same guard as the Node server)
const NO_ROOM = "That game code doesn't exist (or the game has ended).";

// Answer a WebSocket request with one message and a close, without keeping the socket.
// (A plain HTTP error can't carry text to the page: browsers hide why a WebSocket failed.)
function refuse(text) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ t: 'gone', text }));
  pair[1].close(1000, 'bye');
  return new Response(null, { status: 101, webSocket: pair[0] });
}
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHABET[b % ALPHABET.length]).join('');

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.want = null; // timer the room asked for during this event (ms), or null
    // message counts per socket. Kept in memory only: a room is evicted from memory only after
    // its sockets have gone quiet, and a quiet socket's count would have reset anyway.
    this.rate = new Map();
  }

  io() {
    return {
      send: (conn, msg) => {
        for (const ws of this.ctx.getWebSockets(conn)) {
          try {
            ws.send(JSON.stringify(msg));
          } catch (e) {
            /* socket already gone */
          }
        }
      },
      close: (conn) => {
        for (const ws of this.ctx.getWebSockets(conn)) {
          try {
            ws.close(1000, 'bye');
          } catch (e) {
            /* socket already gone */
          }
        }
      },
      timer: (ms) => {
        this.want = ms;
      },
      now: () => Date.now(),
      token: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  }
  cfg() {
    return { botMs: +this.env.BOT_MS || 900, awayMs: +this.env.AWAY_MS || 30000, maxLevel: this.env.MAX_LEVEL || 'normal' };
  }
  connOf(ws) {
    const a = ws.deserializeAttachment();
    return a && a.id;
  }

  // Bring the room into memory (first event after creation, or after hibernation).
  async load(code) {
    if (this.room) return;
    const data = await this.ctx.storage.get('room');
    this.room = data ? Room.load(this.io(), data, this.cfg()) : new Room(this.io(), code || 'XXXX', this.cfg());
    this.room.reconcile(this.ctx.getWebSockets().map((ws) => this.connOf(ws)));
  }
  // Save, and set the one alarm: the room's own timer if it wants one, else idle clean-up.
  async flush() {
    const r = this.room;
    if (r.empty) {
      if (r.s.created) {
        // everyone has left: forget the game, and drop any socket that never took a seat
        await this.ctx.storage.deleteAll();
        this.room = new Room(this.io(), r.s.code, this.cfg());
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1000, 'bye');
          } catch (e) {
            /* already closed */
          }
        }
      }
      this.want = null;
      return;
    }
    await this.ctx.storage.put('room', r.save());
    await this.ctx.storage.put('alarm', this.want != null ? 'move' : 'idle');
    await this.ctx.storage.setAlarm(Date.now() + (this.want != null ? this.want : IDLE_MS));
    this.want = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const create = !!url.searchParams.get('create');
    await this.load(code);
    if (create && this.room.s.created) return new Response('taken', { status: 409 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!create && !this.room.s.created) return refuse(NO_ROOM);
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Too many connections to this game', { status: 429 });
    const pair = new WebSocketPair();
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment({ id });
    if (!this.room.s.created) {
      // nothing is stored for this room yet. If "create" never arrives, the alarm closes the socket.
      await this.ctx.storage.put('alarm', 'idle');
      await this.ctx.storage.setAlarm(Date.now() + (+this.env.CLAIM_MS || CLAIM_MS));
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // How far over the limit this socket is: 0 while it has sent at most FLOOD_N messages within
  // FLOOD_MS, then 1 for the first message past it, 2 for the next, and so on.
  flooding(conn) {
    const now = Date.now();
    let r = this.rate.get(conn);
    if (!r || now - r.t0 > FLOOD_MS) this.rate.set(conn, (r = { t0: now, n: 0 }));
    return Math.max(0, ++r.n - FLOOD_N);
  }

  async webSocketMessage(ws, data) {
    const over = this.flooding(this.connOf(ws));
    if (over) {
      // drop the socket once; anything still in flight behind it is ignored without touching storage
      if (over > 1) return;
      const conn = this.connOf(ws);
      await this.gone(ws); // frees the seat's connection; the player can come back with their token
      this.rate.set(conn, { t0: Date.now(), n: FLOOD_N + 1 });
      try {
        ws.close(1008, 'Too many messages');
      } catch (e) {
        /* already closed */
      }
      return;
    }
    if (typeof data !== 'string' || data.length > 16 * 1024) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    await this.load();
    this.want = null;
    this.room.schedule(); // start from the timer the room currently needs
    this.room.onMessage(this.connOf(ws), msg);
    await this.flush();
  }
  async webSocketClose(ws, code) {
    await this.gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch (e) {
      /* already closed */
    }
  }
  async webSocketError(ws) {
    await this.gone(ws);
  }
  async gone(ws) {
    this.rate.delete(this.connOf(ws));
    await this.load();
    this.want = null;
    this.room.schedule();
    this.room.onClose(this.connOf(ws), false);
    await this.flush();
  }

  async alarm() {
    await this.load();
    const kind = await this.ctx.storage.get('alarm');
    const r = this.room;
    if (kind === 'idle' || r.empty) {
      // nothing happened for two hours (or everyone left): close up
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, 'idle');
        } catch (e) {
          /* already closed */
        }
      }
      await this.ctx.storage.deleteAll();
      this.room = null;
      this.rate.clear();
      return;
    }
    this.want = null;
    r.onTimer();
    if (this.want == null) r.schedule();
    await this.flush();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      // Limits are counted per network address. Many people can share one address (a school,
      // a phone network), so they are set well above what a household of players needs and are
      // only there to stop a script. Counts are approximate and kept per Cloudflare location.
      const who = request.headers.get('cf-connecting-ip') || 'unknown';
      const creating = !!url.searchParams.get('create');
      if (env.CONNECT_LIMIT && !(await env.CONNECT_LIMIT.limit({ key: who })).success) {
        // no message: a player who is reconnecting keeps their seat and simply tries again
        return new Response('Too many connections, try again shortly', { status: 429 });
      }
      if (creating && env.CREATE_LIMIT && !(await env.CREATE_LIMIT.limit({ key: who })).success) {
        return refuse('Too many new games from your network. Try again in a minute.');
      }
      const to = (code, create) => {
        const u = new URL(request.url);
        u.search = '?code=' + code + (create ? '&create=1' : '');
        return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(u, request));
      };
      if (creating) {
        for (let k = 0; k < 6; k++) {
          const res = await to(randomCode(), true);
          if (res.status !== 409) return res;
        }
        return new Response('No free game codes, try again', { status: 503 });
      }
      const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').padEnd(4, 'X').slice(0, 4);
      return to(code, false);
    }
    // the game page, told to use this Worker as its game server
    const res = await env.ASSETS.fetch(request);
    if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
    return new HTMLRewriter()
      .on('head', {
        element(el) {
          el.prepend('<script>window.LEAKY_SERVER = location.origin.replace(/^http/, "ws");</script>', { html: true });
        },
      })
      .transform(res);
  },
};
