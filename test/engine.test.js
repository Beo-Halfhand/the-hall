import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, HOUSE_NAME, RuleError, act, addChips, autoAction, checkAddChips, createTable as createTableAtDefaults, nextStandAt, roundCap, sitBackDown, currentTurn, isSolo, join, leave, legalActions, privateView, publicView, startRound, tick, topClaim, upgradeState } from '../src/games/sealed-hand/engine.js';

// These tests do their sums at an ante of 1 with no pot limit: stakes are a table setting now, and the defaults have their own tests.
const createTable = (cfg = {}) => createTableAtDefaults({ ante: 1, potLimit: Infinity, ...cfg });
import { PERSONAS, decide, runBots } from '../src/games/sealed-hand/bots.js';
import { calledThenCaught, caughtStopper, raiseLadder, twoCalls, worstRound, worstStop, UNCAPPED } from '../scripts/round-cap.js';
import { LADDER, newDeck, shuffle } from '../src/games/sealed-hand/cards.js';
import { makeRng } from './helpers.js';

const ctx = (now = 1000) => ({ now, rng: makeRng(7) });
const c = ctx();

/** Four humans, dealt, with hands overwritten by the test. */
function table({ hands, cfg = {} } = {}) {
  const s = createTable({ lobbyMs: 60_000, ...cfg });
  for (const name of ['Ann', 'Bo', 'Cy', 'Di']) join(s, name, c);
  assert.equal(s.phase, 'pass');
  assert.equal(s.round, 1);
  if (hands) s.hands = hands.map((h) => h.split(' '));
  return s;
}

const HANDS = ['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c'];
const firstCard = (s, seat) => s.hands[seat][0];

function passAll(s) {
  for (const seat of [0, 1, 2, 3]) if (s.status[seat] === 'in') act(s, seat, { action: 'pass', card: firstCard(s, seat) }, c);
}

/** Nobody stops and every pass goes round, which opens an empty claim lap on the starter: here, `who`. */
function toLap(s, who = 0) {
  s.starter = who;
  while (s.phase === 'pass') passAll(s);
  assert.equal(s.phase, 'claim');
  assert.equal(currentTurn(s), who);
}

/** toLap, then sets the hands the claims will be judged against. */
function lap(handStrings, who = 0, cfg) {
  const s = table({ cfg });
  toLap(s, who);
  s.hands = handStrings.map((h) => h.split(' '));
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

// ---------- setup ----------

test('deal: ante 1 each into the pot, 5 secret cards each, seat 0 starts round 1', () => {
  const s = table();
  assert.equal(s.pot, 4);
  assert.ok(s.seats.every((x) => x.chips === 99));
  assert.ok(s.hands.every((h) => h.length === 5));
  assert.equal(new Set(s.hands.flat()).size, 20);
  assert.equal(s.starter, 0);
});

test('secrecy: the public view never holds a hand, and /me only your own', () => {
  const s = table();
  passAll(s);
  const pub = JSON.stringify(publicView(s));
  for (const card of s.hands.flat()) assert.ok(!pub.includes(`"${card}"`), `${card} in public view`);
  assert.ok(!/hands|passes|tokens|testRng/.test(pub), 'no private field names');
  const me = privateView(s, 1);
  assert.deepEqual(me.hand, s.hands[1]);
  const passedOn = me.passLog.map((entry) => entry.sent); // you know what you gave away, and no more
  for (const seat of [0, 2, 3]) for (const card of s.hands[seat]) if (!passedOn.includes(card)) assert.ok(!JSON.stringify(me).includes(`"${card}"`));
});

// ---------- pass ----------

test('pass: all at once to the next seat, and nothing moves until the last card is in', () => {
  const s = table({ hands: HANDS });
  act(s, 0, { action: 'pass', card: '9c' }, c);
  act(s, 1, { action: 'pass', card: '3c' }, c);
  act(s, 2, { action: 'pass', card: 'Qc' }, c);
  assert.ok(s.hands[0].includes('9c') && s.hands[1].includes('3c'), 'still in the hands before the last pass');
  assert.deepEqual(publicView(s).waitingOn, [3]);
  act(s, 3, { action: 'pass', card: 'Ac' }, c);
  assert.ok(s.hands[1].includes('9c') && !s.hands[0].includes('9c'));
  assert.ok(s.hands[2].includes('3c'));
  assert.ok(s.hands[3].includes('Qc'));
  assert.ok(s.hands[0].includes('Ac'));
  assert.ok(s.hands.every((h) => h.length === 5));
  assert.equal(s.phase, 'pass', 'straight on to the next pass: there is no betting step');
  assert.equal(s.passNo, 2);
});

test('pass: rejects a card you do not hold, a bad card, a second choice', () => {
  const s = table({ hands: HANDS });
  assert.equal(code(() => act(s, 0, { action: 'pass', card: 'Ac' }, c)), 'not_in_hand');
  assert.equal(code(() => act(s, 0, { action: 'pass', card: 'Zz' }, c)), 'bad_card');
  act(s, 0, { action: 'pass', card: '9c' }, c);
  assert.equal(code(() => act(s, 0, { action: 'pass', card: '9d' }, c)), 'already_passed');
});

test('pass: a folded seat is skipped', () => {
  const s = table({ hands: HANDS });
  passAll(s);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 1 }, c);
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'pass', card: firstCard(s, 2), match: true }, c);
  act(s, 3, { action: 'pass', card: firstCard(s, 3), match: true }, c);
  assert.deepEqual(publicView(s).waitingOn, [0, 2, 3]);
  const [a, b, d] = [firstCard(s, 0), firstCard(s, 2), firstCard(s, 3)];
  const bo = s.hands[1].slice();
  passAll(s);
  assert.ok(s.hands[2].includes(a), 'seat 0 passes over the folded seat 1 to seat 2');
  assert.ok(s.hands[3].includes(b));
  assert.ok(s.hands[0].includes(d));
  assert.deepEqual(s.hands[1], bo);
});

test('stop: not until two passes are done, then anyone may, in place of the next pass', () => {
  const s = table();
  assert.ok(!legalActions(s, 0).some((a) => a.action === 'stop'));
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9] }, c)), 'too_early');
  passAll(s);
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9] }, c)), 'too_early');
  passAll(s);
  assert.equal(s.passNo, 3);
  assert.ok(legalActions(s, 2).some((a) => a.action === 'stop'));
  const kept = firstCard(s, 0);
  act(s, 0, { action: 'pass', card: kept }, c); // a card chosen, then someone stops: it stays in the hand
  assert.ok(legalActions(s, 0).some((a) => a.action === 'stop'), 'choosing a card does not use up the stop');
  act(s, 2, { action: 'stop', claim: [1, 9] }, c);
  assert.equal(s.phase, 'claim');
  assert.equal(currentTurn(s), 3, 'the seat after the stopper goes first');
  assert.deepEqual(s.lap.queue, [3, 0, 1], 'the stopper has had their turn');
  assert.deepEqual(s.claims, [{ seat: 2, claim: [1, 9, 0], status: 'standing' }]);
  assert.ok(s.hands[0].includes(kept), 'that pass never happened');
  assert.ok(s.hands.every((h) => h.length === 5));
});

test('max 5 passes, then the starter opens', () => {
  const s = table();
  for (let i = 1; i <= 5; i++) {
    assert.equal(s.phase, 'pass');
    assert.equal(s.passNo, i);
    passAll(s);
  }
  assert.equal(s.phase, 'claim');
  assert.equal(currentTurn(s), s.starter);
});

// ---------- raise ----------

test('raise: 1 to 25, capped at own chips, paid into the pot, and it goes with the pass', () => {
  const s = table();
  passAll(s);
  const card = firstCard(s, 0);
  for (const n of [0, -1, 26, 2.5, '3']) assert.equal(code(() => act(s, 0, { action: 'pass', card, raise: n }, c)), 'bad_raise', `raise=${n}`);
  assert.equal(s.passes[0], null, 'a refused raise leaves the card with you too');
  s.seats[0].chips = 10;
  assert.equal(code(() => act(s, 0, { action: 'pass', card, raise: 11 }, c)), 'bad_raise');
  assert.deepEqual(legalActions(s, 0).find((a) => a.action === 'pass').raise, { min: 1, max: 10 });
  act(s, 0, { action: 'pass', card, raise: 10 }, c);
  assert.equal(s.seats[0].chips, 0);
  assert.equal(s.pot, 14);
  assert.equal(s.passes[0], card);
});

test('raise: a seat facing it matches, raises or folds as its own move, and the plain moves are refused', () => {
  const s = table();
  passAll(s);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 5 }, c);
  assert.deepEqual(publicView(s).waitingOn, [1, 2, 3], 'still all at once');
  const card = firstCard(s, 1);
  assert.equal(code(() => act(s, 1, { action: 'pass', card }, c)), 'must_answer');
  assert.equal(code(() => act(s, 1, { action: 'check' }, c)), 'wrong_phase');
  assert.equal(code(() => act(s, 1, { action: 'raise', n: 2 }, c)), 'wrong_phase', 'no standalone raise');
  assert.equal(code(() => act(s, 1, { action: 'match' }, c)), 'wrong_phase', 'no standalone match');
  assert.equal(code(() => act(s, 1, { action: 'pass', card, raise: 5, match: true }, c)), 'bad_stake', 'a raise already pays what you owe');
  assert.equal(code(() => act(s, 1, { action: 'pass', card, fold: true }, c)), 'bad_stake');
  assert.deepEqual(legalActions(s, 1).map((a) => a.action), ['pass', 'fold']);
  const pass = legalActions(s, 1)[0];
  assert.deepEqual(pass.match, { cost: 5, level: 5 });
  assert.deepEqual(pass.raise, { min: 1, max: 25 });
  assert.equal(s.seats[1].chips, 99, 'refused moves took nothing');
  act(s, 1, { action: 'pass', card, match: true }, c);
  act(s, 2, { action: 'fold' }, c);
  act(s, 3, { action: 'pass', card: firstCard(s, 3), match: true }, c);
  assert.equal(s.pot, 4 + 5 * 3);
  assert.equal(s.seats[2].chips, 99);
  assert.equal(s.status[2], 'folded');
  assert.equal(s.passNo, 3, 'every card in and every raise answered: the pass goes round');
  assert.deepEqual(publicView(s).waitingOn, [0, 1, 3]);
  assert.equal(code(() => act(s, 2, { action: 'check' }, c)), 'not_in_round');
});

test('raise: one on top of another pays what it owes as well, and whoever is left short answers when the cards are in', () => {
  const s = table();
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 5 }, c);
  act(s, 1, { action: 'pass', card: firstCard(s, 1), raise: 10 }, c);
  assert.equal(s.seats[1].chips, 99 - 15, 'match 5, raise 10');
  assert.deepEqual(publicView(s).passRaise, { high: 15, by: 1, paid: { 0: 5, 1: 15 } });
  assert.deepEqual(legalActions(s, 2)[0].match, { cost: 15, level: 15 });
  act(s, 2, { action: 'pass', card: firstCard(s, 2), match: true }, c);
  act(s, 3, { action: 'fold' }, c);
  assert.equal(s.passNo, 1, 'seat 0 still owes 10');
  assert.deepEqual(publicView(s).raise, { by: 1, amount: 15, waiting: [0] });
  assert.deepEqual(legalActions(s, 0), [{ action: 'match', cost: 10, level: 15 }, { action: 'fold' }]);
  assert.equal(code(() => act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 1 }, c)), 'already_passed');
  act(s, 0, { action: 'match' }, c);
  assert.equal(s.seats[0].chips, 99 - 15);
  assert.equal(s.passNo, 2);
  assert.equal(publicView(s).raise, null);
  assert.deepEqual(publicView(s).passRaise, { high: 0, by: null, paid: {} }, 'a new window starts clean');
  assert.ok(legalActions(s, 0)[0].raise, 'one raise per seat per window: a new window, a new raise');
});

test('raise: a short stack can\'t match, and only fold is offered', () => {
  const s = table();
  passAll(s);
  s.seats[1].chips = 3;
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 20 }, c);
  assert.deepEqual(legalActions(s, 1), [{ action: 'fold' }]);
  assert.equal(code(() => act(s, 1, { action: 'pass', card: firstCard(s, 1), match: true }, c)), 'short_stack');
  assert.equal(s.seats[1].chips, 3, 'nothing taken');
  act(s, 1, { action: 'fold' }, c);
  assert.equal(s.status[1], 'folded');
});

test('raise: exactly enough chips can match', () => {
  const s = table();
  passAll(s);
  s.seats[1].chips = 20;
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 20 }, c);
  act(s, 1, { action: 'pass', card: firstCard(s, 1), match: true }, c);
  assert.equal(s.seats[1].chips, 0);
  assert.equal(s.status[1], 'in');
});

test('stop is blocked while a raise is out in the window', () => {
  const s = table();
  passAll(s); passAll(s);
  assert.ok(legalActions(s, 2).some((a) => a.action === 'stop'));
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 1 }, c);
  assert.equal(code(() => act(s, 2, { action: 'stop', claim: [1, 9] }, c)), 'raise_pending');
  assert.ok(!legalActions(s, 2).some((a) => a.action === 'stop'));
  assert.ok(!legalActions(s, 0).some((a) => a.action === 'stop'));
});

// ---------- uncontested ----------

test('uncontested: the last player not folded takes the pot', () => {
  const s = table();
  passAll(s);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 10 }, c);
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'fold' }, c);
  assert.equal(s.phase, 'pass');
  act(s, 3, { action: 'fold' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.lastResult.kind, 'uncontested');
  assert.deepEqual(s.lastResult.awards, [{ seat: 0, amount: 14 }]);
  assert.equal(s.seats[0].chips, 89 + 14);
  assert.equal(s.pot, 0);
});

// ---------- claim lap ----------

test('lap: one turn each, in order, then settle', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  assert.equal(code(() => act(s, 0, { action: 'check' }, c)), 'not_your_turn');
  act(s, 1, { action: 'check' }, c);
  act(s, 2, { action: 'check' }, c);
  assert.equal(s.phase, 'claim');
  act(s, 3, { action: 'check' }, c);
  assert.equal(s.phase, 'settled');
});

test('claim: must beat the top standing claim', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  assert.equal(code(() => act(s, 1, { action: 'claim', claim: [1, 9] }, c)), 'claim_too_low');
  assert.equal(code(() => act(s, 1, { action: 'claim', claim: [1, 8] }, c)), 'claim_too_low');
  assert.equal(code(() => act(s, 1, { action: 'claim', claim: [9, 9] }, c)), 'bad_claim');
  act(s, 1, { action: 'claim', claim: [1, 10] }, c);
  assert.deepEqual(topClaim(s), [1, 10, 0]);
});

test('claim: a caught claim no longer sets the bar', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c); // true
  act(s, 1, { action: 'claim', claim: [7, 14] }, c); // bluff
  act(s, 2, { action: 'call', seat: 1 }, c);
  assert.deepEqual(topClaim(s), [1, 9, 0]);
  act(s, 3, { action: 'claim', claim: [2, 14, 2] }, c);
  assert.deepEqual(topClaim(s), [2, 14, 2]);
});

test('claim: a straight flush can\'t be topped, and the offer goes away', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [8] }, c);
  assert.ok(!legalActions(s, 1).some((a) => a.action === 'claim'));
  assert.equal(code(() => act(s, 1, { action: 'claim', claim: [8] }, c)), 'claim_too_low');
});

test('call: bluff caught → claimer out of the pot, pays the caller 5, hand stays hidden', () => {
  const s = lap(HANDS);
  const [claimer, caller] = [s.seats[0].chips, s.seats[1].chips];
  act(s, 0, { action: 'claim', claim: [7, 14] }, c);
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.equal(s.claims[0].status, 'caught');
  assert.equal(s.seats[0].chips, claimer - 5);
  assert.equal(s.seats[1].chips, caller + 5);
  assert.deepEqual(s.seats[0].rep, { called: 1, proven: 0, caught: 1 });
  assert.equal(topClaim(s), null);
  const pub = JSON.stringify(publicView(s));
  for (const card of s.hands[0]) assert.ok(!pub.includes(`"${card}"`));
});

test('call: true → caller pays the claimer 5, claim marked proven, still standing', () => {
  const s = lap(HANDS);
  const [claimer, caller] = [s.seats[0].chips, s.seats[1].chips];
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.equal(s.claims[0].status, 'proven');
  assert.ok(s.log.some((line) => /is CHECKED\./.test(line.text)), 'the table reads "checked": the house found it held');
  assert.equal(s.seats[0].chips, claimer + 5);
  assert.equal(s.seats[1].chips, caller - 5);
  assert.deepEqual(s.seats[0].rep, { called: 1, proven: 1, caught: 0 });
  assert.deepEqual(topClaim(s), [1, 9, 0]);
});

test('call: ANY uncalled claim, not just the top one', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'claim', claim: [1, 10] }, c);
  assert.deepEqual(legalActions(s, 2).find((a) => a.action === 'call'), { action: 'call', seats: [0, 1], raise: { min: 1, max: 25 } });
  act(s, 2, { action: 'call', seat: 0 }, c);
  assert.equal(s.claims[0].status, 'proven');
  assert.equal(s.claims[1].status, 'standing');
});

test('call: rejects no claim, own seat, a claim already called, bad input', () => {
  const s = lap(HANDS);
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 1 }, c)), 'no_such_claim');
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 0 }, c)), 'bad_call');
  assert.equal(code(() => act(s, 0, { action: 'call' }, c)), 'bad_call');
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.equal(code(() => act(s, 2, { action: 'call', seat: 0 }, c)), 'already_called');
  assert.ok(!legalActions(s, 2).some((a) => a.action === 'call'), 'not offered once called');
});

test('a call needs at least 5 chips: no free calls', () => {
  const s = lap(HANDS);
  s.seats[1].chips = 4;
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  assert.ok(!legalActions(s, 1).some((a) => a.action === 'call'), 'not offered');
  assert.equal(code(() => act(s, 1, { action: 'call', seat: 0 }, c)), 'not_enough_chips');
  assert.equal(s.claims[0].status, 'standing', 'nothing happened');
  s.seats[1].chips = 5;
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.equal(s.seats[1].chips, 0);
});

