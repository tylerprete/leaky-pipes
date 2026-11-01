const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('file:///home/claude/leaky/dist/index.html');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shots/v2-setup.png' });
  await page.click('[data-act="start"]');
  // play until it's my turn with a selectable card that has targets
  for (let k = 0; k < 40; k++) {
    await page.waitForTimeout(250);
    const ok = await page.evaluate(() => { const ui = window.__leaky; const g = ui.game; return g.players[g.turn].kind === 'human' && !ui.busy && g.turns > 6; });
    if (ok) break;
    const mine = await page.evaluate(() => { const ui = window.__leaky; const g = ui.game; return g.players[g.turn].kind === 'human' && !ui.busy; });
    if (mine) {
      const m = await page.evaluate(() => { const g = window.__leaky.game; return window.LP.bot.chooseMove(g, g.turn); });
      if (m.type === 'discard') { await page.click(`[data-card="${m.cardId}"]`); await page.click('[data-act="discard"]'); }
      else if (m.type === 'wrench') { await page.click('[data-act="wrench"]'); await page.click(`#board [data-i="${m.i}"]`); }
      else { await page.click(`[data-card="${m.cardId}"]`); const v = await page.evaluate(() => window.__leaky.view); if (v !== m.target) await page.click(`[data-view="${m.target}"]`); const f = await page.evaluate((id) => !!window.__leaky.flips[id], m.cardId); if (!!m.flip !== f) await page.click('[data-act="turn"]'); await page.click(`#board [data-i="${m.i}"]`); }
    }
  }
  await page.click('[data-act="hint"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shots/v2-hint.png' });
  // finish the game fast through the engine and show the win animation for the viewer
  await page.evaluate(() => {
    const ui = window.__leaky; const g = ui.game; const LP = window.LP; const bot = LP.bot.makeBot();
    let guard = 0; while (g.phase !== 'over' && guard++ < 2000) LP.applyMove(g, g.turn, bot.chooseMove(g, g.turn));
  });
  await page.evaluate(() => { const ui = window.__leaky; ui.gen++; ui.busy = false; ui.modal = null; ui.view = ui.game.winner; });
  await page.click('[data-view="' + (await page.evaluate(() => window.__leaky.game.winner)) + '"]');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: 'shots/v2-water.png' });
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  await browser.close();
})();
