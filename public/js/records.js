import { mountSupport } from './support.js';
import { mountNav } from './nav.js';

// The Records page: find a round by table and round number, or read the latest. Each row links to the round itself,
// where its dice can be rechecked in the browser.

const $ = (id) => document.getElementById(id);
const CHAIN_TX = (hash) => `https://preprod.midnightexplorer.com/transactions/${hash}`;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined));
  return el;
}

const BADGE = { posted: 'dice sealed', opened: 'opened', settled: 'settled on chain', void: 'did not settle' };
const HAND_BADGE = { posted: 'deck sealed', opened: 'deck opened', over: 'over', settled: 'settled on chain', void: 'did not settle' };
const GAMES = ['cup-and-claim', 'sealed-hand'];
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const faceWord = (face, many) => ['', '', 'two', 'three', 'four', 'five', 'six'][face] + (many ? 's' : '');
// A claim's fate as the table knows it. "standing" says nobody called it, and nothing about whether it was true.
const CLAIM_FATE = { standing: 'nobody called it', proven: 'called, and it held', caught: 'called: a bluff', withdrawn: 'withdrawn' };

/** A Sealed Hand round in a line: the claims and what became of them, then who was paid. */
function describeHand(r) {
  if (!r.result) return 'The cards are dealt. The round is in play.';
  const parts = [];
  if (r.claims?.length) parts.push(`${r.claims.map((c) => `${c.name}: ${c.label}, ${CLAIM_FATE[c.status] ?? c.status}`).join('. ')}.`);
  const res = r.result;
  const paid = (res.awards ?? []).map((a) => `${a.name} took ${a.amount}`).join(', ');
  if (res.kind === 'settled') parts.push(`${paid}.`);
  else if (res.kind === 'uncontested') parts.push(`Everyone else folded. ${paid}.`);
  else if (res.kind === 'carried') parts.push(`No claim stood: the pot of ${res.pot} carried to the next round.`);
  else if (res.kind === 'returned') parts.push(`The table closed and the pot of ${res.pot} went back${paid ? `: ${paid}` : ''}.`);
  else if (res.kind === 'void') parts.push('The round did not finish.');
  return parts.join(' ');
}

function describe(r) {
  if (r.game === 'sealed-hand') return describeHand(r);
  if (!r.claim && !r.result) return 'The dice are sealed. The round is in play.';
  const parts = [];
  if (r.claim) parts.push(`${r.claim.name} claimed at least ${r.claim.count} ${faceWord(r.claim.face, r.claim.count !== 1)}.`);
  if (r.call) parts.push(`${r.call.name} called Liar.`);
  if (r.result?.kind === 'call') parts.push(`The table counted ${r.result.total}: the claim ${r.result.held ? 'held' : 'fell'}. ${r.result.loser ? `${r.result.loser} paid.` : `${r.result.winner} took ${r.result.pot}.`}`);
  else if (r.result?.winner) parts.push(`Everyone else folded. ${r.result.winner} took ${r.result.pot}.`);
  else if (r.result?.kind === 'void') parts.push('The round did not finish.');
  return parts.join(' ');
}

// ---------- the receipt pop-up: one round, laid out like a receipt ----------

const GAME_NAME = { 'cup-and-claim': 'Cup & Claim', 'sealed-hand': 'Sealed Hand' };
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—');

