// Finding a player's seat at a Cup & Claim table. Same shape as the Sealed Hand one, against the DICE_TABLE binding.

export const GAME_ID = 'cup-and-claim';

export async function seatOf(env, tableId, playerId) {
  try {
    const stub = env.DICE_TABLE.get(env.DICE_TABLE.idFromString(tableId));
    const res = await stub.fetch(new Request('https://table/seat-of', { method: 'POST', body: JSON.stringify({ playerId }) }));
    return res.ok ? await res.json() : { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

/** The dice tables named in a player's holds where they are still sitting, biggest stack first. */
export async function liveSeats(env, inPlay, playerId, { except } = {}) {
  const keys = inPlay.map((hold) => hold.key).filter((key) => key !== except && key.startsWith(`${GAME_ID}:`));
  const seats = await Promise.all(keys.map(async (key) => {
    const tableId = key.slice(GAME_ID.length + 1);
    return { game: GAME_ID, tableId, ...(await seatOf(env, tableId, playerId)) };
  }));
  return seats.filter((seat) => seat.status === 'seated').sort((a, b) => b.stack - a.stack);
}
