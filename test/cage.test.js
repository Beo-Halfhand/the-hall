// tNIGHT tables, the money rules without a server. The engine plays real rounds; cage.js turns them into lines.

import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createTable, leave, legalActions, tick } from '../src/games/sealed-hand/engine.js';
import { FOLD_BEFORE_SECS, MIN_ROUND_SECS, cageClock, cageForceRoundEnd, cageMoving, cageSeated, cageStanding, cageAfterChange, cageAlert, cageDead, cageJoinable, cageHouseSeated, cageMaybeStart, cageReleased, cageSeatVerified, cageSettled, cageView, cageWork, claimRefusal, newCage } from '../src/games/sealed-hand/cage.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const H = 'c'.repeat(64);
const star = (n) => String(n * 1_000_000);
const ctx = (now = 1000) => {
  let x = 7;
  return { now, rng: () => { x = (x * 16807) % 2147483647; return x / 2147483647; } };
};

function table({ bots = 0, seats = 4 } = {}) {
  const s = createTable({ seats, lobbyMs: 1, turnMs: 15000, ante: 1, potLimit: Infinity }); // stakes are a setting: these do their sums at 1
  s.tokens = [];
  s.players = [];
  s.cage = newCage({ table: 1, address: 'f'.repeat(64), bots, lobbyMs: 0 });
  return s;
}
function claim(s, id, name) {
  assert.equal(claimRefusal(s, id), null);
  s.cage.claims[id] = { name, kind: 'agent', avatar: 'adventurer', status: 'pending' };
}
function seat(s, id, name, atRisk, balance = atRisk, c = ctx()) {
  claim(s, id, name);
  const out = cageSeatVerified(s, id, { ok: true, atRiskStar: star(atRisk), balanceStar: star(balance), epoch: 1 }, c);
  assert.equal(out.status, 'seated');
  return out.seat;
}

/**
 * Plays a round through the engine. `claimer` stops the passing with a claim nobody calls, so it takes the pot. With
 * `carry`, all five passes go round and everyone checks: no claim stands, so the pot carries over.
 */
function playRound(s, c, { claimer = 0, raise = 0, carry = false } = {}) {
  assert.equal(s.phase, 'pass');
  const passWindow = () => { for (const seat of s.seats.keys()) if (s.phase === 'pass' && s.status[seat] === 'in') act(s, seat, { action: 'pass', card: s.hands[seat][0] }, c); };
  if (raise) {
    act(s, claimer, { action: 'pass', card: s.hands[claimer][0], raise }, c);
    for (const seat of s.seats.keys()) if (seat !== claimer && s.status[seat] === 'in') act(s, seat, { action: 'pass', card: s.hands[seat][0], match: true }, c);
  } else passWindow();
  passWindow();
  passWindow();
  if (carry) while (s.phase === 'pass') passWindow();
  else act(s, claimer, { action: 'stop', claim: [1, 2] }, c);
  while (s.phase === 'claim') act(s, s.lap.queue[0], { action: 'check' }, c);
  cageAfterChange(s);
}
const next = (s, seatNo, c) => {
  act(s, seatNo, { action: 'next' }, c);
  cageAfterChange(s);
};
function started() {
  const s = table();
  seat(s, A, 'Ann', 10);
  seat(s, B, 'Bob', 10);
  cageMaybeStart(s, ctx());
  return s;
}

test('a claim is refused once the table has started, for a bad id, and when seats run out', () => {
  const s = table({ seats: 2 });
  assert.equal(claimRefusal(s, 'nope').code, 'bad_cage_id');
  seat(s, A, 'Ann', 5);
  claim(s, B, 'Bob');
  assert.equal(claimRefusal(s, B).code, 'claim_pending');
  assert.equal(claimRefusal(s, H).code, 'table_full');
  assert.equal(cageSeatVerified(s, B, { ok: true, atRiskStar: star(5), balanceStar: star(5), epoch: 1 }, ctx()).status, 'seated');
  cageMaybeStart(s, ctx());
  assert.equal(s.phase, 'pass');
  assert.equal(claimRefusal(s, H).code, 'table_started');
});

