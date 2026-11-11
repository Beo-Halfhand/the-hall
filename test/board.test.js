// The leaderboard's sums: weeks in Pacific time, one line per ranked seat per round, counted once, ranked best net first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { boardAdd, boardAfterChange, boardList, netsFromMoney, netsFromStakes, weekOf } from '../src/platform/board.js';

/** Just enough of a Durable Object's storage for these. */
function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
const P = (c) => c.repeat(64);
const body = async (res) => res.json();

test('weekOf: Monday 00:00 to Monday 00:00 Pacific, across the clock change', () => {
  // Thursday 2026-11-05, 4 pm Pacific (PST, UTC-8).
  const w = weekOf(Date.parse('2026-11-06T00:13:00Z'));
  assert.equal(w.key, '2026-11-02');
  assert.equal(new Date(w.start).toISOString(), '2026-11-02T08:00:00.000Z', 'Monday midnight PST');
  assert.equal(new Date(w.end).toISOString(), '2026-11-09T08:00:00.000Z');
  // The week the clocks went back (Sunday 2026-11-01): it starts at midnight PDT and ends at midnight PST.
  const dst = weekOf(Date.parse('2026-10-28T12:00:00Z'));
  assert.equal(dst.key, '2026-10-26');
  assert.equal(new Date(dst.start).toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(new Date(dst.end).toISOString(), '2026-11-02T08:00:00.000Z');
  // Sunday 11:30 pm Pacific is still that week; a minute past Monday midnight is the next.
  assert.equal(weekOf(Date.parse('2026-11-09T07:30:00Z')).key, '2026-11-02');
  assert.equal(weekOf(Date.parse('2026-11-09T08:01:00Z')).key, '2026-11-09');
  assert.equal(weekOf(Date.parse('2026-11-06T00:13:00Z'), 1).key, '2026-10-26', 'last week');
});

test('nets: Sealed Hand from the round money, Cup & Claim from award less stake; seats not dealt in are left out', () => {
  assert.deepEqual(netsFromMoney({ money: [{ in: 5, out: 0 }, { in: 15, out: 40 }, { in: 0, out: 0 }, { in: 20, out: 0 }] }), [{ seat: 0, net: -5 }, { seat: 1, net: 25 }, { seat: 3, net: -20 }]);
  assert.deepEqual(netsFromStakes({ stakes: [5, 5, 0, 5], awards: [{ seat: 0, amount: 8 }, { seat: 3, amount: 7 }] }), [{ seat: 0, net: 3 }, { seat: 1, net: -5 }, { seat: 3, net: 2 }]);
});

test('boardAfterChange: once per settled round, players only, never at a tNIGHT table or for a pot handed back', () => {
  const seats = [{ name: 'Ann', kind: 'human', avatar: 'mage' }, { name: 'Brannock', bot: true, kind: 'house' }, { name: 'Probe', kind: 'agent', avatar: null }];
  const s = { round: 3, seats, players: [P('a'), null, P('c')], lastResult: { round: 3, kind: 'showdown' } };
  const nets = [{ seat: 0, net: 12 }, { seat: 1, net: -6 }, { seat: 2, net: -6 }];
  boardAfterChange(s, 'f'.repeat(64), nets);
  assert.deepEqual(s.boardQueue.map((l) => [l.name, l.net, l.kind]), [['Ann', 12, 'human'], ['Probe', -6, 'agent']], 'the house bot has no player');
  assert.equal(s.boardQueue[0].id, `${'f'.repeat(16)}:3`);
  boardAfterChange(s, 'f'.repeat(64), nets);
  assert.equal(s.boardQueue.length, 2, 'the same round is queued once');
  const cage = { ...s, boardQueue: [], boardRound: null, cage: {} };
  boardAfterChange(cage, 'f'.repeat(64), nets);
  assert.deepEqual(cage.boardQueue, [], 'tNIGHT is not on the board');
  const back = { ...s, boardQueue: [], boardRound: null, lastResult: { round: 3, kind: 'returned' } };
  boardAfterChange(back, 'f'.repeat(64), nets);
  assert.deepEqual(back.boardQueue, []);
  const stale = { ...s, boardQueue: [], boardRound: null, round: 4 };
  boardAfterChange(stale, 'f'.repeat(64), nets);
  assert.deepEqual(stale.boardQueue, [], 'a result from an earlier round is not counted again as a new deal starts');
});

test('boardAdd and boardList: weekly totals, a repeated line counted once, best net first, your row by id, no ids out', async () => {
  const storage = memoryStorage();
  const at = Date.parse('2026-11-05T20:00:00Z');
  const line = (who, net, id, name = who) => ({ id, playerId: P(who), name, avatar: null, kind: 'human', net });
  await boardAdd(storage, { lines: [line('a', 12, 't1:1', 'Ann'), line('b', -5, 't1:1', 'Bo'), line('c', 30, 't2:1', 'Cy')], at });
  await boardAdd(storage, { lines: [line('a', 12, 't1:1', 'Ann')], at }); // a retry
  await boardAdd(storage, { lines: [line('a', 4, 't1:2', 'Ann'), line('b', 21, 't1:2', 'Bo'), { id: 'x', playerId: 'nope', net: 3 }], at });
  const list = await body(await boardList(storage, { week: '2026-11-02', playerId: P('b') }));
  assert.equal(list.players, 3);
  assert.deepEqual(list.rows.map((r) => [r.rank, r.name, r.net, r.rounds, r.wins]), [[1, 'Cy', 30, 1, 1], [2, 'Ann', 16, 2, 2], [3, 'Bo', 16, 2, 1]], 'Ann and Bo tie on net; Ann won more rounds');
  assert.deepEqual(list.you, { rank: 3, name: 'Bo', avatar: null, kind: 'human', net: 16, rounds: 2, wins: 1, you: true });
  assert.ok(!JSON.stringify(list).includes(P('a')), 'no player id leaves the Directory');
  const other = await body(await boardList(storage, { week: '2026-10-26', playerId: null }));
  assert.deepEqual([other.players, other.you], [0, null], 'last week is its own slate');
});

test('Fill up never moves the board: only round nets count, so a refilled player ranks by what they won, not by their stack', async () => {
  // Ann busts for -995, fills up (no line at all), then wins 10: net -985. Bo just wins 5: net +5, ahead of Ann whatever Ann's stack is.
  const s = { round: 2, seats: [{ name: 'Ann', kind: 'human' }], players: [P('a')], lastResult: { round: 2, kind: 'showdown' } };
  boardAfterChange(s, 'f'.repeat(64), [{ seat: 0, net: -995 }]);
  const afterBust = s.boardQueue.length;
  s.seats[0].chips = 1000; // Fill up: chips arrive on the stack, outside any round
  boardAfterChange(s, 'f'.repeat(64), []); // and the table's next save has nothing new to say
  assert.equal(s.boardQueue.length, afterBust, 'a fill-up queues no line');
  const store = memoryStorage();
  const at = Date.parse('2026-11-06T00:13:00Z');
  await boardAdd(store, { at, lines: [{ id: 't:1', playerId: P('a'), name: 'Ann', net: -995, kind: 'human' }, { id: 't:3', playerId: P('a'), name: 'Ann', net: 10, kind: 'human' }, { id: 't:3b', playerId: P('b'), name: 'Bo', net: 5, kind: 'agent' }] });
  const { rows } = await body(await boardList(store, { week: weekOf(at).key }));
  assert.deepEqual(rows.map((r) => [r.name, r.net]), [['Bo', 5], ['Ann', -985]]);
  assert.ok(rows.every((r) => !('chips' in r) && !('stack' in r)), 'the board carries no stack');
});
