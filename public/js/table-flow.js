// Moving between tables with play chips, shared by the card and dice pages: one seat at a time, one stack, carried.
// Leaving a table sends its stack to the purse (at the end of the hand if one is on); sitting down takes the purse.

import { PLAYER_KEY, api, h, seatKey, store } from './common.js';

const GAME_NAMES = { 'sealed-hand': 'Sealed Hand', 'cup-and-claim': 'Cup & Claim' };
const apiOf = (page) => (page === '/dice' ? '/dice-tables' : '/tables');

/** "Sealed Hand, table 2": the game's name and the table's number, from the Hall's list or from the table itself (`n`) once it's off the list. */
export async function tableLabel(gameId, tableId, n = null) {
  try {
    const { games } = await api('GET', '/games');
    const game = games.find((g) => g.id === gameId);
    const table = game?.tables.find((t) => t.id === tableId);
    const number = table?.n ?? n;
    return `${game?.name ?? GAME_NAMES[gameId] ?? gameId}${number ? `, table ${number}` : ''}`;
  } catch {
    return `${GAME_NAMES[gameId] ?? gameId}${n ? `, table ${n}` : ''}`;
  }
}

/** The panel's chips line says "on chain" only at a tNIGHT table. A chip table's default, in the page's HTML, stays otherwise. */
export function paintTrust(view) {
  const line = document.getElementById('trust-chips');
  if (line && view?.cage) line.textContent = 'On chain.';
  const count = document.getElementById('trust-count');
  if (count && view?.proof) count.textContent = 'Sealed on chain before anyone sees a die, and checked on chain at a call. The house can’t pick your dice or see them. Bidding stays on the house’s server.';
}

/**
 * Leaves the seat at `from` (a row from /players/me/seats) and waits until it is gone, so the purse holds the stack. Uses the
 * seat token this browser kept, or takes the seat back with the player token first. `say` gets a line to show meanwhile.
 */
export async function leaveSeat(from, { say = () => {} } = {}) {
  const token = store.get(PLAYER_KEY);
  const fromApi = apiOf(from.page);
  let seatToken = store.get(seatKey(from.tableId));
  if (!seatToken) {
    const back = await api('POST', `${fromApi}/${from.tableId}/join`, { token, body: { kind: 'human' } });
    seatToken = back.token;
  }
  const left = await api('POST', `${fromApi}/${from.tableId}/leave`, { token: seatToken, body: {} });
  store.remove(seatKey(from.tableId));
  if (left.queued) {
    say(`Finishing the hand at ${await tableLabel(from.game, from.tableId, from.n)}. Your stack comes over when it ends.`);
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      const where = await api('GET', `${fromApi}/${from.tableId}/seat`, { token }).catch(() => ({ status: 'none' }));
      if (where.status !== 'seated') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * The join box's note when a seat is held somewhere else: where, with the way back, and the way to bring the stack here.
 * `sitHere` is the page's own join (the whole purse); `say` shows progress on the note.
 */
export async function elsewhereOffer(message, { sitHere, note }) {
  try {
    const { seats } = await api('GET', '/players/me/seats', { token: store.get(PLAYER_KEY) });
    const from = seats[0];
    if (!from) return message;
    const label = await tableLabel(from.game, from.tableId, from.n);
    const move = h('button', { id: 'join-move', class: 'btn primary small', type: 'button', text: 'Leave it and bring my stack here' });
    const back = h('a', { id: 'join-return', class: 'btn small', href: `${from.page}?id=${from.tableId}`, text: `Back to ${label}` });
    const line = h('span', { text: `You’re still seated at ${label} (${from.stack} chips). ` });
    move.addEventListener('click', async () => {
      move.disabled = true;
      move.setAttribute('aria-busy', 'true');
      move.textContent = 'Leaving it';
      try {
        await leaveSeat(from, { say: (t) => { line.textContent = `${t} `; } });
        line.textContent = 'Your stack is in your purse. Sitting down here… ';
        await sitHere();
      } catch (err) {
        move.disabled = false;
        move.removeAttribute('aria-busy');
        move.textContent = 'Leave it and bring my stack here';
        line.textContent = `Couldn’t move your seat: ${err.message} `;
      }
    });
    return h('span', { class: 'elsewhere' }, line, h('span', { class: 'row-buttons' }, move, back));
  } catch { /* the plain message will do */ }
  return message;
}

/**
 * The Hall's button while seated: a small confirm in the Hall's style. "Leave and go" is the page's own leave (the stack goes to
 * the purse, at the end of the hand if one is on), which ends in the Hall.
 */
export function confirmLeave({ game, stack, onLeave, where = 'the Hall', unit = 'chips' }) {
  let box = document.getElementById('confirm-leave');
  if (!box) {
    box = h('div', { class: 'dialogue confirm', id: 'confirm-leave', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-leave-line' });
    document.body.append(box);
  }
  const close = () => { box.hidden = true; };
  box.replaceChildren(
    h('p', { class: 'line', id: 'confirm-leave-line', text: `You’re seated at ${game} with ${stack} ${unit}. Leave the table and go to ${where}?` }), // the agreed words (11-07), with where the link was going
    h('div', { class: 'row-buttons' },
      h('button', { class: 'btn primary', id: 'confirm-leave-go', type: 'button', text: 'Leave and go', onClick: () => { close(); onLeave(); } }),
      h('button', { class: 'btn', id: 'confirm-leave-stay', type: 'button', text: 'Stay', onClick: close })));
  box.hidden = false;
  box.querySelector('#confirm-leave-go').focus();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, { once: true });
}

/** The other game in the Hall, for the Move button at a tNIGHT table. */
const OTHER_GAME = { '/table': { id: 'cup-and-claim', api: '/dice-tables', page: '/dice', name: 'Cup & Claim' }, '/dice': { id: 'sealed-hand', api: '/tables', page: '/table', name: 'Sealed Hand' } };
export const otherGame = (page) => OTHER_GAME[page];

/**
 * A tNIGHT table of the other game that can take a seat now: a warm one first, or any that's seating, or a new one. Its public view too, for the limits the seat is sized by.
 */
export async function hopTarget(page) {
  const other = OTHER_GAME[page];
  const { games } = await api('GET', '/games');
  const tables = games.find((g) => g.id === other.id)?.tables ?? [];
  const row = tables.find((t) => t.tnight && t.joinable && t.warm) ?? tables.find((t) => t.tnight && t.joinable);
  const tableId = row?.id ?? (await api('POST', other.api, { body: { tnight: true, bots: 2 } })).id;
  return { ...other, tableId, table: await api('GET', `${other.api}/${tableId}`) };
}
