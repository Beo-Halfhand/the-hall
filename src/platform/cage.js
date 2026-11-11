// tNIGHT tables: the seat and money rules that sit around a game's engine, for every game in the Hall. Pure state on s.cage,
// no I/O. A game calls makeCage with its own engine and gets these rules bound to it; platform/cage-table.js does the I/O.
//
// The engine still only knows chips. Here one chip is one tNIGHT of the player's balance in the cage contract, and the
// chain is the bank: the server never pays or holds anything. It reports each finished round as lines the judge settles.
//
// What the contract makes us respect:
//   - A seat exists only once the judge has read it from cage state, with a signature proving who it belongs to.
//   - A debit can't pass the seat's remaining atRisk, and winning doesn't raise atRisk. So a stack is never more than
//     min(remaining atRisk, balance); anything above that waits "behind" the seat, still the player's, not in play.
//   - Debits must equal credits in each entry, so a round whose pot carries over isn't reported until a pot is paid.
//   - All of a table's bots are one on-chain seat, the house's, so they net to one line.

export const STAR_PER_CHIP = 1_000_000;
export const CAGE_ROUND_CAP = 1000; // cage #3's roundCap, in chips: fixed in the contract
export const CAGE_TURN_MS = 15_000; // a slow round has to fit inside the cage's 30-minute escape: see sealed-cage/NOTES.md
export const MAX_PENDING_CLAIMS = 8;
// How a stand's clock is kept. A hold for a standing player ends HOLD_MARGIN (180 s) before their stand runs out (sealed-cage scripts/judge-plan.mjs). This ends the round
// before that, so their line exists when the hold ends. A round is forced to its end only this close to a deadline: an honest table never sees it.
export const FOLD_BEFORE_SECS = 240;
export const MIN_ROUND_SECS = 600; // far enough from FOLD_BEFORE_SECS that a dealt round isn't ended moments later. A deal this close to the table's deadline waits for a settle of nothing, which the judge sends when it sees dealWaiting
const MAX_RECEIPTS = 100;
const MAX_SEAT_RECEIPTS = 40;
const HEX64 = /^[0-9a-f]{64}$/;

export const isCageId = (id) => typeof id === 'string' && HEX64.test(id);

/** What a player signs with the wallet key their cage balance pays out to. */
export const seatMessage = (cage, tableId, cageId) => `sealed-hand:seat:v1|${cage.address}|${tableId}|${cageId}`;

/**
 * The cage rules bound to one game's engine. The engine must keep seats as { chips, left, leftWith, leaving, bot }, a pot, a
 * round counter, and the phases lobby, settled and over; it must offer the five calls below.
 */
