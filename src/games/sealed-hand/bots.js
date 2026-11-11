// House bots, following the prototype's logic. A bot decides from publicView, its own hand and the cards
// it was passed, and never sees the full state, so it can't peek at another hand even by accident.

import { DEFAULTS, HOUSE_NAME, act, addLog, addTalk, autoAction, inRound, publicView, waitingOn } from './engine.js';
import { CAT, LADDER, bestClaim, compareClaims, contains, rankOf, suitOf } from './cards.js';

// Tally is patient, Brannock is aggressive, Old Wick rarely bluffs. `pass` is how often a bot passes in each style other
// than the plain one: see passChoice. Tuned in scripts/sim.js, which reports how often the passed card is the lowest.
export const PERSONAS = {
  [HOUSE_NAME]: { bluff: 0.18, doubt: 0.30, pass: { builder: 0.22, mid: 0.11, good: 0.04 } },
  Brannock: { bluff: 0.38, doubt: 0.22, pass: { builder: 0.17, mid: 0.18, good: 0.09 } },
  'Old Wick': { bluff: 0.07, doubt: 0.36, pass: { builder: 0.28, mid: 0.05, good: 0.01 } },
};

// Scripted table talk, and the fallback whenever an AI line can't be used. A line depends only on the kind
// of move, never on the hand or on whether a claim is true, so it gives nothing away.
export const VOICES = {
  [HOUSE_NAME]: {
    raise: ['A little more for the ledger.', 'No hurry. The count goes up.'],
    claim: ['Mark that down, then.', "I don't chalk what I can't carry."],
    call: ['The count says show me.', 'Patience. Now prove it.'],
  },
  Brannock: {
    raise: ['Another round on me! Well, on you.', 'Drink up and pay up, friends!', "Too rich? I'll keep your stool warm."],
    claim: ['Beat that and I sing at your wedding!', 'Ha! Top that, you lovely lot.', 'Write that one on the slate, barkeep!'],
    call: ["Let's see it, friend, or the next ale's yours!", "I've heard better tales from my mule!", 'Oh, I love a good story. Prove it!'],
  },
  'Old Wick': {
    raise: ['A little more on the fire.', 'Good iron costs what it costs.'],
    claim: ['Set that on the anvil, then.', 'Hm. That much I will say.'],
    call: ["Let's see if that one rings true.", 'Every blade gets tested.'],
  },
};
const TALK_P = 0.35;

const HANDS_5 = 2598960;
const PRIOR_FLOOR = 0.002;

/**
 * How often a random 5-card hand holds a claim, by [cat, r1]. Exact counts; test/bots.test.js recounts
 * them over every hand. Floored, so a rare claim never reads as impossible.
 */
export function priorOf([cat, r1, r2]) {
  const counts = {
    [CAT.PAIR]: 108336,
    [CAT.TWO_PAIR]: 1632 * (r1 - 2), // r1 pair with any lower pair, full houses included
    [CAT.THREE]: 4560,
    [CAT.STRAIGHT]: 1024,
    [CAT.FLUSH]: 5148,
    [CAT.FULL]: 288,
    [CAT.FOUR]: 48,
    [CAT.STRAIGHT_FLUSH]: 40,
  };
  return Math.max(counts[cat] / HANDS_5, PRIOR_FLOOR) * (r2 ? 0.5 : 1);
}

const heldOf = (hand, rank) => hand.filter((c) => rankOf(c) === rank).length;

/** True if this hand alone proves the claim can't be in anyone else's five cards. */
export function isImpossible([cat, r1, r2], hand) {
  const left = (rank) => 4 - heldOf(hand, rank);
  switch (cat) {
    case CAT.PAIR: return left(r1) < 2;
    case CAT.TWO_PAIR: return left(r1) < 2 || (r2 !== 0 && left(r2) < 2);
    case CAT.THREE: return left(r1) < 3;
    case CAT.FULL: return left(r1) < 3 || (r2 !== 0 && left(r2) < 2);
    case CAT.FOUR: return left(r1) < 4;
    case CAT.STRAIGHT: {
      const run = r1 === 5 ? [14, 2, 3, 4, 5] : [r1, r1 - 1, r1 - 2, r1 - 3, r1 - 4];
      return run.some((rank) => left(rank) < 1);
    }
    default: return false;
  }
}

