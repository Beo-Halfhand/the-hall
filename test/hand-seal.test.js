// Sealed Hand's deck seal: the shuffle from the seed, the seal over the deck, and the record a round leaves, checked the way the page
// checks it (public/js/round-check.js, run here with the same WebCrypto). Then the tamper tests: a card changed after the seal, a
// different seed, a pass reordered, each must make the checks show ✗.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CAT, LADDER, bestClaim, contains, newDeck, truthfulAbove } from '../src/games/sealed-hand/cards.js';
import { DOMAIN, deckOrder, deckSeal, verifyDeck } from '../src/games/sealed-hand/fair.js';
import { act, createTable as createTableAtDefaults, currentTurn, join, publicView, sealDeal } from '../src/games/sealed-hand/engine.js';
import { recordsAfterChange } from '../src/games/sealed-hand/records.js';
import { deckOrderOf, deckSealOf, handContains, rebuildHands, runHandChecks } from '../public/js/round-check.js';
import { sha256, toHex, utf8 } from '../src/platform/seal.js';
import { makeRng } from './helpers.js';

const SEED = 'ab'.repeat(32);
const createTable = (cfg = {}) => createTableAtDefaults({ ante: 1, potLimit: Infinity, lobbyMs: 60_000, ...cfg });
const c = { now: 1000, rng: makeRng(7) };

