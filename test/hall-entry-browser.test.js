// The way into the Hall (The owner, 11-06): the door asks a name and nothing else, and you stand in the Hall with your purse as it
// was. Picking a game is what asks how much to bring, naming the game. Leaving a table for the Hall or the menu asks first, and
// standing up sends the stack home with no table left behind. Set SHOTS to a folder for the screenshots.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = Number(process.env.TEST_PORT ?? 8879);
const BASE = `http://127.0.0.1:${PORT}`;
const TN_PORT = PORT + 2; // the same Hall with tNIGHT on: chips or tNIGHT is the first question
const TN = `http://127.0.0.1:${TN_PORT}`;
const JUDGE = 'test-judge-token';
const SHOTS = process.env.SHOTS;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const SIZES = [[DESKTOP, 'desktop'], [PHONE, 'phone']];

let browser;

before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  await startServer(TN_PORT, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', 'WALLET_PAGE:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${'d'.repeat(64)}`, '--var', 'CAGE_TABLE_BASE:700', '--var', 'FRESH_START:on']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  seenHandGuide(browser); // Tally's Sealed Hand walkthrough already seen, unless a test asks for it ({ guide: true })
}, { timeout: 180_000 });

after(async () => {
  await browser?.close();
  await stopServers();
});

/** A browser session that counts every request that would make or take a seat, and collects page errors. */
async function session(options = DESKTOP) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' }); // the doorman's line lands whole, so it can be read at once
  page.errors = [];
  page.seatCalls = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && (/^\/(tables|dice-tables)$/.test(path) || /\/join$/.test(path))) page.seatCalls.push(path);
  });
  return { context, page };
}

const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(400); // the doorman's line types out
  await page.click('#line').catch(() => {}); // and a click finishes it
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const menuIds = (page) => page.$$eval('#menu .menu-item', (els) => els.map((e) => e.dataset.id));

async function apiPost(path, body, token) {
  const res = await fetch(BASE + path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body ?? {}) });
  return res.json();
}
async function apiGet(path, token) {
  return (await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
}
const tokenOf = (page) => page.evaluate(() => localStorage.getItem('hall.player'));

/** The door (11-10): "New here, or bringing a Player ID?", New here, a name, an avatar, and in. */
async function chalkIn(page, name, look = 'adventurer') {
  await page.waitForSelector('#menu [data-id="who-new"]');
  await page.click('#menu [data-id="who-new"]');
  await page.waitForSelector('#seat-form:not([hidden])');
  await page.fill('#seat-name', name);
  await page.click('#seat-go');
  await page.waitForSelector(`#looks [data-look="${look}"]`);
  await page.click(`#looks [data-look="${look}"]`);
  await page.click('#menu [data-id="look-ok"]');
}

/** Through the door, as a first visitor: the name, Enter the Hall, and the doorman's welcome. Returns the player token. */
async function enter(page, name) {
  await page.goto(BASE);
  await chalkIn(page, name);
  await page.waitForFunction(() => /^In you come/.test(document.getElementById('line').textContent));
  await page.waitForSelector('#menu [data-id="seat"]');
  return tokenOf(page);
}

/** A seat at a Cup & Claim table that's still seating (no round on), held by this browser. */
async function seatedAtDice(page, { buyIn = 50, name = 'Leaver', table = { lobbySeconds: 300 } } = {}) {
  const player = await apiPost('/players', { name });
  const t = await apiPost('/dice-tables', table);
  const seat = await apiPost(`/dice-tables/${t.id}/join`, { kind: 'human', buyIn }, player.token);
  await page.goto(BASE);
  await page.evaluate(([p, id, s]) => {
    localStorage.setItem('hall.player', p);
    localStorage.setItem(`hall.seat.${id}`, s);
  }, [player.token, t.id, seat.token]);
  return { token: player.token, id: t.id, n: t.n ?? t.state?.n ?? null };
}