test('a caught bluffer with few chips pays what they have', () => {
  const s = lap(HANDS);
  s.seats[0].chips = 2;
  act(s, 0, { action: 'claim', claim: [7, 14] }, c);
  const before = s.seats[1].chips;
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.equal(s.seats[0].chips, 0);
  assert.equal(s.seats[1].chips, before + 2);
});

// ---------- settle ----------

/** A settled lap where seats 0 and 2 hold standing claims, and the pot is forced first. */
function settledWithPot(pot, moves) {
  const s = lap(HANDS);
  s.pot = pot;
  const chips = s.seats.map((x) => x.chips);
  moves(s);
  while (s.phase === 'claim') act(s, currentTurn(s), { action: 'check' }, c);
  assert.equal(s.phase, 'settled');
  return { s, chips };
}

const twoClaims = (s) => {
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'check' }, c);
  act(s, 2, { action: 'claim', claim: [3, 12] }, c);
};

test('settle: top takes ceil(2/3), second takes the rest', () => {
  for (const [pot, top, second] of [[10, 7, 3], [9, 6, 3], [4, 3, 1], [5, 4, 1], [1, 1, 0], [100, 67, 33], [101, 68, 33]]) {
    const { s, chips } = settledWithPot(pot, twoClaims);
    assert.equal(s.seats[2].chips - chips[2], top, `pot ${pot}: top`);
    assert.equal(s.seats[0].chips - chips[0], second, `pot ${pot}: second`);
    assert.equal(s.pot, 0);
    assert.equal(s.lastResult.kind, 'settled');
  }
});

test('settle: proven and never-called claims both stand, and a caught one does not', () => {
  const { s, chips } = settledWithPot(10, (t) => {
    act(t, 0, { action: 'claim', claim: [1, 9] }, c); // true, gets proven by seat 1
    act(t, 1, { action: 'call', seat: 0 }, c);
    act(t, 2, { action: 'claim', claim: [7, 2] }, c); // bluff, caught by seat 3
    act(t, 3, { action: 'call', seat: 2 }, c);
  });
  assert.equal(s.lastResult.awards.length, 1);
  assert.equal(s.lastResult.awards[0].seat, 0);
  assert.equal(s.seats[0].chips - chips[0], 5 + 10, 'call winnings plus the whole pot');
  assert.equal(s.seats[2].chips - chips[2], -5);
  assert.equal(s.pot, 0);
});

test('settle: a lone standing claim takes the WHOLE pot', () => {
  const { s, chips } = settledWithPot(10, (t) => act(t, 0, { action: 'claim', claim: [1, 9] }, c));
  assert.equal(s.seats[0].chips - chips[0], 10);
  assert.equal(s.pot, 0);
  assert.equal(s.lastResult.carried, 0);
});

test('settle: none standing → the whole pot carries into the next round', () => {
  const { s } = settledWithPot(10, () => {});
  assert.equal(s.lastResult.kind, 'carried');
  assert.equal(s.pot, 10);
  startRound(s, ctx(2000));
  assert.equal(s.round, 2);
  assert.equal(s.pot, 14, 'carry plus 4 antes');
  assert.equal(s.starter, 1, 'starter moves on one seat');
});

test('uncalled claims are never revealed, not even at settle', () => {
  const { s } = settledWithPot(10, (t) => {
    act(t, 0, { action: 'claim', claim: [7, 2] }, c); // a bluff nobody calls
  });
  const pub = publicView(s);
  assert.equal(pub.claims[0].status, 'standing');
  assert.ok(!('truth' in pub.claims[0]));
  assert.ok(!/bluff/i.test(JSON.stringify(pub.log)), 'the log never says it was a bluff');
  assert.equal(s.lastResult.awards[0].seat, 0, 'an uncalled bluff still wins');
});

test('reputation carries across rounds', () => {
  const { s } = settledWithPot(10, (t) => {
    act(t, 0, { action: 'claim', claim: [1, 9] }, c);
    act(t, 1, { action: 'call', seat: 0 }, c);
  });
  startRound(s, ctx(2000));
  assert.deepEqual(publicView(s).seats[0].rep, { called: 1, proven: 1, caught: 0 });
  assert.deepEqual(publicView(s).claims, [], 'claims reset each round');
});

// ---------- bad input ----------

test('illegal moves leave the state untouched', () => {
  const s = table();
  const before = JSON.stringify(s);
  for (const [seat, move] of [[0, { action: 'nonsense' }], [0, null], [0, { action: 'check' }], [0, { action: 'stop' }], [0, { action: 'claim', claim: [1, 9] }], [0, { action: 'match' }], [0, { action: 'fold' }], [0, { action: 'next' }], [0, { action: 'pass', card: 'nope' }]]) {
    assert.ok(code(() => act(s, seat, move, c)), JSON.stringify(move));
  }
  assert.equal(JSON.stringify(s), before);
});

// ---------- timeouts ----------

test('timeout: at a mixed table, unsubmitted seats auto-pass after 60 s; before then nothing happens', () => {
  const s = table();
  act(s, 0, { action: 'pass', card: firstCard(s, 0) }, c);
  assert.equal(s.cfg.turnMs, 60_000);
  assert.equal(tick(s, ctx(s.deadline - 1)), false);
  assert.equal(s.phase, 'pass');
  assert.equal(tick(s, ctx(s.deadline)), true);
  assert.equal(s.passNo, 2);
  assert.ok(s.hands.every((h) => h.length === 5));
});

test('timeout: auto-fold on a raise not answered, auto-check in the lap', () => {
  const s = table();
  act(s, 1, { action: 'pass', card: firstCard(s, 1), raise: 5 }, c);
  assert.deepEqual(autoAction(s, 2, c), { action: 'fold' });
  tick(s, ctx(s.deadline));
  assert.equal(s.status[2], 'folded');
  assert.equal(s.seats[2].away, true);
  const l = lap(HANDS);
  tick(l, ctx(l.deadline));
  assert.equal(currentTurn(l), 1, 'seat 0 auto-checked in the lap');
});

test('lobby: bots fill the empty seats when the timer ends', () => {
  const s = createTable();
  join(s, 'Ann', ctx(0));
  assert.equal(s.phase, 'lobby');
  assert.equal(s.deadline, 30_000);
  const late = createTable();
  assert.equal(tick(late, ctx(99)), false, 'an empty lobby never starts');
  tick(s, ctx(30_000));
  assert.equal(s.phase, 'pass');
  assert.deepEqual(s.seats.map((x) => [x.name, x.bot]), [['Ann', false], ['Tally · house', true], ['Brannock', true], ['Old Wick', true]]);
});

test('lobby: lobbyMs 0 starts on the first join; names are checked; a started table is closed', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  assert.equal(s.phase, 'pass');
  assert.equal(code(() => join(s, 'Bo', c)), 'table_started');
  const t = createTable();
  join(t, 'Ann', c);
  assert.equal(code(() => join(t, 'ann', c)), 'name_taken');
  for (const name of ['tally · house', 'Tally', 'halfhand (house)', 'brannock', 'OLD WICK']) assert.equal(code(() => join(t, name, c)), 'name_reserved', name);
  join(t, 'Halfhand', c);
  assert.equal(t.seats[1].name, 'Halfhand', 'plain Halfhand is free for a real agent');
  assert.equal(t.seats[1].kind, 'agent');
});

test('table ends: one player with chips, no humans with chips, or too long idle', () => {
  const lone = table();
  lone.cage = { status: 'open' }; // tNIGHT: the others can't be restaked, so one seat with chips closes the table
  lone.seats.forEach((x, i) => { x.chips = i === 0 ? 50 : 0; });
  startRound(lone, c);
  assert.equal(lone.phase, 'over');
  assert.equal(lone.overCode, 'others_out_of_chips');
  assert.equal(lone.deadline, null);
  const chipsLone = table(); // play chips: never closed for that. It waits, says so once, and the round deals when two can ante.
  chipsLone.seats.forEach((x, i) => { x.chips = i === 0 ? 50 : 0; });
  startRound(chipsLone, c);
  startRound(chipsLone, c);
  assert.notEqual(chipsLone.phase, 'over');
  assert.equal(chipsLone.log.filter((l) => /Waiting for another player with chips/.test(l.text)).length, 1);

  const noHuman = createTable({ lobbyMs: 0 });
  join(noHuman, 'Ann', c);
  noHuman.cage = { status: 'open' }; // tNIGHT: nothing restakes a seat, so the table closes
  noHuman.seats[0].chips = 0;
  startRound(noHuman, c);
  assert.equal(noHuman.phase, 'over');
  const neverDealt = createTable({ lobbyMs: 60_000 }); // play chips, before any deal: no result to keep up, so it closes as before
  join(neverDealt, 'Ann', c);
  neverDealt.seats[0].chips = 0;
  startRound(neverDealt, c);
  assert.equal(neverDealt.phase, 'over');

  const idle = table();
  startRound(idle, ctx(1000 + idle.cfg.idleMs + 1));
  assert.equal(idle.phase, 'over');
  assert.deepEqual([idle.overCode, idle.overReason, idle.overRound], ['no_human_action', 'No moves for 30 minutes.', 1]);
  assert.ok(idle.log.some((l) => l.text === 'Table over: No moves for 30 minutes.'));
});

test('a player who can\'t ante sits the round out', () => {
  const s = table();
  s.seats[3].chips = 0;
  s.phase = 'settled';
  startRound(s, c);
  assert.equal(s.status[3], 'out');
  assert.equal(s.hands[3].length, 0);
  assert.equal(code(() => act(s, 3, { action: 'pass', card: 'Ah' }, c)), 'not_in_round');
  assert.deepEqual(publicView(s).waitingOn, [0, 1, 2]);
});

// ---------- leaving ----------

test('leave between rounds: the stack comes off the table now, and the seat stays out', () => {
  const { s, chips } = settledWithPot(10, () => {});
  const r = leave(s, 0);
  assert.deepEqual(r, { queued: false, amount: chips[0] });
  assert.deepEqual(s.departures, [{ seat: 0, amount: chips[0] }]);
  assert.equal(s.seats[0].chips, 0);
  assert.equal(publicView(s).seats[0].left, true);
  assert.equal(code(() => leave(s, 0)), 'already_left');
  startRound(s, ctx(2000));
  assert.equal(s.status[0], 'out');
  assert.equal(s.hands[0].length, 0);
});

test('leave during a round: waits for the round to end, with winnings included', () => {
  const s = lap(HANDS);
  s.pot = 10;
  const before = s.seats[0].chips;
  assert.deepEqual(leave(s, 0), { queued: true });
  assert.equal(s.seats[0].chips, before, 'nothing moves yet');
  assert.equal(s.departures.length, 0);
  assert.equal(privateView(s, 0).leaving, true);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'check' }, c);
  assert.equal(s.phase, 'settled');
  assert.deepEqual(s.departures, [{ seat: 0, amount: before + 10 }], 'stack plus the pot it just won');
  assert.equal(s.seats[0].left, true);
});

test('leave: refused once the table is over; the last human leaving ends a bot table', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  s.phase = 'settled';
  leave(s, 0);
  startRound(s, c);
  assert.equal(s.phase, 'over', 'bots do not play on alone');
  assert.equal(code(() => leave(s, 1)), 'table_over');
});

test('passed cards are remembered per seat and never public', () => {
  const s = table({ hands: HANDS });
  passAll(s);
  assert.deepEqual(s.received[1], [{ from: 0, card: '9c' }]);
  assert.deepEqual(s.received[0], [{ from: 3, card: 'Ac' }]);
  assert.ok(!/received|talkQueue|departures|passLog/.test(JSON.stringify(publicView(s))));
  startRound(s, ctx(2000));
  assert.deepEqual(s.received[1], [], 'forgotten each round');
});

// ---------- whole games ----------

/** Plays one of the moves the server says is legal. */
function randomLegal(s, seat, rng) {
  const legal = legalActions(s, seat);
  const pick = legal[Math.floor(rng() * legal.length)];
  switch (pick.action) {
    case 'pass': return { action: 'pass', card: pick.cards[Math.floor(rng() * pick.cards.length)], ...randomStake(pick, rng) };
    case 'claim': return { action: 'claim', claim: pick.truthful.length && rng() < 0.7 ? pick.truthful[0].claim : [8, 0, 0], ...randomStake(pick, rng) };
    case 'stop': return { action: 'stop', claim: pick.truthful.length && rng() < 0.7 ? pick.truthful[0].claim : pick.options[Math.floor(rng() * pick.options.length)].claim, ...randomStake(pick, rng) };
    case 'call': return { action: 'call', seat: pick.seats[Math.floor(rng() * pick.seats.length)], ...randomStake(pick, rng) };
    case 'check': return { action: 'check', ...randomStake(pick, rng) };
    default: return { action: pick.action };
  }
}

/** What goes with a lap move, picked at random from what the server said it can carry. */
function randomStake(move, rng) {
  if (move.raise && rng() < 0.3) return { raise: move.raise.min + Math.floor(rng() * (move.raise.max - move.raise.min + 1)) };
  if (move.fold && (!move.match || rng() < 0.5)) return { fold: true };
  return move.match ? { match: true } : {};
}

test('fuzz: 300 tables, 1 random human + 3 bots. Chips conserved, every offered move legal, no bot errors, no hand in public', () => {
  let rounds = 0;
  for (let game = 0; game < 300; game++) {
    const rng = makeRng(game + 1);
    const context = { now: 1000, rng };
    const s = createTable({ lobbyMs: 0 });
    join(s, 'Probe', context);
    runBots(s, context);
    const start = s.cfg.startChips * 4;
    for (let step = 0; step < 2000 && s.phase !== 'over' && s.round <= 30; step++) {
      context.now += 1;
      if (s.phase === 'settled') {
        rounds += 1;
        assert.ok(s.lastResult);
        startRound(s, context);
      } else {
        const legal = legalActions(s, 0);
        if (legal.length === 0) {
          // The human is out or already passed: only a timeout can be due. Force it.
          context.now = s.deadline;
          tick(s, context);
        } else act(s, 0, randomLegal(s, 0, rng), context);
      }
      runBots(s, context);
      assert.equal(total(s), start + (s.houseStaked ?? 0), `chips conserved, but for what the house staked (game ${game}, step ${step})`);
      assert.ok(s.seats.every((x) => x.chips >= 0));
      if (['pass', 'claim'].includes(s.phase)) {
        const live = s.hands.flat();
        assert.equal(new Set(live).size, live.length, 'no duplicated card');
        assert.ok(s.status.every((st, i) => st !== 'in' || s.hands[i].length === 5));
      }
      const view = publicView(s);
      const pub = JSON.stringify(view);
      if (['pass', 'claim', 'answer'].includes(s.phase)) for (const card of s.hands.flat()) assert.ok(!pub.includes(`"${card}"`)); // once the round is over the deck is opened for all to recheck
      else if (s.phase === 'settled') assert.ok(view.deal?.opened?.deck?.length === 52, 'the deck opens when the round is over');
    }
    assert.ok(!s.log.some((l) => l.botError), `bot error in game ${game}: ${JSON.stringify(s.log.filter((l) => l.botError))}`);
  }
  assert.ok(rounds > 1000, `played ${rounds} rounds`);
});

// ---------- raising during the pass window ----------

test('pass window: a raise comes with the pass, on the legal list, and one who passed earlier answers once the cards are in', () => {
  const s = table();
  assert.deepEqual(legalActions(s, 0).map((a) => a.action), ['pass']);
  assert.deepEqual(legalActions(s, 0)[0].raise, { min: 1, max: 25 });
  act(s, 0, { action: 'pass', card: firstCard(s, 0) }, c);
  assert.deepEqual(legalActions(s, 0), [], 'one move a window');

  const { pot } = s;
  act(s, 1, { action: 'pass', card: firstCard(s, 1), raise: 4 }, c);
  assert.equal(s.phase, 'pass');
  assert.equal(s.pot, pot + 4);
  assert.deepEqual(publicView(s).raise, null, 'nobody holds up the window while cards are still being picked');
  assert.deepEqual(publicView(s).passRaise, { high: 4, by: 1, paid: { 1: 4 } });
  assert.deepEqual(publicView(s).raisedThisPass, [1]);
  assert.deepEqual(publicView(s).waitingOn, [2, 3]);
  assert.deepEqual(legalActions(s, 0), [], 'it answers after the cards are in');

  act(s, 2, { action: 'pass', card: firstCard(s, 2), match: true }, c);
  act(s, 3, { action: 'fold' }, c);
  assert.equal(s.passNo, 1);
  assert.deepEqual(publicView(s).raise, { by: 1, amount: 4, waiting: [0] });
  assert.equal(currentTurn(s), 0);
  assert.equal(code(() => act(s, 2, { action: 'match' }, c)), 'not_your_turn');
  assert.deepEqual(legalActions(s, 0).map((a) => a.action), ['match', 'fold']);
  act(s, 0, { action: 'match' }, c);
  assert.equal(s.pot, pot + 12);
  assert.equal(s.passNo, 2, 'and then the pass goes round');
  assert.equal(publicView(s).raise, null);
});

test('pass window: the last answer to a raise resolves the pass, and a fold there counts too', () => {
  const s = table();
  for (const seat of [0, 1, 2]) act(s, seat, { action: 'pass', card: firstCard(s, seat) }, c);
  act(s, 3, { action: 'pass', card: firstCard(s, 3), raise: 2 }, c);
  assert.equal(s.passNo, 1);
  for (const seat of [0, 1]) act(s, seat, { action: 'match' }, c);
  act(s, 2, { action: 'fold' }, c);
  assert.equal(s.passNo, 2);
  assert.equal(s.status[2], 'folded');
});

test('pass window: everyone folding to a raise ends the round; a raise cap still applies', () => {
  const s = table();
  assert.equal(code(() => act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 26 }, c)), 'bad_raise');
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 3 }, c);
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'fold' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.lastResult.kind, 'uncontested');
  const t = table();
  assert.equal(code(() => act(t, 1, { action: 'fold' }, c)), 'no_raise_to_answer', 'no raise, no fold');
});

