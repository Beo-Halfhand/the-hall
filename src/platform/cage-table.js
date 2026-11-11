// What every game's tNIGHT table does over HTTP: opening one, taking a seat claim, and answering the judge. The rules are in
// cage.js, bound to the game's engine. A game passes its own engine bits here, and its table calls these from its routes.
//
// `table` is the game's Durable Object: this.s, this.ctx, this.env, this.ctxNow(), this.persist(), this.view().

import { DEFAULT_AVATAR, cleanAvatar } from './avatars.js';
import { directoryStub } from './directory.js';
import { doorSession } from './door.js';
import { isDoormanName } from './doorman.js';
import { cleanName } from './filter.js';
import { bearer, fail, json, randomToken, sha256 } from './http.js';
import { BUY_IN_MAX } from './agent-settings.js';
import { originHash, watchCheck, watchOrigin } from './collusion.js';

const CAGE_ADDRESS = /^[0-9a-f]{64}$/;
const STAR_PER_CHIP = 1_000_000;

/**
 * Checks `tnight` and `bots` on the options for a new table and takes a cage table number. Returns { error } or { cage }, which
 * goes in the table's init options. Only the Worker sets it: anything a client sent as `cage` is dropped before this.
 */
export async function openCageOptions(env, tableId, opts, { warm = false, maxBots, game }) {
  if (opts.tnight !== true) return { error: fail(400, 'bad_tnight', 'tnight must be true, or left out.') };
  if (env.TNIGHT_TABLES !== 'on' || !CAGE_ADDRESS.test(env.CAGE_ADDRESS ?? '')) return { error: fail(400, 'tnight_off', 'tNIGHT tables are off on this server.') };
  // The drain switch: tables in play finish and the judge API stays up, which turning TNIGHT_TABLES off would stop. No new tables, and no new seats (see claim).
  if (env.TNIGHT_DRAIN === 'on') return { error: fail(409, 'draining', 'The Hall isn\'t opening new tNIGHT tables just now.') };
  const bots = opts.bots ?? 0;
  if (!Number.isInteger(bots) || bots < 0 || bots > maxBots) return { error: fail(400, 'bad_bots', `bots must be a whole number from 0 to ${maxBots}.`) };
  const res = await directoryStub(env).fetch(new Request('https://directory/cage/new', { method: 'POST', body: JSON.stringify({ id: tableId, base: Number(env.CAGE_TABLE_BASE) || 0, game }) }));
  const { table } = await res.json();
  return { cage: { table, address: env.CAGE_ADDRESS, bots, warm } };
}

