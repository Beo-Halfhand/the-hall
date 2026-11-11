// One Durable Object per table: storage, seat tokens, alarms, buy-ins. All the rules live in engine.js.
//
// Mutations run synchronously after any await, so two requests can't interleave inside one.

import { DurableObject } from 'cloudflare:workers';
import { legalActions, DEFAULTS, RuleError, act, addChips, addLog, addTalk, checkAddChips, createTable, dealNow, isReservedName, join, leave, roundCap, nextStandAt, privateView, publicView, sitBackDown, tick, upgradeState } from './engine.js';
import { paceBots } from './bots.js';
import * as cage from './cage.js';
import { recordNumber, recordsAfterChange } from './records.js';
import { GAME_ID, liveSeats } from './seats.js';
import { liveSeats as diceSeats } from '../cup-and-claim/seats.js';
import { AiBudget, QuickLines, voiceBots } from './talk.js';
import { DEFAULT_AVATAR, cleanAvatar, isRetiredAvatar } from '../../platform/avatars.js';
import { DOORMAN, isDoormanName } from '../../platform/doorman.js';
import { cageTableRoutes } from '../../platform/cage-table.js';
import { originHash, watchCheck, watchMove, watchOrigin, watchView } from '../../platform/collusion.js';
import { SEAT_DEFAULT, cashOut, fillPurse, holdChips, moveToSeat, parsePlayerToken, releaseChips, rememberAvatar, verifyPlayer } from '../../platform/chips.js';
import { closureFields } from '../../platform/closures.js';
import { directoryStub, tableFaces } from '../../platform/directory.js';
import { flushRecords } from '../../platform/records.js';
import { anchorAdopt, anchorAfterSeal, anchorBeginRound, anchorApplyResult, anchorExpire, anchorFail, anchorHolding, anchorQueuedLine, anchorView, enqueueAnchor, tableAnchorMode } from '../../platform/anchor.js';
import { boardAfterChange, flushBoard, netsFromMoney } from '../../platform/board.js';
import { cleanName, cleanSay } from '../../platform/filter.js';
import { chipsStakes } from '../../platform/stakes.js';
import { ApiError, bearer, fail, json, randomToken, sha256 } from '../../platform/http.js';
import { seatMaySay } from '../../platform/limits.js';
import { mockAi } from '../../platform/voice.js';

const { CAGE_ROUND_CAP, CAGE_TURN_MS, cageAfterChange, cageDealBlocked, cageForceRoundEnd, cageJoinable, cageMaybeStart, cageMoving, cageView, newCage } = cage;
// The judge's routes deal too (a seat read from the cage can start a round): their bots wait on a lock like any other.
const gatedBots = (s, c) => { anchorBeginRound(s, c.now); if (!anchorHolding(s)) paceBots(s, c); };
const tnight = cageTableRoutes({ cage, RuleError, addLog, isReservedName, leave, paceBots: gatedBots, apiPath: '/tables' });

const CASHOUT_RETRY_MS = 10_000;
const RECORD_RETRY_MS = 10_000;

/** 53 random bits, so the shuffle has no meaningful modulo bias. */
function cryptoRng() {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return ((hi >>> 5) * 67108864 + (lo >>> 6)) / 9007199254740992;
}