test('the shared piece hashes like SHA-256', () => {
  assert.equal(toHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(toHex(sha256(new Uint8Array(0))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('the deck order is a whole deck, the same for the same seed, different for another, and the page shuffles it the same way', async () => {
  const deck = deckOrder(SEED);
  assert.equal(deck.length, 52);
  assert.deepEqual([...deck].sort(), newDeck().sort());
  assert.deepEqual(deckOrder(SEED), deck);
  assert.notDeepEqual(deckOrder('cd'.repeat(32)), deck);
  for (const seed of [SEED, 'cd'.repeat(32), '00'.repeat(32)]) assert.deepEqual(await deckOrderOf(seed), deckOrder(seed), 'the browser and the Worker agree on the shuffle');
});

test('the seal is over the table, the round, the seed and the whole order; the page recomputes it; anything changed breaks it', async () => {
  const deck = deckOrder(SEED);
  const seal = deckSeal({ table: 3, round: 41, seed: SEED, deck });
  assert.match(seal, /^[0-9a-f]{64}$/);
  assert.equal(await deckSealOf({ table: 3, round: 41, seed: SEED, deck }), seal);
  assert.ok(verifyDeck({ table: 3, round: 41, seed: SEED, deck, seal }));
  assert.notEqual(deckSeal({ table: 4, round: 41, seed: SEED, deck }), seal, 'another table');
  assert.notEqual(deckSeal({ table: 3, round: 42, seed: SEED, deck }), seal, 'another round');
  const swapped = [...deck];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.notEqual(deckSeal({ table: 3, round: 41, seed: SEED, deck: swapped }), seal, 'two cards swapped');
  assert.ok(!verifyDeck({ table: 3, round: 41, seed: SEED, deck: swapped, seal }));
  assert.ok(!verifyDeck({ table: 3, round: 41, seed: 'cd'.repeat(32), deck, seal }), 'another seed');
  assert.ok(!verifyDeck({ table: 3, round: 41, seed: SEED, deck: deck.slice(0, 51), seal }), 'a short deck');
  assert.equal(DOMAIN.seal, 'sealed-hand/seal/v1');
});

test('the page judges a claim against a hand exactly as the engine does', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 300; i++) {
    const deck = deckOrder(toHex(Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256))));
    const hand = deck.slice(0, 5);
    for (const claim of [LADDER[Math.floor(rng() * LADDER.length)], bestClaim(hand) ?? [CAT.PAIR, 2, 0], [CAT.FLUSH, 0, 0], [CAT.STRAIGHT_FLUSH, 0, 0], [CAT.TWO_PAIR, 14, 0]]) assert.equal(handContains(hand, claim), contains(hand, claim), `${hand.join(' ')} vs ${claim}`);
  }
});

/** A whole round through the engine, recorded as the table would record it: the opening at the deal, the closing at the end. */
function playRecordedRound() {
  const s = createTable();
  for (const name of ['Ann', 'Bo', 'Cy', 'Di']) join(s, name, c);
  assert.equal(s.phase, 'pass');
  assert.ok(s.deal && s.deal.seed && s.deal.deck.length === 52 && s.deal.seal === null, 'the deal is sealed in the state, not yet under a number');
  const before = JSON.stringify(publicView(s));
  assert.ok(!/"seed"|"deck"/.test(before.replace(/"deal":\{"seal":null,"opened":null\}/, '')), 'nothing of the seed or the deck is public while the round is in play');
  recordsAfterChange(s, 3);
  const [opening] = s.rec.queue;
  assert.equal(opening.patch.seal.hash, deckSeal({ table: 3, round: 1, seed: s.deal.seed, deck: s.deal.deck }));
  assert.equal(opening.patch.seal.domain, 'sealed-hand/seal/v1');
  assert.equal(publicView(s).deal.seal, opening.patch.seal.hash, 'the page sees the seal');
  assert.equal(publicView(s).deal.opened, null);
  assert.ok(s.log.some((l) => l.act?.kind === 'seal' && l.text.startsWith('Deck sealed before the deal')), 'the round log says so');
  for (const card of s.hands.flat()) assert.ok(!JSON.stringify(opening).includes(`"${card}"`), 'no card at the deal');
  // Two passes of the first card, then the lap: Ann claims the lowest truthful rung, Bo calls it (proven); Cy claims a straight flush
  // (a bluff, with these cards), Di calls it (caught). Then the round settles.
  s.starter = 0;
  while (s.phase === 'pass') for (const seat of [0, 1, 2, 3]) act(s, seat, { action: 'pass', card: s.hands[seat][0] }, c);
  assert.equal(s.phase, 'claim');
  assert.equal(currentTurn(s), 0);
  const truthful = truthfulAbove(s.hands[0], null)[0] ?? null;
  if (truthful) act(s, 0, { action: 'claim', claim: truthful }, c); else act(s, 0, { action: 'check' }, c);
  if (truthful) act(s, 1, { action: 'call', seat: 0 }, c); else act(s, 1, { action: 'check' }, c);
  const bluff = [CAT.STRAIGHT_FLUSH, 0, 0];
  assert.ok(!contains(s.hands[2], bluff), 'Cy has no straight flush');
  act(s, 2, { action: 'claim', claim: bluff }, c);
  act(s, 3, { action: 'call', seat: 2 }, c);
  assert.equal(s.phase, 'settled');
  recordsAfterChange(s, 3);
  assert.equal(s.rec.queue.length, 2);
  const closing = s.rec.queue[1].patch;
  const r = { game: 'sealed-hand', kind: 'play', table: 3, round: 1, number: '3-1', ...opening.patch, ...closing, status: 'opened' };
  return { s, r, truthful };
}

test('a recorded round: the seal, the opened deck, every pass, every hand and every verdict all check out in the browser', async () => {
  const { s, r, truthful } = playRecordedRound();
  assert.equal(r.opened.seed, s.deal.seed);
  assert.deepEqual(r.opened.deck, s.deal.deck);
  assert.equal(r.moves.passes.length, s.cfg.maxPasses, 'one list of moves per pass: nobody stopped, so every pass went round');
  assert.ok(r.moves.passes.every((list) => list.length === 4 && list.every((m) => /^[2-9TJQKA][cdhs]$/.test(m.card))));
  assert.deepEqual(r.moves.claims.map((x) => x.status), truthful ? ['proven', 'caught'] : ['caught']);
  assert.deepEqual(r.moves.calls.map((x) => [x.seat, x.target, x.result]), truthful ? [[1, 0, 'proven'], [3, 2, 'caught']] : [[3, 2, 'caught']]);
  assert.deepEqual(r.hands, s.hands.map((h) => [...h]), 'the hands as they stood');
  const { hands, bad } = rebuildHands(r);
  assert.equal(bad, null);
  assert.deepEqual(hands.map((h) => [...h].sort()), s.hands.map((h) => [...h].sort()), 'rebuilt from the deck and the passes alone');
  const out = await runHandChecks(r);
  const fails = out.filter((x) => x.kind === 'fail');
  assert.deepEqual(fails, [], JSON.stringify(out, null, 1));
  const passes = out.filter((x) => x.kind === 'pass').map((x) => x.text);
  for (const want of [/seal recomputes/, /whole deck/, /seed’s shuffle/, /Every pass could happen/, /hands rebuilt/, /straight flush, called: a bluff/, /chips moved add up/]) assert.ok(passes.some((t) => want.test(t)), `a pass for ${want}`);
  if (truthful) assert.ok(passes.some((t) => /called, and the cards held it/.test(t)));
  assert.equal(publicView(s).deal.opened.deck.length, 52, 'the page sees the opened deck once the round is over');
});

test('tamper: one card changed after the seal makes the seal and the shuffle fail', async () => {
  const { r } = playRecordedRound();
  const deck = [...r.opened.deck];
  [deck[0], deck[5]] = [deck[5], deck[0]]; // Ann's first card for Bo's: the seal was over the original order
  const out = await runHandChecks({ ...r, opened: { ...r.opened, deck } });
  const by = (re) => out.find((x) => re.test(x.text));
  assert.equal(by(/seal/).kind, 'fail');
  assert.equal(by(/shuffle/).kind, 'fail');
  assert.ok(out.some((x) => x.kind === 'fail' && /hand|pass/i.test(x.text)), 'and the hands no longer follow');
});

test('tamper: another seed makes the seal and the shuffle fail', async () => {
  const { r } = playRecordedRound();
  const out = await runHandChecks({ ...r, opened: { ...r.opened, seed: 'cd'.repeat(32) } });
  assert.equal(out.find((x) => /seal/.test(x.text)).kind, 'fail');
  assert.equal(out.find((x) => /shuffle/.test(x.text)).kind, 'fail');
});

test('tamper: a reordered pass makes the hands, or a verdict, fail', async () => {
  const { r } = playRecordedRound();
  const passes = r.moves.passes.map((list) => list.map((m) => ({ ...m })));
  const [a, b] = passes[0];
  [a.card, b.card] = [b.card, a.card]; // Ann sent Bo's card and Bo sent Ann's: not what happened
  const out = await runHandChecks({ ...r, moves: { ...r.moves, passes } });
  assert.equal(out.find((x) => /seal/.test(x.text)).kind, 'pass', 'the seal is untouched');
  assert.ok(out.some((x) => x.kind === 'fail' && /not in that hand|rebuilt|verdict is wrong/.test(x.text)), JSON.stringify(out, null, 1));
});

test('tamper: a verdict changed on the record fails against the cards', async () => {
  const { r } = playRecordedRound();
  const claims = r.moves.claims.map((x) => ({ ...x, status: x.status === 'caught' ? 'proven' : 'caught' }));
  const out = await runHandChecks({ ...r, moves: { ...r.moves, claims } });
  assert.ok(out.some((x) => x.kind === 'fail' && /verdict is wrong/.test(x.text)));
});

test('a round still in play, and a round from before the seal, are said so and never failed', async () => {
  const { r } = playRecordedRound();
  const inPlay = await runHandChecks({ ...r, opened: undefined, hands: undefined, moves: undefined, status: 'posted' });
  assert.ok(inPlay.every((x) => x.kind !== 'fail'));
  assert.match(inPlay[0].text, /sealed .* in play/);
  const old = await runHandChecks({ ...r, seal: undefined, opened: undefined, hands: undefined, moves: undefined, status: 'over' });
  assert.match(old[0].text, /before the deck was sealed/);
  assert.ok(old.every((x) => x.kind !== 'fail'));
});

test('sealDeal seals once: a second number does not change the seal', () => {
  const s = createTable();
  for (const name of ['Ann', 'Bo', 'Cy', 'Di']) join(s, name, c);
  const first = sealDeal(s, { table: 3, round: 1 });
  assert.equal(sealDeal(s, { table: 9, round: 9 }), first);
  assert.equal(s.log.filter((l) => l.act?.kind === 'seal').length, 1);
});
