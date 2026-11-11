// Cup & Claim: the rules. Pure state machine, no I/O: the clock and randomness come in through ctx = { now, rng }.
// State is plain JSON, so a Durable Object stores it as is. Handlers validate before they mutate.
//
// publicView is a whitelist and the only thing spectators get. Dice and seeds reach only their owner, through
// privateView, and only a seat that chose "show" ever has its dice in the public record.
//
// Mirrors src/games/sealed-hand/engine.js in shape (seats, chips, clocks, away, leaving) so the table code is the same.

import { commitHouse, commitSeed, countFace, FACES, newSeed, proofCommit, proofDice, proofHouseCommit, proveCount, rollDice } from './fair.js';
import { compareBids, faceWord, labelBid, nextBidAbove, normalizeBid } from './dice.js';

export const DEFAULTS = {
  seats: 4, // a table setting: 2 to 6
  minSeats: 2,
  maxSeats: 6,
  dice: 5,
  startChips: 100,
  ante: 5, // table settings, for future tiers
  raiseLimit: 25,
  potLimit: 500,
  liarCostsMatch: false, // true: calling Liar also pays any raise you haven't matched. Off: the call is free, the chips in are at risk
  turnMs: 60_000,
  lobbyMs: 30_000,
  roundGapMs: 30_000,
  botDelayMs: [1500, 3000],
  idleMs: 30 * 60_000,
  waitingIdleMs: 24 * 60 * 60_000,
  awayStandMs: 30 * 60_000,
  resitMs: 30 * 60_000,
  logMax: 200,
};

export const HOUSE_NAME = 'Tally · house';
// Up to five house bots for a six-seat table. The first three have painted sprites of their own; the two new regulars
// borrow a look from the avatar set.
export const BOTS = [
  { name: HOUSE_NAME, avatar: null },
  { name: 'Brannock', avatar: null },
  { name: 'Old Wick', avatar: null },
  { name: 'Red Mab', avatar: 'pirate' },
  { name: 'Sister Ivy', avatar: 'mage' },
];
export const BOT_NAMES = BOTS.map((b) => b.name);
const RESERVED_NAMES = new Set([...BOT_NAMES, 'Tally', 'Halfhand (house)'].map((name) => name.toLowerCase()));
export const isReservedName = (name) => RESERVED_NAMES.has(name.toLowerCase());
export const ACTIONS = ['bid', 'liar', 'fold', 'reveal', 'next', 'back'];
export const MODES = ['prove', 'show'];

const ROUND_PHASES = ['seal', 'bid', 'duel']; // seal: only at a proof table, while the cups go on chain
export const inRound = (s) => ROUND_PHASES.includes(s.phase);

/**
 * The most one seat can lose in one round, for the cage. The pot never passes potLimit (a raise must fit even if
 * everyone still in matched it), and the other seats' antes are in that pot, so one seat can't have paid more than
 * the rest. scripts/dice-round-cap.js plays the worst round through the engine; the test holds the two together.
 */
export const roundCap = (cfg = DEFAULTS, seats = cfg.seats) => cfg.potLimit - (seats - 1) * cfg.ante;

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
    phase: 'lobby', // lobby | seal (proof tables) | bid | duel | settled | over
    round: 0,
    starter: -1,
    pot: 0,
    seats: [], // { name, bot, kind, avatar, chips, rep: { called, proven, caught, open } }
    status: [], // per seat: in | folded | out
    dice: [], // per seat, this round. Never public.
    seeds: [], // per seat, this round: the player's secret, hex. Never public unless that seat shows.
    commits: [], // per seat: H(seed). Public from the deal.
    houseSeed: null, // this round's house secret. Public once the round ends.
    houseCommit: null,
    bid: null, // the standing bid: { seat, count, face }
    turn: null,
    owed: [], // per seat: raises made since they last bid, which they match to bid again
    duel: null, // { bidder, caller, bid, waiting: [seat], modes: { seat: prove | show } }
    lastDuel: null, // public record of the last call
    lastResult: null,
    overReason: null,
    overCode: null,
    overRound: null,
    overAt: null,
    log: [],
    houseStaked: 0, // play chips the house has put in to buy its bots back in, all told. Stays 0 on a tNIGHT table.
    logN: 0,
    deadline: null,
    clockFrom: null,
    lastHumanAt: null,
    chipLog: [],
    chipN: 0,
    carried: 0,
    potIn: [],
    botDue: {},
    talkQueue: [],
    departures: [],
  };
}

// ---------- helpers ----------

const seatIds = (s) => s.seats.map((_, i) => i);
const isActive = (s, seat) => s.status[seat] === 'in';
const activeSeats = (s) => seatIds(s).filter((i) => isActive(s, i));
const dealtSeats = (s) => seatIds(s).filter((i) => s.status[i] === 'in' || s.status[i] === 'folded');
export const totalDice = (s) => dealtSeats(s).length * s.cfg.dice;

function say(s, text, extra = {}) {
  s.logN += 1;
  s.log.push({ n: s.logN, round: s.round, text, ...extra });
  if (s.log.length > s.cfg.logMax) s.log.splice(0, s.log.length - s.cfg.logMax);
  return s.log.at(-1);
}

export const addLog = say;
export const addTalk = (s, seat, text) => say(s, text, { say: true, seat, name: s.seats[seat].name });
const nameOf = (s, seat) => s.seats[seat].name;

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

function chipMove(s, kind, from, to, amount) {
  if (amount <= 0) return;
  s.chipN = (s.chipN ?? 0) + 1;
  s.chipLog.push({ n: s.chipN, kind, from, to, amount });
  if (s.chipLog.length > 40) s.chipLog.shift();
}