/** Repeatable generator for tests. Only reachable when ALLOW_TEST_CONFIG is set. */
function testRng(s) {
  return () => {
    s.testRng = (s.testRng + 0x6d2b79f5) | 0;
    let t = s.testRng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A table's stakes, for future tiers: { ante, raiseLimit, potLimit }, each optional, defaulting to the engine's.
 * A tNIGHT table's pot limit has to leave a seat's worst round inside the roundCap fixed in the cage.
 */
function stakesRefusal(stakes, isCage) {
  if (stakes === null || typeof stakes !== 'object' || Array.isArray(stakes)) return 'stakes must be an object.';
  for (const key of Object.keys(stakes)) if (!['ante', 'raiseLimit', 'potLimit'].includes(key)) return `Unknown stake: ${key}.`;
  const { ante = DEFAULTS.ante, raiseLimit = DEFAULTS.raiseLimit, potLimit = DEFAULTS.potLimit } = stakes;
  for (const [name, n] of Object.entries({ ante, raiseLimit, potLimit })) if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return `${name} must be a whole number from 1 to 1000000.`;
  if (potLimit < ante * 2) return 'potLimit must be at least two antes.';
  if (isCage && roundCap({ ...DEFAULTS, ante, raiseLimit, potLimit }, 6) > CAGE_ROUND_CAP) return `On a tNIGHT table one seat's worst round must fit the cage's roundCap of ${CAGE_ROUND_CAP}.`;
  return null;
}

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    this.reported = '';
    this.budget = new AiBudget();
    this.quick = new QuickLines();
    this.sayTimes = {};
    this.testPrompts = [];
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('s')) ?? null;
      this.n = (await ctx.storage.get('n')) ?? null; // the Hall's number for this table, from its first report
      if (this.s && upgradeState(this.s, { now: Date.now() })) await ctx.storage.put('s', this.s);
      // A table from before anchoring was on (a judge's warm table, say) takes the Worker's default mode once: its rounds lock from now on.
      // New tables always store theirs (null = off), so a choice of "off" is never overridden here.
      if (this.s && this.s.anchorMode === undefined && true) { anchorAdopt(this.s, tableAnchorMode(env, undefined, { cage: !!this.s.cage })); await ctx.storage.put('s', this.s); }
    });
  }

  ctxNow() {
    const s = this.s;
    return { now: Date.now(), rng: s.testRng === undefined ? cryptoRng : testRng(s) };
  }

  get holdKey() {
    return `${GAME_ID}:${this.ctx.id.toString()}`;
  }

  /** Public state, plus the server clock so a browser can count down without trusting its own. */
  view() {
    return { ...publicView(this.s), watch: watchView(this.s), now: Date.now(), n: this.n, seatsTotal: this.s.cfg.seats, buyIn: SEAT_DEFAULT, roundSeal: this.s.deal?.seal ?? null, anchor: anchorView(this.s), anchorPicker: this.env.ANCHOR_PICKER === 'on' && !!this.s.anchorMode, dealByPlayer: this.dealByPlayer, ...(anchorHolding(this.s) ? { waitingOn: [], clocks: [] } : {}), ...(this.s.cage ? { cage: cageView(this.s, this.ctx.id.toString()) } : {}) };
  }

  /** A seat's own view. At a tNIGHT table there is no purse to add from. */
  meView(seat) {
    const me = privateView(this.s, seat);
    // While the round waits on its lock, your cards stay face down: dealt, sealed, not yet yours to see.
    const held = anchorHolding(this.s) ? { hand: null, handHeld: true, legal: [], best: null } : {};
    return this.s.cage ? { ...me, canAddChips: false, ...held } : { ...me, ...held };
  }

  /** The preview's player-started deal: a settled round waits for someone to press Shuffle & deal (no 30-second clock). Chips only. */
  get dealByPlayer() {
    return this.env.DEAL_BY_PLAYER === 'on' && !this.s?.cage;
  }

  /** After the records have sealed the deal: queue the seal once, and say so. A queue that can't take it fails the lock at once. */
  async anchorStep() {
    const s = this.s;
    if (!s.anchorMode || !s.deal?.seal) return false;
    const number = recordNumber(s, this.n, s.round);
    if (!number) return false;
    const now = Date.now();
    const item = anchorAfterSeal(s, { game: GAME_ID, tableId: this.ctx.id.toString(), recordId: `${s.cage ? 't' : ''}${number.table}-${number.round}`, seal: s.deal.seal, now });
    if (!item) return false;
    anchorQueuedLine(s, (t, x) => addLog(s, t, x));
    try {
      const r = await enqueueAnchor(this.env, item);
      if (!r.ok) this.anchorNote(anchorFail(s, r.why ?? 'the queue refused it', Date.now(), (t, x) => addLog(s, t, x)) ? r.why ?? 'refused' : null);
    } catch (err) {
      this.anchorNote(anchorFail(s, 'the anchor queue did not answer', Date.now(), (t, x) => addLog(s, t, x)) ? 'the anchor queue did not answer' : null);
      console.error('anchor enqueue:', err?.message);
    }
    return true;
  }

  /** A lock the table gave up on (offline, refused, timed out) goes on the record once, as a note beside the seal. */
  anchorNote(why) {
    const s = this.s;
    const a = s.anchor;
    if (!why || !a || a.noted) return;
    a.noted = true;
    const number = recordNumber(s, this.n, a.round);
    if (number) (s.rec ??= { posted: 0, closed: 0, queue: [] }).queue.push({ kind: s.cage ? 'tnight' : 'play', ...number, patch: { anchorNote: { state: a.state, why: String(why).slice(0, 160), mode: a.mode, at: Date.now() } } });
  }

  /** Workers AI, or the recording stand-in on a test table. */
  get ai() {
    return this.s.testAi ? mockAi(this.s.testAi, this.testPrompts) : this.env.AI ?? null;
  }

  get aiTimeoutMs() {
    return this.s.testAiTimeoutMs; // undefined means the real limit
  }

  /** Applies anything overdue and lets the bots move. */
  advance() {
    const c = this.ctxNow();
    if (anchorHolding(this.s)) {
      if (anchorExpire(this.s, c.now, (t, x) => addLog(this.s, t, x))) this.anchorNote(this.s.anchor.error);
      if (anchorHolding(this.s)) return; // the round waits on its lock: no clock, no bot
    }
    if (this.s.cage) {
      cageMaybeStart(this.s, c);
      cageForceRoundEnd(this.s, c);
      if (this.s.phase === 'settled' && this.s.deadline !== null && c.now >= this.s.deadline && cageDealBlocked(this.s, c.now)) this.s.deadline = null; // the deal waits for the table's clock: see cageClock
    }
    tick(this.s, c);
    this.bots(c);
  }

  /** The bots move, unless a round was just dealt in lock mode or is still waiting on its lock. */
  bots(c) {
    anchorBeginRound(this.s, c.now);
    if (!anchorHolding(this.s)) paceBots(this.s, c);
  }

  /** Lets queued bot lines become AI lines, within the time limit. */
  voice() {
    return voiceBots(this.s, this.ai, this.budget, Date.now(), this.aiTimeoutMs);
  }

  async persist() {
    const s = this.s;
    s.cashouts ??= [];
    cageAfterChange(s); // before anything is saved: the entry and the next round's stacks go in with this change
    if (!s.cage && this.n === null && s.seats.length > 0) await this.learnNumber(); // a play round's public number has the table's in it
    recordsAfterChange(s, this.n);
    await this.anchorStep();
    if (this.dealByPlayer && s.phase === 'settled' && s.round > 0) s.deadline = null; // the next deal is a press, not a clock
    boardAfterChange(s, this.ctx.id.toString(), netsFromMoney(s.lastResult)); // the leaderboard's lines, while each seat still names its player
    for (const { seat, amount, stood } of s.departures.splice(0)) {
      const playerId = s.players[seat];
      if (playerId) {
        s.cashouts.push({ playerId, amount });
        (s.gone ??= {})[playerId] = { seat, stack: amount, at: Date.now(), stood: !!stood };
      }
      s.players[seat] = null;
      s.tokens[seat] = null;
    }
    if (s.phase === 'over' && !s.cashoutsQueued) {
      s.cashoutsQueued = true;
      s.cashouts.push(...s.players.flatMap((playerId, seat) => (playerId ? [{ playerId, amount: s.seats[seat].chips }] : [])));
    }
    await this.ctx.storage.put('s', s);
    await this.payCashouts();
    const sentRecord = await flushRecords(this.env, s, GAME_ID);
    const sentBoard = await flushBoard(this.env, s);
    if (sentRecord || sentBoard) await this.ctx.storage.put('s', s);
    const waitingLimit = s.deadline === null && s.round > 0 && s.phase !== 'over' ? s.lastHumanAt + (s.cfg.waitingIdleMs ?? DEFAULTS.waitingIdleMs) + 1 : null;
    const times = [s.deadline, waitingLimit, nextStandAt(s), s.cashouts?.length || s.boardQueue?.length ? Date.now() + CASHOUT_RETRY_MS : null, s.cage?.startAt, s.phase !== 'over' && s.phase !== 'settled' && s.phase !== 'lobby' ? s.cage?.foldAt : null, s.rec?.queue.length && this.env.RECEIPTS ? Date.now() + RECORD_RETRY_MS : null, s.anchor?.held ? s.anchor.lockUntil : null, ...Object.values(s.botDue ?? {}).map((d) => d.at)];
    const pending = times.filter((t) => t !== null && t !== undefined);
    if (pending.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...pending));
    this.report();
  }

  /** Pays stacks back to player balances when the table ends. Repeats safely until every one lands. */
  async payCashouts() {
    const s = this.s;
    if (!s.cashouts?.length || this.paying) return;
    this.paying = true;
    try {
      for (const entry of s.cashouts.slice()) {
        try {
          await cashOut(this.env, entry.playerId, this.holdKey, entry.amount);
          s.cashouts = s.cashouts.filter((x) => x !== entry);
        } catch (err) {
          console.error('cash-out will retry:', err?.message);
        }
      }
      await this.ctx.storage.put('s', s);
    } finally {
      this.paying = false;
    }
  }

  /** What the Hall's list shows of this table. Null for a table nobody sat at: it isn't listed. */
  summary() {
    const s = this.s;
    if (s.seats.length === 0 && !s.cage) return null; // a tNIGHT table is waiting for someone to bring tNIGHT
    const phase = s.phase === 'lobby' || s.phase === 'over' ? s.phase : 'playing';
    return { game: GAME_ID, id: this.ctx.id.toString(), seatsFilled: s.seats.filter((x) => !x.left).length, seats: s.cfg.seats, phase, joinable: s.cage ? cageJoinable(s) : s.phase === 'lobby' && s.seats.length < s.cfg.seats, round: s.round, ante: s.cfg.ante, faces: tableFaces(s), ...(s.phase === 'over' ? closureFields(s) : {}), ...(s.cage ? { tnight: true, table: s.cage.table, warm: !!s.cage.warm && !!s.cage.house } : {}) };
  }

  /** Keeps the Hall's number for this table, so "table 2" survives the table leaving the Hall's list. */
  async takeNumber(res) {
    const { n } = await res.json();
    if (Number.isInteger(n) && n !== this.n) {
      this.n = n;
      await this.ctx.storage.put('n', n);
    }
  }

  /** Tells the Hall directory when something a visitor would notice has changed. */
  report() {
    const summary = this.summary();
    if (!summary) return;
    const text = JSON.stringify(summary);
    if (text === this.reported) return;
    this.reported = text;
    const body = JSON.stringify({ ...summary, seq: this.s.logN });
    this.ctx.waitUntil(directoryStub(this.env).fetch(new Request('https://directory/update', { method: 'POST', body }))
      .then((res) => this.takeNumber(res))
      .catch(() => { this.reported = ''; }));
  }

  /** The first report, waited for, so the first round's record goes up under the table's number. As at Cup & Claim. */
  async learnNumber() {
    const summary = this.summary();
    if (!summary || summary.phase === 'over') return;
    try {
      const res = await directoryStub(this.env).fetch(new Request('https://directory/update', { method: 'POST', body: JSON.stringify({ ...summary, seq: this.s.logN }) }));
      await this.takeNumber(res);
      this.reported = JSON.stringify(summary);
    } catch (err) {
      console.error('table number will retry:', err?.message);
    }
  }

  async alarm() {
    if (!this.s) return;
    this.advance();
    await this.voice();
    await this.persist();
  }

  /** Someone who left and may still sit back down: within the time, and not at a table closed for another reason. */
  goneSeat(playerId) {
    const s = this.s;
    const gone = s.gone?.[playerId];
    if (!gone || gone.stack < 1 || !s.seats[gone.seat]?.left) return null;
    if (Date.now() - gone.at > (s.cfg.resitMs ?? DEFAULTS.resitMs)) return null;
    if (s.phase === 'over' && (s.overCode ?? (s.overReason === 'everyone has left' ? 'everyone_left' : null)) !== 'everyone_left') return null;
    return gone;
  }

  /** Where this player stands at this table. */
  seatStatus(playerId) {
    const s = this.s;
    const seat = s.players.indexOf(playerId);
    if (seat >= 0 && s.phase !== 'over' && !s.seats[seat].left) return { status: 'seated', seat, stack: s.seats[seat].chips, phase: s.phase, round: s.round, n: this.n };
    const gone = this.goneSeat(playerId);
    return gone ? { status: 'left', seat: gone.seat, stack: gone.stack, stood: !!gone.stood, n: this.n } : { status: 'none' };
  }

  async seatFor(request) {
    const token = bearer(request);
    if (!token) throw new RuleError('no_token', 'Send your seat token as "Authorization: Bearer <token>".', 401);
    const hash = await sha256(token);
    const seat = this.s.tokens.indexOf(hash);
    if (seat < 0) throw new RuleError('bad_token', 'That seat token is not valid for this table.', 401);
    return seat;
  }

  async fetch(request) {
    try {
      return await this.route(request);
    } catch (err) {
      if (err instanceof RuleError || err instanceof ApiError) return fail(err.status, err.code, err.message);
      console.error('table error:', err?.message);
      return fail(500, 'server_error', 'Something went wrong on the server.');
    }
  }

  async route(request) {
    const { pathname } = new URL(request.url);
    const op = `${request.method} ${pathname}`;

    if (op === 'POST /init') return this.init(await request.json());
    if (!this.s) return fail(404, 'no_table', 'No such table.');
    if (pathname.startsWith('/judge/')) return tnight.judge(this, request, pathname.slice(7));

    switch (op) {
      case 'GET /':
        return json(this.view());
      case 'GET /me': {
        const seat = await this.seatFor(request);
        return json(this.meView(seat));
      }
      case 'POST /join':
        if (this.s.cage) throw new RuleError('cage_table', 'This is a tNIGHT table: sit in the cage, then POST /tables/:id/cage-seat.');
        return this.joinRoute(request);
      case 'POST /cage-seat':
        return tnight.claim(this, request);
      case 'GET /cage-seat':
        return tnight.claimStatus(this, request);
      case 'POST /act': {
        const seat = await this.seatFor(request);
        const body = await request.json();
        if (anchorHolding(this.s) && body?.action !== 'back') throw new RuleError('locking', 'Your hand is being locked on Midnight. One moment.', 409);
        const c = this.ctxNow();
        const legalBefore = legalActions(this.s, seat); // for the collusion watch: who this move could have challenged
        act(this.s, seat, body, c);
        watchMove(this.s, seat, legalBefore, body);
        watchCheck(this.s, addLog);
        this.bots(c);
        await this.voice();
        await this.persist();
        return json({ ok: true, me: this.meView(seat), state: this.view() });
      }
      case 'POST /anchor-result': { // internal: only the AnchorQueue reaches this (index.js has no route to it)
        const r = await request.json();
        const now = Date.now();
        const { changed, patch } = anchorApplyResult(this.s, r, now, (t, x) => addLog(this.s, t, x));
        const number = recordNumber(this.s, this.n, r.round);
        if (patch && number) (this.s.rec ??= { posted: 0, closed: 0, queue: [] }).queue.push({ kind: this.s.cage ? 'tnight' : 'play', ...number, patch });
        if (this.s.anchor?.round === r.round && ['failed'].includes(this.s.anchor.state)) this.anchorNote(this.s.anchor.error);
        if (changed) this.bots(this.ctxNow());
        await this.persist();
        return json({ ok: true });
      }
      case 'POST /say': {
        const seat = await this.seatFor(request);
        const body = await request.json();
        const cleaned = cleanSay(body?.text);
        if (cleaned.error) throw new RuleError('bad_text', cleaned.error, 400);
        if (!seatMaySay(this.sayTimes, seat, Date.now())) throw new RuleError('rate_limited', 'Easy there. Give the table a few seconds.', 429);
        addTalk(this.s, seat, cleaned.text);
        await this.persist();
        return json({ ok: true, text: cleaned.text }, 201);
      }
      case 'POST /leave': {
        const seat = await this.seatFor(request);
        const c = this.ctxNow();
        const body = await request.json().catch(() => ({}));
        if (this.s.cage && body?.moving) cageMoving(this.s, seat); // the Hop: this player's next seat is already asked for
        const result = leave(this.s, seat, c);
        this.bots(c);
        await this.voice();
        await this.persist();
        return json({ ok: true, ...result, state: this.view() });
      }
      case 'POST /deal-now': { // a chip lobby: bots take the empty seats and the deal is now
        const seat = await this.seatFor(request);
        const c = this.ctxNow();
        dealNow(this.s, seat, c);
        this.bots(c);
        await this.voice();
        await this.persist();
        return json({ ok: true, state: this.view() });
      }
      case 'POST /add-chips':
        return this.addChipsRoute(request);
      case 'POST /fill-up':
        return this.fillUpRoute(request);
      case 'POST /seat-of': {
        // Internal: index.js has no route to this. The Worker and other tables ask it for a player they've verified.
        const { playerId } = await request.json();
        return json(this.seatStatus(playerId));
      }
      case 'GET /seat': {
        const me = await verifyPlayer(this.env, bearer(request));
        return json(this.seatStatus(me.playerId));
      }
      case 'GET /quick': {
        await this.seatFor(request);
        return json(await this.quick.get(this.s, this.ai, this.budget, Date.now(), this.aiTimeoutMs));
      }
      case 'GET /test-prompts':
        // Only a table created with test options has any, and only a test server can create those.
        return this.s.testAi ? json({ prompts: this.testPrompts }) : fail(404, 'not_found', 'No such route.');
      default:
        return fail(404, 'not_found', 'No such route.');
    }
  }

  /** From the purse to the stack, between rounds. If a round was dealt while the purse paid, the chips go straight back. */
  async addChipsRoute(request) {
    const seat = await this.seatFor(request);
    if (this.s.cage) throw new RuleError('cage_table', 'Chips at a tNIGHT table come from the cage. Stand, deposit, and sit again.');
    const { amount } = await request.json();
    checkAddChips(this.s, seat, amount);
    const playerId = this.s.players[seat];
    if (!playerId) throw new RuleError('no_purse', 'This seat plays on table chips only, so there is no purse to add from.');
    const player = await moveToSeat(this.env, playerId, this.holdKey, amount);
    try {
      checkAddChips(this.s, seat, amount);
    } catch (err) {
      await moveToSeat(this.env, playerId, this.holdKey, -amount);
      throw err;
    }
    addChips(this.s, seat, amount, this.ctxNow());
    await this.persist();
    return json({ ok: true, stack: this.s.seats[seat].chips, purse: player.purse, me: privateView(this.s, seat), state: this.view() });
  }

  /**
   * "Fill up" (play chips): between rounds, the stack back to SEAT_DEFAULT, free and as often as wanted. A seat with a purse is
   * paid from it, and the purse is raised by just the shortfall first (so the purse never decides whether it works); a seat with
   * table chips only just gets the chips. Not at a tNIGHT table: there the chips are the cage's.
   */
  async fillUpRoute(request) {
    const seat = await this.seatFor(request);
    if (this.s.cage) throw new RuleError('cage_table', 'Chips at a tNIGHT table come from the cage. Stand, deposit, and sit again.');
    const need = SEAT_DEFAULT - this.s.seats[seat].chips;
    checkAddChips(this.s, seat, Math.max(1, need)); // the same refusals as adding chips (between rounds, not leaving, not away)
    if (need <= 0) return json({ ok: true, added: 0, stack: this.s.seats[seat].chips, purse: null, me: privateView(this.s, seat), state: this.view() });
    const playerId = this.s.players[seat];
    let purse = null;
    if (playerId) {
      await fillPurse(this.env, playerId, need);
      const player = await moveToSeat(this.env, playerId, this.holdKey, need);
      purse = player.purse;
      try {
        checkAddChips(this.s, seat, need);
      } catch (err) {
        await moveToSeat(this.env, playerId, this.holdKey, -need);
        throw err;
      }
    }
    addChips(this.s, seat, need, this.ctxNow());
    await this.persist();
    return json({ ok: true, added: need, stack: this.s.seats[seat].chips, purse, me: privateView(this.s, seat), state: this.view() });
  }

  async joinRoute(request) {
    const body = await request.json();
    const avatar = cleanAvatar(body?.avatar);
    const playerToken = bearer(request);
    // A retired look is only for the player who already has it. That's checked below, once the player is known.
    const retiredLook = playerToken && isRetiredAvatar(body?.avatar);
    if (avatar.error && !retiredLook) throw new RuleError('bad_avatar', avatar.error, 400);
    const kind = body?.kind ?? 'agent'; // whoever doesn't say is treated as an agent
    if (kind !== 'agent' && kind !== 'human') throw new RuleError('bad_kind', 'kind must be "agent" or "human".', 400);
    const buyIn = body?.buyIn;
    if (buyIn !== undefined && (!Number.isInteger(buyIn) || buyIn < 1)) throw new RuleError('bad_buyin', 'buyIn must be a whole number of chips, at least 1.', 400);

    const claimed = parsePlayerToken(this.env, playerToken)?.playerId; // not trusted until the hold below checks the token
    const wasGone = claimed ? this.goneSeat(claimed) : null;
    if (this.s.phase === 'over' && !wasGone) throw new RuleError('table_over', 'This table has finished.');
    if (wasGone && this.paying) throw new RuleError('busy', 'Your stack is on its way to your purse. Try again in a moment.');

    let name;
    let held = null;
    let returning = null;
    if (playerToken) {
      // A person or an agent sits down with SEAT_DEFAULT unless they say otherwise; a purse below it is filled to it first, so nobody gets a small default stack.
      // Back at a seat they left, nothing changes: a person's one stack comes too (with no amount named, the whole purse, which holds it); if they
      // name an amount, it's never less than they walked away with; an agent gets just its stack. Only a fresh seat takes the default.
      const defaultBuy = buyIn === undefined && !wasGone;
      const wholePurse = buyIn === undefined && kind === 'human' && !!wasGone;
      const backWith = kind === 'human' ? Math.max(buyIn ?? 0, wasGone?.stack ?? 0) : wasGone?.stack;
      held = await holdChips(this.env, playerToken, this.holdKey, wasGone ? backWith : buyIn ?? SEAT_DEFAULT, { upTo: !!wasGone, all: wholePurse, fillTo: defaultBuy ? SEAT_DEFAULT : 0 });
      name = held.name;
      const giveBack = async () => {
        if (!held.alreadyHeld) await releaseChips(this.env, held.playerId, this.holdKey);
      };
      if (retiredLook && held.avatar !== body.avatar) {
        await giveBack();
        throw new RuleError('bad_avatar', avatar.error, 400);
      }
      returning = this.goneSeat(held.playerId);
      if (this.s.phase === 'over' && !returning) { // it ended while the buy-in was on its way
        await giveBack();
        throw new RuleError('table_over', 'This table has finished.');
      }
      if (avatar.id) await rememberAvatar(this.env, playerToken, avatar.id);
      const rejoin = async (existing) => {
        if (avatar.id) this.s.seats[existing].avatar = avatar.id;
        // Same player again: a new device or a cleared browser. The old seat token stops working.
        const token = randomToken();
        this.s.tokens[existing] = await sha256(token);
        await this.persist();
        return json({ seat: existing, token, rejoined: true, state: this.view() }, 200);
      };
      if (this.s.players.indexOf(held.playerId) >= 0) return rejoin(this.s.players.indexOf(held.playerId));
      if (kind === 'human') { // a person plays one table at a time, so a stack is never left behind by accident
        // cards AND dice: a person plays one table at a time across both games (the default stack is minted at join, so an empty purse no longer stops a second seat)
        const [other] = [...(await liveSeats(this.env, held.inPlay, held.playerId, { except: this.holdKey })), ...(await diceSeats(this.env, held.inPlay, held.playerId))].sort((a, b) => b.stack - a.stack);
        if (other) {
          await giveBack();
          throw new RuleError('seated_elsewhere', `You still have a seat at another table, with a stack of ${other.stack}. Return to it, or leave it first.`);
        }
        if (this.s.players.indexOf(held.playerId) >= 0) return rejoin(this.s.players.indexOf(held.playerId));
      }
      returning = this.goneSeat(held.playerId);
      if (returning) return this.resit(held, returning, avatar.id);
    } else {
      const cleaned = cleanName(body?.name);
      if (cleaned.error) throw new RuleError('bad_name', cleaned.error, 400);
      if (isDoormanName(cleaned.name)) throw new RuleError('name_reserved', `"${DOORMAN.name}" keeps the door here. Pick another name.`);
      name = cleaned.name;
    }

    const token = randomToken();
    const hash = await sha256(token);
    const c = this.ctxNow();
    let seat;
    try {
      seat = join(this.s, name, c, { kind, avatar: avatar.id ?? held?.avatar ?? DEFAULT_AVATAR, chips: held ? held.held : SEAT_DEFAULT });
    } catch (err) {
      if (held && !held.alreadyHeld) await releaseChips(this.env, held.playerId, this.holdKey);
      throw err;
    }
    this.s.tokens[seat] = hash;
    this.s.players[seat] = held?.playerId ?? null;
    watchOrigin(this.s, seat, { ipHash: await originHash(request, this.ctx.id.toString()) });
    watchCheck(this.s, addLog);
    this.bots(c);
    await this.voice();
    await this.persist();
    return json({ seat, token, state: this.view() }, 201);
  }

  /**
   * Back at the seat they left. The hold above took their stack back out of the purse, or as much of it as is left
   * there. If their cash-out hadn't landed yet, it's cancelled instead, and the hold simply stays.
   */
  async resit(held, gone, avatarId) {
    if (this.paying) {
      if (!held.alreadyHeld) await releaseChips(this.env, held.playerId, this.holdKey);
      throw new RuleError('busy', 'Your stack is on its way to your purse. Try again in a moment.');
    }
    const token = randomToken();
    const hash = await sha256(token);
    const s = this.s;
    const c = this.ctxNow();
    const chips = held.alreadyHeld ? gone.stack : held.held;
    s.cashouts = (s.cashouts ?? []).filter((x) => x.playerId !== held.playerId);
    sitBackDown(s, gone.seat, chips, c);
    if (avatarId) s.seats[gone.seat].avatar = avatarId;
    s.tokens[gone.seat] = hash;
    s.players[gone.seat] = held.playerId;
    delete s.gone[held.playerId];
    s.cashoutsQueued = false;
    this.bots(c);
    await this.voice();
    await this.persist();
    return json({ seat: gone.seat, token, rejoined: true, stack: chips, state: this.view() }, 200);
  }

  async init(options) {
    if (this.s) return fail(409, 'exists', 'Table already exists.');
    const cfg = {};
    if (options.lobbySeconds !== undefined) {
      const seconds = options.lobbySeconds;
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300) return fail(400, 'bad_lobby', 'lobbySeconds must be a whole number from 0 to 300.');
      cfg.lobbyMs = seconds * 1000;
    }
    let testRngStart;
    let testAi;
    let testAiTimeoutMs;
    if (options.test !== undefined) {
      if (this.env.ALLOW_TEST_CONFIG !== '1') return fail(400, 'test_config_off', 'Test options are off on this server.');
      if (options.test.turnMs) cfg.turnMs = options.test.turnMs;
      if (options.test.seats) cfg.seats = options.test.seats;
      if (options.test.roundGapMs !== undefined) cfg.roundGapMs = options.test.roundGapMs;
      if (options.test.idleMs !== undefined) cfg.idleMs = options.test.idleMs;
      if (options.test.waitingIdleMs !== undefined) cfg.waitingIdleMs = options.test.waitingIdleMs;
      if (options.test.resitMs !== undefined) cfg.resitMs = options.test.resitMs;
      if (options.test.awayStandMs !== undefined) cfg.awayStandMs = options.test.awayStandMs;
      cfg.botDelayMs = options.test.botDelayMs ?? [0, 0]; // test tables don't wait for bots unless they ask to
      if (options.test.rng !== undefined) testRngStart = options.test.rng | 0;
      testAi = options.test.aiMock;
      if (Number.isInteger(options.test.anchorLockMs)) cfg.anchorLockMs = options.test.anchorLockMs;
      testAiTimeoutMs = options.test.aiTimeoutMs;
    }
    if (options.stakes !== undefined) {
      const refusal = stakesRefusal(options.stakes, !!options.cage);
      if (refusal) return fail(400, 'bad_stakes', refusal);
      Object.assign(cfg, options.stakes);
    }
    if (!options.cage) { // play chips: a bid or raise can go up to a whole stack, house bots sit with one (platform/stakes.js). tNIGHT keeps the engine's stakes and the cage's roundCap.
      const lifted = chipsStakes(cfg.seats ?? DEFAULTS.seats);
      for (const key of ['startChips', 'potLimit', 'botLow', 'botLogMin']) cfg[key] ??= lifted[key];
      cfg.raiseLimit ??= Math.min(lifted.raiseLimit, cfg.potLimit);
    }
    if (options.cage) cfg.turnMs ??= CAGE_TURN_MS;
    this.s = createTable(cfg);
    if (options.cage) { // only createTable in index.js can set this: it replaces any sent
      this.s.cage = newCage({ ...options.cage, lobbyMs: options.cage.warm ? 0 : this.s.cfg.lobbyMs });
      this.s.cfg.lobbyMs = 1; // never 0: the engine would deal, with bots on play chips, at the first join
    }
    this.s.tokens = [];
    this.s.players = [];
    const anchorMode = tableAnchorMode(this.env, options.anchor, { cage: !!options.cage });
    this.s.anchorMode = anchorMode ?? null; // always stored: undefined means a table from before anchoring
    if (cfg.anchorLockMs) this.s.anchorLockMs = cfg.anchorLockMs;
    if (testRngStart !== undefined) this.s.testRng = testRngStart;
    if (testAi) this.s.testAi = testAi;
    if (testAiTimeoutMs) this.s.testAiTimeoutMs = testAiTimeoutMs;
    await this.persist();
    return json({ state: this.view() }, 201);
  }
}
