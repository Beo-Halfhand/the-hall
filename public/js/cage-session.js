// The cage, shared by every page that talks to a wallet: the cage page, and the table pages that seat a player in place.
// The wallet holds the funds. The player key lives in this browser, and goes to the wallet's prover for each call. It never
// goes into an address, a log or a request from a page.
//
// Here: finding and connecting a wallet, the checks, which indexer reads the cage (the wallet's own, or the Hall's), the
// contract session, one call to the cage in the waiting window, the trouble window, the door's one signature, asking the judge
// for a seat, and the plans a page runs: buy in (a deposit with a permit, sign, the judge seats you), a hop to another table with
// nothing to approve, cash out (stand, wait, withdraw). A page renders what it likes from `state` and gets `on(change)`; this
// module owns no page markup but the window.

import {
  noDustText, ACTIONS, DRAIN_TEXT, NETWORK, NIGHT_TOKEN, NO_PERMIT, PERMIT_SECS, WHOLE_CHIP, alreadyRevoked, alreadyStanding, approvalsText, blockfrostUrls, buyPlan, cashPlan, sessionLine, explainTrouble, findWallet, fmtDust, fmtNight, hexBytes, hostOf,
  isPreprodAddress, isPreprodNetwork, isSessionLost, isWalletRestarted, listWallets, namesMainnet, noAnswerSteps, permitState, permitUntil, resultCard, roughSeconds, roughTime, scrub, seatMovedError, seatView, sentence, withinTime,
} from './wallet-core.js';
import { endInFlight, readInFlight, startInFlight, updateInFlight } from './in-flight.js';
import { ensureLook } from './look.js';

const $ = (id) => document.getElementById(id);
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
export const errorText = (e) => scrub(e?.message || e?.reason || e);
export const nightText = (star) => `${fmtNight(star)} tNIGHT`;
// What this wallet brought to the cage since it was last empty, for the line a cash-out ends with (11-09). This browser only: a deposit made
// elsewhere isn't in it, and then the line is left out rather than guessed.
const broughtKey = () => (state.address ? `cage.brought.${state.address}` : null);
function addBrought(star) {
  const k = broughtKey();
  if (!k) return;
  const was = safe(() => BigInt(localStorage.getItem(k) ?? '0'), 0n) ?? 0n;
  safe(() => localStorage.setItem(k, String(was + star)));
}
const broughtSoFar = () => { const k = broughtKey(); const v = k ? safe(() => localStorage.getItem(k)) : null; return v ? safe(() => BigInt(v), null) : null; };
const clearBrought = () => { const k = broughtKey(); if (k) safe(() => localStorage.removeItem(k)); };

// What a browser remembers about wallets: which one was chosen, and whether to reconnect to it on load.
const CHOICE_KEY = 'cage.wallet';
const AUTO_KEY = 'cage.wallet.auto';
const AUTO_WAIT_MS = 10000;
const ANSWER_MS = 20000;
const NO_WALLET = 'No Midnight wallet here. Install 1AM (the tested wallet) in Chrome, set it to Preprod, then refresh this page. Lace is not yet working here.';
const USES = ['getConnectionStatus', 'getConfiguration', 'getUnshieldedAddress', 'getDustAddress', 'getShieldedAddresses', 'getUnshieldedBalances', 'getDustBalance', 'getProvingProvider', 'balanceUnsealedTransaction', 'submitTransaction'];
export const DOOR_KEY = 'cage.door';
export const WALLET_READ_KEY = 'cage.wallet-read'; // what the wallet last said it holds: { name, night, at }. (cage.wallet is the wallet chosen)
const DOOR_SECS = PERMIT_SECS;
const DOOR_POLL_MS = 1500;
// Cage v4b has no revoke circuit: a revoke is a deposit of 0 with the empty permit, which reads only the caller's permit and moves no money.
// The page still calls it a revoke everywhere a person sees it; this is the one place that knows which circuit it is.
const CIRCUIT_OF = { revoke: 'deposit' };
const REVOKE_ARGS = () => [{ bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n];
const DOOR_WAIT_MS = 90000;
const CLAIM_POLL_MS = 1000;
export const CAGE_POLL_MS = 15000;
/** The table's buy-in max: no tNIGHT seat places more than this (the Worker and the judge hold to it too). */
export const BUY_IN_MAX = 250;
/** The most one seat can take at a table, in whole tNIGHT: the buy-in max, or the table's pot limit if that is lower. */
export const seatMost = (table) => (table?.limits?.potLimit && Number(table.limits.potLimit) < BUY_IN_MAX ? Number(table.limits.potLimit) : BUY_IN_MAX);
export const SEATED_POLL_MS = 5000; // while a seat holds the balance: the judge frees it at its next settle, and the page should notice soon after
const STILL_WAITING_MS = 10000;
/** What a player is told when the cage can't be read: what it means for them, then what to do. The raw error goes underneath, small. */
const CAGE_UNREADABLE = 'We can’t reach the table’s vault right now; your tNIGHT is safe in your wallet. Try Refresh in a minute.';
const OUR_INDEXER = { http: `${location.origin}/indexer/graphql`, ws: `${location.origin.replace(/^http/, 'ws')}/indexer/ws`, from: 'the Hall’s own' };
export const claimKey = (id) => `cage.claim.${id}`;
export const seatKey = (id) => `hall.seat.${id}`; // the table page's own key: see common.js

export const state = {
  api: null, wallet: null, address: null, cage: null, session: null, indexer: null, indexerTried: null,
  view: null, seat: null, busy: false, running: false, stopped: false, stopMessage: '', night: null, dust: null, attempt: 0, autoTried: false,
  pickerSeen: null, lost: false, retry: null, pendingId: null, retryId: null, reconnects: 0, approvedAt: null, connectStatus: '', retryOffered: false, readError: '', readDetail: '', fellBack: false, broughtNow: 0n,
  checks: [], log: [], door: null, doorTrouble: '', lastWord: '', codeMissing: false,
};

const listeners = new Set();
/** A page re-renders on every change here. */
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) safe(() => fn()); };
export const walletName = () => state.wallet?.name ?? 'Your wallet';
export const balance = () => state.view?.balance ?? 0n;
const nowSecs = () => Math.floor(Date.now() / 1000);
const declaredNow = () => BigInt(nowSecs() - 60); // a minute behind the clock, inside the cage's slack

/** What the judge may do without asking. From the chain when a wallet is here. With none, from the judge's last reading at the door, which is enough to hop. */
export function permit() {
  const v = state.view;
  if (v?.id) return permitState({ permit: v.permit, judge: v.judge, balance: v.balance }, nowSecs());
  const d = state.door;
  return d?.permit ? permitState({ permit: d.permit, balance: BigInt(d.balanceStar ?? 0) }, nowSecs()) : NO_PERMIT;
}
/**
 * What a deposit carries: this judge's key, the cap, and until when. A cap always: a top-up with an empty permit adds nothing the judge can place.
 * The until is worked out here, as the call is built: whole seconds, and under the cage's maxGrant (permitUntil, in wallet-core.js).
 */
function depositArgs(amount, cap) {
  const doorEnds = doorGood() ? state.door.expires : 0;
  return [state.session.payoutOf(), amount, hexBytes(state.view.judge), cap, permitUntil(doorEnds, nowSecs())];
}
const seatTokenAt = (tableId) => safe(() => localStorage.getItem(seatKey(tableId)));
export const myKey = () => safe(() => localStorage.getItem(`cage.key.${state.address}`));
export const saveKey = (key) => localStorage.setItem(`cage.key.${state.address}`, key);
export function newKey() {
  const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  saveKey(key);
  return key;
}

// ---------- how many times a wallet asks ----------

/** Prompts a wallet shows for one transaction. 1AM asks twice: the transaction, then the DUST choice. Lace asks once. */
export const promptsPerTx = (name = walletName()) => (/1am/i.test(name) ? 2 : 1);
export const askTwice = (name = walletName()) => promptsPerTx(name) === 2;

/** "2 transactions: 4 prompts in 1AM (it asks twice per transaction: the transaction, then the DUST choice), and one signature" */
export function promptsText(plan, name = walletName()) {
  const txs = plan.approvals;
  const per = promptsPerTx(name);
  const parts = [];
  if (txs) parts.push(`${txs} transaction${txs === 1 ? '' : 's'}: ${txs * per} prompt${txs * per === 1 ? '' : 's'} in ${name}${per === 2 ? ' (it asks twice per transaction: the transaction, then the DUST choice)' : ''}`);
  if (plan.signature) parts.push(`${parts.length ? 'and ' : ''}one signature`);
  return parts.length ? parts.join(', ') : 'nothing to approve';
}

// ---------- what must stop everything ----------

export function stop(message) {
  state.stopped = true;
  state.stopMessage = message;
  forgetAuto();
  hideWaiting();
  emit();
}

// ---------- the checks list and the log ----------

export function check(name, status, detail = '') {
  const row = state.checks.find((c) => c.name === name);
  if (row) Object.assign(row, { status, detail });
  else state.checks.push({ name, status, detail });
  emit();
}

export function log(message, cls) {
  state.log.unshift({ text: scrub(message), cls: cls ?? '', at: Date.now() });
  if (state.log.length > 200) state.log.length = 200;
  emit();
}

// ---------- connect ----------

export const chosen = () => safe(() => localStorage.getItem(CHOICE_KEY));
const forgetAuto = () => safe(() => localStorage.removeItem(AUTO_KEY));
const autoOn = () => safe(() => localStorage.getItem(AUTO_KEY)) === '1';
export const wallets = () => listWallets(window.midnight, chosen());

function setStatus(text) { state.connectStatus = text; emit(); }

// Wallets inject after the page loads, and not all at once, so keep looking for a while.
export function watchWallets() {
  let tries = 0;
  setStatus('Looking for wallets…');
  const look = () => {
    if (state.api || state.stopped) return;
    const found = wallets();
    const seen = found.map((w) => `${w.id}|${w.name}|${w.apiVersion}`).join('\n');
    if (seen !== state.pickerSeen) { state.pickerSeen = seen; emit(); }
    if (found.length && state.connectStatus === 'Looking for wallets…') setStatus('');
    tryReconnect(found);
    tries += 1;
    if (tries < 20) setTimeout(look, 500);
    else if (!found.length) setStatus(NO_WALLET);
  };
  look();
}

function startConnect(wallet, { fresh = false } = {}) {
  // 1AM: one connect at a time (pass #24). A click while the page's own reconnect is still waiting on 1AM used to start a second one, and 1AM
  // then asked in its extension panel and in its popup. A connect still young (under ANSWER_MS) answers both. Any other wallet, or an older
  // wait, is asked again: a wallet that went silent (Lace's background stopping) must answer a fresh click.
  const p = state.pendingConnect;
  if (!fresh && p && p.id === wallet.id && wallet.is1am && Date.now() - p.at < ANSWER_MS) return p.promise;
  // A wallet that opens a pop-up can be blocked unless connect() runs straight from the click, so no await before it.
  let promise;
  try { promise = Promise.resolve(wallet.api.connect(NETWORK)); } catch (e) { promise = Promise.reject(e); }
  state.pendingConnect = { id: wallet.id, promise, at: Date.now() };
  promise.catch(() => {}).finally(() => { if (state.pendingConnect?.promise === promise) state.pendingConnect = null; });
  return promise;
}

// A wallet that isn't answering looks the same as one waiting on a person, so the wait ends only the waiting. See acceptLate.
const noAnswerText = (wallet) => `${wallet.name} didn’t answer — open ${wallet.name}, unlock it, and try again. If it still doesn’t answer, refresh this page.`;

// One call to any wallet method, with a time limit. Not for a call that waits on a person or a proof.
const ask = (call) => withinTime(Promise.resolve().then(call), ANSWER_MS, `${walletName()} didn’t answer.`);

function offerRetry(wallet, message) {
  state.retryId = wallet.id;
  state.retryOffered = !state.stopped;
  setStatus(message);
}

/**
 * A slow approval is still an approval, and every connect() is the same request, so the first answer for the wallet the
 * player last chose wins, however late. A click on another wallet ends any wait for the first.
 */
async function acceptLate(api, wallet) {
  if (state.api || state.stopped || state.pendingId !== wallet.id) return;
  const attempt = ++state.attempt; // this answer is now the attempt, so its failure is the one that gets reported
  try { await afterConnect(api, wallet); } catch (e) { connectFailed(wallet, attempt, e); }
}