function takeChips(s, seat, amount) {
  const paid = Math.min(s.seats[seat].chips, amount);
  s.seats[seat].chips -= paid;
  return paid;
}

function payIn(s, seat, amount, kind) {
  const paid = takeChips(s, seat, amount);
  s.pot += paid;
  s.potIn[seat] = (s.potIn[seat] ?? 0) + paid;
  chipMove(s, kind, seat, 'pot', paid);
  return paid;
}

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
  s.lastResult = { round: s.round, kind: 'returned', pot, awards };
  say(s, `The pot of ${pot} goes back: ${awards.map((a) => `${nameOf(s, a.seat)} ${a.amount}`).join(', ')}.`);
}

const humanSeats = (s) => s.seats.filter((x) => !x.bot && !x.left);
export const isSolo = (s) => humanSeats(s).length <= 1;

const touch = (s, ctx, ms = s.cfg.turnMs) => {
  s.clockFrom = ctx.now;
  s.deadline = isSolo(s) ? null : ctx.now + ms;
};

export function currentTurn(s) {
  return s.phase === 'bid' ? s.turn : null;
}

export function waitingOn(s) {
  if (s.phase === 'duel') return s.proof ? [] : [...s.duel.waiting]; // at a proof table the chain's windows keep the time, not this clock
  const turn = currentTurn(s);
  return turn === null || turn === undefined ? [] : [turn];
}

/** What the pot would be if everyone still in matched everything they owe. A raise must keep this within the limit. */
const exposure = (s) => s.pot + activeSeats(s).reduce((sum, i) => sum + (s.owed[i] ?? 0), 0);

/** The most this seat could raise now, and why it's no more: the pot limit, the raise limit, or their chips. */
export function raiseRoom(s, seat) {
  const active = activeSeats(s).length;
  const room = Math.max(0, Math.floor((s.cfg.potLimit - exposure(s)) / Math.max(1, active)));
  const chips = Math.max(0, s.seats[seat].chips - (s.owed[seat] ?? 0));
  const max = Math.min(s.cfg.raiseLimit, room, chips);
  return { max, potLimitReached: room < 1, limitedBy: max === room ? 'pot' : max === s.cfg.raiseLimit ? 'raise' : 'chips' };
}

// ---------- lobby ----------

function addSeat(s, name, bot, { kind = 'agent', avatar = 'adventurer', chips = s.cfg.startChips } = {}) {
  s.seats.push({ name, bot, kind: bot ? 'house' : kind, avatar: bot ? avatar : avatar, chips, rep: { called: 0, proven: 0, caught: 0, open: 0 } });
  say(s, `${name} sits down at seat ${s.seats.length - 1}.`);
  return s.seats.length - 1;
}

export function fillBots(s) {
  const taken = new Set(s.seats.map((x) => x.name));
  for (const bot of BOTS) {
    if (s.seats.length >= s.cfg.seats) break;
    if (!taken.has(bot.name)) addSeat(s, bot.name, true, { avatar: bot.avatar });
  }
}

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
  'Red Mab': 'The house refloats me. Back to the tide, lads.',
  'Sister Ivy': 'A small loan from the house. I shall count it carefully.',
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

/** The deal: antes, then every cup is shaken from two sealed secrets. */
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
  if (eligible.length < 2 || !eligible.some((i) => !s.seats[i].bot)) {
    s.deadline = null;
    return;
  }

  s.round += 1;
  s.status = seatIds(s).map((i) => (eligible.includes(i) ? 'in' : 'out'));
  s.starter = s.starter < 0 ? eligible[0] : orderFrom(s, s.starter + 1)[0];
  s.carried = s.pot;
  for (const i of eligible) payIn(s, i, ante, 'ante');
  if (s.proof) return sealRound(s, eligible, ctx);

  s.houseSeed = newSeed(ctx.rng);
  s.houseCommit = commitHouse(s.houseSeed);
  s.seeds = seatIds(s).map(() => null);
  s.commits = seatIds(s).map(() => null);
  s.dice = seatIds(s).map(() => []);
  for (const i of eligible) {
    s.seeds[i] = newSeed(ctx.rng);
    s.commits[i] = commitSeed(s.seeds[i]);
    s.dice[i] = rollDice(s.houseSeed, s.seeds[i], i, s.round, s.cfg.dice);
  }

  s.bid = null;
  s.owed = seatIds(s).map(() => 0);
  s.duel = null;
  s.phase = 'bid';
  s.turn = s.starter;
  say(s, `Round ${s.round}. Cups shaken: ${totalDice(s)} dice on the table. ${nameOf(s, s.starter)} opens. Pot ${s.pot} after antes.`);
  touch(s, ctx);
}

function finishRound(s, result, ctx) {
  if (s.proof) s.proof.stage = 'done';
  s.lastResult = { round: s.round, ...result, stakes: [...(s.lastStakes ?? [])] }; // what each seat had in: its net is its award less this
  s.phase = 'settled';
  s.turn = null;
  s.duel = null;
  touch(s, ctx, s.cfg.roundGapMs);
  for (const seat of seatIds(s)) if (s.seats[seat].leaving) depart(s, seat);
}

function uncontested(s, ctx) {
  const [seat] = activeSeats(s);
  const pot = s.pot;
  s.lastStakes = seatIds(s).map((i) => s.potIn[i] ?? 0);
  s.seats[seat].chips += pot;
  s.pot = 0;
  s.carried = 0;
  s.potIn = [];
  chipMove(s, 'win', 'pot', seat, pot);
  say(s, `Everyone else folded. ${nameOf(s, seat)} takes the pot of ${pot} uncontested.`);
  finishRound(s, { kind: 'uncontested', pot, awards: [{ seat, amount: pot }] }, ctx);
}

