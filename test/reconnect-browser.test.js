// Mid-hand reconnect, both games, in a real browser (11-10: "card state needs to survive a dropped connection").
// The table is the server's, so a page that drops and comes back must land where it was, with no prompt, and say so plainly:
// "Connection lost. Your seat and cards/cup are safe. Reconnecting…", then "Back in. Your turn." A second page with the same Player ID
// takes the seat; the older page is told and only watches. A dropped player's turn runs its clock, then the table moves for them.
//   RECONNECT_PORT=8907 node --test test/reconnect-browser.test.js
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';
import { connectionText } from '../public/js/connection.js';

const PORT = Number(process.env.RECONNECT_PORT ?? 8907);
const BASE = `http://127.0.0.1:${PORT}`;
const GAMES = [
  { game: 'sealed-hand', api: '/tables', page: '/table', noun: 'cards' },
  { game: 'cup-and-claim', api: '/dice-tables', page: '/dice', noun: 'cup' },
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
/** A's seat (and B's, for two people) at a fresh chips table; bots fill the rest; the round is dealt. */
async function seated(G, { two = false, turnMs = 60000 } = {}) {
  const A = await call('POST', '/players', { name: 'Rook' });
  const B = two ? await call('POST', '/players', { name: 'Wren' }) : null;
  const t = await call('POST', G.api, { lobbySeconds: two ? 60 : 0, test: { turnMs } });
  const sa = await call('POST', `${G.api}/${t.id}/join`, { kind: 'human' }, A.token);
  const sb = two ? await call('POST', `${G.api}/${t.id}/join`, { kind: 'human' }, B.token) : null;
  if (two) await call('POST', `${G.api}/${t.id}/deal-now`, {}, sa.token);
  return { id: t.id, A, B, sa, sb };
}
const view = (G, s) => call('GET', `${G.api}/${s.id}`);
const mine = (G, s, token = s.sa.token) => call('GET', `${G.api}/${s.id}/me`, null, token);
const myTurnIn = (v, seat) => v.turn === seat || (v.waitingOn ?? []).includes(seat);
async function untilTurnOf(G, s, seat, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await view(G, s);
    if (v.round > 0 && myTurnIn(v, seat)) return v;
    if (Date.now() > end) throw new Error(`never seat ${seat}'s turn (phase ${v.phase})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const handOf = (me) => JSON.stringify(me.hand ? [...me.hand].sort() : me.dice ?? null);
async function pageFor(s, G, { context = null, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = context ?? await browser.newContext({ viewport, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('hall.dealShow', 'off'); localStorage.setItem('hall.guide.seen', '1'); } catch { /* off */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.evaluate(([p, id, t]) => { localStorage.setItem('hall.player', p); if (t) localStorage.setItem(`hall.seat.${id}`, t); }, [s.A.token, s.id, s.sa.token]);
  await page.goto(`${BASE}${G.page}?id=${s.id}`);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
  return { ctx, page, errors };
}
const bannerText = (page) => page.evaluate(() => { const b = document.getElementById('conn-banner'); return b && !b.hidden ? b.textContent.replace(/\s+/g, ' ').trim() : ''; });

test('the banner\'s words, by state', () => {
  assert.equal(connectionText('lost', {}, 'cards').head, 'Connection lost. Your seat and cards are safe. Reconnecting…');
  assert.equal(connectionText('lost', {}, 'cup').head, 'Connection lost. Your seat and cup are safe. Reconnecting…');
  assert.equal(connectionText('lost', { seated: false }, 'cards').head, 'Connection lost. Reconnecting…', 'a watcher has no seat to keep');
  assert.match(connectionText('lost', { myTurn: true, deadlineIn: 41_200 }).more, /^It’s your turn: 42 s left on its clock, then the table moves for you until you’re back\.$/);
  assert.match(connectionText('lost', { myTurn: true, deadlineIn: -5 }).more, /clock ran out/);
  assert.match(connectionText('lost', { myTurn: true, deadlineIn: null }).more, /the table waits for you/);
  assert.equal(connectionText('back', { myTurn: true }).head, 'Back in. Your turn.');
  assert.equal(connectionText('back', { turnName: 'Wren' }).head, 'Back in. Wren’s turn.');
  assert.match(connectionText('back', { away: true }).more, /marked away .* Press I’m back/);
  assert.match(connectionText('moved', {}, 'cup').head, /open in another tab or on another device/);
});

test('a poll that set out before the connection was lost never says "Back in" (11-10: one in flight as the browser went offline did)', { timeout: 30000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  const seen = await page.evaluate(async () => {
    const { mountConnection } = await import('/js/connection.js');
    const conn = mountConnection({ noun: 'cards' });
    const text = () => document.getElementById('conn-banner').textContent.trim();
    const out = [];
    const sentBefore = Date.now() - 1000;
    conn.failed(); conn.failed(); out.push(conn.state);
    conn.ok(sentBefore); out.push(conn.state);          // in flight before the loss: still lost
    conn.ok(Date.now()); out.push(conn.state, text());  // a fresh one: back
    return out;
  });
  assert.deepEqual(seen.slice(0, 3), ['lost', 'lost', 'back']);
  assert.match(seen[3], /^Back in\./);
  await ctx.close();
});

for (const G of GAMES) {
  test(`${G.game}: the network drops mid-hand on my turn: the banner says the seat and ${G.noun} are safe, then "Back in. Your turn.", same seat, ${G.noun} and stack`, { timeout: 60000 }, async () => {
    const s = await seated(G);
    const { ctx, page, errors } = await pageFor(s, G);
    await untilTurnOf(G, s, s.sa.seat);
    const before = await mine(G, s);
    const stackBefore = (await view(G, s)).seats[s.sa.seat].chips;
    await ctx.setOffline(true);
    await page.waitForFunction(() => document.getElementById('conn-banner')?.hidden === false, null, { timeout: 15000 });
    assert.match(await bannerText(page), new RegExp(`^Connection lost\\. Your seat and ${G.noun} are safe\\. Reconnecting… It’s your turn, and the table waits for you\\.$`));
    await page.waitForTimeout(3000);
    await ctx.setOffline(false);
    await page.waitForFunction(() => /^Back in\./.test(document.getElementById('conn-banner')?.textContent?.trim() ?? ''), null, { timeout: 15000 });
    assert.match(await bannerText(page), /^Back in\. Your turn\.$/);
    const after = await mine(G, s);
    assert.equal(after.seat, before.seat);
    assert.equal(handOf(after), handOf(before), `same ${G.noun}`);
    assert.equal((await view(G, s)).seats[s.sa.seat].chips, stackBefore);
    assert.equal((await view(G, s)).seats.filter((x) => x && !x.left && x.name === 'Rook').length, 1, 'one seat');
    await page.waitForFunction(() => document.getElementById('conn-banner')?.hidden === true, null, { timeout: 10000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`${G.game}: two people, mine is the turn and I drop: my banner counts the clock down, the table moves for me when it ends, and the other player is never stuck`, { timeout: 60000 }, async () => {
    const s = await seated(G, { two: true, turnMs: 8000 });
    const { ctx, page } = await pageFor(s, G);
    await untilTurnOf(G, s, s.sa.seat);
    await ctx.setOffline(true);
    await page.waitForFunction(() => /s left on its clock/.test(document.getElementById('conn-banner')?.textContent ?? ''), null, { timeout: 15000 });
    // The clock ends: A is marked away and the table moves for A; B gets a turn without waiting on A.
    const end = Date.now() + 25000;
    let v;
    for (;;) { v = await view(G, s); if (v.seats[s.sa.seat].away) break; assert.ok(Date.now() < end, 'A was never marked away'); await new Promise((r) => setTimeout(r, 300)); }
    await page.waitForFunction(() => /clock ran out/.test(document.getElementById('conn-banner')?.textContent ?? ''), null, { timeout: 10000 });
    await ctx.setOffline(false);
    await page.waitForFunction(() => /^Back in\./.test(document.getElementById('conn-banner')?.textContent?.trim() ?? ''), null, { timeout: 15000 });
    assert.match(await bannerText(page), /marked away .* Press I’m back/);
    assert.ok(await page.isVisible('[data-action="back"]'), 'I’m back is there');
    await ctx.close();
  });

  test(`${G.game}: a hard refresh, and a closed tab reopened, come back to the same seat and ${G.noun} with nothing to approve`, { timeout: 60000 }, async () => {
    const s = await seated(G);
    const { ctx, page, errors } = await pageFor(s, G);
    await untilTurnOf(G, s, s.sa.seat);
    const before = await mine(G, s);
    await page.reload();
    await page.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
    const token = await page.evaluate((id) => localStorage.getItem(`hall.seat.${id}`), s.id);
    assert.equal(token, s.sa.token, 'the same seat token, no new seat');
    assert.equal(handOf(await mine(G, s, token)), handOf(before));
    await page.close();
    const again = await ctx.newPage();
    again.on('pageerror', (e) => errors.push(e.message));
    await again.goto(`${BASE}${G.page}?id=${s.id}`);
    await again.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
    assert.equal(handOf(await mine(G, s)), handOf(before));
    assert.equal(await bannerText(again), '', 'no banner: nothing was lost');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`${G.game}: the same player on a second device takes the seat; the first page says so, only watches, and can take it back`, { timeout: 60000 }, async () => {
    const s = await seated(G);
    const first = await pageFor(s, G);
    await untilTurnOf(G, s, s.sa.seat);
    const before = await mine(G, s);
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, serviceWorkers: 'block' });
    await ctx2.addInitScript(() => { try { localStorage.setItem('hall.dealShow', 'off'); localStorage.setItem('hall.guide.seen', '1'); } catch { /* off */ } });
    const second = await ctx2.newPage();
    await second.goto(`${BASE}/`);
    await second.evaluate((p) => localStorage.setItem('hall.player', p), s.A.token); // the Player ID, restored on the second device
    await second.goto(`${BASE}${G.page}?id=${s.id}`);
    await second.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
    const newToken = await second.evaluate((id) => localStorage.getItem(`hall.seat.${id}`), s.id);
    assert.ok(newToken && newToken !== s.sa.token, 'the second device holds the seat now');
    assert.equal(handOf(await mine(G, s, newToken)), handOf(before), `same ${G.noun} on the second device`);
    await assert.rejects(mine(G, s, s.sa.token), (e) => e.status === 401, 'the old page can no longer act');
    await first.page.waitForFunction(() => /open in another tab or on another device/.test(document.getElementById('conn-banner')?.textContent ?? ''), null, { timeout: 15000 });
    assert.equal((await view(G, s)).seats.filter((x) => x && !x.left && x.name === 'Rook').length, 1, 'one seat, never two');
    await first.ctx.close();
    await ctx2.close();
  });
}