/** A claimer's bluff rate, from their public record: caught / called, or .25 with no record. */
export const bluffRateOf = (seatView) => (seatView.rep.called ? seatView.rep.caught / seatView.rep.called : 0.25);

/**
 * prior^0.35 × (1.1 − bluff rate), × 0.55 per card of a claimed rank the bot holds, × 0.6 if the claimer
 * passed the bot that rank (they gave it away), clamped to .02–.98. Impossible = 0, which means call.
 * `gotFromClaimer` is the cards this claimer passed to this bot this round.
 */
export function belief(claim, claimerBluff, hand, gotFromClaimer = []) {
  if (isImpossible(claim, hand)) return 0;
  const [cat, r1, r2] = claim;
  let b = priorOf(claim) ** 0.35 * (1.1 - claimerBluff);
  if ([CAT.PAIR, CAT.TWO_PAIR, CAT.THREE, CAT.FULL, CAT.FOUR].includes(cat)) {
    b *= 0.55 ** (heldOf(hand, r1) + (r2 ? heldOf(hand, r2) : 0));
  }
  if ([CAT.PAIR, CAT.THREE, CAT.FOUR].includes(cat) && gotFromClaimer.some((card) => rankOf(card) === r1)) b *= 0.6;
  return Math.max(0.02, Math.min(0.98, b));
}

/** How much more the pot can take this round. */
const roomIn = (view) => (view.limits.potLimit ?? Infinity) - (view.pot ?? 0);

/** Would this seat pay `cost` to stay in? By its hand, and by nerve. */
function staysFor(cost, hand, persona, rng) {
  const cat = bestClaim(hand)?.[0] ?? 0;
  return cat >= CAT.THREE
    || (cat === CAT.TWO_PAIR && cost <= 15)
    || (cat === CAT.PAIR && cost <= 6)
    || rng() < persona.bluff + 0.25 - cost * 0.02;
}

/** What it costs this seat to reach the pass window's raise. */
function windowCostOf(view, me) {
  const { high = 0, paid = {} } = view.passRaise ?? {};
  return { owed: high - (paid[me] ?? 0), cost: Math.min(high - (paid[me] ?? 0), Math.max(0, roomIn(view))) };
}

function answerRaise(view, me, hand, persona, rng) {
  const { cost } = windowCostOf(view, me);
  return staysFor(cost, hand, persona, rng) && view.seats[me].chips >= cost ? { action: 'match' } : { action: 'fold' };
}

/**
 * A bot's move in a pass window, as in the prototype: having seen at least one pass, it may raise on a strong hand;
 * once enough passes are done it may stop the passing, which is a claim; otherwise it passes. With nothing to show for
 * it, how readily it stops is its nerve for bluffing.
 */
function decidePass(view, me, hand, persona, rng) {
  const best = bestClaim(hand);
  const cat = best?.[0] ?? 0;
  const done = view.passNo - 1;
  const { owed, cost } = windowCostOf(view, me);
  const { chips } = view.seats[me];
  const amount = Math.min(view.limits.raiseLimit, cat * 4 + Math.floor(rng() * 5));
  const canRaise = done >= 1 && !view.raisedThisPass?.includes(me) && amount >= 1 && chips - cost >= amount && roomIn(view) - cost >= amount;
  const raising = canRaise && cat >= CAT.TWO_PAIR && rng() < 0.35;
  if (owed > 0) {
    if (!staysFor(cost, hand, persona, rng) || chips < cost) return { action: 'fold' };
    return raising && cat >= CAT.THREE ? { action: 'pass', card: passChoice(hand, persona, rng), raise: amount } : { action: 'pass', card: passChoice(hand, persona, rng), match: true };
  }
  if (raising) return { action: 'pass', card: passChoice(hand, persona, rng), raise: amount };
  const wants = cat >= CAT.TWO_PAIR || (cat === CAT.PAIR && best[1] >= 10 && rng() < 0.5) || rng() < persona.bluff * STOP_BLUFF * done;
  if (done >= view.limits.minPasses && !view.passRaise?.high && wants) return stopMove(view, me, hand, persona, rng);
  return { action: 'pass', card: passChoice(hand, persona, rng) };
}

