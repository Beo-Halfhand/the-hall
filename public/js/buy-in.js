// Buying in, the same on every page: the wallet picker, the tiles (how much), the "Your seat" summary, one button, and the
// cash-out row. A page mounts it into a box and says which table (or none, for the Hall's door). The plans run in the cage
// session's window; the page hears `onSeated(token)` when the judge has seated the player.

import * as cage from './cage-session.js';
import { TILES, WHOLE_CHIP, buyPlan, cashPlan, fmtNight, handsFor, roughSeconds, roughTime, sentence } from './wallet-core.js';

const DEFAULT_ANTE = 5; // the Hall's tables' ante, for the door's tiles
const OTHER_WALLET_MS = 5000; // how long a click on one wallet keeps the other one off
const WALLET_TIP = '1AM is the tested wallet here: tested end to end on Preprod. Lace is not yet working here since Preprod moved to Ledger 9; use 1AM until it is.'; // the tester's note on the wallet step (11-08 pass, #13, #15)
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c);
  return el;
};

/** The wallet buttons, as the cage page has them. `root` is emptied and filled on every change. */
export function mountPicker(root) {
  const paint = () => {
    const { state } = cage;
    if (state.address) { root.hidden = true; return; } // connected: the picker goes, as it was, with its mark on the wallet that answered
    const list = cage.wallets();
    const waited = Date.now() - (state.connectingAt ?? 0);
    if (state.connecting && !state.address && waited < OTHER_WALLET_MS) setTimeout(paint, OTHER_WALLET_MS - waited + 50); // the other wallet comes back after five seconds (11-07: Lace never answered)
    root.replaceChildren(...list.map((wallet, index) => {
      const clicked = !!state.connecting && !state.address && waited < OTHER_WALLET_MS; // a click waits on its wallet a few seconds; a reconnect on load never locks the picker
      const busy = clicked && state.pendingId === wallet.id;
      const note = !wallet.compatible ? `Can’t be used: connector ${wallet.apiVersion ?? 'unknown'}, and this page needs version 4. Update ${wallet.name}.`
        : busy ? `Waiting for ${wallet.name}` : clicked ? 'Waiting on the other wallet first' : `${wallet.is1am ? 'Tested · recommended · fastest' : wallet.isLace ? 'Works, but can be fussy' : 'Not tested here yet'}${wallet.id === cage.chosen() ? ' · last used' : ''} · connector ${wallet.apiVersion}`;
      let icon = h('span', { class: 'wallet-icon wallet-initial', text: wallet.name[0] });
      if (wallet.icon) { icon = h('img', { class: 'wallet-icon', alt: '', src: wallet.icon }); icon.addEventListener('error', () => icon.replaceWith(h('span', { class: 'wallet-icon wallet-initial', text: wallet.name[0] }))); }
      return h('button', {
        type: 'button', class: `btn wallet-choice${index === 0 && wallet.compatible ? ' primary' : ''}`, dataset: { wallet: wallet.id, ...(wallet.compatible ? {} : { incompatible: '1' }) },
        disabled: !wallet.compatible || clicked || state.stopped, 'aria-busy': busy ? 'true' : null,
        onClick: () => cage.connect(wallet.id),
      }, icon, h('span', { class: 'wallet-text' }, h('span', { class: 'wallet-name', text: wallet.name }), h('span', { class: `wallet-note${busy ? ' waiting' : ''}`, text: note })));
    }));
    if (list.length && WALLET_TIP) root.append(h('p', { class: 'wallet-tip', id: 'wallet-tip', text: WALLET_TIP })); // the tester's note (11-08)
    root.hidden = !!state.address; // the picker stays, with its mark, until the wallet has said who it is
  };
  cage.on(paint);
  paint();
}

/** The connect line under the picker, with Try again when a wallet didn't answer. */
export function mountConnectStatus(root) {
  const status = h('p', { class: 'quiet', id: 'connect-status', role: 'status' });
  const retry = h('button', { class: 'btn primary', id: 'retry-connect', type: 'button', text: 'Try again', hidden: true, onClick: () => cage.retryConnect() });
  root.replaceChildren(status, retry);
  const paint = () => { status.textContent = cage.state.connectStatus; retry.hidden = !cage.state.retryOffered || !!cage.state.address; };
  cage.on(paint);
  paint();
}

/**
 * Mounts the buy-in into `root`. `table` is the table's public view (or null for the door), `game` is { api, page, name }.
 * Calls `onSeated(token)` once the judge has seated the player; `onDone()` for the door; `onHall()` when a top-up ends in the Hall.
 */
