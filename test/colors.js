// Picking player colors: on the local setup sheet and at an online table (two browsers and a
// computer against the Node server), and that the shared table draws each pipeline in its color.
// node test/colors.js        (SHOTS=dir also saves screenshots)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const LP = require('../src/engine.js');
const PORT = 8798;
const URL = `http://localhost:${PORT}/`;
const HEX = Object.fromEntries(LP.COLORS.map((c) => [c.id, c.hex]));
(async () => {
  const srv = spawn('node', [path.join(__dirname, '../server/server.js')], { env: Object.assign({}, process.env, { PORT, BOT_MS: 60, AWAY_MS: 1500 }), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch();
  const errs = [];
  const fail = (m) => errs.push(m);
  const check = (ok, m) => ok || fail(m);
  const shot = async (page, name) => process.env.SHOTS && page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') });
  const mk = async (vp) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail('page error: ' + e.message));
    return page;
  };
  const L = () => window.__leaky;
  try {
    // ---- local: pick for yourself and a computer, start a shared table
    const P = await mk({ width: 390, height: 844 });
    await P.goto(URL);
    await P.click('[data-pick="L0"]');
    await shot(P, 'local-picker');
    await P.click('[data-color="L0:teal"]');
    await P.click('[data-act="add-seat"]');
    await P.click('[data-pick="L1"]');
    check(await P.$eval('[data-color="L1:teal"]', (b) => b.disabled), 'teal should be taken for seat 2');
    await P.click('[data-color="L1:gold"]');
    // seat 3 is added after seat 1 gave up blue, so it gets blue: the first free color
    check(JSON.stringify(await P.evaluate(() => window.__leaky.seats.map((s) => s.color))) === '["teal","gold","blue"]', 'local seat colors');
    check(JSON.parse(await P.evaluate(() => localStorage.getItem('leaky-pipes-prefs'))).color === 'teal', 'your color is remembered');
    await P.click('[data-table="shared"]');
    await P.click('[data-act="start"]');
    const lc = await P.evaluate(() => window.__leaky.game.players.map((p) => p.color));
    check(JSON.stringify(lc) === '["teal","gold","blue"]', 'local game colors ' + lc);
    await P.click('[data-act="fit"]'); // whole table, so every pipeline is drawn
    const board = await P.$eval('#board', (b) => b.innerHTML);
    for (const id of lc) check(board.includes(HEX[id]), 'shared table should be tinted ' + id);
    await shot(P, 'local-shared');
    // a new page load remembers the favorite for seat 1
    const P2 = await mk({ width: 390, height: 844 });
    await P2.goto(URL);
    await P2.evaluate(() => localStorage.setItem('leaky-pipes-prefs', JSON.stringify({ color: 'red' })));
    await P2.reload();
    check((await P2.evaluate(() => window.__leaky.seats[0].color)) === 'red', 'favorite color on a fresh setup');

    // ---- online
    const A = await mk({ width: 1180, height: 820 });
    const B = await mk({ width: 390, height: 844 });
    await A.goto(URL);
    await A.evaluate(() => localStorage.setItem('leaky-pipes-prefs', JSON.stringify({ color: 'purple' })));
    await A.reload();
    await A.click('[data-table="shared"]');
    await A.click('[data-act="online"]');
    await A.fill('#net-name', 'Ann');
    await A.click('[data-act="net-create"]');
    await A.waitForSelector('[data-act="net-start"]');
    const code = await A.evaluate(() => window.__leaky.net.code);
    check((await A.evaluate(() => window.__leaky.net.room.seats[0].color)) === 'purple', 'the creator gets their favorite');
    await A.click('[data-act="net-addbot"]');
    await B.goto(URL + '?room=' + code);
    await B.fill('#net-name', 'Bo');
    await B.click('[data-act="net-join"]');
    await B.waitForFunction(() => window.__leaky.net && window.__leaky.net.room && window.__leaky.net.room.seats.length === 3);
    // seats: Ann, the computer (blue), Bo (orange). Bo can open only their own picker.
    check(JSON.stringify(await B.evaluate(() => window.__leaky.net.room.seats.map((s) => s.color))) === '["purple","blue","orange"]', 'online defaults');
    check(!(await B.$('[data-pick="N0"]')) && !(await B.$('[data-pick="N1"]')) && !!(await B.$('[data-pick="N2"]')), 'Bo picks only for Bo');
    await B.click('[data-pick="N2"]');
    check(await B.$eval('[data-color="N2:purple"]', (b) => b.disabled), "Ann's purple is shown as taken");
    await shot(B, 'online-picker');
    await B.click('[data-color="N2:red"]');
    await A.waitForFunction(() => window.__leaky.net.room.seats[2].color === 'red');
    // the host recolors the computer
    await A.click('[data-pick="N1"]');
    await A.click('[data-color="N1:gold"]');
    await B.waitForFunction(() => window.__leaky.net.room.seats[1].color === 'gold');
    // a stale pick (two people grabbing the same color): the server refuses it
    await B.evaluate(() => window.__leaky.net.ws.send(JSON.stringify({ t: 'color', color: 'gold' })));
    await B.waitForTimeout(300);
    check((await B.evaluate(() => window.__leaky.net.room.seats[2].color)) === 'red', 'a taken color is refused');
    await shot(A, 'online-lobby');
    await A.click('[data-act="net-start"]');
    await A.waitForFunction(() => window.__leaky.game && window.__leaky.game.players.length === 3);
    await B.waitForFunction(() => window.__leaky.game && window.__leaky.game.players.length === 3);
    const gc = await B.evaluate(() => window.__leaky.game.players.map((p) => p.color));
    check(JSON.stringify(gc) === '["purple","gold","red"]', 'online game colors ' + gc);
    await B.click('[data-act="fit"]');
    const bb = await B.$eval('#board', (b) => b.innerHTML);
    for (const id of gc) check(bb.includes(HEX[id]), 'online shared table tinted ' + id);
    check(!(await A.$('.dot.pick')), 'no pickers during the game');
    await shot(A, 'online-shared');
  } catch (e) {
    fail(e.stack || String(e));
  }
  await browser.close();
  srv.kill();
  if (errs.length) {
    console.log('FAIL\n' + errs.join('\n'));
    process.exit(1);
  }
  console.log('colors ok');
})();
