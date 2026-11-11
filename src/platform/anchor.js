// Locking a round's seal on Midnight (the seal-anchor preview, 11-08).
//
// A round's seal (Sealed Hand's deck seal, Cup & Claim's dice fingerprint) is a hash the Records book posts before any card
// moves. Here it also goes on chain: one `attest` into an attestation vault on Midnight preprod, payload = the seal, made by
// the Mini's seal-anchor service (halfhand-ledger/references/notary/seal-anchor.mjs) with its own preprod wallet. The Worker
// never holds a key: it queues the seal, the service takes it, and posts back the transaction and block.
//
//   lock        the round waits for the anchor: no move, no bot, no clock, your cards still face down, until it lands or fails
//   background  the round never waits; table talk says "anchoring…", then "anchored ✓ block N"
// Either way a failure is said plainly and the round plays on: the seal still stands on this server's record.
//
// Pure state on s.anchor (per table, the current round only) plus one AnchorQueue Durable Object for the whole Worker.
//   GET  /anchor          { on, mode, scope, service: { polledAt, online } }: public
//   GET  /anchor/queue    the service's long poll (Authorization: Bearer ANCHOR_TOKEN). ?wait=25 holds the request up to 25 s
//   POST /anchor/result   the service's progress and result, same token

import { bearer, fail, json } from './http.js';

export const MODES = ['lock', 'background'];
export const LOCK_MAX_MS = 120_000;
export const CHAIN_CLOCK_MARGIN_MS = 120_000; // at a tNIGHT table a hold ends this long before the round's on-chain fold time (cage.foldAt): the chain's deadline comes first // a lock that hasn't landed by then lets the round play: said plainly, the anchor may still land
export const SERVICE_STALE_MS = 90_000; // no poll and no word for 90 s: the service is offline and a lock fails at once instead of waiting
const HEX64 = /^[0-9a-f]{64}$/;

/** What this Worker does: off unless the queue is bound and a mode is set. scope 'tnight' is the shape for staging; 'all' lets a chips preview feel it. */
export function anchorConfig(env) {
  const mode = MODES.includes(env?.ANCHOR_MODE) ? env.ANCHOR_MODE : null;
  return { on: !!env?.ANCHOR_QUEUE && !!mode, mode, scope: env?.ANCHOR_SCOPE === 'all' ? 'all' : 'tnight', picker: env?.ANCHOR_PICKER === 'on' };
}

/** The mode a new table plays in: the Worker's, or (on a preview with the picker on) the one asked for. Null = no anchoring. */
export function tableAnchorMode(env, asked, { cage = false } = {}) {
  const c = anchorConfig(env);
  if (!c.on) return null;
  if (c.scope === 'tnight' && !cage) return null;
  if (asked === 'off' && c.picker) return null;
  return c.picker && MODES.includes(asked) ? asked : c.mode;
}

// ---------- the table side (pure) ----------

const PLAYING = ['pass', 'claim', 'answer', 'bid', 'duel'];

/**
 * A new round was just dealt: in lock mode the round holds from this moment, before any bot can move, until its seal is
 * on chain. Call it right after the engine's step and before the bots. Returns true when a round began.
 */
export function anchorBeginRound(s, now) {
  if (!s.anchorMode || !PLAYING.includes(s.phase) || s.round < 1 || s.anchor?.round === s.round) return false;
  // At a tNIGHT table the round must end before its on-chain deadline (cage.foldAt, from the stands and the table's clock), so a hold
  // never runs into it: it ends early, and with no room at all the round doesn't hold. Chips tables have no such clock.
  const cap = chainCap(s);
  const lock = s.anchorMode === 'lock' && cap - now > 20_000;
  s.anchor = { round: s.round, recordId: null, seal: null, mode: s.anchorMode, state: 'sealing', queuedAt: now, step: 'sealing', lockUntil: lock ? Math.min(now + (s.anchorLockMs ?? LOCK_MAX_MS), cap) : null, held: false }; // anchorLockMs: test tables only
  if (lock) holdClock(s, now);
  return true;
}

/** The round has its seal: queue it once. Returns the queue item, or null. */
export function anchorAfterSeal(s, { game, tableId, recordId, seal, now }) {
  if (!s.anchorMode || !HEX64.test(String(seal ?? ''))) return null;
  anchorBeginRound(s, now); // a round dealt by a path that didn't call it (the lobby clock)
  const a = s.anchor;
  if (!a || a.round !== s.round || a.state !== 'sealing') return null;
  Object.assign(a, { recordId, seal, game, state: 'queued', step: 'queued' });
  return { id: `${game === 'cup-and-claim' ? 'c' : 's'}-${tableId.slice(0, 24)}-${s.round}`, game, tableId, recordId, seal, round: s.round, mode: a.mode, at: now };
}

