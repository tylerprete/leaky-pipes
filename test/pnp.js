const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('file:///home/claude/leaky/dist/index.html');
  await page.click('[data-kind="1:human"]');
  await page.fill('#seat-name-1', 'Giovanna');
  await page.click('[data-act="start"]');
  const c = await page.evaluate(() => window.__leaky.game.players[0].hand[0].id);
  await page.click(`[data-card="${c}"]`); await page.click('[data-act="discard"]');
  const s1 = await page.evaluate(() => ({ modal: window.__leaky.modal && window.__leaky.modal.type, turn: window.__leaky.game.turn, name: window.__leaky.game.players[1].name }));
  const hidden = await page.textContent('#hand');
  await page.click('[data-act="pass-ok"]');
  const s2 = await page.evaluate(() => ({ viewer: window.__leaky.viewer, view: window.__leaky.view, modal: window.__leaky.modal }));
  // menu -> rules -> close returns to game
  await page.click('#menuBtn'); await page.click('[data-act="rules"]'); await page.click('[data-act="rules-close"]');
  const s3 = await page.evaluate(() => window.__leaky.modal);
  // reload: resume offered
  await page.reload(); const resume = await page.$('[data-act="resume"]');
  console.log(JSON.stringify({ s1, hidden: hidden.trim().slice(0, 40), s2, s3, resume: !!resume, errs }));
  await b.close();
})();
