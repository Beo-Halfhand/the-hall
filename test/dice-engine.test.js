import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, HOUSE_NAME, RuleError, act, addChips, autoAction, createTable, startRound, currentTurn, join, leave, legalActions, nextStandAt, privateView, publicView, raiseRoom, roundCap, tick, totalDice } from '../src/games/cup-and-claim/engine.js';
import { commitHouse, commitSeed, countFace, rollDice, sha256, toHex, verifyShown } from '../src/games/cup-and-claim/fair.js';
import { compareBids, labelBid, nextBidAbove, normalizeBid } from '../src/games/cup-and-claim/dice.js';
import { worstRound } from '../scripts/dice-round-cap.js';
import { makeRng } from './helpers.js';

const ctx = (now = 1000) => ({ now, rng: makeRng(7) });
const c = ctx();

/** Four humans, dealt. Dice may be overwritten by the test. */
function table({ dice, cfg = {}, names = ['Ann', 'Bo', 'Cy', 'Di'] } = {}) {
  const s = createTable({ lobbyMs: 60_000, seats: names.length, ...cfg });
  for (const name of names) join(s, name, c);
  assert.equal(s.phase, 'bid');
  assert.equal(s.round, 1);
  if (dice) s.dice = dice;
  return s;
}

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof RuleError, `expected a RuleError, got ${e}`);
    return e.code;
  }
  return null;
};

const total = (s) => s.seats.reduce((sum, x) => sum + x.chips, s.pot);
const bid = (s, seat, count, face, raise) => act(s, seat, { action: 'bid', count, face, ...(raise ? { raise } : {}) }, c);

// ---------- fair dice ----------

test('fair: sha256 matches a known vector, dice are 1..6 and repeatable, commitments verify', () => {
  assert.equal(toHex(sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const house = 'aa'.repeat(32);
  const seed = 'bb'.repeat(32);
  const dice = rollDice(house, seed, 2, 7);
  assert.equal(dice.length, 5);
  assert.ok(dice.every((d) => d >= 1 && d <= 6));
  assert.deepEqual(rollDice(house, seed, 2, 7), dice, 'same seeds, same dice');
  assert.notDeepEqual(rollDice(house, seed, 3, 7), dice, 'another seat rolls differently');
  assert.notDeepEqual(rollDice(house, seed, 2, 8), dice, 'another round rolls differently');
  assert.ok(verifyShown({ houseSeed: house, houseCommit: commitHouse(house), seed, commit: commitSeed(seed), seat: 2, round: 7, dice }));
  assert.ok(!verifyShown({ houseSeed: house, houseCommit: commitHouse(house), seed, commit: commitSeed(seed), seat: 2, round: 7, dice: [...dice.slice(1), 1] }), 'changed dice fail');
  assert.ok(!verifyShown({ houseSeed: house, houseCommit: commitHouse('cc'.repeat(32)), seed, commit: commitSeed(seed), seat: 2, round: 7, dice }), 'a house seed that was not committed fails');
  assert.equal(countFace([1, 5, 5, 2, 1], 5), 4, '1s are wild');
  assert.equal(countFace([1, 5, 5, 2, 1], 2), 3);
});

test('fair: over many rolls every face comes up about one sixth of the time', () => {
  const rng = makeRng(3);
  const seen = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 2000; i++) {
    const house = toHex(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256)));
    const seed = toHex(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256)));
    for (const d of rollDice(house, seed, i % 6, i)) seen[d] += 1;
  }
  for (let face = 1; face <= 6; face++) assert.ok(Math.abs(seen[face] / 10000 - 1 / 6) < 0.015, `face ${face}: ${seen[face]}`);
});

// ---------- bids ----------

test('bids: normalise, compare, next, label', () => {
  assert.deepEqual(normalizeBid({ count: 3, face: 5 }), { count: 3, face: 5 });
  assert.equal(normalizeBid({ count: 3, face: 1 }), null, 'nobody bids on 1s');
  assert.equal(normalizeBid({ count: 0, face: 2 }), null);
  assert.equal(normalizeBid({ count: 2.5, face: 2 }), null);
  assert.ok(compareBids({ count: 3, face: 2 }, { count: 2, face: 6 }) > 0, 'count first');
  assert.ok(compareBids({ count: 3, face: 4 }, { count: 3, face: 2 }) > 0, 'then face');
  assert.deepEqual(nextBidAbove(null), { count: 1, face: 2 });
  assert.deepEqual(nextBidAbove({ count: 2, face: 6 }), { count: 3, face: 2 });
  assert.deepEqual(nextBidAbove({ count: 2, face: 3 }), { count: 2, face: 4 });
  assert.equal(labelBid({ count: 3, face: 5 }), 'at least 3 fives');
  assert.equal(labelBid({ count: 1, face: 6 }), 'at least 1 six');
});

