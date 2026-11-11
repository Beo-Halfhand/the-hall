// The wallet page's helpers. No wallet, no network.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  NIGHT_TOKEN, blockfrostUrls, findWallet, fmtDust, fmtNight, hostOf, iconSrc, isPreprodAddress, isPreprodNetwork, isSessionLost, isWalletRestarted, listWallets, namesMainnet, parseKey, parseNight, parseTable, scrub, seatView, withinTime,
  sessionLine,
} from '../public/js/wallet-core.js';
import { isWalletPath, walletPageOn } from '../src/platform/http.js';

test('amounts show in whole units', () => {
  assert.equal(fmtNight(5_000_000_000n), '5,000');
  assert.equal(fmtNight(1_500_000n), '1.5');
  assert.equal(fmtNight(1n), '0.000001');
  assert.equal(fmtDust(2_500_000_000_000_000n), '2.5');
  assert.equal(fmtDust(0n), '0');
  assert.equal(NIGHT_TOKEN.length, 64);
});

test('typed amounts become STAR, and nonsense is refused', () => {
  assert.equal(parseNight('3'), 3_000_000n);
  assert.equal(parseNight(' 0.000001 '), 1n);
  for (const bad of ['', '0', '0.0', '-1', '1e3', '1.0000001', 'abc', '1,000']) assert.equal(parseNight(bad), null, bad);
  assert.equal(parseTable('1'), 1n);
  for (const bad of ['0', '-1', '1.5', 'x', '4294967296']) assert.equal(parseTable(bad), null, bad);
});

test('a player key is 32 bytes of hex', () => {
  assert.equal(parseKey('A'.repeat(64)), 'a'.repeat(64));
  for (const bad of ['', 'a'.repeat(63), 'g'.repeat(64)]) assert.equal(parseKey(bad), null);
});

test('project ids never reach the page', () => {
  const secret = `nightpreprod${'Ab1'.repeat(10)}`;
  const out = scrub(`request to https://midnight-preprod.blockfrost.io/api/v0?project_id=${secret} failed, also ${secret}`);
  assert.ok(!out.includes(secret));
  assert.equal(hostOf(blockfrostUrls(secret).http), 'midnight-preprod.blockfrost.io');
  assert.ok(!hostOf(blockfrostUrls(secret).http).includes(secret));
});

test('only preprod gets through', () => {
  assert.ok(isPreprodAddress('mn_addr_preprod1abc'));
  for (const bad of ['mn_addr1abc', 'mn_addr_preview1abc', 'mn_addr_undeployed1abc', '']) assert.ok(!isPreprodAddress(bad), bad);
  assert.ok(namesMainnet('https://midnight-mainnet.blockfrost.io/api/v0'));
  assert.ok(namesMainnet('https://blockfrost.lw.iog.io/midnight-mainnet/'));
  assert.ok(!namesMainnet('https://midnight-preprod.blockfrost.io/api/v0'));
});

test('every wallet is listed: last used, then 1AM (tested, recommended: 11-08 pass), then Lace, then by name, with anything unusable last', () => {
  const connect = () => {};
  const lace = { rdns: 'io.lace.wallet', name: 'lace', icon: 'data:image/png;base64,AA', apiVersion: '4.0.1', connect };
  const oneAm = { rdns: 'com.midnight.1am', name: '1AM', icon: 'https://1am.example/i.png', apiVersion: '4.0.1', connect };
  const zed = { rdns: 'xyz.zed', name: 'Zed', apiVersion: '4.2.0', connect };
  const old = { rdns: 'xyz.old', name: 'Old', apiVersion: '3.0.0', connect };
  const ids = (list) => list.map((w) => w.id);
  const all = { a: old, b: zed, c: oneAm, d: lace, e: { name: 'not a wallet' }, f: null };
  assert.deepEqual(ids(listWallets(all)), ['com.midnight.1am', 'io.lace.wallet', 'xyz.zed', 'xyz.old']);
  assert.deepEqual(ids(listWallets(all, 'xyz.zed')), ['xyz.zed', 'com.midnight.1am', 'io.lace.wallet', 'xyz.old']);
  assert.deepEqual(ids(listWallets(all, 'xyz.old')), ['com.midnight.1am', 'io.lace.wallet', 'xyz.zed', 'xyz.old'], 'a wallet this page cannot use is never first');
  assert.equal(listWallets(all)[0].name, '1AM');
  assert.equal(listWallets(all).find((w) => w.id === 'xyz.old').compatible, false);
  assert.deepEqual(listWallets(undefined), []);
  assert.equal(findWallet(all, 'com.midnight.1am').api, oneAm);
  assert.equal(findWallet(all, 'gone'), null);
});

test('a wallet is known by rdns, its newest copy wins, and one that throws is left out', () => {
  const stale = { rdns: 'x.y', name: 'Stale', apiVersion: '4.0.0', connect() {} };
  const live = { rdns: 'x.y', name: 'Live', apiVersion: '4.0.0', connect() {} };
  const noRdns = { name: 'Plain', apiVersion: '4.0.0', connect() {} };
  const throwing = { get connect() { throw new Error('no'); } };
  const list = listWallets({ a: stale, b: live, c: noRdns, d: throwing });
  assert.deepEqual(list.map((w) => w.name), ['Live', 'Plain']);
  assert.equal(list[1].id, 'name:Plain');
  assert.equal(listWallets({ a: { connect() {}, name: '', apiVersion: '4.0.0' } })[0].name, 'Unnamed wallet');
});

