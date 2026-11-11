// Agents on tNIGHT (phase 2, 11-08): an agent brings its own Preprod wallet and deposits into the cage with the payout set to its
// owner's wallet, so whatever it wins can only go to the owner. The owner keeps the controls here, signed with that payout wallet:
//   - the daily cap: net loss per Pacific day, 1,000 tNIGHT until the owner raises it or removes it ("none"),
//   - Stop ("stop"): no more seats, and a seat it holds leaves after the round it is in.
// One signed setting carries all three: `sealed-hand:agent:v1|<cage>|<cageId>|<agent>|<limit>|<signedAt>`, the newest one winning.
// The Worker can't check a wallet's signature, so the judge does, against the cage, as it does a door session; until then a
// setting is pending and changes nothing. The agent's own door session is good only under a verified setting naming its key.
//
// The table rules hold whatever the setting says: the buy-in max (250 a seat), the request limits and the per-key limit.

import { directoryStub } from './directory.js';
import { fail, json } from './http.js';

const HEX64 = /^[0-9a-f]{64}$/;
const LIMIT = /^(stop|none|[1-9]\d{0,8})$/;
export const DEFAULT_DAILY_CAP = 1000;
export const BUY_IN_MAX = 250;

/** What an owner signs. limit: whole tNIGHT, "none" or "stop". signedAt: seconds. */
export const agentMessage = (address, cageId, agent, limit, signedAt) => `sealed-hand:agent:v1|${address}|${cageId}|${agent}|${limit}|${signedAt}`;

/** Agents on tNIGHT are on wherever tNIGHT tables are, unless AGENT_TNIGHT is "off". */
export const agentTnightOn = (env) => env.TNIGHT_TABLES === 'on' && HEX64.test(env.CAGE_ADDRESS ?? '') && env.AGENT_TNIGHT !== 'off';

const directory = (env, op, body) => directoryStub(env).fetch(new Request(`https://directory/agent/${op}`, { method: 'POST', body: JSON.stringify(body) }));

/** What anyone may read about an agent's settings: no signature, nothing private. */
function publicView(s) {
  if (!s) return null;
  return {
    cageId: s.cageId, agent: s.agent, limit: s.limit, signedAt: s.signedAt, status: s.status, reason: s.reason ?? null,
    lossTodayStar: s.lossTodayStar ?? null, leftStar: s.leftStar ?? null, day: s.day ?? null,
  };
}

export async function agentSettingsRoute(request, env, parts) {
  if (!agentTnightOn(env)) return fail(404, 'not_found', 'Agents on tNIGHT are not on here. GET /api lists the routes.');
  if (parts.length === 1 && request.method === 'GET') {
    return json({
      address: env.CAGE_ADDRESS,
      message: agentMessage(env.CAGE_ADDRESS, '<cageId>', '<agent>', '<limit>', '<signedAt>'),
      limits: { defaultDailyCap: DEFAULT_DAILY_CAP, buyInMax: BUY_IN_MAX },
      how: 'The owner signs the message with the wallet the agent\'s cage id pays out to. limit: a whole number of tNIGHT (the daily cap, net loss per Pacific day), "none" to remove the cap, or "stop" to stop the agent. signedAt: now, in seconds. The newest signed setting wins.',
    });
  }
  if (parts.length === 2 && request.method === 'GET') {
    if (!HEX64.test(parts[1])) return fail(400, 'bad_cage_id', 'A cage id is 64 hex characters.');
    const res = await directory(env, 'get', { cageId: parts[1] });
    const { current, pending } = await res.json();
    if (!current && !pending) return fail(404, 'no_settings', 'No settings for that cage id yet. Its owner signs them.');
    return json({
      ...publicView(current ?? pending), // what is in force, or else what waits for the judge: status says which
      current: publicView(current ?? null),
      pending: publicView(pending ?? null),
      defaultDailyCap: DEFAULT_DAILY_CAP,
      buyInMax: BUY_IN_MAX,
    });
  }
  if (parts.length !== 1 || request.method !== 'POST') return fail(404, 'not_found', 'Use GET /agent-settings, POST /agent-settings, or GET /agent-settings/:cageId.');
  const text = await request.text();
  if (text.length > 4096) return fail(413, 'too_large', 'Request body is too large.');
  let body;
  try { body = JSON.parse(text); } catch { return fail(400, 'bad_json', 'Request body is not valid JSON.'); }
  const { cageId, agent, signedAt, verifyingKey, signature } = body ?? {};
  const limit = String(body?.limit ?? '');
  if (!HEX64.test(cageId ?? '') || !HEX64.test(agent ?? '')) return fail(400, 'bad_setting', 'cageId and agent must be 64 hex characters: the agent\'s cage id, and its wallet\'s unshielded address in hex.');
  if (!LIMIT.test(limit)) return fail(400, 'bad_setting', 'limit must be a whole number of tNIGHT (the daily cap), "none" or "stop".');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(signedAt) || signedAt > now + 300 || signedAt < now - 3600) return fail(400, 'bad_setting', 'signedAt must be the time you signed, in seconds, within the last hour.');
  if (typeof verifyingKey !== 'string' || typeof signature !== 'string' || verifyingKey.length > 256 || signature.length > 512) return fail(400, 'bad_setting', 'Send verifyingKey and signature from the owner\'s wallet.');
  const setting = { cageId, agent, limit, signedAt, verifyingKey, signature, message: agentMessage(env.CAGE_ADDRESS, cageId, agent, limit, signedAt), status: 'pending', at: Date.now() };
  const res = await directory(env, 'put', { setting });
  if (res.status === 409) return fail(409, 'older_setting', 'A newer setting for this agent is already signed.');
  if (res.status === 429) return fail(429, 'busy', 'Too many settings are waiting for the judge. Try again shortly.');
  if (!res.ok) return fail(503, 'try_again', 'The Hall couldn\'t store that just now. Send it again in a moment.');
  return json({ status: 'pending', cageId, limit, signedAt }, 202);
}

