import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOPUP_EVERY_MS, topUpCheck } from '../src/platform/chips.js';
import { homeRedirect } from '../src/platform/http.js';
import { SEAT_SAY_LIMIT, SEAT_SAY_WINDOW_MS, seatMaySay } from '../src/platform/limits.js';
import { SUPPORT } from '../public/js/support.js';

const file = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('redirect: the old address goes home with a 301, keeping path and query', () => {
  const res = homeRedirect('https://sealedhand.halfhand.dev/table?id=abc&watch=1');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://halfhand.app/table?id=abc&watch=1');
  assert.equal(homeRedirect('https://sealedhand.halfhand.dev/').headers.get('location'), 'https://halfhand.app/');
  for (const url of ['https://halfhand.app/', 'http://127.0.0.1:8799/', 'https://other.halfhand.dev/']) assert.equal(homeRedirect(url), null, url);
});

test('configs: AI and routes are in the deploy config only, so local runs can\'t reach Cloudflare', () => {
  const prod = file('wrangler.toml');
  const dev = file('wrangler.dev.toml');
  assert.match(prod, /^\[ai\]\nbinding = "AI"/m);
  assert.match(prod, /pattern = "halfhand\.app", custom_domain = true/);
  assert.match(prod, /pattern = "sealedhand\.halfhand\.dev", custom_domain = true/);
  assert.ok(!/^\[ai\]/m.test(dev), 'no [ai] in the dev config');
  assert.ok(!/^routes/m.test(dev), 'no routes in the dev config');
  assert.ok(!/account_id/.test(prod + dev), 'no account id in either');
  assert.ok(!/ALLOW_TEST_CONFIG/.test(prod + dev), 'the test flag is off by leaving it out');

  // Apart from those, the two must not drift. Live serves the built asset directory (public/ plus the cage page's contract code);
  // dev serves public/ as it is.
  const body = (text) => text.slice(text.indexOf('[assets]')).replace(/^#.*\n/gm, '').replace('directory = "./.preview-dist"', 'directory = "./public"');
  // One difference on purpose (live L1, 11-10): the seal-anchor queue stays out of live. The seal anchor refuses live hosts, the queue is
  // inert without ANCHOR_MODE, and its Durable Object migration (v5) would block a `wrangler rollback` of live.
  const noAnchorQueue = (text) => text.replace(/# The seal-anchor queue[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "ANCHOR_QUEUE"\nclass_name = "AnchorQueue"\n/, '').replace(/\[\[migrations\]\]\ntag = "v5"\nnew_sqlite_classes = \["AnchorQueue"\]\n/, '');
  assert.ok(!/ANCHOR_QUEUE|AnchorQueue/.test(prod), 'no anchor queue on live');
  assert.equal(body(prod).replace(/\n{3,}/g, '\n\n'), body(noAnchorQueue(dev)).replace(/\n{3,}/g, '\n\n'));
  assert.match(prod, /^directory = "\.\/\.preview-dist"$/m, 'live deploys the built directory, with the cage page\'s contract code in it');
  for (const name of ['LIMIT_PLAYERS', 'LIMIT_TABLES', 'LIMIT_JOIN', 'LIMIT_SAY']) assert.ok(prod.includes(`name = "${name}"`), name);

  const scripts = JSON.parse(file('package.json')).scripts;
  assert.match(scripts.dev, /--config wrangler\.dev\.toml/);
  assert.ok(!Object.values(scripts).some((s) => /\bdeploy\b/.test(s)), 'no npm script deploys');
  assert.match(file('test/server.js'), /'--config', 'wrangler\.dev\.toml'/);
});

test('per-seat say limit', () => {
  const times = {};
  for (let i = 0; i < SEAT_SAY_LIMIT; i++) assert.equal(seatMaySay(times, 0, 1000), true);
  assert.equal(seatMaySay(times, 0, 1000), false);
  assert.equal(seatMaySay(times, 1, 1000), true, 'another seat is separate');
  assert.equal(seatMaySay(times, 0, 1000 + SEAT_SAY_WINDOW_MS), true, 'and the window clears');
});

test('top-up rules: under 100, nothing at a table, once per 24 h', () => {
  const now = 1_000_000_000;
  assert.deepEqual(topUpCheck({ chips: 0, holds: {} }, now), { ok: true });
  assert.deepEqual(topUpCheck({ chips: 99, holds: {} }, now), { ok: true });
  assert.equal(topUpCheck({ chips: 100, holds: {} }, now).code, 'not_broke');
  assert.equal(topUpCheck({ chips: 0, holds: { 'sealed-hand:x': 100 } }, now).code, 'chips_in_play');
  assert.equal(topUpCheck({ chips: 0, holds: {}, lastTopUp: now - TOPUP_EVERY_MS + 1 }, now).code, 'topup_used');
  assert.deepEqual(topUpCheck({ chips: 0, holds: {}, lastTopUp: now - TOPUP_EVERY_MS }, now), { ok: true });
});

test('support: exactly the two Counter page entries, no Bitcoin', () => {
  assert.deepEqual(SUPPORT.map((s) => s.label), ['NIGHT or ADA (Cardano)', 'Private, on Midnight (shielded)']);
  assert.ok(SUPPORT.every((s) => s.address.length > 40), 'both filled');
  assert.ok(!/bitcoin|btc/i.test(file('public/js/support.js')));
  // Compared as true/false only, so a failure never prints an address.
  const counter = join(process.env.WORKSPACE ?? '..', 'halfhand-site/public/counter.html');
  if (existsSync(counter)) {
    const html = readFileSync(counter, 'utf8');
    for (const { label, address } of SUPPORT) {
      const same = html.includes(`<span class="label">${label}</span><div class="code"><code>${address}</code>`); // the Counter page's markup since its 11-08 revamp
      assert.equal(same, true, `${label} matches the Counter page`);
    }
  }
});

test('radio: an https address only; the page policy allows its host and nothing else', async () => {
  const { radioConfig, withPageHeaders, withSvgHeaders } = await import('../src/platform/http.js');
  assert.equal(radioConfig({}), null);
  assert.equal(radioConfig({ RADIO_URL: '' }), null);
  assert.equal(radioConfig({ RADIO_URL: 'http://radio.test/a' }), null, 'no plain http');
  assert.equal(radioConfig({ RADIO_URL: 'not a url' }), null);
  const radio = radioConfig({ RADIO_URL: 'https://radio.test/a.mp3', RADIO_CREDIT: 'Thanks' });
  assert.deepEqual(radio, { url: 'https://radio.test/a.mp3', origin: 'https://radio.test', credit: 'Thanks', link: 'https://midnightradio.cloud/' });
  assert.deepEqual(radioConfig({ RADIO_URL: 'https://stream.midnightradio.cloud/live' }), { url: 'https://stream.midnightradio.cloud/live', origin: 'https://stream.midnightradio.cloud', credit: 'Midnight Radio by TomJon & dvnc', link: 'https://midnightradio.cloud/' }, 'Midnight Radio\'s credit and link by default');
  assert.equal(radioConfig({ RADIO_URL: 'https://radio.test/a', RADIO_LINK: 'javascript:alert(1)' }).link, 'https://midnightradio.cloud/', 'a credit link is https or the default');
  assert.match(withPageHeaders(new Response('x'), { radio }).headers.get('content-security-policy'), /media-src https:\/\/radio\.test;/);
  assert.ok(!/media-src/.test(withPageHeaders(new Response('x')).headers.get('content-security-policy')));

  // A logo's inline style is allowed, on the logo alone. Pages keep their strict policy.
  assert.match(withSvgHeaders(new Response('x')).headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  assert.ok(!/unsafe-inline/.test(withPageHeaders(new Response('x')).headers.get('content-security-policy')));
});

test('purse grant: one player, by id, once, only ever upward; empty does nothing', async () => {
  const { applyGrant } = await import('../src/platform/chips.js');
  const me = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const fresh = (chips) => ({ name: 'Halfhand', chips, holds: {} });

  for (const setting of ['', undefined, null, 'nonsense', `${me}`, `${me}:`, `${me}:-5`, `${me}:12x`, `${me.slice(1)}:1209`]) {
    const p = fresh(100);
    assert.equal(applyGrant(p, me, setting, 1), false, String(setting));
    assert.deepEqual(p, fresh(100));
  }
  const stranger = fresh(100);
  assert.equal(applyGrant(stranger, other, `${me}:1209`, 1), false, 'the name Halfhand alone earns nothing');
  assert.equal(stranger.chips, 100);

  const p = fresh(100);
  assert.equal(applyGrant(p, me, `${me}:1209`, 1000), true);
  assert.equal(p.chips, 1209);
  assert.deepEqual(p.grants['2026-11-bank-restore'], { at: 1000, from: 100, to: 1209 });
  p.chips = 50;
  assert.equal(applyGrant(p, me, `${me}:1209`, 2000), false, 'once');
  assert.equal(p.chips, 50);

  const rich = fresh(5000);
  assert.equal(applyGrant(rich, me, `${me}:1209`, 1), true);
  assert.equal(rich.chips, 5000, 'never lowers a purse');
});

test('purse grant: ships switched off', () => {
  assert.match(file('wrangler.toml'), /^PURSE_GRANT = ""$/m);
  assert.ok(!/PURSE_GRANT/.test(file('wrangler.dev.toml')));
});

test('the purse seam: one view, the house today, ready to say where a wallet\'s lives', async () => {
  const { PURSE_SOURCE, purseView } = await import('../src/platform/purse.js');
  assert.deepEqual(purseView({ chips: 42 }, 'abc'), { amount: 42, source: PURSE_SOURCE.HOUSE, readOnly: false, owner: { kind: 'player', id: 'abc' } });
  assert.deepEqual(Object.keys(PURSE_SOURCE), ['HOUSE', 'CAGE']);
  const seam = file('src/platform/purse.js');
  assert.match(seam, /Nothing here talks to a wallet or a chain yet/);
  for (const page of ['public/js/room.js', 'public/js/table.js', 'public/js/settings.js']) {
    assert.ok(!/\b(me|them|player|purse)\.chips\b/.test(file(page)), `${page} reads the purse only through purse.amount`);
  }
});

test('the rename: no page or message says bank', () => {
  for (const page of ['public/index.html', 'public/table.html', 'public/recover.html', 'public/js/room.js', 'public/js/table.js', 'public/js/settings.js', 'public/js/recover.js', 'public/css/inn.css', 'src/platform/doorman.js', 'src/index.js', 'src/games/sealed-hand/table.js']) {
    assert.ok(!/bank/i.test(file(page)), page);
  }
});

test('the key: nothing puts a player key in an address', () => {
  for (const page of ['public/js/room.js', 'public/js/settings.js', 'public/js/recover.js']) {
    assert.ok(!/location\.(hash|href|replace)[^;]*(token|key)|#carry/.test(file(page)), page);
  }
});

// ---------- bring your own agent, phase 1 (11-08) ----------

import { KEY_LIMIT, checkKeyLimit, checkIpLimit } from '../src/platform/limits.js';
import { gameOf, lobbyRows, noteOpened, openOptions, pickTable } from '../src/platform/lobby-pick.js';

/** A stand-in for Cloudflare's rate limit binding: counts per key, refuses past `limit`. Remembers the keys it was given. */
function fakeLimit(limit) {
  const counts = new Map();
  return { keys: counts, async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= limit }; } };
}
const req = (path, token, method = 'GET') => new Request(`https://hall${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
const partsOf = (path) => path.split('/').filter(Boolean);

test('per-key limit: every token has its own count, wherever it comes from; the key is a hash, never the token; no token is left to the per-address limits', async () => {
  const LIMIT_KEY = fakeLimit(3);
  const env = { LIMIT_KEY };
  const path = '/dice-tables/abc/me';
  for (let i = 0; i < 3; i++) assert.equal(await checkKeyLimit(req(path, 'seat-token-one'), env, partsOf(path)), null);
  const over = await checkKeyLimit(req(path, 'seat-token-one'), env, partsOf(path));
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, 'key_rate_limited');
  assert.ok(over.headers.get('retry-after'));
  assert.equal(await checkKeyLimit(req(path, 'seat-token-two'), env, partsOf(path)), null, 'another token has its own allowance');
  assert.equal(await checkKeyLimit(req('/tables/abc/act', 'seat-token-two', 'POST'), env, partsOf('/tables/abc/act')), null, 'both games, every route with a token');
  assert.equal(await checkKeyLimit(req(path), env, partsOf(path)), null, 'no token: not this limit');
  assert.equal(await checkKeyLimit(req('/records', 'x'), env, ['records']), null, 'public pages are not keyed');
  for (const key of LIMIT_KEY.keys.keys()) assert.ok(/^[0-9a-f]{24}$/.test(key) && !key.includes('seat-token'), 'the binding sees a hash');
  assert.equal(await checkKeyLimit(req(path, 'seat-token-one'), { ALLOW_TEST_CONFIG: '1', LIMIT_KEY }, partsOf(path)), null, 'off in test runs');
  assert.equal(await checkKeyLimit(req(path, 'seat-token-one'), {}, partsOf(path)), null, 'no binding: no limit');
  assert.equal(KEY_LIMIT.limit, 300);
  const tables = fakeLimit(0);
  assert.equal((await checkIpLimit(req('/lobby/open', null, 'POST'), { LIMIT_TABLES: tables }, ['lobby', 'open'])).status, 429, 'POST /lobby/open counts as making a table');
});

test('lobby: options, game names, rows with each seat as human, agent or house', () => {
  assert.equal(gameOf('dice'), 'cup-and-claim');
  assert.equal(gameOf('Sealed-Hand'), 'sealed-hand');
  assert.equal(gameOf('poker'), null);
  assert.deepEqual(openOptions({ game: 'dice' }), { game: 'cup-and-claim', seats: 4, lobbySeconds: 30 });
  assert.match(openOptions({ game: 'sealed-hand', seats: 6 }).error, /4 seats/);
  assert.match(openOptions({ game: 'cup-and-claim', seats: 7 }).error, /2 to 6/);
  assert.match(openOptions({ game: 'cup-and-claim', lobbySeconds: -1 }).error, /lobbySeconds/);
  assert.match(openOptions({}).error, /game must be/);
  const rows = lobbyRows({ 'cup-and-claim': [{ id: 'd1', n: 3, seats: 4, seatsFilled: 3, phase: 'lobby', joinable: true, round: 0, faces: [{ name: 'Ann', kind: 'human' }, { name: 'Bot9', kind: 'agent' }, { name: 'Tally · house', kind: 'house' }] }], 'sealed-hand': [{ id: 's1', seats: 4, seatsFilled: 1, phase: 'playing', joinable: false, round: 2, faces: [{ name: 'X', kind: 'agent' }] }] });
  assert.equal(rows.length, 2);
  const d = rows.find((r) => r.id === 'd1');
  assert.deepEqual([d.humans, d.agents, d.house], [1, 1, 1]);
  assert.equal(d.watch, '/watch/cup-and-claim/3');
  assert.equal(d.api, '/dice-tables/d1');
  assert.equal(rows.find((r) => r.id === 's1').watch, '/table?id=s1&watch=1', 'a table with no number yet: the page link');
  assert.equal(lobbyRows({ 'sealed-hand': [{ id: 't1', n: 9, table: 178, tnight: true, seats: 4, seatsFilled: 0, phase: 'lobby', faces: [] }] })[0].cageTable, 178, 'a tNIGHT table keeps its cage number');
});

test('lobby/open picks a waiting table with room, holds the seat it hands out so callers at the same moment spread out, and asks for a new table when all are full', () => {
  const opts = { game: 'cup-and-claim', seats: 4 };
  const state = {};
  const t0 = 1_000_000;
  // Nothing listed: open one.
  assert.equal(pickTable(opts, [], state, t0), null);
  noteOpened(opts, 'new1', state, t0); // the opener's own seat is held
  // Three more callers at once: the fresh table, which has not reported yet, takes them.
  for (let i = 0; i < 3; i++) assert.deepEqual(pickTable(opts, [], state, t0 + i), { id: 'new1', created: false });
  assert.equal(pickTable(opts, [], state, t0 + 5), null, 'four held of four: the fifth needs a new table');
  // The table reports with four seated: the holds before the report are in it, and it is full.
  const full = [{ game: 'cup-and-claim', id: 'new1', seats: 4, seatsFilled: 4, phase: 'lobby', joinable: false, updatedAt: t0 + 10 }];
  assert.equal(pickTable(opts, full, state, t0 + 20), null);
  // A listed table with room, reported after the holds: its count is the truth.
  const room = [{ game: 'cup-and-claim', id: 'old', seats: 4, seatsFilled: 1, phase: 'lobby', joinable: true, updatedAt: t0 + 30 }];
  const s2 = {};
  assert.deepEqual(pickTable(opts, room, s2, t0 + 40), { id: 'old', created: false });
  assert.deepEqual(pickTable(opts, room, s2, t0 + 41), { id: 'old', created: false });
  assert.deepEqual(pickTable(opts, room, s2, t0 + 42), { id: 'old', created: false });
  assert.equal(pickTable(opts, room, s2, t0 + 43), null, '1 seated + 3 held');
  // Holds run out (the callers never sat): the seats are offered again.
  assert.deepEqual(pickTable(opts, room, s2, t0 + 60_000), { id: 'old', created: false });
  // Never a tNIGHT table, another game, another size, or one already playing.
  const others = [
    { game: 'cup-and-claim', id: 't', seats: 4, seatsFilled: 1, phase: 'lobby', joinable: true, tnight: true, updatedAt: t0 },
    { game: 'cup-and-claim', id: 'six', seats: 6, seatsFilled: 1, phase: 'lobby', joinable: true, updatedAt: t0 },
    { game: 'cup-and-claim', id: 'live', seats: 4, seatsFilled: 2, phase: 'playing', joinable: false, updatedAt: t0 },
  ];
  assert.equal(pickTable(opts, others, {}, t0), null);
});
