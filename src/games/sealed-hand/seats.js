// Finding a player's seat at a table. The player's holds say which tables have their chips; the table says
// whether the seat is still there and what's on it. The /seat-of route is internal: index.js doesn't route to it.

export const GAME_ID = 'sealed-hand';

/** { status: 'seated', seat, stack, phase, round }, { status: 'left', seat, stack }, or { status: 'none' }. */
export async function seatOf(env, tableId, playerId) {
  try {
    const stub = env.TABLE.get(env.TABLE.idFromString(tableId));
    const res = await stub.fetch(new Request('https://table/seat-of', { method: 'POST', body: JSON.stringify({ playerId }) }));
    return res.ok ? await res.json() : { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

/** The tables named in a player's holds where they are still sitting, biggest stack first. */
export async function liveSeats(env, inPlay, playerId, { except } = {}) {
  const keys = inPlay.map((hold) => hold.key).filter((key) => key !== except && key.startsWith(`${GAME_ID}:`));
  const seats = await Promise.all(keys.map(async (key) => {
    const tableId = key.slice(GAME_ID.length + 1);
    return { game: GAME_ID, tableId, ...(await seatOf(env, tableId, playerId)) };
  }));
  return seats.filter((seat) => seat.status === 'seated').sort((a, b) => b.stack - a.stack);
}
