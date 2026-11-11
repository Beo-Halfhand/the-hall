// The Cage page: the wallet, the money in and out, the player key. One path: choose a wallet, buy in (or bring tNIGHT to the
// Hall), the judge seats you (or go to the Hall). The cage itself, the window and the plans live in cage-session.js and are
// shared with the table pages, which seat a player in place; the tiles and the one button in buy-in.js.

import * as cage from './cage-session.js';
import { mountBuyIn, mountConnectStatus, mountPicker } from './buy-in.js';
import { mountSupport } from './support.js';
import { mountNav } from './nav.js';
import { fmtNight, grantLimitText, parseKey, parseNight, seatView } from './wallet-core.js';

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const { state } = cage;

const query = new URLSearchParams(location.search);
const BRING_ID = /^[0-9a-f]{64}$/.exec(query.get('table') ?? '')?.[0] ?? null; // a table's link, as the pages had it
const BRING_GAME = query.get('game') === 'cup-and-claim' ? { api: '/dice-tables', page: '/dice', name: 'Cup & Claim' } : { api: '/tables', page: '/table', name: 'Sealed Hand' };
const TOPUP = query.has('topup');
const CASHOUT = query.has('cashout');
const WHOLE_CHIP = 1_000_000n;

const bring = { table: null, problem: '', avatar: null, hallName: '', cashStarted: false };
/** The Hall opens the way they play. Money in the cage is tNIGHT: the Hall's greeting and banner say so, not the chip purse. */
const playTnight = () => safe(() => localStorage.setItem('hall.mode', 'tnight'));
let buy = null;

// ---------- the table this page is for, if any ----------

async function loadBringTable() {
  const res = await fetch(`${BRING_GAME.api}/${BRING_ID}`, { cache: 'no-store' });
  if (res.status === 404) throw new Error('That table isn’t here any more.');
  if (!res.ok) throw new Error(`The table didn’t answer (${res.status}).`);
  const view = await res.json();
  if (!view.cage) throw new Error('That table plays on chips. It takes no tNIGHT.');
  bring.table = view;
  $('bring-title').textContent = `Bring tNIGHT to table ${view.cage.table}`;
  const { ante, raiseLimit, potLimit } = view.limits;
  $('bring-stakes').textContent = `${BRING_GAME.name}. Ante ${ante}. Raises 1 to ${raiseLimit}.${potLimit ? ` Pot limit ${potLimit}.` : ''} One chip is one tNIGHT. Preprod only: no real money.`;
  buy?.setTable(view);
  return view;
}