// ---------- the deal ----------

test('deal: ante 5 each, five sealed dice each, commitments public, seat 0 opens', () => {
  const s = table();
  assert.equal(s.pot, 20);
  assert.equal(totalDice(s), 20);
  assert.equal(currentTurn(s), 0);
  for (const seat of [0, 1, 2, 3]) {
    assert.equal(s.dice[seat].length, 5);
    assert.equal(s.commits[seat], commitSeed(s.seeds[seat]));
    assert.ok(verifyShown({ houseSeed: s.houseSeed, houseCommit: s.houseCommit, seed: s.seeds[seat], commit: s.commits[seat], seat, round: 1, dice: s.dice[seat] }));
  }
  const view = publicView(s);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(s.houseSeed), 'the house seed is sealed until the round ends');
  for (const seed of s.seeds) assert.ok(!text.includes(seed), 'player seeds never leave');
  assert.ok(!/"dice":\[/.test(text), 'no dice in the public view');
  assert.equal(view.fair.houseCommit, s.houseCommit);
  assert.deepEqual(view.fair.commits, s.commits);
  assert.equal(view.fair.opened, null);
  assert.equal(view.seats[0].cup, 5);
  const me = privateView(s, 1);
  assert.deepEqual(me.dice, s.dice[1]);
  assert.equal(me.counts[5], countFace(s.dice[1], 5));
  assert.equal(me.legal.length, 0, 'not seat 1’s turn');
  const opener = privateView(s, 0).legal;
  assert.deepEqual(opener.map((a) => a.action), ['bid'], 'the opener can only bid: nothing to call or fold from');
  assert.deepEqual(opener[0].lowest, { count: 1, face: 2 });
  assert.equal(opener[0].maxCount, 20);
  assert.equal(opener[0].raise.max, 25);
});

test('bid: must beat the standing bid; the turn goes round; wrong seat, bad bids and bids past the dice are refused', () => {
  const s = table();
  assert.equal(code(() => bid(s, 1, 1, 2)), 'not_your_turn');
  assert.equal(code(() => bid(s, 0, 1, 1)), 'bad_bid');
  assert.equal(code(() => bid(s, 0, 21, 2)), 'bad_bid');
  bid(s, 0, 2, 4);
  assert.deepEqual(publicView(s).bid, { seat: 0, count: 2, face: 4, label: 'at least 2 fours' });
  assert.equal(currentTurn(s), 1);
  assert.equal(code(() => bid(s, 1, 2, 4)), 'bid_too_low');
  assert.equal(code(() => bid(s, 1, 2, 3)), 'bid_too_low');
  assert.equal(code(() => bid(s, 1, 1, 6)), 'bid_too_low');
  bid(s, 1, 2, 5);
  bid(s, 2, 3, 2);
  bid(s, 3, 3, 3);
  assert.equal(currentTurn(s), 0, 'back to the opener, who now faces seat 3’s bid');
  assert.equal(code(() => act(s, 0, { action: 'liar' }, c)), null);
  assert.equal(s.phase, 'duel');
  assert.equal(total(s), 400);
});

test('raise: paid by the raiser, owed by everyone else until they bid; folding or calling Liar never pays it', () => {
  const s = table();
  bid(s, 0, 1, 2, 10);
  assert.equal(s.pot, 30);
  assert.equal(s.seats[0].chips, 85);
  assert.deepEqual(publicView(s).seats.map((x) => x.owed), [0, 10, 10, 10]);
  const legal1 = legalActions(s, 1);
  assert.equal(legal1.find((a) => a.action === 'bid').owed, 10);
  assert.equal(legal1.find((a) => a.action === 'liar').cost, 0);
  bid(s, 1, 1, 3); // matches 10
  assert.equal(s.pot, 40);
  assert.equal(s.seats[1].chips, 85);
  assert.deepEqual(publicView(s).seats.map((x) => x.owed), [0, 0, 10, 10]);
  act(s, 2, { action: 'fold' }, c);
  assert.equal(s.seats[2].chips, 95, 'a fold costs nothing more');
  assert.equal(s.status[2], 'folded');
  assert.equal(currentTurn(s), 3);
  bid(s, 3, 1, 4, 5); // matches 10, raises 5
  assert.equal(s.seats[3].chips, 80);
  assert.deepEqual(publicView(s).seats.map((x) => x.owed), [5, 5, 0, 0], 'the folded seat owes nothing');
  assert.equal(currentTurn(s), 0);
  act(s, 0, { action: 'liar' }, c);
  assert.equal(s.seats[0].chips, 85, 'calling Liar is free by default');
  assert.equal(total(s), 400);
});

