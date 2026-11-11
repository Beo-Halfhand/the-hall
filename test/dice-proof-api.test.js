// A proof table over HTTP on a local `wrangler dev`, with this test standing in for the judge and for dice-house, and nothing on chain.
// The real thing runs on preprod: sealed-cage's scripts/dice-house.mjs and scripts/e2e-dice-proof.mjs.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer, stopServers } from './server.js';
import { proofCommit, proofDice, proofHouseCommit, proofKeyId, proofPreSeal, proofSalt } from '../src/games/cup-and-claim/fair.js';

const ON = 8941;
const OFF = 8945;
const JUDGE = 'test-judge-token';
const HOUSE = 'test-house-token';
const CAGE = 'd'.repeat(64);
const DICE = 'c'.repeat(64);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const H = 'e'.repeat(64);
const star = (n) => String(n * 1_000_000);
const base = ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${CAGE}`, '--var', 'CAGE_TABLE_BASE:500'];

before(async () => {
  await startServer(ON, [...base, '--var', 'DICE_PROOF:on', '--var', `DICE_PROOF_ADDRESS:${DICE}`, '--var', `DICE_HOUSE_TOKEN:${HOUSE}`]);
  await startServer(OFF, base);
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
  return { status: res.status, body: parsed };
}
const judge = (op, id, body) => call('POST', `/judge/tables/${id}/${op}`, { token: JUDGE, body });
const house = (id, body) => call('POST', `/judge/dice-proof/${id}`, { token: HOUSE, body });
const claimProof = { verifyingKey: 'vk', signature: 'sig' };
const hex32 = () => randomBytes(32).toString('hex');
const view = async (id) => (await call('GET', `/dice-tables/${id}`)).body;
const workOf = async (id) => (await call('GET', '/judge/dice-proof', { token: HOUSE })).body.tables.find((t) => t.id === id)?.work ?? null;
const ZERO = '0'.repeat(64);

/** A proof table with one person and the house's two bots, dealt from chain round 40, up to where the cups go on chain. */
async function seated({ people = [A], bots = 2, test = {} } = {}) {
  const t = await call('POST', '/dice-tables', { body: { tnight: true, proof: true, bots, seats: people.length + bots, lobbySeconds: 0, test: { rng: 7, roundGapMs: 200, ...test } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const { id } = t.body;
  const tokens = {};
  for (const [i, cageId] of people.entries()) {
    const claim = await call('POST', `/dice-tables/${id}/cage-seat`, { body: { name: `Probe${i}`, cageId, ...claimProof } });
    assert.equal(claim.status, 202, JSON.stringify(claim.body));
    tokens[cageId] = claim.body.token;
  }
  for (const cageId of people) assert.equal((await judge('verified', id, { cageId, ok: true, atRiskStar: star(40), balanceStar: star(50), epoch: 1, lastRound: '40' })).status, 200);
  assert.equal((await judge('house', id, { cageId: H, atRiskStar: star(60), balanceStar: star(60), epoch: 1 })).status, 200); // the float last, so everyone is in the first deal
  return { id, tokens, table: t.body.state.cage.table };
}
const seatOf = async (id, token) => (await call('GET', `/dice-tables/${id}/me`, { token })).body.seat;

/** Everything up to the bidding: holders named, the house's seal up, each person's cup sealed, the seed opened. */
async function dealIn(id, tokens, { sealers = Object.values(tokens) } = {}) {
  const seeds = {};
  const holder = {};
  const preseal = {};
  const round0 = (await view(id)).proof;
  for (const token of Object.values(tokens)) {
    const sk = hex32();
    const seat = await seatOf(id, token);
    seeds[seat] = hex32();
    holder[seat] = proofKeyId(sk);
    preseal[seat] = proofPreSeal(proofCommit(seeds[seat], round0.table, round0.round, seat, DICE), round0.table, round0.round, seat);
    const r = await call('POST', `/dice-tables/${id}/proof-holder`, { token, body: { holder: holder[seat], preseal: preseal[seat] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  let work = await workOf(id);
  await new Promise((r) => setTimeout(r, 300));
  work = await workOf(id);
  assert.equal(work.stage, 'opening');
  assert.equal(work.houseCommit, proofHouseCommit(work.houseSeed, work.table, work.round));
  assert.equal(work.round, 41, 'the round number is the chain\'s');
  for (const x of work.seats.filter(Boolean)) {
    if (x.bot) assert.equal(x.commit, proofCommit(x.seed, work.table, work.round, x.seat, DICE), 'a bot\'s seal is the server\'s to make');
    else { assert.equal(x.commit, null); assert.equal(x.seed, null, 'the server has no seed for a person'); assert.equal(x.holder, holder[x.seat]); assert.equal(x.preseal, preseal[x.seat]); }
  }
  await house(id, { event: 'opened', sealBy: 2_000_000_000, openBy: 2_000_000_100, callBy: 2_000_001_000, hash: 'open-hash' });
  assert.equal((await view(id)).proof.stage, 'sealing');
  const commits = {};
  for (const x of work.seats.filter(Boolean)) {
    if (x.bot) commits[x.seat] = x.commit;
  }
  for (const token of sealers) {
    const seat = await seatOf(id, token);
    commits[seat] = proofCommit(seeds[seat], work.table, work.round, seat, DICE);
  }
  const cups = Array.from({ length: 6 }, (_, i) => commits[i] ?? ZERO);
  const salt = proofSalt(work.houseSeed, work.table, work.round, cups, DICE);
  const r = await house(id, { event: 'revealed', salt, commits, hash: 'reveal-hash' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { salt, seeds, work };
}

test('flag off: no proof table, no route, and a plain table is untouched', async () => {
  const off = await call('POST', '/dice-tables', { port: OFF, body: { tnight: true, proof: true, bots: 2 } });
  assert.equal(off.status, 400);
  assert.equal(off.body.error, 'proof_off');
  assert.equal((await call('GET', '/judge/dice-proof', { port: OFF, token: HOUSE })).status, 404);
  assert.equal((await call('POST', `/judge/dice-proof/${'0'.repeat(64)}`, { port: OFF, token: HOUSE, body: { event: 'alert' } })).status, 404);
  const plain = await call('POST', '/dice-tables', { port: OFF, body: { tnight: true, bots: 2 } });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.state.proof, undefined);
  const smuggled = await call('POST', '/dice-tables', { port: OFF, body: { tnight: true, bots: 2, proofAddress: DICE } });
  assert.equal(smuggled.body.state.proof, undefined, 'a client can\'t set the address itself');
});

test('flag on: a proof table has to ask, and needs tNIGHT. A table that doesn\'t ask is a plain one', async () => {
  const plain = await call('POST', '/dice-tables', { body: { tnight: true, bots: 2 } });
  assert.equal(plain.body.state.proof, undefined);
  assert.equal((await call('POST', '/dice-tables', { body: { proof: true } })).body.error, 'bad_proof');
  assert.equal((await call('POST', '/dice-tables', { body: { tnight: true, proof: 'yes' } })).body.error, 'bad_proof');
  assert.equal((await call('GET', '/judge/dice-proof', { token: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/judge/dice-proof', { token: JUDGE })).status, 401, 'the judge\'s token doesn\'t open dice-house\'s routes');
  assert.equal((await call('GET', '/judge/tables', { token: HOUSE })).status, 401, 'and dice-house\'s token doesn\'t open the judge\'s');
  assert.equal((await call('POST', `/dice-tables/${plain.body.id}/proof-holder`, { token: 'x', body: { holder: ZERO, preseal: ZERO } })).status, 409);
});

test('a proof table takes at most three bots, the most the house can answer for inside its window. A plain table still takes five', async () => {
  const four = await call('POST', '/dice-tables', { body: { tnight: true, proof: true, bots: 4, seats: 6 } });
  assert.equal(four.status, 400);
  assert.equal(four.body.error, 'bad_bots');
  assert.match(four.body.message, /0 to 3/);
  const three = await call('POST', '/dice-tables', { body: { tnight: true, proof: true, bots: 3, seats: 6 } });
  assert.equal(three.status, 201, JSON.stringify(three.body));
  assert.equal(three.body.state.proof?.address, DICE);
  const plain = await call('POST', '/dice-tables', { body: { tnight: true, bots: 5, seats: 6 } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
});

test('a proof table isn\'t listed in the Hall', async () => {
  const { id } = await seated();
  const { games } = (await call('GET', '/games')).body;
  assert.equal(games.find((g) => g.id === 'cup-and-claim').tables.some((t) => t.id === id), false);
});

test('a full round: the server never has a person\'s dice, and the chain\'s answer settles the pot', async () => {
  const { id, tokens, table } = await seated();
  const token = tokens[A];
  const v0 = await view(id);
  assert.equal(v0.phase, 'seal');
  assert.equal(v0.proof.stage, 'holders', 'nothing goes on chain until the person has fixed their seal');
  assert.equal(await workOf(id), null);
  const { salt, seeds, work } = await dealIn(id, tokens);
  const seat = await seatOf(id, token);

  const during = await view(id);
  assert.equal(during.proof.salt, salt);
  assert.ok(['bid', 'duel'].includes(during.phase));
  const me = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
  assert.deepEqual(me.dice, [], 'the server has no dice for this seat');
  const text = JSON.stringify(during);
  for (const x of work.seats.filter(Boolean)) if (x.seed) assert.equal(text.includes(x.seed), false, 'a bot\'s seed isn\'t public');
  assert.equal(text.includes(seeds[seat]), false);

  // Bid and call. The bots move at once here.
  for (let guard = 0; guard < 60; guard += 1) {
    const v = await view(id);
    if (v.phase === 'duel') break;
    const m = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
    const can = (n) => m.legal.find((x) => x.action === n);
    const act = can('liar') ? { action: 'liar' } : can('bid') ? { action: 'bid', ...can('bid').lowest } : null;
    if (act) await call('POST', `/dice-tables/${id}/act`, { token, body: act });
    await new Promise((r) => setTimeout(r, 30));
  }
  const called = await view(id);
  assert.equal(called.phase, 'duel');
  assert.equal(called.proof.stage, 'calling');
  assert.equal(called.deadline, null, 'the chain\'s windows keep the time now');
  const w = await workOf(id);
  assert.deepEqual([w.duel.bidder, w.duel.caller].length, 2);
  await house(id, { event: 'called', houseBy: 2_000_000_200, answerBy: 2_000_000_400, hash: 'call-hash' });

  // The person can't go first.
  let m = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
  assert.equal(m.legal.find((x) => x.action === 'reveal').ready, false);

  // dice-house answers for the bots: what they show is decided by them, and the count by the chain.
  const { face } = w.duel;
  let total = 0;
  const countIn = (dice) => dice.filter((d) => d === face || d === 1).length;
  for (const x of w.seats.filter((y) => y?.bot)) {
    const dice = proofDice(salt, x.seed, x.seat);
    total += countIn(dice);
    assert.ok(['prove', 'show'].includes(x.mode), 'a bot chooses how it answers');
    await house(id, { event: 'answer', seat: x.seat, count: countIn(dice), shown: x.mode === 'show', dice: x.mode === 'show' ? dice : null, hash: `answer-${x.seat}` });
  }
  m = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
  assert.equal(m.legal.find((x) => x.action === 'reveal').ready, true);
  assert.equal((await call('POST', `/dice-tables/${id}/act`, { token, body: { action: 'reveal', mode: 'prove' } })).status, 200);
  assert.equal((await view(id)).phase, 'duel', 'saying you\'ll prove settles nothing: only the chain does');

  const mine = countIn(proofDice(salt, seeds[seat], seat));
  total += mine;
  await house(id, { event: 'answer', seat, count: mine, shown: false, hash: 'mine' });
  const held = total >= w.duel.count;
  const before = await view(id);
  const pot = before.pot;
  await house(id, { event: 'finished', verdict: held ? 'holds' : 'falls', why: 'counted', total, hash: 'finish-hash' });
  const done = await view(id);
  assert.ok(['settled', 'seal'].includes(done.phase));
  const last = done.lastDuel;
  assert.equal(last.total, total);
  assert.equal(last.held, held);
  assert.equal(last.winner, held ? w.duel.bidder : w.duel.caller);
  assert.equal(last.pot, pot);
  assert.equal(last.reveals.find((r) => r.seat === seat).proof.kind, 'compact-proof');
  assert.equal(last.reveals.find((r) => r.seat === seat).dice, undefined, 'a shut cup stays shut');
  assert.equal(JSON.stringify(done).includes(seeds[seat]), false);

  // The judge gets its entry as at any table, and the receipt names the transactions, with no count on the house's word.
  const judgeWork = (await call('GET', '/judge/tables', { token: JUDGE })).body.tables.find((x) => x.id === id);
  assert.ok(judgeWork, 'the judge still sees this table');
  await new Promise((r) => setTimeout(r, 300));
  const receipt = (await call('GET', `/receipt/${table}-41.json`)).body;
  assert.deepEqual(receipt.attested, [], 'nothing is on the house\'s word');
  assert.equal(receipt.dice.contract, DICE);
  assert.equal(receipt.dice.tx.finish, 'finish-hash');
});

test('a page that never fixes its seal doesn\'t hold up the table: its ante goes back and the round goes on, or there is no round', async () => {
  const { id, tokens } = await seated({ people: [A, B], bots: 1, test: { holdersWaitMs: 600 } });
  const before = await view(id);
  const seatA = await seatOf(id, tokens[A]);
  const seatB = await seatOf(id, tokens[B]);
  const r = before.proof;
  assert.equal(r.stage, 'holders');
  await call('POST', `/dice-tables/${id}/proof-holder`, { token: tokens[A], body: { holder: 'a'.repeat(64), preseal: 'b'.repeat(64) } });
  assert.equal((await view(id)).proof.stage, 'holders', 'B hasn\'t fixed theirs yet');
  assert.equal(await workOf(id), null, 'and nothing goes on chain until then');
  await new Promise((res) => setTimeout(res, 900));
  await view(id);
  const after = await view(id);
  assert.equal(after.proof.stage, 'opening', 'the clock ran out on B, and the round goes on');
  assert.equal(after.seats[seatB].status, 'out');
  assert.equal(after.seats[seatB].chips, before.seats[seatB].chips + before.limits.ante, 'B\'s ante is back');
  assert.equal(after.seats[seatA].status, 'in');
  const w = await workOf(id);
  assert.equal(w.seats[seatB], null, 'B isn\'t named on chain');
  assert.equal(w.seats[seatA].preseal, 'b'.repeat(64));

  const alone = await seated({ test: { holdersWaitMs: 300 } });
  const v0 = await view(alone.id);
  await new Promise((res) => setTimeout(res, 600));
  await view(alone.id);
  const v1 = await view(alone.id);
  assert.equal(v1.proof.stage, 'done', 'nobody there: no round');
  assert.equal(v1.pot, 0);
  assert.equal(v1.seats.reduce((n, x) => n + x.chips, 0), v0.seats.reduce((n, x) => n + x.chips, 0) + v0.pot, 'every ante went back');
});

test('a seal\'s hash is taken only when the round is asking, and only from a seat in it', async () => {
  const { id, tokens } = await seated();
  await dealIn(id, tokens);
  const late = await call('POST', `/dice-tables/${id}/proof-holder`, { token: tokens[A], body: { holder: ZERO, preseal: ZERO } });
  assert.equal(late.status, 409, 'it can\'t be changed once it\'s on chain');
  assert.equal(late.body.error, 'wrong_stage');
  const bad = await call('POST', `/dice-tables/${id}/proof-holder`, { token: tokens[A], body: { holder: 'zz', preseal: ZERO } });
  assert.equal(bad.status, 400);
});

test('a called round the chain can no longer take goes back: the time for a call ran out', async () => {
  const { id, tokens } = await seated();
  await dealIn(id, tokens);
  const token = tokens[A];
  for (let guard = 0; guard < 60; guard += 1) {
    const v = await view(id);
    if (v.phase === 'duel') break;
    const m = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
    const can = (n) => m.legal.find((x) => x.action === n);
    const act = can('liar') ? { action: 'liar' } : can('bid') ? { action: 'bid', ...can('bid').lowest } : null;
    if (act) await call('POST', `/dice-tables/${id}/act`, { token, body: act });
    await new Promise((r) => setTimeout(r, 30));
  }
  const before = await view(id);
  assert.equal(before.proof.stage, 'calling');
  const pot = before.pot;
  await house(id, { event: 'finished', verdict: 'voided', why: 'noCall', total: 0, hash: 'void-hash' });
  const v = await view(id);
  assert.equal(v.pot, 0);
  assert.equal(v.proof.stage, 'done');
  assert.equal(v.lastResult.kind, 'returned');
  assert.equal(v.lastResult.awards.reduce((n, x) => n + x.amount, 0), pot, 'the whole pot goes back');
});

test('a report twice is the same as a report once', async () => {
  const { id, tokens } = await seated();
  await dealIn(id, tokens);
  const v1 = await view(id);
  const again = await house(id, { event: 'opened', sealBy: 1, openBy: 2, hash: 'x' });
  assert.equal(again.status, 200);
  const v2 = await view(id);
  assert.equal(v2.proof.sealBy, v1.proof.sealBy);
  assert.equal(v2.proof.tx.open, v1.proof.tx.open);
});

test('a person who never seals isn\'t dealt in, and the ante comes back', async () => {
  const { id, tokens } = await seated({ people: [A, B], bots: 1 });
  const before = await view(id);
  const seatB = await seatOf(id, tokens[B]);
  const stackB = before.seats[seatB].chips;
  await dealIn(id, tokens, { sealers: [tokens[A]] });
  const v = await view(id);
  assert.equal(v.seats[seatB].chips, stackB + before.limits.ante, 'the ante is back');
  assert.equal(v.seats[seatB].status, 'out');
});

test('if nobody seals, there is no round, and every ante goes back', async () => {
  const { id, tokens } = await seated();
  const stack = (await view(id)).seats.map((x) => x.chips);
  const ante = (await view(id)).limits.ante;
  await dealIn(id, tokens, { sealers: [] });
  const v = await view(id);
  assert.equal(v.pot, 0);
  assert.deepEqual(v.seats.map((x) => x.chips), stack.map((c) => c + ante));
  assert.equal(v.proof.stage, 'done');
});

test('void: a third seat stays silent, and its stake is shared among the rest', async () => {
  const { id, tokens } = await seated({ people: [A, B], bots: 1 });
  await dealIn(id, tokens);
  // Bid and call between the two people. The third seat, whichever it is, stays silent.
  for (let guard = 0; guard < 80; guard += 1) {
    const v = await view(id);
    if (v.phase === 'duel') break;
    for (const token of Object.values(tokens)) {
      const m = (await call('GET', `/dice-tables/${id}/me`, { token })).body;
      const can = (n) => m.legal.find((x) => x.action === n);
      const act = can('liar') ? { action: 'liar' } : can('bid') ? { action: 'bid', ...can('bid').lowest } : null;
      if (act) await call('POST', `/dice-tables/${id}/act`, { token, body: act });
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  const w = await workOf(id);
  await house(id, { event: 'called', houseBy: 2_000_000_200, answerBy: 2_000_000_400, hash: 'call-hash' });
  const dealtSeats = w.seats.filter(Boolean).map((x) => x.seat);
  const third = dealtSeats.find((x) => x !== w.duel.bidder && x !== w.duel.caller);
  for (const s of [w.duel.bidder, w.duel.caller]) await house(id, { event: 'answer', seat: s, count: 0, hash: `a${s}` });
  const before = await view(id);
  const pot = before.pot;
  const stacks = before.seats.map((x) => x.chips);
  await house(id, { event: 'finished', verdict: 'voided', why: 'thirdSilent', total: 0, hash: 'f' });
  const v = await view(id);
  assert.equal(v.pot, 0);
  assert.equal(v.lastDuel.voided, true);
  assert.equal(v.lastDuel.reveals.find((r) => r.seat === third).mode, 'silent');
  assert.equal(v.seats[third].chips, stacks[third], 'the silent seat gets nothing back');
  const { awards } = v.lastResult;
  assert.equal(awards.some((x) => x.seat === third), false);
  assert.equal(awards.reduce((n, x) => n + x.amount, 0), pot, 'the whole pot went back to the others'); // part of it may wait behind a seat's at-risk limit
});
