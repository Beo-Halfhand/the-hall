// The leaderboard: net play chips won this week, per player, across every play-chip table of every game. A table queues one
// line per seat for each round it settles and sends them to the Hall's Directory, which keeps the weekly totals.
//
// Who counts: a seat with a player (a purse). House bots, and seats that came with table chips only, have no player and aren't
// ranked. tNIGHT tables aren't counted: this board is play chips only. Weeks run Monday 00:00 to Monday 00:00, Pacific time.
//
// The Directory stores   b:<week>:<playerId>  { name, avatar, kind, net, rounds, wins, last, seen }
// where `seen` is the last few round ids, so a line sent twice (a retry after a lost answer) is counted once.

import { fail, json } from './http.js';
import { verifyPlayer } from './chips.js';

const ZONE = 'America/Los_Angeles';
// The Hall's Directory, named as directory.js names it. Not imported from there: that module needs the Workers runtime, and these sums are tested in plain Node.
const directoryStub = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('hall'));
const QUEUE_MAX = 40;
const SEEN_MAX = 30;
export const BOARD_SHOWN = 50;

/** Minutes this zone is ahead of UTC at `ms` (negative for Pacific). */
function zoneOffsetMin(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Local midnight (Pacific) of a Y-M-D, as a UTC instant. Handles the clock change, since midnight is never in the skipped hour. */
function localMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  return guess - zoneOffsetMin(guess - 12 * 3_600_000) * 60_000;
}