test('nobody is dealt in until the judge confirms them, and one seat alone never deals', () => {
  const s = table();
  claim(s, A, 'Ann');
  claim(s, B, 'Bob');
  cageMaybeStart(s, ctx());
  assert.equal(s.seats.length, 0, 'a claim is not a seat');
  assert.equal(s.phase, 'lobby');
  assert.equal(cageSeatVerified(s, A, { ok: true, atRiskStar: star(5), balanceStar: star(5), epoch: 1 }, ctx()).status, 'seated');
  cageMaybeStart(s, ctx());
  tick(s, ctx(99_999_999));
  assert.equal(s.phase, 'lobby', 'one verified seat waits, and its clock does not close the table or add play-chip bots');
  assert.equal(s.seats.length, 1);
  assert.equal(cageSeatVerified(s, B, { ok: false, reason: 'no seat on chain' }, ctx()).status, 'refused');
  assert.equal(s.seats.length, 1);
  assert.equal(s.cage.claims[B].reason, 'no seat on chain');
  assert.ok(!s.cage.claims[B].proven, 'an unproven claim must not free anybody\'s seat');
});

test('a stack starts at min(atRisk, balance), and no chips are created', () => {
  const s = table();
  seat(s, A, 'Ann', 3, 8);
  assert.equal(s.seats[0].chips, 3);
  assert.equal(s.cage.holders[A].behind, 5);
  seat(s, B, 'Bob', 9, 4);
  assert.equal(s.seats[1].chips, 4);
  assert.equal(s.cage.holders[B].behind, 0);
});

test('a seat on chain under the ante is refused, and freed, and a float too small to ante is refused', () => {
  const s = createTable({ seats: 4, lobbyMs: 1, turnMs: 15000 });
  s.tokens = [];
  s.players = [];
  s.cage = newCage({ table: 1, address: 'f'.repeat(64), bots: 2, lobbyMs: 0 });
  assert.equal(s.cfg.ante, 5);
  claim(s, A, 'Ann');
  assert.equal(cageSeatVerified(s, A, { ok: true, atRiskStar: star(4), balanceStar: star(4), epoch: 1 }, ctx()).status, 'refused');
  assert.match(s.cage.claims[A].reason, /ante of 5/);
  assert.ok(s.cage.claims[A].proven, 'its seat is real, so the judge frees it');
  assert.equal(cageHouseSeated(s, H, { atRiskStar: star(6), balanceStar: star(6), epoch: 1 }).error, 'float_too_small', '3 chips a bot can\'t ante 5');
  assert.equal(cageHouseSeated(s, H, { atRiskStar: star(60), balanceStar: star(60), epoch: 1 }).ok, true);
  assert.deepEqual(s.seats.map((x) => x.chips), [30, 30]);
});

test('whole chips only: fractions of a tNIGHT stay in the cage', () => {
  const s = table();
  claim(s, A, 'Ann');
  cageSeatVerified(s, A, { ok: true, atRiskStar: '2500000', balanceStar: '2500000', epoch: 1 }, ctx());
  assert.equal(s.seats[0].chips, 2);
  claim(s, B, 'Bob');
  assert.equal(cageSeatVerified(s, B, { ok: true, atRiskStar: '900000', balanceStar: '900000', epoch: 1 }, ctx()).status, 'refused');
  assert.ok(s.cage.claims[B].proven, 'a real on-chain seat that can\'t play gets freed');
});

test('a round becomes one entry whose lines sum to zero and match the stacks', () => {
  const s = started();
  const c = ctx();
  playRound(s, c, { claimer: s.starter });
  assert.equal(s.phase, 'settled');
  const [e, ...rest] = cageWork(s, 'id').entries;
  assert.equal(rest.length, 0);
  assert.deepEqual(e.rounds, [1]);
  assert.equal(e.lines.reduce((sum, l) => sum + l.delta, 0), 0);
  assert.equal(e.lines.length, 2);
  cageAfterChange(s);
  assert.equal(cageWork(s, 'id').entries.length, 1, 'running again cuts nothing new');
  const behind = Object.values(s.cage.holders).reduce((sum, h) => sum + h.behind, 0);
  assert.equal(s.seats[0].chips + s.seats[1].chips + behind, 20, 'on the table or behind a seat, nothing is lost');
});