test('pass window: a raise not answered times out as a fold, in the window and after it, and the pass carries on', () => {
  const s = table();
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 3 }, c);
  act(s, 1, { action: 'pass', card: firstCard(s, 1), match: true }, c);
  act(s, 2, { action: 'pass', card: firstCard(s, 2), match: true }, c);
  assert.deepEqual(autoAction(s, 3), { action: 'fold' });
  tick(s, ctx(s.deadline));
  assert.equal(s.status[3], 'folded');
  assert.equal(s.passNo, 2);
  const late = table();
  for (const seat of [1, 2, 3]) act(late, seat, { action: 'pass', card: firstCard(late, seat) }, c);
  act(late, 0, { action: 'pass', card: firstCard(late, 0), raise: 3 }, c);
  assert.deepEqual(autoAction(late, 1), { action: 'fold' });
  tick(late, ctx(late.deadline));
  assert.equal(late.status[1], 'folded');
  assert.deepEqual(publicView(late).raise.waiting, [2, 3]);
  act(late, 2, { action: 'match' }, c);
  act(late, 3, { action: 'match' }, c);
  assert.equal(late.passNo, 2);
});

test('a table saved before this change, with no pass-raise record, still works', () => {
  const s = table();
  delete s.passRaised;
  delete s.botDue;
  delete s.raise;
  assert.ok(legalActions(s, 0).find((a) => a.action === 'pass').raise);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 1 }, c);
  assert.ok(publicView(s).clocks.length > 0);
});

test('a table saved mid-raise under the old rules: the raise can still be answered, and the window goes on', () => {
  const s = table();
  delete s.passRaise;
  s.raise = { by: 0, amount: 3, waiting: [1, 2, 3] };
  s.passRaised = [0];
  s.seats[0].chips -= 3;
  s.pot += 3;
  assert.equal(upgradeState(s, c), true);
  assert.deepEqual(legalActions(s, 1)[0], { action: 'match', cost: 3, level: 3 });
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'match' }, c);
  assert.equal(s.raise, null);
  assert.equal(s.phase, 'pass');
  assert.equal(s.pot, 4 + 12);
  assert.deepEqual(publicView(s).waitingOn, [0, 1, 2, 3], 'nobody had chosen a card yet');
  const old = table();
  delete old.cfg.potLimit;
  assert.equal(publicView(old).limits.potLimit, null, 'an old table has no pot limit');
  act(old, 0, { action: 'pass', card: firstCard(old, 0), raise: 25 }, c);
});

// ---------- the next round ----------

test('next round: anyone seated can deal; nobody pressing deals after 30 s; it is on the legal list only between rounds', () => {
  const { s } = settledWithPot(10, () => {});
  assert.equal(s.cfg.roundGapMs, 30_000);
  assert.deepEqual(legalActions(s, 1), [{ action: 'next' }]);
  assert.equal(tick(s, ctx(s.deadline - 1)), false);
  const round = s.round;
  act(s, 1, { action: 'next' }, ctx(s.deadline - 1));
  assert.equal(s.round, round + 1);
  assert.equal(s.phase, 'pass');
  assert.equal(code(() => act(s, 2, { action: 'next' }, c)), 'wrong_phase', 'a second press finds it already dealt');

  const { s: quiet } = settledWithPot(10, () => {});
  const before = quiet.round;
  tick(quiet, ctx(quiet.deadline));
  assert.equal(quiet.round, before + 1);
});

test('public clocks: who is being waited on and until when, with no card in sight', () => {
  const s = table();
  const { clocks, deadline } = publicView(s);
  assert.deepEqual(clocks.map((k) => k.seat), [0, 1, 2, 3]);
  assert.ok(clocks.every((k) => k.until === deadline));
  assert.equal(s.cfg.turnMs, 60_000);
});

// ---------- no betting step, and tables saved from before ----------

test('no betting step: a pass leads straight to the next pass, and the only way to raise is with the pass', () => {
  const s = table();
  passAll(s);
  assert.equal(s.phase, 'pass');
  assert.deepEqual(legalActions(s, 0).map((a) => a.action), ['pass']);
  assert.equal(code(() => act(s, 0, { action: 'check' }, c)), 'wrong_phase');
  assert.equal(code(() => act(s, 0, { action: 'fold' }, c)), 'no_raise_to_answer');
});

test('an old table caught mid-bet carries on: to its next pass, keeping a raise being answered', () => {
  const old = (bet, passNo = 2) => {
    const s = table();
    s.phase = 'bet';
    s.passNo = passNo;
    s.bet = bet;
    delete s.raise;
    return s;
  };
  const quiet = old({ queue: [1, 2], raise: null });
  assert.equal(upgradeState(quiet, c), true);
  assert.equal(quiet.phase, 'pass');
  assert.equal(quiet.passNo, 3);
  assert.equal(quiet.bet, undefined);
  assert.ok(legalActions(quiet, 0).some((a) => a.action === 'pass'));

  const raised = old({ queue: [], raise: { by: 0, amount: 4, waiting: [1, 2, 3] } });
  upgradeState(raised, c);
  assert.equal(raised.phase, 'pass');
  assert.deepEqual(publicView(raised).raise, { by: 0, amount: 4, waiting: [1, 2, 3] });
  for (const seat of [1, 2, 3]) act(raised, seat, { action: 'match' }, c);
  assert.equal(raised.raise, null);

  const last = old({ queue: [1], raise: null }, 5);
  upgradeState(last, c);
  assert.equal(last.phase, 'claim');
  assert.equal(currentTurn(last), last.starter);

  const fresh = table();
  assert.equal(upgradeState(fresh, c), false, 'a table under the new rules is left alone');
});

test('an old table in a pass window with a raise pending keeps it', () => {
  const s = table();
  delete s.raise;
  s.bet = { queue: [], raise: { by: 2, amount: 3, waiting: [3, 0, 1] } };
  upgradeState(s, c);
  assert.equal(s.phase, 'pass');
  assert.equal(currentTurn(s), 3);
});

// ---------- solo tables: no clock ----------

function soloTable() {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c);
  return s;
}

const HOUR = 60 * 60_000;

test('solo: one human against the house has no turn timer: the table waits, nobody is marked away; untouched for 30 minutes, the seat stands up and the stack goes home (The owner, 11-07)', () => {
  const s = soloTable();
  assert.equal(isSolo(s), true);
  assert.equal(s.deadline, null);
  assert.equal(publicView(s).clocks[0].until, null);
  runBots(s, c);
  assert.deepEqual(publicView(s).waitingOn, [0]);
  assert.equal(tick(s, ctx(1000 + 29 * MIN)), false, 'twenty-nine minutes later, still waiting');
  assert.equal(s.seats[0].away, undefined);
  assert.equal(s.passNo, 1);
  assert.equal(nextStandAt(s), 1000 + 30 * MIN, 'the alarm knows when');
  const stack = s.seats[0].chips;
  assert.equal(tick(s, ctx(1000 + 30 * MIN)), true, 'thirty minutes untouched: the seat stands up');
  for (let i = 0; i < 60 && s.phase !== 'over'; i++) runBots(s, c); // the round plays itself out for the leaver
  assert.equal(s.phase, 'over');
  assert.equal(s.seats[0].left, true);
  assert.equal(s.departures[0].seat, 0);
  assert.equal(s.departures[0].stood, true, 'stood up, so the page can say why');
  assert.ok(s.departures[0].amount >= stack - 5, `the stack goes to the purse: ${s.departures[0].amount}`);
});

test('solo: no auto-deal. The round waits for Next round', () => {
  const s = soloTable();
  runBots(s, c);
  for (let i = 0; i < 60 && s.phase !== 'settled'; i++) {
    const legal = legalActions(s, 0);
    const pass = legal.find((a) => a.action === 'pass');
    if (legal.some((a) => a.action === 'match')) act(s, 0, { action: 'match' }, c);
    else if (pass) act(s, 0, { action: 'pass', card: pass.cards[0], ...(pass.match ? { match: true } : {}) }, c);
    else if (legal.some((a) => a.action === 'fold') && s.phase === 'pass') act(s, 0, { action: 'fold' }, c);
    else if (legal.some((a) => a.action === 'check')) act(s, 0, { action: 'check' }, c);
    runBots(s, c);
  }
  assert.equal(s.phase, 'settled');
  assert.equal(s.deadline, null);
  assert.equal(tick(s, ctx(1000 + 20 * MIN)), false);
  assert.equal(s.round, 1);
  act(s, 0, { action: 'next' }, ctx(1000 + 20 * MIN));
  assert.equal(s.round, 2);
});

test('solo: untouched for 30 minutes in the lobby, the seat stands up, the table closes and the stack goes home', () => {
  const s = soloTable();
  assert.equal(tick(s, ctx(1000 + 30 * MIN - 1)), false);
  assert.equal(tick(s, ctx(1000 + 30 * MIN)), true);
  assert.equal(s.seats[0].standing || s.seats[0].left, true, 'stood up');
  for (let i = 0; i < 80 && s.phase !== 'over'; i++) runBots(s, c); // a round the table had dealt plays itself out for the leaver
  assert.equal(s.phase, 'over');
  assert.deepEqual([s.overCode, s.overReason], ['everyone_left', 'Everyone else left.']);
  assert.equal(s.departures[0].seat, 0);
  assert.equal(s.departures[0].stood, true);
  assert.ok(s.departures[0].amount >= 95, `the stack goes home: ${s.departures[0].amount}`);
  assert.equal(s.deadline, null);
});

test('solo: leaving mid-round plays it out automatically, since nothing else would end it, then the table closes', () => {
  const s = soloTable();
  runBots(s, c);
  const stack = s.seats[0].chips;
  assert.deepEqual(leave(s, 0, c), { queued: true });
  assert.notEqual(s.passes[0], null, 'its card went at once');
  for (let i = 0; i < 60 && s.phase === 'pass'; i++) runBots(s, c);
  for (let i = 0; i < 60 && s.phase === 'claim'; i++) runBots(s, c);
  assert.equal(s.phase, 'over');
  assert.deepEqual([s.overCode, s.overReason], ['everyone_left', 'Everyone else left.']);
  assert.equal(s.departures[0].seat, 0);
  assert.ok(s.departures[0].amount >= stack - 5, `stack ${s.departures[0].amount}`);
  assert.equal(s.seats[0].left, true);
});

test('going solo: when the other human leaves, the clock stops', () => {
  const s = createTable({ lobbyMs: 5000 });
  join(s, 'Ann', c);
  join(s, 'Bo', c);
  tick(s, ctx(s.deadline));
  assert.equal(isSolo(s), false);
  assert.notEqual(s.deadline, null);
  s.phase = 'settled';
  leave(s, 1);
  assert.equal(isSolo(s), true);
  assert.equal(s.deadline, null);
});

// ---------- mixed tables: away ----------

test('away: 60 s, then marked away, not folded; a random card goes, and later passes go by themselves', () => {
  const s = table();
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'pass', card: firstCard(s, seat) }, c);
  assert.equal(s.cfg.turnMs, 60_000);
  const held = s.hands[0].slice();
  tick(s, ctx(s.deadline));
  assert.equal(s.seats[0].away, true);
  assert.equal(s.status[0], 'in', 'not folded');
  assert.ok(s.log.some((l) => l.text === 'Ann timed out and is marked away.'));
  assert.equal(publicView(s).seats[0].away, true);
  assert.equal(s.passNo, 2);
  assert.equal(s.hands[0].filter((card) => !held.includes(card)).length, 1, 'one card went round');
  assert.notEqual(s.passes[0], null, 'and the next pass is already chosen, so nobody waits');
  assert.deepEqual(publicView(s).waitingOn, [1, 2, 3]);
});

test('away: the auto-pass is a random card, not the best one', () => {
  const s = table({ hands: HANDS });
  const seen = new Set();
  for (let r = 0; r < 200; r++) seen.add(autoAction(s, 0, ctx()).card);
  assert.equal(autoAction(s, 0, { now: 0, rng: () => 0 }).card, s.hands[0][0]);
  assert.equal(autoAction(s, 0, { now: 0, rng: () => 0.99 }).card, s.hands[0][4]);
});

test('away: only ever checks in the lap: no raise, no call', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  tick(s, ctx(s.deadline));
  assert.equal(s.seats[1].away, true);
  assert.equal(s.claims[0].status, 'standing', 'it did not call');
  assert.ok(s.log.some((l) => l.text === 'Bo checks.'));
  assert.equal(currentTurn(s), 2);
});

test('away: folds only a raise it faces', () => {
  const s = table();
  act(s, 3, { action: 'pass', card: firstCard(s, 3), raise: 2 }, c);
  tick(s, ctx(s.deadline));
  assert.equal(s.seats[0].away, true);
  assert.equal(s.status[0], 'folded');
  const noRaise = table();
  tick(noRaise, ctx(noRaise.deadline));
  assert.ok(noRaise.seats.every((x) => x.away));
  assert.ok(noRaise.status.every((x) => x === 'in'), 'with no raise, nobody folds');
});

test('away: sits out the following rounds with no ante, until "I\'m back"', () => {
  const s = table();
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'pass', card: firstCard(s, seat) }, c);
  tick(s, ctx(s.deadline));
  assert.deepEqual(legalActions(s, 0), [{ action: 'back' }]);
  assert.equal(code(() => act(s, 0, { action: 'raise', n: 1 }, c)), 'away');
  assert.equal(code(() => act(s, 0, { action: 'next' }, c)), 'away');

  s.phase = 'settled';
  s.pot = 0;
  const chips = s.seats[0].chips;
  startRound(s, c);
  assert.equal(s.round, 2);
  assert.equal(s.status[0], 'out');
  assert.equal(s.seats[0].chips, chips, 'no ante');
  assert.deepEqual(s.hands[0], []);

  act(s, 0, { action: 'back' }, c);
  assert.equal(s.seats[0].away, false);
  assert.ok(s.log.some((l) => l.text === 'Ann is back.'));
  assert.equal(s.status[0], 'out', 'this round is already dealt');
  assert.equal(code(() => act(s, 0, { action: 'back' }, c)), 'not_away');

  s.phase = 'settled';
  startRound(s, c);
  assert.equal(s.status[0], 'in', 'dealt in again');
  assert.equal(s.hands[0].length, 5);
});

test('away: coming back mid-round, still dealt in, plays on', () => {
  const s = table();
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'pass', card: firstCard(s, seat) }, c);
  tick(s, ctx(s.deadline));
  assert.equal(s.passNo, 2, 'its card went round for it');
  act(s, 0, { action: 'back' }, c);
  assert.ok(s.status[0] === 'in');
  assert.equal(s.seats[0].away, false);
});

test('auto-deal: 30 s at a mixed table; if everyone who could play is away, it waits, then closes after 24 hours', () => {
  const s = table();
  tick(s, ctx(s.deadline));
  assert.equal(s.phase, 'settled', 'everyone away: the round plays itself out');
  assert.equal(s.deadline - s.clockFrom, 30_000);
  const round = s.round;
  tick(s, ctx(s.deadline));
  assert.equal(s.round, round, 'nobody to deal to');
  assert.equal(s.phase, 'settled');
  assert.equal(s.deadline, null);

  act(s, 0, { action: 'back' }, ctx(2000));
  assert.equal(s.deadline, 2000 + 30_000, 'the deal runs again');
  tick(s, ctx(s.deadline));
  assert.equal(s.round, round, 'one back, with three away, is not enough to play');
  act(s, 1, { action: 'back' }, ctx(3000));
  act(s, 0, { action: 'next' }, ctx(3000));
  assert.equal(s.round, round + 1);
  assert.deepEqual(s.status, ['in', 'in', 'out', 'out']);

  const quiet = table();
  for (let i = 0; i < 2; i++) tick(quiet, ctx(quiet.deadline));
  assert.equal(quiet.deadline, null);
  assert.equal(tick(quiet, ctx(1000 + 24 * HOUR + 1)), true);
  assert.equal(quiet.phase, 'over');
});

test('an old solo table loses its clock on upgrade, so it can\'t mark its player away', () => {
  const s = soloTable();
  s.deadline = 5000;
  s.bet = null;
  delete s.raise;
  assert.equal(upgradeState(s, c), true);
  assert.equal(s.deadline, null);
  assert.equal(s.bet, undefined);
});

// ---------- reading the table ----------

test('pass log: each player sees their own passes, one per pass, with their own cards only, cleared each round', () => {
  const s = table({ hands: HANDS });
  act(s, 0, { action: 'pass', card: '9c' }, c);
  act(s, 1, { action: 'pass', card: '3c' }, c);
  act(s, 2, { action: 'pass', card: 'Qc' }, c);
  assert.deepEqual(privateView(s, 0).passLog, [], 'nothing until it goes round');
  act(s, 3, { action: 'pass', card: 'Ac' }, c);
  assert.deepEqual(privateView(s, 0).passLog, [{ n: 1, sent: '9c', to: 1, got: 'Ac', from: 3 }]);
  assert.deepEqual(privateView(s, 1).passLog, [{ n: 1, sent: '3c', to: 2, got: '9c', from: 0 }]);
  const pub = JSON.stringify(publicView(s));
  assert.ok(!/passLog|"sent"|"got"/.test(pub));
  for (const card of ['9c', '3c', 'Qc', 'Ac']) assert.ok(!pub.includes(`"${card}"`), `${card} in the public view`);
  assert.deepEqual(publicView(s).seats.map((x) => x.passCount), [1, 1, 1, 1], 'how many is public');

  passAll(s);
  assert.deepEqual(privateView(s, 0).passLog.map((e) => e.n), [1, 2]);
  assert.deepEqual(publicView(s).seats.map((x) => x.passCount), [2, 2, 2, 2]);

  s.phase = 'settled';
  startRound(s, c);
  assert.deepEqual(privateView(s, 0).passLog, []);
  assert.deepEqual(publicView(s).seats.map((x) => x.passCount), [0, 0, 0, 0]);
});

test('pass log: a folded seat is passed over, and the log names the real neighbours', () => {
  const s = table({ hands: HANDS });
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 1 }, c);
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'pass', card: firstCard(s, 2), match: true }, c);
  act(s, 3, { action: 'pass', card: firstCard(s, 3), match: true }, c);
  assert.deepEqual([privateView(s, 0).passLog[0].to, privateView(s, 2).passLog[0].from], [2, 0]);
  assert.deepEqual(privateView(s, 1).passLog, [], 'the folded seat passed nothing');
  assert.equal(publicView(s).seats[1].passCount, 0);
});

