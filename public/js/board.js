// The leaderboard page: this week's (or last week's) slate, best net first. The top three get medals; your own row is marked,
// and pinned to the foot of the screen whenever it isn't in view, or isn't in the top 50 at all.

import { PLAYER_KEY, api, faceEl, h, loadArt, store } from './common.js';
import { mountSupport } from './support.js';
import { mountNav } from './nav.js';

const $ = (id) => document.getElementById(id);
const MEDALS = ['gold', 'silver', 'bronze'];
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;

let week = 'this';
let data = null;
let watcher = null;

function row(r, { pinned = false } = {}) {
  return h('li', { class: `board-row ${r.you ? 'you' : ''} ${r.rank <= 3 ? 'top' : ''}`, dataset: { rank: r.rank }, ...(pinned ? {} : { id: r.you ? 'board-you' : null }) },
    r.rank <= 3 ? h('span', { class: `medal ${MEDALS[r.rank - 1]}`, 'aria-label': `${ordinal(r.rank)} place`, text: String(r.rank) }) : h('span', { class: 'board-rank', text: String(r.rank) }),
    faceEl({ kind: r.kind, avatar: r.avatar }, 32),
    h('span', { class: 'board-name' }, h('span', { class: 'board-who', text: r.you ? `${r.name} (you)` : r.name }),
      h('small', { text: `${r.rounds} round${r.rounds === 1 ? '' : 's'} · ${r.wins} won${r.kind === 'agent' ? ' · agent' : ''}` })),
    h('span', { class: `board-net ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}`, text: signed(r.net) }));
}

/** "New week in 2 days 4 hours", or when last week ran. */
function clock() {
  if (!data) return;
  const { start, end, which } = data.week;
  const day = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
  if (which === 'last') {
    $('board-clock').textContent = `${day(start)} to ${day(end - 1)}, Pacific`;
    return;
  }
  const left = Math.max(0, end - Date.now());
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  const mins = Math.floor((left % 3_600_000) / 60_000);
  $('board-clock').textContent = `New week in ${days ? `${days} day${days === 1 ? '' : 's'} ` : ''}${days || hours ? `${hours} hour${hours === 1 ? '' : 's'}` : `${mins} min`}`;
}

/** Your row at the foot of the screen while the real one is out of sight (or not in the list). */
function pin() {
  const bar = $('board-pinned');
  watcher?.disconnect();
  const you = data?.you;
  const token = store.get(PLAYER_KEY);
  if (!you) {
    bar.hidden = week !== 'this';
    bar.replaceChildren(h('p', { class: 'board-join' }, token ? 'You’re not on this week’s slate yet. ' : 'Sit at a chip table and win a round to get on the slate. ', h('a', { class: 'btn small primary', href: '/', text: 'Find a table' })));
    return;
  }
  bar.replaceChildren(h('ol', { class: 'board-list', 'aria-label': 'Your place' }, row(you, { pinned: true })));
  const mine = $('board-you');
  if (!mine) {
    bar.hidden = false;
    return;
  }
  bar.hidden = true;
  watcher = new IntersectionObserver(([entry]) => { bar.hidden = entry.isIntersecting; }, { rootMargin: '0px 0px -8px 0px' });
  watcher.observe(mine);
}

async function load() {
  $('status').textContent = 'Reading the slate…';
  try {
    data = await api('GET', `/board${week === 'last' ? '?week=last' : ''}`, { token: store.get(PLAYER_KEY) ?? undefined });
  } catch (err) {
    $('status').textContent = `The slate can’t be read just now: ${err.message}`;
    return;
  }
  $('board-list').replaceChildren(...data.rows.map((r) => row(r)));
  $('status').textContent = data.rows.length
    ? `${data.players} player${data.players === 1 ? '' : 's'} on the slate${data.players > data.rows.length ? `, top ${data.rows.length} shown` : ''}.`
    : week === 'this' ? 'Nobody on the slate yet this week. The first round won at a chip table puts someone on it.' : 'Nobody played a chip round last week.';
  clock();
  pin();
}

for (const b of document.querySelectorAll('[data-week]')) {
  b.addEventListener('click', () => {
    week = b.dataset.week;
    for (const x of document.querySelectorAll('[data-week]')) x.setAttribute('aria-pressed', String(x === b));
    load();
  });
}

mountSupport($('support'));
mountNav({ current: 'Records' });
await loadArt();
load();
setInterval(clock, 30_000);
