import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createTable as createTableAtDefaults, currentTurn, join, legalActions, publicView, tick } from '../src/games/sealed-hand/engine.js';

// These tests do their sums at an ante of 1 with no pot limit: stakes are a table setting now, and the defaults have their own tests.
const createTable = (cfg = {}) => createTableAtDefaults({ ante: 1, potLimit: Infinity, ...cfg });
import { PERSONAS, VOICES, belief, bluffRateOf, decide, isImpossible, paceBots, priorOf, runBots } from '../src/games/sealed-hand/bots.js';
import { CAT, contains, handCategory, newDeck, normalizeClaim, rankOf, shuffle, suitOf } from '../src/games/sealed-hand/cards.js';
import { isProfane } from '../src/platform/filter.js';
import { makeRng } from './helpers.js';

const hand = (text) => text.split(' ');
const always = (x) => () => x;
const seq = (values) => { let i = 0; return () => values[i++ % values.length]; };
const HOUSE = 'Tally · house';

const view = (over = {}) => ({
  phase: 'claim', passNo: 2, top: null, claims: [], raise: null, lapRaise: { high: 0, by: null, paid: {}, waiting: [1] }, pot: 12,
  limits: { minPasses: 2, raiseLimit: 25, callStake: 5 },
  seats: [
    { seat: 0, name: 'Ann', bot: false, chips: 100, rep: { called: 0, proven: 0, caught: 0 } },
    { seat: 1, name: HOUSE, bot: true, chips: 100, rep: { called: 0, proven: 0, caught: 0 } },
    { seat: 2, name: 'Brannock', bot: true, chips: 100, rep: { called: 0, proven: 0, caught: 0 } },
    { seat: 3, name: 'Old Wick', bot: true, chips: 100, rep: { called: 0, proven: 0, caught: 0 } },
  ],
  ...over,
});

test('personas: the design numbers', () => {
  assert.deepEqual(Object.keys(PERSONAS), [HOUSE, 'Brannock', 'Old Wick']);
  assert.deepEqual(PERSONAS[HOUSE], { bluff: 0.18, doubt: 0.30, pass: { builder: 0.22, mid: 0.11, good: 0.04 } });
  assert.deepEqual(PERSONAS.Brannock, { bluff: 0.38, doubt: 0.22, pass: { builder: 0.17, mid: 0.18, good: 0.09 } });
  assert.deepEqual(PERSONAS['Old Wick'], { bluff: 0.07, doubt: 0.36, pass: { builder: 0.28, mid: 0.05, good: 0.01 } });
});

test('priors: recounted exactly over all 2,598,960 five-card hands', () => {
  const deck = newDeck();
  const ranks = deck.map(rankOf);
  const suits = deck.map(suitOf);
  const tally = { pair9: 0, twoPairKHigh: 0, three9: 0, straight9: 0, flush: 0, full9: 0, four9: 0, sf: 0 };
  const n = new Int8Array(15);
  let total = 0;
  for (let a = 0; a < 48; a++)
    for (let b = a + 1; b < 49; b++)
      for (let c = b + 1; c < 50; c++)
        for (let d = c + 1; d < 51; d++)
          for (let e = d + 1; e < 52; e++) {
            total += 1;
            const h = [a, b, c, d, e];
            n.fill(0);
            for (const i of h) n[ranks[i]] += 1;
            if (n[9] >= 2) tally.pair9 += 1;
            if (n[9] >= 3) tally.three9 += 1;
            if (n[9] === 4) tally.four9 += 1;
            if (n[13] >= 2) for (let r = 2; r < 13; r++) if (n[r] >= 2) { tally.twoPairKHigh += 1; break; }
            if (n[9] === 3) for (let r = 2; r < 15; r++) if (r !== 9 && n[r] >= 2) { tally.full9 += 1; break; }
            const straight9 = n[5] && n[6] && n[7] && n[8] && n[9];
            if (straight9) tally.straight9 += 1;
            const flush = suits[a] === suits[b] && suits[a] === suits[c] && suits[a] === suits[d] && suits[a] === suits[e];
            if (flush) {
              tally.flush += 1;
              const sorted = h.map((i) => ranks[i]).sort((x, y) => x - y);
              if (sorted[4] - sorted[0] === 4 || sorted.join() === '2,3,4,5,14') tally.sf += 1;
            }
            if (total % 20000 === 0) assert.equal(n[9] >= 2, contains(h.map((i) => deck[i]), [CAT.PAIR, 9, 0]), 'cross-check against contains()');
          }
  assert.equal(total, 2598960);
  const expected = (count) => Math.max(count / total, 0.002);
  assert.equal(priorOf([CAT.PAIR, 9, 0]), expected(tally.pair9));
  assert.equal(priorOf([CAT.TWO_PAIR, 13, 0]), expected(tally.twoPairKHigh));
  assert.equal(priorOf([CAT.THREE, 9, 0]), expected(tally.three9));
  assert.equal(priorOf([CAT.STRAIGHT, 9, 0]), expected(tally.straight9));
  assert.equal(priorOf([CAT.FLUSH, 0, 0]), expected(tally.flush));
  assert.equal(priorOf([CAT.FULL, 9, 0]), expected(tally.full9));
  assert.equal(priorOf([CAT.FOUR, 9, 0]), expected(tally.four9));
  assert.equal(priorOf([CAT.STRAIGHT_FLUSH, 0, 0]), expected(tally.sf));
});