/** The latest a hold may last at this table: 2 min before the on-chain fold time at a tNIGHT table, no limit elsewhere. */
export const chainCap = (s) => (Number.isFinite(s.cage?.foldAt) ? s.cage.foldAt - CHAIN_CLOCK_MARGIN_MS : Infinity);

/**
 * A table from before anchoring was on takes a mode (the Worker's default). A round already in play is left alone: it was dealt
 * without a lock and is never held or queued halfway through; the next round is the first one locked.
 */
export function anchorAdopt(s, mode) {
  s.anchorMode = mode ?? null;
  if (s.anchorMode && PLAYING.includes(s.phase) && s.round >= 1) s.anchor = { round: s.round, recordId: null, seal: null, mode: s.anchorMode, state: 'skipped', step: 'skipped', queuedAt: null, lockUntil: null, held: false };
}

/** True while the round waits on its lock. */
export const anchorHolding = (s) => !!s.anchor?.held;

function holdClock(s, now) {
  const a = s.anchor;
  a.held = true;
  a.deadlineLeft = s.deadline === null || s.deadline === undefined ? null : Math.max(0, s.deadline - now);
  s.deadline = null;
  s.botDue = {};
}

function release(s, now) {
  const a = s.anchor;
  if (!a?.held) return;
  a.held = false;
  a.releasedAt = now;
  if (a.deadlineLeft !== null && a.deadlineLeft !== undefined && s.phase !== 'settled' && s.phase !== 'over') s.deadline = now + a.deadlineLeft;
  s.botDue = {}; // the bots think again from now
}

const shortHash = (h) => `${String(h).slice(0, 8)}…${String(h).slice(-4)}`;
const thing = (a) => (a?.game === 'cup-and-claim' ? 'this roll' : 'this hand');

