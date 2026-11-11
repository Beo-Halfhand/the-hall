// The collusion watch: chances and calls from the games' own legal moves, flags only past a bar honest pairs don't reach,
// shared origins, and a new sitter starting afresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_MIN, challengeTargets, newFlags, watchFlags, watchMove, watchOrigin, watchView } from '../src/platform/collusion.js';

const table = (n = 4) => ({ seats: Array.from({ length: n }, (_, i) => ({ name: `S${i}`, kind: 'agent', left: false })) });
const seated = (s) => (i) => !!s.seats[i] && s.seats[i].kind !== 'house' && !s.seats[i].left;
const liar = (seat) => [{ action: 'bid' }, { action: 'liar', seat }];

test('the chances come from the game\'s own legal moves: liar on the bidder, call on any claim', () => {
  assert.deepEqual(challengeTargets(liar(2)), [2]);
  assert.deepEqual(challengeTargets([{ action: 'call', seats: [1, 3] }, { action: 'check' }]), [1, 3]);
  assert.deepEqual(challengeTargets([{ action: 'bid' }]), []);
});

test('a pair that never calls each other while calling the rest is flagged, past the bar; an honest pair is not', () => {
  const s = table();
  for (let i = 0; i < 4; i += 1) watchOrigin(s, i, {});
  // seats 0 and 1 never call each other (20 chances); both call others half the time; seats 2 and 3 call everyone half the time
  for (let k = 0; k < 10; k += 1) {
    watchMove(s, 0, liar(1), { action: 'bid' });
    watchMove(s, 1, liar(0), { action: 'bid' });
    for (const [from, to] of [[0, 2], [0, 3], [1, 2], [1, 3], [2, 0], [2, 1], [2, 3], [3, 0], [3, 1], [3, 2]]) watchMove(s, from, liar(to), { action: k % 2 ? 'liar' : 'bid' });
  }
  const flags = watchFlags(s, seated(s));
  assert.deepEqual(flags.map((f) => f.seats), [[0, 1]]);
  assert.match(flags[0].why, /0 calls on each other in 20 chances, against 50% on the rest/);
  assert.equal(newFlags(s, flags).length, 1, 'logged once');
  assert.equal(newFlags(s, watchFlags(s, seated(s))).length, 0, 'not again');
  assert.deepEqual(watchView(s).flags[0].names, ['S0', 'S1']);
});

test('short sessions stay quiet: under the minimum chances nothing is flagged', () => {
  const s = table(2);
  watchOrigin(s, 0, {}); watchOrigin(s, 1, {});
  for (let k = 0; k < (FLAG_MIN - 2) / 2; k += 1) { watchMove(s, 0, liar(1), { action: 'bid' }); watchMove(s, 1, liar(0), { action: 'bid' }); }
  assert.deepEqual(watchFlags(s, seated(s)), []);
});

test('shared origins: one payout is one owner; one network address; no address known is no flag; the house is never a pair', () => {
  const s = table();
  watchOrigin(s, 0, { ipHash: 'aa', payout: 'p1' });
  watchOrigin(s, 1, { ipHash: 'bb', payout: 'p1' });
  watchOrigin(s, 2, { ipHash: 'cc' });
  watchOrigin(s, 3, { ipHash: 'cc' });
  const flags = watchFlags(s, seated(s));
  assert.deepEqual(flags.map((f) => [f.seats, f.why]), [[[0, 1], 'one payout wallet: one owner, two seats'], [[2, 3], 'the same network address']]);
  const t = table(2);
  watchOrigin(t, 0, { ipHash: null }); watchOrigin(t, 1, { ipHash: null });
  assert.deepEqual(watchFlags(t, seated(t)), [], 'a test server: no address, no flag');
  s.seats[3].kind = 'house';
  assert.deepEqual(watchFlags(s, seated(s)).map((f) => f.seats), [[0, 1]]);
});

test('a new sitter at a seat starts afresh: the old counts and flags for that seat go', () => {
  const s = table(2);
  watchOrigin(s, 0, { ipHash: 'x' }); watchOrigin(s, 1, { ipHash: 'x' });
  newFlags(s, watchFlags(s, seated(s)));
  watchMove(s, 0, liar(1), { action: 'bid' });
  watchOrigin(s, 1, { ipHash: 'y' });
  assert.deepEqual(s.watch.pairs, {});
  assert.deepEqual(s.watch.flagged, []);
  assert.deepEqual(watchFlags(s, seated(s)), []);
});
