// The top bar, on every page: The Hall, Games, Agents, Records, and the Cage where the cage page is on. Built here so one
// list serves all pages. A link only exists for a page that exists; the rest are shown greyed, "coming soon", and do nothing.
//
// A table page passes `guard(href, label)`: while the player is seated it returns true after showing its own "Leave the table
// and go?" confirm, and the link then waits for the answer. Everywhere else a link is an ordinary link.

import { mountInFlightBanner } from './in-flight.js';

const SOON = 'coming soon';

/**
 * Forgets this browser's chips-or-tNIGHT choice, its Player ID (the purse; a copy is kept under hall.player.previous, as the Player ID
 * dialog does), its door session, the wallet it chose and the wallet's last reading, and any seats it holds. The cage player key
 * (cage.key.*) stays: that is the money in the cage, and it is never thrown away here.
 */
export function startFresh() {
  const keep = 'Forget this browser’s name and purse, its chips-or-tNIGHT choice, its wallet choice and its door session, and start as a new visitor? Your money in the cage stays under your player key, which is kept.';
  if (!window.confirm(keep)) return;
  try {
    const player = localStorage.getItem('hall.player');
    if (player) localStorage.setItem('hall.player.previous', player);
    for (const key of Object.keys(localStorage)) {
      if (['hall.mode', 'hall.player', 'hall.left', 'hall.tnight.told', 'cage.wallet', 'cage.door', 'cage.wallet-read'].includes(key) || key.startsWith('hall.seat.') || key.startsWith('cage.claim.')) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch { /* storage is off: nothing to forget */ }
  window.location.href = '/';
}

/** The cage's balance as the door last read it, on the Cage button: "Cage: 186 tNIGHT". Only with a door session in this browser; otherwise the plain word. */
async function labelCage(button) {
  let token = null;
  try { token = localStorage.getItem('cage.door'); } catch { /* storage off */ }
  if (!token) return;
  try {
    const res = await fetch('/door/me', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!res.ok) return;
    const door = await res.json();
    const whole = Math.floor(Number(door.balanceStar ?? 0) / 1_000_000);
    if (door.status === 'verified' && !door.expired && whole > 0) button.textContent = `Cage: ${whole.toLocaleString()} tNIGHT`;
  } catch { /* the plain word */ }
}

/**
 * Menu → Player → Change look (11-10): the same player and Player ID, a new face, from any page. No saved player: the Hall, which asks who
 * first. The window is look.js's, loaded on the press.
 */
async function changeLook() {
  let token = null;
  try { token = localStorage.getItem('hall.player'); } catch { /* storage off */ }
  if (!token) { window.location.href = '/'; return; }
  let current = null;
  try {
    const res = await fetch('/players/me', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.ok) current = (await res.json()).avatar ?? null;
  } catch { /* nothing preselected */ }
  const atTable = /^\/(table|dice)$/.test(window.location.pathname);
  const { pickLook } = await import('./look.js');
  await pickLook({ title: 'Change look', current, cancel: 'Keep this one', why: atTable ? 'Pick a new look. It shows from your next seat.' : 'Pick a new look. It follows you to every table.' });
}
/** Menu → Player → Player ID: the Hall's panel; from another page, the Hall opens it. */
function playerId() {
  const open = document.getElementById('settings-open');
  if (open) open.click();
  else window.location.href = '/?player-id=1';
}

/** One entry: a link, or a greyed line that can't be followed. */
const entry = (label, href) => ({ label, href });

const MENUS = [
  { label: 'The Hall', href: '/' },
  { label: 'Games', items: [entry('Start here', '/start'), entry('Sealed Hand', '/?play=sealed-hand'), entry('Cup & Claim', '/?play=cup-and-claim'), entry('Lobby: every table', '/lobby'), entry('Axe Lane')] },
  { label: 'Agents', items: [entry('Bring your agent', '/agents'), entry('Agent sheet (llms.txt)', '/agents/llms.txt'), entry('Midnight City')] },
  // Records: every round has a public number, searchable by table and round. A player's own history waits.
  { label: 'Records', items: [entry('Round records', '/records'), entry('Leaderboard', '/leaderboard'), entry('Your receipts'), entry('Hand history')] },
];

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.filter(Boolean));
  return node;
};

