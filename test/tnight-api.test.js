// tNIGHT tables over HTTP on a local `wrangler dev`, with this test standing in for the judge service.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServers } from './server.js';

const ON = 8811;
const OFF = 8813;
const JUDGE = 'test-judge-token';
const CAGE = 'd'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const star = (n) => String(n * 1_000_000);

before(async () => {
  await startServer(ON, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${CAGE}`, '--var', 'CAGE_TABLE_BASE:500']);
  await startServer(OFF, ['--var', 'ALLOW_TEST_CONFIG:1']);
}, { timeout: 120_000 });
after(stopServers);

async function call(method, path, { body, token, port = ON } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const judge = (op, id, body) => call('POST', `/judge/tables/${id}/${op}`, { token: JUDGE, body });
const proof = { verifyingKey: 'vk', signature: 'sig' };

async function newTable(extra = {}) {
  const t = await call('POST', '/tables', { body: { tnight: true, lobbySeconds: 0, stakes: { ante: 1 }, test: { rng: 42, roundGapMs: 200 }, ...extra } });
  assert.equal(t.status, 201);
  return t.body;
}
async function seated(id, cageId, name, atRisk = 10) {
  const c = await call('POST', `/tables/${id}/cage-seat`, { body: { name, cageId, ...proof } });
  assert.equal(c.status, 202);
  const v = await judge('verified', id, { cageId, ok: true, atRiskStar: star(atRisk), balanceStar: star(atRisk), epoch: 1 });
  assert.equal(v.status, 200);
  return c.body.token;
}
/** Plays one round to a paid pot with the first seat's claim. */
async function playRound(id, tokens) {
  for (let guard = 0; guard < 60; guard += 1) {
    const v = (await call('GET', `/tables/${id}`)).body;
    if (v.phase === 'settled' || v.phase === 'over') return v;
    let moved = false;
    for (const token of tokens) {
      const me = (await call('GET', `/tables/${id}/me`, { token })).body;
      const legal = (name) => me.legal.find((x) => x.action === name);
      let action = null;
      if (legal('stop') && me.seat === v.starter) action = { action: 'stop', claim: legal('stop').options[0].claim };
      else if (legal('pass')) action = { action: 'pass', card: me.hand[0] };
      else if (legal('check')) action = { action: 'check' };
      else if (legal('match')) action = { action: 'match' };
      if (action && (await call('POST', `/tables/${id}/act`, { token, body: action })).status === 200) moved = true;
    }
    assert.ok(moved, 'nobody could move');
  }
  throw new Error('round did not end');
}

test('off by default: no tNIGHT tables, no judge routes, no Hall change', async () => {
  const t = await call('POST', '/tables', { port: OFF, body: { tnight: true } });
  assert.equal(t.status, 400);
  assert.equal(t.body.error, 'tnight_off');
  assert.equal((await call('GET', '/judge/tables', { port: OFF, token: JUDGE })).status, 404);
  const plain = await call('POST', '/tables', { port: OFF, body: { lobbySeconds: 0, test: { rng: 1 } } });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.state.cage, undefined);
  const j = await call('POST', `/tables/${plain.body.id}/join`, { port: OFF, body: { name: 'Cat' } });
  assert.equal(j.status, 201, 'a play-chip table joins as it always has');
  assert.ok(j.body.state.seats.some((x) => x.bot && x.chips >= 90), 'its bots still bring play chips');
  assert.equal((await call('POST', `/tables/${plain.body.id}/cage-seat`, { port: OFF, body: { name: 'Dee', cageId: A, ...proof } })).status, 409);
});

test('a client can\'t set the cage itself, and a play table on a tNIGHT server stays a play table', async () => {
  const t = await call('POST', '/tables', { body: { lobbySeconds: 0, cage: { table: 5, address: 'e'.repeat(64) } } });
  assert.equal(t.status, 201);
  assert.equal(t.body.state.cage, undefined);
  assert.equal((await call('POST', `/tables/${t.body.id}/join`, { body: { name: 'Eve' } })).status, 201);
  assert.equal((await call('POST', '/tables', { body: { tnight: 'yes' } })).status, 400);
  assert.equal((await call('POST', '/tables', { body: { tnight: true, bots: 9 } })).status, 400);
});

test('the judge door needs the token', async () => {
  assert.equal((await call('GET', '/judge/tables')).status, 401);
  assert.equal((await call('GET', '/judge/tables', { token: 'wrong' })).status, 401);
  const { id } = await newTable();
  assert.equal((await call('POST', `/judge/tables/${id}/settled`, { token: 'wrong', body: { seqs: [], tx: {} } })).status, 401);
  assert.equal((await call('POST', `/tables/${id}/judge`, { body: {} })).status, 404, 'not reachable through the public table routes');
  assert.equal((await call('GET', '/judge/tables', { token: JUDGE })).status, 200);
});

test('a whole table: claim, verified by the judge, dealt, rounds listed for settling, receipts in the log, release', async () => {
  const { id, state } = await newTable();
  assert.equal(state.cage.mode, 'tnight');
  assert.equal(state.cage.address, CAGE);
  assert.ok(Number.isInteger(state.cage.table));
  assert.equal(state.limits.turnMs, 15000);

  assert.equal((await call('POST', `/tables/${id}/join`, { body: { name: 'Sly' } })).status, 409, 'no ordinary join at a tNIGHT table');

  const c = await call('POST', `/tables/${id}/cage-seat`, { body: { name: 'Ann', cageId: A, ...proof } });
  assert.equal(c.status, 202);
  assert.equal((await call('GET', `/tables/${id}/me`, { token: c.body.token })).status, 401, 'no seat yet');
  assert.equal((await call('GET', `/tables/${id}/cage-seat`, { token: c.body.token })).body.status, 'pending');
  assert.equal((await call('GET', `/tables/${id}`)).body.seats.length, 0, 'a claim deals nobody in');
  assert.ok(!JSON.stringify((await call('GET', `/tables/${id}`)).body).includes('"sig"'), 'the proof is not public');

  const row = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.equal(row.claims[0].cageId, A);
  assert.equal(row.claims[0].signature, 'sig');
  assert.equal(row.claims[0].message, `sealed-hand:seat:v1|${CAGE}|${id}|${A}`);

  await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(10), balanceStar: star(10), epoch: 1 });
  const annStatus = (await call('GET', `/tables/${id}/cage-seat`, { token: c.body.token })).body;
  assert.equal(annStatus.status, 'seated');
  assert.equal(annStatus.stack, 10);
  assert.equal((await call('GET', `/tables/${id}`)).body.phase, 'lobby', 'one seat waits');
  const addChips = await call('POST', `/tables/${id}/add-chips`, { token: c.body.token, body: { amount: 5 } });
  assert.equal(addChips.status, 409, 'chips come from the cage');
  assert.equal((await call('GET', `/tables/${id}/me`, { token: c.body.token })).body.canAddChips, false);

  const bob = await seated(id, B, 'Bob');
  const tokens = [c.body.token, bob];
  await new Promise((r) => setTimeout(r, 50));
  let view = (await call('GET', `/tables/${id}`)).body;
  if (view.phase === 'lobby') { // the judge's next call, or the alarm, starts it; nudge
    await judge('alert', id, { message: '' });
    view = (await call('GET', `/tables/${id}`)).body;
  }
  assert.equal(view.phase, 'pass');
  assert.equal(view.seats.length, 2, 'no play-chip bots');

  view = await playRound(id, tokens);
  const work = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.equal(work.entries.length, 1);
  assert.deepEqual(work.entries[0].rounds, [1]);
  assert.equal(work.entries[0].lines.reduce((sum, l) => sum + l.delta, 0), 0);

  const tx = { hash: 'beef', id: '00aa', block: 99, chainRound: 1, status: 'SucceedEntirely' };
  assert.equal((await judge('settled', id, { seqs: [1], tx })).status, 200);
  assert.equal((await judge('settled', id, { seqs: [1], tx })).status, 200, 'repeat is safe');
  assert.equal((await judge('settled', id, { seqs: [1], tx: { ...tx, hash: 'cafe' } })).status, 409);
  view = (await call('GET', `/tables/${id}`)).body;
  assert.equal(view.log.filter((l) => l.receipt).length, 1);
  assert.match(view.log.find((l) => l.receipt).text, /Round 1 settled on chain.*Tx beef in block 99/);
  assert.equal(view.cage.receipts[0].hash, 'beef');
  assert.deepEqual(view.cage.unsettled, []);

  // Bob stands on chain, so the Worker has him leave. Between rounds that's at once.
  await judge('standing', id, { cageId: B });
  view = (await call('GET', `/tables/${id}`)).body;
  assert.ok(view.seats.find((x) => x.name === 'Bob').left);
  let w = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.deepEqual(w.releases, [{ cageId: B, kind: 'player' }]);
  await judge('released', id, { cageId: B });

  // Ann leaves: the table is over and listed as done once she's released.
  assert.equal((await call('POST', `/tables/${id}/leave`, { token: c.body.token, body: {} })).status, 200);
  w = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.equal(w.over, true);
  assert.equal(w.done, false);
  await judge('released', id, { cageId: A });
  w = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.equal(w.done, true);
  assert.equal((await call('POST', `/judge/tables/${id}/done`, { token: JUDGE, body: {} })).status, 200);
  assert.ok(!(await call('GET', '/judge/tables', { token: JUDGE })).body.tables.some((t) => t.id === id));
  // The table and its receipts stay readable after the judge is finished with it.
  assert.equal((await call('GET', `/tables/${id}`)).body.cage.receipts.length, 1);
});

test('a refused claim deals nobody in and frees nobody: the owner can claim again', async () => {
  const { id } = await newTable();
  const c = await call('POST', `/tables/${id}/cage-seat`, { body: { name: 'Ann', cageId: A, ...proof } });
  await judge('verified', id, { cageId: A, ok: false, reason: 'signature does not match the payout address' });
  const status = (await call('GET', `/tables/${id}/cage-seat`, { token: c.body.token })).body;
  assert.equal(status.status, 'refused');
  assert.match(status.reason, /signature/);
  const w = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.deepEqual(w.releases, []);
  assert.equal((await call('POST', `/tables/${id}/cage-seat`, { body: { name: 'Ann', cageId: A, ...proof } })).status, 202);
});

test('a table the chain has voided closes and asks nothing more of the judge', async () => {
  const { id } = await newTable();
  const a = await seated(id, A, 'Ann');
  const b = await seated(id, B, 'Bob');
  await judge('alert', id, { message: '' });
  await playRound(id, [a, b]);
  await judge('dead', id, { reason: 'no settle for 30 minutes.' });
  const v = (await call('GET', `/tables/${id}`)).body;
  assert.equal(v.phase, 'over');
  assert.equal(v.cage.status, 'dead');
  assert.deepEqual(v.cage.unsettled, []);
  const w = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.equal(w.entries.length, 0);
  assert.equal(w.done, true);
});

test('the Hall lists a tNIGHT table, marked, before anyone sits, and a play-chip table stays as it was', async () => {
  const { id, state } = await newTable({ bots: 2 });
  const hall = (await call('GET', '/games')).body.games.find((g) => g.id === 'sealed-hand');
  const row = hall.tables.find((t) => t.id === id);
  assert.equal(row.tnight, true);
  assert.equal(row.table, state.cage.table);
  assert.equal(row.joinable, true);
  const plain = await call('POST', '/tables', { body: { lobbySeconds: 30 } });
  await call('POST', `/tables/${plain.body.id}/join`, { body: { name: 'Pat' } });
  const after = (await call('GET', '/games')).body.games.find((g) => g.id === 'sealed-hand');
  const listed = after.tables.find((t) => t.id === plain.body.id);
  assert.equal(listed.tnight, undefined, 'nothing added to a play-chip row');
  assert.equal(listed.joinable, true);
  assert.equal(state.cage.joinable, true);
});

test('reserved names are refused before a claim, so a player seated on chain can fix it and sign again', async () => {
  const { id } = await newTable();
  for (const name of ['Tally', 'Brannock', 'Clockwork', 'clock work']) {
    const r = await call('POST', `/tables/${id}/cage-seat`, { body: { name, cageId: A, ...proof } });
    assert.equal(r.status, 409, name);
    assert.equal(r.body.error, 'name_reserved', name);
  }
  assert.equal((await call('POST', `/tables/${id}/cage-seat`, { body: { name: 'Ann', cageId: A, ...proof } })).status, 202);
});

test('a tNIGHT table takes stakes too, but its worst round has to fit the cage', async () => {
  const t = await call('POST', '/tables', { body: { tnight: true, stakes: { ante: 1, potLimit: 900 } } });
  assert.equal(t.status, 201);
  assert.equal(t.body.state.limits.potLimit, 900);
  assert.equal((await call('POST', '/tables', { body: { tnight: true, stakes: { raiseLimit: 100, potLimit: 2000 } } })).body.error, 'bad_stakes');
  const v = await call('POST', '/tables', { body: { tnight: true } });
  assert.deepEqual([v.body.state.limits.ante, v.body.state.limits.potLimit], [5, 500]);
});

test('table numbers start above CAGE_TABLE_BASE, because the chain outlives any one Worker', async () => {
  const { state } = await newTable();
  assert.ok(state.cage.table > 500, `got ${state.cage.table}`);
});

test('a table with bots waits for the float, then its bots play house chips', async () => {
  const { id } = await newTable({ bots: 2 });
  assert.equal((await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id).wantHouse, false, 'nobody here yet: no float');
  const a = await seated(id, A, 'Ann', 6);
  assert.equal((await call('GET', `/tables/${id}`)).body.phase, 'lobby');
  const w = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.equal(w.wantHouse, true);
  await judge('house', id, { cageId: B, atRiskStar: star(6), balanceStar: star(6), epoch: 1 });
  const v = (await call('GET', `/tables/${id}`)).body;
  assert.equal(v.seats.length, 3);
  assert.deepEqual(v.seats.filter((x) => x.bot).map((x) => x.chips).map((n) => n <= 3), [true, true]);
  assert.notEqual(v.phase, 'lobby');
  assert.ok(a);
});

// ---------- the door, and warm tables ----------

const doorBody = (over = {}) => ({ cageId: A, payout: 'c'.repeat(64), expires: Math.floor(Date.now() / 1000) + 3600, verifyingKey: 'vk', signature: 'sig', name: 'The owner', avatar: 'rogue', kind: 'human', ...over });
const doorAnswer = (key, body) => call('POST', '/judge/door', { token: JUDGE, body: { key, ...body } });
async function atTheDoor(over) {
  const d = await call('POST', '/door', { body: doorBody(over) });
  assert.equal(d.status, 202);
  const { body: { doors } } = await call('GET', '/judge/tables', { token: JUDGE });
  return { token: d.body.token, row: doors.find((x) => x.status === 'pending' && x.expires === d.body.expires) };
}

test('the door is off without tNIGHT, and refuses a bad session', async () => {
  assert.equal((await call('POST', '/door', { body: doorBody(), port: OFF })).status, 404);
  assert.equal((await call('GET', '/door/me', { token: 'x', port: OFF })).status, 404);
  const expires = Math.floor(Date.now() / 1000);
  for (const over of [{ cageId: 'nope' }, { payout: 'nope' }, { expires: expires + 30 }, { expires: expires + 25 * 3600 }, { signature: 'x'.repeat(513) }, { verifyingKey: undefined }]) {
    assert.equal((await call('POST', '/door', { body: doorBody(over) })).status, 400, JSON.stringify(over));
  }
  assert.equal((await call('GET', '/door/me', { token: 'not-a-session' })).status, 401);
});

test('a session at the door is pending until the judge says, and only then takes a seat, for its own player key', async () => {
  const { id } = await newTable();
  const { token, row } = await atTheDoor();
  assert.equal(row.message, `sealed-hand:door:v1|${CAGE}|${A}|${'c'.repeat(64)}|${row.expires}`, 'the Worker writes the message, so the judge checks what was claimed');
  assert.equal(row.signature, 'sig');
  assert.equal(row.token, undefined);
  assert.equal((await call('GET', '/door/me', { token })).body.status, 'pending');

  const early = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token } });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'door_pending');
  assert.equal((await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: 'nobody' } })).body.error, 'door_required');

  assert.equal((await call('POST', '/judge/door', { body: { key: row.key, ok: true } })).status, 401, 'only the judge answers');
  await doorAnswer(row.key, { ok: true, balanceStar: star(30) });
  const me = await call('GET', '/door/me', { token });
  assert.deepEqual([me.body.status, me.body.cageId, me.body.name, me.body.balanceStar, me.body.expired], ['verified', A, 'The owner', star(30), false]);

  // The player key comes from the session: naming someone else's in the request changes nothing.
  const claim = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token, cageId: B, name: 'Pauly', approvedAt: 1234 } });
  assert.equal(claim.status, 202);
  const work = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((t) => t.id === id);
  assert.deepEqual(work.claims.map((c) => [c.cageId, c.door, c.signature]), [[A, true, undefined]]);
  const v = await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(10), balanceStar: star(30), epoch: 1 });
  assert.equal(v.status, 200);
  const state = (await call('GET', `/tables/${id}`)).body;
  assert.deepEqual([state.seats[0].name, state.seats[0].avatar], ['Pauly', 'rogue']);
  assert.equal(state.cage.timings.approvedAt, 1234);
  assert.ok(state.cage.timings.seatedAt > 0);
});

test('a session the judge refused says why and seats nobody', async () => {
  const { id } = await newTable();
  const { token, row } = await atTheDoor();
  await doorAnswer(row.key, { ok: false, reason: 'That wallet is not the payout address of this cage id.' });
  assert.match((await call('GET', '/door/me', { token })).body.reason, /not the payout/);
  const c = await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token } });
  assert.equal(c.status, 409);
  assert.match(c.body.message, /door refused/);
  const { body: { doors } } = await call('GET', '/judge/tables', { token: JUDGE });
  assert.ok(!doors.some((d) => d.key === row.key), 'and the judge isn\'t asked again');
});

test('a warm table: the judge opens it, the float goes on before anyone comes, and a seat deals at once', async () => {
  assert.equal((await call('POST', '/judge/warm', { body: { bots: 2 } })).status, 401);
  const warm = await call('POST', '/judge/warm', { token: JUDGE, body: { bots: 2 } });
  assert.equal(warm.status, 201);
  const { id } = warm.body;
  const row = () => call('GET', '/judge/tables', { token: JUDGE }).then((r) => r.body.tables.find((t) => t.id === id));
  let work = await row();
  assert.deepEqual([work.warm, work.wantHouse, work.wantBots, work.ante], [true, true, 2, 5], 'it wants its float with nobody there');
  const H = 'e'.repeat(64);
  assert.equal((await judge('house', id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 })).status, 200);
  work = await row();
  assert.equal(work.wantHouse, false);
  let state = (await call('GET', `/tables/${id}`)).body;
  assert.equal(state.phase, 'lobby', 'bots alone don\'t deal');
  assert.equal(state.cage.warm, true);
  assert.equal(state.cage.joinable, true);
  const listed = (await call('GET', '/games')).body.games[0].tables.find((t) => t.id === id);
  assert.equal(listed.warm, true);

  const { token, row: session } = await atTheDoor({ cageId: A, name: 'Warmer' });
  await doorAnswer(session.key, { ok: true });
  await call('POST', `/tables/${id}/cage-seat`, { body: { doorToken: token } });
  await judge('verified', id, { cageId: A, ok: true, atRiskStar: star(50), balanceStar: star(50), epoch: 1 });
  state = (await call('GET', `/tables/${id}`)).body;
  assert.equal(state.round, 1, 'dealt by the judge\'s word, with no lobby');
  assert.ok(state.cage.timings.dealtAt >= state.cage.timings.seatedAt);
  assert.equal((await call('POST', `/judge/tables/${id}/settled`, { token: JUDGE, body: { seqs: [], tx: { hash: 'ab', block: 1, chainRound: '1', status: 'ok' } } })).status, 200, 'a settle of nothing has no entries to mark');
  assert.equal((await row()).phase, state.phase);
});

