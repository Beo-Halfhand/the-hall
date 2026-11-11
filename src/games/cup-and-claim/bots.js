// House bots. A bot decides from publicView and its own dice, never the full state, so it can't peek under
// another cup even by accident. Its one tool is arithmetic: every die it can't see shows the bid face, or a wild,
// with probability 1/3.

import { HOUSE_NAME, act, addLog, addTalk, autoAction, inRound, publicView, waitingOn } from './engine.js';
import { FACES, countFace } from './fair.js';
import { compareBids, nextBidAbove } from './dice.js';

// bluff: how often a bot bids past what its dice support. doubt: the belief below which it calls Liar.
// raise: how readily it puts chips behind a bid it believes. show: how often it lifts the cup when called.
export const PERSONAS = {
  [HOUSE_NAME]: { bluff: 0.14, doubt: 0.30, raise: 0.16, show: 0.05 },
  Brannock: { bluff: 0.36, doubt: 0.22, raise: 0.34, show: 0.70 },
  'Old Wick': { bluff: 0.06, doubt: 0.36, raise: 0.12, show: 0.20 },
  'Red Mab': { bluff: 0.28, doubt: 0.18, raise: 0.26, show: 0.45 },
  'Sister Ivy': { bluff: 0.10, doubt: 0.40, raise: 0.10, show: 0.10 },
};

// Scripted lines. A line depends only on the kind of move, never on the dice, so it gives nothing away.
export const VOICES = {
  [HOUSE_NAME]: {
    bid: ['The count goes up.', 'Mark it on the slate.'],
    raise: ['A little more for the ledger.', 'Chips say what words cannot.'],
    liar: ['The count says show me.', 'No. Prove it.'],
    show: ['Here. Count them yourself.'],
    prove: ['The cup stays shut. The count is what matters.', 'You get the number, not the dice.'],
  },
  Brannock: {
    bid: ['Ha! More than that, surely!', 'Top that, you lovely lot.'],
    raise: ['Another round on me! Well, on you.', 'Drink up and pay up, friends!'],
    liar: ["I've heard better tales from my mule!", 'Oh, I love a good story. LIAR!'],
    show: ['Look at them! Beauties, every one!', 'Nothing to hide at this table!'],
    prove: ['Just the number tonight. Mysterious, eh?'],
  },
  'Old Wick': {
    bid: ['Hm. That much I will say.', 'Steady. One more.'],
    raise: ['Good iron costs what it costs.', 'A little more on the fire.'],
    liar: ["Let's see if that one rings true.", 'Every blade gets tested.'],
    show: ['Soot on my hands, nothing up my sleeve.'],
    prove: ['The hammer knows. You need not see.', 'Shut cup, honest count.'],
  },
  'Red Mab': {
    bid: ['Higher, lads. The tide is in.', 'I have sailed through worse odds.'],
    raise: ['Gold on the barrel, then.', 'Sink or swim, friends.'],
    liar: ['Walk the plank with that one. Liar!', 'Red Mab smells a rat.'],
    show: ['Ha! Feast your eyes.', 'A pirate hides her gold, not her dice.'],
    prove: ['You get my word, and the count. Enough.'],
  },
  'Sister Ivy': {
    bid: ['Quietly, then. A little more.', 'I will say this much.'],
    raise: ['A small offering.', 'Faith has a price.'],
    liar: ['Forgive me. I do not believe you.', 'That is a sin against arithmetic.'],
    show: ['See for yourselves. I have nothing to confess.'],
    prove: ['The cup stays down. The truth goes out all the same.', 'The number, not the dice. That is the whole lesson.'],
  },
};
const TALK_P = 0.35;

/** P(at least k of n unseen dice show the face or a wild), each with probability 1/3. */
export function atLeast(k, n) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let p = 0;
  let term = (2 / 3) ** n; // P(X = 0)
  for (let x = 0; x <= n; x++) {
    if (x >= k) p += term;
    term *= ((n - x) / (x + 1)) * 0.5; // P(X = x+1) / P(X = x) with p = 1/3
  }
  return Math.min(1, p);
}

/** A bidder's bluff rate, from their public record: caught / called, or .3 with no record. */
export const bluffRateOf = (seatView) => (seatView.rep.called ? seatView.rep.caught / seatView.rep.called : 0.3);

/**
 * How likely a bid is to hold, from this bot's dice: it needs (count − what I hold) of the dice it can't see.
 * A known bluffer's bids are believed a little less, a proven one's a little more.
 */
export function belief(bid, dice, totalDice, bidderBluff = 0.3) {
  const mine = countFace(dice, bid.face);
  const p = atLeast(bid.count - mine, totalDice - dice.length);
  return Math.max(0.01, Math.min(0.99, p * (1.15 - bidderBluff * 0.5)));
}

/** Every bid above `above`, lowest first, up to a count ceiling. */
function bidsAbove(above, maxCount) {
  const out = [];
  let bid = nextBidAbove(above);
  while (bid.count <= maxCount) {
    out.push(bid);
    bid = nextBidAbove(bid);
  }
  return out;
}