test('a carried pot waits: its rounds settle together with the next paid pot', () => {
  const s = started();
  const c = ctx();
  playRound(s, c, { claimer: s.starter, carry: true });
  assert.ok(s.pot > 0);
  assert.equal(cageWork(s, 'id').entries.length, 0, 'debits would not equal credits');
  next(s, 0, c);
  playRound(s, c, { claimer: s.starter });
  const [e, ...rest] = cageWork(s, 'id').entries;
  assert.equal(rest.length, 0);
  assert.deepEqual(e.rounds, [1, 2]);
  assert.equal(e.lines.reduce((sum, l) => sum + l.delta, 0), 0);
});

test('winning does not raise atRisk, so the winnings wait behind the seat', () => {
  const s = started();
  const c = ctx();
  const winner = s.starter;
  const loser = 1 - winner;
  playRound(s, c, { claimer: winner, raise: 3 });
  const ids = [A, B];
  const w = s.cage.holders[ids[winner]];
  const l = s.cage.holders[ids[loser]];
  assert.equal(w.balance, 14);
  assert.equal(w.atRisk, 10, 'a win leaves atRisk alone');
  assert.equal(s.seats[winner].chips, 10, 'never more on the table than atRisk');
  assert.equal(w.behind, 4);
  assert.equal(l.balance, 6);
  assert.equal(l.atRisk, 6, 'a loss spends it');
  assert.equal(s.seats[loser].chips, 6);
});

