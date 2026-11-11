// The cage's roundCap, recomputed from the engine: plays the worst round one seat can have, through the real rules,
// and reports what it lost. `node scripts/round-cap.js`. The formula is roundCap in engine.js.

import { fileURLToPath } from 'node:url';
import { DEFAULTS, act, createTable, join, legalActions, roundCap } from '../src/games/sealed-hand/engine.js';

const STACK = 100_000; // far more than any round can cost, so nothing gets clamped. A seat's loss includes its ante.
const ctx = { now: 1000, rng: () => 0.5, auto: true };

// The rule-driven numbers come first, with no pot limit in the way. The last column plays the same round at the real stakes.
export const UNCAPPED = { ...DEFAULTS, potLimit: Infinity };

/** A whole pass window: every seat passes and raises the limit on top of what it owes, and whoever passed earlier matches. */
function raiseWindow(s, seats, cfg) {
  for (let seat = 0; seat < seats; seat++) act(s, seat, { action: 'pass', card: s.hands[seat][0], raise: cfg.raiseLimit }, ctx);
  while (s.raise) act(s, s.raise.waiting[0], { action: 'match' }, ctx);
}

/** Every pass window but the last raised through in full, with the last still to come. Stacks too deep to clamp. */
function toTheLastWindow(seats, cfg) {
  const s = createTable({ ...cfg, seats, lobbyMs: 60_000 });
  for (let i = 0; i < seats; i++) join(s, `Seat ${i}`, ctx, { chips: STACK });
  for (let pass = 0; pass < cfg.maxPasses - 1; pass++) raiseWindow(s, seats, cfg);
  return s;
}

/** Nobody stops: all the pass windows go round. Ends in the claim lap, on the starter. */
function toTheLap(seats, cfg) {
  const s = toTheLastWindow(seats, cfg);
  raiseWindow(s, seats, cfg);
  if (s.phase !== 'claim') throw new Error(`expected the claim lap, got ${s.phase}`);
  s.hands[0] = ['Ah', 'Ad', '2c', '3c', '4c'];
  return s;
}

/**
 * n seats, the last of them the victim. In the lap, seat 0 makes a true claim and raises the limit, and the victim
 * calls it, pays the sting, and matches. Seat 0 takes the pot.
 */
