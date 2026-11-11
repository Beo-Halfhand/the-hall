// The rules. Pure state machine: no I/O. The clock and randomness come in through ctx = { now, rng }.
// State is plain JSON, so a Durable Object can store it as is. Handlers validate before they mutate,
// so a rejected move leaves the state untouched.
//
// publicView is a whitelist and the only thing that leaves for spectators. Hands reach only their owner,
// through privateView. Log lines never contain a card, and a claim's truth stays unknown until it is called.

import {
  isCard, normalizeClaim, compareClaims, contains, labelClaim,
  truthfulAbove, firstRungAbove, bestClaim, LADDER,
} from './cards.js';
import { deckOrder, deckSeal, newDeckSeed } from './fair.js';

export const DEFAULTS = {
  seats: 4,
  startChips: 100,
  ante: 5,
  minPasses: 2,
  maxPasses: 5,
  raiseLimit: 25,
  potLimit: 500, // per round: once the pot is here, no more raises, and a match pays only what fits
  callStake: 5,
  turnMs: 60_000,
  lobbyMs: 30_000,
  roundGapMs: 30_000, // the Next round button deals sooner
  botDelayMs: [1500, 3000], // how long a house bot thinks before each move
  idleMs: 30 * 60_000, // stops a table of dead agents from running forever
  waitingIdleMs: 24 * 60 * 60_000, // a table with no clock, waiting on someone, closes after this long untouched
  awayStandMs: 30 * 60_000, // at a table with other people, how long someone can be Away before they're stood up
  resitMs: 30 * 60_000, // how long someone who left can sit back down at this table with the stack they took
  logMax: 200,
};

export const HOUSE_NAME = 'Tally · house';
export const BOT_NAMES = [HOUSE_NAME, 'Brannock', 'Old Wick'];
const OLD_HOUSE_NAME = 'Halfhand (house)';
// Nobody sits down as the house, under its short name or the one saved tables still have. Plain Halfhand is a player's name.
const RESERVED_NAMES = new Set([...BOT_NAMES, 'Tally', OLD_HOUSE_NAME].map((name) => name.toLowerCase()));
export const isReservedName = (name) => RESERVED_NAMES.has(name.toLowerCase());
export const ACTIONS = ['pass', 'raise', 'match', 'fold', 'stop', 'claim', 'call', 'check', 'next', 'back'];

const ROUND_PHASES = ['pass', 'claim', 'answer'];

/** True while cards are out: from the deal until the round settles. */
export const inRound = (s) => ROUND_PHASES.includes(s.phase);

/**
 * The most one seat can lose in one round, for the cage. Every term is a rule in this file:
 * what it pays into the pot, which can't pass potLimit; and short of that, the ante; in each pass window, its own raise
 * plus matching every other seat's (raiseLimit × seats);
 * the stings; and in the claim lap at most raiseLimit, however many raises there are, because a raise is to a level and
 * matching pays only the difference up to it.
 * Two stings at most, from three seats up: a seat can lose one call in its lap turn and one in its after-lap turn, or lose
 * its after-lap call and then be caught, since a claim is called once. Then it has no turn left. With two seats there is
 * only ever one: the other seat has one claim at most to call, and whoever set the highest raise has no after-lap turn,
 * so the two can't both call after the lap.
 * scripts/round-cap.js plays those rounds through the engine, and test/engine.test.js holds the two to each other.
 */
export const roundCap = (cfg = DEFAULTS, seats = cfg.seats) => Math.min(cfg.ante + cfg.maxPasses * cfg.raiseLimit * seats + cfg.raiseLimit, cfg.potLimit ?? Infinity) + (seats >= 3 ? 2 : 1) * cfg.callStake;

export class RuleError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createTable(cfg = {}) {
  return {
    cfg: { ...DEFAULTS, ...cfg },
    phase: 'lobby', // lobby | pass | claim | answer | settled | over
    round: 0,
    starter: -1,
    pot: 0,
    seats: [], // { name, bot, chips, rep: { called, proven, caught } }
    status: [], // per seat: in | folded | out
    hands: [],
    passNo: 0,
    passes: [],
    raise: null, // after a pass window's cards are in, while seats that passed before a raise answer it: { by, amount, waiting: [seat] }
    passRaise: null, // this pass window's money: { high, by, paid: { seat: chips } }. Raises add to high; a match pays up to it.
    passRaised: [], // seats that have raised during this pass window: one each
    botDue: {}, // seat → { step, from, at }: when a paced bot will move. Public as a clock; independent of its hand.
    lap: null, // { leader, queue: [seat], high, by, paid: { seat: chips } }. high is the level raised to, by the seat that set it.
    claims: [], // { seat, claim, status: standing | proven | caught | withdrawn }
    lastResult: null,
    overReason: null,
    overCode: null,
    overRound: null,
    overAt: null,
    log: [],
    houseStaked: 0, // play chips the house has put in to buy its bots back in, all told. Stays 0 on a tNIGHT table.
    logN: 0,
    deadline: null,
    lastHumanAt: null,
    received: [], // per seat, this round: { from, card }. What a bot remembers. Never public.
    passLog: [], // per seat, this round: { n, sent, to, got, from }. Goes only to that seat's owner.
    chipLog: [], // recent chip movements, public: { n, kind, from, to, amount }. Seat numbers, or 'pot'.
    chipN: 0,
    carried: 0, // how much of the pot came over from a round with no winner
    potIn: [], // per seat: what each has paid into the pot as it stands, for handing it back if the table closes
    talkQueue: [], // bot lines the table may upgrade with AI. Never public.
    departures: [], // { seat, amount } for the table to pay out
  };
}

// ---------- helpers ----------

const seatIds = (s) => s.seats.map((_, i) => i);
const isActive = (s, seat) => s.status[seat] === 'in';
const activeSeats = (s) => seatIds(s).filter((i) => isActive(s, i));

function say(s, text, extra = {}) {
  s.logN += 1;
  s.log.push({ n: s.logN, round: s.round, text, ...extra });
  if (s.log.length > s.cfg.logMax) s.log.splice(0, s.log.length - s.cfg.logMax);
  return s.log.at(-1);
}

export const addLog = say;

/** Table talk, from a player or a bot. The caller has already cleaned the text. */
export const addTalk = (s, seat, text) => say(s, text, { say: true, seat, name: s.seats[seat].name });

const nameOf = (s, seat) => s.seats[seat].name;

/** Active seats clockwise, beginning at `from` (or the next active seat after it). */
function orderFrom(s, from) {
  const n = s.seats.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const seat = (from + i) % n;
    if (isActive(s, seat)) out.push(seat);
  }
  return out;
}

const nextActive = (s, seat) => orderFrom(s, seat + 1)[0];

/** Records a movement of chips, so a page can animate it. It says nothing that the log doesn't. */
function chipMove(s, kind, from, to, amount) {
  if (amount <= 0) return;
  s.chipLog ??= [];
  s.chipN = (s.chipN ?? 0) + 1;
  s.chipLog.push({ n: s.chipN, kind, from, to, amount });
  if (s.chipLog.length > 40) s.chipLog.shift();
}

/** Moves up to `amount` chips out of a seat. Chips never go negative. Returns what actually moved. */
function takeChips(s, seat, amount) {
  const paid = Math.min(s.seats[seat].chips, amount);
  s.seats[seat].chips -= paid;
  return paid;
}

/** How much more this round's pot can take. */
const potRoom = (s) => Math.max(0, (s.cfg.potLimit ?? Infinity) - s.pot);

/** A seat pays into the pot, never past the pot limit. Returns what actually moved. */
function payIn(s, seat, amount, kind) {
  const paid = takeChips(s, seat, Math.min(amount, potRoom(s)));
  if (s.roundMoney?.[seat]) s.roundMoney[seat].in += paid;
  s.pot += paid;
  s.potIn ??= [];
  s.potIn[seat] = (s.potIn[seat] ?? 0) + paid;
  chipMove(s, kind, seat, 'pot', paid);
  return paid;
}

/**
 * The table is closing with chips in the pot: each seat still here gets back its share, in proportion to what it
 * paid in. Whole chips, the odd ones going to the largest remainders, so none are lost. A bot's share goes back to
 * the bot, so nobody leaves with more than they put in. Anything from a seat that has left is shared out the same way.
 */