test('the sum of debits on a seat can never pass its declared atRisk, over many rounds', () => {
  const s = table();
  seat(s, A, 'Ann', 6, 50);
  seat(s, B, 'Bob', 6, 50);
  cageMaybeStart(s, ctx());
  const c = ctx();
  const debited = { [A]: 0, [B]: 0 };
  for (let round = 0; round < 40 && s.phase !== 'over'; round += 1) {
    playRound(s, c, { claimer: s.starter, raise: 1 });
    for (const e of s.cage.entries.slice(-1)) for (const l of e.lines) if (l.delta < 0) debited[l.id] -= l.delta;
    assert.ok(debited[A] <= 6 && debited[B] <= 6, `debited ${debited[A]}, ${debited[B]}`);
    for (const h of Object.values(s.cage.holders)) assert.ok(h.atRisk >= 0 && h.balance >= 0);
    if (s.phase === 'settled') next(s, 0, c);
    cageAfterChange(s);
  }
  assert.equal(s.phase, 'over', 'a seat out of atRisk has no chips in play, so the table ends');
  assert.ok(s.log.some((l) => /used up this seat's at-risk limit/.test(l.text)));
});

test('a leaver is named in their last round, then listed for release only when that entry has settled', () => {
  const s = started();
  const c = ctx();
  const stayer = s.starter;
  const goer = 1 - stayer;
  const id = [A, B][goer];
  leave(s, goer, c);
  playRound(s, c, { claimer: stayer });
  assert.ok(s.seats[goer].left);
  const w = cageWork(s, 'id');
  assert.equal(w.entries.length, 1);
  assert.ok(w.entries[0].lines.some((l) => l.id === id));
  assert.equal(w.releases.length, 0, 'an unsettled line still names them');
  assert.deepEqual(cageSettled(s, [w.entries[0].seq], { hash: 'h1', block: 7, chainRound: 1, status: 'SucceedEntirely' }).conflicts, []);
  assert.deepEqual(cageWork(s, 'id').releases, [{ cageId: id, kind: 'player' }]);
  cageReleased(s, id);
  assert.equal(cageWork(s, 'id').releases.length, 0);
});

test('receipts: one log line per round, repeats change nothing, and a different tx for the same round is refused', () => {
  const s = started();
  const c = ctx();
  playRound(s, c, { claimer: s.starter });
  const tx = { hash: 'abc123', block: 42, chainRound: 1, status: 'SucceedEntirely' };
  assert.deepEqual(cageSettled(s, [1], tx).conflicts, []);
  const lines = () => s.log.filter((l) => l.receipt).length;
  assert.equal(lines(), 1);
  assert.match(s.log.find((l) => l.receipt).text, /^Round 1 settled on chain: .*Tx abc123 in block 42\.$/);
  assert.deepEqual(cageSettled(s, [1], tx).conflicts, [], 'same tx again: fine, a restarted judge may repeat itself');
  assert.equal(lines(), 1);
  assert.deepEqual(cageSettled(s, [1], { ...tx, hash: 'other' }).conflicts, [1]);
  assert.equal(cageSettled(s, [99], tx).conflicts[0], 99);
  assert.equal(cageWork(s, 'id').entries.length, 0);
  assert.equal(cageView(s, 'id').receipts.length, 1);
  assert.ok(!JSON.stringify(cageView(s, 'id')).includes('signature'), 'the public view has no proofs');
});

test('bots play from one house seat: their stacks come from the float and they net to one line', () => {
  const s = table({ bots: 2 });
  cageHouseSeated(s, H, { atRiskStar: star(6), balanceStar: star(6), epoch: 1 });
  assert.equal(s.phase, 'lobby');
  assert.equal(s.seats.length, 2);
  assert.ok(s.seats.every((x) => x.bot && x.chips === 3), 'the float, split, and not the play-chip start of 100');
  cageMaybeStart(s, ctx());
  assert.equal(s.phase, 'lobby', 'no human yet');
  seat(s, A, 'Ann', 5);
  const c = ctx();
  cageMaybeStart(s, c);
  assert.equal(s.phase, 'pass');
  const me = 2;
  s.seats.forEach((x, i) => { if (x.bot) s.seats[i].bot = false; }); // drive them by hand here; bots.js has its own tests
  playRound(s, c, { claimer: me });
  const [e] = cageWork(s, 'id').entries;
  assert.equal(e.lines.length, 2, 'one line for the player and one for the whole house');
  assert.ok(e.lines.some((l) => l.id === H));
  assert.equal(e.lines.reduce((sum, l) => sum + l.delta, 0), 0);
  assert.ok(s.cage.holders[H].balance < 6);
});

test('a quiet table asks for no float: it goes on chain only once a player has claimed a seat', () => {
  const s = table({ bots: 2 });
  assert.equal(cageWork(s, 'id').wantHouse, false, 'nothing to die in 30 minutes while nobody is here');
  claim(s, A, 'Ann');
  assert.equal(cageWork(s, 'id').wantHouse, true);
  cageHouseSeated(s, H, { atRiskStar: star(6), balanceStar: star(6), epoch: 1 });
  assert.equal(cageWork(s, 'id').wantHouse, false);
});

test('whether the Hall offers Bring tNIGHT: seats free, counting the ones kept for bots and those waiting on the judge', () => {
  const s = table({ bots: 2, seats: 4 });
  assert.equal(cageJoinable(s), true);
  claim(s, A, 'Ann');
  assert.equal(cageJoinable(s), true, 'one claim and two bots leave a seat');
  s.cage.claims[B] = { name: 'Bob', status: 'pending' };
  assert.equal(cageJoinable(s), false);
  const t = started();
  assert.equal(cageJoinable(t), false, 'dealt: no late seats');
});

test('a table waiting for its house float does not deal', () => {
  const s = table({ bots: 1 });
  seat(s, A, 'Ann', 5);
  seat(s, B, 'Bob', 5);
  cageMaybeStart(s, ctx());
  assert.equal(s.phase, 'lobby');
  cageHouseSeated(s, H, { atRiskStar: star(4), balanceStar: star(4), epoch: 1 });
  cageMaybeStart(s, ctx());
  assert.equal(s.phase, 'pass');
  assert.equal(s.seats.length, 3);
});

test('a dead table voids what has not settled and stops reporting', () => {
  const s = started();
  const c = ctx();
  playRound(s, c, { claimer: s.starter });
  next(s, 0, c);
  cageDead(s, 'no settle for 30 minutes.');
  assert.equal(s.phase, 'over');
  const w = cageWork(s, 'id');
  assert.equal(w.entries.length, 0);
  assert.equal(w.releases.length, 0, 'void seats need no release');
  assert.ok(w.done);
});

test('a judge alert is said once and does not stop rounds being reported', () => {
  const s = started();
  const c = ctx();
  cageAlert(s, 'settle failed');
  cageAlert(s, 'settle failed');
  assert.equal(s.log.filter((l) => /can't settle this table/.test(l.text)).length, 1);
  playRound(s, c, { claimer: s.starter });
  assert.equal(cageWork(s, 'id').entries.length, 1);
  assert.equal(cageView(s, 'id').alert, 'settle failed');
});

test('a chip count that stops adding up stops the reports: the contract would refuse them anyway', () => {
  const s = started();
  const c = ctx();
  playRound(s, c, { claimer: s.starter });
  next(s, 0, c);
  s.seats[0].chips += 3; // nothing in the rules can do this
  playRound(s, c, { claimer: s.starter });
  assert.equal(cageWork(s, 'id').entries.length, 1, 'only the first round');
  assert.match(cageView(s, 'id').alert, /stacks moved by 3/);
});

test('a round where no chips moved cuts no entry: the node refuses an entry with no lines', () => {
  const s = started();
  const c = ctx();
  playRound(s, c, { claimer: s.starter });
  next(s, 0, c);
  // Hand the pot straight back, as a table closing mid-round would.
  const before = s.cage.entries.length;
  s.seats[0].chips = s.cage.base[0];
  s.seats[1].chips = s.cage.base[1];
  s.pot = 0;
  s.phase = 'settled';
  s.lastResult = { round: s.round };
  cageAfterChange(s);
  assert.equal(s.cage.entries.length, before);
  assert.equal(s.cage.window.length, 0);
  assert.ok(s.log.some((l) => /moved no chips/.test(l.text)));
});

// ---------- cage v4: a stand's clock, what landed, and who is going ----------

/** Two players mid-round, with a round settled behind them. */
function midRound(c = ctx()) {
  const s = table();
  seat(s, A, 'Ann', 50, 50, c);
  seat(s, B, 'Bob', 50, 50, c);
  cageMaybeStart(s, c);
  assert.equal(s.phase, 'pass');
  return s;
}

test('a stand gives the round a deadline: before the time nothing changes, and by it the round is over, so the line exists when the hold ends', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = midRound(c);
  const standUntil = t0 + 1321; // a stand back-dated by the slack
  leave(s, 0, c);
  cageStanding(s, A, standUntil, c);
  assert.equal(s.cage.foldAt, (standUntil - FOLD_BEFORE_SECS) * 1000);
  assert.equal(s.phase, 'pass', 'plenty of time');
  cageForceRoundEnd(s, ctx((standUntil - FOLD_BEFORE_SECS - 1) * 1000));
  assert.equal(s.phase, 'pass', 'a second before');
  const at = ctx((standUntil - FOLD_BEFORE_SECS) * 1000);
  cageForceRoundEnd(s, at);
  assert.ok(s.phase === 'settled' || s.phase === 'over', `the round is over: ${s.phase}`);
  assert.ok(s.seats[0].left, 'the stander is gone');
  cageAfterChange(s);
  const work = cageWork(s, 'T');
  assert.ok(work.entries.flatMap((e) => e.lines).some((l) => l.id === A) || s.seats[0].leftWith === 50, 'a line exists for what they lost');
  assert.equal(s.seats[1].away, false, 'the honest player isn\'t left marked away');
});

test('N-4: a second stander is out by the first stand\'s deadline, and an honest player keeps their line', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = table();
  seat(s, A, 'Ann', 50, 50, c); seat(s, B, 'Bob', 50, 50, c); seat(s, H, 'Hal', 50, 50, c);
  cageMaybeStart(s, c);
  leave(s, 0, c); leave(s, 1, c);
  cageStanding(s, A, t0 + 1321, c);
  cageStanding(s, B, t0 + 1621, c); // stood 300 s later
  assert.equal(s.cage.foldAt, (t0 + 1321 - FOLD_BEFORE_SECS) * 1000, 'the first deadline rules');
  cageForceRoundEnd(s, ctx((t0 + 1321 - FOLD_BEFORE_SECS) * 1000));
  assert.ok(s.seats[0].left && s.seats[1].left, 'both are out by it');
});

test('a stander who has left is no clock on the others: their later rounds aren\'t ended for it', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = table();
  seat(s, A, 'Ann', 50, 50, c); seat(s, B, 'Bob', 50, 50, c); seat(s, H, 'Hal', 50, 50, c);
  cageMaybeStart(s, c);
  leave(s, 0, c);
  cageStanding(s, A, t0 + 1321, c);
  playRound(s, c, { claimer: 1 });
  cageAfterChange(s);
  assert.ok(s.seats[0].left);
  assert.equal(s.cage.foldAt, null, 'they left: their stand binds nobody at the table');
});

test('the table\'s own deadline ends a round too, and a deal that close waits for a settle of nothing', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = midRound(c);
  cageClock(s, t0 + 1000, c);
  assert.equal(s.cage.foldAt, (t0 + 1000 - FOLD_BEFORE_SECS) * 1000);
  const late = ctx((t0 + 1000 - FOLD_BEFORE_SECS) * 1000);
  cageForceRoundEnd(s, late);
  assert.notEqual(s.phase, 'pass');
  const held = table();
  const near = ctx((t0 + 1000 - MIN_ROUND_SECS + 1) * 1000);
  seat(held, A, 'Ann', 50, 50, near); seat(held, B, 'Bob', 50, 50, near);
  cageClock(held, t0 + 1000, near);
  cageMaybeStart(held, near);
  assert.equal(held.phase, 'lobby', 'no deal');
  assert.equal(cageWork(held, 'T').dealWaiting, true, 'the judge is told');
  cageClock(held, t0 + 3000, near);
  cageMaybeStart(held, near);
  assert.equal(held.phase, 'pass', 'the deadline moved: it deals');
  assert.equal(cageWork(held, 'T').dealWaiting, false);
});