// The claim lap's money. Tuned in scripts/sim.js: the rates it reports are in the claim-raise report.
const RAISE_TRUE = { base: 0.10, perCat: 0.08 }; // chance of raising on a true claim, by category
const RAISE_BLUFF = 0.5; // chance of raising on a bluffed claim, times the bot's bluff rate
const RAISE_EMPTY = 0.12; // chance of raising with no claim of its own, times the bot's bluff rate
const RERAISE = 0.5; // how much less likely with a raise already on the table
const STOP_CREDIT = 0.22; // how much more a claim is believed for being put down first, by whoever stopped the passing
const STOP_BLUFF = 0.3; // chance of stopping with no hand to show for it, per pass done, times the bot's bluff rate
const RAISE_DOUBT = { base: 0.08, perChip: 0.006 }; // how much harder a raised claim is looked at
const BACK_BLUFF = { base: 0.10, perChip: 0.015 }; // nerve to pay to keep a bluff on the table

// The steps bots bluff along: by category and first rank only, as in the prototype.
const COARSE_LADDER = LADDER.filter(([cat, r1, r2]) => r2 === 0 && (cat !== CAT.FLUSH || r1 === 0));

/** How hard this bot looks at a claim. A raise puts it under more suspicion, more so the bigger it is. */
const doubtOf = (view, seat, persona) => {
  const paid = view.lapRaise.paid[seat] ?? 0;
  return persona.doubt + (paid > 0 ? RAISE_DOUBT.base + paid * RAISE_DOUBT.perChip : 0);
};

/** The claim a bot would make, if it makes one: its own hand most of the time, a small step up the ladder otherwise. */
function pickClaim(view, hand, persona, rng) {
  const options = COARSE_LADDER.filter((rung) => !view.top || compareClaims(rung, view.top) > 0);
  const truthful = options.filter((rung) => contains(hand, rung));
  if (truthful.length && rng() > persona.bluff * 0.4) {
    const best = bestClaim(hand);
    const exact = best && (!view.top || compareClaims(best, view.top) > 0) && rng() < 0.4;
    return exact ? best : truthful[0];
  }
  if (options.length && (rng() < persona.bluff + 0.12 || !view.top)) return options[Math.min(options.length - 1, Math.floor(rng() * 3))];
  return null;
}

/** How likely a claim is to go down with a raise. A bluffer raises by nerve, and as big as an honest bot does. */
function raiseRate(cat, isTrue, persona, high) {
  const nerve = 0.6 + persona.bluff * 2;
  return (isTrue ? RAISE_TRUE.base + cat * RAISE_TRUE.perCat : persona.bluff * RAISE_BLUFF) * nerve * (high > 0 ? RERAISE : 1);
}

const raiseReach = (cat) => 4 + Math.max(cat, 2) * 2;

/** Stopping the passing: the claim, and maybe a raise with it. Nothing's on the table yet, so nobody is ahead of it. */
function stopMove(view, me, hand, persona, rng) {
  const claim = pickClaim(view, hand, persona, rng);
  const [cat] = claim;
  const cap = Math.min(view.limits.raiseLimit, view.seats[me].chips, roomIn(view));
  const move = { action: 'stop', claim };
  if (cap < 1 || rng() >= raiseRate(cat, contains(hand, claim), persona, 0)) return move;
  return { ...move, raise: 1 + Math.floor(rng() * Math.min(cap, raiseReach(cat))) };
}

/** The standing claim this bot believes least, and by how much it falls short. Nothing if it can't afford a call. */
function mostDoubted(view, me, hand, persona, received) {
  if (view.seats[me].chips < view.limits.callStake) return null;
  let worst = null;
  for (const c of view.claims) {
    if (c.status !== 'standing' || c.seat === me) continue;
    const got = received.filter((r) => r.from === c.seat).map((r) => r.card);
    const believed = belief(c.claim, bluffRateOf(view.seats[c.seat]), hand, got);
    const b = believed > 0 && c.seat === view.lapRaise.stopper ? Math.min(0.98, believed + STOP_CREDIT) : believed;
    const margin = b - doubtOf(view, c.seat, persona);
    if (!worst || margin < worst.margin) worst = { seat: c.seat, b, margin };
  }
  return worst;
}