export function returnPot(s) {
  const { pot } = s;
  if (pot <= 0) return;
  const seats = seatIds(s).filter((i) => !s.seats[i].left);
  const paid = seats.map((i) => s.potIn?.[i] ?? 0);
  const total = paid.reduce((sum, x) => sum + x, 0);
  const exact = seats.map((_, k) => (total > 0 ? (pot * paid[k]) / total : pot / seats.length));
  const shares = exact.map(Math.floor);
  const byRemainder = seats.map((_, k) => k).sort((a, b) => exact[b] - shares[b] - (exact[a] - shares[a]) || a - b);
  for (let spare = pot - shares.reduce((sum, x) => sum + x, 0), k = 0; spare > 0; spare--, k++) shares[byRemainder[k % seats.length]] += 1;
  const awards = seats.map((seat, k) => ({ seat, amount: shares[k] })).filter((a) => a.amount > 0);
  for (const a of awards) {
    s.seats[a.seat].chips += a.amount;
    chipMove(s, 'refund', 'pot', a.seat, a.amount);
  }
  s.pot = 0;
  s.carried = 0;
  s.potIn = [];
  for (const a of awards) moneyMoved(s, null, a.seat, a.amount);
  s.lastResult = { round: s.round, kind: 'returned', pot, awards, carried: 0, ...roundStory(s) };
  say(s, `The pot of ${pot} goes back: ${awards.map((a) => `${nameOf(s, a.seat)} ${a.amount}`).join(', ')}.`);
}

const humanSeats = (s) => s.seats.filter((x) => !x.bot && !x.left);

/** One human or agent against the house. Nobody else is kept waiting, so the table has no clock: it waits. */
export const isSolo = (s) => humanSeats(s).length <= 1;

const touch = (s, ctx, ms = s.cfg.turnMs) => {
  s.clockFrom = ctx.now;
  s.deadline = isSolo(s) ? null : ctx.now + ms;
};

export const standingClaims = (s) => s.claims.filter((c) => c.status === 'standing' || c.status === 'proven');
export const uncalledClaims = (s) => s.claims.filter((c) => c.status === 'standing');

/** Top standing claim, proven or never called. Standing claims are strictly rising, so never tied. */
export function topClaim(s) {
  let top = null;
  for (const c of standingClaims(s)) if (!top || compareClaims(c.claim, top) > 0) top = c.claim;
  return top;
}

/** Seat that must act next, or null in the simultaneous pass phase (unless a raise is pending) and between rounds. */
export function currentTurn(s) {
  if (s.phase === 'pass') return s.raise ? s.raise.waiting[0] : null;
  if (s.phase === 'claim' || s.phase === 'answer') return s.lap.queue[0];
  return null;
}

export function waitingOn(s) {
  if (s.phase === 'pass' && !s.raise) return activeSeats(s).filter((i) => s.passes[i] === null);
  const turn = currentTurn(s);
  return turn === null || turn === undefined ? [] : [turn];
}

// ---------- lobby ----------

export function fillBots(s) {
  const taken = new Set(s.seats.map((x) => x.name));
  for (const name of BOT_NAMES) {
    if (s.seats.length >= s.cfg.seats) break;
    if (!taken.has(name)) addSeat(s, name, true);
  }
}

function addSeat(s, name, bot, { kind = 'agent', avatar = 'adventurer', chips = s.cfg.startChips } = {}) {
  s.seats.push({ name, bot, kind: bot ? 'house' : kind, avatar: bot ? null : avatar, chips, rep: { called: 0, proven: 0, caught: 0 } });
  say(s, `${name} sits down at seat ${s.seats.length - 1}.`);
  return s.seats.length - 1;
}

/** Seats a player. With lobbyMs 0, or a full table, the game starts at once. */
export function join(s, name, ctx, extra) {
  if (s.phase !== 'lobby') throw new RuleError('table_started', 'This table has already started.');
  if (s.seats.length >= s.cfg.seats) throw new RuleError('table_full', 'This table is full.');
  const lower = name.toLowerCase();
  if (RESERVED_NAMES.has(lower)) throw new RuleError('name_reserved', `"${name}" is reserved for a house bot.`);
  if (s.seats.some((x) => x.name.toLowerCase() === lower)) throw new RuleError('name_taken', `"${name}" is already at this table.`);
  const seat = addSeat(s, name, false, extra);
  s.lastHumanAt = ctx.now;
  if (s.seats.length >= s.cfg.seats || s.cfg.lobbyMs === 0) startGame(s, ctx);
  else s.deadline ??= ctx.now + s.cfg.lobbyMs;
  return seat;
}

function startGame(s, ctx) {
  fillBots(s);
  startRound(s, ctx);
}

/**
 * "Deal me in now, with bots" (11-06, round 2): a seated player at a chip table still in the lobby fills the empty seats with
 * bots and starts at once, instead of waiting out the lobby clock. The clock stays for anyone who'd rather wait for people.
 * A tNIGHT table is unchanged: its seats come from the cage and the judge.
 */
export function dealNow(s, seat, ctx) {
  if (s.cage) throw new RuleError('tnight_table', 'A tNIGHT table is seated by the judge: it deals when the cage is ready.');
  if (s.phase !== 'lobby') throw new RuleError('table_started', 'This table has already started.');
  if (!s.seats[seat] || s.seats[seat].left) throw new RuleError('not_seated', 'You are not seated here.');
  say(s, `${s.seats[seat].name} asks for the deal now: bots take the empty seats.`);
  startGame(s, ctx);
}

// ---------- round flow ----------

/**
 * Every way a table closes goes through here, with a code (for the Hall's record of closures) and a plain full sentence (what a player is told).
 * Codes: everyone_left, no_human_action, others_out_of_chips, cannot_ante. A tNIGHT table's chain closing is cageDead in platform/cage.js
 * (code cage_dead). A play-chip table closes only for everyone_left and no_human_action, or before its first deal.
 */
function endTable(s, code, text, ctx) {
  returnPot(s);
  s.phase = 'over';
  s.overCode = code;
  s.overReason = text;
  s.overRound = s.round;
  s.overAt = ctx?.now ?? Date.now();
  s.deadline = null;
  say(s, `Table over: ${text}`);
}

/** "30 minutes", "24 hours": how long a table was left untouched, from the setting that closed it. */
const quietFor = (ms) => (ms >= 2 * 3_600_000 ? `${Math.round(ms / 3_600_000)} hours` : `${Math.max(1, Math.round(ms / 60_000))} minutes`);
const NO_MOVES = (ms) => `No moves for ${quietFor(ms)}.`;

// What each house bot says when the house stakes it again. Scripted and kept as is: a fact about the chips, not table talk
// for the model to redo.
const REBUY_LINES = {
  [HOUSE_NAME]: 'House buys me back in.',
  Brannock: 'Ha! The house stakes me again. Pour another!',
  'Old Wick': 'Hm. The house puts more iron in my hand.',
};

/**
 * Play-chip tables: between rounds, a house bot that can't cover the ante is bought back in to its starting stack by the
 * house, so the player is never left with nobody to play. The history gets the house's line and the bot gets one of
 * its own. Only ever from here, at the deal: never mid-hand, and no player's chips move.
 * A tNIGHT table takes the other path, standBrokeBots: there the house float is on chain and nothing restakes a seat.
 */
function rebuyBots(s) {
  for (const seat of seatIds(s)) {
    const x = s.seats[seat];
    if (!x.bot || x.left || x.chips >= (s.cfg.botLow ?? s.cfg.ante)) continue;
    const before = x.chips;
    const amount = s.cfg.startChips - before;
    x.chips = s.cfg.startChips;
    x.rebuys = (x.rebuys ?? 0) + 1;
    s.houseStaked = (s.houseStaked ?? 0) + amount;
    if (amount < (s.cfg.botLogMin ?? 0)) continue; // a small top-up at a play-chip table: counted above, not worth a line every round
    say(s, `${x.name} is down to ${before} chips. The house buys ${x.name} back in with ${amount}.`, { rebuy: true, seat, amount });
    addTalk(s, seat, REBUY_LINES[x.name] ?? 'The house stakes me again.');
  }
}

/**
 * tNIGHT tables: a house bot that can't cover the ante stands up between rounds and its seat stays empty. The house's
 * float is one seat on chain, so a bot's stack can't be topped up from here; a house bankroll with a cap is for cage v4.
 */
function standBrokeBots(s) {
  for (const seat of seatIds(s)) {
    const x = s.seats[seat];
    if (!x.bot || x.left || x.chips >= s.cfg.ante) continue;
    say(s, `${x.name} is down to ${x.chips} chips and stands up: the house doesn't restake a tNIGHT seat.`, { broke: true, seat });
    depart(s, seat);
  }
}