test('raise: capped by the raise limit, the chips, and the pot limit, which counts what everyone still in would owe', () => {
  const s = table();
  assert.deepEqual(raiseRoom(s, 0), { max: 25, potLimitReached: false, limitedBy: 'raise' });
  assert.equal(code(() => bid(s, 0, 1, 2, 26)), 'bad_raise');
  assert.equal(code(() => bid(s, 0, 1, 2, -1)), 'bad_raise');
  s.seats[0].chips = 8;
  assert.equal(raiseRoom(s, 0).max, 8);
  assert.equal(raiseRoom(s, 0).limitedBy, 'chips');
  assert.equal(code(() => bid(s, 0, 1, 2, 9)), 'bad_raise');

  // Near the pot limit: a raise must fit even if every active seat matched it.
  const t = table();
  t.pot = 460;
  assert.equal(raiseRoom(t, 0).max, 10, '(500 − 460) / 4 seats');
  assert.equal(raiseRoom(t, 0).limitedBy, 'pot');
  bid(t, 0, 1, 2, 10);
  assert.equal(t.pot, 470);
  const room = raiseRoom(t, 1);
  assert.equal(room.max, 0, '470 + 3 × 10 owed = 500: full');
  assert.ok(room.potLimitReached);
  assert.equal(code(() => bid(t, 1, 1, 3, 1)), 'pot_limit');
  assert.equal(legalActions(t, 1).find((a) => a.action === 'bid').raise.potLimitReached, true);
  bid(t, 1, 1, 3);
  bid(t, 2, 1, 4);
  bid(t, 3, 1, 5);
  assert.equal(t.pot, 500, 'matches fill the pot to the limit and no further');
  assert.equal(raiseRoom(t, 0).max, 0);
});

test('short stack: can’t bid without the chips to match; may fold or call Liar', () => {
  const s = table();
  bid(s, 0, 1, 2, 25);
  s.seats[1].chips = 10;
  assert.deepEqual(legalActions(s, 1).map((a) => a.action), ['liar', 'fold']);
  assert.equal(code(() => bid(s, 1, 1, 3)), 'short_stack');
  act(s, 1, { action: 'liar' }, c);
  assert.equal(s.phase, 'duel');
});

test('liarCostsMatch: a table setting that makes the call pay the unmatched raise', () => {
  const s = table({ cfg: { liarCostsMatch: true } });
  bid(s, 0, 1, 2, 20);
  assert.equal(legalActions(s, 1).find((a) => a.action === 'liar').cost, 20);
  act(s, 1, { action: 'liar' }, c);
  assert.equal(s.seats[1].chips, 75);
  assert.equal(s.pot, 60);
  const t = table({ cfg: { liarCostsMatch: true } });
  bid(t, 0, 1, 2, 20);
  t.seats[1].chips = 5;
  assert.deepEqual(legalActions(t, 1).map((a) => a.action), ['fold'], 'can’t afford to bid or to call');
  assert.equal(code(() => act(t, 1, { action: 'liar' }, c)), 'short_stack');
});

test('fold: not before the first bid; the last seat standing takes the pot uncontested', () => {
  const s = table();
  assert.equal(code(() => act(s, 0, { action: 'fold' }, c)), 'no_bid');
  assert.equal(code(() => act(s, 0, { action: 'liar' }, c)), 'no_bid');
  bid(s, 0, 1, 2);
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'fold' }, c);
  act(s, 3, { action: 'fold' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.lastResult.kind, 'uncontested');
  assert.equal(s.seats[0].chips, 115);
  assert.equal(total(s), 400);
});

// ---------- the call ----------

/** Seat 0 bids, seat 1 calls Liar. Dice are set so the table holds `fives` fives, wilds counted. */
function duel(dice, count = 4, face = 5) {
  const s = table({ dice: dice.map((d) => d.split(' ').map(Number)) });
  bid(s, 0, count, face);
  act(s, 1, { action: 'liar' }, c);
  assert.equal(s.phase, 'duel');
  return s;
}

