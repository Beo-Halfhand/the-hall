// Two small fixes (11-10), both games, in a real browser:
//  1. A seat that left doesn't read as busted: it shows "left · 1,000" (what went back to the purse), not 0 chips, through the round it
//     left in, and then drops off the seat list (an open seat).
//  2. Cup & Claim: the bidding step says what a bid counts, with the real number of dice ("Bids count every die at the table, all 20,
//     not just yours."), and so do the side panel and the rules.
//   LEFT_SEAT_PORT=8917 node --test test/left-seat-browser.test.js
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = Number(process.env.LEFT_SEAT_PORT ?? 8917);
const BASE = `http://127.0.0.1:${PORT}`;
const GAMES = [
  { game: 'sealed-hand', api: '/tables', page: '/table', plate: '#plates [data-plate]' },
  { game: 'cup-and-claim', api: '/dice-tables', page: '/dice', plate: '#cups [data-cup]' },
];
let browser;
before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, { timeout: 90000 });
after(async () => { await browser?.close(); await stopServers(); });

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} ${res.status} ${data.error ?? ''}`), { status: res.status });
  return data;
}
async function pageAs(player, id, seatToken, G, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('hall.dealShow', 'off'); localStorage.setItem('hall.guide.seen', '1'); } catch { /* off */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate(([p, i, t]) => { localStorage.setItem('hall.player', p); localStorage.setItem(`hall.seat.${i}`, t); }, [player.token, id, seatToken]);
  await page.goto(`${BASE}${G.page}?id=${id}`);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
  return { ctx, page, errors };
}
/** The plates, as text: [name, chips text] for each. */
const plates = (page, G) => page.$$eval(G.plate, (els) => els.map((el) => ({ name: el.querySelector('.name')?.textContent?.trim() ?? '', chips: el.querySelector('.chips')?.textContent?.replace(/\s+/g, ' ').trim() ?? '', open: el.classList.contains('open') })));

for (const G of GAMES) {
  test(`${G.game}: a player who left shows "left · 1,000" (not 0 chips) through that round, then drops off the seat list`, { timeout: 60000 }, async () => {
    const A = await call('POST', '/players', { name: 'Rook' });
    const B = await call('POST', '/players', { name: 'Wren' });
    const t = await call('POST', G.api, { lobbySeconds: 120, test: { turnMs: 60000 } });
    const sa = await call('POST', `${G.api}/${t.id}/join`, { kind: 'human' }, A.token);
    const sb = await call('POST', `${G.api}/${t.id}/join`, { kind: 'human' }, B.token);
    const { ctx, page, errors } = await pageAs(A, t.id, sa.token, G);
    await page.waitForFunction(([sel]) => [...document.querySelectorAll(sel)].some((el) => /Wren/.test(el.textContent)), [G.plate]);
    const left = await call('POST', `${G.api}/${t.id}/leave`, {}, sb.token);
    assert.equal(left.queued, false);
    assert.equal(left.amount, 1000, 'what went back to the purse');
    // the round it left in: "left · 1,000", never "0"
    await page.waitForFunction(([sel]) => [...document.querySelectorAll(sel)].some((el) => /left · 1,000/.test(el.textContent)), [G.plate], { timeout: 15000 });
    const shown = (await plates(page, G)).find((p) => /Wren/.test(p.name));
    assert.ok(shown, 'Wren is on the list through the round she left in');
    assert.equal(shown.chips, 'left · 1,000');
    assert.ok(!/^0$|\b0\b/.test(shown.chips), 'no "0 chips"');
    // the next round is dealt: the seat is gone from the list
    await call('POST', `${G.api}/${t.id}/deal-now`, {}, sa.token);
    await page.waitForFunction(([sel]) => ![...document.querySelectorAll(sel)].some((el) => /Wren/.test(el.textContent)), [G.plate], { timeout: 20000 });
    const after = await plates(page, G);
    assert.ok(!after.some((p) => /Wren/.test(p.name) || /left ·/.test(p.chips)), 'no left seat on the list');
    // the API says it too
    const v = await call('GET', `${G.api}/${t.id}`);
    const wren = v.seats.find((x) => x.name === 'Wren');
    assert.equal(wren.status, 'left');
    assert.equal(wren.gone, true);
    assert.equal(wren.leftWith, 1000);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('cup-and-claim: the bidding step says bids count every die at the table, with the real number; the panel and the rules say it too', { timeout: 60000 }, async () => {
  for (const names of [['Rook'], ['Rook', 'Wren']]) {
    const players = [];
    for (const name of names) players.push(await call('POST', '/players', { name }));
    const t = await call('POST', '/dice-tables', { lobbySeconds: names.length > 1 ? 60 : 0, test: { turnMs: 60000 } });
    const seats = [];
    for (const p of players) seats.push(await call('POST', `/dice-tables/${t.id}/join`, { kind: 'human' }, p.token));
    if (names.length > 1) await call('POST', `/dice-tables/${t.id}/deal-now`, {}, seats[0].token);
    // wait for A's turn to open
    let v;
    for (let i = 0; i < 60; i += 1) {
      v = await call('GET', `/dice-tables/${t.id}`);
      if (v.round > 0 && v.waitingOn.includes(seats[0].seat)) break;
      const other = seats[1] && v.waitingOn.includes(seats[1].seat) ? seats[1] : null;
      if (other) { const me = await call('GET', `/dice-tables/${t.id}/me`, null, other.token); const bid = me.legal.find((x) => x.action === 'bid'); if (bid) await call('POST', `/dice-tables/${t.id}/act`, { action: 'bid', ...(bid.lowest ?? {}) }, other.token).catch(() => {}); }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(v.totalDice > 0, 'the table knows how many dice are out');
    const { ctx, page } = await pageAs(players[0], t.id, seats[0].token, { page: '/dice' });
    const want = `Bids count every die at the table, all ${v.totalDice}, not just yours.`;
    await page.waitForSelector('#bid-scope', { timeout: 15000 });
    assert.equal((await page.textContent('#bid-scope')).trim(), want, `${names.length} human(s) at the table`);
    assert.equal((await page.textContent('#scope-note')).trim(), want, 'and in the side panel');
    assert.match(await page.textContent('#rules'), /Bids count every die at the table, not just yours\./);
    await ctx.close();
  }
});