test('a table saved before the pass log still resolves a pass', () => {
  const s = table();
  delete s.passLog;
  assert.deepEqual(privateView(s, 0).passLog, []);
  passAll(s);
  assert.equal(privateView(s, 0).passLog.length, 1);
});

// ---------- chips on the move ----------

test('chip log: antes, raises and matches go to the pot, and it carries no card', () => {
  const s = table();
  assert.deepEqual(s.chipLog.map((m) => [m.kind, m.from, m.to, m.amount]), [0, 1, 2, 3].map((seat) => ['ante', seat, 'pot', 1]));
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 4 }, c);
  act(s, 1, { action: 'pass', card: firstCard(s, 1), match: true }, c);
  act(s, 2, { action: 'fold' }, c);
  act(s, 3, { action: 'pass', card: firstCard(s, 3), match: true }, c);
  assert.deepEqual(s.chipLog.slice(4).map((m) => [m.kind, m.from, m.to, m.amount]), [['raise', 0, 'pot', 4], ['match', 1, 'pot', 4], ['match', 3, 'pot', 4]]);
  const moves = JSON.stringify(publicView(s).chipLog);
  assert.ok(!/[2-9TJQKA][cdhs]/.test(moves), moves);
  assert.ok(s.chipLog.every((m, i, all) => i === 0 || m.n === all[i - 1].n + 1), 'numbered in order');
});

test('chip log: a call\'s sting goes from the loser to the winner, not to the pot', () => {
  const s = lap(HANDS);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c); // true
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.deepEqual(s.chipLog.at(-1).kind, 'sting');
  assert.deepEqual([s.chipLog.at(-1).from, s.chipLog.at(-1).to, s.chipLog.at(-1).amount], [1, 0, 5]);

  const bluff = lap(HANDS);
  act(bluff, 0, { action: 'claim', claim: [7, 14] }, c); // false
  act(bluff, 1, { action: 'call', seat: 0 }, c);
  assert.deepEqual([bluff.chipLog.at(-1).from, bluff.chipLog.at(-1).to], [0, 1]);
});

test('chip log: the pot pays out as two visible shares at settle, and all at once to a lone claim', () => {
  const s = lap(HANDS);
  s.pot = 30;
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'check' }, c);
  act(s, 2, { action: 'claim', claim: [3, 12] }, c);
  act(s, 3, { action: 'check' }, c);
  assert.equal(s.phase, 'settled');
  const wins = s.chipLog.filter((m) => m.kind === 'win');
  assert.deepEqual(wins.map((m) => [m.from, m.to, m.amount]), [['pot', 2, 20], ['pot', 0, 10]]);
  assert.equal(s.carried, 0);

  const lone = lap(HANDS);
  lone.pot = 12;
  act(lone, 0, { action: 'claim', claim: [1, 9] }, c);
  for (const seat of [1, 2, 3]) act(lone, seat, { action: 'check' }, c);
  assert.deepEqual(lone.chipLog.at(-1).amount, 12);
});

test('carried: a pot with no winner shows as carried, then as part of the next pot, and clears when it\'s won', () => {
  const s = lap(HANDS);
  s.pot = 9;
  for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'check' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(publicView(s).carried, 9);
  assert.equal(publicView(s).pot, 9);
  startRound(s, c);
  assert.equal(publicView(s).carried, 9, 'it stays separate');
  assert.equal(publicView(s).pot, 13, 'with the new antes on top');
  for (let i = 0; i < 2; i++) passAll(s);
  act(s, 0, { action: 'stop', claim: [1, 9] }, c);
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'check' }, c);
  assert.equal(publicView(s).carried, 0);
});

test('an old table with no chip log still plays', () => {
  const s = table();
  delete s.chipLog;
  delete s.chipN;
  delete s.carried;
  assert.deepEqual(publicView(s).chipLog, []);
  assert.equal(publicView(s).carried, 0);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 1 }, c);
  assert.equal(s.chipLog.length, 1);
});

// ---------- the best true claim ----------

/** A table on someone's claim turn, with the given hand for seat 0 and these claims standing. */
function claimTurn(hand, claims = [], queue = [0, 1, 2, 3]) {
  const s = soloTable();
  s.phase = 'claim';
  s.hands[0] = hand;
  s.claims = claims;
  s.lap = { leader: queue[0], queue, high: 0, by: null, paid: {} };
  return s;
}

test('best true claim: named for its owner, and whether it beats what stands', () => {
  const nines = ['9c', '9d', '2h', '5s', 'Kc'];
  let best = privateView(claimTurn(nines), 0).bestTrue;
  assert.deepEqual(best, { claim: [1, 9, 0], label: 'pair of 9s', beats: true });

  best = privateView(claimTurn(nines, [{ seat: 2, claim: [2, 13, 0], status: 'standing' }]), 0).bestTrue;
  assert.deepEqual(best, { claim: [1, 9, 0], label: 'pair of 9s', beats: false });

  best = privateView(claimTurn(['2c', '4d', '7h', '9s', 'Kc']), 0).bestTrue;
  assert.deepEqual(best, { claim: null, label: null, beats: false }, 'no pair: nothing true to claim');

  const caught = privateView(claimTurn(nines, [{ seat: 2, claim: [8, 0, 0], status: 'caught' }]), 0).bestTrue;
  assert.equal(caught.beats, true, 'a caught bluff is no longer there to beat');
});

test('best true claim: only for you, only while your say is to come, and it never reaches the public view', () => {
  const s = claimTurn(['9c', '9d', '2h', '5s', 'Kc'], [], [1, 2, 3]);
  assert.equal(privateView(s, 0).bestTrue, null, 'already had their say');
  s.lap.queue = [0, 1, 2, 3];
  const text = JSON.stringify(publicView(s));
  assert.ok(!text.includes('bestTrue') && !text.includes('potIn'));
  s.phase = 'pass';
  assert.equal(privateView(s, 0).bestTrue, null, 'only in the claim lap');
});

test('best true claim: agrees with the legal list on 400 random hands, and Check is always there', () => {
  const rng = makeRng(99);
  const deck = newDeck();
  for (let i = 0; i < 400; i++) {
    const hand = shuffle(deck, rng).slice(0, 5);
    const claims = i % 3 ? [{ seat: 2, claim: LADDER[Math.floor(rng() * LADDER.length)], status: 'standing' }] : [];
    const s = claimTurn(hand, claims);
    const legal = legalActions(s, 0);
    const claim = legal.find((a) => a.action === 'claim');
    const { bestTrue: best } = privateView(s, 0);
    assert.equal(best.beats, (claim?.truthful.length ?? 0) > 0, hand.join());
    if (best.beats) assert.ok(claim.options.some((o) => o.label === best.label), best.label);
    assert.ok(legal.some((a) => a.action === 'check'), 'a legal true move, always');
  }
});

// ---------- the pot goes back when a table closes ----------

const chipsOnTable = (s) => s.seats.reduce((sum, x) => sum + x.chips, s.pot);

test('24 h close: each seat gets back what it paid in, nothing lost', () => {
  const s = soloTable();
  assert.deepEqual(s.potIn, [1, 1, 1, 1]);
  runBots(s, c);
  const before = chipsOnTable(s);
  const stacks = s.seats.map((x) => x.chips);
  const pot = s.pot;
  assert.equal(pot, 4);
  tick(s, ctx(1001 + 24 * HOUR));
  assert.equal(s.phase, 'over');
  assert.equal(s.pot, 0);
  assert.equal(chipsOnTable(s), before, 'every chip accounted for');
  s.seats.forEach((x, i) => assert.equal(x.chips, stacks[i] + 1, x.name));
  assert.deepEqual(s.lastResult.awards.map((a) => a.amount), [1, 1, 1, 1]);
  assert.equal(s.lastResult.kind, 'returned');
  assert.ok(s.log.some((l) => /The pot of 4 goes back: Ann 1, Tally · house 1, Brannock 1, Old Wick 1\./.test(l.text)));
  assert.equal(s.chipLog.filter((m) => m.kind === 'refund').length, 4, 'a page can show it');
});

test('24 h close: a raise counts, so the share follows the chips put in', () => {
  const s = soloTable();
  s.pot = 24;
  s.potIn = [12, 6, 6, 0];
  const stacks = s.seats.map((x) => x.chips);
  tick(s, ctx(1001 + 24 * HOUR));
  assert.deepEqual(s.seats.map((x, i) => x.chips - stacks[i]), [12, 6, 6, 0]);
});

test('24 h close: odd chips go to the largest remainders and none vanish', () => {
  const s = soloTable();
  s.pot = 10;
  s.potIn = [5, 3, 2, 1]; // shares 4.54, 2.72, 1.81, 0.90
  const stacks = s.seats.map((x) => x.chips);
  tick(s, ctx(1001 + 24 * HOUR));
  assert.deepEqual(s.seats.map((x, i) => x.chips - stacks[i]), [4, 3, 2, 1]);
  assert.equal(s.pot, 0);
});

test('close: a seat that has left gets nothing more, and its chips are shared among those still here', () => {
  const s = createTable({ lobbyMs: 1000 });
  join(s, 'Ann', c);
  join(s, 'Bo', c);
  tick(s, ctx(3000));
  assert.equal(s.round, 1);
  s.pot = 12;
  s.potIn = [3, 3, 3, 3];
  s.seats[1].left = true;
  s.seats[1].chips = 0;
  const stacks = s.seats.map((x) => x.chips);
  s.deadline = null;
  s.seats.forEach((x) => { x.away = false; });
  s.lastHumanAt = 0;
  s.cfg.waitingIdleMs = 1;
  tick(s, ctx(5000));
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.seats.map((x, i) => x.chips - stacks[i]), [4, 0, 4, 4]);
});

test('close: the last player to leave a carried pot takes their share with them', () => {
  const s = soloTable();
  s.phase = 'settled';
  s.pot = 8;
  s.carried = 8;
  s.potIn = [2, 2, 2, 2];
  const stack = s.seats[0].chips;
  const left = leave(s, 0, c);
  assert.equal(left.amount, stack + 2);
  assert.deepEqual(s.departures, [{ seat: 0, amount: stack + 2 }]);
  assert.equal(s.phase, 'over');
  assert.equal(s.pot, 0);
});

test('close: a tNIGHT table that runs out of players still hands back a carried pot (a chip table stays open and keeps it)', () => {
  const kept = soloTable();
  kept.phase = 'settled';
  kept.pot = 8;
  kept.potIn = [2, 2, 2, 2];
  kept.seats.forEach((x) => { x.chips = 0; });
  startRound(kept, c);
  assert.equal(kept.phase, 'settled', 'play chips: nobody is thrown out for being broke');
  assert.equal(kept.pot, 8, 'the carried pot waits for the next deal');
  const s = soloTable();
  s.cage = { status: 'open' };
  s.phase = 'settled';
  s.pot = 8;
  s.potIn = [2, 2, 2, 2];
  s.seats.forEach((x) => { x.chips = 0; });
  startRound(s, c);
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.seats.map((x) => x.chips), [2, 2, 2, 2]);
});

test('close: with an empty pot nothing is said, and the last result stands', () => {
  const s = soloTable();
  s.pot = 0;
  s.potIn = [];
  s.lastResult = { round: 1, kind: 'settled', pot: 4, awards: [], carried: 0 };
  tick(s, ctx(1001 + 24 * HOUR));
  assert.equal(s.lastResult.kind, 'settled');
  assert.ok(!s.log.some((l) => /goes back/.test(l.text)));
});

test('the shares follow the pot: paid out, they reset; carried, they stay', () => {
  const s = soloTable();
  s.status = ['in', 'in', 'folded', 'folded'];
  s.raise = { by: 0, amount: 1, waiting: [1] };
  act(s, 1, { action: 'fold' }, { ...c, auto: true });
  assert.equal(s.phase, 'settled', 'uncontested');
  assert.equal(s.pot, 0);
  assert.deepEqual(s.potIn, []);
  startRound(s, c);
  assert.deepEqual(s.potIn, [1, 1, 1, 1], 'only this round counts');

  s.phase = 'claim';
  s.lap = { leader: 0, queue: [0, 1, 2, 3], high: 0, by: null, paid: {} };
  for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'check' }, { ...c, auto: true });
  assert.equal(s.lastResult.kind, 'carried');
  assert.deepEqual(s.potIn, [1, 1, 1, 1], 'still in the pot');
  startRound(s, c);
  assert.deepEqual(s.potIn, [2, 2, 2, 2], 'a carried pot keeps its shares');
});

test('a saved table: the house becomes Tally, in its seat and its log, the pot has shares, and the bots still play', () => {
  const s = soloTable();
  const bot = s.seats[1];
  bot.name = 'Halfhand (house)';
  s.log.push({ n: 99, round: 1, text: 'Halfhand (house) raises 5.' }, { n: 100, round: 1, text: 'No hurry.', say: true, seat: 1, name: 'Halfhand (house)' });
  delete s.potIn;
  s.pot = 9;
  assert.equal(upgradeState(s, c), true);
  assert.equal(bot.name, HOUSE_NAME);
  assert.equal(s.log.at(-2).text, 'Tally · house raises 5.');
  assert.equal(s.log.at(-1).name, HOUSE_NAME);
  assert.deepEqual(s.potIn, [2.25, 2.25, 2.25, 2.25]);
  runBots(s, c);
  assert.ok(!s.log.some((l) => l.botError), 'its persona is found');
  assert.equal(upgradeState(s, c), false, 'once is enough');
  tick(s, ctx(1001 + 24 * HOUR));
  assert.equal(chipsOnTable(s), s.seats.reduce((sum, x) => sum + x.chips, 0));
  assert.equal(s.pot, 0);
});

test('the doorman has no seat: nobody at the door is dealt in', () => {
  const s = soloTable();
  assert.deepEqual(s.seats.map((x) => x.name), ['Ann', 'Tally · house', 'Brannock', 'Old Wick']);
});

// ---------- stop and claim, one move ----------

/** Two passes done, in the third window, with these hands. */
function atStop(handStrings = HANDS, cfg) {
  const s = table({ cfg });
  passAll(s); passAll(s);
  s.hands = handStrings.map((h) => h.split(' '));
  return s;
}

test('stop: a claim is required, and nothing moves if it is refused', () => {
  const s = atStop();
  const pot = s.pot;
  for (const claim of [undefined, null, [], [99], 'pair']) {
    assert.equal(code(() => act(s, 0, { action: 'stop', ...(claim === undefined ? {} : { claim }) }, c)), 'bad_claim', JSON.stringify(claim));
  }
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9], raise: 0 }, c)), 'bad_raise');
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9], raise: 26 }, c)), 'bad_raise');
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9], raise: 1.5 }, c)), 'bad_raise');
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9], match: true }, c)), 'bad_stake');
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9], fold: true }, c)), 'bad_stake');
  assert.equal(s.phase, 'pass');
  assert.equal(s.pot, pot);
  assert.deepEqual(s.claims, []);
  assert.equal(s.lap, null);
});

test('stop: what /me offers, and the raise is capped by the stack', () => {
  const s = atStop();
  const stop = legalActions(s, 3).find((a) => a.action === 'stop');
  assert.deepEqual(stop.raise, { min: 1, max: 25 });
  assert.ok(stop.options.length > 50, 'the whole ladder');
  assert.ok(stop.truthful.some((t) => String(t.claim) === '2,14,2'), 'and which are true');
  assert.deepEqual(privateView(s, 3).bestTrue, { claim: [2, 14, 2], label: privateView(s, 3).bestTrue.label, beats: true });
  s.seats[3].chips = 4;
  assert.deepEqual(legalActions(s, 3).find((a) => a.action === 'stop').raise, { min: 1, max: 4 });
  assert.equal(code(() => act(s, 3, { action: 'stop', claim: [1, 14], raise: 5 }, c)), 'bad_raise');
  s.seats[3].chips = 0;
  assert.equal(legalActions(s, 3).find((a) => a.action === 'stop').raise, undefined, 'no chips: still a claim, no raise');
  act(s, 3, { action: 'stop', claim: [1, 14] }, c);
  assert.equal(s.claims[0].seat, 3);
});

test('stop: claim and raise in one action, then the next seat must answer, and also choose', () => {
  const s = atStop();
  const stacks = s.seats.map((x) => x.chips);
  const pot = s.pot;
  act(s, 1, { action: 'stop', claim: [1, 9], raise: 10 }, c);
  assert.equal(s.seats[1].chips, stacks[1] - 10);
  assert.equal(s.pot, pot + 10);
  assert.equal(currentTurn(s), 2);
  assert.deepEqual(s.lap.queue, [2, 3, 0]);
  assert.deepEqual(publicView(s).lapRaise, { high: 10, by: 1, paid: { 1: 10 }, waiting: [2, 3, 0], stopper: 1 });
  assert.deepEqual(publicView(s).top, [1, 9, 0]);
  assert.deepEqual(privateView(s, 2).facing, { high: 10, by: 1, owed: 10, paid: 0 });
  assert.equal(privateView(s, 1).bestTrue, null, 'the stopper has had their say');
  assert.deepEqual(legalActions(s, 1), [], 'and has no turn in the lap');

  const legal = legalActions(s, 2);
  assert.deepEqual(legal.map((a) => a.action), ['claim', 'call', 'check', 'fold']);
  for (const a of legal.filter((x) => x.action !== 'fold')) {
    assert.deepEqual(a.match, { cost: 10, level: 10 }, a.action);
    assert.equal(a.raise.min, 11, a.action);
  }
  for (const move of [{ action: 'check' }, { action: 'claim', claim: [1, 14] }, { action: 'call', seat: 1 }]) {
    assert.equal(code(() => act(s, 2, move, c)), 'must_answer', move.action);
  }
  assert.equal(code(() => act(s, 2, { action: 'claim', claim: [1, 8], match: true }, c)), 'claim_too_low', 'a claim has to beat the stopper');

  act(s, 2, { action: 'claim', claim: [3, 12], match: true }, c); // true, and higher
  act(s, 3, { action: 'call', seat: 1, match: true }, c); // the stopper's 9s were never in this hand: a bluff, caught
  assert.equal(s.claims[0].status, 'caught');
  act(s, 0, { action: 'check', match: true }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.lastResult.kind, 'settled');
  assert.equal(s.lastResult.awards[0].seat, 2);
});

