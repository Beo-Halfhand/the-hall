import { mountSupport } from './support.js';
import { mountNav } from './nav.js';
import { h, kickerTail, receiptBoxes, statusLine } from './receipt-view.js';

// A round's public receipt, the full page. It reads the JSON at this same address and draws it with receipt-view.js, the same piece the
// window over a table uses; the checks run in this browser with nothing from the server but the receipt.

const $ = (id) => document.getElementById(id);
// One page for both: /receipt/114-47 (a tNIGHT round) and /records/<game>/<number> (any round, play chips or tNIGHT).
const path = location.pathname.replace(/\.json$/, '');
const number = /^\/receipt\/(\d+-\d+)$/.exec(path)?.[1] ?? /^\/records\/[a-z-]+\/(t?\d+-\d+)$/.exec(path)?.[1];
const isRecord = path.startsWith('/records/');
const jsonHref = isRecord ? `${path}.json` : `/receipt/${number}.json`;

function render(r) {
  document.title = `${r.label} · ${isRecord ? 'record' : 'receipt'}`;
  $('title').textContent = r.label;
  const kicker = document.querySelector('.receipt-kicker');
  if (isRecord && kicker) kicker.replaceChildren(h('a', { href: '/' }, 'The Hall'), ' · ', h('a', { href: r.game === 'sealed-hand' ? '/records?game=sealed-hand' : '/records' }, 'Records'), ` · ${kickerTail(r)}`);
  $('status').textContent = statusLine(r);
  $('body').replaceChildren(...receiptBoxes(r, { jsonHref }, state));
}

let lastText = ''; // the receipt as last drawn, so a reload that brought nothing new leaves the page alone
const state = { checked: false }; // they pressed Check: the results are drawn again when the receipt grows, not wiped

async function load() {
  if (!number) { $('status').textContent = 'A number looks like 3-41 (table 3, round 41), or 114-47 for a tNIGHT receipt.'; return; }
  const res = await fetch(jsonHref, { cache: 'no-store' });
  if (!res.ok) { $('status').textContent = `No ${isRecord ? 'record' : 'receipt'} ${number} here.`; return; }
  const text = await res.text();
  const r = JSON.parse(text);
  if (text !== lastText) {
    lastText = text;
    render(r);
  }
  if (r.status === 'posted' || ((r.status === 'opened' || r.status === 'over') && r.kind !== 'play')) setTimeout(load, 8000); // it's still growing
}

load();

mountSupport(document.getElementById('support'));
mountNav();