for (const [options, size] of SIZES) {
  test(`first visit, ${size}: the door asks a name only, Enter the Hall lets you in standing, purse untouched, and no game is chosen for you`, { timeout: 60_000 }, async () => {
    const { context, page } = await session(options);
    await page.goto(BASE);
    await page.waitForSelector('#dialogue:not([hidden])');
    await page.waitForSelector('#menu [data-id="who-new"]');
    const hall = await apiGet('/hall');
    assert.equal((await page.textContent('#line')).trim().length > 0, true);
    await page.waitForFunction(() => document.getElementById('line').textContent === 'New here, or bringing a Player ID?');
    assert.equal(await page.textContent('#speaker'), hall.name, 'whoever keeps the door asks (Tally on the preview)');
    assert.equal(await page.$eval('#seat-form', (f) => f.hidden), true, 'the question first, no form yet');
    assert.deepEqual(await menuIds(page), ['who-new', 'who-restore'], 'no door, no game, no table before one is done');
    await shot(page, `hall-door-${size}`);
    assert.ok(await noSideScroll(page));
    await page.click('#menu [data-id="who-new"]'); // New here: the name
    await page.waitForSelector('#seat-form:not([hidden])');
    await page.waitForFunction((ask) => document.getElementById('line').textContent.endsWith(ask), hall.doorAsk);
    assert.equal((await page.textContent('#seat-go')).trim(), 'Next: pick an avatar');
    assert.equal(await page.$eval('#buyin-form', (f) => f.hidden), true, 'nothing about how much to bring');

    await page.fill('#seat-name', `Newcomer ${size}`);
    await page.click('#seat-go');
    await page.waitForSelector('#looks:not([hidden])'); // then the avatar
    assert.equal(await tokenOf(page), null, 'no player until both are chosen');
    await shot(page, `hall-avatar-${size}`);
    await page.click('#looks [data-look="ranger"]');
    await page.click('#menu [data-id="look-ok"]');
    await page.waitForFunction(() => /^In you come/.test(document.getElementById('line').textContent));
    const token = await tokenOf(page);
    assert.ok(token, 'a player now');
    assert.equal(page.url(), `${BASE}/`, 'still in the Hall');
    assert.equal(await page.$('#looks:not([hidden])'), null, 'the avatar was chosen on the way in');
    assert.equal((await apiGet('/players/me', await tokenOf(page))).avatar, 'ranger', 'and it is the one picked');
    assert.equal(await page.$eval('#buyin-form', (f) => f.hidden), true);
    await page.waitForFunction((n) => document.getElementById('who-line')?.textContent === `${n} · Purse: 1000`, `Newcomer ${size}`);
    assert.match(await page.textContent('#line'), /standing in the Hall with 1000 in your purse/);
    assert.deepEqual(await menuIds(page), ['seat', 'watch', 'rules', 'tnight'], 'with tNIGHT off, the choice is there and says coming soon');
    assert.equal((await page.textContent('#menu [data-id="seat"]')).trim(), 'Choose a game');

    const me = await apiGet('/players/me', token);
    assert.equal(me.purse.amount, 1000, 'purse untouched');
    assert.deepEqual((await apiGet('/players/me/seats', token)).seats, [], 'not seated anywhere');
    await page.waitForTimeout(1500); // a poll or two: nothing sits them down behind their back
    assert.deepEqual(page.seatCalls, [], 'no table made, no seat taken');
    assert.equal(await page.$('#in-play .row.mine'), null, 'no table marked as theirs');
    await shot(page, `hall-entered-${size}`);
    assert.ok(await noSideScroll(page));

    // Choose a game asks which: there is no default.
    await page.click('#menu [data-id="seat"]');
    await page.waitForSelector('#menu [data-id="pick-cup-and-claim"]');
    assert.deepEqual(await menuIds(page), ['pick-sealed-hand', 'pick-cup-and-claim', 'back']);
    assert.deepEqual(page.seatCalls, []);
    assert.deepEqual(page.errors, []);
    await context.close();
  });
}

test('the name is refused at the door (a doorman\'s name): it says why and stays at the door', { timeout: 30_000 }, async () => {
  const { context, page } = await session();
  await page.goto(BASE);
  await page.waitForSelector('#menu [data-id="who-new"]');
  await page.click('#menu [data-id="who-new"]');
  await page.waitForSelector('#seat-form:not([hidden])');
  await page.fill('#seat-name', (await apiGet('/hall')).name);
  await page.click('#seat-go');
  await page.click('#looks [data-look="adventurer"]'); // the name is checked when the player is made, after the avatar
  await page.click('#menu [data-id="look-ok"]');
  await page.waitForFunction(() => /doorman|name/i.test(document.getElementById('line').textContent) && !/^Evening/.test(document.getElementById('line').textContent));
  assert.equal(await tokenOf(page), null);
  assert.equal((await page.textContent('#seat-go')).trim(), 'Next: pick an avatar');
  assert.equal(await page.$('#seat-form:not([hidden])') !== null, true);
  await context.close();
});