/** A claim, a call or a check, before any thought of the raise. */
function chooseMove(view, me, hand, persona, rng, received) {
  // Facing a raise, a call gives up any share of the pot. A strong hand that can beat the table claims instead.
  const strongest = bestClaim(hand);
  if (view.lapRaise.high > 0 && strongest?.[0] >= CAT.THREE && (!view.top || compareClaims(strongest, view.top) > 0)) return { move: { action: 'claim', claim: strongest }, worst: null };
  const worst = mostDoubted(view, me, hand, persona, received);
  if (worst && worst.margin < 0) return { move: { action: 'call', seat: worst.seat }, worst };
  const claim = pickClaim(view, hand, persona, rng);
  if (claim) return { move: { action: 'claim', claim }, worst };
  if (worst && worst.b < 0.55) return { move: { action: 'call', seat: worst.seat }, worst };
  return { move: { action: 'check' }, worst };
}

/** Will this bot pay `high` to keep a claim on the table? True claims by their strength, bluffs on nerve. */
function backsClaim(cat, isTrue, high, persona, rng) {
  if (!isTrue) return rng() < persona.bluff + BACK_BLUFF.base - high * BACK_BLUFF.perChip;
  return cat >= CAT.THREE
    || (cat === CAT.TWO_PAIR && high <= 15)
    || (cat === CAT.PAIR && high <= 6)
    || rng() < persona.bluff + 0.15 - high * 0.02;
}

/**
 * The claim lap: the move, then what it does about the raise. Strong claims and bluffs raise, and a bluffer's raise is
 * as big as an honest one's, so the size gives little away. A seat with no claim can't share the pot, so it never pays
 * to stay in. It calls for the price of the stake and folds, or now and then raises to shake a claim loose.
 */
function decideClaim(view, me, hand, persona, rng, received) {
  const { high } = view.lapRaise;
  const { move, worst } = chooseMove(view, me, hand, persona, rng, received);
  const spare = view.seats[me].chips - (move.action === 'call' ? view.limits.callStake : 0);
  const cap = Math.min(view.limits.raiseLimit, spare, (view.lapRaise.paid[me] ?? 0) + Math.max(0, roomIn(view)));
  const raiseTo = (reach) => high + 1 + Math.floor(rng() * Math.min(cap - high, reach));
  const canRaise = roomIn(view) > 0 && cap > high;
  const owedNow = Math.min(high - (view.lapRaise.paid[me] ?? 0), Math.max(0, roomIn(view)));

  if (move.action === 'claim') {
    const isTrue = contains(hand, move.claim);
    const [cat] = move.claim;
    if (canRaise && rng() < raiseRate(cat, isTrue, persona, high)) return { ...move, raise: raiseTo(raiseReach(cat)) };
    if (high === 0) return move;
    if (spare >= owedNow && backsClaim(cat, isTrue, high, persona, rng)) return { ...move, match: true };
    return worst && worst.b < 0.55 && view.seats[me].chips >= view.limits.callStake ? { action: 'call', seat: worst.seat, fold: true } : { action: 'fold' };
  }

  const standing = view.claims.some((c) => c.status === 'standing' || c.status === 'proven');
  if (canRaise && standing && rng() < persona.bluff * RAISE_EMPTY) return { ...move, raise: raiseTo(4) };
  if (high === 0) return move;
  return move.action === 'call' ? { ...move, fold: true } : { action: 'fold' };
}

/** Is this seat's place among the claims worth the price of matching? Top claims stay, and weak spots go. */
function worthMatching(view, me, owed, persona, rng) {
  const standing = view.claims.filter((c) => c.status === 'standing' || c.status === 'proven').sort((a, b) => compareClaims(b.claim, a.claim));
  const place = standing.findIndex((c) => c.seat === me);
  if (place < 0) return false;
  if (place >= 2) return rng() < persona.bluff * 0.25; // no share to protect, unless a higher claim folds
  const share = place === 1 ? 1 / 3 : standing.length > 1 ? 2 / 3 : 1;
  return share * (view.pot + owed) * (1 + persona.bluff) >= owed;
}

