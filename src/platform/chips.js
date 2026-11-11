// The chip interface games use. Today it talks to the Player Durable Object; later, the cage contract.

import { ApiError } from './http.js';

const ID = /^[0-9a-f]{64}$/;

// One restoration, set from wrangler.toml as PURSE_GRANT = "<playerId>:<chips>". Empty does nothing. It's keyed on the
// player id because names aren't unique: anyone can sit down as "Halfhand". Recorded on the player, so it can't repeat.
const PURSE_GRANT_TAG = '2026-11-bank-restore'; // the name on saved records: changing it could pay someone twice
const GRANT_SETTING = /^([0-9a-f]{64}):(\d+)$/;

/** Raises this player's purse to the set amount, once. Returns true if the record changed. */
export function applyGrant(p, playerId, setting, now) {
  const [, id, chips] = GRANT_SETTING.exec(setting ?? '') ?? [];
  if (id !== playerId || p.grants?.[PURSE_GRANT_TAG]) return false;
  const to = Math.max(p.chips, Number(chips));
  p.grants = { ...p.grants, [PURSE_GRANT_TAG]: { at: now, from: p.chips, to } };
  p.chips = to;
  return true;
}

export const BROKE_BELOW = 100; // can't afford a seat
export const TOPUP_TO = 200;
export const TOPUP_EVERY_MS = 24 * 60 * 60_000;
// Fill up (play chips only): a purse or a stack back to FILL_TO, any time, as often as wanted. SEAT_DEFAULT is what a human or an
// agent sits down with when they name no buy-in; a purse below it is filled to it first, so nobody gets a small default stack.
export { BOT_STACK, FILL_TO, SEAT_DEFAULT } from './stakes.js';

/** Whether this player may have a free top-up now. Play chips only; never for tNIGHT tables. */
export function topUpCheck({ chips, holds, lastTopUp }, now) {
  if (chips >= BROKE_BELOW) return { ok: false, code: 'not_broke', message: `The free top-up is for balances under ${BROKE_BELOW} chips.` };
  if (Object.keys(holds).length > 0) return { ok: false, code: 'chips_in_play', message: 'You still have chips at a table.' };
  const nextAt = (lastTopUp ?? -Infinity) + TOPUP_EVERY_MS;
  if (now < nextAt) return { ok: false, code: 'topup_used', message: 'You have had your free top-up for today.', nextAt };
  return { ok: true };
}

/**
 * A player token is "<playerId>.<secret>". Returns null if it isn't shaped like one, including an id
 * this platform never issued (idFromString throws on those).
 */
export function parsePlayerToken(env, token) {
  const [playerId, secret, extra] = String(token ?? '').split('.');
  if (!ID.test(playerId ?? '') || !secret || extra) return null;
  try {
    env.PLAYER.idFromString(playerId);
  } catch {
    return null;
  }
  return { playerId, secret };
}

const playerStub = (env, playerId) => env.PLAYER.get(env.PLAYER.idFromString(playerId));

async function post(env, playerId, path, body) {
  return playerStub(env, playerId).fetch(new Request(`https://player${path}`, { method: 'POST', body: JSON.stringify(body) }));
}

/** Checks a player token and returns that player's view: name, purse, what's held. Throws ApiError if it's bad. */
export async function verifyPlayer(env, token) {
  const parsed = parsePlayerToken(env, token);
  if (!parsed) throw new ApiError(401, 'bad_token', 'Send your player token as "Authorization: Bearer <token>".');
  const res = await playerStub(env, parsed.playerId).fetch(new Request('https://player/me', { headers: { 'x-secret': parsed.secret } }));
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body.error, body.message);
  return body;
}

/** Verifies the token and takes the buy-in. Safe to repeat with the same key. Throws ApiError on refusal. */
export async function holdChips(env, token, key, amount, { upTo = false, all = false, fillTo = 0 } = {}) {
  const parsed = parsePlayerToken(env, token);
  if (!parsed) throw new ApiError(401, 'bad_token', 'That player token is not valid.');
  const res = await post(env, parsed.playerId, '/hold', { secret: parsed.secret, key, amount, upTo, all, fillTo });
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body.error, body.message);
  return body;
}

/** Table side of "Fill up": raises the purse to at least `to` chips (never lowers it), so the move to a stack below can't fall short. */
export async function fillPurse(env, playerId, to) {
  const res = await post(env, playerId, '/fill', { to });
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body.error, body.message);
  return body;
}

/** Remembers a player's look. Throws ApiError on a bad token. */
export async function rememberAvatar(env, token, avatar) {
  const parsed = parsePlayerToken(env, token);
  if (!parsed) throw new ApiError(401, 'bad_token', 'That player token is not valid.');
  const res = await post(env, parsed.playerId, '/avatar', { secret: parsed.secret, avatar });
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body.error, body.message);
  return body;
}

/** Moves chips from the purse to a seat already held, or back if `amount` is negative. Returns the player's view. */
export async function moveToSeat(env, playerId, key, amount) {
  const res = await post(env, playerId, '/hold-more', { key, amount });
  const body = await res.json();
  if (!res.ok) throw new ApiError(res.status, body.error, body.message);
  return body;
}

export async function releaseChips(env, playerId, key) {
  await post(env, playerId, '/release', { key });
}

export async function cashOut(env, playerId, key, amount) {
  const res = await post(env, playerId, '/cashout', { key, amount });
  if (!res.ok) throw new Error(`cash-out failed: ${res.status}`);
}
