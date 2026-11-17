// Offline support: after one visit, the game must open and play with no connection.
// Checked three ways: a plain static site in a sub-folder (like GitHub Pages), the Node game
// server, and (with CF=1) the Cloudflare Worker under `wrangler dev`.
// node test/offline.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const DOCS = path.join(__dirname, '..', 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
let failed = 0;
const check = (ok, what) => { console.log((ok ? '  ok  ' : 'FAIL  ') + what); if (!ok) failed++; };

// docs/ served under /leaky-pipes/, the way GitHub Pages serves a project site
function pagesLike(port) {
  const hits = { page: 0 };
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (!u.startsWith('/leaky-pipes/')) { res.writeHead(404); return res.end(); }
    const f = u.slice('/leaky-pipes/'.length) || 'index.html';
    if (f === 'index.html') hits.page++;
    try {
      const body = fs.readFileSync(path.join(DOCS, f));
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=600' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => srv.listen(port, () => r({ srv, hits })));
}

async function run(browser, name, url, hits) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  // first visit: the worker installs and saves the page
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).some((k) => /^leaky-[0-9a-f]+$/.test(k)), null, { timeout: 8000 });
  const saved = await page.evaluate(async () => { const k = (await caches.keys()).find((x) => /^leaky-[0-9a-f]/.test(x)); return (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname.split('/').pop() || '(page)').sort(); });
  check(saved.length === 6 && saved.includes('(page)'), name + ': page and icons saved on the first visit (' + saved.join(', ') + ')');

  // online again: the page still comes from the network, so a new version shows up at once
  if (hits) {
    const before = hits.page;
    await page.reload();
    await page.waitForFunction(() => window.__leaky);
    check(hits.page > before, name + ': online, the page is fetched fresh (not just the saved copy)');
  }

  // no connection
  await ctx.setOffline(true);
  const t0 = Date.now();
  await page.reload();
  await page.waitForFunction(() => window.__leaky, null, { timeout: 8000 });
  check(true, name + ': opens with no connection (' + (Date.now() - t0) + ' ms)');
  const withQuery = await ctx.newPage();
  await withQuery.goto(url + '?room=ABCD');
  check(await withQuery.evaluate(() => !!window.__leaky), name + ': an invite link also opens offline');
  await withQuery.close();
  check(await page.evaluate(async () => (await fetch('manifest.webmanifest')).ok && (await fetch('icon-192.png')).ok), name + ': icons and manifest load offline');

  // a whole game against the computer, offline
  await page.click('[data-act="start"]');
  let steps = 0;
  while (steps++ < 3000) {
    const st = await page.evaluate(() => { const ui = window.__leaky, g = ui.game; return { over: g.phase === 'over', kind: g.players[g.turn].kind, busy: ui.busy, modal: ui.modal && ui.modal.type }; });
    if (st.over) break;
    if (st.modal === 'warn') { await page.click('[data-act="warn-no"]'); continue; }
    if (st.kind !== 'human' || st.busy || st.modal) { await sleep(30); continue; }
    await page.evaluate(() => { const g = window.__leaky.game; window.__leakyPlay(window.LP.bot.chooseMove(g, g.turn)); });
  }
  check(await page.evaluate(() => window.__leaky.game.phase === 'over'), name + ': a full game plays offline');
  // online play says so, instead of hanging
  await page.reload();
  await page.waitForFunction(() => window.__leaky);
  check(!errors.length, name + ': no page errors ' + errors.join('; '));
  await ctx.setOffline(false);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  const kids = [];
  try {
    const gh = await pagesLike(8795);
    await run(browser, 'static sub-folder', 'http://localhost:8795/leaky-pipes/', gh.hits);
    gh.srv.close();

    const node = spawn('node', [path.join(__dirname, '..', 'server', 'server.js')], { env: Object.assign({}, process.env, { PORT: 8796 }), stdio: 'ignore' });
    kids.push(() => node.kill());
    await sleep(700);
    await run(browser, 'Node server', 'http://localhost:8796/');

    if (process.env.CF) {
      const w = spawn('npx', ['wrangler', 'dev', '--port', 8797], { cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: true });
      kids.push(() => { try { process.kill(-w.pid, 'SIGTERM'); } catch (e) { /* gone */ } });
      for (let k = 0; k < 60; k++) { await sleep(500); try { if ((await fetch('http://localhost:8797/health')).ok) break; } catch (e) { /* not up yet */ } }
      await run(browser, 'Cloudflare Worker', 'http://localhost:8797/');
    }
  } catch (e) {
    console.log('FAIL  ' + e.message);
    failed++;
  }
  kids.forEach((k) => k());
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall good');
  process.exit(failed ? 1 : 0);
})();