export function startRound(s, ctx) {
  const { ante } = s.cfg;
  const canAnte = (i) => s.seats[i].chips >= ante;
  if (!seatIds(s).some((i) => !s.seats[i].bot && canAnte(i))) {
    if (s.cage || s.round === 0) return endTable(s, 'cannot_ante', 'Not enough players to ante.', ctx); // a table that never dealt has no result to keep up
    // A play-chip table stays open for a player who is out: the last result stays up, and they can fill up or leave. Nobody back for a
    // day (waitingIdleMs), or a lone seat untouched for awayStandMs, still closes it.
    const out = seatIds(s).filter((i) => !s.seats[i].bot && !s.seats[i].left).map((i) => nameOf(s, i));
    if (!s.outSaid) say(s, `${out.join(', ') || 'The player'} ${out.length > 1 ? 'are' : 'is'} out of chips: fill up to keep playing, or leave.`);
    s.outSaid = true;
    s.deadline = null;
    return;
  }
  s.outSaid = false;
  if (s.cage) standBrokeBots(s);
  else rebuyBots(s);
  const funded = seatIds(s).filter(canAnte);
  if (funded.length < 2) {
    if (s.cage || s.round === 0) return endTable(s, 'others_out_of_chips', 'The other players ran out of chips.', ctx);
    // Play chips: never a reason to close. Whoever is out can fill up; the round deals when two can ante.
    if (!s.waitSaid) say(s, 'Waiting for another player with chips: fill up to keep playing.');
    s.waitSaid = true;
    s.deadline = null;
    return;
  }
  s.waitSaid = false;
  if (ctx.now - s.lastHumanAt > s.cfg.idleMs) return endTable(s, 'no_human_action', NO_MOVES(s.cfg.idleMs), ctx);
  const eligible = funded.filter((i) => !s.seats[i].away);
  if (eligible.length < 2 || !eligible.some((i) => !s.seats[i].bot)) { // everyone who could play is away: wait for one
    s.deadline = null;
    return;
  }

  s.round += 1;
  s.roundMoney = seatIds(s).map(() => ({ in: 0, out: 0 }));
  s.status = seatIds(s).map((i) => (eligible.includes(i) ? 'in' : 'out'));
  s.starter = s.starter < 0 ? eligible[0] : orderFrom(s, s.starter + 1)[0];
  s.carried = s.pot;
  for (const i of eligible) payIn(s, i, ante, 'ante');

  // The deck is sealed: one secret per round, the shuffle from it by a fixed rule, and the seal (over the table, the round, the seed and
  // the whole order) goes up before any card moves (sealDeal, from the records once the round has its number). Opened when the round ends.
  const seed = newDeckSeed(ctx.rng);
  const deck = deckOrder(seed);
  s.deal = { seed, deck, seal: null };
  const draw = deck.slice();
  s.hands = seatIds(s).map(() => []);
  s.received = seatIds(s).map(() => []);
  s.passLog = seatIds(s).map(() => []);
  for (const i of eligible) s.hands[i] = draw.splice(0, 5);

  s.passNo = 0;
  s.raise = null;
  s.lap = null;
  s.claims = [];
  say(s, `Round ${s.round}. ${nameOf(s, s.starter)} starts. Pot ${s.pot} after antes.`, { act: { seat: null, kind: 'deal', starter: s.starter } });
  openPass(s, ctx);
}

function openPass(s, ctx) {
  s.phase = 'pass';
  s.passNo += 1;
  s.passes = seatIds(s).map(() => null);
  s.passRaised = [];
  s.raise = null;
  s.passRaise = { high: 0, by: null, paid: {} };
  touch(s, ctx);
}

/** What this seat still has to reach in this pass window, and what that costs with the pot limit. */
const windowOwed = (s, seat) => (s.passRaise ? s.passRaise.high - (s.passRaise.paid[seat] ?? 0) : 0);
const windowCost = (s, seat) => Math.min(windowOwed(s, seat), potRoom(s));

function payToWindow(s, seat, level, kind) {
  payIn(s, seat, level - (s.passRaise.paid[seat] ?? 0), kind);
  s.passRaise.paid[seat] = level;
}

/**
 * Reads what a pass carries, and throws if it can't: nothing has moved yet. A raise goes on top of whatever this seat
 * owes, and it pays both. Facing a raise, a plain pass isn't enough: match, raise or fold.
 */
function readPassStake(s, seat, a) {
  const owed = windowOwed(s, seat);
  const cost = windowCost(s, seat);
  const { chips } = s.seats[seat];
  const hasRaise = a.raise !== undefined && a.raise !== null;
  if (hasRaise && a.match) throw new RuleError('bad_stake', 'Send raise or match with a pass, not both. A raise pays what you owe as well.', 400);
  if (a.fold) throw new RuleError('bad_stake', 'A fold is its own move: send { action: "fold" }, with no card.', 400);
  if (hasRaise) {
    if ((s.passRaised ?? []).includes(seat)) throw new RuleError('already_raised', 'You have already raised during this pass.');
    if (potRoom(s) <= 0) throw new RuleError('pot_limit', `The pot has reached its limit of ${s.cfg.potLimit}: no more raises.`);
    if (!Number.isInteger(a.raise)) throw new RuleError('bad_raise', 'raise must be a whole number.', 400);
    const cap = Math.min(s.cfg.raiseLimit, chips - cost, potRoom(s) - cost);
    if (cap < 1) throw new RuleError('no_chips', 'You have no chips to raise with.');
    if (a.raise < 1 || a.raise > cap) throw new RuleError('bad_raise', `Raise must be 1 to ${cap}.`, 400);
    return { kind: 'raise', n: a.raise };
  }
  if (owed <= 0) {
    if (a.match) throw new RuleError('no_raise_to_answer', 'There is no raise for you to match.');
    return null;
  }
  if (!a.match) throw new RuleError('must_answer', `The raise stands at ${s.passRaise.high}: send match: true or raise: n with your pass, or fold.`);
  if (chips < cost) throw new RuleError('short_stack', `You need ${cost} chips to match; you have ${chips}. You can only fold.`);
  return { kind: 'match' };
}

function applyPassStake(s, seat, stake, ctx) {
  if (stake?.kind === 'raise') {
    const level = s.passRaise.high + stake.n;
    (s.passRaised ??= []).push(seat);
    payToWindow(s, seat, level, 'raise');
    s.passRaise.high = level;
    s.passRaise.by = seat;
    say(s, `${nameOf(s, seat)} passes and raises ${stake.n}.`, { act: { seat, kind: 'raise', n: stake.n, passNo: s.passNo } }); // tagged, so a page can list the round's moves and put each seat's last on its card
    touch(s, ctx);
  } else if (stake?.kind === 'match') {
    const { high } = s.passRaise;
    payToWindow(s, seat, high, 'match');
    say(s, `${nameOf(s, seat)} passes and stays in for ${high}.`, { act: { seat, kind: 'match', n: high, passNo: s.passNo } });
  }
}

/** Every card is in. Anyone who passed before a raise came gets one turn to match or fold, then the cards go round. */
function closeWindow(s, ctx) {
  const { by, high } = s.passRaise;
  const owing = by === null ? [] : orderFrom(s, by + 1).filter((seat) => windowOwed(s, seat) > 0);
  if (owing.length === 0) return resolvePass(s, ctx);
  s.raise = { by, amount: high, waiting: owing };
  say(s, `The raise stands at ${high}. ${nameOf(s, owing[0])} to stay in or fold.`, { act: { seat: null, kind: 'stands', n: high } });
  return touch(s, ctx);
}

function resolvePass(s, ctx) {
  const seats = activeSeats(s);
  const moves = seats.map((seat) => ({ card: s.passes[seat], to: nextActive(s, seat), from: seat }));
  for (const m of moves) s.hands[m.from] = s.hands[m.from].filter((c) => c !== m.card);
  for (const m of moves) {
    s.hands[m.to].push(m.card);
    s.received[m.to].push({ from: m.from, card: m.card });
  }
  s.passLog ??= seatIds(s).map(() => []);
  for (const m of moves) {
    const incoming = moves.find((x) => x.to === m.from);
    s.passLog[m.from].push({ n: s.passNo, sent: m.card, to: m.to, got: incoming.card, from: incoming.from });
  }
  say(s, `Pass ${s.passNo} done.`, { act: { seat: null, kind: 'pass-done', passNo: s.passNo } });
  if (s.passNo >= s.cfg.maxPasses) {
    say(s, `Passing is over after ${s.passNo} passes.`, { act: { seat: null, kind: 'passing-over' } });
    return openLap(s, s.starter, ctx);
  }
  openPass(s, ctx);
}

/** A raise was answered. Once everyone has, the pass window carries on, and resolves if every card is in. */
function afterRaiseStep(s, ctx) {
  if (s.raise.waiting.length > 0) return touch(s, ctx);
  s.raise = null;
  return waitingOn(s).length === 0 ? resolvePass(s, ctx) : touch(s, ctx);
}

/** `stopper` has already had their turn: they claimed as they stopped the passing. */
function openLap(s, from, ctx, stopper = null) {
  const queue = orderFrom(s, from).filter((seat) => seat !== stopper);
  s.phase = 'claim';
  s.raise = null;
  s.passes = seatIds(s).map(() => null);
  s.lap = { leader: queue[0], queue, high: 0, by: null, paid: {}, stopper };
  if (stopper === null) say(s, `Claims open. ${nameOf(s, queue[0])} goes first.`, { act: { seat: null, kind: 'claims-open' } });
  touch(s, ctx);
}

