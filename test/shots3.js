// Screenshots of the all-boards layout at several sizes and seat counts.
// node test/shots3.js [table]   -> shots/v3-<size>-<n>p.png
const { chromium } = require('playwright');
const table = process.argv[2] || 'classic';
const sizes = {
  phone: { width: 390, height: 844 },
  ipadP: { width: 820, height: 1180 },
  ipadL: { width: 1180, height: 820 },
  desk: { width: 1440, height: 900 },
};
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [name, vp] of Object.entries(sizes)) {
    for (const n of [2, 4]) {
      const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`${name} ${n}p: ${e.message}`));
      await page.goto('file:///home/claude/leaky/docs/index.html');
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForTimeout(300);
      await page.evaluate(
        ({ n, table }) => {
          const ui = window.__leaky;
          ui.table = table;
          const seats = [{ name: 'You', kind: 'human' }];
          const names = ['Rusty', 'Faucet', 'Gasket'];
          for (let i = 1; i < n; i++) seats.push({ name: names[i - 1], kind: 'bot' });
          window.__leakyStart(seats);
        },
        { n, table }
      );
      // fast-forward: play a dozen rounds with bots for everyone, then hand control back
      await page.evaluate(() => {
        const ui = window.__leaky;
        const g = ui.game;
        const LP = window.LP;
        const bot = LP.bot.makeBot();
        ui.gen++;
        let guard = 0;
        while (g.turns < 9 * g.players.length && g.phase !== 'over' && guard++ < 500) LP.applyMove(g, g.turn, bot.chooseMove(g, g.turn));
        while (g.turn !== 0 && g.phase !== 'over') LP.applyMove(g, g.turn, bot.chooseMove(g, g.turn));
        ui.busy = false;
        ui.viewer = 0;
        ui.view = 0;
        ui.vb = null;
        const m = bot.chooseMove(g, 0);
        if (m.cardId) ui.sel = m.cardId;
        window.__leakyRender();
      });
      await page.waitForTimeout(700);
      await page.screenshot({ path: `shots/v3-${table}-${name}-${n}p.png` });
      await page.close();
    }
  }
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  await browser.close();
})();
