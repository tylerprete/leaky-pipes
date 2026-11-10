const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const [name, vp, table] of [['phone', { width: 390, height: 844 }, 'classic'], ['ipad', { width: 1180, height: 820 }, 'shared']]) {
    const page = await b.newPage({ viewport: vp }); page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file:///home/claude/leaky/docs/index.html');
    await page.click(`[data-table="${table}"]`); await page.click('[data-act="start"]'); await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const u = window.__leaky, g = u.game, LP = window.LP, bot = LP.bot.makeBot(); u.gen++;
      let guard = 0;
      // play until the human holds a wrench card and has a leak
      while (g.phase !== 'over' && guard++ < 3000) {
        const me = g.players[0];
        if (g.turn === 0 && g.phase === 'play' && LP.leakAt(me.board) >= 0 && me.hand.some((c) => c.kind === 'wrench')) break;
        let m = bot.chooseMove(g, g.turn);
        if (g.turn === 0 && m.type === 'wrench') m = { type: 'discard', cardId: g.players[0].hand.find((c) => c.kind !== 'wrench').id };
        LP.applyMove(g, g.turn, m);
      }
      if (g.phase === 'over') return 'game ended first';
      u.busy = false; u.viewer = 0; u.view = 0; u.vb = null; u.sel = g.players[0].hand.find((c) => c.kind === 'wrench').id; window.__leakyRender();
      return { hand: g.players[0].hand.length, leak: LP.leakAt(g.players[0].board) };
    });
    await page.waitForTimeout(500); await page.screenshot({ path: `/home/claude/leaky/shots/wr-${name}.png` });
    if (typeof r === 'object') {
      await page.click(`#board [data-i="${r.leak}"]`); await page.waitForTimeout(200);
      const a = await page.evaluate(() => { const g = window.__leaky.game; return { leak: window.LP.leakAt(g.players[0].board), phase: g.phase, turn: g.turn, hand: g.players[0].hand.length, wr: g.players[0].wrenches }; });
      console.log(name, JSON.stringify(r), '->', JSON.stringify(a));
    } else console.log(name, r);
    await page.close();
  }
  console.log(errs.length ? errs : 'no page errors'); await b.close();
})();
