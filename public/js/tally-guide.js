// Tally's first-sit guide, one piece for both games (11-07 for Cup & Claim; Sealed Hand's lap walkthrough 11-08). One short
// card the first time a player sits at that game, before their first move. Once per browser per game (localStorage, in
// try/catch: if storage fails it shows again rather than break). The "?" in the top bar and the button inside How to play
// reopen it. Page-side only: it never holds the deal, for this player or anyone else.
import { h } from './common.js';

const HALL_ART = '/art/hall/';

/** What Tally says at each game. `steps` is the claim-lap walkthrough: one lap, a move a line. */
export const GUIDES = {
  'cup-and-claim': {
    key: 'hall.dice.guided',
    id: 'dice-guide',
    title: "Liar's Dice, with a twist",
    text: "Everyone rolls in secret. Take turns claiming how many of a face are on the whole table (ones are wild). Anyone can call the last claim a lie. Whoever's wrong pays.",
  },
  'sealed-hand': {
    key: 'hall.hand.guided',
    id: 'hand-guide',
    title: 'Poker claims, with a pass',
    text: 'Five cards each, and only you see yours. One lap goes like this:',
    steps: [
      ['Pass', 'everyone slides one card to the next seat, all at once. Two passes at least, five at most.'],
      ['Claim', 'name a poker hand better than the one to beat. True, or a bluff: nobody sees your cards.'],
      ['Check', 'let the claim stand. It’s free.'],
      ['Call', 'say it’s a bluff. The house checks the hand, and whoever’s wrong pays 5.'],
    ],
    after: 'After the lap, the best claim still standing takes most of the pot.',
  },
};

const read = (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const remember = (key) => { try { localStorage.setItem(key, '1'); } catch { /* shown again next time, which is fine */ } };

/** Tally's portrait, as the Hall crops it from her sprite sheet; the drawn doorman when the sheet isn't there. */
function portrait(art) {
  const el = h('div', { class: 'portrait', 'aria-hidden': 'true' });
  const look = art?.sprites?.tally;
  if (!look) return el;
  const [fx, fy, across] = look.face;
  const k = 72 / across; // the box is 72 px on a phone; a wider screen scales the whole card's portrait by the same rule as the Hall
  el.classList.add('cropped', 'guide-portrait');
  el.style.backgroundImage = `url(${HALL_ART}${look.file})`;
  el.style.setProperty('--pw', `${look.w * 2 * k}px`);
  el.style.setProperty('--ph', `${look.h * k}px`);
  el.style.setProperty('--px', `${-fx * k}px`);
  el.style.setProperty('--py', `${-fy * k}px`);
  return el;
}

/** The guide for one game: open it, show it once on the first sit, and wire the buttons that reopen it. */
export function tallyGuide(game) {
  const guide = GUIDES[game];
  let box = null;

  /** Opens the card. `rules` is the How to play details element; `art` the Hall's art manifest (for the portrait). */
  function open({ art, rules, onClose } = {}) {
    if (!box) {
      box = h('div', { class: 'dialogue guide', id: guide.id, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'guide-title' });
      document.body.append(box);
    }
    const close = () => { box.hidden = true; remember(guide.key); onClose?.(); };
    const howTo = h('a', { class: 'guide-rules', id: 'guide-rules', href: '#rules-title', text: 'How to play' });
    howTo.addEventListener('click', (e) => {
      e.preventDefault();
      close();
      if (rules) { rules.open = true; rules.scrollIntoView({ block: 'start', behavior: 'smooth' }); rules.querySelector('summary')?.focus(); }
    });
    box.replaceChildren(
      portrait(art),
      h('div', { class: 'guide-body' },
        h('p', { class: 'speaker', text: 'Tally' }),
        h('h2', { class: 'guide-title', id: 'guide-title', text: guide.title }),
        h('p', { class: 'line guide-line', id: 'guide-line', text: guide.text }),
        guide.steps ? h('ol', { class: 'guide-steps', id: 'guide-steps', 'aria-label': 'One lap' }, guide.steps.map(([move, what]) => h('li', { dataset: { step: move.toLowerCase() } }, h('b', { text: `${move}:` }), ` ${what}`))) : null,
        guide.after ? h('p', { class: 'guide-after', id: 'guide-after', text: guide.after }) : null,
        h('div', { class: 'row-buttons guide-row' },
          h('button', { class: 'btn primary', id: 'guide-ok', type: 'button', text: 'Got it', onClick: close }),
          howTo)),
      h('button', { class: 'close', id: 'guide-close', type: 'button', 'aria-label': 'Close', text: '×', onClick: close }));
    box.hidden = false;
    box.querySelector('#guide-ok').focus({ preventScroll: true });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }

  const isOpen = () => !!box && !box.hidden;

  return {
    open,
    isOpen,
    /**
     * Called on every render once the page knows whether this visitor is seated. Shows the card once, the first time a seat
     * is theirs, and not while another dialogue (the cage's waiting window, the leave confirm) is up: it waits for the next render.
     */
    onFirstSit({ seated, art, rules }) {
      if (!seated || read(guide.key) || isOpen()) return false;
      if (document.querySelector('.dialogue:not(.guide):not([hidden])')) return false;
      open({ art, rules });
      return true;
    },
    /** The "?" in the top bar and "Tally's walkthrough" inside How to play: each reopens the card any time. */
    mount(buttons, { art, rules }) {
      for (const button of buttons.filter(Boolean)) {
        button.hidden = false;
        button.addEventListener('click', () => open({ art: art(), rules }));
      }
    },
  };
}