/**
 * Who gets what when a Liar call is settled (the "loser pays" rule). The loser of the call forfeits their stake, and so does
 * every seat that folded. Everyone else still in gets their own stake back, plus an equal share of what was forfeited; a
 * caller who was right counts CALLER_SHARES shares, so a right call pays more than standing by. With two players the one
 * other seat takes everything, which is exactly the old "winner takes the pot".
 */
export const CALLER_SHARES = 2;

function settleCall(s, { bidder, caller, held }) {
  const winner = held ? bidder : caller;
  const loser = held ? caller : bidder;
  const stake = (i) => s.potIn[i] ?? 0;
  const rest = activeSeats(s).filter((i) => i !== loser);
  if (!isActive(s, loser) || rest.length === 0) return { winner, loser, pool: s.pot, awards: [{ seat: winner, amount: s.pot, back: 0, share: s.pot }] };
  const pool = s.pot - rest.reduce((sum, i) => sum + stake(i), 0);
  const weight = (i) => (!held && i === caller ? CALLER_SHARES : 1);
  const total = rest.reduce((sum, i) => sum + weight(i), 0);
  const exact = rest.map((i) => (pool * weight(i)) / total);
  const shares = exact.map(Math.floor);
  const byRemainder = rest.map((_, k) => k).sort((a, b) => exact[b] - shares[b] - (exact[a] - shares[a]) || a - b);
  for (let spare = pool - shares.reduce((sum, x) => sum + x, 0), k = 0; spare > 0; spare--, k++) shares[byRemainder[k % rest.length]] += 1;
  const awards = rest.map((seat, k) => ({ seat, amount: stake(seat) + shares[k], back: stake(seat), share: shares[k], ...(!held && seat === caller ? { bonus: true } : {}) }));
  return { winner, loser, pool, awards: awards.filter((a) => a.amount > 0) };
}

/**
 * Every cup has answered. The count is added up across the whole table, wilds included: a shown cup from its dice,
 * a shut cup from its proof. The bid holds or it doesn't, and the loser of the call pays (see settleCall).
 */
function resolveDuel(s, ctx) {
  const { bidder, caller, bid, modes } = s.duel;
  const reveals = dealtSeats(s).map((seat) => {
    const mode = modes[seat] ?? 'prove';
    const count = countFace(s.dice[seat], bid.face);
    const base = { seat, mode, count, commit: s.commits[seat], folded: s.status[seat] === 'folded' };
    if (mode === 'show') return { ...base, dice: [...s.dice[seat]], seed: s.seeds[seat] };
    return { ...base, proof: proveCount({ dice: s.dice[seat], face: bid.face, commit: s.commits[seat], houseSeed: s.houseSeed, seat, round: s.round }) };
  });
  const total = reveals.reduce((sum, r) => sum + r.count, 0);
  const held = total >= bid.count;
  const rep = s.seats[bidder].rep;
  rep.called += 1;
  if (held) rep.proven += 1;
  else rep.caught += 1;
  const pot = s.pot;
  s.lastStakes = seatIds(s).map((i) => s.potIn[i] ?? 0); // what each seat had in, for the round's public record
  const { winner, loser, pool, awards } = settleCall(s, { bidder, caller, held });
  const loserStake = s.lastStakes[loser] ?? 0;
  for (const a of awards) {
    s.seats[a.seat].chips += a.amount;
    chipMove(s, 'win', 'pot', a.seat, a.amount);
  }
  s.pot = 0;
  s.carried = 0;
  s.potIn = [];
  const verdict = `The table shows ${total} ${faceWord(bid.face, total !== 1)}, wilds counted. The bid (${labelBid(bid)}) ${held ? 'HOLDS' : 'FALLS'}`;
  if (awards.length === 1) say(s, `${verdict}: ${nameOf(s, winner)} takes the pot of ${pot}.`);
  else {
    const split = awards.map((a) => `${nameOf(s, a.seat)} ${a.amount}${a.bonus ? ' (double share, right call)' : ''}`).join(', ');
    say(s, `${verdict}: ${nameOf(s, loser)} pays. The pot of ${pot}: everyone else still in gets their stake back and splits ${pool} (${nameOf(s, loser)}'s ${loserStake}${pool > loserStake ? ' and the folders\'' : ''}). ${split}.`);
  }
  s.lastDuel = { round: s.round, bid, bidder, caller, total, held, winner, loser, pot, reveals, houseSeed: s.houseSeed, houseCommit: s.houseCommit };
  finishRound(s, { kind: 'duel', pot, awards, loser, loserStake, pool, bid, total, held, bidder, caller }, ctx);
}

// ---------- actions ----------

function needPhase(s, action, ...phases) {
  if (!phases.includes(s.phase)) throw new RuleError('wrong_phase', `Can't ${action} during the ${s.phase} phase (legal in: ${phases.join(', ')}).`);
}

function needTurn(s, seat, action) {
  const turn = currentTurn(s);
  if (turn !== seat) throw new RuleError('not_your_turn', `Can't ${action}: it is seat ${turn}'s turn.`);
}

