// The deal, shown (11-08, seal-anchor preview), shared by both tables:
//   - the lock panel: "Locking your hand on Midnight…" with its steps, the seal's short hash, a timer, then "✓ block N" (lock mode),
//     or a plain line when it can't lock and the round plays on. Background mode never opens it: table talk says it instead.
//   - the card deal: five face-down cards with the Midnight mark fly from the deck to every seat in turn, after a short shuffle.
// Everything here is skippable (a tap, or the Skip button) and instant when the browser asks for reduced motion.

import { MIDNIGHT, h } from './common.js';
import { copyText } from './player-id.js';

export const EXPLORER_TX = 'https://preprod.midnightexplorer.com/transactions/';
export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const short = (x) => (x ? `${String(x).slice(0, 10)}…${String(x).slice(-6)}` : '');
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------- the round's name in the top banner (11-08) ----------

/** A copy button for a whole hash: says "Copied" for a moment. */
export function copyButton(value, label = 'Copy') {
  const b = h('button', { type: 'button', class: 'btn tiny copy-btn', text: label, title: 'Copy the whole hash' });
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(b.dataset.value ?? value);
    b.textContent = ok ? 'Copied' : 'Copy failed';
    clearTimeout(b.timer);
    b.timer = setTimeout(() => { b.textContent = label; }, 2000);
  });
  b.dataset.value = value;
  return b;
}

/**
 * "Table 22 · Round 1 · seal 74d7e8…68b0ae [Copy] [Receipt]" beside the game's name: every round named the way its record is, its seal
 * (the deck seal, or the dice fingerprint) copyable whole, and its receipt one tap away. Drawn only when something changed.
 */
export function paintRoundId({ record, seal, what = 'seal', onReceipt }) {
  const hud = document.querySelector('header.hud');
  if (!hud) return;
  let el = document.getElementById('round-id');
  if (!record) { if (el) el.hidden = true; return; }
  const key = `${record.label}|${seal ?? ''}`;
  if (el && el.dataset.key === key && !el.hidden) return;
  if (!el) { el = h('div', { class: 'round-strip', id: 'round-id', role: 'group', 'aria-label': "This round's name" }); hud.insertAdjacentElement('afterend', el); }
  el.hidden = false;
  el.dataset.key = key;
  const receipt = h('button', { type: 'button', class: 'rid-btn', id: 'round-receipt', text: 'Receipt', title: "This round's receipt" });
  receipt.addEventListener('click', (e) => { e.stopPropagation(); onReceipt?.(record); });
  const copy = seal ? copyButton(seal) : null;
  copy?.classList.replace('btn', 'rid-btn');
  copy?.classList.remove('tiny');
  el.replaceChildren(
    h('span', { class: 'rid-label', text: record.label }),
    ...(seal ? [h('span', { class: 'rid-seal' }, ` · ${what} `, h('code', { text: `${seal.slice(0, 6)}…${seal.slice(-6)}`, title: seal })), copy] : []),
    receipt);
}

// ---------- the lock panel ----------

const STEPS = (noun) => [
  ['sealed', noun === 'cup' ? 'Shaken and sealed' : 'Shuffled and sealed'],
  ['proving', 'Proving the lock'],
  ['sent', 'Sent to Midnight, waiting for a block'],
  ['done', 'Locked on Midnight'],
];
const stepIndex = (a) => {
  if (!a) return -1;
  if (a.state === 'anchored') return 3;
  if (a.step === 'sent') return 2;
  if (a.step === 'proving' || a.step === 'taken' || a.state === 'started') return 1;
  return 0;
};

/**
 * One panel per page. update() on every render with the table's view; it decides whether to show itself.
 *   noun: 'hand' | 'cup'   what is being locked, for the words
 *   onDone(): called once when a lock ends (landed, failed or timed out) and the panel has closed: the page reveals then
 */
