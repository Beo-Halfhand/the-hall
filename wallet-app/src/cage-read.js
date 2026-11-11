// What the page reads from the cage's ledger. v4 keeps these in separate maps so its transactions don't collide: atRisk in risks, the epoch in
// epochs, the seat count in a Counter. The page wants them where the seat and the table are. Plain data only, so the same code runs against the simulator in tests.

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The table a seat is at, or null: last round, heartbeat, epoch and how many sit there. */
export function tableOf(L, seat) {
  if (!seat || !L.tables.member(seat.table)) return null;
  return { ...L.tables.lookup(seat.table), epoch: L.epochs.member(seat.table) ? L.epochs.lookup(seat.table) : 0n, seated: L.seats.member(seat.table) ? L.seats.lookup(seat.table).read() : 0n };
}

/** One player's seat, with what it can still lose. */
export function seatOf(L, idBytes) {
  if (!L.seat.member(idBytes)) return null;
  return { ...L.seat.lookup(idBytes), atRisk: L.risks.member(idBytes) ? L.risks.lookup(idBytes) : 0n };
}

/** One player's permit, in the form the page compares. */
export function permitOf(L, idBytes) {
  if (!L.permits.member(idBytes)) return null;
  const p = L.permits.lookup(idBytes);
  return { judge: toHex(p.judge), cap: p.cap, until: p.until, floor: p.floor };
}

const balanceOf = (L, idBytes) => (L.balance.member(idBytes) ? L.balance.lookup(idBytes) : 0n);

/** What every read carries, player or not. maxGrant (L1): the longest a permit may run past the block's clock, in seconds. */
export const baseOf = (L) => ({ escapeSecs: L.escapeSecs, roundCap: L.roundCap, maxSeats: L.maxSeats, maxGrant: L.maxGrant, judge: toHex(L.judge) });

/** Everything the page knows about one player. */
export function readPlayer(L, idBytes, payoutHex) {
  const seat = seatOf(L, idBytes);
  const bound = L.payTo.member(idBytes);
  return {
    ...baseOf(L),
    id: toHex(idBytes),
    balance: balanceOf(L, idBytes),
    seat,
    table: tableOf(L, seat),
    permit: permitOf(L, idBytes),
    bound,
    ours: bound && toHex(L.payTo.lookup(idBytes).bytes) === payoutHex,
  };
}

/** Every player id whose withdrawals are fixed to this wallet. The cage's payout list is public. */
export function findByPayout(L, payoutHex) {
  const found = [];
  for (const [idBytes, to] of L.payTo) {
    if (toHex(to.bytes) !== payoutHex) continue;
    const seat = seatOf(L, idBytes);
    found.push({ id: toHex(idBytes), idBytes, balance: balanceOf(L, idBytes), seat, table: tableOf(L, seat), escapeSecs: L.escapeSecs });
  }
  return found;
}
