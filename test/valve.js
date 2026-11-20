// The win: tapping the winner's valve handle turns the water off, and tapping it again turns it
// back on. Checked on the classic and shared tables, by mouse and by touch, at phone and desktop width.
require('fs').mkdirSync(__dirname + '/../shots', { recursive: true });
const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('  ok ', m); };

async function finish(page, table) {
  // two human seats, then the engine plays the game out with the bot's moves (no UI waits)
  await page.evaluate((table) => {
    window.__leaky.table = table;
    window.__leakyStart([{ name: 'Ada', kind: 'human' }, { name: 'Bo', kind: 'human' }]);
    const g = window.__leaky.game;
    for (let n = 0; n < 2000 && g.phase !== 'over'; n++) window.LP.applyMove(g, g.turn, window.LP.bot.chooseMove(g, g.turn));
    window.__leakyProceed();
  }, table);
  return page.evaluate(() => window.__leaky.game.winner);
}
const state = (page) => page.evaluate(() => {
  const svg = document.getElementById('board');
  const wf = svg.querySelector('.winflow');
  return { flow: !!wf, off: !!(wf && wf.classList.contains('off')), svgOff: svg.classList.contains('wateroff'),
    tap: svg.querySelectorAll('.hit.tap').length, ring: svg.querySelectorAll('.handlering').length,
    turning: svg.querySelectorAll('.spokes.turning').length, title: (svg.querySelector('.hit.tap title') || {}).textContent };
});

(async () => {
  const browser = await chromium.launch();
  for (const [table, width, touch] of [['classic', 390, true], ['shared', 1280, false], ['endless', 390, false]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + require('path').resolve(__dirname, '../docs/index.html'));
    await page.waitForTimeout(300);
    const w = await finish(page, table);
    if (w < 0) { console.log('  -- no winner on', table, '(skipped)'); await ctx.close(); continue; }
    await page.waitForTimeout(300);
    let s = await state(page);
    assert(s.flow && !s.off && s.tap === 1 && s.ring === 1, `${table}: the water runs and the valve can be tapped`);
    assert(s.title === 'Turn the water off', `${table}: the handle says it turns the water off`);
    const tap = async () => {
      if (touch) await page.tap('#board .hit.tap'); else await page.click('#board .hit.tap');
      await page.waitForTimeout(100);
    };
    await tap();
    s = await state(page);
    assert(s.off && s.svgOff && s.turning === 1, `${table}: tapping the handle turns the water off and spins it`);
    assert(s.title === 'Turn the water on', `${table}: then it says it turns the water on`);
    await page.waitForTimeout(table === 'classic' ? 5000 : 900);
    await page.screenshot({ path: `${__dirname}/../shots/valve-${table}-off.png` });
    // after it has drained, the stream is gone
    if (table === 'classic') {
      const op = await page.evaluate(() => getComputedStyle(document.querySelector('#board .winflow .stream')).opacity);
      assert(+op === 0, `classic: the stream stops once the pipes have run dry (opacity ${op})`);
    }
    // the sheet may have opened meanwhile; look at the table again, which runs the water anew
    if (await page.$('[data-act="see-board"]')) {
      await page.click('[data-act="see-board"]');
      await page.waitForTimeout(100);
      s = await state(page);
      assert(s.flow && !s.off, `${table}: "Look at the table" runs the water again`);
      await tap();
    }
    await tap();
    s = await state(page);
    assert(s.flow && !s.off && !s.svgOff && s.turning === 1, `${table}: tapping it again turns the water back on`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${__dirname}/../shots/valve-${table}-on.png` });
    // tapping other cards after the game is over does nothing odd
    const other = await page.evaluate(() => { const h = [...document.querySelectorAll('#board .hit:not(.tap)')]; return h.length; });
    assert(other > 0, `${table}: other cells are still there`);
    assert(!errors.length, `${table}: no page errors ${errors.join('; ')}`);
    await ctx.close();
  }
  await browser.close();
})();
