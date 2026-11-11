import test from 'node:test';
import assert from 'node:assert/strict';
import { CAT, LADDER, bestClaim, compareClaims, contains, firstRungAbove, labelClaim, leastHurtCard, newDeck, normalizeClaim, shuffle, truthfulAbove } from '../src/games/sealed-hand/cards.js';

const hand = (text) => text.split(' ');
const T = 10, J = 11, Q = 12, K = 13, A = 14;

test('deck: 52 distinct cards, and shuffle keeps them all', () => {
  const deck = newDeck();
  assert.equal(new Set(deck).size, 52);
  let x = 0.1;
  const rng = () => (x = (x * 9301 + 0.49297) % 1);
  assert.deepEqual(shuffle(deck, rng).slice().sort(), deck.slice().sort());
});

test('truth: every category, true and false', () => {
  const cases = [
    ['9c 9d 2h 5s Kd', [CAT.PAIR, 9, 0], true],
    ['9c 8d 2h 5s Kd', [CAT.PAIR, 9, 0], false],
    ['9c 9d 5h 5s Kd', [CAT.TWO_PAIR, 9, 5], true],
    ['9c 9d 5h 4s Kd', [CAT.TWO_PAIR, 9, 5], false],
    ['9c 9d 5h 5s Kd', [CAT.TWO_PAIR, 9, 0], true], // "9s high"
    ['9c 9d Kh Ks 2d', [CAT.TWO_PAIR, 9, 0], false], // Kings are the high pair, so not "9s high"
    ['9c 9d 9h 5s Kd', [CAT.THREE, 9, 0], true],
    ['9c 9d 8h 5s Kd', [CAT.THREE, 9, 0], false],
    ['5c 6d 7h 8s 9d', [CAT.STRAIGHT, 9, 0], true],
    ['5c 6d 7h 8s 9d', [CAT.STRAIGHT, T, 0], false],
    ['Ac 2d 3h 4s 5d', [CAT.STRAIGHT, 5, 0], true], // wheel
    ['Ac 2d 3h 4s 5d', [CAT.STRAIGHT, A, 0], false],
    ['Tc Jd Qh Ks Ad', [CAT.STRAIGHT, A, 0], true],
    ['2h 7h 9h Jh Kh', [CAT.FLUSH, 0, 0], true],
    ['2h 7h 9h Jh Kh', [CAT.FLUSH, K, 0], true],
    ['2h 7h 9h Jh Kh', [CAT.FLUSH, J, 0], false], // exact top
    ['2h 7h 9h Jh Kd', [CAT.FLUSH, 0, 0], false],
    ['9c 9d 9h 5s 5d', [CAT.FULL, 9, 5], true],
    ['9c 9d 5h 5s 5d', [CAT.FULL, 9, 5], false], // 5s over 9s, not 9s over 5s
    ['9c 9d 9h 5s 5d', [CAT.FULL, 9, 0], true], // "9s full"
    ['9c 9d 9h 5s 4d', [CAT.FULL, 9, 0], false],
    ['9c 9d 9h 9s 5d', [CAT.FOUR, 9, 0], true],
    ['9c 9d 9h 5s 5d', [CAT.FOUR, 9, 0], false],
    ['5h 6h 7h 8h 9h', [CAT.STRAIGHT_FLUSH, 0, 0], true],
    ['Ah 2h 3h 4h 5h', [CAT.STRAIGHT_FLUSH, 0, 0], true],
    ['5h 6h 7h 8h 9d', [CAT.STRAIGHT_FLUSH, 0, 0], false],
  ];
  for (const [h, claim, want] of cases) assert.equal(contains(hand(h), claim), want, `${h} / ${labelClaim(claim)}`);
});

test('truth: a hand CONTAINS weaker combinations inside it', () => {
  assert.ok(contains(hand('9c 9d 9h 5s 5d'), [CAT.PAIR, 9, 0]), 'a full house holds a pair of 9s');
  assert.ok(contains(hand('9c 9d 9h 5s 5d'), [CAT.PAIR, 5, 0]), 'and a pair of 5s');
  assert.ok(contains(hand('9c 9d 9h 5s 5d'), [CAT.TWO_PAIR, 9, 5]), 'and two pair');
  assert.ok(contains(hand('9c 9d 9h 5s 5d'), [CAT.THREE, 9, 0]), 'and three 9s');
  assert.ok(contains(hand('9c 9d 9h 9s 5d'), [CAT.THREE, 9, 0]), 'four 9s holds three 9s');
  assert.ok(contains(hand('5h 6h 7h 8h 9h'), [CAT.STRAIGHT, 9, 0]), 'a straight flush holds the straight');
  assert.ok(contains(hand('5h 6h 7h 8h 9h'), [CAT.FLUSH, 9, 0]), 'and the flush');
  assert.ok(!contains(hand('9c 9d 9h 9s 5d'), [CAT.TWO_PAIR, 9, 0]), 'four of a kind is not two pair');
});

