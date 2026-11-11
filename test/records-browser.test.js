// The Records page in headless Chrome against a throwaway local `wrangler dev`: search by table and round, one round's page, the
// in-browser recheck of its dice, the phone layout, and the "Table 3 · Round 41" link at both games' tables. Set SHOTS to a folder
// to save screenshots.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';
import { answering, stopping } from './helpers.js';

const PORT = 8877;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1100, height: 900 } };

let browser;
let table;
let dice; // the Cup & Claim table above: { id, token }, with round 3 dealt
let hand; // a Sealed Hand play table with round 1 played out: { id, token, table }

before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  seenHandGuide(browser); // Tally's Sealed Hand walkthrough already seen, unless a test asks for it ({ guide: true })
  // Two rounds at one table, played to the end, one with the cup shown.
  const post = async (path, body, token) => (await fetch(BASE + path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) })).json();
  const get = async (path, token) => (await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
  const { id } = await post('/dice-tables', { lobbySeconds: 0, test: { rng: 21, roundGapMs: 1500 } });
  const { token } = await post(`/dice-tables/${id}/join`, { name: 'Probe' });
  table = (await get(`/dice-tables/${id}`)).n;
  for (let round = 1; round <= 2; round += 1) {
    for (let guard = 0; guard < 80; guard += 1) {
      const v = await get(`/dice-tables/${id}`);
      if (v.phase === 'settled') break;
      const me = await get(`/dice-tables/${id}/me`, token);
      const can = (name) => me.legal.find((x) => x.action === name);
      const action = can('reveal') ? { action: 'reveal', mode: round === 1 ? 'show' : 'prove' } : can('liar') ? { action: 'liar' } : can('bid') ? { action: 'bid', ...can('bid').lowest } : null;
      if (action) await post(`/dice-tables/${id}/act`, action, token);
      await new Promise((r) => setTimeout(r, 40));
    }
    await post(`/dice-tables/${id}/act`, { action: 'next' }, token);
  }
  dice = { id, token };
  // And one Sealed Hand round, played to its end with the plainest legal moves.
  const sh = await post('/tables', { lobbySeconds: 0, test: { rng: 5, roundGapMs: 600_000 } });
  const dealer = await post(`/tables/${sh.id}/join`, { name: 'Dealer' });
  hand = { id: sh.id, token: dealer.token, table: (await get(`/tables/${sh.id}`)).n };
  for (let guard = 0; guard < 80; guard += 1) {
    const v = await get(`/tables/${sh.id}`);
    if (v.phase === 'settled' || v.phase === 'over') break;
    const me = await get(`/tables/${sh.id}/me`, dealer.token);
    const has = (a) => me.legal?.find((l) => l.action === a);
    const body = has('pass') ? { action: 'pass', card: has('pass').cards[0], ...(has('pass').match ? { match: true } : {}) } : has('match') ? { action: 'match' } : has('stop') ? stopping(me) : has('claim')?.truthful.length ? { action: 'claim', claim: has('claim').truthful[0].claim } : has('check') ? { action: 'check' } : has('fold') ? { action: 'fold' } : null;
    if (body) await post(`/tables/${sh.id}/act`, answering(me, body), dealer.token);
    else await new Promise((r) => setTimeout(r, 100));
  }
}, { timeout: 120_000 });

after(async () => {
  await browser?.close();
  await stopServers();
});

async function session(options = DESKTOP) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  return { context, page };
}
const shot = async (page, name, full = true) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full }); };

