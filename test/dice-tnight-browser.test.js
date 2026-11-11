// A tNIGHT dice table and its public receipt, in headless Chrome against a local `wrangler dev`, with this test as the judge.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = 8845;
const BASE = `http://127.0.0.1:${PORT}`;
const JUDGE = 'test-judge-token';
const SHOTS = process.env.SHOTS;
const A = 'a'.repeat(64);
const H = 'e'.repeat(64);
const star = (n) => String(n * 1_000_000);
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

let browser;
before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', 'WALLET_PAGE:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${'d'.repeat(64)}`, '--var', 'CAGE_TABLE_BASE:700']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, { timeout: 120_000 });
after(async () => {
  await browser?.close();
  await stopServers();
});

async function call(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json();
}
const judge = (op, id, body) => call('POST', `/judge/tables/${id}/${op}`, { token: JUDGE, body });
const shot = async (page, name, full = false) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full }); };

async function seatedTable() {
  const t = await call('POST', '/dice-tables', { body: { tnight: true, bots: 2, lobbySeconds: 0, test: { rng: 11, botDelayMs: [300, 500], roundGapMs: 60_000 } } });
  const claim = await call('POST', `/dice-tables/${t.id}/cage-seat`, { body: { name: 'Probe', cageId: A, verifyingKey: 'vk', signature: 'sig' } });
  await judge('house', t.id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 });
  await judge('verified', t.id, { cageId: A, ok: true, atRiskStar: star(40), balanceStar: star(40), epoch: 1, lastRound: '40' });
  return { id: t.id, token: claim.token, table: t.state.cage.table };
}

async function pageAtTable(id, token) {
  const context = await browser.newContext(PHONE);
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [`hall.seat.${id}`, token]);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/dice?id=${id}`);
  return { context, page };
}

