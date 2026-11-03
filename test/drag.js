// Drag a card onto the board with mouse and with touch; make sure no floating card is left behind.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const errs = [];
  for (const touch of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file:///home/claude/leaky/docs/index.html');
    await page.click('[data-act="start"]');
    await page.waitForTimeout(400);
    let placed = 0, attempts = 0;
    while (placed < 3 && attempts++ < 12) {
      await page.waitForFunction(() => { const u = window.__leaky, g = u.game; return g.players[g.turn].kind === 'human' && !u.busy; }, null, { timeout: 15000 });
      const m = await page.evaluate(() => { const g = window.__leaky.game; return window.LP.legalMoves(g, g.turn).find((x) => x.type === 'pipe' && x.target === g.turn && !x.flip); });
      if (!m) { const id = await page.evaluate(() => window.__leaky.game.players[0].hand[0].id); await page.click(`[data-card="${id}"]`); await page.click('[data-act="discard"]'); continue; }
      const card = await page.$(`[data-card="${m.cardId}"]`);
      const cb = await card.boundingBox();
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.mouse.down();
      await page.mouse.move(cb.x + cb.width / 2, cb.y - 40, { steps: 4 });
      const ghostsMid = await page.$$eval('.dragghost', (e) => e.length);
      const cell = await page.$(`#board [data-i="${m.i}"]`);
      const tb = await cell.boundingBox();
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const ghostsAfter = await page.$$eval('.dragghost', (e) => e.length);
      const ok = await page.evaluate((i) => { const b = window.__leaky.game.players[0].board; return !!b.cells[i]; }, m.i);
      if (ok) placed++;
      if (ghostsMid !== 1 || ghostsAfter !== 0) errs.push(`ghosts mid=${ghostsMid} after=${ghostsAfter}`);
    }
    console.log(touch ? 'touch ctx' : 'mouse', 'placed by drag', placed);
    await ctx.close();
  }
  console.log(errs.length ? errs.join('\n') : 'no errors, no stray ghosts');
  await browser.close();
})();
