// Online room logic (server/room.js), driven directly with a fake host: no sockets, no clock.
// Both hosts (the Node server and the Cloudflare Durable Object) run this same code.
// node test/room.test.js
const assert = require('assert');
const LP = require('../src/engine.js');
const B = require('../src/bot.js');
const { Room } = require('../server/room.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
    process.exitCode = 1;
  }
}

// A host that records what the room sends and which timer it asked for.
function host(cfg) {
  const h = { sent: {}, closed: [], timer: null, clock: 1000, tokens: 0 };
  h.io = {
    send: (conn, msg) => (h.sent[conn] = h.sent[conn] || []).push(JSON.parse(JSON.stringify(msg))),
    close: (conn) => h.closed.push(conn),
    timer: (ms) => (h.timer = ms),
    now: () => h.clock,
    token: () => 'tok' + ++h.tokens,
  };
  h.room = new Room(h.io, 'ABCD', Object.assign({ botMs: 900, awayMs: 30000, maxLevel: 'normal' }, cfg || {}));
  h.last = (conn, t) => (h.sent[conn] || []).filter((m) => m.t === t).pop();
  h.say = (conn, msg) => h.room.onMessage(conn, msg);
  return h;
}
// A started two-human game: a (host) and b.
function twoPlayers(cfg) {
  const h = host(cfg);
  h.say('a', { t: 'create', name: 'Ann', opts: { table: 'classic', deck: 'tuned', level: 'normal' } });
  h.say('b', { t: 'join', name: 'Bob' });
  h.say('a', { t: 'start' });
  return h;
}
// A move the engine accepts for whoever is to play, chosen by the Normal computer.
const aMove = (h) => B.forLevel('normal').chooseMove(h.room.game, h.room.game.turn);
const connOfTurn = (h) => h.room.s.seats[h.room.game.turn].conn;

test('create, join and start', () => {
  const h = host();
  h.say('a', { t: 'create', name: 'Ann', opts: { table: 'shared', deck: 'tuned', level: 'normal' } });
  assert.strictEqual(h.last('a', 'joined').code, 'ABCD');
  assert.ok(h.last('a', 'joined').token, 'the creator gets a seat token');
  h.say('b', { t: 'join', name: 'Bob' });
  assert.deepStrictEqual(h.last('a', 'room').seats.map((x) => x.name), ['Ann', 'Bob']);
  assert.strictEqual(h.last('b', 'room').seat, 1);
  h.say('b', { t: 'start' });
  assert.strictEqual(h.room.game, null, 'only the host can start');
  h.say('a', { t: 'start' });
  assert.ok(h.room.game, 'the host starts the game');
  assert.strictEqual(h.last('b', 'state').game.table, 'shared');
});

test('a second create for the same room is refused; joining an unknown room says so', () => {
  const h = host();
  h.say('a', { t: 'create', name: 'Ann' });
  h.say('z', { t: 'create', name: 'Zed' });
  assert.ok(h.last('z', 'error'));
  const fresh = host();
  fresh.say('b', { t: 'join', name: 'Bob' });
  assert.ok(fresh.last('b', 'gone'), 'no such game');
});

test("each seat sees its own hand and nobody else's, and never the deck", () => {
  const h = twoPlayers();
  const real = h.room.game;
  for (const [conn, seat] of [['a', 0], ['b', 1]]) {
    const g = h.last(conn, 'state').game;
    assert.deepStrictEqual(g.players[seat].hand, real.players[seat].hand, 'own hand is real');
    const other = g.players[1 - seat].hand;
    assert.strictEqual(other.length, real.players[1 - seat].hand.length, 'the count is public');
    assert.ok(other.every((c) => c.kind === 'hidden'), 'the cards are not');
    assert.ok(g.deck.every((c) => c === 0), 'deck order is hidden');
    assert.strictEqual(g.rng, 0, 'so is the shuffle state');
    const text = JSON.stringify(g);
    for (const c of real.players[1 - seat].hand) assert.ok(!text.includes('"' + c.id + '"'), "an opponent's card id leaked");
    assert.strictEqual(g.drawn, real.turn === seat ? real.drawn : null, 'only the player to move learns which card they drew');
  }
});

