const assert = require('assert');
const LP = require('../src/engine.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok  ' + name);
  } catch (e) {
    console.log('FAIL ' + name + '\n   ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e));
    process.exitCode = 1;
  }
}

let uid = 0;
const pipe = (mat, shape) => ({ id: 't' + uid++, kind: 'pipe', mat, shape });
const cap = (caps) => ({ id: 't' + uid++, kind: 'cap', caps });
const at = (b, x, y) => y * b.w + x;
function put(b, x, y, card, flip, extra) {
  const i = at(b, x, y);
  LP.setCell(b, i, Object.assign({ card, flip: !!flip, repaired: false, wrench: false, under: [], by: b.owner }, extra || {}));
  if (card.kind === 'pipe') b.last = i;
  return i;
}
// A two-player game with empty hands we can stock by hand.
function bareGame(n) {
  const g = LP.newGame({ players: Array.from({ length: n || 2 }, (_, i) => ({ name: 'P' + i, kind: 'human' })), seed: 7 });
  for (const p of g.players) p.hand = [];
  g.turn = 0;
  g.phase = 'play';
  return g;
}

// Tyler's table, mirrored so the valve sits on the right and opens left (as the rulebook sets it up).
function photoBoard() {
  const b = LP.newBoard(0); // valve at (13,3) opening W
  put(b, 12, 3, pipe('iron', 'L1'), false); // E,N
  put(b, 12, 2, pipe('iron', 'L1'), true); // S,W
  put(b, 11, 2, pipe('iron', 'T1'), false); // E,S,W
  put(b, 11, 3, pipe('iron', 'V'), false); // N,S
  put(b, 11, 4, pipe('copper', 'L2'), false); // N,W
  put(b, 10, 4, pipe('copper', 'L1'), false); // N,E
  put(b, 10, 3, pipe('iron', 'V'), false); // N,S  -> head points up into (10,2)
  return b;
}

test('photo position: both open ends point into the same square', () => {
  const b = photoBoard();
  const ends = LP.openEnds(b);
  assert.strictEqual(ends.length, 2);
  assert.ok(ends.every((e) => e.t === at(b, 10, 2)));
});

test('photo position: a T that merges the loop and keeps going is legal (rulebook RIGHT example)', () => {
  const b = photoBoard();
  const r = LP.evalPipe(b, at(b, 10, 2), pipe('iron', 'T1'), false); // E,S,W
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.conns.length, 2);
});

test('photo position: everything else in that square is illegal', () => {
  const b = photoBoard();
  const i = at(b, 10, 2);
  assert.ok(!LP.evalPipe(b, i, pipe('iron', 'V'), false).ok, 'straight blocks the T arm');
  assert.ok(!LP.evalPipe(b, i, pipe('iron', 'L2'), true).ok, 'S,E elbow closes the loop with no way out');
  assert.ok(!LP.evalPipe(b, i, pipe('iron', 'L1'), true).ok, 'S,W elbow leaves the T arm butting a blank edge');
  assert.ok(!LP.evalCap(b, i, cap({ N: 'iron', E: 'iron', S: 'iron', W: 'iron' }), false).ok, 'cap would stop all water');
});

test('photo position: still finishable, so no dead-end warning for the straight that set it up', () => {
  const b = photoBoard();
  assert.ok(LP.analyze(b, 12).viable);
});

test('rulebook WRONG: closing a loop with no way to continue is illegal', () => {
  const b = LP.newBoard(0);
  put(b, 12, 3, pipe('iron', 'H'));
  put(b, 11, 3, pipe('iron', 'T1')); // E,S,W
  put(b, 10, 3, pipe('iron', 'L2'), true); // S,E
  put(b, 11, 4, pipe('iron', 'L2')); // N,W
  const r = LP.evalPipe(b, at(b, 10, 4), pipe('iron', 'L1'), false); // N,E
  assert.ok(!r.ok);
  assert.match(r.reason, /block/);
});

