// The Hall's record of closed tables: one entry per close, newest first, capped at 200, names and chips only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_KEEP, closureFields, listClosures, logClosure } from '../src/platform/closures.js';

/** Just enough of a Durable Object's storage: get, put (a key or an object), delete (one key), list with prefix and reverse. */
function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix = '', reverse = false } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1) * (reverse ? -1 : 1))),
    size: () => m.size,
  };
}
const id = (n) => n.toString(16).padStart(64, '0');
const report = (n, extra = {}) => ({ game: 'cup-and-claim', id: id(n), phase: 'over', round: 3, overCode: 'everyone_left', overReason: 'Everyone else left.', overRound: 3, humans: ['Ann'], stacks: [{ name: 'Ann', chips: 1040, left: true }], ...extra });

test('a closure is logged with the table, the round, the code, the words and who was left with what', async () => {
  const store = memoryStorage();
  const entry = await logClosure(store, report(1), 7, 5000);
  assert.deepEqual(entry, { at: 5000, game: 'cup-and-claim', n: 7, id: id(1), round: 3, code: 'everyone_left', text: 'Everyone else left.', humans: ['Ann'], stacks: [{ name: 'Ann', chips: 1040, left: true }] });
  assert.deepEqual(await listClosures(store), [entry]);
  assert.equal(await logClosure(store, report(1), 7, 6000), null, 'a table that reports its close twice is logged once');
  assert.equal((await listClosures(store)).length, 1);
  const text = JSON.stringify(await listClosures(store));
  assert.ok(!/token|playerId|secret/i.test(text), 'names and chips only');
});

test('closures list newest first, can be narrowed by game and limit, and keep only the last 200', async () => {
  const store = memoryStorage();
  await logClosure(store, report(1), 1, 1000);
  await logClosure(store, report(2, { game: 'sealed-hand', overCode: 'no_human_action', overReason: 'No moves for 30 minutes.' }), 4, 2000);
  await logClosure(store, report(3, { overCode: 'others_out_of_chips', overReason: 'The other players ran out of chips.' }), 2, 3000);
  assert.deepEqual((await listClosures(store)).map((e) => [e.n, e.code]), [[2, 'others_out_of_chips'], [4, 'no_human_action'], [1, 'everyone_left']]);
  assert.deepEqual((await listClosures(store, { game: 'sealed-hand' })).map((e) => e.n), [4]);
  assert.deepEqual((await listClosures(store, { limit: 2 })).map((e) => e.n), [2, 4]);
  for (let i = 10; i < 10 + 250; i++) await logClosure(store, report(i), i, 10_000 + i);
  const all = await listClosures(store, { limit: 1000 });
  assert.equal(all.length, CLOSED_KEEP);
  assert.equal(all[0].n, 259, 'the newest first');
  assert.equal(all.at(-1).n, 60, 'the oldest 50 and the first three are gone');
  assert.equal(store.size(), CLOSED_KEEP * 2, 'and so are their once-only marks');
  assert.ok(await logClosure(store, report(10), 10, 99_999), 'a table whose entry was trimmed could be logged again, but no table closes twice');
});

test('a table reports its close with the code, the words, the round, and every non-bot seat with its stack (names and chips only)', () => {
  const seats = [{ name: 'Ann', kind: 'human', chips: 0, left: true, leftWith: 1040 }, { name: 'Probe', kind: 'agent', chips: 220 }, { name: 'Brannock', bot: true, kind: 'house', chips: 900 }];
  const fields = closureFields({ seats, round: 5, overCode: 'no_human_action', overReason: 'No moves for 30 minutes.', overRound: 5 });
  assert.deepEqual(fields, { overCode: 'no_human_action', overReason: 'No moves for 30 minutes.', overRound: 5, humans: ['Ann', 'Probe'], stacks: [{ name: 'Ann', chips: 1040, left: true }, { name: 'Probe', chips: 220 }] });
});