test('duel: every cup still in answers; the count is added up with wilds; the bid holds, the caller pays, the others split the caller\'s stake', () => {
  const s = duel(['5 5 2 3 4', '1 6 6 6 6', '5 2 2 2 2', '3 3 3 3 3']); // 2 + 1 wild + 1 = 4 fives
  assert.deepEqual(s.duel.waiting, [0, 1, 2, 3]);
  assert.deepEqual(legalActions(s, 2).map((a) => a.action), ['reveal']);
  assert.equal(code(() => act(s, 0, { action: 'reveal', mode: 'maybe' }, c)), 'bad_mode');
  act(s, 0, { action: 'reveal', mode: 'prove' }, c);
  assert.equal(code(() => act(s, 0, { action: 'reveal', mode: 'show' }, c)), 'already_chosen');
  act(s, 1, { action: 'reveal', mode: 'show' }, c);
  assert.equal(s.seats[1].rep.open, 1, 'showing earns an open-hand mark');
  assert.equal(s.seats[0].rep.open, 0);
  const mid = publicView(s);
  assert.deepEqual(mid.duel.modes, { 0: 'prove', 1: 'show' });
  assert.ok(!/"dice":\[/.test(JSON.stringify(mid)), 'nothing is shown until every cup has answered');
  act(s, 2, { action: 'reveal', mode: 'prove' }, c);
  act(s, 3, { action: 'reveal', mode: 'prove' }, c);
  assert.equal(s.phase, 'settled');
  const { lastDuel } = publicView(s);
  assert.equal(lastDuel.total, 4);
  assert.equal(lastDuel.held, true);
  assert.equal(lastDuel.winner, 0);
  assert.equal(lastDuel.loser, 1, 'the caller lost the call');
  assert.deepEqual(s.lastResult.awards.map((a) => [a.seat, a.amount, a.back, a.share]), [[0, 7, 5, 2], [2, 7, 5, 2], [3, 6, 5, 1]], 'the caller\'s 5 is split three ways, the spare chips going by seat order');
  assert.equal(s.seats[0].chips, 102);
  assert.equal(s.seats[1].chips, 95, 'the caller lost only their stake');
  assert.deepEqual(s.seats[0].rep, { called: 1, proven: 1, caught: 0, open: 0 });
  const shown = lastDuel.reveals.find((r) => r.seat === 1);
  assert.deepEqual(shown.dice, [1, 6, 6, 6, 6]);
  assert.equal(shown.count, 1);
  assert.ok(verifyShown({ houseSeed: lastDuel.houseSeed, houseCommit: lastDuel.houseCommit, seed: shown.seed, commit: shown.commit, seat: 1, round: 1, dice: shown.dice }) === false, 'the test overwrote the dice, so the shown cup no longer matches its seeds');
  for (const seat of [0, 2, 3]) {
    const r = lastDuel.reveals.find((x) => x.seat === seat);
    assert.equal(r.dice, undefined, 'a shut cup shows no dice');
    assert.equal(r.seed, undefined);
    assert.equal(r.proof.kind, 'house-attested');
    assert.equal(r.proof.statement.count, r.count);
    assert.equal(r.proof.statement.face, 5);
  }
  assert.equal(publicView(s).fair.opened, lastDuel.houseSeed, 'the house seed is opened once the round is over');
});

test('duel: a real deal, shown cups verify against the opened house seed', () => {
  const s = table();
  bid(s, 0, 1, 2);
  act(s, 1, { action: 'liar' }, c);
  for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'reveal', mode: 'show' }, c);
  const { lastDuel } = publicView(s);
  for (const r of lastDuel.reveals) {
    assert.ok(verifyShown({ houseSeed: lastDuel.houseSeed, houseCommit: lastDuel.houseCommit, seed: r.seed, commit: r.commit, seat: r.seat, round: 1, dice: r.dice }), `seat ${r.seat} verifies`);
  }
});

test('duel: the bid falls: the bidder pays, the folder forfeits, the others split it and the right caller counts double; folded cups still count and are proven shut', () => {
  const s = table({ dice: ['5 5 2 3 4', '2 6 6 6 6', '5 2 2 2 2', '3 3 3 3 3'].map((d) => d.split(' ').map(Number)) });
  bid(s, 0, 1, 2);
  act(s, 1, { action: 'fold' }, c);
  bid(s, 2, 4, 5); // table has 3 fives
  act(s, 3, { action: 'liar' }, c);
  assert.deepEqual(s.duel.waiting, [0, 2, 3], 'the folded seat has no choice to make');
  for (const seat of [0, 2, 3]) act(s, seat, { action: 'reveal', mode: 'prove' }, c);
  const { lastDuel } = publicView(s);
  assert.equal(lastDuel.total, 3);
  assert.equal(lastDuel.held, false);
  assert.equal(lastDuel.winner, 3);
  const folded = lastDuel.reveals.find((r) => r.seat === 1);
  assert.equal(folded.folded, true);
  assert.equal(folded.mode, 'prove');
  assert.equal(folded.count, 0);
  assert.deepEqual(s.seats[2].rep, { called: 1, proven: 0, caught: 1, open: 0 });
  assert.equal(lastDuel.loser, 2);
  assert.equal(s.lastResult.loserStake, 5);
  assert.equal(s.lastResult.pool, 10, 'the bidder\'s 5 and the folder\'s 5');
  assert.deepEqual(s.lastResult.awards.map((a) => [a.seat, a.amount, a.back, a.share, !!a.bonus]), [[0, 8, 5, 3, false], [3, 12, 5, 7, true]]);
  assert.equal(s.seats[3].chips, 107);
  assert.equal(s.seats[0].chips, 103);
  assert.equal(s.seats[1].chips, 95, 'the folder forfeits');
  assert.equal(s.seats[2].chips, 95);
  assert.equal(total(s), 400);
});