/** Still in the pot: dealt in, not folded, and not caught bluffing. */
const stillIn = (s) => activeSeats(s).filter((i) => !s.claims.some((c) => c.seat === i && c.status === 'caught'));

/** What this seat still has to pay to have matched the highest raise. */
const owedBy = (s, seat) => s.lap.high - (s.lap.paid[seat] ?? 0);

/** Nothing left to back, or nobody left to back it against. */
const nothingToAnswer = (s) => standingClaims(s).length === 0 || stillIn(s).length <= 1;

function afterLapStep(s, ctx) {
  if (s.lap.queue.length === 0) openAnswers(s, ctx);
  else touch(s, ctx);
}

/** The lap is done. Seats still in that haven't matched the highest raise get one turn each, starting after the raiser: match or fold, and call a claim if they like. */
function openAnswers(s, ctx) {
  if (nothingToAnswer(s) || s.lap.by === null) return settle(s, ctx);
  const inPot = new Set(stillIn(s));
  const owing = orderFrom(s, s.lap.by + 1).filter((seat) => inPot.has(seat) && owedBy(s, seat) > 0);
  if (owing.length === 0) return settle(s, ctx);
  s.phase = 'answer';
  s.lap.queue = owing;
  say(s, `The raise stands at ${s.lap.high}. ${nameOf(s, owing[0])} to stay in or fold.`);
  touch(s, ctx);
}

function afterAnswer(s, ctx) {
  s.lap.queue.shift();
  if (s.lap.queue.length === 0 || nothingToAnswer(s)) return settle(s, ctx);
  touch(s, ctx);
}

/** A seat pays up to `level`. It only ever pays the difference, so nobody has more than raiseLimit in over a lap. */
function payUpTo(s, seat, level, kind) {
  payIn(s, seat, level - (s.lap.paid[seat] ?? 0), kind);
  s.lap.paid[seat] = level;
}

/** Everyone else folded: not caught, folded. Then it's that seat's pot, claim or no claim. */
const lastOneIn = (s) => activeSeats(s).length === 1 && stillIn(s).length === 1;

function foldInLap(s, seat) {
  const claim = s.claims.find((c) => c.seat === seat && (c.status === 'standing' || c.status === 'proven'));
  if (claim) claim.status = 'withdrawn';
  s.status[seat] = 'folded';
  say(s, claim ? `${nameOf(s, seat)} folds and withdraws the claim.` : `${nameOf(s, seat)} folds.`, { act: { seat, kind: 'fold', withdrew: !!claim } });
}

const sendsRaise = (a) => a.raise !== undefined && a.raise !== null;

/** A raise to `n`, above the highest so far. Throws if it can't be: nothing has moved yet. */
function checkLapRaise(s, n, chips, high, paid = 0) {
  if (potRoom(s) <= 0) throw new RuleError('pot_limit', `The pot has reached its limit of ${s.cfg.potLimit}: no more raises.`);
  const cap = Math.min(s.cfg.raiseLimit, chips, paid + potRoom(s));
  if (!Number.isInteger(n)) throw new RuleError('bad_raise', 'raise must be a whole number.', 400);
  if (cap <= high) throw new RuleError('bad_raise', high ? `You can't raise above ${high}.` : 'You have no chips to raise with.');
  if (n <= high || n > cap) throw new RuleError('bad_raise', `Raise must be ${high + 1} to ${cap}.`, 400);
  return { kind: 'raise', n };
}

/**
 * Reads what a lap move does about the raise, and throws if it can't: nothing has moved yet. `reserve` is chips this
 * move may need elsewhere. A call reserves the whole stake whether or not the claim is true, so what's refused here
 * says nothing about the claim.
 */
function readStake(s, seat, a, reserve) {
  const chips = s.seats[seat].chips - reserve;
  const { high } = s.lap;
  const owed = owedBy(s, seat);
  const cost = Math.min(owed, potRoom(s));
  const hasRaise = sendsRaise(a);
  if (Number(hasRaise) + Number(!!a.match) + Number(!!a.fold) > 1) throw new RuleError('bad_stake', 'Send one of raise, match or fold with a move.', 400);
  if (hasRaise) return checkLapRaise(s, a.raise, chips, high, s.lap.paid[seat] ?? 0);
  if (owed <= 0) {
    if (a.match || a.fold) throw new RuleError('no_raise_to_answer', 'There is no raise for you to match or fold to.');
    return null;
  }
  if (a.fold) return { kind: 'fold' };
  if (!a.match) throw new RuleError('must_answer', `The raise stands at ${high}: send match: true or fold: true with your move${s.phase === 'answer' ? '' : ', or a higher raise'}.`);
  if (chips < cost) throw new RuleError('short_stack', `You need ${cost} chips to match, and you have ${chips} to spare. You can only fold.`);
  return { kind: 'match' };
}

function applyStake(s, seat, stake) {
  if (stake?.kind === 'raise') {
    payUpTo(s, seat, stake.n, 'raise');
    s.lap.high = stake.n;
    s.lap.by = seat;
    say(s, `${nameOf(s, seat)} raises to ${stake.n}.`, { act: { seat, kind: 'raise', n: stake.n } });
  } else if (stake?.kind === 'match') {
    const { high } = s.lap;
    payUpTo(s, seat, high, 'match');
    say(s, `${nameOf(s, seat)} stays in for ${high}.`, { act: { seat, kind: 'match', n: high } });
  } else if (stake?.kind === 'fold') {
    foldInLap(s, seat);
  }
}

/** The end of any lap move. Folding can end the round on the spot. */
function endLapTurn(s, ctx) {
  s.lap.queue.shift();
  if (lastOneIn(s)) return uncontested(s, ctx);
  afterLapStep(s, ctx);
}

/** Who paid and got what this round, for the round's result. A stack's own business, so it's public, like the stacks. */
function moneyMoved(s, from, to, amount) {
  if (s.roundMoney?.[from]) s.roundMoney[from].in += amount;
  if (s.roundMoney?.[to]) s.roundMoney[to].out += amount;
}

/**
 * What a page needs to tell the round's story in plain words. Every claim's status is as the table knows it: "standing"
 * means nobody called it, and says nothing about whether it was true. No card, and no truth, is in here.
 */
const roundStory = (s) => ({
  claims: s.claims.map((c) => ({ seat: c.seat, label: labelClaim(c.claim), status: c.status })),
  folded: seatIds(s).filter((i) => s.status[i] === 'folded'),
  money: (s.roundMoney ?? []).map((m) => ({ ...m })),
});

function finishRound(s, result, ctx) {
  for (const a of result.awards ?? []) moneyMoved(s, null, a.seat, a.amount);
  s.lastResult = { round: s.round, ...result, ...roundStory(s) };
  s.phase = 'settled'; // the deck opens with it: dealView gives the seed and the order once the phase is settled or over
  s.raise = null;
  s.lap = null;
  touch(s, ctx, s.cfg.roundGapMs);
  for (const seat of seatIds(s)) if (s.seats[seat].leaving) depart(s, seat);
}

function settle(s, ctx) {
  const ranked = standingClaims(s).slice().sort((a, b) => compareClaims(b.claim, a.claim));
  const pot = s.pot;
  if (ranked.length === 0) {
    say(s, `No claim stands. The pot of ${pot} carries to the next round.`);
    s.carried = pot;
    return finishRound(s, { kind: 'carried', pot, awards: [], carried: pot }, ctx);
  }
  // A lone claim takes it all; otherwise ceil(2/3) to the top and the rest to the second.
  const topShare = ranked[1] ? Math.floor((2 * pot + 2) / 3) : pot;
  const awards = [{ seat: ranked[0].seat, amount: topShare, claim: ranked[0].claim }];
  if (ranked[1]) awards.push({ seat: ranked[1].seat, amount: pot - topShare, claim: ranked[1].claim });
  s.carried = 0;
  for (const a of awards) {
    s.seats[a.seat].chips += a.amount;
    chipMove(s, 'win', 'pot', a.seat, a.amount);
    say(s, `${nameOf(s, a.seat)} takes ${a.amount} with ${labelClaim(a.claim)}.`);
  }
  s.pot = 0;
  s.potIn = [];
  finishRound(s, { kind: 'settled', pot, awards, carried: 0 }, ctx);
}

