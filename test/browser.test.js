// Real browsers against a throwaway local `wrangler dev`. Headless Chrome, driven by playwright-core.
// Set SHOTS to a folder to save screenshots of the room and a table.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';
import { createTable, join as joinTable, privateView, publicView } from '../src/games/sealed-hand/engine.js';
import { labelClaim } from '../src/games/sealed-hand/cards.js';

const PORT = Number(process.env.TEST_PORT ?? 8803); // another checkout may be running its own tests on the default
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
const CARD_NAME = / of (clubs|diamonds|hearts|spades)/; // how the page names a face card for screen readers

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

let browser;

before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  seenHandGuide(browser); // Tally's Sealed Hand walkthrough already seen, unless a test asks for it ({ guide: true })
}, { timeout: 120_000 });

after(async () => {
  await browser?.close();
  await stopServers();
});

/** A separate browser session, with page errors collected so a test can insist there were none. */
async function session(options = DESKTOP) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  return { context, page };
}

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** Take a seat from the doorman's menu: there is no default game, so the game is named (The owner, 11-06). */
async function takeSeat(page, game = 'sealed-hand', how = 'click') {
  await page[how]('#menu [data-id="seat"]');
  await page.waitForSelector(`#menu [data-id="pick-${game}"]`);
  await page[how](`#menu [data-id="pick-${game}"]`);
}

/** Someone already through the door, so the doorman greets them with the menu. */
async function named(page, name = 'Regular') {
  const player = await apiPost('/players', { name });
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), player.token);
  await page.reload();
  return player;
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function apiPost(path, rawBody) {
  // These do their sums at an ante of 1: stakes are a table setting, and the defaults have a test of their own.
  const body = path === '/tables' && rawBody?.stakes === undefined ? { ...rawBody, stakes: { ante: 1 } } : rawBody;
  const res = await fetch(BASE + path, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

test('art: every sprite is an indexed PNG on the one palette of 32 colours or fewer', () => {
  const dir = new URL('../public/art/', import.meta.url).pathname;
  const palettes = new Set();
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  assert.ok(files.length >= 15);
  for (const file of files) {
    const png = readFileSync(join(dir, file));
    assert.equal(png[25], 3, `${file} is indexed`);
    const at = png.indexOf(Buffer.from('PLTE'));
    const length = png.readUInt32BE(at - 4);
    assert.ok(length / 3 - 1 <= 32, `${file}: ${length / 3 - 1} colours`);
    palettes.add(png.subarray(at + 4, at + 4 + length).toString('hex'));
  }
  assert.equal(palettes.size, 1, 'all share one palette');
});

test('room loads: the doorman greets first, with the menu, and no errors', async () => {
  const { context, page } = await session();
  const res = await page.goto(BASE);
  assert.equal(res.status(), 200);
  assert.match(res.headers()['content-security-policy'] ?? '', /script-src 'self'/, 'security headers are on');
  await page.waitForSelector('#dialogue:not([hidden])');
  // A first visit is the door (11-10): New here, or bringing a Player ID? Nothing else (its own test is in hall-entry-browser.test.js).
  await page.waitForFunction(() => document.getElementById('line').textContent === 'New here, or bringing a Player ID?');
  assert.equal(await page.textContent('#speaker'), 'Tally', 'Tally keeps the door (The owner, 11-06)');
  assert.match(await page.getAttribute('#doorman', 'aria-label'), /Tally/);
  assert.match(await page.$eval('#doorman', (el) => el.style.backgroundImage), /art\/hall\/seat-tally\.png/);
  assert.equal(await page.$('#doorman-picker'), null, 'no doorman mock-up switch');
  assert.deepEqual(await page.$$eval('#menu .menu-item', (els) => els.map((e) => e.dataset.id)), ['who-new', 'who-restore']);
  // Through the door, the greeting has the menu.
  await named(page);
  await page.waitForFunction(() => document.getElementById('line').textContent.endsWith('be?'));
  const items = await page.$$eval('#menu .menu-item', (els) => els.map((e) => [e.dataset.id, e.disabled]));
  assert.deepEqual(items.slice(0, 3), [['seat', false], ['watch', false], ['rules', false]]);
  assert.deepEqual(items.at(-1), ['tnight', false], 'with tNIGHT off the choice is there and can be pressed');
  assert.match(await page.textContent('#menu'), /Take a seat.*Just watching.*How do I play\?.*Play with tNIGHT.*coming soon/);
  // Pressing it never starts a wallet flow: Tally says the tables are coming, and Back is the greeting again (The owner, 2026-11-07).
  await page.click('#menu [data-id="tnight"]');
  await page.waitForFunction(() => document.getElementById('line').textContent.startsWith('Coming soon: tNIGHT tables are in testing'));
  assert.equal(page.url(), `${BASE}/`, 'still in the Hall');
  await page.click('#menu [data-id="back"]');
  await page.waitForFunction(() => document.getElementById('line').textContent.endsWith('be?'));
  // The cage's spot says the same, and its sign reads Coming soon.
  assert.equal((await page.textContent('#cage-plate small')).trim(), 'Coming soon');
  await page.click('.hotspot-cage');
  await page.waitForFunction(() => document.getElementById('line').textContent.startsWith('Coming soon: tNIGHT tables are in testing'));
  await page.click('#menu [data-id="back"]');
  await page.waitForFunction(() => document.getElementById('line').textContent.endsWith('be?'));
  await shot(page, 'room-desktop-doorman');
  assert.ok(await noSideScroll(page));

  assert.equal(await page.getAttribute('#sound', 'aria-pressed'), 'false', 'sound is muted by default');

  // The sprite is pixel-scaled, not smoothed.
  const rendering = await page.$eval('#room', (el) => getComputedStyle(el).imageRendering);
  assert.equal(rendering, 'pixelated');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('doorman: "How do I play?" walks through the rules from GET /hall, one box at a time', async () => {
  const hall = await (await fetch(`${BASE}/hall`)).json();
  const { context, page } = await session();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await named(page);
  await page.waitForSelector('#menu [data-id="watch"]');
  await page.click('#menu [data-id="rules"]');
  for (let i = 0; i < hall.rules.length; i++) {
    assert.equal(await page.textContent('#line'), hall.rules[i], `box ${i + 1}`);
    if (i === 1) await shot(page, 'room-rules');
    await page.click('#menu [data-id="next"]');
  }
  assert.ok((await page.textContent('#line')).startsWith(hall.greeting[0]), 'back at the greeting');
  await page.click('#menu [data-id="watch"]'); // no default game: a table to watch, or which game, or nobody yet
  await page.waitForFunction(() => /watch=1/.test(window.location.search) || /Which game|Nobody/.test(document.getElementById('line')?.textContent ?? ''));
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('registry drives the room: every game from GET /games becomes a spot, and a new entry just appears', async () => {
  const { games } = await (await fetch(`${BASE}/games`)).json();
  const { context, page } = await session();
  await page.goto(BASE);
  await page.waitForSelector('.spot');
  const seen = await page.$$eval('.spot', (els) => els.map((e) => [e.dataset.game, e.dataset.status]));
  assert.deepEqual(seen, games.map((g) => [g.id, g.status]));
  assert.equal(await page.$$eval('.spot.soon', (els) => els.length), games.filter((g) => g.status === 'soon').length, 'every game not open yet has a spot');
  assert.equal(await page.$$eval('.spot.live', (els) => els.length), games.filter((g) => g.status === 'live').length);

  // Nothing in the page knows about game names: change the list and the room changes with it.
  const extra = { id: 'dice-pit', name: 'Dice Pit', status: 'soon', art: 'cards', blurb: 'Coming.', openTables: 0, tables: [] };
  const rewrite = async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.games.push(extra);
    await route.fulfill({ response: res, json: body });
  };
  await page.route('**/hall', rewrite);
  await page.route('**/games', rewrite);
  await page.reload();
  await page.waitForSelector('.spot[data-game="dice-pit"]');
  assert.match(await page.textContent('#stage'), /Dice Pit/);

  await page.click('#dialogue-close');
  await page.click('.spot[data-game="axe-lane"]');
  await page.waitForFunction(() => /Axe Lane/.test(document.getElementById('line').textContent));
  assert.equal(await page.$('#menu [data-id="join"]'), null, 'a soon game offers no Join');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('phone: the room fits, tables stay tappable, no sideways scroll', async () => {
  const { context, page } = await session(PHONE);
  await page.goto(BASE);
  await page.waitForSelector('.spot');
  await page.waitForSelector('#dialogue:not([hidden])');
  assert.ok(await noSideScroll(page));
  await page.waitForSelector('#menu [data-id="who-new"]'); // the door: who first
  await shot(page, 'room-phone-doorman');
  await page.click('#dialogue-close');
  await page.waitForTimeout(200);
  await shot(page, 'room-phone');
  for (const box of await page.$$eval('.spot', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, r.left, r.right]; }))) {
    assert.ok(box[0] >= 44 && box[1] >= 44, `tap target ${box[0]}×${box[1]}`);
    assert.ok(box[2] >= 0 && box[3] <= 390, 'on screen');
  }
  await page.tap('.spot[data-game="sealed-hand"]'); // no player yet: who first (New here, or a Player ID), then a name and an avatar, then the bring prompt
  await page.waitForSelector('#menu [data-id="who-new"]');
  await page.tap('#menu [data-id="who-new"]');
  await page.waitForSelector('#seat-form:not([hidden])');
  assert.equal((await page.textContent('#seat-go')).trim(), 'Next: pick an avatar');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('support footer: the two entries, each copying its exact address', async () => {
  const { SUPPORT } = await import('../public/js/support.js');
  const { context, page } = await session();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(BASE);
  await page.click('#dialogue-close');
  assert.deepEqual(await page.$$eval('[data-copy]', (els) => els.map((e) => e.dataset.copy)), SUPPORT.map((s) => s.label));
  assert.ok(!/bitcoin|btc|coming soon/i.test(await page.textContent('#support')));
  await page.click('#support-open'); // the addresses open on a tap (11-08)
  for (const { label, address } of SUPPORT) {
    await page.click(`[data-copy="${label}"]`);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied === address, true, `${label} copied exactly`); // true/false, so a failure prints no address
    await page.waitForTimeout(50);
  }
  await context.close();
});

test('blank support entry: its button is off, so nobody copies nothing', async () => {
  const { context, page } = await session();
  const real = readFileSync(new URL('../public/js/support.js', import.meta.url), 'utf8'); // the same mount, with one blank entry in its place
  await page.route('**/js/support.js', (route) => route.fulfill({ contentType: 'text/javascript', body: real.replace(/export const SUPPORT = \[[\s\S]*?\];/, "export const SUPPORT = [{ label: 'Test', address: '' }];") }));
  await page.goto(BASE);
  await page.click('#dialogue-close');
  assert.equal(await page.$eval('[data-copy="Test"]', (e) => e.disabled), true);
  await context.close();
});

test('top-up: a broke player sees the header top-up in the room, and at a table is simply seated with the 1,000 default', async () => {
  const { context, page } = await session();
  const broke = await apiPost('/players', { name: 'Skint', testChips: 0 });
  await page.goto(BASE);
  await page.evaluate((token) => localStorage.setItem('hall.player', token), broke.token);
  await page.reload();
  await page.waitForSelector('#topup:not([hidden])');
  await page.click('#dialogue-close');
  await page.click('#topup');
  await page.waitForFunction(() => /Purse: 200/.test(document.getElementById('who-line')?.textContent));
  assert.equal(await page.$('#topup:not([hidden])'), null, 'used');

  // At a table an empty purse is no longer refused: every seat starts at 1,000, and the table fills a short purse up as it seats them.
  const other = await apiPost('/players', { name: 'Skint Too', testChips: 0 });
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 21 } });
  await page.evaluate((token) => localStorage.setItem('hall.player', token), other.token);
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('#join-form:not([hidden])');
  await page.click('#join-form button[type="submit"]');
  await page.waitForSelector('button.card.face', { timeout: 10_000 });
  assert.equal(await page.$('#join-topup:not([hidden])'), null, 'nothing to top up first');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('leave: between rounds the button cashes out, says what the night came to, and the Hall is the next tap', { timeout: 120_000 }, async () => {
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 31, roundGapMs: 25_000 } });
  const { context, page } = await session();
  await page.goto(`${BASE}/table?id=${id}`);
  await page.fill('#join-name', 'Quitter');
  await page.click('#join-form button[type="submit"]');
  await page.waitForSelector('#leave:not([hidden])', { timeout: 10_000 });
  assert.match(await page.textContent('#leave'), /after this round/, 'mid-round it waits');
  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  await page.waitForFunction(() => /cash out/.test(document.getElementById('leave').textContent), null, { timeout: 5000 });
  await shot(page, 'table-leave');
  await leaveToHall(page);
  await page.waitForFunction(() => /Quitter · Purse: \d+$/.test(document.getElementById('who-line')?.textContent), null, { timeout: 5000 });
  const who = await page.textContent('#who-line');
  assert.ok(!who.includes('at table'), who);
  assert.ok(Number(who.match(/Purse: (\d+)/)[1]) >= 900, who);
  assert.deepEqual(page.errors, []);
  await context.close();
});

/** Leave on a chips table: the page says what the night came to and offers the way on; the Hall is one more tap (nothing sends them there). */
async function leaveToHall(page, { timeout = 15_000 } = {}) {
  await page.click('#leave');
  await page.waitForSelector('#table-end', { timeout });
  assert.match(await page.textContent('#te-summary'), /^Sat down with [\d,]+(, added [\d,]+)? · leaving with [\d,]+ \((even|[+−][\d,]+)\)$/);
  await page.click('#te-hall');
  await page.waitForURL(`${BASE}/`, { timeout });
}

/** Plays with whatever the page offers, through the page's own controls, until `done()`. */
async function playUntil(page, done, { limit = 120_000 } = {}) {
  const start = Date.now();
  let raised = false;
  let claimed = false;
  while (!(await done()) && Date.now() - start < limit) {
    const pick = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      if (q('#pass-confirm:not([disabled])')) return '#pass-confirm';
      if (q('#pass-fold') && !q('#pass-confirm')) return '#pass-fold';
      if (q('button.card.face:not(.chosen)')) return 'button.card.face:not(.chosen)';
      if (q('#move-row [data-action="match"], #actions [data-action="match"]')) return q('#move-row [data-action="match"]') ? '#move-row [data-action="match"]' : '#actions [data-action="match"]';
      if (q('#claim-confirm:not([disabled])')) return '#claim-confirm';
      if (q('#use-best')) return '#use-best';
      // Stop & claim is open with nothing true to pick: name the lowest claim there is.
      if (q('#claim-confirm[data-action="stop"]')) return q('.pick-row.ranks button') ? '.pick-row.ranks button' : '.pick-row.kinds button:not([disabled])';
      if (q('#stop-open')) return '#stop-open';
      if (q('#move-row [data-action="check"], #actions [data-action="check"]')) return q('#move-row [data-action="check"]') ? '#move-row [data-action="check"]' : '#actions [data-action="check"]';
      if (q('#move-row [data-action="fold"], #actions [data-action="fold"]')) return q('#move-row [data-action="fold"]') ? '#move-row [data-action="fold"]' : '#actions [data-action="fold"]';
      return null;
    });
    if (!pick) {
      await page.waitForTimeout(250);
      continue;
    }
    if (pick.includes('raise')) {
      if (raised) {
        const check = await page.$('#move-row [data-action="check"], #actions [data-action="check"]');
        if (check) await check.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(150);
        continue;
      }
      raised = true;
    }
    if (pick.includes('use-best')) claimed = true;
    await page.click(pick, { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  return { raised, claimed };
}

const TABLE_RE = /[?&]id=([0-9a-f]{64})/;

test('join → play a round → a second session watches and never sees a hand', { timeout: 240_000 }, async () => {
  // Player one arrives through the doorman.
  const player = await session();
  await player.page.emulateMedia({ reducedMotion: 'reduce' });
  const urls = [];
  player.page.on('request', (r) => urls.push(r.url()));
  await player.page.goto(BASE);
  await player.page.waitForSelector('#menu [data-id="who-new"]'); // the door (11-10): New here, or bringing a Player ID?
  await player.page.click('#menu [data-id="who-new"]');
  await player.page.waitForSelector('#seat-form:not([hidden])'); // a name
  await player.page.fill('#seat-name', 'Wanderer');
  await shot(player.page, 'room-take-a-seat');
  await player.page.click('#seat-form button[type="submit"]');
  // then the avatar, before the player is made. Adventurer is already picked.
  await player.page.waitForSelector('#looks:not([hidden])');
  assert.equal(await player.page.$$eval('#looks [data-look]', (els) => els.length), 9);
  assert.ok(await player.page.$('[data-look="halfhand"]'), 'the hooded look is offered, under its saved id');
  assert.equal((await player.page.textContent('[data-look="halfhand"]')).trim(), 'Hooded', 'and labelled for what it shows');
  assert.equal(await player.page.$('[data-look="clockwork"]'), null, 'Clockwork keeps the door');
  assert.equal(await player.page.$('[data-id="look-keep"]'), null, 'a new player has nothing to keep');
  assert.equal(await player.page.getAttribute('[data-look="adventurer"]', 'aria-pressed'), 'true');
  await shot(player.page, 'room-choose-look');
  await player.page.click('[data-look="pirate"]');
  assert.equal(await player.page.getAttribute('[data-look="pirate"]', 'aria-pressed'), 'true');
  assert.equal(await player.page.getAttribute('[data-look="adventurer"]', 'aria-pressed'), 'false');
  await player.page.click('[data-id="look-ok"]');
  await player.page.waitForSelector('#menu [data-id="seat"]');
  await takeSeat(player.page);
  await player.page.waitForSelector('#buyin-form:not([hidden])');
  await player.page.click('#menu [data-id="sit"]');
  await player.page.waitForURL(/\/table\?id=/);
  const tableId = player.page.url().match(TABLE_RE)[1];
  await player.page.waitForSelector('[data-plate="0"]');
  assert.match(await player.page.textContent('[data-plate="0"]'), /Wanderer/);

  // The room in another browser now shows the table, seats filled from the registry.
  const other = await session();
  await other.page.goto(BASE);
  await other.page.waitForFunction(() => /1 of 4 seated/.test(document.getElementById('spots').textContent), null, { timeout: 8000 });
  assert.ok(await other.page.$(`[data-table="${tableId}"]`), 'listed in Tables in play');
  await other.page.click('#dialogue-close');
  await shot(other.page, 'room-desktop');
  await other.context.close();

  // The watcher: a separate session, no token, watching the same table.
  const watcher = await session();
  const watcherResponses = [];
  const watcherUrls = [];
  watcher.page.on('request', (r) => watcherUrls.push(r.url()));
  watcher.page.on('response', async (r) => {
    if (r.url().includes('/tables/')) watcherResponses.push(await r.text().catch(() => ''));
  });
  await watcher.page.goto(`${BASE}/table?id=${tableId}&watch=1`);
  await watcher.page.waitForSelector('[data-plate="0"]');
  assert.equal(await watcher.page.textContent('#mode'), 'watching');

  // Bots fill the table when the lobby timer ends.
  await player.page.waitForSelector('button.card.face', { timeout: 40_000 });
  const seats = await player.page.$$eval('.seat-plate .name', (els) => els.map((e) => e.textContent));
  assert.deepEqual(seats, ['Wanderer', 'Tally', 'Brannock', 'Old Wick']);
  assert.equal(await player.page.$$eval('.card.face', (els) => els.length), 5, 'five face cards');
  assert.equal(await player.page.$$eval('[data-sprite="house"]', (els) => els.length), 3, 'three bots drawn');
  const tags = await player.page.$$eval('[data-plate="0"] .tag', (els) => els.map((e) => e.textContent));
  assert.deepEqual(tags, ['you'], 'a browser player is not tagged agent');
  assert.match(await player.page.$eval('#me-corner .face', (el) => el.style.backgroundImage), /seat-pirate/, 'the look they picked, on their corner portrait');
  await shot(player.page, 'table-desktop-pass');

  // Talk works, and a hostile line stays plain text.
  await player.page.waitForSelector('#quick button');
  await player.page.click('#quick button');
  await player.page.fill('#say-input', '<img src=x onerror=alert(1)>');
  await player.page.click('#say-form button[type="submit"]');
  await player.page.waitForFunction(() => /onerror/.test(document.getElementById('log').textContent));
  assert.equal(await player.page.$('#log img'), null, 'no markup from table talk');
  await watcher.page.waitForFunction(() => /onerror/.test(document.getElementById('log').textContent), null, { timeout: 8000 });
  assert.equal(await watcher.page.$('#log img'), null);

  // Play the first round through the page.
  await playUntil(player.page, async () => /Round 1 over|Round 2|closed/.test(await player.page.textContent('#phase')));
  assert.match(await player.page.textContent('#phase'), /Round 1 over|Round 2/);
  await shot(player.page, 'table-desktop-round-over');
  assert.ok((await player.page.textContent('#log')).includes('Round 1.'), 'the log shows the round');
  await watcher.page.waitForFunction(() => /Round 1 over|Round 2/.test(document.getElementById('phase').textContent), null, { timeout: 8000 });
  await shot(watcher.page, 'table-watching');

  // The watcher never saw a hand, in the page or on the wire, and never used a token.
  assert.ok(watcherResponses.length > 0, 'the watcher was polling');
  for (const body of watcherResponses) {
    assert.ok(!/"hand"|"hands"|"tokens"|"legal"/.test(body), 'no private field on the wire');
    // Once the round is over the deck is opened for all to recheck (the deck seal, 2026-11-07): that one part may hold cards, nothing else.
    const sealed = body.replace(/"opened":\{"seed":"[0-9a-f]{64}","deck":\[[^\]]*\]\}/, '"opened":"the deck, open"');
    assert.ok(!/"[2-9TJQKA][cdhs]"/.test(sealed), 'no card on the wire');
  }
  assert.ok(!watcherUrls.some((u) => /\/me(\?|$)/.test(u)), 'the watcher never asked for a hand');
  assert.equal(await watcher.page.$$eval('.card.face', (els) => els.length), 0);
  assert.equal(await watcher.page.$$eval('.card.back', (els) => els.length), 5, 'it sees sealed backs');
  assert.equal(await watcher.page.$('[data-card]'), null, 'no card element');
  const html = await watcher.page.content();
  assert.ok(!CARD_NAME.test(html), 'no card named anywhere in the page, including hidden labels');
  assert.equal(await watcher.page.$('#actions button'), null, 'a watcher has no controls');
  assert.equal(await watcher.page.$('#say-form:not([hidden])'), null, 'and no voice');
  const stored = await watcher.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hall.seat') || k === 'hall.player'));
  assert.deepEqual(stored, [], 'and no tokens');
  assert.deepEqual(watcher.page.errors, []);

  // Tokens never go in a URL.
  const stored2 = await player.page.evaluate(() => Object.values(localStorage));
  for (const secret of stored2.filter((v) => v.length > 40)) assert.ok(!urls.some((u) => u.includes(secret)), 'a token in a URL');
  assert.deepEqual(player.page.errors, []);
  await watcher.context.close();

  // A reload keeps the seat.
  await player.page.reload();
  await player.page.waitForSelector('.card.face', { timeout: 15_000 });
  assert.ok(await player.page.$('.seat-plate.mine'));
  await player.context.close();
});

test('phone table: cards fit and can be played; no sideways scroll', { timeout: 120_000 }, async () => {
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 11 } });
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('#join-form:not([hidden])');
  await page.fill('#join-name', 'Pocket');
  await page.tap('#join-form button[type="submit"]');
  await page.waitForSelector('button.card.face', { timeout: 15_000 });
  await page.waitForTimeout(300);
  assert.ok(await noSideScroll(page));
  await shot(page, 'table-phone');
  const cards = await page.$$eval('.card.face', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.width, r.height]; }));
  assert.equal(cards.length, 5);
  for (const [left, right, w, h] of cards) {
    assert.ok(left >= 0 && right <= 390, 'on screen');
    assert.ok(w >= 44 && h >= 44, `tappable: ${w}×${h}`);
  }
  await page.tap('button.card.face');
  await page.waitForSelector('#pass-confirm:not([disabled])');
  await shot(page, 'table-phone-picked');
  await page.tap('#pass-confirm');
  await page.waitForFunction(() => /Pass 2/.test(document.getElementById('phase').textContent), null, { timeout: 8000 });
  assert.ok(await noSideScroll(page));
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- two-step moves, pacing, next round ----------