const HANDLERS = {
  bid(s, seat, a, ctx) {
    needPhase(s, 'bid', 'bid');
    needTurn(s, seat, 'bid');
    const bid = normalizeBid(a);
    if (!bid) throw new RuleError('bad_bid', `A bid is { count, face }: count 1 or more, face one of ${FACES.join(', ')}. 1s are wild.`, 400);
    if (bid.count > totalDice(s)) throw new RuleError('bad_bid', `There are only ${totalDice(s)} dice on the table.`, 400);
    if (s.bid && compareBids(bid, s.bid) <= 0) throw new RuleError('bid_too_low', `Must beat ${labelBid(s.bid)}: bid more dice, or the same number of a higher die.`);
    const owed = s.owed[seat] ?? 0;
    if (s.seats[seat].chips < owed) throw new RuleError('short_stack', `You owe ${owed} chips to stay in, and need them to bid; you have ${s.seats[seat].chips}. Fold or call Liar.`);
    const raise = a.raise ?? 0;
    if (!Number.isInteger(raise) || raise < 0) throw new RuleError('bad_raise', 'raise must be a whole number of chips, 0 or more.', 400);
    if (raise > 0) {
      const room = raiseRoom(s, seat);
      if (room.potLimitReached) throw new RuleError('pot_limit', `Pot limit reached: no raises past ${s.cfg.potLimit}.`);
      if (room.max < 1) throw new RuleError('no_chips', 'You have no chips to raise with.');
      if (raise > room.max) throw new RuleError('bad_raise', `Raise must be 1 to ${room.max}${room.limitedBy === 'pot' ? ' (the pot limit)' : ''}.`, 400);
    }
    if (owed > 0) {
      payIn(s, seat, owed, 'match');
      s.owed[seat] = 0;
    }
    if (raise > 0) {
      payIn(s, seat, raise, 'raise');
      for (const other of activeSeats(s)) if (other !== seat) s.owed[other] = (s.owed[other] ?? 0) + raise;
    }
    s.bid = { seat, ...bid };
    const parts = [`${nameOf(s, seat)} bids ${labelBid(bid)}`];
    if (owed > 0) parts.push(`pays ${owed} to stay in`);
    if (raise > 0) parts.push(`raises ${raise}`);
    say(s, `${parts.join(', ')}.`, { bid: { seat, count: bid.count, face: bid.face } }); // tagged, so a page can list the round's bids
    s.turn = nextActive(s, seat);
    touch(s, ctx);
  },

  liar(s, seat, a, ctx) {
    needPhase(s, 'liar', 'bid');
    needTurn(s, seat, 'liar');
    if (!s.bid) throw new RuleError('no_bid', 'Nobody has bid yet. Open with a bid.');
    const owed = s.owed[seat] ?? 0;
    if (s.cfg.liarCostsMatch && owed > 0) {
      if (s.seats[seat].chips < owed) throw new RuleError('short_stack', `Calling Liar here costs ${owed}, what you owe to stay in; you have ${s.seats[seat].chips}.`);
      payIn(s, seat, owed, 'match');
      s.owed[seat] = 0;
    }
    const waiting = s.proof ? dealtSeats(s) : activeSeats(s); // the chain counts every cup dealt, so a folded seat answers too
    s.duel = { bidder: s.bid.seat, caller: seat, bid: { count: s.bid.count, face: s.bid.face }, waiting, modes: {} };
    s.phase = 'duel';
    s.turn = null;
    say(s, `${nameOf(s, seat)} calls LIAR on ${nameOf(s, s.bid.seat)}'s bid, ${labelBid(s.bid)}! Every cup answers: keep it shut, or show.`);
    if (s.proof) {
      s.proof.stage = 'calling';
      s.deadline = null;
      return;
    }
    touch(s, ctx);
  },

  fold(s, seat, a, ctx) {
    needPhase(s, 'fold', 'bid');
    needTurn(s, seat, 'fold');
    if (!s.bid) throw new RuleError('no_bid', "Nobody has bid yet, so there's nothing to fold from. Open with a bid.");
    s.status[seat] = 'folded';
    say(s, `${nameOf(s, seat)} folds. The cup stays on the table, shut.`);
    if (activeSeats(s).length === 1) return uncontested(s, ctx);
    s.turn = nextActive(s, seat);
    touch(s, ctx);
  },

  reveal(s, seat, a, ctx) {
    needPhase(s, 'reveal', 'duel');
    if (!s.duel.waiting.includes(seat)) throw new RuleError('already_chosen', 'You have already answered for your cup.');
    if (!MODES.includes(a.mode)) throw new RuleError('bad_mode', `mode must be "prove" (cup stays shut, only your count goes out) or "show" (dice shown).`, 400);
    s.duel.modes[seat] = a.mode;
    if (s.proof) return; // only says what this seat is doing: its answer counts when the chain has it
    s.duel.waiting = s.duel.waiting.filter((x) => x !== seat);
    if (a.mode === 'show') {
      s.seats[seat].rep.open += 1;
      say(s, `${nameOf(s, seat)} lifts the cup: show and prove.`);
    } else {
      say(s, `${nameOf(s, seat)} keeps the cup shut: only the count goes out.`);
    }
    if (s.duel.waiting.length === 0) return resolveDuel(s, ctx);
    touch(s, ctx);
  },
};