test('pot rule: two players play exactly the old rule, the winner of the call takes the whole pot', () => {
  const s = table({ dice: ['5 5 2 3 4', '2 6 6 6 6', '1 1 1 1 1', '1 1 1 1 1'].map((d) => d.split(' ').map(Number)), names: ['Ann', 'Bo'] });
  bid(s, 0, 9, 5, 4); // a raise of 4, matched
  act(s, 1, { action: 'liar' }, c);
  for (const seat of [0, 1]) act(s, seat, { action: 'reveal', mode: 'prove' }, c);
  assert.equal(s.lastResult.held, false);
  assert.deepEqual(s.lastResult.awards.map((a) => [a.seat, a.amount]), [[1, s.lastResult.pot]], 'one award: the whole pot');
  assert.equal(s.lastResult.pot, 14, 'both antes and the unmatched raise');
  assert.equal(s.seats[1].chips, 109);
  assert.equal(s.seats[0].chips, 91);
});

test('pot rule: a held bid pays the caller\'s loss to the bystanders equally; nobody ever loses more than their stake; chips are conserved', () => {
  const s = table({ dice: ['5 5 5 5 5', '2 2 2 2 2', '3 3 3 3 3', '4 4 4 4 4'].map((d) => d.split(' ').map(Number)) });
  bid(s, 0, 4, 5, 6);
  act(s, 1, { action: 'liar' }, c); // pays nothing extra: liarCostsMatch is off
  for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'reveal', mode: 'prove' }, c);
  const r = s.lastResult;
  assert.equal(r.held, true);
  assert.equal(r.loser, 1);
  assert.equal(r.awards.reduce((n, a) => n + a.amount, 0), r.pot);
  assert.equal(r.awards.find((a) => a.seat === 1), undefined, 'the loser is not paid');
  assert.ok(r.awards.every((a) => !a.bonus), 'a held bid gives the caller no bonus');
  assert.ok(s.seats[1].chips >= 100 - r.loserStake - 1);
  assert.equal(total(s), 400);
});

// ---------- rounds, clocks, away ----------

test('next round: the opener rotates, antes go in, new seeds and commitments', () => {
  const s = table();
  bid(s, 0, 1, 2);
  act(s, 1, { action: 'liar' }, c);
  for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'reveal', mode: 'prove' }, c);
  const firstCommits = [...s.commits];
  const firstHouse = s.houseSeed;
  act(s, 2, { action: 'next' }, c);
  assert.equal(s.round, 2);
  assert.equal(s.starter, 1);
  assert.equal(currentTurn(s), 1);
  assert.equal(s.pot, 20);
  assert.notDeepEqual(s.commits, firstCommits);
  assert.notEqual(s.houseSeed, firstHouse);
  assert.equal(publicView(s).fair.opened, null);
});

test('clock: a seat that times out is marked away and folds (or opens with the lowest bid); in a duel its cup stays shut', () => {
  const s = table();
  assert.deepEqual(autoAction(s, 0), { action: 'bid', count: 1, face: 2 });
  tick(s, ctx(1000 + DEFAULTS.turnMs + 1));
  assert.equal(s.seats[0].away, true);
  assert.deepEqual(s.bid && { count: s.bid.count, face: s.bid.face }, { count: 1, face: 2 });
  assert.equal(currentTurn(s), 1);
  assert.deepEqual(autoAction(s, 1), { action: 'fold' });
  tick(s, ctx(s.deadline + 1));
  assert.equal(s.status[1], 'folded');
  act(s, 2, { action: 'liar' }, ctx(s.deadline - 1));
  assert.equal(s.phase, 'duel');
  tick(s, ctx(s.deadline + 1));
  assert.equal(s.phase, 'settled', 'every cup answered for its absent owner: prove');
  assert.ok(s.lastDuel.reveals.every((r) => r.mode === 'prove'));
  assert.deepEqual(legalActions(s, 0), [{ action: 'back' }]);
});

test('solo: one human against the house has no clock', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  assert.equal(s.seats.length, 4);
  assert.deepEqual(s.seats.slice(1).map((x) => [x.bot, x.name]), [[true, HOUSE_NAME], [true, 'Brannock'], [true, 'Old Wick']]);
  assert.equal(s.deadline, null);
});

