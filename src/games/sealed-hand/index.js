// Sealed Hand as a Hall game: its registry entry and its HTTP routes. The rules are in engine.js.

import { openCageOptions } from '../../platform/cage-table.js';
import { fail, json } from '../../platform/http.js';
import { DEFAULTS } from './engine.js';

export { Table } from './table.js';
export { liveSeats } from './seats.js';

const MAX_BODY = 4096;

const ROUTES = {
  '': { GET: '/' },
  join: { POST: '/join' },
  'cage-seat': { GET: '/cage-seat', POST: '/cage-seat' },
  me: { GET: '/me' },
  act: { POST: '/act' },
  say: { POST: '/say' },
  leave: { POST: '/leave' },
  'deal-now': { POST: '/deal-now' },
  quick: { GET: '/quick' },
  seat: { GET: '/seat' },
  'add-chips': { POST: '/add-chips' },
  'fill-up': { POST: '/fill-up' },
  'test-prompts': { GET: '/test-prompts' },
};

/** Size-checks a JSON body and builds the request for the Durable Object, or returns an error Response. */
async function forwardBody(request, path) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: fail(413, 'too_large', `Request body is over ${MAX_BODY} bytes.`) };
  try {
    if (JSON.parse(text || 'null') === null) return { error: fail(400, 'bad_json', 'Send a JSON object in the request body.') };
  } catch {
    return { error: fail(400, 'bad_json', 'Request body is not valid JSON.') };
  }
  return { request: new Request(`https://table${path}`, { method: 'POST', headers: request.headers, body: text }) };
}

/**
 * Creates a table from options someone is allowed to set. A warm table comes only from the judge, which keeps one ready with
 * the house float already on chain, so a player's sit deals at once.
 */
async function openTable(env, options, { warm = false } = {}) {
  const opts = { ...options };
  delete opts.cage; // set here, never by a client
  const id = env.TABLE.newUniqueId();
  if (opts.tnight !== undefined) {
    const opened = await openCageOptions(env, id.toString(), opts, { warm, maxBots: DEFAULTS.seats - 1, game: 'sealed-hand' });
    if (opened.error) return opened.error;
    opts.cage = opened.cage;
  }
  const res = await env.TABLE.get(id).fetch(new Request('https://table/init', { method: 'POST', body: JSON.stringify(opts) }));
  if (!res.ok) return res;
  return json({ id: id.toString(), ...(await res.json()) }, 201);
}

async function createTable(request, env) {
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, 'too_large', `Request body is over ${MAX_BODY} bytes.`);
  let options = {};
  if (text.trim()) {
    try {
      options = JSON.parse(text);
    } catch {
      return fail(400, 'bad_json', 'Request body is not valid JSON.');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail(400, 'bad_json', 'Send a JSON object.');
  }
  return openTable(env, options);
}

async function route(request, env, parts) {
  if (parts.length > 3) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  if (parts.length === 1) {
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /tables to create a table.');
    return createTable(request, env);
  }
  let id;
  try {
    id = env.TABLE.idFromString(parts[1]);
  } catch {
    return fail(404, 'no_table', 'No such table.');
  }
  const methods = ROUTES[parts[2] ?? ''];
  if (!methods) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  const path = methods[request.method];
  if (!path) return fail(405, 'method', `Use ${Object.keys(methods).join(' or ')} here.`);

  const stub = env.TABLE.get(id);
  if (request.method === 'GET') return stub.fetch(new Request(`https://table${path}`, { headers: request.headers }));
  const forwarded = await forwardBody(request, path);
  return forwarded.error ?? stub.fetch(forwarded.request);
}

export const sealedHand = {
  id: 'sealed-hand',
  name: 'Sealed Hand',
  status: 'live',
  art: 'cards',
  blurb: 'Five secret cards. Claim, call or check.',
  page: '/table',
  api: '/tables',
  binding: 'TABLE',
  seats: DEFAULTS.seats,
  route,
  openWarmTable: (env, bots) => openTable(env, { tnight: true, bots, lobbySeconds: 0 }, { warm: true }),
};