test('rulebook RIGHT: two Ts with a U below, open end remains, is legal', () => {
  const b = LP.newBoard(0);
  put(b, 12, 3, pipe('iron', 'H'));
  put(b, 11, 3, pipe('iron', 'T1'));
  put(b, 10, 3, pipe('iron', 'T1'));
  put(b, 11, 4, pipe('iron', 'L2')); // N,W
  const r = LP.evalPipe(b, at(b, 10, 4), pipe('iron', 'L1'), false); // N,E
  assert.ok(r.ok, r.reason);
  const b2 = LP.boardAfter(b, { type: 'pipe', i: at(b, 10, 4) }, pipe('iron', 'L1'), 0);
  const ends = LP.openEnds(b2);
  assert.strictEqual(ends.length, 1);
  assert.strictEqual(ends[0].d, 'W');
  // Every card in the loop counts toward the line.
  assert.strictEqual(LP.longestPath(b2, at(b, 10, 3)), 5);
});

test('pipes must line up: open edge against a blank edge is wrong', () => {
  const b = LP.newBoard(0);
  assert.ok(!LP.evalPipe(b, at(b, 12, 3), pipe('iron', 'V'), false).ok, 'straight up/down next to valve');
  assert.ok(LP.evalPipe(b, at(b, 12, 3), pipe('iron', 'L2'), true).ok, 'elbow S,E next to valve');
});

test("can't build off the edge of the table", () => {
  const b = LP.newBoard(0, 6, 3); // valve (5,1)
  put(b, 4, 1, pipe('iron', 'H'));
  const r = LP.evalPipe(b, at(b, 3, 1), pipe('iron', 'L1'), false); // N,E -> N goes to row 0, fine
  assert.ok(r.ok);
  put(b, 3, 1, pipe('iron', 'L1'));
  const r2 = LP.evalPipe(b, at(b, 3, 0), pipe('iron', 'V'), false); // N points off the top
  assert.ok(!r2.ok);
  assert.match(r2.reason, /edge/);
});

test('spout: needs required length, one open end heading left, no leaks', () => {
  const b = LP.newBoard(0, 6, 3); // valve (5,1)
  for (let x = 4; x >= 1; x--) put(b, x, 1, pipe('iron', 'H'));
  assert.strictEqual(LP.spoutCell(b, 4), at(b, 0, 1));
  assert.strictEqual(LP.spoutCell(b, 5), -1);
  const leaky = LP.newBoard(0, 6, 3);
  for (let x = 4; x >= 2; x--) put(leaky, x, 1, pipe('iron', 'H'));
  put(leaky, 1, 1, pipe('leaky', 'H'));
  assert.strictEqual(LP.spoutCell(leaky, 4), -1);
});

test('spout: line ending upward cannot take the spout (must pour left and down)', () => {
  const b = LP.newBoard(0, 6, 3);
  for (let x = 4; x >= 2; x--) put(b, x, 1, pipe('iron', 'H'));
  put(b, 1, 1, pipe('iron', 'L1')); // N,E: heads up
  assert.strictEqual(LP.spoutCell(b, 3), -1);
});

test('an open T blocks the win until one end is capped; caps do not count', () => {
  const b = LP.newBoard(0, 8, 3); // valve (7,1)
  for (let x = 6; x >= 4; x--) put(b, x, 1, pipe('iron', 'H'));
  put(b, 3, 1, pipe('iron', 'T1')); // E,S,W
  put(b, 2, 1, pipe('iron', 'H'));
  assert.strictEqual(LP.spoutCell(b, 5), -1, 'T still open to the south');
  const c = cap({ N: 'iron', E: 'iron', S: 'copper', W: 'iron' });
  const r = LP.evalCap(b, at(b, 3, 2), c, false);
  assert.ok(r.ok, r.reason);
  const b2 = LP.boardAfter(b, { type: 'cap', i: at(b, 3, 2) }, c, 0);
  assert.strictEqual(LP.spoutCell(b2, 5), at(b, 1, 1));
  assert.strictEqual(LP.spoutCell(b2, 6), -1, 'cap card not counted');
});

test('a cap may not close the only open end', () => {
  const b = LP.newBoard(0);
  put(b, 12, 3, pipe('iron', 'H'));
  const r = LP.evalCap(b, at(b, 11, 3), cap({ N: 'iron', E: 'iron', S: 'iron', W: 'iron' }), false);
  assert.ok(!r.ok);
});