for (const [options, size] of SIZES) {
  test(`pick a game, ${size}: Tally's bring prompt names it, 1,000 / Half / 100 / Not yet, and Not yet hands back the Hall`, { timeout: 60_000 }, async () => {
    const { context, page } = await session(options);
    const token = await enter(page, `Picker ${size}`);
    // The game in the room: the staircase is Cup & Claim.
    await page.click('#dialogue-close');
    await page.click('.spot[data-game="cup-and-claim"]');
    await page.waitForSelector('#buyin-form:not([hidden])');
    assert.match(await page.textContent('#line'), /^Cup & Claim\. /);
    assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Cup & Claim with 1,000');
    assert.deepEqual(await page.$$eval('#buyin-presets button', (els) => els.map((e) => e.textContent)), ['1,000', 'Half', '100']);
    assert.equal((await page.textContent('#menu [data-id="back"]')).trim(), 'Not yet');
    await shot(page, `hall-bring-cup-and-claim-${size}`);
    assert.ok(await noSideScroll(page));
    await page.click('[data-buyin="500"]');
    assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Cup & Claim with 500', 'Half');
    await page.click('[data-buyin="100"]');
    assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Cup & Claim with 100');

    await page.click('#menu [data-id="back"]'); // Not yet
    await page.waitForSelector('#dialogue', { state: 'hidden' });
    assert.equal(page.url(), `${BASE}/`);
    assert.deepEqual(page.seatCalls, [], 'Not yet makes nothing');
    assert.equal((await apiGet('/players/me', token)).purse.amount, 1000);
    assert.deepEqual((await apiGet('/players/me/seats', token)).seats, []);

    // The other game, through the doorman: the prompt names that one instead.
    await page.click('#doorman');
    await page.click('#menu [data-id="seat"]');
    await page.click('#menu [data-id="pick-sealed-hand"]');
    await page.waitForSelector('#buyin-form:not([hidden])');
    assert.match(await page.textContent('#line'), /^Sealed Hand\. /);
    assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Sealed Hand with 1,000');
    await page.click('#menu [data-id="back"]');
    await page.waitForSelector('#dialogue', { state: 'hidden' });
    assert.deepEqual(page.seatCalls, []);
    assert.deepEqual(page.errors, []);
    await context.close();
  });
}

test('pick a table from the list: the prompt names the game and the table; Sit down takes exactly that', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  const t = await apiPost('/dice-tables', { lobbySeconds: 300 });
  const host = await apiPost('/players', { name: 'Host' }); // a table is on the Hall's list once someone sits at it
  await apiPost(`/dice-tables/${t.id}/join`, { kind: 'human', buyIn: 10 }, host.token);
  const token = await enter(page, 'Lister');
  const row = `#in-play .row[data-table="${t.id}"]`;
  await page.waitForSelector(`${row} button`, { timeout: 10_000 });
  const label = await page.textContent(`${row} .trow-game`);
  const n = label.match(/table (\d+)/)?.[1];
  await page.click(`${row} button`); // Join
  await page.waitForSelector('#buyin-form:not([hidden])');
  assert.match(await page.textContent('#line'), new RegExp(`^Cup & Claim${n ? `, table ${n}` : ''}\\. `));
  assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Cup & Claim with 1,000');
  await page.click('[data-buyin="100"]');
  await page.click('#menu [data-id="sit"]');
  await page.waitForURL(new RegExp(`/dice\\?id=${t.id}`), { timeout: 15_000 });
  await page.waitForSelector('#leave:not([hidden])', { timeout: 15_000 });
  const seats = (await apiGet('/players/me/seats', token)).seats;
  assert.equal(seats.length, 1);
  assert.equal(seats[0].tableId, t.id);
  assert.equal(seats[0].stack, 100);
  assert.equal((await apiGet('/players/me', token)).purse.amount, 900);
  assert.deepEqual(page.errors, []);
  await context.close();
});

