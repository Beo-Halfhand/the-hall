// The seat cards' shared pieces, both games (11-07, Phase A): whose turn it is ("thinking…" on theirs, YOUR TURN in gold on
// yours, "choosing…" on a call), each seat's latest move in words, and the action overlays (a move pops in large on the card
// it belongs to, a call flashes, the verdict puts what it cost or paid on each card) with expiries, laid again when the strip
// is rebuilt. Each game page decides what counts as a move; this module draws it. Reduced motion: state only, no pop.

import { h } from './common.js';

export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The note under a seat: `turn` is on the clock, `deciding` is answering a call (every cup answers, so it says choosing, not thinking). */
export function turnNoteEl({ mine, turn, deciding = false }) {
  const text = !turn ? '' : deciding ? (mine ? 'Your call' : 'choosing…') : mine ? 'Your turn' : 'thinking…';
  return h('span', { class: `turn-note ${mine ? 'yours' : ''}`, text });
}

/** One line under the name: the seat's latest move. `kind` colours it (claimed, called, checked, bluff, folded, away, left). */
export const actionEl = (text, kind = '', short = null) => h('span', { class: `card-action ${kind}` }, h('span', { class: 'act-long', text: text ?? '' }), short ? h('span', { class: 'act-short', text: short }) : null);

/** A move, large, for a second: a count with a die, or words. */
export const popEl = (...children) => h('span', { class: `card-pop claim-pop ${children.every((c) => typeof c === 'string') ? 'words' : ''}`, 'aria-hidden': 'true' }, ...children);
/** A call, flashing: "Lie!" or "Called!". With reduced motion it just sits there. */
export const flashEl = (text) => h('span', { class: `card-pop lie-pop ${reduceMotion() ? 'still' : ''}`, 'aria-hidden': 'true', text });
/** The verdict on a card: a word and what it cost or paid. `kind` is right or wrong. */
export const verdictEl = (kind, word, delta = '') => h('span', { class: `card-verdict ${kind}` }, h('b', { text: word }), h('span', { class: 'delta', text: delta }));

/**
 * The overlays on one strip of cards. `card(seat)` finds a seat's card in the strip as it is now. `add` queues an overlay for
 * `ms`; `lay()` puts every live overlay on the cards (a rebuilt strip lost them) and drops the spent ones at their time.
 */
export function makeEffects(strip, card) {
  let effects = [];
  let nextId = 0;
  let sweep = null;
  const sweepNow = () => {
    const now = Date.now();
    effects = effects.filter((e) => e.until > now);
    strip.querySelectorAll('[data-effect]').forEach((n) => { if (!effects.some((e) => String(e.id) === n.dataset.effect)) n.remove(); });
    clearTimeout(sweep);
    sweep = effects.length ? setTimeout(sweepNow, Math.max(50, Math.min(...effects.map((e) => e.until)) - now + 20)) : null;
  };
  return {
    add(seat, kind, ms, build) { effects.push({ id: ++nextId, seat, kind, until: Date.now() + ms, build }); },
    lay() {
      for (const e of effects) {
        const c = card(e.seat);
        if (c && !c.querySelector(`[data-effect="${e.id}"]`)) { const n = e.build(); n.dataset.effect = e.id; c.append(n); }
      }
      sweepNow();
    },
    get live() { return effects.length; },
  };
}

/**
 * "Agent" (11-08, bring your own agent): on the seat card, in the round's moves and in Table talk, for anyone who sat down as an
 * agent. kind is what a seat said when it joined: the Hall's own pages say "human", a program that says nothing is an agent, and
 * only the house bots are "house". So the badge is the seat's word, the same as the API's kind.
 */
export const AGENT_TITLE = 'Agent: a program plays this seat (it said so when it sat down)';
export const isAgent = (seat) => !!seat && seat.kind === 'agent' && !seat.bot;
export const agentTag = (seat) => (isAgent(seat) ? h('span', { class: 'tag agent', title: AGENT_TITLE, text: 'Agent' }) : null);
/** The small inline form, next to a name in a list or a line of talk. */
export const agentMark = (seat) => (isAgent(seat) ? h('span', { class: 'agent-mark', title: AGENT_TITLE, text: 'Agent' }) : null);

/** "+5" / "−5" / "0". */
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
