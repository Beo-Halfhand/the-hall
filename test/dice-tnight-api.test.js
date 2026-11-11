// Cup & Claim on tNIGHT over HTTP on a local `wrangler dev`, with this test standing in for the judge service: seats from the cage,
// entries for the judge, and a numbered receipt for every round that anyone can recheck.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServers } from './server.js';
import { commitHouse, commitSeed, rollDice, roundFingerprint } from '../src/games/cup-and-claim/fair.js';

const ON = 8831;
const OFF = 8835;
const JUDGE = 'test-judge-token';
const CAGE = 'd'.repeat(64);
const A = 'a'.repeat(64);
const H = 'e'.repeat(64);
const star = (n) => String(n * 1_000_000);
const onDir = mkdtempSync(join(tmpdir(), 'sealed-hand-receipts-'));
const onVars = (cage = CAGE, extra = []) => ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${cage}`, '--var', 'CAGE_TABLE_BASE:700', ...extra];
let kept = null; // a settled receipt from cage CAGE, for the cut-over test at the end

before(async () => {
  await startServer(ON, onVars(), onDir);
  await startServer(OFF, ['--var', 'ALLOW_TEST_CONFIG:1']);
}, { timeout: 120_000 });
after(stopServers);

async function call(method, path, { body, token, port = ON } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, body: parsed, headers: res.headers };
}
const judge = (op, id, body) => call('POST', `/judge/tables/${id}/${op}`, { token: JUDGE, body });
const proof = { verifyingKey: 'vk', signature: 'sig' };

/** A table with a player and the house float seated, dealt from chain round 40. */
async function dealt({ show = false } = {}) {
  const t = await call('POST', '/dice-tables', { body: { tnight: true, bots: 2, lobbySeconds: 0, test: { rng: 7, roundGapMs: 200 } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const { id } = t.body;
  const claim = await call('POST', `/dice-tables/${id}/cage-seat`, { body: { name: 'Probe', cageId: A, ...proof } });
  assert.equal(claim.status, 202, JSON.stringify(claim.body));
  const token = claim.body.token;
  const work = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((x) => x.id === id);
  assert.equal(work.game, 'cup-and-claim');
  assert.equal(work.wantHouse, true, 'the float comes when a player shows up');
  assert.equal((await judge('house', id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 })).status, 200);
  const seated = await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(40), balanceStar: star(50), epoch: 1, lastRound: '40' });
  assert.equal(seated.status, 200, JSON.stringify(seated.body));
  return { id, token, show, table: t.body.state.cage.table };
}

/** Plays out one round by opening with the lowest bid and calling, and answering every prompt. */
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

test('off by default: no tNIGHT dice tables and no receipts', async () => {
  const t = await call('POST', '/dice-tables', { port: OFF, body: { tnight: true } });
  assert.equal(t.status, 400);
  assert.equal(t.body.error, 'tnight_off');
  assert.equal((await call('GET', '/receipt/1-1.json', { port: OFF })).status, 404);
  assert.equal((await call('GET', '/receipts/1', { port: OFF })).status, 404);
  const body = { tnight: true, cage: { table: 1 } };
  assert.equal((await call('POST', '/dice-tables', { port: OFF, body })).status, 400);
});

test('a dice table takes a cage number above the base, refuses a play-chip join, and a client cannot set the cage', async () => {
  const t = await call('POST', '/dice-tables', { body: { tnight: true, bots: 2, cage: { table: 1, address: 'bad' } } });
  assert.equal(t.status, 201);
  assert.ok(t.body.state.cage.table > 700);
  assert.equal(t.body.state.cage.address, CAGE);
  assert.equal(t.body.state.cage.mode, 'tnight');
  const join = await call('POST', `/dice-tables/${t.body.id}/join`, { body: { name: 'Sneak' } });
  assert.equal(join.status, 409);
  assert.equal(join.body.error, 'cage_table');
  const plain = await call('POST', '/dice-tables', { body: { cage: { table: 1, address: CAGE }, lobbySeconds: 0 } });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.state.cage, undefined, 'only the tnight option can make a cage table');
});

test('the judge opens a warm dice table when asked for that game, and reaches it through the right binding', async () => {
  const warm = await call('POST', '/judge/warm', { token: JUDGE, body: { bots: 2, game: 'cup-and-claim' } });
  assert.equal(warm.status, 201, JSON.stringify(warm.body));
  assert.equal(warm.body.state.cage.warm, true);
  assert.ok(warm.body.state.limits.faces, 'it is a dice table');
  const list = (await call('GET', '/judge/tables', { token: JUDGE })).body;
  assert.deepEqual(list.games, ['sealed-hand', 'cup-and-claim']);
  const row = list.tables.find((x) => x.id === warm.body.id);
  assert.equal(row.game, 'cup-and-claim');
  assert.equal(row.wantHouse, true);
  const house = await judge('house', warm.body.id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 });
  assert.equal(house.status, 200);
  const cards = await call('POST', '/judge/warm', { token: JUDGE, body: { bots: 2, game: 'sealed-hand' } });
  assert.ok(cards.body.state.cage.warm && !cards.body.state.limits.faces, 'and a card table for that game');
  const games = (await call('GET', '/games')).body.games;
  const dice = games.find((g) => g.id === 'cup-and-claim').tables.find((x) => x.id === warm.body.id);
  assert.equal(dice.tnight, true);
  assert.equal(dice.warm, true);
});

test('one round end to end: fingerprint before the deal is seen, opened after, lines for the judge, settle on the receipt', async () => {
  const { id, token, table } = await dealt();
  const number = `${table}-41`;
  let v = (await call('GET', `/dice-tables/${id}`)).body;
  assert.ok(v.round >= 1, 'dealt once the seat is confirmed');
  assert.equal(v.cage.chainBase, 40);
  assert.equal(v.receipt.number, number, 'the first round is the chain\'s next one');
  assert.equal(v.receipt.url, `/receipt/${number}`);
  const before1 = (await call('GET', `/receipt/${number}.json`)).body;
  assert.equal(before1.status, 'posted');
  assert.equal(before1.label, `Table ${table} · Round 41`);
  assert.equal(before1.fingerprint.hash, v.receipt.fingerprint);
  assert.equal(before1.opened, undefined, 'nothing is open while the round is in play');
  assert.ok(!JSON.stringify(before1).includes('"seed"'));
  assert.equal(roundFingerprint({ table, round: 41, houseCommit: before1.fingerprint.houseCommit, commits: before1.fingerprint.commits }), before1.fingerprint.hash, 'anyone can recompute it from its parts');
  assert.equal(before1.fingerprint.houseCommit, v.fair.houseCommit);
  assert.deepEqual(before1.fingerprint.commits, v.fair.commits);

  v = await playRound(id, token, { show: true });
  assert.equal(v.phase, 'settled');
  const after1 = (await call('GET', `/receipt/${number}.json`)).body;
  assert.equal(after1.status, 'opened');
  assert.equal(commitHouse(after1.opened.houseSeed), after1.fingerprint.houseCommit, 'the opened secret matches the seal');
  assert.ok(after1.claim && after1.call && after1.result, 'the claim, the call, the result');
  assert.equal(after1.result.kind, 'call');
  const mine = after1.reveals.find((r) => r.name === 'Probe');
  assert.equal(mine.mode, 'show');
  assert.equal(commitSeed(mine.seed), after1.fingerprint.commits[mine.seat]);
  assert.deepEqual(rollDice(after1.opened.houseSeed, mine.seed, mine.seat, after1.engineRound), mine.dice, 'a shown cup re-rolls');
  for (const r of after1.reveals) {
    if (r.mode === 'prove') {
      assert.equal(r.seed, undefined, 'a shut cup keeps its seed');
      assert.equal(r.dice, undefined);
      assert.equal(r.attested, 'house-attested', 'and its count is marked as the house\'s word');
    }
  }
  assert.equal(after1.reveals.reduce((n, r) => n + r.count, 0), after1.result.total);
  assert.equal(after1.chips.reduce((n, l) => n + l.delta, 0), 0, 'chips moved net to zero');
  assert.ok(after1.chips.some((l) => l.cageId === A), 'the player has a line');
  assert.match(after1.howToCheck.houseAttested, /only the money settles on chain/);

  // The judge's side: one entry for this round, whose lines are the same as the receipt's.
  const row = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((x) => x.id === id);
  assert.equal(row.entries.length, 1);
  assert.deepEqual(row.entries[0].rounds, [v.round]);
  assert.deepEqual(row.entries[0].lines.map((l) => [l.id, l.delta]), after1.chips.map((l) => [l.cageId, l.delta]));
  const tx = { hash: 'ab'.repeat(32), id: 'cd'.repeat(32), block: 3300000, status: 'SUCCESS', chainRound: 41, blockAt: 1793802768000 };
  assert.equal((await judge('settled', id, { seqs: row.entries[0].seq ? [row.entries[0].seq] : [], tx })).status, 200);
  const final = (await call('GET', `/receipt/${number}.json`)).body;
  assert.equal(final.status, 'settled');
  assert.equal(final.settle.hash, tx.hash);
  assert.equal(final.settle.block, 3300000);
  assert.equal(final.settle.chainRound, 41);
  assert.equal(final.cage.address, CAGE);
  assert.match(final.howToCheck.chain, new RegExp(`table ${table} and roundNo 41`));

  const list = (await call('GET', `/receipts/${table}`)).body;
  assert.equal(list.receipts[0].number, number);
  assert.equal(list.receipts[0].tx, tx.hash);
  assert.equal(list.receipts[0].cage, CAGE);
  kept = { number, table, fingerprint: final.fingerprint.hash };
  const page = await call('GET', `/receipt/${number}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.body, /js\/receipt\.js/);
  const asJson = await fetch(`http://127.0.0.1:${ON}/receipt/${number}`, { headers: { accept: 'application/json' } });
  assert.equal((await asJson.json()).number, number, 'the same address gives JSON to whoever asks for it');
  assert.equal((await call('GET', '/receipt/999999-1.json')).status, 404);
  assert.equal((await call('GET', '/receipt/nope')).status, 404);

  // The Records page has it too, under the tNIGHT number, with the same fingerprint and the settle transaction.
  const rec = (await call('GET', `/records/cup-and-claim/t${table}-41.json`)).body;
  assert.equal(rec.label, `Cup & Claim · tNIGHT table ${table} · round 41`);
  assert.equal(rec.status, 'settled');
  assert.equal(rec.settle.hash, tx.hash);
  assert.equal(rec.fingerprint.hash, final.fingerprint.hash);
  assert.equal(rec.receipt, `/receipt/${number}`);
  assert.match(rec.howToCheck.chain, new RegExp(`table ${table} and roundNo 41`));
  const found = (await call('GET', `/records/search?table=${table}&round=41&kind=tnight`)).body.records;
  assert.equal(found.length, 1);
  assert.equal(found[0].tx, tx.hash);
  assert.equal(found[0].url, `/records/cup-and-claim/t${table}-41`);

  // The next round takes the next number.
  const next = await call('POST', `/dice-tables/${id}/act`, { token, body: { action: 'next' } });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.state.receipt.number, `${table}-42`);
});