/** After the lap, with a raise to answer: match or fold by where its claim ranks, and call a claim it doesn't believe as it does. */
function decideAnswer(view, me, hand, persona, rng, received) {
  const { high, paid } = view.lapRaise;
  const owed = Math.min(high - (paid[me] ?? 0), Math.max(0, roomIn(view)));
  const { chips } = view.seats[me];
  const worst = mostDoubted(view, me, hand, persona, received);
  const calling = worst && worst.margin < 0;
  const spare = chips - (calling ? view.limits.callStake : 0);
  const stay = spare >= owed && worthMatching(view, me, owed, persona, rng);
  if (calling) return { action: 'call', seat: worst.seat, ...(stay ? { match: true } : { fold: true }) };
  return { action: stay ? 'match' : 'fold' };
}

/** `persona` defaults to the seat's own, and can be set for a stand-in player in the sim. */
export function decide(view, me, hand, rng, { persona = PERSONAS[view.seats[me].name], received = [] } = {}) {
  if (view.phase === 'answer') return decideAnswer(view, me, hand, persona, rng, received);
  if (view.raise) return answerRaise(view, me, hand, persona, rng);
  if (view.phase === 'pass') return decidePass(view, me, hand, persona, rng);
  return decideClaim(view, me, hand, persona, rng, received);
}

/** How near a hand is to a flush or a straight: its longest suit or the most ranks in any run of five, whichever is nearer. */
function drawScore(cards) {
  const suits = {};
  for (const c of cards) suits[suitOf(c)] = (suits[suitOf(c)] ?? 0) + 1;
  const ranks = new Set(cards.map(rankOf));
  if (ranks.has(14)) ranks.add(1);
  let run = 0;
  for (let low = 1; low <= 10; low += 1) run = Math.max(run, [0, 1, 2, 3, 4].filter((i) => ranks.has(low + i)).length);
  const suit = Math.max(...Object.values(suits));
  return Math.max(suit, run) * 10 + Math.min(suit, run);
}

/**
 * Which card a bot passes. Plain is the card that hurts the hand least, which is nearly always the lowest, so a bot that only
 * did that would give away what it holds. So it has styles, and picks one for each pass. None of them breaks up a pair or better:
 *   builder: keeps whatever is nearest a flush or a straight, however low, and passes the card that helps that least.
 *   mid: passes a middling card, as if it can afford to.
 *   good: passes its best spare card. A claim from someone who gave away a King reads differently.
 */
function passChoice(hand, persona, rng) {
  const spare = hand.filter((c) => hand.filter((x) => rankOf(x) === rankOf(c)).length === 1).sort((a, b) => rankOf(a) - rankOf(b));
  const styles = persona?.pass;
  if (!styles || spare.length < 2) return leastHurt(hand);
  const roll = rng();
  if (roll < styles.good) return spare.at(-1);
  if (roll < styles.good + styles.mid) return spare[Math.floor(spare.length / 2)];
  if (roll < styles.good + styles.mid + styles.builder) {
    const score = (c) => drawScore(hand.filter((x) => x !== c));
    const most = Math.max(...spare.map(score));
    const ties = spare.filter((c) => score(c) === most);
    return ties[Math.floor(rng() * ties.length)];
  }
  return leastHurt(hand);
}

/** The card that hurts the hand least: what's left is scored by category and rank, lowest card first. */
function leastHurt(hand) {
  let pick = hand[0];
  let bestScore = -Infinity;
  for (const card of hand) {
    const rest = bestClaim4(hand.filter((c) => c !== card));
    const score = rest[0] * 20 + rest[1] - rankOf(card) / 20;
    if (score > bestScore) [pick, bestScore] = [card, score];
  }
  return pick;
}

