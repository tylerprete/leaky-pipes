/* One game room: seats, lobby, the game itself, computer seats, reconnects.
 *
 * This file knows nothing about sockets, clocks or storage. Whoever hosts it (the Node server
 * in server.js, or the Cloudflare Durable Object in cloudflare/worker.js) passes in `io`:
 *
 *   io.send(conn, msg)   deliver a message to one connection
 *   io.close(conn)       drop a connection
 *   io.timer(ms | null)  call room.onTimer() once after ms (replacing any earlier timer)
 *   io.now()             current time in ms
 *   io.token()           a fresh secret for a seat
 *
 * `conn` is any string id the host uses for a connection. Everything in room.s is plain data,
 * so the host can save it with room.save() and bring it back with Room.load().
 */
'use strict';
const LP = require('../src/engine.js');
const B = require('../src/bot.js');

const BOT_NAMES = ['Rusty', 'Faucet', 'Gasket'];
const LEVELS = ['easy', 'normal', 'hard'];
const REACTIONS = 8; // how many reactions the page offers (src/ui.js)
const pick = (v, list, d) => (list.includes(v) ? v : d);

class Room {
  constructor(io, code, cfg) {
    this.io = io;
    // slice: 0 lets a Hard computer think in one go. A host with a tight time limit per event
    // sets it to how many units of the search to run per "tick" message (see think() below);
    // thinkMs is how much longer than botMs such a search may take before the computer moves anyway.
    this.cfg = Object.assign({ botMs: 900, awayMs: 30000, maxLevel: 'hard', slice: 0, thinkMs: 2600 }, cfg || {});
    this.bots = {};
    this.reacted = {}; // connection -> when it last sent a reaction
    this.job = null; // a Hard search in progress (kept in memory only; losing it costs one weaker move)
    this.game = null; // live engine game (unpacked)
    this.s = { code, seats: [], host: 0, played: 0, opts: null, touched: io.now(), created: false };
  }

  // ---- persistence ----
  save() {
    return Object.assign({}, this.s, { game: this.game ? LP.packGame(this.game) : null });
  }
  static load(io, data, cfg) {
    const r = new Room(io, data.code, cfg);
    r.s = Object.assign({}, data);
    delete r.s.game;
    r.game = data.game ? LP.unpackGame(data.game) : null;
    return r;
  }
  // Connections the host no longer has (after a restart or wake-up) are marked as away.
  reconcile(liveConns) {
    const live = new Set(liveConns);
    for (const s of this.s.seats) {
      if (s.conn && !live.has(s.conn)) {
        s.conn = null;
        s.leftAt = this.io.now();
      }
    }
  }
  get empty() {
    return !this.s.created || !this.s.seats.some((x) => x.kind !== 'bot');
  }