test('moves: out of turn and illegal ones are refused, a legal one reaches everyone', () => {
  const h = twoPlayers();
  const g = h.room.game;
  const turnConn = connOfTurn(h);
  const waitConn = turnConn === 'a' ? 'b' : 'a';
  const seq = g.seq;
  h.say(waitConn, { t: 'move', move: aMove(h) });
  assert.ok(/turn/.test(h.last(waitConn, 'error').text), 'not your turn');
  assert.strictEqual(g.seq, seq, 'nothing changed');
  h.say(turnConn, { t: 'move', move: { type: 'pipe', cardId: 'nope', i: 3 } });
  assert.ok(h.last(turnConn, 'error'), 'a card you do not hold');
  assert.strictEqual(g.seq, seq, 'still nothing changed');
  const before = (h.sent[waitConn] || []).filter((m) => m.t === 'state').length;
  const p = g.turn;
  h.say(turnConn, { t: 'move', move: aMove(h) });
  assert.notStrictEqual(g.seq, seq, 'the move was applied');
  const states = h.sent[waitConn].filter((m) => m.t === 'state');
  assert.strictEqual(states.length, before + 1, 'the other player hears about it');
  assert.strictEqual(states.pop().ev.p, p);
});

test('someone without a seat cannot move or change the room', () => {
  const h = twoPlayers();
  const seq = h.room.game.seq;
  h.say('x', { t: 'move', move: aMove(h) });
  h.say('x', { t: 'start' });
  h.say('x', { t: 'addbot' });
  assert.strictEqual(h.room.game.seq, seq);
  assert.strictEqual(h.room.s.seats.length, 2);
  h.say('x', { t: 'join', name: 'Late' });
  assert.ok(/started/.test(h.last('x', 'error').text), 'no joining a running game');
});

test('a computer seat moves when the timer fires, at no more than the allowed level', () => {
  const h = host({ maxLevel: 'normal' });
  h.say('a', { t: 'create', name: 'Ann', opts: { table: 'classic', deck: 'tuned', level: 'hard' } });
  assert.strictEqual(h.room.s.opts.level, 'normal', 'hard is capped by the host setting');
  h.say('a', { t: 'addbot' });
  h.say('a', { t: 'start' });
  const g = h.room.game;
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 400) {
    if (h.room.s.seats[g.turn].kind === 'bot') {
      assert.ok(h.timer > 0, 'the room asks for a timer on a computer turn');
      const seq = g.seq;
      h.room.onTimer();
      assert.notStrictEqual(g.seq, seq, 'the computer moved');
    } else {
      assert.strictEqual(h.timer, null, 'no timer while waiting for a person who is here');
      h.say('a', { t: 'move', move: aMove(h) });
    }
  }
  assert.strictEqual(g.phase, 'over', 'the game finishes');
  assert.strictEqual(h.timer, null, 'and no timer is left running');
});

test('a dropped player keeps their seat and comes back with their token', () => {
  const h = twoPlayers();
  const token = h.last('b', 'joined').token;
  h.room.onClose('b', false);
  assert.strictEqual(h.room.s.seats[1].kind, 'human', 'still their seat');
  assert.strictEqual(h.last('a', 'room').seats[1].online, false, 'shown as away');
  h.say('b2', { t: 'resume', token: 'wrong' });
  assert.ok(h.last('b2', 'gone'), 'a wrong token gets nothing');
  h.say('b3', { t: 'resume', token });
  assert.strictEqual(h.room.s.seats[1].conn, 'b3');
  assert.deepStrictEqual(h.last('b3', 'state').game.players[1].hand, h.room.game.players[1].hand, 'and they see their hand again');
});

test('a computer covers for a player who stays away, and stops when they return', () => {
  const h = twoPlayers({ awayMs: 30000, botMs: 900 });
  const g = h.room.game;
  const away = g.turn;
  const conn = h.room.s.seats[away].conn;
  const token = h.last(conn, 'joined').token;
  h.room.onClose(conn, false);
  assert.ok(h.timer > 900 && h.timer <= 30000, 'waits the away time first: ' + h.timer);
  const seq = g.seq;
  h.room.onTimer();
  assert.notStrictEqual(g.seq, seq, 'then plays for them');
  // back before their next turn comes round
  h.say('again', { t: 'resume', token });
  while (g.turn !== away && g.phase !== 'over') h.say(connOfTurn(h), { t: 'move', move: aMove(h) });
  if (g.phase !== 'over') {
    assert.strictEqual(h.timer, null, 'no cover while they are here');
    const s2 = g.seq;
    h.room.onTimer();
    assert.strictEqual(g.seq, s2, 'a stale timer does nothing');
  }
});