/** Best made combination in four cards: pairs, two pair, three, four. */
function bestClaim4(cards) {
  const n = {};
  for (const c of cards) n[rankOf(c)] = (n[rankOf(c)] ?? 0) + 1;
  const groups = Object.entries(n).map(([r, k]) => [Number(r), k]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const [top, next] = groups;
  if (top[1] === 4) return [CAT.FOUR, top[0]];
  if (top[1] === 3) return [CAT.THREE, top[0]];
  if (top[1] === 2 && next?.[1] === 2) return [CAT.TWO_PAIR, top[0]];
  if (top[1] === 2) return [CAT.PAIR, top[0]];
  return [0, top[0]];
}

function maybeTalk(s, seat, move, rng) {
  // A move can carry a raise, and then the raise is what gets talked about. Stopping the passing is a claim, to anyone listening.
  const kind = move.raise ? 'raise' : move.action === 'stop' ? 'claim' : move.action;
  const lines = VOICES[s.seats[seat].name]?.[kind];
  if (!lines || rng() >= TALK_P) return;
  const entry = addTalk(s, seat, lines[Math.floor(rng() * lines.length)]);
  // The scripted line is already in the log. The table may swap in an AI line; if it can't, this stays.
  s.talkQueue.push({ n: entry.n, seat, action: kind, amount: move.n ?? move.raise ?? null });
}

const waitingBots = (s) => (inRound(s) ? waitingOn(s).filter((i) => s.seats[i].bot) : []);

/** Should a bot ever produce an illegal move, it takes the timeout move and logs it, so a bug can't freeze a table. */
function playBot(s, seat, ctx) {
  const auto = { ...ctx, auto: true };
  try {
    const move = decide(publicView(s), seat, s.hands[seat], ctx.rng, { received: s.received[seat] });
    ctx.onBotMove?.(seat, s.hands[seat], move); // the sim's way of watching
    maybeTalk(s, seat, move, ctx.rng); // before the move, so the line reads ahead of its result
    act(s, seat, move, auto);
  } catch (err) {
    addLog(s, `Bot error at seat ${seat}: ${err.code ?? 'unknown'}.`, { botError: true });
    act(s, seat, autoAction(s, seat, ctx), auto);
  }
}

/** Plays every bot move at once, and stops when a human has to act or the round ends. The sim and fast tests use this. */
export function runBots(s, ctx) {
  for (let guard = 0; guard < 500; guard++) {
    const due = waitingBots(s);
    if (due.length === 0) return;
    for (const seat of due) {
      const before = `${s.phase}.${s.passNo}`;
      playBot(s, seat, ctx);
      if (`${s.phase}.${s.passNo}` !== before || s.raise) break;
    }
  }
}

/** What a bot's wait belongs to. If this changes under it, it thinks again rather than moving early. */
const stepOf = (s) => `${s.phase}.${s.passNo}.${s.raise?.by ?? ''}.${s.passRaise?.high ?? 0}`;

/**
 * The live table's version: each bot waits a random time from cfg.botDelayMs before it moves. Gives each waiting
 * bot a time, plays whoever's time has come, and returns. The table sets an alarm for the next one. The wait is
 * random, so a watcher learns nothing about the hand from it.
 */
export function paceBots(s, ctx) {
  const [lo, hi] = s.cfg.botDelayMs ?? DEFAULTS.botDelayMs;
  if (hi <= 0) {
    s.botDue = {};
    return runBots(s, ctx);
  }
  s.botDue ??= {};
  for (let guard = 0; guard < 500; guard++) {
    const waiting = waitingBots(s);
    const step = stepOf(s);
    for (const seat of Object.keys(s.botDue)) {
      if (!waiting.includes(Number(seat)) || s.botDue[seat].step !== step) delete s.botDue[seat];
    }
    for (const seat of waiting) s.botDue[seat] ??= { step, from: ctx.now, at: ctx.now + lo + Math.floor(ctx.rng() * (hi - lo + 1)) };
    const next = waiting.filter((seat) => s.botDue[seat].at <= ctx.now).sort((a, b) => s.botDue[a].at - s.botDue[b].at)[0];
    if (next === undefined) return;
    delete s.botDue[next];
    playBot(s, next, ctx);
  }
}