function connectFailed(wallet, attempt, e) {
  if (attempt !== state.attempt) return;
  failConnect();
  const text = errorText(e);
  if (retryAfterRestart(wallet, e)) return;
  if (e?.noAnswer) offerRetry(wallet, noAnswerText(wallet));
  else if (isWalletRestarted(e)) offerRetry(wallet, restartedText(wallet.name));
  else offerRetry(wallet, /network/i.test(text) ? `${wallet.name} refused: ${text} Set ${wallet.name} to Preprod and try again.` : /locked|unlock/i.test(text) ? `${wallet.name} is locked: unlock it and tap Sit again.` : `${wallet.name} said no: ${text}`);
  trouble(explainTrouble(e, { wallet: wallet.name, during: 'connect' }), { retry: () => connect(wallet.id) });
}

const restartedText = (name) => `${name} restarted itself. Click Try again.`;

/** A wallet whose background restarted mid-connect: drop what this page held and ask it once more by itself, from window.midnight afresh. */
function retryAfterRestart(wallet, e) {
  if (!isWalletRestarted(e) || state.restartRetried) return false;
  state.restartRetried = true; // once until the next connect that works
  log(`${wallet.name} restarted itself while connecting. Asking it again.`, 'failed');
  setStatus(`${wallet.name} restarted itself; asking it again…`);
  setTimeout(() => connect(wallet.id), 1000);
  return true;
}

/**
 * A fresh link to the wallet: window.midnight read again and connect() called again, never a connector held from before (11-09: Lace's
 * background restarted and the page's connector "can no longer be used"). A site the wallet has approved gets it without a prompt.
 * The same address, or it stops. `waitMs` 0 waits as long as the wallet takes (a slow approval still counts). Resolves to the new api.
 */
async function reacquire({ waitMs = ANSWER_MS } = {}) {
  const id = state.wallet?.id ?? state.retryId ?? chosen();
  const wallet = findWallet(window.midnight, id);
  if (!wallet) throw Object.assign(new Error(`${walletName()} has gone from this page.`), { gone: true });
  const connecting = startConnect(wallet, { fresh: true });
  const api = await (waitMs ? withinTime(connecting, waitMs, `${wallet.name} didn’t answer.`) : connecting);
  const { unshieldedAddress } = await ask(() => api.getUnshieldedAddress());
  if (state.address && unshieldedAddress !== state.address) {
    hideWaiting();
    stop(`Stopped. ${wallet.name} came back with a different address. Nothing was sent. Refresh to start over.`);
    throw Object.assign(new Error('a different address'), { stopped: true });
  }
  state.api = api;
  state.wallet = wallet;
  state.session?.useApi(api);
  state.lost = false;
  state.restartRetried = false;
  log(`A fresh link to ${wallet.name}.`);
  emit();
  return api;
}

/** Try again in the trouble window: a fresh link to the wallet first (when one was connected), then the same step. */
async function freshThen(retry) {
  if (!state.api || !state.wallet || state.stopped) return retry();
  try { await reacquire(); } catch (e) { if (!e?.stopped) offerReconnect(retry, e, 'answer'); return null; }
  return retry();
}

/** From a click on a wallet. Says "Waiting for <wallet>" at once. */
export function connect(id) {
  const wallet = findWallet(window.midnight, id);
  if (!wallet) { setStatus('That wallet has gone from this page. Refresh and try again.'); return; }
  const attempt = ++state.attempt;
  const connecting = startConnect(wallet);
  state.pendingId = wallet.id;
  state.autoConnecting = false;
  state.connecting = true; // from the click until the wallet answers or the wait ends
  state.connectingAt = Date.now();
  safe(() => localStorage.setItem(CHOICE_KEY, wallet.id));
  hideWaiting();
  state.retryOffered = false;
  setStatus(`Waiting for ${wallet.name}… Approve in ${wallet.name} if it asks.`);
  const timer = setTimeout(() => {
    if (attempt === state.attempt && !state.api) connectFailed(wallet, attempt, { noAnswer: true });
  }, ANSWER_MS);
  connecting.finally(() => clearTimeout(timer)).then((api) => acceptLate(api, wallet)).catch((e) => connectFailed(wallet, attempt, e));
}

export const retryConnect = () => { if (state.retryId) connect(state.retryId); };

/**
 * The connector can't tell a page whether a site is still approved, so the only way to find out is connect(). A wallet
 * that has approved this site answers with no prompt. One that hasn't may prompt or never answer, so this runs at most
 * once per load, and any failure turns it off until the next successful connect. That way a page can't keep asking.
 */
function tryReconnect(found) {
  if (state.autoTried || state.attempt || state.api || !autoOn()) return;
  const wallet = found.find((w) => w.id === chosen());
  if (!wallet?.compatible) return;
  state.autoTried = true;
  state.autoConnecting = true;
  const attempt = ++state.attempt;
  state.pendingId = wallet.id;
  setStatus(`Reconnecting to ${wallet.name}…`);
  const timer = setTimeout(() => {
    if (attempt !== state.attempt || state.api) return;
    forgetAuto();
    offerRetry(wallet, noAnswerText(wallet));
    noAnswerWindow(() => connect(wallet.id), wallet.name);
  }, AUTO_WAIT_MS);
  startConnect(wallet).finally(() => clearTimeout(timer)).then((api) => acceptLate(api, wallet)).catch((e) => {
    if (attempt !== state.attempt) return;
    failConnect();
    if (retryAfterRestart(wallet, e)) return;
    offerRetry(wallet, e?.noAnswer ? noAnswerText(wallet) : isWalletRestarted(e) ? restartedText(wallet.name) : `Couldn’t reconnect to ${wallet.name}: ${errorText(e)} Choose a wallet to connect.`);
    if (e?.noAnswer) noAnswerWindow(() => connect(wallet.id), wallet.name);
  });
}

function failConnect() {
  state.pendingConnect = null; // a try after a failure, or after a wait that ran out, asks the wallet afresh
  state.api = null;
  state.wallet = null;
  state.autoConnecting = false;
  state.connecting = false; // the buttons work again; a late answer for the pending wallet still counts
  forgetAuto();
  emit();
}

export function switchWallet() { forgetAuto(); location.reload(); }

// A wallet can say "disconnected" for a moment right after connect(), so one answer isn't enough to give up.
async function connectionStatus(api) {
  let status;
  for (let i = 0; i < 4; i += 1) {
    status = await ask(() => api.getConnectionStatus());
    if (status.status === 'connected') return status;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  return status;
}

async function afterConnect(api, wallet) {
  state.api = api;
  state.wallet = wallet;
  closeNoAnswer(); // it answered after all
  check('Wallet', 'ok', `${wallet.name}${wallet.rdns ? ` (${wallet.rdns})` : ''}, connector ${wallet.apiVersion}`);
  const status = await connectionStatus(api);
  if (status.status !== 'connected') throw new Error('it says it is not connected.');
  if (!isPreprodNetwork(status.networkId)) {
    check('Network', 'bad', `${wallet.name} is on ${status.networkId}.`);
    stop(`Stopped. ${wallet.name} is on ${status.networkId}. This page works on preprod only. Switch ${wallet.name} to Preprod and refresh.`);
    return;
  }
  const { unshieldedAddress } = await ask(() => api.getUnshieldedAddress());
  if (!isPreprodAddress(unshieldedAddress)) {
    check('Network', 'bad', 'That isn’t a preprod address.');
    stop(`Stopped. ${wallet.name} gave an address that isn’t on preprod. Nothing was sent.`);
    return;
  }
  check('Network', 'ok', 'Preprod');
  safe(() => localStorage.setItem(CHOICE_KEY, wallet.id));
  safe(() => localStorage.setItem(AUTO_KEY, '1'));
  // Asking for everything at once lets a wallet that asks method by method do it now, not halfway through a call.
  if (typeof api.hintUsage === 'function') Promise.resolve().then(() => api.hintUsage(USES)).catch(() => {});
  state.address = unshieldedAddress;
  state.restartRetried = false;
  state.pendingId = null;
  state.autoConnecting = false;
  state.connecting = false;
  state.retryOffered = false;
  setStatus('');
  const { dustAddress } = await ask(() => api.getDustAddress()).catch(() => ({ dustAddress: '' }));
  state.dustAddress = dustAddress;
  await refreshWallet();
  // Each of these reports its own trouble, so that one failing doesn't hide the balances above.
  await checkServices(api);
  await loadCage();
}

export async function refreshWallet({ again = false } = {}) {
  const { api } = state;
  if (!api) return;
  const couldntSay = (e) => {
    if (e?.noAnswer) noAnswerWindow(async () => { await refreshWallet(); await refreshCage(); });
    return e?.noAnswer ? errorText(e) : `${walletName()} couldn’t say: ${errorText(e)}`;
  };
  try {
    // Switched wallets or accounts in the wallet since this page connected (pass #12)? Then everything it read is for the other one: say so.
    const { unshieldedAddress } = await ask(() => api.getUnshieldedAddress());
    if (state.address && unshieldedAddress && unshieldedAddress !== state.address) {
      state.accountChanged = true;
      trouble({ kind: 'account', title: `${walletName()} is on another account now`, what: `This page connected to one address, and ${walletName()} now answers for another.`, cause: `You switched wallets or accounts in ${walletName()} while this page was connected.`, todo: 'Tap Use another wallet below and connect again, so the page reads the account you are on now.', retry: false, raw: '' }, { retry: null });
      $('trouble-refresh').textContent = 'Use another wallet';
      $('trouble-refresh').onclick = () => switchWallet();
      return;
    }
  } catch (e) {
    // The wallet restarted under the page (its connector "can no longer be used"): one quiet fresh link, then read again. No prompt for an
    // approved site; anything else is left to the reads below and to Try again.
    if (!again && !state.busy && !state.stopped && isWalletRestarted(e) && state.api === api) {
      try { await reacquire(); return refreshWallet({ again: true }); } catch { /* the reads below say what is wrong */ }
    }
  }
  try {
    const night = await ask(() => api.getUnshieldedBalances());
    state.night = BigInt(night[NIGHT_TOKEN] ?? 0n);
    state.nightText = nightText(state.night);
    safe(() => localStorage.setItem(WALLET_READ_KEY, JSON.stringify({ name: walletName(), night: String(state.night), at: Date.now() }))); // the Hall's banner, in tNIGHT mode
  } catch (e) { state.nightText = couldntSay(e); }
  try {
    const { balance: dust, cap } = await ask(() => api.getDustBalance());
    state.dust = BigInt(dust);
    state.dustText = `${fmtDust(dust)} tDUST`;
    state.dustCap = `Fills up to ${fmtDust(cap)}`;
    if (BigInt(dust) === 0n && !state.saidNoDust) { state.saidNoDust = true; log(`You have no tDUST yet, and a wallet normally needs it to pay fees. Generate tDUST in ${walletName()} and let it fill.`); }
  } catch (e) { state.dustText = couldntSay(e); }
  emit();
}

// ---------- proof server and indexer ----------

async function checkServices(api) {
  const name = walletName();
  const proves = typeof api.getProvingProvider === 'function';
  check('Proving', proves ? 'ok' : 'bad', proves ? `${name} can prove for this page.` : `${name} can’t prove for a page, so you can read the cage but not send. Update it if you can.`);
  const config = await ask(() => api.getConfiguration()).catch((e) => {
    check('Wallet settings', 'bad', `${name} couldn’t say: ${errorText(e)}`);
    if (e?.noAnswer) noAnswerWindow(() => retrySession());
    return null;
  });
  if (config) {
    if (!isPreprodNetwork(config.networkId) || namesMainnet(config.indexerUri) || namesMainnet(config.substrateNodeUri)) {
      check('Wallet settings', 'bad', 'They name another network.');
      stop(`Stopped. ${name}’s settings point at a network other than preprod. Nothing was sent.`);
      return;
    }
    await checkProofServer(config);
  }
  const wallet = config?.indexerUri ? { http: config.indexerUri, ws: config.indexerWsUri ?? config.indexerUri.replace(/^http/, 'ws'), from: `${name}’s` } : null;
  await pickIndexer({ wallet, name });
}

async function checkProofServer(config) {
  const uri = config.proverServerUri;
  const name = walletName();
  if (!uri) { check('Proof server', 'ok', `${name} chooses where to prove. A hosted prover sees your player key, so check ${name}’s settings for anything you care about.`); return; }
  if (!/localhost|127\.0\.0\.1/.test(uri)) { check('Proof server', 'bad', `${name} uses ${hostOf(uri)}. That prover would see your player key. Choose a local prover in ${name}’s settings.`); return; }
  try {
    await fetch('http://localhost:6300/health', { mode: 'no-cors', signal: AbortSignal.timeout(4000) });
    check('Proof server', 'ok', 'Running on this computer.');
  } catch {
    check('Proof server', 'bad', 'Nothing on localhost:6300, or this browser won’t let a page look. Start it with Docker if it isn’t running.');
  }
}

/** The cage's address, from the Hall, before the rest of the page needs it: an indexer is only as good as its copy of this contract. */
async function cageAddress() {
  if (state.cage?.address) return state.cage.address;
  try {
    state.cage = await (await fetch('/cage-config.json', { cache: 'no-store' })).json();
    return state.cage?.address ?? null;
  } catch { return null; }
}

/**
 * Whether this indexer is one the page can use: it answers, and it has the cage. A block height alone proves neither (11-09: a wallet's own
 * indexer answered the height and had no copy of the cage, so the page chose it and then read nothing). Returns the block height.
 */
async function indexerAnswers(url) {
  const address = await cageAddress();
  const query = address ? 'query($a: HexEncoded!) { block { height } contract(address: $a) { address } }' : '{ block { height } }';
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, ...(address ? { variables: { a: address } } : {}) }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json())?.data;
  if (data?.block?.height == null) throw new Error('no block height');
  if (address && !data.contract) throw new Error('it answers, but has no copy of the cage');
  return data.block.height;
}