test('a table the chain has given up on leaves its round on the receipt as void, and no money line settles', async () => {
  const { id, token, table } = await dealt();
  assert.equal((await judge('dead', id, { reason: 'the cage escape fired: no settle for 30 minutes.' })).status, 200);
  const r = (await call('GET', `/receipt/${table}-41.json`)).body;
  assert.equal(r.result.kind, 'void');
  assert.equal(r.settle, undefined);
  assert.equal((await call('GET', `/dice-tables/${id}/me`, { token })).status, 200);
});

test('after a cut-over to a new cage, the old cage\'s receipts stay readable when RECEIPTS_PAST names it, and only then', { timeout: 180_000 }, async () => {
  assert.ok(kept, 'the receipt test above ran first');
  const NEW = 'f'.repeat(64);
  await stopServers();
  await startServer(ON, onVars(NEW, ['--var', `RECEIPTS_PAST:${CAGE}`]), onDir);
  const r = await call('GET', `/receipt/${kept.number}.json`);
  assert.equal(r.status, 200);
  assert.equal(r.body.cage.address, CAGE, 'it says which cage it is from');
  assert.equal(r.body.fingerprint.hash, kept.fingerprint);
  assert.equal(r.body.status, 'settled');
  const list = (await call('GET', `/receipts/${kept.table}`)).body;
  assert.ok(list.receipts.some((x) => x.number === kept.number), 'the table\'s list has it');
  assert.ok(list.receipts.every((x) => x.cage === CAGE), 'each row says its cage');
  assert.equal((await call('GET', `/receipt/${kept.number}.json?cage=${CAGE.slice(0, 8)}`)).status, 200);
  assert.equal((await call('GET', `/receipt/${kept.number}.json?cage=${NEW.slice(0, 8)}`)).status, 404, 'the new cage has no such round');
  assert.equal((await call('GET', `/receipt/${kept.number}.json?cage=dd`)).status, 404, 'too short a prefix names nothing');

  await stopServers();
  await startServer(ON, onVars(NEW), onDir);
  assert.equal((await call('GET', `/receipt/${kept.number}.json`)).status, 404, 'without RECEIPTS_PAST the old book is out of reach, as before');
});