test('stop: a raise after the stopper brings them back for one match-or-fold turn, with nothing new', () => {
  const s = atStop(['9c 9d 2h 5s Kd', 'Ac Ad 2c 2d 6c', 'Qc Qd Qh 6s Td', '3c 4d 7h 8s Jd']);
  const start = s.seats[1].chips;
  act(s, 1, { action: 'stop', claim: [1, 14], raise: 5 }, c);
  act(s, 2, { action: 'claim', claim: [3, 12], raise: 12 }, c);
  act(s, 3, { action: 'fold' }, c);
  act(s, 0, { action: 'fold' }, c);
  assert.equal(s.phase, 'answer');
  assert.equal(currentTurn(s), 1);
  assert.deepEqual(legalActions(s, 1), [
    { action: 'match', cost: 7, level: 12 },
    { action: 'call', seats: [2], match: { cost: 7, level: 12 }, fold: true },
    { action: 'fold' },
  ]);
  assert.equal(code(() => act(s, 1, { action: 'claim', claim: [8] }, c)), 'wrong_phase');
  act(s, 1, { action: 'match' }, c);
  assert.equal(s.seats[1].chips + 0, start - 12 + s.lastResult.awards.find((a) => a.seat === 1).amount);
  assert.deepEqual(s.lastResult.awards.map((a) => a.seat), [2, 1]);
});

test('stop: when every other seat folds the stopper wins, and the claim stands on the record like any uncalled claim', () => {
  const s = atStop();
  const reps = JSON.stringify(s.seats.map((x) => x.rep));
  act(s, 1, { action: 'stop', claim: [7, 14], raise: 10 }, c); // four aces: a bluff, in a hand of 3c 4d 7h 8s Jd
  const before = s.seats[1].chips;
  const pot = s.pot;
  for (const seat of [2, 3, 0]) act(s, seat, { action: 'fold' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.seats[1].chips, before + pot);
  const label = s.claims[0] && publicView(s).claims[0].label;
  assert.deepEqual(publicView(s).claims, [{ seat: 1, claim: [7, 14, 0], label, status: 'standing' }]);
  const { claims, folded, money, ...result } = s.lastResult;
  assert.deepEqual(result, { round: 1, kind: 'uncontested', pot, awards: [{ seat: 1, amount: pot, claim: [7, 14, 0], label }], carried: 0 });
  assert.ok(Array.isArray(claims) && Array.isArray(folded) && Array.isArray(money));
  assert.equal(JSON.stringify(s.seats.map((x) => x.rep)), reps, 'never called, so the record is what an uncalled claim leaves it');
  assert.ok(s.log.at(-1).text.includes(label), s.log.at(-1).text);
  assert.ok(publicView(s).deal.opened.deck.includes('3c'), 'the deck opens with the round over, so the record can show it (the deck seal, 2026-11-07)');
  assert.ok(!JSON.stringify({ ...publicView(s), deal: null }).includes('3c'), 'and nothing else in the public view names a card');
});

test('stop: an all-fold win with no claim has no claim on its award', () => {
  const s = table();
  passAll(s);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 3 }, c);
  for (const seat of [1, 2, 3]) act(s, seat, { action: 'fold' }, c);
  assert.equal(s.lastResult.kind, 'uncontested');
  assert.equal(s.lastResult.awards[0].claim, undefined);
});

test('stop: if a bluff is caught and nobody else claims, the pot carries; if the stopper folds to a raise, the claim is withdrawn', () => {
  const s = atStop();
  act(s, 1, { action: 'stop', claim: [7, 14] }, c);
  act(s, 2, { action: 'call', seat: 1 }, c);
  assert.equal(s.claims[0].status, 'caught');
  assert.equal(s.seats[1].rep.caught, 1);
  for (const seat of [3, 0]) act(s, seat, { action: 'check' }, c);
  assert.equal(s.lastResult.kind, 'carried');

  const t = atStop();
  act(t, 1, { action: 'stop', claim: [1, 3] }, c);
  act(t, 2, { action: 'check', raise: 25 }, c);
  act(t, 3, { action: 'fold' }, c);
  act(t, 0, { action: 'fold' }, c);
  assert.equal(t.phase, 'answer');
  act(t, 1, { action: 'fold' }, c);
  assert.equal(t.claims[0].status, 'withdrawn');
  assert.equal(t.lastResult.kind, 'uncontested');
  assert.equal(t.lastResult.awards[0].seat, 2);
  assert.equal(t.lastResult.awards[0].claim, undefined, 'seat 2 never claimed');
});

test('five passes and nobody stops: the starter still opens an empty lap', () => {
  const s = table();
  while (s.phase === 'pass') passAll(s);
  assert.equal(currentTurn(s), s.starter);
  assert.deepEqual(s.claims, []);
  assert.deepEqual(s.lap.queue, [0, 1, 2, 3]);
});

test('an away seat in the lap answers a stopper\'s raise by folding, and checks when there is none', () => {
  const s = atStop();
  s.seats[2].away = true;
  act(s, 1, { action: 'stop', claim: [1, 9], raise: 10 }, c);
  assert.equal(s.status[2], 'folded');
  assert.equal(currentTurn(s), 3);
  const t = atStop();
  t.seats[2].away = true;
  act(t, 1, { action: 'stop', claim: [1, 9] }, c);
  assert.equal(t.status[2], 'in');
  assert.equal(currentTurn(t), 3);
});

// ---------- the after-lap call ----------

/** The lap has gone round and seat 3, the last turn, claimed and raised. Everyone else is left to answer. */
function lastSeatRaised(claim = [7, 14], raise = 12, handStrings = ['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c']) {
  const s = lap(handStrings);
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'check' }, c);
  act(s, 2, { action: 'check' }, c);
  act(s, 3, { action: 'claim', claim, raise }, c);
  assert.equal(s.phase, 'answer');
  assert.equal(currentTurn(s), 0);
  return s;
}

test('after-lap call: the last seat\'s raised bluff is caught, and pays the sting, and is out of the pot', () => {
  const s = lastSeatRaised(); // four Aces, in a hand with two
  const liar = s.seats[3].chips;
  const me = s.seats[0].chips;
  assert.deepEqual(legalActions(s, 0).find((a) => a.action === 'call'), { action: 'call', seats: [3], match: { cost: 12, level: 12 }, fold: true });
  act(s, 0, { action: 'call', seat: 3, match: true }, c);
  const called = s.claims.find((x) => x.seat === 3);
  assert.equal(called.status, 'caught');
  assert.equal(s.seats[3].chips, liar - 5);
  assert.equal(s.seats[3].rep.caught, 1);
  assert.equal(s.lap.paid[0], 12);
  assert.equal(currentTurn(s), 1, 'the raise still stands, for whoever owes it');
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'fold' }, c);
  assert.equal(s.phase, 'settled');
  assert.deepEqual(s.lastResult.awards.map((a) => a.seat), [0]);
  assert.equal(s.seats[0].chips, me + 5 - 12 + s.lastResult.pot);
});

test('after-lap call: a true claim is proven and the caller pays, and can fold instead of matching', () => {
  const s = lastSeatRaised([2, 14, 2]);
  const claimer = s.seats[3].chips;
  const me = s.seats[1].chips;
  act(s, 0, { action: 'match' }, c);
  act(s, 1, { action: 'call', seat: 3, fold: true }, c);
  assert.equal(s.claims.find((x) => x.seat === 3).status, 'proven');
  assert.equal(s.seats[3].chips, claimer + 5);
  assert.equal(s.seats[1].chips, me - 5, 'the sting and no more');
  assert.equal(s.status[1], 'folded');
  assert.equal(currentTurn(s), 2);
  assert.equal(legalActions(s, 2).some((a) => a.action === 'call' && a.seats.includes(3)), false, 'a claim is called once');
});

test('after-lap call: it comes with a match or a fold, and nothing else can come with it', () => {
  const s = lastSeatRaised();
  const before = JSON.stringify(s);
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 3 }, c)), 'must_answer');
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 3, raise: 20 }, c)), 'bad_stake');
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 3, match: true, fold: true }, c)), 'bad_stake');
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 0, match: true }, c)), 'bad_call');
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 1, match: true }, c)), 'no_such_claim');
  assert.equal(code(() => act(s, 1, { action: 'call', seat: 3, match: true }, c)), 'not_your_turn');
  assert.equal(code(() => act(s, 0, { action: 'claim', claim: [8], match: true }, c)), 'wrong_phase');
  assert.equal(code(() => act(s, 0, { action: 'check', match: true }, c)), 'wrong_phase');
  assert.equal(JSON.stringify(s), before, 'nothing moved');
});

test('after-lap call: stacks too short to do both', () => {
  const s = lastSeatRaised();
  s.seats[0].chips = 13; // can match 12, or call for 5, not both
  const legal = legalActions(s, 0);
  assert.ok(legal.some((a) => a.action === 'match'));
  assert.deepEqual(legal.find((a) => a.action === 'call'), { action: 'call', seats: [3], fold: true });
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 3, match: true }, c)), 'short_stack');
  s.seats[0].chips = 4; // can't afford to call at all
  assert.deepEqual(legalActions(s, 0), [{ action: 'fold' }]);
});

test('after-lap call: a seat caught before its turn has nothing left to answer', () => {
  const s = lap(['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c']);
  act(s, 0, { action: 'check' }, c);
  act(s, 1, { action: 'claim', claim: [7, 14] }, c); // a bluff, and it owes the raise to come
  act(s, 2, { action: 'claim', claim: [8] }, c);
  act(s, 3, { action: 'check', raise: 5 }, c);
  assert.equal(s.phase, 'answer');
  assert.deepEqual(s.lap.queue, [0, 1, 2]);
  act(s, 0, { action: 'call', seat: 1, fold: true }, c);
  assert.equal(s.claims.find((x) => x.seat === 1).status, 'caught');
  assert.deepEqual(s.lap.queue, [2], 'seat 1 is out of the pot, so its turn is gone');
  assert.equal(currentTurn(s), 2);
});

test('after-lap call: catching the only claim ends the round, and the pot carries', () => {
  const s = lap(['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c']);
  for (const seat of [0, 1, 2]) act(s, seat, { action: 'check' }, c);
  act(s, 3, { action: 'claim', claim: [7, 14], raise: 12 }, c);
  act(s, 0, { action: 'call', seat: 3, fold: true }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.lastResult.kind, 'carried');
});

test('after-lap call: a call and fold on a true claim that leaves its maker alone pays them, with the claim on the award', () => {
  const s = lap(['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c']);
  act(s, 0, { action: 'check' }, c);
  act(s, 1, { action: 'check' }, c);
  act(s, 2, { action: 'check' }, c);
  act(s, 3, { action: 'claim', claim: [2, 14, 2], raise: 12 }, c);
  act(s, 0, { action: 'fold' }, c);
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'call', seat: 3, fold: true }, c);
  assert.equal(s.lastResult.kind, 'uncontested');
  assert.deepEqual(s.lastResult.awards[0].claim, [2, 14, 2]);
  assert.equal(s.claims[0].status, 'proven');
});

test('after-lap call: nobody to call means no call option, and an unraised last claim still has no after-lap turn', () => {
  const alone = lap(['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c']);
  act(alone, 0, { action: 'claim', claim: [1, 9] }, c);
  act(alone, 1, { action: 'check' }, c);
  act(alone, 2, { action: 'check', raise: 3 }, c);
  act(alone, 3, { action: 'fold' }, c);
  assert.equal(alone.phase, 'answer');
  assert.deepEqual(legalActions(alone, 0).map((a) => a.action), ['match', 'fold'], 'only its own claim stands');

  const plain = lap(['9c 9d 2h 5s Kd', '3c 4d 7h 8s Jd', 'Qc Qd Qh 6s Td', 'Ac Ad 2c 2d 6c']);
  for (const seat of [0, 1, 2]) act(plain, seat, { action: 'check' }, c);
  act(plain, 3, { action: 'claim', claim: [7, 14] }, c);
  assert.equal(plain.phase, 'settled', 'no raise, no turn, as the rule says');
  assert.equal(plain.lastResult.awards[0].seat, 3);
});

test('after-lap call: two seats never take two stings', () => {
  let biggest = 0;
  for (let g = 1; g <= 400; g++) {
    const rng = makeRng(g + 5000);
    const context = { now: 1000, rng, auto: true };
    const s = createTable({ seats: 2, lobbyMs: 60_000 });
    for (const name of ['A', 'B']) join(s, name, context, { chips: 100_000 });
    while (s.phase === 'pass') for (const seat of [0, 1]) if (s.phase === 'pass') act(s, seat, { action: 'pass', card: s.hands[seat][0] }, context);
    const stings = [0, 0];
    for (let i = 0; i < 20 && ['claim', 'answer'].includes(s.phase); i++) {
      const seat = currentTurn(s);
      const legal = legalActions(s, seat);
      const m = legal[Math.floor(rng() * legal.length)];
      const stake = m.raise && rng() < 0.6 ? { raise: m.raise.min + Math.floor(rng() * (m.raise.max - m.raise.min + 1)) } : m.match && typeof m.match === 'object' ? { match: true } : m.fold ? { fold: true } : {};
      const body = m.action === 'claim' ? { action: 'claim', claim: m.options[Math.floor(rng() * m.options.length)].claim, ...stake } : m.action === 'call' ? { action: 'call', seat: m.seats[0], ...stake } : m.action === 'check' ? { action: 'check', ...stake } : { action: m.action };
      if (body.action === 'call') {
        const proven = () => s.claims.find((x) => x.seat === body.seat)?.status === 'proven';
        act(s, seat, body, context);
        stings[proven() ? seat : body.seat] += 1;
      } else act(s, seat, body, context);
    }
    biggest = Math.max(biggest, ...stings);
    assert.ok(stings.every((n) => n <= 1), `table ${g}: ${stings}`);
  }
  assert.equal(biggest, 1, 'the play reached a sting');
});

// ---------- leaving and coming back ----------

test('a buy-in sets the stack; bots are unaffected', () => {
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', c, { chips: 250 });
  assert.equal(s.seats[0].chips, 249);
  assert.equal(s.seats[1].chips, 99);
});

test('leaving records what they left with, publicly, as the log already says', () => {
  const s = soloTable();
  s.phase = 'settled';
  s.seats[0].chips = 209;
  s.pot = 0;
  s.potIn = [];
  leave(s, 0, c);
  assert.equal(publicView(s).seats[0].leftWith, 209);
  assert.equal(s.seats[0].chips, 0);
});

test('sitting back down: a table closed by the last one out opens again, and plays on with the same bots', () => {
  const s = soloTable();
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  s.seats[0].chips = 209;
  s.seats[2].chips = 77;
  leave(s, 0, c);
  assert.equal(s.phase, 'over');
  sitBackDown(s, 0, 209, ctx(5000));
  assert.equal(s.phase, 'settled');
  assert.equal(s.overReason, null);
  assert.equal(s.deadline, null, 'solo: no clock');
  assert.equal(s.lastHumanAt, 5000);
  assert.deepEqual([s.seats[0].left, s.seats[0].chips, s.seats[0].leftWith], [false, 209, null]);
  assert.equal(s.seats[2].chips, 77, 'the bots keep theirs');
  assert.deepEqual(legalActions(s, 0), [{ action: 'next' }]);
  act(s, 0, { action: 'next' }, ctx(5000));
  assert.equal(s.round, 2);
  assert.equal(s.status[0], 'in');
  assert.equal(s.seats[0].chips, 208);
});

test('sitting back down in a round already running: out until the next deal, and nothing waits on them', () => {
  const s = createTable({ lobbyMs: 1000 });
  join(s, 'Ann', c);
  join(s, 'Bo', c);
  tick(s, ctx(3000));
  s.status[1] = 'out';
  s.seats[1].left = true;
  s.seats[1].leftWith = 50;
  s.seats[1].chips = 0;
  s.passes[1] = null;
  sitBackDown(s, 1, 50, ctx(3100));
  assert.equal(s.phase, 'pass');
  assert.equal(s.status[1], 'out');
  assert.ok(!publicView(s).waitingOn.includes(1));
  assert.deepEqual(legalActions(s, 1), []);
  assert.equal(s.seats[1].chips, 50);
});

// ---------- standing up after too long away, and adding chips ----------

function mixedTable() {
  const s = createTable({ lobbyMs: 1000 });
  join(s, 'Ann', c);
  join(s, 'Bo', c);
  tick(s, ctx(3000));
  assert.equal(s.round, 1);
  return s;
}

const MIN = 60_000;

test('away: at a table with others, the clock runs from when they went away, 30 minutes by default', () => {
  const s = mixedTable();
  assert.equal(nextStandAt(s), null, 'nobody away');
  s.deadline = 5000;
  s.seats[1].away = true;
  s.seats[1].awaySince = 5000;
  assert.equal(nextStandAt(s), 5000 + 30 * MIN);
  s.phase = 'settled';
  s.seats[1].chips = 77;
  s.deadline = 5000 + 60 * MIN;
  assert.equal(tick(s, ctx(5000 + 30 * MIN - 1)), false, 'not yet');
  assert.equal(s.seats[1].left, undefined);
  assert.equal(tick(s, ctx(5000 + 30 * MIN)), true);
  assert.equal(s.seats[1].left, true);
  assert.deepEqual(s.departures, [{ seat: 1, amount: 77, stood: true }], 'the table pays that to the purse');
  assert.equal(nextStandAt(s), 5000 + 60 * MIN, 'the table is solo now: the one left stands 30 minutes from here, not from their last move before');
});

test('away: in a round, they stand when it ends, and coming back in time cancels it', () => {
  const s = mixedTable();
  s.seats[1].away = true;
  s.seats[1].awaySince = 1000;
  s.deadline = 1000 + 60 * MIN;
  tick(s, ctx(1000 + 30 * MIN));
  assert.equal(s.seats[1].left, undefined, 'not mid-round');
  assert.equal(s.seats[1].leaving, true);
  assert.equal(nextStandAt(s), null, 'nothing more to wait for');
  act(s, 1, { action: 'back' }, ctx(1000 + 31 * MIN));
  assert.deepEqual([s.seats[1].leaving, s.seats[1].away, s.seats[1].awaySince], [false, false, null], 'still seated');
});