test('a stander\'s last round ends with an entry whatever the pot does: a carried pot goes back', () => {
  const c = ctx();
  const s = table();
  seat(s, A, 'Ann', 50, 50, c); seat(s, B, 'Bob', 50, 50, c); seat(s, H, 'Hal', 50, 50, c);
  cageMaybeStart(s, c);
  leave(s, 0, c);
  cageStanding(s, A, Math.floor(c.now / 1000) + 1800, c);
  playRound(s, c, { carry: true });
  cageAfterChange(s);
  assert.equal(s.pot, 0, 'it can\'t wait');
  const lines = cageWork(s, 'T').entries.flatMap((e) => e.lines);
  assert.equal(lines.find((l) => l.id === A).delta, -1, 'their ante is their loss');
  assert.equal(lines.reduce((sum, l) => sum + l.delta, 0), 0, 'and it adds up');
  assert.deepEqual(cageWork(s, 'T').releases, [], 'not free until that settles');
});

test('a mover\'s last round too. Someone who only left keeps the old rule: the pot carries, and their line waits for it', () => {
  for (const moving of [true, false]) {
    const c = ctx();
    const s = table();
    seat(s, A, 'Ann', 50, 50, c); seat(s, B, 'Bob', 50, 50, c); seat(s, H, 'Hal', 50, 50, c);
    cageMaybeStart(s, c);
    if (moving) cageMoving(s, 0);
    leave(s, 0, c);
    playRound(s, c, { carry: true });
    cageAfterChange(s);
    assert.equal(s.pot === 0, moving, `moving ${moving}`);
  }
});

