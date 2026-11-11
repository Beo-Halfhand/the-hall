// Sealed Hand's public round records, as pure state: what goes up at the deal and what goes up at the end, once each, under the
// right number, and never a card.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CAT, labelClaim } from '../src/games/sealed-hand/cards.js';
import { recordNumber, recordsAfterChange } from '../src/games/sealed-hand/records.js';
import { deckOrder, deckSeal } from '../src/games/sealed-hand/fair.js';

const SEED = 'ab'.repeat(32);

const HANDS = [['Ks', 'Kh', '7d', '7c', '2s'], ['Ad', 'Qd', '9h', '4c', '3s'], ['Th', 'Td', 'Tc', '5h', '5s']];
const KINGS = [CAT.PAIR, 13, 0];
const TENS = [CAT.THREE, 10, 0];

function dealtTable(extra = {}) {
  return {
    round: 1,
    phase: 'pass',
    seats: [{ name: 'Probe', kind: 'human' }, { name: 'Brannock', kind: 'bot', bot: true }, { name: 'Old Wick', kind: 'bot', bot: true }, { name: 'Late', kind: 'human' }],
    status: ['in', 'in', 'in', 'out'],
    cfg: { ante: 5, logMax: 100 },
    hands: HANDS,
    log: [],
    logN: 0,
    deal: { seed: SEED, deck: deckOrder(SEED), seal: null },
    passLog: [[{ n: 1, sent: '2s', to: 1, got: '5s', from: 2 }], [{ n: 1, sent: '3s', to: 2, got: '2s', from: 0 }], [{ n: 1, sent: '5s', to: 0, got: '3s', from: 1 }], []],
    claims: [{ seat: 0, claim: KINGS, status: 'proven' }, { seat: 2, claim: TENS, status: 'standing' }, { seat: 1, claim: [5, 0, 0], status: 'caught' }],
    lastResult: null,
    ...extra,
  };
}

const settledResult = () => ({
  round: 1,
  kind: 'settled',
  pot: 30,
  carried: 0,
  awards: [{ seat: 2, amount: 20, claim: TENS }, { seat: 0, amount: 10, claim: KINGS }],
  claims: [{ seat: 0, label: labelClaim(KINGS), status: 'proven' }, { seat: 2, label: labelClaim(TENS), status: 'standing' }, { seat: 1, label: 'flush', status: 'caught' }],
  folded: [],
  money: [{ in: 10, out: 10 }, { in: 15, out: 0 }, { in: 5, out: 20 }, { in: 0, out: 0 }],
});

const noCards = (value) => !HANDS.flat().some((card) => JSON.stringify(value).includes(`"${card}"`));

test('a play table posts nothing until the Hall has numbered it', () => {
  const s = dealtTable();
  recordsAfterChange(s, null);
  assert.deepEqual(s.rec.queue, []);
  assert.equal(recordNumber(s, null, 1), null);
});

test('the deal: one opening part under "table · round", who was dealt in, and the ante; running again adds nothing', () => {
  const s = dealtTable();
  recordsAfterChange(s, 3);
  recordsAfterChange(s, 3);
  assert.equal(s.rec.queue.length, 1);
  const [{ kind, table, round, patch }] = s.rec.queue;
  assert.deepEqual({ kind, table, round }, { kind: 'play', table: 3, round: 1 });
  assert.deepEqual(patch.seats.map((x) => [x.name, x.bot, x.dealt]), [['Probe', false, true], ['Brannock', true, true], ['Old Wick', true, true], ['Late', false, false]]);
  assert.equal(patch.ante, 5);
  assert.equal(patch.engineRound, 1);
  assert.equal(patch.fingerprint, undefined, 'the dice have a fingerprint; a deck has a seal');
  assert.equal(patch.seal.hash, deckSeal({ table: 3, round: 1, seed: SEED, deck: deckOrder(SEED) }), 'the seal, under the round\'s number');
  assert.equal(patch.seal.domain, 'sealed-hand/seal/v1');
  assert.equal(s.deal.seal, patch.seal.hash, 'kept on the state for the pages');
  assert.ok(s.log.some((l) => l.act?.kind === 'seal'), 'and said in the log');
  assert.ok(noCards(s.rec), 'no card');
  assert.ok(!JSON.stringify(s.rec).includes(SEED), 'and no seed');
});