test('Records: the latest rounds, then a search by table and round, then the round itself', async () => {
  const { context, page } = await session();
  await page.goto(`${BASE}/records`);
  await page.waitForSelector('.rec-item');
  assert.ok(await page.$$eval('.rec-item', (a) => a.length) >= 3, 'rounds one and two, and the sealed third');
  assert.match(await page.innerText('#status'), /latest/i);
  assert.ok(await page.$('#topnav'), 'the top bar is here');
  await shot(page, 'records-desktop');

  await page.fill('#f-table', String(table));
  await page.fill('#f-round', '1');
  await page.click('#f-go');
  await page.waitForFunction(() => document.querySelectorAll('.rec-item').length === 1);
  assert.equal(await page.textContent('.rec-head a'), `Cup & Claim · table ${table} · round 1`);
  assert.match(await page.innerText('.rec-item'), /called Liar/);
  assert.match(await page.innerText('.rec-item'), /Chips moved: .*[+-]\d+/);
  assert.match(await page.$eval('.rec-fp', (e) => e.textContent), /Fingerprint [0-9a-f]{64}/);
  assert.match(page.url(), new RegExp(`table=${table}&round=1`), 'the search is in the address, so it can be shared');

  await page.fill('#f-round', '999');
  await page.click('#f-go');
  await page.waitForFunction(() => document.querySelectorAll('.rec-item').length === 0);
  assert.match(await page.innerText('#status'), /No round with that number/);
  await page.fill('#f-round', '1.5');
  await page.click('#f-go');
  assert.match(await page.innerText('#status'), /whole numbers/);

  await page.goto(`${BASE}/records?table=${table}`);
  await page.waitForSelector('.rec-item');
  assert.deepEqual(await page.$$eval('.rec-head a', (a) => a.map((x) => x.textContent)), [3, 2, 1].map((n) => `Cup & Claim · table ${table} · round ${n}`), 'newest first');
  // A click on a round opens its receipt here: status, game, table and round, result, chips, the round ID with Copy, the times.
  await page.click(`.rec-item[data-number="${table}-1"] .rec-head a`);
  await page.waitForSelector('#receipt[open]');
  assert.equal(page.url(), `${BASE}/records?table=${table}`, 'still on the list');
  assert.equal(await page.textContent('#receipt-title'), 'Round 1');
  assert.equal(await page.textContent('#rx-status'), 'opened');
  assert.equal(await page.textContent('#rx-id'), `cup-and-claim/${table}-1`);
  const rx = await page.innerText('#receipt');
  assert.match(rx, new RegExp(`Table ${table} · Round 1`));
  assert.match(rx, /Play chips, not on chain/);
  assert.match(rx, /Probe\s+[+−-]?\d+/, 'chips moved, by name');
  assert.match(rx, /Started\s+\S+/);
  assert.doesNotMatch(rx, /Ended\s+(—|In play)/, 'an opened round has its end time');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#rx-copy');
  await page.waitForFunction(() => document.querySelector('.rx-copied').textContent === 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `cup-and-claim/${table}-1`);
  await shot(page, 'records-receipt-desktop');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('receipt').open);
  await page.click(`.rec-item[data-number="${table}-2"] .rec-line`);
  await page.waitForSelector('#receipt[open]');
  assert.equal(await page.textContent('#receipt-title'), 'Round 2', 'anywhere on the row opens it');
  await page.click('#rx-close');
  await page.click(`.rec-item[data-number="${table}-1"] .rec-head a`);
  await page.click('#rx-full');
  await page.waitForURL(`${BASE}/records/cup-and-claim/${table}-1`);
  await page.waitForSelector('#rc-fingerprint');
  assert.equal(await page.textContent('h1'), `Cup & Claim · table ${table} · round 1`);
  assert.ok(!(await page.$('#rc-tx')), 'play chips: no chain transaction');
  assert.match(await page.innerText('.receipt-kicker'), /Records · Cup & Claim · play chips/);
  assert.ok(await page.$('#rc-json'));
  await page.click('#check-now');
  await page.waitForSelector('#rc-checks li');
  const checks = await page.$$eval('#rc-checks li', (a) => a.map((x) => [x.className, x.textContent]));
  assert.ok(checks.every(([kind]) => kind !== 'fail'), JSON.stringify(checks));
  assert.ok(checks.some(([kind, text]) => kind === 'pass' && /fingerprint recomputes/.test(text)));
  assert.ok(checks.some(([kind, text]) => kind === 'pass' && /Probe showed/.test(text)), 'the shown cup re-rolls in the browser');
  assert.ok(checks.some(([kind, text]) => kind === 'pass' && /chips moved add up to zero/.test(text)));
  await shot(page, 'record-desktop');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('Records on a phone: no sideways scroll, the form wraps, a round reads in one column', async () => {
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/records?table=${table}`);
  await page.waitForSelector('.rec-item');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no side scroll');
  await shot(page, 'records-phone');
  await page.goto(`${BASE}/records/cup-and-claim/${table}-2`);
  await page.waitForSelector('#rc-fingerprint');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no side scroll on a round');
  await shot(page, 'record-phone');
  assert.deepEqual(page.errors, []);
  await context.close();
});

/** A page seated at a table, as if its player had sat down there. */
async function seatedAt(id, token, options = DESKTOP) {
  const s = await session(options);
  await s.context.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* a new tab's blank first page has no storage */ } }, [`hall.seat.${id}`, token]);
  return s;
}

test('each table shows its round up top as "Table 3 · Round 41", no longer a link; once the round has ended, "This round\'s receipt" opens the checked record in a window over the table, with the full page a link inside', async () => {
  const { context, page } = await seatedAt(hand.id, hand.token);
  await page.goto(`${BASE}/table?id=${hand.id}`);
  await page.waitForSelector('#round-no');
  assert.ok(Number.isInteger(hand.table));
  assert.equal(await page.textContent('#round-no'), `Table ${hand.table} · Round 1`);
  assert.equal(await page.textContent('#phase'), `Table ${hand.table} · Round 1 over`, 'the rest of the line is as it was');
  assert.equal(await page.$('a#round-no'), null, 'the number is not a link: a record of a round in play is nearly empty (The owner, 11-07)');
  await page.waitForSelector('#round-receipt-open:not([hidden])');
  assert.equal((await page.textContent('#round-receipt-open')).trim(), 'This round’s receipt');
  assert.match(await page.textContent('#sp-seal-row'), /Deck seal/, 'the seal in the status panel');
  assert.match(await page.textContent('#sp-seal-note'), /opened/, 'opened with the round over');
  await shot(page, 'round-no-hand-desktop', false);
  await page.click('#round-receipt-open');
  await page.waitForSelector('#receipt-window[open] #rc-result');
  assert.equal(await page.getAttribute('#rw-full', 'href'), `/records/sealed-hand/${hand.table}-1`);
  assert.equal(await page.getAttribute('#rw-full', 'target'), '_blank', 'the table stays open');
  assert.match(await page.innerText('#receipt-window'), /Deck seal/);
  assert.match(await page.innerText('#receipt-window #rc-deal'), /Dealt in: .*Dealer/);
  await page.click('#receipt-window #check-now');
  await page.waitForSelector('#receipt-window .rc-check li');
  const checks = await page.$$eval('#receipt-window .rc-check li', (els) => els.map((e) => [e.className, e.textContent]));
  assert.ok(checks.some(([kind, text]) => kind === 'pass' && /seal recomputes/.test(text)), JSON.stringify(checks));
  assert.ok(checks.some(([kind, text]) => kind === 'pass' && /seed’s shuffle/.test(text)));
  assert.ok(checks.some(([kind, text]) => kind === 'pass' && /hands rebuilt/.test(text)));
  assert.ok(!checks.some(([kind]) => kind === 'fail'), 'nothing fails on an honest round');
  await shot(page, 'receipt-window-hand-desktop', false);
  const [record] = await Promise.all([context.waitForEvent('page'), page.click('#rw-full')]);
  const recordErrors = [];
  record.on('pageerror', (e) => recordErrors.push(e.message));
  await record.waitForSelector('#rc-result');
  assert.equal(await record.textContent('h1'), `Sealed Hand · table ${hand.table} · round 1`);
  assert.match(await record.innerText('.receipt-kicker'), /Records · Sealed Hand · play chips/);
  assert.match(await record.textContent('#rc-deal'), /Dealt in: .*Dealer/);
  assert.ok(await record.$('#check-now'), 'the deck can be rechecked');
  assert.match(await record.textContent('#rc-seal'), /^[0-9a-f]{64}$/, 'the deck seal');
  assert.ok(await record.$('#rc-hands'), 'the hands, opened');
  assert.match(await record.innerText('body'), /sealed before the deal and opened after it/);
  assert.match(await record.getAttribute('#rc-json', 'href'), new RegExp(`/records/sealed-hand/${hand.table}-1\\.json$`));
  assert.match(await record.innerText('#rc-chips'), /Dealer/);
  assert.doesNotMatch(await record.innerText('#rc-chips'), /its bots, one line/, 'at a play table each bot is its own line');
  await record.click('#check-now');
  await record.waitForSelector('.rc-check li');
  assert.ok(!(await record.$$eval('.rc-check li', (els) => els.some((e) => e.classList.contains('fail')))));
  await shot(record, 'record-hand-desktop');
  assert.deepEqual([...page.errors, ...recordErrors], []);
  await record.close();
  await page.click('#rw-done');
  await page.waitForFunction(() => !document.getElementById('receipt-window').open);
  await context.close();

  const d = await seatedAt(dice.id, dice.token);
  await d.page.goto(`${BASE}/dice?id=${dice.id}`);
  await d.page.waitForSelector('#round-no');
  assert.equal(await d.page.textContent('#round-no'), `Table ${table} · Round 3`);
  assert.match(await d.page.textContent('#phase'), new RegExp(`^Table ${table} · Round 3( · | over)`));
  assert.equal(await d.page.$('a#round-no'), null, 'no link at Cup & Claim either');
  const over = /over$/.test(await d.page.textContent('#phase'));
  assert.equal(await d.page.$eval('#round-receipt-open', (e) => e.hidden), !over, 'the receipt button only once the round has ended');
  await shot(d.page, 'round-no-dice-desktop', false);
  await d.page.goto(`${BASE}/records/cup-and-claim/${table}-1`);
  await d.page.waitForSelector('#rc-chips');
  assert.doesNotMatch(await d.page.innerText('#rc-chips'), /its bots, one line/, 'nor at a Cup & Claim play table');
  assert.match(await d.page.innerText('#rc-chips'), /Probe/);
  assert.deepEqual(d.page.errors, []);
  await d.context.close();
});

test('the link on a phone: the status line wraps, and nothing scrolls sideways', async () => {
  for (const [path, id, token] of [[`/table?id=${hand.id}`, hand.id, hand.token], [`/dice?id=${dice.id}`, dice.id, dice.token]]) {
    const { context, page } = await seatedAt(id, token, PHONE);
    await page.goto(`${BASE}${path}`);
    await page.waitForSelector('#round-no');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no side scroll at ${path}`);
    const box = await page.$eval('#round-no', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    assert.ok(box.left >= 0 && box.right <= 390, 'the link is on screen');
    await shot(page, `round-no-phone-${path.startsWith('/dice') ? 'dice' : 'hand'}`, false);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('Records for Sealed Hand: the game picker, the round, and its line', async () => {
  const { context, page } = await session();
  await page.goto(`${BASE}/records?game=sealed-hand&table=${hand.table}`);
  await page.waitForSelector('.rec-item');
  assert.equal(await page.$eval('#f-game', (e) => e.value), 'sealed-hand');
  assert.equal(await page.textContent('.rec-head a'), `Sealed Hand · table ${hand.table} · round 1`);
  assert.equal(await page.textContent('.rec-badge'), 'deck opened');
  assert.match(await page.innerText('.rec-item'), /took \d+|carried|went back|did not finish/);
  assert.match(await page.textContent('.rec-fp'), /^Deck seal [0-9a-f]{64}$/, 'the deck seal line, where Cup & Claim has its fingerprint');
  await page.click('.rec-item');
  await page.waitForSelector('#receipt[open]');
  assert.equal(await page.textContent('#rx-status'), 'deck opened');
  assert.equal(await page.textContent('#rx-id'), `sealed-hand/${hand.table}-1`);
  assert.match(await page.innerText('#receipt'), /Played for\s+Play chips, not on chain/);
  await page.click('#rx-close');
  await page.fill('#f-table', '');
  await page.selectOption('#f-game', 'cup-and-claim');
  await page.waitForFunction(() => /Cup & Claim/.test(document.querySelector('.rec-head a')?.textContent ?? ''));
  assert.doesNotMatch(page.url(), /game=/, 'Cup & Claim is the default, so its address stays as it was');
  await shot(page, 'records-hand-desktop');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('a round number that is not there says so', async () => {
  const { context, page } = await session();
  await page.goto(`${BASE}/records/cup-and-claim/999999-1`);
  await page.waitForFunction(() => /No record/.test(document.getElementById('status').textContent));
  await context.close();
});

/**
 * Every new context starts with Tally's Sealed Hand walkthrough marked as seen (it shows once, the first time a seat is
 * yours, and would sit over the moves), unless it's made with { guide: true }, as the tests of the walkthrough itself are.
 */
function seenHandGuide(b) {
  const make = b.newContext.bind(b);
  b.newContext = async ({ guide = false, ...options } = {}) => {
    const context = await make(options);
    if (!guide) await context.addInitScript(() => { try { localStorage.setItem('hall.hand.guided', '1'); } catch { /* storage blocked: the test says so itself */ } });
    return context;
  };
}