/** Whether this Hall reads the chain for itself. Null when it doesn't. */
async function hallIndexer() {
  try {
    const res = await fetch('/indexer', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body.on ? { ...OUR_INDEXER, host: body.host } : null;
  } catch { return null; }
}

function useIndexer(choice, detail) {
  state.indexer = choice;
  state.indexerForm = false;
  check('Indexer', 'ok', detail);
}

/**
 * The wallet's own indexer first, when it names one and it answers. Otherwise the Hall's own, through this Worker. The
 * cage is read the same way either way, and the wallet never sees which. Neither answering leaves the paste box.
 */
async function pickIndexer({ wallet, name = walletName() }) {
  if (wallet && namesMainnet(wallet.http)) { stop('Stopped. That indexer is on mainnet. Nothing was sent.'); return false; }
  state.indexerTried = { wallet, name };
  const block = (height) => `block ${Number(height).toLocaleString('en-US')}`;
  let walletTrouble = null;
  if (wallet) {
    check('Indexer', 'wait', `Asking ${wallet.from} indexer, ${hostOf(wallet.http)}…`);
    try {
      useIndexer(wallet, `${wallet.from}: ${hostOf(wallet.http)}, ${block(await indexerAnswers(wallet.http))}`);
      return true;
    } catch (e) { walletTrouble = `${wallet.from} ${hostOf(wallet.http)} didn’t answer (${errorText(e)})`; }
  }
  const ours = await hallIndexer();
  if (ours) {
    try {
      useIndexer(ours, `The Hall’s own, ${ours.host}, ${block(await indexerAnswers(ours.http))}. ${walletTrouble ? `${walletTrouble}, so the Hall reads the cage for you.` : `${name} names no indexer, so the Hall reads the cage for you.`}`);
      return true;
    } catch (e) {
      check('Indexer', 'bad', `None answers: ${walletTrouble ? `${walletTrouble}, and ` : ''}the Hall’s own ${ours.host} didn’t either (${errorText(e)}). This page asks again every ${CAGE_POLL_MS / 1000} seconds.`);
    }
  } else {
    check('Indexer', 'bad', `${walletTrouble ?? `${name} names no indexer`}, and this Hall has none of its own. Paste a Blockfrost project ID below, or try again later.`);
  }
  state.indexer = null;
  state.indexerForm = true;
  emit();
  return false;
}

/** A Blockfrost project id pasted by the player: stays in this tab, goes only to Blockfrost. */
export async function useProjectId(id) {
  safe(() => sessionStorage.setItem('cage.indexer', id));
  const urls = blockfrostUrls(id);
  try {
    useIndexer({ ...urls, from: 'Your Blockfrost project' }, `Your Blockfrost project: ${hostOf(urls.http)}, block ${Number(await indexerAnswers(urls.http)).toLocaleString('en-US')}`);
    await loadCage();
  } catch (e) {
    check('Indexer', 'bad', `Your Blockfrost project: ${hostOf(urls.http)} didn’t answer (${errorText(e)}).`);
    state.indexerForm = true;
    emit();
  }
}

// One failed answer from an indexer shouldn't leave the page waiting until someone refreshes, so it asks again now and then.
let retryingSession = false;
export async function retrySession() {
  if (retryingSession || !state.api || state.session || state.busy || state.stopped || state.lost) return;
  retryingSession = true;
  try {
    if (!state.indexer && state.indexerTried && !(await pickIndexer(state.indexerTried))) return;
    await loadCage();
  } finally {
    retryingSession = false;
  }
}

// ---------- the cage ----------

async function loadCage() {
  if (state.stopped) return;
  try {
    state.cage = await (await fetch('/cage-config.json', { cache: 'no-store' })).json();
  } catch (e) { check('Cage', 'bad', `Couldn’t load its address: ${errorText(e)}`); return; }
  if (state.cage.network !== NETWORK) { stop('Stopped. This page was built for another network. Nothing was sent.'); return; }
  emit();
  if (!state.indexer) {
    const saved = safe(() => sessionStorage.getItem('cage.indexer'));
    if (saved) {
      const urls = blockfrostUrls(saved);
      try { useIndexer({ ...urls, from: 'Your Blockfrost project' }, `Your Blockfrost project: ${hostOf(urls.http)}, block ${Number(await indexerAnswers(urls.http)).toLocaleString('en-US')}`); } catch { /* the box stays */ }
    }
  }
  let code;
  try {
    code = await import('/wallet-app/cage.js');
  } catch (e) {
    state.codeMissing = true;
    check('Contract code', 'bad', `Not on this build yet (${errorText(e)}). Connect and balances still work.`);
    emit();
    return;
  }
  check('Contract code', 'ok', 'Loaded.');
  if (!state.indexer) { emit(); return; }
  try {
    // openCage asks the wallet for its shielded keys, so it can hang the same way.
    state.session = await ask(() => code.openCage({
      api: state.api, address: state.cage.address, indexerHttp: state.indexer.http, indexerWs: state.indexer.ws,
      walletAddress: state.address, zkBase: `${location.origin}/wallet-app/zk`, walletName: walletName(),
    }));
  } catch (e) {
    check('Contract code', 'bad', `Couldn’t start: ${errorText(e)}`);
    if (e?.noAnswer) noAnswerWindow(() => retrySession());
    emit();
    return;
  }
  await refreshCage();
}

export async function refreshCage() {
  if (!state.session) return;
  try {
    const view = await state.session.read(myKey());
    state.view = view;
    state.seat = seatView({ seat: view.seat, table: view.table, escapeSecs: view.escapeSecs, now: Math.floor(Date.now() / 1000) });
    state.readError = '';
    state.readDetail = '';
    // A cash-out another page started and this cage now shows done: nothing seated and nothing left. The banner can go.
    if (!state.running && readInFlight()?.kind === 'cashout' && view.balance === 0n && !state.seat?.seated) endInFlight();
  } catch (e) {
    // The wallet's own indexer was chosen but can't read the cage: the Hall's reads it for the player, once, before this says anything.
    if (!state.fellBack && state.indexer && state.indexer.from !== OUR_INDEXER.from) {
      const ours = await hallIndexer();
      if (ours) {
        state.fellBack = true;
        const was = state.indexer;
        useIndexer(ours, `The Hall’s own, ${ours.host}. ${was.from} ${hostOf(was.http)} couldn’t read the cage (${errorText(e)}), so the Hall reads it for you.`);
        state.session = null;
        await loadCage();
        return;
      }
    }
    state.readError = CAGE_UNREADABLE;
    state.readDetail = `Couldn’t read the cage: ${errorText(e)}${state.indexer ? ` (through ${hostOf(state.indexer.http)})` : ''}`;
  }
  emit();
}

/** The Refresh for a cage that can't be read: ask the wallet and the indexer again, from the start if no session opened. */
export async function retryRead() {
  state.fellBack = false;
  await refreshWallet();
  if (state.session) await refreshCage(); else await retrySession();
}

export const ready = () => !!state.session && !!state.cage?.writable && !state.busy && !state.running && !state.stopped && !state.lost;

/** Why nothing can be sent just now, in plain words, or '' when it can. */
/**
 * Whether the connected wallet can pay a network fee now (the 11-08 pass #3, #7): it holds DUST, or it is a wallet that covers the fee itself
 * (1AM shows "DUST sponsored"). Not read yet counts as ready, so nothing is held back on a guess.
 */
export const sponsorsDust = () => /\b1am\b/i.test(walletName());
/** The no-DUST line for this wallet (the same words the plan gives as its reason). */
export const dustText = () => noDustText(walletName());
export function dustReady() {
  if (!state.api || state.dust === null || state.dust === undefined) return true;
  return state.dust > 0n || sponsorsDust();
}
/** The wallet card's badge: ready, covered, or not ready yet. Null before the wallet is read. */
export function dustBadge() {
  if (!state.api || state.dust === null || state.dust === undefined) return null;
  if (state.dust > 0n) return { ok: true, text: 'You have DUST to pay fees' };
  if (sponsorsDust()) return { ok: true, text: `No DUST: ${walletName()} may cover the fee (it says DUST sponsored)` }; // not confirmed for Preprod (11-08 research)
  return { ok: false, text: 'Not ready yet: no DUST' };
}

export function notReady() {
  if (state.stopped) return 'This page has stopped: see the top.';
  if (!state.api) return 'Choose your wallet first.';
  if (state.lost) return `Reconnect to ${walletName()} first: see the window.`;
  if (state.cage && !state.cage.writable) return 'This cage is read-only.';
  if (state.session && !state.view && state.readError) return 'The cage can’t be read right now: see above.';
  if (!state.session) return !state.indexer ? 'Waiting for an indexer: none answers yet. This page keeps asking, and the Hall’s own is tried too.' : state.codeMissing ? 'The contract code isn’t on this build.' : 'Waiting for the contract code and the cage.';
  if (state.busy || state.running) return $('waiting')?.classList.contains('compact') && !$('waiting').hidden ? 'Working on it: see the banner at the top.' : 'Working on it: see the window.';
  return '';
}

// ---------- the waiting window ----------
// Every on-chain step runs in here: the stages tick off as the wallet and the chain answer, the bar fills over the whole plan,
// and a plain line underneath says where it is. When something fails, the same window says what broke and what to do.

const WINDOW_HTML = `
  <div class="waiting-banner" id="waiting-banner" role="status"><span class="mid-spin" id="waiting-banner-spin" aria-hidden="true"></span><span class="waiting-banner-text" id="waiting-banner-text"></span> <span class="waiting-banner-clock" id="waiting-banner-clock"></span><button class="btn small" id="waiting-details" type="button">Details</button></div>
  <div class="waiting-body">
    <h2 class="box-title" id="waiting-title"></h2>
    <p class="prose" id="waiting-intro"></p>
    <p class="why-wait" id="waiting-why"></p>
    <div class="bar" id="waiting-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="waiting-fill"></span></div>
    <ol class="stages" id="stages"></ol>
    <p class="plain-log" id="waiting-line"></p>
    <div class="result-cards" id="result-cards"></div>
    <ol class="cage-log small-log" id="waiting-log"></ol>
    <div class="trouble" id="trouble" hidden>
      <p><b>What broke.</b> <span id="trouble-what"></span></p>
      <p><b>Likely cause.</b> <span id="trouble-cause"></span></p>
      <p><b>What to do.</b> <span id="trouble-do"></span></p>
      <ol class="trouble-steps" id="trouble-steps" hidden></ol>
    </div>
    <div class="row-buttons" id="waiting-buttons">
      <button class="btn primary" id="trouble-retry" type="button" hidden>Try again</button>
      <button class="btn primary" id="reconnect" type="button" hidden>Reconnect and try again</button>
      <button class="btn primary" id="trouble-revoke" type="button" hidden>Revoke, then stand</button>
      <button class="btn" id="trouble-refresh" type="button" hidden>Refresh this page</button>
      <a class="btn primary" id="waiting-go" hidden></a>
      <button class="btn small" id="waiting-hide" type="button">Hide</button>
    </div>
    <pre class="raw" id="trouble-raw" hidden></pre>
  </div>`;

/** The window's markup, once, on any page. */
function ensureWindow() {
  if ($('waiting')) return;
  const el = document.createElement('div');
  el.className = 'dialogue waiting';
  el.id = 'waiting';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'waiting-title');
  el.hidden = true;
  el.innerHTML = WINDOW_HTML;
  document.body.append(el);
  $('reconnect').addEventListener('click', onReconnect);
  $('trouble-retry').addEventListener('click', () => { const retry = waiting.retry; hideWaiting(); if (retry) freshThen(retry); }); // never the old connector (11-09)
  $('trouble-revoke').addEventListener('click', () => { const go = waiting.revoke; hideWaiting(); if (go) go(); });
  $('trouble-refresh').addEventListener('click', () => location.reload());
  $('waiting-hide').addEventListener('click', () => { $('waiting').hidden = true; if ($('waiting').classList.contains('failed')) hideWaiting(); });
  $('waiting-details').addEventListener('click', () => expandWaiting());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('waiting').hidden && $('waiting').classList.contains('failed')) hideWaiting(); });
}