export function mountBuyIn(root, { table = null, tableId = null, game = null, topup = false, name = () => '', avatar = () => null, onSeated = () => {}, onDone = () => {}, onHall = () => {}, blocked = () => '' }) {
  const pick = { amount: null, custom: false, picked: false, more: false }; // more: they asked to see the top-up tiles
  const el = {
    line: h('p', { class: 'cage-line', id: 'cage-line' }, h('span', { text: 'In the cage now' }), ' ', h('b', { id: 'cage-balance', text: '…' }), ' ', h('span', { id: 'cage-seat' })),
    trouble: h('div', { class: 'cage-trouble', id: 'cage-trouble', role: 'alert', hidden: true },
      h('p', { class: 'cage-trouble-text', id: 'cage-trouble-text' }),
      h('button', { class: 'btn small', id: 'cage-refresh', type: 'button', text: 'Refresh', onClick: async (e) => { e.currentTarget.disabled = true; try { await cage.retryRead(); } finally { e.currentTarget.disabled = false; } } }),
      h('small', { class: 'cage-trouble-raw', id: 'cage-trouble-raw' })),
    tiles: h('div', { class: 'tiles', id: 'tiles', role: 'radiogroup', 'aria-label': 'How much to bring' }),
    more: h('p', { class: 'add-more-line', id: 'add-more-line', hidden: true }),
    dust: h('div', { class: 'dust-wall', id: 'dust-wall', role: 'status', hidden: true },
      h('p', { class: 'dust-wall-text', id: 'dust-wall-text' }),
      h('button', { class: 'btn small', id: 'dust-refresh', type: 'button', text: 'Refresh', onClick: async (e) => { e.currentTarget.disabled = true; try { await cage.refreshWallet(); } finally { e.currentTarget.disabled = false; } } })),
    customForm: h('form', { class: 'cage-action custom', id: 'buy-custom-form', novalidate: true, hidden: true }, h('label', { text: 'Other amount, in tNIGHT ' }, h('input', { id: 'buy-custom', inputmode: 'decimal', autocomplete: 'off', placeholder: '0' }))),
    summary: h('div', { class: 'summary', id: 'seat-summary', hidden: true }),
    button: h('button', { class: 'btn primary big', id: 'buy-go', type: 'button', disabled: true, text: 'Sit' }),
    why: h('p', { class: 'why', id: 'buy-go-why' }),
    status: h('p', { class: 'prose status', id: 'bring-status', role: 'status' }),
    cashRow: h('div', { class: 'cash-row', id: 'cash-row', hidden: true },
      h('button', { class: 'btn', id: 'cash-out', type: 'button', disabled: true, text: 'Cash out' }),
      h('p', { class: 'why', id: 'cash-out-why' }),
      h('p', { class: 'cage-note', id: 'cash-note', text: 'Cash out can only go back to your own wallet.' })),
  };
  el.customForm.addEventListener('submit', (e) => e.preventDefault());
  el.customForm.querySelector('input').addEventListener('input', () => { pick.amount = parseAmount(el.customForm.querySelector('input').value); paintButton(); paintSummary(); });
  root.replaceChildren(el.line, el.trouble, el.dust, el.tiles, el.more, el.customForm, el.summary, el.button, el.why, el.status, el.cashRow);

  const tableNo = () => (table ? BigInt(table.cage.table) : null);
  const ante = () => Number(table?.limits.ante ?? DEFAULT_ANTE);
  const potLimit = () => (table ? cage.seatMost(table) : null); // the most for one seat: the buy-in max (250), or a lower pot limit
  const seatedHere = () => (table ? cage.seatedAt(tableNo()) : false);
  const seatToken = () => { try { return tableId ? localStorage.getItem(cage.seatKey(tableId)) : null; } catch { return null; } };
  const planFor = (amount) => buyPlan({
    dustReady: cage.dustReady(), wallet: cage.walletName(),
    amount, cage: cage.balance(), night: cage.state.night, ante: ante(), potLimit: potLimit(), signed: cage.doorGood(), table: tableNo(),
    seated: seatedHere(), standing: !!cage.state.seat?.standing, topup, canSit: !(topup && table && !table.cage.joinable),
    permit: cage.permit(), bound: !!cage.state.seat?.seated, canLeave: !!seatToken(), draining: !!cage.state.draining,
  });
  /** Seated at another table this browser can reach, with a permit that covers a seat here: the judge can bring them, with nothing to approve. */
  const canHop = () => !!table && !topup && !!cage.state.seat?.seated && !seatedHere() && !cage.state.seat.standing && !!cage.state.hopFrom && !!table.cage?.joinable && cage.hopAmount(table) !== null;
  const status = (text) => { el.status.textContent = text; };

  function tileList() {
    const balance = cage.balance();
    const cap = potLimit();
    const list = [];
    if (table && balance >= BigInt(ante()) * WHOLE_CHIP) {
      // With a good permit, what the judge can place first: the seat that asks nothing. Otherwise what the cage holds.
      const p = cage.permit();
      const room = p.good && p.room >= BigInt(ante()) * WHOLE_CHIP ? p.room : balance;
      const most = cap != null && room > BigInt(cap) * WHOLE_CHIP ? BigInt(cap) * WHOLE_CHIP : room;
      list.push({ amount: most, first: true, note: most === balance ? 'what the cage holds for you' : room === p.room && room !== balance && most === room ? `what your permit can place; the cage holds ${fmtNight(balance)}` : `the most for one seat; the cage holds ${fmtNight(balance)}` });
    }
    for (const amount of TILES) if (!list.some((t) => t.amount === amount)) list.push({ amount, note: null });
    return list;
  }

  function paintTiles() {
    const plans = tileList().map((tile) => ({ ...tile, plan: planFor(tile.amount) }));
    const first = plans.find((t) => t.first && !t.plan.why);
    // The cage already covers a seat here with nothing to approve: that's the one tile. Bringing more is a smaller Add more, never chosen for them.
    const covered = !!first && first.plan.approvals === 0 && !first.plan.signature;
    const folded = covered && !topup && !pick.more;
    if (!pick.picked) {
      const chosen = first ?? plans.find((t) => t.amount === 50n * WHOLE_CHIP && !t.plan.why) ?? plans.find((t) => !t.plan.why);
      pick.amount = chosen?.amount ?? null;
      pick.custom = false;
    }
    const wallet = cage.walletName();
    const per = cage.promptsPerTx(wallet);
    const buttons = (folded ? plans.filter((t) => t.first) : plans).map((tile) => {
      const hands = handsFor(tile.amount, ante());
      const txs = tile.plan.approvals;
      const topsUp = table && !tile.plan.grant && tile.plan.deposit > 0n && cage.balance() > 0n ? `tops up ${fmtNight(tile.plan.deposit)} · ` : '';
      const cost = `${topsUp}${txs ? `${txs} transaction${txs === 1 ? '' : 's'}${per > 1 ? ` (${txs * per} prompts)` : ''}${tile.plan.signature ? ' + 1 signature' : ''}` : tile.plan.signature ? '1 signature' : 'nothing to approve'}`;
      const b = h('button', { type: 'button', class: 'btn tile', role: 'radio', dataset: { amount: tile.amount.toString() }, 'aria-checked': String(!pick.custom && pick.amount === tile.amount), disabled: !!tile.plan.why,
        onClick: () => { pick.amount = tile.amount; pick.custom = false; pick.picked = true; paint(); } },
      h('span', { class: 'amount', text: `${fmtNight(tile.amount)} tNIGHT` }),
      h('span', { class: 'sub', text: `${tile.note ? `${tile.note} · ` : ''}≈ ${hands} hand${hands === 1 ? '' : 's'}${table ? '' : ` at ante ${ante()}`} · ${cost}` }));
      if (tile.plan.why) b.append(h('span', { class: 'why', text: tile.plan.why }));
      return b;
    });
    if (!folded) buttons.push(h('button', { type: 'button', class: 'btn tile', role: 'radio', dataset: { amount: 'other' }, 'aria-checked': String(pick.custom),
      onClick: () => { pick.custom = true; pick.picked = true; pick.amount = parseAmount(el.customForm.querySelector('input').value); paint(); el.customForm.querySelector('input').focus(); } },
    h('span', { class: 'amount', text: 'Other amount' }),
    h('span', { class: 'sub', text: table ? `whole tNIGHT, at least the ante (${ante()})${potLimit() ? `, up to ${potLimit()} for one seat` : ''}` : 'any amount of tNIGHT' })));
    el.tiles.replaceChildren(...buttons);
    el.customForm.hidden = !pick.custom || folded;
    el.more.hidden = !covered || !!topup;
    if (!el.more.hidden) {
      el.more.replaceChildren(h('button', { type: 'button', class: 'add-more', id: 'add-more', 'aria-expanded': String(!!pick.more), text: pick.more ? 'Just what the cage holds' : 'Add more from your wallet',
        onClick: () => { pick.more = !pick.more; if (!pick.more) { pick.picked = false; pick.custom = false; } paint(); } }));
    }
  }

  function paintSummary() {
    const plan = planFor(pick.amount ?? 0n);
    const ok = !!cage.state.session && !!cage.state.view && pick.amount && !plan.why && !blocked() && !canHop();
    el.summary.hidden = !ok;
    if (!ok) return;
    const wallet = cage.walletName();
    const balance = cage.balance();
    const fromCage = table ? (plan.amount > balance ? balance : plan.amount) : 0n;
    const said = plan.moves.map((m) => (m.kind === 'stand' ? `1 in ${wallet} to stand up (the judge frees the seat once your last round is settled, about a minute)` : m.kind === 'deposit' ? `1 in ${wallet} to put ${fmtNight(m.amount)} in the cage${m.grant ? ' and renew your permit' : ''}` : m.kind === 'sign' ? 'one signature so you can play without pop-ups' : m.kind === 'sit' ? `1 in ${wallet} to take the seat` : null)).filter(Boolean);
    const steps = said.map((line, i) => (i ? `then ${line}` : line));
    const prompts = cage.promptsPerTx(wallet) > 1 && plan.approvals ? ` ${wallet} asks twice per transaction (the transaction, then the DUST choice): expect ${plan.approvals * 2} prompts${plan.signature ? ', plus the signature' : ''}.` : '';
    el.summary.replaceChildren(
      h('h3', { class: 'cage-h3', id: 'summary-title', text: table ? 'Your seat' : 'Your cage' }),
      h('dl', { class: 'cage-facts' },
        h('dt', { id: 'summary-table-dt', text: table ? 'Table' : 'Where' }), h('dd', { id: 'summary-table', text: table ? `Table ${table.cage.table} · ${game?.name ?? ''}` : 'Any tNIGHT table in the Hall' }),
        h('dt', { text: 'Buy-in' }), h('dd', { id: 'summary-amount', text: table && seatedHere() && !topup && cage.state.view?.seat ? `${fmtNight(cage.state.view.seat.atRisk)} tNIGHT at risk, already on chain at this table: the judge only reads it` : table ? `${fmtNight(plan.amount)} tNIGHT at risk${plan.deposit > 0n ? `: ${fromCage > 0n ? `${fmtNight(fromCage)} already in the cage, ` : ''}${fmtNight(plan.deposit)} from your wallet` : ', all from the cage'}` : `${fmtNight(plan.amount)} tNIGHT from your wallet into the cage${balance > 0n ? ` (it holds ${fmtNight(balance)} already)` : ''}` }),
        h('dt', { text: 'Approvals' }), h('dd', { id: 'summary-approvals', text: `${steps.length ? `${steps.join(', ')}.` : 'None. The judge seats you.'}${prompts}${topup && table && !table.cage.joinable ? ' This table has moved on, so the new seat comes at a table that is seating, from the Hall.' : ''}` }),
        ...(plan.moves.some((m) => m.kind === 'deposit') ? [h('dt', { text: 'Your permit' }), h('dd', { id: 'summary-permit', text: `The judge can seat you at any table and move you between them with nothing to approve, up to ${fmtNight(plan.moves.find((m) => m.kind === 'deposit').cap)} tNIGHT at risk. That’s the most this permit can lose, plus anything you win while it’s live. It can never send your money anywhere but your own wallet. To end it: stand, or Revoke under My cage.` })] : []),
        h('dt', { text: 'Time' }), h('dd', { id: 'summary-time', text: `${sentence(roughTime(roughSeconds(plan, { warm: !!table?.cage.warm })))}${table && !table.cage.warm && plan.moves.some((m) => m.kind === 'judge') ? ', as the judge has to put the house float on chain first' : ''}.` }),
        h('dt', { text: 'Money comes back to' }), h('dd', {}, h('code', { id: 'summary-payout', class: 'one-line', title: cage.state.address ?? '', text: cage.state.address ?? '' }))), // the whole address, on one line (the review shots: it broke mid-string)
      plan.signature ? h('label', { id: 'name-label', text: 'Your name at the tables ' }, nameInput()) : '');
  }

  let nameEl = null;
  function nameInput() {
    if (!nameEl) { nameEl = h('input', { id: 'bring-name', maxlength: '24', autocomplete: 'off', value: name() ?? '' }); nameEl.addEventListener('input', paintButton); }
    return nameEl;
  }
  const typedName = () => (nameEl?.value ?? name() ?? '').trim();

  function paintButton() {
    const { state } = cage;
    const plan = planFor(pick.amount ?? 0n);
    if (el.button.getAttribute('aria-busy') !== 'true') {
      const known = !!pick.amount;
      const amount = known ? `${fmtNight(pick.amount)} tNIGHT` : '';
      if (canHop()) {
        const amount = cage.hopAmount(table);
        el.button.textContent = `Move my seat here with ${fmtNight(amount)} tNIGHT`;
        el.button.disabled = !!cage.notReady();
        el.why.textContent = cage.notReady() || `Nothing to approve. You’re at table ${cage.state.view.seat.table}: your round there finishes first, then the judge moves your seat.`;
        return;
      }
      el.button.textContent = table
        ? (seatedHere() && !topup ? (plan.signature ? 'Sign once and take my seat' : `Sit with ${fmtNight(state.view?.seat?.atRisk ?? pick.amount ?? 0n)} tNIGHT · nothing to approve`) : seatedHere() ? (plan.moves.some((m) => m.kind === 'sit' || m.kind === 'judge') ? (known ? `Leave and sit again with ${amount}` : 'Leave and sit again') : (known ? `Leave and bring the cage to ${amount}` : 'Leave and top up')) : (known ? `Sit with ${amount}` : 'Sit at this table'))
        : (cage.doorGood() ? (known ? `Add ${amount} to the cage` : 'Add to the cage') : (known ? `Bring ${amount} to the Hall` : 'Bring tNIGHT to the Hall'));
      const reason = state.stopped ? 'This page has stopped: see the top.'
        : !state.api ? 'Choose your wallet first.'
          : blocked() || cage.notReady() || (pick.dustWall ? 'No DUST yet: see above.' : !pick.amount ? 'Pick an amount above.' : plan.why) || (plan.signature && !typedName() ? 'Type the name you’ll go by at the tables.' : '');
      el.button.disabled = !!reason;
      el.why.textContent = reason;
    }
    const cashB = el.cashRow.querySelector('#cash-out');
    el.cashRow.hidden = !state.api || !state.view; // until the cage is read there is nothing to cash out, and the one reason sits under the big button
    if (cashB.getAttribute('aria-busy') !== 'true') {
      const cash = cashPlan({ balance: cage.balance(), seated: !!state.seat?.seated, standing: !!state.seat?.standing, dustReady: cage.dustReady(), wallet: cage.walletName() });
      cashB.textContent = `Cash out ${fmtNight(state.cashAmount ?? cage.balance())} tNIGHT`;
      const reason = (cage.notReady() && !el.button.disabled ? cage.notReady() : '') || cash.why || ''; // said once: under the big button when both are off for it
      cashB.disabled = !!reason;
      el.cashRow.querySelector('#cash-out-why').textContent = reason;
      el.cashRow.querySelector('#cash-note').textContent = `Cash out can only go back to your own wallet${state.address ? `: ${state.address.slice(0, 22)}…` : '.'}`;
    }
  }

  function paint() {
    const { state } = cage;
    // The door page, once the cage holds something: Cash out leads, above the tiles (11-07). With a table, or an empty cage, the tiles lead.
    const cashFirst = !table && !topup && cage.doorGood() && cage.balance() > 0n && !!state.view;
    if (cashFirst && root.firstChild !== el.cashRow) root.prepend(el.cashRow);
    else if (!cashFirst && root.lastChild !== el.cashRow) root.append(el.cashRow);
    el.cashRow.classList.toggle('leads', cashFirst);
    el.cashRow.querySelector('#cash-out').classList.toggle('primary', cashFirst);
    const unreadable = !state.view && !!state.readError; // what that means for the player, once, with the raw error small underneath
    const text = state.view ? `${fmtNight(cage.balance())} tNIGHT` : unreadable ? 'not available right now' : '…';
    el.trouble.hidden = !unreadable;
    if (unreadable) {
      el.trouble.querySelector('#cage-trouble-text').textContent = state.readError;
      el.trouble.querySelector('#cage-trouble-raw').textContent = state.readDetail ?? '';
    }
    el.line.querySelector('#cage-balance').textContent = text;
    el.line.querySelector('#cage-seat').textContent = state.seat?.seated ? `· ${state.seat.text}` : '';
    if (state.seat?.seated && table && !seatedHere() && !topup) cage.findHopSource();
    const ready = !!state.api && !!state.view && !blocked() && !canHop();
    // No DUST and nothing the cage can do without a wallet transaction: no amounts yet, just what to do about it (the 11-08 pass #3).
    const wall = ready && tileList().every((t) => planFor(t.amount).noDust);
    el.dust.hidden = !wall;
    pick.dustWall = wall;
    if (wall) el.dust.querySelector('#dust-wall-text').textContent = cage.dustText();
    const show = ready && !wall;
    el.tiles.hidden = !show;
    if (show) paintTiles(); else el.customForm.hidden = true;
    paintSummary();
    paintButton();
    if (!state.running && state.lastWord) status(state.lastWord);
    else if (!state.running && !state.busy && blocked() && !canHop()) status(blocked());
    else if (!state.running && !state.busy && state.api && !state.session) status(''); // the reason is under the button, once
    else if (!state.running && !state.busy && !state.lastWord && el.status.textContent && !/Step:|Approve in|judge/.test(el.status.textContent)) status('');
  }

  el.button.addEventListener('click', async () => {
    paintButton();
    if (el.button.disabled) return;
    if (canHop()) {
      const token = await cage.hop({ from: cage.state.hopFrom, to: { ...game, tableId, table }, name: typedName() || null, avatar: avatar(), button: el.button, status });
      if (token) onSeated(token);
      paint();
      return;
    }
    const result = await cage.buyIn({ amount: pick.amount, table, tableId, game, name: typedName(), avatar: avatar(), topup, button: el.button, status });
    if (result === 'done') { pick.picked = false; onDone(); } else if (result === 'hall') onHall(); else if (typeof result === 'string') onSeated(result);
    paint();
  });
  mountCashAsk(el.cashRow, { balance: () => cage.balance(), onGo: (amount) => cage.cashOut({ amount, button: el.cashRow.querySelector('#cash-out'), status }) });

  cage.on(paint);
  paint();
  return { paint, status, setTable(next) { table = next; paint(); } };
}

