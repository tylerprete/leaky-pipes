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
 */
import { DurableObject } from 'cloudflare:workers';
import roomModule from '../server/room.js';

const { Room } = roomModule;
const IDLE_MS = 2 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHABET[b % ALPHABET.length]).join('');

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.want = null; // timer the room asked for during this event (ms), or null
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
        await this.ctx.storage.deleteAll();
        this.room = new Room(this.io(), r.s.code, this.cfg());
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
    await this.load(code);
    if (url.searchParams.get('create') && this.room.s.created) return new Response('taken', { status: 409 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment({ id });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, data) {
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
      const to = (code, create) => {
        const u = new URL(request.url);
        u.search = '?code=' + code + (create ? '&create=1' : '');
        return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(u, request));
      };
      if (url.searchParams.get('create')) {
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