  // ---- helpers ----
  seatOf(conn) {
    return this.s.seats.findIndex((x) => x.conn === conn);
  }
  cleanName(raw, fallback) {
    let n = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || fallback;
    if (/^you$/i.test(n)) n = fallback; // "You" is reserved by the rules text
    const taken = new Set(this.s.seats.map((x) => x.name.toLowerCase()));
    let out = n;
    for (let k = 2; taken.has(out.toLowerCase()); k++) out = n.slice(0, 12) + ' ' + k;
    return out;
  }
  opts(o, base) {
    o = o || {};
    const level = pick(o.level, LEVELS, base.level);
    return {
      table: pick(o.table, ['classic', 'endless', 'shared'], base.table),
      deck: pick(o.deck, ['classic', 'tuned'], base.deck),
      level: LEVELS[Math.min(LEVELS.indexOf(level), LEVELS.indexOf(this.cfg.maxLevel))],
    };
  }
  info(seat) {
    const s = this.s;
    return { t: 'room', code: s.code, seat, host: s.host, started: !!this.game, opts: s.opts, seats: s.seats.map((x) => ({ name: x.name, kind: x.kind, online: x.kind === 'bot' || !!x.conn })) };
  }
  // What one seat is allowed to see: everyone else's hand and the deck are hidden.
  view(seat) {
    const g = this.game;
    const p = LP.packGame(g);
    p.rng = 0;
    p.deck = new Array(g.deck.length).fill(0);
    // card ids follow the order the deck was built in, so an id gives the card away:
    // only the player who drew a card is told which one it was
    p.drawn = g.turn === seat ? g.drawn : null;
    p.players = p.players.map((pl, i) => ({
      name: pl.name,
      kind: i === seat ? 'human' : this.s.seats[i].kind === 'bot' ? 'bot' : 'remote',
      away: this.s.seats[i].kind !== 'bot' && !this.s.seats[i].conn,
      wrenches: pl.wrenches,
      board: pl.board,
      hand: i === seat ? pl.hand : pl.hand.map((_, k) => ({ id: 'hidden' + i + '_' + k, kind: 'hidden' })),
    }));
    return p;
  }
  broadcast(ev) {
    this.s.touched = this.io.now();
    this.s.seats.forEach((x, i) => {
      if (!x.conn) return;
      this.io.send(x.conn, this.info(i));
      if (this.game) this.io.send(x.conn, { t: 'state', game: this.view(i), ev: ev || null });
    });
  }
  fixHost() {
    const s = this.s;
    const ok = s.seats[s.host] && s.seats[s.host].kind !== 'bot' && s.seats[s.host].conn;
    if (ok) return;
    let h = s.seats.findIndex((x) => x.kind !== 'bot' && x.conn);
    if (h < 0) h = s.seats.findIndex((x) => x.kind !== 'bot');
    s.host = Math.max(0, h);
  }

  // ---- game flow ----
  start() {
    const s = this.s;
    const n = s.seats.length;
    this.game = LP.newGame({ players: s.seats.map((x) => ({ name: x.name, kind: x.kind === 'bot' ? 'bot' : 'human' })), table: s.opts.table, deck: s.opts.deck, first: s.played % n });
    this.game.level = s.opts.level;
    s.played++;
    this.broadcast(null);
    this.schedule();
  }
  // Whose move is it, and does the server need to make it?
  schedule() {
    const g = this.game;
    if (!g || g.phase === 'over' || !this.s.seats.some((x) => x.conn)) return this.io.timer(null); // nobody here: the game waits
    const x = this.s.seats[g.turn];
    if (x.kind === 'bot') {
      if (this.sliced()) this.think();
      return this.io.timer(g.phase === 'wrenchDiscard' ? Math.min(450, this.cfg.botMs) : this.cfg.botMs);
    }
    if (!x.conn) return this.io.timer(Math.max(this.cfg.botMs, this.cfg.awayMs - (this.io.now() - (x.leftAt || 0))));
    this.io.timer(null);
  }
  onTimer() {
    const g = this.game;
    if (!g || g.phase === 'over') return;
    const p = g.turn;
    const x = this.s.seats[p];
    if (x.kind !== 'bot' && x.conn) return; // they came back
    const level = x.kind === 'bot' ? this.s.opts.level : 'normal';
    if (x.kind === 'bot' && this.sliced()) {
      const j = this.job && this.job.seq === g.seq && this.job.p === p ? this.job : null;
      if (j && !j.search.done && !j.late && j.ticks > 0) {
        // the search is under way but not finished: give it a little longer, once
        j.late = true;
        return this.io.timer(this.cfg.thinkMs);
      }
      // finished, or out of time: the best move found so far; with nothing to go on, a Normal move
      return this.botMove(p, (j && j.search.best()) || this.bot('normal').chooseMove(g, p));
    }
    this.botMove(p, this.bot(level).chooseMove(g, p));
  }
  bot(level) {
    return this.bots[level] || (this.bots[level] = B.forLevel(level));
  }
  botMove(p, m) {
    const g = this.game;
    let r = LP.applyMove(g, p, m);
    if (!r.ok) {
      m = g.players[p].hand.length ? { type: 'discard', cardId: g.players[p].hand[0].id } : { type: 'pass' };
      r = LP.applyMove(g, p, m);
    }
    this.job = null;
    this.broadcast({ p, move: m });
    this.schedule();
  }