const nounOf = (circuit) => ACTIONS[circuit]?.noun ?? 'transaction';
const TX_STAGES = (wallet, circuit) => [`Building your ${nounOf(circuit)}`, `Proving your ${nounOf(circuit)}`, `Approve in ${wallet}${askTwice(wallet) ? ' (2 prompts)' : ''}`, 'Sending to Midnight', 'Waiting for the block', 'Done'];
const SIGN_STAGES = (wallet) => [`Sign in ${wallet}`, 'The judge checks it', 'Done'];
const SEAT_STEPS = (noun) => [`The judge is proving your ${noun}`, 'Sending to Midnight', 'Waiting for the block'];
export const JUDGE_STAGES = (seats = false) => (seats ? ['The judge picks it up', ...SEAT_STEPS('seat'), 'Seated'] : ['Your seat is on chain', 'The judge reads it from the cage', 'Seated']);
const HOP_STAGES = () => ['Your round here finishes', 'The judge settles it', ...SEAT_STEPS('move'), 'Seated'];
const FREE_STAGES = () => ['The judge frees your seat', 'Free'];
export const waiting = { open: false, total: 1, done: 0, stages: [], stillTimer: null, retry: null };
/** Why a window waits, one line under its title (11-06, round 2), in Tally's voice, with the times measured on preprod today: a block 30 s to a minute. */
export const WHY = {
  chain: 'Settled on Midnight: every seat, stack and payout waits for a block, usually 30 s to a minute. That’s what makes the table cheat-proof.',
  door: 'Your tNIGHT goes into the cage on Midnight: one block, usually 30 s to a minute, and the judge checks your signature after. That’s what makes it safe to play with.',
  leave: 'Your seat is freed on Midnight, one block after your last round is settled, usually 30 s to a minute. That’s how your stack is only ever yours.',
  cash: 'Standing and the withdraw are two blocks on Midnight, usually 30 s to a minute each, and the money comes back only to your own wallet.',
};

/**
 * A step with nothing to approve (the judge seats you from the cage, or moves your seat) waits in a small banner at the top instead
 * of the big window (the 11-08 pass #17): the table stays in view, a clock counts, and Details opens the full window with its steps and
 * the result card. Trouble always opens it in full.
 */
