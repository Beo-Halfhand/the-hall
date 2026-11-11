import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUSE_NAME, act, createTable, join, publicView } from '../src/games/cup-and-claim/engine.js';
import { PERSONAS, atLeast, belief, decide, runBots, paceBots } from '../src/games/cup-and-claim/bots.js';
import { makeRng } from './helpers.js';

test('atLeast: binomial tail with p = 1/3, checked against a direct count', () => {
  assert.equal(atLeast(0, 5), 1);
  assert.equal(atLeast(6, 5), 0);
  const direct = 1 - ((2 / 3) ** 3 + 3 * (1 / 3) * (2 / 3) ** 2); // P(X >= 2), n = 3
  assert.ok(Math.abs(atLeast(2, 3) - direct) < 1e-12);
  assert.ok(atLeast(5, 15) > atLeast(6, 15));
  assert.ok(Math.abs(atLeast(5, 15) - 0.5959) < 0.001);
});

test('belief: what the bot holds counts, 1s wild, and a known bluffer is believed less', () => {
  const mine = [5, 5, 1, 2, 3]; // three fives with the wild
  assert.equal(belief({ count: 3, face: 5 }, mine, 20), 0.99, 'held outright');
  const b = belief({ count: 8, face: 5 }, mine, 20, 0.3);
  assert.ok(b > 0.3 && b < 0.7, `needs 5 of 15: ${b}`);
  assert.ok(belief({ count: 8, face: 5 }, mine, 20, 0.9) < b, 'bluffer');
  assert.ok(belief({ count: 8, face: 5 }, mine, 20, 0.0) > b, 'proven honest');
  assert.ok(belief({ count: 20, face: 6 }, mine, 20) < 0.02);
});

/** Plays `rounds` rounds with a stand-in human at seat 0 that decides like the house. Returns the table. */
function playRounds(seats, rounds, seed) {
  const ctx = { now: 1000, rng: makeRng(seed) };
  const s = createTable({ lobbyMs: 0, seats, botDelayMs: [0, 0] });
  join(s, 'Stand-in', ctx);
  let played = 0;
  for (let guard = 0; guard < 20_000 && s.phase !== 'over' && played < rounds; guard++) {
    runBots(s, ctx);
    if (s.phase === 'settled') {
      played += 1;
      ctx.now += 1000;
      for (const x of s.seats) if (x.chips < 30) x.chips = 100; // refills, so the table runs on
      act(s, 0, { action: 'next' }, ctx);
      continue;
    }
    const mine = (s.phase === 'bid' && s.turn === 0) || (s.phase === 'duel' && s.duel.waiting.includes(0));
    if (mine) {
      const move = decide(publicView(s), 0, s.dice[0], ctx.rng, { persona: PERSONAS[HOUSE_NAME] });
      act(s, 0, move, ctx); // throws a RuleError if the stand-in ever picks an illegal move
    }
  }
  assert.equal(played, rounds, `played ${played} of ${rounds} rounds (phase ${s.phase})`);
  return s;
}

test('decide: every move a bot makes is legal, over many rounds of four-seat and six-seat tables', () => {
  for (const seats of [2, 4, 6]) {
    const s = playRounds(seats, 60, seats);
    assert.ok(!s.log.some((l) => l.botError), `${seats} seats: ${s.log.filter((l) => l.botError).map((l) => l.text).join('; ')}`);
    assert.ok(s.log.some((l) => /calls LIAR/.test(l.text)), 'someone called Liar');
    assert.ok(s.log.some((l) => /raises \d+\./.test(l.text)), 'someone raised');
    assert.ok(s.log.some((l) => /lifts the cup/.test(l.text)), 'someone showed');
    assert.ok(s.log.some((l) => /keeps the cup shut/.test(l.text)), 'someone proved');
  }
});

test('decide: the house bot calls an impossible bid and believes one it holds', () => {
  const s = createTable({ lobbyMs: 60_000, seats: 2 });
  join(s, 'Ann', { now: 1000, rng: makeRng(1) });
  join(s, 'Bo', { now: 1000, rng: makeRng(1) });
  s.dice = [[2, 2, 2, 2, 2], [6, 6, 6, 6, 6]];
  act(s, 0, { action: 'bid', count: 10, face: 6 }, { now: 1000, rng: makeRng(1) });
  const move = decide(publicView(s), 1, s.dice[1], makeRng(2), { persona: PERSONAS[HOUSE_NAME] });
  assert.equal(move.action, 'liar', 'ten sixes on ten dice with five known 6s: needs all five unseen');
  const t = createTable({ lobbyMs: 60_000, seats: 2 });
  join(t, 'Ann', { now: 1000, rng: makeRng(1) });
  join(t, 'Bo', { now: 1000, rng: makeRng(1) });
  t.dice = [[2, 2, 2, 2, 2], [6, 6, 6, 1, 1]];
  act(t, 0, { action: 'bid', count: 4, face: 6 }, { now: 1000, rng: makeRng(1) });
  const again = decide(publicView(t), 1, t.dice[1], makeRng(2), { persona: PERSONAS[HOUSE_NAME] });
  assert.equal(again.action, 'bid', 'holds five sixes with wilds: the bid is certainly true, so it bids on');
});

test('paceBots: bots wait their turn on the clock; no bot is due while it is the human’s turn', () => {
  const ctx = { now: 1000, rng: makeRng(5) };
  const s = createTable({ lobbyMs: 0, botDelayMs: [1000, 2000] });
  join(s, 'Ann', ctx);
  assert.equal(s.turn, 0, 'Ann opens');
  paceBots(s, ctx);
  assert.equal(Object.keys(s.botDue).length, 0);
  act(s, 0, { action: 'bid', count: 1, face: 2 }, ctx);
  paceBots(s, ctx);
  assert.deepEqual(Object.keys(s.botDue), ['1']);
  assert.ok(s.botDue[1].at >= 2000 && s.botDue[1].at <= 3000);
  assert.equal(s.turn, 1, 'not moved yet');
  paceBots(s, { ...ctx, now: s.botDue[1].at });
  assert.notEqual(s.turn, 1, 'moved when its time came');
  assert.ok(publicView(s).clocks.every((k) => k.until !== undefined), 'the wait is public');
});