function decideBid(view, me, dice, persona, rng) {
  const canBid = (view.seats[me].chips >= (view.seats[me].owed ?? 0));
  const { bid } = view;
  const total = view.totalDice;
  const unseen = total - dice.length;

  // 1. The standing bid: call it if it looks like a lie.
  if (bid) {
    const b = belief(bid, dice, total, bluffRateOf(view.seats[bid.seat]));
    const owed = view.seats[me].owed ?? 0;
    const pressure = owed > 0 ? Math.min(0.12, owed / 200) : 0; // a raise to match makes a doubtful bid worth calling instead
    if (b < persona.doubt + pressure) return { action: 'liar' };
    if (!canBid) return b > 0.6 && rng() < 0.7 ? { action: 'fold' } : { action: 'liar' };
  }

  // 2. Something to bid: the lowest bids above, scored by how likely they are to hold.
  // Up to two counts above the standing bid. A bot climbs: the highest bid it's confident in, or one picked from the
  // confident ones, so the bidding moves and a round is a handful of bids, not a slow crawl up every rung.
  const options = bidsAbove(bid, total).slice(0, 10).map((b) => ({ bid: b, p: atLeast(b.count - countFace(dice, b.face), unseen) }));
  const safe = options.filter((o) => o.p >= 0.55);
  const bluffing = rng() < persona.bluff;
  let pick = null;
  if (safe.length && !bluffing) pick = rng() < 0.5 ? safe.at(-1) : safe[Math.floor(rng() * safe.length)];
  else if (bluffing) pick = options.findLast((o) => o.p >= 0.25 && o.p < 0.55) ?? options.find((o) => o.p >= 0.2) ?? options[0];
  else pick = options.find((o) => o.p >= 0.35) ?? options[0];

  if (bid) {
    // Nothing worth bidding: fold when a raise is owed and the bid looks true, or call it when it doesn't.
    const b = belief(bid, dice, total, bluffRateOf(view.seats[bid.seat]));
    if (!pick || pick.p < 0.2) {
      if (b < 0.55) return { action: 'liar' };
      if ((view.seats[me].owed ?? 0) > 0 && rng() < 0.75) return { action: 'fold' };
      if (rng() < 0.4) return { action: 'fold' };
    }
  }
  if (!pick) return bid ? { action: 'liar' } : { action: 'bid', ...nextBidAbove(null) };

  // 3. Chips behind it: a bid it believes gets a raise sometimes; a bluff gets one less often, to shake the next seat.
  let raise = 0;
  const room = view.raiseRoom?.max ?? 0;
  if (room >= 1) {
    const want = pick.p >= 0.6 ? persona.raise : pick.p < 0.4 ? persona.bluff * 0.35 : persona.raise * 0.4;
    if (rng() < want) raise = Math.max(1, Math.min(room, Math.round(2 + rng() * (pick.p >= 0.6 ? 10 : 6) + persona.raise * 12)));
  }
  return { action: 'bid', ...pick.bid, ...(raise > 0 ? { raise } : {}) };
}

function decideReveal(view, me, dice, persona, rng) {
  // A bluffer who got caught would rather show than let the number speak? No: the number is the same either way.
  // Showing is a style, and a bit of theatre when the cup is strong.
  const { bid } = view.duel;
  const strong = countFace(dice, bid.face) >= 3;
  const p = persona.show + (strong ? 0.15 : 0);
  return { action: 'reveal', mode: rng() < p ? 'show' : 'prove' };
}

/** `persona` defaults to the seat's own, and can be set for a stand-in player in the sim. */
export function decide(view, me, dice, rng, { persona = PERSONAS[view.seats[me].name] ?? PERSONAS[HOUSE_NAME] } = {}) {
  if (view.phase === 'duel') return decideReveal(view, me, dice, persona, rng);
  return decideBid(view, me, dice, persona, rng);
}

function maybeTalk(s, seat, move, rng) {
  const key = move.action === 'bid' && move.raise ? 'raise' : move.action === 'reveal' ? move.mode : move.action;
  const lines = VOICES[s.seats[seat].name]?.[key];
  if (!lines || rng() >= TALK_P) return;
  const entry = addTalk(s, seat, lines[Math.floor(rng() * lines.length)]);
  s.talkQueue.push({ n: entry.n, seat, action: key, amount: move.raise ?? null });
}

const waitingBots = (s) => (inRound(s) ? waitingOn(s).filter((i) => s.seats[i].bot) : []);

function playBot(s, seat, ctx) {
  const auto = { ...ctx, auto: true };
  try {
    const move = decide(publicView(s), seat, s.dice[seat], ctx.rng);
    maybeTalk(s, seat, move, ctx.rng);
    act(s, seat, move, auto);
  } catch (err) {
    addLog(s, `Bot error at seat ${seat}: ${err.code ?? 'unknown'}.`, { botError: true });
    act(s, seat, autoAction(s, seat), auto);
  }
}

/** Plays every bot move at once, and stops when a human has to act or the round ends. The sim and fast tests use this. */
export function runBots(s, ctx) {
  for (let guard = 0; guard < 500; guard++) {
    const due = waitingBots(s);
    if (due.length === 0) return;
    for (const seat of due) {
      const before = `${s.phase}.${s.round}`;
      playBot(s, seat, ctx);
      if (`${s.phase}.${s.round}` !== before) break;
    }
  }
}

const stepOf = (s) => `${s.phase}.${s.round}.${s.bid ? `${s.bid.seat}:${s.bid.count}:${s.bid.face}` : ''}`;

/** The live table's version: each bot waits a random time from cfg.botDelayMs before it moves. */
export function paceBots(s, ctx) {
  if (s.proof && s.phase === 'duel') { // the chain takes a bot's answer through dice-house, so here a bot only chooses how it answers
    for (const seat of s.duel.waiting) {
      if (s.seats[seat].bot && !s.duel.modes[seat]) s.duel.modes[seat] = decide(publicView(s), seat, s.dice[seat], ctx.rng).mode ?? 'prove';
    }
    return undefined;
  }
  const [lo, hi] = s.cfg.botDelayMs ?? [1500, 3000];
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

export { FACES, compareBids };