function uncontested(s, ctx) {
  const [seat] = stillIn(s);
  const pot = s.pot;
  s.seats[seat].chips += pot;
  s.pot = 0;
  s.carried = 0;
  s.potIn = [];
  chipMove(s, 'win', 'pot', seat, pot);
  // A claim that wins this way stays on the record as it is: standing, never called, and its truth never shown.
  const held = standingClaims(s).find((c) => c.seat === seat)?.claim;
  say(s, `Everyone else folded. ${nameOf(s, seat)} takes the pot of ${pot} uncontested${held ? `, with ${labelClaim(held)}` : ''}.`);
  finishRound(s, { kind: 'uncontested', pot, awards: [{ seat, amount: pot, ...(held ? { claim: held, label: labelClaim(held) } : {}) }], carried: 0 }, ctx);
}

// ---------- actions ----------

function needPhase(s, action, ...phases) {
  if (!phases.includes(s.phase)) {
    throw new RuleError('wrong_phase', `Can't ${action} during the ${s.phase} phase (legal in: ${phases.join(', ')}).`);
  }
}

function needTurn(s, seat, action) {
  const turn = currentTurn(s);
  if (turn !== seat) throw new RuleError('not_your_turn', `Can't ${action}: it is seat ${turn}'s turn.`);
}

const HANDLERS = {
  pass(s, seat, a, ctx) {
    needPhase(s, 'pass', 'pass');
    if (!isCard(a.card)) throw new RuleError('bad_card', 'card must look like "Ah", "Td" or "2c".', 400);
    if (s.passes[seat] !== null) throw new RuleError('already_passed', 'You have already chosen a card for this pass.');
    if (!s.hands[seat].includes(a.card)) throw new RuleError('not_in_hand', `${a.card} is not in your hand.`);
    if (s.raise) throw new RuleError('raise_pending', 'A raise is pending: it must be matched or folded first.');
    const stake = readPassStake(s, seat, a);
    s.passes[seat] = a.card;
    applyPassStake(s, seat, stake, ctx);
    if (waitingOn(s).length === 0) closeWindow(s, ctx);
  },

  raise(s, seat, a, ctx) {
    if (s.phase === 'claim') throw new RuleError('wrong_phase', 'In the claim lap a raise goes with your move: send raise: n with check, claim or call.');
    needPhase(s, 'raise', 'pass');
    throw new RuleError('wrong_phase', 'In a pass window a raise goes with your pass: send { action: "pass", card, raise: n }.');
  },

  match(s, seat, a, ctx) {
    if (s.phase === 'answer') {
      needTurn(s, seat, 'match');
      const stake = readStake(s, seat, { match: true }, 0);
      applyStake(s, seat, stake);
      return afterAnswer(s, ctx);
    }
    if (s.phase === 'claim') throw new RuleError('wrong_phase', 'In the claim lap a match goes with your move: send match: true with check, claim or call.');
    needPhase(s, 'match', 'pass');
    if (!s.raise) throw new RuleError('wrong_phase', 'In a pass window a match goes with your pass: send { action: "pass", card, match: true }.');
    needTurn(s, seat, 'match');
    const { amount } = s.raise;
    const cost = windowCost(s, seat);
    if (s.seats[seat].chips < cost) throw new RuleError('short_stack', `You need ${cost} chips to match; you have ${s.seats[seat].chips}. You can only fold.`);
    payToWindow(s, seat, amount, 'match');
    s.raise.waiting.shift();
    say(s, `${nameOf(s, seat)} stays in for ${amount}.`, { act: { seat, kind: 'match', n: amount, passNo: s.passNo } });
    afterRaiseStep(s, ctx);
  },

  fold(s, seat, a, ctx) {
    if (s.phase === 'answer') {
      needTurn(s, seat, 'fold');
      foldInLap(s, seat);
      return lastOneIn(s) ? uncontested(s, ctx) : afterAnswer(s, ctx);
    }
    if (s.phase === 'claim') {
      needTurn(s, seat, 'fold');
      if (owedBy(s, seat) <= 0) throw new RuleError('no_raise_to_answer', 'There is no raise for you to fold to. Check instead.');
      foldInLap(s, seat);
      return endLapTurn(s, ctx);
    }
    needPhase(s, 'fold', 'pass');
    if (s.raise) needTurn(s, seat, 'fold');
    else if (s.passes[seat] !== null) throw new RuleError('already_passed', 'You have already chosen a card for this pass.');
    else if (windowOwed(s, seat) <= 0) throw new RuleError('no_raise_to_answer', 'There is no raise for you to fold to.');
    s.status[seat] = 'folded';
    if (s.raise) s.raise.waiting = s.raise.waiting.filter((x) => x !== seat);
    say(s, `${nameOf(s, seat)} folds.`, { act: { seat, kind: 'fold', passNo: s.passNo } });
    if (activeSeats(s).length === 1) return uncontested(s, ctx);
    if (s.raise) return afterRaiseStep(s, ctx);
    if (waitingOn(s).length === 0) closeWindow(s, ctx);
  },

  stop(s, seat, a, ctx) {
    needPhase(s, 'stop', 'pass');
    if (s.passNo - 1 < s.cfg.minPasses) throw new RuleError('too_early', `Nobody may stop until ${s.cfg.minPasses} passes are done.`);
    if (s.raise) throw new RuleError('raise_pending', 'A raise is pending: it must be matched or folded first.');
    if (s.passRaise?.high > 0) throw new RuleError('raise_pending', 'There is a raise out in this pass window, so nobody can stop until the next one.');
    const claim = normalizeClaim(a.claim);
    if (!claim) throw new RuleError('bad_claim', 'Stopping the passing is a claim: send claim as [cat, r1, r2], and raise: n if you want to. See GET /api for the format.', 400);
    if (a.match || a.fold) throw new RuleError('bad_stake', 'There is no raise to answer yet. Stop with a claim, and raise: n if you want to.');
    const stake = sendsRaise(a) ? checkLapRaise(s, a.raise, s.seats[seat].chips, 0) : null;
    s.claims.push({ seat, claim, status: 'standing' });
    say(s, `${nameOf(s, seat)} stops the passing and claims ${labelClaim(claim)}.`, { act: { seat, kind: 'stop', label: labelClaim(claim) } });
    openLap(s, seat + 1, ctx, seat);
    applyStake(s, seat, stake);
    say(s, `Claims open. ${nameOf(s, s.lap.queue[0])} is next.`, { act: { seat: null, kind: 'claims-open' } });
  },

  claim(s, seat, a, ctx) {
    needPhase(s, 'claim', 'claim');
    needTurn(s, seat, 'claim');
    const claim = normalizeClaim(a.claim);
    if (!claim) throw new RuleError('bad_claim', 'claim is not a valid [cat, r1, r2]. See GET / for the format.', 400);
    const top = topClaim(s);
    if (top && compareClaims(claim, top) <= 0) throw new RuleError('claim_too_low', `Must beat the top standing claim: ${labelClaim(top)}.`);
    if (a.fold) throw new RuleError('bad_stake', 'A claim you fold is gone before it lands. Match, raise, or just fold.');
    const stake = readStake(s, seat, a, 0);
    s.claims.push({ seat, claim, status: 'standing' });
    say(s, `${nameOf(s, seat)} claims ${labelClaim(claim)}.`, { act: { seat, kind: 'claim', label: labelClaim(claim) } });
    applyStake(s, seat, stake);
    endLapTurn(s, ctx);
  },

  call(s, seat, a, ctx) {
    needPhase(s, 'call', 'claim', 'answer');
    needTurn(s, seat, 'call');
    const afterLap = s.phase === 'answer';
    if (afterLap && sendsRaise(a)) throw new RuleError('bad_stake', 'No raises after the lap. Send match: true or fold: true with your call.');
    if (!Number.isInteger(a.seat)) throw new RuleError('bad_call', 'seat must be the seat number of the claim you are calling.', 400);
    if (a.seat === seat) throw new RuleError('bad_call', "You can't call your own claim.");
    const target = s.claims.find((c) => c.seat === a.seat);
    if (!target) throw new RuleError('no_such_claim', `Seat ${a.seat} has no claim this round.`);
    if (target.status !== 'standing') throw new RuleError('already_called', `Seat ${a.seat}'s claim was already called.`);
    const stake = s.cfg.callStake;
    if (s.seats[seat].chips < stake) throw new RuleError('not_enough_chips', `A call needs at least ${stake} chips.`);
    const onTop = readStake(s, seat, a, stake);

    const rep = s.seats[a.seat].rep;
    rep.called += 1;
    if (contains(s.hands[a.seat], target.claim)) {
      target.status = 'proven';
      rep.proven += 1;
      const paid = takeChips(s, seat, stake);
      moneyMoved(s, seat, a.seat, paid);
      s.seats[a.seat].chips += paid;
      chipMove(s, 'sting', seat, a.seat, paid);
      say(s, `${nameOf(s, seat)} calls ${nameOf(s, a.seat)}: ${labelClaim(target.claim)} is CHECKED. ${nameOf(s, seat)} pays ${paid}.`, { act: { seat, kind: 'call', target: a.seat, result: 'checked', label: labelClaim(target.claim), paid } });
    } else {
      target.status = 'caught';
      rep.caught += 1;
      const paid = takeChips(s, a.seat, stake);
      moneyMoved(s, a.seat, seat, paid);
      s.seats[seat].chips += paid;
      chipMove(s, 'sting', a.seat, seat, paid);
      say(s, `${nameOf(s, seat)} calls ${nameOf(s, a.seat)}: ${labelClaim(target.claim)} is a BLUFF. ${nameOf(s, a.seat)} is out of the pot and pays ${paid}.`, { act: { seat, kind: 'call', target: a.seat, result: 'bluff', label: labelClaim(target.claim), paid } });
    }
    applyStake(s, seat, onTop);
    if (!afterLap) return endLapTurn(s, ctx);
    if (target.status === 'caught') s.lap.queue = s.lap.queue.filter((x) => x !== a.seat); // out of the pot, so nothing left to answer
    return lastOneIn(s) ? uncontested(s, ctx) : afterAnswer(s, ctx);
  },

  check(s, seat, a, ctx) {
    needPhase(s, 'check', 'claim');
    needTurn(s, seat, 'check');
    const stake = readStake(s, seat, a, 0);
    if (stake?.kind === 'fold') foldInLap(s, seat); // check and fold is a fold
    else {
      say(s, `${nameOf(s, seat)} checks.`, { act: { seat, kind: 'check' } });
      applyStake(s, seat, stake);
    }
    endLapTurn(s, ctx);
  },
};

