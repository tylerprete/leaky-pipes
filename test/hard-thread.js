// The Hard computer thinks in a background worker, so the page must stay responsive while it does.
// Plays Hard games in a real browser and measures the longest gap between animation frames,
// with the worker and with it switched off (the old behaviour, and the fallback).
// node test/hard-thread.js
const { chromium } = require('playwright');
const FILE = 'file://' + require('path').resolve(__dirname, '../docs/index.html');
(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  const check = (ok, what) => { console.log((ok ? '  ok  ' : 'FAIL  ') + what); if (!ok) failed++; };
  async function game(table, players, useWorker, maxTurns) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(FILE);
    await page.waitForTimeout(200);
    await page.evaluate((off) => { if (off) window.__leakyBrain.off = true; }, !useWorker);
    await page.click(`[data-table="${table}"]`);
    await page.click('[data-level="hard"]');
    for (let k = 2; k < players; k++) await page.click('[data-act="add"]').catch(() => {});
    await page.click('[data-act="start"]');
    await page.evaluate(() => {
      window.__gaps = [];
      let last = performance.now();
      (function tick() { const now = performance.now(); window.__gaps.push(now - last); last = now; requestAnimationFrame(tick); })();
    });
    let turns = 0, steps = 0, botMoves = 0, lastSeq = -1;
    while (steps++ < 4000) {
      const st = await page.evaluate(() => {
        const ui = window.__leaky, g = ui.game;
        return { over: g.phase === 'over', kind: g.players[g.turn].kind, busy: ui.busy, modal: ui.modal && ui.modal.type, seq: g.seq, n: g.players.length };
      });
      if (st.over || turns >= maxTurns) break;
      if (st.seq !== lastSeq) { if (st.kind !== 'human') botMoves++; lastSeq = st.seq; }
      if (st.modal === 'warn') { await page.click('[data-act="warn-no"]'); continue; }
      if (st.kind !== 'human' || st.busy || st.modal) { await page.waitForTimeout(40); continue; }
      // the person's own moves are made instantly, so the gaps measured are the computer's
      await page.evaluate(() => { const g = window.__leaky.game; window.__leakyPlay(window.LP.bot.chooseMove(g, g.turn)); });
      turns++;
    }
    const out = await page.evaluate(() => {
      const g = window.__gaps.slice(5).sort((a, b) => a - b);
      const b = window.__leakyBrain;
      return { max: Math.round(g[g.length - 1]), p99: Math.round(g[Math.floor(g.length * 0.99)]), over100: g.filter((x) => x > 100).length, frames: g.length, worker: !!b.w, off: b.off, ready: b.ready, jobs: b.n, phase: window.__leaky.game.phase, seq: window.__leaky.game.seq, n: window.__leaky.game.players.length };
    });
    out.errors = errors;
    out.turns = turns;
    await page.close();
    return out;
  }
  try {
    for (const [table, players] of [['classic', 2], ['shared', 2], ['endless', 2]]) {
      const off = await game(table, players, false, 12);
      const on = await game(table, players, true, 12);
      console.log(`${table}: longest frame gap ${off.max} ms on the page thread -> ${on.max} ms with the worker (gaps over 100 ms: ${off.over100} -> ${on.over100}; ${on.jobs} moves thought out in the worker)`);
      check(on.worker && on.ready && !on.off, table + ': the worker is running');
      check(on.jobs >= 5, table + ': Hard moves went to the worker (' + on.jobs + ')');
      check(on.over100 === 0, table + ': no frame gap over 100 ms with the worker (max ' + on.max + ')');
      check(off.jobs === 0 && off.seq > 10, table + ': with the worker off, the game still plays (fallback)');
      check(!on.errors.length && !off.errors.length, table + ': no page errors ' + on.errors.concat(off.errors).join('; '));
    }
    // a whole game to the end, worker on
    const full = await game('classic', 2, true, 1000);
    check(full.phase === 'over' && !full.errors.length, 'a full Hard game finishes (' + full.turns + ' of my turns, ' + full.jobs + ' worker moves, longest gap ' + full.max + ' ms)');

    // hint: also off the page thread, and it still lands
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    await page.goto(FILE);
    await page.click('[data-act="start"]');
    await page.waitForFunction(() => { const u = window.__leaky; return u.game && u.game.players[u.game.turn].kind === 'human' && !u.busy; }, null, { timeout: 15000 });
    await page.click('[data-act="hint"]');
    await page.waitForFunction(() => window.__leaky.hint, null, { timeout: 5000 });
    const h = await page.evaluate(() => ({ hint: window.__leaky.hint, seq: window.__leaky.game.seq, jobs: window.__leakyBrain.n }));
    check(h.hint.seq === h.seq && h.jobs === 1, 'hint is worked out in the worker and shown');
    // a worker that dies mid-thought: the move is finished on the page instead
    await page.evaluate(() => { const b = window.__leakyBrain; b.w.terminate(); window.__leaky.hint = null; });
    await page.click('[data-act="hint"]');
    await page.waitForFunction(() => window.__leaky.hint, null, { timeout: 9000 });
    const d = await page.evaluate(() => ({ off: window.__leakyBrain.off, hint: !!window.__leaky.hint }));
    check(d.off && d.hint, 'a dead worker is noticed and the hint still arrives');
    await page.close();
  } catch (e) {
    console.log('FAIL  ' + e.message);
    failed++;
  }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall good');
  process.exit(failed ? 1 : 0);
})();