test('leaks: opponent leaky pipe goes next to or on top of the last card only', () => {
  const g = bareGame(2);
  const b1 = g.players[1].board;
  put(b1, 12, 3, pipe('iron', 'H'));
  put(b1, 11, 3, pipe('iron', 'L2'), true); // S,E -> heads down, last card
  const lk = pipe('leaky', 'V');
  const lkH = pipe('leaky', 'H');
  const lkE = pipe('leaky', 'L2');
  g.players[0].hand = [lk, lkH, lkE];
  // adjacent below the last card
  assert.ok(LP.checkMove(g, 0, { type: 'pipe', cardId: lk.id, target: 1, i: at(b1, 11, 4), flip: false }).ok);
  // on top of the last card: same shape only
  assert.ok(LP.checkMove(g, 0, { type: 'cover', cardId: lkE.id, target: 1, i: at(b1, 11, 3), flip: true }).ok);
  assert.ok(!LP.checkMove(g, 0, { type: 'cover', cardId: lkE.id, target: 1, i: at(b1, 11, 3), flip: false }).ok, 'wrong orientation');
  assert.ok(!LP.checkMove(g, 0, { type: 'cover', cardId: lkH.id, target: 1, i: at(b1, 12, 3), flip: false }).ok, 'not the last card');
});

test('leaks: copper cannot be made to leak, repaired pipes cannot leak again', () => {
  const g = bareGame(2);
  const b1 = g.players[1].board;
  put(b1, 12, 3, pipe('copper', 'H'));
  const lk = pipe('leaky', 'H');
  g.players[0].hand = [lk];
  assert.ok(!LP.checkMove(g, 0, { type: 'cover', cardId: lk.id, target: 1, i: at(b1, 12, 3), flip: false }).ok);
  assert.ok(LP.checkMove(g, 0, { type: 'pipe', cardId: lk.id, target: 1, i: at(b1, 11, 3), flip: false }).ok, 'next to copper is fine');
  const g2 = bareGame(2);
  const b2 = g2.players[1].board;
  put(b2, 12, 3, pipe('iron', 'H'), false, { repaired: true });
  const lk2 = pipe('leaky', 'H');
  g2.players[0].hand = [lk2];
  assert.ok(!LP.checkMove(g2, 0, { type: 'cover', cardId: lk2.id, target: 1, i: at(b2, 12, 3), flip: false }).ok);
});

test('leaks: only one at a time; owner must repair before building', () => {
  const g = bareGame(2);
  const b0 = g.players[0].board;
  put(b0, 12, 3, pipe('leaky', 'H'));
  const good = pipe('iron', 'H');
  const fix = pipe('copper', 'H');
  g.players[0].hand = [good, fix];
  assert.ok(!LP.checkMove(g, 0, { type: 'pipe', cardId: good.id, target: 0, i: at(b0, 11, 3), flip: false }).ok);
  assert.ok(LP.checkMove(g, 0, { type: 'cover', cardId: fix.id, target: 0, i: at(b0, 12, 3), flip: false }).ok);
  // A second leak from an opponent is not allowed.
  g.turn = 1;
  g.players[1].hand = [pipe('leaky', 'H')];
  const m = { type: 'pipe', cardId: g.players[1].hand[0].id, target: 0, i: at(b0, 11, 3), flip: false };
  assert.ok(!LP.checkMove(g, 1, m).ok);
});

test('wrench repairs, then a discard is required, and the turn passes', () => {
  const g = bareGame(2);
  const b0 = g.players[0].board;
  put(b0, 12, 3, pipe('leaky', 'H'));
  g.players[0].hand = [pipe('iron', 'V'), pipe('iron', 'V'), pipe('iron', 'V'), pipe('iron', 'V'), pipe('iron', 'V'), pipe('iron', 'V')];
  const r = LP.applyMove(g, 0, { type: 'wrench', i: at(b0, 12, 3), target: 0 });
  assert.ok(r.ok && r.needDiscard);
  assert.strictEqual(LP.leakAt(g.players[0].board), -1);
  assert.strictEqual(g.players[0].wrenches, 1);
  assert.ok(!LP.checkMove(g, 0, { type: 'pipe', cardId: g.players[0].hand[0].id, target: 0, i: at(b0, 11, 3), flip: false }).ok);
  LP.applyMove(g, 0, { type: 'discard', cardId: g.players[0].hand[0].id });
  assert.strictEqual(g.players[0].hand.length, 5);
  assert.strictEqual(g.turn, 1);
});