export function mountLockPanel({ noun = 'hand', clock = () => Date.now(), onDone = () => {} } = {}) {
  const title = h('h3', { class: 'lock-title' });
  const hash = h('p', { class: 'lock-hash' });
  const list = h('ol', { class: 'lock-steps' });
  const timer = h('p', { class: 'lock-timer', 'aria-live': 'off' });
  const foot = h('p', { class: 'lock-foot' });
  const close = h('button', { type: 'button', class: 'btn small lock-close', text: 'Play on' });
  const panel = h('section', { class: 'lock-panel', id: 'lock-panel', role: 'status', 'aria-live': 'polite', hidden: true },
    h('div', { class: 'lock-mark' }, h('img', { src: MIDNIGHT.symbol, alt: '' })), title, hash, list, timer, foot, close);
  document.body.append(panel);
  let shownFor = null; // the round whose lock is on screen
  let closedFor = null;
  let finishedAt = null;
  let last = null;
  const finish = () => {
    panel.hidden = true;
    closedFor = shownFor;
    onDone(last);
  };
  close.addEventListener('click', finish);

  function paint(a, round) {
    last = a;
    const i = stepIndex(a);
    const failed = a.state === 'failed' || a.state === 'timeout';
    panel.classList.toggle('failed', failed);
    panel.classList.toggle('landed', a.state === 'anchored');
    title.textContent = a.state === 'anchored' ? `Locked on Midnight ✓ block ${a.block}` : failed ? `Couldn't lock your ${noun} on Midnight` : `Locking your ${noun} on Midnight…`;
    if (hash.dataset.seal !== String(a.seal ?? '')) { // copyable whole (11-08)
      hash.dataset.seal = String(a.seal ?? '');
      hash.replaceChildren(h('span', { text: noun === 'cup' ? 'Dice fingerprint ' : 'Deck seal ' }), h('code', { text: a.seal ? short(a.seal) : 'sealing…', title: a.seal ?? '' }), ...(a.seal ? [' ', copyButton(a.seal)] : []));
    }
    list.replaceChildren(...STEPS(noun).map(([key, label], k) => h('li', { class: failed && k > i ? 'skipped' : k < i || a.state === 'anchored' ? 'done' : k === i && !failed ? 'now' : '', dataset: { step: key } },
      h('span', { class: 'tick', 'aria-hidden': 'true', text: k < i || a.state === 'anchored' ? '✓' : k === i && !failed ? '•' : '' }), label)));
    const since = a.queuedAt ?? clock();
    timer.textContent = a.state === 'anchored' ? `${((a.landedAt ?? clock()) - since) / 1000 > 0 ? (((a.landedAt ?? clock()) - since) / 1000).toFixed(1) : '0'} s, deal to block` : failed ? '' : `${mmss(clock() - since)} · usually 40–55 s on preprod`;
    foot.replaceChildren(...(a.state === 'anchored' && a.txHash
      ? [h('a', { href: `${EXPLORER_TX}${a.txHash}`, target: '_blank', rel: 'noopener', text: `Transaction ${short(a.txHash)} on the explorer` })]
      : failed ? [h('span', { text: `${a.error ? `${a.error[0].toUpperCase()}${a.error.slice(1)}. ` : ''}The round plays on: the seal still stands on this server's record.` })]
        : [h('span', { text: `One write to Midnight preprod, before anyone moves. Nobody, the house included, can change ${noun === 'cup' ? 'a die' : 'a card'} after this.` })]));
    close.hidden = !failed;
    void round;
  }

  return {
    /** a = view.anchor, round = view.round. Opens for a lock-mode round in play; closes itself 1.6 s after the block. */
    update(a, round) {
      if (!a || a.mode !== 'lock' || a.state === 'idle') { if (!panel.hidden && shownFor !== round) finish(); return; }
      const live = a.held || ['sealing', 'queued', 'started'].includes(a.state);
      if (closedFor === round) return;
      if (shownFor !== round) {
        if (!live) return; // opened mid-round after the lock: nothing to show
        shownFor = round;
        finishedAt = null;
      }
      panel.hidden = false;
      paint(a, round);
      if (!live && finishedAt === null) {
        finishedAt = clock();
        setTimeout(() => { if (shownFor === round && closedFor !== round) finish(); }, a.state === 'anchored' ? 1600 : 4000); // a failure reads for 4 s, then the round is yours
      }
    },
    tick() { if (!panel.hidden && last && !(last.state === 'anchored' || last.state === 'failed' || last.state === 'timeout')) paint(last, shownFor); },
    get open() { return !panel.hidden; },
  };
}