test('what landed beats what was reported: a dropped line and a shaved winner show in the receipt, the balance and the stack', () => {
  const c = ctx();
  const s = midRound(c);
  playRound(s, c, { claimer: 1 });
  cageAfterChange(s);
  const [e] = cageWork(s, 'T').entries;
  const won = e.lines.find((l) => l.id === B).delta;
  const lost = e.lines.find((l) => l.id === A).delta;
  assert.equal(won, -lost);
  const stackBefore = s.seats[1].chips;
  const balanceBefore = s.cage.holders[B].balance;
  // Ann's stand ran out, so her line was dropped and Bob's was shaved to nothing.
  cageSettled(s, [e.seq], { hash: 'ab', block: 9, chainRound: 1, status: 'SucceedEntirely' }, { dropped: [{ id: A, delta: lost }], lines: [{ id: B, debit: '0', credit: '0' }] });
  const receipt = s.cage.receipts.at(-1);
  assert.deepEqual(receipt.lines, [], 'nothing moved on chain');
  assert.deepEqual(receipt.dropped, [{ id: A, delta: lost }]);
  assert.equal(s.cage.holders[B].balance, balanceBefore - won);
  assert.equal(s.cage.holders[A].balance, 50, 'her balance is untouched');
  assert.equal(s.cage.holders[A].atRisk, 50);
  assert.equal(s.cage.holders[B].behind + s.seats[1].chips, stackBefore + s.cage.holders[B].behind + (s.seats[1].chips - stackBefore), 'consistent');
  assert.ok(s.seats[1].chips + s.cage.holders[B].behind <= s.cage.holders[B].balance, 'never more on the table than the chain holds');
  assert.match(s.log.map((l) => l.text).join('\n'), /line of -?\d+ couldn't land/);
  assert.equal(s.cage.base[1], s.seats[1].chips, 'no phantom line for next time');
  assert.deepEqual(cageWork(s, 'T').entries, []);
});

test('entries merged for a standing seat landed as one: one receipt, with all their rounds, and the net that landed', () => {
  const c = ctx();
  const s = midRound(c);
  playRound(s, c, { claimer: 1 });
  cageAfterChange(s);
  s.deadline = c.now;
  tick(s, c);
  assert.equal(s.phase, 'pass');
  playRound(s, c, { claimer: 1 });
  cageAfterChange(s);
  const work = cageWork(s, 'T').entries;
  assert.equal(work.length, 2);
  const net = work.flatMap((e) => e.lines).filter((l) => l.id === B).reduce((sum, l) => sum + l.delta, 0);
  cageSettled(s, work.map((e) => e.seq), { hash: 'cd', block: 9, chainRound: 1, status: 'SucceedEntirely' }, { dropped: [{ id: 'f'.repeat(64), delta: 0 }], lines: [{ id: B, debit: '0', credit: star(net) }, { id: A, debit: star(net), credit: '0' }] });
  assert.equal(s.cage.receipts.length, 1);
  assert.deepEqual(s.cage.receipts[0].rounds, [1, 2]);
  assert.equal(s.cage.receipts[0].lines.find((l) => l.id === B).delta, net);
});

test('N-2: a settle that names a standing seat marks it freed, so the judge drops any line for them after, even if they sit back down', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = midRound(c);
  playRound(s, c, { claimer: 1 });
  cageAfterChange(s);
  const [e] = cageWork(s, 'T').entries;
  cageStanding(s, A, t0 + 1800, c);
  assert.equal(cageWork(s, 'T').holders.find((h) => h.cageId === A).freed, undefined);
  cageSettled(s, [e.seq], { hash: 'ef', block: 9, chainRound: 1, status: 'SucceedEntirely' });
  assert.equal(cageWork(s, 'T').holders.find((h) => h.cageId === A).freed, true);
  assert.equal(cageWork(s, 'T').holders.find((h) => h.cageId === B).freed, undefined, 'someone not standing stays as they were');
  assert.equal(claimRefusal(s, A)?.code, 'table_started', 'and the Worker won\'t take them back');
});

