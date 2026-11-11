// Cup & Claim pot rules at 3, 4 and 5 seats. ANALYSIS ONLY: nothing here changes the engine.
// The real engine plays every round (so the bots, bids, raises, folds and dice are the real ones) and this script records
// who staked what and which bid was made when. Each round is then settled under four rules from the same record:
//   C   today: the winner of the Liar call takes the whole pot
//   A   every seat's LAST bid is judged against the dice; true bids share the pot weighted by stake, false bids lose their stake
//   A2  as A, but only bids made at or after the round's first raise are judged (no raise: the call decides, as in C)
//   B   the loser of the call pays: their stake, and any folder's, goes to everyone else still in, weighted by stake, who get their own back
//   B3  as B, but the share is equal per seat, not weighted by stake
//   B3cX as B3, but a caller who was right counts X shares (the caller bonus)
//   B2  as B, but the winner of the call counts double in that share, so a right call pays more than standing by
// Then a "smart" stand-in in seat 0 tries a grid of policies, so we can see which rule is exploitable.
// node scripts/pot-rules-sim.js [tables] [rounds per table] [--json]

import { act, createTable, join, publicView } from '../src/games/cup-and-claim/engine.js';
import { PERSONAS, atLeast, belief, bluffRateOf, decide } from '../src/games/cup-and-claim/bots.js';
import { HOUSE_NAME } from '../src/games/cup-and-claim/engine.js';
import { countFace } from '../src/games/cup-and-claim/fair.js';
import { nextBidAbove } from '../src/games/cup-and-claim/dice.js';

const TABLES = Number(process.argv[2] ?? 300);
const ROUNDS = Number(process.argv[3] ?? 20);
const AS_JSON = process.argv.includes('--json');
const SEATS = [3, 4, 5];
const RULES = ['C', 'A', 'A2', 'B', 'B2', 'B3', 'B3c1.5', 'B3c2', 'B3c3'];