/** The seat-claim and judge routes for one game. */
export function cageTableRoutes({ cage, RuleError, addLog, isReservedName, leave, paceBots, apiPath }) {
  const { cageAlert, cageClock, cageDead, cageHouseSeated, cageMaybeStart, cageReleased, cageSeatVerified, cageSeated, cageSettled, cageStanding, cageWork, claimRefusal, seatMessage } = cage;

  /**
   * A seat at a tNIGHT table. The claim holds nothing and deals nothing: the judge reads the cage, checks the signature
   * against the seat's payout address, and only then does the engine get a seat.
   *
   * With `atRiskStar` and a session from the door it also asks the judge to seat them under their permit, or to move them here from the table they are finishing at.
   * Without it, it is "I have sat, read it". Either way the seat is read back from the chain before anyone is dealt in.
   */
  async function claim(table, request) {
    const { s } = table;
    if (!s.cage) throw new RuleError('not_cage_table', 'This table plays on chips, not tNIGHT.');
    if (table.env.TNIGHT_DRAIN === 'on') throw new RuleError('draining', 'The Hall isn\'t taking new tNIGHT seats just now. Your money is safe, and comes out from the cage page as usual.');
    const body = await request.json();
    // With a session from the door, the player key and wallet were proven there, and the id comes from that, not from the request.
    const door = body?.doorToken ? await doorSession(table.env, body.doorToken) : null;
    if (door) {
      body.cageId = door.cageId;
      body.name ??= door.name;
      body.avatar ??= door.avatar ?? undefined;
      body.kind ??= door.kind;
    }
    const refusal = claimRefusal(s, body?.cageId);
    if (refusal) throw new RuleError(refusal.code, refusal.message);
    const cleaned = cleanName(body?.name);
    if (cleaned.error) throw new RuleError('bad_name', cleaned.error, 400);
    const avatar = cleanAvatar(body?.avatar);
    if (avatar.error) throw new RuleError('bad_avatar', avatar.error, 400);
    const kind = body?.kind ?? 'agent';
    if (kind !== 'agent' && kind !== 'human') throw new RuleError('bad_kind', 'kind must be "agent" or "human".', 400);
    if (!door && (typeof body?.verifyingKey !== 'string' || typeof body?.signature !== 'string' || body.verifyingKey.length > 256 || body.signature.length > 512)) {
      throw new RuleError('bad_proof', `Send verifyingKey and signature: the key your cage balance pays out to, signing the message from GET ${apiPath}/:id.`, 400);
    }
    if (isReservedName(cleaned.name) || isDoormanName(cleaned.name)) throw new RuleError('name_reserved', `"${cleaned.name}" is reserved. Pick another name.`);
    const lower = cleaned.name.toLowerCase();
    if (s.seats.some((x) => x.name.toLowerCase() === lower) || Object.values(s.cage.claims).some((x) => x.status === 'pending' && x.name.toLowerCase() === lower)) {
      throw new RuleError('name_taken', `"${cleaned.name}" is already at this table.`);
    }
    // Only a session from the door can ask: it proves the wallet behind this player key. The judge checks the permit, the cap and the floor against the chain.
    let ask = null;
    if (body?.atRiskStar !== undefined) {
      if (!door) throw new RuleError('door_required', 'Asking the judge to seat you takes a session from the door.', 401);
      if (typeof body.atRiskStar !== 'string' || !/^[1-9]\d{0,18}$/.test(body.atRiskStar)) throw new RuleError('bad_risk', 'atRiskStar must be a whole number of STAR, as a string.', 400);
      // The table's buy-in max: 250 a seat, for a person or an agent (the judge holds to it too, and to an agent's daily cap).
      const potMost = s.cfg.potLimit ? BigInt(s.cfg.potLimit) * BigInt(STAR_PER_CHIP) : null;
      const capMost = BigInt(BUY_IN_MAX) * BigInt(STAR_PER_CHIP);
      const most = potMost !== null && potMost < capMost ? potMost : capMost;
      const want = BigInt(body.atRiskStar);
      if (want < BigInt(s.cfg.ante) * BigInt(STAR_PER_CHIP)) throw new RuleError('bad_risk', `This table's ante is ${s.cfg.ante}, so bring at least ${s.cfg.ante} tNIGHT.`, 400);
      ask = { atRiskStar: String(most !== null && want > most ? most : want) };
    }
    const token = randomToken();
    s.cage.claims[body.cageId] = {
      name: cleaned.name,
      kind,
      avatar: avatar.id ?? DEFAULT_AVATAR,
      tokenHash: await sha256(token),
      ...(door
        ? { door: true, ...(ask ? { ask } : {}) }
        : { verifyingKey: body.verifyingKey, signature: body.signature, message: seatMessage(s.cage, table.ctx.id.toString(), body.cageId) }),
      status: 'pending',
      origin: { ipHash: await originHash(request, table.ctx.id.toString()), payout: door?.payout ?? null }, // for the collusion watch
      at: Date.now(),
      approvedAt: Number.isFinite(body.approvedAt) ? body.approvedAt : null,
    };
    addLog(s, ask ? `${cleaned.name} asked the judge for a seat.` : `${cleaned.name} is waiting for the judge to confirm a seat in the cage.`);
    await table.persist();
    return json({ status: 'pending', token, state: table.view() }, 202);
  }

  async function claimStatus(table, request) {
    if (!table.s.cage) throw new RuleError('not_cage_table', 'This table plays on chips, not tNIGHT.');
    const hash = await sha256(bearer(request));
    const found = Object.values(table.s.cage.claims).find((x) => x.tokenHash === hash);
    if (!found) throw new RuleError('bad_token', 'That token has no seat claim at this table.', 401);
    return json({ status: found.status, seat: found.seat ?? null, reason: found.reason ?? null, code: found.code ?? null, step: found.step ?? null, receipt: found.seatedBy ?? null, stack: found.status === 'seated' ? table.s.seats[found.seat].chips : null });
  }

  /** Only the Worker's judge route reaches these, after it has checked the judge's token. */
  async function judge(table, request, op) {
    const { s } = table;
    if (!s.cage) return fail(404, 'not_cage_table', 'This table plays on chips, not tNIGHT.');
    const id = table.ctx.id.toString();
    if (op === 'work') return json(cageWork(s, id));
    const body = await request.json();
    const c = table.ctxNow();
    let out = { ok: true };
    switch (op) {
      case 'verified': {
        out = cageSeatVerified(s, body.cageId, body, c);
        if (out.status === 'seated') {
          watchOrigin(s, out.seat, s.cage.claims[body.cageId].origin ?? {});
          watchCheck(s, addLog);
          s.tokens[out.seat] = s.cage.claims[body.cageId].tokenHash;
          s.players[out.seat] = null; // never a purse: the chain holds this money
        }
        break;
      }
      case 'house':
        out = cageHouseSeated(s, body.cageId, body);
        break;
      case 'settled':
        out = cageSettled(s, body.seqs, body.tx, { dropped: body.dropped ?? null, lines: body.lines ?? null });
        if (out.conflicts.length) return json({ error: 'conflict', ...out }, 409);
        break;
      case 'released':
        cageReleased(s, body.cageId, body.tx ?? null);
        break;
      case 'standing': {
        // They called stand on chain themselves. The next settle naming them frees the seat, so this is their last round, and it has to be over before standUntil.
        const seat = s.cage.holders[body.cageId]?.seats[0];
        if (seat !== undefined && s.phase !== 'over' && !s.seats[seat].left && !s.seats[seat].leaving) leave(s, seat, c);
        cageStanding(s, body.cageId, body.standUntil, c);
        break;
      }
      case 'clock':
        cageClock(s, body.tableUntil, c);
        break;
      case 'seated':
        cageSeated(s, body.cageId, body);
        break;
      case 'step': // what the judge is doing for this seat now, for the player's window
        if (s.cage.claims[body.cageId]?.status === 'pending') s.cage.claims[body.cageId].step = String(body.step ?? '').slice(0, 20);
        break;
      case 'dead':
        cageDead(s, body.reason ?? 'the cage escape fired: no settle for 30 minutes.');
        break;
      case 'alert':
        cageAlert(s, body.message);
        break;
      case 'stop': { // an agent's owner pressed Stop: the seat finishes the round it is in, then leaves; a claim still waiting is dropped
        const seat = s.cage.holders[body.cageId]?.seats[0];
        if (seat !== undefined && s.phase !== 'over' && !s.seats[seat].left && !s.seats[seat].leaving) {
          leave(s, seat, c);
          addLog(s, `${s.seats[seat].name}'s owner stopped it: it leaves after this round.`);
        }
        if (s.cage.claims[body.cageId]?.status === 'pending') Object.assign(s.cage.claims[body.cageId], { status: 'refused', code: 'agent_stopped', reason: 'This agent\'s owner has stopped it.' });
        break;
      }
      default:
        return fail(404, 'not_found', 'No such route.');
    }
    cageMaybeStart(s, c);
    paceBots(s, c);
    await table.persist();
    return json({ ...out, state: table.view() });
  }

  return { claim, claimStatus, judge };
}
