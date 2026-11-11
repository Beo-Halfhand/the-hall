// Numbered receipts for a tNIGHT dice table. Pure state on s.cage.book, no I/O: table.js sends what's queued to the receipt book.
//
// Every round gets a public number, its cage table and the round the chain will count it as: "Table 114 · Round 47". The chain's
// counter only moves by one, and a table's rounds settle in order, so the number is known from the first deal.
//   - At the deal: the fingerprint goes up, before anyone sees a die. It's a hash over the two kinds of sealed secret.
//   - When the round ends: the house secret opens, with the claim, the call, each cup's answer and the chips moved.
//   - When the judge's transaction lands: its hash and block.
//
// What this proves, and what it doesn't: the chain holds the money. The fingerprint and the counts are this server's word. A
// shut cup's count stays house-attested until a circuit replaces it, so `attested` says so on every receipt that has one.

import { DOMAIN, FINGERPRINT_NOTE, roundFingerprint } from './fair.js';

const faceLabel = (bid) => ({ count: bid.count, face: bid.face, label: `at least ${bid.count} of face ${bid.face}, 1s wild` });

/** The number a round goes by. Null until a seat has been confirmed: a table with nobody at it has no rounds. */
export const receiptNumber = (cage, round) => ({ table: cage.table, round: (cage.chainBase ?? 0) + round });
export const receiptId = (cage, round) => { const n = receiptNumber(cage, round); return `${n.table}-${n.round}`; };

function book(c) {
  c.book ??= { posted: 0, closed: 0, queue: [], fingerprint: null };
  return c.book;
}

export const nameAt = (s, seat) => s.seats[seat]?.name ?? `Seat ${seat}`;

/** What goes up at the deal, for the round's public number. The same for a tNIGHT round and a play-chip one. */
export function openingParts(s, { table, round }) {
  const fingerprint = roundFingerprint({ table, round, houseCommit: s.houseCommit, commits: s.commits });
  return {
    fingerprint: { hash: fingerprint, houseCommit: s.houseCommit, commits: [...s.commits], domain: DOMAIN.fingerprint, how: FINGERPRINT_NOTE, postedAt: Date.now() },
    seats: s.seats.map((x, seat) => ({ seat, name: x.name, kind: x.kind, bot: !!x.bot, dealt: s.commits[seat] !== null })),
    engineRound: s.round,
    ante: s.cfg.ante,
  };
}

const opening = (s) => openingParts(s, receiptNumber(s.cage, s.round));

/** The chips a tNIGHT round moved, as the judge's entry has them. */
function cageMoved(s) {
  const c = s.cage;
  const entry = c.entries.find((e) => e.rounds.includes(s.round));
  return entry?.lines.map((l) => ({ cageId: l.id, name: c.holders[l.id]?.name ?? 'seat', kind: c.holders[l.id]?.kind ?? null, delta: l.delta })) ?? [];
}

/** What goes up when the round ends: the opened secret, the claim, the call, each cup's answer, and `moved`, the chips that changed hands. */
export function closingParts(s, moved) {
  const out = { opened: { houseSeed: s.houseSeed, at: Date.now() }, ...(s.proof ? { dice: { contract: s.proof.address, salt: s.proof.salt, tx: { ...s.proof.tx }, why: s.lastDuel?.why ?? null } } : {}) }; // a proof table: the chain's contract, the round's salt and its transactions
  const r = s.lastResult?.round === s.round ? s.lastResult : null;
  if (!r) return { ...out, result: { kind: 'void', why: s.overReason ?? 'The round did not finish.' }, chips: [] };
  const awards = r.awards.map((a) => ({ seat: a.seat, name: nameAt(s, a.seat), amount: a.amount, ...(a.back !== undefined ? { back: a.back, share: a.share } : {}), ...(a.bonus ? { bonus: true } : {}) }));
  if (r.kind === 'duel') {
    const d = s.lastDuel;
    const reveals = d.reveals.map(({ proof, ...x }) => ({ ...x, name: nameAt(s, x.seat), attested: proof?.kind ?? null, ...(proof?.hash ? { proofHash: proof.hash } : {}) }));
    return {
      ...out,
      claim: { seat: d.bidder, name: nameAt(s, d.bidder), ...faceLabel(d.bid) },
      call: { seat: d.caller, name: nameAt(s, d.caller) },
      result: { kind: 'call', total: d.total, held: d.held, winner: { seat: d.winner, name: nameAt(s, d.winner) }, loser: { seat: d.loser, name: nameAt(s, d.loser) }, loserStake: r.loserStake, pool: r.pool, pot: d.pot, awards },
      reveals,
      attested: reveals.filter((x) => x.attested && x.attested !== 'compact-proof').map((x) => x.seat), // the chain checked a compact-proof: nobody has to take the house's word
      ...(s.proof ? { proven: reveals.filter((x) => x.attested === 'compact-proof').map((x) => ({ seat: x.seat, hash: x.proofHash ?? null })) } : {}),
      chips: moved,
    };
  }
  return { ...out, claim: s.bid ? { seat: s.bid.seat, name: nameAt(s, s.bid.seat), ...faceLabel(s.bid) } : null, call: null, result: { kind: r.kind, pot: r.pot, awards }, reveals: [], attested: [], chips: moved };
}

/** Runs after the cage's own step, on every change, and queues anything new for the receipt book. Safe to run again. */
export function bookAfterChange(s) {
  const c = s.cage;
  if (!c) return;
  const b = book(c);
  const push = (round, patch) => b.queue.push({ ...receiptNumber(c, round), patch });
  if (s.round > b.posted && s.houseCommit && (!s.proof || s.proof.salt || s.proof.stage === 'done')) { // at a proof table the cups are final only once the seed opens
    const patch = opening(s);
    b.fingerprint = patch.fingerprint.hash;
    b.posted = s.round;
    push(s.round, patch);
  }
  if ((s.phase === 'settled' || s.phase === 'over') && s.round > b.closed && b.posted >= s.round) {
    b.closed = s.round;
    push(s.round, closingParts(s, cageMoved(s)));
  }
  for (const e of c.entries) {
    if (e.booked) continue;
    if (!e.tx && !e.void) continue;
    e.booked = true;
    for (const round of e.rounds) {
      if (e.tx) {
        const { hash, id, block, status, chainRound, blockAt } = e.tx;
        push(round, { settle: { hash, id: id ?? null, block, status, chainRound: chainRound === undefined ? null : Number(chainRound), blockAt: blockAt ?? null, ...(e.dropped ? { dropped: e.dropped.map((d) => ({ cageId: d.id, name: c.holders[d.id]?.name ?? 'seat', delta: d.delta })), landed: e.lines.map((l) => ({ cageId: l.id, name: c.holders[l.id]?.name ?? 'seat', delta: l.delta })) } : {}), rounds: e.rounds.map((x) => receiptNumber(c, x).round) } });
      } else push(round, { void: { why: c.deadReason ?? 'The table closed before this round settled.' } });
    }
  }
}

/** What a page may show about the round in play or just finished. */
export function currentReceipt(s) {
  const c = s.cage;
  if (!c?.book?.posted) return null;
  const number = receiptId(c, c.book.posted);
  return { number, url: `/receipt/${number}`, fingerprint: c.book.fingerprint };
}