test('away: a solo table has no Away clock, but its one seat stands after 30 minutes untouched all the same (11-07)', () => {
  const s = soloTable();
  s.seats[0].away = true;
  s.seats[0].awaySince = 1000;
  assert.equal(nextStandAt(s), 1000 + 30 * MIN);
  assert.equal(tick(s, ctx(1000 + 12 * HOUR)), true);
  assert.ok(s.seats[0].left || s.seats[0].leaving, 'stood up, or leaving once the round it was dealt plays out');
});

test('away: a timeout starts the clock once, and a saved table starts it on load', () => {
  const s = mixedTable();
  s.deadline = 3500;
  tick(s, ctx(3500));
  assert.equal(s.seats[0].awaySince, 3500);
  const saved = mixedTable();
  saved.seats[0].away = true;
  assert.equal(upgradeState(saved, ctx(9000)), true);
  assert.equal(saved.seats[0].awaySince, 9000);
  assert.equal(upgradeState(saved, ctx(9500)), false);
});

test('adding chips: between rounds only; never while leaving or away; the stack takes it', () => {
  const s = soloTable();
  const code = (fn) => { try { fn(); return null; } catch (err) { return err.code; } };
  assert.equal(code(() => checkAddChips(s, 0, 10)), 'not_between_rounds', 'in a round');
  assert.equal(privateView(s, 0).canAddChips, false);
  s.phase = 'settled';
  assert.equal(privateView(s, 0).canAddChips, true);
  assert.equal(code(() => checkAddChips(s, 0, 10)), null);
  for (const bad of [0, -1, 1.5, '5', undefined]) assert.equal(code(() => checkAddChips(s, 0, bad)), 'bad_amount', String(bad));
  s.seats[0].away = true;
  assert.equal(code(() => checkAddChips(s, 0, 10)), 'not_between_rounds');
  s.seats[0].away = false;
  s.seats[0].leaving = true;
  assert.equal(privateView(s, 0).canAddChips, false);
  s.seats[0].leaving = false;
  const before = s.seats[0].chips;
  addChips(s, 0, 40, ctx(7000));
  assert.equal(s.seats[0].chips, before + 40);
  assert.equal(s.lastHumanAt, 7000);
  assert.equal(s.log.at(-1).text, 'Ann adds 40 chips.');
});

// ---------- raising in the claim lap ----------

/** The lap on four humans, with a pot worth playing for. */
function raiseLap() {
  const s = lap(HANDS);
  s.pot = 12;
  return s;
}
const lapMoves = (s, seat) => Object.fromEntries(legalActions(s, seat).map((m) => [m.action, m]));
const raiseOf = (s) => { const { high, by, paid } = publicView(s).lapRaise; return { high, by, paid }; };

test('lap raise: check, claim and call can each carry one, and the pot and the level move', () => {
  const s = raiseLap();
  assert.deepEqual(raiseOf(s), { high: 0, by: null, paid: {} });
  assert.deepEqual(lapMoves(s, 0).check, { action: 'check', raise: { min: 1, max: 25 } });
  assert.deepEqual(lapMoves(s, 0).claim.raise, { min: 1, max: 25 });
  assert.equal(lapMoves(s, 0).fold, undefined, 'nothing to fold to');

  const pot = s.pot;
  act(s, 0, { action: 'check', raise: 4 }, c);
  assert.equal(s.pot, pot + 4);
  assert.deepEqual(raiseOf(s), { high: 4, by: 0, paid: { 0: 4 } });
  s.hands[1] = ['9c', '9d', '2h', '5s', 'Kc'];
  act(s, 1, { action: 'claim', claim: [1, 9], raise: 9 }, c);
  assert.equal(s.claims[0].status, 'standing');
  assert.equal(s.pot, pot + 13);
  act(s, 2, { action: 'call', seat: 1, raise: 12 }, c);
  assert.equal(s.claims[0].status, 'proven', 'seat 1 holds the 9s');
  assert.deepEqual(raiseOf(s), { high: 12, by: 2, paid: { 0: 4, 1: 9, 2: 12 } });
  assert.ok(s.log.some((l) => l.text === 'Ann checks.') && s.log.some((l) => l.text === 'Ann raises to 4.'));
});

test('lap raise: above the highest, up to the limit, within your chips; once a lap because a seat has one turn', () => {
  const s = raiseLap();
  act(s, 0, { action: 'check', raise: 10 }, c);
  assert.deepEqual(lapMoves(s, 1).check.raise, { min: 11, max: 25 });
  for (const n of [10, 3, 26, 11.5, '12']) assert.equal(code(() => act(s, 1, { action: 'check', raise: n }, c)), 'bad_raise', `raise ${n}`);
  assert.equal(s.lap.high, 10, 'a refused raise moved nothing');
  assert.equal(currentTurn(s), 1);
  s.seats[1].chips = 8;
  assert.equal(lapMoves(s, 1).check, undefined, 'it can’t cover 10, so it can only fold');
  s.seats[1].chips = 15;
  assert.deepEqual(lapMoves(s, 1).check.raise, { min: 11, max: 15 });
  act(s, 1, { action: 'check', raise: 15 }, c);
  assert.equal(code(() => act(s, 1, { action: 'check', raise: 20 }, c)), 'not_your_turn');
  act(s, 2, { action: 'check', match: true }, c);
  act(s, 3, { action: 'check', match: true }, c);
  assert.equal(s.phase, 'settled', 'no claim stands, so nobody is asked to answer');
});

test('lap raise: a seat facing one must answer alongside its move, and plain moves are refused', () => {
  const s = raiseLap();
  act(s, 0, { action: 'claim', claim: [1, 9], raise: 12 }, c);
  assert.deepEqual(privateView(s, 1).facing, { high: 12, by: 0, owed: 12, paid: 0 });
  assert.equal(privateView(s, 0).facing, null, 'the raiser has matched itself');
  const moves = lapMoves(s, 1);
  assert.deepEqual(moves.check, { action: 'check', raise: { min: 13, max: 25 }, match: { cost: 12, level: 12 } });
  assert.deepEqual(moves.call.match, { cost: 12, level: 12 });
  assert.equal(moves.call.fold, true);
  assert.deepEqual(moves.fold, { action: 'fold' });
  assert.deepEqual(moves.claim.match, { cost: 12, level: 12 });
  for (const body of [{ action: 'check' }, { action: 'claim', claim: [8] }, { action: 'call', seat: 0 }]) assert.equal(code(() => act(s, 1, body, c)), 'must_answer', body.action);
  assert.equal(code(() => act(s, 1, { action: 'claim', claim: [8], fold: true }, c)), 'bad_stake', 'a claim you fold is nothing');
  assert.equal(code(() => act(s, 1, { action: 'check', raise: 14, match: true }, c)), 'bad_stake', 'one of the three');
  assert.equal(code(() => act(s, 1, { action: 'raise', n: 14 }, c)), 'wrong_phase', 'a raise goes with a move');
  assert.equal(code(() => act(s, 1, { action: 'match' }, c)), 'wrong_phase', 'a match goes with a move');
  assert.equal(s.claims.length, 1, 'refused moves changed nothing');
  assert.equal(s.seats[1].chips, 99);

  const pot = s.pot;
  act(s, 1, { action: 'check', match: true }, c);
  assert.equal(s.pot, pot + 12);
  assert.equal(s.seats[1].chips, 99 - 12);
  assert.ok(s.log.some((l) => l.text === 'Bo stays in for 12.'));
});

test('lap raise: a higher raise covers the match, and with no raise to answer, match and fold are refused', () => {
  const s = raiseLap();
  assert.equal(code(() => act(s, 0, { action: 'check', match: true }, c)), 'no_raise_to_answer');
  assert.equal(code(() => act(s, 0, { action: 'fold' }, c)), 'no_raise_to_answer');
  act(s, 0, { action: 'check', raise: 5 }, c);
  const before = s.seats[1].chips;
  act(s, 1, { action: 'check', raise: 7 }, c);
  assert.equal(before - s.seats[1].chips, 7, 'raising to 7 costs 7, not 12');
});

test('lap raise: folding on your turn: chips already in stay in, and you take no further part', () => {
  const s = raiseLap();
  act(s, 0, { action: 'claim', claim: [1, 9], raise: 5 }, c);
  const pot = s.pot;
  const chips = s.seats[1].chips;
  act(s, 1, { action: 'fold' }, c);
  assert.equal(s.status[1], 'folded');
  assert.equal(s.pot, pot);
  assert.equal(s.seats[1].chips, chips);
  assert.deepEqual(legalActions(s, 1), []);
  assert.equal(currentTurn(s), 2);
  assert.equal(privateView(s, 1).facing, null);
});

test('lap raise: a raised claim can still be called and caught, by a seat that folds for the price of the stake', () => {
  const s = raiseLap();
  s.hands[0] = ['2c', '4d', '7h', '9s', 'Kc'];
  act(s, 0, { action: 'claim', claim: [3, 14], raise: 25 }, c);
  const callerChips = s.seats[1].chips;
  const claimerChips = s.seats[0].chips;
  const pot = s.pot;
  act(s, 1, { action: 'call', seat: 0, fold: true }, c);
  assert.equal(s.claims[0].status, 'caught');
  assert.equal(s.status[1], 'folded');
  assert.equal(s.seats[1].chips, callerChips + 5, 'the caller gains the sting and pays no raise');
  assert.equal(s.seats[0].chips, claimerChips - 5);
  assert.equal(s.pot, pot, 'the bluffer’s raise stays in the pot');
  assert.equal(s.lap.high, 25, 'and the level stands');

  const proven = raiseLap();
  proven.hands[0] = ['9c', '9d', '2h', '5s', 'Kc'];
  act(proven, 0, { action: 'claim', claim: [1, 9], raise: 10 }, c);
  const before = proven.seats[1].chips;
  act(proven, 1, { action: 'call', seat: 0, fold: true }, c);
  assert.equal(proven.claims[0].status, 'proven');
  assert.equal(proven.seats[1].chips, before - 5, 'a true claim stings the caller, and the fold costs nothing more');
  assert.equal(proven.status[1], 'folded');
});

test('lap raise: a call with a match or a raise reserves the whole stake, so what is refused gives nothing away', () => {
  for (const hand of [['9c', '9d', '2h', '5s', 'Kc'], ['2c', '4d', '7h', '9s', 'Kc']]) { // a true claim, and a bluff
    const s = raiseLap();
    s.hands[0] = hand;
    act(s, 0, { action: 'claim', claim: [1, 9], raise: 10 }, c);
    s.seats[1].chips = 14;
    const moves = lapMoves(s, 1);
    assert.equal(moves.call.match, undefined, 'stake 5 plus 10 is 15');
    assert.equal(moves.call.fold, true, 'it can still call and fold');
    assert.deepEqual(moves.check.match, { cost: 10, level: 10 });
    assert.equal(code(() => act(s, 1, { action: 'call', seat: 0, match: true }, c)), 'short_stack');
    assert.equal(s.claims[0].status, 'standing', 'refused before the call resolved');
    s.seats[1].chips = 15;
    assert.deepEqual(lapMoves(s, 1).call.match, { cost: 10, level: 10 });
    assert.equal(lapMoves(s, 1).call.raise, undefined, 'nothing over 10 after the stake');
    s.seats[1].chips = 17;
    assert.deepEqual(lapMoves(s, 1).call.raise, { min: 11, max: 12 });
  }
});

test('lap raise: a short stack can only fold, or call and fold if it has the stake', () => {
  const s = raiseLap();
  act(s, 0, { action: 'claim', claim: [1, 9], raise: 20 }, c);
  s.seats[1].chips = 7;
  assert.deepEqual(legalActions(s, 1).map((m) => m.action), ['call', 'fold']);
  assert.equal(code(() => act(s, 1, { action: 'check', match: true }, c)), 'short_stack');
  s.seats[1].chips = 3;
  assert.deepEqual(legalActions(s, 1).map((m) => m.action), ['fold']);
});

// ---------- after the lap: match or fold ----------

/** Seat 0 claims, seat 1 checks, seat 2 claims and raises, seat 3 is what the test says. */
function toAnswers(level = 12, last = { action: 'check', match: true }) {
  const s = raiseLap();
  act(s, 0, { action: 'claim', claim: [1, 9] }, c);
  act(s, 1, { action: 'check' }, c);
  act(s, 2, { action: 'claim', claim: [3, 12], raise: level }, c);
  act(s, 3, last, c);
  return s;
}