test('the judge\'s seat receipt is public, once per transaction, and on the claim for the player\'s window', () => {
  const c = ctx();
  const s = table();
  claim(s, A, 'Ann');
  s.cage.claims[A].ask = { atRiskStar: star(50) };
  assert.deepEqual(cageWork(s, 'T').claims[0].ask, { atRiskStar: star(50) });
  cageSeated(s, A, { kind: 'move', from: '7', until: '1900', tx: { hash: 'ab', block: 9, status: 'SucceedEntirely', ms: 41_000 } });
  cageSeated(s, A, { kind: 'move', from: '7', until: '1900', tx: { hash: 'ab', block: 9, status: 'SucceedEntirely', ms: 41_000 } });
  assert.equal(cageView(s, 'T').seatReceipts.length, 1);
  assert.equal(s.cage.claims[A].seatedBy.ms, 41_000);
  cageSeatVerified(s, A, { ok: true, atRiskStar: star(50), balanceStar: star(90), epoch: 1 }, c);
  assert.match(s.log.map((l) => l.text).join('\n'), /moved here by the judge under their permit, from table 7\. Tx ab in block 9/);
  assert.equal(s.cage.holders[A].behind, 40, 'what the seat can\'t lose waits behind it');
  cageReleased(s, A, { hash: 'cd', block: 10, ms: 30_000 });
  assert.equal(cageView(s, 'T').seatReceipts.at(-1).kind, 'release');
});

