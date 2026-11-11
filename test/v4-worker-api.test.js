// Cage v4's Worker routes on a local `wrangler dev`: asking the judge for a seat, a stand's clock, the judge's steps and receipts, timings, and the drain switch.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServers } from './server.js';

const PORT = 8873;
const JUDGE = 'test-judge-token';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const star = (n) => String(n * 1_000_000);
const dir = mkdtempSync(join(tmpdir(), 'sealed-hand-v4-'));
const vars = (extra = []) => ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${'d'.repeat(64)}`, ...extra];

before(() => startServer(PORT, vars(), dir), { timeout: 120_000 });
after(stopServers);

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const judge = (op, id, body) => call('POST', `/judge/tables/${id}/${op}`, { token: JUDGE, body });
const work = async (id) => (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
const newTable = async (extra = {}) => (await call('POST', '/tables', { body: { tnight: true, lobbySeconds: 0, stakes: { ante: 5, potLimit: 500 }, test: { rng: 42, roundGapMs: 200 }, ...extra } })).body;
async function door(cageId = A, name = 'The owner') {
  const d = await call('POST', '/door', { body: { cageId, payout: 'c'.repeat(64), expires: Math.floor(Date.now() / 1000) + 3600, verifyingKey: 'vk', signature: 'sig', name, kind: 'human' } });
  const { doors } = (await call('GET', '/judge/tables', { token: JUDGE })).body;
  const row = doors.find((x) => x.status === 'pending' && x.cageId === cageId);
  await call('POST', '/judge/door', { token: JUDGE, body: { key: row.key, ok: true, balanceStar: star(100), permit: { cap: star(50), until: '1999999999', floor: star(50), ok: true } } });
  return d.body.token;
}

test('asking for a seat: only with a session from the door, in whole STAR, at least the ante, and never over the table\'s buy-in max (250) or pot limit', async () => {
  const { id } = await newTable();
  const token = await door();
  assert.equal((await call('POST', `/tables/${id}/cage-seat`, { body: { cageId: A, name: 'Sly', verifyingKey: 'vk', signature: 'sig', atRiskStar: star(50) } })).body.error, 'door_required', 'a signed seat claim can\'t ask');
  for (const bad of [50, '50.5', '-1', '0', 'all', '9'.repeat(30)]) assert.equal((await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token, atRiskStar: bad } })).body.error, 'bad_risk', String(bad));
  assert.match((await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token, atRiskStar: star(4) } })).body.message, /ante is 5/);
  const claim = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token, atRiskStar: star(900) } });
  assert.equal(claim.status, 202);
  assert.deepEqual((await work(id)).claims[0].ask, { atRiskStar: star(250) }, 'the buy-in max (250), under the pot limit of 500, whatever was asked');
  const small = await newTable({ stakes: { ante: 5, raiseLimit: 25, potLimit: 100 } });
  const t2 = await door('e'.repeat(64), 'Kit');
  assert.equal((await call('POST', `/tables/${small.id}/cage-seat`, { body: { doorToken: t2, atRiskStar: star(900) } })).status, 202);
  assert.deepEqual((await work(small.id)).claims[0].ask, { atRiskStar: star(100) }, 'a pot limit under 250 still wins');
  assert.equal((await work(id)).claims[0].cageId, A, 'the id comes from the session');
});

test('the door tells a page what is left on the permit, from the judge\'s last reading', async () => {
  const token = await door(B, 'Bea');
  const me = (await call('GET', '/door/me', { token })).body;
  assert.deepEqual(me.permit, { cap: star(50), until: '1999999999', floor: star(50), ok: true });
});

test('the judge\'s steps and refusal code reach the player\'s claim, and its receipt reaches the claim and the table', async () => {
  const { id } = await newTable();
  const token = await door();
  const c = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token, atRiskStar: star(50) } });
  const status = async () => (await call('GET', `/tables/${id}/cage-seat`, { token: c.body.token })).body;
  assert.equal((await status()).step, null);
  await judge('step', id, { cageId: A, step: 'proving' });
  assert.equal((await status()).step, 'proving');
  await judge('seated', id, { cageId: A, kind: 'seat', until: '1999999999', tx: { hash: 'ab', id: 'cd', block: 9, status: 'SucceedEntirely', ms: 41000 } });
  await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(50), balanceStar: star(100), epoch: 1 });
  const seated = await status();
  assert.equal(seated.status, 'seated');
  assert.deepEqual(seated.receipt, { kind: 'seat', from: null, until: '1999999999', ms: 41000, tx: { hash: 'ab', block: 9 } });
  const view = (await call('GET', `/tables/${id}`)).body;
  assert.equal(view.cage.seatReceipts[0].hash, 'ab');
  assert.ok(!JSON.stringify(view).includes(token), 'no token in public');

  const { id: other } = await newTable();
  const d = await call('POST', `/tables/${other}/cage-seat`, { body: { doorToken: await door(B, 'Bea'), atRiskStar: star(50) } });
  await judge('verified', other, { cageId: B, ok: false, code: 'need_grant', reason: 'No permit on chain.' });
  const refused = (await call('GET', `/tables/${other}/cage-seat`, { token: d.body.token })).body;
  assert.deepEqual([refused.status, refused.code, refused.reason], ['refused', 'need_grant', 'No permit on chain.']);
});

test('a stand\'s deadline and the table\'s clock come through, and a leave can say it\'s moving', async () => {
  const { id } = await newTable();
  const a = await door(A, 'Ann'), b = await door(B, 'Bob');
  const ca = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: a, atRiskStar: star(50) } });
  const cb = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: b, atRiskStar: star(50) } });
  await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(50), balanceStar: star(100), epoch: 1 });
  await judge('verified', id, { cageId: B, ok: true, atRiskStar: star(50), balanceStar: star(100), epoch: 1 });
  assert.equal((await judge('clock', id, { tableUntil: String(Math.floor(Date.now() / 1000) + 1800) })).status, 200);
  assert.ok((await work(id)).tableUntil > 0);
  const moving = await call('POST', `/tables/${id}/leave`, { token: cb.body.token, body: { moving: true } });
  assert.equal(moving.status, 200);
  assert.equal((await judge('standing', id, { cageId: A, standUntil: String(Math.floor(Date.now() / 1000) + 1500) })).status, 200);
  const row = await work(id);
  assert.ok(row.dealtAt > 0, 'the judge can see when the round in play was dealt');
  assert.ok(ca.body.token);
});

test('a page can report its own kinds of transaction, with a session. The judge reports the rest. Anyone can read the medians', async () => {
  const token = await door();
  assert.equal((await call('POST', '/door/timings', { body: { action: 'withdraw', ms: 1000 } })).status, 401);
  assert.equal((await call('POST', '/door/timings', { token: 'nope', body: { action: 'withdraw', ms: 1000 } })).status, 401);
  assert.equal((await call('POST', '/door/timings', { token, body: { action: 'move', ms: 1000 } })).status, 400);
  assert.equal((await call('POST', '/door/timings', { token, body: { action: 'withdraw', ms: -5 } })).status, 400);
  for (const ms of [1000, 3000, 2000]) assert.equal((await call('POST', '/door/timings', { token, body: { action: 'withdraw', ms } })).status, 200);
  assert.equal((await call('POST', '/judge/timing', { body: { action: 'move', ms: 1 } })).status, 401);
  assert.equal((await call('POST', '/judge/timing', { token: JUDGE, body: { action: 'move', ms: 40000 } })).status, 200);
  const { medians } = (await call('GET', '/door/timings')).body;
  assert.deepEqual(medians.withdraw, { ms: 2000, n: 3 });
  assert.deepEqual(medians.move, { ms: 40000, n: 1 });
});

test('the drain switch: no new tables and no new seats, the judge\'s routes stay up, and what\'s in play finishes', { timeout: 120_000 }, async () => {
  const { id } = await newTable();
  const token = await door();
  await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token, atRiskStar: star(50) } });
  await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(50), balanceStar: star(100), epoch: 1 });
  const cb = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: await door(B, 'Bob'), atRiskStar: star(50) } });
  await judge('verified', id, { cageId: B, ok: true, atRiskStar: star(50), balanceStar: star(100), epoch: 1 });
  const { id: empty } = await newTable();
  assert.equal((await call('GET', '/judge/tables', { token: JUDGE })).body.draining, undefined);

  await stopServers();
  await startServer(PORT, vars(['--var', 'TNIGHT_DRAIN:on']), dir);
  assert.equal((await call('POST', '/tables', { body: { tnight: true } })).body.error, 'draining');
  assert.equal((await call('POST', '/dice-tables', { body: { tnight: true } })).body.error, 'draining');
  assert.equal((await call('POST', '/judge/warm', { token: JUDGE, body: { bots: 2 } })).body.error, 'draining');
  assert.equal((await call('POST', `/tables/${empty}/cage-seat`, { body: { doorToken: token, atRiskStar: star(50) } })).body.error, 'draining');
  assert.equal((await call('GET', '/door')).body.draining, true);
  const list = (await call('GET', '/judge/tables', { token: JUDGE })).body;
  assert.equal(list.draining, true);
  assert.ok(list.tables.some((t) => t.id === id), 'the judge still sees the table in play');
  assert.equal((await judge('alert', id, { message: '' })).status, 200, 'and can still answer it');
  // Everything that takes money out goes on: a stand from the cage page, a leave at the table, the judge's settle and release.
  assert.equal((await judge('standing', id, { cageId: A, standUntil: String(Math.floor(Date.now() / 1000) + 1500) })).status, 200, 'a stand is heard');
  assert.ok((await work(id)).holders.some((h) => h.cageId === A && h.standUntil > 0), 'and its deadline reaches the judge');
  assert.equal((await call('POST', `/tables/${id}/leave`, { token: cb.body.token, body: {} })).status, 200, 'a player can leave the table');
  assert.equal((await judge('settled', id, { seqs: [], tx: { hash: 'ef', block: 10, status: 'SucceedEntirely' } })).status, 200, 'the judge can settle');
  assert.equal((await judge('released', id, { cageId: A, tx: { hash: 'f0', block: 11 } })).status, 200, 'and free a seat');
  assert.equal((await call('POST', '/tables', { body: { lobbySeconds: 0 } })).status, 201, 'play chips go on');
});