test('leaving for good mid-game hands the seat to a computer; the last person out empties the room', () => {
  const h = twoPlayers();
  h.say('b', { t: 'leave' });
  assert.strictEqual(h.room.s.seats[1].kind, 'bot');
  assert.strictEqual(h.room.empty, false);
  h.say('a', { t: 'leave' });
  assert.strictEqual(h.room.empty, true);
});

test('a saved room loads back the same, in every table mode', () => {
  for (const table of ['classic', 'endless', 'shared']) {
    const h = host();
    h.say('a', { t: 'create', name: 'Ann', opts: { table, deck: 'tuned', level: 'normal' } });
    h.say('a', { t: 'addbot' });
    h.say('a', { t: 'start' });
    for (let k = 0; k < 12 && h.room.game.phase !== 'over'; k++) {
      if (h.room.s.seats[h.room.game.turn].kind === 'bot') h.room.onTimer();
      else h.say('a', { t: 'move', move: aMove(h) });
    }
    const data = JSON.parse(JSON.stringify(h.room.save())); // what storage would hand back
    const h2 = host();
    const r2 = Room.load(h2.io, data, h.room.cfg);
    const plain = (g) => JSON.parse(JSON.stringify(LP.packGame(g)));
    assert.deepStrictEqual(plain(r2.game), plain(h.room.game), table + ': same game');
    r2.reconcile([]); // the new host has none of the old connections
    assert.strictEqual(r2.s.seats[0].conn, null, table + ': old connection is marked away');
    assert.strictEqual(r2.s.seats[0].token, h.room.s.seats[0].token, table + ': the seat token survives');
    // both copies choose the same next move
    const p = h.room.game.turn;
    assert.deepStrictEqual(B.forLevel('normal').chooseMove(r2.game, p), B.forLevel('normal').chooseMove(h.room.game, p), table + ': same next move');
  }
});

// ---- a Hard computer thinking a piece at a time (how the Cloudflare host runs it) ----
const copyOf = (g) => LP.unpackGame(JSON.parse(JSON.stringify(LP.packGame(g))));
// A two-seat game against a Hard computer on a host that slices the search. Plays the person's
// first move and returns what Hard would choose in reply if it thought straight through.
function hardGame(cfg) {
  const h = host(Object.assign({ maxLevel: 'hard', slice: 2, thinkMs: 2600 }, cfg || {}));
  h.say('a', { t: 'create', name: 'Ann', opts: { table: 'shared', deck: 'tuned', level: 'hard' } });
  h.say('a', { t: 'addbot' });
  h.say('a', { t: 'start' });
  const g = h.room.game;
  assert.strictEqual(g.turn, 0, 'the person moves first in the first game');
  const mine = aMove(h);
  const twin = copyOf(g);
  LP.applyMove(twin, 0, mine);
  h.expected = B.makeSearchBot({}, { budgetMs: 1e9 }).chooseMove(twin, 1);
  h.say('a', { t: 'move', move: mine });
  h.asked = (h.last('a', 'think') || {}).n || 0;
  h.botEv = () => h.sent.a.filter((m) => m.t === 'state' && m.ev && m.ev.p === 1).pop();
  return h;
}

test('sliced Hard: the page is asked for ticks, and with them the computer plays the full Hard move', () => {
  const h = hardGame();
  const g = h.room.game;
  assert.strictEqual(g.turn, 1);
  assert.ok(h.asked > 20, 'asked for ticks: ' + h.asked);
  assert.strictEqual(h.timer, 900, 'the usual pause is still the timer');
  const seq = g.seq;
  for (let k = 0; k < h.asked; k++) assert.strictEqual(h.say('a', { t: 'tick' }), 'quiet', 'a tick changes nothing by itself');
  assert.strictEqual(g.seq, seq, 'no move until the pause is up');
  h.room.onTimer();
  assert.deepStrictEqual(h.botEv().ev.move, h.expected, 'same move as Hard thinking straight through');
});

test('sliced Hard: no ticks at all (an old page) means a Normal move, on time', () => {
  const h = hardGame();
  const g = h.room.game;
  const seq = g.seq;
  h.room.onTimer();
  assert.notStrictEqual(g.seq, seq, 'it moved at the first timer');
  assert.ok(h.botEv(), 'and everyone was told');
});