test('solo: untouched for 30 minutes, the one seat stands up and the stack goes to the purse (The owner, 11-07), as at Sealed Hand', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  assert.equal(nextStandAt(s), 1000 + 30 * 60_000, 'the alarm knows when');
  assert.equal(tick(s, { ...c, now: 1000 + 30 * 60_000 - 1 }), false);
  assert.equal(tick(s, { ...c, now: 1000 + 30 * 60_000 }), true);
  assert.ok(s.seats[0].left || s.seats[0].leaving, 'stood up, or leaving once the round plays out');
});

test('six seats: five bots fill in, the two new regulars with borrowed looks', () => {
  const s = createTable({ lobbyMs: 0, seats: 6 });
  join(s, 'Ann', c);
  assert.deepEqual(s.seats.map((x) => x.name), ['Ann', HOUSE_NAME, 'Brannock', 'Old Wick', 'Red Mab', 'Sister Ivy']);
  assert.equal(s.seats[4].avatar, 'pirate');
  assert.equal(s.seats[5].avatar, 'mage');
  assert.equal(totalDice(s), 30);
  assert.equal(s.pot, 30);
});

test('leave: between rounds now; during a round after it, and the pot goes back when the last human goes', () => {
  const s = table();
  bid(s, 0, 1, 2, 10);
  const r = leave(s, 2, c);
  assert.equal(r.queued, true);
  assert.equal(s.seats[2].leaving, true);
  act(s, 1, { action: 'liar' }, c);
  for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'reveal', mode: 'prove' }, c);
  assert.equal(s.seats[2].left, true);
  assert.equal(s.departures[0].seat, 2);
  assert.equal(total(s) + s.departures[0].amount, 400);
});

// ---------- the cage ----------

test('max loss: the pot never passes the pot limit, and one seat never loses more than roundCap, which is under 1000', () => {
  for (let seats = 2; seats <= 6; seats++) {
    const { lost, pot, table: s } = worstRound(seats);
    assert.ok(pot <= DEFAULTS.potLimit, `${seats} seats: pot ${pot}`);
    assert.ok(lost <= roundCap(DEFAULTS, seats), `${seats} seats: lost ${lost} vs cap ${roundCap(DEFAULTS, seats)}`);
    assert.ok(roundCap(DEFAULTS, seats) <= 1000);
    assert.ok(s.chipLog.every((m) => m.amount > 0));
  }
  assert.equal(worstRound(2).lost, 250);
});

test('the pot limit is respected along any sequence of raises: random play never pushes the pot past 500', () => {
  const rng = makeRng(11);
  for (let t = 0; t < 40; t++) {
    const s = table({ cfg: { startChips: 10_000 } });
    for (let guard = 0; guard < 400 && s.phase === 'bid'; guard++) {
      const seat = currentTurn(s);
      const legal = legalActions(s, seat);
      const b = legal.find((a) => a.action === 'bid');
      const choice = rng();
      if (b && (choice < 0.8 || legal.length === 1)) {
        const raise = b.raise.max >= 1 && rng() < 0.7 ? 1 + Math.floor(rng() * b.raise.max) : 0;
        const next = nextBidAbove(s.bid);
        if (next.count > totalDice(s)) break;
        bid(s, seat, next.count, next.face, raise);
      } else if (choice < 0.9 && legal.some((a) => a.action === 'fold')) act(s, seat, { action: 'fold' }, c);
      else if (legal.some((a) => a.action === 'liar')) act(s, seat, { action: 'liar' }, c);
      assert.ok(s.pot <= DEFAULTS.potLimit, `pot ${s.pot}`);
    }
  }
});

// ---------- house rebuy ----------

