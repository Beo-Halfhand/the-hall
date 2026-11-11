// "This round's receipt": the round's record in a window over the table, once the round has ended, drawn with the same piece as the
// full page (receipt-view.js) and checked here in the browser. An "Open full page" link inside goes to the record itself; Records
// stays the place for old rounds.

import { h, receiptBoxes, statusLine } from './receipt-view.js';

let dialog = null;
let state = { checked: false };
let showing = null; // the href of the record in the window, while it is open
let opener = null;

function build() {
  dialog = h('dialog', { class: 'receipt-pop receipt-window', id: 'receipt-window', 'aria-labelledby': 'rw-title' },
    h('div', { class: 'rw-head' },
      h('h2', { id: 'rw-title', text: 'This round’s receipt' }),
      h('button', { class: 'btn small', id: 'rw-close', type: 'button', text: 'Close', 'aria-label': 'Close the receipt', on: () => dialog.close() })),
    h('p', { class: 'rw-sub', id: 'rw-sub', text: 'Reading the record…' }),
    h('div', { class: 'rw-body', id: 'rw-body' }),
    h('div', { class: 'rw-foot' },
      h('a', { class: 'btn', id: 'rw-full', href: '#', target: '_blank', rel: 'noopener', text: 'Open full page' }),
      h('button', { class: 'btn primary', id: 'rw-done', type: 'button', text: 'Done', on: () => dialog.close() })));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // a tap outside the card
  dialog.addEventListener('close', () => { showing = null; opener?.focus?.(); });
  document.body.append(dialog);
}

async function fill(href, label) {
  const res = await fetch(`${href}.json`, { cache: 'no-store' }).catch(() => null);
  if (showing !== href) return;
  if (!res?.ok) { dialog.querySelector('#rw-sub').textContent = 'The record isn’t in the book yet. Try again in a moment, or open the full page.'; return; }
  const r = await res.json();
  if (showing !== href) return;
  dialog.querySelector('#rw-title').textContent = `This round’s receipt · ${label ?? r.label}`;
  dialog.querySelector('#rw-sub').textContent = `${r.label}. ${statusLine(r)}`;
  dialog.querySelector('#rw-body').replaceChildren(...receiptBoxes(r, { jsonHref: `${href}.json` }, state));
  if (r.status === 'posted' || ((r.status === 'opened' || r.status === 'over') && r.kind !== 'play')) setTimeout(() => { if (showing === href && dialog.open) fill(href, label); }, 8000); // still growing: a settle transaction may land
}

/** Opens the window for the record at `href` (/records/<game>/<number>). `label` is "Table 3 · Round 41". */
export function openReceiptWindow({ href, label }) {
  if (!dialog) build();
  if (showing !== href) state = { checked: false };
  showing = href;
  opener = document.activeElement;
  dialog.querySelector('#rw-title').textContent = `This round’s receipt${label ? ` · ${label}` : ''}`;
  dialog.querySelector('#rw-sub').textContent = 'Reading the record…';
  dialog.querySelector('#rw-body').replaceChildren();
  dialog.querySelector('#rw-full').href = href;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  dialog.querySelector('#rw-close').focus({ preventScroll: true });
  fill(href, label);
}

/**
 * The "This round's receipt" button on a table page: shown once the round has ended and the record has a number, hidden while a round
 * is in play (a record of a round in play is nearly empty, and Records has the old rounds). `record` is from roundRecord().
 */
export function paintReceiptButton(button, { record, finished }) {
  const on = !!record && finished;
  button.hidden = !on;
  if (!on) { button.dataset.href = ''; return; }
  if (button.dataset.href === record.href) return;
  button.dataset.href = record.href;
  button.textContent = 'This round’s receipt';
  button.title = `${record.label}: the record, checked here`;
  button.onclick = () => openReceiptWindow({ href: record.href, label: record.label });
}
