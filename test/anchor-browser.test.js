// The deal show and the lock panel in a real browser, against a local Worker with anchoring on and the fake anchor service.
// Set SHOTS to a folder to keep screenshots (the Player ID is masked in every one).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';
import { fakeAnchor } from './fake-anchor.js';

const PORT = Number(process.env.ANCHOR_BROWSER_PORT ?? 8891);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `anchor-browser-token-${'y'.repeat(24)}`;
const SHOTS = process.env.SHOTS;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 820 } };
let browser;
let svc;

before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'ANCHOR_MODE:lock', '--var', 'ANCHOR_SCOPE:all', '--var', 'ANCHOR_PICKER:on', '--var', 'DEAL_BY_PLAYER:on', '--var', `ANCHOR_TOKEN:${TOKEN}`]);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  svc = fakeAnchor({ base: BASE, token: TOKEN, delayMs: 3000 });
  await new Promise((r) => setTimeout(r, 2500)); // the service has polled once: online
}, { timeout: 120_000 });

after(async () => {
  await svc?.stop();
  await browser?.close();
  await stopServers();
});

async function open(game, mode, options = DESKTOP) {
  const api = game === 'dice' ? '/dice-tables' : '/tables';
  const res = await fetch(`${BASE}${api}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lobbySeconds: 120, anchor: mode, test: { rng: 4, botDelayMs: [800, 1500] } }) });
  const { id } = await res.json();
  const context = await browser.newContext(options);
  await context.addInitScript(() => { try { localStorage.setItem('hall.hand.guided', '1'); localStorage.setItem('hall.dice.guided', '1'); } catch { /* none */ } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/${game === 'dice' ? 'dice' : 'table'}?id=${id}`);
  await page.fill('#join-name', 'Paulo');
  await page.click('#join-form button[type="submit"]');
  await page.waitForSelector('#deal-now');
  return { context, page, id };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), mask: [page.locator('.player-id')], maskColor: '#2e222f' }); };