test('house rebuy: between rounds a bot that can’t ante is bought back in to its starting stack, with a line of its own', () => {
  const s = createTable({ lobbyMs: 0, seats: 6 });
  join(s, 'Ann', c);
  assert.equal(s.round, 1);
  s.phase = 'settled';
  for (const seat of [1, 2, 3, 4]) s.seats[seat].chips = 0;
  s.seats[5].chips = 4;
  const ann = s.seats[0].chips;
  const before = s.log.length;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.round, 2);
  assert.deepEqual(s.seats.map((x) => x.chips), [ann - 5, 95, 95, 95, 95, 95], 'every bot back to 100, then antes; the player only antes');
  assert.deepEqual(s.status, ['in', 'in', 'in', 'in', 'in', 'in']);
  assert.equal(totalDice(s), 30);
  assert.equal(s.houseStaked, 4 * 100 + 96);
  assert.equal(publicView(s).houseStaked, 496);
  assert.deepEqual(s.seats.map((x) => x.rebuys ?? 0), [0, 1, 1, 1, 1, 1]);
  const lines = s.log.slice(before);
  assert.deepEqual(lines.filter((l) => l.rebuy).map((l) => [l.seat, l.amount]), [[1, 100], [2, 100], [3, 100], [4, 100], [5, 96]]);
  assert.equal(lines.find((l) => l.rebuy).text, `${HOUSE_NAME} is down to 0 chips. The house buys ${HOUSE_NAME} back in with 100.`);
  assert.deepEqual(lines.filter((l) => l.say).map((l) => [l.name, l.text]), [
    [HOUSE_NAME, 'House buys me back in.'],
    ['Brannock', 'Ha! The house stakes me again. Pour another!'],
    ['Old Wick', 'Hm. The house puts more iron in my hand.'],
    ['Red Mab', 'The house refloats me. Back to the tide, lads.'],
    ['Sister Ivy', 'A small loan from the house. I shall count it carefully.'],
  ]);
  assert.ok(lines.findIndex((l) => l.rebuy) < lines.findIndex((l) => /^Round 2\./.test(l.text)), 'on the record before the deal');
  assert.equal(s.talkQueue.length, 0, 'scripted: not offered to the model');
  assert.ok(!lines.some((l) => l.say && /\d/.test(l.text)), 'a line never carries a number');
});

test('house rebuy: never mid-hand, and never for a player: at a tNIGHT table a broke player still closes it', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  s.cage = { status: 'open' };
  s.seats[0].chips = 0;
  s.seats[1].chips = 0;
  bid(s, 0, 1, 2);
  assert.equal(s.seats[1].chips, 0, 'nothing moves mid-hand');
  assert.equal(s.houseStaked, 0);
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.phase, 'over');
  assert.deepEqual([s.overCode, s.overReason], ['cannot_ante', 'Not enough players to ante.']);
  assert.equal(s.seats[0].chips, 0, 'the player’s chips are never touched');
  assert.equal(s.seats[1].chips, 0, 'no rebuy at a table that is closing');
  assert.ok(!s.log.some((l) => l.rebuy));
});

test('tNIGHT table: a bot that can’t ante stands up between rounds and the seat stays empty; nothing restakes it', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  s.cage = { status: 'open' };
  s.phase = 'settled';
  s.seats[2].chips = 0;
  const before = s.log.length;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.round, 2);
  assert.equal(s.seats[2].left, true);
  assert.equal(s.seats[2].leftWith, 0);
  assert.equal(s.status[2], 'out');
  assert.deepEqual(s.departures, [{ seat: 2, amount: 0 }]);
  assert.equal(s.houseStaked, 0);
  assert.equal(totalDice(s), 15);
  assert.equal(publicView(s).seats[2].left, true);
  const lines = s.log.slice(before);
  assert.ok(!lines.some((l) => l.rebuy || l.say), 'no rebuy, no line');
  assert.equal(lines.find((l) => l.broke)?.text, 'Brannock is down to 0 chips and stands up: the house doesn\'t restake a tNIGHT seat.');
  s.phase = 'settled';
  s.seats[1].chips = 0;
  s.seats[3].chips = 3;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.phase, 'over');
  assert.deepEqual([s.overCode, s.overReason], ['others_out_of_chips', 'The other players ran out of chips.']);
  assert.ok(s.seats.slice(1).every((x) => x.left));
  assert.deepEqual(s.departures.map((d) => [d.seat, d.amount]), [[2, 0], [1, 0], [3, 3]]);
});

test('play chips: a player who is out of chips keeps the table and the last result; Fill up (adding chips) and Next deal them back in', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  s.seats[0].chips = 0;
  bid(s, 0, 1, 2);
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  s.lastResult = { round: s.round, kind: 'settled', pot: 20, awards: [], stakes: [5, 5, 5, 5] };
  const round = s.round;
  act(s, 0, { action: 'next' }, c);
  act(s, 0, { action: 'next' }, c); // pressed again: harmless, and said once
  assert.equal(s.phase, 'settled', 'not closed');
  assert.equal(s.overReason, null);
  assert.equal(s.deadline, null);
  assert.equal(s.round, round, 'no round was dealt');
  assert.equal(s.lastResult.kind, 'settled', 'the result stays');
  assert.equal(s.log.filter((l) => /out of chips/.test(l.text)).length, 1);
  const me = privateView(s, 0);
  assert.equal(me.broke, true);
  assert.equal(me.canFillUp, true);
  addChips(s, 0, 1000, c);
  assert.equal(privateView(s, 0).broke, false);
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.round, round + 1);
  assert.equal(s.phase, 'bid');
  assert.equal(s.seats[0].chips, 995, 'the ante came off the 1,000');
});