function rngFrom(start) {
  let a = start | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- settlement ----------

/** Pays a pool to `winners` ({seat}) weighted by stake. Returns false if there is nobody to pay. */
function share(pay, pool, winners, stake, double = -1, equal = false, mult = 2) {
  const w = (i) => (equal ? 1 : stake[i]) * (i === double ? mult : 1);
  const weight = winners.reduce((sum, i) => sum + w(i), 0);
  if (weight <= 0) return false;
  for (const i of winners) pay[i] += (pool * w(i)) / weight;
  return true;
}

/** payout per seat under a rule. R = { stake[], status[], last[], lastSeq[], firstRaise, bidder, caller, held, trueCount(face) }. */
export function settle(rule, R) {
  const n = R.stake.length;
  const pay = Array(n).fill(0);
  const dealt = R.stake.map((_, i) => i).filter((i) => R.status[i] === 'in' || R.status[i] === 'folded');
  const winner = R.held ? R.bidder : R.caller;
  const void_ = () => { dealt.forEach((i) => { pay[i] = R.stake[i]; }); return { pay, voided: true }; };
  const pot = R.stake.reduce((a, b) => a + b, 0);

  if (rule === 'C' || (rule === 'A2' && R.firstRaise === null)) {
    pay[winner] = pot;
    return { pay };
  }
  if (rule === 'B' || rule === 'B2' || rule.startsWith('B3')) {
    const loser = R.held ? R.caller : R.bidder;
    const folded = dealt.filter((i) => R.status[i] === 'folded');
    const rest = dealt.filter((i) => i !== loser && R.status[i] === 'in');
    const pool = R.stake[loser] + folded.reduce((s, i) => s + R.stake[i], 0);
    rest.forEach((i) => { pay[i] = R.stake[i]; });
    // B3cX: equal shares, and a caller who was right (the bid fell) counts X shares
    const bonus = rule.startsWith('B3c') && !R.held ? R.caller : -1;
    const mult = rule.startsWith('B3c') ? Number(rule.slice(3)) : 2;
    return share(pay, pool, rest, R.stake, rule === 'B2' ? winner : bonus, rule.startsWith('B3'), mult) ? { pay } : void_();
  }
  // A and A2: a seat is true, false, forfeit (folded, nothing judged) or refunded (never had a turn / not judged)
  const judged = (i) => R.last[i] && (rule === 'A' || R.lastSeq[i] >= R.firstRaise);
  const winners = [];
  let pool = 0;
  for (const i of dealt) {
    if (judged(i)) {
      const b = R.last[i];
      if (R.trueCount(b.face) >= b.count) winners.push(i);
      else pool += R.stake[i];
    } else if (R.status[i] === 'folded') pool += R.stake[i];
    else pay[i] = R.stake[i];
  }
  winners.forEach((i) => { pay[i] = R.stake[i]; });
  return share(pay, pool, winners, R.stake) ? { pay } : void_();
}

// ---------- policies for the seat-0 stand-in ----------

// noCall: never call Liar (fold or bid instead). safeP: the lowest bid it believes at least this much. raise: 'none' | 'safe' (when p >= raiseP) | 'always', always the maximum.
export const POLICIES = {
  house: null, // the stock stand-in: the house persona through the real decide()
  'steady-no-raise': { noCall: false, safeP: 0.55, raise: 'none' },
  'steady-raise-safe': { noCall: false, safeP: 0.55, raise: 'safe', raiseP: 0.8 },
  'steady-raise-all': { noCall: false, safeP: 0.55, raise: 'always' },
  'quiet-raise-safe': { noCall: true, safeP: 0.75, raise: 'safe', raiseP: 0.9 },
  'quiet-raise-all': { noCall: true, safeP: 0.55, raise: 'always' },
  'quiet-no-raise': { noCall: true, safeP: 0.75, raise: 'none' },
};

function smart(view, me, dice, rng, pol) {
  if (view.phase === 'duel') return { action: 'reveal', mode: 'prove' };
  const { bid } = view;
  const total = view.totalDice;
  const unseen = total - dice.length;
  const seat = view.seats[me];
  const owed = seat.owed ?? 0;
  if (bid && !pol.noCall) {
    const b = belief(bid, dice, total, bluffRateOf(view.seats[bid.seat]));
    if (b < PERSONAS[HOUSE_NAME].doubt + (owed > 0 ? Math.min(0.12, owed / 200) : 0)) return { action: 'liar' };
  }
  if (bid && seat.chips < owed) return { action: 'fold' };
  const options = [];
  for (let b = nextBidAbove(bid); b.count <= total && options.length < 10; b = nextBidAbove(b)) options.push({ bid: b, p: atLeast(b.count - countFace(dice, b.face), unseen) });
  const pick = options.find((o) => o.p >= pol.safeP);
  if (!pick) {
    if (!bid) return { action: 'bid', ...nextBidAbove(null) };
    return pol.noCall ? { action: 'fold' } : { action: 'liar' };
  }
  const room = view.raiseRoom?.max ?? 0;
  const raise = pol.raise === 'always' || (pol.raise === 'safe' && pick.p >= pol.raiseP) ? room : 0;
  return { action: 'bid', ...pick.bid, ...(raise > 0 ? { raise } : {}) };
}

// ---------- one round, recorded ----------

/** Plays one round to its end through the real engine and returns the record of who put in what, and when. */
function playRound(s, ctx, policy) {
  const contrib = []; // { seat, amount, raise: k | null (ante), match: k | null }
  const pending = {}; // seat -> [{ k, r }] raises by others that the seat will pay when it next bids
  const events = []; // bids, in order
  let firstRaise = null;
  let k = 0;
  for (let i = 0; i < s.seats.length; i++) if (s.status[i] === 'in') contrib.push({ seat: i, amount: s.cfg.ante, raise: null, match: null });
  const last = [];
  const lastSeq = [];
  for (let guard = 0; guard < 2000 && ['bid', 'duel'].includes(s.phase); guard++) {
    const waiting = s.phase === 'bid' ? [s.turn] : [...s.duel.waiting];
    for (const seat of waiting) {
      if (!['bid', 'duel'].includes(s.phase)) break;
      const view = publicView(s);
      const persona = seat === 0 ? PERSONAS[HOUSE_NAME] : PERSONAS[s.seats[seat].name];
      const move = seat === 0 && policy ? smart(view, seat, s.dice[seat], ctx.rng, policy) : decide(view, seat, s.dice[seat], ctx.rng, { persona });
      if (move.action === 'bid') {
        const kk = k++;
        for (const p of pending[seat] ?? []) contrib.push({ seat, amount: p.r, raise: null, match: p.k });
        pending[seat] = [];
        if (move.raise) {
          contrib.push({ seat, amount: move.raise, raise: kk, match: null });
          for (let o = 0; o < s.seats.length; o++) if (o !== seat && s.status[o] === 'in') (pending[o] ??= []).push({ k: kk, r: move.raise });
          firstRaise ??= kk;
        }
        last[seat] = { count: move.count, face: move.face };
        lastSeq[seat] = kk;
        events.push({ k: kk, seat, count: move.count, face: move.face, raise: move.raise ?? 0 });
      }
      act(s, seat, move, ctx);
    }
  }
  return { contrib, events, last, lastSeq, firstRaise };
}

function stakeOf(n, contrib, drop = null) {
  const stake = Array(n).fill(0);
  for (const c of contrib) if (drop === null || (c.raise !== drop && c.match !== drop)) stake[c.seat] += c.amount;
  return stake;
}

// ---------- the run ----------

const blank = () => ({
  rounds: 0, calls: 0, uncontested: 0, voided: 0, raiseRounds: 0, raisedChips: 0,
  deadRaiseChips: 0, // raised chips put in by a seat that ended up outside the call
  bystanderSeatRounds: 0, bystanderWins: 0, bystanderNet: 0, roundsWithBystanderWin: 0, roundsWithBystander: 0,
  gapSum: 0, gapN: 0, rightCallerNet: 0, callerLostButWon: 0, callerLost: 0, bidderLostButWon: 0, bidderLost: 0,
  raiseDelta: 0, raiseChips: 0, // static value of a raise: raiser's net with it, minus without it (and everyone's matches of it)
  net: {}, // by seat name
  nRounds: {},
});

function run(seats, policyName) {
  const policy = POLICIES[policyName];
  const out = Object.fromEntries(RULES.map((r) => [r, blank()]));
  for (let t = 1; t <= TABLES; t++) {
    const ctx = { now: 1000, rng: rngFrom(t * 7919 + seats) };
    const s = createTable({ lobbyMs: 0, seats });
    join(s, 'Stand-in', ctx);
    for (let r = 0; r < ROUNDS && s.phase !== 'over'; r++) {
      if (!['bid'].includes(s.phase)) break;
      const dice = s.dice.map((d) => [...d]);
      const status = [...s.status];
      const rec = playRound(s, ctx, policy);
      if (s.phase !== 'settled') break;
      const res = s.lastResult;
      const n = s.seats.length;
      const names = s.seats.map((x) => (x.name === 'Stand-in' ? 'Stand-in' : x.name));
      const folded = (i) => status[i] === 'in' && s.status[i] === 'folded';
      const st = status.map((x, i) => (folded(i) ? 'folded' : x));
      const trueCount = (face) => st.reduce((sum, x, i) => sum + (x === 'in' || x === 'folded' ? countFace(dice[i], face) : 0), 0);
      for (const rule of RULES) {
        const o = out[rule];
        o.rounds += 1;
        const stake = stakeOf(n, rec.contrib);
        const pot = stake.reduce((a, b) => a + b, 0);
        if (Math.abs(pot - res.pot) > 1e-9) throw new Error(`stake record ${pot} != engine pot ${res.pot}`);
        const add = (pay) => pay.forEach((p, i) => { o.net[names[i]] = (o.net[names[i]] ?? 0) + (p - stake[i]); o.nRounds[names[i]] = (o.nRounds[names[i]] ?? 0) + 1; });
        if (res.kind === 'uncontested') { // cups stay shut, no dice to judge: every rule pays the last seat standing
          o.uncontested += 1;
          const pay = Array(n).fill(0);
          pay[res.awards[0].seat] = pot;
          add(pay);
          continue;
        }
        o.calls += 1;
        const R = { stake, status: st, last: rec.last, lastSeq: rec.lastSeq, firstRaise: rec.firstRaise, bidder: res.bidder, caller: res.caller, held: res.held, trueCount };
        const { pay, voided } = settle(rule, R);
        if (voided) o.voided += 1;
        if (Math.abs(pay.reduce((a, b) => a + b, 0) - pot) > 1e-6) throw new Error(`rule ${rule} paid ${pay.reduce((a, b) => a + b, 0)} of ${pot}`);
        add(pay);
        const net = pay.map((p, i) => p - stake[i]);
        const inCall = (i) => i === res.bidder || i === res.caller;
        const bystanders = st.map((x, i) => i).filter((i) => st[i] === 'in' && !inCall(i));
        o.bystanderSeatRounds += bystanders.length;
        if (bystanders.length) o.roundsWithBystander += 1;
        let any = false;
        for (const i of bystanders) {
          o.bystanderNet += net[i];
          if (net[i] > 1e-9) { o.bystanderWins += 1; any = true; }
        }
        if (any) o.roundsWithBystanderWin += 1;
        if (!res.held && bystanders.length) { // a right call vs the bystanders' take in the same round
          o.gapN += 1;
          o.rightCallerNet += net[res.caller];
          o.gapSum += net[res.caller] - bystanders.reduce((a, i) => a + net[i], 0) / bystanders.length;
        }
        const loserIsCaller = res.held;
        if (loserIsCaller) { o.callerLost += 1; if (net[res.caller] > 1e-9) o.callerLostButWon += 1; } else { o.bidderLost += 1; if (net[res.bidder] > 1e-9) o.bidderLostButWon += 1; }
        // raises
        const raisers = rec.events.filter((e) => e.raise > 0);
        if (raisers.length) o.raiseRounds += 1;
        for (const e of raisers) {
          o.raisedChips += e.raise;
          if (!inCall(e.seat)) o.deadRaiseChips += e.raise;
          const without = stakeOf(n, rec.contrib, e.k);
          const R2 = { ...R, stake: without, firstRaise: rec.events.filter((x) => x.raise > 0 && x.k !== e.k)[0]?.k ?? null };
          const alt = settle(rule, R2).pay;
          o.raiseDelta += net[e.seat] - (alt[e.seat] - without[e.seat]);
          o.raiseChips += e.raise;
        }
      }
      for (const x of s.seats) if (x.chips < 30 && !x.bot) x.chips = 100;
      ctx.now += 1000;
      act(s, 0, { action: 'next' }, ctx);
    }
  }
  return out;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const results = {};

for (const seats of SEATS) {
  results[seats] = { house: run(seats, 'house') };
}

if (!AS_JSON) {
  console.log(`${TABLES} tables x ${ROUNDS} rounds per seat count. Stock bots: seat 0 plays the house persona; the rest are the house bots in order.\n`);
  for (const seats of SEATS) {
    const base = results[seats].house;
    console.log(`## ${seats} players  (${base.C.rounds} rounds: Liar call ${pct(base.C.calls, base.C.rounds)}, everyone folded ${pct(base.C.uncontested, base.C.rounds)}, round has a raise ${pct(base.C.raiseRounds, base.C.rounds)})`);
    console.log('rule  raise: chips/round   dead raise chips   raise value per chip   bystander wins (per seat)   round with a bystander win   caller loses but still wins   bidder loses but still wins   voided');
    for (const rule of RULES) {
      const o = base[rule];
      console.log([
        rule.padEnd(5), f2(o.raisedChips / o.rounds).padEnd(19), pct(o.deadRaiseChips, o.raisedChips).padEnd(18), f2(o.raiseDelta / o.raiseChips).padEnd(22),
        pct(o.bystanderWins, o.bystanderSeatRounds).padEnd(27), pct(o.roundsWithBystanderWin, o.roundsWithBystander).padEnd(28),
        pct(o.callerLostButWon, o.callerLost).padEnd(29), pct(o.bidderLostButWon, o.bidderLost).padEnd(29), pct(o.voided, o.calls),
      ].join(' '));
    }
    console.log('\nright call vs standing by (rounds where the bid fell and a bystander was in): caller net, and its edge over a bystander in the same round');
    for (const rule of RULES) console.log(`  ${rule.padEnd(7)} caller +${f2(base[rule].rightCallerNet / base[rule].gapN)}   edge over bystander ${f2(base[rule].gapSum / base[rule].gapN)}`);
    console.log('\nnet chips per round, by seat:');
    const names = Object.keys(base.C.net);
    console.log(['rule', ...names.map((x) => x.padEnd(13))].join('  '));
    for (const rule of RULES) console.log([rule.padEnd(4), ...names.map((nm) => f2(base[rule].net[nm] / base[rule].nRounds[nm]).padEnd(13))].join('  '));
    console.log('');
  }
  for (const seats of SEATS) {
    console.log(`## smart stand-in in seat 0, ${seats} players: net chips per round for seat 0, by policy and rule (the others stay stock)`);
    console.log(['policy'.padEnd(20), ...RULES.map((r) => r.padStart(8)), '  raise/round'].join(' '));
    for (const name of Object.keys(POLICIES)) {
      const r = name === 'house' ? results[seats].house : run(seats, name);
      results[seats][name] = r;
      console.log([name.padEnd(20), ...RULES.map((rule) => f2(r[rule].net['Stand-in'] / r[rule].nRounds['Stand-in']).padStart(8)), `  ${f2(r.C.raisedChips / r.C.rounds)}`].join(' '));
    }
    console.log('');
  }
} else {
  for (const seats of SEATS) for (const name of Object.keys(POLICIES)) results[seats][name] ??= run(seats, name);
  console.log(JSON.stringify(results));
}
