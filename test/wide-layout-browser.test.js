// The table page on a wide screen (11-10, the owner's full run): the tiles (claims or the call, who you're trusting, how to play, the talk)
// sat under a dead band beside a short hand. From 1280 they are the middle column's, straight under the hand; under 1280 and on a
// phone, as before. Both games.
//   WIDE_PORT=8937 node --test test/wide-layout-browser.test.js
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = Number(process.env.WIDE_PORT ?? 8937);
const BASE = `http://127.0.0.1:${PORT}`;
let browser;
before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, { timeout: 90000 });
after(async () => { await browser?.close(); await stopServers(); });

const call = async (method, path, body, token) => (await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const SIZES = [[1920, 1080], [1440, 900], [1280, 800], [1100, 800], [390, 844]];

for (const G of [{ game: 'sealed-hand', api: '/tables', page: '/table' }, { game: 'cup-and-claim', api: '/dice-tables', page: '/dice' }]) {
  test(`${G.game}: from 1280 the tiles sit straight under the hand, beside the side columns; under 1280 and on a phone, the full-width strip as before`, { timeout: 90000 }, async () => {
    const A = await call('POST', '/players', { name: 'Rook', avatar: 'knight' });
    const B = await call('POST', '/players', { name: 'Wren', avatar: 'mage' });
    const t = await call('POST', G.api, { lobbySeconds: 60, test: { turnMs: 600000, rng: 5 } });
    const sa = await call('POST', `${G.api}/${t.id}/join`, { kind: 'human' }, A.token);
    await call('POST', `${G.api}/${t.id}/join`, { kind: 'human' }, B.token);
    await call('POST', `${G.api}/${t.id}/deal-now`, {}, sa.token);
    for (const [width, height] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width, height }, ...(width < 980 ? { isMobile: true, hasTouch: true } : {}), serviceWorkers: 'block' });
      await ctx.addInitScript(([p, i, s]) => { localStorage.setItem('hall.player', p); localStorage.setItem(`hall.seat.${i}`, s); localStorage.setItem('hall.dealShow', 'off'); localStorage.setItem('hall.guide.seen', '1'); localStorage.setItem('hall.dice.guided', '1'); localStorage.setItem('hall.hand.guided', '1'); }, [A.token, t.id, sa.token]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${BASE}${G.page}?id=${t.id}`);
      await page.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
      await page.waitForTimeout(600);
      const box = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height, b: r.bottom + window.scrollY, r: r.right }; });
      const [strip, hand, left, right] = [await box('.zone-strip'), await box('.zone-hand'), await box('.zone-left'), await box('.zone-right')];
      const tag = `${G.game} at ${width}`;
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tag}: no side scroll`);
      if (width >= 1280) {
        assert.ok(strip.y - hand.b <= 14, `${tag}: the tiles start straight under the hand (gap ${Math.round(strip.y - hand.b)}px)`);
        assert.ok(Math.abs(strip.x - hand.x) < 2 && Math.abs(strip.w - hand.w) < 2, `${tag}: in the middle column, as wide as the hand`);
        assert.ok(strip.x >= left.r && strip.r <= right.x, `${tag}: the side columns run beside them`);
        const tops = await page.$$eval('.zone-strip > .box:not([hidden])', (els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
        assert.equal(new Set(tops).size, 2, `${tag}: two columns of tiles`);
      } else {
        assert.ok(strip.y >= Math.max(left.b, right.b, hand.b) - 1, `${tag}: the strip under it all, as before`);
        assert.ok(strip.w > hand.w || width < 980, `${tag}: full width`);
      }
      assert.deepEqual(errors, [], tag);
      await ctx.close();
    }
  });
}

test('cup-and-claim: from 1280 the table art fills its column (as Sealed Hand\'s does), with the figures, cups and dice in frame; 980-1279 and a phone as before', { timeout: 90000 }, async () => {
  const A = await call('POST', '/players', { name: 'Rook', avatar: 'knight' });
  const B = await call('POST', '/players', { name: 'Wren', avatar: 'mage' });
  const t = await call('POST', '/dice-tables', { lobbySeconds: 60, test: { turnMs: 600000, rng: 5 } });
  const sa = await call('POST', `/dice-tables/${t.id}/join`, { kind: 'human' }, A.token);
  await call('POST', `/dice-tables/${t.id}/join`, { kind: 'human' }, B.token);
  await call('POST', `/dice-tables/${t.id}/deal-now`, {}, sa.token);
  for (const [width, height, fills] of [[1920, 1080, true], [1440, 900, true], [1280, 900, true], [1100, 800, false], [390, 844, null]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, ...(width < 980 ? { isMobile: true, hasTouch: true } : {}), serviceWorkers: 'block' });
    await ctx.addInitScript(([p, i, s]) => { localStorage.setItem('hall.player', p); localStorage.setItem(`hall.seat.${i}`, s); localStorage.setItem('hall.dealShow', 'off'); localStorage.setItem('hall.guide.seen', '1'); localStorage.setItem('hall.dice.guided', '1'); }, [A.token, t.id, sa.token]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/dice?id=${t.id}`);
    await page.waitForSelector('.table-cup', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width }; };
      const wrap = r('.scene-wrap'), zone = r('.zone-mid');
      const cups = [...document.querySelectorAll('.table-cup .cup-art')].map((el) => el.getBoundingClientRect());
      const heads = [...document.querySelectorAll('.dice-scene .figure, .dice-scene [data-figure], .dice-scene .table-figure')].map((el) => el.getBoundingClientRect());
      return { wrap, zone, cups: cups.map((c) => ({ y: c.top, b: c.bottom })), figures: heads.length };
    });
    const tag = `dice at ${width}x${height}`;
    if (fills) assert.ok(Math.abs(m.wrap.w - m.zone.w) < 3 || m.wrap.w > m.zone.w * 0.8, `${tag}: the art fills the column (${Math.round(m.wrap.w)} of ${Math.round(m.zone.w)})`);
    if (width >= 1440) assert.ok(Math.abs(m.wrap.w - m.zone.w) < 3, `${tag}: exactly the column's width`);
    else if (fills === false) assert.ok(m.wrap.w < m.zone.w - 20, `${tag}: as before, centred and narrower (${Math.round(m.wrap.w)} of ${Math.round(m.zone.w)})`);
    assert.ok(m.cups.every((c) => c.y >= m.wrap.y && c.b <= m.wrap.b + 1), `${tag}: every cup inside the frame`);
    await ctx.close();
  }
});
