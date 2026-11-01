const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('file:///home/claude/leaky/docs/index.html');
  await page.click('[data-act="start"]');
  // my move: discard
  await page.waitForTimeout(300);
  const id = await page.evaluate(() => window.__leaky.game.players[0].hand[0].id);
  await page.click(`[data-card="${id}"]`); await page.click('[data-act="discard"]');
  const right = await page.$$eval('#status .log', els => els.map(e => e.textContent));
  await page.waitForTimeout(1500);
  const afterBot = await page.$$eval('#status .log', els => els.map(e => e.textContent));
  await page.waitForTimeout(9000);
  const later = await page.$$eval('#status .log', els => els.map(e => e.textContent + ' op=' + getComputedStyle(e).opacity));
  console.log(JSON.stringify({ right, afterBot, later, errs }));
  await b.close();
})();