function depart(s, seat) {
  const x = s.seats[seat];
  if (humanSeats(s).every((other) => other === x)) returnPot(s);
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

function addChipsRefusal(s, seat) {
  const x = s.seats[seat];
  if (x.left || x.leaving) return 'You are leaving this table.';
  if (x.away) return 'You are marked away. Come back first.';
  if (!['lobby', 'settled'].includes(s.phase)) return 'You can only add chips between rounds.';
  return null;
}

export function checkAddChips(s, seat, amount) {
  if (!Number.isInteger(amount) || amount < 1) throw new RuleError('bad_amount', 'amount must be a whole number of chips, at least 1.', 400);
  const refusal = addChipsRefusal(s, seat);
  if (refusal) throw new RuleError('not_between_rounds', refusal);
}

export function addChips(s, seat, amount, ctx) {
  const x = s.seats[seat];
  x.chips += amount;
  s.lastHumanAt = ctx.now;
  say(s, `${x.name} adds ${amount} chips.`);
}

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

/** Nothing to upgrade yet: the first saved tables are on these rules. */
export function upgradeState() {
  return false;
}

function nextRound(s, seat, ctx) {
  if (s.phase !== 'settled') throw new RuleError('wrong_phase', 'The next round can only be dealt when this one is over.');
  if (s.seats[seat].left) throw new RuleError('already_left', 'You have already left this table.');
  if (!s.seats[seat].bot) s.lastHumanAt = ctx.now;
  startRound(s, ctx);
}

export function act(s, seat, action, ctx) {
  const type = action?.action;
  if (!ACTIONS.includes(type)) throw new RuleError('bad_action', `action must be one of: ${ACTIONS.join(', ')}.`, 400);
  if (type === 'back') return comeBack(s, seat, ctx);
  if (s.seats[seat].away && !ctx.auto) throw new RuleError('away', 'You are marked away. Send { "action": "back" } first.');
  if (type === 'next') return nextRound(s, seat, ctx);
  if (!inRound(s)) throw new RuleError('no_round', `No round in play (phase: ${s.phase}).`);
  if (!isActive(s, seat) && !(s.proof && s.phase === 'duel')) throw new RuleError('not_in_round', 'You have folded or are sitting out this round.');
  HANDLERS[type](s, seat, action, ctx);
  if (!ctx.auto && !s.seats[seat].bot) s.lastHumanAt = ctx.now;
  playAutoSeats(s, ctx);
}

function comeBack(s, seat, ctx) {
  const x = s.seats[seat];
  if (!x.away) throw new RuleError('not_away', 'You are not marked away.');
  x.away = false;
  x.awaySince = null;
  if (x.standing) {
    x.standing = false;
    x.leaving = false;
  }
  s.lastHumanAt = ctx.now;
  say(s, `${x.name} is back.`);
  if (s.phase === 'settled' && s.deadline === null) touch(s, ctx, s.cfg.roundGapMs);
}

function playAutoSeats(s, ctx) {
  const auto = { ...ctx, auto: true };
  for (let guard = 0; guard < 200; guard++) {
    if (!inRound(s)) return;
    const seat = waitingOn(s).find((i) => !s.seats[i].bot && (s.seats[i].away || (s.seats[i].leaving && isSolo(s))));
    if (seat === undefined) return;
    act(s, seat, autoAction(s, seat, ctx), auto);
  }
}

/** The move made for someone who isn't there: the cup stays shut, a standing bid is folded to, an empty table gets the lowest bid. */
export function autoAction(s, seat) {
  if (s.phase === 'duel') return { action: 'reveal', mode: 'prove' };
  if (s.bid) return { action: 'fold' };
  return { action: 'bid', ...nextBidAbove(null) };
}

function markAway(s, seat, ctx) {
  if (s.seats[seat].bot) return;
  s.seats[seat].away = true;
  s.seats[seat].awaySince ??= ctx.now;
  say(s, `${nameOf(s, seat)} timed out and is marked away.`);
}

const awayLimit = (s) => s.cfg.awayStandMs ?? DEFAULTS.awayStandMs;
const awaySeats = (s) => seatIds(s).filter((i) => s.seats[i].away && !s.seats[i].left && !s.seats[i].leaving && !s.seats[i].bot);

/** A chips seat left untouched at a solo table stands up after awayStandMs with no move of theirs (The owner, 11-07). See sealed-hand/engine.js. */
function soloIdleStandAt(s) {
  if (s.cage || s.phase === 'over' || !isSolo(s) || s.lastHumanAt == null) return null;
  const human = humanSeats(s).find((x) => !x.leaving && !x.standing);
  return human ? Math.max(s.lastHumanAt, s.soloSince ?? 0) + awayLimit(s) : null; // from their last move, or from when the table went solo under them
}

export function nextStandAt(s) {
  if (s.phase === 'over') return null;
  const times = isSolo(s) ? [] : awaySeats(s).map((i) => s.seats[i].awaySince + awayLimit(s));
  const solo = soloIdleStandAt(s);
  if (solo !== null) times.push(solo);
  return times.length ? Math.min(...times) : null;
}

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
  if (s.phase === 'seal') { // only a proof table's wait for a page's answer has a deadline in this phase
    proofHoldersReady(s, ctx);
    return true;
  }
  const auto = { ...ctx, auto: true };
  if (s.phase === 'lobby') startGame(s, ctx);
  else if (s.phase === 'settled') startRound(s, ctx);
  else if (s.phase === 'duel') {
    for (const seat of waitingOn(s)) {
      if (s.phase !== 'duel') break;
      markAway(s, seat, ctx);
      if (s.seats[seat].bot) act(s, seat, autoAction(s, seat), auto);
    }
    playAutoSeats(s, ctx);
  } else if (inRound(s)) {
    const seat = currentTurn(s);
    markAway(s, seat, ctx);
    if (s.seats[seat].bot) act(s, seat, autoAction(s, seat), auto);
    else playAutoSeats(s, ctx);
  }
  return true;
}

// ---------- views ----------