test('priors: floored at .002, halved if a second rank is named', () => {
  assert.equal(priorOf([CAT.FOUR, 9, 0]), 0.002);
  assert.equal(priorOf([CAT.STRAIGHT_FLUSH, 0, 0]), 0.002);
  assert.equal(priorOf([CAT.TWO_PAIR, 13, 5]), priorOf([CAT.TWO_PAIR, 13, 0]) / 2);
  assert.equal(priorOf([CAT.FULL, 9, 5]), 0.001, 'the floor applies before the halving');
});

test('belief: prior^0.35 × (1.1 − bluff), × .55 per held card, × .6 if the claimer passed it to you, clamped', () => {
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} vs ${b}`);
  const base = priorOf([1, 9, 0]) ** 0.35;
  near(belief([1, 9, 0], 0.25, hand('2c 3d 7h 8s Jd')), base * 0.85, 'plain');
  near(belief([1, 9, 0], 0.25, hand('9c 3d 7h 8s Jd')), base * 0.85 * 0.55, 'one held');
  near(belief([1, 9, 0], 0.25, hand('9c 9d 7h 8s Jd')), base * 0.85 * 0.55 ** 2, 'two held');
  near(belief([1, 9, 0], 0.25, hand('2c 3d 7h 8s Jd'), ['9h']), base * 0.85 * 0.6, 'the claimer gave the bot a 9');
  near(belief([1, 9, 0], 0.25, hand('2c 3d 7h 8s Jd'), ['Th']), base * 0.85, 'another rank changes nothing');
  near(belief([4, 9, 0], 0.25, hand('9c 3d 7h 8s Jd')), priorOf([4, 9, 0]) ** 0.35 * 0.85, 'straights ignore held cards');
  near(belief([7, 9, 0], 1.05, hand('2c 3d 7h 8s Jd')), 0.02, 'clamped low');
  assert.ok(belief([1, 9, 0], -5, hand('2c 3d 7h 8s Jd')) === 0.98, 'clamped high');
  assert.equal(belief([1, 9, 0], 0.25, hand('9c 9d 9h 8s Jd')), 0, 'impossible stays 0, so it is always called');
});

test('impossible claims', () => {
  assert.ok(isImpossible([1, 9, 0], hand('9c 9d 9h 8s Jd')), 'only one 9 left');
  assert.ok(!isImpossible([1, 9, 0], hand('9c 9d 7h 8s Jd')));
  assert.ok(isImpossible([3, 9, 0], hand('9c 9d 7h 8s Jd')), 'only two 9s left');
  assert.ok(isImpossible([7, 9, 0], hand('9c 7d 7h 8s Jd')));
  assert.ok(isImpossible([6, 9, 7], hand('2c 7d 7h 7s 2d')), 'only one 7 left');
  assert.ok(isImpossible([4, 6, 0], hand('4c 4d 4h 4s Jd')), 'the 4s are all here');
  assert.ok(isImpossible([4, 5, 0], hand('Ac Ad Ah As Jd')), 'the wheel needs an Ace');
});

test('bluff rate comes from the public record: caught / called, or .25 with none', () => {
  assert.equal(bluffRateOf(view().seats[2]), 0.25);
  assert.equal(bluffRateOf({ rep: { called: 4, proven: 3, caught: 1 } }), 0.25);
  assert.equal(bluffRateOf({ rep: { called: 5, proven: 0, caught: 5 } }), 1);
});

test('claim turn: calls the least-believed claim when belief < doubt', () => {
  const v = view({ claims: [{ seat: 0, claim: [1, 9, 0], status: 'standing' }, { seat: 2, claim: [3, 12, 0], status: 'standing' }], top: [3, 12, 0] });
  assert.deepEqual(decide(v, 1, hand('2c 3d 7h 8s Jd'), always(0.99)), { action: 'call', seat: 2 });
});

test('claim turn: remembers what the claimer passed it', () => {
  const stand = { seat: 0, claim: [1, 9, 0], status: 'standing' };
  const cold = hand('2c 3d 7h 8s Jd');
  const v = view({ claims: [stand], top: [1, 9, 0] });
  // Belief is about .28, over Brannock's doubt of .22, so with a low roll Brannock bluffs instead of calling.
  // With the 9 Ann passed, belief is .17: under the doubt, so the call comes first.
  assert.equal(decide(v, 2, cold, always(0.01)).action, 'claim', 'no memory');
  assert.deepEqual(decide(v, 2, cold, always(0.5), { received: [{ from: 0, card: '9h' }] }), { action: 'call', seat: 0 }, 'Ann gave that 9 away');
  assert.equal(decide(v, 2, cold, always(0.01), { received: [{ from: 3, card: '9h' }] }).action, 'claim', 'a 9 from someone else proves nothing');
});

test('claim turn: with under 5 chips a bot never calls', () => {
  const v = view({ claims: [{ seat: 0, claim: [7, 14, 0], status: 'standing' }], top: [7, 14, 0] });
  v.seats[1].chips = 4;
  assert.notEqual(decide(v, 1, hand('2c 3d 7h 8s Jd'), always(0.99)).action, 'call');
  v.seats[1].chips = 5;
  assert.equal(decide(v, 1, hand('2c 3d 7h 8s Jd'), always(0.99)).action, 'call');
});

test('claim turn: lowest true step, exact best, bluff 1 to 3 steps, or check', () => {
  const h = hand('9c 9d 5h 5s Kd');
  // rng order: skip-bluff check, then exact check
  assert.deepEqual(decide(view(), 1, h, seq([0.99, 0.99])), { action: 'claim', claim: [1, 5, 0] }, 'lowest true');
  assert.deepEqual(decide(view(), 1, h, seq([0.99, 0.01])), { action: 'claim', claim: [2, 9, 5] }, 'exact best');
  // No true option and nothing on the table: a bot always opens with a low bluff.
  const cold = hand('2c 3d 7h 8s Jd');
  assert.deepEqual(decide(view(), 1, cold, seq([0.99, 0.01])), { action: 'claim', claim: [1, 2, 0] }, '1 step');
  assert.deepEqual(decide(view(), 1, cold, seq([0.99, 0.99])), { action: 'claim', claim: [1, 4, 0] }, '3 steps');
  // A proven claim on the table: bluffs only sometimes, otherwise checks.
  const top = [1, 14, 0];
  const v = view({ top, claims: [{ seat: 2, claim: top, status: 'proven' }] });
  assert.deepEqual(decide(v, 1, cold, always(0.99)), { action: 'check' });
  assert.deepEqual(decide(v, 1, cold, seq([0.01, 0.01])).action, 'claim');
  const ceiling = [8, 0, 0];
  assert.deepEqual(decide(view({ top: ceiling, claims: [{ seat: 2, claim: ceiling, status: 'proven' }] }), 1, h, always(0.5)), { action: 'check' }, 'ladder exhausted');
});

test('raising: 4 × category plus up to 4, with two pair or better, once it has seen a pass, and it goes with the pass; never more than it has', () => {
  const twoPair = hand('9c 9d 5h 5s Kd');
  const v = view({ phase: 'pass', passNo: 2 });
  const low = decide(v, 1, twoPair, seq([0, 0]));
  assert.deepEqual([low.action, low.raise], ['pass', 8]);
  assert.ok(twoPair.includes(low.card), 'with its card');
  assert.equal(decide(v, 1, twoPair, seq([0.99, 0])).raise, 12);
  assert.equal(decide(v, 1, hand('9c 9d 7h 8s Jd'), always(0)).raise, undefined, 'a pair never raises');
  assert.equal(decide(view({ phase: 'pass', passNo: 1 }), 1, twoPair, always(0)).raise, undefined, 'not on the deal, as in the prototype');
  assert.equal(decide(view({ phase: 'pass', passNo: 2, raisedThisPass: [1] }), 1, twoPair, always(0)).raise, undefined, 'once a window');
  const poor = view({ phase: 'pass', passNo: 2 });
  poor.seats[1].chips = 3;
  assert.equal(decide(poor, 1, hand('Ac Ad Ah As Jd'), always(0)).raise, undefined, 'no raise it can\'t afford');
  const capped = view({ phase: 'pass', passNo: 2, pot: 495 });
  capped.limits = { ...capped.limits, potLimit: 500 };
  assert.equal(decide(capped, 1, twoPair, always(0)).raise, undefined, 'none past the pot limit');
});

test('answering a raise: match by strength, and a short stack folds even with the goods', () => {
  const v = view({ phase: 'pass', passNo: 1, raise: { by: 0, amount: 12, waiting: [1] }, passRaise: { high: 12, by: 0, paid: { 0: 12 } } });
  assert.deepEqual(decide(v, 1, hand('2c 3d 7h 8s Jd'), always(0.99)), { action: 'fold' });
  assert.deepEqual(decide(v, 1, hand('9c 9d 5h 5s Kd'), always(0.99)), { action: 'match' });
  v.seats[1].chips = 11;
  assert.deepEqual(decide(v, 1, hand('Ac Ad Ah As Jd'), always(0.99)), { action: 'fold' });
});

test('facing a raise in the window: the bot answers as it passes, by the same reckoning, and never stops', () => {
  const v = view({ phase: 'pass', passNo: 3, passRaise: { high: 12, by: 0, paid: { 0: 12 } } });
  assert.deepEqual(decide(v, 1, hand('2c 3d 7h 8s Jd'), always(0.99)), { action: 'fold' });
  const twoPair = decide(v, 1, hand('9c 9d 5h 5s Kd'), always(0.99));
  assert.deepEqual([twoPair.action, twoPair.match, twoPair.raise], ['pass', true, undefined]);
  const threes = decide(v, 1, hand('9c 9d 9h 5s Kd'), always(0));
  assert.deepEqual([threes.action, threes.raise], ['pass', 12], 'a strong hand can raise on top');
  v.seats[1].chips = 11;
  assert.deepEqual(decide(v, 1, hand('Ac Ad Ah As Jd'), always(0.99)), { action: 'fold' });
  const out = view({ phase: 'pass', passNo: 3, passRaise: { high: 2, by: 0, paid: { 0: 2, 1: 2 } } });
  assert.notEqual(decide(out, 1, hand('9c 9d 5h 5s Kd'), always(0.99)).action, 'stop', 'a raise is out');
});

test('stopping: not until two passes are done, then with two pair or a high pair', () => {
  const two = hand('9c 9d 5h 5s Kd');
  assert.equal(decide(view({ phase: 'pass', passNo: 2 }), 1, two, always(0.99)).action, 'pass');
  const stopped = decide(view({ phase: 'pass', passNo: 3 }), 1, two, always(0.99));
  assert.equal(stopped.action, 'stop');
  assert.ok(contains(two, stopped.claim), 'an honest stop names what it holds');
  assert.equal(stopped.raise, undefined);
  const high = decide(view({ phase: 'pass', passNo: 3 }), 1, hand('Kc Kd 7h 8s Jd'), always(0.4));
  assert.equal(high.action, 'stop', 'high pair, half the time');
  assert.ok(high.claim, 'and it always has a claim');
  assert.equal(decide(view({ phase: 'pass', passNo: 3 }), 1, hand('3c 3d 7h 8s Jd'), always(0.99)).action, 'pass');
});

test('stopping: every bot stop has a claim, some carry a raise, and some are bluffs, by temperament', () => {
  const rng = makeRng(11);
  const counts = {};
  for (const name of Object.keys(PERSONAS)) {
    counts[name] = { stops: 0, raised: 0, bluffs: 0 };
    for (let i = 0; i < 4000; i++) {
      const dealt = shuffle(newDeck(), rng).slice(0, 5);
      const v = view({ phase: 'pass', passNo: 4 });
      v.seats[1].name = name;
      const move = decide(v, 1, dealt, rng, { persona: PERSONAS[name] });
      if (move.action !== 'stop') continue;
      assert.ok(normalizeClaim(move.claim), JSON.stringify(move));
      counts[name].stops += 1;
      if (move.raise) {
        counts[name].raised += 1;
        assert.ok(move.raise >= 1 && move.raise <= 25, JSON.stringify(move));
      }
      if (!contains(dealt, move.claim)) counts[name].bluffs += 1;
    }
    assert.ok(counts[name].raised > 0, name);
  }
  assert.ok(counts.Brannock.bluffs > counts['Old Wick'].bluffs * 2, JSON.stringify(counts));
  assert.ok(counts.Brannock.raised > counts['Old Wick'].raised, JSON.stringify(counts));
});

test('calling a stop: the same claim is believed more from whoever stopped, but an impossible one is still called', () => {
  const claims = [{ seat: 0, claim: [1, 9, 0], label: 'pair of 9s', status: 'standing' }];
  const facts = (stopper) => view({ claims, top: [1, 9, 0], lapRaise: { high: 0, by: null, paid: {}, waiting: [1], stopper } });
  const held = hand('2c 3d 7h 8s Jd');
  const calls = (stopper) => {
    const rng = makeRng(31);
    let n = 0;
    for (let i = 0; i < 2000; i++) if (decide(facts(stopper), 1, held, rng).action === 'call') n += 1;
    return n;
  };
  assert.ok(calls(0) < calls(null) * 0.85, `${calls(0)} calls of a stopper, ${calls(null)} of another seat`);
  const nines = hand('9c 9d 9h 8s Jd');
  const impossible = view({ claims: [{ seat: 0, claim: [1, 9, 0], label: 'pair of 9s', status: 'standing' }], top: [1, 9, 0], lapRaise: { high: 0, by: null, paid: {}, waiting: [1], stopper: 0 } });
  assert.deepEqual(decide(impossible, 1, nines, always(0.99)), { action: 'call', seat: 0 }, 'three of the four 9s are here');
});

test('after the lap: a bot calls a claim it does not believe, matching or folding by where its claim ranks', () => {
  const standing = [{ seat: 0, claim: [7, 14, 0], label: 'four Aces', status: 'standing' }, { seat: 1, claim: [1, 9, 0], label: 'pair of 9s', status: 'standing' }];
  const facts = (over = {}) => view({ phase: 'answer', claims: standing, top: [7, 14, 0], lapRaise: { high: 3, by: 0, paid: { 0: 3 }, waiting: [1], stopper: null }, pot: 30, ...over });
  const aces = hand('Ac Ad 9h 8s Jd'); // two Aces here: four is impossible
  assert.deepEqual(decide(facts(), 1, aces, always(0.99)), { action: 'call', seat: 0, match: true }, 'its second place is worth 3');
  const noClaim = facts({ claims: [standing[0]] });
  assert.deepEqual(decide(noClaim, 1, aces, always(0.99)), { action: 'call', seat: 0, fold: true }, 'no claim of its own, so it catches and goes');
  const broke = facts();
  broke.seats[1].chips = 5;
  assert.deepEqual(decide(broke, 1, aces, always(0.99)), { action: 'call', seat: 0, fold: true }, 'the stake is all it has');
  broke.seats[1].chips = 2;
  assert.equal(decide(broke, 1, aces, always(0.99)).action, 'fold');
  broke.seats[1].chips = 100;
});

test('bots only ever get the public view, their own hand, and what was passed to them', () => {
  const context = { now: 1000, rng: makeRng(3) };
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Ann', context);
  const v = publicView(s);
  const others = s.hands.filter((_, i) => i !== 1).flat();
  const seen = JSON.stringify([v, s.hands[1]]);
  for (const card of others) assert.ok(!seen.includes(`"${card}"`), `${card} visible to the bot`);
});

/** Plays Ann with the plainest moves to the end of the round. */
function playRound(s, context) {
  runBots(s, context);
  for (let i = 0; i < 80 && !['settled', 'over'].includes(s.phase); i++) {
    if (s.raise) {
      if (currentTurn(s) === 0) act(s, 0, { action: s.seats[0].chips < s.raise.amount ? 'fold' : 'match' }, context);
    } else if (s.phase === 'pass') {
      const legal = legalActions(s, 0);
      const pass = legal.find((m) => m.action === 'pass');
      if (pass) act(s, 0, { action: 'pass', card: s.hands[0][0], ...(pass.match ? { match: true } : {}) }, context);
      else if (legal.some((m) => m.action === 'fold')) act(s, 0, { action: 'fold' }, context);
    }
    else if (currentTurn(s) === 0) {
      const legal = legalActions(s, 0);
      const can = (action) => legal.find((m) => m.action === action);
      if (s.phase === 'answer') act(s, 0, { action: can('match') ? 'match' : 'fold' }, context);
      else if (can('check')?.match) act(s, 0, { action: 'check', match: true }, context);
      else act(s, 0, { action: can('check') ? 'check' : 'fold' }, context);
    }
    runBots(s, context);
  }
}

test('voices: all three bots talk, cleanly, and lines carry no cards', () => {
  assert.deepEqual(Object.keys(VOICES), [HOUSE, 'Brannock', 'Old Wick']);
  const all = Object.values(VOICES).flatMap((voice) => Object.values(voice).flat());
  for (const line of all) {
    assert.ok(line.length <= 120, line);
    assert.ok(!line.split(/[^\p{L}\p{N}]+/u).some(isProfane), line);
    assert.ok(!/\b[2-9TJQKA][cdhs]\b/.test(line), `card in: ${line}`);
  }
  const talked = new Set();
  for (let g = 1; g <= 30; g++) {
    const context = { now: 1000, rng: makeRng(g) };
    const s = createTable({ lobbyMs: 0 });
    join(s, 'Ann', context);
    playRound(s, context);
    for (const l of s.log) if (l.say) { talked.add(l.name); assert.ok(all.includes(l.text)); }
  }
  assert.ok(talked.has(HOUSE));
  assert.ok(talked.has('Brannock'));
  assert.ok(talked.has('Old Wick'));
});

test('Brannock makes the most false claims', () => {
  const tally = {};
  for (let g = 1; g <= 60; g++) {
    const context = { now: 1000, rng: makeRng(1000 + g) };
    const s = createTable({ lobbyMs: 0 });
    join(s, 'Ann', context);
    for (let round = 0; round < 12 && s.phase !== 'over'; round++) {
      playRound(s, context);
      if (s.phase !== 'settled') break;
      for (const c of s.claims) {
        const name = s.seats[c.seat].name;
        tally[name] ??= { claims: 0, false: 0 };
        tally[name].claims += 1;
        if (!contains(s.hands[c.seat], c.claim)) tally[name].false += 1;
      }
      act(s, 0, { action: 'next' }, context);
    }
  }
  const rate = (n) => tally[n].false / tally[n].claims;
  assert.ok(rate('Brannock') > rate(HOUSE) && rate('Brannock') > rate('Old Wick'), JSON.stringify(tally));
});

test('handCategory stays consistent for the strongest hands', () => {
  assert.equal(handCategory(hand('Ah 2h 3h 4h 5h')), CAT.STRAIGHT_FLUSH);
});

// ---------- pacing ----------

function pacedTable(botDelayMs = [1500, 3000]) {
  const context = { now: 1000, rng: makeRng(7) };
  const s = createTable({ lobbyMs: 0, botDelayMs });
  join(s, 'Player', context);
  return { s, context };
}

test('pacing: a bot waits 1.5 to 3 s before it moves, and its wait shows as a public clock', () => {
  const { s, context } = pacedTable();
  paceBots(s, context);
  const view = publicView(s);
  assert.deepEqual(s.passes, [null, null, null, null], 'nobody has moved yet');
  for (const seat of [1, 2, 3]) {
    const clock = view.clocks.find((k) => k.seat === seat);
    assert.equal(clock.from, 1000);
    assert.ok(clock.until >= 2500 && clock.until <= 4000, `seat ${seat}: ${clock.until}`);
  }
  assert.equal(view.clocks.find((k) => k.seat === 0).until, null, 'one human against the house has no clock');

  const first = Math.min(...[1, 2, 3].map((seat) => s.botDue[seat].at));
  paceBots(s, { ...context, now: first - 1 });
  assert.deepEqual(s.passes.slice(1), [null, null, null], 'not a moment early');
  paceBots(s, { ...context, now: first });
  assert.equal(s.passes.slice(1).filter(Boolean).length, 1, 'only the one whose time came');
});

test('pacing: every delay stays in range over many moves, and bots answer a raise during the pass window', () => {
  const { s, context } = pacedTable();
  const delays = [];
  act(s, 0, { action: 'pass', card: s.hands[0][0], raise: 2 }, context);
  for (let i = 0; i < 400 && !['settled', 'over'].includes(s.phase); i++) {
    paceBots(s, context);
    for (const due of Object.values(s.botDue)) if (due.from === context.now) delays.push(due.at - due.from);
    const waiting = publicView(s).waitingOn;
    if (waiting.includes(0)) {
      const legal = legalActions(s, 0);
      const pick = legal.find((a) => a.action === 'pass') ?? legal.find((a) => a.action === 'match') ?? legal.find((a) => a.action === 'check') ?? legal.find((a) => a.action === 'fold');
      act(s, 0, pick.action === 'pass' ? { action: 'pass', card: pick.cards[0], ...(pick.match ? { match: true } : {}) } : { action: pick.action, ...(pick.match && pick.action !== 'match' ? { match: true } : {}) }, context);
      continue;
    }
    const soonest = Math.min(...Object.values(s.botDue).map((d) => d.at));
    if (soonest === Infinity) break;
    context.now = soonest;
  }
  assert.ok(['settled', 'over'].includes(s.phase), `reached ${s.phase}`);
  assert.ok(delays.length > 3, `${delays.length} delays seen`);
  assert.ok(delays.every((ms) => ms >= 1500 && ms <= 3000), delays.join());
  assert.ok(new Set(delays).size > 1, 'random, not fixed');
});

test('pacing: zero delay plays at once, like the sim', () => {
  const { s, context } = pacedTable([0, 0]);
  paceBots(s, context);
  assert.deepEqual(publicView(s).waitingOn, [0]);
  assert.deepEqual(s.botDue, {});
});

test('pacing: a bot that changes step thinks again rather than moving early', () => {
  const { s, context } = pacedTable();
  paceBots(s, context);
  const old = s.botDue[1].at;
  act(s, 0, { action: 'pass', card: s.hands[0][0], raise: 2 }, { ...context, now: old - 10 });
  paceBots(s, { ...context, now: old - 10 });
  assert.ok(s.botDue[1].at >= old - 10 + 1500, 'its answer to the raise gets a fresh wait');
  assert.ok(s.botDue[2].at >= old - 10 + 1500, 'all of them do: the window stays open, all at once');
});

// ---------- how a bot passes ----------

const passView = () => view({ phase: 'pass', passNo: 1, seats: [{ name: 'A', chips: 100, rep: { called: 0, caught: 0 } }, { name: HOUSE, chips: 100, rep: { called: 0, caught: 0 } }] });
const passedOver = (name, cards, tries = 2000) => {
  const rng = makeRng(7);
  const counts = {};
  for (let i = 0; i < tries; i += 1) {
    const move = decide(passView(), 1, cards, rng, { persona: PERSONAS[name] });
    assert.equal(move.action, 'pass');
    counts[move.card] = (counts[move.card] ?? 0) + 1;
  }
  return counts;
};

test('passing: every bot varies it, and the bolder the bot, the less often it is the lowest', () => {
  const cards = hand('2c 5d 8h Js Kd');
  const lowest = (name) => passedOver(name, cards)['2c'] / 2000;
  for (const name of Object.keys(PERSONAS)) assert.ok(lowest(name) < 0.9, `${name} doesn't always pass the lowest`);
  assert.ok(lowest('Brannock') < lowest(HOUSE) && lowest(HOUSE) < lowest('Old Wick'));
  const brannock = passedOver('Brannock', cards);
  assert.ok(brannock['8h'] > 200, 'a middling card, as if it can afford to');
  assert.ok(brannock.Kd > 100, 'its best spare card now and then');
  assert.ok(brannock.Kd < brannock['2c'], 'but not as often as the lowest');
  assert.ok(passedOver('Old Wick', cards).Kd < brannock.Kd, 'Old Wick hardly ever gives a good card away');
});

