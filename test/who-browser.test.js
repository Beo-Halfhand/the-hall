// Who are you (11-10, after the owner's first tNIGHT run on live: a name, no avatar the server accepts, and the seat was refused):
//  - no player saved here: "New here, or bringing a Player ID?" before anything else: New is a name then an avatar; a Player ID is pasted
//  - a returning player: "Welcome back, <name>" with their face and "Not you? Switch player"
//  - a returning player with no avatar the server accepts: asked for one right there
//  - no seat request ever goes out with a missing or invalid avatar (look.js, in claimSeat and signDoor)
// Every path on a phone and a desktop, at the chips door (tNIGHT off) and the tNIGHT door (tNIGHT on).
//   WHO_PORT=8927 node --test test/who-browser.test.js
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = Number(process.env.WHO_PORT ?? 8927);
const CHIPS = `http://127.0.0.1:${PORT}`;
const TN = `http://127.0.0.1:${PORT + 2}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const SIZES = [[DESKTOP, 'desktop'], [PHONE, 'phone']];
const DOORS = [[CHIPS, 'the chips door'], [TN, 'the tNIGHT door']];
let browser;

before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  await startServer(PORT + 2, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', 'WALLET_PAGE:on', '--var', 'JUDGE_TOKEN:test-judge-token', '--var', `CAGE_ADDRESS:${'d'.repeat(64)}`, '--var', 'CAGE_TABLE_BASE:700']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, { timeout: 120_000 });
after(async () => { await browser?.close(); await stopServers(); });

async function session(options) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource|cloudflareinsights/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  return { context, page };
}
const post = async (base, path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const me = async (base, token) => (await fetch(`${base}/players/me`, { headers: { authorization: `Bearer ${token}` } })).json();
const menuIds = (page) => page.$$eval('#menu .menu-item', (els) => els.map((e) => e.dataset.id));
const line = (page) => page.evaluate(() => document.getElementById('line').textContent);
const tap = (page, sel) => page.tap?.(sel).catch(() => page.click(sel)) ?? page.click(sel);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const WHO = 'New here, or bringing a Player ID?';

for (const [options, size] of SIZES) {
  for (const [base, door] of DOORS) {
    const tn = base === TN;

    test(`new, ${size}, ${door}: the question first, then a name, then an avatar; the player is made with both`, { timeout: 60_000 }, async () => {
      const { context, page } = await session(options);
      await page.goto(base);
      await page.waitForFunction((q) => document.getElementById('line').textContent === q, WHO);
      assert.deepEqual(await menuIds(page), ['who-new', 'who-restore'], 'no way to play, no door, no table before one is done');
      assert.equal(await page.$eval('#seat-form', (f) => f.hidden), true);
      assert.ok(await noSideScroll(page));
      await tap(page, '#menu [data-id="who-new"]');
      await page.waitForSelector('#seat-form:not([hidden])');
      await page.fill('#seat-name', `Newbie ${size[0]}${tn ? 'N' : 'C'}`);
      await tap(page, '#seat-go');
      await page.waitForSelector('#looks:not([hidden])');
      assert.match(await line(page), /pick an avatar/i);
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.player')), null, 'no player until both are chosen');
      assert.ok(await noSideScroll(page));
      await tap(page, '#looks [data-look="mage"]');
      await tap(page, '#menu [data-id="look-ok"]');
      await page.waitForFunction(() => !!localStorage.getItem('hall.player'));
      const token = await page.evaluate(() => localStorage.getItem('hall.player'));
      assert.equal((await me(base, token)).avatar, 'mage', 'the avatar they picked');
      // then, at the chips door the Hall; at the tNIGHT door the one question, chips or tNIGHT
      if (tn) {
        await page.waitForSelector('#menu [data-id="mode-tnight"]');
        assert.deepEqual(await menuIds(page), ['mode-chips', 'mode-tnight', 'rules']);
      } else {
        await page.waitForSelector('#menu [data-id="seat"]');
        assert.equal(await page.isVisible('#welcome-back'), true);
      }
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`restore, ${size}, ${door}: Bringing a Player ID opens the panel; the ID is checked, then the Hall welcomes them back by name`, { timeout: 60_000 }, async () => {
      const saved = await post(base, '/players', { name: `Keeper ${size[0]}${tn ? 'N' : 'C'}`, avatar: 'knight' });
      const { context, page } = await session(options);
      await page.goto(base);
      await page.waitForSelector('#menu [data-id="who-restore"]');
      await tap(page, '#menu [data-id="who-restore"]');
      await page.waitForSelector('#settings:not([hidden])');
      await page.fill('#key-input', saved.token);
      await tap(page, '#key-restore button[type="submit"]');
      await page.waitForSelector('#key-confirm:not([hidden])');
      assert.match(await page.textContent('#key-found'), new RegExp(saved.name));
      await tap(page, '#key-switch');
      await page.waitForFunction((t) => localStorage.getItem('hall.player') === t, saved.token);
      if (tn) await page.waitForSelector('#menu [data-id="mode-tnight"]'); // the way to play, as for anyone who hasn't said
      else {
        await page.waitForSelector('#menu [data-id="seat"]');
        assert.equal((await page.textContent('#welcome-text')).trim(), `Welcome back, ${saved.name}`);
      }
      assert.equal((await me(base, saved.token)).avatar, 'knight', 'their avatar is as it was');
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`returning, ${size}, ${door}: "Welcome back, <name>" with their face; Not you? Switch player asks who, and keeps the old Player ID`, { timeout: 60_000 }, async () => {
      const saved = await post(base, '/players', { name: `Back ${size[0]}${tn ? 'N' : 'C'}`, avatar: 'ranger' });
      const { context, page } = await session(options);
      await page.addInitScript(([t, m]) => { localStorage.setItem('hall.player', t); if (m) localStorage.setItem('hall.mode', 'chips'); }, [saved.token, tn]);
      await page.goto(base);
      await page.waitForSelector('#menu [data-id="seat"]');
      assert.notEqual(await line(page), WHO, 'a saved player is not asked who they are');
      assert.equal(await page.isVisible('#welcome-back'), true);
      assert.equal((await page.textContent('#welcome-text')).trim(), `Welcome back, ${saved.name}`);
      assert.ok(await page.$('#welcome-face .face'), 'their face');
      assert.equal((await page.textContent('#switch-player')).trim(), 'Not you? Switch player');
      assert.ok(await noSideScroll(page));
      // Switch player: the same question, with a way back, and nothing is lost until the new one is made
      await tap(page, '#switch-player');
      await page.waitForFunction((q) => document.getElementById('line').textContent === q, WHO);
      assert.deepEqual(await menuIds(page), ['who-new', 'who-restore', 'who-cancel']);
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.player')), saved.token, 'still them until another is made');
      await tap(page, '#menu [data-id="who-cancel"]');
      await page.waitForSelector('#menu [data-id="seat"]');
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.player')), saved.token);
      // and a new player replaces them, the old key kept under previous
      await tap(page, '#switch-player');
      await tap(page, '#menu [data-id="who-new"]');
      await page.fill('#seat-name', `Other ${size[0]}${tn ? 'N' : 'C'}`);
      await tap(page, '#seat-go');
      await tap(page, '#looks [data-look="pirate"]');
      await tap(page, '#menu [data-id="look-ok"]');
      await page.waitForFunction((t) => localStorage.getItem('hall.player') && localStorage.getItem('hall.player') !== t, saved.token);
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.player.previous')), saved.token, 'never the only copy of a Player ID thrown away');
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`returning without an avatar, ${size}, ${door}: asked for one right there, before anything else`, { timeout: 60_000 }, async () => {
      const saved = await post(base, '/players', { name: `Faceless ${size[0]}${tn ? 'N' : 'C'}`, testSavedAvatar: 'wizard' }); // a look the server doesn't accept
      assert.equal((await me(base, saved.token)).avatar, 'wizard');
      const { context, page } = await session(options);
      await page.addInitScript((t) => localStorage.setItem('hall.player', t), saved.token);
      await page.goto(base);
      await page.waitForSelector('#looks:not([hidden])');
      assert.equal((await line(page)).trim(), 'Pick an avatar before you sit down.');
      assert.equal((await page.textContent('#welcome-text')).trim(), `Welcome back, ${saved.name}`, 'at the welcome card');
      assert.equal(await page.isVisible('#change-look'), false, 'the picker is already open');
      assert.deepEqual(await menuIds(page), ['look-ok'], 'nothing else on offer until one is picked: no door, no table');
      assert.ok(await noSideScroll(page));
      await tap(page, '#looks [data-look="rogue"]');
      await tap(page, '#menu [data-id="look-ok"]');
      await page.waitForFunction(() => !document.querySelector('#looks:not([hidden])'));
      assert.equal((await me(base, saved.token)).avatar, 'rogue', 'saved on the player');
      await page.waitForSelector(tn ? '#menu [data-id="mode-tnight"]' : '#menu [data-id="seat"]');
      assert.deepEqual(page.errors, []);
      await context.close();
    });
  }
}

// ---------- 11-10, the owner's full run: a retired look is asked about at the door; Change look on the card and in Menu → Player ----------

const openPlayerMenu = async (page) => {
  if (await page.isVisible('.nav-burger')) await tap(page, '.nav-burger');
  const top = page.locator('.nav-drop > button', { hasText: 'Player' });
  await top.click();
  await page.waitForSelector('#nav-change-look', { state: 'visible' });
};
const faceImage = (page, sel) => page.$eval(`${sel} .face`, (el) => el.style.backgroundImage);

for (const [options, size] of SIZES) {
  for (const [base, door] of DOORS) {
    const tn = base === TN;

    test(`returning with a retired look, ${size}, ${door}: "Your look has been retired: pick a new one" at the welcome card, once, before any door or table`, { timeout: 60_000 }, async () => {
      const saved = await post(base, '/players', { name: `Gears ${size[0]}${tn ? 'N' : 'C'}`, testSavedAvatar: 'clockwork' });
      assert.equal((await me(base, saved.token)).avatar, 'clockwork');
      const { context, page } = await session(options);
      await page.addInitScript(([t, m]) => { localStorage.setItem('hall.player', t); if (m) localStorage.setItem('hall.mode', 'chips'); }, [saved.token, tn]);
      await page.goto(base);
      await page.waitForSelector('#looks:not([hidden])');
      assert.equal((await line(page)).trim(), 'Your look has been retired: pick a new one.');
      assert.equal(await page.isVisible('#welcome-back'), true, 'at the welcome card');
      assert.equal((await page.textContent('#welcome-text')).trim(), `Welcome back, ${saved.name}`);
      assert.deepEqual(await menuIds(page), ['look-ok'], 'no door, no table, no keeping it');
      assert.equal(await page.$('#looks [data-look="clockwork"]'), null, 'not offered');
      assert.ok(await noSideScroll(page));
      await tap(page, '#looks [data-look="halfling"]');
      await tap(page, '#menu [data-id="look-ok"]');
      await page.waitForSelector('#menu [data-id="seat"]');
      const after = await me(base, saved.token);
      assert.equal(after.avatar, 'halfling', 'saved on the same player');
      assert.equal(after.name, saved.name);
      // once: back again, no picker, straight to the welcome
      await page.reload();
      await page.waitForSelector('#menu [data-id="seat"]');
      assert.equal(await page.isVisible('#looks'), false);
      assert.equal(await page.$('#look-ask'), null, 'and no seat window either');
      assert.deepEqual(page.errors, []);
      await context.close();
    });

    test(`Change look, ${size}, ${door}: on the welcome card and in Menu → Player; the same player and Player ID, a new face`, { timeout: 60_000 }, async () => {
      const saved = await post(base, '/players', { name: `Face ${size[0]}${tn ? 'N' : 'C'}`, avatar: 'ranger' });
      const { context, page } = await session(options);
      await page.addInitScript(([t, m]) => { localStorage.setItem('hall.player', t); if (m) localStorage.setItem('hall.mode', 'chips'); }, [saved.token, tn]);
      await page.goto(base);
      await page.waitForSelector('#menu [data-id="seat"]');
      assert.equal((await page.textContent('#change-look')).trim(), 'Change look');
      assert.ok(await noSideScroll(page));
      const before = await faceImage(page, '#welcome-face');
      // the card
      await tap(page, '#change-look');
      await page.waitForSelector('#look-ask');
      assert.equal((await page.textContent('#look-ask-title')).trim(), 'Change look');
      assert.equal(await page.getAttribute('#look-ask [data-look="ranger"]', 'aria-pressed'), 'true', 'their look, picked');
      await tap(page, '#look-ask [data-look="knight"]');
      await tap(page, '#look-ask-ok');
      await page.waitForSelector('#look-ask', { state: 'detached' });
      assert.equal((await me(base, saved.token)).avatar, 'knight');
      await page.waitForFunction((b) => document.querySelector('#welcome-face .face')?.style.backgroundImage !== b, before);
      // Keep this one changes nothing
      await tap(page, '#change-look');
      await tap(page, '#look-ask-cancel');
      await page.waitForSelector('#look-ask', { state: 'detached' });
      assert.equal((await me(base, saved.token)).avatar, 'knight');
      // Menu → Player
      await openPlayerMenu(page);
      await tap(page, '#nav-change-look');
      await page.waitForSelector('#look-ask');
      assert.equal(await page.getAttribute('#look-ask [data-look="knight"]', 'aria-pressed'), 'true');
      await tap(page, '#look-ask [data-look="pirate"]');
      await tap(page, '#look-ask-ok');
      await page.waitForSelector('#look-ask', { state: 'detached' });
      assert.equal((await me(base, saved.token)).avatar, 'pirate');
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.player')), saved.token, 'the same Player ID');
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.player.previous')), null, 'no player switched');
      assert.equal((await page.textContent('#welcome-text')).trim(), `Welcome back, ${saved.name}`);
      // Menu → Player → Player ID: the panel
      await openPlayerMenu(page);
      await tap(page, '#nav-player-id');
      await page.waitForSelector('#settings:not([hidden])');
      assert.deepEqual(page.errors, []);
      await context.close();
    });
  }
}

test('Menu → Player from another page: Change look saves the same player; Player ID takes them to the Hall\'s panel', { timeout: 60_000 }, async () => {
  for (const [options, size] of SIZES) {
    const saved = await post(CHIPS, '/players', { name: `Away ${size[0]}`, avatar: 'mage' });
    const { context, page } = await session(options);
    await page.addInitScript((t) => { localStorage.setItem('hall.player', t); localStorage.setItem('hall.guide.seen', '1'); }, saved.token);
    await page.goto(`${CHIPS}/lobby`);
    await openPlayerMenu(page);
    await tap(page, '#nav-change-look');
    await page.waitForSelector('#look-ask');
    assert.equal(await page.getAttribute('#look-ask [data-look="mage"]', 'aria-pressed'), 'true');
    await tap(page, '#look-ask [data-look="dwarf"]');
    await tap(page, '#look-ask-ok');
    await page.waitForSelector('#look-ask', { state: 'detached' });
    assert.equal((await me(CHIPS, saved.token)).avatar, 'dwarf', size);
    await openPlayerMenu(page);
    await tap(page, '#nav-player-id');
    await page.waitForURL(`${CHIPS}/`);
    await page.waitForSelector('#settings:not([hidden])');
    assert.equal(await page.textContent('#pid-value'), `${saved.token.length}-character ID, hidden`);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

// ---------- no seat request goes out with a missing or invalid avatar (look.js, claimSeat) ----------

test('claimSeat: a saved look the server refuses is never sent; the player picks, and the seat request carries the pick', { timeout: 60_000 }, async () => {
  const saved = await post(TN, '/players', { name: 'Seater', testSavedAvatar: 'wizard' });
  const { context, page } = await session(DESKTOP);
  const sent = [];
  await page.route('**/cage-seat', async (r) => {
    if (r.request().method() === 'POST') { sent.push(JSON.parse(r.request().postData() ?? '{}')); await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_avatar', message: 'stub' }) }); } else await r.continue();
  });
  await page.addInitScript((t) => localStorage.setItem('hall.player', t), saved.token);
  await page.goto(`${TN}/wallet`);
  // 1. the page holds the refused look: the request waits for a pick, and "Not now" sends nothing at all
  const first = page.evaluate(async () => {
    const { claimSeat } = await import('/js/cage-session.js');
    try { await claimSeat({ api: '/tables', tableId: 'a'.repeat(64), avatar: 'wizard' }); return 'sent'; } catch (e) { return e.code; }
  });
  await page.waitForSelector('#look-ask');
  assert.equal((await page.textContent('#look-ask-title')).trim(), 'Pick an avatar');
  assert.equal(sent.length, 0, 'nothing sent while the avatar is missing');
  await page.click('#look-ask-cancel');
  assert.equal(await first, 'no_avatar');
  assert.equal(sent.length, 0, 'and nothing sent after "Not now"');
  // 2. a pick goes onto the player and into the request
  const second = page.evaluate(async () => {
    const { claimSeat } = await import('/js/cage-session.js');
    try { await claimSeat({ api: '/tables', tableId: 'b'.repeat(64), avatar: null }); return 'sent'; } catch (e) { return e.code; }
  });
  await page.waitForSelector('#look-ask');
  await page.click('#look-ask [data-look="dwarf"]');
  await page.click('#look-ask-ok');
  assert.equal(await second, 'bad_avatar', 'the (stubbed) server refusal comes back as the page’s own code');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].avatar, 'dwarf');
  assert.equal((await me(TN, saved.token)).avatar, 'dwarf', 'saved on the player');
  // 3. a valid look goes straight through, with no window
  sent.length = 0;
  const third = await page.evaluate(async () => {
    const { claimSeat } = await import('/js/cage-session.js');
    try { await claimSeat({ api: '/tables', tableId: 'c'.repeat(64), avatar: 'knight' }); return 'sent'; } catch (e) { return e.code; }
  });
  assert.equal(third, 'bad_avatar');
  assert.equal(sent[0].avatar, 'knight');
  assert.equal(await page.$('#look-ask'), null);
  // 4. a missing look on a player who has a good saved one: read from the player, no window
  sent.length = 0;
  await page.evaluate(async () => { const { claimSeat } = await import('/js/cage-session.js'); try { await claimSeat({ api: '/tables', tableId: 'd'.repeat(64), avatar: null }); } catch { /* the stub refuses */ } });
  assert.equal(sent[0].avatar, 'dwarf', 'the saved look, read fresh');
  assert.equal(await page.$('#look-ask'), null);
  await context.close();
});

test('the seat trouble for a refused avatar says "Pick an avatar", with that button, not a raw error', () => {
  const src = readCageSession();
  assert.match(src, /e\.code === 'bad_avatar' \|\| e\.code === 'no_avatar'/, 'both codes');
  assert.match(src, /title: 'Pick an avatar', what: 'You need an avatar to sit down\.'/);
  assert.match(src, /\$\('trouble-retry'\)\.textContent = explained\.kind === 'avatar' \? 'Pick an avatar' : 'Try again'/);
});

import { readFileSync } from 'node:fs';
function readCageSession() { return readFileSync(new URL('../public/js/cage-session.js', import.meta.url), 'utf8'); }