/**
 * Background mode (the default, 11-08): one quiet line when the hand starts, "Locking this hand on Midnight (30–60 s). Enjoy your
 * game.", and a small notification when it lands, "Locked ✓ block N" with the explorer link (10 s). A failure says so for 8 s. Nothing
 * waits and nothing covers the table. A page opened after the start shows nothing for that round.
 */
export function mountAnchorNote({ noun = 'hand' } = {}) {
  const text = h('span', { class: 'an-text' });
  const close = h('button', { type: 'button', class: 'an-close', 'aria-label': 'Close', text: '×' });
  const note = h('div', { class: 'anchor-note', id: 'anchor-note', role: 'status', 'aria-live': 'polite', hidden: true }, h('img', { src: MIDNIGHT.symbol, alt: '' }), text, close);
  document.body.append(note);
  const thing = noun === 'cup' ? 'this roll' : 'this hand';
  let round = null, shown = null, timer = null, closedFor = null;
  const hide = () => { note.hidden = true; clearTimeout(timer); };
  close.addEventListener('click', () => { closedFor = `${round}:${shown}`; hide(); });
  const show = (kind, parts, ms) => {
    if (shown === kind || closedFor === `${round}:${kind}`) return;
    shown = kind;
    note.className = `anchor-note ${kind}`;
    text.replaceChildren(...parts);
    note.hidden = false;
    clearTimeout(timer);
    if (ms) timer = setTimeout(hide, ms);
  };
  return {
    update(a, r) {
      if (!a || a.mode !== 'background' || a.state === 'idle') { if (r !== round) hide(); return; }
      if (r !== round) { round = r; shown = null; hide(); if (!['sealing', 'queued', 'started'].includes(a.state)) { shown = 'late'; return; } }
      if (shown === 'late') return; // opened mid-round, after the lock: no note for this one
      if (['sealing', 'queued', 'started'].includes(a.state)) show('locking', [`Locking ${thing} on Midnight (30–60 s). Enjoy your game.`], 0);
      else if (a.state === 'anchored') show('landed', [`Locked ✓ block ${a.block} `, a.txHash ? h('a', { href: `${EXPLORER_TX}${a.txHash}`, target: '_blank', rel: 'noopener', text: 'explorer' }) : null], 10_000);
      else show('failed', [`Couldn't lock ${thing} on Midnight. It plays on, sealed on this server.`], 8_000);
    },
  };
}

/** Background mode's small line in the status panel: "Anchoring on Midnight…" then "Anchored ✓ block N" with the explorer link. */
export function anchorChip(a) {
  if (!a || a.state === 'idle') return null;
  if (a.state === 'anchored') return h('span', { class: 'anchor-chip done' }, `Anchored ✓ block ${a.block} `, a.txHash ? h('a', { href: `${EXPLORER_TX}${a.txHash}`, target: '_blank', rel: 'noopener', text: 'explorer' }) : null);
  if (a.state === 'failed' || a.state === 'timeout') return h('span', { class: 'anchor-chip failed', text: `Not anchored: ${a.error ?? a.state}` });
  return h('span', { class: 'anchor-chip', text: 'Anchoring on Midnight…' });
}

/** The preview's mode line: which way this table locks, and one tap to a fresh table that does it the other way. */
export function modeLine(view, game) {
  const mode = view?.anchor?.mode;
  if (!view?.anchorPicker || !mode) return null;
  const other = mode === 'lock' ? 'background' : 'lock';
  const said = { lock: 'lock first: the round waits for the block', background: 'background: the round never waits' };
  return h('p', { class: 'anchor-mode', id: 'anchor-mode' }, `Midnight lock: ${said[mode]}. `,
    h('a', { href: `/?anchor=${other}&play=${game}`, text: `Try ${other === 'lock' ? 'lock first' : 'background'} →` }));
}

