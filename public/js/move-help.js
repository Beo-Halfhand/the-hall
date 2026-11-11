// What each move does, in plain words, one piece for both tables (11-08). An outside player's first hand: "check, call and
// match aren't clear". In poker all three are betting words, and "call" means match a bet; here Call says a claim is a
// bluff, and what was "Match" pays up to a raise to stay in the pot. So every move in the row carries one line under it
// that says what it does, and a tap on a greyed move says the whole of it and why it's not open now.
//
// The line sits in the move's cell beside the button, never inside it: the button stays the real control, with its own
// words (and the price it shows), and the line never moves when the button is swapped for a live one.
import { h } from './common.js';

/** `short` goes under the button; `long` is what a tap on a greyed move (and the button's title) says. */
export const MOVE_WHAT = {
  // Sealed Hand
  pass: { short: 'Slide a card to the next seat', long: 'Pass: pick one card and slide it to the next seat. Everyone passes at once.' },
  stop: { short: 'End the passing with a claim', long: 'Stop & claim: end the passing now. Your claim is your turn in the lap.' },
  claim: { short: 'Name a hand, true or bluff', long: 'Claim: name a poker hand better than the one to beat. True or a bluff: nobody sees your cards.' },
  check: { short: 'Let the claim stand (free)', long: 'Check: let the claim stand. It’s free.' },
  call: { short: 'Say it’s a bluff; loser pays 5', long: 'Call: say it’s a bluff. The house checks the hand, and whoever’s wrong pays 5.' },
  match: { short: 'Pay up to the raise', long: 'Stay in: match the highest raise. You pay only the difference, and you stay in for the pot.' },
  fold: { short: 'Drop out of this pot', long: 'Fold: drop out of this pot. What you’ve paid stays in it.' },
  // Cup & Claim
  bid: { short: 'Guess a count across all cups', long: 'Bid: say at least how many dice show one face, every cup together. 1s are wild.' },
  liar: { short: 'Say the last bid is too high', long: 'Call liar: say the last bid is too high. Every cup is counted, and whoever’s wrong pays.' },
  sitout: { short: 'Sit the round out', long: 'Fold: sit the round out. What you’ve put in stays in the pot.' },
};

/** The line under a move, by id. */
export const whatLine = (id) => MOVE_WHAT[id]?.short ?? '';

/** What a tap on a greyed move says: the whole of what it does, then why not now. */
export const whyNot = (id, reason) => `${MOVE_WHAT[id]?.long ?? ''} Not now: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;

/**
 * Puts the row's buttons in their cells, in order, each with its line under it. `moves` is [{ id, el, what }]: the move,
 * its button (live or greyed), and which line goes under it (the move's own, unless `what` names another). Cells are made
 * once per move and kept, so a repaint that swaps only a button leaves the rest alone. Returns false when nothing changed.
 */
export function placeMoves(row, moves) {
  const cells = moves.map(({ id, el, what = id }) => {
    let cell = row.querySelector(`:scope > .move-cell[data-cell="${id}"]`);
    if (!cell) cell = h('div', { class: `move-cell ${id}`, dataset: { cell: id } });
    const lineId = `move-what-${id}`;
    let line = cell.querySelector('.move-what');
    if (!line) line = h('small', { class: 'move-what', id: lineId });
    if (line.textContent !== whatLine(what)) line.textContent = whatLine(what);
    if (!el.title) el.title = MOVE_WHAT[what]?.long ?? '';
    el.setAttribute('aria-describedby', [lineId, el.classList.contains('ghost') ? 'move-reason' : null].filter(Boolean).join(' '));
    if (cell.firstElementChild !== el || cell.lastElementChild !== line) cell.replaceChildren(el, line);
    return cell;
  });
  if (row.children.length === cells.length && cells.every((cell, i) => row.children[i] === cell)) return;
  row.replaceChildren(...cells);
}

/** True when the row already holds exactly these buttons, in this order. */
export const rowHolds = (row, els) => row.children.length === els.length && els.every((el, i) => row.children[i]?.firstElementChild === el);