export function makeCage({ addLog, fillBots, inRound, join, startRound, returnPot, tick, game = 'sealed-hand' }) {
  function newCage({ table, address, bots = 0, warm = false, lobbyMs }) {
    return {
      warm, // kept ready by the judge: the house float goes on chain before anyone comes, and a seat deals at once
      lobbyMs, // the engine's own lobby clock would fill empty seats with play-chip bots, so this table keeps its own
      table, // the Uint32 table id on chain
      address,
      status: 'open', // open | dead
      wantBots: bots,
      house: null, // { cageId } once the judge has seated the float
      claims: {}, // cageId → { name, kind, avatar, tokenHash, verifyingKey, signature, message, status: pending | seated | refused, reason, seat }
      holders: {}, // cageId → { kind: player | house, name, seats: [seat], atRisk, balance, behind, epoch, released }
      seatOwner: [], // seat → cageId
      base: [], // seat → stack when the last entry was cut
      startAt: null, // when a table in its lobby deals, once it has two seats and a person
      recorded: 0, // the last engine round already taken into an entry or a window
      window: [], // engine rounds finished but not yet in an entry (a carried pot)
      entries: [], // { seq, rounds, lines: [{ id, delta }], tx: null | {...} }
      nextSeq: 1,
      receipts: [],
      alert: null, // the judge's word on why it can't settle here
      broken: null, // our own: the chip count stopped adding up, so rounds are no longer reported
      tableUntil: null, // when the table goes quiet on chain, in unix seconds, from the judge
      foldAt: null, // ms: the round in play is ended by then, so a stand's last line exists before the hold ends
      dealtAt: null, // ms: when the round in play was dealt
      dealWaiting: false, // a deal held back until the table's deadline moves
      seatReceipts: [], // seats and moves the judge made under a permit: all public on chain
    };
  }

  /** Whether someone could still bring tNIGHT here: the Hall's "Bring tNIGHT" button. */
  /** A claim's stack can't be under one ante, so a warm table's float is sized by the judge in the same terms. */
  function cageJoinable(s) {
    const c = s.cage;
    if (c.status !== 'open' || s.phase !== 'lobby') return false;
    const pending = Object.values(c.claims).filter((x) => x.status === 'pending').length;
    return s.seats.length + pending + (c.house ? 0 : c.wantBots) < s.cfg.seats;
  }

  /** Why a new claim can't be taken, or null. */
  function claimRefusal(s, cageId) {
    const c = s.cage;
    if (c.status !== 'open' || s.phase !== 'lobby') return { code: 'table_started', message: 'This table has already started.' };
    if (!isCageId(cageId)) return { code: 'bad_cage_id', message: 'cageId must be 64 hex characters, lowercase.' };
    if (c.holders[cageId]) return { code: 'already_seated', message: 'That cage id already has a seat here.' };
    const pending = Object.values(c.claims).filter((x) => x.status === 'pending');
    if (c.claims[cageId]?.status === 'pending') return { code: 'claim_pending', message: 'That cage id is already waiting for the judge.' };
    if (pending.length >= MAX_PENDING_CLAIMS) return { code: 'too_many_claims', message: 'Too many seats are waiting for the judge here. Try shortly.' };
    const reserved = c.house ? 0 : c.wantBots;
    if (s.seats.length + pending.length + reserved >= s.cfg.seats) return { code: 'table_full', message: 'This table is full.' };
    return null;
  }

  const wholeChips = (star) => Math.floor(Number(star) / STAR_PER_CHIP);
  const stackOf = (x) => (x.left ? x.leftWith ?? 0 : x.chips);

  /** Where a holder's playing stack may go: never over what the contract would let the judge debit. */
  function capOf(holder, pendingLoss) {
    return Math.max(0, Math.min(holder.atRisk, holder.balance) - pendingLoss);
  }

  function holderLoss(c, s, id) {
    const seats = c.holders[id].seats;
    const net = seats.reduce((sum, seat) => sum + stackOf(s.seats[seat]) - c.base[seat], 0);
    return Math.max(0, -net);
  }

  /** Moves chips between the stack and behind it, so a holder's next round can't lose more than the contract allows. */
  function clampHolder(s, id) {
    const c = s.cage;
    const holder = c.holders[id];
    const live = holder.seats.filter((seat) => !s.seats[seat].left);
    if (live.length === 0) return;
    const cap = capOf(holder, holderLoss(c, s, id));
    let total = live.reduce((sum, seat) => sum + s.seats[seat].chips, 0);
    while (total > cap) {
      const seat = live.reduce((a, b) => (s.seats[b].chips > s.seats[a].chips ? b : a));
      const off = Math.min(total - cap, Math.max(1, s.seats[seat].chips - Math.floor(cap / live.length)));
      s.seats[seat].chips -= off;
      c.base[seat] -= off;
      holder.behind += off;
      total -= off;
    }
    while (total < cap && holder.behind > 0) {
      const seat = live.reduce((a, b) => (s.seats[b].chips < s.seats[a].chips ? b : a));
      const on = Math.min(cap - total, holder.behind);
      s.seats[seat].chips += on;
      c.base[seat] += on;
      holder.behind -= on;
      total += on;
    }
    if (cap === 0 && !holder.spent && holder.kind === 'player') {
      holder.spent = true;
      addLog(s, `${holder.name} has used up this seat's at-risk limit. Stand and sit again to play on.`);
    }
  }

  function cutEntry(s) {
    const c = s.cage;
    const lines = [];
    for (const [id, holder] of Object.entries(c.holders)) {
      const delta = holder.seats.reduce((sum, seat) => sum + stackOf(s.seats[seat]) - c.base[seat], 0);
      if (delta !== 0) lines.push({ id, delta });
      holder.balance += delta;
      holder.atRisk -= Math.max(0, -delta);
      for (const seat of holder.seats) c.base[seat] = stackOf(s.seats[seat]);
    }
    const rounds = c.window.splice(0);
    if (lines.length === 0) {
      // No chips moved, so there's nothing to settle, and the node refuses an entry with no lines (Custom error 168).
      if (rounds.length) addLog(s, `${rounds.length === 1 ? `Round ${rounds[0]}` : `Rounds ${rounds.join(' and ')}`} moved no chips: nothing to settle on chain.`);
      return;
    }
    c.entries.push({ seq: c.nextSeq, rounds, lines, tx: null, at: Date.now() });
    c.nextSeq += 1;
  }

  /**
   * Runs after every change to a table. Takes each finished round into an entry for the judge, then sets the stacks for
   * the next deal. A round only finishes through the settled or over phase, and the engine waits at least roundGapMs
   * before it deals from settled, so this always sees the stacks before the next round touches them.
   */
  function cageAfterChange(s) {
    const c = s.cage;
    if (!c || c.status !== 'open' || c.broken) return;
    c.foldAt = foldTime(s); // kept fresh here, because this runs on every change
    if (inRound(s) && c.dealtRound !== s.round) { c.dealtRound = s.round; c.dealtAt = Date.now(); c.dealWaiting = false; } // when the round in play was dealt: the judge keeps its table alive long enough
    if (s.phase !== 'settled' && s.phase !== 'over') return;
    if (s.round > c.recorded) {
      c.window.push(s.round);
      c.recorded = s.round;
    }
    // Whoever is going, for good, can't wait on a carried pot: a debit needs a credit in the same entry, and with nothing to settle the seat can't free. Their last round
    // ends with an entry whatever the pot does, so the pot goes back to the seats still here, as it does when the last player leaves. Nobody's stack is short by more than what they put in.
    if (s.pot > 0 && s.seats.some((x) => !x.left) && Object.values(c.holders).some((h) => mustLand(s, h))) {
      addLog(s, 'Someone is leaving with a carried pot on the table: it can\'t wait for them, so it goes back now.');
      returnPot(s);
    }
    if (s.pot === 0) {
      const net = Object.values(c.holders).reduce((sum, h) => sum + h.seats.reduce((n, seat) => n + stackOf(s.seats[seat]) - c.base[seat], 0), 0);
      const moved = Object.values(c.holders).some((h) => h.seats.some((seat) => stackOf(s.seats[seat]) !== c.base[seat]));
      if (net !== 0) {
        // Conservation failed, which the rules don't allow. The contract would refuse this entry, so nothing is reported.
        c.broken = `round ${s.round}: stacks moved by ${net} chips with an empty pot. Not reported to the judge.`;
        addLog(s, 'This table has stopped reporting rounds: the chip count is off. Your cage balance is unchanged.');
        return;
      }
      if (c.window.length > 0 || moved) cutEntry(s);
    }
    c.foldAt = foldTime(s); // a line that has just been cut ends that stand's claim on the clock
    if (s.phase === 'settled') for (const id of Object.keys(c.holders)) clampHolder(s, id);
  }

  /** Standing on chain, or moving to another table, and gone from this one, with chips still to settle. */
  function mustLand(s, h) {
    if (h.kind !== 'player' || (h.standUntil == null && !h.moving)) return false;
    return h.seats.every((seat) => s.seats[seat].left) && h.seats.some((seat) => stackOf(s.seats[seat]) !== s.cage.base[seat]);
  }

  /** The soonest a round in play must be over: the first stand to run out, or the table going quiet. Null with neither. */
  function foldTime(s) {
    const c = s.cage;
    // Only someone still in the round, or gone with a line still to come. Once their line exists, the others' rounds are no business of their clock.
    const stands = Object.values(c.holders).filter((h) => h.standUntil != null && !h.released && h.seats.some((seat) => !s.seats[seat].left || stackOf(s.seats[seat]) !== c.base[seat])).map((h) => h.standUntil);
    const until = [...stands, ...(c.tableUntil ? [c.tableUntil] : [])];
    return until.length ? (Math.min(...until) - FOLD_BEFORE_SECS) * 1000 : null;
  }

  /** A deal that can't be given the time it needs. The judge sees dealWaiting, sends a settle of nothing, and the clock it posts back lets the deal through. */
  function cageDealBlocked(s, now) {
    const c = s.cage;
    if (!c?.tableUntil) return false;
    const blocked = now / 1000 + MIN_ROUND_SECS > c.tableUntil;
    c.dealWaiting = blocked;
    return blocked;
  }

  /**
   * Past the time a round may run: the clocks of everyone still to move run out now, so the round ends and its lines exist. Those seats play their automatic moves, and
   * an honest player is back for the next round. Only a table within minutes of a deadline gets here: a stand back-dated by the slack, or a judge that has gone quiet.
   */
  function cageForceRoundEnd(s, ctx) {
    const c = s.cage;
    if (c) c.foldAt = foldTime(s);
    if (!c?.foldAt || ctx.now < c.foldAt || !inRound(s)) return false;
    const round = s.round;
    const wereAway = new Set(s.seats.map((x, i) => (x.away ? i : null)).filter((i) => i !== null));
    const standing = new Set(Object.values(c.holders).filter((h) => h.standUntil != null).flatMap((h) => h.seats));
    addLog(s, 'A stand or the table is running out of time on chain, so this round ends now: the clock runs out on everyone still to move.');
    for (let guard = 0; guard < 500 && inRound(s) && s.round === round; guard += 1) {
      s.deadline = ctx.now;
      tick(s, ctx);
    }
    s.seats.forEach((x, i) => { if (!x.bot && !wereAway.has(i) && !standing.has(i)) { x.away = false; x.awaySince = null; } });
    return true;
  }

  /** Starts the deal clock, or deals. A lobby needs two seats and someone who isn't the house. */
  function cageMaybeStart(s, ctx) {
    const c = s.cage;
    if (!c || c.status !== 'open' || s.phase !== 'lobby') return;
    const ready = s.seats.length >= 2 && s.seats.some((x) => !x.bot);
    const housePending = c.wantBots > 0 && !c.house;
    if (!ready || housePending) {
      c.startAt = null;
      return;
    }
    c.startAt ??= ctx.now + c.lobbyMs;
    if (ctx.now >= c.startAt || s.seats.length >= s.cfg.seats) {
      if (cageDealBlocked(s, ctx.now)) return; // the judge sees dealWaiting and sends a settle of nothing: the next clock lets this through
      c.startAt = null;
      startRound(s, ctx);
      if (c.timings) c.timings.dealtAt = ctx.now;
    }
  }

  function addHolder(c, id, kind, name, { atRiskStar, balanceStar, epoch }) {
    const atRisk = wholeChips(atRiskStar);
    const balance = wholeChips(balanceStar);
    c.holders[id] = { kind, name, seats: [], atRisk, balance, behind: 0, epoch, released: false };
    return c.holders[id];
  }

  function placeSeat(c, id, seat, chips, s) {
    c.holders[id].seats.push(seat);
    c.seatOwner[seat] = id;
    c.base[seat] = chips;
    s.seats[seat].chips = chips;
  }

  /** The engine's join, without its lobby clock or its deal: cageMaybeStart decides when this table starts. */
  function seatInLobby(s, claim, chips, ctx) {
    const seatsCfg = s.cfg.seats;
    if (s.seats.length >= seatsCfg) throw new Error('This table is full.');
    s.cfg.seats = seatsCfg + 1;
    try {
      return join(s, claim.name, ctx, { kind: claim.kind, avatar: claim.avatar, chips });
    } finally {
      s.cfg.seats = seatsCfg;
      s.deadline = null;
    }
  }

  /** The judge has checked a claim against the cage. Seats the player if the cage agrees, and marks the claim either way. */
  function cageSeatVerified(s, cageId, result, ctx) {
    const c = s.cage;
    const claim = c.claims[cageId];
    if (!claim) return { error: 'no_claim' };
    if (claim.status !== 'pending') return { seat: claim.seat ?? null, status: claim.status };
    if (!result.ok) {
      claim.status = 'refused';
      claim.reason = result.reason ?? 'The judge could not match this seat to the cage.';
      claim.code = result.code ?? null; // need_grant: one new approval. judge_no_dust: the player can sit for themselves
      return { status: 'refused', code: claim.code };
    }
    const chips = Math.min(wholeChips(result.atRiskStar), wholeChips(result.balanceStar));
    const refuse = (reason, proven) => {
      claim.status = 'refused';
      claim.reason = reason;
      claim.proven = proven; // their on-chain seat is real, so the judge should free it
      return { status: 'refused' };
    };
    if (chips < s.cfg.ante) return refuse(`The seat on chain is under this table's ante of ${s.cfg.ante} chips.`, true);
    if (s.phase !== 'lobby') return refuse('The table started before your seat was confirmed. The judge will free it.', true);
    let seat;
    try {
      seat = seatInLobby(s, claim, chips, ctx);
    } catch (err) {
      return refuse(err.message, true);
    }
    const holder = addHolder(c, cageId, 'player', claim.name, result);
    placeSeat(c, cageId, seat, chips, s);
    holder.behind = holder.balance - chips;
    claim.status = 'seated';
    claim.seat = seat;
    // Where the chain's round count stood: this table's rounds settle in order from here, so they can be numbered before they're dealt.
    if (result.lastRound !== undefined) c.chainBase = Number(result.lastRound);
    c.timings = { approvedAt: claim.approvedAt ?? null, claimedAt: claim.at ?? null, seatedAt: ctx.now, dealtAt: null };
    addLog(s, `${claim.name} is confirmed in the cage: ${chips} chips on the table, ${holder.atRisk} tNIGHT at risk.`);
    if (claim.seatedBy) addLog(s, `${claim.name} was ${claim.seatedBy.kind === 'move' ? 'moved here' : 'seated'} by the judge under their permit${claim.seatedBy.from ? `, from table ${claim.seatedBy.from}` : ''}. Tx ${claim.seatedBy.tx.hash} in block ${claim.seatedBy.tx.block}.`);
    return { seat, status: 'seated' };
  }

  /** The judge has put the house float on chain: the table's bots play from it, one line between them. */
  function cageHouseSeated(s, cageId, result) {
    const c = s.cage;
    if (c.house) return { ok: true, already: true };
    if (s.phase !== 'lobby') return { error: 'table_started' };
    const want = Math.min(c.wantBots, s.cfg.seats - s.seats.length);
    if (want < 1) return { error: 'table_full' };
    if (Math.floor(Math.min(wholeChips(result.atRiskStar), wholeChips(result.balanceStar)) / want) < s.cfg.ante) return { error: 'float_too_small' };
    const holder = addHolder(c, cageId, 'house', 'House', result);
    c.house = { cageId };
    const seatsCfg = s.cfg.seats;
    const first = s.seats.length;
    s.cfg.seats = first + want;
    fillBots(s);
    s.cfg.seats = seatsCfg;
    const stake = Math.min(holder.atRisk, holder.balance);
    const each = Math.floor(stake / want);
    for (let seat = first; seat < first + want; seat += 1) placeSeat(c, cageId, seat, each, s);
    holder.behind = holder.balance - each * want;
    addLog(s, `The house float is in the cage: its bots bring ${each} chips each, ${holder.atRisk} tNIGHT at risk between them.`);
    return { ok: true };
  }

  /** The chain says this table's seats no longer bind. Nothing more can settle, and every balance is free to withdraw. */
  function cageDead(s, reason) {
    const c = s.cage;
    if (c.status === 'dead') return;
    c.status = 'dead';
    c.deadReason = reason;
    // Anyone still waiting for a seat here hears so, or their page would wait for ever: nobody asks about a dead table again.
    for (const claim of Object.values(c.claims)) if (claim.status === 'pending') Object.assign(claim, { status: 'refused', code: 'table_closed', reason: 'That table closed before your seat was ready. Your money is as the cage shows: pick another table.' });
    for (const e of c.entries) if (!e.tx) e.void = true;
    s.pot = 0;
    s.phase = 'over';
    s.overReason = reason;
    s.overCode = 'cage_dead';
    s.overRound = s.round;
    s.overAt = Date.now();
    s.deadline = null;
    addLog(s, `Table over: ${reason} Rounds not yet settled don't count. Cage balances stay as the chain has them.`);
  }

  const entryNames = (e, id) => e.lines.some((l) => l.id === id);

  /** Holders who are finished here on chain's side: left, or refused, with nothing left to settle that names them. */
  function releasesDue(s) {
    const c = s.cage;
    const open = c.entries.filter((e) => !e.tx && !e.void);
    const tableDone = s.phase === 'over';
    const out = [];
    for (const [id, h] of Object.entries(c.holders)) {
      if (h.released) continue;
      const gone = h.seats.every((seat) => s.seats[seat].left) || tableDone;
      if (!gone) continue;
      if (h.seats.some((seat) => stackOf(s.seats[seat]) !== c.base[seat])) continue; // they have a line still to come
      if (open.some((e) => entryNames(e, id))) continue;
      out.push({ cageId: id, kind: h.kind });
    }
    for (const [id, claim] of Object.entries(c.claims)) {
      if (claim.status === 'refused' && claim.proven && !claim.released) out.push({ cageId: id, kind: 'player', refused: true });
    }
    return out;
  }

  /** Everything the judge needs for one table. Only public data, plus the signatures it has to check. */
  function cageWork(s, tableId) {
    const c = s.cage;
    return {
      id: tableId,
      game,
      cageTable: c.table,
      phase: s.phase,
      status: c.status,
      live: inRound(s),
      over: s.phase === 'over',
      // Only once a player has shown up: a float on chain dies in 30 minutes with no settle, and a quiet table costs nothing this way.
      // A warm table has it there before anyone comes, and the judge keeps that seat alive.
      wantHouse: c.wantBots > 0 && !c.house && s.phase === 'lobby' && c.status === 'open' && (c.warm || Object.values(c.claims).some((x) => x.status === 'pending' || x.status === 'seated')),
      warm: !!c.warm,
      claims: Object.entries(c.claims).filter(([, x]) => x.status === 'pending').map(([cageId, x]) => ({ cageId, at: x.at, door: !!x.door, ...(x.ask ? { ask: x.ask } : {}), message: x.message, verifyingKey: x.verifyingKey, signature: x.signature })),
      holders: Object.entries(c.holders).map(([cageId, h]) => ({ cageId, kind: h.kind, left: h.seats.every((seat) => s.seats[seat].left), epoch: h.epoch, atRisk: h.atRisk, balance: h.balance, released: h.released, ...(h.freed ? { freed: true } : {}), ...(h.standUntil != null ? { standUntil: h.standUntil } : {}) })),
      dealtAt: inRound(s) ? c.dealtAt ?? null : null,
      dealWaiting: !!c.dealWaiting,
      tableUntil: c.tableUntil ?? null,
      entries: c.entries.filter((e) => !e.tx && !e.void).map(({ seq, rounds, lines, at }) => ({ seq, rounds, lines, at })),
      releases: c.status === 'open' ? releasesDue(s) : [], // a dead table's seats are void: withdraw clears them
      // Players on their way out (left, or leaving after this round), not yet released: the judge frees them before any float or seat work (11-06, round 2).
      leaving: Object.entries(c.holders).filter(([, h]) => h.kind !== 'house' && !h.released && h.seats.some((seat) => s.seats[seat].left || s.seats[seat].leaving)).map(([cageId]) => cageId),
      house: c.house?.cageId ?? null,
      wantBots: c.wantBots,
      ante: s.cfg.ante,
      lastChainRound: c.receipts.reduce((most, r) => Math.max(most, r.chainRound ?? 0), 0),
      alert: c.broken ?? c.alert,
      done: s.phase === 'over' && (c.status === 'dead' || (c.entries.every((e) => e.tx) && releasesDue(s).length === 0)),
    };
  }

  /** Star amounts from the judge, as chips, one number per player. */
  const landedDeltas = (lines) => new Map(lines.map((l) => [l.id, wholeChips(l.credit ?? 0) - wholeChips(l.debit ?? 0)]));

  /**
   * What actually landed differs from what was reported, because a line was dropped (a stand that ran out, or a seat that has gone) and the others were shaved to balance.
   * The chain is the bank, so its numbers win: the holder's balance, atRisk and stack follow what landed, and the table's next rounds are played from them.
   */
  function correctHolders(s, reported, landed) {
    const c = s.cage;
    for (const [id, was] of reported) {
      const holder = c.holders[id];
      if (!holder) continue;
      const now = landed.get(id) ?? 0;
      if (now === was) continue;
      holder.balance += now - was;
      holder.atRisk += Math.max(0, -was) - Math.max(0, -now);
      // Less won than was shown: it comes from behind the seat first, then the stack. More: it goes behind the seat, and clampHolder brings it on between rounds.
      let take = was - now;
      if (take < 0) { holder.behind -= take; continue; }
      const off = Math.min(take, holder.behind);
      holder.behind -= off;
      take -= off;
      for (const seat of holder.seats) {
        if (take <= 0) break;
        const x = s.seats[seat];
        const cut = Math.min(take, x.left ? x.leftWith ?? 0 : x.chips);
        if (x.left) x.leftWith -= cut; else x.chips -= cut;
        c.base[seat] -= cut;
        take -= cut;
      }
    }
  }

  /** The judge's receipt for entries it has landed. Safe to repeat; a different tx for a settled entry is refused. `lines` and `dropped` come when what landed isn't what was reported. */
  function cageSettled(s, seqs, tx, { dropped = null, lines = null } = {}) {
    const c = s.cage;
    const conflicts = [];
    const fresh = [];
    for (const seq of seqs) {
      const e = c.entries.find((x) => x.seq === seq);
      if (!e) {
        conflicts.push(seq);
        continue;
      }
      if (e.tx) {
        if (e.tx.hash !== tx.hash) conflicts.push(seq);
        continue;
      }
      fresh.push(e);
    }
    const reported = new Map();
    for (const e of fresh) for (const l of e.lines) reported.set(l.id, (reported.get(l.id) ?? 0) + l.delta);
    const landed = lines ? landedDeltas(lines) : reported;
    const named = new Set([...landed.keys(), ...(dropped ?? []).map((d) => d.id)]);
    if (lines && fresh.length) correctHolders(s, reported, landed);
    // Entries merged for a standing seat landed as one: they get one receipt, with the numbers that landed.
    const shown = lines && fresh.length ? [...landed].filter(([, delta]) => delta !== 0).map(([id, delta]) => ({ id, delta })) : null;
    const whoName = (id) => c.holders[id]?.name ?? 'seat';
    fresh.forEach((e, i) => {
      e.tx = tx;
      delete e.void;
      if (shown) {
        e.reported = e.lines;
        e.lines = i === 0 ? shown : [];
        if (dropped?.length) e.dropped = dropped;
      }
      if (shown && i > 0) return;
      const rounds = shown ? fresh.flatMap((x) => x.rounds) : e.rounds;
      const label = rounds.length === 1 ? `Round ${rounds[0]}` : rounds.length === 0 ? 'The table' : `Rounds ${rounds.join(' and ')}`;
      const moved = e.lines.length ? e.lines.map((l) => `${whoName(l.id)} ${l.delta > 0 ? '+' : ''}${l.delta}`).join(', ') : 'no chips moved';
      addLog(s, `${label} settled on chain: ${moved}. Tx ${tx.hash} in block ${tx.block}.`, { receipt: true });
      if (dropped?.length) addLog(s, `${dropped.map((d) => `${whoName(d.id)}'s line of ${d.delta > 0 ? '+' : ''}${d.delta}`).join(' and ')} couldn't land: that seat had already gone on chain. The rest settled, shaved to add up.`);
      c.receipts.push({ rounds, lines: e.lines, ...(dropped?.length ? { dropped } : {}), hash: tx.hash, block: tx.block, chainRound: tx.chainRound, status: tx.status, at: tx.at ?? Date.now(), endedAt: e.at ?? null, blockAt: tx.blockAt ?? null });
      if (c.receipts.length > MAX_RECEIPTS) c.receipts.shift();
    });
    // A settle naming a standing seat frees it. Any line for them after this can't land, even if they sit back down here: the judge is told.
    if (fresh.length) for (const id of named) if (c.holders[id]?.standUntil != null) c.holders[id].freed = true;
    return { conflicts };
  }

  /** The judge can't settle this table. Said once in the log per different reason: the 30-minute escape is the backstop. */
  function cageAlert(s, message) {
    const c = s.cage;
    const text = String(message ?? '').slice(0, 300);
    if (c.alert === text) return;
    c.alert = text;
    if (text) addLog(s, `The judge can't settle this table right now. Rounds since the last receipt aren't on chain yet: ${text}`);
  }

  function cageReleased(s, cageId, tx = null) {
    const c = s.cage;
    if (tx?.hash && !(c.seatReceipts ??= []).some((r) => r.hash === tx.hash)) c.seatReceipts.push({ cageId, kind: 'release', hash: tx.hash, id: tx.id ?? null, block: tx.block ?? null, status: tx.status ?? null, ms: tx.ms ?? null, at: tx.at ?? Date.now() });
    if (c.holders[cageId]) c.holders[cageId].released = true;
    if (c.claims[cageId]) c.claims[cageId].released = true;
  }

  /** They called stand on chain: this is their last round here, and it has to be over before their stand runs out. */
  function cageStanding(s, cageId, standUntil, ctx) {
    const c = s.cage;
    const holder = c.holders[cageId];
    if (!holder) return;
    const until = Number(standUntil);
    if (Number.isFinite(until) && until > 0) holder.standUntil = until;
    c.foldAt = foldTime(s);
    cageForceRoundEnd(s, ctx);
  }

  /** The judge's reading of when this table goes quiet. A settle moves it, and that may let a held deal through. */
  function cageClock(s, tableUntil, ctx) {
    const c = s.cage;
    const until = Number(tableUntil);
    if (!Number.isFinite(until) || until <= 0) return;
    c.tableUntil = until;
    c.foldAt = foldTime(s);
    if (c.dealWaiting && !cageDealBlocked(s, ctx.now) && s.phase === 'settled' && s.deadline === null) s.deadline = ctx.now;
    cageForceRoundEnd(s, ctx);
  }

  /** The judge has landed a seat or a move under this player's permit: the receipt, on the table that took them. */
  function cageSeated(s, cageId, { kind, from = null, until = null, tx }) {
    const c = s.cage;
    const claim = c.claims[cageId];
    const row = { cageId, kind: kind === 'move' ? 'move' : 'seat', from, until, hash: tx?.hash ?? null, id: tx?.id ?? null, block: tx?.block ?? null, status: tx?.status ?? null, ms: tx?.ms ?? null, at: tx?.at ?? Date.now() };
    if (claim) claim.seatedBy = { kind: row.kind, from, until, ms: row.ms, tx: { hash: row.hash, block: row.block } };
    if (!(c.seatReceipts ??= []).some((r) => r.hash === row.hash)) c.seatReceipts.push(row);
    if (c.seatReceipts.length > MAX_SEAT_RECEIPTS) c.seatReceipts.shift();
  }

  /** The Hop: this seat's holder is going straight to another table. Nothing here changes but what a carried pot does: see mustLand. */
  function cageMoving(s, seat) {
    const id = s.cage.seatOwner[seat];
    if (id && s.cage.holders[id]) s.cage.holders[id].moving = true;
  }

  /** What anyone may see of the cage at this table. It's all on chain anyway, apart from the claim's waiting state. */
  function cageView(s, tableId) {
    const c = s.cage;
    return {
      mode: 'tnight',
      unit: '1 chip = 1 tNIGHT',
      address: c.address,
      table: c.table,
      status: c.status,
      deadReason: c.deadReason ?? null,
      seatMessage: seatMessage(c, tableId, '<cageId>'),
      waiting: Object.values(c.claims).filter((x) => x.status === 'pending').map((x) => x.name),
      waitingSince: Object.values(c.claims).filter((x) => x.status === 'pending').reduce((first, x) => (first === null || x.at < first ? x.at : first), null), // for a count-up while the judge seats the table
      housePending: c.wantBots > 0 && !c.house,
      warm: !!c.warm,
      chainBase: c.chainBase ?? null,
      timings: c.timings ?? null,
      joinable: cageJoinable(s),
      seats: c.seatOwner.map((id, seat) => (id ? { seat, cageId: id, kind: c.holders[id].kind, atRisk: c.holders[id].atRisk, balance: c.holders[id].balance, behind: c.holders[id].behind } : null)).filter(Boolean),
      unsettled: c.entries.filter((e) => !e.tx && !e.void).map((e) => e.rounds).flat(),
      receipts: c.receipts,
      seatReceipts: c.seatReceipts ?? [],
      alert: c.broken ?? c.alert,
    };
  }

  return { newCage, cageJoinable, claimRefusal, cageAfterChange, cageMaybeStart, cageSeatVerified, cageHouseSeated, cageDead, cageWork, cageSettled, cageAlert, cageReleased, cageView, cageStanding, cageClock, cageSeated, cageMoving, cageForceRoundEnd, cageDealBlocked };
}
