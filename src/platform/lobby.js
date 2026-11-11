// The lobby, for people and agents (11-08, bring your own agent, phase 1):
//   GET  /lobby/tables              every listed table, both games, flat: who sits there (human, agent or house) and a watch link
//   POST /lobby/open {game, seats?, lobbySeconds?}
//                                   a play-chip table of that game with a free seat: one waiting in its lobby, or a new one.
//                                   Then POST <api>/join as usual. When a table fills, the next caller gets a new one.
//   GET  /watch/:game/:n            a plain spectator link: sends you to table n of that game, watching (no seat, no hand)
// The page is /lobby (public/lobby.html). Nothing here is private: it is the Hall's list, which GET /games already shows.

import { directoryStub } from './directory.js';
import { fail, json } from './http.js';
import { LOBBY_GAMES, gameOf, lobbyRows, openOptions } from './lobby-pick.js';

export { LOBBY_GAMES, gameOf, lobbyRows, openOptions };

async function readBody(request) {
  const text = await request.text();
  if (text.length > 1024) return { error: fail(413, 'too_large', 'Request body is over 1024 bytes.') };
  if (!text.trim()) return { body: {} };
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: fail(400, 'bad_json', 'Send a JSON object.') };
    return { body };
  } catch {
    return { error: fail(400, 'bad_json', 'Request body is not valid JSON.') };
  }
}

export async function lobbyRoute(request, env, parts) {
  const stub = directoryStub(env);
  if (parts[1] === 'tables' && parts.length === 2) {
    if (request.method !== 'GET') return fail(405, 'method', 'Use GET /lobby/tables.');
    const byGame = await (await stub.fetch('https://directory/list')).json();
    const tables = lobbyRows(byGame);
    return json({
      tables,
      totals: { tables: tables.length, humans: tables.reduce((n, t) => n + t.humans, 0), agents: tables.reduce((n, t) => n + t.agents, 0) },
      note: 'Up to 25 open tables per game, waiting ones first. kind is what a seat said it was when it sat: house bots are the only "house".',
    });
  }
  if (parts[1] === 'open' && parts.length === 2) {
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /lobby/open with { "game": "cup-and-claim" } or { "game": "sealed-hand" }.');
    const read = await readBody(request);
    if (read.error) return read.error;
    const opts = openOptions(read.body);
    if (opts.error) return fail(400, 'bad_options', opts.error);
    const res = await stub.fetch(new Request('https://directory/lobby/open', { method: 'POST', body: JSON.stringify(opts) }));
    const out = await res.json();
    if (!res.ok) return json(out, res.status);
    const info = LOBBY_GAMES[opts.game];
    return json({ ...out, game: opts.game, api: `${info.api}/${out.id}`, join: `POST ${info.api}/${out.id}/join`, watch: `${info.page}?id=${out.id}&watch=1` }, out.created ? 201 : 200);
  }
  return fail(404, 'not_found', 'Use GET /lobby/tables or POST /lobby/open. The page is /lobby.');
}

/** GET /watch/:game/:n → the table page, watching. */
export async function watchRoute(request, env, parts) {
  if (request.method !== 'GET') return fail(405, 'method', 'Use GET /watch/<game>/<table number>.');
  const game = gameOf(parts[1]);
  const n = Number(parts[2]);
  if (!game || parts.length !== 3 || !Number.isInteger(n) || n < 1) return fail(404, 'not_found', 'A watch link is /watch/sealed-hand/<n> or /watch/cup-and-claim/<n>. The lobby lists them: /lobby.');
  const byGame = await (await directoryStub(env).fetch('https://directory/list')).json();
  const t = (byGame[game] ?? []).find((x) => x.n === n);
  if (!t) return fail(404, 'no_table', `${LOBBY_GAMES[game].name} table ${n} is not open now. The lobby lists the open ones: /lobby.`);
  return new Response(null, { status: 302, headers: { location: `${LOBBY_GAMES[game].page}?id=${t.id}&watch=1`, 'cache-control': 'no-store' } });
}