function depart(s, seat) {
  const x = s.seats[seat];
  if (humanSeats(s).every((other) => other === x)) returnPot(s); // the last one out: nothing else will ever pay this pot
  const amount = x.chips;
  x.chips = 0;
  x.left = true;
  x.leaving = false;
  x.leftWith = amount;
  x.leftRound = s.round; // the public seat list shows "left · N" through this round, then the seat is gone from it (11-10)
  if (s.status[seat]) s.status[seat] = 'out';
  s.departures.push({ seat, amount, ...(x.standing ? { stood: true } : {}) });
  x.standing = false;
  say(s, `${x.name} leaves the table with ${amount} chips.`);
  if (humanSeats(s).length === 0) endTable(s, 'everyone_left', 'Everyone else left.');
  else if (isSolo(s)) s.deadline = null;
  return amount;
}

/** Why this seat can't take more chips right now, or null. Never mid-round: a stack can't grow to meet a raise. */
function addChipsRefusal(s, seat) {
  const x = s.seats[seat];
  if (x.left || x.leaving) return 'You are leaving this table.';
  if (x.away) return 'You are marked away. Come back first.';
  if (!['lobby', 'settled'].includes(s.phase)) return 'You can only add chips between rounds.';
  return null;
}

/** Throws if this move can't happen. Called before any chips leave the purse. */
export function checkAddChips(s, seat, amount) {
  if (!Number.isInteger(amount) || amount < 1) throw new RuleError('bad_amount', 'amount must be a whole number of chips, at least 1.', 400);
  const refusal = addChipsRefusal(s, seat);
  if (refusal) throw new RuleError('not_between_rounds', refusal);
}

/** The chips have left the purse: they land on the stack. */
export function addChips(s, seat, amount, ctx) {
  const x = s.seats[seat];
  x.chips += amount;
  s.lastHumanAt = ctx.now;
  say(s, `${x.name} adds ${amount} chips.`);
}

/**
 * Back at the seat they left, with the stack they took. A table that closed because they were the last one out
 * opens again, between rounds. In a round already running, they're dealt in at the next one.
 */
export function sitBackDown(s, seat, chips, ctx) {
  const x = s.seats[seat];
  x.left = false;
  x.leaving = false;
  x.away = false;
  x.leftWith = null;
  x.chips = chips;
  s.lastHumanAt = ctx.now;
  if (s.phase === 'over') {
    s.phase = 'settled';
    s.overReason = null;
    s.overCode = null;
    s.overRound = null;
    s.overAt = null;
    s.deadline = null;
  }
  say(s, `${x.name} sits back down with ${chips} chips.`);
  if (s.phase === 'settled' && s.deadline === null) touch(s, ctx, s.cfg.roundGapMs);
}

/**
 * Leave the table. Between rounds it happens now. During a round it happens as soon as the round ends,
 * and the player keeps acting (or timing out) until then. At a solo table nothing would ever end that round,
 * so it plays itself out with the automatic moves.
 */
export function leave(s, seat, ctx) {
  const x = s.seats[seat];
  if (s.phase === 'over') throw new RuleError('table_over', 'This table has finished.');
  if (x.left) throw new RuleError('already_left', 'You have already left this table.');
  if (inRound(s)) {
    x.leaving = true;
    say(s, `${x.name} will leave after this round.`);
    if (ctx) playAutoSeats(s, ctx);
    return { queued: true };
  }
  return { queued: false, amount: depart(s, seat) };
}

/** A table saved before the house bot was Tally: the seat and its lines in the log change over. */
function renameOldHouse(s) {
  const seat = s.seats.find((x) => x.bot && x.name === OLD_HOUSE_NAME);
  if (!seat) return false;
  seat.name = HOUSE_NAME;
  for (const line of s.log) {
    line.text = line.text.replaceAll(OLD_HOUSE_NAME, HOUSE_NAME);
    if (line.name === OLD_HOUSE_NAME) line.name = HOUSE_NAME;
  }
  return true;
}

/**
 * Brings a saved table up to the current rules. Returns true if anything changed.
 * A table saved before the pot's shares were recorded treats its pot as paid in equally by the seats still there.
 * One with a betting step between passes moves to its next pass, keeping any raise being answered, or to the
 * claim lap if that was the last pass.
 */
export function upgradeState(s, ctx) {
  let changed = renameOldHouse(s);
  if (s.potIn === undefined) {
    const here = seatIds(s).filter((i) => !s.seats[i].left);
    s.potIn = [];
    if (s.pot > 0) for (const i of here) s.potIn[i] = s.pot / here.length;
    changed = true;
  }
  for (const x of s.seats) {
    if (x.away && x.awaySince === undefined) {
      x.awaySince = ctx.now; // saved before Away had a time limit: it starts now
      changed = true;
    }
  }
  if (s.phase === 'pass' && s.passRaise === undefined) { // saved before a raise went with the pass: a raise being answered stays answerable
    s.passRaise = { high: s.raise?.amount ?? 0, by: s.raise?.by ?? null, paid: s.raise ? { [s.raise.by]: s.raise.amount } : {} };
    changed = true;
  }
  changed = upgradeLap(s, ctx) || changed;
  return upgradeBetStep(s, ctx) || changed;
}

/**
 * A table saved under the old rules. A lap in play gets its raise fields. One stopped in the old round after the lap
 * carries its raise over: anyone still in who hasn't matched it answers now, and with no raise it settles.
 */
function upgradeLap(s, ctx) {
  let changed = false;
  if (s.lap && s.lap.high === undefined) {
    Object.assign(s.lap, { high: 0, by: null, paid: {} });
    changed = true;
  }
  if (s.lastCall === undefined) return changed;
  const old = s.lastCall;
  delete s.lastCall;
  if (s.phase === 'lastcall') {
    s.lap = { leader: old.queue[0] ?? 0, queue: [], high: old.high, by: Number(Object.keys(old.paid).find((seat) => old.paid[seat] === old.high) ?? 0), paid: { ...old.paid } };
    s.phase = 'claim';
    openAnswers(s, ctx);
  }
  return true;
}

function upgradeBetStep(s, ctx) {
  if (s.bet === undefined) return false;
  const pending = s.bet?.raise ?? null;
  const midBet = s.phase === 'bet';
  delete s.bet;
  s.raise = null;
  if (midBet) {
    if (s.passNo >= s.cfg.maxPasses) openLap(s, s.starter, ctx);
    else openPass(s, ctx);
  }
  if (s.phase === 'pass' && pending) s.raise = pending;
  if (isSolo(s) && (inRound(s) || s.phase === 'settled')) s.deadline = null; // solo tables have no clock now
  return true;
}

/** Anyone still seated can deal the next round once this one is settled. Nobody pressing: tick() does it. */
function nextRound(s, seat, ctx) {
  if (s.phase !== 'settled') throw new RuleError('wrong_phase', 'The next round can only be dealt when this one is over.');
  if (s.seats[seat].left) throw new RuleError('already_left', 'You have already left this table.');
  if (!s.seats[seat].bot) s.lastHumanAt = ctx.now;
  startRound(s, ctx);
}