test('the end: every claim and its fate, the result with labels, each seat net of what it put in, and the deck opened with the moves and the hands', () => {
  const s = dealtTable();
  recordsAfterChange(s, 3);
  Object.assign(s, { phase: 'settled', lastResult: settledResult() });
  recordsAfterChange(s, 3);
  recordsAfterChange(s, 3);
  assert.equal(s.rec.queue.length, 2, 'an opening and a closing, once each');
  const { patch } = s.rec.queue[1];
  assert.deepEqual(patch.claims.map((c) => [c.name, c.label, c.status]), [['Probe', labelClaim(KINGS), 'proven'], ['Old Wick', labelClaim(TENS), 'standing'], ['Brannock', 'flush', 'caught']]);
  assert.deepEqual(patch.result, { kind: 'settled', pot: 30, carried: 0, awards: [{ seat: 2, name: 'Old Wick', amount: 20, label: labelClaim(TENS) }, { seat: 0, name: 'Probe', amount: 10, label: labelClaim(KINGS) }] });
  assert.deepEqual(patch.chips.map((c) => [c.name, c.delta]), [['Probe', 0], ['Brannock', -15], ['Old Wick', 15]], 'a seat that put nothing in and got nothing is not a line');
  assert.equal(patch.chips.reduce((n, c) => n + c.delta, 0), 0);
  assert.ok(noCards(s.rec.queue[0]), 'the opening still has no card');
  assert.equal(patch.opened.seed, SEED);
  assert.deepEqual(patch.opened.deck, deckOrder(SEED), 'the deck order, opened');
  assert.deepEqual(patch.hands, [...HANDS, null], 'the hands as they stood; none for a seat not dealt in');
  assert.deepEqual(patch.moves.passes, [[{ from: 0, to: 1, card: '2s' }, { from: 1, to: 2, card: '3s' }, { from: 2, to: 0, card: '5s' }]], 'each pass as the cards that moved');
  assert.deepEqual(patch.moves.claims.map((c) => [c.seat, c.claim, c.status]), [[0, KINGS, 'proven'], [2, TENS, 'standing'], [1, [5, 0, 0], 'caught']], 'the claims themselves, with the table\'s verdicts');
});

test('a round that never finished closes as void, with the table\'s reason', () => {
  const s = dealtTable();
  recordsAfterChange(s, 3);
  Object.assign(s, { phase: 'over', overReason: 'everyone has left' });
  recordsAfterChange(s, 3);
  assert.deepEqual(s.rec.queue[1].patch.result, { kind: 'void', why: 'everyone has left' });
});

test('a later round is a new record, and the round before keeps its own', () => {
  const s = dealtTable();
  recordsAfterChange(s, 3);
  Object.assign(s, { phase: 'settled', lastResult: settledResult() });
  recordsAfterChange(s, 3);
  Object.assign(s, { round: 2, phase: 'pass', lastResult: settledResult() }); // round 1's result is still lastResult when round 2 is dealt
  recordsAfterChange(s, 3);
  assert.deepEqual(s.rec.queue.map((q) => [q.round, Object.keys(q.patch).includes('seats') ? 'deal' : 'end']), [[1, 'deal'], [1, 'end'], [2, 'deal']]);
});

test('a tNIGHT round goes by its cage table and chain round, and its settle transaction goes up once when it lands', () => {
  const cage = { table: 114, chainBase: 46, address: 'd'.repeat(64), entries: [], holders: { ['a'.repeat(64)]: { name: 'Probe', kind: 'human' }, ['e'.repeat(64)]: { name: 'House', kind: 'house' } } };
  const s = dealtTable({ cage });
  recordsAfterChange(s, null);
  assert.deepEqual(recordNumber(s, null, 1), { table: 114, round: 47 });
  assert.deepEqual([s.rec.queue[0].kind, s.rec.queue[0].table, s.rec.queue[0].round], ['tnight', 114, 47]);
  assert.deepEqual(s.rec.queue[0].patch.cage, { address: 'd'.repeat(64), network: 'preprod' });
  cage.entries.push({ rounds: [1], lines: [{ id: 'a'.repeat(64), delta: 5 }, { id: 'e'.repeat(64), delta: -5 }] });
  Object.assign(s, { phase: 'settled', lastResult: settledResult() });
  recordsAfterChange(s, null);
  assert.deepEqual(s.rec.queue[1].patch.chips.map((c) => [c.name, c.kind, c.delta]), [['Probe', 'human', 5], ['House', 'house', -5]], 'the chips are the judge\'s entry');
  recordsAfterChange(s, null);
  assert.equal(s.rec.queue.length, 2, 'nothing for the chain until the transaction lands');
  cage.entries[0].tx = { hash: 'ab'.repeat(32), id: 'cd'.repeat(32), block: 3300000, status: 'SUCCESS', chainRound: 47, blockAt: 1 };
  recordsAfterChange(s, null);
  recordsAfterChange(s, null);
  assert.equal(s.rec.queue.length, 3);
  assert.deepEqual(s.rec.queue[2], { kind: 'tnight', table: 114, round: 47, patch: { settle: { hash: 'ab'.repeat(32), id: 'cd'.repeat(32), block: 3300000, status: 'SUCCESS', chainRound: 47, blockAt: 1, rounds: [47] } } });
});
