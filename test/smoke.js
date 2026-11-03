const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto('file:///home/claude/leaky/docs/index.html');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/home/claude/leaky/shots/setup.png' });
  if (process.env.TABLE === 'endless') await page.click('[data-table="endless"]');
  await page.click('[data-act="start"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/home/claude/leaky/shots/turn1.png' }); console.log('viewBox at start', await page.getAttribute('#board', 'viewBox'));

  // Drive the human seat through the real UI using the bot's choice.
  let shots = 0, steps = 0;
  while (steps++ < 400) {
    const st = await page.evaluate(() => {
      const ui = window.__leaky, g = ui.game;
      return { over: g.phase === 'over', turn: g.turn, kind: g.players[g.turn].kind, busy: ui.busy, modal: ui.modal && ui.modal.type, phase: g.phase };
    });
    if (st.over || st.modal === 'over') break;
    if (st.modal === 'warn') { await page.click('[data-act="warn-no"]'); continue; }
    if (st.kind !== 'human' || st.busy) { await page.waitForTimeout(200); continue; }
    const m = await page.evaluate(() => {
      const g = window.__leaky.game; return window.LP.bot.chooseMove(g, g.turn);
    });
    if (m.type === 'discard') {
      await page.click(`[data-card="${m.cardId}"]`);
      await page.click('[data-act="discard"]');
    } else if (m.type === 'wrench') {
      await page.click('[data-act="wrench"]');
      await page.click(`#board [data-i="${m.i}"]`);
    } else {
      await page.click(`[data-card="${m.cardId}"]`);
      const view = await page.evaluate(() => window.__leaky.view);
      if (view !== m.target) await page.click(`[data-view="${m.target}"]`);
      const flip = await page.evaluate((id) => !!window.__leaky.flips[id], m.cardId);
      if (!!m.flip !== flip) await page.click('[data-act="turn"]');
      if (shots < 2 && m.target !== 0) { await page.screenshot({ path: `/home/claude/leaky/shots/attack${shots}.png` }); shots++; }
      await page.click(`#board [data-i="${m.i}"]`);
    }
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/home/claude/leaky/shots/end.png' });
  const res = await page.evaluate(() => { const g = window.__leaky.game; return { winner: g.winner, turns: g.turns, log: g.log.slice(-3).map(l => l.text) }; });
  console.log(JSON.stringify(res), 'steps', steps);
  // close the result and look at the board
  await page.click('[data-act="see-board"]').catch(() => {});
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/home/claude/leaky/shots/final-board.png' });
  // desktop look
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/home/claude/leaky/shots/desktop.png' });
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  await browser.close();
})();