/** Sits a fresh player down at a test table. Returns the page and a list of every /act body it sends. */
async function seated(test = {}, options = DESKTOP, name = 'Tester') {
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 11, ...test } });
  const s = await session(options);
  await s.page.goto(`${BASE}/table?id=${id}`);
  await s.page.fill('#join-name', name);
  await s.page.click('#join-form button[type="submit"]');
  await s.page.waitForSelector('button.card.face', { timeout: 15_000 });
  s.acts = [];
  s.page.on('request', (r) => { if (r.url().endsWith('/act')) s.acts.push(JSON.parse(r.postData())); });
  s.id = id;
  return s;
}

test('two steps to pass: a tap lifts a card and sends nothing; a second tap puts it back; the button sends it', { timeout: 60_000 }, async () => {
  const { context, page, acts } = await seated();
  assert.equal(await page.$eval('#pass-confirm', (b) => b.disabled), true, 'nothing picked yet');
  const code = await page.getAttribute('button.card.face', 'data-card');
  const flat = (await page.locator(`[data-card="${code}"]`).boundingBox()).y;

  await page.click(`[data-card="${code}"]`);
  assert.deepEqual(acts, [], 'a tap sends nothing');
  assert.equal(await page.getAttribute(`[data-card="${code}"]`, 'aria-pressed'), 'true');
  assert.equal((await page.textContent('#pass-confirm')).trim(), 'Pass');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(50);
  assert.ok((await page.locator(`[data-card="${code}"]`).boundingBox()).y < flat, 'lifted');
  await shot(page, 'table-desktop-picked');

  await page.waitForTimeout(1700); // a poll goes by: the pick stays
  assert.equal(await page.getAttribute(`[data-card="${code}"]`, 'aria-pressed'), 'true', 'a poll keeps the pick');

  await page.click(`[data-card="${code}"]`);
  assert.equal(await page.$eval('#pass-confirm', (b) => b.disabled), true, 'put back');
  await page.click(`[data-card="${code}"]`);
  await page.click('#pass-confirm');
  await page.waitForFunction(() => /Pass 2/.test(document.getElementById('phase').textContent));
  assert.deepEqual(acts, [{ action: 'pass', card: code }]);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the pass panel: pick a card, then Pass or Pass + raise, sent as one move, with no separate Raise button', { timeout: 60_000 }, async () => {
  const { context, page, acts } = await seated({ botDelayMs: [20_000, 20_000] }); // bots hold still
  assert.match(await page.textContent('#phase'), /Pass 1/);
  await page.waitForSelector('#pass-raise-amount');
  assert.equal(await page.$('#actions [data-action="raise"]'), null, 'no standalone Raise');
  assert.match(await page.textContent('#pass-confirm'), /Pick a card/);
  assert.equal(await page.$eval('#pass-confirm', (x) => x.disabled), true);
  assert.equal(await page.$eval('#pass-raise', (x) => x.disabled), true, 'no card, no raise');
  await page.fill('#pass-raise-amount', '7');
  assert.deepEqual(acts, [], 'typing an amount sends nothing');
  await page.waitForTimeout(1700);
  assert.equal(await page.inputValue('#pass-raise-amount'), '7', 'a poll keeps the amount');
  await page.click('[data-pass-raise-amount="10"]');
  assert.equal(await page.inputValue('#pass-raise-amount'), '10');
  assert.deepEqual(acts, [], 'a preset sends nothing either');
  await page.fill('#pass-raise-amount', '7');
  const card = await page.getAttribute('button.card.face', 'data-card');
  await page.click(`button.card.face[data-card="${card}"]`);
  await page.waitForFunction(() => document.getElementById('pass-confirm').textContent.trim() === 'Pass');
  assert.equal(await page.inputValue('#pass-raise-amount'), '7', 'picking a card keeps the amount');
  assert.equal((await page.textContent('#pass-raise')).trim(), 'Pass + raise 7');
  await shot(page, 'table-desktop-pass-panel');
  await page.click('#pass-raise');
  await page.waitForFunction(() => /Pass 1/.test(document.getElementById('phase').textContent) && /Raise 7/.test(document.getElementById('phase').textContent));
  assert.deepEqual(acts, [{ action: 'pass', card, raise: 7 }]);
  assert.equal(await page.$('#pass-raise'), null, 'one move a window');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('two steps to claim: kind, rank, then Make claim; Next round deals when pressed', { timeout: 120_000 }, async () => {
  const { context, page, acts } = await seated({ roundGapMs: 25_000 });
  await playUntil(page, async () => !!(await page.$('#claim-confirm')) || /over/.test(await page.textContent('#phase')));
  if (await page.$('#claim-confirm')) {
    assert.equal(await page.$eval('#claim-confirm', (b) => b.disabled), true);
    assert.equal(await page.$('#actions select'), null, 'no dropdown');
    const sent = acts.length;
    const kind = page.locator('[data-kind]:not([disabled])').first();
    await kind.click();
    assert.equal(acts.length, sent, 'picking sends nothing');
    assert.equal(await kind.getAttribute('aria-pressed'), 'true');
    if (await page.$('[data-rank]')) await page.locator('[data-rank]').last().click();
    if (await page.$eval('#claim-confirm', (b) => b.disabled)) await page.locator('[data-second]').first().click();
    assert.equal(acts.length, sent, 'still nothing sent');
    const label = (await page.textContent('#claim-confirm')).replace('Make claim: ', '');
    assert.match(await page.textContent('#claim-confirm'), /Make claim: /);
    await shot(page, 'table-desktop-claim-picked');
    await page.click('#claim-confirm');
    await page.waitForFunction(() => document.getElementById('claim-confirm') === null);
    assert.equal(acts.at(-1).action, 'claim');
    assert.equal(labelClaim(acts.at(-1).claim), label, 'what it said is what it sent');
  }
  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  await page.waitForSelector('[data-action="next"]');
  assert.match(await page.textContent('[data-action="next"]'), /Next round/, 'the after-round card deals the next round');
  assert.equal((await page.textContent('#clock')).trim(), '', 'one player: no countdown to the deal');
  await shot(page, 'table-desktop-next-round');
  await page.click('[data-action="next"]');
  await page.waitForFunction(() => /Round 2/.test(document.getElementById('phase').textContent));
  assert.deepEqual(acts.at(-1), { action: 'next' });
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('pace: bots take their time, with a ring on whoever is being waited on, and the ring empties', { timeout: 60_000 }, async () => {
  const { context, page } = await seated({ botDelayMs: [1500, 3000] });
  // Seats 1, 2 and 3 are thinking. I'm the only human, so mine has no number on it: the table waits for me.
  await page.waitForSelector('[data-ring="1"]');
  assert.equal(await page.$$eval('[data-ring]', (els) => els.length), 4);
  assert.equal(await page.textContent('[data-ring="0"]'), '');
  await page.waitForTimeout(500);
  await shot(page, 'table-desktop-rings');
  const bot = await page.evaluate(() => {
    const el = document.querySelector('[data-ring="1"], [data-ring="2"], [data-ring="3"]');
    return el ? [Number(el.style.getPropertyValue('--p')), Number(el.firstChild.textContent)] : null;
  });
  if (bot) {
    assert.ok(bot[0] < 1, `a bot's ring has moved: ${bot[0]}`);
    assert.ok(bot[1] >= 1 && bot[1] <= 3, `a bot's clock reads ${bot[1]}`);
  }
  // A bot's choice arrives between 1.5 and 3 s after dealing, by itself.
  await page.waitForFunction(() => document.querySelectorAll('[data-ring]').length === 1, null, { timeout: 6000 });
  assert.deepEqual(await page.$$eval('[data-ring]', (els) => els.map((e) => e.dataset.ring)), ['0'], 'just me now');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('talk line: shows who spoke with a small portrait, and the log does too', { timeout: 60_000 }, async () => {
  const { context, page } = await seated();
  assert.equal(await page.$('#talk-line:not([hidden])'), null, 'nothing said yet');
  await page.fill('#say-input', 'Evening, all.');
  await page.click('#say-form button[type="submit"]');
  await page.waitForSelector('#talk-line:not([hidden])');
  assert.match(await page.textContent('#talk-line'), /Tester: Evening, all\./);
  const face = await page.$eval('#talk-line .face', (el) => ({ image: el.style.backgroundImage, w: el.offsetWidth }));
  assert.match(face.image, /seat-adventurer/, "a visitor's portrait");
  assert.ok(face.w >= 20);
  assert.equal(await page.$$eval('#log .said .face', (els) => els.length), 1);
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- reading the table ----------

test('after a pass: a log line, cards that fly, a NEW badge for about 2 s, and a highlight that stays until the next pass', { timeout: 60_000 }, async () => {
  const { context, page } = await seated();
  assert.equal(await page.$('#pass-log li'), null);
  assert.equal(await page.$('.new-badge'), null);
  const sent = await page.getAttribute('button.card.face', 'data-card');
  await page.click(`[data-card="${sent}"]`);
  await page.click('#pass-confirm');

  await page.waitForSelector('.fly-card');
  assert.equal(await page.$$eval('.fly-card', (els) => els.length), 2, 'one out, one in');
  await page.waitForTimeout(150);
  await shot(page, 'table-pass-flying');

  await page.waitForSelector('#pass-log li');
  const line = await page.textContent('#pass-log li');
  assert.match(line, /^Pass 1: you sent \S+ → Tally · house, got \S+ ← Old Wick$/, line);
  const received = await page.$eval('.card.received', (el) => el.dataset.card);
  assert.notEqual(received, sent);
  assert.equal(await page.$eval('.card.new', (el) => el.dataset.card), received, 'the same card');
  assert.equal(await page.textContent('.new-badge'), 'NEW');
  await page.waitForSelector('.fly-card', { state: 'detached', timeout: 3000 });
  await shot(page, 'table-pass-new');

  // The badge goes after about 2 s. The outline doesn't.
  await page.waitForSelector('.new-badge', { state: 'detached', timeout: 4000 });
  assert.equal(await page.$('.card.new'), null);
  assert.equal(await page.$eval('.card.received', (el) => el.dataset.card), received, 'still marked as the new one');
  await page.waitForTimeout(1700); // a poll goes by
  assert.equal(await page.$eval('.card.received', (el) => el.dataset.card), received);
  await shot(page, 'table-pass-received');

  // The next pass moves the highlight on, and adds a line.
  const next = await page.$eval('button.card.face:not(.received)', (el) => el.dataset.card);
  await page.click(`[data-card="${next}"]`);
  await page.click('#pass-confirm');
  await page.waitForFunction(() => document.querySelectorAll('#pass-log li').length === 2);
  assert.equal(await page.$$eval('.card.received', (els) => els.length), 1, 'one at a time');
  assert.notEqual(await page.$eval('.card.received', (el) => el.dataset.card), received);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('NEW stays until the next pass if the tab was hidden when it came', { timeout: 60_000 }, async () => {
  const { context, page } = await seated();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await page.click('button.card.face');
  await page.click('#pass-confirm');
  await page.waitForSelector('.new-badge');
  await page.waitForTimeout(2600);
  assert.equal(await page.$$eval('.new-badge', (els) => els.length), 1, 'still there');
  await context.close();
});

test('a reload does not replay a pass: no flight and no badge, but the log and the outline are there', { timeout: 60_000 }, async () => {
  const { context, page } = await seated();
  await page.click('button.card.face');
  await page.click('#pass-confirm');
  await page.waitForSelector('#pass-log li');
  await page.reload();
  await page.waitForSelector('#pass-log li');
  assert.equal(await page.$('.fly-card'), null);
  assert.equal(await page.$('.new-badge'), null);
  assert.equal(await page.$$eval('.card.received', (els) => els.length), 1);
  await context.close();
});

test('seat tiles: backs count each seat\'s passes, an arrow shows the way round, and a watcher sees no card', { timeout: 60_000 }, async () => {
  const { context, page, id } = await seated();
  const count = (seat) => page.$$eval(`[data-plate="${seat}"] .tiny-back`, (els) => els.length);
  assert.equal(await count(0), 0);
  for (const [seat, to] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
    assert.equal(await page.getAttribute(`[data-plate="${seat}"] .pass-arrow`, 'data-to'), String(to), `seat ${seat}`);
  }
  assert.match(await page.getAttribute('[data-plate="0"] .pass-arrow', 'title'), /Passes to Tally/);
  assert.equal(await page.textContent('[data-plate="3"] .pass-arrow'), '↩', 'the last seat wraps round');

  await page.click('button.card.face');
  await page.click('#pass-confirm');
  await page.waitForFunction(() => document.querySelectorAll('[data-plate="2"] .tiny-back').length === 1);
  for (const seat of [0, 1, 2, 3]) assert.equal(await count(seat), 1, `seat ${seat}`);
  if (SHOTS) await page.locator('#plates').screenshot({ path: join(SHOTS, 'seat-tiles.png') });

  const watcher = await session();
  const bodies = [];
  watcher.page.on('response', async (r) => { if (r.url().includes('/tables/')) bodies.push(await r.text().catch(() => '')); });
  await watcher.page.goto(`${BASE}/table?id=${id}&watch=1`);
  await watcher.page.waitForFunction(() => document.querySelectorAll('[data-plate="2"] .tiny-back').length === 1);
  assert.equal(await watcher.page.$('#pass-log li'), null, 'no pass log for a watcher');
  assert.equal(await watcher.page.$('.card.received'), null);
  assert.ok(bodies.length > 0);
  for (const body of bodies) {
    assert.ok(!/passLog|"sent"|"got"/.test(body), 'no private field on the wire');
    assert.ok(!/"[2-9TJQKA][cdhs]"/.test(body), 'no card on the wire');
  }
  await watcher.context.close();
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('reduced motion: no flying cards, but the log and the highlight still work', { timeout: 60_000 }, async () => {
  const { context, page } = await seated();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.click('button.card.face');
  await page.click('#pass-confirm');
  await page.waitForSelector('#pass-log li');
  assert.equal(await page.$('.fly-card'), null);
  assert.equal(await page.$$eval('.card.received', (els) => els.length), 1);
  await context.close();
});

// ---------- the pot on the felt ----------

/** Collects every flying chip and +N label as it appears, so a test can check them after they've gone. */
const watchChips = () => {
  window.__moves = [];
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.classList?.contains('fly-chip')) window.__moves.push(n.dataset.kind);
        if (n.classList?.contains('chip-label')) window.__moves.push(`${n.dataset.kind}:${n.textContent}`);
      }
    }
  }).observe(document, { childList: true, subtree: true });
};

test('pot: a pile on the felt with its total, and chips that fly on ante, raise, match and win', { timeout: 120_000 }, async () => {
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 11, roundGapMs: 25_000 } });
  const { context, page } = await session();
  await page.addInitScript(watchChips);
  await page.goto(`${BASE}/table?id=${id}`);
  await page.fill('#join-name', 'Bettor');
  await page.click('#join-form button[type="submit"]');
  await page.waitForSelector('.pot-on-felt:not([hidden]) .pot-amount', { timeout: 15_000 });

  await page.waitForFunction(() => window.__moves.filter((m) => m === 'ante').length >= 1, null, { timeout: 5000 });
  assert.equal(await page.textContent('.pot-amount'), await page.textContent('#pot'), 'the same total as the top bar');
  assert.equal(await page.getAttribute('.pot-on-felt', 'data-tier'), 'small');

  await page.click('button.card.face');
  await page.waitForSelector('#pass-raise:not([disabled])');
  await page.fill('#pass-raise-amount', '10');
  await page.click('#pass-raise');
  await page.waitForFunction(() => window.__moves.includes('raise'), null, { timeout: 5000 });
  await page.waitForFunction(() => Number(document.querySelector('.pot-amount').textContent) >= 14);
  await page.waitForTimeout(150);
  await shot(page, 'table-pot-chips-flying');

  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  const result = await (await fetch(`${BASE}/tables/${id}`)).json();
  if (result.lastResult.awards.length) {
    await page.waitForFunction(() => window.__moves.includes('win'), null, { timeout: 5000 });
    const labels = await page.evaluate(() => window.__moves.filter((m) => m.startsWith('win:')));
    assert.deepEqual(labels, result.lastResult.awards.map((a) => `win:+${a.amount}`), 'one share for each winner, visibly');
  }
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('pot: small, medium and large piles, and carried chips in their own small pile', { timeout: 60_000 }, async () => {
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 11 } });
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page } = await session(options);
    let fake = { pot: 8, carried: 0 };
    await page.route(`**/tables/${id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, ...fake, seats: body.seats } });
    });
    await page.goto(`${BASE}/table?id=${id}&watch=1`);
    await page.waitForSelector('.pot-on-felt:not([hidden])');
    for (const [pot, tier] of [[8, 'small'], [30, 'medium'], [80, 'large']]) {
      fake = { pot, carried: 0 };
      await page.waitForFunction((p) => document.querySelector('.pot-amount')?.textContent === String(p), pot, { timeout: 6000 });
      assert.equal(await page.getAttribute('.pot-on-felt', 'data-tier'), tier);
      assert.equal(await page.getAttribute('.piles > .pile', 'data-tier'), tier);
      assert.match(await page.$eval('.piles > .pile', (el) => el.style.backgroundImage), new RegExp(`pot-${tier}`));
      assert.equal(await page.textContent('#pot'), String(pot), 'the top bar still says it');
      await shot(page, `table-pot-${tier}-${name}`);
    }
    fake = { pot: 37, carried: 7 };
    await page.waitForSelector('.carried');
    assert.match(await page.textContent('.carried-label'), /carried 7/);
    assert.equal(await page.textContent('.pot-amount'), '37', 'the total counts everything');
    await shot(page, `table-pot-carried-${name}`);
    fake = { pot: 0, carried: 0 };
    await page.waitForSelector('.pot-on-felt', { state: 'hidden', timeout: 6000 });
    await context.close();
  }
});

test('pot: with no art, coins from the code-drawn set stand in', { timeout: 60_000 }, async () => {
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 12 } });
  await apiPost(`/tables/${id}/join`, { name: 'Somebody' });
  const { context, page } = await session();
  await page.route('**/art/hall/pot-*.png', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await page.goto(`${BASE}/table?id=${id}&watch=1`);
  await page.waitForSelector('.coin-pile img');
  assert.equal(await page.$('.sprite-pile'), null);
  await context.close();
});

// ---------- fonts and cards ----------

test('fonts and tokens: Cinzel, Alegreya SC, Alegreya, carved buttons in both rooms; card fronts sized for the screen', { timeout: 120_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    {
      const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 7 } });
      const { context, page } = await session(options);
      const fontsLoaded = [];
      page.on('request', (r) => { if (r.url().includes('fonts.googleapis')) fontsLoaded.push(r.url()); });
      await page.goto(BASE);
      await page.waitForSelector('#dialogue:not([hidden])');
      await page.waitForFunction(() => document.getElementById('line').textContent === 'New here, or bringing a Player ID?'); // the door, on a first visit (who first, 11-10)
      await page.evaluate(() => document.fonts.ready);
      assert.match(await page.$eval('.title', (el) => getComputedStyle(el).fontFamily), /Cinzel/);
      for (const label of ['.btn', '.menu-item', '#speaker', '.box-title']) assert.match(await page.$eval(label, (el) => getComputedStyle(el).fontFamily), /Alegreya SC/, label);
      assert.match(await page.$eval('#line', (el) => getComputedStyle(el).fontFamily), /^Alegreya,/);
      for (const selector of ['.btn', '#line', '.title']) assert.match(await page.$eval(selector, (el) => getComputedStyle(el).fontVariantNumeric), /lining-nums/, `${selector}: 0 must not read as o`);
      assert.ok(fontsLoaded.every((url) => !/Pixelify|Atkinson/.test(url)));
      const token = (selector) => page.$eval(selector, (el) => {
        const style = getComputedStyle(el);
        return { radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow, image: style.backgroundImage };
      });
      const carved = (look, what) => {
        assert.ok(look.radius >= 8, `${what}: radius ${look.radius}`);
        assert.match(look.shadow, /inset/, `${what}: bevel`);
        assert.match(look.image, /linear-gradient/, `${what}: wood`);
      };
      carved(await token('.btn'), 'room button');
      carved(await token('.menu-item'), 'room menu');
      await shot(page, `room-${name}`);
      assert.ok(await noSideScroll(page));

      await page.goto(`${BASE}/table?id=${id}`);
      await page.fill('#join-name', 'Reader');
      await page.click('#join-form button[type="submit"]');
      await page.waitForSelector('button.card.face', { timeout: 15_000 });
      await page.waitForTimeout(300);
      await shot(page, `table-pass-${name}`);
      assert.ok(await noSideScroll(page));
      carved(await token('.btn'), 'table button');
      // The move row's buttons are the table's own: chunky, a hard shadow with no blur, bright on the muted table (11-05 redesign).
      const pass = await token('#move-row #pass-confirm');
      assert.ok(pass.radius >= 4, `table move: radius ${pass.radius}`);
      assert.match(pass.shadow, /0px [2-6]px 0px/, `table move: a hard shadow, ${pass.shadow}`);
      for (const label of ['.btn', '.box-title', '.seat-plate .name']) assert.match(await page.$eval(label, (el) => getComputedStyle(el).fontFamily), /Alegreya SC/, label);
      assert.match(await page.$eval('#log', (el) => getComputedStyle(el).fontFamily), /^Alegreya,/);
      {
        const look = await page.$eval('button.card.face', (el) => {
          const style = getComputedStyle(el);
          return { image: style.backgroundImage, radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow };
        });
        assert.match(look.image, /art\/cards\/cards\.png/);
        assert.ok(look.radius >= 3, `radius ${look.radius}`);
        assert.ok(look.shadow !== 'none');
        const cards = await page.$$eval('button.card.face', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, e.offsetWidth, e.offsetHeight]; })); // the hand is fanned: its own size, not the tilted box
        for (const [left, right, w, h] of cards) {
          assert.ok(left >= 0 && right <= options.viewport.width, 'on screen');
          assert.ok(w >= 44 && h >= 44, `tappable: ${w}×${h}`);
          assert.ok(Math.abs(h / w - 120 / 84) < 0.02, 'not stretched');
        }
        if (name === 'phone') {
          assert.equal(cards[0][2], 56, 'a phone at 3× lands one art pixel on one device pixel');
          const small = await page.$$eval('.seat-plate .name, .btn, .box-title, #phase, .pot-amount', (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
          assert.ok(Math.min(...small) >= 12, `smallest label ${Math.min(...small)}px`);
        }
        if (SHOTS) await page.locator('#hand-box').screenshot({ path: join(SHOTS, `card-fronts-${name}.png`) });
      }
      assert.deepEqual(page.errors, []);
      await context.close();
    }
  }
});

// ---------- solo and mixed tables ----------

test('solo table: no countdown, nobody goes away, and no auto-deal: it waits for Next round', { timeout: 120_000 }, async () => {
  const { context, page } = await seated({ turnMs: 500, roundGapMs: 500 });
  await page.waitForTimeout(1300);
  assert.equal(await page.$('.tag.away'), null);
  assert.match(await page.textContent('#phase'), /Pass 1/, 'still my move');
  assert.equal((await page.textContent('#clock')).trim(), '', 'no countdown');
  assert.equal(await page.textContent('[data-ring="0"]'), '', 'the ring shows whose turn it is, with no number');
  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  await page.waitForSelector('[data-action="next"]');
  assert.match(await page.textContent('#turn-line'), /when you’re ready/);
  await page.waitForTimeout(1000);
  assert.match(await page.textContent('#phase'), /Round 1 over/, 'no auto-deal');
  await shot(page, 'table-solo-next-round');
  await page.click('[data-action="next"]');
  await page.waitForFunction(() => /Round 2/.test(document.getElementById('phase').textContent));
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('mixed table: the clock runs out, you are marked Away, and "I\'m back" returns you', { timeout: 120_000 }, async () => {
  const { id } = await apiPost('/tables', { lobbySeconds: 1, test: { rng: 9, turnMs: 1500, roundGapMs: 25_000 } });
  const { context, page } = await session();
  await page.goto(`${BASE}/table?id=${id}`);
  await page.fill('#join-name', 'Drifter');
  await page.click('#join-form button[type="submit"]');
  await page.waitForSelector('[data-plate="0"]');
  await apiPost(`/tables/${id}/join`, { name: 'Other Agent' });
  await page.waitForSelector('[data-ring="0"]', { timeout: 10_000 });
  const seconds = Number(await page.textContent('[data-ring="0"]'));
  assert.ok(seconds >= 1 && seconds <= 2, `a countdown: ${seconds}`);

  await page.waitForSelector('[data-plate="0"] .tag.away', { timeout: 10_000 });
  await page.waitForSelector('#actions [data-action="back"]');
  assert.match(await page.textContent('#actions [data-action="back"]'), /I’m back/);
  assert.ok((await page.textContent('#log')).includes('Drifter timed out and is marked away.'));
  // Away is not folded, unless there's a raise to answer: someone away can only fold to it.
  if ((await page.textContent('[data-plate="0"]')).includes('folded')) assert.match(await page.textContent('#log'), /Drifter folds|raises to \d+\./);
  assert.ok(!(await page.textContent('#log')).includes('Drifter raises'), 'never raised for them');
  await page.waitForFunction(() => /Next round in \d+s/.test(document.getElementById('clock').textContent), null, { timeout: 10_000 });
  await shot(page, 'table-away');

  await page.click('#actions [data-action="back"]');
  await page.waitForFunction(() => document.querySelector('[data-plate="0"] .tag.away') === null);
  assert.ok((await page.textContent('#log')).includes('Drifter is back.'));
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- art ----------

const manifest = JSON.parse(readFileSync(new URL('../public/art/hall/manifest.json', import.meta.url)));

test('painted room: V1 is the background, hotspots sit where the config says, with a stone fill beside it', async () => {
  const { ART } = await import('../public/js/hall-config.js');
  const { context, page } = await session();
  await page.goto(BASE);
  await page.waitForSelector('#dialogue:not([hidden])');
  await page.click('#dialogue-close');
  await page.waitForSelector('.spot');
  assert.match(await page.$eval('#room', (el) => el.style.backgroundImage), new RegExp(`room-${ART.room}`));
  const box = await page.locator('#room').boundingBox();
  assert.equal(box.width, 576);
  assert.equal(box.x, (1280 - 576) / 2, 'centred');
  assert.match(await page.$eval('#stage', (el) => el.style.backgroundImage), /side\.png/);
  for (const [id, [x, y, w, h]] of Object.entries(ART.rooms[ART.room].hotspots)) {
    const selector = id === 'cage' ? '[data-hotspot="cage"]' : `.spot[data-game="${id}"]`;
    const spot = await page.locator(selector).boundingBox();
    assert.deepEqual([spot.x - box.x, spot.y - box.y, spot.width, spot.height], [x, y, w, h], id);
    assert.ok(x >= 0 && y >= 0 && x + w <= manifest.rooms.v1.w && y + h <= manifest.rooms.v1.h, `${id} inside the image`);
  }
  await page.click('[data-hotspot="cage"]');
  await page.waitForFunction(() => /cage/.test(document.getElementById('line').textContent));
  await page.click('#dialogue-close');
  if (SHOTS) {
    await page.locator('#stage').screenshot({ path: join(SHOTS, 'room-desktop-full.png') });
    await page.locator('.midnight-link').screenshot({ path: join(SHOTS, 'footer-midnight.png') });
  }
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('painted room, phone: full width and scrollable, with no sideways scroll; every hotspot is tappable', async () => {
  for (const options of [PHONE, { ...PHONE, viewport: { width: 360, height: 760 } }]) {
    const { context, page } = await session(options);
    await page.goto(BASE);
    await page.click('#dialogue-close');
    await page.waitForSelector('.spot');
    const box = await page.locator('#room').boundingBox();
    assert.ok(box.width >= options.viewport.width - 8, `room is ${box.width} wide on a ${options.viewport.width} screen`);
    assert.ok(box.height > options.viewport.height / 2);
    assert.ok(await noSideScroll(page));
    for (const b of await page.$$eval('.spot, .hotspot', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, r.left, r.right]; }))) {
      assert.ok(b[0] >= 44 && b[1] >= 44, `tap target ${b[0]}×${b[1]}`);
      assert.ok(b[2] >= 0 && b[3] <= options.viewport.width, 'on screen');
    }
    if (options === PHONE && SHOTS) await page.locator('#stage').screenshot({ path: join(SHOTS, 'room-phone-full.png') });
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('painted table: the characters sit behind the felt rail, in their chairs', { timeout: 60_000 }, async () => {
  const { context, page } = await seated({ roundGapMs: 25_000 });
  assert.match(await page.$eval('#scene', (el) => el.style.backgroundImage), /table\.png/);
  const sprites = await page.$$eval('[data-sprite]', (els) => els.map((e) => [e.dataset.seat, e.style.backgroundImage]));
  assert.equal(sprites.length, 3, 'the other three: the player looks across at them');
  assert.ok(sprites.every(([, image]) => image.includes('/art/hall/seat-')), 'painted sprites');
  await shot(page, 'table-desktop-pass');
  const stack = await page.evaluate(() => [getComputedStyle(document.querySelector('.scene .front')).zIndex, getComputedStyle(document.querySelector('[data-sprite]')).zIndex].map(Number));
  assert.ok(stack[0] > stack[1], 'the rail is in front');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('missing art falls back to the code-drawn set, file by file', { timeout: 60_000 }, async () => {
  // No manifest at all: everything is code-drawn, as it was.
  {
    const { context, page } = await session();
    await page.route('**/art/hall/**', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await page.goto(BASE);
    await page.waitForSelector('.spot');
    assert.match(await page.$eval('#room', (el) => el.style.backgroundImage), /room-wide/);
    assert.equal(await page.$$eval('.spot.soon .rope', (els) => els.length), 3, 'three spots roped off');
    assert.equal(await page.$('[data-hotspot="cage"]'), null);
    assert.equal(await page.$eval('#doorman', (el) => el.style.backgroundImage), '', 'the stylesheet draws the doorman');
    await context.close();
  }
  // One file gone: only that one falls back.
  {
    const { context, page } = await session();
    await page.route('**/art/hall/seat-brannock.png', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await page.route('**/art/hall/room-v1.png', (route) => route.fulfill({ status: 404, body: 'nope' }));
    const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 5 } });
    await page.goto(BASE);
    await page.waitForSelector('.spot');
    assert.match(await page.$eval('#room', (el) => el.style.backgroundImage), /room-wide/, 'the room image is gone: the drawn room');
    await page.goto(`${BASE}/table?id=${id}`);
    await page.fill('#join-name', 'Fallback');
    await page.click('#join-form button[type="submit"]');
    await page.waitForSelector('[data-sprite="house"]', { timeout: 15_000 });
    const images = await page.$$eval('[data-sprite]', (els) => els.map((e) => e.style.backgroundImage));
    assert.ok(images.some((i) => i.includes('/art/seat-brannock.png')), images.join());
    assert.ok(images.some((i) => i.includes('/art/hall/seat-oldwick.png')), 'the others stay painted');
    await context.close();
  }
});

test('a saved Clockwork player is asked for a new look at the Hall (retired); a table reached straight by its link still seats them as they are', { timeout: 60_000 }, async () => {
  const saved = await apiPost('/players', { name: 'Old Purse', testChips: 300, testSavedAvatar: 'clockwork' });
  const { context, page } = await session();
  await page.addInitScript((token) => localStorage.setItem('hall.player', token), saved.token);
  // the table first, by its link: the server keeps the look at chips tables (the Hall is where it's asked)
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 5 } });
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('#join-form button[type="submit"]');
  await page.click('#join-form button[type="submit"]');
  await page.waitForSelector('#me-corner .face', { timeout: 15_000 });
  assert.match(await page.$eval('#me-corner .face', (el) => el.style.backgroundImage), /seat-clockwork\.png/);
  // the Hall: retired, pick a new one
  await page.goto(BASE);
  await page.waitForSelector('#looks:not([hidden])');
  await page.waitForFunction(() => document.getElementById('line').textContent.trim() === 'Your look has been retired: pick a new one.');
  assert.equal(await page.$('[data-look="clockwork"]'), null, 'not offered');
  assert.equal(await page.$$eval('#looks [data-look]', (els) => els.length), 9);
  assert.equal(await page.$('[data-id="look-keep"]'), null, 'nothing to keep');
  await shot(page, 'room-retired-look');
  await page.click('#looks [data-look="mage"]');
  await page.click('[data-id="look-ok"]');
  await page.waitForSelector('#looks', { state: 'hidden' });
  const me = await (await fetch(`${BASE}/players/me`, { headers: { authorization: `Bearer ${saved.token}` } })).json();
  assert.equal(me.avatar, 'mage');
  await context.close();
});

/** One page and three agents at a table of four, in the third pass window. The page holds seat 0, so seat 3 acts just before it. */
async function pageAtStopWindow(options) {
  const { id } = await apiPost('/tables', { lobbySeconds: 60, test: { rng: 21 } });
  const s = await session(options);
  await s.page.goto(`${BASE}/table?id=${id}`);
  await s.page.fill('#join-name', 'Tester');
  await s.page.click('#join-form button[type="submit"]');
  await s.page.waitForSelector('#join-form', { state: 'hidden', timeout: 15_000 }).catch(() => {});
  const agents = [];
  for (const name of ['One', 'Two', 'Three']) {
    const joined = await apiPost(`/tables/${id}/join`, { name });
    agents.push(joined);
  }
  const headers = (seat) => ({ authorization: `Bearer ${agents[seat - 1].token}` });
  const agentAct = async (seat, body) => (await fetch(`${BASE}/tables/${id}/act`, { method: 'POST', headers: headers(seat), body: JSON.stringify(body) })).json();
  const agentMe = async (seat) => (await fetch(`${BASE}/tables/${id}/me`, { headers: headers(seat) })).json();
  await s.page.waitForSelector('button.card.face', { timeout: 15_000 });
  for (let window = 1; window <= 2; window++) {
    await s.page.click('button.card.face');
    await s.page.click('#pass-confirm');
    for (const seat of [1, 2, 3]) await agentAct(seat, { action: 'pass', card: (await agentMe(seat)).hand[0] });
    await s.page.waitForSelector('button.card.face:not(.chosen)', { timeout: 15_000 });
  }
  await s.page.waitForSelector('#stop-open', { timeout: 15_000 });
  return { ...s, id, agentAct, agentMe };
}

for (const [where, options] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  test(`stop & claim, ${where}: claim and raise chosen together, one action, and an all-fold win shows the claim`, { timeout: 90_000 }, async () => {
    const { context, page, agentAct } = await pageAtStopWindow(options);
    assert.match(await page.textContent('#stop-open'), /^Stop & claim$/);
    assert.equal(await page.$('#claim-picker'), null, 'nothing to pick until you ask');
    assert.equal(await page.$('#best-true'), null, 'and the pass panel stays short');
    const acts = [];
    page.on('request', (r) => { if (r.url().endsWith('/act')) acts.push(JSON.parse(r.postData())); });

    await page.click('#stop-open');
    assert.ok(await page.$('#claim-picker'));
    assert.ok(await page.$('#stake-row'));
    assert.ok(await page.$('#best-true'));
    assert.equal(await page.$('#stop-open'), null);
    assert.equal(await page.$eval('#claim-confirm', (b) => [b.disabled, b.textContent].join()), 'true,Pick a claim');
    assert.deepEqual(await page.$$eval('#stake-row button', (els) => els.map((b) => b.textContent)), ['No raise', 'Raise']);
    await page.click('#stop-cancel');
    assert.ok(await page.$('#stop-open'), 'you can back out');
    assert.deepEqual(acts, []);

    await page.click('#stop-open');
    await page.click('[data-stake="raise"]');
    await page.click('[data-raise-amount="10"]');
    await page.click('[data-kind="7"]');
    await page.click('[data-rank="14"]');
    assert.match(await page.textContent('#claim-confirm'), /^Stop & claim: .*\+ raise to 10$/);
    await shot(page, `stop-claim-${where}`);
    assert.ok(await noSideScroll(page));
    await page.click('#claim-confirm');
    await page.waitForFunction(() => !document.getElementById('claim-picker'));
    assert.deepEqual(acts, [{ action: 'stop', claim: [7, 14, 0], raise: 10 }], 'one move');

    for (const seat of [1, 2, 3]) await agentAct(seat, { action: 'fold' });
    await page.waitForFunction(() => /everyone else folded/.test(document.getElementById('round-result').textContent));
    const line = await page.textContent('#round-result');
    assert.match(line, /Tester takes \d+ · .*(Aces|Ace)/i, line);
    assert.match(await page.textContent('#turn-line'), /Deal when you’re ready|next round deals itself/);
    await shot(page, `stop-all-fold-${where}`);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  test(`facing a stopper's raise, ${where}: Stay in for 10, or fold, with claim, call and check`, { timeout: 90_000 }, async () => {
    const { context, page, agentAct } = await pageAtStopWindow(options);
    assert.ok((await agentAct(3, { action: 'stop', claim: [1, 9], raise: 10 })).state);
    await page.waitForFunction(() => document.getElementById('facing-big')?.textContent === 'Stay in for 10, or fold');
    assert.match(await page.textContent('#to-beat'), /Three/);
    assert.deepEqual(await page.$$eval('#stake-row button', (els) => els.map((b) => b.textContent)), ['Stay in for 10', 'Raise', 'Fold']);
    assert.match(await page.textContent('#move-row [data-action="call"]'), /^Call Three: pair of 9s \+ 10 to stay in$/);
    assert.equal(await page.textContent('#move-row [data-action="check"]'), 'Check + 10 to stay in');
    assert.ok(await page.$('#claim-picker'), 'and a claim above it');
    assert.equal(await page.$('[data-kind="1"][disabled]'), null);
    await shot(page, `stop-facing-${where}`);
    assert.ok(await noSideScroll(page));
    await page.click('#move-row [data-action="check"]');
    await page.waitForFunction(() => document.getElementById('facing-big')?.textContent !== 'Stay in for 10, or fold');
    assert.deepEqual(page.errors, []);
    await context.close();
  });
}

for (const [where, options] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  test(`after-lap call, ${where}: the last seat's raised claim can be called, with a match or a fold`, { timeout: 90_000 }, async () => {
    const { id } = await apiPost('/tables', { lobbySeconds: 60, test: { rng: 21 } });
    const { context, page } = await session(options);
    await page.goto(`${BASE}/table?id=${id}`);
    await page.fill('#join-name', 'Tester');
    await page.click('#join-form button[type="submit"]');
    await page.waitForTimeout(800);
    const tokens = [];
    for (const name of ['One', 'Two', 'Three']) tokens.push((await apiPost(`/tables/${id}/join`, { name })).token);
    const headers = (seat) => ({ authorization: `Bearer ${tokens[seat - 1]}` });
    const agentAct = async (seat, body) => (await fetch(`${BASE}/tables/${id}/act`, { method: 'POST', headers: headers(seat), body: JSON.stringify(body) })).json();
    const agentMe = async (seat) => (await fetch(`${BASE}/tables/${id}/me`, { headers: headers(seat) })).json();
    await page.waitForSelector('button.card.face', { timeout: 15_000 });
    for (let window = 1; window <= 5; window++) {
      await page.click('button.card.face');
      await page.click('#pass-confirm');
      for (const seat of [1, 2, 3]) await agentAct(seat, { action: 'pass', card: (await agentMe(seat)).hand[0] });
      if (window < 5) await page.waitForSelector('button.card.face:not(.chosen)', { timeout: 15_000 });
    }
    await page.waitForSelector('#move-row [data-action="check"]', { timeout: 15_000 });
    await page.click('#move-row [data-action="check"]');
    for (const seat of [1, 2]) await agentAct(seat, { action: 'check' });
    await agentAct(3, { action: 'claim', claim: [7, 14], raise: 12 });
    await page.waitForSelector('#answer-line', { timeout: 15_000 });
    assert.match(await page.textContent('#turn-line'), /you can call a claim/);
    assert.deepEqual(await page.$$eval('#move-row button[data-action], #actions button[data-action]', (els) => els.map((b) => b.textContent)), [
      'Stay in for 12', 'Fold', 'Call Three: four Aces + 12 to stay in', 'Call Three: four Aces, then fold',
    ]);
    await shot(page, `after-lap-call-${where}`);
    assert.ok(await noSideScroll(page));
    const acts = [];
    page.on('request', (r) => { if (r.url().endsWith('/act')) acts.push(JSON.parse(r.postData())); });
    await page.click('[data-action="call"][data-with="match"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="call"]'));
    assert.deepEqual(acts, [{ action: 'call', seat: 3, match: true }]);
    assert.deepEqual(page.errors, []);
    await context.close();
  });
}

test('the name Clockwork: the room refuses it to a new player, and says why', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  await page.goto(BASE);
  await page.waitForSelector('#menu [data-id="who-new"]');
  await page.click('#menu [data-id="who-new"]');
  await page.waitForSelector('#seat-form:not([hidden])');
  await page.fill('#seat-name', 'Clockwork');
  await page.click('#seat-form button[type="submit"]');
  await page.click('#looks [data-look="adventurer"]'); // the name is checked when the player is made
  await page.click('#menu [data-id="look-ok"]');
  await page.waitForFunction(() => /keeps the door here/.test(document.getElementById('line').textContent));
  assert.equal(await page.$('#looks:not([hidden])'), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.player')), null, 'no player made');
  await context.close();
});

test('alternate room: the config switch uses V2 and its own hotspots', async () => {
  const { ART } = await import('../public/js/hall-config.js');
  const source = readFileSync(new URL('../public/js/hall-config.js', import.meta.url), 'utf8');
  const { context, page } = await session();
  await page.route('**/js/hall-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: source.replace("room: 'v1'", "room: 'v2'") }));
  await page.goto(BASE);
  await page.click('#dialogue-close');
  await page.waitForSelector('.spot');
  assert.match(await page.$eval('#room', (el) => el.style.backgroundImage), /room-v2/);
  const room = await page.locator('#room').boundingBox();
  const spot = await page.locator('.spot[data-game="sealed-hand"]').boundingBox();
  assert.equal(spot.x - room.x, ART.rooms.v2.hotspots['sealed-hand'][0]);
  await shot(page, 'room-desktop-v2');
  await context.close();
});

// ---------- Midnight marks ----------

const near = (a, b, within = 0.02) => Math.abs(a - b) <= within * b;

test('Midnight: official files, unstretched: the footer link in white, small symbols in the room, and the rug mark', async () => {
  const { ART } = await import('../public/js/hall-config.js');
  const { context, page } = await session();
  await page.goto(BASE);
  await page.click('#dialogue-close');
  await page.waitForSelector('.hall-mark');

  // No wordmark in the room: only the symbol, small and quiet, and no shape changed.
  assert.equal(await page.$('.banner'), null);
  assert.equal(await page.$('#room img[src*="Stacked"]'), null);
  const marks = await page.$$eval('.hall-mark', (els) => els.map((el) => {
    const style = getComputedStyle(el);
    return { src: el.dataset.src, opacity: Number(style.opacity), w: el.offsetWidth, h: el.offsetHeight, transform: style.transform, tint: getComputedStyle(el, '::before').backgroundColor, forGame: el.dataset.for };
  }));
  assert.equal(marks.length, ART.rooms[ART.room].marks.length);
  assert.equal(marks.length, 2, 'two marks, each at a way in (11-08 pass #26)');
  assert.deepEqual(marks.map((m) => m.forGame).sort(), ['cage', 'cup-and-claim']);
  for (const mark of marks) {
    assert.equal(mark.src, '/brand/midnight/Midnight-RGB_Symbol-White.svg');
    assert.ok(mark.opacity > 0 && mark.opacity <= 0.6, `opacity ${mark.opacity}`);
    assert.equal(mark.w, mark.h, 'not stretched');
    assert.ok(mark.w <= 16, `small: ${mark.w}`);
    assert.equal(mark.transform, 'none', 'not distorted');
    assert.equal(mark.tint, 'rgb(185, 176, 236)', 'soft silver-violet, not gold');
  }
  // A mark brightens while the way in it belongs to is hovered, and goes quiet again after.
  const markOpacity = (game) => page.$eval(`.hall-mark[data-for="${game}"]`, (el) => Number(getComputedStyle(el).opacity));
  await page.hover('.hotspot-cage');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.hall-mark[data-for="cage"]')).opacity) > 0.9);
  assert.ok((await markOpacity('cup-and-claim')) < 0.6, 'only the hovered way in wakes its mark');
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.hall-mark[data-for="cage"]')).opacity) < 0.6);

  const footer = await page.locator('.midnight-link');
  assert.equal(await footer.getAttribute('href'), 'https://midnight.network');
  const logo = footer.locator('img');
  const logoBox = await logo.boundingBox();
  assert.ok(near(logoBox.width / logoBox.height, 1583.47 / 343.01), `footer ratio ${logoBox.width / logoBox.height}`);
  const rugBox = await page.locator('.rug-mark').boundingBox();
  assert.equal(rugBox.width, rugBox.height);
  assert.equal(await page.$eval('.rug-mark', (el) => getComputedStyle(el).opacity), String(ART.midnight.rugOpacity));
  assert.equal(await page.$eval('.rug-mark', (el) => getComputedStyle(el).filter), 'none');

  // The white comes from a <style> inside the file, so a page policy that blocks it would turn the logo black.
  const res = await fetch(`${BASE}/brand/midnight/Midnight-RGB_Symbol-White.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /svg/);
  assert.match(res.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  const whitest = await page.evaluate(async () => {
    const img = document.querySelector('.midnight-link img');
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 300;
    canvas.height = img.naturalHeight || 65;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
    let best = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) best = Math.max(best, Math.min(data[i], data[i + 1], data[i + 2]));
    return best;
  });
  assert.equal(whitest, 255, 'the logo renders white');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('Midnight: the toggles turn the marks and rug off, and the card back is a setting', { timeout: 60_000 }, async () => {
  const source = readFileSync(new URL('../public/js/hall-config.js', import.meta.url), 'utf8');
  const off = source.replace('marks: true, rug: true', 'marks: false, rug: false').replace("cardBack: 'midnight'", "cardBack: 'seal'");
  assert.notEqual(off, source);
  const { id } = await apiPost('/tables', { lobbySeconds: 5, test: { rng: 6 } });

  const on = await session();
  await on.page.goto(`${BASE}/table?id=${id}&watch=1`);
  await on.page.waitForSelector('.card.back');
  assert.equal(await on.page.$$eval('.card.back.midnight img', (els) => els.filter((e) => e.src.endsWith('Midnight-RGB_Symbol-White.svg')).length), 5, 'default: the Midnight symbol');
  const back = await on.page.locator('.card.back').first().boundingBox();
  const symbol = await on.page.locator('.card.back img').first().boundingBox();
  assert.equal(symbol.width, symbol.height, 'not stretched');
  assert.ok(near(symbol.x + symbol.width / 2, back.x + back.width / 2) && near(symbol.y + symbol.height / 2, back.y + back.height / 2), 'centred');
  assert.ok(symbol.width <= back.width * 0.6, 'with clear space');
  await shot(on.page, 'table-watching-midnight-back');
  await on.context.close();

  const { context, page } = await session();
  await page.route('**/js/hall-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: off }));
  await page.goto(BASE);
  await page.waitForSelector('.spot');
  assert.equal(await page.$('.hall-mark'), null);
  assert.equal(await page.$('.rug-mark'), null);
  await page.goto(`${BASE}/table?id=${id}&watch=1`);
  await page.waitForSelector('.card.back');
  assert.equal(await page.$('.card.back.midnight'), null, 'the wax hand instead');
  assert.equal(await page.$eval('.card.back', (el) => el.style.getPropertyValue('--row')), '4');
  await context.close();
});

// ---------- radio ----------

test('radio: hidden with no stream address, and the pages allow no outside audio', async () => {
  const { context, page } = await session();
  const res = await page.goto(BASE);
  assert.ok(!/media-src/.test(res.headers()['content-security-policy']));
  await page.waitForSelector('.spot');
  assert.equal(await page.$('#radio'), null, 'no radio until there is a stream address');
  await context.close();
});

test('radio: with an address, off by default and fetching nothing, until toggled', { timeout: 120_000 }, async () => {
  const port = PORT + 2;
  await startServer(port, ['--var', 'RADIO_URL:https://radio.test/stream.mp3', '--var', 'RADIO_CREDIT:Test Radio, by permission']);
  const { context, page } = await session();
  const asked = [];
  await page.route('https://radio.test/**', (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  const res = await page.goto(`http://127.0.0.1:${port}/`);
  assert.match(res.headers()['content-security-policy'], /media-src https:\/\/radio\.test;/);
  await page.click('#dialogue-close');
  await page.waitForSelector('#radio:not([hidden])');
  assert.equal(await page.getAttribute('#radio-toggle', 'aria-pressed'), 'false');
  assert.equal(await page.textContent('#radio-credit'), 'Test Radio, by permission');
  await page.waitForTimeout(300);
  assert.deepEqual(asked, [], 'nothing fetched while off');
  assert.equal(await page.$eval('#radio', (el) => el.previousElementSibling?.id), 'sound', 'right beside the sound button');
  assert.equal(await page.getAttribute('#radio-credit', 'href'), 'https://midnightradio.cloud/', 'the credit links to the station');
  assert.equal((await page.textContent('#radio-toggle')).trim(), '▶ Radio');
  await shot(page, 'room-desktop-radio');

  await page.click('#radio-toggle');
  await page.waitForFunction(() => document.getElementById('radio-credit').textContent !== 'Test Radio, by permission' || document.getElementById('radio-toggle').getAttribute('aria-pressed') === 'true');
  await page.waitForTimeout(500);
  assert.deepEqual(asked, ['https://radio.test/stream.mp3'], 'asked for the stream once');
  // A dropped stream is a quiet "offline", not an error, and pressing play tries again. (The route above refuses the stream.)
  await page.waitForFunction(() => /offline/i.test(document.getElementById('radio-credit').textContent), null, { timeout: 8000 });
  assert.equal(await page.textContent('#radio-credit'), 'Radio offline');
  assert.equal(await page.getAttribute('#radio-toggle', 'aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.radio')), null, 'a lost stream is not remembered as playing');
  assert.equal(await page.$('#radio-credit.offline') !== null, true);
  // Playing carries to the next page (each page is its own document): the page remembers it, and asks for the stream again.
  await page.evaluate(() => localStorage.setItem('hall.radio', 'on'));
  const before = asked.length;
  const t = await (await fetch(`http://127.0.0.1:${port}/dice-tables`, { method: 'POST', body: JSON.stringify({ lobbySeconds: 300 }) })).json();
  await page.goto(`http://127.0.0.1:${port}/dice?id=${t.id}&watch=1`);
  await page.waitForSelector('#radio-toggle');
  await page.waitForFunction(() => document.getElementById('radio-toggle'));
  await page.waitForTimeout(500);
  assert.ok(asked.length > before, 'the next page resumed the stream without being pressed');
  const note = await page.textContent('#radio-credit');
  assert.ok(!/error|failed|undefined/i.test(note), `nothing alarming on the page: ${note}`);
  await context.close();
  const t2 = t;
  // A fresh browser: off by default at a table too.
  const fresh = await session();
  await fresh.page.goto(`http://127.0.0.1:${port}/dice?id=${t2.id}&watch=1`);
  await fresh.page.waitForSelector('#radio-toggle');
  assert.equal(await fresh.page.getAttribute('#radio-toggle', 'aria-pressed'), 'false', 'off by default at the table too');
  await fresh.context.close();
});

// ---------- the claim panel, from the engine's own views ----------

/** Shows a seated page a claim turn: the views the engine would really send, laid over the real table's routes. */
async function claimScene({ hand, claims = [], queue = [0, 1, 2, 3], options = DESKTOP, name = 'Tester', raise = null, answer = false, chips = null }) {
  const s = await seated({}, options, name);
  const table = createTable({ lobbyMs: 0 });
  joinTable(table, name, { now: 1000, rng: () => 0.5 });
  table.phase = 'claim';
  table.hands[0] = hand;
  table.claims = claims;
  table.lap = { leader: queue[0], queue, high: 0, by: null, paid: {}, ...raise };
  table.deadline = null;
  if (answer) table.phase = 'answer';
  if (chips !== null) table.seats[0].chips = chips;
  const state = { ...publicView(table), seatsTotal: 4, buyIn: 100 };
  state.clocks = [];
  await s.page.route(/\/tables\/[0-9a-f]+$/, (route) => route.fulfill({ json: { ...state, now: Date.now() } }));
  await s.page.route(/\/tables\/[0-9a-f]+\/me$/, (route) => route.fulfill({ json: privateView(table, 0) }));
  await s.page.waitForSelector('#to-beat:not([hidden])');
  return s;
}

const NINES = ['9c', '9d', '2h', '5s', 'Kc'];
const TWO_PAIR = ['Jc', 'Jd', '4h', '4s', 'Kc'];
const NOTHING = ['2c', '4d', '7h', '9s', 'Kc'];
const BRANNOCK_KINGS = { seat: 2, claim: [2, 13, 0], status: 'standing' };

test('claim panel: nothing beats it, so Call and Check are the big buttons, and the claim to beat is on top', { timeout: 60_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, acts } = await claimScene({ hand: NINES, claims: [BRANNOCK_KINGS], queue: [0, 1, 3], options });
    const beat = await page.textContent('#to-beat');
    assert.equal(beat, 'To beat: Brannock — two pair, Kings high (claimed, not shown)');
    const order = await page.$$eval('#action-box > *:not([hidden])', (els) => els.map((e) => e.id || e.className));
    assert.deepEqual(order.slice(0, 3), ['action-title', 'to-beat', 'turn-line'], 'right under the panel title');
    const size = await page.$eval('#to-beat', (el) => parseFloat(getComputedStyle(el).fontSize));
    const bodySize = await page.$eval('#turn-line', (el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(size >= bodySize + 3, `large: ${size} over ${bodySize}`);
    assert.equal(await page.textContent('#best-true p'), 'Your best true claim: pair of 9s. It doesn’t beat Brannock’s two pair, Kings high.');
    for (const action of ['check', 'call']) {
      const button = page.locator(`.zone-right [data-action="${action}"]`); // the move row is under the hand
      assert.match(await button.getAttribute('class'), /primary/, action);
      assert.match(await button.getAttribute('class'), /big/, action);
      assert.ok(await button.isVisible());
      const box = await button.boundingBox();
      assert.ok(box.height >= 56, `${action} ${box.height}px`);
    }
    assert.match(await page.textContent('[data-action="call"]'), /Call Brannock: two pair, Kings high/);
    assert.ok((await page.$$eval('#claims li', (els) => els.length)) === 1, 'the full list stays where it was');
    assert.ok(await noSideScroll(page));
    await shot(page, `claim-doesnt-beat-${name}`);
    if (SHOTS) await page.locator('#action-box').screenshot({ path: join(SHOTS, `claim-doesnt-beat-panel-${name}.png`) });
    await page.click('[data-action="check"]');
    assert.deepEqual(acts.at(-1), { action: 'check' });
    await context.close();
  }
});

test('claim panel: no claims yet, you open; nothing true to say; Check is still there and the picker is still open', { timeout: 60_000 }, async () => {
  const { context, page } = await claimScene({ hand: NOTHING });
  assert.equal(await page.textContent('#to-beat'), 'No claims yet — you open.');
  assert.equal(await page.textContent('#best-true p'), 'Your best true claim: none. You hold no pair or better.');
  assert.match(await page.getAttribute('[data-action="check"]', 'class'), /primary/);
  assert.equal(await page.$('[data-action="call"]'), null, 'nothing to call');
  assert.equal(await page.$$eval('[data-kind]:not([disabled])', (els) => els.length), 8);
  assert.equal(await page.$('#use-best'), null);
  assert.equal(await page.$('[data-truthful]'), null, 'nothing is true');
  await context.close();
});

test('claim panel: a claim that beats it can be picked in one tap and confirmed; Check and Call stay in sight, not shouting', { timeout: 60_000 }, async () => {
  const { context, page, acts } = await claimScene({ hand: TWO_PAIR, claims: [{ seat: 2, claim: [1, 9, 0], status: 'standing' }], queue: [0, 1, 3] });
  assert.equal(await page.textContent('#to-beat'), 'To beat: Brannock — pair of 9s (claimed, not shown)');
  assert.equal(await page.textContent('#best-true p'), 'Your best true claim: two pair, Jacks and 4s');
  assert.doesNotMatch(await page.getAttribute('[data-action="check"]', 'class'), /primary/);
  assert.ok(await page.locator('[data-action="check"]').isVisible());
  const sent = acts.length;
  await page.click('#use-best');
  assert.equal(acts.length, sent, 'picks, doesn\'t send');
  assert.equal(await page.textContent('#claim-confirm'), 'Make claim: two pair, Jacks and 4s');
  assert.equal(await page.textContent('#claim-verdict'), 'True: your hand holds this.');
  for (const selector of ['[data-kind="2"]', '[data-rank="11"]', '[data-second="4"]']) assert.equal(await page.getAttribute(selector, 'aria-pressed'), 'true', selector);
  await shot(page, 'claim-use-best');
  await page.click('#claim-confirm');
  assert.deepEqual(acts.at(-1), { action: 'claim', claim: [2, 11, 4] });
  await context.close();
});

test('picker: kinds, then only legal ranks, true ones marked and bluffs tagged, on a phone', { timeout: 60_000 }, async () => {
  const { context, page, acts } = await claimScene({ hand: NINES, claims: [{ seat: 2, claim: [1, 8, 0], status: 'standing' }], queue: [0, 1, 3], options: PHONE });
  const kinds = await page.$$eval('[data-kind]', (els) => els.map((e) => e.firstChild.textContent));
  assert.deepEqual(kinds, ['Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush']);
  assert.equal(await page.$('#actions select'), null);
  assert.equal(await page.$('[data-rank]'), null, 'ranks wait for a kind');
  await shot(page, 'picker-kinds-phone');

  await page.tap('[data-kind="1"]');
  const ranks = await page.$$eval('[data-rank]', (els) => els.map((e) => [e.firstChild.textContent, e.lastChild.textContent]));
  assert.deepEqual(ranks, [['9', 'true'], ['10', 'bluff'], ['J', 'bluff'], ['Q', 'bluff'], ['K', 'bluff'], ['A', 'bluff']], 'nothing at or below the 8s');
  assert.equal(await page.$eval('#claim-confirm', (b) => b.disabled), true);
  await shot(page, 'picker-ranks-phone');
  for (const box of await page.$$eval('.chip', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }))) {
    assert.ok(box[0] >= 44 && box[1] >= 44, `tap target ${box}`);
  }
  assert.ok(await noSideScroll(page));

  await page.tap('[data-rank="14"]');
  assert.equal(await page.textContent('#claim-confirm'), 'Make claim: pair of Aces');
  assert.equal(await page.textContent('#claim-verdict'), 'A bluff: it costs you 5 if someone calls it.');
  await shot(page, 'picker-bluff-phone');
  await page.tap('[data-rank="9"]');
  assert.equal(await page.textContent('#claim-verdict'), 'True: your hand holds this.');

  // Two pair: a third row, short, for the other pair. Full house the same. No long list anywhere.
  await page.tap('[data-kind="6"]');
  assert.equal(await page.$eval('#claim-confirm', (b) => b.disabled), true, 'a new kind starts over');
  await page.tap('[data-rank="13"]');
  assert.equal(await page.textContent('#claim-confirm'), 'Make claim: Kings full');
  assert.deepEqual(await page.$$eval('[data-second]', (els) => els.length), 13, 'any, or one of twelve others');
  await page.tap('[data-second="9"]');
  assert.equal(await page.textContent('#claim-confirm'), 'Make claim: full house, Kings over 9s');
  await shot(page, 'picker-full-house-phone');
  assert.ok(await noSideScroll(page));

  // One legal claim in a kind: no rank to ask for.
  await page.tap('[data-kind="8"]');
  assert.equal(await page.$('[data-rank]'), null);
  assert.equal(await page.textContent('#claim-confirm'), 'Make claim: straight flush');
  const sent = acts.length;
  await page.tap('#claim-confirm');
  assert.deepEqual(acts.at(sent), { action: 'claim', claim: [8, 0, 0] });
  await context.close();
});

