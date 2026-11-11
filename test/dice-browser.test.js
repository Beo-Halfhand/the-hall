// The Cup & Claim page in headless Chrome against a throwaway local `wrangler dev`.
// Set SHOTS to a folder to save phone and desktop screenshots.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = 8843;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 900 } };

let browser;

before(async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
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

const shot = async (page, name, full = false) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full });
};

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function apiPost(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

/** A table where the bots take a moment, so a page can be seen mid-turn. */
async function newTable(extra = {}) {
  const t = await apiPost('/dice-tables', { lobbySeconds: 0, test: { rng: 7, botDelayMs: [400, 800], roundGapMs: 60_000, ...extra } });
  return t.id;
}

test('the Hall lists Cup & Claim as a live sign, and its page carries the plaque', async () => {
  const { context, page } = await session();
  await page.goto(BASE);
  await page.waitForSelector('[data-game="cup-and-claim"]');
  const status = await page.getAttribute('[data-game="cup-and-claim"]', 'data-status');
  assert.equal(status, 'live');
  await context.close();
});

test('phone: sit down, the cup shakes and slams, bid with a raise, call Liar, choose the proof, see the count', async () => {
  const id = await newTable();
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForSelector('#join-box:not([hidden])');
  assert.match(await page.textContent('.plaque-line'), /I choose what to show: the dice, or just the count\./);
  await shot(page, 'dice-phone-join');
  assert.ok(await noSideScroll(page));

  await page.fill('#join-name', 'Probe');
  await page.click('#join-submit');
  await page.waitForFunction(() => document.getElementById('join-box').hidden);
  await page.waitForSelector('.my-dice.shown .die', { timeout: 10_000 });
  const dice = await page.$$('.my-dice .die');
  assert.equal(dice.length, 5);
  assert.match(await page.textContent('#counts'), /You hold, with wilds/);
  assert.equal((await page.$$('.cup-card')).length, 4);
  await page.waitForSelector('#bid-confirm');
  await shot(page, 'dice-phone-open', true);
  assert.ok(await noSideScroll(page));

  // Open with the lowest bid and a raise of 5, from the picker.
  assert.match(await page.textContent('#bid-confirm'), /^Bid: at least 1 two/);
  await page.click('#count-up');
  assert.equal(await page.textContent('#count-value'), '2');
  await page.click('[data-face="5"]');
  await page.click('[data-raise-amount="5"]');
  assert.match(await page.textContent('#bid-confirm'), /^Bid: at least 2 fives \+ raise 5$/);
  await page.click('#bid-confirm');
  await page.waitForFunction(() => document.querySelector('#felt-bid')?.textContent.includes('2 fives'));
  await page.waitForFunction(() => Number(document.getElementById('pot').textContent) >= 25);

  // Wait for the bots to come back round, then call Liar on whatever stands (or answer a duel they started).
  await page.waitForFunction(() => document.querySelector('#liar') || document.querySelector('#choose-prove') || document.querySelector('[data-action="next"]'), null, { timeout: 20_000 });
  if (await page.$('#liar')) {
    await shot(page, 'dice-phone-liar', true);
    await page.click('#liar');
  }
  await page.waitForFunction(() => document.querySelector('#choose-prove') || document.querySelector('[data-action="next"]') || document.querySelector('#chosen-line'), null, { timeout: 20_000 });
  if (await page.$('#choose-prove')) {
    assert.match(await page.textContent('#duel-head'), /Liar on/);
    await shot(page, 'dice-phone-prove-or-show', true);
    assert.doesNotMatch(await page.textContent('#actions'), /on chain/i, 'a chip table settles nothing on chain, so the choice doesn\u2019t say so');
    await page.click('#choose-prove');
    await page.waitForSelector('#chosen-line');
    assert.match(await page.textContent('#chosen-line'), /cup stays shut/);
  }
  await page.waitForSelector('[data-action="next"]', { timeout: 20_000 });
  await page.waitForSelector('#call-box:not([hidden])');
  const call = await page.textContent('#call');
  assert.match(call, /HOLDS|FALLS/);
  assert.match(call, /House secret opened/);
  await shot(page, 'dice-phone-counted', true);
  // The after-round card: my net is my award less what I had in, and the card holds the one Play again.
  await page.waitForSelector('#after-round:not([hidden])');
  const state = await (await fetch(`${BASE}/dice-tables/${new URL(page.url()).searchParams.get('id')}`)).json();
  const mySeat = state.seats.findIndex((x) => x.name === 'Probe');
  const r = state.lastResult;
  const net = (r.awards.find((a) => a.seat === mySeat)?.amount ?? 0) - r.stakes[mySeat];
  assert.equal((await page.textContent('#ar-net')).trim(), net > 0 ? `+${net}` : net < 0 ? `\u2212${-net}` : '0');
  assert.equal(r.stakes.reduce((a, b) => a + b, 0), r.pot, 'the stakes add up to the pot');
  assert.match(await page.textContent('#ar-place'), /by stack, of \d at this table$/);
  assert.equal((await page.textContent('#ar-again')).trim(), 'Next round'); // chips tables say Next round (the 11-09 pass)
  assert.equal(await page.$('#actions [data-action="next"]'), null);
  assert.equal(await page.$$eval('#move-row button', (b) => b.length), 0, 'the round is over: no Bid, no Liar, no Fold to press (The owner, 11-05)');
  assert.equal(await page.$('#bid-confirm'), null);
  assert.ok(await noSideScroll(page));
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('phone: chips at another dice table: the second table says so with a way back, and the top-up refusal stays on screen', async () => {
  const idA = await newTable();
  const idB = await newTable();
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/dice?id=${idA}`);
  await page.waitForSelector('#join-box:not([hidden])');
  await page.fill('#join-name', 'Wanderer');
  await page.click('#join-submit');
  await page.waitForFunction(() => document.getElementById('join-box').hidden);
  await page.waitForFunction(() => /Your stack 995/.test(document.getElementById('purse-bar').textContent));

  // The second table, the way a second tap on the stairs gets there.
  await page.goto(`${BASE}/dice?id=${idB}&join=1`);
  await page.waitForSelector('#join-return', { timeout: 15_000 });
  assert.match(await page.textContent('#join-note'), /still seated at Cup & Claim, table \d+ \(995 chips\).*Leave it and bring my stack here.*Back to Cup & Claim, table \d+/);
  assert.ok(await page.$eval('#join-form', (el) => el.hidden), 'no form to fail with');
  assert.equal(await page.$eval('#join-topup', (el) => el.hidden), true, 'no top-up offered');
  await shot(page, 'dice-phone-chips-elsewhere');
  await page.click('#join-return');
  await page.waitForURL(new RegExp(`id=${idA}`));
  await page.waitForFunction(() => /Your stack 995/.test(document.getElementById('purse-bar').textContent), null, { timeout: 15_000 });
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('phone: /dice with no table says so, and Start a table makes one and lands on it', async () => {
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/dice`);
  await page.waitForSelector('#start-table');
  assert.equal(await page.textContent('#phase'), 'No table yet');
  assert.equal(await page.textContent('#join-title'), 'No table yet');
  assert.ok(await page.$eval('#join-form', (el) => el.hidden));
  assert.equal(await page.getAttribute('#back-to-hall', 'href'), '/');
  await shot(page, 'dice-phone-no-table');
  assert.ok(await noSideScroll(page));
  await page.click('#start-table');
  await page.waitForURL(/\/dice\?id=[0-9a-f]{64}/, { timeout: 15_000 });
  await page.waitForSelector('#join-box:not([hidden]) #join-form:not([hidden])');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('desktop: watching shows every cup shut and never a die of anyone’s', async () => {
  const id = await newTable();
  const { token } = await apiPost(`/dice-tables/${id}/join`, { name: 'Someone' });
  await fetch(`${BASE}/dice-tables/${id}/act`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'bid', count: 2, face: 3 }) });
  const { context, page } = await session(DESKTOP);
  await page.goto(`${BASE}/dice?id=${id}&watch=1`);
  await page.waitForSelector('.cup-card');
  assert.equal(await page.textContent('#mode'), 'watching');
  assert.match(await page.textContent('#cup-title'), /Every cup stays shut/);
  assert.equal(await page.$('#bid-confirm'), null);
  await page.waitForSelector('#felt-bid:not([hidden])', { timeout: 15_000 });
  await shot(page, 'dice-desktop-watch');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('leaving a dice table: the Hall says what came back, once, and offers no way "back" to the table left', async () => {
  const player = await apiPost('/players', { name: 'Backer' });
  const { id } = await apiPost('/dice-tables', { lobbySeconds: 300 });
  const seat = await (await fetch(`${BASE}/dice-tables/${id}/join`, { method: 'POST', headers: { authorization: `Bearer ${player.token}` }, body: JSON.stringify({ kind: 'human', buyIn: 50 }) })).json();
  const left = await (await fetch(`${BASE}/dice-tables/${id}/leave`, { method: 'POST', headers: { authorization: `Bearer ${seat.token}` }, body: '{}' })).json();
  assert.equal(left.amount, 50);
  const { context, page } = await session();
  await page.goto(BASE);
  await page.evaluate(([t, tableId]) => {
    localStorage.setItem('hall.player', t);
    localStorage.setItem('hall.left', JSON.stringify({ id: tableId, page: '/dice', amount: 50, told: false }));
  }, [player.token, id]);
  await page.goto(BASE);
  await page.waitForSelector('#notice:not([hidden])');
  assert.equal(await page.textContent('#notice'), '50 returned to your purse (now 1000).');
  // Standing is standing (The owner, 11-06): the first choice is a game, not the table just left.
  assert.equal((await page.textContent('#menu button')).trim(), 'Take a seat');
  assert.equal(await page.$('#menu [data-id="resit"]'), null);
  assert.doesNotMatch(await page.textContent('#menu'), /Back to Cup & Claim/);
  await page.reload();
  await page.waitForSelector('#menu [data-id="seat"]');
  assert.equal(await page.$eval('#notice', (el) => el.hidden), true, 'said once');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('no 1s in the cup: the counts line and the To beat line never print the word null', { timeout: 60_000 }, async () => {
  // Deals with a fixed generator until the seat's cup has no 1s in it.
  let id;
  let token;
  for (let rng = 1; rng < 60 && !id; rng += 1) {
    const t = await apiPost('/dice-tables', { lobbySeconds: 0, test: { rng, botDelayMs: [800, 1200], roundGapMs: 60_000 } });
    const seat = await apiPost(`/dice-tables/${t.id}/join`, { name: 'Dry', kind: 'human' });
    const me = await (await fetch(`${BASE}/dice-tables/${t.id}/me`, { headers: { authorization: `Bearer ${seat.token}` } })).json();
    if (me.dice && !me.dice.includes(1)) { id = t.id; token = seat.token; }
  }
  assert.ok(id, 'a generator that deals no wilds');
  const { context, page } = await session(PHONE);
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [`hall.seat.${id}`, token]);
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForFunction(() => /You hold, with wilds/.test(document.getElementById('counts').textContent), null, { timeout: 20_000 });
  const counts = await page.textContent('#counts');
  assert.doesNotMatch(counts, /null/);
  assert.doesNotMatch(counts, /wild$/, 'no wilds, no wilds note');
  // A watcher is never the one to bid, so this is the To beat line with no hint after it.
  await fetch(`${BASE}/dice-tables/${id}/act`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'bid', count: 1, face: 2 }) });
  const watcher = await session(PHONE);
  await watcher.page.goto(`${BASE}/dice?id=${id}&watch=1`);
  await watcher.page.waitForFunction(() => /To beat/.test(document.getElementById('to-beat')?.textContent ?? ''), null, { timeout: 20_000 });
  assert.doesNotMatch(await watcher.page.textContent('#to-beat'), /null/);
  assert.deepEqual(page.errors, []);
  await watcher.context.close();
  await context.close();
});

test('the panel says who you are trusting, and a chip table does not claim the chain', async () => {
  const id = await newTable();
  const { context, page } = await session(PHONE);
  await page.goto(`${BASE}/dice?id=${id}&watch=1`);
  await page.waitForSelector('#trust');
  const text = await page.textContent('#trust');
  assert.match(text, /Your cup/);
  assert.match(text, /Other players never see it\. The house deals it\./);
  assert.match(text, /locked by fingerprint at the deal/);
  assert.match(text, /house’s word, for now/);
  assert.match(await page.textContent('#trust-chips'), /^Play chips, on the house’s ledger\. Nothing here goes on chain\.$/);
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- the room on the owner's table art, the reveal, and the Player ID (11-06) ----------

/** Seats a player with a Player ID at a fresh table, from the page, at the given size. */
async function seatedWithId(options) {
  const id = await newTable({ botDelayMs: [600, 1000] });
  const player = await apiPost('/players', { name: 'The owner', testChips: 900 });
  const s = await session(options);
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await s.page.goto(BASE);
  await s.page.evaluate((t) => localStorage.setItem('hall.player', t), player.token);
  await s.page.goto(`${BASE}/dice?id=${id}`);
  await s.page.waitForSelector('#join-box:not([hidden])');
  if (await s.page.isVisible('#join-name')) await s.page.fill('#join-name', 'The owner');
  await s.page.click('#join-submit');
  await s.page.waitForSelector('.my-dice.shown .die', { timeout: 15_000 });
  return { ...s, id, player };
}

/** Bids, calls Liar when it comes round, shows the dice when asked, until the call is counted. */
async function playToTheCall(page) {
  await page.waitForSelector('#bid-confirm', { timeout: 20_000 });
  await page.click('#bid-confirm');
  for (let i = 0; i < 80 && !(await page.$('#reveal:not([hidden])')); i++) {
    if (await page.$('#choose-show')) await page.click('#choose-show').catch(() => {});
    else if (await page.$('#liar')) await page.click('#liar').catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('#reveal:not([hidden])', { timeout: 20_000 });
}

test('the room is the owner\'s table art, a band of the table on a phone (Phase A, 11-07) and cropped to the lamp, window and table on a laptop, never stretched, nothing laid over it, the cups on the table top', { timeout: 90_000 }, async () => {
  for (const [options, wide] of [[PHONE, false], [{ viewport: { width: 1280, height: 800 } }, true]]) {
    const { context, page } = await seatedWithId(options);
    await page.waitForSelector('.table-cup', { state: 'attached' });
    const room = await page.evaluate(() => {
      const scene = document.getElementById('scene');
      const wrap = scene.parentElement;
      const s = getComputedStyle(scene);
      const r = scene.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return { bg: s.backgroundImage, ratio: r.width / r.height, shown: w.height / r.height, wrapW: w.width, sceneW: r.width, after: getComputedStyle(wrap, '::after').content, cups: document.querySelectorAll('.table-cup').length };
    });
    assert.match(room.bg, /table-room-1152\.webp/);
    assert.ok(Math.abs(room.ratio - 1152 / 1728) < 0.01, `kept at 2:3, never stretched: ${room.ratio}`);
    assert.ok(room.after === 'none' || room.after === 'normal', `nothing laid over the art: ${room.after}`);
    assert.ok(Math.abs(room.wrapW - room.sceneW) < 1.5, 'the frame is the picture');
    assert.equal(room.cups, 4, 'a cup on the table for each seat dealt in');
    if (wide) {
      assert.ok(room.shown < 0.75, `a laptop crops to the lamp, window and table: ${room.shown}`);
      const inView = await page.evaluate(() => ['#felt-bid', '#bid-confirm', '.cup-box'].map((sel) => document.querySelector(sel).getBoundingClientRect().bottom <= window.innerHeight));
      assert.deepEqual(inView, [true, true, true], 'the bid board, Bid and your cup in view without a scroll');
    } else {
      assert.ok(room.shown > 0.35 && room.shown < 0.45, `a phone shows the band of the table, rows 690 to 1380: ${room.shown}`);
      assert.ok(await page.$eval('.cup-box', (el) => el.getBoundingClientRect().top < document.getElementById('scene').getBoundingClientRect().top), 'your cup comes before the room on a phone');
      assert.ok(await noSideScroll(page));
    }
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

test('after a call: one plain line on what decided it, and each shown cup\'s dice big enough to count on a phone', { timeout: 90_000 }, async () => {
  const { context, page, id } = await seatedWithId(PHONE);
  await playToTheCall(page);
  const state = await (await fetch(`${BASE}/dice-tables/${id}`)).json();
  const d = state.lastDuel;
  const line = await page.textContent('#reveal-line');
  assert.match(line, /^[A-Z][a-z]+ \d+s? needed, ([a-z]+|\d+) showing: bid (holds|falls)$/);
  assert.match(line, new RegExp(` ${d.bid.face}s? needed, .* showing: bid ${d.held ? 'holds' : 'falls'}$`));
  const shown = d.reveals.filter((r) => r.mode === 'show');
  assert.ok(shown.length >= 1, 'I showed mine');
  for (const r of shown) {
    const dice = await page.$$eval(`[data-reveal-seat="${r.seat}"] .reveal-dice .die`, (els) => els.map((el) => ({ face: Number(el.style.getPropertyValue('--face')), w: el.getBoundingClientRect().width, hit: el.classList.contains('hit') })));
    assert.deepEqual(dice.map((x) => x.face), r.dice);
    assert.ok(dice.every((x) => x.w >= 32), `big enough to count: ${dice.map((x) => x.w)}`);
    assert.deepEqual(dice.map((x) => x.hit), r.dice.map((f) => f === d.bid.face || f === 1), 'the dice that count are lit');
  }
  for (const r of d.reveals.filter((x) => x.mode !== 'show')) assert.match(await page.textContent(`[data-reveal-seat="${r.seat}"]`), new RegExp(`cup shut: ${r.count} `));
  assert.ok(await noSideScroll(page));
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('No Player ID on your badge or the page, and the first win says where to copy it', { timeout: 90_000 }, async () => {
  const { context, page, player, id } = await seatedWithId({ viewport: { width: 1280, height: 800 } });
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  page.on('console', (m) => seen.push(m.text()));
  await page.waitForSelector('.cup-card.mine');
  await page.waitForTimeout(300);
  assert.equal(await page.$('.player-id, .pid-short, .pid-copy'), null, 'no Player ID element');
  assert.ok(!(await page.innerText('body')).includes(player.token.slice(0, 6)), 'not even its first characters');
  assert.equal(await page.textContent('.built-on'), 'Built on the Midnight Network');
  await playToTheCall(page);
  await page.waitForSelector('#after-round:not([hidden])');
  const net = Number((await page.textContent('#ar-net')).replace('−', '-'));
  const told = await page.evaluate(() => localStorage.getItem('hall.firstWin'));
  if (net > 0) {
    assert.equal(await page.textContent('#ar-first-win'), 'Your chips live in this browser. To keep them on another device, copy your Player ID from the Player ID button in the Hall.');
    assert.equal(told, `cup-and-claim:${id}#1`);
  } else {
    assert.equal(await page.$('#ar-first-win'), null, 'only on a win');
    assert.equal(told, null);
  }
  const secret = player.token.split('.')[1];
  assert.ok(!(await page.content()).includes(secret), 'never on the page');
  assert.ok(!seen.some((text) => text.includes(secret)), 'never in an address or a log');
  assert.deepEqual(page.errors, []);
  await context.close();
});

// ---------- round 3 (The owner, 11-06): the seats as in Sealed Hand, his Grok cups, the sharp dice, the symbol on the tapestry ----------

/** Where each figure, cup and badge is, and what it's drawn with. */
const tableNow = (page) => page.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, bottom: r.bottom, right: r.right }; };
  const wrap = document.querySelector('.dice-scene-wrap').getBoundingClientRect();
  const mark = document.querySelector('.tapestry-mark');
  return {
    badges: [...document.querySelectorAll('#cups .cup-card')].map((el) => ({ seat: Number(el.dataset.cup), open: el.classList.contains('open'), first: el.firstElementChild.className, faceArea: el.querySelector(':scope > .face') ? getComputedStyle(el.querySelector(':scope > .face')).gridArea.split(' ')[0] : null, face: el.querySelector(':scope > .face') ? box(el.querySelector(':scope > .face')) : null, card: box(el), mine: el.classList.contains('mine'), pid: el.querySelector('.player-id') ? box(el.querySelector('.player-id')) : null, text: el.textContent.trim() })),
    figures: [...document.querySelectorAll('.table-figure')].map((el) => ({ seat: Number(el.dataset.figure), bg: el.style.backgroundImage, clip: el.style.clipPath, z: Number(getComputedStyle(el).zIndex), ...box(el) })),
    cups: [...document.querySelectorAll('.table-cup')].map((el) => ({ seat: Number(el.dataset.tableCup), lifted: el.classList.contains('lifted'), art: getComputedStyle(el.querySelector('.cup-art')).backgroundImage, z: Number(getComputedStyle(el).zIndex), ...box(el) })),
    seats: [...document.querySelectorAll('#cups .cup-card')].map((el) => el.querySelector('.name')?.textContent),
    mark: mark ? { shown: getComputedStyle(mark).display !== 'none', opacity: Number(getComputedStyle(mark).opacity), src: mark.dataset.src, ...box(mark), wrapTop: wrap.top, wrapBottom: wrap.bottom, wrapLeft: wrap.left, sceneW: document.getElementById('scene').getBoundingClientRect().width } : null,
    dieBg: getComputedStyle(document.querySelector('.die')).backgroundImage,
  };
});

/** The alpha at a corner and in the middle of an image, drawn on a canvas: a clean cut-out is clear at the corner. */
const alphaOf = (page, src) => page.evaluate(async (url) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const at = (x, y) => g.getImageData(x, y, 1, 1).data[3];
  return { corner: at(2, 2), middle: at(c.width >> 1, c.height >> 1), w: c.width, h: c.height };
}, src);

for (const [label, options] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', PHONE]]) {
  test(`${label}: every seat has a face tile on its badge, as in Sealed Hand, and the others stand at the table behind their cups, in seat order`, { timeout: 90_000 }, async () => {
    const { context, page } = await seatedWithId(options);
    await page.waitForSelector('.table-figure', { state: 'attached' });
    await page.waitForTimeout(400);
    const t = await tableNow(page);
    // the badges: one per seat, each led by its face tile in the face column, as Sealed Hand's seat plates are
    assert.equal(t.badges.length, 4);
    for (const b of t.badges) {
      assert.match(b.first, /\bface\b/, `seat ${b.seat}: the face tile comes first`);
      assert.equal(b.faceArea, 'face', `seat ${b.seat}: in the face column`);
      assert.ok(b.face.w >= 28 && b.face.w <= 36, `seat ${b.seat}: a face tile Sealed Hand's size: ${b.face.w}`);
    }
    // your badge carries no Player ID (it works like a password; screenshots get posted)
    const mine = t.badges.find((b) => b.mine);
    assert.ok(!mine.pid, 'no Player ID on your badge');
    // the characters: every seat but yours, standing behind the far rim (clipped along it), drawn under the cups
    assert.deepEqual(t.figures.map((f) => f.seat).sort(), [1, 2, 3], 'the other three, not you');
    for (const f of t.figures) {
      assert.match(f.clip, /^polygon\(/, `seat ${f.seat}: the table hides them from the waist down`);
      assert.ok(f.z < t.cups[0].z, 'behind the cups');
    }
    assert.match(t.figures.find((f) => f.seat === 1).bg, /seat-tally\.png/, 'Tally is Tally');
    assert.match(t.figures.find((f) => f.seat === 2).bg, /seat-brannock\.png/);
    assert.match(t.figures.find((f) => f.seat === 3).bg, /seat-oldwick\.png/);
    // seat order from your left: seats 1, 2, 3 left to right, each with its cup in front of it (below, and near its x)
    const order = [...t.figures].sort((a, b) => a.cx - b.cx).map((f) => f.seat);
    assert.deepEqual(order, [1, 2, 3], 'in seat order round from your left');
    for (const f of t.figures) {
      const cup = t.cups.find((c) => c.seat === f.seat);
      assert.ok(cup.y > f.y + f.h * 0.4, `seat ${f.seat}: its cup is on the table in front of it`);
      assert.ok(Math.abs(cup.x - f.cx) < f.w * 1.2, `seat ${f.seat}: its cup is in front of it, not across the table`);
    }
    // yours at the front, nearest you
    const yours = t.cups.find((c) => c.seat === 0);
    assert.ok(t.cups.every((c) => c.seat === 0 || c.y < yours.y), 'your cup is the nearest');
    assert.deepEqual(page.errors, []);
    await shot(page, `cc-seats-${label}`);
    await context.close();
  });
}

test('watching: every seat stands at the table, none at the front', { timeout: 60_000 }, async () => {
  const id = await newTable({ botDelayMs: [600, 1000] });
  await apiPost(`/dice-tables/${id}/join`, { name: 'Sitter' });
  const { context, page } = await session();
  await page.goto(`${BASE}/dice?id=${id}&watch=1`);
  await page.waitForFunction(() => document.querySelectorAll('.table-figure').length === 4, null, { timeout: 20_000 });
  const t = await tableNow(page);
  assert.deepEqual([...t.figures].sort((a, b) => a.cx - b.cx).map((f) => f.seat), [0, 1, 2, 3]);
  assert.equal(t.badges.length, 4);
  await context.close();
});

test('the cups are the owner\'s Grok cups, cut out clean; the dice are the sharp faces everywhere; the symbol is whole on the tapestry', { timeout: 90_000 }, async () => {
  for (const [options, wide] of [[PHONE, false], [{ viewport: { width: 1280, height: 800 } }, 'cropped'], [{ viewport: { width: 1280, height: 1500 } }, true]]) { // 11-10: a wide window too short for the whole picture fills the column with a crop that starts below the wall: no symbol there
    const { context, page } = await seatedWithId(options);
    await page.waitForSelector('.table-cup', { state: 'attached' });
    const t = await tableNow(page);
    for (const c of t.cups) assert.match(c.art, c.lifted ? /cup-up-s\.webp/ : /cup-down-s\.webp/, `seat ${c.seat}: ${c.lifted ? 'stood up' : 'turned down'} (the small sharpened copy, round 3)`);
    assert.ok(t.cups.find((c) => c.seat === 0).lifted, 'yours is stood up beside your dice, for you');
    assert.ok(t.cups.filter((c) => c.seat !== 0).every((c) => !c.lifted), 'the others are shut');
    assert.match(await page.$eval('#cup-sprite', (el) => getComputedStyle(el).backgroundImage), /cup-down\.webp/, 'your cup panel: the same cup');
    for (const file of ['cup-down', 'cup-up', 'cup-down-s', 'cup-up-s']) {
      const a = await alphaOf(page, `/art/dice/${file}.webp`);
      assert.equal(a.corner, 0, `${file}: the black background is cut away`);
      assert.equal(a.middle, 255, `${file}: the cup itself is solid`);
    }
    // the dice: one face strip everywhere it's drawn (your cup, the picker, the table)
    const strips = await page.$$eval('.die', (els) => [...new Set(els.map((el) => getComputedStyle(el).backgroundImage.replace(/.*\/art\//, '/art/').replace(/["')]/g, '')))]);
    assert.deepEqual(strips, ['/art/dice/dice.svg']);
    // the symbol: the brand file, on the wood wall beside the tapestry (round 2), 120 px of the picture's 1152, lower opacity, wholly inside the frame
    const m = t.mark;
    assert.equal(m.src, '/brand/midnight/Midnight-RGB_Symbol-White.svg');
    if (wide !== true) { // the phone's band (Phase A, 11-07) and a cropped wide frame start under the symbol: never a cut symbol, so none
      assert.ok(!m.shown, 'the band cuts the wall above, so the symbol is not drawn');
      assert.deepEqual(page.errors, []);
      await context.close();
      continue;
    }
    assert.ok(m.shown, 'shown: the frame holds it whole');
    assert.ok(Math.abs(m.w / m.sceneW - 120 / 1152) < 0.005 && Math.abs(m.w - m.h) < 1, `120 of 1152, square: ${m.w}`);
    assert.ok(m.x - m.wrapLeft > (m.sceneW * 270) / 1152 - 2, `off the tapestry, on the wall to its right: left edge ${m.x - m.wrapLeft} of ${m.sceneW}`);
    assert.ok(m.opacity > 0.2 && m.opacity < 0.6, `lower opacity: ${m.opacity}`);
    assert.ok(m.y >= m.wrapTop && m.bottom <= m.wrapBottom && m.x >= m.wrapLeft, `never clipped: ${JSON.stringify(m)}`);
    if (wide) assert.ok(m.y - m.wrapTop > 20, 'on a laptop, with wall above it in the frame');
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

// ---------- round 3 (11-07): Tally's first-sit guide, the action on the cards, sharper dice ----------

const GUIDE_TEXT = "Everyone rolls in secret. Take turns claiming how many of a face are on the whole table (ones are wild). Anyone can call the last claim a lie. Whoever's wrong pays.";

test('Tally\'s guide: the first sit shows the card once, word for word, after the deal went ahead; Got it remembers; ? reopens it; How to play opens the rules; a watcher never sees it', { timeout: 90_000 }, async () => {
  const { context, page, id } = await seatedWithId(PHONE);
  await page.waitForSelector('#dice-guide:not([hidden])', { timeout: 10_000 });
  assert.equal(await page.textContent('#guide-title'), "Liar's Dice, with a twist");
  assert.equal(await page.textContent('#guide-line'), GUIDE_TEXT);
  assert.equal(await page.textContent('#guide-ok'), 'Got it');
  assert.equal(await page.textContent('#guide-rules'), 'How to play');
  assert.equal((await page.$$('.my-dice.shown .die')).length, 5, 'the deal never waited for the card');
  assert.ok(await page.$eval('#dice-guide .portrait', (el) => /seat-tally|portrait-doorman/.test(getComputedStyle(el).backgroundImage)), 'Tally speaks it');
  assert.ok(await noSideScroll(page));
  await shot(page, 'r3-guide-phone');
  await page.click('#guide-ok');
  assert.ok(await page.$eval('#dice-guide', (el) => el.hidden));
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.dice.guided')), '1');
  await page.reload();
  await page.waitForSelector('.my-dice.shown .die, .my-dice.sealed .die', { timeout: 15_000 });
  await page.waitForTimeout(2000);
  assert.ok(await page.$eval('#dice-guide', (el) => el.hidden).catch(() => true), 'once per browser');
  await page.click('#guide-open');
  await page.waitForSelector('#dice-guide:not([hidden])');
  await page.click('#guide-rules');
  assert.ok(await page.$eval('#dice-guide', (el) => el.hidden));
  assert.ok(await page.$eval('#rules', (el) => el.open), 'How to play opens the full rules');
  assert.equal(await page.textContent('#guide-again'), 'Tally’s walkthrough, in short');
  await page.click('#guide-again'); // and How to play reopens Tally's card (11-08, both tables)
  await page.waitForSelector('#dice-guide:not([hidden])');
  await page.click('#guide-ok');
  // a watcher is never shown it
  const watcher = await session(PHONE);
  await watcher.page.goto(`${BASE}/dice?id=${id}&watch=1`);
  await watcher.page.waitForSelector('#cups .cup-card', { timeout: 15_000 });
  await watcher.page.waitForTimeout(2500);
  assert.equal(await watcher.page.$('#dice-guide:not([hidden])'), null);
  assert.deepEqual(page.errors, []);
  await watcher.context.close();
  await context.close();
});

test('Tally\'s guide: when storage is blocked it shows anyway, and nothing breaks', { timeout: 60_000 }, async () => {
  const id = await newTable({ botDelayMs: [600, 1000] });
  const { context, page } = await session(PHONE);
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForSelector('#join-box:not([hidden])');
  await page.fill('#join-name', 'NoStore');
  await page.click('#join-submit');
  await page.waitForSelector('.my-dice.shown .die', { timeout: 15_000 });
  await page.waitForSelector('#dice-guide:not([hidden])', { timeout: 10_000 });
  await page.click('#guide-ok');
  assert.ok(await page.$eval('#dice-guide', (el) => el.hidden));
  assert.deepEqual(page.errors, []);
  await context.close();
});

/** The card of the seat whose turn it is, and what its note says. */
const turnNotes = (page) => page.$$eval('#cups .cup-card', (els) => els.map((e) => ({ seat: e.dataset.cup, turn: e.classList.contains('turn'), mine: e.classList.contains('mine'), note: e.querySelector('.turn-note')?.textContent ?? '', yours: !!e.querySelector('.turn-note.yours') })));

test('the action on the cards: YOUR TURN in gold on yours, thinking… on theirs with the glow breathing, a claim pops on the claimer\'s card and settles into the chip, Lie! flashes on the caller\'s, the count puts Wrong and the cost on the loser\'s', { timeout: 120_000 }, async () => {
  const id = await newTable({ botDelayMs: [1800, 2600] });
  const { context, page } = await session({ viewport: { width: 720, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForSelector('#join-box:not([hidden])');
  await page.fill('#join-name', 'Probe');
  await page.click('#join-submit');
  await page.waitForSelector('.my-dice.shown .die', { timeout: 15_000 });
  await page.click('#guide-ok').catch(() => {});
  // whose turn: the note on the card, and the pulse on it
  await page.waitForSelector('#cups .cup-card.turn', { timeout: 15_000 });
  let notes = await turnNotes(page);
  const turn = notes.find((n) => n.turn);
  assert.ok(turn, 'one card has the turn');
  if (turn.mine) { assert.equal(turn.note, 'Your turn'); assert.ok(turn.yours, 'in gold'); } else assert.equal(turn.note, 'thinking…');
  assert.notEqual(await page.$eval('#cups .cup-card.turn', (el) => getComputedStyle(el).animationName), 'none', 'the glow breathes');
  assert.ok(notes.filter((n) => !n.turn).every((n) => n.note === ''), 'only the turn card has a note');
  await shot(page, 'r3-turn-720');
  // your turn comes: the gold note, then your claim pops in large on your card, then settles into the last-bid chip
  await page.waitForSelector('#cups .cup-card.mine.turn', { timeout: 30_000 });
  notes = await turnNotes(page);
  assert.equal(notes.find((n) => n.mine).note, 'Your turn');
  assert.ok(notes.find((n) => n.mine).yours);
  await shot(page, 'r3-your-turn-720');
  await page.waitForSelector('#bid-confirm', { timeout: 10_000 });
  await page.click('#bid-confirm');
  const pop = await page.waitForSelector('#cups .cup-card.mine .claim-pop', { timeout: 6000 });
  const popText = (await pop.textContent()).trim();
  assert.match(popText, /^\d+ ×$/, `the claim, large: "${popText}" and the face`);
  assert.ok(await pop.$('.die'), 'with the face as a die');
  await shot(page, 'r3-claim-pop-720');
  await page.waitForFunction(() => !document.querySelector('#cups .cup-card.mine .claim-pop'), null, { timeout: 4000 });
  assert.match(await page.textContent('#cups .cup-card.mine .last-bid'), /^\d+×/, 'settled into the chip');
  // the call: Lie! on the caller's card; then the count: Wrong and the cost on the loser's card, a share on the others
  let lieSeen = null;
  let verdicts = null;
  for (let i = 0; i < 400 && !verdicts; i++) {
    if (!lieSeen) { const lie = await page.$('#cups .cup-card .lie-pop'); if (lie) { lieSeen = await page.$eval('#cups .cup-card:has(.lie-pop)', (el) => ({ seat: el.dataset.cup, text: el.querySelector('.lie-pop').textContent, caller: el.classList.contains('caller') })); await shot(page, 'r3-lie-720'); } }
    const v = await page.$$eval('#cups .card-verdict', (els) => els.map((e) => ({ seat: e.closest('.cup-card').dataset.cup, wrong: e.classList.contains('wrong'), word: e.querySelector('b').textContent, delta: e.querySelector('.delta').textContent })));
    if (v.length) { verdicts = v; await shot(page, 'r3-verdict-720'); break; }
    if (await page.$('#choose-show')) await page.click('#choose-show').catch(() => {});
    else if (await page.$('#liar')) await page.click('#liar').catch(() => {});
    else if (await page.$('#bid-confirm')) await page.click('#bid-confirm').catch(() => {});
    await page.waitForTimeout(200);
  }
  assert.ok(lieSeen, 'Lie! flashed on a card');
  assert.equal(lieSeen.text, 'Lie!');
  assert.ok(lieSeen.caller, 'on the caller\'s card');
  assert.ok(verdicts, 'the verdicts came');
  const wrong = verdicts.find((v) => v.wrong);
  assert.ok(wrong, 'the loser\'s card says so');
  assert.match(wrong.word, /^Wrong/);
  assert.match(wrong.delta, /^−\d+$/, `what it cost: ${wrong.delta}`);
  for (const v of verdicts.filter((x) => !x.wrong)) assert.match(v.delta, /^\+\d+$/);
  await page.waitForFunction(() => !document.querySelector('#cups .card-verdict'), null, { timeout: 5000 });
  assert.ok(await page.$('#reveal:not([hidden])'), 'the full result stays in the panel');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('reduced motion: the turn note changes, nothing pulses or pops', { timeout: 60_000 }, async () => {
  const id = await newTable({ botDelayMs: [1800, 2600] });
  const { context, page } = await session(PHONE);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}/dice?id=${id}`);
  await page.waitForSelector('#join-box:not([hidden])');
  await page.fill('#join-name', 'Still');
  await page.click('#join-submit');
  await page.waitForSelector('.my-dice.shown .die', { timeout: 15_000 });
  await page.click('#guide-ok').catch(() => {});
  await page.waitForSelector('#cups .cup-card.turn', { timeout: 15_000 });
  assert.equal(await page.$eval('#cups .cup-card.turn', (el) => getComputedStyle(el).animationName), 'none');
  await page.waitForSelector('#cups .cup-card.mine.turn', { timeout: 30_000 });
  assert.equal((await turnNotes(page)).find((n) => n.mine).note, 'Your turn');
  await page.waitForSelector('#bid-confirm', { timeout: 10_000 });
  await page.click('#bid-confirm');
  await page.waitForFunction(() => /^\d+×/.test(document.querySelector('#cups .cup-card.mine .last-bid')?.textContent ?? ''), null, { timeout: 8000 });
  assert.equal(await page.$('#cups .claim-pop'), null, 'no pop');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('sharper dice: the redrawn vector faces everywhere, every die and cup drawn at whole pixels, the pips dark on ivory; wilds counted in words, never null', { timeout: 90_000 }, async () => {
  const svg = await (await fetch(`${BASE}/art/dice/dice.svg`)).text();
  assert.match(svg, /id="bevel"/, 'the round-3 faces: a bevel of light');
  assert.match(svg, /rx="15"/, 'squarer than before, not boxy');
  for (const options of [PHONE, { viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true }, { viewport: { width: 720, height: 1000 } }]) {
    const { context, page } = await seatedWithId(options);
    await page.click('#guide-ok').catch(() => {});
    await page.waitForSelector('.table-cup', { state: 'attached' });
    await page.waitForTimeout(400);
    // the laid-out size (a lifted cup sits rotated, so its bounding box is no measure of the pixels it's drawn at)
    const sizes = await page.$$eval('.die, .table-cup .cup-art, #cup-sprite', (els) => els.map((el) => ({ what: el.className.split(' ')[0] || el.id, w: parseFloat(getComputedStyle(el).width), h: parseFloat(getComputedStyle(el).height) })));
    assert.ok(sizes.length > 10, 'dice and cups on the page');
    for (const z of sizes) assert.ok(Math.abs(z.w - Math.round(z.w)) < 0.02 && Math.abs(z.h - Math.round(z.h)) < 0.02, `${z.what} at ${options.viewport.width}: ${z.w} x ${z.h} is a whole size`);
    const strips = await page.$$eval('.die', (els) => [...new Set(els.map((el) => getComputedStyle(el).backgroundImage.replace(/.*\/art\//, '/art/').replace(/["')]/g, '')))]);
    assert.deepEqual(strips, ['/art/dice/dice.svg']);
    const smallest = Math.min(...(await page.$$eval('.my-dice .die', (els) => els.map((el) => el.getBoundingClientRect().width))));
    assert.ok(smallest >= 36, `your dice are at least 36 px on a phone: ${smallest}`);
    const counts = await page.textContent('#counts');
    assert.doesNotMatch(counts, /null/i);
    assert.match(counts, /^You hold, with wilds: .*(\d wilds?)?$/);
    if (/wild$|wilds$/.test(counts)) assert.match(counts, /(1 wild|[2-5] wilds)$/, `the wilds in words: "${counts}"`);
    if (options === PHONE) await shot(page, 'r3-dice-phone');
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});

// ---------- 11-08: first-hand clarity, the same pass as Sealed Hand's ----------

test('first-hand clarity at Cup & Claim: Bid, Call liar and Fold each carry a line under them in plain words; a greyed move says all of it and why not now; what you owe reads "to stay in", never "match"', { timeout: 90_000 }, async () => {
  for (const [options, where] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const { context, page } = await seatedWithId(options);
    await page.click('#guide-ok').catch(() => {});
    await page.waitForSelector('#move-row .move-cell');
    const cells = await page.$$eval('#move-row .move-cell', (els) => els.map((c) => [c.dataset.cell, c.querySelector('.move-what')?.textContent]));
    assert.deepEqual(cells, [['bid', 'Guess a count across all cups'], ['liar', 'Say the last bid is too high'], ['fold', 'Sit the round out']]);
    const sizes = await page.$$eval('#move-row .move-what', (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    assert.ok(Math.min(...sizes) >= 12, `readable: ${Math.min(...sizes)}px`);
    await page.waitForFunction(() => { const b = document.querySelector('#move-row .move-cell[data-cell="liar"] button'); return b && !b.disabled; }, null, { timeout: 10_000 }).catch(() => {});
    const liar = await page.$('#move-row .move-cell[data-cell="liar"] button.ghost:not([disabled])');
    if (liar) { // no bid yet, or not my turn: a tap says what it does and why not now
      await liar.evaluate((el) => el.click()); // the row may be locked for a moment while a bot's move lands
      assert.match(await page.textContent('#move-reason'), /^Call liar: say the last bid is too high\. Every cup is counted, and whoever’s wrong pays\. Not now: /);
    }
    assert.doesNotMatch(await page.textContent('#move-row'), /\bmatch\b/i);
    assert.ok(await noSideScroll(page), `${where}: no sideways scroll`);
    await shot(page, `first-bid-${where}`);
    assert.deepEqual(page.errors, []);
    await context.close();
  }
});