test('tNIGHT table: canFillUp is false (the cage owns the chips)', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  s.cage = { status: 'open' };
  s.phase = 'settled';
  assert.equal(privateView(s, 0).canFillUp, false);
});

test('every way a table closes has a code and a plain sentence, in the view and in the log; a play-chip table closes only for some of them', () => {
  const ten = (cfg = {}) => { const s = createTable({ lobbyMs: 0, ...cfg }); join(s, 'Ann', c); return s; };
  const closed = (s) => [s.overCode, s.overReason, s.overRound, publicView(s).overCode, publicView(s).overReason, publicView(s).overRound];
  // everyone left
  const left = ten();
  s_settle(left);
  leave(left, 0, c);
  assert.deepEqual(closed(left), ['everyone_left', 'Everyone else left.', left.round, 'everyone_left', 'Everyone else left.', left.round]);
  assert.ok(left.log.some((l) => l.text === 'Table over: Everyone else left.'));
  // no moves for the idle time (the sentence follows the setting)
  const idle = ten({ idleMs: 45 * 60_000 });
  s_settle(idle);
  startRound(idle, { now: c.now + 46 * 60_000, rng: c.rng });
  assert.deepEqual([idle.overCode, idle.overReason], ['no_human_action', 'No moves for 45 minutes.']);
  const day = ten({ waitingIdleMs: 24 * 3_600_000, awayStandMs: 10 ** 12 }); // (a lone seat would be stood up first)
  s_settle(day);
  day.deadline = null;
  tick(day, { now: c.now + 25 * 3_600_000, rng: c.rng });
  assert.deepEqual([day.overCode, day.overReason], ['no_human_action', 'No moves for 24 hours.']);
  // tNIGHT only: the others ran out of chips; nobody can ante
  const cage = ten();
  cage.cage = { status: 'open' };
  s_settle(cage);
  cage.seats.forEach((x, i) => { x.chips = i === 0 ? 50 : 0; });
  startRound(cage, c);
  assert.deepEqual([cage.overCode, cage.overReason], ['others_out_of_chips', 'The other players ran out of chips.']);
  const none = ten();
  none.cage = { status: 'open' };
  s_settle(none);
  none.seats[0].chips = 0;
  startRound(none, c);
  assert.deepEqual([none.overCode, none.overReason], ['cannot_ante', 'Not enough players to ante.']);
  // play chips: neither of those two closes a table that has dealt
  const chips = ten();
  s_settle(chips);
  chips.seats.forEach((x, i) => { x.chips = i === 0 ? 50 : 0; });
  chips.seats.forEach((x) => { x.bot = false; }); // four people, one of them with chips
  startRound(chips, c);
  assert.notEqual(chips.phase, 'over');
});

test('play chips: a house bot is topped up whenever it is below the mark (botLow), the house stake is always counted, and only a top-up of botLogMin or more gets a log line', () => {
  const s = createTable({ lobbyMs: 0, startChips: 1000, botLow: 1000, botLogMin: 100, potLimit: 4000, raiseLimit: 1000 });
  join(s, 'Ann', c);
  assert.equal(s.seats[1].chips, 1000 - 5, 'house bots sit down with a full stack (less the ante)');
  s_settle(s);
  s.seats[1].chips = 990; // down 10: refilled, silently
  s.seats[2].chips = 400; // down 600: refilled, with a line
  s.seats[3].chips = 1000;
  const before = s.log.length;
  act(s, 0, { action: 'next' }, c);
  assert.deepEqual(s.seats.slice(1).map((x) => x.chips + (x.chips < 1000 ? 5 : 0) >= 995), [true, true, true]);
  assert.equal(s.houseStaked, 610);
  const lines = s.log.slice(before).filter((l) => l.rebuy);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /Brannock|Old Wick/);
  assert.ok(s.seats.every((x) => !x.left));
});

function s_settle(s) {
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  s.deadline = null;
}

test('a seat that left is public as "left" with what it took home, not as 0 chips out (11-10): shown through that round, gone after it', () => {
  const s = table();
  s.phase = 'settled';
  s.seats[0].chips = 1011;
  s.pot = 0;
  s.potIn = [];
  const round = s.round;
  leave(s, 0, c);
  const seat = publicView(s).seats[0];
  assert.equal(seat.status, 'left', 'not "out", which reads as busted');
  assert.equal(seat.left, true);
  assert.equal(seat.leftWith, 1011);
  assert.equal(seat.gone, false, 'still on the list through the round it left in');
  s.round = round + 1;
  assert.equal(publicView(s).seats[0].gone, true, 'a round later the seat list drops it');
  assert.equal(publicView(s).seats[1].gone, false, 'a seat still at the table never drops');
  assert.equal(publicView(s).seats[1].status === 'left', false);
});
