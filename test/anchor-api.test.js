// The seal-anchor gate through a real local Worker, with the fake anchor service standing in for the Mini (test/fake-anchor.js).
// Both games, both modes, the service offline, the service silent (the lock times out), the token, and the record's anchor part.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServers } from './server.js';
import { fakeAnchor } from './fake-anchor.js';

const PORT = Number(process.env.ANCHOR_TEST_PORT ?? 8857);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `anchor-test-token-${'x'.repeat(24)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'ANCHOR_MODE:lock', '--var', 'ANCHOR_SCOPE:all', '--var', 'ANCHOR_PICKER:on', '--var', 'DEAL_BY_PLAYER:on', '--var', `ANCHOR_TOKEN:${TOKEN}`]), { timeout: 90_000 });
after(() => stopServers());

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A table in this mode, one person seated, dealt now. */
async function dealt(api, mode, test = {}) {
  const { body: t } = await call('POST', api, { body: { lobbySeconds: 120, anchor: mode, test: { rng: 5, botDelayMs: [200, 400], ...test } } });
  const { body: seat } = await call('POST', `${api}/${t.id}/join`, { body: { name: 'Tester', kind: 'human' } });
  const dn = await call('POST', `${api}/${t.id}/deal-now`, { token: seat.token, body: {} });
  assert.equal(dn.status, 200, JSON.stringify(dn.body));
  return { id: t.id, token: seat.token, state: dn.body.state };
}

async function until(api, id, ok, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const st = (await call('GET', `${api}/${id}`)).body;
    if (ok(st)) return st;
    if (Date.now() > end) throw new Error(`timed out; anchor ${JSON.stringify(st.anchor)}`);
    await sleep(250);
  }
}

test('the service is a bearer of the token, nobody else: the queue refuses a wrong one', async () => {
  assert.equal((await call('GET', '/anchor/queue')).status, 401);
  assert.equal((await call('GET', '/anchor/queue', { token: 'wrong-token-but-long-enough-xxxx' })).status, 401);
  assert.equal((await call('POST', '/anchor/result', { token: 'wrong-token-but-long-enough-xxxx', body: {} })).status, 401);
  const pub = (await call('GET', '/anchor')).body;
  assert.equal(pub.on, true);
  assert.equal(pub.mode, 'lock');
});

test('service offline: a lock fails at once, says why, and the round plays (no 90-second wait)', async () => {
  const t = await dealt('/tables', 'lock');
  const st = (await call('GET', `/tables/${t.id}`)).body;
  assert.equal(st.anchor.state, 'failed');
  assert.match(st.anchor.error, /offline/);
  const me = (await call('GET', `/tables/${t.id}/me`, { token: t.token })).body;
  assert.equal(me.hand.length, 5, 'the hand is the player\'s at once');
  assert.ok(st.log.some((l) => /Couldn't lock this hand on Midnight: the anchor service is offline/.test(l.text)));
});

test('Sealed Hand, lock first: the round holds (no move, hand face down) until the block, then plays; the record has the anchor', async () => {
  const svc = fakeAnchor({ base: BASE, token: TOKEN, delayMs: 1500 });
  try {
    await sleep(2500); // the service has polled: online
    const t = await dealt('/tables', 'lock');
    assert.equal(t.state.anchor.held, true);
    assert.deepEqual(t.state.waitingOn, [], 'nobody is on the clock while it locks');
    const held = (await call('GET', `/tables/${t.id}/me`, { token: t.token })).body;
    assert.equal(held.hand, null);
    assert.equal(held.handHeld, true);
    assert.deepEqual(held.legal, []);
    const move = await call('POST', `/tables/${t.id}/act`, { token: t.token, body: { action: 'fold' } });
    assert.equal(move.status, 409);
    assert.equal(move.body.error, 'locking');
    const st = await until('/tables', t.id, (x) => x.anchor?.state === 'anchored');
    assert.equal(st.anchor.held, false);
    assert.equal(st.anchor.seal, st.deal.seal, 'the seal locked is the deck seal');
    assert.ok(st.waitingOn.length > 0);
    const me = (await call('GET', `/tables/${t.id}/me`, { token: t.token })).body;
    assert.equal(me.hand.length, 5);
    assert.ok(me.legal.length > 0);
    const n = st.n;
    let rec = null;
    for (let i = 0; i < 40 && !rec?.anchor; i++) { rec = (await call('GET', `/records/sealed-hand/${n}-1.json`)).body; await sleep(300); }
    assert.equal(rec.anchor.ok, true);
    assert.equal(rec.anchor.payload, rec.seal.hash);
    assert.ok(Number.isInteger(rec.anchor.block));
    assert.equal(svc.seen.length, 1, 'one write per hand');
  } finally {
    await svc.stop();
  }
});

test('Sealed Hand, background: nothing waits; table talk says anchoring, then anchored', async () => {
  const svc = fakeAnchor({ base: BASE, token: TOKEN, delayMs: 1500 });
  try {
    await sleep(2500);
    const t = await dealt('/tables', 'background');
    assert.equal(t.state.anchor.held, false);
    const me = (await call('GET', `/tables/${t.id}/me`, { token: t.token })).body;
    assert.equal(me.hand.length, 5, 'the hand at once');
    const st = await until('/tables', t.id, (x) => x.anchor?.state === 'anchored');
    assert.ok(st.log.some((l) => /Locking this hand on Midnight \(30–60 s\)\. Enjoy your game\./.test(l.text)));
    assert.ok(st.log.some((l) => /^Locked ✓ block \d+/.test(l.text) && l.act?.tx));
  } finally {
    await svc.stop();
  }
});

test('lock with a silent service: the lock times out, says so, the round plays, and the record notes it', async () => {
  const svc = fakeAnchor({ base: BASE, token: TOKEN, outcome: 'silent' });
  try {
    await sleep(2500);
    const t = await dealt('/tables', 'lock', { anchorLockMs: 3000 });
    assert.equal(t.state.anchor.held, true);
    const st = await until('/tables', t.id, (x) => x.anchor?.state === 'timeout', 15_000);
    assert.ok(st.log.some((l) => /Couldn't lock this hand on Midnight in time/.test(l.text)));
    const me = (await call('GET', `/tables/${t.id}/me`, { token: t.token })).body;
    assert.equal(me.hand.length, 5);
    let rec = null;
    for (let i = 0; i < 40 && !rec?.anchorNote; i++) { rec = (await call('GET', `/records/sealed-hand/${st.n}-1.json`)).body; await sleep(300); }
    assert.equal(rec.anchorNote.state, 'timeout');
  } finally {
    await svc.stop();
  }
});

test('Cup & Claim, lock first: the cup stays down (no dice, no move) until the block; the fingerprint is what is locked', async () => {
  const svc = fakeAnchor({ base: BASE, token: TOKEN, delayMs: 1500 });
  try {
    await sleep(2500);
    const t = await dealt('/dice-tables', 'lock');
    assert.equal(t.state.anchor.held, true);
    const held = (await call('GET', `/dice-tables/${t.id}/me`, { token: t.token })).body;
    assert.equal(held.dice, null);
    assert.equal(held.diceHeld, true);
    assert.equal((await call('POST', `/dice-tables/${t.id}/act`, { token: t.token, body: { action: 'fold' } })).status, 409);
    const st = await until('/dice-tables', t.id, (x) => x.anchor?.state === 'anchored');
    const me = (await call('GET', `/dice-tables/${t.id}/me`, { token: t.token })).body;
    assert.equal(me.dice.length, 5);
    let rec = null;
    for (let i = 0; i < 40 && !rec?.anchor; i++) { rec = (await call('GET', `/records/cup-and-claim/${st.n}-1.json`)).body; await sleep(300); }
    assert.equal(rec.anchor.payload, rec.fingerprint.hash, 'the dice fingerprint is what went on chain');
  } finally {
    await svc.stop();
  }
});

test('the player starts the next deal: a settled chips round waits for a press (no clock)', async () => {
  // a round played out (call liar when it can, else the lowest bid), then nothing deals by itself
  const { body: t } = await call('POST', '/dice-tables', { body: { lobbySeconds: 120, anchor: 'off', test: { rng: 9 } } });
  const { body: seat } = await call('POST', `/dice-tables/${t.id}/join`, { body: { name: 'Bidder', kind: 'human' } });
  await call('POST', `/dice-tables/${t.id}/deal-now`, { token: seat.token, body: {} });
  let st;
  for (let i = 0; i < 60; i++) {
    st = (await call('GET', `/dice-tables/${t.id}`)).body;
    if (st.phase === 'settled' || st.phase === 'over') break;
    const me = (await call('GET', `/dice-tables/${t.id}/me`, { token: seat.token })).body;
    const liar = me.legal.find((a) => a.action === 'liar');
    const bid = me.legal.find((a) => a.action === 'bid');
    const reveal = me.legal.find((a) => a.action === 'reveal');
    if (reveal) await call('POST', `/dice-tables/${t.id}/act`, { token: seat.token, body: { action: 'reveal', mode: reveal.modes.includes('show') ? 'show' : reveal.modes[0] } });
    else if (liar) await call('POST', `/dice-tables/${t.id}/act`, { token: seat.token, body: { action: 'liar' } });
    else if (bid) await call('POST', `/dice-tables/${t.id}/act`, { token: seat.token, body: { action: 'bid', count: bid.lowest.count, face: bid.lowest.face } });
    await sleep(300);
  }
  assert.equal(st.phase, 'settled');
  await sleep(1500);
  assert.equal((await call('GET', `/dice-tables/${t.id}`)).body.phase, 'settled', 'still waiting for the press');
  assert.equal(st.deadline, null, 'no auto-deal clock');
  assert.equal(st.dealByPlayer, true);
  assert.equal(st.anchor, null, 'anchor off for this table (the picker)');
});