/** Called on every alarm/advance: a lock past its time lets the round go. Returns true if it changed something. */
export function anchorExpire(s, now, say) {
  const a = s.anchor;
  if (!a?.held || a.lockUntil === null) return false;
  const chain = now >= chainCap(s); // the fold time can come closer during a hold (a stand): it is read fresh each time
  if (now < a.lockUntil && !chain) return false;
  a.state = 'timeout';
  if (chain) a.error = "the table's on-chain clock comes first";
  else if (!a.seal) a.error = 'the round never got its seal'; else a.error = `no block within ${Math.round((s.anchorLockMs ?? LOCK_MAX_MS) / 1000)} s`;
  release(s, now);
  say?.(`Couldn't lock ${thing(a)} on Midnight in time (${a.error}). Playing on${a.seal ? `: the seal ${shortHash(a.seal)} still stands on this server's record, and the lock may still land` : ''}.`, { act: { seat: null, kind: 'anchor', state: 'timeout' } });
  return true;
}

/** The service said it can't be reached, or the queue refused: fail at once. */
export function anchorFail(s, why, now, say) {
  const a = s.anchor;
  if (!a || a.state === 'anchored' || a.state === 'failed') return false;
  a.state = 'failed';
  a.error = String(why ?? 'unknown').slice(0, 160);
  const waited = a.held;
  release(s, now);
  say?.(`Couldn't lock ${thing(a)} on Midnight: ${a.error}. ${waited ? 'Playing on' : 'The round goes on'}: the seal ${shortHash(a.seal)} still stands on this server's record.`, { act: { seat: null, kind: 'anchor', state: 'failed' } });
  return true;
}

/** Background mode's first word, at the deal. */
export function anchorQueuedLine(s, say) {
  const a = s.anchor;
  if (a?.mode !== 'background' || a.said) return;
  a.said = true;
  say?.(`Locking ${thing(a)} on Midnight (30–60 s). Enjoy your game.`, { act: { seat: null, kind: 'anchor', state: 'queued', seal: a.seal } });
}

/**
 * The service's word on a round. Progress ('started', 'progress') moves the step; a result settles it. A result for an earlier
 * round still counts for that round's record (the patch), not for the table's live state. Returns { changed, patch }.
 */
export function anchorApplyResult(s, r, now, say) {
  const a = s.anchor;
  const final = r.outcome === 'anchored' || r.outcome === 'already-on-chain' || (r.outcome && !['started', 'progress'].includes(r.outcome));
  const patch = final ? { anchor: anchorRecord(r, now, a?.round === r.round ? a.mode : s.anchorMode) } : null;
  if (!a || a.round !== r.round || a.seal !== r.seal) return { changed: false, patch };
  if (!final) {
    a.step = r.step ?? (r.outcome === 'started' ? 'proving' : a.step);
    if (a.state === 'queued') a.state = 'started';
    a.startedAt ??= now;
    return { changed: true, patch: null };
  }
  if (r.ok && (r.outcome === 'anchored' || r.outcome === 'already-on-chain')) {
    const wasLate = a.state === 'timeout' || a.state === 'failed';
    Object.assign(a, { state: 'anchored', step: 'done', block: r.block ?? null, blockAt: r.blockAt ?? null, txHash: r.txHash ?? null, ms: r.ms ?? null, landedAt: now, late: wasLate });
    const waited = a.held;
    release(s, now);
    const ex = a.txHash ? ` · tx ${String(a.txHash).slice(0, 10)}…` : '';
    say?.(wasLate
      ? `The lock for ${thing(a)} landed late on Midnight: block ${a.block}${ex}. The receipt says when.`
      : waited ? `Locked on Midnight ✓ block ${a.block}${ex}. ${a.game === 'cup-and-claim' ? 'Lift your cup.' : 'Your cards are yours.'}` : `Locked ✓ block ${a.block}${ex}.`, { act: { seat: null, kind: 'anchor', state: 'anchored', block: a.block, tx: a.txHash } });
    return { changed: true, patch };
  }
  anchorFail(s, r.error ?? r.outcome, now, say);
  return { changed: true, patch };
}

/** The record's `anchor` part: what the receipt checks in the browser. */
export function anchorRecord(r, now, mode = null) {
  return { mode: mode ?? null, // lock: the round waited for this block; background: it didn't (the receipt says what that means)
    network: 'preprod', vault: r.vault ?? null, attester: r.attesterId ?? null, recordKey: r.recordKey ?? null, payload: r.seal, metadataHash: r.metadataHash ?? null,
    ok: !!r.ok, outcome: r.outcome, txHash: r.txHash ?? null, ledgerId: r.ledgerId ?? null, block: r.block ?? null, blockAt: r.blockAt ?? null,
    error: r.ok ? null : String(r.error ?? r.outcome ?? '').slice(0, 200), ms: r.ms ?? null, feeRaw: r.feeRaw ?? null, at: now,
  };
}

/** What a page sees of this round's lock. No secret in it: the seal is public from the deal. */
export function anchorView(s) {
  const a = s.anchor;
  if (!a || a.round !== s.round) return s.anchorMode ? { mode: s.anchorMode, state: 'idle' } : null;
  return { mode: a.mode, state: a.state, step: a.step, seal: a.seal, held: a.held, queuedAt: a.queuedAt, startedAt: a.startedAt ?? null, lockUntil: a.lockUntil,
    block: a.block ?? null, blockAt: a.blockAt ?? null, txHash: a.txHash ?? null, landedAt: a.landedAt ?? null, late: !!a.late, error: a.error ?? null, ms: a.ms ?? null };
}

// ---------- the Worker side ----------

export const anchorStub = (env) => env.ANCHOR_QUEUE.get(env.ANCHOR_QUEUE.idFromName('anchor'));

/** Queues one item. Resolves { ok, online } or throws. */
export async function enqueueAnchor(env, item) {
  const res = await anchorStub(env).fetch(new Request('https://anchor/enqueue', { method: 'POST', body: JSON.stringify(item) }));
  return res.json();
}

async function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length < 24) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : Buffer.from(x).equals(Buffer.from(y));
}

export async function anchorRoute(request, env, parts) {
  const c = anchorConfig(env);
  if (parts.length === 1) {
    if (request.method !== 'GET') return fail(405, 'method', 'Use GET /anchor.');
    if (!c.on) return json({ on: false });
    const st = await (await anchorStub(env).fetch('https://anchor/status')).json();
    return json({ on: true, mode: c.mode, scope: c.scope, picker: c.picker, network: 'preprod', service: st });
  }
  if (!c.on) return fail(404, 'not_found', 'Anchoring is off on this server.');
  if (!(await sameToken(bearer(request), env.ANCHOR_TOKEN))) return fail(401, 'bad_token', 'Not the anchor service.');
  if (parts[1] === 'queue' && request.method === 'GET') return anchorStub(env).fetch(new Request(`https://anchor/queue${new URL(request.url).search}`));
  if (parts[1] === 'result' && request.method === 'POST') return anchorStub(env).fetch(new Request('https://anchor/result', { method: 'POST', body: await request.text() }));
  return fail(404, 'not_found', 'No such anchor route.');
}