/**
 * The Directory's side: one record per agent cage id for the newest verified setting (`agent:c:<cageId>`), and one for the newest one
 * still waiting for the judge (`agent:p:<cageId>`). A pending setting replaces the current one only when the judge verifies it.
 */
export async function agentStore(storage, op, body) {
  const now = Date.now();
  if (op === 'put') {
    const { setting } = body;
    const [current, pending] = await Promise.all([storage.get(`agent:c:${setting.cageId}`), storage.get(`agent:p:${setting.cageId}`)]);
    if ((current && current.signedAt >= setting.signedAt) || (pending && pending.signedAt > setting.signedAt)) return json({ error: 'older' }, 409);
    const waiting = [...(await storage.list({ prefix: 'agent:p:' })).values()].filter((s) => now - s.at < 3_600_000).length;
    if (!pending && waiting >= 50) return json({ error: 'busy' }, 429);
    await storage.put(`agent:p:${setting.cageId}`, setting);
    return json({ ok: true });
  }
  if (op === 'get') {
    const [current, pending] = await Promise.all([storage.get(`agent:c:${body.cageId}`), storage.get(`agent:p:${body.cageId}`)]);
    return json({ current: current ?? null, pending: pending ?? null });
  }
  if (op === 'list') {
    // For the judge: everything waiting, and every current setting (it needs them for the door, the cap and Stop). An old refusal is dropped.
    const out = [];
    for (const [k, s] of await storage.list({ prefix: 'agent:p:' })) {
      if (s.status === 'refused' && now - s.at > 3_600_000) { await storage.delete(k); continue; }
      if (s.status === 'pending' && now - s.at > 3_600_000) { await storage.delete(k); continue; }
      if (s.status === 'pending') out.push(s);
    }
    for (const s of (await storage.list({ prefix: 'agent:c:' })).values()) out.push(s);
    return json({ agents: out });
  }
  if (op === 'result') {
    // The judge's answer to a pending setting (ok true/false), or the day so far for a current one (lossTodayStar, leftStar).
    const { cageId, signedAt } = body;
    if ('ok' in body) {
      const pending = await storage.get(`agent:p:${cageId}`);
      if (!pending || pending.signedAt !== signedAt) return json({ ok: true, stale: true });
      if (body.ok === true) {
        await storage.put(`agent:c:${cageId}`, { ...pending, status: 'verified', verifiedAt: now });
        await storage.delete(`agent:p:${cageId}`);
      } else {
        await storage.put(`agent:p:${cageId}`, { ...pending, status: 'refused', reason: String(body.reason ?? '').slice(0, 200) });
      }
      return json({ ok: true });
    }
    const current = await storage.get(`agent:c:${cageId}`);
    if (!current || current.signedAt !== signedAt) return json({ ok: true, stale: true });
    await storage.put(`agent:c:${cageId}`, { ...current, lossTodayStar: body.lossTodayStar ?? null, leftStar: body.leftStar ?? null, day: body.day ?? null });
    return json({ ok: true });
  }
  return json({ error: 'not_found' }, 404);
}