/** "mn_addr_preprod147jax…vgs3eh8zn": the start and the end of an address, for a line that can't wrap it whole. */
export const shortAddress = (address) => (address && address.length > 28 ? `${address.slice(0, 22)}…${address.slice(-8)}` : address ?? '');

/**
 * "Cash out how much?" (11-07): the Cash out button in `row` opens a small form with All <n> or an amount typed; `onGo(amount)` runs the
 * plan (null is all of it). The amount shown is `balance()` as the page knows it; the plan takes what the cage holds when the withdraw goes.
 */
export function mountCashAsk(row, { balance, onGo, live = null }) {
  const button = row.querySelector('#cash-out');
  const input = h('input', { id: 'cash-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: 'an amount' });
  const all = h('button', { type: 'button', class: 'btn primary', id: 'cash-all' });
  const some = h('button', { type: 'submit', class: 'btn', id: 'cash-some', text: 'Cash out that' });
  const why = h('p', { class: 'why', id: 'cash-ask-why' });
  const ask = h('form', { class: 'cash-ask', id: 'cash-ask', novalidate: true, hidden: true },
    h('p', { class: 'cash-ask-title', text: 'Cash out how much?' }),
    h('div', { class: 'cash-ask-row' }, all, h('span', { class: 'cash-ask-or', text: 'or' }), input, some, h('button', { type: 'button', class: 'btn small', id: 'cash-never', text: 'Never mind', onClick: () => { ask.hidden = true; } })),
    why);
  button.after(ask);
  const total = () => (live ? live() : balance());
  const go = async (amount) => { ask.hidden = true; why.textContent = ''; await onGo(amount); };
  all.addEventListener('click', () => go(null));
  ask.addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseAmount(input.value);
    if (!amount) { why.textContent = 'Type an amount above zero, with at most 6 decimals, or press All.'; return; }
    if (amount > total()) { why.textContent = `That’s more than the cage holds for you (${fmtNight(total())} tNIGHT).`; return; }
    go(amount);
  });
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-busy') === 'true') return;
    all.textContent = `All ${fmtNight(total())} tNIGHT`;
    input.value = '';
    why.textContent = '';
    ask.hidden = !ask.hidden;
    if (!ask.hidden) all.focus();
  });
  return { close: () => { ask.hidden = true; } };
}

function parseAmount(text) {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!m) return null;
  const star = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  return star > 0n ? star : null;
}