test('answers: only seats still in that have not matched, starting after the raiser, and with no new moves', () => {
  const s = toAnswers();
  assert.equal(s.phase, 'answer');
  assert.deepEqual(publicView(s).lapRaise, { high: 12, by: 2, paid: { 2: 12, 3: 12 }, waiting: [0, 1], stopper: null });
  assert.equal(currentTurn(s), 0);
  assert.deepEqual(publicView(s).waitingOn, [0]);
  assert.deepEqual(legalActions(s, 0), [{ action: 'match', cost: 12, level: 12 }, { action: 'call', seats: [2], match: { cost: 12, level: 12 }, fold: true }, { action: 'fold' }]);
  assert.deepEqual(legalActions(s, 2), [], 'the raiser has nothing to answer');
  assert.deepEqual(legalActions(s, 3), [], 'nor has a seat that matched');
  assert.ok(s.log.some((l) => l.text === 'The raise stands at 12. Ann to stay in or fold.'));
  for (const body of [{ action: 'claim', claim: [8] }, { action: 'check' }, { action: 'raise', n: 20 }]) {
    assert.equal(code(() => act(s, 0, body, c)), 'wrong_phase', body.action);
  }
  assert.equal(code(() => act(s, 0, { action: 'call', seat: 2 }, c)), 'must_answer', 'a call has to say which');
  assert.equal(code(() => act(s, 1, { action: 'match' }, c)), 'not_your_turn');
  act(s, 0, { action: 'match' }, c);
  assert.equal(s.phase, 'answer', 'seat 1 still owes');
  act(s, 1, { action: 'fold' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(s.lastResult.kind, 'settled');
});

test('answers: matching pays only the difference, so a seat that raised earlier tops up, and a lap costs 25 at most', () => {
  const s = raiseLap();
  act(s, 0, { action: 'claim', claim: [1, 9], raise: 5 }, c);
  act(s, 1, { action: 'check', raise: 12 }, c);
  act(s, 2, { action: 'check', raise: 25 }, c);
  act(s, 3, { action: 'check', match: true }, c);
  assert.equal(s.phase, 'answer');
  assert.deepEqual(privateView(s, 0).facing, { high: 25, by: 2, owed: 20, paid: 5 });
  assert.deepEqual(legalActions(s, 0)[0], { action: 'match', cost: 20, level: 25 });
  const chips = s.seats[0].chips;
  act(s, 0, { action: 'match' }, c);
  assert.equal(chips - s.seats[0].chips, 20);
  assert.equal(s.lastResult ?? null, null);
  act(s, 1, { action: 'match' }, c);
  assert.equal(s.phase, 'settled');
  assert.equal(99 - s.seats[1].chips, 25, 'seat 1 paid 12, then 13, and shared no pot');
});

test('answers: a fold withdraws the claim, it cannot share the pot, and the chips it paid stay in', () => {
  const s = toAnswers();
  const pot = s.pot;
  act(s, 0, { action: 'fold' }, c);
  assert.equal(s.claims.find((x) => x.seat === 0).status, 'withdrawn');
  assert.equal(s.pot, pot);
  assert.ok(s.log.some((l) => l.text === 'Ann folds and withdraws the claim.'));
  act(s, 1, { action: 'match' }, c);
  assert.equal(s.lastResult.kind, 'settled');
  assert.deepEqual(s.lastResult.awards.map((a) => a.seat), [2], 'a lone claim, so seat 2 takes it all');
  assert.equal(s.lastResult.pot, pot + 12);
});

test('answers: a short stack can only fold, and an unanswered seat that left is not waited for', () => {
  const s = toAnswers();
  s.seats[0].chips = 11;
  assert.deepEqual(legalActions(s, 0), [{ action: 'call', seats: [2], fold: true }, { action: 'fold' }]);
  assert.equal(code(() => act(s, 0, { action: 'match' }, c)), 'short_stack');
  s.seats[0].chips = 4;
  assert.deepEqual(legalActions(s, 0), [{ action: 'fold' }], 'and with less than the stake, no call either');
});

test('answers: nothing to answer: no raise, no claim standing, or every claim gone', () => {
  const plain = raiseLap();
  act(plain, 0, { action: 'claim', claim: [1, 9] }, c);
  for (const seat of [1, 2, 3]) act(plain, seat, { action: 'check' }, c);
  assert.equal(plain.phase, 'settled', 'no raise: it settles as it always did');
  assert.equal(plain.lastResult.kind, 'settled');

  const empty = raiseLap();
  act(empty, 0, { action: 'check' }, c);
  act(empty, 1, { action: 'check' }, c);
  act(empty, 2, { action: 'check' }, c);
  act(empty, 3, { action: 'check', raise: 10 }, c);
  assert.equal(empty.phase, 'settled', 'a raise with no claim standing asks nobody for anything');
  assert.equal(empty.lastResult.kind, 'carried');

  const gone = toAnswers(12, { action: 'check', match: true });
  gone.claims.find((x) => x.seat === 2).status = 'caught'; // as if called in the lap
  act(gone, 0, { action: 'fold' }, c);
  assert.equal(gone.phase, 'settled', 'the last claim went, so seat 1 is not asked');
  assert.equal(gone.lastResult.kind, 'carried');
});

test('answers: a seat caught bluffing gets no turn, and one that called and paid does', () => {
  const s = raiseLap();
  s.hands[0] = ['2c', '4d', '7h', '9s', 'Kc'];
  act(s, 0, { action: 'claim', claim: [3, 14] }, c);
  act(s, 1, { action: 'call', seat: 0 }, c);
  assert.equal(s.claims[0].status, 'caught');
  act(s, 2, { action: 'claim', claim: [3, 12], raise: 8 }, c);
  act(s, 3, { action: 'check', match: true }, c);
  assert.equal(s.phase, 'answer');
  assert.deepEqual(publicView(s).lapRaise.waiting, [1], 'seat 0 is out of the pot');
});

test('everyone else folds: the pot is uncontested, whoever is left, but never to a seat caught bluffing', () => {
  const s = raiseLap();
  act(s, 0, { action: 'check', raise: 5 }, c);
  act(s, 1, { action: 'fold' }, c);
  act(s, 2, { action: 'fold' }, c);
  const { pot } = s;
  const chips = s.seats[0].chips;
  act(s, 3, { action: 'fold' }, c);
  assert.equal(s.lastResult.kind, 'uncontested');
  assert.equal(s.seats[0].chips, chips + pot);

  const bluff = raiseLap();
  bluff.hands[0] = ['2c', '4d', '7h', '9s', 'Kc'];
  act(bluff, 0, { action: 'claim', claim: [3, 14], raise: 5 }, c);
  act(bluff, 1, { action: 'call', seat: 0, fold: true }, c);
  act(bluff, 2, { action: 'fold' }, c);
  act(bluff, 3, { action: 'fold' }, c);
  assert.equal(bluff.lastResult.kind, 'carried', 'the only seat not folded was caught, so nobody takes it');
  assert.equal(bluff.seats[0].chips, 99 - 5 - 5);
});

test('answers: nobody is kept waiting: away seats fold to a raise and check otherwise, never raising or calling', () => {
  const s = raiseLap();
  s.seats[1].away = true;
  s.seats[1].awaySince = 1000;
  assert.deepEqual(autoAction(s, 1, c), { action: 'check' });
  act(s, 0, { action: 'claim', claim: [1, 9], raise: 5 }, c);
  assert.deepEqual(autoAction(s, 1, c), { action: 'fold' });
  assert.equal(s.status[1], 'folded', 'it moved for itself at once');
  assert.equal(currentTurn(s), 2);

  const later = raiseLap();
  act(later, 0, { action: 'claim', claim: [1, 9] }, c);
  later.seats[0].away = true;
  later.seats[0].awaySince = 1000;
  act(later, 1, { action: 'claim', claim: [1, 10] }, c);
  act(later, 2, { action: 'check', raise: 6 }, c);
  act(later, 3, { action: 'check', match: true }, c);
  assert.equal(later.claims[0].status, 'withdrawn', 'away after the lap: the raise is folded to');
  assert.equal(later.phase, 'answer');
  assert.equal(currentTurn(later), 1);
});

test('answers: a human who runs out the clock is marked away and folds', () => {
  const s = toAnswers();
  const context = { now: s.deadline, rng: makeRng(3) };
  assert.ok(tick(s, context));
  assert.equal(s.seats[0].away, true);
  assert.equal(s.claims[0].status, 'withdrawn');
  assert.equal(currentTurn(s), 1);
});

// ---------- bots in the claim lap ----------

function botSpot(bot, { hand, claims = [], high = 0, by = null, paid = {}, chips = 100, pot = 30 }) {
  const s = raiseLap();
  s.seats[1].name = bot;
  s.seats[1].bot = true;
  s.seats[1].chips = chips;
  s.hands[1] = hand;
  s.claims = claims;
  s.pot = pot;
  s.lap = { leader: 0, queue: [1, 2, 3], high, by, paid };
  return s;
}
const ACES = ['Ah', 'Ad', '2c', '7d', '9s'];
const TRIPS = ['Ah', 'Ad', 'As', '7d', '9s'];
const COLD = ['2h', '5d', '8c', 'Jd', 'Ks'];
const tally = (times, f) => { const n = {}; for (let i = 0; i < times; i++) { const k = f(); n[k] = (n[k] ?? 0) + 1; } return n; };

test('bots: bluffers raise more than steady hands, strong claims more than weak, and every raise is legal', () => {
  const raises = (bot, hand) => {
    const rng = makeRng(77);
    const s = botSpot(bot, { hand });
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const move = decide(publicView(s), 1, hand, rng);
      if (move.raise) {
        assert.ok(move.raise >= 1 && move.raise <= 25);
        n += 1;
      }
    }
    return n;
  };
  assert.ok(raises('Brannock', ACES) > raises('Old Wick', ACES) * 1.3, 'Brannock pushes harder');
  assert.ok(raises(HOUSE_NAME, TRIPS) > raises(HOUSE_NAME, ACES), 'a stronger claim raises more');
  assert.ok(raises('Brannock', COLD) > raises('Old Wick', COLD) * 3, 'and bluffers raise on nothing');
});

test('bots: strong claims match, nothing folds, and a seat with no claim never pays to stay', () => {
  const rng = makeRng(5);
  const raised = [{ seat: 0, claim: [1, 3, 0], status: 'standing' }];
  const strong = botSpot('Old Wick', { hand: TRIPS, claims: raised, high: 12, by: 0, paid: { 0: 12 } });
  const moves = Array.from({ length: 300 }, () => decide(publicView(strong), 1, TRIPS, rng));
  assert.ok(moves.every((m) => m.action === 'claim' && (m.match || m.raise)), 'three aces never run from 12, and claim before they call');

  const weak = botSpot('Old Wick', { hand: COLD, claims: [{ seat: 0, claim: [7, 14, 0], status: 'proven' }], high: 25, by: 0, paid: { 0: 25 } });
  const result = tally(300, () => { const m = decide(publicView(weak), 1, COLD, rng); return m.match ? 'match' : m.action; });
  assert.equal(result.match, undefined, 'it has nothing, and it pays nothing');
  assert.ok((result.fold ?? 0) > 200, `folds: ${JSON.stringify(result)}`);

  const noCard = botSpot('Old Wick', { hand: COLD, claims: raised, high: 12, by: 0, paid: { 0: 12 }, chips: 3 });
  assert.deepEqual(decide(publicView(noCard), 1, COLD, rng), { action: 'fold' }, 'it can’t cover the raise or the stake');
});

test('bots: a raised claim is called more than the same claim unraised, and calling a raise costs only the stake', () => {
  // A pair of 9s from a clean record. Belief is about .28, so Old Wick's doubt of .36 calls either way: use Tally's .30 and a spot just over it.
  const claim = { seat: 0, claim: [1, 13, 0], status: 'standing' };
  const hand = ['2h', '5d', '8c', 'Jd', '3s'];
  const callRate = (spot) => {
    const rng = makeRng(11);
    return tally(600, () => decide(publicView(spot), 1, hand, rng).action).call ?? 0;
  };
  const brannock = (over) => botSpot('Brannock', { hand, claims: [claim], ...over });
  const plain = callRate(brannock({}));
  const raised = callRate(brannock({ high: 20, by: 0, paid: { 0: 20 } }));
  assert.ok(raised > plain, `raised ${raised}, plain ${plain}`);

  const rng = makeRng(2);
  const spot = botSpot(HOUSE_NAME, { hand, claims: [{ ...claim, claim: [1, 2, 0] }], high: 20, by: 0, paid: { 0: 20 } });
  for (let i = 0; i < 300; i++) {
    const move = decide(publicView(spot), 1, ['2h', '2d', '8c', 'Jd', '3s'], rng);
    if (move.action === 'call') assert.ok(move.fold || move.match || move.raise, JSON.stringify(move));
  }
});

test('bots after the lap: top claims stay, third place goes, second place weighs the pot, and no claim folds', () => {
  const rng = makeRng(9);
  const stayOrGo = (move) => (move.action === 'call' ? (move.match ? 'match' : 'fold') : move.action); // whether or not it calls too
  const spot = (bot, claims, { high = 10, pot = 40 } = {}) => {
    const s = botSpot(bot, { hand: COLD, claims, high, by: 3, paid: { 3: high }, pot });
    s.phase = 'answer';
    s.lap.queue = [1];
    return () => stayOrGo(decide(publicView(s), 1, COLD, rng));
  };
  const me = (claim) => ({ seat: 1, claim, status: 'standing' });
  const rival = (claim, status = 'standing') => ({ seat: 3, claim, status });
  const top = spot('Old Wick', [rival([1, 3, 0]), me([1, 14, 0])]);
  assert.deepEqual(tally(100, top), { match: 100 }, 'top claim stays');
  const second = spot('Old Wick', [rival([1, 14, 0]), me([1, 3, 0])]);
  assert.deepEqual(tally(100, second), { match: 100 }, 'a third of a big pot is worth 10');
  const priced = spot('Old Wick', [rival([1, 14, 0]), me([1, 3, 0])], { high: 25, pot: 30 });
  assert.deepEqual(tally(100, priced), { fold: 100 }, 'a third of a small pot is not worth 25');
  const third = spot('Old Wick', [rival([1, 14, 0]), { seat: 2, claim: [1, 9, 0], status: 'standing' }, me([1, 3, 0])]);
  assert.ok((tally(400, third).fold ?? 0) > 380, 'third place has no share to protect');
  assert.deepEqual(tally(100, spot('Brannock', [rival([1, 14, 0])])), { fold: 100 }, 'no claim never pays');

  const broke = botSpot('Brannock', { hand: COLD, claims: [me([1, 14, 0])], high: 10, by: 3, paid: { 3: 10 }, chips: 9 });
  broke.phase = 'answer';
  broke.lap.queue = [1];
  assert.equal(stayOrGo(decide(publicView(broke), 1, COLD, rng)), 'fold', 'and it can’t pay what it hasn’t got');
});

test('bots: tables finish, and no bot ever makes an illegal move, over 300 tables with real raises', () => {
  let answered = 0;
  let withdrawn = 0;
  let raised = 0;
  for (let g = 1; g <= 300; g++) {
    const context = { now: 1000, rng: makeRng(g) };
    const s = createTable({ lobbyMs: 0 });
    join(s, 'Ann', context);
    for (let round = 0; round < 8 && s.phase !== 'over'; round++) {
      for (let i = 0; i < 400 && !['settled', 'over'].includes(s.phase); i++) {
        runBots(s, context);
        if (['settled', 'over'].includes(s.phase)) break;
        if (legalActions(s, 0).length) act(s, 0, randomLegal(s, 0, context.rng), context);
      }
      assert.ok(['settled', 'over'].includes(s.phase), `table ${g} stuck in ${s.phase}`);
      assert.ok(!s.log.some((l) => l.botError), `table ${g}: ${s.log.find((l) => l.botError)?.text}`);
      if (s.log.some((l) => l.text.startsWith('The raise stands') && l.round === s.round)) answered += 1;
      if (s.log.some((l) => / raises to /.test(l.text) && l.round === s.round)) raised += 1;
      withdrawn += s.claims.filter((x) => x.status === 'withdrawn').length;
      assert.equal(s.lap, null);
      if (s.phase === 'settled') startRound(s, context);
    }
  }
  assert.ok(raised > 300, `${raised} rounds with a lap raise`);
  assert.ok(answered > 100, `${answered} rounds with a match-or-fold turn`);
  assert.ok(withdrawn > 10, `${withdrawn} claims withdrawn`);
});

// ---------- what's public, and tables saved under the old rules ----------

test('lap raise: never in the public view: a hand, or whether a claim is true', () => {
  const s = toAnswers();
  const text = JSON.stringify(publicView(s));
  for (const card of s.hands.flat()) assert.ok(!text.includes(`"${card}"`), card);
  assert.ok(!/bluff/i.test(text));
  assert.equal('lastCall' in publicView(s), false);
  assert.equal('facing' in publicView(s), false, 'what a seat owes goes only to that seat');
});

test('a saved table: in the old last round it answers the raise under the new rules; with no raise it settles; a lap gains its fields', () => {
  const saved = (high, paid, queue) => {
    const s = raiseLap();
    s.claims = [{ seat: 0, claim: [1, 9, 0], status: 'standing' }, { seat: 2, claim: [3, 12, 0], status: 'standing' }];
    s.phase = 'lastcall';
    s.lap = null;
    s.lastCall = { queue, high, paid };
    return s;
  };
  const raised = saved(10, { 2: 10 }, [3, 0, 1]);
  assert.equal(upgradeState(raised, c), true);
  assert.equal(raised.phase, 'answer');
  assert.equal('lastCall' in raised, false);
  assert.deepEqual(publicView(raised).lapRaise, { high: 10, by: 2, paid: { 2: 10 }, waiting: [3, 0, 1], stopper: null });
  act(raised, 3, { action: 'match' }, c);
  act(raised, 0, { action: 'match' }, c);
  act(raised, 1, { action: 'fold' }, c);
  assert.equal(raised.phase, 'settled');

  const free = saved(0, {}, [2, 3, 0, 1]);
  assert.equal(upgradeState(free, c), true);
  assert.equal(free.phase, 'settled');
  assert.equal(free.lastResult.kind, 'settled');

  const between = raiseLap();
  between.lastCall = null;
  delete between.lap.high;
  assert.equal(upgradeState(between, c), true);
  assert.deepEqual(raiseOf(between), { high: 0, by: null, paid: {} });
  assert.equal(upgradeState(between, c), false, 'once is enough');
});

// ---------- roundCap, for the cage ----------

test('roundCap: at the default stakes the pot limit bounds it: 510 at 4 to 6 seats, under the cage limit of 1000', () => {
  assert.equal(roundCap(DEFAULTS, 6), 510);
  assert.equal(roundCap(DEFAULTS, 4), 510);
  assert.equal(roundCap(DEFAULTS, 3), 415);
  assert.equal(roundCap(DEFAULTS, 2), 285);
  assert.ok(roundCap(DEFAULTS, 6) <= 1000);
  assert.equal(roundCap(UNCAPPED, 6), 790, 'without the pot limit');
  assert.deepEqual([DEFAULTS.ante, DEFAULTS.maxPasses, DEFAULTS.raiseLimit, DEFAULTS.callStake, DEFAULTS.potLimit], [5, 5, 25, 5, 500], 'the cage relies on these: change one and tell it');
});

test('roundCap: with no pot limit it is reachable: the worst round, played through the engine, loses exactly that', () => {
  assert.equal(worstRound(2).lost, roundCap(UNCAPPED, 2), 'two seats: one sting');
  for (let seats = 3; seats <= 6; seats++) {
    assert.equal(twoCalls(seats).lost, roundCap(UNCAPPED, seats), `${seats} seats, calling twice`);
    assert.equal(calledThenCaught(seats).lost, roundCap(UNCAPPED, seats), `${seats} seats, calling and being caught`);
  }
});

test('roundCap: one sting less without an after-lap call; a stop gives up a window, since nobody can stop with a raise out', () => {
  for (let seats = 3; seats <= 6; seats++) {
    const oneSting = roundCap(UNCAPPED, seats) - UNCAPPED.callStake;
    assert.equal(worstRound(seats).lost, oneSting, `${seats} seats, worstRound`);
    const noRaiseThatWindow = oneSting - UNCAPPED.raiseLimit * seats;
    for (const play of [worstStop, caughtStopper]) assert.equal(play(seats).lost, noRaiseThatWindow, `${seats} seats, ${play.name}`);
  }
});

test('roundCap: more lap raises do not cost more: the climbing raises come to the same loss, because a seat pays only the difference', () => {
  for (let seats = 3; seats <= 6; seats++) assert.equal(raiseLadder(seats).lost, roundCap(UNCAPPED, seats) - UNCAPPED.callStake, `${seats} seats`);
});

test('roundCap: it holds: no seat ever loses more in a round, over wild play with deep stacks', () => {
  let biggest = 0;
  for (let g = 1; g <= 400; g++) {
    const rng = makeRng(g);
    const context = { now: 1000, rng, auto: true };
    const seats = 2 + (g % 5);
    const s = createTable({ seats, lobbyMs: 60_000 });
    for (let i = 0; i < seats; i++) join(s, `P${i}`, context, { chips: 100_000 });
    for (let round = 0; round < 3 && s.phase !== 'over'; round++) {
      const before = s.seats.map((x) => x.chips);
      for (let i = 0; i < 5000 && !['settled', 'over'].includes(s.phase); i++) {
        const moves = seatIds2(s).flatMap((seat) => legalActions(s, seat).map((m) => [seat, m]));
        if (moves.length === 0) break;
        const raises = moves.filter(([, m]) => m.raise);
        const [seat, m] = raises.length && rng() < 0.7 ? raises[Math.floor(rng() * raises.length)] : moves[Math.floor(rng() * moves.length)];
        if (m.action === 'fold' && rng() < 0.9) continue; // keep them in, for the biggest rounds
        // In the lap, raise as high as the move allows, or at least stay in, so a seat pays as much as it can.
        const stake = m.raise && rng() < 0.6 ? { raise: m.raise.min + Math.floor(rng() * (m.raise.max - m.raise.min + 1)) } : m.match ? { match: true } : m.fold ? { fold: true } : {};
        const body = m.action === 'pass' ? { action: 'pass', card: m.cards[0], ...(m.raise && rng() < 0.7 ? { raise: m.raise.max } : m.match ? { match: true } : {}) } : m.action === 'claim' ? { action: 'claim', claim: m.options[0].claim, ...stake } : m.action === 'stop' ? { action: 'stop', claim: m.options[0].claim, ...stake } : m.action === 'call' ? { action: 'call', seat: m.seats[0], ...stake } : m.action === 'check' ? { action: 'check', ...stake } : { action: m.action };
        act(s, seat, body, context);
      }
      if (s.phase !== 'settled') break;
      s.seats.forEach((x, i) => {
        const lost = before[i] - x.chips;
        biggest = Math.max(biggest, lost);
        assert.ok(lost <= roundCap(s.cfg, seats), `table ${g} seat ${i}: lost ${lost} of ${roundCap(s.cfg, seats)}`);
      });
      startRound(s, context);
    }
  }
  assert.ok(biggest > 200, `the play reached a loss of ${biggest}`);
});

const seatIds2 = (s) => s.seats.map((_, i) => i);

// ---------- stakes and the pot limit ----------

/** Four seats at real stakes, or any others. */
function stakes(cfg = {}) {
  const s = createTableAtDefaults({ lobbyMs: 60_000, ...cfg });
  for (const name of ['Ann', 'Bo', 'Cy', 'Di']) join(s, name, c);
  return s;
}

test('stakes: 5, 25 and 500 by default, and a table can set its own', () => {
  const s = stakes();
  assert.equal(s.pot, 20, 'four antes of 5');
  assert.deepEqual(s.seats.map((x) => x.chips), [95, 95, 95, 95]);
  const { ante, raiseLimit, potLimit } = s.cfg;
  assert.deepEqual([ante, raiseLimit, potLimit], [5, 25, 500]);
  assert.equal(publicView(s).limits.potLimit, 500);
  const tier = stakes({ ante: 2, raiseLimit: 7, potLimit: 60 });
  assert.equal(tier.pot, 8);
  assert.deepEqual(legalActions(tier, 0)[0].raise, { min: 1, max: 7 });
  assert.equal(publicView(tier).limits.potLimit, 60);
});

test('pot limit: a raise only goes up to what fits, the next match pays only what fits, then no more raises', () => {
  const s = stakes({ potLimit: 40 });
  assert.equal(s.pot, 20);
  assert.deepEqual(legalActions(s, 0)[0].raise, { min: 1, max: 20 });
  assert.equal(code(() => act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 21 }, c)), 'bad_raise');
  assert.equal(publicView(s).potLimitReached, false);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 15 }, c);
  assert.equal(s.pot, 35);
  const facing = legalActions(s, 1)[0];
  assert.deepEqual(facing.match, { cost: 5, level: 15 }, 'the raise is 15, but only 5 fits');
  assert.equal(facing.raise, undefined, 'nothing left to raise with');
  act(s, 1, { action: 'pass', card: firstCard(s, 1), match: true }, c);
  assert.equal(s.seats[1].chips, 90);
  assert.equal(s.pot, 40);
  assert.equal(publicView(s).potLimitReached, true);
  const free = legalActions(s, 2)[0];
  assert.deepEqual(free.match, { cost: 0, level: 15 }, 'still has to stay in, for nothing');
  assert.equal(code(() => act(s, 2, { action: 'pass', card: firstCard(s, 2), raise: 1 }, c)), 'pot_limit');
  act(s, 2, { action: 'pass', card: firstCard(s, 2), match: true }, c);
  act(s, 3, { action: 'pass', card: firstCard(s, 3), match: true }, c);
  assert.equal(s.pot, 40);
  assert.equal(s.seats.reduce((sum, x) => sum + x.chips, s.pot), 400, 'no chip made or lost');
  assert.equal(s.passNo, 2);
  assert.equal(legalActions(s, 0)[0].raise, undefined, 'the next window has none either');
  assert.equal(publicView(s).potLimitReached, true);
});

