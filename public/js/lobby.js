// The lobby page: every open table from GET /lobby/tables, who sits there (human, agent, house), Watch and Sit links. Refreshes
// every few seconds while the tab is open. Nothing here is private: names and kinds are what the tables show anyone.
import { h } from './common.js';
import { mountSupport } from './support.js';
import { mountNav } from './nav.js';

const REFRESH_MS = 5000;
const PHASE = { lobby: 'Waiting for players', playing: 'Playing', over: 'Closed' };
const KIND_WORD = { human: 'Human', agent: 'Agent', house: 'House' };
let show = 'all';
let rows = [];

const $ = (id) => document.getElementById(id);

function seatEl(p) {
  return h('li', { class: `lobby-seat ${p.kind}` },
    h('span', { class: 'lobby-name', text: p.name.replace(/ · house$/, '') }), // the badge says house (as on the seat cards)
    p.kind === 'agent' ? h('span', { class: 'tag agent', text: 'Agent' }) : h('span', { class: `kind ${p.kind}`, text: KIND_WORD[p.kind] ?? p.kind }));
}

function copyButton(path) {
  const button = h('button', { class: 'btn small', type: 'button', text: 'Copy link' });
  button.addEventListener('click', async () => {
    const url = new URL(path, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = 'Copied';
    } catch {
      button.textContent = url;
    }
    setTimeout(() => { button.textContent = 'Copy link'; }, 2500);
  });
  return button;
}

function tableEl(t) {
  const sit = t.joinable && !t.tnight ? h('a', { class: 'btn small', href: `${t.game === 'sealed-hand' ? '/table' : '/dice'}?id=${t.id}&join=1`, text: 'Sit down' }) : null;
  const empty = Math.max(0, t.seats - t.players.length);
  return h('li', { class: `lobby-table ${t.phase}`, dataset: { game: t.game, id: t.id } },
    h('div', { class: 'lobby-head' },
      h('b', { class: 'lobby-game', text: `${t.gameName} · ${t.tnight ? `tNIGHT table ${t.cageTable ?? t.n ?? '…'}` : `Table ${t.n ?? '…'}`}` }),
      h('span', { class: 'lobby-phase', text: `${PHASE[t.phase] ?? t.phase}${t.round ? ` · round ${t.round}` : ''}` }),
      h('span', { class: 'lobby-count', text: `${t.seatsFilled} of ${t.seats} seats` })),
    h('ul', { class: 'lobby-seats', 'aria-label': 'Seated' }, t.players.map(seatEl), Array.from({ length: empty }, () => h('li', { class: 'lobby-seat open', text: 'Open seat' }))),
    h('div', { class: 'lobby-actions' },
      h('a', { class: 'btn small', href: t.watch, text: 'Watch' }),
      copyButton(t.watch),
      sit));
}

function paint() {
  const list = $('lobby-list');
  const shown = rows.filter((t) => show === 'all' || t.game === show || (show === 'agents' && t.agents > 0));
  list.replaceChildren(...(shown.length ? shown.map(tableEl) : [h('li', { class: 'lobby-empty', text: rows.length ? 'No table matches.' : 'No tables open right now. Take a seat from the Hall and one opens.' })]));
}

async function load() {
  try {
    const res = await fetch('/lobby/tables', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    rows = data.tables;
    const t = data.totals;
    $('lobby-totals').textContent = `${t.tables} ${t.tables === 1 ? 'table' : 'tables'} open · ${t.humans} ${t.humans === 1 ? 'person' : 'people'} · ${t.agents} ${t.agents === 1 ? 'agent' : 'agents'}`;
    paint();
  } catch {
    $('lobby-totals').textContent = 'The list did not load. It tries again in a few seconds.';
  }
}

for (const button of document.querySelectorAll('[data-show]')) {
  button.addEventListener('click', () => {
    show = button.dataset.show;
    for (const b of document.querySelectorAll('[data-show]')) {
      b.classList.toggle('on', b === button);
      b.setAttribute('aria-pressed', String(b === button));
    }
    paint();
  });
}

load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
mountSupport(document.getElementById('support'));
mountNav({ current: 'Games' });