test('picker: only legal kinds can be tapped, and at the very top of the ladder only Call and Check are left', { timeout: 60_000 }, async () => {
  let scene = await claimScene({ hand: NINES, claims: [{ seat: 2, claim: [5, 0, 0], status: 'standing' }], queue: [0, 1, 3] });
  assert.deepEqual(await scene.page.$$eval('[data-kind][disabled]', (els) => els.map((e) => Number(e.dataset.kind))), [1, 2, 3, 4], 'below a flush');
  await scene.context.close();

  scene = await claimScene({ hand: NINES, claims: [{ seat: 2, claim: [8, 0, 0], status: 'proven' }], queue: [0, 1, 3] });
  assert.equal(await scene.page.textContent('#to-beat'), 'To beat: Brannock — straight flush (checked, not shown)');
  assert.equal(await scene.page.$('[data-kind]'), null);
  assert.match(await scene.page.getAttribute('[data-action="check"]', 'class'), /primary/);
  assert.equal(await scene.page.$('[data-action="call"]'), null, 'proven already: nothing to call');
  await scene.context.close();
});

test('the claim to beat: everyone sees it through the lap, and only the one to open is told to', { timeout: 60_000 }, async () => {
  const scene = await claimScene({ hand: NINES, queue: [1, 2, 3, 0] });
  assert.equal(await scene.page.textContent('#to-beat'), 'No claims yet.');
  assert.match(await scene.page.textContent('#best-true p'), /pair of 9s/, 'your best is there before your turn');
  assert.equal(await scene.page.$('[data-action="check"]'), null, 'not your turn');
  await scene.context.close();
});

