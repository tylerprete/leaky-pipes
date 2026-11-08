// Attack by drag: hover the opponent's panel (Classic) or drop straight on the shared table.
// node test/drag2.js [classic|shared]
const { chromium } = require('playwright');
const table = process.argv[2] || 'classic';
(async () => {
  const browser = await chromium.launch();
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file:///home/claude/leaky/docs/index.html');
  await page.click(`[data-table="${table}"]`);
  await page.click('[data-act="start"]');
  let done = false;
  for (let k = 0; k < 40 && !done; k++) {
    await page.waitForFunction(() => { const u = window.__leaky, g = u.game; return g.phase === 'over' || (g.players[g.turn].kind === 'human' && !u.busy); }, null, { timeout: 20000 });
    if (await page.evaluate(() => window.__leaky.game.phase === 'over')) break;
    const m = await page.evaluate(() => { const g = window.__leaky.game; return window.LP.legalMoves(g, g.turn).find((x) => x.type === 'pipe' && x.target !== g.turn); });
    if (!m) {
      const bm = await page.evaluate(() => { const g = window.__leaky.game; return window.LP.bot.chooseMove(g, g.turn); });
      const id = bm.cardId || (await page.evaluate(() => window.__leaky.game.players[0].hand[0].id));
      await page.evaluate(({ bm, id }) => { const u = window.__leaky; const g = u.game; const r = window.LP.applyMove(g, g.turn, bm.type === 'wrench' || bm.type === 'pass' ? bm : bm.type === 'discard' ? bm : { type: 'discard', cardId: id }); if (g.phase === 'wrenchDiscard') window.LP.applyMove(g, g.turn, { type: 'discard', cardId: g.players[g.turn].hand[0].id }); }, { bm, id });
      await page.evaluate(() => { window.__leaky.gen++; window.__leakyProceed(); });
      continue;
    }
    const card = await page.$(`[data-card="${m.cardId}"]`);
    const cb = await card.boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width / 2, cb.y - 60, { steps: 4 });
    if (table === 'classic') {
      // the selected card jumps the main board to the target; flip back to mine, then hover the panel
      await page.evaluate(() => { window.__leaky.view = 0; window.__leakyRender && 0; });
      const wrap = await (await page.$('#boardwrap')).boundingBox();
      await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2, { steps: 3 });
      const panel = await page.$(`.panel.mini[data-view="${m.target}"]`);
      if (!panel) { errs.push('no panel for target'); break; }
      const pb = await panel.boundingBox();
      await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 5 });
      await page.mouse.move(pb.x + pb.width / 2 + 5, pb.y + pb.height / 2 + 3, { steps: 3 });
      const v = await page.evaluate(() => window.__leaky.view);
      if (v !== m.target) errs.push(`hovering the panel did not swap it in (view ${v}, want ${m.target})`);
    }
    const cell = await page.$(`#board [data-i="${m.i}"]`);
    if (!cell) { errs.push('target cell not on screen'); await page.mouse.up(); break; }
    const tb = await cell.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const ok = await page.evaluate(({ t, i }) => !!window.__leaky.game.players[t].board.cells[i], { t: m.target, i: m.i });
    const ghosts = await page.$$eval('.dragghost', (e) => e.length);
    if (ghosts) errs.push('ghost left behind');
    if (!ok) errs.push('attack by drag did not land');
    done = true;
  }
  if (!done) errs.push('never got an attack to try');
  console.log(table, errs.length ? errs.join('\n') : 'attack by drag ok');
  await browser.close();
})();
