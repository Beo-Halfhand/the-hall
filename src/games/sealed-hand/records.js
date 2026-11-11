// The public round records for Sealed Hand: every round, play chips or tNIGHT, gets a number the world can look up at /records.
// Pure state on s.rec, no I/O: table.js sends what's queued to the records book (platform/records.js). Cup & Claim's is the model.
//
//   Sealed Hand · table 3 · round 41              a play-chip table: the Hall's number for the table, and the round the engine dealt
//   Sealed Hand · tNIGHT table 114 · round 47     a tNIGHT table: its cage table and the round the chain counts it as
//
// Two parts per round, in this order, and each is written once:
//   at the deal    the deck seal: one hash over the table, the round, the house's seed for the round and the whole shuffled deck,
//                  before any card is dealt or passed (fair.js). Who was dealt in, and the ante. No card.
//   at the end     the seed and the deck order opened, every pass (who sent which card to whom), every claim with its verdict, every
//                  call, who folded, the hands as they stood, the result and the chips moved; for a tNIGHT round, the settle
//                  transaction when it lands.
// Until the round ends no card is in a record. Once it is, anyone can rebuild every hand from the opened deck and the passes, and
// recheck each claim's verdict ("proven": called, and the cards held it; "caught": called, a bluff) against the cards.

import { labelClaim } from './cards.js';
import { DOMAIN, SEAL_NOTE } from './fair.js';
import { sealDeal } from './engine.js';

const nameAt = (s, seat) => s.seats[seat]?.name ?? `Seat ${seat}`;

/** The number a round goes by: a tNIGHT round as its chain round (like a Cup & Claim receipt), a play round by the Hall's number. */
export const recordNumber = (s, n, round) => (s.cage
  ? { table: s.cage.table, round: (s.cage.chainBase ?? 0) + round }
  : Number.isInteger(n) ? { table: n, round } : null);

/** What goes up at the deal, under the round's number: the seal, and who is in. */
export function openingParts(s, number) {
  const seal = sealDeal(s, number);
  return {
    ...(seal ? { seal: { hash: seal, domain: DOMAIN.seal, how: SEAL_NOTE, postedAt: Date.now() } } : {}),
    seats: s.seats.map((x, seat) => ({ seat, name: x.name, kind: x.kind, bot: !!x.bot, dealt: s.status?.[seat] === 'in' || s.status?.[seat] === 'folded' })),
    engineRound: s.round,
    ante: s.cfg.ante,
    postedAt: Date.now(),
  };
}

/** What each seat won or lost this round, net of what it put in (antes, raises, matches and call stakes). */
const netChips = (s, r) => (r.money ?? [])
  .map((m, seat) => ({ seat, m }))
  .filter(({ m }) => m && (m.in > 0 || m.out > 0))
  .map(({ seat, m }) => ({ name: nameAt(s, seat), kind: s.seats[seat]?.kind ?? null, delta: m.out - m.in }));

/** The chips a tNIGHT round moved, as the judge's entry has them. A carried pot has none until the next paid pot. */
function cageMoved(s) {
  const c = s.cage;
  const entry = c.entries.find((e) => e.rounds.includes(s.round));
  return entry?.lines.map((l) => ({ cageId: l.id, name: c.holders[l.id]?.name ?? 'seat', kind: c.holders[l.id]?.kind ?? null, delta: l.delta })) ?? [];
}

/**
 * The round's moves, enough to replay it from the opened deck: each pass as the cards that moved (sender, receiver, card), the
 * claims with the claim itself and the table's verdict, and the calls (who called whom, and what the cards said). Folds move no card.
 */
export function movesOf(s) {
  const passes = [];
  for (const [seat, log] of (s.passLog ?? []).entries()) {
    for (const p of log) (passes[p.n - 1] ??= []).push({ from: seat, to: p.to, card: p.sent });
  }
  for (const list of passes) list?.sort((a, b) => a.from - b.from);
  const calls = (s.log ?? []).filter((l) => l.round === s.round && l.act?.kind === 'call').map((l) => ({ seat: l.act.seat, target: l.act.target, result: l.act.result === 'checked' ? 'proven' : 'caught' }));
  return {
    passes: passes.map((list) => list ?? []),
    claims: (s.claims ?? []).map((c) => ({ seat: c.seat, name: nameAt(s, c.seat), claim: [...c.claim], label: labelClaim(c.claim), status: c.status })),
    calls,
  };
}

/** What goes up when the round ends: the deck opened, the moves, the hands, and what the table made of it all. */
export function closingParts(s) {
  const opened = s.deal ? { opened: { seed: s.deal.seed, deck: [...s.deal.deck], at: Date.now() }, moves: movesOf(s), hands: s.seats.map((_, seat) => (s.status?.[seat] === 'in' || s.status?.[seat] === 'folded' ? [...(s.hands?.[seat] ?? [])] : null)) } : {};
  const r = s.lastResult?.round === s.round ? s.lastResult : null;
  if (!r) return { ...opened, result: { kind: 'void', why: s.overReason ?? 'The round did not finish.' }, claims: [], folded: [], chips: [], closedAt: Date.now() };
  const awards = (r.awards ?? []).map((a) => ({ seat: a.seat, name: nameAt(s, a.seat), amount: a.amount, ...(a.claim ? { label: labelClaim(a.claim) } : a.label ? { label: a.label } : {}) }));
  return {
    ...opened,
    claims: (r.claims ?? []).map((c) => ({ seat: c.seat, name: nameAt(s, c.seat), label: c.label, status: c.status })),
    folded: (r.folded ?? []).map((seat) => ({ seat, name: nameAt(s, seat) })),
    result: { kind: r.kind, pot: r.pot, carried: r.carried ?? 0, awards },
    chips: s.cage ? cageMoved(s) : netChips(s, r),
    closedAt: Date.now(),
  };
}

/** Runs after the engine's step on every change and queues anything new. Safe to run again. `n` is the Hall's number for a play table. */
export function recordsAfterChange(s, n) {
  const c = s.cage;
  const rec = (s.rec ??= { posted: 0, closed: 0, queue: [] });
  const kind = c ? 'tnight' : 'play';
  if (!recordNumber(s, n, 1)) return; // a play table is numbered by the Hall at its first report: nothing can be posted before
  const push = (round, patch) => rec.queue.push({ kind, ...recordNumber(s, n, round), patch });
  if (s.round > rec.posted) {
    rec.posted = s.round;
    push(s.round, { ...openingParts(s, recordNumber(s, n, s.round)), ...(c ? { cage: { address: c.address, network: 'preprod' } } : {}) });
  }
  if ((s.phase === 'settled' || s.phase === 'over') && s.round > rec.closed && rec.posted >= s.round) {
    rec.closed = s.round;
    push(s.round, closingParts(s));
  }
  for (const e of c?.entries ?? []) { // a tNIGHT round's chain half: its settle transaction, or why it never settled
    if (e.recBooked || (!e.tx && !e.void)) continue;
    e.recBooked = true;
    for (const round of e.rounds) {
      if (e.tx) {
        const { hash, id, block, status, chainRound, blockAt } = e.tx;
        push(round, { settle: { hash, id: id ?? null, block, status, chainRound: chainRound === undefined ? null : Number(chainRound), blockAt: blockAt ?? null, rounds: e.rounds.map((x) => recordNumber(s, n, x).round) } });
      } else push(round, { void: { why: c.deadReason ?? 'The table closed before this round settled.' } });
    }
  }
}