test('leaky T exception: a good cap on one end of the leaky T is allowed before repair', () => {
  const g = bareGame(2);
  const b0 = g.players[0].board;
  put(b0, 12, 3, pipe('iron', 'H'));
  put(b0, 11, 3, pipe('leaky', 'T1')); // E,S,W leaky T
  const goodCap = cap({ N: 'iron', E: 'iron', S: 'copper', W: 'iron' });
  const pipeCard = pipe('iron', 'H');
  g.players[0].hand = [goodCap, pipeCard];
  assert.ok(LP.checkMove(g, 0, { type: 'cap', cardId: goodCap.id, target: 0, i: at(b0, 11, 4), flip: false }).ok);
  assert.ok(!LP.checkMove(g, 0, { type: 'pipe', cardId: pipeCard.id, target: 0, i: at(b0, 10, 3), flip: false }).ok);
});

test('opponent leaky cap must have its leaky cap in use and sit by the last card', () => {
  const g = bareGame(2);
  const b1 = g.players[1].board;
  put(b1, 12, 3, pipe('iron', 'H'));
  put(b1, 11, 3, pipe('iron', 'T1')); // E,S,W
  const leakyCap = cap({ N: 'leaky', E: 'iron', S: 'copper', W: 'iron' });
  g.players[0].hand = [leakyCap];
  // Below the T: its N cap faces the T's S end. Unflipped N is leaky -> allowed.
  assert.ok(LP.checkMove(g, 0, { type: 'cap', cardId: leakyCap.id, target: 1, i: at(b1, 11, 4), flip: false }).ok);
  // Flipped, the N side is copper -> a good cap on an opponent is not allowed.
  assert.ok(!LP.checkMove(g, 0, { type: 'cap', cardId: leakyCap.id, target: 1, i: at(b1, 11, 4), flip: true }).ok);
});

test('dead-end warning fires for a move that boxes the pipeline into a corner', () => {
  const g = LP.newGame({ players: [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'human' }], seed: 3, w: 6, h: 3 });
  g.required = 6;
  const b = g.players[0].board; // valve (5,1)
  put(b, 4, 1, pipe('iron', 'H'));
  put(b, 3, 1, pipe('iron', 'L1')); // E,N -> heads up into (3,0)
  const bad = pipe('iron', 'L2'); // flipped = S,E: turns back toward the corner
  const fine = pipe('iron', 'L1'); // flipped = S,W: heads left
  g.players[0].hand = [bad, fine];
  g.turn = 0;
  g.phase = 'play';
  assert.ok(LP.analyze(b, 6).viable);
  const mBad = { type: 'pipe', cardId: bad.id, target: 0, i: at(b, 3, 0), flip: true };
  const mFine = { type: 'pipe', cardId: fine.id, target: 0, i: at(b, 3, 0), flip: true };
  assert.ok(LP.checkMove(g, 0, mBad).ok);
  assert.ok(LP.deadEndWarning(g, 0, mBad));
  assert.strictEqual(LP.deadEndWarning(g, 0, mFine), null);
});

test("house rule: an opponent's leak can't strand a pipeline", () => {
  const g = LP.newGame({ players: [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'human' }], seed: 3, w: 6, h: 3 });
  g.required = 6;
  const b1 = g.players[1].board;
  put(b1, 4, 1, pipe('iron', 'H'));
  put(b1, 3, 1, pipe('iron', 'L1')); // heads up into (3,0)
  const toCorner = pipe('leaky', 'L2'); // flipped S,E
  const toLeft = pipe('leaky', 'L1'); // flipped S,W
  g.players[0].hand = [toCorner, toLeft];
  g.turn = 0;
  g.phase = 'play';
  const r = LP.checkMove(g, 0, { type: 'pipe', cardId: toCorner.id, target: 1, i: at(b1, 3, 0), flip: true });
  assert.ok(!r.ok);
  assert.match(r.reason, /House rule/);
  assert.ok(LP.checkMove(g, 0, { type: 'pipe', cardId: toLeft.id, target: 1, i: at(b1, 3, 0), flip: true }).ok);
});