export function worstRound(seats, cfg = UNCAPPED) {
  const s = toTheLap(seats, cfg);
  const victim = seats - 1;
  const start = STACK;
  act(s, 0, { action: 'claim', claim: [1, 14, 0], raise: cfg.raiseLimit }, ctx);
  for (let seat = 1; seat < victim; seat++) act(s, seat, { action: 'fold' }, ctx);
  if (!legalActions(s, victim).some((a) => a.action === 'call' && a.match)) throw new Error('the victim should be able to call and match');
  act(s, victim, { action: 'call', seat: 0, match: true }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  return { lost: start - s.seats[victim].chips, table: s };
}

/**
 * The same again by way of a stop. Nobody can stop in a window with a raise out, so that last window has no raise: seat 0
 * stops the passing with a true claim and raises the limit in the same move. The victim, in the lap, calls it, pays the sting and matches.
 */
export function worstStop(seats, cfg = UNCAPPED) {
  const s = toTheLastWindow(seats, cfg);
  const victim = seats - 1;
  s.hands[0] = ['Ah', 'Ad', '2c', '3c', '4c'];
  act(s, 0, { action: 'stop', claim: [1, 14, 0], raise: cfg.raiseLimit }, ctx);
  for (let seat = 1; seat < victim; seat++) act(s, seat, { action: 'fold' }, ctx);
  act(s, victim, { action: 'call', seat: 0, match: true }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  return { lost: STACK - s.seats[victim].chips, table: s };
}

/** The stopper as the victim: its claim is a bluff, someone catches it, and it has raised the limit and paid the sting. */
export function caughtStopper(seats, cfg = UNCAPPED) {
  const s = toTheLastWindow(seats, cfg);
  const victim = 0;
  s.hands[victim] = ['2h', '3d', '7c', '9s', 'Jd'];
  s.hands[1] = ['Ah', 'Ad', '2c', '3c', '4c'];
  act(s, victim, { action: 'stop', claim: [7, 14, 0], raise: cfg.raiseLimit }, ctx);
  act(s, 1, { action: 'call', seat: victim, match: true }, ctx);
  for (let seat = 2; seat < seats; seat++) act(s, seat, { action: 'fold' }, ctx);
  return { lost: STACK - s.seats[victim].chips, table: s };
}

/**
 * The two-sting round, by calling twice. The victim calls a true claim in its lap turn. A later seat makes another true
 * claim and raises the limit, so the victim gets an after-lap turn, calls that one too, and matches. Needs 3 seats.
 */
export function twoCalls(seats, cfg = UNCAPPED) {
  const s = toTheLap(seats, cfg);
  const victim = 1;
  s.hands[0] = ['Ah', 'Ad', '2c', '3c', '4c'];
  s.hands[2] = ['Kh', 'Kd', 'Ks', '3d', '4d'];
  act(s, 0, { action: 'claim', claim: [1, 14, 0] }, ctx);
  act(s, victim, { action: 'call', seat: 0 }, ctx);
  act(s, 2, { action: 'claim', claim: [3, 13, 0], raise: cfg.raiseLimit }, ctx);
  for (let seat = 3; seat < seats; seat++) act(s, seat, { action: 'fold' }, ctx);
  if (s.phase !== 'answer') throw new Error(`expected a match-or-fold turn, got ${s.phase}`);
  act(s, 0, { action: 'match' }, ctx);
  if (!legalActions(s, victim).some((a) => a.action === 'call' && a.match)) throw new Error('the victim should be able to call and match');
  act(s, victim, { action: 'call', seat: 2, match: true }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  return { lost: STACK - s.seats[victim].chips, table: s };
}

/**
 * The two-sting round, by calling and being caught. The victim bluffs in its lap turn, calls a true claim in its after-lap
 * turn and matches, and is then caught by the seat it called. Needs 3 seats.
 */
export function calledThenCaught(seats, cfg = UNCAPPED) {
  const s = toTheLap(seats, cfg);
  const victim = 0;
  s.hands[victim] = ['2h', '3d', '7c', '9s', 'Jd'];
  s.hands[1] = ['Kh', 'Kd', 'Ks', '3c', '4c'];
  act(s, victim, { action: 'claim', claim: [1, 14, 0] }, ctx);
  act(s, 1, { action: 'claim', claim: [3, 13, 0] }, ctx);
  act(s, 2, { action: 'check', raise: cfg.raiseLimit }, ctx);
  for (let seat = 3; seat < seats; seat++) act(s, seat, { action: 'fold' }, ctx);
  if (s.phase !== 'answer') throw new Error(`expected a match-or-fold turn, got ${s.phase}`);
  act(s, victim, { action: 'call', seat: 1, match: true }, ctx);
  act(s, 1, { action: 'call', seat: victim, match: true }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  return { lost: STACK - s.seats[victim].chips, table: s };
}

/**
 * The most raises a seat can be pulled through: every seat raises in turn, climbing to the limit, and the victim
 * raises early, then tops up after the lap. It pays each difference, so it ends level with worstRound: the number of
 * raises doesn't add to the cap, only the level does. Needs 3 seats, so that someone raises after the victim.
 */
export function raiseLadder(seats, cfg = UNCAPPED) {
  const s = toTheLap(seats, cfg);
  const victim = 1;
  const steps = seats - 1;
  const levelOf = (seat) => cfg.raiseLimit - (seats - 1 - seat);
  act(s, 0, { action: 'claim', claim: [1, 14, 0], raise: levelOf(0) }, ctx);
  act(s, victim, { action: 'call', seat: 0, raise: levelOf(1) }, ctx);
  for (let seat = 2; seat <= steps; seat++) act(s, seat, { action: 'check', raise: levelOf(seat) }, ctx);
  if (s.phase !== 'answer') throw new Error(`expected a match-or-fold turn, got ${s.phase}`);
  while (s.phase === 'answer') act(s, s.lap.queue[0], { action: 'match' }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  return { lost: STACK - s.seats[victim].chips, table: s };
}

/**
 * The same seats at the real stakes: everyone raises what the pot will take and stays in, then the victim calls a true
 * claim and pays the sting. The pot limit is what stops it. Below it, this is the most the victim pays.
 */
export function worstAtTheLimit(seats, cfg = DEFAULTS) {
  const s = createTable({ ...cfg, seats, lobbyMs: 60_000 });
  for (let i = 0; i < seats; i++) join(s, `Seat ${i}`, ctx, { chips: STACK });
  for (let pass = 0; pass < cfg.maxPasses; pass++) {
    for (let seat = 0; seat < seats; seat++) {
      const move = legalActions(s, seat).find((a) => a.action === 'pass');
      act(s, seat, { action: 'pass', card: s.hands[seat][0], ...(move.raise ? { raise: move.raise.max } : move.match ? { match: true } : {}) }, ctx);
    }
    while (s.raise) act(s, s.raise.waiting[0], { action: 'match' }, ctx);
  }
  const victim = seats - 1;
  s.hands[0] = ['Ah', 'Ad', '2c', '3c', '4c'];
  const first = legalActions(s, 0).find((a) => a.action === 'claim');
  act(s, 0, { action: 'claim', claim: [1, 14, 0], ...(first.raise ? { raise: first.raise.max } : {}) }, ctx);
  for (let seat = 1; seat < victim; seat++) act(s, seat, { action: legalActions(s, seat).some((m) => m.action === 'fold') ? 'fold' : 'check' }, ctx);
  act(s, victim, { action: 'call', seat: 0, ...(legalActions(s, victim).find((m) => m.action === 'call')?.match ? { match: true } : {}) }, ctx);
  if (s.phase !== 'settled') throw new Error(`expected settled, got ${s.phase}`);
  return { lost: STACK - s.seats[victim].chips, table: s };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ante, maxPasses, raiseLimit, callStake, potLimit } = DEFAULTS;
  console.log(`ante ${ante}, maxPasses ${maxPasses}, raiseLimit ${raiseLimit}, callStake ${callStake}, potLimit ${potLimit}`);
  console.log('seats  no pot limit  played  ladder  two calls  called+caught  stop  caught stopper | with pot limit: bound  played');
  for (let seats = 2; seats <= 6; seats++) {
    const three = (play) => (seats >= 3 ? play(seats).lost : 'n/a');
    const cells = [[seats, 6], [roundCap(UNCAPPED, seats), 14], [worstRound(seats).lost, 8], [three(raiseLadder), 8], [three(twoCalls), 11], [three(calledThenCaught), 15], [worstStop(seats).lost, 6], [caughtStopper(seats).lost, 15]];
    console.log(`${cells.map(([v, w]) => String(v).padEnd(w)).join('')}| ${String(roundCap(DEFAULTS, seats)).padEnd(23)}${worstAtTheLimit(seats).lost}`);
  }
}
