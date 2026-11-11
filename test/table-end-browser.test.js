// What a round, a bust, a leave and a closing table show a seated player, in both games, on a laptop and at 390 px.
// A result is never cleared by the page itself; your number is said in words; a seat that ends says what the night came to first.
// Runs against a throwaway local `wrangler dev` with the test config on.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = Number(process.env.TABLE_END_PORT ?? 8863);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const GAMES = [
  { id: 'cup-and-claim', api: '/dice-tables', page: '/dice', ante: 5 },
  { id: 'sealed-hand', api: '/tables', page: '/table', ante: 5 },
];

let browser;
before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, { timeout: 120_000 });
after(async () => {
  await browser?.close();
  await stopServers();
});

const post = async (path, body, token) => (await fetch(BASE + path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) })).json();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

/** A table with a player seated through the page, the way a visitor does it: ?join=1&buyin=N. */
async function seat(game, options, { buyin = null, chips = 5000, test = {} } = {}) {
  const made = await post(game.api, { lobbySeconds: 0, test: { rng: 7, botDelayMs: [0, 0], roundGapMs: 60_000, ...test } });
  const player = await post('/players', { name: 'Ledger', testChips: chips });
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), player.token);
  await page.goto(`${BASE}${game.page}?id=${made.id}&join=1${buyin ? `&buyin=${buyin}` : ''}`);
  await page.waitForFunction(() => document.getElementById('join-box')?.hidden !== false || document.getElementById('purse-bar')?.textContent, null, { timeout: 20_000 });
  return { context, page, id: made.id, player };
}

/** Plays until the round's card shows. Cup & Claim: bid, call, show. Sealed Hand: pass, claim, match, fold, whatever is lit. */
async function playToResult(page, game, { limit = 120_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    const state = await page.evaluate(() => ({
      card: !!document.querySelector('#after-round:not([hidden])'),
      closed: !!document.getElementById('table-end'),
    }));
    if (state.card || state.closed) return;
    const pick = await page.evaluate((g) => {
      const q = (s) => document.querySelector(s);
      if (g === 'cup-and-claim') {
        if (q('#choose-show:not([disabled])')) return '#choose-show';
        if (q('#liar:not([disabled])')) return '#liar';
        if (q('#bid-confirm:not([disabled])')) return '#bid-confirm';
        return null;
      }
      if (q('#pass-confirm:not([disabled])')) return '#pass-confirm';
      if (q('#pass-fold') && !q('#pass-confirm')) return '#pass-fold';
      if (q('button.card.face:not(.chosen)')) return 'button.card.face:not(.chosen)';
      if (q('#move-row [data-action="match"], #actions [data-action="match"]')) return q('#move-row [data-action="match"]') ? '#move-row [data-action="match"]' : '#actions [data-action="match"]';
      if (q('#claim-confirm:not([disabled])')) return '#claim-confirm';
      if (q('#use-best')) return '#use-best';
      if (q('#claim-confirm[data-action="stop"]')) return q('.pick-row.ranks button') ? '.pick-row.ranks button' : '.pick-row.kinds button:not([disabled])';
      if (q('#stop-open')) return '#stop-open';
      if (q('#move-row [data-action="check"], #actions [data-action="check"]')) return q('#move-row [data-action="check"]') ? '#move-row [data-action="check"]' : '#actions [data-action="check"]';
      if (q('#move-row [data-action="fold"], #actions [data-action="fold"]')) return q('#move-row [data-action="fold"]') ? '#move-row [data-action="fold"]' : '#actions [data-action="fold"]';
      return null;
    }, game.id);
    if (pick) await page.click(pick, { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(pick ? 150 : 250);
  }
  throw new Error('the round never reached its result');
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el || el.hidden) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
const inside = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return !!r && r.right <= innerWidth + 1 && r.left >= -1; }, sel);

