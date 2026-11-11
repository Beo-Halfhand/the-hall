// The lobby's pure parts (11-08, bring your own agent): which games, how a table is listed, and how POST /lobby/open picks a
// table with room. No Worker imports, so the Directory and the unit tests can both use it. The routes are in lobby.js.

export const LOBBY_GAMES = {
  'sealed-hand': { name: 'Sealed Hand', page: '/table', api: '/tables', binding: 'TABLE', seats: [4, 4], aliases: ['cards', 'sh'] },
  'cup-and-claim': { name: 'Cup & Claim', page: '/dice', api: '/dice-tables', binding: 'DICE_TABLE', seats: [2, 6], aliases: ['dice', 'cc'] },
};

/** A game id from a name or a short alias ("dice", "cards"), or null. */
export function gameOf(name) {
  const key = String(name ?? '').toLowerCase();
  if (LOBBY_GAMES[key]) return key;
  return Object.keys(LOBBY_GAMES).find((id) => LOBBY_GAMES[id].aliases.includes(key)) ?? null;
}

/** One seat as the lobby shows it: a name and what it is. A house bot is "house"; anyone else said "human" or "agent" when they sat. */
export const seatKind = (face) => (face.kind === 'house' ? 'house' : face.kind === 'human' ? 'human' : 'agent');

/** The Hall's list, flattened into rows for the lobby. `byGame` is the Directory's list. */
export function lobbyRows(byGame) {
  const rows = [];
  for (const [game, info] of Object.entries(LOBBY_GAMES)) {
    for (const t of byGame[game] ?? []) {
      const seated = (t.faces ?? []).map((f) => ({ name: f.name, kind: seatKind(f) }));
      const count = (k) => seated.filter((x) => x.kind === k).length;
      rows.push({
        game,
        gameName: info.name,
        n: t.n ?? null,
        id: t.id,
        phase: t.phase,
        round: t.round ?? 0,
        seats: t.seats,
        seatsFilled: t.seatsFilled,
        joinable: !!t.joinable,
        tnight: !!t.tnight,
        ...(t.tnight && Number.isInteger(t.table) ? { cageTable: t.table } : {}), // a tNIGHT table goes by its cage table number, as on its page and receipts
        players: seated,
        humans: count('human'),
        agents: count('agent'),
        house: count('house'),
        api: `${info.api}/${t.id}`,
        watch: t.n ? `/watch/${game}/${t.n}` : `${info.page}?id=${t.id}&watch=1`,
      });
    }
  }
  return rows;
}

/** Checks POST /lobby/open's options. Returns { game, seats, lobbySeconds } or { error }. */
export function openOptions(body) {
  const game = gameOf(body.game);
  if (!game) return { error: `game must be one of: ${Object.keys(LOBBY_GAMES).join(', ')}.` };
  const [lo, hi] = LOBBY_GAMES[game].seats;
  const seats = body.seats ?? 4;
  if (!Number.isInteger(seats) || seats < lo || seats > hi) return { error: lo === hi ? `${LOBBY_GAMES[game].name} tables have ${lo} seats.` : `seats must be a whole number from ${lo} to ${hi}.` };
  const lobbySeconds = body.lobbySeconds ?? 30;
  if (!Number.isInteger(lobbySeconds) || lobbySeconds < 0 || lobbySeconds > 300) return { error: 'lobbySeconds must be a whole number from 0 to 300.' };
  return { game, seats, lobbySeconds };
}

// ---------- inside the Directory: find a free seat or open a table, one caller at a time ----------

const HOLD_MS = 15_000; // a seat handed out is counted as taken this long, so callers at the same moment spread out
const FRESH_MS = 60_000; // a table opened here is offered this long before it has reported in (it reports at its first join)

/**
 * The Directory's half of POST /lobby/open. `state` is the Directory's in-memory { holds, fresh }; `rows` are the stored table rows
 * of the game. Returns { id, created:false } for a table with room, or null when a new one must be opened.
 */
export function pickTable({ game, seats }, rows, state, now) {
  state.holds = (state.holds ?? []).filter((h) => now - h.at < HOLD_MS);
  state.fresh = (state.fresh ?? []).filter((f) => now - f.at < FRESH_MS);
  // A hold made before the table's latest report is in that report already (the caller sat) or was dropped: only newer ones count.
  const held = (id, since) => state.holds.filter((h) => h.id === id && h.at > since).length;
  const listed = rows.filter((t) => t.game === game && t.joinable && !t.tnight && t.phase === 'lobby' && t.seats === seats).map((t) => ({ id: t.id, filled: t.seatsFilled, seats: t.seats, since: t.updatedAt ?? 0 }));
  const freshOnly = state.fresh.filter((f) => f.game === game && f.seats === seats && !listed.some((t) => t.id === f.id)).map((f) => ({ id: f.id, filled: 0, seats: f.seats, since: 0 }));
  for (const t of [...listed, ...freshOnly]) {
    if (t.filled + held(t.id, t.since) < t.seats) {
      state.holds.push({ id: t.id, at: now });
      return { id: t.id, created: false };
    }
  }
  return null;
}

/** Records a table this Directory just opened, and holds its first seat for the caller. */
export function noteOpened({ game, seats }, id, state, now) {
  (state.fresh ??= []).push({ id, game, seats, at: now });
  (state.holds ??= []).push({ id, at: now });
}

export const tableBinding = (game) => LOBBY_GAMES[game]?.binding ?? null;