test('Tally has the house seat with its own art, and the doorman has no seat', { timeout: 60_000 }, async () => {
  const { context, page } = await seated();
  assert.match(await page.textContent('[data-plate="1"] .name'), /^Tally$/, 'the name without the suffix: the badge says house (The owner, 11-07)');
  assert.ok(await page.$('[data-plate="1"] .tag.house'), 'Tally gets the house badge like the other bots');
  assert.ok(await page.$('[data-plate="2"] .tag.house'));
  assert.match(await page.$eval('[data-seat="1"]', (el) => el.style.backgroundImage), /seat-tally\.png/);
  assert.ok(!/Clockwork|Halfhand/.test(await page.textContent('#plates')));
  await context.close();

  // Until the art is in, Tally borrows the adventurer's.
  const noArt = await session();
  await noArt.page.route('**/art/hall/manifest.json', async (route) => {
    const manifest = await (await route.fetch()).json();
    delete manifest.sprites.tally;
    await route.fulfill({ json: manifest });
  });
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 11 } });
  await noArt.page.goto(`${BASE}/table?id=${id}`);
  await noArt.page.fill('#join-name', 'Tester');
  await noArt.page.click('#join-form button[type="submit"]');
  await noArt.page.waitForSelector('[data-seat="1"]');
  assert.match(await noArt.page.$eval('[data-seat="1"]', (el) => el.style.backgroundImage), /seat-adventurer\.png/);
  await noArt.context.close();
});

test('closing with chips in the pot says where they went', { timeout: 60_000 }, async () => {
  const { context, page, id } = await seated({ waitingIdleMs: 800 });
  await page.waitForFunction(() => /Table closed/.test(document.getElementById('turn-line').textContent), null, { timeout: 15_000 });
  assert.match(await page.textContent('#turn-line'), /The pot of 4 went back: Tester 1, Tally · house 1, Brannock 1, Old Wick 1\./);
  assert.ok(id);
  await shot(page, 'table-closed-pot-back');
  await context.close();
});

// ---------- the purse, and never losing a seat ----------

async function asPlayer(token, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

const purseOf = async (token) => (await asPlayer(token, 'GET', '/players/me')).chips;

/** A player already at a table with bots holding still, as if they'd sat down from the Hall. */
async function playerAtTable({ name = 'The owner', buyIn = 209, chips, options = DESKTOP, table = {} } = {}) {
  const player = await apiPost('/players', { name, ...(chips === undefined ? {} : { testChips: chips }) });
  const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 31, botDelayMs: [20_000, 20_000], ...table } });
  const seat = await asPlayer(player.token, 'POST', `/tables/${id}/join`, { kind: 'human', buyIn });
  const s = await session(options);
  await s.page.goto(BASE);
  await s.page.evaluate(([t, tableId, st]) => {
    localStorage.setItem('hall.player', t);
    localStorage.setItem(`hall.seat.${tableId}`, st);
  }, [player.token, id, seat.token]);
  s.creates = 0;
  s.page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/tables') s.creates += 1; });
  return { ...s, player, id, token: player.token, seatToken: seat.token };
}

const stackAt = async (id, seat = 0) => (await (await fetch(`${BASE}/tables/${id}`)).json()).seats[seat].chips;
const plateStack = async (page) => Number((await page.textContent('[data-plate="0"] .chips')).trim());

test('wandering off: the Hall offers the seat first, Take a seat goes back to it, and no new table opens', { timeout: 90_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, player, id, token, ...rest } = await playerAtTable({ options });
    const creates = () => rest.creates;
    await page.goto(`${BASE}/table?id=${id}`);
    await page.waitForSelector('[data-plate="0"].mine');
    assert.equal(await plateStack(page), 208, '209, less the ante');
    await page.goto(`${BASE}/`); // the Hall button asks to leave now (tested below); wandering off keeps the seat
    await page.waitForSelector('#menu [data-id="return"]');

    assert.match(await page.textContent('#menu button'), /^Back to Sealed Hand, table \d+ \(208 chips\)$/, 'the first option');
    assert.equal(await page.textContent('#who-line'), 'The owner · Purse: 791 (+208 on the table)', 'the stack, not the buy-in');
    assert.ok(await page.$eval('#who', (el) => el.scrollWidth <= el.clientWidth), 'the purse is never cut short');
    assert.match(await page.textContent(`[data-return="${id}"]`), /Back to your seat \(208 chips\)/);
    await page.waitForFunction(() => document.getElementById('line').textContent.endsWith('be?'));
    await shot(page, `hall-return-${name}`);
    assert.ok(await noSideScroll(page));

    await page.click('#menu [data-id="seat"]'); // Take a seat always asks which game (11-07)
    await page.waitForSelector('#menu [data-id="pick-sealed-hand"]');
    await page.click('#menu [data-id="pick-sealed-hand"]'); // the game they're seated at: back to the seat
    await page.waitForURL(new RegExp(id));
    await page.waitForSelector('[data-plate="0"].mine');
    assert.equal(await plateStack(page), 208);
    assert.equal(creates(), 0, 'no new table');
    assert.equal(await purseOf(token), 791, 'and no new buy-in');
    assert.equal((await asPlayer(token, 'GET', '/players/me')).inPlay.length, 1);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('wandering off: Join on the table in the room goes back to the seat too', { timeout: 60_000 }, async () => {
  const { context, page, id, token } = await playerAtTable();
  await page.goto(BASE);
  await page.waitForSelector('#menu [data-id="return"]');
  await page.click('.spot[data-game="sealed-hand"]'); // picking the game they're seated at: straight back to that seat, no bring prompt
  await page.waitForURL(new RegExp(id));
  await page.waitForSelector('[data-plate="0"].mine');
  assert.equal(await purseOf(token), 791);
  await context.close();
});

test('reload, back, and a lost seat token all reach the same seat', { timeout: 60_000 }, async () => {
  const { context, page, id, token, seatToken } = await playerAtTable();
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('[data-plate="0"].mine');
  await page.reload();
  await page.waitForSelector('[data-plate="0"].mine');
  assert.equal(await plateStack(page), 208, 'reload');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), `hall.seat.${id}`), seatToken, 'reload keeps the same seat token');

  await page.goto(`${BASE}/`);
  await page.goBack();
  await page.waitForSelector('[data-plate="0"].mine');
  assert.equal(await plateStack(page), 208, 'back');

  // The seat token is gone, the player token isn't: found again with no question asked.
  await page.evaluate((key) => localStorage.removeItem(key), `hall.seat.${id}`);
  await page.reload();
  await page.waitForSelector('[data-plate="0"].mine');
  assert.equal(await plateStack(page), 208, 'recovered');
  assert.equal(await page.$eval('#join-box', (el) => el.hidden), true);
  assert.equal(await purseOf(token), 791, 'at no charge');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('a seat opened elsewhere: this page says so and takes it back only when asked', { timeout: 60_000 }, async () => {
  const { context, page, id, token } = await playerAtTable();
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('[data-plate="0"].mine');
  await asPlayer(token, 'POST', `/tables/${id}/join`, { kind: 'human' }); // another device
  await page.waitForFunction(() => /somewhere else/.test(document.getElementById('join-title').textContent), null, { timeout: 8000 });
  assert.match(await page.textContent('#join-note'), /stack of 208 is safe/);
  assert.equal(await page.textContent('#join-submit'), 'Take it back here');
  await shot(page, 'table-seat-elsewhere');
  await page.click('#join-submit');
  await page.waitForSelector('[data-plate="0"].mine');
  assert.equal(await plateStack(page), 208);
  assert.equal(await purseOf(token), 791);
  await context.close();
});

test('a link to another table: sitting there is refused, with the way back to the seat they have', { timeout: 60_000 }, async () => {
  const { context, page, id, token } = await playerAtTable();
  const other = await apiPost('/tables', { lobbySeconds: 30, test: { rng: 5 } });
  await page.goto(`${BASE}/table?id=${other.id}`);
  await page.waitForSelector('#join-form:not([hidden])');
  await page.click('#join-submit');
  await page.waitForSelector('#join-return');
  assert.match(await page.textContent('#join-return'), /^Back to Sealed Hand, table \d+$/);
  assert.match(await page.textContent('#join-note'), /still seated at Sealed Hand, table \d+ \(208 chips\)/);
  assert.equal(await page.$eval('#join-form', (f) => f.hidden), true, 'no dead button');
  assert.equal(await page.textContent('#join-title'), 'You’re already at a table');
  assert.equal(await purseOf(token), 791, 'nothing left the purse');
  await shot(page, 'table-seated-elsewhere');
  await page.click('#join-return');
  await page.waitForURL(new RegExp(id));
  await page.waitForSelector('[data-plate="0"].mine');
  await context.close();
});

test('sitting down: 1,000 by default, less if they say, and the purse pays exactly that', { timeout: 90_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const player = await apiPost('/players', { name: `Buyer ${name}` });
    const { context, page } = await session(options);
    await page.route('**/tables', (route) => (route.request().method() === 'POST' ? route.continue({ postData: JSON.stringify({ lobbySeconds: 30, test: { rng: 5 } }) }) : route.continue()));
    await page.goto(BASE);
    await page.evaluate((t) => localStorage.setItem('hall.player', t), player.token);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('who-line')?.textContent.endsWith('· Purse: 1000'));
    await page.waitForSelector('#menu [data-id="seat"]');
    await takeSeat(page);
    await page.waitForSelector('#buyin-form:not([hidden])');
    assert.equal(await page.inputValue('#buyin'), '1000', 'the default stack');
    assert.equal(await page.getAttribute('#buyin', 'max'), '1000');
    assert.equal(await page.textContent('#buyin-of'), 'of your 1,000');
    assert.equal(await page.textContent('[data-id="sit"]'), 'Sit down at Sealed Hand with 1,000');
    await page.waitForFunction(() => document.getElementById('line').textContent.endsWith('leave.'));
    await shot(page, `hall-buy-in-${name}`);
    assert.ok(await noSideScroll(page));

    await page.fill('#buyin', '5000');
    assert.equal(await page.$eval('[data-id="sit"]', (b) => b.disabled), true, 'more than the purse');
    assert.equal(await page.textContent('[data-id="sit"]'), 'Choose 1 to 1,000');
    await page.fill('#buyin', '0');
    assert.equal(await page.$eval('[data-id="sit"]', (b) => b.disabled), true);
    await page.click('[data-buyin="1000"]');
    assert.equal(await page.inputValue('#buyin'), '1000', 'All');
    await page.fill('#buyin', '250');
    await page.click('[data-id="sit"]');
    await page.waitForURL(/\/table\?id=/);
    await page.waitForSelector('.seat-plate.mine'); // whichever seat: another test's table may still be open to join
    assert.equal(Number((await page.textContent('.seat-plate.mine .chips')).trim()), 250);
    assert.equal(await purseOf(player.token), 750);
    await page.waitForFunction(() => !/buyin=/.test(window.location.search));
    await context.close();
  }
});