/** The week `ms` falls in: { key: '2026-11-02' (its Monday), start, end } with start and end as UTC instants. `back` weeks earlier. */
export function weekOf(ms, back = 0) {
  const local = new Date(ms + zoneOffsetMin(ms) * 60_000); // its fields read as Pacific wall time
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - sinceMonday - 7 * back));
  const [y, m, d] = [monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()];
  const next = new Date(Date.UTC(y, m - 1, d + 7));
  return {
    key: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    start: localMidnight(y, m, d),
    end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

/**
 * The table's side, before it saves: one line per ranked seat for a round that has just settled. `nets` is [{ seat, net }] for
 * the seats dealt in, from the game. Only once per round, never at a tNIGHT table, and not for a pot handed back as a table closed.
 */
export function boardAfterChange(s, tableId, nets) {
  const r = s.lastResult;
  if (s.cage || !r || r.round !== s.round || r.kind === 'returned' || s.boardRound === r.round) return;
  s.boardRound = r.round;
  const lines = nets.flatMap(({ seat, net }) => {
    const playerId = s.players?.[seat];
    const x = s.seats[seat];
    if (!playerId || !x || x.bot) return [];
    return [{ id: `${tableId.slice(0, 16)}:${r.round}`, playerId, name: x.name, avatar: x.avatar ?? null, kind: x.kind ?? 'agent', net }];
  });
  if (!lines.length) return;
  s.boardQueue = [...(s.boardQueue ?? []), ...lines].slice(-QUEUE_MAX);
}

/** Sealed Hand: the round's money per seat ({ in, out }), for the seats that put chips in or took some out. */
export const netsFromMoney = (r) => (r?.money ?? []).flatMap((m, seat) => (m && (m.in > 0 || m.out > 0) ? [{ seat, net: m.out - m.in }] : []));

/** Cup & Claim: each seat's award less its stake, for the seats dealt in. */
export const netsFromStakes = (r) => (r?.stakes ?? []).flatMap((stake, seat) => {
  const award = r.awards?.find((a) => a.seat === seat)?.amount ?? 0;
  return stake > 0 || award > 0 ? [{ seat, net: award - stake }] : [];
});

/** Sends the queued lines to the Directory. Returns whether any went, so the table saves the shorter queue. */
export async function flushBoard(env, s) {
  if (!s.boardQueue?.length) return false;
  try {
    const res = await directoryStub(env).fetch(new Request('https://directory/board/add', { method: 'POST', body: JSON.stringify({ lines: s.boardQueue, at: Date.now() }) }));
    if (!res.ok) return false;
  } catch (err) {
    console.error('leaderboard line will retry:', err?.message);
    return false;
  }
  s.boardQueue = [];
  return true;
}

// ---------- the Directory's side ----------

const keyOf = (week, playerId) => `b:${week}:${playerId}`;

export async function boardAdd(storage, { lines, at }) {
  if (!Array.isArray(lines)) return fail(400, 'bad_lines', 'lines is a list.');
  const week = weekOf(Number.isFinite(at) ? at : Date.now()).key;
  for (const line of lines.slice(0, QUEUE_MAX)) {
    if (!/^[0-9a-f]{64}$/.test(line?.playerId ?? '') || !Number.isInteger(line.net) || typeof line.id !== 'string') continue;
    const key = keyOf(week, line.playerId);
    const row = (await storage.get(key)) ?? { net: 0, rounds: 0, wins: 0, seen: [] };
    if (row.seen.includes(line.id)) continue;
    row.seen = [...row.seen, line.id].slice(-SEEN_MAX);
    Object.assign(row, { name: String(line.name ?? '').slice(0, 24), avatar: line.avatar ?? null, kind: line.kind === 'human' ? 'human' : 'agent', last: at });
    row.net += line.net;
    row.rounds += 1;
    if (line.net > 0) row.wins += 1;
    await storage.put(key, row);
  }
  return json({ ok: true });
}

/** The week's table: best net first, then more rounds won, then whoever got there first. Ranks are shared on a full tie. */
export async function boardList(storage, { week, playerId = null }) {
  const rows = [...(await storage.list({ prefix: `b:${week}:` }))].map(([key, r]) => ({ playerId: key.slice(key.lastIndexOf(':') + 1), ...r }));
  rows.sort((a, b) => b.net - a.net || b.wins - a.wins || a.last - b.last);
  let rank = 0;
  const ranked = rows.map((r, i) => {
    if (i === 0 || r.net !== rows[i - 1].net || r.wins !== rows[i - 1].wins) rank = i + 1;
    return { rank, name: r.name, avatar: r.avatar, kind: r.kind, net: r.net, rounds: r.rounds, wins: r.wins, ...(r.playerId === playerId ? { you: true } : {}) };
  });
  return json({ players: ranked.length, rows: ranked.slice(0, BOARD_SHOWN), you: ranked.find((r) => r.you) ?? null });
}

/** GET /board[?week=last] with an optional player token: the week's table, and your own row wherever it is. Never anyone's id. */
export async function boardRoute(request, env, parts) {
  if (request.method !== 'GET' || parts.length !== 1) return fail(404, 'not_found', 'Use GET /board, or GET /board?week=last.');
  const which = new URL(request.url).searchParams.get('week');
  if (which && which !== 'last' && which !== 'this') return fail(400, 'bad_week', 'week is "this" (the default) or "last".');
  const week = weekOf(Date.now(), which === 'last' ? 1 : 0);
  const auth = request.headers.get('authorization') ?? '';
  // Your row only for your real token: the purse checks the secret, so nobody can find someone else's row by their id.
  const playerId = auth.startsWith('Bearer ') ? await verifyPlayer(env, auth.slice(7)).then((me) => me.playerId, () => null) : null;
  const res = await directoryStub(env).fetch(new Request('https://directory/board/list', { method: 'POST', body: JSON.stringify({ week: week.key, playerId }) }));
  const body = await res.json();
  return new Response(JSON.stringify({ week: { ...week, which: which === 'last' ? 'last' : 'this', zone: ZONE }, counts: 'Ranked by net play chips won this week, across every play-chip table of every game: what a player won less what they lost, round by round. Stack size and Fill up refills do not count, so a refill never moves the board. Ties go to the player with more rounds won. House bots and tNIGHT tables are not counted.', ...body }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