/** Everything a spectator may see. Whitelisted: never add dice, seeds or the house seed of a running round here. */
export function publicView(s) {
  const turn = currentTurn(s);
  return {
    phase: s.phase,
    round: s.round,
    starter: s.starter,
    pot: s.pot,
    carried: s.carried ?? 0,
    chipLog: s.chipLog ?? [],
    turn: turn ?? null,
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
      owed: s.phase === 'bid' && isActive(s, seat) ? s.owed[seat] ?? 0 : 0,
      cup: s.status[seat] === 'in' || s.status[seat] === 'folded' ? s.cfg.dice : 0, // dice under the cup: how many, never which
      left: !!x.left,
      leftWith: x.leftWith ?? null,
      leaving: !!x.leaving,
      away: !!x.away,
    })),
    totalDice: inRound(s) ? totalDice(s) : 0,
    bid: s.bid ? { ...s.bid, label: labelBid(s.bid) } : null,
    raiseRoom: s.phase === 'bid' && turn !== null ? raiseRoom(s, turn) : null,
    duel: s.duel ? { bidder: s.duel.bidder, caller: s.duel.caller, bid: { ...s.duel.bid, label: labelBid(s.duel.bid) }, waiting: [...s.duel.waiting], modes: { ...s.duel.modes } } : null,
    lastDuel: s.lastDuel,
    ...(s.proof ? { proof: proofView(s) } : {}),
    fair: inRound(s) || s.phase === 'settled' ? { houseCommit: s.houseCommit, commits: [...s.commits], opened: s.phase === 'settled' || (s.proof && s.proof.salt) ? s.houseSeed : null } : null,
    lastResult: s.lastResult,
    overCode: s.overCode ?? null,
    overReason: s.overReason,
    overRound: s.overRound ?? null,
    limits: { ante: s.cfg.ante, raiseLimit: s.cfg.raiseLimit, potLimit: s.cfg.potLimit, dice: s.cfg.dice, faces: FACES, liarCostsMatch: s.cfg.liarCostsMatch, turnMs: s.cfg.turnMs },
    houseStaked: s.houseStaked ?? 0,
    log: s.log,
  };
}

export function legalActions(s, seat) {
  if (s.phase !== 'over' && s.seats[seat].away) return [{ action: 'back' }];
  if (s.phase === 'settled') return s.seats[seat].left ? [] : [{ action: 'next' }];
  if (s.proof && s.phase === 'duel') return s.duel.waiting.includes(seat) ? [{ action: 'reveal', modes: [...MODES], bid: { ...s.duel.bid, label: labelBid(s.duel.bid) }, folded: s.status[seat] === 'folded', ready: s.proof.stage === 'answering' && s.proof.houseDone }] : [];
  if (!inRound(s) || !isActive(s, seat)) return [];
  const out = [];
  if (s.phase === 'duel') {
    if (s.duel.waiting.includes(seat)) out.push({ action: 'reveal', modes: [...MODES], bid: { ...s.duel.bid, label: labelBid(s.duel.bid) } });
    return out;
  }
  if (currentTurn(s) !== seat) return out;
  const owed = s.owed[seat] ?? 0;
  const chips = s.seats[seat].chips;
  if (chips >= owed) {
    const room = raiseRoom(s, seat);
    out.push({
      action: 'bid',
      above: s.bid ? { count: s.bid.count, face: s.bid.face, label: labelBid(s.bid) } : null,
      lowest: nextBidAbove(s.bid),
      maxCount: totalDice(s),
      faces: FACES,
      owed, // paid when you bid
      raise: { min: room.max >= 1 ? 1 : 0, max: room.max, potLimitReached: room.potLimitReached, limitedBy: room.limitedBy },
    });
  }
  if (s.bid) {
    const cost = s.cfg.liarCostsMatch ? owed : 0;
    if (chips >= cost) out.push({ action: 'liar', bid: { count: s.bid.count, face: s.bid.face, label: labelBid(s.bid) }, seat: s.bid.seat, cost });
    out.push({ action: 'fold' });
  }
  return out;
}

/** The owner's view of their own cup. */
export function privateView(s, seat) {
  const dice = s.dice[seat] ?? [];
  const dealt = s.status[seat] === 'in' || s.status[seat] === 'folded';
  return {
    seat,
    name: s.seats[seat].name,
    dice: dealt ? [...dice] : [],
    counts: dealt ? Object.fromEntries(FACES.map((face) => [face, countFace(dice, face)])) : null, // with wilds
    commit: dealt ? s.commits[seat] : null,
    owed: s.phase === 'bid' ? s.owed[seat] ?? 0 : 0,
    myBid: !!s.bid && s.bid.seat === seat,
    mode: s.duel?.modes[seat] ?? null,
    ...(s.proof ? { proof: { needSeal: s.proof.stage === 'holders' && s.status[seat] === 'in' && !s.proof.preseals[seat] && !s.seats[seat].bot, sealed: !!s.commits[seat], stage: s.proof.stage } } : {}),
    legal: legalActions(s, seat),
    canAddChips: addChipsRefusal(s, seat) === null,
    broke: s.seats[seat].chips < s.cfg.ante, // between rounds, a play-chip seat that can't ante: the page offers Fill up
    canFillUp: !s.cage && addChipsRefusal(s, seat) === null,
    canLeave: s.phase !== 'over' && !s.seats[seat].left,
    leaving: !!s.seats[seat].leaving,
    away: !!s.seats[seat].away,
  };
}

// ---------- proof tables: the dice are checked on chain. Only with the flag on: see openTable in index.js. ----------
//
// What changes. The server makes the house's seed and its bots' seeds, as ever, and never gets a player's: the player's page makes that
// one, seals it from the player's own wallet, and works out its own dice. So `s.dice` stays empty for a person, and at a call the server
// has no count of theirs. It waits for what the chain says. The dice-house service does the house's side on chain and reports here.
//
//   seal, stage holders    each player's page names its key and the hash of the seal it will post. No wallet: this is a line to the server.
//   seal, stage opening    dice-house posts openRound: the house's seed, its bots' seeds and those hashes are all fixed
//   seal, stage sealing    each player's page posts that seal from its wallet
//   seal, stage revealing  dice-house opens the seed. Everyone who sealed is dealt in
//   bid,  stage play       bidding, on this server, as at any table
//   duel, stage calling    dice-house posts the bid that was called
//   duel, stage answering  dice-house answers for the bots, then each player's page answers from its wallet
//   settled, stage done    dice-house posted finish, and the chain's answer settles the pot