for (const [options, size] of SIZES) {
  test(`leave while seated, ${size}: The Hall asks first, Stay keeps the seat, Leave and go stands you up and the stack goes home`, { timeout: 90_000 }, async () => {
    const { context, page } = await session(options);
    const { token, id } = await seatedAtDice(page, { name: `Leaver ${size[0]}` });

    // The returning visitor, still seated: the Hall offers the way back, by game and table.
    await page.reload();
    await page.waitForSelector('#menu [data-id="return"]');
    assert.match(await page.textContent('#menu [data-id="return"]'), /^Back to Cup & Claim, table \d+ \(50 chips\)$/);
    assert.equal((await menuIds(page))[0], 'return');
    await page.click('#menu [data-id="return"]');
    await page.waitForURL(new RegExp(`/dice\\?id=${id}`));
    await page.waitForSelector('#leave:not([hidden])', { timeout: 15_000 });

    const hallLink = size === 'phone' ? async () => { await page.click('.nav-burger'); await page.click('#topnav a.nav-top[href="/"]'); } : () => page.click('#topnav a.nav-top[href="/"]');
    await hallLink();
    await page.waitForSelector('#confirm-leave:not([hidden])');
    assert.equal(await page.textContent('#confirm-leave-line'), 'You’re seated at Cup & Claim with 50 chips. Leave the table and go to the Hall?');
    assert.equal((await page.textContent('#confirm-leave-go')).trim(), 'Leave and go');
    assert.equal((await page.textContent('#confirm-leave-stay')).trim(), 'Stay');
    await shot(page, `table-leave-confirm-${size}`);
    assert.ok(await noSideScroll(page));
    await page.click('#confirm-leave-stay');
    await page.waitForSelector('#confirm-leave', { state: 'hidden' });
    assert.match(page.url(), new RegExp(`/dice\\?id=${id}`), 'Stay stays');
    assert.equal((await apiGet('/players/me/seats', token)).seats.length, 1, 'and keeps the seat');

    await hallLink();
    await page.click('#confirm-leave-go');
    await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
    await page.waitForSelector('#notice:not([hidden])');
    assert.equal(await page.textContent('#notice'), '50 returned to your purse (now 1000).');
    assert.deepEqual((await apiGet('/players/me/seats', token)).seats, [], 'stood up');
    assert.equal((await apiGet('/players/me', token)).purse.amount, 1000, 'the whole stack is back');
    const ids = await menuIds(page);
    assert.ok(!ids.includes('return') && !ids.includes('resit'), `standing, so no way "back" to a table: ${ids}`);
    assert.doesNotMatch(await page.textContent('#menu'), /Back to Cup & Claim/);
    assert.equal(await page.$(`#in-play .row.mine`), null);
    const table = await apiGet(`/dice-tables/${id}`);
    assert.ok(table.phase === 'over' || table.seats.every((s) => s.left || s.kind !== 'human'), 'no round plays on with them in it');
    await shot(page, `hall-after-leave-${size}`);

    // Back in the browser doesn't bring up the table they left.
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
    assert.doesNotMatch(page.url(), /\/dice\?id=/, `no stale table in the history: ${page.url()}`);
    assert.deepEqual(page.errors, []);
    await context.close();
  });
}

