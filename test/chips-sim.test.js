// A heavy bettor at a play-chip table (scripts/chips-sim.js): bids and raises up to its whole stack, and the table never closes, no house bot
// leaves, stands or sits a round out for lack of chips, and the bots keep a full stack to call with.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runSim } from '../scripts/chips-sim.js';

for (const game of ['cup-and-claim', 'sealed-hand']) {
  test(`${game}: 12 rounds against an all-in bettor on play chips, the table stays open and the house bots never run dry`, () => {
    const r = runSim(game, { rounds: 12, seed: 11 });
    assert.deepEqual(r.violations, []);
    assert.equal(r.rounds, 12);
    assert.equal(r.over, false);
    assert.notEqual(r.phase, 'over');
    assert.ok(r.biggest >= 500, `the bettor really did raise big (${r.biggest})`);
    assert.ok(r.biggestPot > 500, `pots went past the old 500 limit (${r.biggestPot})`);
    assert.ok(Object.values(r.minStack).every((n) => Number.isFinite(n)));
  });
}

test('the sim is repeatable: the same seed plays the same game', () => {
  const a = runSim('cup-and-claim', { rounds: 6, seed: 3 });
  const b = runSim('cup-and-claim', { rounds: 6, seed: 3 });
  assert.deepEqual(a, b);
});