test('a seated phone: the round number and fingerprint from the deal, honest words at the call, and the panel at the end', async () => {
  const { id, token, table } = await seatedTable();
  const { context, page } = await pageAtTable(id, token);
  await page.waitForSelector('#receipt-number');
  assert.equal(await page.textContent('#receipt-number'), `Table ${table} · Round 41`);
  assert.match(await page.textContent('#receipt-fingerprint'), /^[0-9a-f]{16}…$/);
  assert.match(await page.textContent('#result-chain'), /sealed before the deal/);
  assert.equal(await page.$('#check-round'), null, 'Check this round waits for the round to end: it opens the receipt in a window over the table (The owner, 11-07)');
  assert.match(await page.textContent('#purse-bar'), /^Your stack 35 · In the cage 35 tNIGHT$/, 'the cage as it stands: what waits behind the seat plus the live stack, not the figure from the last settle (The owner, 11-07)');
  const dieBg = await page.$eval('.die', (el) => getComputedStyle(el).backgroundImage);
  assert.match(dieBg, /\/art\/dice\/dice\.svg/, 'a die is the sharp, bright face strip the owner preferred (11-06), not the pixel-art one');
  assert.equal(await page.$eval('.die', (el) => getComputedStyle(el).imageRendering), 'auto', 'drawn smooth, as a vector');
  await shot(page, 'tnight-dice-open');

  // Bid and call, then the choice.
  for (let guard = 0; guard < 80; guard += 1) {
    const v = await call('GET', `/dice-tables/${id}`);
    if (v.phase === 'duel' || v.phase === 'settled') break;
    const me = await call('GET', `/dice-tables/${id}/me`, { token });
    const can = (name) => me.legal.find((x) => x.action === name);
    if (can('liar')) await call('POST', `/dice-tables/${id}/act`, { token, body: { action: 'liar' } });
    else if (can('bid')) await call('POST', `/dice-tables/${id}/act`, { token, body: { action: 'bid', ...can('bid').lowest } });
    await new Promise((r) => setTimeout(r, 120));
  }
  await page.waitForSelector('#choose-prove', { timeout: 20000 });
  const words = await page.textContent('#actions');
  assert.match(words, /Keep the cup shut/);
  assert.match(words, /house vouches/);
  assert.doesNotMatch(await page.textContent('body'), /chain prove/i, 'nothing says the chain proves the count');
  assert.match(words, /Only the money settles on chain/);
  assert.equal(await page.textContent('#trust-chips'), 'On chain.', 'at a tNIGHT table the panel says so');
  await shot(page, 'tnight-dice-choice');
  await page.click('#choose-prove');
  await page.waitForFunction(async () => /Settling on chain/.test(document.getElementById('result-chain')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match(await page.textContent('.call-how'), /house-counted|showed/);

  const row = (await call('GET', '/judge/tables', { token: JUDGE })).tables.find((x) => x.id === id);
  await judge('settled', id, { seqs: [row.entries[0].seq], tx: { hash: 'ab'.repeat(32), id: 'cd'.repeat(32), block: 3300000, status: 'SUCCESS', chainRound: 41, blockAt: Date.now() } });
  await page.waitForFunction(() => /Settled on chain/.test(document.getElementById('result-chain')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match(await page.textContent('#result-chain'), /block 3300000/);
  await shot(page, 'tnight-dice-settled');
  assert.deepEqual(page.errors, []);
  await context.close();

  // The receipt, as a stranger sees it, on a phone.
  const stranger = await browser.newContext(PHONE);
  const r = await stranger.newPage();
  const errors = [];
  r.on('pageerror', (e) => errors.push(e.message));
  await r.goto(`${BASE}/receipt/${table}-41`);
  await r.waitForSelector('#check-now');
  assert.equal(await r.textContent('#title'), `Table ${table} · Round 41`);
  assert.match(await r.textContent('#rc-claim'), /bid at least/);
  assert.match(await r.textContent('#rc-call'), /called Liar/);
  assert.match(await r.textContent('#rc-result'), /takes the pot|is paid out/);
  assert.equal(await r.textContent('#rc-tx'), 'ab'.repeat(32));
  assert.match(await r.textContent('#rc-block'), /Block 3300000/);
  assert.equal(await r.getAttribute('#rc-json', 'href'), `/receipt/${table}-41.json`);
  await r.click('#check-now');
  await r.waitForSelector('#rc-checks li');
  const results = await r.$$eval('#rc-checks li', (x) => x.map((li) => [li.className, li.textContent]));
  assert.deepEqual(results.filter(([kind]) => kind === 'fail'), [], 'no check fails');
  assert.ok(results.some(([kind, text]) => kind === 'pass' && /fingerprint recomputes/.test(text)));
  assert.ok(results.some(([kind, text]) => kind === 'pass' && /matches the seal/.test(text)));
  assert.ok(results.some(([kind, text]) => kind === 'word' && /house’s word/.test(text)), 'a shut cup is called what it is');
  assert.ok(await r.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no side scroll');
  await shot(r, 'tnight-receipt', true);
  assert.deepEqual(errors, []);
  await stranger.close();
});

test('the Hall offers both ways in at the dice sign, and Play for tNIGHT lands on the dice table itself, which seats a player in place', async () => {
  const warm = await call('POST', '/judge/warm', { token: JUDGE, body: { bots: 2, game: 'cup-and-claim' } });
  await judge('house', warm.id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 });
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector('[data-game="cup-and-claim"]');
  await page.waitForFunction(() => document.querySelector('[data-game="cup-and-claim"]') && document.querySelector('#menu'));
  await page.dispatchEvent('[data-game="cup-and-claim"]', 'click');
  await page.waitForSelector('#menu .menu-item[data-id="bring"]:not([disabled])');
  await page.click('#menu .menu-item[data-id="bring"]');
  await page.waitForSelector('#menu .menu-item[data-id="go"]'); // once: why the tables wait
  await page.click('#menu .menu-item[data-id="go"]');
  await page.waitForURL(/\/dice\?id=[0-9a-f]{64}$/);
  await page.waitForFunction(() => /Sit at this table/.test(document.getElementById('join-title')?.textContent ?? ''));
  await page.waitForSelector('#cage-join', { state: 'attached' });
  assert.match(await page.textContent('#join-note'), /Choose your wallet, pick how much, and sit/);
  await context.close();
});

test('a tNIGHT table being seated says what the judge is doing, with a count-up, until the deal', async () => {
  const t = await call('POST', '/dice-tables', { body: { tnight: true, bots: 2, lobbySeconds: 0 } });
  await call('POST', `/dice-tables/${t.id}/cage-seat`, { body: { name: 'Waiter', cageId: A, verifyingKey: 'vk', signature: 'sig' } });
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/dice?id=${t.id}&watch=1`);
  await page.waitForSelector('#seating:not([hidden])');
  assert.equal(await page.textContent('#phase'), 'Seating the table');
  assert.match(await page.textContent('#seating'), /house float on chain.*about 2 minutes/);
  await page.waitForFunction(() => /\d:\d\d so far/.test(document.querySelector('#seating small')?.textContent ?? ''));
  await shot(page, 'tnight-dice-seating');
  await judge('house', t.id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 });
  await page.waitForFunction(() => /reading Waiter’s seat/.test(document.getElementById('seating').textContent), null, { timeout: 10000 });
  await judge('verified', t.id, { cageId: A, ok: true, atRiskStar: star(40), balanceStar: star(40), epoch: 1, lastRound: '0' });
  await page.waitForFunction(() => document.getElementById('seating').hidden, null, { timeout: 10000 });
  assert.match(await page.textContent('#phase'), /Round \d+ · Bidding/);
  assert.deepEqual(page.errors, []);
  await context.close();
});