/** ctx.auto marks a timeout or house move, which doesn't count as a human being present. */
export function act(s, seat, action, ctx) {
  const type = action?.action;
  if (!ACTIONS.includes(type)) throw new RuleError('bad_action', `action must be one of: ${ACTIONS.join(', ')}.`, 400);
  if (type === 'back') return comeBack(s, seat, ctx);
  if (s.seats[seat].away && !ctx.auto) throw new RuleError('away', 'You are marked away. Send { "action": "back" } first.');
  if (type === 'next') return nextRound(s, seat, ctx);
  if (!inRound(s)) throw new RuleError('no_round', `No round in play (phase: ${s.phase}).`);
  if (!isActive(s, seat)) throw new RuleError('not_in_round', 'You have folded or are sitting out this round.');
  HANDLERS[type](s, seat, action, ctx);
  if (!ctx.auto && !s.seats[seat].bot) s.lastHumanAt = ctx.now;
  playAutoSeats(s, ctx);
}

/** Back from being away. In a round they're still part of, they play on; otherwise they're dealt in next round. */
function comeBack(s, seat, ctx) {
  const x = s.seats[seat];
  if (!x.away) throw new RuleError('not_away', 'You are not marked away.');
  x.away = false;
  x.awaySince = null;
  if (x.standing) { // they were due to stand up when this round ended: back in time
    x.standing = false;
    x.leaving = false;
  }
  s.lastHumanAt = ctx.now;
  say(s, `${x.name} is back.`);
  if (s.phase === 'settled' && s.deadline === null) touch(s, ctx, s.cfg.roundGapMs); // the deal was waiting for someone
}

/** Seats that move themselves, at once: anyone marked away, and someone leaving a solo table. */
function playAutoSeats(s, ctx) {
  const auto = { ...ctx, auto: true };
  for (let guard = 0; guard < 200; guard++) {
    if (!inRound(s)) return;
    const seat = waitingOn(s).find((i) => !s.seats[i].bot && (s.seats[i].away || (s.seats[i].leaving && isSolo(s))));
    if (seat === undefined) return;
    act(s, seat, autoAction(s, seat, ctx), auto);
  }
}

/** A move made for someone who isn't there: a random card, or a check. Never a raise or a call. A raise to answer can only be folded. */
export function autoAction(s, seat, ctx) {
  if (s.raise || s.phase === 'answer' || (s.phase === 'claim' && owedBy(s, seat) > 0) || (s.phase === 'pass' && windowOwed(s, seat) > 0)) return { action: 'fold' };
  if (s.phase === 'pass') {
    const hand = s.hands[seat];
    return { action: 'pass', card: hand[Math.floor((ctx?.rng?.() ?? 0) * hand.length)] };
  }
  return { action: 'check' };
}

function markAway(s, seat, ctx) {
  if (s.seats[seat].bot) return;
  s.seats[seat].away = true;
  s.seats[seat].awaySince ??= ctx.now;
  say(s, `${nameOf(s, seat)} timed out and is marked away.`);
}

const awayLimit = (s) => s.cfg.awayStandMs ?? DEFAULTS.awayStandMs;
const awaySeats = (s) => seatIds(s).filter((i) => s.seats[i].away && !s.seats[i].left && !s.seats[i].leaving && !s.seats[i].bot);

/**
 * A chips seat left untouched at a solo table: nothing else ever moves that player on (a solo table has no clock), so after
 * awayStandMs with no move of theirs the seat stands up and the stack goes back to the purse (The owner, 11-07: a week-old seat).
 * A tNIGHT table's seats are the judge's, and a table with other people has the Away clock. Null when nothing is due.
 */
function soloIdleStandAt(s) {
  if (s.cage || s.phase === 'over' || !isSolo(s) || s.lastHumanAt == null) return null;
  const human = humanSeats(s).find((x) => !x.leaving && !x.standing);
  return human ? Math.max(s.lastHumanAt, s.soloSince ?? 0) + awayLimit(s) : null; // from their last move, or from when the table went solo under them
}

/** When the next Away player (or the one person at a solo chips table, untouched) is due to stand up, or null. */
export function nextStandAt(s) {
  if (s.phase === 'over') return null;
  const times = isSolo(s) ? [] : awaySeats(s).map((i) => s.seats[i].awaySince + awayLimit(s));
  const solo = soloIdleStandAt(s);
  if (solo !== null) times.push(solo);
  return times.length ? Math.min(...times) : null;
}

/** The one person at a solo chips table, untouched for awayStandMs: they stand up, now or when this round ends (the round plays itself out). */
function standIdleSolo(s, ctx) {
  const due = soloIdleStandAt(s);
  if (due === null || ctx.now < due) return false;
  const seat = seatIds(s).find((i) => !s.seats[i].bot && !s.seats[i].left && !s.seats[i].leaving && !s.seats[i].standing);
  if (seat === undefined) return false;
  const x = s.seats[seat];
  x.standing = true;
  say(s, `${x.name} has been away too long and stands up.`);
  if (inRound(s)) { x.leaving = true; playAutoSeats(s, ctx); } else depart(s, seat);
  return true;
}

/** Away too long at a table with other people: the stack goes back to the purse, now or when this round ends. */
function standAwaySeats(s, ctx) {
  if (s.phase === 'over' || isSolo(s)) return false;
  const due = awaySeats(s).filter((i) => ctx.now >= s.seats[i].awaySince + awayLimit(s));
  for (const seat of due) {
    if (s.phase === 'over') break;
    const x = s.seats[seat];
    x.standing = true;
    say(s, `${x.name} has been away too long and stands up.`);
    if (inRound(s)) x.leaving = true;
    else depart(s, seat);
  }
  return due.length > 0;
}

/** Applies whatever is due at ctx.now. Returns true if the state changed. */
export function tick(s, ctx) {
  const stood = standAwaySeats(s, ctx);
  const solo = isSolo(s); // when the table went solo under someone (the others left): the one left isn't stood for the time before that
  if (solo && s.wasSolo === false) s.soloSince = ctx.now;
  if (!solo) s.soloSince = null;
  s.wasSolo = solo;
  const idle = standIdleSolo(s, ctx);
  return applyClock(s, ctx) || stood || idle;
}

function applyClock(s, ctx) {
  if (s.deadline === null) {
    const limit = s.cfg.waitingIdleMs ?? DEFAULTS.waitingIdleMs;
    if (s.round === 0 || s.phase === 'over' || ctx.now - s.lastHumanAt <= limit) return false;
    endTable(s, 'no_human_action', NO_MOVES(limit), ctx);
    return true;
  }
  if (ctx.now < s.deadline) return false;
  const auto = { ...ctx, auto: true };
  if (s.phase === 'lobby') startGame(s, ctx);
  else if (s.phase === 'settled') startRound(s, ctx);
  else if (s.phase === 'pass' && !s.raise) {
    for (const seat of waitingOn(s)) {
      if (s.passes[seat] !== null || s.phase !== 'pass') continue;
      markAway(s, seat, ctx);
    }
    playAutoSeats(s, ctx);
    for (const seat of waitingOn(s)) if (s.phase === 'pass' && s.seats[seat].bot) act(s, seat, autoAction(s, seat, ctx), auto);
  } else if (inRound(s)) {
    const seat = currentTurn(s);
    markAway(s, seat, ctx);
    if (s.seats[seat].bot) act(s, seat, autoAction(s, seat, ctx), auto);
    else playAutoSeats(s, ctx);
  }
  return true;
}

// ---------- views ----------

/** Everything a spectator may see. Whitelisted: never add hands or passes here. */
/** The round's deck seal, and, once the round is over, the seed and the deck order it was over. Nothing of them before. */
export const dealView = (s) => (s.deal ? { seal: s.deal.seal, opened: s.phase === 'settled' || s.phase === 'over' ? { seed: s.deal.seed, deck: [...s.deal.deck] } : null } : null);

/**
 * Seals the deal under the round's public number: the seal is computed over it, kept on the state for the pages, and said in the log.
 * Called by the records as soon as the round has its number (the same step as the deal at a numbered table). Once only.
 */
export function sealDeal(s, { table, round }) {
  if (!s.deal || s.deal.seal) return s.deal?.seal ?? null;
  s.deal.seal = deckSeal({ table, round, seed: s.deal.seed, deck: s.deal.deck });
  say(s, `Deck sealed before the deal: ${s.deal.seal.slice(0, 16)}…`, { act: { seat: null, kind: 'seal', seal: s.deal.seal } });
  return s.deal.seal;
}