test('sitting down: a small purse is told it fills up to 1,000; an empty one is offered Fill up first', { timeout: 60_000 }, async () => {
  const small = await apiPost('/players', { name: 'Small', testChips: 40 });
  const { context, page } = await session();
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), small.token);
  await page.reload();
  await page.waitForSelector('#menu [data-id="seat"]');
  await takeSeat(page);
  await page.waitForSelector('#buyin-form:not([hidden])');
  assert.equal(await page.inputValue('#buyin'), '1000', 'the default stack, whatever the purse');
  assert.equal(await page.textContent('#buyin-of'), '(your purse 40: it fills up to 1,000)');
  assert.equal(await page.textContent('[data-id="sit"]'), 'Sit down at Sealed Hand with 1,000');
  assert.equal(await page.textContent('[data-buyin="1000"]'), '1,000');

  const empty = await apiPost('/players', { name: 'Empty', testChips: 0 });
  await page.evaluate((t) => localStorage.setItem('hall.player', t), empty.token);
  await page.reload();
  await page.waitForSelector('#menu [data-id="seat"]');
  await takeSeat(page);
  await page.waitForSelector('#menu [data-id="topup"]');
  assert.equal(await page.$eval('#buyin-form', (f) => f.hidden), true);
  assert.equal(await page.textContent('#menu [data-id="topup"]'), 'Fill up to 1,000');
  await page.click('#menu [data-id="topup"]');
  await page.waitForSelector('#buyin-form:not([hidden])');
  assert.equal(await page.textContent('#buyin-of'), 'of your 1,000');
  await context.close();
});

test('the seat form on the table page defaults to 1,000, and can bring less', { timeout: 60_000 }, async () => {
  const player = await apiPost('/players', { name: 'Direct' });
  const { id } = await apiPost('/tables', { lobbySeconds: 30, test: { rng: 5 } });
  const { context, page } = await session();
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), player.token);
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForFunction(() => document.getElementById('join-buyin-of').textContent === 'of your 1,000');
  assert.equal(await page.inputValue('#join-buyin'), '1000');
  await shot(page, 'table-buy-in');
  await page.fill('#join-buyin', '300');
  await page.click('#join-submit');
  await page.waitForSelector('[data-plate="0"].mine');
  assert.equal(await plateStack(page), 300);
  assert.equal(await purseOf(player.token), 700);
  await context.close();
});

test('leaving: "N returned to your purse (now M)", once; then standing, with no way "back" to the table left', { timeout: 120_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, id, token } = await playerAtTable({ options, table: { botDelayMs: [0, 0] } });
    await page.goto(`${BASE}/table?id=${id}`);
    await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
    await page.waitForSelector('#leave:not([hidden])');
    const stack = await stackAt(id);
    const purseBefore = await purseOf(token);
    await leaveToHall(page);
    await page.waitForSelector('#notice:not([hidden])');
    const purse = purseBefore + stack;
    assert.equal(await page.textContent('#notice'), `${stack} returned to your purse (now ${purse}).`);
    assert.equal(await page.textContent('#who-line'), `The owner · Purse: ${purse}`);
    assert.doesNotMatch(await page.textContent('#menu'), /Back to Sealed Hand/, 'standing: the table left is not offered as if still at it (The owner, 11-06)');
    assert.equal((await page.textContent('#menu button')).trim(), 'Take a seat');
    await page.waitForFunction(() => document.getElementById('line').textContent.endsWith('be?'));
    await shot(page, `hall-left-notice-${name}`);

    await page.reload();
    await page.waitForSelector('#menu [data-id="seat"]');
    assert.equal(await page.$eval('#notice', (el) => el.hidden), true, 'said once');
    assert.equal(await page.$('#menu [data-id="resit"]'), null);
    assert.equal(await purseOf(token), purse);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('leaving in the middle of a round: the stack it ended with is what the Hall reports', { timeout: 60_000 }, async () => {
  const { context, page, id, token } = await playerAtTable({ table: { botDelayMs: [0, 0] } });
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('#leave:not([hidden])');
  await leaveToHall(page);
  await page.waitForSelector('#notice:not([hidden])');
  const [, said, now] = (await page.textContent('#notice')).match(/^(\d+) returned to your purse \(now (\d+)\)\.$/) ?? [];
  const amount = Number(said);
  assert.ok(amount > 0 && amount <= 209, `amount ${amount}`);
  assert.equal(Number(now), await purseOf(token));
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.left')), null, 'said, then let go: nothing left to offer a way back to');
  await context.close();
});

test('a table that closes says the stack is back in the purse', { timeout: 60_000 }, async () => {
  const { context, page, id } = await playerAtTable({ table: { waitingIdleMs: 900 } });
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForFunction(() => /Table closed/.test(document.getElementById('turn-line').textContent), null, { timeout: 15_000 });
  assert.match(await page.textContent('#turn-line'), /Your 209 chips are back in your purse\./);
  await context.close();
});

// ---------- the old address ----------

/** Serves both real addresses from the local server, so a browser treats them as the two origins they are. */
async function bothAddresses(context) {
  await context.route(/^https:\/\/(halfhand\.app|sealedhand\.halfhand\.dev)\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: PORT, path: url.pathname + url.search, method: route.request().method(), headers: { ...route.request().headers(), host: url.hostname } }, resolve);
      req.on('error', reject);
      req.end(route.request().postData() ?? undefined);
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return route.fulfill({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
  });
}

const OLD = 'https://sealedhand.halfhand.dev';
const HOME = 'https://halfhand.app';

test('the old address: the key is copied from there and restored here, and never appears in an address', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  await bothAddresses(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: OLD });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: HOME });
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('framenavigated', (f) => urls.push(f.url()));
  const older = await apiPost('/players', { name: 'Halfhand', testChips: 1209 });

  await page.goto(`${OLD}/seed`);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), older.token);
  await page.goto(`${OLD}/recover`);
  await page.waitForSelector('#found:not([hidden])');
  assert.match(await page.textContent('.key-warning'), /Your Player ID is your purse/);
  assert.ok(!(await page.content()).includes(older.token), 'not on the page');
  await shot(page, 'recover-old-address');
  await page.click('#copy');
  await page.waitForFunction(() => /Copied/.test(document.getElementById('status').textContent));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, older.token);

  await page.goto(`${HOME}/`);
  await page.waitForSelector('#dialogue:not([hidden])');
  await page.click('#settings-open');
  await page.fill('#key-input', copied);
  await page.click('#key-restore button[type="submit"]');
  await page.waitForSelector('#key-confirm:not([hidden])');
  assert.equal(await page.textContent('#key-found'), 'This Player ID is Halfhand, with 1209 in the purse.');
  await page.click('#key-switch');
  await page.waitForFunction(() => document.getElementById('who-line')?.textContent === 'Halfhand · Purse: 1209');
  assert.ok(!urls.some((u) => u.includes(older.token)), 'never in an address');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the old address: nothing saved says so', { timeout: 30_000 }, async () => {
  const { context, page } = await session();
  await bothAddresses(context);
  await page.goto(`${OLD}/recover`);
  await page.waitForSelector('#none:not([hidden])');
  assert.equal(await page.$eval('#found', (el) => el.hidden), true);
  await context.close();
});

// ---------- the purse ----------

test('the player key: copies, warns, restores on another device, and never shows in an address, the page or a log', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  page.on('console', (m) => seen.push(m.text()));
  const mine = await apiPost('/players', { name: 'Keeper', testChips: 640 });
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), mine.token);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('who-line')?.textContent === 'Keeper · Purse: 640');
  await page.click('#settings-open');
  assert.match(await page.textContent('.key-warning'), /Your Player ID is your purse\..*spend every chip/);
  await shot(page, 'settings-desktop');
  await page.click('#key-copy');
  await page.waitForFunction(() => /Copied/.test(document.getElementById('key-status').textContent));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), mine.token);
  assert.ok(!(await page.content()).includes(mine.token), 'copied, not shown');
  // The Player ID button opens the panel. The key is masked there until Show, with the one-line warning; Hide (or closing) masks it again.
  assert.equal(await page.textContent('#settings-open'), 'Player ID');
  assert.equal(await page.textContent('#settings-title'), 'Your Player ID');
  assert.equal(await page.textContent('#key-copy'), 'Copy my Player ID');
  assert.equal(await page.textContent('#pid-value'), `${mine.token.length}-character ID, hidden`);
  assert.equal(await page.textContent('#pid-note'), 'It works like a password: never post it, and keep it out of screenshots.');
  await page.click('#pid-reveal');
  assert.equal(await page.textContent('#pid-value'), mine.token);
  assert.equal(await page.textContent('#pid-reveal'), 'Hide');
  await page.click('#pid-reveal');
  assert.equal(await page.textContent('#pid-value'), `${mine.token.length}-character ID, hidden`);
  await page.click('#pid-reveal');
  await page.click('#settings-close');
  assert.ok(!(await page.content()).includes(mine.token), 'closing the panel masks it again');
  // Never in the header: the name and purse only, no short form, no Copy.
  assert.equal(await page.textContent('#who'), 'Keeper · Purse: 640');
  assert.equal(await page.$('#who .player-id, .pid-short, .pid-copy'), null);
  assert.ok(!(await page.innerText('body')).includes(mine.token.slice(0, 6)), 'not even its first characters');

  // A new device: no key, and a way in before it makes a new player.
  const device = await session(PHONE);
  await device.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  device.page.on('request', (r) => seen.push(r.url()));
  device.page.on('console', (m) => seen.push(m.text()));
  await device.page.goto(BASE);
  await device.page.waitForSelector('#menu [data-id="who-restore"]'); // the door offers it first: New here, or bringing a Player ID?
  await device.page.tap('#menu [data-id="who-restore"]');
  await device.page.waitForSelector('#settings:not([hidden])');
  assert.equal(await device.page.$eval('#key-copy', (b) => b.disabled), true, 'nothing to copy yet');
  assert.equal(await device.page.getAttribute('#key-input', 'type'), 'password');

  for (const [bad, message] of [['nonsense', /doesn’t look like/], [`${'a'.repeat(64)}.${'b'.repeat(64)}`, /No purse matches/]]) {
    await device.page.fill('#key-input', bad);
    await device.page.tap('#key-restore button[type="submit"]');
    await device.page.waitForFunction((m) => new RegExp(m).test(document.getElementById('key-status').textContent), message.source);
    assert.equal(await device.page.evaluate(() => localStorage.getItem('hall.player')), null);
  }

  await device.page.fill('#key-input', mine.token);
  await device.page.tap('#key-restore button[type="submit"]');
  await device.page.waitForSelector('#key-confirm:not([hidden])');
  assert.equal(await device.page.inputValue('#key-input'), '', 'cleared the moment it was read');
  assert.equal(await device.page.textContent('#key-found'), 'This Player ID is Keeper, with 640 in the purse.');
  assert.equal(await device.page.evaluate(() => localStorage.getItem('hall.player')), null, 'nothing changes until they say so');
  await shot(device.page, 'settings-restore-phone');
  assert.ok(await noSideScroll(device.page));
  await device.page.tap('#key-switch');
  await device.page.waitForFunction(() => document.getElementById('who-line')?.textContent === 'Keeper · Purse: 640');

  // Switching away warns, and keeps the other key.
  const other = await apiPost('/players', { name: 'Second', testChips: 5 });
  await device.page.tap('#settings-open');
  await device.page.fill('#key-input', other.token);
  await device.page.tap('#key-restore button[type="submit"]');
  await device.page.waitForSelector('#key-confirm:not([hidden])');
  assert.match(await device.page.textContent('#key-found'), /You’re Keeper now, with 640\. Copy that Player ID first/);
  await device.page.tap('#key-cancel');
  assert.equal(await device.page.evaluate(() => localStorage.getItem('hall.player')), mine.token, 'cancel changes nothing');

  await device.page.fill('#key-input', other.token);
  await device.page.tap('#key-restore button[type="submit"]');
  await device.page.waitForSelector('#key-confirm:not([hidden])');
  await device.page.tap('#key-switch');
  await device.page.waitForFunction(() => document.getElementById('who-line')?.textContent === 'Second · Purse: 5');
  assert.equal(await device.page.evaluate(() => localStorage.getItem('hall.player.previous')), mine.token);

  for (const secret of [mine.token, other.token]) assert.ok(!seen.some((text) => text.includes(secret)), 'never in an address or the console');
  await device.context.close();
  await context.close();
});

test('the top bar at a table: on the table N, in your purse M; a watcher with a purse sees theirs, with no token sent to the table', { timeout: 60_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, id, token } = await playerAtTable({ options });
    await page.goto(`${BASE}/table?id=${id}`);
    await page.waitForFunction(() => document.getElementById('purse-bar').textContent === 'Your stack 208 · This session: even · Purse 791');
    await shot(page, `table-purse-bar-${name}`);
    assert.ok(await noSideScroll(page));
    assert.ok(await page.$eval('#purse-bar', (el) => el.getBoundingClientRect().height > 0));

    await page.goto('about:blank'); // so a poll still in flight from the seated page isn't counted against the watcher
    const toTable = [];
    page.on('request', (r) => { if (r.url().includes('/tables/') && r.headers().authorization) toTable.push(r.url()); });
    await page.goto(`${BASE}/table?id=${id}&watch=1`);
    await page.waitForFunction(() => document.getElementById('purse-bar').textContent === 'Purse 791');
    await page.waitForTimeout(400);
    assert.deepEqual(toTable, [], 'watching stays anonymous at the table');
    assert.equal(await purseOf(token), 791);
    await context.close();
  }
});

test('the wallet seam: pages read the purse from purse.amount, and offer no top-up on a read-only one', { timeout: 60_000 }, async () => {
  const skint = await apiPost('/players', { name: 'Linked', testChips: 0 });
  const { context, page } = await session();
  await page.route('**/players/me', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, chips: 0, purse: { amount: 777, source: 'cage', readOnly: true, owner: { kind: 'wallet', id: 'an-address' } } } });
  });
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), skint.token);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('who-line')?.textContent === 'Linked · Purse: 777');
  assert.equal(await page.$eval('#topup', (b) => b.hidden), true, 'the house can\'t top up a cage balance');
  await page.waitForSelector('#menu [data-id="seat"]');
  await takeSeat(page);
  await page.waitForSelector('#buyin-form:not([hidden])');
  assert.equal(await page.inputValue('#buyin'), '777');
  await context.close();
});

test('away too long at a table with other people: the stack goes to the purse, and the page says so and offers the seat', { timeout: 60_000 }, async () => {
  const player = await apiPost('/players', { name: 'Wanders Off', testChips: 500 });
  const friend = await apiPost('/players', { name: 'Stays Here', testChips: 500 });
  const { id } = await apiPost('/tables', { lobbySeconds: 1, test: { rng: 8, turnMs: 400, awayStandMs: 900, roundGapMs: 60_000 } });
  const seat = await asPlayer(player.token, 'POST', `/tables/${id}/join`, { kind: 'human', buyIn: 200 });
  await asPlayer(friend.token, 'POST', `/tables/${id}/join`, { kind: 'human', buyIn: 200 });
  const { context, page } = await session();
  await page.goto(BASE);
  await page.evaluate(([t, tableId, st]) => {
    localStorage.setItem('hall.player', t);
    localStorage.setItem(`hall.seat.${tableId}`, st);
  }, [player.token, id, seat.token]);
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForFunction(() => /away too long/.test(document.getElementById('join-title').textContent), null, { timeout: 25_000 });
  const whole = Number((await page.textContent('#join-submit')).match(/\d+/)[0]);
  const stack = whole - 300;
  assert.match(await page.textContent('#join-note'), new RegExp(`your ${stack} went back to your purse`));
  assert.equal(await purseOf(player.token), whole, 'the button names the whole purse, which is what comes');
  assert.deepEqual((await asPlayer(player.token, 'GET', '/players/me')).inPlay, []);
  await shot(page, 'table-away-stood-up');
  await page.click('#join-submit');
  await page.waitForFunction(() => /Your stack/.test(document.getElementById('purse-bar').textContent));
  assert.equal(await purseOf(player.token), 0, 'one stack');
  await context.close();
});

