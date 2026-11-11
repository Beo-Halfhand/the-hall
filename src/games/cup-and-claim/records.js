// The public round records for Cup & Claim: every round, play chips or tNIGHT, gets a number the world can look up.
// Pure state on s.rec, no I/O: table.js sends what's queued to the records book (platform/records.js).
//
//   Cup & Claim · table 3 · round 41      a play-chip table: the Hall's number for the table, and the round the engine dealt
//   Cup & Claim · tNIGHT table 114 · round 47   a tNIGHT table: its cage table and the chain's round (the receipt's number)
//
// Two parts per round, in this order, and each is written once:
//   at the deal    the dice fingerprint: a hash over the house's sealed secret and every seat's. Before anyone sees a die.
//   at the end     the house secret opened, the claim, the call, the result, each cup's answer, the chips moved,
//                  and, for a tNIGHT round, the settle transaction when it lands.
// Anyone can recheck the fingerprint against the opened secrets: the same arithmetic as a receipt's (see fair.js).

import { nameAt, closingParts, openingParts, receiptNumber } from './receipts.js';

/** What each seat won or lost this round, net of what it put in. Play chips: the engine kept every seat's stake for this. */
function netChips(s) {
  const stakes = s.lastStakes ?? [];
  const won = s.lastResult?.round === s.round ? s.lastResult.awards : [];
  const dealt = s.seats.map((_, seat) => seat).filter((seat) => s.commits[seat] !== null && s.commits[seat] !== undefined);
  return dealt.map((seat) => ({
    name: nameAt(s, seat),
    kind: s.seats[seat].kind,
    delta: (won.filter((a) => a.seat === seat).reduce((sum, a) => sum + a.amount, 0)) - (stakes[seat] ?? 0),
  }));
}

/** Runs after the engine's step on every change and queues anything new. Safe to run again. `n` is the Hall's number for a play table. */
export function recordsAfterChange(s, n) {
  const c = s.cage;
  const rec = (s.rec ??= { posted: 0, closed: 0, queue: [] });
  const kind = c ? 'tnight' : 'play';
  const number = (round) => (c ? receiptNumber(c, round) : n ? { table: n, round } : null);
  const push = (round, patch) => rec.queue.push({ kind, ...number(round), patch });
  if (!number(s.round ?? 1)) return; // a play table is numbered by the Hall at its first report: nothing can be posted before
  if (s.round > rec.posted && s.houseCommit) {
    rec.posted = s.round;
    push(s.round, { ...openingParts(s, number(s.round)), ...(c ? { cage: { address: c.address, network: 'preprod' } } : {}) });
  }
  if ((s.phase === 'settled' || s.phase === 'over') && s.round > rec.closed && rec.posted >= s.round) {
    rec.closed = s.round;
    const moved = c
      ? (c.entries.find((e) => e.rounds.includes(s.round))?.lines.map((l) => ({ cageId: l.id, name: c.holders[l.id]?.name ?? 'seat', kind: c.holders[l.id]?.kind ?? null, delta: l.delta })) ?? [])
      : netChips(s);
    push(s.round, closingParts(s, moved));
  }
  for (const e of c?.entries ?? []) { // a tNIGHT round's chain half: its settle transaction, or why it never settled
    if (e.recBooked || (!e.tx && !e.void)) continue;
    e.recBooked = true;
    for (const round of e.rounds) {
      if (e.tx) {
        const { hash, id, block, status, chainRound, blockAt } = e.tx;
        push(round, { settle: { hash, id: id ?? null, block, status, chainRound: chainRound === undefined ? null : Number(chainRound), blockAt: blockAt ?? null, rounds: e.rounds.map((x) => receiptNumber(c, x).round) } });
      } else push(round, { void: { why: c.deadReason ?? 'The table closed before this round settled.' } });
    }
  }
}