function startBanner(text) {
  clearInterval(waiting.clockTimer);
  clearTimeout(waiting.bannerTimer);
  const t0 = Date.now();
  const tick = () => { const s = Math.round((Date.now() - t0) / 1000); $('waiting-banner-clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  $('waiting-banner-text').textContent = text;
  $('waiting').classList.remove('banner-done');
  $('waiting-banner-spin').hidden = false;
  tick();
  waiting.clockTimer = setInterval(tick, 1000);
  waiting.bannerAt = t0;
}
/** The banner's last word: done, how long it took, and it goes by itself unless they opened the details. */
export function bannerDone(text) {
  if (!$('waiting')?.classList.contains('compact')) return;
  clearInterval(waiting.clockTimer);
  const s = Math.round((Date.now() - (waiting.bannerAt ?? Date.now())) / 1000);
  $('waiting-banner-text').textContent = `${text} in ${s} s ✓`;
  $('waiting-banner-clock').textContent = '';
  $('waiting-banner-spin').hidden = true;
  $('waiting').classList.add('banner-done');
  waiting.bannerTimer = setTimeout(() => { if ($('waiting').classList.contains('compact')) hideWaiting(); }, 8000);
}
/** From the banner to the full window. */
export function expandWaiting() {
  if (!$('waiting')) return;
  clearTimeout(waiting.bannerTimer);
  $('waiting').classList.remove('compact');
  $('waiting').setAttribute('aria-modal', 'true');
  $('waiting').hidden = false;
}

export function openWaiting({ title, intro, total, why = WHY.chain, banner = null }) {
  ensureWindow();
  $('waiting').classList.toggle('compact', !!banner);
  $('waiting').setAttribute('aria-modal', banner ? 'false' : 'true');
  if (banner) startBanner(banner); else { clearInterval(waiting.clockTimer); clearTimeout(waiting.bannerTimer); }
  Object.assign(waiting, { open: true, total: Math.max(1, total), done: 0, stages: [] });
  $('waiting').classList.remove('failed');
  $('waiting-title').textContent = title;
  $('waiting-intro').textContent = intro;
  $('waiting-why').textContent = why ?? '';
  $('stages').replaceChildren();
  $('waiting-line').textContent = '';
  $('waiting-log').replaceChildren();
  lastLine = { text: '', li: null, at: 0, stamp: '' };
  $('result-cards').replaceChildren();
  $('waiting-go').hidden = true;
  results.length = 0;
  $('trouble').hidden = true;
  $('trouble-raw').hidden = true;
  for (const id of ['trouble-retry', 'reconnect', 'trouble-refresh', 'trouble-revoke']) $(id).hidden = true;
  $('trouble-steps').hidden = true;
  $('waiting').classList.remove('no-answer');
  $('waiting').classList.add('running'); // the page dims while its buttons are off; settled() lifts it
  $('waiting-hide').hidden = false;
  $('waiting-hide').textContent = 'Hide';
  bar();
  $('waiting').hidden = false;
}

/** The plan is over, done or not: the window stays to be read, and the page behind it is live again, and looks it. */
export function settled() {
  $('waiting').classList.remove('running');
  $('waiting-hide').textContent = 'Close';
}

export function hideWaiting() {
  clearInterval(waiting.clockTimer);
  clearTimeout(waiting.bannerTimer);
  if ($('waiting')) { $('waiting').hidden = true; $('waiting').classList.remove('running', 'compact', 'banner-done'); }
  waiting.open = false;
  clearTimeout(waiting.stillTimer);
}

// ---------- the result card: what landed, how long it took, what the world can see ----------

const RESULTS_KEY = 'cage.results'; // a card outlives the move to the next page, once
const results = [];
const unsentTimings = []; // a first deposit lands before there's a session to report it with
const timingsNow = () => fetch('/door/timings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).then((b) => b.medians ?? {}).catch(() => ({}));

function flushTimings() {
  const token = doorToken();
  if (!token) return;
  for (const t of unsentTimings.splice(0)) fetch('/door/timings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(t) }).catch(() => {});
}

function paintCard(card) {
  const box = document.createElement('div');
  box.className = 'result-card';
  box.dataset.action = card.action;
  const line = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; return p; };
  box.append(line('result-title', card.title), line('result-head', card.head), line('result-typical', card.typical), line('result-says', card.says));
  if (card.link) {
    const a = document.createElement('a');
    a.className = 'result-link';
    a.href = card.link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'See it on the explorer';
    box.append(a);
  }
  $('result-cards').append(box);
}

/**
 * One transaction has landed. A page's own is timed here, without the time a person took to approve it, and the typical time is read before it counts. A judge's is timed
 * by the judge, which has already reported it, so that median includes it: one sample among the last 51. `report` is false for those.
 */
export async function addResult({ action, ms = null, hash = null, report = true }) {
  ensureWindow();
  const medians = await timingsNow();
  const card = resultCard({ action, ms, typical: medians[action] ?? null, hash });
  results.push(card);
  paintCard(card);
  if (report && Number.isFinite(ms) && ms > 0) { unsentTimings.push({ action, ms: Math.round(ms) }); flushTimings(); }
}

/** Keeps the cards for the next page, when a plan ends by moving there. */
export function stashResults() {
  if (results.length) safe(() => sessionStorage.setItem(RESULTS_KEY, JSON.stringify(results)));
}
function showStashedResults() {
  const saved = safe(() => JSON.parse(sessionStorage.getItem(RESULTS_KEY) ?? 'null'));
  if (!saved?.length) return;
  safe(() => sessionStorage.removeItem(RESULTS_KEY));
  openWaiting({ title: saved.at(-1).title === 'Move' ? 'Moved' : 'Done', intro: '', total: 1, why: '' });
  $('waiting-bar').hidden = true;
  settled();
  saved.forEach((card) => { results.push(card); paintCard(card); });
}

/** A way on from the window, when the plan is done and there's a card to read first. */
export function offerGo(text, href) {
  $('waiting-go').textContent = text;
  $('waiting-go').href = href;
  $('waiting-go').hidden = false;
  settled();
}

function bar(within = 0) {
  if (!$('waiting-fill')) return;
  const pct = Math.min(100, Math.round(((waiting.done + within) / waiting.total) * 100));
  $('waiting-fill').style.width = `${pct}%`;
  $('waiting-bar').setAttribute('aria-valuenow', String(pct));
}

/** A fresh list of stages for the next move. */
export function setStages(names) {
  ensureWindow();
  waiting.stages = names.map((name) => { const li = document.createElement('li'); li.textContent = name; return li; });
  $('stages').replaceChildren(...waiting.stages);
}

export function stageAt(index, { note = null } = {}) {
  clearTimeout(waiting.stillTimer);
  waiting.stages.forEach((li, i) => {
    li.className = i < index ? 'done' : i === index ? 'now' : '';
    const small = li.querySelector('small');
    if (small && (i !== index || note)) small.remove(); // one note at a time, on the step it is about
  });
  if (note && waiting.stages[index]) { const small = document.createElement('small'); small.textContent = note; waiting.stages[index].append(small); }
  if (!note && waiting.stages.length) bar(index / waiting.stages.length);
}

export function stageDone() {
  clearTimeout(waiting.stillTimer);
  for (const li of waiting.stages) { li.className = 'done'; li.querySelector('small')?.remove(); }
  waiting.done += 1;
  bar();
}

function stageFailed() {
  clearTimeout(waiting.stillTimer); // a "still waiting" note under a step that has failed reads as if it were still waiting (pass #5)
  const now = waiting.stages.find((li) => li.className === 'now') ?? waiting.stages.find((li) => !li.className);
  for (const li of waiting.stages) li.querySelector('small')?.remove();
  if (now) now.className = 'failed';
}

/** The last line said, so a step said again (a poll every second) counts up in place instead of filling the log (11-06, round 2). */
let lastLine = { text: '', li: null, at: 0, stamp: '' };
const sofarText = (since) => { const s = Math.round((Date.now() - since) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function waitingLine(text) {
  ensureWindow();
  if (text === lastLine.text && lastLine.li?.isConnected) {
    const sofar = sofarText(lastLine.at);
    $('waiting-line').textContent = `${text}: ${sofar}`;
    lastLine.li.textContent = `${lastLine.stamp} ${text}: ${sofar}`;
    return;
  }
  $('waiting-line').textContent = text;
  const li = document.createElement('li');
  const stamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  li.textContent = `${stamp} ${text}`;
  lastLine = { text, li, at: Date.now(), stamp };
  $('waiting-log').append(li);
  $('waiting-log').scrollTop = $('waiting-log').scrollHeight;
}

/** After a while with no answer from the wallet: it may be asking twice, or be behind another window. */
function stillWaiting(index) {
  clearTimeout(waiting.stillTimer);
  waiting.stillTimer = setTimeout(() => {
    if (!waiting.open || waiting.stages[index]?.className !== 'now') return;
    const name = walletName();
    stageAt(index, { note: `Still waiting on ${name}. ${/\b1am\b/i.test(name) ? 'Use 1AM’s popup window: you don’t need the extension panel open. ' : ''}${askTwice(name) ? `${name} asks twice per transaction (the transaction, then the DUST choice)` : 'It may ask twice (1AM asks for the transaction and the DUST choice separately)'}: check its window.` });
  }, STILL_WAITING_MS);
}

/**
 * The window turns into the trouble window: what broke, the likely cause, what to do, and the wallet's own words in small
 * type. `retry` runs the same step again from a click; `reconnect` is for a wallet that dropped the page.
 */
export function trouble(explained, { retry = null, reconnect = false, revoke = null } = {}) {
  ensureWindow();
  if (!waiting.open) openWaiting({ title: explained.title, intro: '', total: 1, why: '' });
  clearInterval(waiting.clockTimer);
  expandWaiting(); // trouble is never a banner: it needs reading
  $('waiting').classList.add('failed');
  $('waiting').classList.toggle('no-answer', explained.kind === 'no-answer');
  $('waiting-title').textContent = explained.title;
  stageFailed();
  $('trouble-what').textContent = explained.what;
  $('trouble-cause').textContent = explained.cause;
  $('trouble-do').textContent = explained.todo;
  $('trouble-steps').replaceChildren(...(explained.steps ?? []).map((line) => { const li = document.createElement('li'); li.textContent = line; return li; }));
  $('trouble-steps').hidden = !explained.steps?.length;
  waiting.revoke = revoke;
  $('trouble-revoke').hidden = !revoke;
  $('trouble-raw').textContent = explained.raw;
  $('trouble').hidden = false;
  $('trouble-raw').hidden = false;
  waiting.retry = retry;
  $('trouble-retry').hidden = !(retry && explained.retry && !reconnect);
  $('trouble-retry').textContent = explained.kind === 'avatar' ? 'Pick an avatar' : 'Try again';
  $('reconnect').hidden = !reconnect;
  $('reconnect').disabled = false;
  $('reconnect').textContent = explained.kind === 'restarted' ? 'Try again' : 'Reconnect and try again';
  $('trouble-refresh').hidden = false;
  $('trouble-refresh').textContent = 'Refresh this page'; // an account change relabels it once; every other trouble refreshes
  $('trouble-refresh').onclick = null;
  settled();
  $('waiting-hide').hidden = false;
  $('waiting').hidden = false;
  $('waiting').scrollTop = 0;
}

/**
 * The wallet has gone silent: a real window with the steps, wherever that happened. Once, while it's showing, and never over something else the window is saying.
 * A late answer closes it. `retry` runs the same step again.
 */
function noAnswerWindow(retry, wallet = walletName()) {
  ensureWindow();
  if (waiting.open && !$('waiting').classList.contains('no-answer') && !$('waiting').classList.contains('failed') && state.running) return; // a plan owns the window, and reports this itself
  trouble(noAnswerSteps(wallet), { retry });
}
function closeNoAnswer() {
  if ($('waiting')?.classList.contains('no-answer')) hideWaiting();
}

const stageOfProgress = (text) => (/^Running the circuit/.test(text) ? 0 : /^Proving/.test(text) ? 1 : /^Approve in/.test(text) ? 2 : /sending it/.test(text) ? 3 : /Waiting for a block/.test(text) ? 4 : null);
const lineOfStage = (index, wallet, circuit) => [`building your ${nounOf(circuit)}`, `proving your ${nounOf(circuit)} (this takes a while)`, `waiting for ${wallet}${askTwice(wallet) ? ' (it asks twice)' : ''}`, 'sending to Midnight', 'waiting for the block (about a minute)', 'landed'][index];

/** The stage a call is at, in a few words, for the button that was pressed. */
export function stageWord(text) {
  const wallet = walletName();
  if (/^Running the circuit/.test(text)) return 'Running the circuit';
  if (/^Proving/.test(text)) return 'Proving (up to a minute)';
  if (/^Approve in/.test(text)) return `Approve in ${wallet}`;
  if (/sending it/.test(text)) return `${wallet} is sending it`;
  if (/Waiting for a block/.test(text)) return 'Sent. Waiting for a block';
  return text.replace(/\.$/, '');
}

// ---------- one call to the cage ----------

/**
 * Runs one circuit through the wallet and the chain, in the waiting window. Returns the result, or null when it failed: by
 * then the window says why. `tx` is "transaction k of n" for the line; `retry` is what Try again runs; `button` carries the stage.
 */
export async function run(label, circuit, args, sk, { tx = { k: 1, n: 1 }, retry = null, during = 'approve it', button = null, soft = null, stale = false, say = null, restarted = false } = {}) {
  if (state.busy || state.stopped || !state.session) return null;
  state.busy = true;
  emit();
  const started = Date.now();
  let approved = 0;
  let asked = 0;
  const wallet = walletName();
  const owned = !!button && button.getAttribute('aria-busy') !== 'true'; // a plan marks its own button busy and puts it back itself
  const was = button?.textContent ?? null;
  if (!waiting.open) openWaiting({ title: label, intro: `${sentence(promptsText({ approvals: 1, signature: false }, wallet))}. ${sentence(roughTime(roughSeconds({ moves: [{ kind: circuit === 'deposit' ? 'deposit' : circuit === 'withdraw' ? 'withdraw' : 'sit' }] })))}.`, total: 1 });
  setStages(TX_STAGES(wallet, circuit));
  const prefix = tx.n > 1 ? `transaction ${tx.k} of ${tx.n}: ` : '';
  const progress = (text) => {
    state.progress = `${label}: ${text}`;
    if (button) { button.setAttribute('aria-busy', 'true'); button.textContent = stageWord(text); }
    const index = stageOfProgress(text);
    if (index === null) { waitingLine(`${prefix}${text}`); return; }
    stageAt(index);
    // In plain words where the plan gave them (11-09): what the player is signing, then what is happening to their money.
    const plain = say && (index === 2 ? say.sign : index >= 3 ? say.send : null);
    waitingLine(plain ?? `${prefix}${lineOfStage(index, wallet, circuit)}`);
    if (index === 2) { stillWaiting(2); if (!asked) asked = Date.now(); }
    if (/sending it/.test(text)) { state.approvedAt = Date.now(); approved = state.approvedAt; } // the wallet said yes: for the timing of a sit
  };
  let result = null;
  let restart = null; // the wallet restarted before anything was sent: a fresh link and the same call once more, by itself (11-09)
  let staleRetry = false; // Custom error 170: the wallet spent from a DUST note it had already used. Nothing was sent, so the same call goes once more after 20 s (11-07).
  try {
    const input = typeof args === 'function' ? args() : args;
    const r = await state.session.call(CIRCUIT_OF[circuit] ?? circuit, sk, input, progress);
    const secs = (ms) => (ms / 1000).toFixed(1);
    const timing = approved ? ` Approved after ${secs(approved - started)} s, landed ${secs(Date.now() - approved)} s later.` : ` ${secs(Date.now() - started)} s.`;
    log(`${label}: landed in block ${r.blockHeight ?? '?'}, ${r.status ?? 'done'}. Transaction ${r.txHash ?? r.txId ?? '?'}.${timing}`);
    stageDone();
    waitingLine(`${prefix}landed in block ${r.blockHeight ?? '?'}`);
    result = r;
    // How long the chain and the prover took: not how long someone looked at the wallet's window.
    await addResult({ action: circuit, ms: Date.now() - started - (approved && asked ? approved - asked : 0), hash: r.txHash ?? null });
  } catch (e) {
    const text = errorText(e);
    const sent = !!state.session.sent?.();
    if (isSessionLost(e) && !sent && !restarted && isWalletRestarted(e)) {
      log(`${label}: ${wallet} restarted itself. Nothing was sent. Getting a fresh link to ${wallet} and trying once more.`, 'failed');
      restart = { error: e, deadApi: state.api };
    } else if (isSessionLost(e) && !sent) {
      log(`${label} paused: ${wallet} dropped the connection. Nothing was sent.`, 'failed');
      offerReconnect(retry ?? (() => run(label, circuit, args, myKey(), { tx, retry, during, button })), e, during);
    } else if (!sent && !stale && /custom error: 170/i.test(text)) {
      log(`${label}: ${wallet} was a step behind the chain (it built the transaction from a DUST note it had already spent: error 170). Nothing was sent. Trying again in 20 seconds.`, 'failed');
      staleRetry = true;
    } else {
      if (isSessionLost(e)) log(`${label}: ${wallet} dropped the connection after sending, so this page won’t send it again. Check the balance above before you try again. It may still land.`, 'failed');
      else log(`${label} failed: ${text}`, 'failed');
      if (soft?.(text)) state.softError = text; // the caller knows what this means: no window for it
      else trouble(explainTrouble(e, { wallet, during, sent }), { retry });
    }
  } finally {
    state.busy = false;
    state.progress = '';
    await refreshWallet();
    await refreshCage();
    if (button?.isConnected && owned && !staleRetry && !restart) {
      button.removeAttribute('aria-busy');
      if (was !== null) button.textContent = was;
    }
    emit();
  }
  if (restart) {
    const again = retry ?? (() => run(label, circuit, args, myKey(), { tx, retry, during, button, soft, say }));
    waitingLine(`${wallet} restarted itself: getting a fresh link and trying once more`);
    try { if (state.api === restart.deadApi) await reacquire(); } // refreshWallet may have done it already
    catch (e2) { if (!e2?.stopped) offerReconnect(again, e2?.noAnswer || e2?.gone ? e2 : restart.error, during); return null; }
    return run(label, circuit, args, sk, { tx, retry, during, button, soft, stale, say, restarted: true });
  }
  if (staleRetry) {
    stageAt(3, { note: 'Your wallet was a step behind the chain, trying again.' });
    waitingLine('your wallet was a step behind the chain, trying again in 20 seconds');
    if (button) button.textContent = 'Trying again';
    await new Promise((r) => setTimeout(r, 20000));
    return run(label, circuit, args, sk, { tx, retry, during, button, soft, stale: true, say });
  }
  return result;
}

// ---------- a wallet that drops the page halfway ----------

function offerReconnect(retry, error = null, during = 'answer') {
  state.lost = true;
  state.retry = retry;
  trouble(explainTrouble(error ?? Object.assign(new Error('Wallet UI disconnected'), { code: 'Disconnected' }), { wallet: walletName(), during }), { reconnect: true });
  emit();
}

// Runs from a click, because a wallet may need a pop-up to approve, and only runs the call again if nothing left the browser.
// Always a fresh link: window.midnight read again, connect() called again (reacquire). A slow approval still counts.
function onReconnect() {
  const name = state.wallet?.name ?? walletName();
  $('reconnect').disabled = true;
  $('trouble-do').textContent = `Waiting for ${name}… approve it there if it asks.`;
  const attempt = ++state.reconnects;
  const timer = setTimeout(() => {
    if (attempt !== state.reconnects || !state.lost) return;
    trouble({ ...noAnswerSteps(name), steps: [`Open ${name} from your browser’s toolbar.`, 'Unlock it, if it asks for your password.', 'Press Reconnect and try again, below.', 'Still nothing? Press Refresh this page. If even that doesn’t help, turn the extension off and on, then refresh.'] }, { reconnect: true });
  }, ANSWER_MS);
  reacquire({ waitMs: 0 }).finally(() => clearTimeout(timer)).then(async () => {
    if (attempt !== state.reconnects) return;
    hideWaiting();
    const retry = state.retry;
    state.retry = null;
    emit();
    if (retry) await retry();
  }).catch((e) => {
    if (attempt !== state.reconnects || e?.stopped) return;
    $('reconnect').disabled = false;
    $('trouble-do').textContent = e?.gone ? `${name} has gone from this page. Refresh, then check your balance.` : isWalletRestarted(e) ? `${name} restarted again. Click Try again once more, or refresh this page.` : `Couldn’t reconnect to ${name}: ${errorText(e)} Unlock it and try again.`;
  });
}

// ---------- the door ----------

export const doorToken = () => safe(() => localStorage.getItem(DOOR_KEY));
export const doorGood = () => state.door?.status === 'verified' && !state.door.expired && state.door.cageId === state.view?.id;
/**
 * Enough for a move, which asks nothing of the wallet (the 11-08 pass #23): a verified door session, with no wallet answering yet (1AM asleep in
 * the background held the Move button off until it woke). A wallet that has answered must be the one the session is for.
 */
export const doorUsable = () => state.door?.status === 'verified' && !state.door.expired && (!state.view || state.door.cageId === state.view.id);

/**
 * The drain switch, as the door reports it: read at start and on the page's usual poll, so a buy-in or a hop stops before the wallet is asked.
 * A switch flipped in the last poll interval can still let one deposit through: the Worker refuses the seat, and the money stays in the
 * cage until it's withdrawn or swept home. A failed read changes nothing.
 */
export async function loadDrain() {
  try {
    const res = await fetch('/door', { cache: 'no-store' });
    if (res.ok) state.draining = (await res.json()).draining === true;
  } catch { /* the Worker still refuses */ }
  emit();
  return !!state.draining;
}

export async function loadDoor() {
  const token = doorToken();
  if (!token) { state.door = null; emit(); return; }
  try {
    const res = await fetch('/door/me', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.status === 401) { safe(() => localStorage.removeItem(DOOR_KEY)); state.door = null; emit(); return; }
    state.door = await res.json();
    if (state.door.status === 'refused') { // not a problem with the table: the next signature is a fresh try
      state.doorTrouble = `The door refused this session: ${state.door.reason}`;
      safe(() => localStorage.removeItem(DOOR_KEY));
      state.door = null;
    }
  } catch { /* the next look will do */ }
  emit();
}

/** The one signature: this player key and this wallet, for a while. Returns true once the judge has verified it. */
export async function signDoor({ name, avatar = null, retry = null, status = () => {} } = {}) {
  const wallet = walletName();
  if (!name) { status('Type the name you’ll go by at the tables.'); hideWaiting(); return false; }
  // No door request goes out with a missing or invalid avatar (11-10): the saved one is checked, or the player picks one first.
  avatar = await ensureLook(avatar);
  if (!avatar) { status('Pick an avatar to sit down.'); hideWaiting(); return false; }
  if (typeof state.api.signData !== 'function') { trouble({ title: `${wallet} can’t sign`, what: `${wallet} can’t sign a message for a page, so it can’t come in here.`, cause: 'An older connector.', todo: `Update ${wallet}, or use another wallet.`, raw: 'signData is not a function', retry: false }, {}); return false; }
  state.doorTrouble = '';
  setStages(SIGN_STAGES(wallet));
  stageAt(0);
  stillWaiting(0);
  waitingLine(`signing in ${wallet}: one line, nothing moves`);
  status(`Approve in ${wallet}: it’s signing one line, and nothing moves.`);
  state.busy = true;
  emit();
  try {
    const p = permit(); // the session and the permit run out together, so a new visit is one thing to renew
    const expires = p.good && Number(p.until) > nowSecs() + 3600 && Number(p.until) <= nowSecs() + 86_000 ? Number(p.until) : nowSecs() + DOOR_SECS;
    const payout = [...state.session.payoutOf().bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const { address } = await (await fetch('/door', { cache: 'no-store' })).json(); // the cage this Hall's judge reads, so what's signed is what it checks
    const message = `sealed-hand:door:v1|${address}|${state.view.id}|${payout}|${expires}`;
    const signed = await state.api.signData(message, { encoding: 'text', keyType: 'unshielded' }); // a person may take a while: no time limit
    const res = await fetch('/door', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cageId: state.view.id, payout, expires, verifyingKey: signed.verifyingKey, signature: signed.signature, name, kind: 'human', ...(avatar ? { avatar } : {}) }),
    });
    const body = await res.json();
    if (!res.ok) { trouble({ title: 'The door refused', what: body.message ?? `The door refused (${res.status}).`, cause: 'The name or the signature didn’t pass.', todo: 'Try another name, or sign again.', raw: JSON.stringify(body), retry: true }, { retry }); return false; }
    safe(() => localStorage.setItem(DOOR_KEY, body.token));
    stageAt(1);
    waitingLine('the judge is checking the signature (a few seconds)');
    status('The judge is checking your signature. This takes a few seconds.');
    const started = Date.now();
    while (Date.now() - started < DOOR_WAIT_MS) {
      await loadDoor();
      if (state.door?.status === 'verified') break;
      if (!state.door || state.doorTrouble) { trouble({ title: 'The door refused', what: state.doorTrouble || 'The judge refused this signature.', cause: 'The signature didn’t match this wallet, or the cage shows no balance for this key.', todo: 'Try again. If it keeps failing, Refresh and check your balance under My cage.', raw: state.doorTrouble, retry: true }, { retry }); return false; }
      await new Promise((r) => setTimeout(r, DOOR_POLL_MS));
    }
    if (!doorGood()) { trouble({ title: 'The judge hasn’t answered', what: 'The signature went to the door, but the judge hasn’t checked it in 90 seconds.', cause: 'The judge is busy or down.', todo: 'Wait a minute, then Try again: the signature is kept, so it won’t ask twice.', raw: `door status ${state.door?.status ?? 'none'}`, retry: true }, { retry }); return false; }
    stageDone();
    flushTimings();
    waitingLine('signed in: every table takes you for 12 hours. That signature put nothing on chain.');
    log('Signed once at the door: every tNIGHT table takes you for the next 12 hours.');
    return true;
  } catch (e) {
    log(`${wallet} didn’t sign: ${errorText(e)}`, 'failed');
    if (isSessionLost(e)) offerReconnect(retry ?? (() => signDoor({ name, avatar, retry, status })), e, 'sign at the door');
    else trouble(explainTrouble(e, { wallet, during: 'sign one line at the door' }), { retry });
    return false;
  } finally {
    state.busy = false;
    emit();
  }
}

// ---------- the seat at a table ----------

export const seatedAt = (tableNo) => !!state.seat?.seated && state.view?.seat?.table === BigInt(tableNo);

/**
 * Claim a seat with the session from the door, then wait for the judge. No wallet involved. With `atRisk` this asks the judge to seat or move you under your
 * permit; with none, the seat is already on chain and the judge reads it. Resolves with the seat token once the judge has seated you, or rejects with a reason the
 * table or the judge gave. `onClaimed` runs once the claim is in, before the wait: a hop leaves its old table there, so the judge knows the next table first.
 */
export function claimSeat({ api, tableId, name = null, avatar = null, atRisk = null, onClaimed = async () => {}, onStep = () => {}, status = () => {} }) {
  const key = claimKey(tableId);
  return new Promise((resolve, reject) => {
    let timer;
    const poll = async () => {
      clearTimeout(timer);
      const token = safe(() => localStorage.getItem(key));
      if (!token) { reject(Object.assign(new Error('The claim was lost.'), { code: 'claim_lost' })); return; }
      try {
        const res = await fetch(`${api}/${tableId}/cage-seat`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
        if (res.status === 401) { safe(() => localStorage.removeItem(key)); reject(Object.assign(new Error('The table no longer knows this claim.'), { code: 'claim_lost' })); return; }
        const body = await res.json();
        if (body.step) onStep(body.step);
        if (body.status === 'seated') { safe(() => localStorage.removeItem(key)); state.lastSeatReceipt = body.receipt ?? null; resolve(token); return; }
        if (body.status === 'refused') { safe(() => localStorage.removeItem(key)); reject(Object.assign(new Error(`The judge refused this seat: ${body.reason}`), { code: 'refused', reason: body.reason, judgeCode: body.code ?? null })); return; }
      } catch { /* try again on the next beat */ }
      timer = setTimeout(poll, CLAIM_POLL_MS);
    };
    const claim = async () => {
      // A claim already on its way. A retry of a hop still has to tell the old table, or the player stays there.
      if (safe(() => localStorage.getItem(key))) { status('The judge is reading your seat from the cage.'); await onClaimed(); poll(); return; }
      avatar = await ensureLook(avatar); // never a seat request with a missing or invalid avatar (11-10)
      if (!avatar) { reject(Object.assign(new Error('You need an avatar to sit down.'), { code: 'no_avatar' })); return; }
      const res = await fetch(`${api}/${tableId}/cage-seat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doorToken: doorToken(), kind: 'human', ...(name ? { name } : {}), ...(avatar ? { avatar } : {}), ...(state.approvedAt ? { approvedAt: state.approvedAt } : {}), ...(atRisk ? { atRiskStar: String(atRisk) } : {}) }),
      });
      const body = await res.json();
      if (!res.ok && body.error === 'claim_pending' && safe(() => localStorage.getItem(key))) { poll(); return; }
      if (!res.ok) {
        if (body.error === 'door_expired' || body.error === 'door_required') { safe(() => localStorage.removeItem(DOOR_KEY)); state.door = null; }
        reject(Object.assign(new Error(body.message ?? `The table refused (${res.status}).`), { code: body.error ?? 'refused' }));
        return;
      }
      safe(() => localStorage.setItem(key, body.token));
      status(atRisk ? 'The judge is seating you. Nothing to approve.' : 'The judge is reading your seat from the cage.');
      await onClaimed();
      poll();
    };
    claim().catch((e) => reject(Object.assign(new Error('Couldn’t reach the table. Try again.'), { code: 'network', cause: e })));
  });
}

/** What the judge's refusal or the table's means, for the window. */
function seatTrouble(e, { topup = false } = {}) {
  const name = walletName();
  if (e.judgeCode === 'need_grant') return { title: 'One more approval', what: e.reason, cause: 'A permit lets the judge seat you without asking, up to a cap and for a while. This one can’t cover this seat.', todo: `Try again: one approval in ${name} grants a new one, and the judge seats you.`, raw: e.reason ?? '', retry: true };
  if (e.judgeCode === 'judge_no_dust') return { title: 'The judge can’t pay for this seat', what: e.reason, cause: 'Seats made by the judge cost it DUST, and it’s keeping what it has for settling rounds.', todo: `Try again to sit for yourself: one approval in ${name}.`, raw: e.reason ?? '', retry: true };
  if (e.judgeCode === 'table_closed') return { title: 'That table closed', what: e.reason, cause: 'The table went quiet on chain before your seat was ready.', todo: 'Pick another table in the Hall. Nothing to approve there if your permit is good.', raw: e.reason ?? '', retry: false };
  if (e.judgeCode === 'seat_failed' || e.judgeCode === 'seat_timeout') return { title: 'The judge couldn’t seat you', what: e.reason, cause: 'The cage changed while the seat was on its way, or the old table took too long to finish.', todo: 'Try again. Your balance is as the cage shows.', raw: e.reason ?? '', retry: true };
  if (e.code === 'refused') return { title: 'The judge refused the seat', what: e.message, cause: 'The seat on chain didn’t match what the table expected, or the table moved on.', todo: 'Your balance is as the cage shows. Try another table from the Hall, or Stand if a seat is still held.', raw: e.reason ?? '', retry: false };
  if (e.code === 'bad_avatar' || e.code === 'no_avatar') return { kind: 'avatar', title: 'Pick an avatar', what: 'You need an avatar to sit down.', cause: 'This player has no avatar the table accepts. Nothing was sent, and nothing was spent.', todo: 'Pick one, and the seat goes on. It follows you to every table.', raw: e.code, retry: true, reconnect: false };
  if (e.code === 'name_taken' || e.code === 'name_reserved') return { title: 'That name is taken here', what: e.message, cause: 'Someone at this table already goes by it.', todo: 'Try again with another name.', raw: e.code, retry: true };
  if (e.code === 'table_started') return { title: 'The table didn’t take the seat', what: `${e.message} Your seat on chain is still held.`, cause: 'The table left its lobby while the seat went on chain.', todo: topup ? 'Pick a table in the Hall that is seating; this balance sits there with one approval.' : 'Stand under My cage on the cage page and the judge frees the seat at its next settle, then pick a table in the Hall.', raw: e.code, retry: false };
  return { title: 'The table didn’t take the seat', what: e.message, cause: 'The table changed while the seat went on chain, or the Hall couldn’t be reached.', todo: 'Try again. If it keeps failing, Refresh and check your balance on the cage page.', raw: e.code ?? '', retry: true };
}

// ---------- the plans ----------

/**
 * Stand up on chain: the judge sees it, the table has you leave after this round, and the next settle frees the seat. A stand ends the permit.
 * If it fails because the seat moved, it tries once more. If it fails again, something is wrong, because an honest judge moves a seat only when asked, so it offers
 * the way that can't be blocked: revoke, then stand. "Already standing" is done, not an error.
 */
export async function standUp({ tx = { k: 1, n: 1 }, retry = null, button = null, status = () => {}, again = false } = {}) {
  const table = state.view?.seat?.table;
  if (table === undefined) return true; // the seat has gone: there's nothing to stand from
  status(`Step: stand up from table ${table}. Approve it in ${walletName()}.`);
  state.softError = null;
  const moved = (text) => alreadyStanding(text) || seatMovedError(text);
  const r = await run(`Stand from table ${table}`, 'stand', () => [state.view?.seat?.table ?? table, declaredNow()], myKey(), { tx, retry, during: 'approve standing up', button, soft: moved,
    say: { sign: `You’re signing to stand up from table ${table}. Nothing leaves the cage yet: the judge frees your seat after your last round.`, send: `Standing up from table ${table} on Midnight…` } });
  if (r) return true;
  const why = state.softError;
  state.softError = null;
  if (!why) return false; // the window has said what went wrong
  await refreshCage();
  if (alreadyStanding(why) || state.seat?.standing || !state.seat?.seated) return true;
  if (!again) { status('The seat moved under that stand. Trying once more.'); return standUp({ tx, retry, button, status, again: true }); }
  trouble({
    title: 'Your seat keeps moving',
    what: `Standing failed twice, because the seat moved each time. You’re now at table ${state.view.seat.table}.`,
    cause: 'The judge moves a seat only when you ask it to, so a repeat means something is wrong: its key may have been stolen. The most it can take is your permit’s cap, plus anything you’ve won under it.',
    todo: `Revoke the permit, then stand: two approvals in ${walletName()}. Nothing the judge does can stop a revoke, and once it lands the judge can’t move you.`,
    raw: why,
    retry: false,
  }, { revoke: () => revokeThenStand({ retry, button, status }) });
  return false;
}

/** Ends the permit. "No permit" means it was already done. True once there's none. */
export async function revokePermit({ tx = { k: 1, n: 1 }, retry = null, button = null, status = () => {} } = {}) {
  status(`Step: revoke your permit. Approve it in ${walletName()}.`);
  state.softError = null;
  const r = await run('Revoke the judge’s permit', 'revoke', REVOKE_ARGS, myKey(), { tx, retry, during: 'approve the revoke', button, soft: alreadyRevoked,
    say: { sign: 'You’re signing to end the judge’s permit. Nothing leaves the cage.', send: 'Ending the permit on Midnight…' } });
  const done = !!r || alreadyRevoked(state.softError);
  state.softError = null;
  return done;
}

/** The fallback: a revoke can't be knocked out, and the stand after it can't be moved out from under. Then whatever was running picks up from where the cage is. */
async function revokeThenStand({ retry = null, button = null, status = () => {} } = {}) {
  openWaiting({ title: 'Revoking your permit, then standing', intro: `${sentence(promptsText({ approvals: 2, signature: false }))}. Your balance can only go back to your own wallet.`, total: 2 });
  const again = () => revokeThenStand({ retry, button, status });
  if (!(await revokePermit({ tx: { k: 1, n: 2 }, retry: again, button, status }))) return false;
  await refreshCage();
  if (state.seat?.seated && !state.seat.standing && !(await standUp({ tx: { k: 2, n: 2 }, retry: again, button, status, again: true }))) return false;
  if (retry) { hideWaiting(); retry(); } else { waitingLine('your permit is ended and you’re standing: the judge frees the seat at its next settle'); settled(); }
  return true;
}

/** Waits for the judge to free the seat, reading the cage every few seconds and counting up. True once it is free. */
export async function waitFree({ retry = null, status = () => {} } = {}) {
  setStages(FREE_STAGES());
  stageAt(0);
  const started = Date.now();
  const sofar = () => { const s = Math.round((Date.now() - started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const line = () => `waiting for the judge to free the seat: ${sofar()} so far. It comes as soon as your last round is settled: about a minute, two if a round was still on.`;
  waitingLine(line());
  status('The judge frees the seat once your last round is settled, about a minute. This page checks every 5 seconds.');
  const until = (state.seat?.freeAt ?? 0) * 1000 || started + 35 * 60 * 1000;
  const tick = setInterval(() => { if ($('waiting-line')) $('waiting-line').textContent = line(); }, 1000);
  try {
    while (Date.now() < until + 60 * 1000) {
      await refreshCage();
      if (!state.seat?.seated) { stageDone(); waitingLine('the seat is free'); return true; }
      await new Promise((r) => setTimeout(r, SEATED_POLL_MS));
    }
  } finally { clearInterval(tick); }
  trouble({ title: 'The seat didn’t free', what: 'The table went quiet without the judge freeing the seat.', cause: 'The judge is down, or the table died.', todo: 'Try again: the cage frees a seat itself once the table has gone quiet, and this picks up from there.', raw: state.seat?.text ?? '', retry: true }, { retry });
  return false;
}

/**
 * Buy in, as one plan in the window: stand and wait if topping up at a held seat, the deposit if the cage is short, the door's
 * one signature if there is none, the seat, then the judge. With no table (`table` null) it is the Hall's door: deposit and sign.
 * `amount` is the whole buy-in (at risk at a table). Resolves with the seat token when the judge has seated you, with 'hall'
 * when the money is in and the seat has to come from the Hall, with 'done' for the door, or null when something stopped it.
 */
export async function buyIn({ amount, table = null, tableId = null, game = null, name = '', avatar = null, topup = false, button = null, status = () => {}, brought = false, selfSit = false }) {
  if (state.running || state.busy || state.stopped || !state.session || !state.view) return null;
  state.running = true;
  await refreshCage(); // the judge may have seated, moved or freed them since this page last looked
  loadDrain(); // not waited for: the plan below uses what the page already knows, and the next try sees this
  state.running = false;
  const wallet = walletName();
  const tableNo = table ? BigInt(table.cage.table) : null;
  const plan = buyPlan({
    amount, dustReady: dustReady(), wallet: walletName(), cage: balance(), night: state.night, ante: Number(table?.limits.ante ?? 5), potLimit: table ? seatMost(table) : null,
    signed: doorGood(), table: tableNo, seated: tableNo ? seatedAt(tableNo) : false, standing: !!state.seat?.standing, brought, topup, canSit: !(topup && table && !table.cage.joinable),
    permit: permit(), bound: !!state.seat?.seated, canLeave: !!(tableId && seatTokenAt(tableId)), selfSit, draining: !!state.draining,
  });
  if (plan.why) { status(plan.why); return null; }
  const txs = plan.approvals;
  openWaiting({
    title: table ? `${topup && seatedAt(tableNo) ? 'Leaving and sitting again' : 'Sitting'} at table ${table.cage.table} with ${nightText(amount)}` : `Bringing ${nightText(amount)} to the Hall`,
    why: table ? WHY.chain : WHY.door,
    intro: `${sentence(promptsText(plan, wallet))}. ${sentence(roughTime(roughSeconds(plan, { warm: !!table?.cage.warm })))}.`,
    total: plan.moves.length,
    banner: table && plan.approvals === 0 && !plan.signature ? `Taking your seat on Midnight… (nothing to approve)` : null,
  });
  state.running = true;
  state.lastWord = '';
  state.broughtNow = 0n;
  emit();
  if (button) { button.setAttribute('aria-busy', 'true'); button.disabled = true; }
  const label = button?.textContent ?? '';
  const args = { amount, table, tableId, game, name, avatar, topup, button, status, selfSit };
  const retry = () => { hideWaiting(); buyIn({ ...args, brought: args.brought }); };
  const word = (text) => { if (button) button.textContent = text; };
  try {
    let k = 0;
    for (const move of plan.moves) {
      if (move.kind === 'stand') {
        k += 1;
        if (!state.seat?.seated || state.seat.standing) continue;
        word('Standing up');
        if (!(await standUp({ tx: { k, n: txs }, retry, button, status }))) return null;
      } else if (move.kind === 'leave') { // the table's own Leave: nothing to approve, and the permit stays. The judge frees the seat when the round is over
        word('Leaving the table');
        status('Leaving the table. Your round finishes first if one is on.');
        waitingLine('leaving the table: the judge frees the seat when your round is over');
        const left = await fetch(`${game.api}/${tableId}/leave`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${seatTokenAt(tableId)}` }, body: '{}' }).catch(() => null);
        if (!left || (!left.ok && left.status >= 500)) { trouble({ title: 'The table didn’t answer', what: 'This page couldn’t tell the table you’re leaving. Nothing has changed.', cause: 'The network, or the Hall.', todo: 'Try again.', raw: `status ${left?.status ?? 'none'}`, retry: true }, { retry }); return null; }
        safe(() => localStorage.removeItem(seatKey(tableId)));
        waiting.done += 1;
        bar();
      } else if (move.kind === 'free') {
        if (!state.seat?.seated) { waiting.done += 1; bar(); continue; }
        word('Waiting for the judge');
        if (!(await waitFree({ retry, status }))) return null;
      } else if (move.kind === 'deposit') {
        k += 1;
        const before = balance();
        const short = table ? (amount > before ? amount - before : move.grant ? move.amount : 0n) : move.amount; // what the cage is short now: a settle may have moved it
        if (short === 0n) { waiting.done += 1; bar(); continue; }
        const cap = table ? amount : before + short;
        word(`Putting ${fmtNight(short)} in the cage`);
        status(`Step: put ${fmtNight(short)} tNIGHT in the cage, and let the judge seat you with up to ${fmtNight(cap)} at risk. Approve it in ${wallet}.`);
        const sk = myKey() ?? newKey();
        const r = await run(`Put ${nightText(short)} in the cage`, 'deposit', () => depositArgs(short, cap), sk, { tx: { k, n: txs }, retry, during: 'approve the deposit', button,
          say: { sign: `You’re signing to put ${nightText(short)} from your wallet in the cage.`, send: `Putting ${nightText(short)} in the cage…` } });
        if (!r) return null;
        if (!(balance() >= before + short)) { trouble({ title: 'The deposit didn’t show', what: 'The transaction landed, but the cage doesn’t show the new balance yet.', cause: 'An indexer behind the chain.', todo: 'Wait a moment, then Try again: the plan picks up from the balance it reads.', raw: `balance before ${before}, after ${balance()}`, retry: true }, { retry }); return null; }
        state.broughtNow += short;
        addBrought(short);
        if (!table) args.brought = true; // the door's money is in: a retry won't put it in twice
      } else if (move.kind === 'sign') {
        if (doorGood()) continue;
        word(`Waiting for ${wallet}`);
        if (!(await signDoor({ name, avatar, retry, status }))) return null;
      } else if (move.kind === 'sit') {
        if (seatedAt(tableNo) && !topup) continue;
        if (topup) {
          const fresh = await fetch(`${game.api}/${tableId}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (!fresh?.cage?.joinable) { hallInstead(status); return 'hall'; }
        }
        if (seatedAt(tableNo)) { trouble({ title: 'The seat is still held', what: 'The judge hasn’t freed the old seat yet, so a new one can’t go on chain.', cause: 'The settle that frees it hasn’t happened.', todo: 'Wait a minute, then Try again: the plan picks up where it was.', raw: state.seat?.text ?? '', retry: true }, { retry }); return null; }
        k += 1;
        if (balance() < amount) { trouble({ title: 'The cage holds less than the seat needs', what: `The cage shows ${nightText(balance())}, and the seat needs ${nightText(amount)}.`, cause: 'The balance changed, or an indexer is behind the chain.', todo: 'Wait a moment, then Try again: the plan picks up from the balance it reads.', raw: `balance ${balance()}, risk ${amount}`, retry: true }, { retry }); return null; }
        word('Taking the seat');
        status(`Step: take the seat with ${fmtNight(amount)} tNIGHT at risk. Approve it in ${wallet}.`);
        const r = await run(`Sit at table ${tableNo} with ${nightText(amount)}`, 'sit', () => [tableNo, amount, declaredNow()], myKey(), { tx: { k, n: txs }, say: { sign: `You’re signing to sit at table ${tableNo} with ${nightText(amount)} at risk.`, send: `Taking your seat at table ${tableNo} on Midnight…` }, retry, during: 'approve the seat', button });
        if (!r) return null;
      } else if (move.kind === 'judge') {
        const seats = !!move.seats && !seatedAt(tableNo); // nothing asked of the wallet: the judge seats them under the permit
        if (topup) {
          const fresh = await fetch(`${game.api}/${tableId}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (!fresh?.cage?.joinable) { hallInstead(status); return 'hall'; }
        }
        word(seats ? 'The judge is seating you' : 'The judge is reading your seat');
        setStages(JUDGE_STAGES(seats));
        stageAt(seats ? 0 : 1);
        waitingLine(seats ? `the judge seats you with ${nightText(amount)} at risk: nothing to approve` : 'the judge is reading your seat from the cage');
        status(seats ? 'The judge is seating you under your permit. Nothing to approve. About a minute.' : 'The judge is reading your seat from the cage. Under a minute on a warm table; about two if it has to put the house float on chain first.');
        try {
          const token = await claimSeat({ api: game.api, tableId, name: name || null, avatar, atRisk: seats ? amount : null, status, onStep: seats ? judgeSteps(0) : undefined });
          setStages(JUDGE_STAGES(seats));
          stageDone();
          waiting.done = waiting.total; // the whole plan is done
          bar();
          await refreshCage();
          if (seats && state.lastSeatReceipt) await addResult({ action: state.lastSeatReceipt.kind ?? 'seat', ms: state.lastSeatReceipt.ms, hash: state.lastSeatReceipt.tx?.hash, report: false });
          settled();
          waitingLine('seated: here comes the deal');
          $('waiting-title').textContent = 'Seated';
          bannerDone('Seated');
          state.lastWord = '';
          return token;
        } catch (e) {
          status(e.message);
          const fallback = e.judgeCode === 'judge_no_dust' ? () => { hideWaiting(); buyIn({ ...args, brought: args.brought, selfSit: true }); } : retry;
          if (e.code === 'refused') await refreshCage();
          trouble(seatTrouble(e, { topup }), { retry: e.code === 'name_taken' || e.code === 'name_reserved' || e.code === 'network' || ['need_grant', 'judge_no_dust', 'seat_failed', 'seat_timeout'].includes(e.judgeCode) ? fallback : null });
          return null;
        }
      }
    }
    // Nothing left to do: the door path ends here.
    $('waiting-title').textContent = 'Done';
    if (state.broughtNow > 0n) await refreshWallet(); // the wallet's balance after the deposit, for the line below
    const landed = state.broughtNow > 0n ? `Brought ${nightText(state.broughtNow)} to the Hall. In the cage: ${fmtNight(balance())}. Your wallet: ${fmtNight(state.night ?? 0n)}.` : `You’re in, with ${nightText(balance())} in the cage.`;
    state.lastWord = `${landed} Pick a table in the Hall: the judge seats you, with nothing to approve.`;
    waitingLine(landed);
    status(state.lastWord);
    settled();
    return 'done';
  } finally {
    state.running = false;
    if (button?.isConnected) { button.removeAttribute('aria-busy'); button.textContent = label; }
    emit();
  }
}

/** A top-up whose table has moved on: the money is in the cage, and the seat comes at a table that is seating, from the Hall. */
function hallInstead(status) {
  state.lastWord = `${nightText(balance())} is in the cage. This table has moved on, so it can’t take a new seat: pick a table in the Hall, and the judge seats you there, with nothing to approve.`;
  $('waiting-title').textContent = 'Money in the cage';
  waitingLine(state.lastWord);
  settled();
  status(state.lastWord);
}

/** The window's stages follow what the judge says it's doing. `base` is where its first step sits in the list. */
const judgeSteps = (base, words = null) => (step) => {
  const at = { proving: base + (base === 0 ? 1 : 0), sent: base + (base === 0 ? 3 : 2) }[step];
  if (at === undefined) return;
  stageAt(at);
  waitingLine(words?.[step] ?? (step === 'sent' ? 'sent to Midnight: waiting for the block' : 'the judge is proving it'));
};

/** The most the judge can seat this player with at a table, given what's left on the permit and the table's limit. Null if it can't: it takes an approval. */
export function hopAmount(table) {
  const p = permit();
  if (!p.good || !doorUsable()) return null;
  const limit = BigInt(seatMost(table)) * WHOLE_CHIP;
  const most = limit < p.room ? limit : p.room;
  return most >= BigInt(table?.limits?.ante ?? 1) * WHOLE_CHIP ? most : null;
}

/**
 * Finds the table holding this player's seat, so a page can offer to bring them from there. Looked up once per seat, from the Hall's list and this browser's seat token.
 * Null when this browser can't reach it.
 */
export async function findHopSource() {
  const seat = state.view?.seat;
  if (!seat || !state.seat?.seated) { state.hopFrom = null; return null; }
  if (state.hopFrom?.cageTable === String(seat.table)) return state.hopFrom;
  if (state.hopLooked === String(seat.table)) return null;
  state.hopLooked = String(seat.table);
  const { games = [] } = await fetch('/games', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  for (const game of games) {
    const row = game.tables?.find((t) => String(t.table) === String(seat.table));
    const token = row && seatTokenAt(row.id);
    if (token) { state.hopFrom = { api: game.api, page: game.page, name: game.name, tableId: row.id, token, cageTable: String(seat.table) }; emit(); return state.hopFrom; }
  }
  return null;
}

/**
 * A hop: one table to another with nothing to approve. The next table is asked first, so the judge knows it when this table lets the player go, then the old table hears
 * the player is moving. The judge settles what's owed there, then moves the seat in one transaction: no release, and no gap. Resolves with the seat token at the new table.
 * `from` is { api, tableId, token, cageTable } and `to` is { api, page, name, tableId, table }.
 */
export async function hop({ from, to, name = null, avatar = null, button = null, status = () => {} }) {
  if (state.running || state.busy || state.stopped) return null;
  if (state.draining) { status(DRAIN_TEXT); return null; } // a hop is a new seat, and the drain takes none. Nothing to approve here, and the Worker refuses the seat anyway
  const amount = hopAmount(to.table);
  if (amount === null) {
    trouble({ title: 'This move needs an approval', what: 'Your permit can’t place enough at that table, or it has run out, or your session at the door has.', cause: 'A permit lets the judge seat you up to a cap, for 12 hours. The cage takes no deposit while a seat holds your balance, so a new one has to wait until you’ve left this table.', todo: 'Leave this table, then sit at the other one: one approval there, and you’re back to none.', raw: permit().why ?? 'room', retry: false }, {});
    return null;
  }
  state.running = true;
  emit();
  startInFlight({ kind: 'move', to: { api: to.api, page: to.page, name: to.name, tableId: to.tableId, table: to.table.cage.table }, fromTableId: from.tableId }); // any other page shows it, and finishes it
  const label = button?.textContent ?? '';
  if (button) { button.setAttribute('aria-busy', 'true'); button.disabled = true; button.textContent = 'Moving your seat'; }
  openWaiting({ title: `Moving to ${to.name}, table ${to.table.cage.table}`, intro: `Nothing to approve. Your round here finishes first, if one is on. The judge settles it, then moves your seat, with ${nightText(amount)} at risk. Usually a minute or two.`, total: 1 , banner: `Moving your seat to ${to.name} on Midnight… (nothing to approve)` });
  setStages(HOP_STAGES());
  stageAt(0);
  const retry = () => { hideWaiting(); hop({ from, to, name, avatar, button, status }); };
  try {
    const token = await claimSeat({
      api: to.api, tableId: to.tableId, name, avatar, atRisk: amount, status,
      onStep: judgeSteps(2, { proving: `The judge is moving your seat to ${to.name}, table ${to.table.cage.table}. Nothing to approve.`, sent: 'Your move is on its way to Midnight: one block, about 30 s.' }),
      onClaimed: async () => {
        const left = await fetch(`${from.api}/${from.tableId}/leave`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${from.token}` }, body: JSON.stringify({ moving: true }) });
        const body = await left.json().catch(() => ({}));
        if (!left.ok && body.error !== 'already_left' && body.error !== 'table_over') throw Object.assign(new Error(body.message ?? `The old table refused (${left.status}).`), { code: 'leave_failed' });
        stageAt(1);
        waitingLine(body.queued ? `Your round at this table finishes first, then the judge moves your seat to ${to.name}.` : `The judge is settling this table, then moves your seat to ${to.name}.`);
      },
    });
    safe(() => localStorage.removeItem(seatKey(from.tableId)));
    state.hopFrom = null;
    setStages(HOP_STAGES());
    stageDone();
    waiting.done = waiting.total;
    bar();
    await refreshCage();
    waitingLine(`Seated at ${to.name}, table ${to.table.cage.table}, with ${nightText(amount)} at risk. Nothing to approve.`);
    $('waiting-title').textContent = 'Seated';
    bannerDone('Seated at the new table');
    if (state.lastSeatReceipt) await addResult({ action: state.lastSeatReceipt.kind ?? 'move', ms: state.lastSeatReceipt.ms, hash: state.lastSeatReceipt.tx?.hash, report: false });
    stashResults();
    log(`Moved to table ${to.table.cage.table} with nothing to approve.`);
    return token;
  } catch (e) {
    status(e.message);
    if (e.code === 'refused') await refreshCage();
    trouble(seatTrouble(e), { retry: e.code === 'name_taken' || e.code === 'network' || e.judgeCode === 'seat_failed' || e.judgeCode === 'seat_timeout' ? retry : null });
    return null;
  } finally {
    endInFlight();
    state.running = false;
    if (button?.isConnected) { button.removeAttribute('aria-busy'); button.disabled = false; button.textContent = label; }
    emit();
  }
}

/** Cash out, in one go: stand if a seat holds the balance, wait for the judge, withdraw everything. Ends with the money in the wallet. */
export async function cashOut({ button = null, status = () => {}, amount = null } = {}) {
  if (state.running || state.busy || state.stopped || !state.session || !state.view) return null;
  // The judge seats and moves people with nothing from this page, so what it last read may be old. A plan starts from the chain.
  state.running = true;
  await refreshCage();
  state.running = false;
  const wallet = walletName();
  const cash = cashPlan({ balance: balance(), seated: !!state.seat?.seated, standing: !!state.seat?.standing, dustReady: dustReady(), wallet: walletName() });
  if (cash.why) { status(cash.why); return null; }
  const want = amount && amount > 0n && amount < balance() ? amount : null; // part of it (11-07: "Cash out how much?"); null is all of it
  if (want) cash.amount = want;
  state.cashAmount = cash.amount;
  openWaiting({ why: WHY.cash, title: `Cashing out ${nightText(cash.amount)}`, intro: `${sentence(promptsText(cash, wallet))}. ${sentence(roughTime(roughSeconds(cash)))}. It can only go back to your own wallet.`, total: cash.moves.length });
  startInFlight({ kind: 'cashout', amount: fmtNight(cash.amount), phase: cash.moves[0]?.kind === 'stand' ? 'standing' : cash.moves[0]?.kind === 'free' ? 'freeing' : 'withdrawing' }); // any other page shows it as a banner
  state.running = true;
  state.lastWord = '';
  emit();
  if (button) { button.setAttribute('aria-busy', 'true'); button.disabled = true; }
  const label = button?.textContent ?? '';
  const retry = () => { hideWaiting(); cashOut({ button, status, amount }); };
  const txs = cash.approvals;
  const word = (text) => { if (button) button.textContent = text; };
  try {
    let k = 0;
    for (const move of cash.moves) {
      if (move.kind === 'stand') {
        k += 1;
        if (!state.seat?.seated || state.seat.standing) continue;
        word('Standing up');
        updateInFlight({ phase: 'standing' });
        if (!(await standUp({ tx: { k, n: txs }, retry, button, status }))) return null;
      } else if (move.kind === 'free') {
        if (!state.seat?.seated) continue;
        word('Waiting for the judge');
        updateInFlight({ phase: 'freeing' });
        if (!(await waitFree({ retry, status }))) return null;
      } else if (move.kind === 'withdraw') {
        k += 1;
        const amount = want && want <= balance() ? want : balance(); // what was asked for, or what the cage holds now: a settle may have moved it
        if (amount <= 0n) { trouble({ title: 'Nothing to withdraw', what: 'The cage shows no balance for this key now.', cause: 'The last settle took it, or an indexer is behind the chain.', todo: 'Refresh and look at the cage page.', raw: `balance ${amount}`, retry: false }, {}); return null; }
        state.cashAmount = amount;
        word(`Withdrawing ${fmtNight(amount)}`);
        status(`Step: withdraw ${fmtNight(amount)} tNIGHT to your wallet. Approve it in ${wallet}.`);
        updateInFlight({ phase: 'withdrawing', amount: fmtNight(amount) });
        const nightBefore = state.night;
        const r = await run(`Withdraw ${nightText(amount)}`, 'withdraw', [amount], myKey(), { tx: { k, n: txs }, retry, during: 'approve the withdrawal', button,
          say: { sign: `You’re signing to cash out ${nightText(amount)} to your wallet.`, send: `Sending ${nightText(amount)} back to your wallet…` } });
        if (!r) return null;
        // The wallet can be a few seconds behind the block: give it a moment to show the money before saying what it holds.
        for (let i = 0; i < 5 && nightBefore !== null && state.night !== null && state.night < nightBefore + amount; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          await refreshWallet();
        }
        const left = balance();
        const shows = nightBefore === null || state.night === null || state.night >= nightBefore + amount;
        const inWallet = state.night === null ? '' : ` Your wallet: ${fmtNight(state.night)}${shows ? '' : ` (the ${fmtNight(amount)} is still on its way to it)`}.`;
        const brought = broughtSoFar();
        const session = brought !== null && brought > 0n ? ` ${sessionLine(brought, amount, left)}` : '';
        if (left === 0n) clearBrought(); // the cage is empty: the next deposit starts a new session
        $('waiting-title').textContent = 'Done';
        state.lastWord = `Cashed out ${nightText(amount)}.${inWallet} Left in the cage: ${fmtNight(left)}.${session}`;
        waitingLine(state.lastWord);
        status(state.lastWord);
        settled();
        log(`Cashed out: ${state.lastWord}`);
        return amount;
      }
    }
    return null;
  } finally {
    endInFlight(); // done, or stopped with the window saying why: either way no banner elsewhere
    state.running = false;
    state.cashAmount = null;
    if (button?.isConnected) { button.removeAttribute('aria-busy'); button.textContent = label; }
    emit();
  }
}

// ---------- start ----------

/** Starts looking for wallets and keeps the cage fresh. Call once per page. */
export function start() {
  ensureWindow();
  showStashedResults();
  loadDoor();
  loadDrain();
  watchWallets();
  // A seat frees itself when the judge settles or releases it, with nothing happening on this page, so keep the balance fresh.
  setInterval(() => { if (state.session && !state.busy && !state.running && state.seat?.seated) refreshCage(); }, SEATED_POLL_MS);
  setInterval(() => { if (state.session && !state.busy && !state.running && !state.seat?.seated) refreshCage(); }, CAGE_POLL_MS); // and the judge can seat them with nothing happening here
  setInterval(retrySession, CAGE_POLL_MS);
  setInterval(() => { if (!state.running && !state.busy) loadDrain(); }, CAGE_POLL_MS);
}

export { approvalsText, buyPlan, cashPlan, fmtNight, WHOLE_CHIP };