test('only safe icon addresses are loaded', () => {
  for (const ok of ['data:image/svg+xml;base64,AA', 'https://a.example/i.png', 'chrome-extension://abc/i.png', 'moz-extension://abc/i.png']) assert.equal(iconSrc(ok), ok);
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://a.example/i.png', 'data:,', '', null, undefined]) assert.equal(iconSrc(bad), null, String(bad));
});

test('preprod is preprod in any case, and nothing else is', () => {
  for (const ok of ['preprod', 'PreProd']) assert.ok(isPreprodNetwork(ok), ok);
  for (const bad of ['mainnet', 'preview', 'undeployed', '', null]) assert.ok(!isPreprodNetwork(bad), String(bad));
});

test('a lost session is told apart from a refusal or any other failure', () => {
  for (const lost of [
    { code: 'Disconnected', message: 'x' }, new Error('Wallet UI disconnected'), new Error('Extension context invalidated.'),
    { reason: '1AM connection expired' }, new Error('Could not establish connection. Receiving end does not exist.'), new Error('wallet disconnected, please reconnect'),
  ]) assert.ok(isSessionLost(lost), JSON.stringify(lost?.message ?? lost));
  for (const other of [{ code: 'Rejected', message: 'declined' }, { code: 'PermissionRejected' }, new Error('BalanceCheckOverspend'), new Error('disconnected'), null]) assert.ok(!isSessionLost(other), String(other?.code ?? other?.message ?? other));
});

test('a wallet that never answers is given up on, and one that answers is not', async () => {
  await assert.rejects(withinTime(new Promise(() => {}), 5, 'nope'), (e) => e.noAnswer === true && e.message === 'nope');
  assert.equal(await withinTime(Promise.resolve('yes'), 50, 'nope'), 'yes');
  await assert.rejects(withinTime(Promise.reject(new Error('refused')), 50, 'nope'), (e) => e.message === 'refused' && !e.noAnswer);
});

test('a seat holds only while its table is alive and in the same epoch', () => {
  const seat = { table: 1n, epoch: 2n, atRisk: 2_000_000n, standing: false };
  const table = { epoch: 2n, heartbeat: 1000n, seated: 1n };
  const live = seatView({ seat, table, escapeSecs: 900n, now: 1899 });
  assert.equal(live.seated, true);
  assert.equal(live.freeAt, 1900);
  assert.equal(seatView({ seat, table, escapeSecs: 900n, now: 1900 }).seated, false);
  assert.equal(seatView({ seat, table: { ...table, epoch: 3n }, escapeSecs: 900n, now: 1000 }).seated, false);
  assert.equal(seatView({ seat: null, table, escapeSecs: 900n, now: 1000 }).seated, false);
  assert.match(seatView({ seat: { ...seat, standing: true }, table, escapeSecs: 900n, now: 1000 }).text, /standing/);
});