  // ---- a Hard computer, thinking a piece at a time ----
  // Hard looks ahead by playing out a few hundred futures: far more work than a host like the
  // Cloudflare Worker allows in one event. So the search is cut into small pieces, and each piece
  // runs when a "tick" message arrives. The room asks one player's page to send the ticks: they
  // carry no information (the page learns nothing and decides nothing), they are only a reason
  // for the host to run again. If the ticks never come, the computer plays a Normal move instead.
  sliced() {
    return this.cfg.slice > 0 && this.s.opts.level === 'hard';
  }
  think() {
    const g = this.game;
    const p = g.turn;
    if (this.job && this.job.seq === g.seq && this.job.p === p) {
      // already on it; if whoever was sending the ticks has gone, ask someone who is here
      if (!this.s.seats.some((x) => x.conn && x.conn === this.job.to)) this.askTicks();
      return;
    }
    const search = this.bot('hard').start(g, p);
    // a move on the shared table costs about twice one on a table of your own
    const per = this.cfg.slice * (g.table === 'shared' ? 1 : 2);
    this.job = { seq: g.seq, p, search, per, asked: search.done ? 0 : Math.ceil(search.units / per) + 2, ticks: 0, late: false, to: null };
    this.askTicks();
  }
  askTicks() {
    const j = this.job;
    if (!j || j.search.done || j.ticks >= j.asked) return;
    const s = this.s;
    const host = s.seats[s.host];
    const who = host && host.kind !== 'bot' && host.conn ? host : s.seats.find((x) => x.kind !== 'bot' && x.conn);
    j.to = who ? who.conn : null;
    if (who) this.io.send(who.conn, { t: 'think', n: j.asked - j.ticks });
  }
  onTick(conn) {
    const j = this.job;
    const g = this.game;
    if (!j || !g || g.phase === 'over' || j.seq !== g.seq || j.p !== g.turn || j.search.done || j.ticks >= j.asked || this.seatOf(conn) < 0) return 'quiet';
    j.ticks++;
    if (!j.search.step(j.per) || !j.late) return 'quiet'; // not finished, or finished early: the timer makes the move
    this.botMove(j.p, j.search.best()); // finished after its pause was already up: move now
  }