test('photo setup move (straight up beside the T) does not warn', () => {
  const g = bareGame(2);
  const b = g.players[0].board;
  put(b, 12, 3, pipe('iron', 'L1'), false);
  put(b, 12, 2, pipe('iron', 'L1'), true);
  put(b, 11, 2, pipe('iron', 'T1'), false);
  put(b, 11, 3, pipe('iron', 'V'), false);
  put(b, 11, 4, pipe('copper', 'L2'), false);
  put(b, 10, 4, pipe('copper', 'L1'), false);
  const v = pipe('iron', 'V');
  g.players[0].hand = [v];
  const m = { type: 'pipe', cardId: v.id, target: 0, i: at(b, 10, 3), flip: false };
  assert.ok(LP.checkMove(g, 0, m).ok);
  assert.strictEqual(LP.deadEndWarning(g, 0, m), null);
});

test('deck has 102 playable cards (110 minus 4 valves and 4 spouts)', () => {
  assert.strictEqual(LP.buildDeck().length, 102);
});

test('win flow: completing the line places the spout and ends the game', () => {
  const g = LP.newGame({ players: [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'human' }], seed: 1, w: 6, h: 3 });
  g.required = 4;
  const b = g.players[0].board;
  for (let x = 4; x >= 2; x--) put(b, x, 1, pipe('iron', 'H'));
  const last = pipe('copper', 'H');
  g.players[0].hand.push(last);
  g.turn = 0;
  g.phase = 'play';
  const r = LP.applyMove(g, 0, { type: 'pipe', cardId: last.id, target: 0, i: at(b, 1, 1), flip: false });
  assert.ok(r.won);
  assert.strictEqual(g.winner, 0);
  assert.strictEqual(g.players[0].board.spout, at(b, 0, 1));
});

test('endless table: valve in the middle, and you can build right of it after a turn', () => {
  const g = LP.newGame({ players: [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'human' }], seed: 5, table: 'endless' });
  const b = g.players[0].board;
  const c = Math.floor(LP.ENDLESS / 2);
  assert.strictEqual(g.table, 'endless');
  assert.strictEqual(b.valve, at(b, c, c));
  put(b, c - 1, c, pipe('iron', 'L1')); // E,N: up from the valve
  put(b, c - 1, c - 1, pipe('iron', 'L2'), true); // S,E: turn right
  put(b, c, c - 1, pipe('iron', 'H')); // over the valve
  const r = LP.evalPipe(b, at(b, c + 1, c - 1), pipe('iron', 'H'), false); // past the valve to the right
  assert.ok(r.ok, r.reason);
  assert.ok(LP.analyze(b, 12).viable);
});

test('endless spout points away from the valve: right of it heading right works, heading left does not', () => {
  const g = LP.newGame({ players: [{ name: 'A', kind: 'human' }, { name: 'B', kind: 'human' }], seed: 6, table: 'endless' });
  const b = g.players[0].board;
  const c = Math.floor(LP.ENDLESS / 2);
  put(b, c - 1, c, pipe('iron', 'L1')); // E,N
  put(b, c - 1, c - 1, pipe('iron', 'L2'), true); // S,E
  for (let x = c; x <= c + 3; x++) put(b, x, c - 1, pipe('iron', 'H')); // run right, past the valve
  assert.strictEqual(LP.spoutCell(b, 6), at(b, c + 4, c - 1), 'heading right, right of the valve');
  const b2 = LP.newBoard(0, LP.ENDLESS, LP.ENDLESS, c);
  b2.spoutRule = 'away';
  put(b2, c - 1, c, pipe('iron', 'L1')); // E,N
  put(b2, c - 1, c - 1, pipe('iron', 'L2'), true); // S,E
  put(b2, c, c - 1, pipe('iron', 'H'));
  put(b2, c + 1, c - 1, pipe('iron', 'L2')); // W,N: up
  put(b2, c + 1, c - 2, pipe('iron', 'L1'), true); // S,W: back left, still right of the valve column? no: ends at x=c
  assert.strictEqual(LP.spoutCell(b2, 5), at(b2, c, c - 2), 'spout cell is in the valve column, left is allowed');
  const classic = LP.newBoard(0, 6, 3);
  put(classic, 4, 1, pipe('iron', 'H'));
  put(classic, 3, 1, pipe('iron', 'L1')); // E,N heads up
  assert.strictEqual(LP.spoutCell(classic, 2), -1, 'classic still needs a left-pointing line');
});

console.log(`\n${passed} passed`);
