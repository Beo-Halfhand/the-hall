// The door: bring tNIGHT to the Hall once, and sign once. A session proves that this player key's cage balance pays out to
// the wallet that signed, until it expires. Every game's tNIGHT tables take it, so sitting down is one wallet approval.
//
// The Worker can't check a wallet's signature, so the judge does, against the cage, as it does for a seat.
//
// A session can't move money out, and it can't take a key. It can now ask the judge to seat or move this player under their own permit, so
// whoever holds its token can put up to the permit's cap at risk at a table. The page keeps it in this browser. The player's way out is the same: stand, or revoke.

import { directoryStub } from './directory.js';
import { ApiError, bearer, fail, json, randomToken, sha256 } from './http.js';
import { PAGE_TIMED, goodTiming } from './timings.js';
import { MAX_DOOR_SECS } from './door-limit.js';

export { MAX_DOOR_SECS };
const HEX64 = /^[0-9a-f]{64}$/;

/** What a wallet signs at the door: this cage, this player key, this wallet, until this time. */
export const doorMessage = (address, cageId, payout, expires) => `sealed-hand:door:v1|${address}|${cageId}|${payout}|${expires}`;

const directory = (env, path, body) => directoryStub(env).fetch(new Request(`https://directory/door/${path}`, { method: 'POST', body: JSON.stringify(body) }));

/** The verified session behind a door token, or a thrown reason why not. */
export async function doorSession(env, token) {
  const res = await directory(env, 'get', { key: await sha256(token ?? '') });
  const session = res.ok ? await res.json() : null;
  if (!session) throw new ApiError(401, 'door_required', 'Bring tNIGHT to the Hall first: sign at the door.');
  if (session.expires * 1000 <= Date.now()) throw new ApiError(401, 'door_expired', 'Your session at the door has run out. Sign again.');
  if (session.status !== 'verified') throw new ApiError(409, 'door_pending', session.status === 'refused' ? `The door refused this session: ${session.reason}` : 'The judge is still checking your session at the door.');
  return session;
}

export async function doorRoute(request, env, parts) {
  if (env.TNIGHT_TABLES !== 'on' || !HEX64.test(env.CAGE_ADDRESS ?? '')) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  if (parts.length === 2 && parts[1] === 'me' && request.method === 'GET') {
    const res = await directory(env, 'get', { key: await sha256(bearer(request)) });
    if (!res.ok) return fail(401, 'door_required', 'No session at the door.');
    const { cageId, name, avatar, expires, status, reason, balanceStar, permit } = await res.json();
    return json({ cageId, name, avatar, expires, status, reason: reason ?? null, balanceStar: balanceStar ?? null, permit: permit ?? null, expired: expires * 1000 <= Date.now() });
  }
  if (parts.length === 2 && parts[1] === 'timings') {
    if (request.method === 'GET') return directory(env, 'timing-list', {});
    if (request.method !== 'POST') return fail(405, 'method', 'Use GET or POST /door/timings.');
    // A page's own transactions, timed there. It takes a session from the door, so a stranger can't lean on the medians, and it only ever changes a line of text.
    const who = await directory(env, 'get', { key: await sha256(bearer(request)) });
    if (!who.ok) return fail(401, 'door_required', 'No session at the door.');
    const { action, ms } = await request.json().catch(() => ({}));
    if (!PAGE_TIMED.has(action) || !goodTiming(action, ms)) return fail(400, 'bad_timing', 'Not a timing this page can report.');
    return directory(env, 'timing-add', { action, ms });
  }
  if (parts.length === 1 && request.method === 'GET') return json({ address: env.CAGE_ADDRESS, message: doorMessage(env.CAGE_ADDRESS, '<cageId>', '<payout>', '<expires>'), maxSecs: MAX_DOOR_SECS, draining: env.TNIGHT_DRAIN === 'on' });
  if (parts.length !== 1 || request.method !== 'POST') return fail(404, 'not_found', 'Use GET /door, POST /door, or GET /door/me.');
  const text = await request.text();
  if (text.length > 4096) return fail(413, 'too_large', 'Request body is too large.');
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'bad_json', 'Request body is not valid JSON.'); }
  const { cageId, payout, expires, verifyingKey, signature, name, avatar, kind } = body ?? {};
  if (!HEX64.test(cageId ?? '') || !HEX64.test(payout ?? '')) return fail(400, 'bad_door', 'cageId and payout must be 64 hex characters.');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expires) || expires <= now + 60 || expires > now + MAX_DOOR_SECS) return fail(400, 'bad_door', 'expires must be from a minute to a day from now, in seconds.');
  if (typeof verifyingKey !== 'string' || typeof signature !== 'string' || verifyingKey.length > 256 || signature.length > 512) return fail(400, 'bad_door', 'Send verifyingKey and signature from your wallet.');
  const token = randomToken();
  const res = await directory(env, 'put', {
    key: await sha256(token),
    session: { cageId, payout, expires, verifyingKey, signature, name: typeof name === 'string' ? name.slice(0, 40) : null, avatar: typeof avatar === 'string' ? avatar : null, kind: kind === 'agent' ? 'agent' : 'human', message: doorMessage(env.CAGE_ADDRESS, cageId, payout, expires), status: 'pending', at: Date.now() },
  });
  if (!res.ok) return fail(429, 'door_busy', 'Too many sessions are waiting at the door. Try again shortly.');
  return json({ status: 'pending', token, expires }, 202);
}