test('sliced Hard: a slow search gets one extension, then moves the moment it finishes', () => {
  const h = hardGame();
  const g = h.room.game;
  const seq = g.seq;
  const half = Math.floor(h.asked / 2);
  for (let k = 0; k < half; k++) h.say('a', { t: 'tick' });
  h.room.onTimer();
  assert.strictEqual(g.seq, seq, 'not finished: no move yet');
  assert.strictEqual(h.timer, 2600, 'one extension');
  let moved = false;
  for (let k = half; k < h.asked && !moved; k++) moved = h.say('a', { t: 'tick' }) !== 'quiet';
  assert.ok(moved && g.seq !== seq, 'the tick that finishes the search makes the move');
  assert.deepStrictEqual(h.botEv().ev.move, h.expected, 'and it is the full Hard move');
});

test('sliced Hard: if the ticks stop, the computer moves with what it has when the extension ends', () => {
  const h = hardGame();
  const g = h.room.game;
  const seq = g.seq;
  for (let k = 0; k < 5; k++) h.say('a', { t: 'tick' });
  h.room.onTimer(); // extension
  assert.strictEqual(g.seq, seq);
  h.room.onTimer(); // out of time
  assert.notStrictEqual(g.seq, seq, 'it moved');
});

test('sliced Hard: ticks from outside the game, or beyond what was asked, do nothing', () => {
  const h = hardGame();
  const j = h.room.job;
  h.say('stranger', { t: 'tick' });
  assert.strictEqual(j.ticks, 0, 'a stranger cannot drive the search');
  for (let k = 0; k < h.asked + 50; k++) h.say('a', { t: 'tick' });
  assert.ok(j.ticks <= h.asked, 'no more work than was asked for');
  assert.ok(j.search.done, 'and that was enough to finish');
});

test('sliced Hard: if the page sending ticks leaves, another player is asked', () => {
  const h = host({ maxLevel: 'hard', slice: 2 });
  h.say('a', { t: 'create', name: 'Ann', opts: { table: 'classic', deck: 'tuned', level: 'hard' } });
  h.say('b', { t: 'join', name: 'Bob' });
  h.say('a', { t: 'addbot' });
  h.say('a', { t: 'start' });
  while (h.room.s.seats[h.room.game.turn].kind !== 'bot') h.say(connOfTurn(h), { t: 'move', move: aMove(h) });
  assert.ok(h.last('a', 'think') && !h.last('b', 'think'), 'the host is asked first');
  h.room.onClose('a', false);
  assert.ok(h.last('b', 'think'), 'then the player who is still here');
});

test('a host with no limit thinks in one go: no ticks asked, Hard move at the timer', () => {
  const h = hardGame({ slice: 0 });
  assert.strictEqual(h.asked, 0);
  h.room.onTimer();
  assert.deepStrictEqual(h.botEv().ev.move, h.expected);
});

test('reactions reach everyone at the table, one a second each, and change nothing', () => {
  const h = twoPlayers();
  const before = JSON.stringify(h.room.save());
  assert.strictEqual(h.say('b', { t: 'react', k: 1 }), 'quiet', 'nothing to save');
  assert.deepStrictEqual(h.last('a', 'react'), { t: 'react', seat: 1, k: 1 });
  assert.deepStrictEqual(h.last('b', 'react'), { t: 'react', seat: 1, k: 1 }, 'the sender sees it too');
  h.say('b', { t: 'react', k: 2 });
  assert.strictEqual(h.last('a', 'react').k, 1, 'a second one straight away is dropped');
  h.clock += 1500;
  h.say('b', { t: 'react', k: 2 });
  assert.strictEqual(h.last('a', 'react').k, 2, 'a moment later it goes through');
  h.clock += 1500;
  h.say('b', { t: 'react', k: 99 });
  h.say('stranger', { t: 'react', k: 0 });
  assert.strictEqual(h.sent.a.filter((m) => m.t === 'react').length, 2, 'unknown reactions and strangers are ignored');
  assert.strictEqual(JSON.stringify(h.room.save()), before, 'the room is unchanged');
});

test('names are cleaned and kept unique', () => {
  const h = host();
  h.say('a', { t: 'create', name: '<b>Ann</b>' });
  h.say('b', { t: 'join', name: 'bAnn/b' });
  h.say('c', { t: 'join', name: 'You' });
  const names = h.last('a', 'room').seats.map((x) => x.name);
  assert.ok(!names.join('').includes('<'), 'no markup: ' + names);
  assert.strictEqual(new Set(names.map((n) => n.toLowerCase())).size, 3, 'unique: ' + names);
  assert.ok(!names.some((n) => /^you$/i.test(n)), '"You" is reserved');
});

console.log(`\n${passed} passed`);
