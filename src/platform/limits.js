// Per-IP limits on the routes that create things, using Cloudflare's rate limit binding. These are
// approximate and per Cloudflare location: a brake on abuse, not an exact count. A test run turns them off
// (ALLOW_TEST_CONFIG), since its one IP makes hundreds of requests on purpose.

import { fail } from './http.js';

function bindingFor(method, parts) {
  if (parts[0] === 'indexer' && parts.length === 2) return 'LIMIT_INDEXER'; // the Hall's own indexer is paid for: a brake per address
  if (method !== 'POST' && !(method === 'GET' && parts[0] === 'dice' && parts[1] === 'new')) return null;
  const tables = parts[0] === 'tables' || parts[0] === 'dice-tables';
  if (parts[0] === 'dice' && parts[1] === 'new') return 'LIMIT_TABLES'; // GET /dice/new makes a table, so it counts as one
  if (parts[0] === 'lobby' && parts[1] === 'open') return 'LIMIT_TABLES'; // POST /lobby/open may make a table
  if (parts[0] === 'players' && parts.length === 1) return 'LIMIT_PLAYERS';
  if (tables && parts.length === 1) return 'LIMIT_TABLES';
  if (parts[0] === 'door' && parts.length === 1) return 'LIMIT_JOIN';
  if (parts[0] === 'agent-settings' && parts.length === 1) return 'LIMIT_JOIN'; // an owner's signed setting waits for the judge, like a door session
  if (tables && (parts[2] === 'join' || parts[2] === 'cage-seat')) return 'LIMIT_JOIN';
  if (tables && parts[2] === 'say') return 'LIMIT_SAY';
  return null;
}

/** Returns a 429 Response if this request is over its limit, otherwise null. */
export async function checkIpLimit(request, env, parts) {
  if (env.ALLOW_TEST_CONFIG === '1') return null;
  const binding = bindingFor(request.method, parts);
  if (!binding || !env[binding]) return null;
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const { success } = await env[binding].limit({ key: ip });
  if (success) return null;
  const res = fail(429, 'rate_limited', 'Too many requests from your address. Wait a minute and try again.');
  res.headers.set('retry-after', '60');
  return res;
}

// Per key (11-08, bring your own agent): every request that carries a seat, player or door token counts against that token,
// wherever it comes from, so one agent can't hammer a table from many addresses, and many agents behind one address each get
// their own allowance. The key is a hash of the token, never the token. Like the per-address limits it is approximate.
export const KEY_LIMIT = { limit: 300, periodSeconds: 60 }; // 5 a second on average: a page polls about once a second
const KEYED = new Set(['tables', 'dice-tables', 'players', 'door']);

async function keyOf(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hall-key-limit:${token}`)));
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns a 429 Response if this token is over its limit, otherwise null. Requests with no token are left to the per-address limits. */
export async function checkKeyLimit(request, env, parts) {
  if (env.ALLOW_TEST_CONFIG === '1' && env.KEY_LIMIT_IN_TESTS !== '1') return null;
  if (!env.LIMIT_KEY || !KEYED.has(parts[0])) return null;
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const { success } = await env.LIMIT_KEY.limit({ key: await keyOf(token) });
  if (success) return null;
  const res = fail(429, 'key_rate_limited', `Too many requests with this token: about ${KEY_LIMIT.limit} a minute at most. Poll /me about once a second.`);
  res.headers.set('retry-after', '10');
  return res;
}

// Per-seat limit on talk: exact, and kept by the table itself.
export const SEAT_SAY_LIMIT = 5;
export const SEAT_SAY_WINDOW_MS = 10_000;

/** True if this seat may speak now. Records the attempt when it may. */
export function seatMaySay(times, seat, now) {
  const recent = (times[seat] ?? []).filter((t) => now - t < SEAT_SAY_WINDOW_MS);
  if (recent.length >= SEAT_SAY_LIMIT) {
    times[seat] = recent;
    return false;
  }
  recent.push(now);
  times[seat] = recent;
  return true;
}
