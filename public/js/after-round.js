// The after-round card, shared by both games: your result, where you stand at the table, the top three, and the two next
// moves (Play again, Invite). It only draws: each game page says what the round was worth to this seat.

import { api, faceEl, go, h } from './common.js';
import { FIRST_WIN_LINE } from './player-id.js';
import { fmt, verdictText } from './money.js';

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const ordinal = (n) => {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${tail}`;
};
const MEDALS = ['gold', 'silver', 'bronze'];

/**
 * Seats still at the table, best stack first, each with its rank. Equal stacks share a rank (1, 2, 2, 4); within a tie the
 * lower seat number is listed first, so the order never jumps between polls.
 */
export function standings(seats) {
  const sitting = seats.map((x, seat) => ({ ...x, seat: x.seat ?? seat })).filter((x) => !x.left);
  sitting.sort((a, b) => b.chips - a.chips || a.seat - b.seat);
  let rank = 0;
  return sitting.map((x, i) => {
    if (i === 0 || x.chips !== sitting[i - 1].chips) rank = i + 1;
    return { ...x, rank };
  });
}

/** Copies text. The clipboard API needs a secure page and a recent press; the old way covers the rest. Returns whether it worked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  const area = h('textarea', { 'aria-hidden': 'true' });
  area.value = text;
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch { /* not allowed */ }
  area.remove();
  return ok;
}

let lastKey = '';
let weekFor = null; // the round the leaderboard was last asked about
let weekSeen = null; // { round, rank, players } once it answers
let lastArgs = null;

/** This week's place, asked once per round, a moment after it ends (the table sends its line to the leaderboard first). */
function askWeek(token, round) {
  if (!token || weekFor === round) return;
  weekFor = round;
  setTimeout(async () => {
    try {
      const board = await api('GET', '/board', { token });
      if (board.you) weekSeen = { round, rank: board.you.rank, players: board.players };
      if (lastArgs?.show && lastArgs.round === round) renderAfterRound(lastArgs.box, lastArgs);
    } catch { /* the card stands without it */ }
  }, 1500);
}

/**
 * Draws (or hides) the card in `box`.
 *   show      false hides it
 *   round     the round number
 *   net       chips this seat won (+) or lost (−) in the round
 *   seats     the table's public seats
 *   mySeat    this seat's number
 *   link      the Invite link: it seats a friend at a waiting table of this game, or a new one (never as a watcher)
 *   canNext   the next round can be dealt from here (Play again sends it); otherwise Play again goes back to the Hall for a new seat
 *   onNext    sends the next round
 *   againHref where Play again goes when the table is over
 *   note      one plain line under the result (what happened to the pot), optional
 *   playerToken  the player's token, if they have one: the card then adds their place on this week's leaderboard
 *   firstWin  the first round this browser has won with a Player ID: the card says where the chips live, once
 *   stack     this seat's stack now: the headline says it beside the round's number ("You lost 12 · stack 988")
 *   session   the session line under the headline ("This session: −37"), or empty
 *   broke     this seat can't ante the next round: the card says so and offers Fill up, not the next round
 *   onFillUp  brings the stack back to the full 1,000 (chips tables only)
 *   onLeave   leaves the table (the page then shows what the night came to)
 *   closed    the table is over: no next round, the page's own end panel says the way on
 */
export function renderAfterRound(box, args) {
  const { show, round, net, seats, mySeat, link, canNext, onNext, againHref, againLabel = null, note = '', playerToken = null, firstWin = false, onReceipt = null, stack = null, session = '', broke = false, onFillUp = null, onLeave = null, closed = false } = args;
  lastArgs = { ...args, box };
  if (show) askWeek(playerToken, round);
  const week = weekSeen?.round === round ? weekSeen : null;
  if (!show) {
    box.hidden = true;
    lastKey = '';
    return;
  }
  const table = standings(seats);
  const mine = table.find((x) => x.seat === mySeat);
  const top = table.slice(0, 3);
  const key = JSON.stringify([round, net, table.map((x) => [x.seat, x.chips, x.name]), mySeat, canNext, note, week, firstWin, !!onReceipt, stack, session, broke, !!onFillUp, !!onLeave, closed]);
  box.hidden = false;
  if (key === lastKey) return;
  lastKey = key;
  const verdict = Number.isInteger(stack) ? verdictText(net, stack) : net > 0 ? `You won ${fmt(net)}` : net < 0 ? `You lost ${fmt(-net)}` : 'You broke even';
  const row = (x) => h('li', { class: `ar-row ${x.seat === mySeat ? 'you' : ''}`, dataset: { seat: x.seat } },
    x.rank <= 3 ? h('span', { class: `medal ${MEDALS[x.rank - 1]}`, 'aria-label': `${ordinal(x.rank)} place`, text: String(x.rank) }) : h('span', { class: 'ar-rank', text: ordinal(x.rank) }),
    faceEl(x, 28),
    h('span', { class: 'ar-name', text: x.seat === mySeat ? `${x.name} (you)` : x.name }),
    h('span', { class: 'ar-chips', text: String(x.chips) }));
  const rows = top.map(row);
  if (mine && !top.some((x) => x.seat === mySeat)) rows.push(h('li', { class: 'ar-gap', 'aria-hidden': 'true', text: '⋯' }), row(mine));
  const status = h('span', { class: 'ar-copied', role: 'status' });
  const invite = h('button', {
    type: 'button',
    class: 'btn',
    id: 'ar-invite',
    text: 'Invite',
    onClick: async () => {
      const ok = await copyText(link);
      status.textContent = ok ? 'Invite link copied: it seats a friend at a table of this game' : link;
      clearTimeout(invite.timer);
      if (ok) invite.timer = setTimeout(() => { status.textContent = ''; }, 4000);
    },
  });
  // The next round, or (out of chips) Fill up; a closed table has neither, and the page's end panel offers the new table.
  const again = closed ? null
    : broke ? (onFillUp ? h('button', { type: 'button', class: 'btn primary', id: 'ar-fill-up', text: 'Fill up to 1,000', onClick: onFillUp }) : null)
    : canNext
      ? h('button', { type: 'button', class: 'btn primary', id: 'ar-again', dataset: { action: 'next' }, text: againLabel ?? 'Next round', onClick: onNext })
      : h('button', { type: 'button', class: 'btn primary', id: 'ar-again', text: 'Play again', onClick: () => go(againHref) });
  const leave = !closed && onLeave ? h('button', { type: 'button', class: 'btn', id: 'ar-leave', text: 'Leave table', onClick: onLeave }) : null;
  box.replaceChildren(...[
    h('div', { class: 'ar-head' },
      h('div', { class: 'ar-result' },
        h('span', { class: 'ar-kicker', text: `Round ${round}` }),
        h('span', { class: `ar-net ${net > 0 ? 'up' : net < 0 ? 'down' : ''}`, id: 'ar-net', text: signed(net) }),
        h('span', { class: 'ar-verdict', id: 'ar-verdict', text: verdict }),
        session ? h('span', { class: 'ar-session', id: 'ar-session', text: session }) : null),
      h('div', { class: 'ar-standing' },
        mine ? h('span', { class: 'ar-place', id: 'ar-place' }, h('b', { text: ordinal(mine.rank) }), ` by stack, of ${table.length} at this table`) : null,
        week ? h('a', { class: 'ar-week', id: 'ar-week', href: '/leaderboard', text: `#${week.rank} of ${week.players} this week` }) : null)),
    note ? h('p', { class: 'ar-note', text: note }) : null,
    broke && !closed ? h('p', { class: 'ar-broke', id: 'ar-broke', text: 'You’re out of chips. Fill up to 1,000 and play on, or leave. Nothing here closes on you.' }) : null,
    firstWin ? h('p', { class: 'ar-first-win', id: 'ar-first-win', text: FIRST_WIN_LINE }) : null,
    h('ol', { class: 'ar-top', 'aria-label': 'Top of the table' }, rows),
    h('div', { class: 'ar-moves' }, again, leave, invite,
      onReceipt ? h('button', { type: 'button', class: 'btn', id: 'ar-receipt', text: 'This round’s receipt', title: 'The round’s record, checked here', onClick: onReceipt }) : null, // once the round has ended, over the table (11-07)
      status),
  ].filter(Boolean));
}