const HOLDERS_WAIT_MS = 60_000;
export const newProof = (address) => ({ address, stage: null, holders: {}, preseals: {}, salt: null, sealBy: null, openBy: null, callBy: null, houseBy: null, answerBy: null, houseDone: false, answers: {}, tx: {}, alert: null, chainRound: null });

function sealRound(s, eligible, ctx) {
  const { table } = s.cage;
  const round = s.round + (s.cage.chainBase ?? 0);
  s.houseSeed = newSeed(ctx.rng);
  s.houseCommit = proofHouseCommit(s.houseSeed, table, round);
  s.seeds = seatIds(s).map(() => null);
  s.commits = seatIds(s).map(() => null);
  s.dice = seatIds(s).map(() => []);
  for (const i of eligible) {
    if (!s.seats[i].bot) continue;
    s.seeds[i] = newSeed(ctx.rng);
    s.commits[i] = proofCommit(s.seeds[i], table, round, i, s.proof.address);
  }
  Object.assign(s.proof, { chainRound: round, stage: 'holders', preseals: {}, salt: null, sealBy: null, openBy: null, callBy: null, houseBy: null, answerBy: null, houseDone: false, answers: {}, tx: {}, alert: null });
  s.bid = null;
  s.owed = seatIds(s).map(() => 0);
  s.duel = null;
  s.phase = 'seal';
  s.turn = null;
  s.deadline = ctx.now + (s.cfg.holdersWaitMs ?? HOLDERS_WAIT_MS); // a page that doesn't answer doesn't hold up the table
  say(s, `Round ${s.round}. The cups go on chain before anyone sees a die.`);
  proofHoldersReady(s, ctx);
}

/** Dice-house can post the round once every person in it has named their key and the hash of their seal. */
function proofHoldersReady(s, ctx) {
  if (s.proof.stage !== 'holders') return;
  const missing = seatIds(s).filter((i) => s.status[i] === 'in' && !s.seats[i].bot && !s.proof.preseals[i]);
  if (missing.length === 0) {
    s.proof.stage = 'opening';
    s.deadline = null;
  } else if (ctx.now >= s.deadline) { // never answered: not dealt in, and the ante comes back
    for (const i of missing) proofDropSeat(s, i, 'never answered, so isn\'t dealt in');
    if (activeSeats(s).some((i) => !s.seats[i].bot) && activeSeats(s).length >= 2) {
      s.proof.stage = 'opening';
      s.deadline = null;
    } else proofNoRound(s, 'nobody was there to seal a cup.', ctx);
  }
}

function proofDropSeat(s, seat, why) {
  const ante = s.potIn?.[seat] ?? 0;
  s.seats[seat].chips += ante;
  s.pot -= ante;
  s.potIn[seat] = 0;
  s.status[seat] = 'out';
  chipMove(s, 'refund', 'pot', seat, ante);
  say(s, `${nameOf(s, seat)} ${why}. The ante goes back.`);
}

export function proofSetHolder(s, seat, holder, preseal, ctx) {
  if (s.proof.stage !== 'holders') throw new RuleError('wrong_stage', 'This round isn\'t waiting for a seal\'s hash.');
  if (s.status[seat] !== 'in') throw new RuleError('not_in_round', 'You are not in this round.');
  s.proof.holders[seat] = holder;
  s.proof.preseals[seat] = preseal;
  proofHoldersReady(s, ctx);
}

/** Everything a spectator may see. A proof table's cups and seeds come onto the chain's public record, or not at all. */
export function proofView(s) {
  const p = s.proof;
  return { address: p.address, stage: p.stage, table: s.cage.table, round: p.chainRound, salt: p.salt, sealBy: p.sealBy, openBy: p.openBy, callBy: p.callBy, houseBy: p.houseBy, answerBy: p.answerBy, houseDone: p.houseDone, answers: p.answers, tx: p.tx, alert: p.alert };
}

/** What dice-house needs for this round. Only the judge's token reaches this, and it's the only route that carries the house's seeds. */
export function proofWork(s) {
  const p = s.proof;
  if (!p.stage || p.stage === 'done' || p.stage === 'holders') return null;
  return {
    stage: p.stage, table: s.cage.table, round: p.chainRound, houseSeed: s.houseSeed, houseCommit: s.houseCommit, salt: p.salt, sealBy: p.sealBy, openBy: p.openBy, houseBy: p.houseBy, answerBy: p.answerBy,
    seats: seatIds(s).map((i) => (s.status[i] === 'in' || s.status[i] === 'folded' ? { seat: i, bot: !!s.seats[i].bot, holder: p.holders[i] ?? null, preseal: p.preseals[i] ?? null, commit: s.commits[i], seed: s.seats[i].bot ? s.seeds[i] : null, mode: s.duel?.modes[i] ?? null, answered: !!p.answers[i] } : null)),
    duel: s.duel ? { bidder: s.duel.bidder, caller: s.duel.caller, count: s.duel.bid.count, face: s.duel.bid.face } : null,
  };
}

/** A round that can't go ahead: no die was ever fixed, so everyone's ante goes back. */
function proofNoRound(s, why, ctx) {
  returnPot(s);
  say(s, `No round: ${why}`);
  s.proof.stage = 'done';
  finishRound(s, s.lastResult ?? { kind: 'returned', pot: 0, awards: [] }, ctx);
}

