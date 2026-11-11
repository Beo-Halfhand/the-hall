// The Cage's plain helpers: amounts, addresses, and what must never be shown. No wallet and no network here.

export const NETWORK = 'preprod';
/** NIGHT's token type in getUnshieldedBalances. */
export const NIGHT_TOKEN = '0'.repeat(64);
export const STAR_PER_NIGHT = 1_000_000n;
export const SPECK_PER_DUST = 1_000_000_000_000_000n;

function fixed(value, unit, places) {
  const whole = value / unit;
  const part = ((value % unit) * 10n ** BigInt(places)) / unit;
  const decimals = part.toString().padStart(places, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${decimals ? `.${decimals}` : ''}`;
}
export const fmtNight = (star) => fixed(BigInt(star), STAR_PER_NIGHT, 6);
export const fmtDust = (speck) => fixed(BigInt(speck), SPECK_PER_DUST, 3);

/** tNIGHT typed by a person, as STAR. Null unless it's a positive amount with at most 6 decimals. */
export function parseNight(text) {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!m) return null;
  const star = BigInt(m[1]) * STAR_PER_NIGHT + BigInt((m[2] ?? '').padEnd(6, '0'));
  return star > 0n ? star : null;
}

export function parseTable(text) {
  const t = String(text).trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = BigInt(t);
  return n > 0n && n < 2n ** 32n ? n : null;
}

/** A player key is 32 bytes of hex. Null for anything else. */
export function parseKey(text) {
  const k = String(text).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(k) ? k : null;
}

/** Removes secrets from anything about to be shown: Blockfrost project ids, in or out of a URL. */
export function scrub(text) {
  return String(text ?? '')
    .replace(/project_id=[^&\s"'<>)]+/gi, 'project_id=***')
    .replace(/night(preprod|mainnet|preview)[A-Za-z0-9]+/g, 'night$1***');
}

/** Host only, for showing where a service lives. */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return '(not a URL)'; }
}

export const isPreprodAddress = (address) => /^mn_addr_preprod1/.test(String(address));

/** True if a wallet setting names mainnet. Names of other networks are the wallet's business. */
export const namesMainnet = (text) => /(^|[^a-z])mainnet([^a-z]|$)/i.test(String(text ?? ''));

/** A wallet's network id can differ in case: the wallet CLI's connector says PreProd. Nothing else counts as preprod. */
export const isPreprodNetwork = (id) => String(id ?? '').toLowerCase() === NETWORK;

export const LACE_RDNS = 'io.lace.wallet';

/** An icon the page may load: an image data URL, or https, or the wallet's own extension. Anything else gets no image. */
export function iconSrc(icon) {
  const src = String(icon ?? '').trim();
  return /^(data:image\/|https:\/\/|chrome-extension:\/\/|moz-extension:\/\/)/i.test(src) ? src : null;
}

/** A wallet's name for showing as text. Lace calls itself "lace". */
function walletName(raw) {
  const name = String(raw ?? '').trim().slice(0, 40);
  return name ? name[0].toUpperCase() + name.slice(1) : 'Unnamed wallet';
}

/**
 * Every wallet on window.midnight, best choice first: the last one used, then Lace, then the rest by name, and any on a
 * connector this page can't use last. Keys change per load, so a wallet is known by rdns. After an update a tab can hold a
 * stale copy next to the live one, and the newest is injected last, so the last entry for an rdns wins.
 */
export function listWallets(midnight, remembered = null) {
  const byId = new Map();
  let entries = [];
  try { entries = Object.values(midnight ?? {}); } catch { return []; }
  for (const api of entries) {
    try {
      if (!api || typeof api.connect !== 'function') continue;
      const rdns = typeof api.rdns === 'string' && api.rdns ? api.rdns : null;
      const name = walletName(api.name);
      const apiVersion = typeof api.apiVersion === 'string' ? api.apiVersion : null;
      const id = rdns ?? `name:${name}`;
      byId.set(id, { id, rdns, name, icon: iconSrc(api.icon), apiVersion, compatible: /^4\./.test(apiVersion ?? ''), isLace: rdns === LACE_RDNS, is1am: /\b1am\b/i.test(name), api });
    } catch { /* a wallet whose fields throw isn't one we can use */ }
  }
  // 1AM first after the one used last (the 11-08 pass #15: tested end to end here, the fastest), then Lace, then the rest by name
  const rank = (w) => (!w.compatible ? 4 : w.id === remembered ? 0 : w.is1am ? 1 : w.isLace ? 2 : 3);
  return [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export const findWallet = (midnight, id) => listWallets(midnight).find((w) => w.id === id) ?? null;

/**
 * True when a wallet has lost its link to this page, and only a new connect() brings it back. Disconnected is the
 * connector's code. The phrases come from 1AM and from extensions that restart, and getConnectionStatus can still say connected.
 */
export function isSessionLost(error) {
  if (error?.code === 'Disconnected') return true;
  const text = String(error?.reason ?? error?.message ?? error ?? '').toLowerCase();
  return /connection expired|please reconnect|wallet was lost|wallet ui disconnected|extension context invalidated|receiving end does not exist/.test(text)
    || isWalletRestarted(error)
    || (text.includes('disconnected') && /reconnect|connection/.test(text));
}

/**
 * The wallet's background restarted under this page (11-09, Lace on staging: "Remote API with channel 'feature-flags' was shutdown:
 * object can no longer be used"). The connector this page holds is dead for good; a fresh connect() gives a live one.
 */
export function isWalletRestarted(error) {
  const text = String(error?.reason ?? error?.message ?? error ?? '').toLowerCase();
  return /was shut ?down|has been shut ?down|can no longer be used|message port closed|port (is )?closed|object has been destroyed/.test(text);
}

/**
 * Rejects if a wallet hasn't answered in time. A wallet whose background has gone, as after turning the extension off and
 * on, can simply never answer. Whatever it's still doing carries on.
 */
export function withinTime(answer, ms, message) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { noAnswer: true })), ms);
  });
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

export function blockfrostUrls(projectId) {
  const id = encodeURIComponent(String(projectId).trim());
  return {
    http: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${id}`,
    ws: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${id}`,
  };
}

/** Why a seat holds the balance. now and heartbeat are in seconds. */
export function seatView({ seat, table, escapeSecs, now }) {
  if (!seat) return { seated: false, text: 'Not seated.', freeAt: null };
  const current = table && seat.epoch === table.epoch;
  const quietAt = table ? Number(table.heartbeat) + Number(escapeSecs) : 0;
  if (!current || !table.seated || now >= quietAt) return { seated: false, text: `Table ${seat.table} went quiet. Your seat no longer holds your balance.`, freeAt: null };
  // A stand runs out by itself: after that the seat holds nothing, whatever the table is doing.
  const standEnds = seat.standing && seat.standAt ? Number(seat.standAt) + Number(escapeSecs) : null;
  if (standEnds !== null && now >= standEnds) return { seated: false, text: `Your stand from table ${seat.table} has run out. Your seat no longer holds your balance.`, freeAt: null };
  return {
    seated: true,
    standing: seat.standing,
    text: `Table ${seat.table}, ${fmtNight(seat.atRisk)} tNIGHT at risk${seat.standing ? ', standing' : ''}.`,
    freeAt: standEnds !== null && standEnds < quietAt ? standEnds : quietAt,
  };
}

// ---------- the permit: what the judge may do without asking ----------

const PERMIT_MARGIN_SECS = 90; // a seat takes a transaction to land, so a permit this close to its end can't be used
export const PERMIT_SECS = 12 * 60 * 60; // the door's 12 hours
export const NO_PERMIT = { good: false, why: 'none', cap: 0n, floor: 0n, until: 0n, room: 0n };

// L1: cage v4b refuses a permit (cap above 0) whose until is more than maxGrant past the block's clock, before anything is sent.
export const MAX_GRANT_SECS = 30 * 24 * 60 * 60; // 2,592,000 s: the maxGrant cage v4b is deployed with
export const GRANT_MARGIN_SECS = 60 * 60; // so a page clock up to an hour ahead of the chain's still makes a grant the cage takes

/**
 * The until a deposit's permit carries, in whole seconds: the door session's end while more than an hour of it is left, else
 * now plus the door's 12 hours, and never past now + 30 days − 1 hour. The door runs at most a day (MAX_DOOR_SECS), so the
 * clamp only bites on a door expiry in milliseconds, or a longer door: either would make a grant the cage refuses.
 */
export function permitUntil(doorEnds, now) {
  const at = Math.floor(Number(now));
  const door = Math.floor(Number(doorEnds));
  const want = Number.isFinite(door) && door > at + 3600 ? door : at + PERMIT_SECS;
  return BigInt(Math.min(want, at + MAX_GRANT_SECS - GRANT_MARGIN_SECS));
}

/** "A permit runs at most 30 days.", from the cage's own maxGrant, read with the permit; nothing for a cage that has none. */
export function grantLimitText(maxGrant) {
  const s = maxGrant === null || maxGrant === undefined ? NaN : Number(maxGrant);
  if (!Number.isSafeInteger(s) || s <= 0) return '';
  const [n, unit] = s % 86_400 === 0 ? [s / 86_400, 'day'] : s % 3600 === 0 ? [s / 3600, 'hour'] : s % 60 === 0 ? [s / 60, 'minute'] : [s, 'second'];
  return `A permit runs at most ${n.toLocaleString('en-US')} ${unit}${n === 1 ? '' : 's'}.`;
}

const lower = (a, b) => (a < b ? a : b);

/**
 * Whether the judge can seat this player, and how much it can place. It can never place what a loss would take below the floor, or more than the cap,
 * so `room` is the most at risk at any one seat without asking the player again.
 */
export function permitState({ permit = null, judge = null, balance = 0n }, now) {
  if (!permit) return NO_PERMIT;
  const cap = BigInt(permit.cap);
  const floor = BigInt(permit.floor);
  const until = BigInt(permit.until);
  const base = { cap, floor, until };
  const rotated = permit.ok === false || (judge && permit.judge && permit.judge !== judge);
  if (rotated) return { ...base, good: false, why: 'rotated', room: 0n };
  if (until <= BigInt(now) + BigInt(PERMIT_MARGIN_SECS)) return { ...base, good: false, why: 'expired', room: 0n };
  const above = BigInt(balance) > floor ? BigInt(balance) - floor : 0n;
  return { ...base, good: true, why: null, room: lower(cap, above) };
}

export const hexBytes = (hex) => Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

// ---------- buying in: tiles, the plan they make, and how long it takes ----------

export const WHOLE_CHIP = STAR_PER_NIGHT; // one chip is one tNIGHT
export const TILES = [25n, 50n, 100n, 250n].map((n) => n * STAR_PER_NIGHT);

/** About how many hands an amount lasts at an ante, counting a hand as two antes: a fold costs one, a called claim more. */
export function handsFor(star, ante) {
  const perHand = BigInt(ante ?? 0) * STAR_PER_NIGHT * 2n;
  return perHand > 0n ? Number(BigInt(star) / perHand) : 0;
}

export const GRANT_MIN = STAR_PER_NIGHT; // a deposit has to move something: renewing a permit with nothing to add brings one tNIGHT

/**
 * What one buy-in takes from where the player is now, as the moves in order. With no table it is the Hall's door: the money
 * goes in and nobody sits. `why` says what stops it, or is null.
 *
 * With a good permit that covers the amount, the judge seats the player: nothing to approve. Any deposit carries a new permit, whose cap is what this buy-in
 * puts at risk, so one approval both brings the money and lets the judge play it. A deposit is refused while a seat binds, so a top-up at a held seat frees it first:
 * the table's own Leave when this browser has the seat, with nothing to approve, and otherwise a stand. A stand ends the permit, so it needs a new one.
 */
/** What a player reads while the drain switch is on (TNIGHT_DRAIN): nothing new comes in, and everything already in comes out as usual. */
export const DRAIN_TEXT = 'The Hall isn’t taking new tNIGHT seats just now, so there is nothing to approve. Standing, cashing out and the rounds already in play go on as usual.';

export function buyPlan({ amount, dustReady = true, wallet = 'your wallet', cage = 0n, night = null, ante = 1, potLimit = null, signed = false, table = null, seated = false, standing = false, brought = false, topup = false, canSit = true, permit = NO_PERMIT, bound = false, canLeave = false, selfSit = false, draining = false }) {
  const moves = [];
  const atTable = table !== null;
  const heldHere = atTable && seated;
  let live = permit?.good ? permit : NO_PERMIT;
  if (heldHere && topup) { // a bigger seat: free this one, then money and a new seat
    if (canLeave) moves.push({ kind: 'leave' });
    else {
      if (!standing) moves.push({ kind: 'stand' });
      live = NO_PERMIT;
    }
    moves.push({ kind: 'free' });
  }
  const short = atTable ? (amount > cage ? amount - cage : 0n) : brought ? 0n : amount;
  const newSeat = atTable && (!seated || topup) && canSit;
  // What the judge could place with what's on chain now. A win or a top-up since the grant can sit above what this permit lets it place.
  const covers = !selfSit && live.good && short === 0n && amount <= live.room;
  let deposit = short;
  let grant = false;
  if (newSeat && !covers && short === 0n && !selfSit) {
    if (night === null || night >= GRANT_MIN) { deposit = GRANT_MIN; grant = true; } // the same approval as a deposit, moving one tNIGHT, for a new permit
  }
  const judgeSeats = newSeat && !selfSit && (covers || deposit > 0n);
  const after = cage + deposit;
  const cap = !atTable ? after : amount; // at the door, the whole stack can play. At a table, what this seat puts at risk: that much can be lost, wins aside
  if (deposit > 0n) moves.push({ kind: 'deposit', amount: deposit, cap, ...(grant ? { grant: true } : {}) });
  if (!signed) moves.push({ kind: 'sign' });
  if (newSeat && !judgeSeats) moves.push({ kind: 'sit', amount });
  if (atTable && canSit) moves.push({ kind: 'judge', ...(judgeSeats ? { seats: true } : {}) });
  let why = null;
  if (draining) why = DRAIN_TEXT; // checked before the wallet is asked anything: a deposit now would only have to come out again
  else if (amount <= 0n) why = 'Pick an amount.';
  else if (atTable && amount < BigInt(ante) * STAR_PER_NIGHT) why = `This table’s ante is ${ante}, so bring at least ${ante} tNIGHT.`;
  else if (atTable && potLimit != null && amount > BigInt(potLimit) * STAR_PER_NIGHT) why = `At most ${potLimit} tNIGHT can be at risk in one seat at this table.`;
  else if (deposit > 0n && bound && !(heldHere && topup)) why = 'The cage takes no deposit while a seat holds your balance. Leave the table, and the judge frees the seat at its next settle.';
  else if (night != null && deposit > night) why = `Your wallet holds ${fmtNight(night)} tNIGHT${atTable && cage > 0n ? ` and the cage ${fmtNight(cage)}` : ''}: not enough for ${fmtNight(amount)}.`;
  const approvals = moves.filter((m) => APPROVED.has(m.kind)).length;
  if (!why && !dustReady && approvals > 0) why = noDustText(wallet); // a deposit or a sit needs the network fee; a seat from the cage doesn't
  return { amount, deposit, grant, judgeSeats, cap, moves, approvals, signature: moves.some((m) => m.kind === 'sign'), why, noDust: !dustReady && approvals > 0 };
}

/** What a wallet with tNIGHT but no DUST reads (the 11-08 pass #3): it can't pay a network fee yet, and how to fix that. */
export const noDustText = (wallet = 'your wallet') => `Your wallet has no DUST yet, so it can’t pay the network fee. In ${wallet}: DUST → register your tNIGHT (one signature), wait a few minutes, then Refresh.`;

const APPROVED = new Set(['deposit', 'sit', 'stand', 'withdraw', 'revoke']);

/** Cash out: stand if a seat holds the balance, wait for the judge to free it, then withdraw everything to the wallet. */
/**
 * The one line a cash-out ends with (11-09): what this browser saw brought to the cage since it was last empty, against what goes back and what stays.
 * All in STAR. "You brought 50, you're leaving with 22: down 28 this session."
 */
export function sessionLine(brought, out, left = 0n) {
  const net = out + left - brought;
  const word = net === 0n ? 'even' : net > 0n ? `up ${fmtNight(net)}` : `down ${fmtNight(-net)}`;
  return left > 0n
    ? `You brought ${fmtNight(brought)}: ${fmtNight(out)} is back in your wallet and ${fmtNight(left)} stays in the cage, ${word} this session.`
    : `You brought ${fmtNight(brought)}, you’re leaving with ${fmtNight(out)}: ${word} this session.`;
}

export function cashPlan({ balance = 0n, seated = false, standing = false, dustReady = true, wallet = 'your wallet' }) {
  const moves = [];
  if (seated && !standing) moves.push({ kind: 'stand' });
  if (seated) moves.push({ kind: 'free' });
  if (balance > 0n) moves.push({ kind: 'withdraw', amount: balance });
  const approvals = moves.filter((m) => APPROVED.has(m.kind)).length;
  const why = balance <= 0n ? 'Nothing in the cage to cash out.' : !dustReady && approvals > 0 ? noDustText(wallet) : null;
  return { amount: balance, moves, approvals, signature: false, why };
}

/** A stand that failed because the seat moved under it. Anything else is a wallet or a network talking. */
export const seatMovedError = (text) => /seated at another table|not seated|landed but the cage refused/i.test(String(text ?? ''));
export const alreadyStanding = (text) => /already standing/i.test(String(text ?? ''));
/** A revoke refused for this means it was already done: a stand ended it, or it ran out of nothing to end. */
export const alreadyRevoked = (text) => /no permit/i.test(String(text ?? ''));

/** Roughly how long a plan takes, in seconds, from what the chain and the judge took on preprod this week. */
export function roughSeconds(plan, { warm = true } = {}) {
  const per = { deposit: 80, sign: 10, sit: 45, judge: warm ? 60 : 150, stand: 45, free: 60, withdraw: 40, leave: 2, revoke: 45 };
  return plan.moves.reduce((sum, m) => sum + (per[m.kind] ?? 0), 0);
}

export function roughTime(secs) {
  if (secs < 50) return 'under a minute';
  const m = Math.round(secs / 60);
  return m <= 1 ? 'about a minute' : `about ${m} minutes`;
}

// ---------- what each action is called, and what it shows the world ----------

const KEY_PRIVATE = 'your player key, which stays between this browser and your wallet’s prover';
const JUDGE_PRIVATE = 'your player key, which this one never touched';
const HAND = 'and nothing about what you’re dealt was in it';
/** One entry per thing that lands on chain for a player. What's public here is what the contract writes or the transaction carries: see sealed-cage's `disclose` calls. */
export const ACTIONS = {
  deposit: { noun: 'deposit', title: 'Deposit', says: `Public: the amount, your wallet’s address, your player id, and your permit’s cap and end time. Private: ${KEY_PRIVATE}.` },
  sit: { noun: 'seat', title: 'Seat', says: `Public: your player id, the table and the amount at risk. Private: ${KEY_PRIVATE}, ${HAND}.` },
  seat: { noun: 'seat', title: 'Seat', says: `Public: your player id, the table and the amount at risk. Private: ${JUDGE_PRIVATE}, ${HAND}.` },
  move: { noun: 'move', title: 'Move', says: `Public: your player id, both tables and the amount at risk. Private: ${JUDGE_PRIVATE}, ${HAND}.` },
  stand: { noun: 'stand', title: 'Stand', says: `Public: your player id, the table and when you stood, and that your permit ended. Private: ${KEY_PRIVATE}, ${HAND}.` },
  release: { noun: 'release', title: 'Seat freed', says: `Public: your player id and the table you left. Private: ${JUDGE_PRIVATE}, ${HAND}.` },
  withdraw: { noun: 'withdrawal', title: 'Withdrawal', says: `Public: the amount, your wallet’s address and your player id. Private: ${KEY_PRIVATE}.` },
  revoke: { noun: 'revoke', title: 'Revoke', says: `Public: your player id, and that your permit ended. Private: ${KEY_PRIVATE}.` },
  rescue: { noun: 'send-home', title: 'Sent home', says: 'Public: the amount, the player id and the address it went to. Private: the player key, which this one doesn’t need.' },
};

export const EXPLORER_TX = (hash) => `https://preprod.midnightexplorer.com/transactions/${hash}`;

/** "42s", or "2m 05s". */
export function shortTime(ms) {
  const secs = Math.max(1, Math.round(Number(ms) / 1000));
  return secs < 90 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

export const TYPICAL_MIN_SAMPLES = 3;
/** What goes on a result card, in words. `typical` is { ms, n } from the Hall's running median, or null. Too few timings say so: a median of one is not "typical". */
export function resultCard({ action, ms = null, typical = null, hash = null }) {
  const a = ACTIONS[action] ?? { title: 'Transaction', says: '' };
  return {
    action,
    title: a.title,
    head: Number.isFinite(ms) ? `Confirmed in ${shortTime(ms)}` : 'Confirmed',
    typical: typical && typical.n >= TYPICAL_MIN_SAMPLES ? `typical ${shortTime(typical.ms)} for this action` : 'not enough timed yet to say what’s typical for this action',
    says: a.says,
    link: hash ? EXPLORER_TX(hash) : null,
  };
}

/** The first letter up, for a sentence that starts with one of the lines above. */
export const sentence = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** "2 approvals in Lace and one signature", or "nothing to approve". */
export function approvalsText(plan, wallet) {
  const parts = [];
  if (plan.approvals) parts.push(`${plan.approvals} approval${plan.approvals === 1 ? '' : 's'} in ${wallet}`);
  if (plan.signature) parts.push('one signature');
  return parts.length ? parts.join(' and ') : 'nothing to approve';
}

// ---------- what a wallet error means ----------

/** One line that follows a wallet's error down to whatever actually failed: message, cause, reason, code, nested errors. */
export function describeError(err, max = 1500) {
  const reasons = [];
  const seen = new Set();
  const visit = (x, depth) => {
    if (x === undefined || x === null || depth > 6 || seen.has(x)) return;
    if (typeof x !== 'object') { reasons.push(String(x)); return; }
    seen.add(x);
    const start = reasons.length;
    if (typeof x.message === 'string' && x.message && x.message !== '[object Object]') reasons.push(x.message);
    if (typeof x.reason === 'string' && x.reason) reasons.push(x.reason);
    if (x.code !== undefined && x.code !== null && typeof x.code !== 'object') reasons.push(`code ${String(x.code)}`);
    for (const c of [typeof x.message === 'object' ? x.message : undefined, x.cause, x.error, ...(Array.isArray(x.errors) ? x.errors : [])]) if (c !== undefined && c !== null) visit(c, depth + 1);
    if (reasons.length === start) { try { reasons.push(JSON.stringify(x)); } catch { reasons.push(String(x)); } }
  };
  visit(err, 0);
  const text = scrub([...new Set(reasons)].join(': ').replace(/\s+/g, ' ').trim()) || 'no details';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The wallet is silent: the same steps wherever that happens. It is a pop-up, because a wallet that's locked looks just like a page that's stuck. */
export function noAnswerSteps(wallet = 'Your wallet') {
  return {
    kind: 'no-answer',
    title: `${wallet} didn’t answer`,
    what: `This page asked ${wallet} something and heard nothing for 20 seconds. Nothing was sent.`,
    cause: `${wallet} is locked, or its background has stopped (Lace 2.5.0 does this), or its window is waiting behind another.`,
    todo: 'Work through these:',
    steps: [`Open ${wallet} from your browser’s toolbar.`, 'Unlock it, if it asks for your password.', 'Press Try again, below.', 'Still nothing? Press Refresh this page. If even that doesn’t help, turn the extension off and on, then refresh.'],
    raw: 'no answer in 20 seconds',
    retry: true,
    reconnect: false,
  };
}

/**
 * What broke, the likely cause and what to do, in plain words, with the wallet's own words kept underneath. `during` is what
 * the page was asking for ("connect", "approve the deposit"); `sent` says whether the transaction had already left.
 */
export function explainTrouble(err, { wallet = 'Your wallet', during = 'answer', sent = false } = {}) {
  const raw = describeError(err);
  const text = raw.toLowerCase();
  const base = { raw, retry: true, reconnect: false };
  // The cage's own rules, which this page runs before it asks the wallet for anything (compact-runtime's "failed assert: …").
  // First, because the rule's words could match a wallet's below ("insufficient balance" is the cage's, not a fee).
  if (!sent && /failed assert/.test(text)) {
    const grant = /a permit runs at most maxgrant/.test(text);
    return {
      ...base,
      kind: 'cage-refused',
      title: 'The cage refused it',
      what: 'The cage refused it before anything was sent. Nothing was spent.',
      cause: grant ? 'The permit this deposit carried would run longer than the cage allows. This computer’s clock may be ahead.' : `This page runs the cage’s rules before asking ${wallet}, and one of them said no. Its words are below.`,
      todo: grant ? 'Check this computer’s date and time, then Try again.' : 'Refresh to read the cage again, then try once more if it still makes sense.',
    };
  }
  // The node refused the transaction because the wallet spent from a DUST note it had already used (Custom error 170): the wallet was a step behind
  // its own last transaction. Nothing was spent. cage-session waits 20 s and tries once by itself; this is for when that try fails too (11-07).
  if (/custom error: 170/.test(text)) {
    return { ...base, kind: 'stale-dust', title: 'Your wallet was a step behind the chain', what: `${wallet} built the transaction from a DUST note it had already spent, so the chain refused it. Nothing was spent.`, cause: `${wallet} hadn’t caught up with its own last transaction yet.`, todo: 'Wait a few seconds, then Try again.' };
  }
  if (/is locked|wallet locked|unlock|password required|not unlocked/.test(text)) {
    return { ...base, kind: 'locked', title: `${wallet} is locked, or on another account`, what: `${wallet} says it is locked.`, cause: `${wallet} locks itself after a while. It says the same when you switched to another wallet or account in ${wallet} while this page was connected to the first one (pass #12).`, todo: `Open ${wallet} from the toolbar and unlock it, then Try again. Switched wallets or accounts in ${wallet}? Tap Use another wallet and connect again (or remove this site under ${wallet} → Settings → Authorized DApps).` };
  }
  if (err?.noAnswer || /didn’t answer|no answer/.test(text)) {
    return { ...base, ...noAnswerSteps(wallet), what: `This page asked ${wallet} to ${during} and heard nothing for 20 seconds. Nothing was sent.` };
  }
  if (!sent && isWalletRestarted(err)) {
    return { ...base, kind: 'restarted', reconnect: true, title: `${wallet} restarted itself`, what: `${wallet} restarted itself. Click Try again.`, cause: `${wallet}’s background part restarted on its own, and the link this page had to it stopped working. Nothing was sent.`, todo: `Click Try again: the page asks ${wallet} for a fresh link, then does the same step once more.` };
  }
  if (isSessionLost(err)) {
    return sent
      ? { ...base, kind: 'lost-after-send', retry: false, title: `${wallet} dropped this page after sending`, what: `${wallet} lost its link to this tab after the transaction left, so this page won’t send it again.`, cause: `${wallet}’s window closed or its background restarted part way through.`, todo: 'Wait a minute, then Refresh and check your balance. It may well have landed.' }
      : { ...base, kind: 'lost', reconnect: true, title: `${wallet} dropped this page`, what: `${wallet} lost its link to this tab while this page was asking it to ${during}. Nothing was sent.`, cause: `${wallet}’s window closed or its background restarted part way through.`, todo: `Reconnect: approve it in ${wallet}, and the same step runs again.` };
  }
  if (/declin|reject|denied|cancel|refused by user|user refused|not approved|dismissed/.test(text)) {
    return { ...base, kind: 'declined', title: `You said no in ${wallet}`, what: `${wallet} reports that the request to ${during} was declined.`, cause: 'The approval was closed or refused.', todo: `Try again, and approve it in ${wallet} this time.` };
  }
  if (/unsupported network|wrong network|mainnet|network id|networkid/.test(text)) {
    return { ...base, kind: 'network', title: `${wallet} is on another network`, what: `${wallet} refused to ${during} because it isn’t on preprod.`, cause: `${wallet} is set to mainnet or another test network.`, todo: `Set ${wallet} to Preprod, then Try again.` };
  }
  if (/insufficient|not enough|no dust|no tdust|dust|fee/.test(text)) {
    return { ...base, kind: 'funds', title: `${wallet} can’t pay the fee`, what: `${wallet} couldn’t ${during}: it needs tDUST to pay the fee, and tNIGHT to send.`, cause: `Not enough tDUST in ${wallet}, or the tNIGHT is shielded and the cage takes unshielded.`, todo: `Generate tDUST in ${wallet} and let it fill, check the tNIGHT is unshielded, then Try again.` };
  }
  if (/prov|proof|zk|circuit/.test(text)) {
    return { ...base, kind: 'proof', title: 'Proving failed', what: `The proof for this transaction couldn’t be made while asking ${wallet} to ${during}.`, cause: `The proof server ${wallet} uses didn’t answer, or it refused the circuit.`, todo: `Check the proof server in ${wallet}’s settings (a local one on port 6300), then Try again.` };
  }
  if (/not on the indexer|may still land/.test(text)) {
    return { ...base, kind: 'chain', retry: false, title: 'Still waiting on the chain', what: 'The transaction was sent, but no indexer has shown it landing yet.', cause: 'A slow block, or an indexer behind the chain.', todo: 'Wait a minute, then Refresh and check your balance before trying again: it may still land.' };
  }
  if (/landed but the cage refused/.test(text)) {
    return { ...base, kind: 'refused', retry: false, title: 'The cage refused it', what: 'The transaction landed, but the cage’s rules refused it. The fee was spent; your balance didn’t change.', cause: 'The cage saw something different from this page: a seat already taken, a table that moved on, or a balance that changed.', todo: 'Refresh to read the cage again, then try once more if it still makes sense.' };
  }
  return { ...base, kind: 'said-no', title: `${wallet} said no`, what: `${wallet} couldn’t ${during}.`, cause: `${wallet} refused or couldn’t finish the request.`, todo: `Open ${wallet}, check it is unlocked and on Preprod, then Try again. If it keeps failing, refresh this page.` };
}
