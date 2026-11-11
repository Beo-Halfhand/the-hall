// What a night is costing or paying, in plain words, for both games: the session total since sitting down, the one-line summary when a
// seat is left or its table closes, the brief +/- over your seat card, and the way on to a fresh table with your stack.
// It only keeps and draws: each game page says what the stack is and when something happened.

import { api, h, store } from './common.js';

export const fmt = (n) => Number(n).toLocaleString('en-US');
export const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');

const keyOf = (game, id) => `hall.session.${game}.${id}`;
const read = (game, id) => {
  try {
    const r = JSON.parse(store.get(keyOf(game, id)));
    return Number.isInteger(r?.start) && Number.isInteger(r?.added) ? r : null;
  } catch {
    return null;
  }
};

/**
 * This seat's session at this table: the stack it sat down with, and the chips added since (Add chips, Fill up), which are not wins.
 * Opened the first time the page sees the seat; a reload keeps it. Stored in this browser only.
 */
export function sessionOpen(game, id, stack) {
  const have = read(game, id);
  if (have) return have;
  const made = { start: stack, added: 0 };
  store.set(keyOf(game, id), JSON.stringify(made));
  return made;
}

export function sessionAdded(game, id, amount) {
  const rec = read(game, id);
  if (!rec || !Number.isInteger(amount) || amount < 1) return;
  store.set(keyOf(game, id), JSON.stringify({ ...rec, added: rec.added + amount }));
}

/** A fresh table for the same player carries the session on: same start, same additions, as long as the stack came with them. */
export function sessionCarry(game, fromId, toId) {
  const rec = read(game, fromId);
  if (rec) store.set(keyOf(game, toId), JSON.stringify(rec));
}

export const sessionNet = (rec, stack) => (rec ? stack - rec.start - rec.added : null);

/** "This session: −37" (or "even"): since sitting down, not counting chips added. */
export const sessionText = (rec, stack) => {
  const net = sessionNet(rec, stack);
  return net === null ? '' : `This session: ${net === 0 ? 'even' : signed(net)}`;
};

/** "Sat down with 1,000 · leaving with 963 (−37)": the line before anything else when a seat is left or its table closes. */
export function summaryText(rec, end) {
  if (!rec) return `Leaving with ${fmt(end)}`;
  const net = sessionNet(rec, end);
  return `Sat down with ${fmt(rec.start)}${rec.added ? `, added ${fmt(rec.added)}` : ''} · leaving with ${fmt(end)} (${net === 0 ? 'even' : signed(net)})`;
}

/** The round's own line, in the words a person would use: "You lost 12 · stack 988". */
export const verdictText = (net, stack) => `${net > 0 ? `You won ${fmt(net)}` : net < 0 ? `You lost ${fmt(-net)}` : 'You broke even'} · stack ${fmt(stack)}`;

/** A +/- that rises from your seat card for a moment. Fixed to the page, so the table's redraws can't wipe it. */
export function flashNet(card, net) {
  if (!card || !Number.isInteger(net) || net === 0) return;
  const r = card.getBoundingClientRect();
  if (!r.width) return;
  const el = h('span', { class: `net-flash ${net > 0 ? 'up' : 'down'}`, 'aria-hidden': 'true', text: signed(net) });
  el.style.cssText = `left:${Math.round(r.left + r.width / 2)}px;top:${Math.round(r.top + Math.min(r.height / 2, 60))}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 2800);
}

/**
 * The end of a seat, shown above the round's card and never in place of it: what the night came to, and the two ways on.
 *   kind     'left' (you left) or 'closed' (the table closed under you)
 *   reason   why a table closed, in words
 *   onNew    seats you at a fresh table of this game
 *   hallHref where the Hall is
 */
export function tableEnd({ kind, summary, reason = '', stack = 0, onNew, hallHref = '/' }) {
  let busy = false;
  const newButton = h('button', {
    type: 'button',
    class: 'btn primary',
    id: 'te-new',
    text: stack > 0 ? `Sit at a new table with ${fmt(stack)}` : 'Sit at a new table',
    onClick: async () => {
      if (busy) return;
      busy = true;
      newButton.disabled = true;
      newButton.textContent = 'Finding you a seat…';
      try {
        await onNew();
      } catch (err) {
        busy = false;
        newButton.disabled = false;
        newButton.textContent = stack > 0 ? `Sit at a new table with ${fmt(stack)}` : 'Sit at a new table';
        problem.textContent = err.message;
      }
    },
  });
  const problem = h('p', { class: 'te-problem', role: 'alert' });
  const why = reason ? plainClose(reason) : '';
  return h('section', { class: `table-end ${kind}`, id: 'table-end', role: 'status', 'aria-label': kind === 'closed' ? 'This table has closed' : 'You left the table' },
    // A table that closed says why first, in plain words; a seat you left says what the night came to first. Never a silent close.
    kind === 'closed' ? h('p', { class: 'te-head', id: 'te-head' }, h('b', { text: 'This table has closed.' }), ` ${why || 'No reason was recorded.'}`) : null,
    h('p', { class: 'te-summary', id: 'te-summary', text: summary }),
    kind === 'closed'
      ? h('p', { class: 'te-ask', id: 'te-ask', text: 'Sit at a new one?' })
      : h('p', { class: 'te-head', id: 'te-head' }, h('b', { text: 'You left the table.' }), ' Your chips are back in your purse.'),
    h('div', { class: 'te-moves' }, newButton, h('a', { class: 'btn', id: 'te-hall', href: hallHref, text: 'Back to the Hall' })),
    problem);
}

/** Why a table closed, in words a player would use. The server says it in plain words already; these cover its older phrasings. */
const CLOSE_WORDS = {
  'everyone has left': 'Everyone else left.',
  'no human action for too long': 'No moves for 30 minutes.',
  'one player left with chips': 'The other players ran out of chips.',
  'no human player has chips left': 'Not enough players to ante.',
};
export const plainClose = (reason) => CLOSE_WORDS[reason] ?? `${reason[0].toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}`;

/**
 * Opens a fresh table of this game and heads for it with the stack that came back. The stack goes to the purse as the old table
 * pays out, which takes a moment, so it waits for the purse to show it (up to a few seconds) before asking for the seat.
 */
export async function sitAtNewTable({ game, apiBase, page, fromId, stack, token, lobbySeconds = 15 }) {
  let buyin = stack;
  if (token && stack > 0) {
    for (let i = 0; i < 12; i++) {
      const me = await api('GET', '/players/me', { token }).catch(() => null);
      if (!me || me.purse.amount >= stack) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const me = await api('GET', '/players/me', { token }).catch(() => null);
    if (me) buyin = Math.min(stack, me.purse.amount);
  }
  const made = await api('POST', apiBase, { body: { lobbySeconds } });
  sessionCarry(game, fromId, made.id);
  window.location.href = `${page}?id=${made.id}&join=1${buyin > 0 ? `&buyin=${buyin}` : ''}`;
  return new Promise(() => {});
}