/** What dice-house reports. Each is safe to receive twice. */
export function proofEvent(s, e, ctx) {
  const p = s.proof;
  switch (e.event) {
    case 'opened':
      if (p.stage !== 'opening') break;
      Object.assign(p, { stage: 'sealing', sealBy: e.sealBy, openBy: e.openBy, callBy: e.callBy ?? null });
      p.tx.open = e.hash;
      break;
    case 'sealed':
      if (p.stage !== 'sealing') break;
      for (const [seat, commit] of Object.entries(e.commits ?? {})) s.commits[seat] = commit;
      break;
    case 'revealing':
      if (p.stage === 'sealing') p.stage = 'revealing';
      break;
    case 'revealed': {
      if (p.stage !== 'sealing' && p.stage !== 'revealing') break;
      p.tx.reveal = e.hash;
      if (e.voided) return proofNoRound(s, e.voided, ctx);
      for (const i of seatIds(s)) {
        if (s.status[i] !== 'in') continue;
        const commit = e.commits?.[i] ?? null;
        s.commits[i] = commit;
        if (!commit) proofDropSeat(s, i, 'never sealed a cup, so isn\'t dealt in');
        else if (s.seats[i].bot) s.dice[i] = proofDice(e.salt, s.seeds[i], i);
      }
      if (activeSeats(s).length < 2 || !activeSeats(s).some((i) => !s.seats[i].bot)) return proofNoRound(s, 'too few cups were sealed.', ctx);
      s.houseSeed = e.houseSeed ?? s.houseSeed;
      p.salt = e.salt;
      p.stage = 'play';
      s.phase = 'bid';
      s.turn = isActive(s, s.starter) ? s.starter : nextActive(s, s.starter);
      say(s, `The cups are sealed on chain: ${totalDice(s)} dice on the table, and only each cup's owner can read it. ${nameOf(s, s.turn)} opens. Pot ${s.pot} after antes.`);
      touch(s, ctx);
      break;
    }
    case 'called':
      if (p.stage !== 'calling') break;
      Object.assign(p, { stage: 'answering', houseBy: e.houseBy, answerBy: e.answerBy });
      p.tx.call = e.hash;
      proofHouseDone(s);
      break;
    case 'answer': {
      if (p.stage !== 'answering' || p.answers[e.seat]) break;
      p.answers[e.seat] = { count: e.count, shown: !!e.shown, dice: e.shown ? e.dice : null, hash: e.hash ?? null };
      s.duel.waiting = s.duel.waiting.filter((x) => x !== e.seat);
      s.duel.modes[e.seat] = e.shown ? 'show' : 'prove';
      if (e.shown) s.seats[e.seat].rep.open += 1;
      say(s, e.shown ? `${nameOf(s, e.seat)} lifts the cup. The chain checked the dice against the seal.` : `${nameOf(s, e.seat)} keeps the cup shut. The chain checked the count: ${e.count}.`);
      proofHouseDone(s);
      break;
    }
    case 'house-late':
      if (p.stage === 'answering') p.houseDone = true;
      break;
    case 'finished':
      if (p.stage !== 'answering' && p.stage !== 'calling') break;
      return proofFinished(s, e, ctx);
    case 'alert':
      p.alert = e.message;
      break;
    default:
      break;
  }
  return undefined;
}

function proofHouseDone(s) {
  if (s.duel.waiting.every((i) => !s.seats[i].bot)) s.proof.houseDone = true;
}

/** The chain has added it up. Its answer settles the pot: this server only carries it out. */
function proofFinished(s, e, ctx) {
  const p = s.proof;
  const { bidder, caller, bid } = s.duel;
  const pot = s.pot;
  p.tx.finish = e.hash;
  p.stage = 'done';
  const reveals = dealtSeats(s).map((seat) => {
    const a = p.answers[seat];
    const base = { seat, commit: s.commits[seat], folded: s.status[seat] === 'folded' };
    if (!a) return { ...base, mode: 'silent', count: null };
    if (a.shown) return { ...base, mode: 'show', count: a.count, dice: a.dice, proof: { kind: 'compact-proof', hash: a.hash } };
    return { ...base, mode: 'prove', count: a.count, proof: { kind: 'compact-proof', hash: a.hash } };
  });
  const silent = reveals.filter((r) => r.mode === 'silent');
  for (const r of silent) say(s, `${nameOf(s, r.seat)} never answered, and the window closed.`);
  if (e.verdict === 'voided') {
    for (const r of silent) if (s.potIn) s.potIn[r.seat] = 0; // a silent seat's stake is shared among the rest
    s.lastDuel = { round: s.round, bid, bidder, caller, total: e.total, held: null, winner: null, pot, reveals, houseSeed: s.houseSeed, houseCommit: s.houseCommit, why: e.why, voided: true, finish: e.hash };
    say(s, 'The chain voids the round: the count can\'t be finished without the silent cups.');
    returnPot(s);
    return finishRound(s, { kind: 'returned', pot, awards: s.lastResult?.awards ?? [], bid, total: e.total, why: e.why }, ctx);
  }
  const held = e.verdict === 'holds';
  const rep = s.seats[bidder].rep;
  rep.called += 1;
  if (held) rep.proven += 1;
  else rep.caught += 1;
  const winner = held ? bidder : caller;
  s.seats[winner].chips += pot;
  s.pot = 0;
  s.carried = 0;
  s.potIn = [];
  chipMove(s, 'win', 'pot', winner, pot);
  say(s, `The chain counts ${e.total} ${faceWord(bid.face, e.total !== 1)}, wilds included. The bid (${labelBid(bid)}) ${held ? 'HOLDS' : 'FALLS'}: ${nameOf(s, winner)} takes the pot of ${pot}.`);
  s.lastDuel = { round: s.round, bid, bidder, caller, total: e.total, held, winner, pot, reveals, houseSeed: s.houseSeed, houseCommit: s.houseCommit, why: e.why, finish: e.hash };
  return finishRound(s, { kind: 'duel', pot, awards: [{ seat: winner, amount: pot }], bid, total: e.total, held, bidder, caller }, ctx);
}