function link(item, guard, closeAll) {
  if (item.run) { // an action on this page (Menu → Player)
    const b = el('button', { class: 'nav-item', type: 'button', role: 'menuitem', id: item.id, text: item.label });
    b.addEventListener('click', () => { closeAll(); item.run(); });
    return el('li', { role: 'none' }, b);
  }
  if (!item.href) {
    return el('li', { role: 'none' }, el('span', { class: 'nav-item soon', role: 'menuitem', 'aria-disabled': 'true' }, item.label, ' ', el('small', { text: SOON })));
  }
  const a = el('a', { class: 'nav-item', href: item.href, role: 'menuitem', text: item.label });
  a.addEventListener('click', (e) => {
    closeAll();
    if (guard?.(item.href, item.label)) e.preventDefault();
  });
  return el('li', { role: 'none' }, a);
}

/**
 * Puts the bar into `header.hud` (replacing the page's own "◂ The Hall" button, which is its first link now), or at the top
 * of the page where there's no header. Returns { ready } for the Cage item, which waits on the server's word.
 */
export function mountNav({ guard = null, current = null } = {}) {
  if (document.getElementById('topnav')) return;
  const nav = el('nav', { id: 'topnav', class: 'topnav', 'aria-label': 'Main' });
  const burger = el('button', { class: 'btn small nav-burger', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'nav-list', text: '☰ Menu' });
  const list = el('ul', { class: 'nav-list', id: 'nav-list', role: 'menubar' });
  nav.append(burger, list);

  const closeAll = () => {
    list.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
    for (const b of nav.querySelectorAll('.nav-drop > button')) {
      b.setAttribute('aria-expanded', 'false');
      b.parentElement.classList.remove('open');
    }
  };
  const addMenu = (menu) => {
    if (menu.href) {
      const a = el('a', { class: 'btn small nav-top', href: menu.href, role: 'menuitem', text: menu.label, 'aria-current': current === menu.label ? 'page' : false });
      a.addEventListener('click', (e) => {
        closeAll();
        if (guard?.(menu.href, menu.label)) e.preventDefault();
      });
      list.append(el('li', { role: 'none', class: 'nav-li' }, a));
      return;
    }
    const button = el('button', { class: 'btn small nav-top', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, `${menu.label} `, el('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }));
    const sub = el('ul', { class: 'nav-menu', role: 'menu', 'aria-label': menu.label });
    for (const item of menu.items) sub.append(link(item, guard, closeAll));
    const drop = el('li', { class: 'nav-li nav-drop', role: 'none' }, button, sub);
    button.addEventListener('click', () => {
      const open = !drop.classList.contains('open');
      for (const other of nav.querySelectorAll('.nav-drop.open')) { other.classList.remove('open'); other.firstElementChild.setAttribute('aria-expanded', 'false'); }
      drop.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
    });
    list.append(drop);
    return drop;
  };
  for (const menu of MENUS) addMenu(menu);
  addMenu({ label: 'Player', items: [{ id: 'nav-change-look', label: 'Change look', run: changeLook }, { id: 'nav-player-id', label: 'Player ID', run: playerId }] });

  burger.addEventListener('click', () => {
    const open = !list.classList.contains('open');
    list.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) closeAll(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  const header = document.querySelector('header.hud');
  const oldHall = header?.querySelector(':scope > a.btn[href="/"]');
  if (header) {
    if (oldHall) oldHall.replaceWith(nav);
    else header.prepend(nav);
  } else {
    const bar = el('div', { class: 'topbar' }, nav);
    document.body.prepend(bar);
  }

  // The Cage is shown only where the server has the cage page on. Live has it off, so it is never added there.
  const ready = fetch('/games').then((res) => (res.ok ? res.json() : null)).then((data) => {
    if (data?.features?.wallet && !document.getElementById('nav-cage')) {
      const li = el('li', { class: 'nav-li', role: 'none' }, el('a', { id: 'nav-cage', class: 'btn small nav-top', href: '/wallet', role: 'menuitem', text: 'Cage', 'aria-current': current === 'Cage' ? 'page' : false }));
      li.firstChild.addEventListener('click', (e) => { closeAll(); if (guard?.('/wallet', 'the Cage')) e.preventDefault(); });
      list.append(li);
      labelCage(li.firstChild); // "Cage: 186 tNIGHT" whenever the cage holds something (11-07), in chips mode too
    }
    // Staging only (FRESH_START = "on"; live never has it): forget what this browser remembers, so the first-timer path can be walked again without a private window.
    if (data?.features?.fresh && !document.getElementById('nav-fresh')) {
      const b = el('button', { id: 'nav-fresh', class: 'btn small nav-top nav-fresh', type: 'button', role: 'menuitem', text: 'Start fresh as a new visitor' });
      b.addEventListener('click', () => { closeAll(); startFresh(); });
      list.append(el('li', { class: 'nav-li', role: 'none' }, b));
    }
  }).catch(() => {});
  mountInFlightBanner(); // a move or cash-out still going on another page (11-09)
  return { ready };
}
