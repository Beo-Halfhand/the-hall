// The judge service's door. It lists tNIGHT tables with their unsettled rounds, and takes back what it read from the
// cage and the receipts of what it landed. Off unless this Worker has TNIGHT_TABLES = "on" and a JUDGE_TOKEN secret.

import { directoryStub } from './directory.js';
import { bearer, fail, json, sha256 } from './http.js';
import { GAMES } from '../registry.js';
import { agentTnightOn } from './agent-settings.js';

const OPS = new Set(['verified', 'house', 'settled', 'released', 'standing', 'clock', 'seated', 'step', 'dead', 'alert', 'stop']);
const MAX_BODY = 16_384;

/** A Durable Object id only works with its own binding, so a table is reached through its game. */
const stubFor = (env, id, game) => {
  const ns = env[GAMES.find((g) => g.id === game)?.binding ?? 'TABLE'];
  return ns.get(ns.idFromString(id));
};
async function tableStub(env, id) {
  const res = await directoryStub(env).fetch(new Request('https://directory/cage/game', { method: 'POST', body: JSON.stringify({ id }) }));
  return stubFor(env, id, (await res.json()).game);
}

/** Compares hashes, so the check takes the same time however much of a guess is right. */
async function sameToken(given, wanted) {
  const a = await sha256(given);
  const b = await sha256(wanted);
  let diff = 0;
  for (let i = 0; i < b.length; i += 1) diff |= b.charCodeAt(i) ^ a.charCodeAt(i);
  return diff === 0;
}
const authorized = (request, env) => sameToken(bearer(request), env.JUDGE_TOKEN);

/**
 * Dice-house, the service that does the house's side of a proof table on chain. It has its own token, and can do nothing but this: it can't
 * settle, seat or release, and the judge's token doesn't open these routes. Off unless this Worker has DICE_PROOF = "on".
 */
async function diceProofRoute(request, env, parts) {
  if (env.DICE_PROOF !== 'on' || !env.DICE_HOUSE_TOKEN) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  if (!(await sameToken(bearer(request), env.DICE_HOUSE_TOKEN))) return fail(401, 'bad_token', 'Not dice-house.');
  if (parts.length === 2 && request.method === 'GET') {
    const list = await (await directoryStub(env).fetch('https://directory/cage/list')).json();
    const ids = list.tables.filter((id) => list.games?.[id] === 'cup-and-claim');
    const rows = await Promise.all(ids.map(async (id) => {
      const res = await stubFor(env, id, 'cup-and-claim').fetch(new Request('https://table/judge/proof-work'));
      return res.ok ? res.json() : null;
    }));
    return json({ address: env.DICE_PROOF_ADDRESS, tables: rows.filter((r) => r?.work) });
  }
  if (parts.length === 3 && request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BODY) return fail(413, 'too_large', 'Request body is too large.');
    let stub;
    try { stub = stubFor(env, parts[2], 'cup-and-claim'); } catch { return fail(404, 'no_table', 'No such table.'); }
    return stub.fetch(new Request('https://table/judge/proof', { method: 'POST', body: text }));
  }
  return fail(404, 'not_found', 'No such route.');
}

export async function judgeRoute(request, env, parts) {
  if (parts[1] === 'dice-proof') return diceProofRoute(request, env, parts);
  if (env.TNIGHT_TABLES !== 'on' || !env.JUDGE_TOKEN) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  if (!(await authorized(request, env))) return fail(401, 'bad_token', 'Not the judge.');

  if (parts.length === 2 && parts[1] === 'tables' && request.method === 'GET') {
    const list = await (await directoryStub(env).fetch('https://directory/cage/list')).json();
    const rows = await Promise.all(list.tables.map(async (id) => {
      const res = await stubFor(env, id, list.games?.[id]).fetch(new Request('https://table/judge/work'));
      return res.ok ? res.json() : null;
    }));
    const { doors } = await (await directoryStub(env).fetch(new Request('https://directory/door/list', { method: 'POST', body: '{}' }))).json();
    // Agents' owners' settings (phase 2): the judge verifies the waiting ones, and needs the current ones for an agent's door, its daily cap and Stop.
    const { agents } = agentTnightOn(env) ? await (await directoryStub(env).fetch(new Request('https://directory/agent/list', { method: 'POST', body: '{}' }))).json() : { agents: [] };
    return json({ address: env.CAGE_ADDRESS, tables: rows.filter(Boolean), doors, agents, games: GAMES.filter((g) => g.openWarmTable).map((g) => g.id), ...(env.TNIGHT_DRAIN === 'on' ? { draining: true } : {}) });
  }

  if (parts.length === 2 && parts[1] === 'door' && request.method === 'POST') {
    return directoryStub(env).fetch(new Request('https://directory/door/result', { method: 'POST', body: await request.text() }));
  }

  if (parts.length === 2 && parts[1] === 'agent' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BODY) return fail(413, 'too_large', 'Request body is too large.');
    return directoryStub(env).fetch(new Request('https://directory/agent/result', { method: 'POST', body: text }));
  }

  if (parts.length === 2 && parts[1] === 'timing' && request.method === 'POST') {
    return directoryStub(env).fetch(new Request('https://directory/door/timing-add', { method: 'POST', body: await request.text() }));
  }

  // Keeps a table ready for whoever comes next. Every game that has tNIGHT tables can offer one.
  if (parts.length === 2 && parts[1] === 'warm' && request.method === 'POST') {
    const { bots = 2, game: which } = await request.json();
    const game = GAMES.find((g) => g.openWarmTable && (!which || g.id === which));
    return game ? game.openWarmTable(env, bots) : fail(404, 'no_game', 'No game here has tNIGHT tables.');
  }

  if (parts.length === 4 && parts[1] === 'tables' && request.method === 'POST') {
    const [, , id, op] = parts;
    if (op === 'done') {
      await directoryStub(env).fetch(new Request('https://directory/cage/done', { method: 'POST', body: JSON.stringify({ id }) }));
      return json({ ok: true });
    }
    if (!OPS.has(op)) return fail(404, 'not_found', 'No such judge route.');
    let stub;
    try {
      stub = await tableStub(env, id);
    } catch {
      return fail(404, 'no_table', 'No such table.');
    }
    const text = await request.text();
    if (text.length > MAX_BODY) return fail(413, 'too_large', 'Request body is too large.');
    return stub.fetch(new Request(`https://table/judge/${op}`, { method: 'POST', body: text }));
  }
  return fail(404, 'not_found', 'No such judge route.');
}