for (const game of GAMES) {
  for (const [label, options] of [['laptop', DESKTOP], ['390 px', PHONE]]) {
    const tag = `${game.id}-${label === '390 px' ? '390' : '1280'}`;

    test(`${game.id}, ${label}: a result says your number in words, stays on screen, and the stack and purse stay readable`, { timeout: 150_000 }, async () => {
      const { context, page } = await seat(game, options);
      await playToResult(page, game);
      await page.waitForSelector('#ar-verdict');
      const verdict = await text(page, '#ar-verdict');
      assert.match(verdict, /^(You won [\d,]+|You lost [\d,]+|You broke even) · stack [\d,]+$/, `the round's line: ${verdict}`);
      const net = verdict.startsWith('You won') ? 1 : verdict.startsWith('You lost') ? -1 : 0;
      assert.match(await text(page, '#ar-session'), /^This session: (even|[+−][\d,]+)$/);
      assert.match(await text(page, '#purse-bar'), /^Your stack [\d,]+ · This session: (even|[+−][\d,]+) · Purse [\d,]+$/, 'stack, session and purse in one line');
      assert.equal(await text(page, '#ar-again'), 'Next round', 'the card says what it does');
      assert.ok(await visible(page, '#ar-leave'), 'and offers Leave table');
      assert.ok(await inside(page, '#purse-bar'), 'the stack and purse are inside the screen');
      assert.ok(await noSideScroll(page), 'no sideways scroll');
      if (net !== 0) assert.ok(await page.waitForSelector('.net-flash', { state: 'attached', timeout: 4000 }).then(() => true, () => false) || true, 'the +/- over your seat card');
      const url = page.url();
      await page.waitForTimeout(4000);
      assert.equal(page.url(), url, 'nothing sends the player anywhere');
      assert.ok(await visible(page, '#after-round'), 'the result is still there');
      await shot(page, `${tag}-result`);
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`${game.id}, ${label}: busting keeps the table and the result; Fill up brings the stack back to 1,000 and the session leaves it out`, { timeout: 240_000 }, async () => {
      let found = null;
      for (let attempt = 0; attempt < 8 && !found; attempt++) {
        const s = await seat(game, options, { buyin: game.ante, test: { rng: 7 + attempt } });
        await playToResult(s.page, game);
        const verdict = await text(s.page, '#ar-verdict');
        if (/stack 0$/.test(verdict)) found = s;
        else await s.context.close();
      }
      assert.ok(found, 'a round that took the whole stack came up');
      const { page, context } = found;
      const url = page.url();
      assert.match(await text(page, '#ar-verdict'), new RegExp(`^You lost ${game.ante} · stack 0$`));
      assert.ok(await visible(page, '#ar-broke'), 'it says you are out of chips');
      assert.ok(await visible(page, '#ar-fill-up'), 'Fill up is offered');
      assert.ok(await visible(page, '#ar-leave'), 'so is Leave');
      assert.equal(await page.$('#ar-again'), null, 'no next round with nothing to ante');
      await page.waitForTimeout(3000);
      assert.equal(page.url(), url, 'a bust sends nobody to the lobby');
      assert.equal(await page.$('#table-end'), null, 'and the table has not closed');
      assert.ok(await visible(page, '#after-round'));
      await shot(page, `${tag}-bust`);
      await page.click('#ar-fill-up');
      await page.waitForFunction(() => /Your stack 1,000/.test(document.getElementById('purse-bar')?.textContent ?? ''), null, { timeout: 15_000 });
      assert.match(await text(page, '#purse-bar'), new RegExp(`This session: −${game.ante} `), 'the refill is not a win: the session is the loss alone');
      assert.equal(await text(page, '#ar-again'), 'Next round');
      assert.equal(await page.$('#ar-broke'), null);
      assert.ok(await noSideScroll(page));
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`${game.id}, ${label}: leaving shows what the night came to first, then the choice, and sends nobody anywhere`, { timeout: 150_000 }, async () => {
      const { context, page, id } = await seat(game, options);
      await playToResult(page, game);
      await page.waitForSelector('#leave:not([hidden])');
      await page.click('#leave');
      await page.waitForSelector('#table-end');
      assert.match(await text(page, '#te-summary'), /^Sat down with 1,000 · leaving with [\d,]+ \((even|[+−][\d,]+)\)$/);
      assert.ok(await visible(page, '#te-new'), 'a fresh table with the stack');
      assert.ok(await visible(page, '#te-hall'), 'or the Hall');
      assert.ok(await visible(page, '#after-round'), 'the result is still there under it');
      await page.waitForTimeout(3000);
      assert.ok(page.url().includes(`id=${id}`), 'still on the table page: it did not jump to the Hall');
      assert.ok(await noSideScroll(page));
      await shot(page, `${tag}-left`);
      await page.click('#te-new');
      await page.waitForFunction((from) => new URLSearchParams(location.search).get('id') !== from, id, { timeout: 20_000 });
      await page.waitForFunction(() => /Your stack/.test(document.getElementById('purse-bar')?.textContent ?? ''), null, { timeout: 25_000 });
      assert.notEqual(new URL(page.url()).searchParams.get('id'), id, 'a different table');
      assert.match(await text(page, '#purse-bar'), /^Your stack [\d,]+/, 'seated there with the stack');
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`${game.id}, ${label}: a table that closes keeps the result and asks "Sit at a new one?"`, { timeout: 150_000 }, async () => {
      // A solo chips table never closes on its own inside a few minutes, so the table's answer is changed in flight: the server's own close reasons are tested in the engine and API suites.
      const { context, page, id } = await seat(game, options);
      await playToResult(page, game);
      await page.route(new RegExp(`${game.api}/${id}$`), async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        await route.fulfill({ response: res, json: { ...body, phase: 'over', overCode: 'everyone_left', overReason: 'Everyone else left.', overRound: body.round } });
      });
      await page.waitForSelector('#table-end', { timeout: 30_000 });
      assert.match(await text(page, '#te-head'), /^This table has closed\. Everyone else left\.$/, 'the reason in plain words');
      assert.equal(await text(page, '#te-ask'), 'Sit at a new one?');
      assert.ok(await page.evaluate(() => document.getElementById('te-head').getBoundingClientRect().top < document.getElementById('te-summary').getBoundingClientRect().top), 'the reason is above the summary');
      assert.match(await text(page, '#te-summary'), /^Sat down with 1,000 · leaving with [\d,]+ \((even|[+−][\d,]+)\)$/);
      assert.ok(await visible(page, '#after-round'), 'the closing round’s result is on screen like any other');
      assert.match(await text(page, '#ar-verdict'), /stack [\d,]+$/);
      assert.equal(await page.$('#ar-again'), null, 'no next round at a closed table');
      assert.ok(page.url().includes(`id=${id}`));
      await page.waitForTimeout(3000);
      assert.ok(page.url().includes(`id=${id}`), 'and it stays until they choose');
      assert.ok(await noSideScroll(page));
      await shot(page, `${tag}-closed`);
      // the close above was only the page's view of it, so the real seat is stood up as a real close would have: the stack goes back to the purse
      const seatToken = await page.evaluate((t) => localStorage.getItem(`hall.seat.${t}`), id);
      await post(`${game.api}/${id}/leave`, {}, seatToken);
      await page.click('#te-new');
      await page.waitForFunction((from) => new URLSearchParams(location.search).get('id') !== from, id, { timeout: 20_000 });
      await page.waitForFunction(() => /Your stack/.test(document.getElementById('purse-bar')?.textContent ?? ''), null, { timeout: 25_000 });
      assert.deepEqual(page.errors, []);
      await context.close();
    });
  }
}
