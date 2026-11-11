// The cage's roundCap for Cup & Claim, recomputed from the engine: plays the costliest round one seat can have,
// through the real rules, and reports what it lost. `node scripts/dice-round-cap.js`. The bound is roundCap in engine.js.

import { fileURLToPath } from 'node:url';
import { DEFAULTS, act, createTable, join, legalActions, roundCap } from '../src/games/cup-and-claim/engine.js';
import { nextBidAbove } from '../src/games/cup-and-claim/dice.js';

const STACK = 100_000;
const ctx = { now: 1000, rng: () => 0.5, auto: true };

/**
 * n seats, the last of them the victim. Seat 0 opens with the biggest raise that fits; every seat between folds at
 * once; the victim and seat 0 then trade bids, each raising the most the pot limit allows, until no raise fits for
 * either. The victim makes the last bid, on a face no die shows, and seat 0 calls Liar. The victim has matched every
 * raise and loses the pot, which is as full as the limit lets it be.
 */
export function worstRound(seats, cfg = DEFAULTS) {
  const s = createTable({ ...cfg, seats, lobbyMs: 60_000 });
  for (let i = 0; i < seats; i++) join(s, `Seat ${i}`, ctx, { chips: STACK });
  const victim = seats - 1;
  for (let i = 0; i < seats; i++) s.dice[i] = [3, 3, 3, 3, 3]; // no 6s and no wilds anywhere
  const maxRaise = (seat) => legalActions(s, seat).find((a) => a.action === 'bid')?.raise.max ?? 0;
  let last = null;
  const bid = (seat, raise, face = null) => {
    last = face ? { count: last.face === 6 ? last.count + 1 : last.count, face } : nextBidAbove(last);
    act(s, seat, { action: 'bid', ...last, ...(raise ? { raise } : {}) }, ctx);
  };

  bid(0, maxRaise(0));
  for (let seat = 1; seat < victim; seat++) act(s, seat, { action: 'fold' }, ctx);
  for (let guard = 0; guard < 300; guard++) {
    const v = maxRaise(victim);
    if (v === 0 && maxRaise(0) === 0) break;
    bid(victim, v);
    bid(0, maxRaise(0));
  }
  bid(victim, 0, 6); // matches whatever is owed; names a face nobody has
  act(s, 0, { action: 'liar' }, ctx);
  for (const seat of [0, victim]) act(s, seat, { action: 'reveal', mode: 'prove' }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  if (s.lastResult.awards[0].seat !== 0) throw new Error('seat 0 should have won the call');
  return { lost: STACK - s.seats[victim].chips, pot: s.lastResult.pot, table: s };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`ante ${DEFAULTS.ante}, raiseLimit ${DEFAULTS.raiseLimit}, potLimit ${DEFAULTS.potLimit}`);
  console.log('seats  pot at the call  loser paid in  roundCap (bound)');
  for (let seats = 2; seats <= 6; seats++) {
    const { lost, pot } = worstRound(seats);
    console.log(`${String(seats).padEnd(6)} ${String(pot).padEnd(16)} ${String(lost).padEnd(14)} ${roundCap(DEFAULTS, seats)}`);
  }
}