export function publicView(s) {
  const top = topClaim(s);
  return {
    phase: s.phase,
    deal: dealView(s),
    round: s.round,
    starter: s.starter,
    pot: s.pot,
    carried: s.carried ?? 0,
    chipLog: s.chipLog ?? [],
    passNo: s.passNo,
    turn: currentTurn(s) ?? null,
    waitingOn: waitingOn(s),
    deadline: s.deadline,
    clocks: waitingOn(s).map((seat) => {
      const due = s.botDue?.[seat];
      return due ? { seat, from: due.from, until: due.at } : { seat, from: s.clockFrom ?? null, until: s.deadline };
    }),
    seats: s.seats.map((x, seat) => ({
      seat,
      name: x.name,
      bot: x.bot,
      kind: x.kind,
      avatar: x.avatar,
      chips: x.chips,
      // A seat that left says so: its stack went back to the purse (leftWith), and 0 chips with status "out" reads as busted (11-10).
      status: x.left ? 'left' : s.status[seat] ?? 'waiting',
      gone: !!x.left && s.round > (x.leftRound ?? -1), // left a round ago: the seat list drops it
      rep: { ...x.rep },
      left: !!x.left,
      leftWith: x.leftWith ?? null,
      leaving: !!x.leaving,
      away: !!x.away,
      passCount: s.passLog?.[seat]?.length ?? 0, // how many, never which
    })),
    raise: s.raise ? { by: s.raise.by, amount: s.raise.amount, waiting: [...s.raise.waiting] } : null,
    lapRaise: s.lap ? { high: s.lap.high, by: s.lap.by, paid: { ...s.lap.paid }, waiting: [...s.lap.queue], stopper: s.lap.stopper ?? null } : null,
    raisedThisPass: s.phase === 'pass' ? [...(s.passRaised ?? [])] : [],
    passRaise: s.phase === 'pass' && s.passRaise ? { high: s.passRaise.high, by: s.passRaise.by, paid: { ...s.passRaise.paid } } : null,
    potLimitReached: inRound(s) && potRoom(s) <= 0,
    claims: s.claims.map((c) => ({ seat: c.seat, claim: [...c.claim], label: labelClaim(c.claim), status: c.status })),
    top,
    lastResult: s.lastResult,
    overCode: s.overCode ?? null,
    overReason: s.overReason,
    overRound: s.overRound ?? null,
    limits: { ante: s.cfg.ante, minPasses: s.cfg.minPasses, maxPasses: s.cfg.maxPasses, raiseLimit: s.cfg.raiseLimit, callStake: s.cfg.callStake, turnMs: s.cfg.turnMs, potLimit: s.cfg.potLimit ?? null },
    houseStaked: s.houseStaked ?? 0,
    log: s.log,
  };
}

export function legalActions(s, seat) {
  if (s.phase !== 'over' && s.seats[seat].away) return [{ action: 'back' }];
  if (s.phase === 'settled') return s.seats[seat].left ? [] : [{ action: 'next' }];
  if (!inRound(s) || !isActive(s, seat)) return [];
  const out = [];
  if (s.phase === 'answer') {
    if (currentTurn(s) !== seat) return out;
    const owed = Math.min(owedBy(s, seat), potRoom(s));
    const { chips } = s.seats[seat];
    if (chips >= owed) out.push({ action: 'match', cost: owed, level: s.lap.high });
    const callable = uncalledClaims(s).map((c) => c.seat).filter((x) => x !== seat);
    if (callable.length && chips >= s.cfg.callStake) {
      out.push({ action: 'call', seats: callable, ...(chips - s.cfg.callStake >= owed ? { match: { cost: owed, level: s.lap.high } } : {}), fold: true });
    }
    out.push({ action: 'fold' });
    return out;
  }
  if (s.phase === 'pass') {
    if (s.raise) {
      if (s.raise.waiting[0] === seat) {
        if (s.seats[seat].chips >= windowCost(s, seat)) out.push({ action: 'match', cost: windowCost(s, seat), level: s.raise.amount });
        out.push({ action: 'fold' });
      }
      return out;
    }
    const cost = windowCost(s, seat);
    const owes = windowOwed(s, seat) > 0;
    const cap = Math.min(s.cfg.raiseLimit, s.seats[seat].chips - cost, potRoom(s) - cost);
    const canStay = s.seats[seat].chips >= cost;
    if (s.passes[seat] === null && canStay) {
      out.push({
        action: 'pass',
        cards: [...s.hands[seat]],
        ...(owes ? { match: { cost, level: s.passRaise.high } } : {}),
        ...(cap >= 1 && !(s.passRaised ?? []).includes(seat) ? { raise: { min: 1, max: cap } } : {}),
      });
    }
    if (s.passes[seat] === null && owes) out.push({ action: 'fold' });
    if (mayStop(s)) {
      const stopCap = Math.min(s.cfg.raiseLimit, s.seats[seat].chips, potRoom(s));
      out.push({
        action: 'stop',
        truthful: truthfulAbove(s.hands[seat], null).map((claim) => ({ claim, label: labelClaim(claim) })),
        options: LADDER.map((claim) => ({ claim, label: labelClaim(claim) })),
        ...(stopCap >= 1 ? { raise: { min: 1, max: stopCap } } : {}),
      });
    }
    return out;
  }
  const turn = currentTurn(s);
  if (turn === seat) {
    const top = topClaim(s);
    const free = stakeOptions(s, seat, 0);
    const meetsRaise = owedBy(s, seat) <= 0 || !!free.match; // facing a raise, a seat that can't cover it can only fold
    if (firstRungAbove(top) < LADDER.length && meetsRaise) {
      out.push({
        action: 'claim',
        above: top,
        truthful: truthfulAbove(s.hands[seat], top).map((claim) => ({ claim, label: labelClaim(claim) })),
        options: LADDER.slice(firstRungAbove(top)).map((claim) => ({ claim, label: labelClaim(claim) })), // so a client needs no claim logic
        ...free,
      });
    }
    const callable = uncalledClaims(s).map((c) => c.seat).filter((x) => x !== seat);
    const owed = owedBy(s, seat);
    if (callable.length && s.seats[seat].chips >= s.cfg.callStake) {
      out.push({ action: 'call', seats: callable, ...stakeOptions(s, seat, s.cfg.callStake), ...(owed > 0 ? { fold: true } : {}) });
    }
    if (meetsRaise) out.push({ action: 'check', ...free });
    if (owed > 0) out.push({ action: 'fold' });
  }
  return out;
}

/** Stopping the passing is a claim, so it comes with everything a claim needs. */
const mayStop = (s) => s.phase === 'pass' && !s.raise && !(s.passRaise?.high > 0) && s.passNo - 1 >= s.cfg.minPasses;

/** What can go with a lap move: a raise, and a match if there's a raise to meet. `reserve` is what the move itself may cost. */
function stakeOptions(s, seat, reserve) {
  const chips = s.seats[seat].chips - reserve;
  const owed = owedBy(s, seat);
  const cost = Math.min(owed, potRoom(s));
  const cap = Math.min(s.cfg.raiseLimit, chips, (s.lap.paid[seat] ?? 0) + potRoom(s));
  return {
    ...(potRoom(s) > 0 && cap > s.lap.high ? { raise: { min: s.lap.high + 1, max: cap } } : {}),
    ...(owed > 0 && chips >= cost ? { match: { cost, level: s.lap.high } } : {}),
  };
}


/** What this seat could truthfully claim, and whether that's enough. Only until they've had their say this lap. */
function bestTrue(s, seat) {
  const canClaim = mayStop(s) ? isActive(s, seat) : s.phase === 'claim' && s.lap?.queue.includes(seat);
  if (!canClaim) return null;
  const claim = bestClaim(s.hands[seat]);
  const top = topClaim(s);
  return { claim, label: claim ? labelClaim(claim) : null, beats: !!claim && (!top || compareClaims(claim, top) > 0) };
}

/** The raise this seat hasn't matched, if it's still in: what it stands at, who set it, and what matching costs. */
function facingRaise(s, seat) {
  if (!s.lap || !stillIn(s).includes(seat) || owedBy(s, seat) <= 0) return null;
  return { high: s.lap.high, by: s.lap.by, owed: Math.min(owedBy(s, seat), potRoom(s)), paid: s.lap.paid[seat] ?? 0 };
}

/** The owner's view of their own seat. */
export function privateView(s, seat) {
  return {
    seat,
    name: s.seats[seat].name,
    hand: [...(s.hands[seat] ?? [])],
    pendingPass: s.phase === 'pass' ? s.passes[seat] : null,
    passLog: (s.passLog?.[seat] ?? []).map((entry) => ({ ...entry })),
    legal: legalActions(s, seat),
    bestTrue: bestTrue(s, seat),
    facing: facingRaise(s, seat),
    canAddChips: addChipsRefusal(s, seat) === null,
    broke: s.seats[seat].chips < s.cfg.ante, // between rounds, a play-chip seat that can't ante: the page offers Fill up
    canFillUp: !s.cage && addChipsRefusal(s, seat) === null,
    canLeave: s.phase !== 'over' && !s.seats[seat].left,
    leaving: !!s.seats[seat].leaving,
    away: !!s.seats[seat].away,
  };
}