test('Sealed Hand, lock first: Shuffle & deal, the cards fly face down, the lock panel counts to the block, then your cards turn over', { timeout: 90_000 }, async () => {
  const { context, page } = await open('table', 'lock');
  assert.equal((await page.textContent('#deal-now')).trim(), 'Shuffle & deal', 'the deal is the player\'s');
  await page.click('#deal-now');
  await page.waitForSelector('.deal-layer .fly-card', { timeout: 5000 });
  await shot(page, 'anchor-hand-dealing');
  await page.waitForSelector('#lock-panel:not([hidden])', { timeout: 10_000 });
  assert.match(await page.textContent('#lock-panel .lock-title'), /Locking your hand on Midnight/);
  assert.match(await page.textContent('#lock-panel .lock-hash'), /Deck seal [0-9a-f]{10}…[0-9a-f]{6}/);
  assert.equal(await page.$$eval('#hand .card.back.midnight.held', (els) => els.length), 5, 'your five, face down');
  assert.equal(await page.$('#hand .card.face'), null, 'no face before the lock');
  assert.equal(await page.$$eval('.backs.five', (els) => els.length), 3, 'each opponent holds five backs');
  assert.equal(await page.$$eval('.backs.five', (els) => els.every((el) => el.children.length === 5)), true);
  await shot(page, 'anchor-hand-locking');
  await page.waitForFunction(() => /Locked on Midnight ✓ block \d+/.test(document.querySelector('#lock-panel .lock-title')?.textContent ?? ''), null, { timeout: 15_000 });
  assert.match(await page.textContent('#lock-panel .lock-foot'), /Transaction .* on the explorer/);
  await shot(page, 'anchor-hand-locked');
  await page.waitForSelector('#lock-panel', { state: 'hidden', timeout: 5000 });
  await page.waitForSelector('#hand .card.face', { timeout: 5000 });
  assert.equal(await page.$$eval('#hand .card.face', (els) => els.length), 5);
  assert.match(await page.textContent('#log'), /Locked on Midnight ✓ block \d+/);
  assert.ok(await page.$('#log a.anchor-link'), 'the line links the explorer');
  assert.match(await page.textContent('#anchor-mode'), /lock first/);
  // the round's name in the top banner (The owner, 11-08): table, round, the seal short, Copy and Receipt
  assert.match(await page.textContent('header.hud + #round-id'), /Table \d+ · Round 1 · seal [0-9a-f]{6}…[0-9a-f]{6}/);
  assert.ok(await page.$('#round-id .copy-btn'), 'the seal is copyable');
  assert.ok(await page.$('#round-id #round-receipt'), 'and the receipt is one tap away');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('Sealed Hand, background: no wait and no panel; table talk says anchoring, then anchored with a link', { timeout: 60_000 }, async () => {
  const { context, page } = await open('table', 'background');
  await page.click('#deal-now');
  await page.waitForFunction(() => /Locking this hand on Midnight \(30–60 s\)\. Enjoy your game\./.test(document.getElementById('anchor-note')?.textContent ?? ''), null, { timeout: 3000 });
  assert.ok(await page.$('#anchor-note:not([hidden])'), 'the one line shows at the start of the hand');
  await page.waitForSelector('#hand .card.face', { timeout: 8000 });
  assert.ok(await page.$('#lock-panel[hidden]'), 'no panel in background mode');
  await page.waitForFunction(() => /Locked ✓ block \d+/.test(document.getElementById('anchor-note')?.textContent ?? ''), null, { timeout: 15_000 });
  assert.ok(await page.$('#anchor-note a[href*="explorer"]'), 'the notification links the explorer');
  assert.match(await page.textContent('#log'), /Locked ✓ block \d+/);
  await shot(page, 'anchor-hand-background');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('Cup & Claim, lock first, phone: Shake, the cup slams and stays down while locking, then lifts', { timeout: 90_000 }, async () => {
  const { context, page } = await open('dice', 'lock', PHONE);
  assert.equal((await page.textContent('#deal-now')).trim(), 'Shake');
  await page.click('#deal-now');
  await page.waitForSelector('#lock-panel:not([hidden])', { timeout: 10_000 });
  assert.match(await page.textContent('#lock-panel .lock-title'), /Locking your cup on Midnight/);
  assert.match(await page.textContent('#lock-panel'), /Shaken and sealed/);
  assert.match(await page.textContent('#cup-title'), /locking it on Midnight/);
  await shot(page, 'anchor-dice-locking-phone');
  await page.waitForSelector('#lock-panel', { state: 'hidden', timeout: 20_000 });
  await page.waitForFunction(() => document.getElementById('my-dice').classList.contains('shown'), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  assert.match(await page.textContent('#round-id'), /Table \d+ · Round 1 · fingerprint [0-9a-f]{6}…[0-9a-f]{6}/, 'the dice fingerprint names the round on a phone too');
  await shot(page, 'anchor-dice-lifted-phone');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('reduced motion: no flying cards, and the lock still reads plainly', { timeout: 60_000 }, async () => {
  const { context, page } = await open('table', 'lock', { ...DESKTOP, reducedMotion: 'reduce' });
  await page.click('#deal-now');
  await page.waitForSelector('#lock-panel:not([hidden])', { timeout: 10_000 });
  assert.equal(await page.$('.deal-layer'), null, 'no deal layer');
  await page.waitForSelector('#hand .card.face', { timeout: 20_000 });
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the deal show is skippable: a tap ends it at once', { timeout: 60_000 }, async () => {
  const { context, page } = await open('table', 'background');
  await page.click('#deal-now');
  await page.waitForSelector('.deal-skip', { timeout: 5000 });
  await page.click('.deal-skip');
  await page.waitForSelector('.deal-layer', { state: 'detached', timeout: 2000 });
  await page.waitForSelector('#hand .card.face', { timeout: 5000 });
  assert.deepEqual(page.errors, []);
  await context.close();
});