/** Copies text; the old way where the clipboard API isn't allowed. Returns whether it worked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  const area = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  area.remove();
  return ok;
}

let opener = null; // what had focus, to go back to on close

function openReceipt(r) {
  const box = $('receipt');
  const id = `${r.game}/${r.number}`;
  const badge = (r.game === 'sealed-hand' ? HAND_BADGE : BADGE)[r.status] ?? r.status;
  const line = (label, ...value) => h('div', { class: 'rx-row' }, h('dt', { text: label }), h('dd', {}, ...value));
  const copied = h('span', { class: 'rx-copied', role: 'status' });
  const copy = h('button', { class: 'btn small', type: 'button', id: 'rx-copy', text: 'Copy' });
  copy.addEventListener('click', async () => {
    const ok = await copyText(id);
    copied.textContent = ok ? 'Copied' : 'Select it to copy';
  });
  const chips = r.chips?.length
    ? h('ul', { class: 'rx-chips' }, r.chips.map((c) => h('li', {}, h('span', {}, c.name, c.kind === 'agent' ? h('span', { class: 'agent-mark', title: 'Agent: a program played this seat (it said so when it sat down)', text: 'Agent' }) : null), h('span', { class: c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : '', text: signed(c.delta) }))))
    : h('span', { class: 'rx-quiet', text: r.result ? 'None' : 'Not yet: the round is in play' });
  const money = r.kind === 'tnight'
    ? [h('span', { text: 'tNIGHT on Midnight preprod (test NIGHT, no real money)' }), r.tx ? h('span', { class: 'rx-sub' }, 'Settle transaction ', h('a', { href: CHAIN_TX(r.tx), target: '_blank', rel: 'noopener', text: `${r.tx.slice(0, 16)}…` }), r.block ? ` · block ${r.block}` : '') : null]
    : [h('b', { text: 'Play chips, not on chain' }), h('span', { class: 'rx-sub', text: 'No money moved: these are the Hall’s free chips.' })];
  $('receipt-body').replaceChildren(
    h('div', { class: 'rx-head' },
      h('span', { class: `rx-pill ${r.status}`, id: 'rx-status', text: badge }),
      h('h2', { id: 'receipt-title', text: `Round ${r.round}` }),
      h('p', { class: 'rx-where', text: `${GAME_NAME[r.game] ?? r.game} · ${r.kind === 'tnight' ? 'tNIGHT table' : 'table'} ${r.table}` })),
    h('dl', { class: 'rx-rows' },
      line('Game', GAME_NAME[r.game] ?? r.game),
      line('Table and round', `${r.kind === 'tnight' ? 'tNIGHT table' : 'Table'} ${r.table} · Round ${r.round}`),
      line('Result', describe(r)),
      line('Chips moved', chips),
      line('Played for', ...money),
      line('Round ID', h('span', { class: 'rx-id' }, h('code', { id: 'rx-id', text: id }), copy, copied)),
      line('Started', when(r.postedAt)),
      line('Ended', r.closedAt ? when(r.closedAt) : r.result ? '—' : 'In play')),
    h('div', { class: 'rx-foot' },
      h('a', { class: 'btn', href: r.url, id: 'rx-full', text: r.game === 'cup-and-claim' ? 'Full record and dice check' : r.seal ? 'Full record and deck check' : 'Full record' }),
      h('button', { class: 'btn primary', type: 'button', id: 'rx-close', text: 'Done' })),
  );
  $('rx-close').addEventListener('click', () => box.close());
  opener = document.activeElement;
  box.showModal();
  $('rx-close').focus({ preventScroll: true }); // the receipt reads from its top
  box.scrollTop = 0;
}

function item(r) {
  const chips = r.chips?.length
    ? h('p', { class: 'rec-line rec-chips' }, 'Chips moved: ', r.chips.map((c, i) => [i ? ', ' : null, `${c.name}`, c.kind === 'agent' ? h('span', { class: 'agent-mark', title: 'Agent: a program played this seat (it said so when it sat down)', text: 'Agent' }) : null, ' ', h('span', { class: c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : '', text: signed(c.delta) })]))
    : null;
  const li = h('li', { class: 'rec-item', 'data-number': r.number },
    h('div', { class: 'rec-head' }, h('a', { href: r.url, text: r.label }), h('span', { class: `rec-badge ${r.status}`, text: (r.game === 'sealed-hand' ? HAND_BADGE : BADGE)[r.status] ?? r.status })),
    h('p', { class: 'rec-line', text: describe(r) }),
    chips,
    r.tx ? h('p', { class: 'rec-line' }, 'Settle transaction: ', h('a', { class: 'rec-tx', href: CHAIN_TX(r.tx), target: '_blank', rel: 'noopener', text: `${r.tx.slice(0, 16)}…` }), r.block ? ` · block ${r.block}` : '') : null,
    r.fingerprint ? h('p', { class: 'rec-fp' }, 'Fingerprint ', h('a', { href: r.url, text: r.fingerprint })) : null,
    r.seal ? h('p', { class: 'rec-fp' }, 'Deck seal ', h('a', { href: r.url, text: r.seal })) : null);
  // Clicking a round opens its receipt here. A plain click on its title does too; a new-tab click still goes to the full record.
  li.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !link.closest('.rec-head'))) return;
    e.preventDefault();
    openReceipt(r);
  });
  return li;
}

let query = {};
let next = null;

async function search({ append = false } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  if (append && next) q.set('before', next);
  const res = await fetch(`/records/search?${q}`, { cache: 'no-store' });
  if (!res.ok) {
    $('status').textContent = (await res.json().catch(() => ({}))).message ?? 'The book could not be read.';
    return;
  }
  const { records, next: more } = await res.json();
  next = more;
  const list = $('list');
  if (!append) list.replaceChildren();
  list.append(...records.map(item));
  const looking = query.table || query.round;
  $('status').textContent = records.length || append
    ? (looking ? `${list.children.length} round${list.children.length === 1 ? '' : 's'} found.` : 'The latest rounds, newest first.')
    : (looking ? 'No round with that number here.' : 'No rounds recorded yet.');
  $('more').hidden = !more;
}

function fromForm() {
  const val = (id) => $(id).value.trim();
  query = { game: val('f-game') === 'cup-and-claim' ? '' : val('f-game'), table: val('f-table'), round: val('f-round'), kind: val('f-kind') }; // Cup & Claim is the book's default
  const url = new URL(location.href);
  for (const k of ['game', 'table', 'round', 'kind']) query[k] ? url.searchParams.set(k, query[k]) : url.searchParams.delete(k);
  history.replaceState(null, '', url);
}

$('find').addEventListener('submit', (e) => {
  e.preventDefault();
  for (const id of ['f-table', 'f-round']) {
    if ($(id).value.trim() && !/^\d{1,15}$/.test($(id).value.trim())) { $('status').textContent = 'Table and round are whole numbers, such as table 3 and round 41.'; return; }
  }
  fromForm();
  search();
});
$('f-clear').addEventListener('click', () => {
  $('f-table').value = '';
  $('f-round').value = '';
  $('f-kind').value = '';
  fromForm();
  search();
});
$('more').addEventListener('click', () => search({ append: true }));
$('receipt').addEventListener('close', () => opener?.focus?.());
$('receipt').addEventListener('click', (e) => { if (e.target === $('receipt')) $('receipt').close(); }); // a tap outside the card
$('f-game').addEventListener('change', () => { fromForm(); search(); });

const start = new URLSearchParams(location.search);
$('f-game').value = GAMES.includes(start.get('game')) ? start.get('game') : 'cup-and-claim';
$('f-table').value = start.get('table') ?? '';
$('f-round').value = start.get('round') ?? '';
$('f-kind').value = start.get('kind') ?? '';
fromForm();
search();

mountSupport($('support'));
mountNav({ current: 'Records' });