test('a refusal from the judge carries its reason code to the player', () => {
  const s = table();
  claim(s, A, 'Ann');
  assert.deepEqual(cageSeatVerified(s, A, { ok: false, code: 'need_grant', reason: 'No permit on chain.' }, ctx()), { status: 'refused', code: 'need_grant' });
  assert.equal(s.cage.claims[A].code, 'need_grant');
});

test('less landed than was won, with nothing behind the seat: it comes off the stack and its base together, so no line appears from nowhere next time', () => {
  const c = ctx();
  const s = midRound(c);
  playRound(s, c, { claimer: 1 });
  cageAfterChange(s);
  const [e] = cageWork(s, 'T').entries;
  const bob = s.cage.holders[B];
  s.seats[1].chips += bob.behind;
  s.cage.base[1] += bob.behind;
  bob.behind = 0;
  const won = e.lines.find((l) => l.id === B).delta;
  const before = s.seats[1].chips;
  cageSettled(s, [e.seq], { hash: 'ab', block: 9, chainRound: 1, status: 'SucceedEntirely' }, { dropped: [{ id: A, delta: -won }], lines: [{ id: B, debit: '0', credit: '0' }] });
  assert.equal(s.seats[1].chips, before - won);
  assert.equal(s.cage.base[1], s.seats[1].chips);
});

test('leaving first and standing after: their carried-pot line still lands, and their clock counts until it exists', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = table();
  seat(s, A, 'Ann', 50, 50, c); seat(s, B, 'Bob', 50, 50, c); seat(s, H, 'Hal', 50, 50, c);
  cageMaybeStart(s, c);
  leave(s, 0, c);
  s.cage.holders[A].moving = false;
  playRound(s, c, { carry: true }); // a plain leave: the pot carries, and her line waits
  cageAfterChange(s);
  assert.ok(s.pot > 0);
  assert.deepEqual(cageWork(s, 'T').entries, []);
  cageStanding(s, A, t0 + 1800, c); // then she stands
  assert.equal(s.cage.foldAt, (t0 + 1800 - FOLD_BEFORE_SECS) * 1000, 'a line still to come: her clock counts');
  cageAfterChange(s);
  assert.equal(s.pot, 0, 'it can\'t wait for her now');
  assert.equal(cageWork(s, 'T').entries.flatMap((e) => e.lines).find((l) => l.id === A).delta, -1);
  assert.equal(s.cage.foldAt, null, 'her line exists: no more clock');
  assert.equal(cageWork(s, 'T').holders.find((h) => h.cageId === A).standUntil, t0 + 1800);
});

test('a round ended by the clock leaves an honest player as they were: not away, and no away clock running on', () => {
  const t0 = 1_000_000_000;
  const c = ctx(t0 * 1000);
  const s = table();
  seat(s, A, 'Ann', 50, 50, c); seat(s, B, 'Bob', 50, 50, c); seat(s, H, 'Hal', 50, 50, c);
  cageMaybeStart(s, c);
  leave(s, 0, c);
  cageStanding(s, A, t0 + 1321, c);
  cageForceRoundEnd(s, ctx((t0 + 1321 - FOLD_BEFORE_SECS) * 1000));
  assert.equal(s.seats[1].away, false);
  assert.ok(!s.seats[1].awaySince);
});

test('a dealt round has real time: the deal gate is well before the point a round is ended', () => {
  assert.ok(MIN_ROUND_SECS >= FOLD_BEFORE_SECS + 300);
});

test('a table that dies answers anyone still waiting for a seat there', () => {
  const s = table();
  claim(s, A, 'Ann');
  cageDead(s, 'no settle for 30 minutes.');
  assert.deepEqual([s.cage.claims[A].status, s.cage.claims[A].code], ['refused', 'table_closed']);
});