test('add chips: between rounds only, any amount up to the whole purse, and the numbers change at once', { timeout: 120_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, id, token, ...rest } = await playerAtTable({ options, buyIn: 100, chips: 400, table: { botDelayMs: [0, 0], roundGapMs: 60_000 } });
    await page.goto(`${BASE}/table?id=${id}`);
    await page.waitForSelector('[data-plate="0"].mine');
    assert.equal(await page.$eval('#add-chips', (el) => el.hidden), true, 'not in a round');
    await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
    await page.waitForSelector('#add-chips:not([hidden])');
    const stack = await stackAt(id);
    // the middle part is the session total since sitting down; chips added are not part of it
    await page.waitForFunction((st) => new RegExp(`^Your stack ${st} · This session: (even|[+−][\\d,]+) · Purse 300$`).test(document.getElementById('purse-line').textContent), stack);
    const line = await page.textContent('#purse-line');
    const session = line.split(' · ')[1];
    assert.equal(await page.textContent('#purse-bar'), line);
    await shot(page, `table-add-chips-${name}`);

    await page.click('#add-chips-open');
    assert.equal(await page.inputValue('#add-chips-amount'), '300', 'up to the whole purse');
    await page.fill('#add-chips-amount', '301');
    assert.equal(await page.$eval('#add-chips-confirm', (b) => b.disabled), true);
    await page.fill('#add-chips-amount', '0');
    assert.equal(await page.$eval('#add-chips-confirm', (b) => b.disabled), true);
    await page.fill('#add-chips-amount', '120');
    assert.equal(await page.textContent('#add-chips-confirm'), 'Add 120 to the table');
    await shot(page, `table-add-chips-amount-${name}`);
    assert.ok(await noSideScroll(page));
    await page.click('#add-chips-confirm');
    const after = `Your stack ${stack + 120} · ${session} · Purse 180`;
    await page.waitForFunction((t) => document.getElementById('purse-line').textContent === t, after);
    assert.equal(await page.textContent('#purse-bar'), after);
    assert.equal(await page.$eval('#add-chips-form', (f) => f.hidden), true);
    assert.equal(await purseOf(token), 180);
    assert.equal(await stackAt(id), stack + 120);

    await page.click('#add-chips-open');
    await page.click('[data-add="180"]');
    await page.click('#add-chips-confirm');
    await page.waitForFunction((t) => document.getElementById('purse-line').textContent === t, `Your stack ${stack + 300} · ${session} · Purse 0`);
    assert.equal(await page.$eval('#add-chips-open', (b) => b.disabled), true, 'nothing left to add');
    assert.equal(rest.creates, 0);

    await page.click('[data-action="next"]');
    await page.waitForFunction(() => /Round 2/.test(document.getElementById('phase').textContent));
    await page.waitForSelector('#add-chips', { state: 'hidden' });
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

// ---------- raising in the claim lap ----------

const BRANNOCK_12 = { high: 12, by: 2, paid: { 2: 12 } };

test('lap raise: no raise on the table: the amount shows only once you choose Raise, and every label says what it does', { timeout: 60_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, acts } = await claimScene({ hand: NINES, claims: [BRANNOCK_KINGS], queue: [0, 1, 3], options });
    await page.waitForSelector('#stake-row');
    assert.equal(await page.isVisible('#facing'), false, 'no banner with no raise');
    assert.deepEqual(await page.$$eval('#stake-row button', (els) => els.map((e) => e.textContent)), ['No raise', 'Raise']);
    assert.equal(await page.getAttribute('[data-stake="none"]', 'aria-pressed'), 'true');
    assert.equal(await page.isVisible('#stake-amount'), false);
    assert.equal(await page.textContent('[data-action="check"]'), 'Check');

    await page.click('[data-stake="raise"]');
    assert.equal(await page.isVisible('#stake-amount'), true);
    await page.fill('#raise-amount', '12');
    assert.equal(acts.length, 0, 'choosing sends nothing');
    assert.equal(await page.textContent('[data-action="check"]'), 'Check + raise to 12');
    assert.match(await page.textContent('[data-action="call"]'), /Call Brannock: two pair, Kings high \+ raise to 12/);
    assert.ok(await noSideScroll(page));
    const box = await page.locator('[data-stake="raise"]').boundingBox();
    assert.ok(box.height >= 44, `the toggle is a thumb target: ${box.height}px`);
    await shot(page, `lap-raise-${name}`);
    if (SHOTS) await page.locator('#action-box').screenshot({ path: join(SHOTS, `lap-raise-panel-${name}.png`) });

    await page.click('[data-action="check"]');
    assert.deepEqual(acts.at(-1), { action: 'check', raise: 12 });
    await page.click('[data-action="call"]');
    assert.deepEqual(acts.at(-1), { action: 'call', seat: 2, raise: 12 });

    await page.click('[data-kind="3"]');
    await page.click('[data-rank="14"]');
    assert.match(await page.textContent('#claim-confirm'), /Make claim: three Aces \+ raise to 12|Make claim: .* \+ raise to 12/);
    await page.click('#claim-confirm');
    assert.equal(acts.at(-1).raise, 12);
    assert.equal(acts.at(-1).action, 'claim');

    await page.fill('#raise-amount', '99');
    assert.equal(await page.isDisabled('[data-action="check"]'), true, 'out of range: nothing to send');
    await page.fill('#raise-amount', '7');
    await page.click('[data-stake="none"]');
    assert.equal(await page.textContent('[data-action="check"]'), 'Check');
    await page.click('[data-action="check"]');
    assert.deepEqual(acts.at(-1), { action: 'check' });
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('lap raise: facing one: "Stay in for 12, or fold" up top, moves that say the price, and a raise that starts above it', { timeout: 60_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, acts } = await claimScene({ hand: NINES, claims: [BRANNOCK_KINGS], queue: [0, 1, 3], options, raise: BRANNOCK_12 });
    await page.waitForSelector('#facing:not([hidden])');
    assert.equal(await page.textContent('#facing-big'), 'Stay in for 12, or fold');
    assert.equal(await page.textContent('#facing-small'), 'Brannock raised to 12.');
    assert.equal(await page.textContent('#phase'), 'Round 1 · Stay in for 12, or fold', 'up top too, for a phone');
    assert.deepEqual((await page.$$eval('#action-box > *:not([hidden])', (els) => els.map((e) => e.id))).slice(0, 2), ['action-title', 'facing'], 'the first thing in the panel');
    assert.ok((await page.$eval('#facing-big', (el) => parseFloat(getComputedStyle(el).fontSize))) >= 22, 'big');
    assert.deepEqual(await page.$$eval('#stake-row button', (els) => els.map((e) => e.textContent)), ['Stay in for 12', 'Raise', 'Fold']);
    assert.equal(await page.getAttribute('[data-stake="match"]', 'aria-pressed'), 'true');
    assert.equal(await page.textContent('[data-action="check"]'), 'Check + 12 to stay in');
    assert.match(await page.textContent('[data-action="call"]'), /\+ 12 to stay in$/);
    assert.match(await page.textContent('[data-plate="2"]'), /in for 12/);
    assert.ok(await noSideScroll(page));
    await shot(page, `lap-facing-${name}`);
    if (SHOTS) await page.locator('#action-box').screenshot({ path: join(SHOTS, `lap-facing-panel-${name}.png`) });

    await page.click('[data-action="check"]');
    assert.deepEqual(acts.at(-1), { action: 'check', match: true });
    await page.click('[data-action="call"]');
    assert.deepEqual(acts.at(-1), { action: 'call', seat: 2, match: true });

    await page.click('[data-stake="raise"]');
    assert.equal(await page.getAttribute('#raise-amount', 'min'), '13');
    assert.equal(await page.inputValue('#raise-amount'), '13', 'it starts above the raise');
    assert.deepEqual(await page.$$eval('[data-raise-amount]', (els) => els.map((e) => e.textContent)), ['13', '25']);
    await page.click('[data-raise-amount="25"]');
    assert.equal(await page.textContent('[data-action="check"]'), 'Check + raise to 25');
    await page.click('[data-action="call"]');
    assert.deepEqual(acts.at(-1), { action: 'call', seat: 2, raise: 25 });

    await page.click('[data-stake="fold"]');
    assert.equal(await page.isVisible('#claim-box'), false, 'folding means no claim');
    assert.match(await page.textContent('#stake-note'), /pay nothing more/);
    assert.match(await page.textContent('[data-action="call"]'), /, then fold$/);
    assert.equal(await page.textContent('#move-row [data-action="fold"]'), 'Fold');
    if (name === 'phone') {
      await page.evaluate(() => { document.getElementById('error').textContent = ''; }); // the clicks above reached a table in another phase
      await shot(page, 'lap-facing-fold-phone');
      if (SHOTS) await page.locator('#action-box').screenshot({ path: join(SHOTS, 'lap-facing-fold-panel-phone.png') });
    }
    await page.click('[data-action="call"]');
    assert.deepEqual(acts.at(-1), { action: 'call', seat: 2, fold: true });
    await page.click('#move-row [data-action="fold"]');
    assert.deepEqual(acts.at(-1), { action: 'fold' });

    await page.click('[data-stake="match"]');
    assert.equal(await page.isVisible('#claim-box'), true);
    await page.click('[data-kind="3"]');
    await page.click('[data-rank="14"]');
    await page.click('#claim-confirm');
    assert.equal(acts.at(-1).match, true);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('lap raise: a stack that can’t cover it can only fold, or call and fold; a seat that isn’t up sees the numbers', { timeout: 60_000 }, async () => {
  let scene = await claimScene({ hand: NOTHING, claims: [BRANNOCK_KINGS], queue: [0, 1, 3], raise: BRANNOCK_12, chips: 8 });
  await scene.page.waitForSelector('#stake-row');
  assert.deepEqual(await scene.page.$$eval('#stake-row button', (els) => els.map((e) => e.textContent)), ['Fold']);
  assert.equal(await scene.page.isVisible('[data-kind]'), false);
  assert.match(await scene.page.textContent('[data-action="call"]'), /, then fold$/);
  await scene.page.click('[data-action="call"]');
  assert.deepEqual(scene.acts.at(-1), { action: 'call', seat: 2, fold: true });
  await scene.context.close();

  scene = await claimScene({ hand: NOTHING, claims: [BRANNOCK_KINGS], queue: [0, 1, 3], raise: BRANNOCK_12, chips: 3 });
  await scene.page.waitForSelector('#move-row [data-action="fold"]');
  assert.equal(await scene.page.$('[data-action="call"]'), null);
  await scene.context.close();

  scene = await claimScene({ hand: NINES, claims: [BRANNOCK_KINGS], queue: [1, 3, 0], raise: BRANNOCK_12 });
  await scene.page.waitForSelector('#facing:not([hidden])');
  assert.equal(await scene.page.textContent('#facing-big'), 'Raised to 12');
  assert.match(await scene.page.textContent('#facing-small'), /By Brannock\. On your turn, pay to stay in, or fold\./);
  assert.equal(await scene.page.$('#stake-row'), null);
  await scene.context.close();
});

// ---------- after the lap: match or fold ----------

const CLAIMS_TO_BACK = [{ seat: 2, claim: [2, 13, 0], status: 'standing' }, { seat: 0, claim: [1, 9, 0], status: 'standing' }];

test('match or fold: the top claim, the price, the two moves, and a call on the claim to go with either', { timeout: 60_000 }, async () => {
  for (const [options, name] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page, acts } = await claimScene({ hand: NINES, claims: CLAIMS_TO_BACK, options, answer: true, queue: [0, 1], raise: BRANNOCK_12 });
    await page.waitForSelector('#facing:not([hidden])');
    assert.equal(await page.textContent('#facing-big'), 'Stay in for 12, or fold');
    assert.equal(await page.textContent('#phase'), 'Round 1 · Stay in for 12, or fold');
    assert.equal(await page.textContent('#to-beat'), 'Top claim: Brannock — two pair, Kings high (claimed, not shown)');
    assert.equal(await page.textContent('#answer-line'), 'Your claim: pair of 9s. Highest raise: 12.');
    assert.equal(await page.textContent('[data-action="match"]'), 'Stay in for 12');
    assert.match(await page.getAttribute('[data-action="match"]', 'class'), /primary/);
    assert.equal(await page.textContent('[data-action="fold"]'), 'Fold: withdraw my claim');
    assert.ok(!(await page.$('[data-kind], [data-action="check"], #raise-amount, #stake-row')), 'no new claims or raises');
    assert.match(await page.textContent('#turn-line'), /you can call a claim/);
    assert.deepEqual(await page.$$eval('[data-action="call"]', (els) => els.map((b) => b.textContent)), ['Call Brannock: two pair, Kings high + 12 to stay in', 'Call Brannock: two pair, Kings high, then fold']);
    assert.ok(await noSideScroll(page));
    await shot(page, `lap-answer-${name}`);
    if (SHOTS) await page.locator('#action-box').screenshot({ path: join(SHOTS, `lap-answer-panel-${name}.png`) });
    await page.click('[data-action="match"]');
    assert.deepEqual(acts.at(-1), { action: 'match' });
    await page.click('[data-action="fold"]');
    assert.deepEqual(acts.at(-1), { action: 'fold' });
    await page.click('[data-action="call"][data-with="match"]');
    assert.deepEqual(acts.at(-1), { action: 'call', seat: 2, match: true });
    await page.click('[data-action="call"][data-with="fold"]');
    assert.deepEqual(acts.at(-1), { action: 'call', seat: 2, fold: true });
    await context.close();
  }
});

test('match or fold: a top-up shows the difference; no claim says so; not your turn shows only the numbers', { timeout: 60_000 }, async () => {
  let scene = await claimScene({ hand: NINES, claims: CLAIMS_TO_BACK, answer: true, queue: [0], raise: { high: 12, by: 2, paid: { 2: 12, 0: 5 } } });
  await scene.page.waitForSelector('[data-action="match"]');
  assert.equal(await scene.page.textContent('[data-action="match"]'), 'Stay in: 7 more (to 12)');
  assert.match(await scene.page.textContent('#facing-small'), /You’re in for 5, so it’s 7 more\./);
  await scene.context.close();

  scene = await claimScene({ hand: NOTHING, claims: [BRANNOCK_KINGS], answer: true, queue: [0, 1], raise: BRANNOCK_12 });
  await scene.page.waitForSelector('[data-action="fold"]');
  assert.match(await scene.page.textContent('#answer-line'), /You have no claim, so you can’t share this pot\./);
  assert.equal(await scene.page.textContent('[data-action="fold"]'), 'Fold');
  assert.match(await scene.page.getAttribute('[data-action="fold"]', 'class'), /primary/);
  await scene.context.close();

  scene = await claimScene({ hand: NINES, claims: CLAIMS_TO_BACK, answer: true, queue: [1, 0], raise: BRANNOCK_12 });
  await scene.page.waitForSelector('#answer-line');
  assert.equal(await scene.page.$('[data-action="match"], [data-action="fold"]'), null);
  await scene.context.close();

  scene = await claimScene({ hand: NINES, claims: [{ seat: 2, claim: [1, 3, 0], status: 'withdrawn' }, { seat: 0, claim: [1, 9, 0], status: 'standing' }], answer: true, queue: [0], raise: { high: 5, by: 3, paid: { 3: 5 } } });
  await scene.page.waitForSelector('.st.withdrawn');
  assert.equal(await scene.page.textContent('.st.withdrawn'), 'withdrawn');
  await scene.context.close();
});

test('a raise in a real round through the server: the page answers it, and a watcher sees the banner with no moves', { timeout: 150_000 }, async () => {
  let seen = false;
  for (let attempt = 0; attempt < 6 && !seen; attempt++) {
    const { context, page, id } = await seated({ rng: 40 + attempt, roundGapMs: 25_000 });
    const facingMe = async () => /or fold$/.test((await page.$('#facing:not([hidden]) #facing-big')) ? await page.textContent('#facing-big') : '');
    await playUntil(page, async () => (await facingMe()) || /over|closed/.test(await page.textContent('#phase')), { limit: 30_000 });
    if (await facingMe()) {
      seen = true;
      const watcher = await session();
      await watcher.page.goto(`${BASE}/table?id=${id}&watch=1`);
      await watcher.page.waitForSelector('#facing:not([hidden])');
      assert.match(await watcher.page.textContent('#facing-big'), /^Raised to \d+$/);
      assert.equal(await watcher.page.$('#actions [data-action="fold"], #stake-row'), null, 'a watcher has no moves');
      await watcher.context.close();
      const asked = await page.textContent('#facing-big');
      const stayIn = await page.$('[data-stake="match"]');
      if (stayIn) await stayIn.click();
      await page.click('#move-row [data-action="check"], #move-row [data-action="match"]');
      // Answered. A bot behind this seat may raise again, and then it's a new price.
      await page.waitForFunction((was) => document.getElementById('facing-big')?.textContent !== was, asked, { timeout: 15_000 });
      assert.deepEqual(page.errors, []);
    }
    await context.close();
  }
  assert.ok(seen, 'a real table raised at this seat on its turn');
});

// ---------- the pass panel, facing a raise, and the pot limit ----------

/** Seat 1 on the page, phone-sized, with an agent in seat 0 driven through the API and bots holding still. */
/** Two people and no bots: seat 1 on the page, seat 0 driven through the API. */
async function twoSeats() {
  const { id } = await apiPost('/tables', { lobbySeconds: 60, stakes: { ante: 5 }, test: { rng: 11, seats: 2, turnMs: 60_000 } });
  const a = await (await fetch(`${BASE}/tables/${id}/join`, { method: 'POST', body: JSON.stringify({ name: 'Ann', kind: 'agent' }) })).json();
  const b = await (await fetch(`${BASE}/tables/${id}/join`, { method: 'POST', body: JSON.stringify({ name: 'Bob', kind: 'agent' }) })).json();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(({ key, token }) => localStorage.setItem(key, token), { key: `hall.seat.${id}`, token: b.token });
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('#pass-confirm', { timeout: 15_000 });
  const meOf = (token) => fetch(`${BASE}/tables/${id}/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const send = (token, body) => fetch(`${BASE}/tables/${id}/act`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const ann = async (body) => send(a.token, { card: (await meOf(a.token)).hand[0], ...body });
  return { id, context, page, ann, mine: () => meOf(b.token), act: (body) => send(b.token, body) };
}

async function facingTable(stakes) {
  const { id } = await apiPost('/tables', { lobbySeconds: 1, stakes, test: { rng: 11, botDelayMs: [60_000, 60_000], turnMs: 60_000 } });
  const a = await (await fetch(`${BASE}/tables/${id}/join`, { method: 'POST', body: JSON.stringify({ name: 'Ann', kind: 'agent' }) })).json();
  const b = await (await fetch(`${BASE}/tables/${id}/join`, { method: 'POST', body: JSON.stringify({ name: 'Bob', kind: 'agent' }) })).json();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(({ key, token }) => localStorage.setItem(key, token), { key: `hall.seat.${id}`, token: b.token });
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/table?id=${id}`);
  await page.waitForSelector('#pass-confirm', { timeout: 15_000 });
  const annMe = await (await fetch(`${BASE}/tables/${id}/me`, { headers: { authorization: `Bearer ${a.token}` } })).json();
  const ann = (body) => fetch(`${BASE}/tables/${id}/act`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ card: annMe.hand[0], ...body }) });
  return { id, context, page, ann };
}