test('leave for the Games menu while seated: asks with the game named, then stands and opens the bring prompt for that game', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  const { token, id } = await seatedAtDice(page, { name: 'Switcher', buyIn: 70 });
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 15_000 });
  await page.click('#topnav .nav-drop > button'); // Games
  await page.click('#topnav a[href="/?play=sealed-hand"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  assert.equal(await page.textContent('#confirm-leave-line'), 'You’re seated at Cup & Claim with 70 chips. Leave the table and go to Sealed Hand?');
  await page.click('#confirm-leave-go');
  await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
  await page.waitForSelector('#buyin-form:not([hidden])');
  assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Sealed Hand with 1,000');
  assert.deepEqual((await apiGet('/players/me/seats', token)).seats, []);
  assert.equal((await apiGet('/players/me', token)).purse.amount, 1000);
  await page.click('#menu [data-id="back"]');
  await page.waitForSelector('#dialogue', { state: 'hidden' });
  assert.deepEqual((await apiGet('/players/me/seats', token)).seats, [], 'Not yet: still standing');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('leave in the middle of a round, at a table of bots: Leave and go ends the round for you and lands in the Hall standing', { timeout: 90_000 }, async () => {
  const { context, page } = await session();
  const { token, id } = await seatedAtDice(page, { name: 'Midround', buyIn: 60, table: { lobbySeconds: 0, test: { rng: 7, botDelayMs: [400, 800], roundGapMs: 60_000 } } });
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForFunction(() => /after this round/.test(document.getElementById('leave')?.textContent ?? ''), null, { timeout: 15_000 });
  await page.click('#topnav a.nav-top[href="/"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  assert.match(await page.textContent('#confirm-leave-line'), /^You’re seated at Cup & Claim with \d+ chips\. Leave the table and go to the Hall\?$/);
  await page.click('#confirm-leave-go');
  await page.waitForURL(`${BASE}/`, { timeout: 30_000 });
  assert.deepEqual((await apiGet('/players/me/seats', token)).seats, []);
  const table = await apiGet(`/dice-tables/${id}`);
  const round = table.round;
  await page.waitForTimeout(2500);
  assert.equal((await apiGet(`/dice-tables/${id}`)).round, round, 'no round deals on without them');
  const purse = (await apiGet('/players/me', token)).purse.amount;
  assert.ok(purse > 940 - 60 && purse <= 1000 + 60 * 5, `the stack it ended with is in the purse: ${purse}`);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('a chip table waiting in the lobby: "Deal me in now, with bots" fills the seats and deals at once; the clock stays for anyone who waits', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  const { token, id } = await seatedAtDice(page, { name: 'Impatient', buyIn: 50, table: { lobbySeconds: 300 } });
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForSelector('#deal-now', { timeout: 15_000 });
  assert.equal((await page.textContent('#deal-now')).trim(), 'Deal me in now, with bots');
  assert.equal((await apiGet(`/dice-tables/${id}`)).phase, 'lobby', 'still waiting: nothing happens until it is pressed');
  await page.waitForTimeout(1500);
  assert.equal((await apiGet(`/dice-tables/${id}`)).round, 0);
  await page.click('#deal-now');
  await page.waitForFunction(() => /Round 1/.test(document.getElementById('phase')?.textContent ?? ''), null, { timeout: 15_000 });
  const t = await apiGet(`/dice-tables/${id}`);
  assert.equal(t.round, 1);
  assert.equal(t.seats.length, t.seatsTotal, 'bots took the empty seats');
  assert.equal(t.seats.filter((x) => x.kind === 'house').length, t.seatsTotal - 1);
  assert.equal(await page.$('#deal-now'), null, 'the button is gone once the table has started');
  assert.equal((await apiGet('/players/me/seats', token)).seats[0].tableId, id);
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- with tNIGHT on: chips or tNIGHT is the one choice on arrival, remembered, and never chips by default ----------

const jh = { authorization: `Bearer ${JUDGE}`, 'content-type': 'application/json' };
const tnPost = async (path, body, headers = { 'content-type': 'application/json' }) => (await fetch(TN + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })).json();
const tnGet = async (path, headers = {}) => (await fetch(TN + path, { headers })).json();
const modeOf = (page) => page.evaluate(() => localStorage.getItem('hall.mode'));
/** A player saved in the browser (11-10: nothing but the Player ID question comes before one). Returns the token. */
const tnPlayer = async (name) => (await tnPost('/players', { name })).token;
const A = 'a'.repeat(64);
const H = 'e'.repeat(64);

/** A door session the judge has verified, with `whole` tNIGHT in the cage: the token this browser keeps. */
async function verifiedDoor(name, whole) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const { token } = await tnPost('/door', { cageId: A, payout: '0'.repeat(64), expires, verifyingKey: 'vk', signature: 'sig', name, kind: 'human' });
  const { doors } = await tnGet('/judge/tables', jh);
  for (const d of doors.filter((x) => x.status === 'pending')) await tnPost('/judge/door', { key: d.key, ok: true, balanceStar: String(whole * 1_000_000) }, jh);
  return token;
}
/** A warm Cup & Claim tNIGHT table with the house float seated, as the judge keeps one. */
async function warmDice() {
  const warm = await tnPost('/judge/warm', { bots: 2, game: 'cup-and-claim' }, jh);
  await tnPost(`/judge/tables/${warm.id}/house`, { cageId: H, atRiskStar: '60000000', balanceStar: '60000000', epoch: 1 }, jh);
  return warm;
}

for (const [options, size] of SIZES) {
  test(`arrival with tNIGHT on, ${size}: one choice, chips or tNIGHT; chips goes by the door and is remembered; tNIGHT goes by the cage`, { timeout: 90_000 }, async () => {
    const { context, page } = await session(options);
    await page.goto(TN);
    // Who first (11-10): before the way to play, a player: New here, or bringing a Player ID?
    await page.waitForFunction(() => document.getElementById('line').textContent === 'New here, or bringing a Player ID?');
    assert.deepEqual(await menuIds(page), ['who-new', 'who-restore'], 'no way to play, no door, no table before one is done');
    assert.equal(await modeOf(page), null);
    await shot(page, `tn-who-${size}`);
    assert.ok(await noSideScroll(page));
    await chalkIn(page, `Chips ${size}`);
    await page.waitForSelector('#menu [data-id="mode-tnight"]');
    const hall = await tnGet('/hall');
    assert.equal(await page.textContent('#line'), `${hall.greeting[0]} ${hall.chooseMode}`);
    assert.deepEqual(await menuIds(page), ['mode-chips', 'mode-tnight', 'rules'], 'the one choice, once a player is made, before a wallet');
    assert.equal(await page.$eval('#seat-form', (f) => f.hidden), true, 'no name asked again');
    assert.equal(await page.$eval('#menu [data-id="mode-chips"]', (e) => e.classList.contains('menu-primary')), true);
    assert.equal(await page.$eval('#menu [data-id="mode-tnight"]', (e) => e.classList.contains('menu-primary')), true);
    assert.equal(await modeOf(page), null);
    await shot(page, `tn-arrival-${size}`);
    assert.ok(await noSideScroll(page));

    // Chips: the Hall as always, and the other way stays on offer.
    await page.click('#menu [data-id="mode-chips"]');
    assert.equal(await modeOf(page), 'chips');
    await page.waitForFunction((n) => document.getElementById('who-line')?.textContent === `${n} · Purse: 1000`, `Chips ${size}`);
    assert.deepEqual(await menuIds(page), ['seat', 'watch', 'rules', 'mode-tnight'], 'the other way is offered, never taken');
    assert.deepEqual(page.seatCalls, []);
    await page.reload();
    await page.waitForSelector('#menu [data-id="seat"]');
    assert.ok(!(await menuIds(page)).includes('mode-chips'), 'remembered: not asked again');
    assert.deepEqual(page.errors, []);
    await shot(page, `tn-chips-hall-${size}`);

    // tNIGHT, with nothing in the cage: the cage page is the first stop, and the Hall says so when they come back.
    await page.click('#menu [data-id="mode-tnight"]');
    await page.waitForURL(/\/wallet\?door=1$/);
    assert.equal(await modeOf(page), 'tnight');
    await page.goto(TN);
    page.errors.length = 0; // the cage page's own noise, without a wallet, is not the Hall's
    await page.waitForSelector('#menu [data-id="cage"]');
    assert.equal(await page.textContent('#line'), hall.tnightEmpty);
    assert.deepEqual(await menuIds(page), ['cage', 'watch', 'rules', 'mode-chips']);
    assert.equal((await page.textContent('#menu [data-id="cage"]')).trim().startsWith('Bring tNIGHT at the cage'), true);
    assert.doesNotMatch(await page.textContent('#who'), /Purse/, 'never the chip balance in tNIGHT mode');
    assert.match(await page.textContent('#who'), /tNIGHT: nothing in the cage yet/);
    await shot(page, `tn-empty-cage-${size}`);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  test(`tNIGHT, funded, ${size}: the banner shows the cage and the wallet, the greeting offers a seat, and a game goes to its tNIGHT table`, { timeout: 90_000 }, async () => {
    const name = `Funded ${size[0]}`;
    const token = await verifiedDoor(name, 50);
    const player = await tnPlayer(name);
    const warm = await warmDice();
    const { context, page } = await session(options);
    await page.goto(TN);
    const hall = await tnGet('/hall');
    await page.evaluate(([t, p]) => {
      localStorage.setItem('hall.player', p);
      localStorage.setItem('cage.door', t);
      localStorage.setItem('hall.mode', 'tnight');
      localStorage.setItem('cage.wallet-read', JSON.stringify({ name: 'Lace', night: '4929400000', at: Date.now() })); // as the cage page last read it
    }, [token, player]);
    await page.reload();
    await page.waitForSelector('#menu [data-id="seat"]');
    assert.equal((await page.textContent('#who-line')).trim(), `${name} · tNIGHT: 50 in the cage · 4,929 in Lace`);
    assert.equal(await page.textContent('#line'), `Welcome back, ${name}. The cage holds 50 tNIGHT for you. Pick a game and the judge seats you, nothing to approve.`);
    assert.deepEqual(await menuIds(page), ['seat', 'watch', 'rules', 'cage', 'mode-chips']);
    assert.equal((await page.textContent('#menu [data-id="seat"]')).trim(), 'Take a seat');
    assert.equal((await page.textContent('#menu [data-id="cage"]')).trim(), 'Cage: 50 tNIGHT · Cash out · Top up'); // the one cage line, every menu (The owner, 11-07)
    await shot(page, `tn-hall-funded-${size}`);
    assert.ok(await noSideScroll(page));
    await page.click('#menu [data-id="seat"]');
    await page.waitForSelector('#menu [data-id="pick-cup-and-claim"]');
    assert.match(await page.textContent('#menu [data-id="pick-cup-and-claim"]'), new RegExp(`table ${warm.state.cage.table}, preprod`));
    assert.match(await page.textContent('#menu [data-id="pick-sealed-hand"]'), /opens a table/);
    await shot(page, `tn-which-game-${size}`);
    await page.click('#menu [data-id="pick-cup-and-claim"]');
    // Once, before the first tNIGHT seat: Tally says why the tables wait (round 2, item 12). Got it goes on; the next time there's no line.
    await page.waitForSelector('#menu [data-id="go"]');
    assert.equal(await page.textContent('#line'), hall.tnightWait);
    assert.equal((await page.textContent('#menu [data-id="go"]')).trim(), 'Sit me down at Cup & Claim');
    await shot(page, `tn-why-the-wait-${size}`);
    await page.click('#menu [data-id="go"]');
    await page.waitForURL(new RegExp(`/dice\\?id=${warm.id}$`));
    assert.equal(await page.evaluate(() => localStorage.getItem('hall.tnight.told')), '1');
    await page.waitForFunction(() => /Sit at this table/.test(document.getElementById('join-title')?.textContent ?? ''));
    assert.equal(await page.$('#deal-now'), null, 'a tNIGHT table is seated by the judge: no deal-now button');
    assert.deepEqual(page.seatCalls, [], 'no chip table made, no chip seat taken');
    assert.equal(await modeOf(page), 'tnight');
    assert.deepEqual(page.errors, []);
    await context.close();
  });
}

test('the Games menu with nothing said yet: the game’s sign asks chips or tNIGHT by name, and the one pressed is the way from then on', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  await page.goto(`${TN}/?play=sealed-hand`);
  await page.waitForSelector('#menu [data-id="join"]');
  assert.equal(page.url(), `${TN}/`);
  assert.match(await page.textContent('#line'), /^Sealed Hand\. /);
  const ids = await menuIds(page);
  assert.equal(ids[0], 'join');
  assert.ok(ids[1] === 'bring' || ids[1] === 'open', `the tNIGHT way, by name: ${ids}`);
  assert.match(await page.textContent('#menu [data-id="join"]'), /^Play chips/);
  assert.equal(await modeOf(page), null);
  assert.deepEqual(page.seatCalls, [], 'nothing taken for them');
  await page.click('#menu [data-id="join"]'); // Play chips: no purse here yet, so the name first, then the bring prompt names the game
  assert.equal(await modeOf(page), 'chips');
  await chalkIn(page, 'Gamer');
  await page.waitForSelector('#buyin-form:not([hidden])');
  assert.equal((await page.textContent('#menu [data-id="sit"]')).trim(), 'Sit down at Sealed Hand with 1,000');
  assert.deepEqual(page.seatCalls, []);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('switching games in tNIGHT mode keeps to tNIGHT: the Games link goes to that game’s tNIGHT table, never a chips prompt', { timeout: 60_000 }, async () => {
  const token = await verifiedDoor('Hopper', 40);
  const player = await tnPlayer('Hopper');
  const { context, page } = await session();
  await page.goto(TN);
  await page.evaluate(([t, p]) => { localStorage.setItem('hall.player', p); localStorage.setItem('cage.door', t); localStorage.setItem('hall.mode', 'tnight'); localStorage.setItem('hall.tnight.told', '1'); }, [token, player]);
  await page.goto(`${TN}/?play=sealed-hand`);
  await page.waitForURL(/\/table\?id=[0-9a-f]{64}$/, { timeout: 15_000 });
  const id = new URL(page.url()).searchParams.get('id');
  const view = await tnGet(`/tables/${id}`);
  assert.ok(view.cage, 'a tNIGHT table, opened for them since none was seating');
  assert.deepEqual(page.seatCalls.filter((p) => /join$/.test(p)), [], 'no chip seat: the table seats them from the cage');
  await page.waitForFunction(() => /Sit at this table/.test(document.getElementById('join-title')?.textContent ?? ''));
  assert.equal(await modeOf(page), 'tnight');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('the table list in tNIGHT mode: every row says which way it is, and a chips row is a press, never a default', { timeout: 60_000 }, async () => {
  const host = await tnPost('/players', { name: 'Hosting' });
  const chips = await tnPost('/dice-tables', { lobbySeconds: 300 });
  await tnPost(`/dice-tables/${chips.id}/join`, { kind: 'human', buyIn: 10 }, { 'content-type': 'application/json', authorization: `Bearer ${host.token}` });
  const warm = await warmDice();
  const { context, page } = await session();
  const lister = await tnPlayer('Lister');
  await page.goto(TN);
  await page.evaluate((p) => { localStorage.setItem('hall.player', p); localStorage.setItem('hall.mode', 'tnight'); }, lister);
  await page.reload();
  await page.waitForSelector(`#in-play .row[data-table="${chips.id}"] button`, { timeout: 10_000 });
  assert.equal((await page.textContent(`#in-play .row[data-table="${chips.id}"] button`)).trim(), 'Play chips');
  assert.equal((await page.textContent(`#in-play .row[data-table="${warm.id}"] [data-bring]`)).trim(), 'Play for tNIGHT');
  // One table number, the cage's (the one on the receipts), with preprod kept; never two numbers in a row (round 2).
  const label = (await page.textContent(`#in-play .row[data-table="${warm.id}"] .trow-game`)).replace(/\s+/g, ' ').trim();
  assert.equal(label, `Cup & Claim · Table ${warm.state.cage.table} · tNIGHTAnte 5 · preprod`, label); // the name, the one number, tNIGHT; under it the ante and preprod
  assert.equal((label.match(/\b[Tt]able \d+/g) ?? []).length, 1, `one table number: ${label}`);
  await page.click(`#in-play .row[data-table="${chips.id}"] button`);
  await page.waitForSelector('#buyin-form:not([hidden])'); // chips it is, by their press: the bring prompt (the player is saved already)
  assert.equal(await modeOf(page), 'chips');
  assert.deepEqual(page.seatCalls, []);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('leaving a tNIGHT table for the Hall: it asks, in tNIGHT, and the Hall opens in tNIGHT mode with no way back to that table', { timeout: 120_000 }, async () => {
  const t = await tnPost('/dice-tables', { tnight: true, bots: 2, lobbySeconds: 0, test: { rng: 11, botDelayMs: [300, 500], roundGapMs: 60_000 } });
  const claim = await tnPost(`/dice-tables/${t.id}/cage-seat`, { name: 'Prober', cageId: A, verifyingKey: 'vk', signature: 'sig' });
  await tnPost(`/judge/tables/${t.id}/house`, { cageId: H, atRiskStar: '60000000', balanceStar: '60000000', epoch: 1 }, jh);
  await tnPost(`/judge/tables/${t.id}/verified`, { cageId: A, ok: true, atRiskStar: '40000000', balanceStar: '40000000', epoch: 1, lastRound: '40' }, jh);
  const player = await tnPlayer('Prober');
  const { context, page } = await session();
  await page.goto(TN);
  await page.evaluate(([id, s, p]) => { localStorage.setItem('hall.player', p); localStorage.setItem(`hall.seat.${id}`, s); localStorage.setItem('hall.mode', 'tnight'); }, [t.id, claim.token, player]);

  // The returning visitor, still seated for tNIGHT: the Hall offers the way back, by game and table, in tNIGHT.
  await page.reload();
  await page.waitForSelector('#menu [data-id="return"]');
  assert.match(await page.textContent('#menu [data-id="return"]'), /^Back to Cup & Claim(, table \d+)? \(\d+ tNIGHT\)$/, 'in tNIGHT, not chips: the stack as the table has it (the ante is in the pot once the cups are shaken)');
  await page.click('#menu [data-id="return"]');
  await page.waitForURL(new RegExp(`/dice\\?id=${t.id}`));
  await page.waitForSelector('#leave:not([hidden])', { timeout: 15_000 });

  await page.click('#topnav a.nav-top[href="/"]');
  await page.waitForSelector('#confirm-leave:not([hidden])');
  assert.match(await page.textContent('#confirm-leave-line'), /^You’re seated at Cup & Claim with \d+ tNIGHT\. Leave the table and go to the Hall\?$/);
  await page.click('#confirm-leave-go');
  await page.waitForURL(`${TN}/`, { timeout: 90_000 });
  await page.waitForSelector('#menu [data-id="cage"], #menu [data-id="seat"]');
  assert.equal(await modeOf(page), 'tnight', 'still tNIGHT');
  const ids = await menuIds(page);
  assert.ok(!ids.includes('return'), `stood up: no way back to that table: ${ids}`);
  assert.ok(ids.includes('mode-chips') && !ids.includes('mode-tnight'), 'the tNIGHT greeting, with chips as the other way');
  assert.equal(await page.$eval('#notice', (n) => n.hidden), true, 'no chip purse line');
  assert.doesNotMatch(await page.textContent('#who'), /Purse/);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('staging only: "Start fresh as a new visitor" in the top bar forgets the mode, the name and the wallet choice, keeps the cage key, and lands at the first question; the chips Hall has no such link', { timeout: 60_000 }, async () => {
  const { context, page } = await session();
  const { token } = await tnPost('/players', { name: 'Freshly' }); // a purse on this Hall (a token from the other server would be dropped as unknown)
  await page.goto(TN);
  await page.evaluate(([t]) => {
    localStorage.setItem('hall.player', t);
    localStorage.setItem('hall.mode', 'chips');
    localStorage.setItem('cage.wallet', 'io.lace.wallet');
    localStorage.setItem('cage.door', 'door-token');
    localStorage.setItem('cage.key.mn_addr_test', 'ab'.repeat(32)); // the money in the cage: never thrown away
    localStorage.setItem('hall.seat.' + 'f'.repeat(64), 'seat-token');
  }, [token]);
  await page.reload();
  await page.waitForSelector('#nav-fresh', { timeout: 10_000 });
  assert.equal((await page.textContent('#nav-fresh')).trim(), 'Start fresh as a new visitor');
  page.once('dialog', (d) => d.accept());
  await page.click('#nav-fresh');
  await page.waitForSelector('#menu [data-id="who-new"]', { timeout: 10_000 }); // the first question is who: New here, or bringing a Player ID?
  const left = await page.evaluate(() => Object.keys(localStorage).sort());
  assert.ok(!left.includes('hall.mode') && !left.includes('hall.player') && !left.includes('cage.wallet') && !left.includes('cage.door') && !left.some((k) => k.startsWith('hall.seat.')), `forgotten: ${left}`);
  assert.ok(left.includes('cage.key.mn_addr_test'), 'the cage key stays');
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.player.previous')), token, 'the Player ID is kept under previous, never the only copy thrown away');
  assert.equal((await page.textContent('#who')).trim(), '', 'a new visitor');
  assert.deepEqual(await menuIds(page), ['who-new', 'who-restore']);
  // the chips Hall (no FRESH_START) has no such link
  await page.goto(BASE);
  await page.waitForSelector('#topnav');
  await page.waitForTimeout(600);
  assert.equal(await page.$('#nav-fresh'), null);
  assert.deepEqual(page.errors, []);
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
