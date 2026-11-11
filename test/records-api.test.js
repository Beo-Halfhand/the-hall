// The Records page over HTTP on a local `wrangler dev`: every Cup & Claim and Sealed Hand round gets a public number; the dice
// fingerprint is posted before the round is seen and opened after; and rounds can be found by table and round number.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServers } from './server.js';
import { answering, stopping } from './helpers.js';
import { commitHouse, commitSeed, roundFingerprint, verifyShown } from '../src/games/cup-and-claim/fair.js';

const PORT = Number(process.env.RECORDS_API_PORT ?? 8871); // its own port: 8871 + 1000 can be held by another checkout's server (11-10)
const BASE = `http://127.0.0.1:${PORT}`;

before(() => startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']), { timeout: 90_000 });
after(stopServers);

async function call(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function newTable(rng) {
  const t = await call('POST', '/dice-tables', { body: { lobbySeconds: 0, test: { rng, roundGapMs: 1500 } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  return t.body.id;
}

/** Plays the round in front of us to its end: opens with the lowest bid, calls Liar when it can, shows or proves when asked. */
async function playRound(id, token, { show = false } = {}) {
  for (let guard = 0; guard < 80; guard += 1) {
    const v = (await call('GET', `/dice-tables/${id}`)).body;
    if (v.phase === 'settled' || v.phase === 'over') return v;
    const me = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
    const can = (name) => me.legal.find((x) => x.action === name);
    let action = null;
    if (can('reveal')) action = { action: 'reveal', mode: show ? 'show' : 'prove' };
    else if (can('liar')) action = { action: 'liar' };
    else if (can('bid')) action = { action: 'bid', ...can('bid').lowest };
    if (action) await call('POST', `/dice-tables/${id}/act`, { token, body: action });
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('round did not end');
}

test('a play-chip round is numbered by the Hall: the fingerprint is up while the round is in play, the secrets open at the end', async () => {
  const id = await newTable(11);
  const joined = await call('POST', `/dice-tables/${id}/join`, { body: { name: 'Probe' } });
  assert.equal(joined.status, 201);
  const { token } = joined.body;
  const view = (await call('GET', `/dice-tables/${id}`)).body;
  assert.ok(Number.isInteger(view.n) && view.n >= 1, 'the Hall gave the table a number at the first deal');
  const table = view.n;
  assert.equal(view.round, 1);

  // While the round is in play: the fingerprint, and nothing a die could be read from.
  const open = (await call('GET', `/records/cup-and-claim/${table}-1.json`)).body;
  assert.equal(open.label, `Cup & Claim · table ${table} · round 1`);
  assert.equal(open.number, `${table}-1`);
  assert.equal(open.status, 'posted');
  assert.equal(open.fingerprint.hash, roundFingerprint({ table, round: 1, houseCommit: view.fair.houseCommit, commits: view.fair.commits }));
  assert.equal(open.fingerprint.houseCommit, view.fair.houseCommit);
  assert.deepEqual(open.fingerprint.commits, view.fair.commits);
  assert.equal(open.opened, undefined);
  assert.equal(open.claim, undefined);
  assert.ok(!/"seed"|"dice"|"houseSeed"/.test(JSON.stringify({ ...open, howToCheck: null })), 'nothing under a cup is in the record yet');

  const done = await playRound(id, token, { show: true });
  assert.equal(done.phase, 'settled');
  const rec = (await call('GET', `/records/cup-and-claim/${table}-1.json`)).body;
  assert.equal(rec.status, 'opened');
  assert.equal(rec.fingerprint.hash, open.fingerprint.hash, 'the fingerprint did not change when the round was opened');
  assert.equal(commitHouse(rec.opened.houseSeed), rec.fingerprint.houseCommit);
  assert.ok(rec.claim && rec.call && rec.result, 'the claim, the call and the result');
  assert.equal(rec.result.kind, 'call');
  assert.equal(rec.reveals.reduce((n, r) => n + r.count, 0), rec.result.total);
  const mine = rec.reveals.find((r) => r.name === 'Probe');
  assert.equal(mine.mode, 'show');
  assert.equal(commitSeed(mine.seed), rec.fingerprint.commits[mine.seat]);
  assert.ok(verifyShown({ houseSeed: rec.opened.houseSeed, houseCommit: rec.fingerprint.houseCommit, seed: mine.seed, commit: mine.commit, seat: mine.seat, round: rec.engineRound, dice: mine.dice }), 'a shown cup recomputes');
  for (const r of rec.reveals) if (r.mode === 'prove') assert.ok(r.dice === undefined && r.seed === undefined, 'a shut cup keeps its dice and seed');
  assert.equal(rec.chips.length, 4, 'a line for every seat dealt in');
  // The pot rule: the loser of the call pays, the others get their stake back and an equal share, a right caller counts double.
  assert.equal(rec.result.loser.name, rec.result.held ? rec.call.name : rec.claim.name);
  assert.equal(rec.result.awards.reduce((n, a) => n + a.amount, 0), rec.result.pot);
  assert.ok(rec.result.awards.every((a) => a.amount === a.back + a.share && a.name !== rec.result.loser.name), 'each award is its stake back plus a share; the loser is not paid');
  const lost = rec.chips.find((l) => l.name === rec.result.loser.name);
  assert.equal(lost.delta, -rec.result.loserStake, 'the loser is out only their own stake');
  assert.equal(rec.chips.reduce((n, l) => n + l.delta, 0), 0, 'what one side lost the other won');
  assert.ok(rec.chips.find((l) => l.name === rec.result.winner.name).delta >= 0, 'the winner of the call is not out of pocket');
  assert.equal(rec.settle, undefined, 'play chips: no chain transaction');
  assert.match(rec.howToCheck.chips, /no chain money moved/);
  assert.equal(done.lastResult.pot, rec.result.pot);
});

test('rounds are found by table and round number, and the latest are listed newest first', async () => {
  const id = await newTable(12);
  const { token } = (await call('POST', `/dice-tables/${id}/join`, { body: { name: 'Finder' } })).body;
  const table = (await call('GET', `/dice-tables/${id}`)).body.n;
  await playRound(id, token);
  assert.equal((await call('POST', `/dice-tables/${id}/act`, { token, body: { action: 'next' } })).status, 200);
  await playRound(id, token);
  assert.equal((await call('POST', `/dice-tables/${id}/act`, { token, body: { action: 'next' } })).status, 200);

  const one = (await call('GET', `/records/search?table=${table}&round=2`)).body.records;
  assert.equal(one.length, 1);
  assert.equal(one[0].label, `Cup & Claim · table ${table} · round 2`);
  assert.equal(one[0].url, `/records/cup-and-claim/${table}-2`);
  assert.equal(one[0].status, 'opened');
  assert.ok(one[0].claim && one[0].result && one[0].chips);

  const byTable = (await call('GET', `/records/search?table=${table}`)).body.records;
  assert.deepEqual(byTable.map((r) => r.round), [3, 2, 1], 'newest first; round 3 is dealt and still sealed');
  assert.equal(byTable[0].status, 'posted');
  assert.equal(byTable[0].claim, null);

  const byRound = (await call('GET', `/records/search?round=1`)).body.records;
  assert.ok(byRound.some((r) => r.table === table), 'a round number alone finds it at every table');
  assert.ok(byRound.every((r) => r.round === 1));

  const latest = (await call('GET', '/records/search')).body;
  assert.ok(latest.records.length >= 3);
  for (let i = 1; i < latest.records.length; i += 1) assert.ok(latest.records[i - 1].number !== latest.records[i].number);
  assert.equal((await call('GET', `/records/search?table=${table}&round=999`)).body.records.length, 0);
  assert.equal((await call('GET', `/records/search?table=${table}&kind=tnight`)).body.records.length, 0, 'a play table is not a tNIGHT one');

  assert.equal((await call('GET', '/records/search?table=abc')).status, 400);
  assert.equal((await call('GET', '/records/search?round=1.5')).status, 400);
  assert.equal((await call('GET', '/records/search?game=nope')).status, 400);
  assert.equal((await call('GET', '/records/search?kind=nope')).status, 400);
});

test('the pages: /records, a round at its own address, and the errors', async () => {
  const id = await newTable(13);
  await call('POST', `/dice-tables/${id}/join`, { body: { name: 'Pager' } });
  const table = (await call('GET', `/dice-tables/${id}`)).body.n;
  const list = await call('GET', '/records');
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type'), /text\/html/);
  assert.match(list.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(list.body, /js\/records\.js/);
  const page = await call('GET', `/records/cup-and-claim/${table}-1`);
  assert.equal(page.status, 200);
  assert.match(page.body, /js\/receipt\.js/, 'one round is shown by the same page as a receipt');
  const asJson = await fetch(`${BASE}/records/cup-and-claim/${table}-1`, { headers: { accept: 'application/json' } });
  assert.equal((await asJson.json()).number, `${table}-1`);
  assert.equal((await call('GET', '/records/cup-and-claim/999999-1.json')).status, 404);
  assert.equal((await call('GET', '/records/cup-and-claim/nope')).status, 404);
  assert.equal((await call('GET', '/records/axe-lane/1-1')).status, 404, 'a game with no book');
  assert.equal((await call('GET', '/records/sealed-hand/999999-1.json')).status, 404);
  assert.equal((await call('POST', '/records/search')).status, 405);
  const api = (await call('GET', '/api')).body;
  assert.ok(api.routes['GET /records']);
  assert.match(api.routes['GET /records'], /Sealed Hand/);
});

/** Plays a Sealed Hand seat with the plainest legal moves until the round is over. */
async function playHand(id, token) {
  for (let i = 0; i < 80; i += 1) {
    const v = (await call('GET', `/tables/${id}`)).body;
    if (v.phase === 'settled' || v.phase === 'over') return v;
    const me = (await call('GET', `/tables/${id}/me`, { token })).body;
    const has = (a) => me.legal?.find((l) => l.action === a);
    const body = has('pass') ? { action: 'pass', card: has('pass').cards[0], ...(has('pass').match ? { match: true } : {}) } : has('match') ? { action: 'match' } : has('stop') ? stopping(me) : has('claim')?.truthful.length ? { action: 'claim', claim: has('claim').truthful[0].claim } : has('check') ? { action: 'check' } : has('fold') ? { action: 'fold' } : null;
    if (body) await call('POST', `/tables/${id}/act`, { body: answering(me, body), token });
    else await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the hand did not end');
}

test('a Sealed Hand play round has a number too: who was dealt in from the deal, the claims and chips at the end, and never a card', async () => {
  const made = await call('POST', '/tables', { body: { lobbySeconds: 0, test: { rng: 5, roundGapMs: 60_000 } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  const joined = await call('POST', `/tables/${id}/join`, { body: { name: 'Dealer' } });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const { token } = joined.body;
  const view = (await call('GET', `/tables/${id}`)).body;
  assert.ok(Number.isInteger(view.n) && view.n >= 1, 'the Hall numbered the table before the first deal');
  assert.equal(view.round, 1);
  const table = view.n;
  const seat = view.seats.findIndex((x) => x.name === 'Dealer');
  const cards = new Set((await call('GET', `/tables/${id}/me`, { token })).body.hand);
  assert.equal(cards.size, 5);

  const open = (await call('GET', `/records/sealed-hand/${table}-1.json`)).body;
  assert.equal(open.label, `Sealed Hand · table ${table} · round 1`);
  assert.equal(open.number, `${table}-1`);
  assert.equal(open.status, 'posted');
  assert.ok(open.seats.find((x) => x.name === 'Dealer').dealt);
  assert.ok(Number.isInteger(open.ante) && open.ante >= 1, 'the ante');
  assert.match(open.seal.hash, /^[0-9a-f]{64}$/, 'the deck seal, posted before any card was dealt');
  assert.equal(open.opened, undefined, 'the seed and the deck are still sealed');
  assert.equal(open.claims, undefined);
  assert.match(open.howToCheck.seal, /before any card was dealt or passed/);
  for (const card of cards) assert.ok(!JSON.stringify(open).includes(`"${card}"`), `no card (${card}) while the round is in play`);

  const done = await playHand(id, token);
  assert.equal(done.phase, 'settled');
  for (const card of (await call('GET', `/tables/${id}/me`, { token })).body.hand) cards.add(card);
  const finalHand = (await call('GET', `/tables/${id}/me`, { token })).body.hand;
  const rec = (await call('GET', `/records/sealed-hand/${table}-1.json`)).body;
  assert.equal(rec.status, 'opened', 'the round is over and the deck is open');
  assert.equal(rec.result.kind, done.lastResult.kind);
  assert.equal(rec.result.pot, done.lastResult.pot);
  assert.deepEqual(rec.claims.map((c) => [c.label, c.status]), done.lastResult.claims.map((c) => [c.label, c.status]));
  assert.deepEqual(rec.result.awards.map((a) => [a.seat, a.amount]), done.lastResult.awards.map((a) => [a.seat, a.amount]));
  const money = done.lastResult.money[seat];
  assert.equal(rec.chips.find((l) => l.name === 'Dealer').delta, money.out - money.in, 'the same net the table shows the seat');
  assert.equal(rec.chips.reduce((n, l) => n + l.delta, 0), 0 - rec.result.carried, 'what one seat lost another won, less any pot carried on');
  assert.equal(rec.seal.hash, open.seal.hash, 'the same seal');
  assert.equal(rec.opened.deck.length, 52, 'the deck, opened');
  assert.match(rec.opened.seed, /^[0-9a-f]{64}$/);
  assert.deepEqual([...rec.hands[seat]].sort(), [...finalHand].sort(), 'the hand this seat held is in the opened record');
  assert.ok(Array.isArray(rec.moves.passes) && rec.moves.passes.length >= 2, 'every pass');
  assert.deepEqual(rec.moves.claims.map((c) => c.status), rec.claims.map((c) => c.status));
  assert.match(rec.howToCheck.hands, /takes the next five cards/);
  assert.equal(rec.settle, undefined, 'play chips: no chain transaction');
  assert.match(rec.howToCheck.chips, /no chain money moved/);

  const found = (await call('GET', `/records/search?game=sealed-hand&table=${table}`)).body.records;
  assert.equal(found.length, 1);
  assert.equal(found[0].label, `Sealed Hand · table ${table} · round 1`);
  assert.equal(found[0].url, `/records/sealed-hand/${table}-1`);
  assert.equal(found[0].status, 'opened');
  assert.equal(found[0].seal, rec.seal.hash, 'the seal in the list');
  assert.deepEqual(found[0].claims.map((c) => c.status), done.lastResult.claims.map((c) => c.status));
  assert.ok((await call('GET', `/records/search?table=${table}&round=1`)).body.records.every((r) => r.game === 'cup-and-claim'), 'Cup & Claim is still the default book');
  const page = await call('GET', `/records/sealed-hand/${table}-1`);
  assert.equal(page.status, 200);
  assert.match(page.body, /js\/receipt\.js/);
});