test('the pass panel, facing a raise: Pass + match or Fold, on the same panel, and nothing goes without the match', { timeout: 60_000 }, async () => {
  const { context, page, ann } = await facingTable({ ante: 5 });
  await ann({ action: 'pass', raise: 10 });
  await page.waitForFunction(() => /Pick a card/.test(document.getElementById('pass-confirm').textContent) && !!document.getElementById('pass-fold'));
  assert.match(await page.textContent('#pass-facing'), /Ann raised\. The raise stands at 10/);
  assert.match(await page.textContent('#turn-line'), /pass and pay to stay in, or fold/);
  assert.match(await page.textContent('#phase'), /Raise 10/);
  const card = await page.getAttribute('button.card.face', 'data-card');
  await page.click(`button.card.face[data-card="${card}"]`);
  await page.waitForFunction(() => /^Pass \+ 10 to stay in$/.test(document.getElementById('pass-confirm').textContent.trim()));
  await page.fill('#pass-raise-amount', '5');
  await page.waitForFunction(() => /Pass \+ raise 5 \(you pay 15\)/.test(document.getElementById('pass-raise').textContent));
  assert.equal(await page.isEnabled('#pass-fold'), true);
  await shot(page, 'table-phone-pass-facing');
  await page.click('#pass-confirm');
  await page.waitForFunction(() => !document.getElementById('pass-confirm'));
  assert.match(await page.textContent('#log'), /Bob passes and stays in for 10/);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the pass panel: Fold goes with no card, and a stack that can\'t cover the raise sees only that', { timeout: 60_000 }, async () => {
  const { context, page, ann } = await facingTable({ ante: 5 });
  await ann({ action: 'pass', raise: 25 });
  await page.waitForSelector('#pass-fold');
  await page.click('#pass-fold');
  await page.waitForFunction(() => /Bob folds/.test(document.getElementById('log').textContent));
  assert.equal(await page.$('#pass-confirm'), null);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('pot limit: the top bar says so, a match says what it costs, and the raise control is gone', { timeout: 60_000 }, async () => {
  const { context, page, ann } = await facingTable({ ante: 5, potLimit: 30 });
  assert.equal(await page.isVisible('#pot-limit'), false);
  const card = await page.getAttribute('button.card.face', 'data-card');
  await ann({ action: 'pass', raise: 10 }); // four seats' antes are 20, so a raise of 10 fills the pot
  await page.waitForFunction(() => document.getElementById('pot').textContent === '30');
  await page.waitForSelector('#pot-limit:not([hidden])');
  assert.equal(await page.textContent('#pot-limit'), 'Pot limit reached');
  await page.click(`button.card.face[data-card="${card}"]`);
  await page.waitForFunction(() => /nothing to pay/.test(document.getElementById('pass-confirm').textContent));
  assert.equal(await page.$('#pass-raise'), null);
  assert.match(await page.textContent('#pass-limit'), /Pot limit reached: 30 in the pot/);
  await shot(page, 'table-phone-pot-limit');
  await page.click('#pass-confirm');
  await page.waitForFunction(() => /Bob passes and stays in for 10/.test(document.getElementById('log').textContent));
  assert.equal(await page.textContent('#pot'), '30', 'the pot stayed at its limit');
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- the Round result panel, and raises in sight on Stop & claim ----------

test('Round result: in plain words, the pot, who was paid and why, and my own line; no chain line at a play-chip table', { timeout: 90_000 }, async () => {
  const { context, page } = await seated({ botDelayMs: [0, 0] });
  assert.equal(await page.isVisible('#round-result'), false, 'nothing during a round');
  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  await page.waitForSelector('#round-result:not([hidden])');
  const text = await page.textContent('#round-result');
  assert.match(await page.textContent('#round-result-title'), /Round 1 result · pot \d+/);
  assert.match(text, /takes \d+|carries to the next round/);
  assert.match(await page.textContent('#result-mine'), /You put in \d+, got back \d+ → net (\+\d+|−\d+|0)\./);
  assert.equal(await page.$('#result-chain'), null, 'play chips: nothing about a chain');
  assert.doesNotMatch(text, /null|undefined/);
  const myCards = await page.$$eval('.card.face', (els) => els.map((e) => e.dataset.card));
  const telling = myCards.filter((card) => !/^[2-9]s$/.test(card)); // "9s" is also how a claim label says nines: those codes can't be told apart in prose
  assert.ok(telling.length > 0 && !telling.some((card) => new RegExp(`\\b${card}\\b`).test(text)), `no card in ${text}`);
  await shot(page, 'table-round-result');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('after-round card: my net matches the round panel, my place at the table, the top three with medals, Play again deals, Invite copies a link that seats a friend at this game', { timeout: 90_000 }, async () => {
  const { context, page } = await seated({ botDelayMs: [0, 0] });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  assert.equal(await page.isVisible('#after-round'), false, 'nothing during a round');
  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  await page.waitForSelector('#after-round:not([hidden])');
  const net = (await page.textContent('#ar-net')).trim();
  const mine = (await page.textContent('#result-mine')).match(/net ([+−]?\d+)\./)[1];
  assert.equal(net, mine, 'the card and the round panel agree');
  assert.match(await page.textContent('#ar-place'), /^(1st|2nd|3rd|4th) by stack, of 4 at this table$/);
  const rows = await page.$$eval('#after-round .ar-top .ar-row', (x) => x.map((r) => ({ you: r.classList.contains('you'), medal: r.querySelector('.medal')?.className ?? null, chips: Number(r.querySelector('.ar-chips').textContent) })));
  assert.ok(rows.length === 3 || rows.length === 4, 'top three, and me pinned under them if I am not in it');
  assert.ok(rows.slice(0, 3).every((r) => /medal (gold|silver|bronze)/.test(r.medal)), 'medals on the top three');
  assert.ok(rows.slice(0, 3).every((r, i, all) => i === 0 || all[i - 1].chips >= r.chips), 'best stack first');
  assert.equal(rows.filter((r) => r.you).length, 1, 'my row is marked');
  assert.equal(await page.$('#actions [data-action="next"]'), null, 'one way to deal: the card');
  assert.equal(await page.$$eval('#move-row button', (b) => b.length), 0, 'the round is over: no move can be pressed, only Next round and Leave');
  assert.equal(await page.isVisible('#move-row'), false);
  await page.click('#ar-invite');
  await page.waitForFunction(() => /Invite link copied|\/\?play=/.test(document.querySelector('.ar-copied').textContent));
  const invite = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(invite, `${new URL(page.url()).origin}/?play=sealed-hand`, 'a seat at this game, not this full table');
  // A friend who opens it, in their own browser, is asked their name for a seat: never dropped in as a watcher.
  const friend = await session(PHONE);
  await friend.page.goto(invite);
  await friend.page.waitForSelector('#menu [data-id="who-new"]', { timeout: 15000 }); // New here, or bringing a Player ID?
  await friend.page.click('#menu [data-id="who-new"]');
  await friend.page.waitForSelector('#seat-form:not([hidden])', { timeout: 15000 });
  await friend.page.waitForFunction(() => /What name/.test(document.getElementById('line').textContent), null, { timeout: 10000 });
  await friend.page.fill('#seat-name', 'Friend');
  await friend.page.click('#seat-form button[type="submit"]');
  await friend.page.click('#looks [data-look="adventurer"]'); // a name, then an avatar
  await friend.page.click('#menu [data-id="look-ok"]');
  await friend.page.waitForSelector('#buyin-form:not([hidden])'); // then the bring prompt for the game in the link
  assert.equal((await friend.page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Sealed Hand with 1,000');
  await friend.page.click('#menu [data-id="sit"]');
  await friend.page.waitForURL(/\/table\?id=/, { timeout: 30000 });
  assert.notEqual(new URL(friend.page.url()).searchParams.get('id'), new URL(page.url()).searchParams.get('id'), 'a waiting table or a new one, not the full table in play');
  assert.equal(new URL(friend.page.url()).searchParams.get('watch'), null);
  assert.deepEqual(friend.page.errors, []);
  await friend.context.close();
  await page.click('#ar-again');
  await page.waitForFunction(() => /Round 2/.test(document.getElementById('phase').textContent));
  await page.waitForSelector('#after-round', { state: 'hidden' });
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('Stop & claim: +5, +10 and +25 are in sight, and one tap puts the raise on the move', { timeout: 60_000 }, async () => {
  const { id, context, page, ann, mine, act } = await twoSeats();
  for (let window = 0; window < 2; window += 1) {
    await ann({ action: 'pass' });
    await act({ action: 'pass', card: (await mine()).hand[0] });
  }
  await page.waitForSelector('#stop-open', { timeout: 10_000 });
  assert.equal(await page.$('#stake-quick'), null, 'it comes with the panel');
  await page.click('#stop-open');
  await page.waitForSelector('#stake-quick');
  assert.deepEqual(await page.$$eval('#stake-quick button', (x) => x.map((y) => y.textContent)), ['+5', '+10', '+25']);
  assert.equal(await page.isVisible('#stake-quick'), true);
  assert.equal(await page.isVisible('#stake-amount'), false, 'the typed amount stays out of the way');
  await page.click('[data-quick-raise="10"]');
  assert.equal(await page.getAttribute('[data-stake="raise"]', 'aria-pressed'), 'true');
  assert.equal(await page.inputValue('#raise-amount'), '10');
  assert.ok(id);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the table view: a seated player looks across it, with the others drawn and themselves in the corner, lit on their turn', { timeout: 60_000 }, async () => {
  const { id, context, page, ann } = await twoSeats();
  await page.waitForSelector('#me-corner');
  assert.equal(await page.$('[data-sprite][data-seat="1"]'), null, 'my own figure is not in the line-up');
  assert.ok(await page.$('[data-sprite][data-seat="0"]'), 'the other seat is');
  assert.match(await page.textContent('#me-corner'), /Bob/);
  assert.match(await page.textContent('#me-chips'), /\d+/);
  const box = await page.$eval('#me-corner', (el) => { const a = el.getBoundingClientRect(); const s = document.getElementById('scene').getBoundingClientRect(); return { right: s.right - a.right, bottom: s.bottom - a.bottom, width: a.width }; });
  assert.ok(box.right < 12 && box.bottom < 14 && box.width < 100, `bottom right and small, where a laptop's crop never reaches: ${JSON.stringify(box)}`);
  // It's my turn while I haven't passed: lit, with the ring on me and on the other seat while they haven't either.
  assert.equal(await page.$eval('#me-corner', (el) => el.classList.contains('turn')), true);
  assert.equal(await page.$eval('[data-plate="1"]', (el) => el.classList.contains('turn')), true, 'and my seat card');
  await ann({ action: 'pass' });
  await page.waitForFunction(() => !document.querySelector('[data-ring="0"]'));
  assert.ok(await page.$('#me-corner [data-ring="1"]'), 'the ring is mine now, on my portrait');
  // A watcher sees every seat.
  const watcher = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const watching = await watcher.newPage();
  await watching.route('https://fonts.**', (r) => r.abort());
  await watching.goto(`${BASE}/table?id=${id}&watch=1`);
  await watching.waitForSelector('[data-sprite][data-seat="1"]');
  assert.ok(await watching.$('[data-sprite][data-seat="0"]'));
  assert.equal(await watching.$('#me-corner'), null);
  await watcher.close();
  await context.close();
});

// ---------- polish (11-04): a press answers at once, the greeting keeps out of the way, one press is one request ----------

test('the greeting keeps out of the way of a sign opened while the purse was still loading', { timeout: 60_000 }, async () => {
  const player = await apiPost('/players', { name: 'Early' });
  const { context, page } = await session();
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('hall.player', t), player.token);
  await page.route('**/players/me/seats', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
  await page.goto(BASE);
  await page.waitForSelector('[data-game="sealed-hand"]');
  await page.click('[data-game="sealed-hand"]'); // the game picked: its bring prompt, once the purse is in
  await page.waitForSelector('#buyin-form:not([hidden])', { timeout: 10_000 });
  await page.waitForSelector('#who:not(:empty)', { timeout: 10_000 }); // the purse has landed: this is when the greeting used to write over the sign
  await page.waitForTimeout(800);
  assert.ok(await page.$('#buyin-form:not([hidden])'), 'the bring prompt is still open');
  assert.match(await page.textContent('#line'), /^Sealed Hand/);
  assert.equal(await page.$('#menu [data-id="seat"]'), null, 'no greeting over it');
  await page.click('#doorman');
  await page.waitForSelector('#menu [data-id="seat"]');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('Enter the Hall: a double press on "This one" makes one player', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/players') posts += 1; });
  await page.route('**/players', async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
  await page.goto(BASE);
  await page.waitForSelector('#menu [data-id="who-new"]');
  await page.click('#menu [data-id="who-new"]');
  await page.waitForSelector('#seat-form:not([hidden])');
  await page.fill('#seat-name', 'Twice');
  await page.click('#seat-form button[type="submit"]');
  await page.click('#looks [data-look="adventurer"]');
  await page.$eval('#menu [data-id="look-ok"]', (b) => { b.click(); b.click(); }); // two presses, one player
  await page.waitForSelector('#menu [data-id="seat"]'); // in the Hall
  assert.equal(posts, 1);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('a move goes busy the moment it is pressed, and Leave is one request however often it is pressed', { timeout: 60_000 }, async () => {
  const { context, page, acts } = await seated({ botDelayMs: [20_000, 20_000] });
  await page.route('**/act', async (r) => { await new Promise((ok) => setTimeout(ok, 700)); await r.continue(); });
  const code = await page.getAttribute('button.card.face', 'data-card');
  await page.click(`[data-card="${code}"]`);
  await page.click('#pass-confirm');
  assert.equal(await page.getAttribute('#pass-confirm', 'aria-busy'), 'true', 'busy at once');
  assert.equal((await page.textContent('#pass-confirm')).trim(), 'Passing');
  await page.waitForFunction(() => !document.getElementById('pass-confirm'), null, { timeout: 10_000 });
  assert.deepEqual(acts, [{ action: 'pass', card: code }]);
  await page.unroute('**/act');

  let leaves = 0;
  page.on('request', (r) => { if (r.url().endsWith('/leave')) leaves += 1; });
  await page.route('**/leave', async (r) => { await new Promise((ok) => setTimeout(ok, 500)); await r.continue(); });
  await page.waitForSelector('#leave:not([hidden])');
  await page.$eval('#leave', (b) => { b.click(); b.click(); });
  assert.equal(await page.getAttribute('#leave', 'aria-busy'), 'true');
  assert.equal((await page.textContent('#leave')).trim(), 'Leaving');
  await page.waitForFunction(() => /Leaving after this round/.test(document.getElementById('leave').textContent), null, { timeout: 15_000 });
  assert.equal(leaves, 1);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the round result lands inside Your move: the scene stays where it was', { timeout: 90_000 }, async () => {
  const { context, page } = await seated({ botDelayMs: [0, 0] });
  const top = () => page.$eval('.scene', (el) => Math.round(el.getBoundingClientRect().top + scrollY));
  const during = await top();
  await playUntil(page, async () => /Round 1 over/.test(await page.textContent('#phase')));
  await page.waitForSelector('#round-result:not([hidden])');
  assert.ok(await page.$('#action-box #round-result'), 'inside the move panel');
  assert.equal(await top(), during, 'nothing above the panel moved');
  assert.doesNotMatch(await page.textContent('#turn-line'), /takes \d+/, 'the panel says the result; the line says what is next');
  await context.close();
});

// ---------- table flow fixes (11-04): one seat at a time, carried; the Hall's button asks; the hand stays in view ----------

const flowPlayer = async (name, chips = 500) => apiPost('/players', { name, testChips: chips });
const chipTable = async (apiBase, lobbySeconds = 300) => (await fetch(`${BASE}${apiBase}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lobbySeconds }) })).json();
const sitAt = async (apiBase, id, token, buyIn) => (await fetch(`${BASE}${apiBase}/${id}/join`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: 'human', ...(buyIn ? { buyIn } : {}) }) })).json();
const mySeats = async (token) => (await (await fetch(`${BASE}/players/me/seats`, { headers: { authorization: `Bearer ${token}` } })).json()).seats;
const myPurse = async (token) => (await (await fetch(`${BASE}/players/me`, { headers: { authorization: `Bearer ${token}` } })).json()).purse.amount;

test('seated at dice, Join on a card table in the Hall asks; Yes leaves the dice seat, carries the whole purse as one stack, and lands seated at the cards', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Mover');
  const dice = await chipTable('/dice-tables');
  const sit = await sitAt('/dice-tables', dice.id, player.token, 200);
  const cards = await chipTable('/tables');
  const other = await flowPlayer('Other');
  await sitAt('/tables', cards.id, other.token, 50); // listed in the Hall once someone sits
  const { context, page } = await session();
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${dice.id}`, sv: sit.token });
  await page.goto(BASE);
  await page.waitForSelector('#menu [data-id="return"]');
  assert.match(await page.textContent('#menu [data-id="return"]'), /^Back to Cup & Claim, table \d+ \(200 chips\)$/);
  await page.waitForSelector(`#in-play .row[data-table="${cards.id}"] button`, { timeout: 15000 });
  await page.click(`#in-play .row[data-table="${cards.id}"] button`);
  await page.waitForFunction(() => /still seated at Cup & Claim, table \d+ \(200 chips\)\. Leave it and bring your stack here\?/.test(document.getElementById('line').textContent), null, { timeout: 15000 });
  assert.deepEqual(await page.$$eval('#menu .menu-item', (b) => b.map((x) => x.dataset.id)), ['move', 'return']);
  await page.click('#menu [data-id="move"]');
  await page.waitForURL(`${BASE}/table?id=${cards.id}`, { timeout: 30000 });
  await page.waitForFunction(() => /Your stack 500/.test(document.getElementById('purse-bar').textContent), null, { timeout: 15000 });
  assert.deepEqual((await mySeats(player.token)).map((s) => [s.game, s.stack]), [['sealed-hand', 500]], 'one seat, the whole purse');
  assert.equal(await myPurse(player.token), 0);
  await context.close();
});

test('on a table page with a seat held elsewhere, the join box offers to leave it and bring the stack here, and does', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Hopper');
  const dice = await chipTable('/dice-tables');
  const sit = await sitAt('/dice-tables', dice.id, player.token, 500); // the whole purse: 500 (a seat with no amount named now takes the 1,000 default)
  const cards = await chipTable('/tables');
  const { context, page } = await session();
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${dice.id}`, sv: sit.token });
  await page.goto(`${BASE}/table?id=${cards.id}&join=1`);
  await page.waitForSelector('#join-move', { timeout: 15000 });
  assert.match(await page.textContent('#join-note'), /still seated at Cup & Claim, table \d+ \(500 chips\)/);
  await page.click('#join-move');
  await page.waitForFunction(() => /Your stack 500/.test(document.getElementById('purse-bar').textContent), null, { timeout: 30000 });
  assert.ok(page.url().includes(`/table?id=${cards.id}`), 'still on the card page, now seated');
  assert.deepEqual((await mySeats(player.token)).map((s) => [s.game, s.stack]), [['sealed-hand', 500]]);
  await context.close();
});

test('the Hall button while seated asks first: Stay stays; Leave and go leaves with the stack and opens the Hall; not seated, it is just a link', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Walker');
  const cards = await chipTable('/tables');
  const sit = await sitAt('/tables', cards.id, player.token, 120);
  const { context, page } = await session();
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${cards.id}`, sv: sit.token });
  await page.goto(`${BASE}/table?id=${cards.id}`);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 15000 });
  await page.click('header.hud a[href="/"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  assert.equal(await page.textContent('#confirm-leave-line'), 'You’re seated at Sealed Hand with 120 chips. Leave the table and go to the Hall?');
  await page.click('#confirm-leave-stay');
  assert.ok(page.url().includes('/table?id='), 'stayed');
  assert.ok(await page.evaluate(() => document.getElementById('confirm-leave').hidden));
  await page.click('header.hud a[href="/"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  await page.click('#confirm-leave-go');
  await page.waitForURL(BASE + '/', { timeout: 20000 });
  assert.deepEqual(await mySeats(player.token), []);
  assert.equal(await myPurse(player.token), 500, 'the stack came back to the purse');
  // Not seated: the button is a plain link.
  await page.goto(`${BASE}/table?id=${cards.id}&watch=1`);
  await page.waitForSelector('#phase');
  await page.click('header.hud a[href="/"]');
  await page.waitForURL(BASE + '/', { timeout: 10000 });
  await context.close();
});

test('the top bar: the same list on every page; nothing links to a page that doesn’t exist; no Cage or tNIGHT here; a phone folds it into one button', { timeout: 60000 }, async () => {
  const { context, page } = await session();
  await page.goto(BASE + '/');
  await page.waitForSelector('#topnav .nav-top');
  await page.waitForTimeout(600);
  assert.deepEqual(await page.$$eval('#topnav .nav-top', (a) => a.map((x) => x.textContent.replace(/\s+/g, ' ').trim())), ['The Hall', 'Games ▾', 'Agents ▾', 'Records ▾', 'Player ▾'], 'no Cage: the cage page is off here');
  assert.deepEqual(await page.$$eval('#topnav .nav-drop:nth-child(5) .nav-item', (a) => a.map((x) => x.textContent.trim())), ['Change look', 'Player ID'], 'Menu → Player (11-10): actions on this page, not links');
  const hrefs = await page.$$eval('#topnav a', (a) => a.map((x) => x.getAttribute('href')).sort());
  assert.deepEqual(hrefs, ['/', '/?play=cup-and-claim', '/?play=sealed-hand', '/agents', '/agents/llms.txt', '/leaderboard', '/lobby', '/records', '/start']);
  for (const href of hrefs) assert.ok((await fetch(BASE + href.split('?')[0])).status === 200, href + ' is a page that exists');
  assert.deepEqual(await page.$$eval('#topnav .soon', (a) => a.map((x) => x.textContent.replace(/\s+/g, ' ').trim())), ['Axe Lane coming soon', 'Midnight City coming soon', 'Your receipts coming soon', 'Hand history coming soon']);
  assert.ok(await page.$$eval('#topnav .soon', (a) => a.every((x) => x.getAttribute('aria-disabled') === 'true' && !x.closest('a'))), 'greyed entries are not links');
  assert.ok(!/tnight/i.test(await page.innerText('#topnav')));
  await page.hover('#topnav .nav-drop:nth-child(2) > button');
  assert.ok(await page.isVisible('#topnav .nav-drop:nth-child(2) .nav-menu'), 'opens on hover');
  await page.mouse.move(700, 500);
  await page.keyboard.press('Escape');
  await context.close();
  const phone = await session({ viewport: { width: 390, height: 844 } });
  await phone.page.goto(BASE + '/');
  await phone.page.waitForSelector('.nav-burger');
  assert.ok(await phone.page.isVisible('.nav-burger'));
  assert.ok(!(await phone.page.isVisible('.nav-list')), 'folded');
  await phone.page.click('.nav-burger');
  await phone.page.click('.nav-drop:nth-child(2) > button');
  assert.ok(await phone.page.isVisible('.nav-drop:nth-child(2) .nav-menu'), 'opens on tap');
  assert.ok(await noSideScroll(phone.page));
  assert.deepEqual(phone.page.errors, []);
  await phone.context.close();
});

test('narrow screens crop both rooms to a band of the table (Phase A, 11-07): the card table from above the heads to the pot, 150 px tall; the saloon to its table, cups and heads: the hand sits as before and nothing is cut at the neck', { timeout: 120000 }, async () => {
  for (const [w, h] of [[960, 800], [390, 844], [430, 760]]) {
    for (const [label, apiBase, path, band] of [['cards', '/tables', '/table', 0.4], ['dice', '/dice-tables', '/dice', 0.4]]) { // the saloon's band: rows 690 to 1380 of 1728 (dice.js ROOM.narrowCrop)
      const player = await flowPlayer(`Crop${label}${w}`, 300);
      const t = await chipTable(apiBase, 0);
      const sit = await sitAt(apiBase, t.id, player.token, 100);
      const { context, page } = await session({ viewport: { width: w, height: h } });
      await page.addInitScript(({ k, v, pk, pv }) => { localStorage.setItem(k, v); localStorage.setItem(pk, pv); }, { k: `hall.seat.${t.id}`, v: sit.token, pk: 'hall.player', pv: player.token });
      await page.goto(`${BASE}${path}?id=${t.id}`);
      await page.waitForFunction(() => document.getElementById('scene')?.getBoundingClientRect().height > 0 && getComputedStyle(document.documentElement).getPropertyValue('--crop-top') !== '', null, { timeout: 20000 });
      await page.waitForTimeout(800);
      const m = await page.evaluate(() => {
        const wrap = document.querySelector('.scene-wrap').getBoundingClientRect();
        const scene = document.getElementById('scene').getBoundingClientRect();
        return { wrapH: wrap.height, sceneH: scene.height, top: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--crop-top')), sceneTop: scene.top - wrap.top, sceneW: scene.width };
      });
      const tag = `${label} ${w}x${h}`;
      if (label === 'dice') { // the saloon on a narrow screen (Phase A, 11-07): a band of the table, full width, the cup and the move above it
        assert.ok(Math.abs(m.wrapH / m.sceneH - band) < 0.02, `${tag}: the band is ${band} of the room, got ${m.wrapH / m.sceneH}`);
        assert.ok(m.top > 0.3 && m.sceneTop < 0, `${tag}: the wall above is what is cut`);
        assert.ok(m.sceneW <= w && m.sceneW >= w - 20, `${tag}: the room fills the width: ${m.sceneW} of ${w}`);
        assert.ok(await noSideScroll(page), `${tag}: no sideways scroll`);
        assert.deepEqual(page.errors, []);
        await context.close();
        continue;
      }
      assert.ok(Math.abs(m.wrapH - 150) <= 1 || (m.wrapH < 150 && m.sceneW >= w - 20), `${tag}: the band is 150 px tall (or the whole width's worth), got ${m.wrapH}`);
      assert.ok(Math.abs(m.wrapH / m.sceneH - band) < 0.02, `${tag}: the band is ${band} of the scene, got ${m.wrapH / m.sceneH}`);
      assert.ok(m.top > (label === 'dice' ? 0.3 : 0.4) && m.sceneTop < 0, `${tag}: the wall above is what is cut`);
      assert.ok(m.sceneW <= w, `${tag}: the scene fits the width`);
      assert.ok(await noSideScroll(page), `${tag}: no sideways scroll`);
      assert.deepEqual(page.errors, []);
      await context.close();
    }
  }
  // Roomy screens are not cropped.
  const { context, page } = await session({ viewport: { width: 1440, height: 1000 } });
  const player = await flowPlayer('CropRoomy', 300);
  const t = await chipTable('/tables', 0);
  const sit = await sitAt('/tables', t.id, player.token, 100);
  await page.addInitScript(({ k, v, pk, pv }) => { localStorage.setItem(k, v); localStorage.setItem(pk, pv); }, { k: `hall.seat.${t.id}`, v: sit.token, pk: 'hall.player', pv: player.token });
  await page.goto(`${BASE}/table?id=${t.id}`);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--crop-top').trim()), '0');
  await context.close();
});

test('the agents page: the bar, the examples with this Hall’s address, the script as the file, Copy that copies, the footer, and a phone without sideways scroll', { timeout: 60000 }, async () => {
  for (const [w, h] of [[1440, 820], [390, 844]]) {
    const { context, page } = await session({ viewport: { width: w, height: h } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
    await page.goto(BASE + '/agents');
    await page.waitForSelector('#topnav');
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('example').textContent));
    assert.equal(await page.title(), 'Bring your agent');
    const text = await page.innerText('main');
    assert.ok(text.includes(BASE + '/lobby/open') && text.includes(BASE + '/agents/llms.txt') && !text.includes('{{HALL}}'), 'examples carry this Hall address');
    assert.ok(/Not built yet/.test(text) && /MCP server/.test(text) && /scripted house players/.test(text));
    assert.equal(await page.textContent('#example'), readFileSync(new URL('../public/agent-example.mjs', import.meta.url), 'utf8'));
    assert.ok((await page.$$('.code .copy')).length >= 7, 'a Copy button on every code block');
    await page.click('#example-box .copy');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), readFileSync(new URL('../public/agent-example.mjs', import.meta.url), 'utf8'), 'Copy copies exactly the script');
    assert.deepEqual(await page.$$eval('#support [data-copy]', (b) => b.length), 2, 'the support footer');
    assert.ok(await page.isHidden('#example-py'), 'Python waits behind its tab');
    await page.click('#tab-py');
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('example-py-code').textContent));
    assert.ok(await page.isVisible('#example-py') && await page.isHidden('#example-js'), 'the tab shows Python');
    assert.equal(await page.textContent('#example-py-code'), readFileSync(new URL('../public/agent-example.py', import.meta.url), 'utf8'), 'the Python file as served');
    assert.equal(await page.getAttribute('#tab-py', 'aria-selected'), 'true');
    await page.click('#tab-js');
    if (w > 860) await page.hover('#topnav .nav-drop:nth-child(3) > button'); else { await page.click('.nav-burger'); await page.click('.nav-drop:nth-child(3) > button'); }
    assert.deepEqual(await page.$$eval('.nav-drop:nth-child(3) .nav-item', (a) => a.map((x) => [x.getAttribute('href'), x.textContent.replace(/\s+/g, ' ').trim()])), [['/agents', 'Bring your agent'], ['/agents/llms.txt', 'Agent sheet (llms.txt)'], [null, 'Midnight City coming soon']]);
    assert.ok(await noSideScroll(page), 'no sideways scroll at ' + w);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('the top bar while seated: a link out of the table asks first, naming where; Leave and go leaves with the stack and lands there', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Navver');
  const cards = await chipTable('/tables');
  const sit = await sitAt('/tables', cards.id, player.token, 120);
  const { context, page } = await session();
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${cards.id}`, sv: sit.token });
  await page.goto(`${BASE}/table?id=${cards.id}`);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 15000 });
  await page.hover('#topnav .nav-drop:nth-child(2) > button');
  await page.click('#topnav a[href="/?play=cup-and-claim"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  assert.equal(await page.textContent('#confirm-leave-line'), 'You’re seated at Sealed Hand with 120 chips. Leave the table and go to Cup & Claim?');
  await page.click('#confirm-leave-stay');
  assert.ok(page.url().includes('/table?id='), 'stayed');
  await page.hover('#topnav .nav-drop:nth-child(2) > button');
  await page.click('#topnav a[href="/?play=cup-and-claim"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  await page.click('#confirm-leave-go');
  await page.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
  await page.waitForSelector('#line');
  assert.deepEqual(await mySeats(player.token), [], 'the old seat is gone');
  assert.equal(await myPurse(player.token), 500, 'the stack is back in the purse');
  assert.ok(!page.url().includes('play='), 'the address is clean again');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('on a laptop (1440×820) the dice page keeps the cup and the Bid button above the fold, and the card page its hand and move; on a phone the hand or cup is in view at both games', { timeout: 90000 }, async () => {
  for (const [w, h] of [[1440, 820], [390, 844]]) {
    for (const [label, apiBase, path] of [['dice', '/dice-tables', '/dice'], ['cards', '/tables', '/table']]) {
      const player = await flowPlayer(`Fit${label}${w}`, 300);
      const t = await chipTable(apiBase, 0);
      const sit = await sitAt(apiBase, t.id, player.token, 100);
      const context = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await context.newPage();
      await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${t.id}`, sv: sit.token });
      await page.route('https://fonts.**', (r) => r.abort());
      await page.goto(`${BASE}${path}?id=${t.id}`);
      await page.waitForFunction(() => /Round 1/.test(document.getElementById('phase')?.textContent ?? '') || document.querySelector('#action-box button:not([hidden])'), null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => { const r = (sel) => document.querySelector(sel)?.getBoundingClientRect(); const bid = [...document.querySelectorAll('#action-box button')].find((b) => /^Bid/.test(b.textContent)); return { hand: (r('#cup-box') ?? r('#hand-box'))?.bottom, board: r('#felt-bid')?.bottom, bid: bid?.getBoundingClientRect().bottom ?? null, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      assert.ok(m.hand <= h, `${label} ${w}×${h}: the hand ends at ${Math.round(m.hand)}, inside ${h}`); // on a phone the cup or hand comes right under the seat strip (Phase A, 11-07)
      if (w >= 980 && label === 'dice') assert.ok(m.bid !== null && m.bid <= h, `${label} ${w}×${h}: the Bid button ends at ${m.bid}, inside ${h}`);
      assert.ok(m.over <= 0, `${label} ${w}×${h}: no sideways scroll`);
      await context.close();
    }
  }
});

test('the panel says who you are trusting, and a chip table does not claim the chain', async () => {
  const cards = await chipTable('/tables');
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/table?id=${cards.id}&watch=1`);
  await page.waitForSelector('#trust');
  const text = await page.textContent('#trust');
  assert.match(text, /Your cards/);
  assert.match(text, /Other players never see them\. The house deals them\./);
  assert.match(text, /The claim check/);
  assert.match(text, /house’s word, for now/);
  assert.match(await page.textContent('#trust-chips'), /^Play chips, on the house’s ledger\. Nothing here goes on chain\.$/);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('a seat the Hall list no longer shows is still named by game and table', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Offlist');
  const cards = await chipTable('/tables');
  const sit = await sitAt('/tables', cards.id, player.token, 120);
  const { context, page } = await session();
  await page.route(/\/(games|hall)$/, async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    for (const game of data.games) game.tables = game.tables.filter((t) => t.id !== cards.id);
    await route.fulfill({ response: res, json: data });
  });
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${cards.id}`, sv: sit.token });
  await page.goto(BASE);
  await page.waitForSelector('#menu [data-id="return"]');
  assert.match((await page.textContent('#menu [data-id="return"]')).trim(), /^Back to Sealed Hand, table \d+ \(120 chips\)$/);
  await context.close();
});

test('seated at dice, the Games link to Sealed Hand asks, and Yes lands at a card table with the one stack', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Linker');
  const dice = await chipTable('/dice-tables');
  const sit = await sitAt('/dice-tables', dice.id, player.token, 200);
  const { context, page } = await session();
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${dice.id}`, sv: sit.token });
  await page.goto(`${BASE}/?play=sealed-hand`);
  await page.waitForFunction(() => /still seated at Cup & Claim, table \d+ \(200 chips\)\. Leave it and bring your stack here\?/.test(document.getElementById('line').textContent), null, { timeout: 15000 });
  await page.click('#menu [data-id="move"]');
  await page.waitForURL(/\/table\?id=/, { timeout: 30000 });
  await page.waitForFunction(() => /Your stack 500/.test(document.getElementById('purse-bar').textContent), null, { timeout: 15000 });
  assert.deepEqual((await mySeats(player.token)).map((s) => [s.game, s.stack]), [['sealed-hand', 500]]);
  assert.equal(await myPurse(player.token), 0);
  await context.close();
});

test('seated at the cards, the Games link to Sealed Hand goes back to the seat without asking', { timeout: 60000 }, async () => {
  const player = await flowPlayer('Stayer');
  const cards = await chipTable('/tables');
  const sit = await sitAt('/tables', cards.id, player.token, 200);
  const { context, page } = await session();
  await page.addInitScript(({ pk, pv, sk, sv }) => { localStorage.setItem(pk, pv); localStorage.setItem(sk, sv); }, { pk: 'hall.player', pv: player.token, sk: `hall.seat.${cards.id}`, sv: sit.token });
  await page.goto(`${BASE}/?play=sealed-hand`);
  await page.waitForURL(`${BASE}/table?id=${cards.id}`, { timeout: 15000 });
  assert.equal((await mySeats(player.token)).length, 1);
  await context.close();
});

test('the table picker: one row per table with its ante, seated faces and open chairs, hand in play or waiting; Cards / Dice filters stick, and fit a phone', { timeout: 60000 }, async () => {
  const waiting = await apiPost('/tables', { lobbySeconds: 300 });
  await apiPost(`/tables/${waiting.id}/join`, { name: 'Mira', avatar: 'mage' });
  const dice = await (await fetch(`${BASE}/dice-tables`, { method: 'POST', body: JSON.stringify({ lobbySeconds: 0, seats: 4 }) })).json();
  await fetch(`${BASE}/dice-tables/${dice.id}/join`, { method: 'POST', body: JSON.stringify({ name: 'Wren', avatar: 'rogue' }) });
  const { context, page } = await session(PHONE);
  await page.goto(BASE);
  const cardRow = `#in-play .row[data-table="${waiting.id}"]`;
  const diceRow = `#in-play .row[data-table="${dice.id}"]`;
  await page.waitForSelector(diceRow, { timeout: 15000 });
  await page.waitForFunction((sel) => /Hand in play/.test(document.querySelector(sel)?.textContent ?? ''), diceRow, { timeout: 15000 });
  assert.match(await page.textContent(cardRow), /Sealed Hand · table \d+Ante 1 · play chips/);
  assert.match(await page.textContent(cardRow), /1\/4/);
  assert.match(await page.textContent(cardRow), /Waiting · 3 open/);
  assert.equal(await page.$$eval(`${cardRow} .seat-faces .face:not(.empty)`, (x) => x.length), 1, 'one face');
  assert.equal(await page.$$eval(`${cardRow} .seat-faces .face.empty`, (x) => x.length), 3, 'three empty chairs');
  assert.equal(await page.getAttribute(`${cardRow} .seat-stack`, 'aria-label'), '1 of 4 seats taken');
  assert.equal((await page.textContent(`${cardRow} button`)).trim(), 'Join');
  assert.match(await page.textContent(diceRow), /Cup & Claim · table \d+Ante 5/);
  assert.equal(await page.$(`${diceRow} button`), null, 'a hand in play has no Join, only Watch');
  assert.ok(await noSideScroll(page), 'no sideways scroll at 390');
  await page.click('#dialogue-close');
  await page.click('[data-filter="dice"]');
  assert.equal(await page.$(cardRow), null, 'Dice hides the card tables');
  assert.ok(await page.$(diceRow));
  assert.equal(await page.getAttribute('[data-filter="dice"]', 'aria-pressed'), 'true');
  await page.reload();
  await page.waitForSelector(diceRow, { timeout: 15000 });
  assert.equal(await page.$(cardRow), null, 'the filter is remembered');
  await page.click('#dialogue-close');
  await page.click('[data-filter="cards"]');
  assert.ok(await page.$(cardRow));
  assert.equal(await page.$(diceRow), null);
  await page.click('[data-filter="all"]');
  assert.ok(await page.$(cardRow) && await page.$(diceRow));
  assert.deepEqual(page.errors, []);
  await context.close();
});

/** One Cup & Claim round for a player with a purse, played through the API to its end. Returns the table id. */
async function playDiceRound(token, rng) {
  const t = await (await fetch(`${BASE}/dice-tables`, { method: 'POST', body: JSON.stringify({ lobbySeconds: 0, test: { rng, roundGapMs: 600_000 } }) })).json();
  const seat = await (await fetch(`${BASE}/dice-tables/${t.id}/join`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: 'human', buyIn: 100 }) })).json();
  if (!seat.token) throw new Error(`join: ${JSON.stringify(seat)} table: ${JSON.stringify(t)}`);
  for (let i = 0; i < 200; i++) {
    const v = await (await fetch(`${BASE}/dice-tables/${t.id}`)).json();
    if (v.phase === 'settled' || v.phase === 'over') break;
    const me = await (await fetch(`${BASE}/dice-tables/${t.id}/me`, { headers: { authorization: `Bearer ${seat.token}` } })).json();
    const can = (name) => me.legal.find((x) => x.action === name);
    const action = can('reveal') ? { action: 'reveal', mode: 'show' } : can('liar') ? { action: 'liar' } : can('bid') ? { action: 'bid', ...can('bid').lowest } : null;
    if (action) await fetch(`${BASE}/dice-tables/${t.id}/act`, { method: 'POST', headers: { authorization: `Bearer ${seat.token}` }, body: JSON.stringify(action) });
    else await new Promise((r) => setTimeout(r, 100));
  }
  await fetch(`${BASE}/dice-tables/${t.id}/leave`, { method: 'POST', headers: { authorization: `Bearer ${seat.token}` }, body: '{}' });
  return t.id;
}

test('leaderboard: real rounds put players on this week\'s slate, best net first with medals; my row is marked, and pinned while it is out of sight; a made-up token finds nobody', { timeout: 120_000 }, async () => {
  const players = [];
  for (const [i, name] of ['Ash', 'Bree', 'Cole'].entries()) {
    const p = await (await fetch(`${BASE}/players`, { method: 'POST', body: JSON.stringify({ name: `${name}${Date.now() % 1000}`, avatar: 'rogue', testChips: 300 }) })).json();
    await playDiceRound(p.token, 40 + i);
    players.push(p);
  }
  let board;
  for (let i = 0; i < 40; i++) {
    board = await (await fetch(`${BASE}/board`, { headers: { authorization: `Bearer ${players[2].token}` } })).json();
    if (players.every((p) => board.rows.some((r) => r.name === p.name)) && board.you) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(board.you, 'my own row comes back with my token');
  assert.equal(board.you.name, players[2].name);
  assert.equal(board.you.rounds, 1);
  assert.ok(board.rows.every((r, i, all) => i === 0 || all[i - 1].net >= r.net), 'best net first');
  assert.ok(!JSON.stringify(board).includes(players[2].playerId), 'no player id in the answer');
  assert.match(board.counts, /House bots and tNIGHT tables are not counted/);
  const forged = await (await fetch(`${BASE}/board`, { headers: { authorization: `Bearer ${players[0].playerId}.${'0'.repeat(64)}` } })).json();
  assert.equal(forged.you, null, 'someone else\'s id with a made-up secret gets no row');
  const last = await (await fetch(`${BASE}/board?week=last`)).json();
  assert.equal(last.week.which, 'last');

  const { context, page } = await session({ ...PHONE, viewport: { width: 390, height: 420 } });
  await page.addInitScript((t) => localStorage.setItem('hall.player', t), players[2].token);
  await page.goto(`${BASE}/leaderboard`);
  await page.waitForSelector('#board-list .board-row');
  const rows = await page.$$eval('#board-list .board-row', (x) => x.map((r) => ({ you: r.classList.contains('you'), medal: !!r.querySelector('.medal'), rank: Number((r.querySelector('.medal') ?? r.querySelector('.board-rank')).textContent) })));
  assert.deepEqual(rows.slice(0, 3).map((r) => r.medal), [true, true, true], 'medals on the top three');
  // a tie shares its rank (src/platform/board.js), so a tie for third is two thirds, both with medals: a medal is ranks 1 to 3
  assert.ok(rows.every((r) => r.medal === (r.rank <= 3)), `a medal exactly on ranks 1 to 3: ${JSON.stringify(rows.map((r) => [r.rank, r.medal]))}`);
  assert.deepEqual(rows.map((r) => r.rank), board.rows.slice(0, rows.length).map((r) => r.rank), 'the ranks the board gave');
  assert.equal(rows.filter((r) => r.you).length, 1);
  assert.match(await page.textContent('#board-you'), /\(you\)/);
  assert.match(await page.textContent('#board-clock'), /^New week in /);
  await page.waitForSelector('#board-pinned:not([hidden])');
  assert.match(await page.textContent('#board-pinned'), new RegExp(`${players[2].name} \\(you\\)`), 'my row is pinned while it is below the fold');
  await page.$eval('#board-you', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForSelector('#board-pinned', { state: 'hidden' });
  assert.ok(await noSideScroll(page));
  await page.click('[data-week="last"]');
  await page.waitForFunction(() => /to .*, Pacific/.test(document.getElementById('board-clock').textContent));
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('No Player ID on your Sealed Hand badge or anywhere on the table page, not even its first characters; the footer says Built on the Midnight Network', { timeout: 60_000 }, async () => {
  for (const options of [DESKTOP, PHONE]) {
    const { context, page, id, token } = await playerAtTable({ options });
    await page.goto(`${BASE}/table?id=${id}`);
    await page.waitForSelector('.seat-plate.mine');
    await page.waitForTimeout(300);
    assert.equal(await page.$('.player-id, .pid-short, .pid-copy'), null, 'no Player ID element');
    assert.ok(!/player id/i.test(await page.innerText('.seat-plate.mine')), 'not on your badge');
    assert.ok(!(await page.innerText('body')).includes(token.slice(0, 6)), 'not even its first characters');
    assert.ok(!(await page.content()).includes(token.split('.')[1]), 'none of the secret on the page');
    assert.equal(await page.textContent('.built-on'), 'Built on the Midnight Network');
    assert.ok(await noSideScroll(page));
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

/**
 * Every new context starts with Tally's Sealed Hand walkthrough marked as seen (it shows once, the first time a seat is
 * yours, and would sit over the moves), unless it's made with { guide: true }, as the tests of the walkthrough itself are.
 */
function seenHandGuide(b) {
  const make = b.newContext.bind(b);
  b.newContext = async ({ guide = false, dealShow = false, ...options } = {}) => {
    const context = await make(options);
    if (!guide) await context.addInitScript(() => { try { localStorage.setItem('hall.hand.guided', '1'); } catch { /* storage blocked: the test says so itself */ } });
    if (!dealShow) await context.addInitScript(() => { try { localStorage.setItem('hall.dealShow', 'off'); } catch { /* as above */ } }); // the deal show has its own test
    return context;
  };
}

// ---------- 11-08: first-hand clarity, Tally's lap walkthrough, the slim Support footer ----------

const LAP_STEPS = [
  'Pass: everyone slides one card to the next seat, all at once. Two passes at least, five at most.',
  'Claim: name a poker hand better than the one to beat. True, or a bluff: nobody sees your cards.',
  'Check: let the claim stand. It’s free.',
  'Call: say it’s a bluff. The house checks the hand, and whoever’s wrong pays 5.',
];

test('Tally\'s lap walkthrough at Sealed Hand: the first sit shows it once, the four steps word for word; Got it remembers; ? and How to play\'s button reopen it; its link opens the rules; a watcher never sees it', { timeout: 90_000 }, async () => {
  for (const [options, where] of [[PHONE, 'phone'], [DESKTOP, 'desktop']]) {
    const { id } = await apiPost('/tables', { lobbySeconds: 0, test: { rng: 11 } });
    const { context, page } = await session({ ...options, guide: true });
    await page.goto(`${BASE}/table?id=${id}`);
    await page.fill('#join-name', 'Newcomer');
    await page.click('#join-form button[type="submit"]');
    await page.waitForSelector('#hand-guide:not([hidden])', { timeout: 15_000 });
    assert.equal(await page.textContent('#guide-title'), 'Poker claims, with a pass');
    assert.equal(await page.textContent('#guide-line'), 'Five cards each, and only you see yours. One lap goes like this:');
    assert.deepEqual(await page.$$eval('#guide-steps li', (els) => els.map((e) => e.textContent)), LAP_STEPS, 'one lap: pass, claim, check or call');
    assert.equal(await page.textContent('#guide-after'), 'After the lap, the best claim still standing takes most of the pot.');
    assert.equal(await page.textContent('#guide-ok'), 'Got it');
    assert.equal(await page.textContent('#guide-rules'), 'How to play');
    assert.ok(await page.$eval('#hand-guide .portrait', (el) => /seat-tally|portrait-doorman/.test(getComputedStyle(el).backgroundImage)), 'Tally speaks it');
    await page.waitForSelector('button.card.face', { timeout: 15_000 });
    assert.ok(await noSideScroll(page), `${where}: no sideways scroll`);
    await shot(page, `hand-guide-${where}`);
    await page.click('#guide-ok');
    assert.ok(await page.$eval('#hand-guide', (el) => el.hidden));
    assert.equal(await page.evaluate(() => localStorage.getItem('hall.hand.guided')), '1');
    await page.reload();
    await page.waitForSelector('button.card.face', { timeout: 15_000 });
    await page.waitForTimeout(2000);
    assert.equal(await page.$('#hand-guide:not([hidden])'), null, 'once per browser');
    await page.click('#guide-open');
    await page.waitForSelector('#hand-guide:not([hidden])');
    await page.click('#guide-ok');
    await page.$eval('#rules', (el) => { el.open = true; el.scrollIntoView(); });
    assert.equal(await page.textContent('#guide-again'), 'Tally’s walkthrough: one lap');
    await page.click('#guide-again');
    await page.waitForSelector('#hand-guide:not([hidden])');
    await page.$eval('#rules', (el) => { el.open = false; });
    await page.click('#guide-rules');
    assert.ok(await page.$eval('#hand-guide', (el) => el.hidden));
    assert.ok(await page.$eval('#rules', (el) => el.open), 'How to play opens the full rules');
    assert.match(await page.textContent('#rules'), /Check to let the claim stand, free/);
    assert.deepEqual(page.errors, []);
    if (where === 'phone') { // a watcher is never shown it
      const watcher = await session({ ...PHONE, guide: true });
      await watcher.page.goto(`${BASE}/table?id=${id}&watch=1`);
      await watcher.page.waitForSelector('[data-seat-card]', { timeout: 15_000 });
      await watcher.page.waitForTimeout(2500);
      assert.equal(await watcher.page.$('#hand-guide:not([hidden])'), null);
      await watcher.context.close();
    }
    await context.close();
  }
});

/** The row's moves as a player reads them: each button's words and the line under it. */
const rowWords = (page) => page.$$eval('#move-row .move-cell', (cells) => cells.map((c) => { const b = c.querySelector('button').cloneNode(true); b.querySelector('small')?.remove(); return [c.dataset.cell, b.textContent.replace(/\s+/g, ' ').trim(), c.querySelector('.move-what')?.textContent ?? null]; })); // a greyed button's own words, without its tucked-away reason

test('first-hand clarity at Sealed Hand: every move carries a line under it in plain words; Check lets the claim stand (free), Call says it\'s a bluff, Stay in is what was Match; a greyed move says all of it and why not now', { timeout: 90_000 }, async () => {
  for (const [options, where] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    // the first pass: Pass is live; Check, Call and Stay in are greyed, each saying what it does
    const s = await seated({}, options);
    await s.page.waitForSelector('#move-row .move-cell');
    const pass = await rowWords(s.page);
    assert.deepEqual(pass.map(([id, , what]) => [id, what]), [
      ['pass', 'Slide a card to the next seat'],
      ['stop', 'End the passing with a claim'],
      ['claim', 'Name a hand, true or bluff'],
      ['check', 'Let the claim stand (free)'],
      ['call', 'Say it’s a bluff; loser pays 5'],
      ['match', 'Pay up to the raise'],
      ['fold', 'Drop out of this pot'],
    ]);
    assert.equal(pass.find(([id]) => id === 'match')[1], 'Stay in', 'no "Match" next to Check and Call');
    assert.ok(!pass.some(([, label]) => /^Match/.test(label)));
    const sizes = await s.page.$$eval('#move-row .move-what', (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    assert.ok(Math.min(...sizes) >= 12, `the lines are readable: ${Math.min(...sizes)}px`);
    assert.equal(await s.page.getAttribute('#move-row [data-move="check"]', 'aria-describedby'), 'move-what-check move-reason', 'a screen reader hears the line too');
    await s.page.$eval('#move-row [data-move="call"]', (el) => el.click()); // aria-disabled: Playwright won't press it, a finger will
    assert.equal(await s.page.textContent('#move-reason'), 'Call: say it’s a bluff. The house checks the hand, and whoever’s wrong pays 5. Not now: only after the passing.');
    await s.page.$eval('#move-row [data-move="match"]', (el) => el.click());
    assert.equal(await s.page.textContent('#move-reason'), 'Stay in: match the highest raise. You pay only the difference, and you stay in for the pot. Not now: no raise to answer.');
    assert.ok(await noSideScroll(s.page), `${where}: no sideways scroll`);
    await shot(s.page, `first-hand-pass-${where}`);
    await s.context.close();

    // the claim lap: Check and Call are live, their lines under them
    const c = await claimScene({ hand: NINES, claims: [BRANNOCK_KINGS], queue: [0, 1, 3], options });
    await c.page.waitForSelector('#move-row [data-action="check"]');
    const lap = Object.fromEntries((await rowWords(c.page)).map(([id, label, what]) => [id, { label, what }]));
    assert.deepEqual(lap.check, { label: 'Check', what: 'Let the claim stand (free)' });
    assert.match(lap.call.label, /^Call Brannock: two pair, Kings high$/);
    assert.equal(lap.call.what, 'Say it’s a bluff; loser pays 5');
    assert.equal(await c.page.getAttribute('#move-row [data-action="check"]', 'title'), 'Check: let the claim stand. It’s free.');
    assert.ok(await noSideScroll(c.page), `${where}: no sideways scroll in the lap`);
    await shot(c.page, `first-hand-lap-${where}`);
    assert.deepEqual(c.page.errors, []);
    await c.context.close();
  }
});

test('Support the build is a slim line on every public page: the title and the lanterns line, the addresses behind one tap marked mainnet NIGHT or ADA (real, not test), shortened on screen, Copy copying all of each', { timeout: 120_000 }, async () => {
  const { SUPPORT, SUPPORT_NETWORK } = await import('../public/js/support.js');
  const { id } = await apiPost('/tables', { lobbySeconds: 300 });
  const dice = await apiPost('/dice-tables', { lobbySeconds: 300 });
  for (const [options, where, most] of [[DESKTOP, 'desktop', 90], [PHONE, 'phone', 140]]) {
    const { context, page } = await session(options);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    for (const path of ['/', `/table?id=${id}`, `/dice?id=${dice.id}`, '/records', '/leaderboard', '/agents']) {
      await page.goto(BASE + path);
      await page.waitForSelector('#support #support-open', { timeout: 15_000 });
      if (path === '/') await page.click('#dialogue-close').catch(() => {});
      assert.equal(await page.textContent('#support-title'), 'Support the build', path);
      assert.equal(await page.textContent('.page-support .support-line'), 'The Hall is a one-person build. If you\'d like to help keep the lanterns lit:', `${path}: the wording kept`);
      assert.equal(await page.textContent('#support-net'), SUPPORT_NETWORK);
      assert.equal(SUPPORT_NETWORK, 'mainnet NIGHT or ADA (real, not test)');
      const closed = (await page.locator('.page-support').boundingBox()).height;
      assert.ok(closed <= most, `${where} ${path}: ${Math.round(closed)}px tall, a slim line`);
      assert.equal(await page.isVisible('[data-copy]'), false, 'the addresses wait for a tap');
      await page.click('#support-open');
      const shown = await page.$$eval('#support code', (els) => els.map((e) => e.textContent));
      assert.equal(shown.length, SUPPORT.length);
      SUPPORT.forEach(({ address }, i) => {
        assert.equal(shown[i].includes('…') && shown[i].length < 30 && address.startsWith(shown[i].split('…')[0]) && address.endsWith(shown[i].split('…')[1]), true, `${path}: entry ${i} shortened on screen`);
      });
      await page.click(`[data-copy="${SUPPORT[1].label}"]`);
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())) === SUPPORT[1].address, true, `${path}: Copy copies the whole address`);
      assert.ok(await noSideScroll(page), `${where} ${path}: no sideways scroll`);
      if (path === '/records' && SHOTS) {
        await page.locator('.page-support').screenshot({ path: join(SHOTS, `support-${where}-open.png`) });
        await page.click('#support-open');
        await page.locator('.page-support').screenshot({ path: join(SHOTS, `support-${where}-closed.png`) });
      }
    }
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

// ---------- bring your own agent, phase 1 (11-08): the lobby, watch links, the Agent badge ----------

test('the lobby lists every table with who sits there; Watch opens it with no seat; an agent wears the Agent badge on its card, in the bids and in Table talk', { timeout: 90000 }, async () => {
  const post = async (path, body, token) => (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
  // A dice table: an agent and a person, then the house fills the rest.
  const dice = await post('/dice-tables', { lobbySeconds: 0, seats: 3 });
  const bot = await post(`/dice-tables/${dice.id}/join`, { name: 'Clanker', kind: 'agent' });
  const card = await post('/tables', { lobbySeconds: 0, stakes: { ante: 1 } });
  const cardAgent = await post(`/tables/${card.id}/join`, { name: 'Deckhand', kind: 'agent' });
  // The agent bids once and says something, so its name shows in the bids and in Table talk.
  const me = await (await fetch(`${BASE}/dice-tables/${dice.id}/me`, { headers: { authorization: `Bearer ${bot.token}` } })).json();
  const bid = me.legal.find((m) => m.action === 'bid');
  if (bid) await post(`/dice-tables/${dice.id}/act`, { action: 'bid', ...bid.lowest }, bot.token);
  await post(`/dice-tables/${dice.id}/say`, { text: 'Beep. Good luck all.' }, bot.token);
  await post(`/tables/${card.id}/say`, { text: 'Shuffle up.' }, cardAgent.token);

  const rows = (await (await fetch(`${BASE}/lobby/tables`)).json()).tables;
  const diceRow = rows.find((t) => t.id === dice.id);
  assert.ok(diceRow && diceRow.agents === 1 && diceRow.house === 2 && diceRow.humans === 0, 'the list counts the agent and the house');
  assert.match(diceRow.watch, /^\/watch\/cup-and-claim\/\d+$/);

  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const { context, page } = await session({ viewport: { width: w, height: h } });
    await page.goto(BASE + '/lobby');
    await page.waitForSelector(`[data-id="${dice.id}"]`);
    const item = await page.innerText(`[data-id="${dice.id}"]`);
    assert.ok(/Cup & Claim · Table \d+/.test(item) && /Clanker\s*Agent/.test(item) && /House/.test(item), item);
    assert.ok(!/Tally · house/.test(item), 'the house word is the badge, not the name');
    assert.ok(await page.isVisible(`[data-id="${card.id}"]`), 'Sealed Hand tables are listed too');
    await page.click('[data-show="sealed-hand"]');
    assert.ok(await page.isHidden(`[data-id="${dice.id}"]`), 'the game filter hides Cup & Claim');
    await page.click('[data-show="agents"]');
    assert.ok(await page.isVisible(`[data-id="${dice.id}"]`) && await page.isVisible(`[data-id="${card.id}"]`), 'with agents: both');
    assert.ok(await noSideScroll(page), 'no sideways scroll at ' + w);
    // Watch: the short link lands on the table, watching.
    await page.click(`[data-id="${dice.id}"] a:text("Watch")`);
    await page.waitForURL((u) => u.pathname === '/dice' && u.searchParams.get('watch') === '1' && u.searchParams.get('id') === dice.id);
    await page.waitForSelector('#cups .tag.agent');
    assert.equal(await page.textContent('#cups .tag.agent'), 'Agent', 'the seat card');
    if (bid) {
      await page.waitForSelector('#bid-ladder .agent-mark', { state: 'attached' }); // a short screen shows only the latest bids
      assert.match(await page.$eval('#bid-ladder .agent-mark', (m) => m.closest('li').textContent), /^Clanker\s*Agent/, 'the bids');
    }
    await page.waitForSelector('#talk-line .agent-mark');
    assert.match(await page.innerText('#talk-line'), /Clanker\s*Agent: Beep/, 'Table talk');
    assert.equal(await page.$$eval('#cups .tag.agent', (a) => a.length), 1, 'only the agent: the house bots say house');
    assert.ok(!/player id/i.test(await page.innerText('body')), 'a watcher sees no Player ID');
    await page.goto(`${BASE}/table?id=${card.id}&watch=1`);
    await page.waitForSelector('.seat-card .tag.agent');
    assert.equal(await page.$$eval('.seat-card .tag.agent', (a) => a.map((x) => x.textContent).join()), 'Agent');
    await page.waitForSelector('#talk-line .agent-mark');
    assert.match(await page.innerText('#talk-line'), /Deckhand\s*Agent: Shuffle up/);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
  const missing = await fetch(`${BASE}/watch/cup-and-claim/99999`, { redirect: 'manual' });
  assert.equal(missing.status, 404);
  const watched = await fetch(BASE + diceRow.watch, { redirect: 'manual' });
  assert.equal(watched.status, 302);
  assert.equal(watched.headers.get('location'), `/dice?id=${dice.id}&watch=1`);
});