  // ---- messages ----
  onMessage(conn, msg) {
    const s = this.s;
    const io = this.io;
    const fail = (text) => io.send(conn, { t: 'error', text });
    // Returning 'quiet' tells the host that nothing in the room changed, so there is nothing to save.
    if (msg.t === 'tick') return this.onTick(conn);
    let seat = this.seatOf(conn);

    if (msg.t === 'create') {
      if (s.created) return fail('That game already exists.');
      s.created = true;
      s.opts = this.opts(msg.opts, { table: 'classic', deck: 'tuned', level: 'normal' });
      const token = io.token();
      s.seats.push({ name: this.cleanName(msg.name, 'Player 1'), kind: 'human', conn, token });
      io.send(conn, { t: 'joined', code: s.code, token });
      return this.broadcast(null);
    }
    if (msg.t === 'join' || msg.t === 'resume') {
      if (!s.created) return io.send(conn, { t: 'gone', text: "That game code doesn't exist (or the game has ended)." });
      if (seat >= 0) return;
      if (msg.token) {
        const k = s.seats.findIndex((x) => x.kind !== 'bot' && x.token && x.token === msg.token);
        if (k >= 0) {
          const old = s.seats[k].conn;
          if (old && old !== conn) {
            io.send(old, { t: 'gone', text: 'This game was opened somewhere else.' });
            io.close(old);
          }
          s.seats[k].conn = conn;
          io.send(conn, { t: 'joined', code: s.code, token: msg.token });
          this.fixHost();
          this.broadcast(null);
          return this.schedule();
        }
        if (msg.t === 'resume') return io.send(conn, { t: 'gone', text: 'Your seat in that game is gone.' });
      }
      if (this.game) return fail('That game has already started.');
      if (s.seats.length >= 4) return fail('That game is full.');
      const token = io.token();
      s.seats.push({ name: this.cleanName(msg.name, 'Player ' + (s.seats.length + 1)), kind: 'human', conn, token });
      io.send(conn, { t: 'joined', code: s.code, token });
      this.fixHost();
      return this.broadcast(null);
    }
    if (seat < 0) return fail('Join a game first.');
    const isHost = seat === s.host;

    if (msg.t === 'opts' && isHost && !this.game) {
      s.opts = this.opts(msg.opts, s.opts);
      return this.broadcast(null);
    }
    if (msg.t === 'addbot' && isHost && !this.game) {
      if (s.seats.length >= 4) return fail('The table is full.');
      s.seats.push({ name: this.cleanName(BOT_NAMES[s.seats.filter((x) => x.kind === 'bot').length % 3], 'Computer'), kind: 'bot' });
      return this.broadcast(null);
    }
    if (msg.t === 'remove' && isHost && !this.game) {
      const k = msg.seat | 0;
      const x = s.seats[k];
      if (!x || k === s.host) return;
      if (x.conn) {
        io.send(x.conn, { t: 'gone', text: 'The host removed you from the game.' });
        io.close(x.conn);
      }
      const hostConn = s.seats[s.host].conn;
      s.seats.splice(k, 1);
      s.host = Math.max(0, s.seats.findIndex((y) => y.conn === hostConn));
      return this.broadcast(null);
    }
    if ((msg.t === 'start' || msg.t === 'again') && isHost) {
      if (this.game && this.game.phase !== 'over') return;
      if (s.seats.length < 2) return fail('You need at least two players. Add a computer or invite someone.');
      return this.start();
    }
    if (msg.t === 'move') {
      const g = this.game;
      if (!g || g.phase === 'over') return fail('The game is not running.');
      if (g.turn !== seat) return fail("It isn't your turn.");
      const m = msg.move || {};
      const move = { type: String(m.type), cardId: m.cardId == null ? undefined : String(m.cardId), target: m.target == null ? undefined : m.target | 0, i: m.i == null ? undefined : m.i | 0, flip: !!m.flip };
      const r = LP.applyMove(g, seat, move);
      if (!r.ok) return fail(r.reason || "That move isn't allowed.");
      this.broadcast({ p: seat, move });
      return this.schedule();
    }
    if (msg.t === 'react') {
      // a quick reaction, shown to everyone at the table. One a second per player; nothing is saved.
      const k = msg.k | 0;
      const now = io.now();
      if (k < 0 || k >= REACTIONS || now - (this.reacted[conn] || 0) < 1000) return 'quiet';
      this.reacted[conn] = now;
      for (const x of s.seats) if (x.conn) io.send(x.conn, { t: 'react', seat, k });
      return 'quiet';
    }
    if (msg.t === 'leave') return this.onClose(conn, true);
  }

  // A connection went away. forGood = they chose to leave (not just a dropped connection).
  onClose(conn, forGood) {
    const s = this.s;
    delete this.reacted[conn];
    const seat = this.seatOf(conn);
    if (seat < 0) return;
    const x = s.seats[seat];
    x.conn = null;
    x.leftAt = this.io.now();
    if (!this.game) {
      s.seats.splice(seat, 1); // in the lobby a seat is simply freed
    } else if (forGood) {
      x.kind = 'bot'; // mid-game: a computer takes the seat for the rest of the game
      x.token = null;
    }
    if (this.empty) return this.io.timer(null);
    this.fixHost();
    this.broadcast(null);
    this.schedule();
    if (this.job && this.job.to === conn) this.askTicks(); // they were helping a computer think: ask someone else
  }
}

module.exports = { Room };