test('passing: no style breaks up a pair or better', () => {
  for (const name of Object.keys(PERSONAS)) {
    const pair = passedOver(name, hand('3c 3d 7h Js Kd'));
    assert.equal(pair['3c'] ?? 0, 0);
    assert.equal(pair['3d'] ?? 0, 0);
    assert.ok(Object.keys(pair).length > 1, 'it still has a choice among the others');
    assert.deepEqual(Object.keys(passedOver(name, hand('3c 3d 7h 7s Kd'))), ['Kd'], 'two pair: only the spare');
    const trips = passedOver(name, hand('3c 3d 3h 7s Kd'));
    assert.deepEqual(Object.keys(trips).sort(), ['7s', 'Kd']);
  }
});

test('passing: the builder keeps what is nearest a flush or a straight, however low', () => {
  const rng = seq([0.3, 0]); // past good and mid, inside builder, then the first of any ties
  const persona = { bluff: 0, doubt: 0, pass: { builder: 1, mid: 0, good: 0 } };
  const flush = decide(passView(), 1, hand('2h 4h 7h 9h Kd'), rng, { persona });
  assert.equal(flush.card, 'Kd', 'four hearts stay, so the King goes');
  const straight = decide(passView(), 1, hand('3c 4d 5h 6s Qd'), rng, { persona });
  assert.equal(straight.card, 'Qd', 'a run stays, so the Queen goes');
});

test('passing: a persona with no styles passes the plain way, and the same rng passes the same card', () => {
  const plain = { bluff: 0, doubt: 0 };
  for (const x of [0, 0.5, 0.99]) assert.equal(decide(passView(), 1, hand('2c 5d 8h Js Kd'), always(x), { persona: plain }).card, '2c');
  const run = () => { const rng = makeRng(11); return Array.from({ length: 30 }, () => decide(passView(), 1, hand('2c 5d 8h Js Kd'), rng).card); };
  assert.deepEqual(run(), run());
});