/** Fills in the name and look a player already goes by in the Hall. They can change the name. */
async function nameFromHall() {
  const token = safe(() => localStorage.getItem('hall.player'));
  if (!token) return;
  try {
    const res = await fetch('/players/me', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const player = await res.json();
    bring.hallName = player.name ?? '';
    bring.avatar = player.avatar ?? null; // the look they picked at the door comes to the table with them
    render();
  } catch { /* they can type it */ }
}

function goToTable(token) {
  cage.stashResults();
  safe(() => localStorage.setItem(cage.seatKey(BRING_ID), token));
  location.href = `${BRING_GAME.page}?id=${BRING_ID}`;
}

const seatedHere = () => !!BRING_ID && !!bring.table && cage.seatedAt(BRING_ID && bring.table.cage.table);
const untilText = (secs) => new Date(Number(secs) * 1000).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
const seatedElsewhere = () => !!state.seat?.seated && !(bring.table && cage.seatedAt(bring.table.cage.table));
const tableStarted = () => !!bring.table && !bring.table.cage.joinable && !seatedHere() && !TOPUP;
const blocked = () => bring.problem || (tableStarted() ? 'This table has started, so it can’t take another seat now. Your wallet and balance are as they were.' : '') || (BRING_ID && seatedElsewhere() ? `You’re seated at table ${state.view.seat.table}. Leave it, or Stand under My cage, then come back.` : '') || (BRING_ID && !bring.table ? 'Finding the table…' : '');

// ---------- the path ----------

function stepNow() {
  if (!state.api) return 'wallet';
  if (BRING_ID && CASHOUT) return 'buy';
  if (BRING_ID && safe(() => localStorage.getItem(cage.claimKey(BRING_ID)))) return 'seat';
  if (BRING_ID && seatedHere() && cage.doorGood() && !TOPUP) return 'seat';
  if (BRING_ID) return 'buy';
  return cage.doorGood() && cage.balance() >= WHOLE_CHIP ? 'done' : 'buy';
}

function render() {
  if (state.stopped) { $('stop').textContent = state.stopMessage; show('stop'); }
  // step 1
  show('wallet', !!state.api);
  const now0 = stepNow();
  if (state.api) {
    $('wallet-name').textContent = cage.walletName();
    $('night').textContent = state.nightText ?? '…';
    $('dust').textContent = state.dustText ?? '…';
    $('dust').title = state.dustCap ?? '';
    const badge = cage.dustBadge(); // ready / not ready yet, in plain words (the 11-08 pass #7)
    $('dust-badge').hidden = !badge;
    if (badge) { $('dust-badge').textContent = badge.text; $('dust-badge').classList.toggle('ok', badge.ok); $('dust-badge').classList.toggle('no', !badge.ok); }
    // What just happened, in plain words, until something does move (the 11-09 browser test: connected, and then nothing said what came next).
    const idle = now0 === 'buy' && !state.running && !state.busy && !state.lastWord;
    $('connected-note').hidden = !idle;
    $('connected-note').textContent = `${cage.walletName()} connected. Nothing has moved yet. Next: ${CASHOUT ? 'cash out below' : BRING_ID ? 'pick how much tNIGHT to put at risk at this table' : 'pick how much tNIGHT to bring'}.`;
    $('address').textContent = state.address ?? '';
    $('dust-address').textContent = state.dustAddress ?? '';
    show('dust-address-line', !!state.dustAddress);
  }
  // the steps
  const now = stepNow();
  const last = BRING_ID ? 'seat' : 'done';
  const order = ['wallet', 'buy', last];
  const at = order.indexOf(now);
  for (const section of document.querySelectorAll('.step')) {
    const i = order.indexOf(section.dataset.step);
    section.hidden = i < 0;
    if (i < 0) continue;
    section.classList.toggle('done', i < at);
    section.classList.toggle('now', i === at);
    section.classList.toggle('later', i > at);
  }
  // From the Hall's door: bringing tNIGHT the first time, or, once the door is signed and the cage holds something, topping up or cashing out.
  if (!BRING_ID) $('bring-title').textContent = query.has('door') ? (cage.doorGood() && cage.balance() > 0n ? 'Top up or cash out' : 'Bring tNIGHT to the Hall') : 'The Cage';
  $('buy-title').replaceChildren(Object.assign(document.createElement('span'), { className: 'step-no', textContent: '2' }), document.createTextNode(BRING_ID ? ' Buy in and sit' : ' Bring tNIGHT'));
  $('buy-intro').textContent = BRING_ID
    ? 'Pick how much to put at risk at this table. One approval and one signature the first time, and the judge seats you: after that, nothing to approve, at any table, for 12 hours.'
    : 'Pick how much to put in the cage. It works at any tNIGHT table in the Hall. One approval and one signature, and you play without pop-ups for 12 hours.';
  show('bring-to-table', !!bring.table && (tableStarted() || now === 'seat'));
  if (bring.table) $('bring-to-table').href = `${BRING_GAME.page}?id=${BRING_ID}&watch=1`;
  if (BRING_ID) $('seat-status').textContent = now === 'seat' ? 'The judge is seating you. Nothing to approve. About a minute on a warm table; about two if it has to put the house float on chain first.' : '';
  if (now === 'done') $('hall-note').textContent = `You’re in, with ${fmtNight(cage.balance())} tNIGHT in the cage. Go to the Hall and pick a game: the judge seats you, with nothing to approve.`;
  // A seat already on chain with a good session, and no plan on it: claim it, once. A plan claims its own seat at its judge step,
  // and a refusal is not asked again by itself.
  if (now === 'seat' && BRING_ID && !state.running && !state.busy && !bring.autoClaimed && !safe(() => localStorage.getItem(cage.claimKey(BRING_ID))) && seatedHere() && cage.doorGood()) claimNow();
  renderMyCage();
  renderChecks();
  renderLog();
}

/** A claim already with the judge (this page was refreshed): keep asking until the seat is taken or refused. No wallet involved. */
async function resumeClaim() {
  bring.autoClaimed = true;
  try {
    const token = await cage.claimSeat({ api: BRING_GAME.api, tableId: BRING_ID, status: (t) => { $('seat-status').textContent = t; } });
    goToTable(token);
  } catch (e) {
    $('seat-status').textContent = e.message;
    cage.trouble({ title: 'The judge refused the seat', what: e.message, cause: 'The seat on chain didn’t match what the table expected, or the table moved on.', todo: 'Your balance is as the cage shows under My cage. Try another table from the Hall, or Stand if a seat is still held.', raw: e.reason ?? e.code ?? '', retry: false }, {});
    render();
  }
}

let claiming = false;
async function claimNow() {
  if (claiming) return;
  claiming = true;
  bring.autoClaimed = true;
  try {
    cage.openWaiting({ title: `Taking your seat at table ${bring.table.cage.table}`, intro: 'Your seat is on chain already. The judge reads it, and you’re in: nothing to approve.', total: 1 });
    cage.setStages(cage.JUDGE_STAGES());
    cage.stageAt(1);
    const token = await cage.claimSeat({ api: BRING_GAME.api, tableId: BRING_ID, name: bring.hallName || null, avatar: bring.avatar });
    goToTable(token);
  } catch (e) {
    cage.trouble({ title: 'The table didn’t take the seat', what: e.message, cause: 'The table changed while the seat was held, or the name is taken.', todo: 'Pick a table in the Hall, or Stand under My cage and the judge frees the seat.', raw: e.code ?? '', retry: false }, {});
    $('seat-status').textContent = e.message;
  } finally { claiming = false; }
}

// ---------- My cage ----------

function why(id, text) { const el = $(`${id}-why`); if (el) el.textContent = $(id)?.disabled ? text ?? '' : ''; }

function renderMyCage() {
  const view = state.view;
  const seat = state.seat;
  $('cage-address').textContent = state.cage?.address ?? '';
  $('cage-name').textContent = state.cage?.name ?? '';
  show('read-only', !!state.cage && !state.cage.writable);
  if (state.cage && !state.cage.writable) $('read-only').textContent = `Read-only for now. This shows ${state.cage.name}, an old test contract. Deposit, Sit, Stand and Withdraw switch on when cage #3 is live.`;
  $('my-balance').textContent = view ? (view.id ? `${fmtNight(view.balance)} tNIGHT` : 'No player key yet') : state.readError ? 'Not available right now' : (state.api ? (state.indexer ? '…' : 'Waiting for an indexer') : '…');
  $('my-seat').textContent = seat?.text ?? '…';
  const permit = cage.permit();
  const limit = grantLimitText(view?.maxGrant); // L1, from the cage itself: "A permit runs at most 30 days."
  $('my-permit').textContent = !view?.id ? '…' : !view.permit ? 'None. The judge can’t seat you without asking.'
    : permit.why === 'rotated' ? 'It names the judge’s old key, so it can’t be used. Your next deposit grants a new one.'
      : permit.why === 'expired' ? 'It has run out. Your next deposit grants a new one.'
        : `The judge can seat you with up to ${fmtNight(permit.room)} tNIGHT at risk, until ${untilText(permit.until)}. Its cap is ${fmtNight(permit.cap)}: the most it can lose, plus anything you win while it’s live. A seat placed before it ends can still be settled after.${limit ? ` ${limit}` : ''}`;
  $('my-cage-note').textContent = view?.id ? `${fmtNight(view.balance)} tNIGHT${seat?.seated ? ` · seated at table ${view.seat.table}` : ''}` : '';
  if (seat?.seated) {
    const at = new Date(seat.freeAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('withdraw-note').textContent = `Once you’ve left the table, the judge frees the seat as soon as your last round is settled, about a minute, and this page checks every ${cage.SEATED_POLL_MS / 1000} seconds. With no settle at all, the table goes quiet at ${at}.`;
  } else $('withdraw-note').textContent = view?.balance > 0n ? `Up to ${fmtNight(view.balance)} tNIGHT, to your own address.` : '';
  if (!$('withdraw-amount').value && view?.balance > 0n) $('withdraw-amount').value = fmtNight(view.balance).replaceAll(',', '');
  const ready = cage.ready();
  const notReady = cage.notReady();
  const seated = !!seat?.seated;
  $('withdraw').disabled = !ready || seated || !(cage.balance() > 0n);
  why('withdraw', notReady || (seated ? `You’re seated at table ${view.seat.table}, so the cage refuses a withdrawal. Leave the table (or Stand below), and the judge frees the seat at its next settle.` : 'Nothing in the cage to withdraw.'));
  $('stand').disabled = !ready || !seated || !!seat?.standing;
  why('stand', notReady || (!seated ? 'You’re not seated anywhere, so there’s nothing to stand from.' : 'Already asked: the judge frees the seat at its next settle.'));
  $('revoke').disabled = !ready || !view?.permit;
  why('revoke', notReady || 'No permit to end.');
  $('probe').disabled = !ready || !(cage.balance() > 0n);
  why('probe', notReady || 'Needs a balance in the cage to build a call with.');
  show('sponsor-box', !!state.cage?.writable);
  $('find').disabled = !state.session || state.busy || state.running;
  why('find', !state.session ? (state.api ? 'Waiting for an indexer and the contract code.' : 'Choose your wallet first.') : 'Something is running.');
  const key = cage.myKey();
  $('copy-key').disabled = !key;
  why('copy-key', 'No key in this browser yet: one is made at your first deposit.');
  if (!key) $('key-state').textContent = 'No key in this browser for this wallet. One is made at your first deposit.';
  else if (!view?.id) $('key-state').textContent = 'Saved in this browser.';
  else $('key-state').textContent = `Saved in this browser. Player ${view.id.slice(0, 12)}…${view.ours ? ' matches a deposit from this wallet.' : ''}`;
}

function renderChecks() {
  const list = $('checks');
  list.replaceChildren(...state.checks.map((c) => {
    const li = document.createElement('li');
    li.dataset.check = c.name;
    li.className = c.status; // the mark is the row's ::before, the first grid cell; the words are the second
    const span = document.createElement('span');
    span.textContent = c.name;
    if (c.detail) { const small = document.createElement('small'); small.textContent = c.detail; span.append(small); }
    li.append(span);
    return li;
  }));
  const bad = state.checks.filter((c) => c.status === 'bad').length;
  $('checks-note').textContent = bad ? `${bad} problem${bad === 1 ? '' : 's'}` : state.checks.length ? 'all good' : '';
  $('checks-note').className = `fold-note${bad ? ' bad' : ''}`;
  if (bad) $('checks-box').open = true;
  show('indexer-form', !!state.indexerForm && !state.indexer);
}

function renderLog() {
  $('progress').textContent = state.progress ?? '';
  $('log').replaceChildren(...state.log.map((entry) => { const li = document.createElement('li'); li.textContent = entry.text; if (entry.cls) li.className = entry.cls; return li; }));
  const failed = state.log.filter((e) => e.cls === 'failed').length;
  $('log-note').textContent = state.log.length ? `${state.log.length} line${state.log.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}` : '';
  if (failed && !$('log-box').dataset.opened) { $('log-box').open = true; $('log-box').dataset.opened = '1'; }
}

function onWithdraw(event) {
  event.preventDefault();
  const amount = parseNight($('withdraw-amount').value);
  if (!amount) { $('withdraw-why').textContent = 'Type an amount above zero, with at most 6 decimals.'; return; }
  if (amount > cage.balance()) { $('withdraw-why').textContent = 'That’s more than your balance in the cage.'; return; }
  $('withdraw-amount').value = '';
  const go = () => cage.run(`Withdraw ${fmtNight(amount)} tNIGHT`, 'withdraw', [amount], cage.myKey(), { retry: go, during: 'approve the withdrawal', button: $('withdraw') });
  go();
}

function onStand() {
  const go = () => cage.standUp({ retry: go, button: $('stand') });
  go();
}

function onRevoke() {
  const go = () => cage.revokePermit({ retry: go, button: $('revoke') }).then((done) => { if (done) cage.log('Your permit is ended: the judge can’t seat or move you until you grant it again. A seat you already hold stays until it’s settled, released or stood from.'); });
  go();
}

async function onCopyKey() {
  const key = cage.myKey();
  if (!key) return;
  try { await navigator.clipboard.writeText(key); $('key-state').textContent = 'Copied. Keep it somewhere private. It’s the only copy besides this browser.'; } catch { $('key-state').textContent = 'Your browser wouldn’t let me copy it.'; }
}

async function onRestore(event) {
  event.preventDefault();
  const key = parseKey($('restore-key').value);
  $('restore-key').value = '';
  if (!key) { $('key-state').textContent = 'That isn’t a player key: it should be 64 letters and digits.'; return; }
  const old = cage.myKey();
  if (old && old !== key && cage.balance() > 0n) { $('key-state').textContent = 'This browser’s key holds a balance. Copy it and withdraw first, so that you don’t lose track of it.'; return; }
  cage.saveKey(key);
  cage.log('Player key restored in this browser.');
  await cage.refreshCage();
}

async function onFind() {
  if (!state.session) { $('found').replaceChildren(); cage.log('Finding deposits needs the contract code and an indexer.', 'failed'); return; }
  const list = await state.session.findByAddress().catch((e) => { cage.log(`Couldn’t search the cage: ${cage.errorText(e)}`, 'failed'); return null; });
  if (!list) return;
  const here = cage.myKey() ? state.view?.id : null;
  const rows = list.map((entry) => {
    const li = document.createElement('li');
    const seat = seatView({ seat: entry.seat, table: entry.table, escapeSecs: entry.escapeSecs, now: Math.floor(Date.now() / 1000) });
    const line = document.createElement('span');
    line.textContent = `Player ${entry.id.slice(0, 12)}…: ${fmtNight(entry.balance)} tNIGHT${entry.id === here ? ', this browser’s key' : ''}${seat.seated ? `, seated until ${new Date(seat.freeAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
    li.append(line);
    if (state.cage.writable && entry.balance > 0n) {
      const button = document.createElement('button');
      button.className = 'btn small';
      button.type = 'button';
      button.textContent = 'Send it home to this wallet';
      button.disabled = seat.seated;
      const go = () => cage.run(`Send ${fmtNight(entry.balance)} tNIGHT home`, 'rescue', [entry.idBytes], cage.myKey() ?? cage.newKey(), { retry: go, during: 'approve sending it home', button });
      button.addEventListener('click', go);
      li.append(button);
      if (seat.seated) { const p = document.createElement('p'); p.className = 'why'; p.textContent = 'Its seat still holds it: once the table settles or goes quiet, it can be sent home.'; li.append(p); }
    }
    return li;
  });
  if (!rows.length) { const li = document.createElement('li'); li.textContent = 'No deposits from this address in this cage.'; rows.push(li); }
  $('found').replaceChildren(...rows);
}

async function onProbe() {
  if (state.busy || !state.session) return;
  state.busy = true;
  render();
  $('probe-result').textContent = `Building and proving. This can take a few minutes. Then approve in ${cage.walletName()}.`;
  try {
    const seated = state.seat?.seated;
    const now = BigInt(Math.floor(Date.now() / 1000) - 60);
    const circuit = seated ? 'stand' : 'sit';
    const args = seated ? [state.view.seat.table, now] : [1n, 1n, now];
    const r = await state.session.probeNoDust(circuit, cage.myKey(), args, (text) => { $('probe-result').textContent = text; });
    $('probe-result').textContent = r.dustSpends === 0
      ? `Yes. ${cage.walletName()} signed a ${circuit} call with no tDUST in it, so a sponsor could add the fee. Nothing was sent.`
      : `No. ${cage.walletName()} added ${r.dustSpends} tDUST spend(s) even though it was asked not to, so it pays the fee itself. Nothing was sent.`;
    cage.log(`Sign with no tDUST: ${r.dustSpends === 0 ? 'yes' : 'no'} (${r.dustSpends} tDUST spends in the ${circuit} call). Nothing sent.`);
  } catch (e) {
    $('probe-result').textContent = `The test didn’t finish: ${cage.errorText(e)}`;
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- start ----------

async function start() {
  mountSupport(document.getElementById('support'));
  mountNav({ current: 'Cage' });
  mountPicker($('wallets'));
  mountConnectStatus($('connect-root'));
  buy = mountBuyIn($('buy-body'), {
    table: null, tableId: BRING_ID, game: BRING_GAME, topup: TOPUP, name: () => bring.hallName, avatar: () => bring.avatar, blocked,
    onSeated: goToTable, onDone: () => { playTnight(); render(); cage.offerGo('Go to the Hall', '/'); }, onHall: () => render(),
  });
  cage.on(() => { if (seatedHere() && !state.running && $('trouble') && !$('trouble').hidden) bring.autoClaimed = true; }); // a seat the table or the judge refused is not claimed again by itself
  $('bring-to-hall').addEventListener('click', playTnight);
  $('switch-wallet').addEventListener('click', () => cage.switchWallet());
  $('refresh').addEventListener('click', async () => { await cage.refreshWallet(); await cage.refreshCage(); });
  $('copy-address').addEventListener('click', () => navigator.clipboard.writeText(state.address).catch(() => {}));
  $('indexer-form').addEventListener('submit', (e) => { e.preventDefault(); const id = $('indexer-id').value.trim(); $('indexer-id').value = ''; if (id) cage.useProjectId(id); });
  $('withdraw-form').addEventListener('submit', onWithdraw);
  $('stand').addEventListener('click', onStand);
  $('revoke').addEventListener('click', onRevoke);
  $('copy-key').addEventListener('click', onCopyKey);
  $('restore-form').addEventListener('submit', onRestore);
  $('find').addEventListener('click', onFind);
  $('probe').addEventListener('click', onProbe);
  cage.on(render);
  render();
  nameFromHall();
  if (BRING_ID) {
    try {
      await loadBringTable();
      const seatToken = safe(() => localStorage.getItem(cage.seatKey(BRING_ID)));
      if (seatToken && !TOPUP && !CASHOUT && (await fetch(`${BRING_GAME.api}/${BRING_ID}/me`, { headers: { authorization: `Bearer ${seatToken}` } })).ok) { goToTable(seatToken); return; }
      if (safe(() => localStorage.getItem(cage.claimKey(BRING_ID)))) resumeClaim(); // a refresh while the judge reads the seat picks up where it was
    } catch (e) { bring.problem = cage.errorText(e); }
    setInterval(() => { loadBringTable().then(render).catch(() => {}); }, cage.CAGE_POLL_MS);
  }
  render();
  cage.start();
  if (CASHOUT) cage.on(() => { if (!bring.cashStarted && state.view && state.session && !state.busy && !state.running) { bring.cashStarted = true; cage.cashOut({ button: $('cash-out'), status: (t) => { $('bring-status').textContent = t; } }); } });
}

start();