/** A table-talk line about a lock gets its explorer link. */
export function anchorLinkFor(entry) {
  const tx = entry?.act?.kind === 'anchor' ? entry.act.tx : null;
  return tx ? [' ', h('a', { href: `${EXPLORER_TX}${tx}`, target: '_blank', rel: 'noopener', class: 'anchor-link', text: 'explorer' })] : [];
}

// ---------- the card deal ----------

const backEl = () => h('div', { class: 'fly-card' }, h('img', { src: MIDNIGHT.symbol, alt: '' }));

/**
 * Shuffle at `from`, then deal `rounds` cards to each target in turn (targets: [{ el, me? }]), face down. Resolves when done or
 * skipped. With reduced motion, or no room on screen, it resolves at once.
 */
export function dealCards({ from, targets, rounds = 5, perCardMs = 70 }) {
  return new Promise((resolve) => {
    const fromRect = from?.getBoundingClientRect();
    const live = targets.filter((t) => t.el && t.el.getBoundingClientRect().width > 0);
    if (reduceMotion() || document.hidden || !fromRect || fromRect.width === 0 || live.length === 0) return resolve(false);
    const layer = h('div', { class: 'deal-layer', 'aria-hidden': 'true' });
    const skip = h('button', { type: 'button', class: 'btn small deal-skip', text: 'Skip' });
    document.body.append(layer, skip);
    let done = false;
    const timers = [];
    const end = (skipped) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      layer.remove();
      skip.remove();
      window.removeEventListener('pointerdown', onTap, true);
      resolve(!skipped);
    };
    const onTap = (e) => { if (e.target !== skip) end(true); };
    skip.addEventListener('click', () => end(true));
    window.addEventListener('pointerdown', onTap, true);
    const cx = fromRect.left + fromRect.width / 2;
    const cy = fromRect.top + fromRect.height / 2;
    // the shuffle: the deck splits and riffles twice
    const deck = [0, 1, 2, 3].map((k) => { const c = backEl(); c.classList.add('deck'); c.style.setProperty('--x', `${cx}px`); c.style.setProperty('--y', `${cy}px`); c.style.setProperty('--k', k); layer.append(c); return c; });
    layer.classList.add('shuffling');
    const SHUFFLE_MS = 900;
    timers.push(setTimeout(() => { layer.classList.remove('shuffling'); deck.slice(1).forEach((c) => c.remove()); }, SHUFFLE_MS));
    let k = 0;
    for (let r = 0; r < rounds; r++) {
      for (const t of live) {
        const delay = SHUFFLE_MS + k * perCardMs;
        k += 1;
        timers.push(setTimeout(() => {
          const rect = t.el.getBoundingClientRect();
          const slots = t.slots?.() ?? null;
          const slot = slots?.[r]?.getBoundingClientRect();
          const tx = slot ? slot.left + slot.width / 2 : rect.left + (rect.width * (r + 0.5)) / rounds;
          const ty = slot ? slot.top + slot.height / 2 : rect.top + rect.height / 2;
          const c = backEl();
          c.classList.toggle('big', !!t.me);
          c.style.setProperty('--x', `${cx}px`);
          c.style.setProperty('--y', `${cy}px`);
          c.style.setProperty('--tx', `${tx - cx}px`);
          c.style.setProperty('--ty', `${ty - cy}px`);
          c.style.setProperty('--spin', `${(r - 2) * 6}deg`);
          layer.append(c);
          requestAnimationFrame(() => c.classList.add('go'));
          timers.push(setTimeout(() => c.classList.add('landed'), 380));
        }, delay));
      }
    }
    timers.push(setTimeout(() => end(false), SHUFFLE_MS + k * perCardMs + 520));
  });
}