test('pot limit: the stop and the claim lap obey it too, and a lap match pays only what fits', () => {
  const s = stakes({ potLimit: 30, seats: 4 });
  passAll(s); passAll(s);
  const stop = legalActions(s, 0).find((a) => a.action === 'stop');
  assert.deepEqual(stop.raise, { min: 1, max: 10 });
  assert.equal(code(() => act(s, 0, { action: 'stop', claim: [1, 9], raise: 11 }, c)), 'bad_raise');
  act(s, 0, { action: 'stop', claim: [1, 9], raise: 8 }, c);
  assert.equal(s.pot, 28);
  const moves = legalActions(s, 1);
  const check = moves.find((a) => a.action === 'check');
  assert.deepEqual(check.match, { cost: 2, level: 8 });
  assert.equal(check.raise, undefined, 'room for the match only: it is a raise to a level, and 2 more reaches 8');
  act(s, 1, { action: 'check', match: true }, c);
  assert.equal(s.pot, 30);
  assert.equal(publicView(s).potLimitReached, true);
  assert.equal(code(() => act(s, 2, { action: 'check', raise: 9 }, c)), 'pot_limit');
  assert.deepEqual(legalActions(s, 2).find((a) => a.action === 'check').match, { cost: 0, level: 8 });
});

test('pot limit: carried chips count, and an ante pays only what fits', () => {
  const s = stakes({ potLimit: 32 });
  while (s.phase === 'pass') passAll(s);
  while (s.phase === 'claim') act(s, s.lap.queue[0], { action: 'check' }, c);
  assert.equal(s.lastResult.kind, 'carried');
  assert.equal(s.pot, 20);
  startRound(s, c);
  assert.equal(s.pot, 32, 'the first seats pay their antes, and the rest fit what is left');
  assert.deepEqual(s.seats.map((x) => x.chips), [90, 90, 93, 95]);
  assert.equal(publicView(s).potLimitReached, true);
});

test('fuzz at the real stakes: chips conserved, the pot never over its limit, no bot errors, nobody over the bound', () => {
  for (let game = 0; game < 120; game++) {
    const rng = makeRng(game + 900);
    const context = { now: 1000, rng };
    const s = createTableAtDefaults({ lobbyMs: 0 });
    join(s, 'Probe', context, { chips: 2000 });
    for (const x of s.seats) x.chips = 2000;
    runBots(s, context);
    const start = s.seats.reduce((sum, x) => sum + x.chips, s.pot);
    for (let step = 0; step < 1500 && s.phase !== 'over' && s.round <= 12; step++) {
      context.now += 1;
      if (s.phase === 'settled') startRound(s, context);
      else {
        const legal = legalActions(s, 0);
        if (legal.length === 0) { context.now = s.deadline ?? context.now; tick(s, context); } else act(s, 0, randomLegal(s, 0, rng), context);
      }
      runBots(s, context);
      assert.ok(s.pot <= 500, `pot ${s.pot} over the limit`);
      assert.equal(s.seats.reduce((sum, x) => sum + x.chips, s.pot), start, 'conserved');
    }
    assert.ok(!s.log.some((l) => l.botError), JSON.stringify(s.log.filter((l) => l.botError)));
  }
});

test('roundCap at the limit: played hard with deep stacks, nobody loses more than the bound in a round', () => {
  let biggest = 0;
  for (let g = 1; g <= 300; g++) {
    const rng = makeRng(g + 5000);
    const context = { now: 1000, rng, auto: true };
    const seats = 2 + (g % 5);
    const s = createTableAtDefaults({ seats, lobbyMs: 60_000 });
    for (let i = 0; i < seats; i++) join(s, `P${i}`, context, { chips: 100_000 });
    const before = s.seats.map((x) => x.chips + (s.potIn?.[s.seats.indexOf(x)] ?? 0));
    for (let i = 0; i < 4000 && !['settled', 'over'].includes(s.phase); i++) {
      const moves = s.seats.flatMap((_, seat) => legalActions(s, seat).map((m) => [seat, m]));
      if (moves.length === 0) break;
      const raises = moves.filter(([, m]) => m.raise);
      const [seat, m] = raises.length && rng() < 0.8 ? raises[Math.floor(rng() * raises.length)] : moves[Math.floor(rng() * moves.length)];
      if (m.action === 'fold' && !m.match && moves.length > 1 && rng() < 0.9) continue;
      const stake = m.raise && rng() < 0.8 ? { raise: m.raise.max } : m.match ? { match: true } : m.fold ? { fold: true } : {};
      const card = s.hands[seat][0];
      const body = m.action === 'pass' ? { action: 'pass', card, ...stake } : m.action === 'stop' ? { action: 'stop', claim: m.options[0].claim, ...(stake.raise ? { raise: stake.raise } : {}) } : m.action === 'claim' ? { action: 'claim', claim: m.options[0].claim, ...stake } : m.action === 'call' ? { action: 'call', seat: m.seats[0], ...stake } : m.action === 'check' ? { action: 'check', ...stake } : { action: m.action };
      try { act(s, seat, body, context); } catch { /* an illegal mix of options: pick again */ }
    }
    if (s.phase !== 'settled') continue;
    const worst = Math.max(...s.seats.map((x, i) => before[i] - x.chips));
    biggest = Math.max(biggest, worst);
    assert.ok(worst <= roundCap(DEFAULTS, seats), `${seats} seats lost ${worst}`);
    assert.ok(worst <= 510);
  }
  assert.ok(biggest > 100, `the play should have got somewhere: ${biggest}`);
});

// ---------- the round's result, for the panel ----------

test('round result: who put in what and got what back adds up, with stings, and folded seats are listed', () => {
  const s = table({ cfg: { ante: 5 } });
  s.hands = HANDS.map((h) => h.split(' '));
  const start = s.seats.map((x) => x.chips + 5);
  act(s, 0, { action: 'pass', card: firstCard(s, 0), raise: 4 }, c);
  act(s, 1, { action: 'fold' }, c);
  for (const seat of [2, 3]) act(s, seat, { action: 'pass', card: firstCard(s, seat), match: true }, c);
  passAll(s);
  s.hands[3] = ['Ac', 'Ad', '2c', '2d', '6c'];
  act(s, 3, { action: 'stop', claim: [2, 14, 2] }, c);
  while (s.phase === 'claim') {
    const turn = s.lap.queue[0];
    if (turn === 0) act(s, 0, { action: 'call', seat: 3 }, c); // true: seat 0 pays the sting
    else act(s, turn, { action: 'check' }, c);
  }
  const r = s.lastResult;
  assert.equal(s.phase, 'settled');
  assert.deepEqual(r.folded, [1]);
  assert.deepEqual(r.claims.map((x) => [x.seat, x.status]), [[3, 'proven']]);
  for (const seat of [0, 1, 2, 3]) assert.equal(start[seat] - r.money[seat].in + r.money[seat].out, s.seats[seat].chips, `seat ${seat}`);
  assert.equal(r.money[0].in, 5 + 4 + 5, 'ante, raise, sting');
  assert.equal(r.money[3].out, r.pot + 5, 'the pot and the sting');
  assert.equal(JSON.stringify(publicView(s).lastResult), JSON.stringify(r));
});

test('round result: an uncalled claim says "standing" whether it was true or false, and nothing else tells them apart', () => {
  const play = (hand) => {
    const s = table({ cfg: { ante: 5 } });
    passAll(s); passAll(s);
    s.hands[0] = hand.split(' ');
    act(s, 0, { action: 'stop', claim: [1, 14] }, c);
    while (s.phase === 'claim') act(s, s.lap.queue[0], { action: 'check' }, c);
    return publicView(s).lastResult;
  };
  const honest = play('Ah Ad 2c 3c 4c');
  const bluff = play('2h 3d 7c 9s Jd');
  assert.equal(honest.claims[0].status, 'standing');
  assert.equal(bluff.claims[0].status, 'standing');
  assert.deepEqual(honest, bluff, 'the whole result is identical');
  assert.ok(!/[2-9TJQKA][cdhs]"/.test(JSON.stringify(bluff)), 'no card');
});

test('round result: a carried pot and a returned pot tell their story too', () => {
  const s = table({ cfg: { ante: 5 } });
  while (s.phase === 'pass') passAll(s);
  while (s.phase === 'claim') act(s, s.lap.queue[0], { action: 'check' }, c);
  assert.equal(s.lastResult.kind, 'carried');
  assert.deepEqual(s.lastResult.money[0], { in: 5, out: 0 });
  for (const seat of [0, 1, 2, 3]) leave(s, seat, c);
  assert.equal(s.lastResult.kind, 'returned');
  assert.equal(s.lastResult.awards[0].seat, 3, 'the last one out gets it back');
  assert.equal(s.lastResult.money[3].out, 20);
});


// ---------- house rebuy ----------

/** Ann and three bots at the real ante of 5: the file plays at 1, and a rebuy turns on what a seat can't cover. */
function soloAt5() {
  const s = createTable({ lobbyMs: 0, ante: 5 });
  join(s, 'Ann', c);
  return s;
}

test('house rebuy: between rounds a bot that can’t ante is bought back in to its starting stack, with a line of its own', () => {
  const s = soloAt5();
  s.phase = 'settled';
  s.seats[1].chips = 0;
  s.seats[2].chips = 3;
  const ann = s.seats[0].chips;
  const before = s.log.length;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.round, 2);
  assert.equal(s.seats[1].chips, 100 - 5, 'Tally is back to 100, then antes');
  assert.equal(s.seats[2].chips, 100 - 5, 'Brannock was under the ante: back to 100 too');
  assert.equal(s.seats[3].chips, 95 - 5, 'Old Wick could ante and is left alone');
  assert.equal(s.seats[0].chips, ann - 5, 'the player paid the ante and nothing else');
  assert.deepEqual(s.status, ['in', 'in', 'in', 'in']);
  assert.equal(s.houseStaked, 100 + 97);
  assert.equal(publicView(s).houseStaked, 197);
  assert.deepEqual(s.seats.map((x) => x.rebuys ?? 0), [0, 1, 1, 0]);
  const lines = s.log.slice(before);
  const rebuys = lines.filter((l) => l.rebuy);
  assert.deepEqual(rebuys.map((l) => [l.seat, l.amount]), [[1, 100], [2, 97]]);
  assert.equal(rebuys[0].text, `${HOUSE_NAME} is down to 0 chips. The house buys ${HOUSE_NAME} back in with 100.`);
  const said = lines.filter((l) => l.say);
  assert.deepEqual(said.map((l) => [l.seat, l.name, l.text]), [[1, HOUSE_NAME, 'House buys me back in.'], [2, 'Brannock', 'Ha! The house stakes me again. Pour another!']]);
  assert.ok(lines.findIndex((l) => l.rebuy) < lines.findIndex((l) => /^Round 2\./.test(l.text)), 'on the record before the deal');
  assert.equal(s.talkQueue.length, 0, 'the line is scripted: not offered to the model');
});

test('house rebuy: never mid-hand, and never for a player: at a tNIGHT table a broke player still closes it, bots as they were', () => {
  const s = soloAt5();
  s.cage = { status: 'open' };
  s.seats[0].chips = 0;
  s.seats[1].chips = 0;
  act(s, 0, { action: 'pass', card: firstCard(s, 0) }, c);
  assert.equal(s.seats[1].chips, 0, 'nothing moves mid-hand');
  assert.equal(s.houseStaked, 0);
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  startRound(s, c);
  assert.equal(s.phase, 'over');
  assert.deepEqual([s.overCode, s.overReason], ['cannot_ante', 'Not enough players to ante.']);
  assert.equal(s.seats[0].chips, 0, 'the player’s chips are never touched');
  assert.equal(s.seats[1].chips, 0, 'no rebuy at a table that is closing');
  assert.ok(!s.log.some((l) => l.rebuy));
});

test('tNIGHT table: a bot that can’t ante stands up between rounds and the seat stays empty; nothing restakes it', () => {
  const s = soloAt5();
  s.cage = { status: 'open' };
  s.phase = 'settled';
  s.seats[1].chips = 0;
  const before = s.log.length;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.round, 2);
  assert.equal(s.seats[1].left, true);
  assert.equal(s.seats[1].chips, 0);
  assert.equal(s.seats[1].leftWith, 0);
  assert.equal(s.status[1], 'out');
  assert.deepEqual(s.departures, [{ seat: 1, amount: 0 }]);
  assert.equal(s.houseStaked, 0);
  assert.deepEqual(s.hands.map((h) => h.length), [5, 0, 5, 5]);
  assert.equal(publicView(s).seats[1].left, true);
  const lines = s.log.slice(before);
  assert.ok(!lines.some((l) => l.rebuy || l.say), 'no rebuy, no line');
  assert.equal(lines.find((l) => l.broke)?.text, `${HOUSE_NAME} is down to 0 chips and stands up: the house doesn't restake a tNIGHT seat.`);
  assert.equal(lines.find((l) => l.broke).seat, 1);
  // When the last bot goes, the table closes as it always did.
  s.phase = 'settled';
  s.seats[2].chips = 4;
  s.seats[3].chips = 0;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.phase, 'over');
  assert.deepEqual([s.overCode, s.overReason], ['others_out_of_chips', 'The other players ran out of chips.']);
  assert.ok(s.seats.slice(1).every((x) => x.left));
  assert.deepEqual(s.departures.map((d) => [d.seat, d.amount]), [[1, 0], [2, 4], [3, 0]]);
});

test('play chips: a player who is out of chips keeps the table and the last result; Fill up (adding chips) and Next deal them back in', () => {
  const s = soloAt5();
  s.seats[0].chips = 0;
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  s.lastResult = { round: s.round, kind: 'settled', pot: 20, awards: [], money: [] };
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
  assert.notEqual(s.phase, 'settled');
});

test('tNIGHT table: canFillUp is false (the cage owns the chips)', () => {
  const s = soloAt5();
  s.cage = { status: 'open' };
  s.phase = 'settled';
  assert.equal(privateView(s, 0).canFillUp, false);
});

test('play chips: a house bot is topped up whenever it is below the mark (botLow), the house stake is always counted, only a top-up of botLogMin or more gets a line', () => {
  const s = createTable({ lobbyMs: 0, ante: 5, startChips: 1000, botLow: 1000, botLogMin: 100, potLimit: 4000, raiseLimit: 1000 });
  join(s, 'Ann', c);
  assert.equal(s.seats[1].chips, 1000 - 5, 'house bots sit down with a full stack (less the ante)');
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  s.deadline = null;
  s.seats[1].chips = 990;
  s.seats[2].chips = 400;
  s.seats[3].chips = 1000;
  const before = s.log.length;
  act(s, 0, { action: 'next' }, c);
  assert.equal(s.houseStaked, 610);
  assert.equal(s.log.slice(before).filter((l) => l.rebuy).length, 1, 'one line, for the 600');
  assert.ok(s.seats.every((x) => !x.left));
});

test('every way a Sealed Hand table closes has a code and a plain sentence in the view', () => {
  const s = soloAt5();
  s.phase = 'settled';
  s.pot = 0;
  s.potIn = [];
  leave(s, 0, c);
  assert.deepEqual([publicView(s).overCode, publicView(s).overReason, publicView(s).overRound], ['everyone_left', 'Everyone else left.', s.round]);
  const idle = soloAt5();
  idle.cfg.idleMs = 20 * 60_000;
  idle.phase = 'settled';
  idle.pot = 0;
  idle.potIn = [];
  startRound(idle, ctx(1000 + 21 * 60_000));
  assert.deepEqual([idle.overCode, idle.overReason], ['no_human_action', 'No moves for 20 minutes.']);
});

test('a seat that left is public as "left" with what it took home, not as 0 chips out (11-10): shown through that round, gone after it', () => {
  const s = soloTable();
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
  s.round = round + 1; // the next round is dealt
  const later = publicView(s).seats[0];
  assert.equal(later.gone, true, 'a round later the seat list drops it');
  assert.equal(later.leftWith, 1011);
  assert.equal(later.status, 'left');
});
