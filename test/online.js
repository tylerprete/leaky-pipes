// End-to-end online game: two browsers and a computer seat against a local server.
// node test/online.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const PORT = 8799;
const URL = `http://localhost:${PORT}/`;
(async () => {
  const srv = spawn('node', [__dirname + '/../server/server.js'], { env: Object.assign({}, process.env, { PORT, BOT_MS: 60, AWAY_MS: 1500 }), stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch();
  const errs = [];
  const fail = (m) => errs.push(m);
  const mk = async (vp) => { const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage(); page.on('pageerror', (e) => fail('page error: ' + e.message)); return { ctx, page }; };
  try {
    const A = await mk({ width: 1180, height: 820 });
    const B = await mk({ width: 390, height: 844 });
    await A.page.goto(URL);
    await A.page.click('[data-table="shared"]');
    await A.page.click('[data-act="online"]');
    await A.page.fill('#net-name', 'Ann');
    await A.page.click('[data-act="net-create"]');
    await A.page.waitForSelector('[data-act="net-start"]');
    const code = await A.page.evaluate(() => window.__leaky.net.code);
    if (!/^[A-Z]{4}$/.test(code)) fail('bad code ' + code);
    await A.page.click('[data-act="net-addbot"]');
    await B.page.goto(URL + '?room=' + code);
    await B.page.fill('#net-name', 'Bo');
    await B.page.click('[data-act="net-join"]');
    await B.page.waitForFunction(() => window.__leaky.net && window.__leaky.net.room && window.__leaky.net.room.seats.length === 3);
    await A.page.waitForFunction(() => window.__leaky.net.room.seats.length === 3);
    await A.page.screenshot({ path: __dirname + '/../shots/online-lobby.png' });
    await A.page.click('[data-act="net-start"]');
    await B.page.waitForFunction(() => window.__leaky.game && window.__leaky.net.gotState);
    const peek = await B.page.evaluate(() => { const g = window.__leaky.game; return { mine: g.players[2].hand.every((c) => c.kind !== 'hidden'), theirs: g.players[0].hand.every((c) => c.kind === 'hidden') && g.players[1].hand.every((c) => c.kind === 'hidden'), deck: g.deck.every((c) => c === 0), table: g.table, seat: window.__leaky.viewer }; });
    if (!(peek.mine && peek.theirs && peek.deck && peek.table === 'shared' && peek.seat === 2)) fail('view wrong ' + JSON.stringify(peek));
    // out-of-turn and illegal moves are refused by the server
    const myTurn = (p) => p.evaluate(() => { const u = window.__leaky, g = u.game; return g.phase !== 'over' && g.turn === u.viewer && !u.busy; });
    const step = async (P) => {
      if (!(await myTurn(P.page))) return false;
      await P.page.evaluate(() => { const u = window.__leaky, g = u.game; const bot = (window.__tb = window.__tb || window.LP.bot.makeBot()); window.__leakyPlay(bot.chooseMove(g, g.turn)); });
      return true;
    };
    let shot = false, dropped = false, moves = 0;
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 150000) { fail('game did not finish in time'); break; }
      const over = await A.page.evaluate(() => window.__leaky.game.phase === 'over');
      if (over) break;
      const a = await step(A);
      const b = B.page ? await step(B) : false;
      if (a || b) moves++;
      if (moves === 14 && !shot) { shot = true; await B.page.screenshot({ path: __dirname + '/../shots/online-phone.png' }); await A.page.screenshot({ path: __dirname + '/../shots/online-wide.png' }); }
      if (moves === 20 && !dropped) {
        // Bo's phone dies; the server covers the seat, then Bo comes back to the same seat and hand
        dropped = true;
        const before = await B.page.evaluate(() => window.__leaky.game.turns);
        await B.page.close(); B.page = null;
        await A.page.waitForFunction(() => window.__leaky.game.players[2].away === true, null, { timeout: 5000 }).catch(() => fail('away not shown'));
        // drive Ann until the server has played a turn for Bo
        const t1 = Date.now(); let covered = false;
        while (Date.now() - t1 < 15000 && !covered) { await step(A); await new Promise((r) => setTimeout(r, 150)); covered = await A.page.evaluate(() => window.__leaky.game.log.filter((l) => l.p === 2).length) > 0 && await A.page.evaluate((b) => window.__leaky.game.turns > b + 4, before); }
        if (!covered) fail('server did not cover for the absent player');
        B.page = await B.ctx.newPage(); B.page.on('pageerror', (e) => fail('page error: ' + e.message));
        await B.page.goto(URL);
        await B.page.waitForFunction(() => window.__leaky.game && window.__leaky.net && window.__leaky.net.gotState, null, { timeout: 8000 }).catch(() => fail('did not resume'));
        const r = await B.page.evaluate(() => { const u = window.__leaky; return u.game ? { seat: u.viewer, hand: u.game.players[2].hand.every((c) => c.kind !== 'hidden'), modal: u.modal && u.modal.type } : null; });
        if (!r || r.seat !== 2 || !r.hand || r.modal) fail('resume wrong ' + JSON.stringify(r));
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    await A.page.waitForSelector('#overlay.show-over', { timeout: 8000 }).catch(() => fail('no game-over sheet'));
    const w = await Promise.all([A.page, B.page].map((p) => p.evaluate(() => window.__leaky.game.winner)));
    if (w[0] !== w[1] || w[0] < 0) fail('winners disagree ' + w);
    // host starts the next game
    if (await A.page.$('[data-act="again"]')) { await A.page.click('[data-act="again"]'); await B.page.waitForFunction(() => window.__leaky.game.phase !== 'over' && window.__leaky.game.turns <= 3, null, { timeout: 5000 }).catch(() => fail('rematch did not start')); } else fail('host has no Play again button');
    console.log(`moves by people: ${moves}, winner seat ${w[0]}`);
  } catch (e) {
    fail('exception: ' + e.message);
  }
  console.log(errs.length ? 'FAILED\n' + errs.join('\n') : 'online game ok');
  await browser.close();
  srv.kill();
  process.exit(errs.length ? 1 : 0);
})();