test('the wallet page is off unless the config turns it on: staging, preview and live (since L2, 11-10) do; dev and tests don’t', () => {
  assert.equal(walletPageOn({}), false);
  assert.equal(walletPageOn({ WALLET_PAGE: 'on' }), true);
  for (const p of ['/wallet', '/js/wallet.js', '/css/wallet.css', '/cage-config.json', '/wallet-app/cage.js']) assert.ok(isWalletPath(p), p);
  for (const p of ['/', '/table', '/js/table.js', '/walletish', '/js/wallet-core.js', '/js/cage-session.js', '/js/buy-in.js', '/css/cage.css']) assert.ok(!isWalletPath(p), `${p}: the table pages import it whether or not the cage is on`);
  const live = readFileSync('wrangler.toml', 'utf8');
  assert.match(live, /^WALLET_PAGE = "on"$/m, 'live has the cage page since L2 (11-10)');
  assert.match(live, /^TNIGHT_TABLES = "on"$/m, 'and tNIGHT tables, served by the two-site judge');
  assert.match(live, /^CAGE_ADDRESS = "3ac04271[0-9a-f]{56}"$/m, 'cage v4b, the same cage as staging');
  assert.match(live, /^CAGE_TABLE_BASE = "2000"$/m, 'live tables numbered apart from staging’s (101-1000) and the judge test’s (1001-1004)');
  assert.match(live, /^INDEXER_UPSTREAM = "https:\/\/midnight-preprod\.blockfrost\.io\/api\/v0"$/m);
  assert.ok(!/^(INDEXER_KEY|JUDGE_TOKEN)\s*=/m.test(live.replace(/^#.*$/gm, '')), 'the secrets are secrets, not vars');
  assert.ok(!readFileSync('wrangler.dev.toml', 'utf8').includes('WALLET_PAGE'));
});

test('the cage page is for the door only: topping up and cashing out. Every way to a seat is the table page, which seats a player in place', () => {
  for (const f of ['public/index.html', 'public/table.html', 'public/js/settings.js']) assert.ok(!/\/wallet\b|wallet\.html/.test(readFileSync(f, 'utf8')), f);
  const room = readFileSync('public/js/room.js', 'utf8');
  const links = room.match(/\/wallet\b[^`'"]*/g);
  assert.equal(links.length, 5, 'the cage hotspot, the tNIGHT greeting’s two (bring, and top up or cash out), the choice on arrival, and the switch from chips');
  assert.ok(links.every((l) => l === '/wallet?door=1'), `the door only: ${links}`);
  assert.match(room, /const bringHref = \(game, id\) => `\$\{game\.page\}\?id=\$\{id\}`/, 'Play for tNIGHT goes to the table page');
  assert.match(room, /href: bringHref\(game, table\.id\)/);
  assert.match(room, /return table \? go\(bringHref\(game, table\.id\)\) : openTnightTable\(game\)/, 'Play for tNIGHT at a game: its table that is seating, or a fresh one');
  assert.match(room, /label: `Cage: \$\{cageWhole\(cageLiveStar\(\)\)\} tNIGHT · Cash out · Top up`/, 'the one cage line (11-07)');
  assert.match(room, /hall\.features\?\.tnight \? go\('\/wallet\?door=1'\)/, 'the cage is only a way in where the server has tNIGHT on');
  assert.match(room, /if \(funded\(\)\) items\.push\(cageItem\(\)\);/, 'and its menu line comes only when the cage holds something');
  assert.match(room, /x\.tnight && x\.joinable && x\.warm\) \?\? game\.tables\.find\(\(x\) => x\.tnight && x\.joinable\)/, 'a warm table first');
  assert.match(room, /tnightOn\(\) \? \[/, 'the sign only offers it where the server has tNIGHT on');
  assert.match(room, /table\.joinable && !mine && table\.tnight \? h\('a'/);
  for (const f of ['public/js/table.js', 'public/js/dice.js']) {
    const page = readFileSync(f, 'utf8');
    assert.equal(page.match(/\/wallet\b[^`'"]*/g), null, `${f}: never bounces a player to the cage page`);
    assert.match(page, /if \(view\.cage\) \{ \/\/ a seat here comes from the cage/);
    assert.match(page, /if \(view\?\.cage\) \{ \/\/ the seat on chain is freed first, right here/);
    assert.match(page, /mountBuyIn\(body, \{\n\s+table: view, tableId, game: GAME/);
  }
});

// ---------- revamp (11-04): buying in, and what a wallet error means ----------

import { DRAIN_TEXT, GRANT_MARGIN_SECS, MAX_GRANT_SECS, NO_PERMIT, PERMIT_SECS, TILES, WHOLE_CHIP, alreadyRevoked, alreadyStanding, approvalsText, buyPlan, cashPlan, describeError, explainTrouble, grantLimitText, handsFor, permitState, permitUntil, resultCard, roughSeconds, roughTime, seatMovedError, sentence, shortTime } from '../public/js/wallet-core.js';
import { MAX_SAMPLES, PAGE_TIMED, addSample, goodTiming, medianOf } from '../src/platform/timings.js';
import { MAX_DOOR_SECS } from '../src/platform/door-limit.js';
import { operationOf } from '../src/platform/indexer.js';

const N = (n) => BigInt(n) * WHOLE_CHIP;

test('the tiles are whole buy-ins, and a hand counts as two antes', () => {
  assert.deepEqual(TILES.map(String), ['25000000', '50000000', '100000000', '250000000']);
  assert.equal(handsFor(N(50), 5), 5);
  assert.equal(handsFor(N(25), 1), 12);
  assert.equal(handsFor(N(3), 5), 0);
  assert.equal(handsFor(N(50), 0), 0);
});

test('a buy-in at a table: the deposit is only what the cage is short, the signature only when there is none, and the judge last', () => {
  const fresh = buyPlan({ amount: N(50), cage: 0n, night: N(5000), ante: 5, potLimit: 500, signed: false, table: 7n });
  assert.deepEqual(fresh.moves.map((m) => m.kind), ['deposit', 'sign', 'judge'], 'the deposit carries the permit, so there is no sit');
  assert.equal(fresh.moves[0].cap, N(50));
  assert.equal(fresh.moves.at(-1).seats, true);
  assert.equal(fresh.deposit, N(50));
  assert.equal(fresh.approvals, 1);
  assert.equal(fresh.signature, true);
  assert.equal(fresh.why, null);
  const topped = buyPlan({ amount: N(100), cage: N(91), night: N(5000), ante: 5, potLimit: 500, signed: true, table: 7n });
  assert.deepEqual(topped.moves.map((m) => [m.kind, m.amount && String(m.amount)]), [['deposit', '9000000'], ['judge', undefined]]);
  assert.equal(topped.moves[0].cap, N(100), 'always a cap: a top-up with an empty permit adds nothing the judge can place');
  assert.equal(topped.approvals, 1);
  assert.equal(topped.signature, false);
  const walletEmpty = buyPlan({ amount: N(50), cage: N(91), night: 0n, ante: 5, potLimit: 500, signed: true, table: 7n });
  assert.deepEqual(walletEmpty.moves.map((m) => m.kind), ['sit', 'judge'], 'no permit and nothing to deposit with: today\'s sit');
  assert.equal(walletEmpty.approvals, 1);
  const good = { good: true, cap: N(100), floor: 0n, until: 9n, room: N(91), why: null };
  const covered = buyPlan({ amount: N(50), cage: N(91), night: N(5), ante: 5, potLimit: 500, signed: true, table: 7n, permit: good });
  assert.deepEqual(covered.moves.map((m) => m.kind), ['judge'], 'a good permit: nothing to approve');
  assert.equal(covered.approvals, 0);
  const over = buyPlan({ amount: N(95), cage: N(100), night: N(5), ante: 5, potLimit: 500, signed: true, table: 7n, permit: good });
  assert.deepEqual(over.moves.map((m) => [m.kind, m.grant ?? false]), [['deposit', true], ['judge', false]], 'more than the permit can place, with the money there: a new grant moving one tNIGHT');
  assert.equal(over.deposit, N(1));
  assert.equal(over.moves[0].cap, N(95));
  const selfSit = buyPlan({ amount: N(50), cage: N(91), night: N(5), ante: 5, potLimit: 500, signed: true, table: 7n, permit: good, selfSit: true });
  assert.deepEqual(selfSit.moves.map((m) => m.kind), ['sit', 'judge'], 'the judge is short of DUST: the player sits for themselves');
  const onChain = buyPlan({ amount: N(50), cage: N(50), ante: 5, signed: false, table: 7n, seated: true });
  assert.deepEqual(onChain.moves.map((m) => m.kind), ['sign', 'judge'], 'a seat already on chain needs only the door');
});

test('cash out: stand only while a seat holds the balance, wait for the judge, then everything goes home', () => {
  const seated = cashPlan({ balance: N(7), seated: true, standing: false });
  assert.deepEqual(seated.moves.map((m) => m.kind), ['stand', 'free', 'withdraw']);
  assert.equal(seated.approvals, 2);
  assert.equal(seated.moves.at(-1).amount, N(7));
  assert.deepEqual(cashPlan({ balance: N(7), seated: true, standing: true }).moves.map((m) => m.kind), ['free', 'withdraw'], 'already standing: no second stand');
  const free = cashPlan({ balance: N(12), seated: false });
  assert.deepEqual(free.moves.map((m) => m.kind), ['withdraw']);
  assert.equal(free.approvals, 1);
  assert.equal(approvalsText(free, 'Lace'), '1 approval in Lace');
  assert.equal(roughTime(roughSeconds(free)), 'under a minute');
  assert.equal(roughTime(roughSeconds(seated)), 'about 2 minutes');
  assert.equal(cashPlan({ balance: 0n }).why, 'Nothing in the cage to cash out.');
});

test('a top-up at the same table frees the seat first, then puts in the difference with a new cap, and the judge seats them: one approval', () => {
  const plan = buyPlan({ amount: N(100), cage: N(7), night: N(5000), ante: 1, potLimit: 500, signed: true, table: 7n, seated: true, topup: true, canLeave: true });
  assert.deepEqual(plan.moves.map((m) => m.kind), ['leave', 'free', 'deposit', 'judge']);
  assert.equal(plan.deposit, N(93));
  assert.equal(plan.moves[2].cap, N(100));
  assert.equal(plan.approvals, 1);
  const noToken = buyPlan({ amount: N(100), cage: N(7), night: N(5000), ante: 1, signed: true, table: 7n, seated: true, topup: true });
  assert.deepEqual(noToken.moves.map((m) => m.kind), ['stand', 'free', 'deposit', 'judge'], 'this browser can\'t reach the seat: a stand does it');
  assert.equal(noToken.approvals, 2);
  assert.deepEqual(buyPlan({ amount: N(100), cage: N(7), night: N(5000), ante: 1, signed: true, table: 7n, seated: true, standing: true, topup: true }).moves.map((m) => m.kind), ['free', 'deposit', 'judge']);
  const good = { good: true, cap: N(100), floor: 0n, until: 9n, room: N(100), why: null };
  assert.deepEqual(buyPlan({ amount: N(50), cage: N(100), night: N(5000), ante: 1, signed: true, table: 7n, seated: true, topup: true, canLeave: true, permit: good }).moves.map((m) => m.kind), ['leave', 'free', 'judge'], 'a leave keeps the permit');
  assert.deepEqual(buyPlan({ amount: N(50), cage: N(100), night: N(5000), ante: 1, signed: true, table: 7n, seated: true, topup: true, permit: good }).moves.map((m) => [m.kind, m.grant ?? false]), [['stand', false], ['free', false], ['deposit', true], ['judge', false]], 'a stand ends it, so the seat after needs a new one');
  assert.deepEqual(buyPlan({ amount: N(5), cage: N(7), ante: 1, signed: true, table: 7n, seated: true, topup: false }).moves.map((m) => m.kind), ['judge'], 'not topping up: the seat on chain is claimed as it is');
});

test('a buy-in at the door puts the whole amount in, once', () => {
  const door = buyPlan({ amount: N(20), cage: N(5), night: N(100), signed: false });
  assert.deepEqual(door.moves.map((m) => [m.kind, m.amount && String(m.amount)]), [['deposit', '20000000'], ['sign', undefined]]);
  assert.equal(door.approvals, 1);
  const again = buyPlan({ amount: N(20), cage: N(25), night: N(80), signed: false, brought: true });
  assert.deepEqual(again.moves.map((m) => m.kind), ['sign'], 'after the deposit landed, a retry signs only');
  assert.deepEqual(buyPlan({ amount: N(20), cage: N(25), night: N(80), signed: true }).moves.map((m) => m.kind), ['deposit'], 'signed in: more money is just a deposit');
  assert.equal(door.moves[0].cap, N(25), 'the door\'s cap is the whole stack, so it can play anywhere');
});

test('no deposit is ever planned while a seat binds', () => {
  assert.match(buyPlan({ amount: N(20), cage: N(5), night: N(100), signed: true, bound: true }).why, /no deposit while a seat holds your balance/, 'at the door');
  assert.match(buyPlan({ amount: N(100), cage: N(50), night: N(100), signed: true, table: 7n, seated: true, bound: true }).why, /no deposit while a seat holds your balance/, 'a tile above the seat, not topping up');
  assert.match(buyPlan({ amount: N(50), cage: N(50), night: N(100), signed: true, table: 8n, bound: true }).why, /no deposit while a seat holds your balance/, 'a new seat with a seat elsewhere and no permit');
  assert.equal(buyPlan({ amount: N(100), cage: N(50), night: N(100), signed: true, table: 7n, seated: true, topup: true, bound: true, canLeave: true }).why, null, 'a top-up frees the seat first');
});

test('the permit: what the judge can place, when it can\'t, and why', () => {
  const p = (over = {}) => ({ judge: 'j', cap: N(100), floor: N(900), until: 2000n, ...over });
  assert.deepEqual(permitState({ permit: null, judge: 'j', balance: N(1) }, 1000), NO_PERMIT);
  assert.equal(permitState({ permit: p(), judge: 'j', balance: N(1000) }, 1000).room, N(100), 'the cap');
  assert.equal(permitState({ permit: p(), judge: 'j', balance: N(950) }, 1000).room, N(50), 'what\'s left above the floor');
  assert.equal(permitState({ permit: p(), judge: 'j', balance: N(800) }, 1000).room, 0n, 'below the floor: nothing');
  assert.equal(permitState({ permit: p(), judge: 'k', balance: N(1000) }, 1000).why, 'rotated');
  assert.equal(permitState({ permit: p({ ok: false, judge: undefined }), balance: N(1000) }, 1000).why, 'rotated', 'from the door, with no judge to compare');
  assert.equal(permitState({ permit: p(), judge: 'j', balance: N(1000) }, 1911).why, 'expired', 'inside a landing of its end');
  assert.equal(permitState({ permit: p(), judge: 'j', balance: N(1000) }, 1909).good, true);
});

// L1: cage v4b refuses a permit (cap above 0) whose until is more than maxGrant, 30 days, past the block's clock.
test('a deposit\'s until: the door\'s end, else 12 hours, in whole seconds, and never past now + 30 days - 1 hour', () => {
  const now = 1_762_444_800; // 2025-11-06 16:00 UTC; any whole second works
  const most = BigInt(now + 30 * 86_400 - 3600);
  assert.equal(MAX_GRANT_SECS, 2_592_000, 'the maxGrant the real cage is deployed with');
  assert.equal(GRANT_MARGIN_SECS, 3600);
  assert.equal(permitUntil(now + 20 * 3600, now), BigInt(now + 20 * 3600), 'a door with more than an hour left: its end');
  assert.equal(permitUntil(now + 3600, now), BigInt(now + PERMIT_SECS), 'an hour or less left: a fresh 12 hours');
  assert.equal(permitUntil(0, now), BigInt(now + PERMIT_SECS), 'no door');
  for (const junk of [undefined, null, NaN, Infinity, -Infinity, 'soon', {}, -5]) assert.equal(permitUntil(junk, now), BigInt(now + PERMIT_SECS), String(junk));
  assert.equal(permitUntil(now + 20 * 3600 + 0.75, now), BigInt(now + 20 * 3600), 'whole seconds, rounded down');
  assert.equal(permitUntil(now + 0.9, now + 0.9), BigInt(now + PERMIT_SECS), 'now too');
  assert.equal(permitUntil((now + 20 * 3600) * 1000, now), most, 'a door end in milliseconds: clamped, not refused by the cage');
  assert.equal(permitUntil(now + 40 * 86_400, now), most, 'a longer door');
  assert.equal(permitUntil(Number.MAX_SAFE_INTEGER, now), most);
  assert.equal(permitUntil(now + 30 * 86_400 - 3600, now), most, 'on the clamp');
  assert.equal(permitUntil(now + 30 * 86_400 - 3601, now), most - 1n, 'just under it: kept');
  for (let door = now - 86_400; door < now + 60 * 86_400; door += 7919) {
    const until = permitUntil(door, now);
    assert.equal(typeof until, 'bigint');
    assert.ok(until <= BigInt(now + MAX_GRANT_SECS - GRANT_MARGIN_SECS) && until > BigInt(now), String(door));
  }
});

test('MAX_DOOR_SECS stays at or under the cage\'s maxGrant: the door\'s end becomes the permit\'s until', () => {
  assert.ok(MAX_DOOR_SECS <= 2_592_000, `MAX_DOOR_SECS is ${MAX_DOOR_SECS}: a door past 30 days would outlive any permit cage v4b takes`);
  assert.ok(MAX_DOOR_SECS <= MAX_GRANT_SECS);
  const now = 1_762_444_800;
  assert.equal(permitUntil(now + MAX_DOOR_SECS, now), BigInt(now + MAX_DOOR_SECS), 'the longest door the Worker takes is granted as it is, unclamped');
});

test('the permit tile says how long a permit can run, from the cage\'s own maxGrant', () => {
  assert.equal(grantLimitText(2_592_000n), 'A permit runs at most 30 days.');
  assert.equal(grantLimitText(2_592_000), 'A permit runs at most 30 days.');
  assert.equal(grantLimitText(86_400n), 'A permit runs at most 1 day.');
  assert.equal(grantLimitText(7200n), 'A permit runs at most 2 hours.');
  assert.equal(grantLimitText(720n), 'A permit runs at most 12 minutes.', 'the units mistake the deploy guards against reads as what it is');
  assert.equal(grantLimitText(61n), 'A permit runs at most 61 seconds.');
  for (const none of [undefined, null, 0n, -1, NaN, 'x', 2n ** 64n]) assert.equal(grantLimitText(none), '', String(none));
});

test('a stand\'s own clock: the seat stops holding the balance when it runs out, and freeAt is the earlier of the two', () => {
  const table = { epoch: 1n, seated: 2n, heartbeat: 1000n };
  const seat = (over) => ({ table: 7n, epoch: 1n, atRisk: N(5), standing: false, standAt: 0n, ...over });
  assert.equal(seatView({ seat: seat(), table, escapeSecs: 1800n, now: 1100 }).freeAt, 2800);
  assert.equal(seatView({ seat: seat({ standing: true, standAt: 900n }), table, escapeSecs: 1800n, now: 1100 }).freeAt, 2700);
  assert.equal(seatView({ seat: seat({ standing: true, standAt: 900n }), table, escapeSecs: 1800n, now: 2700 }).seated, false);
});

test('what makes a stand a moved seat, and what makes a revoke already done', () => {
  assert.equal(seatMovedError('failed assert: seated at another table'), true);
  assert.equal(seatMovedError('It landed but the cage refused it (FailEntirely).'), true);
  assert.equal(seatMovedError('You said no in Lace'), false);
  assert.equal(alreadyStanding('failed assert: already standing'), true);
  assert.equal(alreadyRevoked('failed assert: no permit'), true);
});

test('the result card: the time, the typical time once there are enough, one line on what is public, and the link', () => {
  for (const action of ['deposit', 'sit', 'seat', 'move', 'stand', 'release', 'withdraw', 'revoke', 'rescue']) {
    const c = resultCard({ action, ms: 42_300, typical: { ms: 38_000, n: 3 }, hash: 'ab12' });
    assert.equal(c.head, 'Confirmed in 42s');
    assert.equal(c.typical, 'typical 38s for this action');
    assert.match(c.says, /^Public: .+ Private: .+\.$/, action);
    assert.equal(c.says.split('. ').length, 2, `${action}: one plain line, two parts`);
    assert.ok(!/until|safe|anonymous/i.test(c.says), action);
    assert.equal(c.link, 'https://preprod.midnightexplorer.com/transactions/ab12');
  }
  assert.match(resultCard({ action: 'seat', typical: { ms: 1000, n: 2 } }).typical, /not enough timed yet/, 'a median of two isn\'t typical');
  assert.equal(resultCard({ action: 'seat', ms: null }).head, 'Confirmed', 'a restart can lose the time, and it says nothing it does not know');
  assert.equal(resultCard({ action: 'seat', hash: null }).link, null);
  assert.equal(shortTime(400), '1s');
  assert.equal(shortTime(89_000), '89s');
  assert.equal(shortTime(125_000), '2m 05s');
});

test('the running median: the middle of the last samples, per action', () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([5]), 5);
  assert.equal(medianOf([9, 1, 5]), 5);
  assert.equal(medianOf([1, 2, 3, 100]), 3);
  let w = [];
  for (let i = 1; i <= MAX_SAMPLES + 10; i += 1) w = addSample(w, i * 1000);
  assert.equal(w.length, MAX_SAMPLES, 'it keeps moving');
  assert.equal(w[0], 11_000);
  assert.equal(medianOf(w), 36_000);
  assert.equal(goodTiming('seat', 1000), true);
  assert.equal(goodTiming('settle', 1000), false);
  assert.equal(goodTiming('seat', 0), false);
  assert.equal(goodTiming('seat', 31 * 60_000), false);
  assert.equal(PAGE_TIMED.has('seat'), false, 'a seat is the judge\'s to report');
});

test('what stops a buy-in, in plain words', () => {
  assert.equal(buyPlan({ amount: 0n, table: 7n }).why, 'Pick an amount.');
  assert.match(buyPlan({ amount: N(4), ante: 5, table: 7n, night: N(100) }).why, /ante is 5, so bring at least 5 tNIGHT/);
  assert.match(buyPlan({ amount: N(600), ante: 5, potLimit: 500, table: 7n, night: N(1000) }).why, /At most 500 tNIGHT can be at risk in one seat at this table/);
  assert.match(buyPlan({ amount: N(250), cage: N(50), ante: 5, table: 7n, night: N(120) }).why, /Your wallet holds 120 tNIGHT and the cage 50: not enough for 250\./);
  assert.match(buyPlan({ amount: N(250), night: N(120) }).why, /Your wallet holds 120 tNIGHT: not enough for 250\./);
  assert.equal(buyPlan({ amount: N(4), ante: 5, night: N(100) }).why, null, 'the door has no ante');
  assert.equal(buyPlan({ amount: N(250), night: null, table: 7n }).why, null, 'a wallet that would not say its balance is not refused here');
});

test('how long and how many approvals, said up front', () => {
  const plan = buyPlan({ amount: N(50), cage: 0n, night: N(5000), ante: 5, potLimit: 500, signed: false, table: 7n });
  assert.equal(roughSeconds(plan, { warm: true }), 80 + 10 + 60);
  assert.equal(roughSeconds(plan, { warm: false }), 80 + 10 + 150);
  assert.equal(roughTime(30), 'under a minute');
  assert.equal(roughTime(70), 'about a minute');
  assert.equal(roughTime(195), 'about 3 minutes');
  assert.equal(sentence(roughTime(195)), 'About 3 minutes');
  assert.equal(approvalsText(plan, 'Lace'), '1 approval in Lace and one signature');
  assert.equal(approvalsText(buyPlan({ amount: N(50), cage: N(50), signed: true, table: 7n }), 'Lace'), '1 approval in Lace');
  assert.equal(approvalsText(buyPlan({ amount: N(50), cage: N(50), signed: true, table: 7n, permit: { good: true, cap: N(50), floor: 0n, room: N(50) } }), 'Lace'), 'nothing to approve');
  assert.equal(approvalsText(buyPlan({ amount: N(50), cage: N(50), signed: true, table: 7n, seated: true }), 'Lace'), 'nothing to approve');
});

test('describeError follows a wallet error down to what failed, in one scrubbed line', () => {
  assert.equal(describeError(new Error('User declined')), 'User declined');
  assert.equal(describeError({ message: { reason: 'Connection expired', code: 'Disconnected' } }), 'Connection expired: code Disconnected');
  assert.equal(describeError(Object.assign(new Error('balance failed'), { cause: { errors: [{ message: 'insufficient DUST' }] } })), 'balance failed: insufficient DUST');
  const fakeId = ['night', 'preprod', 'ABC123'].join(''); // a made-up id, built so scanners don't read it as a key
  assert.equal(describeError(new Error(`fetch https://x/api?project_id=${fakeId} failed`)), 'fetch https://x/api?project_id=*** failed');
  assert.equal(describeError(null), 'no details');
  assert.equal(describeError('plain text'), 'plain text');
  const loop = { message: 'a' }; loop.cause = loop;
  assert.equal(describeError(loop), 'a');
  assert.ok(describeError(new Error('x'.repeat(2000))).length <= 1501);
});

test('explainTrouble: what broke, the likely cause and what to do, by kind', () => {
  const noAnswer = explainTrouble(Object.assign(new Error('Lace didn’t answer.'), { noAnswer: true }), { wallet: 'Lace', during: 'connect' });
  assert.equal(noAnswer.kind, 'no-answer');
  assert.equal(noAnswer.title, 'Lace didn’t answer');
  assert.match(noAnswer.what, /asked Lace to connect/);
  assert.match(noAnswer.cause, /Lace 2\.5\.0 does this/);
  assert.deepEqual(noAnswer.steps.map((x) => x.split(' ')[0]), ['Open', 'Unlock', 'Press', 'Still'], 'open it, unlock it, retry, refresh');
  assert.match(noAnswer.steps[3], /Refresh this page/);
  assert.equal(noAnswer.retry, true);
  const lost = explainTrouble(Object.assign(new Error('Wallet UI disconnected'), { code: 'Disconnected' }), { wallet: '1AM', during: 'approve the deposit' });
  assert.equal(lost.kind, 'lost');
  assert.equal(lost.reconnect, true);
  assert.match(lost.what, /Nothing was sent/);
  const lostSent = explainTrouble(Object.assign(new Error('Wallet UI disconnected'), { code: 'Disconnected' }), { wallet: '1AM', sent: true });
  assert.equal(lostSent.kind, 'lost-after-send');
  assert.equal(lostSent.retry, false);
  assert.equal(explainTrouble(new Error('User declined to sign'), { wallet: 'Lace', during: 'approve the seat' }).title, 'You said no in Lace');
  assert.equal(explainTrouble(new Error('Unsupported network mainnet'), { wallet: 'Lace' }).kind, 'network');
  assert.equal(explainTrouble(new Error('Insufficient DUST for fees'), { wallet: 'Lace' }).kind, 'funds');
  assert.equal(explainTrouble(new Error('proof server returned 500'), { wallet: 'Lace' }).kind, 'proof');
  assert.equal(explainTrouble(new Error('Not on the indexer after 6 minutes. It may still land.'), { wallet: 'Lace' }).retry, false);
  assert.equal(explainTrouble(new Error('It landed but the cage refused it (FailEntirely).'), { wallet: 'Lace' }).kind, 'refused');
  const other = explainTrouble(new Error('Something odd'), { wallet: 'Lace', during: 'connect' });
  assert.equal(other.kind, 'said-no');
  assert.equal(other.raw, 'Something odd');
  assert.match(other.todo, /check it is unlocked and on Preprod/);
});

test('explainTrouble: the cage\'s own refusal, before anything is sent, is the cage\'s, not the wallet\'s', () => {
  const compact = (rule) => Object.assign(new Error(`failed assert: ${rule}`), { name: 'CompactError' }); // compact-runtime's words
  const grant = explainTrouble(compact('a permit runs at most maxGrant'), { wallet: 'Lace', during: 'approve the deposit' });
  assert.equal(grant.kind, 'cage-refused');
  assert.equal(grant.title, 'The cage refused it');
  assert.equal(grant.what, 'The cage refused it before anything was sent. Nothing was spent.');
  assert.match(grant.cause, /longer than the cage allows/);
  assert.match(grant.todo, /date and time/);
  assert.equal(grant.raw, 'failed assert: a permit runs at most maxGrant', 'the cage\'s own words, underneath');
  assert.equal(grant.retry, true);
  assert.ok(!/wallet said no|said no in/i.test(`${grant.title} ${grant.what} ${grant.cause}`), 'it doesn\'t blame the wallet');
  for (const rule of ['insufficient balance', 'seated: deposit after you stand', 'the permit names another judge', 'declared time is in the future', 'table is full']) {
    const t = explainTrouble(compact(rule), { wallet: 'Lace', during: 'approve it' });
    assert.equal(t.kind, 'cage-refused', `${rule}: not a fee, a decline or a proof`);
    assert.equal(t.what, 'The cage refused it before anything was sent. Nothing was spent.');
    assert.match(t.cause, /cage’s rules before asking Lace/);
    assert.match(t.todo, /Refresh to read the cage again/);
  }
  const wrapped = explainTrouble(Object.assign(new Error('Unexpected error executing scoped transaction'), { cause: compact('a permit runs at most maxGrant') }), { wallet: 'Lace' });
  assert.equal(wrapped.kind, 'cage-refused', 'found down the cause chain');
  const midnightJs = explainTrouble(new Error("Unexpected error executing scoped transaction '<unnamed>': Error: failed assert: a permit runs at most maxGrant"), { wallet: 'Lace' });
  assert.equal(midnightJs.kind, 'cage-refused', 'midnight-js\'s own wording, as the L1 rehearsal printed it');
  assert.match(midnightJs.cause, /longer than the cage allows/);
  assert.notEqual(explainTrouble(compact('insufficient balance'), { wallet: 'Lace', sent: true }).kind, 'cage-refused', 'after sending, it is not this card');
  assert.equal(explainTrouble(new Error('It landed but the cage refused it (FailEntirely).'), { wallet: 'Lace' }).kind, 'refused', 'a refusal on chain keeps its own card');
});

test('the Hall’s indexer lets queries through and nothing else', () => {
  assert.equal(operationOf('{ block { height } }'), 'query');
  assert.equal(operationOf('query Height { block { height } }'), 'query');
  assert.equal(operationOf('# note\n  query { x }'), 'query');
  assert.equal(operationOf('mutation { x }'), 'mutation');
  assert.equal(operationOf('subscription { x }'), 'subscription');
  assert.equal(operationOf('fragment F on X { y } query { x }'), null);
  assert.equal(operationOf(''), null);
});

test('the drain switch: a buy-in, a top up or a seat stops before the wallet is asked, and cashing out is unchanged', () => {
  const live = permitState({ permit: { cap: N(500), until: BigInt(Math.floor(Date.now() / 1000) + 40_000), floor: 0n }, balance: N(100) }, Math.floor(Date.now() / 1000));
  for (const args of [
    { amount: N(50), cage: 0n, night: N(5000), ante: 5, table: 7n },
    { amount: N(50), cage: N(100), night: N(5000), ante: 5, table: 7n, signed: true, permit: live },
    { amount: N(100), cage: N(91), night: N(5000), ante: 5, table: 7n, seated: true, topup: true, signed: true },
    { amount: N(20), cage: 0n, night: N(5000) },
  ]) {
    assert.equal(buyPlan({ ...args, draining: true }).why, DRAIN_TEXT);
    assert.notEqual(buyPlan(args).why, DRAIN_TEXT);
  }
  assert.deepEqual(cashPlan({ balance: N(7), seated: true, standing: false }).moves.map((m) => m.kind), ['stand', 'free', 'withdraw'], 'stand, wait, withdraw: the drain takes nothing away');
});

test('no DUST (pass #3, #7): a deposit, a sit or a cash-out waits with the reason; a seat from the cage, which needs no transaction, does not', () => {
  const N = (n) => BigInt(n) * 1_000_000n;
  const dep = buyPlan({ amount: N(50), dustReady: false, wallet: 'Lace', ante: 5, table: 7n, night: N(5000) });
  assert.match(dep.why, /^Your wallet has no DUST yet, so it can’t pay the network fee\. In Lace: DUST → register your tNIGHT \(one signature\), wait a few minutes, then Refresh\.$/);
  assert.equal(dep.noDust, true);
  const free = buyPlan({ amount: N(50), dustReady: false, cage: N(80), signed: true, ante: 5, table: 7n, night: N(10), permit: { good: true, room: N(80), cap: N(80) } });
  assert.equal(free.approvals, 0);
  assert.equal(free.why, null, 'the judge seats them from the cage: nothing for the wallet to pay');
  assert.equal(buyPlan({ amount: N(50), ante: 5, table: 7n, night: N(5000) }).why, null, 'with DUST, as before');
  assert.match(cashPlan({ balance: N(72), dustReady: false, wallet: '1AM' }).why, /no DUST yet.*In 1AM/);
  assert.equal(cashPlan({ balance: N(72) }).why, null);
});

test('the line a cash-out ends with (11-09): brought, back in the wallet, what stays, and up or down', () => {
  const n = (x) => BigInt(x) * 1_000_000n;
  assert.equal(sessionLine(n(50), n(22)), 'You brought 50, you’re leaving with 22: down 28 this session.');
  assert.equal(sessionLine(n(50), n(61)), 'You brought 50, you’re leaving with 61: up 11 this session.');
  assert.equal(sessionLine(n(50), n(50)), 'You brought 50, you’re leaving with 50: even this session.');
  assert.equal(sessionLine(n(50), n(20), n(10)), 'You brought 50: 20 is back in your wallet and 10 stays in the cage, down 20 this session.');
  assert.equal(sessionLine(n(10), 7_500_000n), 'You brought 10, you’re leaving with 7.5: down 2.5 this session.');
});

test('a wallet that restarted under the page (11-09, Lace): lost, and said in plain words with the raw error kept', () => {
  const lace = new Error("Remote API with channel 'feature-flags' was shutdown: object can no longer be used");
  for (const e of [lace, 'Port closed', new Error('Attempting to use a disconnected port object; message port closed'), { reason: 'The object has been destroyed' }]) {
    assert.ok(isWalletRestarted(e), String(e?.message ?? e?.reason ?? e));
    assert.ok(isSessionLost(e), String(e?.message ?? e?.reason ?? e));
  }
  for (const other of [new Error('declined'), new Error('Unsupported network'), new Error('shutdown of the prover is scheduled'), null]) assert.ok(!isWalletRestarted(other), String(other?.message ?? other));
  const said = explainTrouble(lace, { wallet: 'Lace', during: 'approve the deposit' });
  assert.equal(said.kind, 'restarted');
  assert.equal(said.title, 'Lace restarted itself');
  assert.equal(said.what, 'Lace restarted itself. Click Try again.');
  assert.equal(said.reconnect, true);
  assert.match(said.raw, /can no longer be used/);
  const afterSend = explainTrouble(lace, { wallet: 'Lace', sent: true });
  assert.equal(afterSend.kind, 'lost-after-send', 'after sending it never offers to send again');
  assert.equal(afterSend.retry, false);
});
