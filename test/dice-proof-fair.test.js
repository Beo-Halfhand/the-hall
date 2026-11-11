// The server, the player's page and the contract must agree on every hash and every die. These vectors are written by the compiled
// contract's own pure circuits, in sealed-cage: scripts/dice-vectors.mjs, test/dice-vectors.json. A copy lives here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { proofCommit, proofDice, proofHouseCommit, proofKeyId, proofPreSeal, proofSalt } from '../src/games/cup-and-claim/fair.js';
import { commitOf, countsOf, diceOf, keyIdOf, preSealOf } from '../public/js/dice-roll.js';

const vectors = JSON.parse(readFileSync(new URL('./dice-vectors.json', import.meta.url), 'utf8'));

test('the Worker\'s arithmetic matches the contract', () => {
  assert.ok(vectors.length >= 5);
  for (const v of vectors) {
    assert.equal(proofKeyId(v.seed), v.keyId);
    assert.equal(proofHouseCommit(v.houseSeed, v.table, v.round), v.houseCommit);
    assert.equal(proofCommit(v.seed, v.table, v.round, v.seat, v.self), v.commit);
    assert.equal(proofPreSeal(v.commit, v.table, v.round, v.seat), v.preseal);
    assert.equal(proofSalt(v.houseSeed, v.table, v.round, v.cups, v.self), v.salt);
    assert.deepEqual(proofDice(v.salt, v.seed, v.seat), v.dice);
  }
});

test('the player\'s page\'s arithmetic matches the contract', async () => {
  for (const v of vectors) {
    assert.equal(await keyIdOf(v.seed), v.keyId);
    assert.equal(await commitOf(v.seed, v.table, v.round, v.seat, v.self), v.commit);
    assert.equal(await preSealOf(v.commit, v.table, v.round, v.seat), v.preseal);
    assert.deepEqual(await diceOf(v.salt, v.seed, v.seat), v.dice);
  }
});

test('1s count for every face on the player\'s page', () => {
  assert.deepEqual(countsOf([1, 1, 2, 5, 5]), { 2: 3, 3: 2, 4: 2, 5: 4, 6: 2 });
  assert.deepEqual(countsOf([1, 1, 1, 1, 1]), { 2: 5, 3: 5, 4: 5, 5: 5, 6: 5 });
});
