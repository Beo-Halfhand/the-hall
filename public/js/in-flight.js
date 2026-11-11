// A move or cash-out in progress, on any page (11-09: The owner pressed Menu in the middle of a move, and the next page didn't know a move was on).
// The page that runs it records it here; every page with the top menu shows it as a banner until it is done, and a move is finished from
// wherever the player is: the claim it made is watched, and once the judge has seated them the seat is theirs on that table's page.
// Light on purpose: no wallet and no cage code, so the Hall and the board can load it too.

const KEY = 'hall.inflight';
const MAX_AGE_MS = 45 * 60 * 1000; // a record this old is from a page that stopped long ago
const POLL_MS = 3000;
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
let mine = null; // the record this page itself is running: its own window shows it, so no banner here
let timer = null;

export function readInFlight() {
  const rec = safe(() => JSON.parse(localStorage.getItem(KEY)));
  if (!rec || typeof rec !== 'object' || !rec.kind || !rec.at) return null;
  if (Date.now() - rec.at > MAX_AGE_MS) { safe(() => localStorage.removeItem(KEY)); return null; }
  return rec;
}

/** Starts a record: { kind: 'move', to: { api, page, name, tableId, table }, fromTableId } or { kind: 'cashout', amount (tNIGHT, a number), phase }. */
export function startInFlight(rec) {
  mine = { ...rec, at: Date.now() };
  safe(() => localStorage.setItem(KEY, JSON.stringify(mine)));
  paint();
}

export function updateInFlight(patch) {
  const rec = readInFlight();
  if (!rec) return;
  const next = { ...rec, ...patch };
  if (mine) mine = next;
  safe(() => localStorage.setItem(KEY, JSON.stringify(next)));
  paint();
}

export function endInFlight() {
  mine = null;
  safe(() => localStorage.removeItem(KEY));
  paint();
}

const clock = (since) => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const here = (rec) => rec.kind === 'move' && new URLSearchParams(location.search).get('id') === rec.to?.tableId && location.pathname === rec.to?.page;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) { if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
  e.append(...kids.filter(Boolean));
  return e;
}

function bannerEl() {
  let b = document.getElementById('inflight');
  if (!b) {
    b = el('div', { id: 'inflight', class: 'inflight', role: 'status', 'aria-live': 'polite', hidden: '' });
    // Under the page's header (or the top bar where there is none), full width, so it never squeezes the header's own grid.
    const anchor = document.querySelector('header.hud') ?? document.querySelector('.topbar');
    if (anchor) anchor.after(b); else document.body.prepend(b);
  }
  return b;
}

/** Shows a finished move or a problem for a while, then goes. */
function say(b, text, link = null, done = true) {
  b.replaceChildren(...[el('span', { class: 'inflight-text', text }), link ? el('a', { class: 'btn small', href: link.href, text: link.text }) : null,
    done ? el('button', { class: 'btn small inflight-close', type: 'button', 'aria-label': 'Close', text: '×' }) : null].filter(Boolean));
  b.hidden = false;
  b.classList.toggle('done', done);
  b.querySelector('.inflight-close')?.addEventListener('click', () => { b.hidden = true; });
}

/** One look at a move's claim: seated, refused, lost, or still on its way. */
async function checkMove(rec, b) {
  const to = rec.to ?? {};
  const token = safe(() => localStorage.getItem(`cage.claim.${to.tableId}`));
  if (!token) {
    // The claim never went out (the page stopped before it asked), or the page that ran it already finished it.
    if (safe(() => localStorage.getItem(`hall.seat.${to.tableId}`))) { endInFlight(); say(b, `Seated at ${to.name}, table ${to.table} ✓`, here(rec) ? null : { href: `${to.page}?id=${to.tableId}`, text: 'Go to your seat' }); return; }
    endInFlight();
    say(b, `The move to ${to.name} didn’t start, so nothing changed. Your seat and your money are where they were.`);
    return;
  }
  try {
    const res = await fetch(`${to.api}/${to.tableId}/cage-seat`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.status === 401 || res.status === 404) {
      safe(() => localStorage.removeItem(`cage.claim.${to.tableId}`));
      endInFlight();
      say(b, `That table no longer knows the move to ${to.name}. Your money is as the cage shows: open the cage page to see it.`, { href: '/wallet', text: 'Open the cage' });
      return;
    }
    const body = await res.json();
    if (body.status === 'seated') {
      safe(() => { localStorage.setItem(`hall.seat.${to.tableId}`, token); localStorage.removeItem(`cage.claim.${to.tableId}`); if (rec.fromTableId) localStorage.removeItem(`hall.seat.${rec.fromTableId}`); });
      endInFlight();
      if (here(rec)) { location.reload(); return; } // this is the table: show the seat
      say(b, `Seated at ${to.name}, table ${to.table} ✓`, { href: `${to.page}?id=${to.tableId}`, text: 'Go to your seat' });
      return;
    }
    if (body.status === 'refused') {
      safe(() => localStorage.removeItem(`cage.claim.${to.tableId}`));
      endInFlight();
      say(b, `The move to ${to.name} didn’t go through: ${body.reason ?? 'the judge refused it'}. Your money is as the cage shows.`, { href: '/wallet', text: 'Open the cage' });
      return;
    }
    const step = body.step === 'sent' ? 'on its way to Midnight' : body.step === 'proving' ? 'the judge is moving your seat' : 'your last round finishes first, then the judge moves your seat';
    say(b, `Moving your seat to ${to.name}, table ${to.table}: ${step}. Nothing to approve. ${clock(rec.at)}`, here(rec) ? null : { href: `${to.page}?id=${to.tableId}`, text: 'Go there' }, false);
  } catch {
    say(b, `Moving your seat to ${to.name}, table ${to.table}… ${clock(rec.at)}`, null, false);
  }
}

const CASH_PHASE = {
  standing: 'standing up, so the judge can free your seat',
  freeing: 'waiting for the judge to free your seat',
  withdrawing: 'the withdraw was sent from your wallet: it may still land',
};

async function tick() {
  clearTimeout(timer);
  const rec = readInFlight();
  if (!rec || (mine && rec.at === mine.at)) { // nothing going on elsewhere: no element at all, unless a finished move is still being shown
    const b = document.getElementById('inflight');
    if (b && !b.classList.contains('done')) b.hidden = true;
    return;
  }
  const b = bannerEl();
  if (rec.kind === 'move') await checkMove(rec, b);
  else if (rec.kind === 'cashout') {
    const onCage = location.pathname === '/wallet';
    say(b, `Cashing out ${rec.amount ? `${rec.amount} tNIGHT` : 'your tNIGHT'}: ${CASH_PHASE[rec.phase] ?? 'in progress'}. ${rec.phase === 'withdrawing' ? 'Check the cage before you cash out again.' : 'It finishes on the cage page, with one approval.'} ${clock(rec.at)}`,
      onCage ? null : { href: rec.phase === 'withdrawing' ? '/wallet' : '/wallet?cashout=1', text: rec.phase === 'withdrawing' ? 'Check the cage' : 'Finish cashing out' }, false);
  }
  if (readInFlight()) timer = setTimeout(tick, POLL_MS);
}

function paint() { if (typeof document !== 'undefined' && document.body) tick(); }

/** Every page with the top menu calls this once. */
export function mountInFlightBanner() {
  paint();
  window.addEventListener('storage', (e) => { if (e.key === KEY) paint(); }); // another tab started or finished one
}