test('ordering: lexicographic [cat, r1, r2]', () => {
  const rising = [[1, 2, 0], [1, 14, 0], [2, 3, 0], [2, 3, 2], [2, 4, 0], [2, 14, 13], [3, 2, 0], [4, 5, 0], [4, 14, 0], [5, 0, 0], [5, 6, 0], [5, 14, 0], [6, 2, 0], [6, 2, 3], [6, 14, 13], [7, 2, 0], [7, 14, 0], [8, 0, 0]];
  for (let i = 1; i < rising.length; i++) assert.equal(compareClaims(rising[i - 1], rising[i]), -1, `${rising[i - 1]} < ${rising[i]}`);
  assert.equal(compareClaims([3, 9, 0], [3, 9, 0]), 0);
});

test('ladder: strictly rising, every rung legal, ends at straight flush', () => {
  for (let i = 1; i < LADDER.length; i++) assert.equal(compareClaims(LADDER[i - 1], LADDER[i]), -1);
  assert.deepEqual(LADDER[0], [1, 2, 0]);
  assert.deepEqual(LADDER.at(-1), [8, 0, 0]);
  assert.equal(firstRungAbove(null), 0);
  assert.equal(firstRungAbove([8, 0, 0]), LADDER.length);
});

test('claim validation rejects malformed shapes', () => {
  for (const bad of [null, 'pair', [], [0, 5], [9, 5], [1], [1, 1], [1, 15], [1, 5, 2], [1, 2.5], [2, 5, 5], [2, 5, 9], [2, 2], [4, 4], [4, 15], [5, 5], [6, 9, 9], [7, 1], [8, 9], [1, 2, 0, 0], ['1', 5]]) {
    assert.equal(normalizeClaim(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeClaim([1, 9]), [1, 9, 0]);
  assert.deepEqual(normalizeClaim([5]), [5, 0, 0]);
  assert.deepEqual(normalizeClaim([8]), [8, 0, 0]);
});

test('truthfulAbove and bestClaim', () => {
  const h = hand('9c 9d 5h 5s Kd');
  assert.deepEqual(bestClaim(h), [2, 9, 5]);
  assert.deepEqual(truthfulAbove(h, null)[0], [1, 5, 0]);
  assert.deepEqual(truthfulAbove(h, [1, 5, 0])[0], [1, 9, 0]);
  assert.deepEqual(truthfulAbove(h, [2, 9, 5]), []);
  assert.equal(bestClaim(hand('2c 7d 9h Js Kd')), null);
  assert.deepEqual(bestClaim(hand('Ah 2h 3h 4h 5h')), [8, 0, 0]);
});

test('labels', () => {
  assert.equal(labelClaim([1, 9, 0]), 'pair of 9s');
  assert.equal(labelClaim([2, K, 5]), 'two pair, Kings and 5s');
  assert.equal(labelClaim([2, K, 0]), 'two pair, Kings high');
  assert.equal(labelClaim([4, Q, 0]), 'straight to the Queen');
  assert.equal(labelClaim([5, 0, 0]), 'flush');
  assert.equal(labelClaim([5, A, 0]), 'Ace-high flush');
  assert.equal(labelClaim([6, 9, 5]), 'full house, 9s over 5s');
  assert.equal(labelClaim([6, 9, 0]), '9s full');
  assert.equal(labelClaim([8, 0, 0]), 'straight flush');
});

test('leastHurtCard keeps made hands and draws', () => {
  assert.equal(leastHurtCard(hand('9c 9d 2h 5s Kd')), '2h', 'keeps the pair, drops the low card');
  assert.equal(leastHurtCard(hand('9c 9d 9h 5s Kd')), '5s', 'keeps the set');
  assert.equal(leastHurtCard(hand('2h 7h 9h Jh Kd')), 'Kd', 'keeps four to a flush');
  assert.equal(leastHurtCard(hand('5c 6d 7h 8s Kd')), 'Kd', 'keeps four to a straight');
});
