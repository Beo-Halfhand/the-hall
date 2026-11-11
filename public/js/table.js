// The table page. It holds no game logic: every control comes from the server's legal list, and every
// result from the public state. Watch mode sends no token to the table and never asks it for /me.
//
// Moves are two steps: pick something, then confirm it. What's picked lives only in this page until confirmed.

import { mountSupport } from './support.js';
import { placeMoves, rowHolds, whyNot } from './move-help.js';
import { tallyGuide } from './tally-guide.js';
import { confirmLeave, elsewhereOffer, hopTarget, otherGame, paintTrust } from './table-flow.js';
import { mountNav } from './nav.js';
import * as cage from './cage-session.js';
import { mountBuyIn, mountCashAsk, mountConnectStatus, mountPicker } from './buy-in.js';
import { HALL_ART, LEFT_KEY, MIDNIGHT, MODE_KEY, PLAYER_KEY, api, art, cardInfo, cropScene, faceEl, fitScale, go, h, loadArt, locking, pageScale, paintPhase, pressedButton, pressing, roundRecord, seatArt, seatKey, setupSound, store } from './common.js';
import { mountConnection } from './connection.js';
import { ART } from './hall-config.js';
import { renderAfterRound } from './after-round.js';
import { flashNet, fmt, plainClose, sessionAdded, sessionOpen, sessionText, sitAtNewTable, summaryText, tableEnd } from './money.js';
import { anchorChip, anchorLinkFor, dealCards, modeLine, mountAnchorNote, mountLockPanel, paintRoundId, reduceMotion as stillMotion } from './deal-show.js';
import { openReceiptWindow, paintReceiptButton } from './receipt-window.js';
import { firstWin } from './player-id.js';
import { actionEl, flashEl, makeEffects, popEl, reduceMotion, turnNoteEl, verdictEl, agentMark, agentTag } from './seat-cards.js';

const guide = tallyGuide('sealed-hand'); // Tally's first-sit card: one lap, pass, claim, check or call; "?" and How to play reopen it
const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;
const RING_STEPS = 24;
const PURSE_REFRESH_MS = 20_000;
const IN_ROUND = ['pass', 'claim', 'answer'];
// What a pressed move says while the table answers.
const WAIT_WORDS = { pass: 'Passing', stop: 'Claiming', claim: 'Claiming', call: 'Calling', check: 'Checking', match: 'Paying', fold: 'Folding', next: 'Dealing', back: 'Sitting back down' };
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const tableId = params.get('id');
const watching = params.get('watch') === '1';
const autoJoin = params.get('join') === '1';
const urlBuyIn = Number(params.get('buyin')) || undefined; // chosen in the Hall
const path = `/tables/${tableId}`;

let seatToken = watching ? null : store.get(seatKey(tableId));
let view = null;
let me = null;
let clockOffset = 0;
let lastLogN = 0;
let actionsKey = '';
let handKey = '';
let sceneKey = '';
let joining = false;
let joinOffer = null; // a seat here that's theirs to take back: { title, note, label }
let joinProblem = null; // why the last try to sit down didn't work: a string or an element
let seatedElsewhere = false; // refused because they have a seat at another table: the only move is back to it
let leavingNow = false;
let purseChips = null; // this player's purse, once known
let purseAsked = ''; // what the purse was last read for, so it's read when something could have changed it
let quickKey = '';
const logEls = new Map(); // log number → its element and text, so a line that changes can be redrawn
let busy = false;

// What the last pass brought. The highlight lasts until the next pass; the NEW badge about 2 s, unless the tab
// was hidden when it came, when it waits there until the next pass.
const NEW_MS = 2000;
const FLY_MS = 480;
let seenPasses = null; // null until the first look, so a reload doesn't replay a pass
let newCard = null;
let newTimer = null;
let flying = null; // the pass to animate on the next hand draw

// Picked, not yet confirmed.
let pickedCard = null;
let pickedClaim = null; // the claim from the server's list, once it's fully picked
let raiseAmount = 5;
let stakeMode = null; // what goes with a lap move: none | match | raise | fold. Picked afresh for each raise you face.
let stakeFor = '';
let stopOpenFor = null; // the pass window the Stop & claim panel is open in

// ---------- layout ----------

const useBack = () => (ART.cardBack === 'midnight' ? 'midnight' : 'seal');

/** The painted table if its image is here, or the code-drawn one. In art pixels. */
function sceneProfile() {
  if (art.table) {
    return { painted: true, w: art.table.w, h: art.table.h, frontTop: ART.scene.frontTop, seats: ART.scene.seats, backsTop: ART.scene.backsTop };
  }
  return { painted: false, w: 320, h: 144, frontTop: 104, seats: null, backsTop: 112 };
}

function fit() {
  const width = document.documentElement.clientWidth;
  const wide = width >= 980;
  const profile = sceneProfile();
  // Three columns on a wide screen (Phase A, 11-07): the round panel (240) | the room, with your hand under it | your move (340).
  const leftCol = wide ? Math.min(width, 1280) - (width >= 1280 ? 240 + 340 : 220 + 300) - 48 : width; // the side columns are narrower under 1280 (table3.css)
  const rightCol = leftCol;
  const { scale, soft } = profile.painted ? pageScale(leftCol, profile.w) : { scale: fitScale(leftCol, profile.w), soft: false };
  const uncropped = profile.painted && !soft ? Math.min(scale, 2) : Math.min(scale, 3);
  // Cropped, the card table shows from above the figures' heads (and the turn ring) down to the pot.
  const cropped = cropScene(uncropped, soft, profile.h, { top: 0.6, bottom: 0 });
  // A laptop-height screen in the three-zone layout: the room keeps its size and shows the band from above the heads to
  // the pot, so your hand and the move row stay in view. A tall screen shows it all.
  const { s, soft: softScene, top, bottom } = wide && window.innerHeight < 960 ? { s: uncropped, soft, top: 0.42, bottom: 0 } : cropped;
  const root = document.documentElement.style;
  root.setProperty('--s', s);
  root.setProperty('--crop-top', top);
  root.setProperty('--crop-bottom', bottom);
  root.setProperty('--scene-w', profile.w);
  root.setProperty('--scene-h', profile.h);
  $('scene').classList.toggle('soft', softScene);
  // Five cards across their box. On a sharp phone, snap to the width where one art pixel is one device pixel.
  const across = Math.min(84, Math.floor((rightCol - 76 - 16) / 5));
  const ratio = window.devicePixelRatio || 1;
  root.setProperty('--cw', ratio >= 3 && across >= 56 && across < 66 ? 56 : across);
  document.documentElement.classList.toggle('short', window.innerHeight < 940);
  if (profile.painted) {
    $('scene').classList.add('art');
    $('scene').style.backgroundImage = `url(${HALL_ART}${art.table.file})`;
    const wrap = $('scene').parentElement;
    wrap.classList.add('art');
    if (art.side) wrap.style.backgroundImage = `url(${HALL_ART}${art.side.file})`;
  }
  sceneKey = ''; // sizes changed: draw it again
}

// ---------- the scene ----------

function seatCentre(i, n, profile) {
  if (profile.seats && n === profile.seats.length) return profile.seats[i];
  return Math.round(((i + 0.5) * profile.w) / n);
}

/** Where a seat's figure goes: its waist at the table's edge, or sat on the code-drawn stool. */
function seatBox(seat, i, n, profile) {
  const { w, h: height } = seatArt(seat);
  const cx = seatCentre(i, n, profile);
  const y = profile.painted ? profile.frontTop - Math.round(height * 0.52) : 58;
  return { x: cx - w / 2, y, w, h: height, cx };
}

function frontLayer(profile) {
  const front = h('div', { class: 'front' });
  if (profile.painted) {
    const s = 'var(--s)';
    front.style.backgroundImage = `url(${HALL_ART}${art.table.file})`;
    front.style.top = `calc(${profile.frontTop} * ${s} * 1px)`;
    front.style.height = `calc(${profile.h - profile.frontTop} * ${s} * 1px)`;
    front.style.backgroundSize = `calc(${profile.w} * ${s} * 1px) calc(${profile.h} * ${s} * 1px)`;
    front.style.backgroundPosition = `0 calc(${-profile.frontTop} * ${s} * 1px)`;
  }
  return front;
}

// ---------- the pot on the felt ----------

const potTier = (amount) => (amount >= ART.pot.large ? 'large' : amount >= ART.pot.medium ? 'medium' : 'small');

function pileEl(tier) {
  const sprite = art.pot?.[tier];
  if (sprite) {
    const el = h('div', { class: 'pile sprite-pile', dataset: { tier }, vars: { pw: sprite.w, ph: sprite.h } });
    el.style.backgroundImage = `url(${HALL_ART}${sprite.file})`;
    return el;
  }
  // No art: coins from the code-drawn set, more of them for a bigger pile.
  const coins = { small: 2, medium: 5, large: 9 }[tier];
  return h('div', { class: 'pile coin-pile', dataset: { tier } }, Array.from({ length: coins }, () => h('img', { class: 'px', src: '/art/coin.png', alt: '' })));
}

function renderPot() {
  $('pot-limit').hidden = !view.potLimitReached;
  let wrap = $('scene').querySelector('.pot-on-felt');
  if (!wrap) {
    wrap = h('div', { class: 'pot-on-felt', id: 'felt-pot' });
    $('scene').append(wrap);
  }
  const { pot } = view;
  const carried = Math.min(view.carried ?? 0, pot);
  const fresh = pot - carried;
  wrap.hidden = pot <= 0;
  const key = `${pot}:${carried}`;
  if (wrap.dataset.key === key) return;
  wrap.dataset.key = key;
  wrap.dataset.tier = potTier(pot);
  wrap.replaceChildren(
    h('div', { class: 'piles' },
      fresh > 0 ? pileEl(potTier(fresh)) : null,
      carried > 0 ? h('div', { class: 'carried', title: `${carried} carried from the last round` }, pileEl('small'), h('span', { class: 'carried-label', text: `carried ${carried}` })) : null),
    h('div', { class: 'pot-amount', text: String(pot) }),
  );
}

// ---------- chips on the move ----------

const CHIP_MS = 520;
let seenChip = null; // null until the first look, so a reload doesn't replay anything

function chipSpot(place) {
  if (place === 'pot') return $('scene').querySelector('.pot-on-felt:not([hidden]) .pot-amount')?.getBoundingClientRect() ?? $('scene').getBoundingClientRect();
  return $('scene').querySelector(`[data-seat="${place}"]`)?.getBoundingClientRect();
}

function flyChips(move, delay) {
  const from = chipSpot(move.from);
  const to = chipSpot(move.to);
  if (!from || !to) return;
  const start = [from.left + from.width / 2, from.top + from.height * (move.from === 'pot' ? 0.2 : 0.55)];
  const end = [to.left + to.width / 2, to.top + to.height * (move.to === 'pot' ? 0.2 : 0.55)];
  const coins = Math.min(move.amount, 6);
  for (let i = 0; i < coins; i++) {
    const coin = h('img', { class: 'fly-chip px', src: '/art/coin.png', alt: '', dataset: { kind: move.kind } });
    coin.style.left = `${start[0] - 8}px`;
    coin.style.top = `${start[1] - 8}px`;
    document.body.append(coin);
    coin.animate(
      [{ transform: 'translate(0, 0)', opacity: 1 }, { transform: `translate(${end[0] - start[0]}px, ${end[1] - start[1]}px)`, opacity: 1 }],
      { duration: CHIP_MS, delay: delay + i * 55, easing: 'ease-in-out', fill: 'both' },
    ).finished.finally(() => coin.remove());
  }
  if (['win', 'sting', 'refund'].includes(move.kind)) {
    const label = h('span', { class: 'chip-label', dataset: { kind: move.kind }, text: `+${move.amount}` });
    label.style.left = `${end[0]}px`;
    label.style.top = `${end[1]}px`;
    document.body.append(label);
    label.animate(
      [{ transform: 'translate(-50%, 0)', opacity: 0 }, { transform: 'translate(-50%, -10px)', opacity: 1, offset: 0.25 }, { transform: 'translate(-50%, -26px)', opacity: 0 }],
      { duration: 1500, delay: delay + CHIP_MS, fill: 'both' },
    ).finished.finally(() => label.remove());
  }
}

/** Plays any chip movements this page hasn't seen. Shown to everyone, watchers too: they're public. */
function renderChipMoves() {
  const log = view.chipLog ?? [];
  const latest = log.at(-1)?.n ?? 0;
  if (seenChip === null) {
    seenChip = latest;
    return;
  }
  const fresh = log.filter((m) => m.n > seenChip);
  seenChip = Math.max(seenChip, latest);
  if (fresh.length === 0 || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  fresh.forEach((move, i) => flyChips(move, i * 110));
}

const midnightBack = () => h('div', { class: 'mini-back' }, h('img', { src: MIDNIGHT.symbol, alt: '' }));

function miniBack() {
  if (useBack() === 'midnight') return h('div', { class: 'mini-back' }, h('img', { src: MIDNIGHT.symbol, alt: '' }));
  return h('img', { src: '/art/back-mini.png', alt: '' });
}

function renderScene() {
  const profile = sceneProfile();
  const inPlay = IN_ROUND.includes(view.phase);
  // A seated player looks across the table: the others face them, and they're the corner portrait. A watcher sees every seat.
  const myself = viewerSeat();
  const key = JSON.stringify(view.seats.map((s) => [s.name, s.kind, s.avatar, s.status, s.away, s.gone])) + inPlay + myself;
  if (key !== sceneKey) {
    sceneKey = key;
    const nodes = [h('div', { class: 'night' }), frontLayer(profile)];
    const lights = profile.painted ? ART.scene.lights : [[24, 28, 60, 0.5], [288, 28, 60, 0.5], [160, 110, 110, 0.28]];
    for (const [x, y, r, a] of lights) nodes.push(h('div', { class: 'glow', vars: { x, y, r, a } }));
    view.seats.forEach((seat, i) => {
      if (i === myself || seat.gone) return; // a seat that left a round ago drops off
      const box = drawnBox(seat, i, profile);
      nodes.push(spriteSeat(seat, i, box));
      if (seat.status === 'in' && inPlay) { // their hand: five cards, face down, the Midnight mark on each back (11-08)
        const across = profile.painted ? 22 : 14;
        nodes.push(h('div', { class: 'backs five', dataset: { backs: i }, vars: { x: box.cx - across, y: profile.backsTop }, 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(midnightBack)));
      }
    });
    $('scene').replaceChildren(...nodes);
  }
  $('scene').querySelectorAll('.ring').forEach((el) => el.remove());
  for (const clock of view.clocks ?? []) {
    if (!view.seats[clock.seat] || clock.seat === myself) continue;
    const box = drawnBox(view.seats[clock.seat], clock.seat, profile);
    $('scene').append(h('div', { class: 'ring', dataset: { ring: clock.seat }, vars: { x: box.cx, y: Math.max(box.y - 4, 0), p: 1 } }, h('span')));
  }
  renderCorner(myself);
}

/** The seat this page is playing, if it's still in it. */
/** "left · 1,011": a seat that left shows what went back to the purse, not 0 chips (which reads as busted), for one round. */
const leftText = (seat) => (Number.isFinite(seat.leftWith) ? `left · ${seat.leftWith.toLocaleString('en-US')}` : 'left');

const viewerSeat = () => (me && !watching && view.seats[me.seat] && !view.seats[me.seat].left ? me.seat : null);

/** Where a seat is drawn. Round the table from the viewer's left, so the others keep their order across a re-seat. */
function drawnBox(seat, i, profile) {
  const myself = viewerSeat();
  const n = view.seatsTotal;
  if (myself === null) return seatBox(seat, i, n, profile);
  return seatBox(seat, (i - myself - 1 + n) % n, n - 1, profile);
}

/** The viewer: small, in the top-right corner of the scene, with their name and stack, lit up on their turn. */
function renderCorner(myself) {
  const scene = $('scene');
  let corner = scene.querySelector('#me-corner');
  if (myself === null) {
    corner?.remove();
    return;
  }
  const seat = view.seats[myself];
  const lookKey = `${myself}:${seat.avatar}:${seat.kind}`;
  if (!corner || corner.dataset.look !== lookKey) {
    corner?.remove();
    corner = h('div', { class: 'me-corner', id: 'me-corner', dataset: { seat: myself, look: lookKey } },
      faceEl(seat, 40),
      h('span', { class: 'me-name', text: seat.name }),
      h('span', { class: 'me-chips', id: 'me-chips' }));
    scene.append(corner);
  }
  corner.querySelector('#me-chips').textContent = String(seat.chips);
  const myTurn = view.waitingOn.includes(myself);
  corner.classList.toggle('turn', myTurn);
  corner.classList.toggle('folded', seat.status === 'folded');
  const clock = (view.clocks ?? []).find((x) => x.seat === myself);
  if (clock) corner.append(h('div', { class: 'ring', dataset: { ring: myself }, vars: { p: 1 } }, h('span')));
}

function spriteSeat(seat, i, box) {
  const el = h('div', { class: `sprite seat frames ${seat.status} ${seat.away ? 'away' : ''}`, dataset: { seat: i, sprite: seat.kind }, vars: { x: box.x, y: box.y, sw: box.w, sh: box.h } });
  el.style.backgroundImage = `url(${seatArt(seat).url})`;
  el.style.animationDelay = `${-i * 0.37}s`;
  return el;
}

/** The seat a card goes to from `i` this round: the next seat still in. Null when there is none. */
function passTo(i) {
  if (view.round === 0 || view.seats[i]?.status !== 'in') return null;
  const n = view.seatsTotal;
  for (let k = 1; k < n; k++) {
    const other = view.seats[(i + k) % n];
    if (other?.status === 'in') return (i + k) % n;
  }
  return null;
}

/** This round's moves, as the table's log tags them (engine.js: pass raises and matches, stops, claims, calls, checks, folds, and the lap's own lines), oldest first. */
const roundActs = () => (view?.log ?? []).filter((l) => l.act && l.round === view.round);
const lastActOf = (seat) => roundActs().filter((l) => l.act.seat === seat).at(-1) ?? null;

/** What a seat just did, in a few words, for its card: [text, kind]. The kind colours it (seat-cards.css). */
function seatAction(seat, i) {
  if (seat.left) return ['left the table', 'left'];
  if (seat.away) return ['away', 'away'];
  if (seat.status === 'folded') return ['folded', 'folded'];
  if (!IN_ROUND.includes(view.phase)) return ['', ''];
  if (view.anchor?.held) return ['', '']; // the round waits on its lock: nobody has moved, whatever the empty clock suggests
  const claim = view.claims.find((c) => c.seat === i);
  if (claim?.status === 'caught') return [`caught bluffing: ${claim.label}`, 'bluff'];
  if (claim?.status === 'proven') return [`${claim.label}: called, true`, 'checked'];
  const a = lastActOf(i)?.act ?? null;
  if (view.phase === 'pass') {
    if (a && a.passNo === view.passNo && a.kind === 'raise') return [`passes and raises ${a.n}`, 'claimed'];
    if (a && a.passNo === view.passNo && a.kind === 'match') return [`passes and stays in for ${a.n}`, ''];
    const to = passTo(i);
    if (!view.waitingOn.includes(i) && !view.raise && to !== null) return [`passed a card to ${nameOf(to)}`, '', `passed to ${nameOf(to).replace(' · house', '')}`];
    return ['', ''];
  }
  switch (a?.kind) {
    case 'stop': return [`stopped & claims ${a.label}`, 'claimed'];
    case 'claim': return [`claims ${a.label}`, 'claimed'];
    case 'call': return [`called ${nameOf(a.target)}: ${a.result === 'bluff' ? 'bluff!' : 'it was true'}`, a.result === 'bluff' ? 'checked' : 'called'];
    case 'check': return ['checked', ''];
    case 'raise': return [`raised to ${a.n}`, 'claimed'];
    case 'match': return [`stayed in for ${a.n}`, ''];
    default: return claim ? [`claims ${claim.label}`, 'claimed'] : ['', ''];
  }
}

/** The top row: one card per chair (seat-cards.css). Face, name, stack, what the seat just did, and whose turn it is. */
function renderPlates() {
  const plates = $('plates');
  plates.style.setProperty('--n', view.seatsTotal);
  const nodes = [];
  const inRound = IN_ROUND.includes(view.phase);
  for (let i = 0; i < view.seatsTotal; i++) {
    const seat = view.seats[i];
    if (!seat || seat.gone) {
      nodes.push(h('div', { class: 'seat-card seat-plate open', title: 'An open seat' }, h('span', { class: 'name', text: 'Open seat' })));
      continue;
    }
    const mine = me?.seat === i;
    const turn = view.waitingOn.includes(i) && inRound;
    const held = inRound && (seat.status === 'in' || seat.status === 'folded') ? 5 : 0;
    const [action, kind, short] = seatAction(seat, i);
    nodes.push(h('div', {
      class: `seat-card seat-plate ${seat.status} ${turn ? 'turn' : ''} ${mine ? 'mine' : ''}`,
      dataset: { plate: i, seatCard: i },
    },
    faceEl(seat, 32),
    h('span', { class: 'name', text: seat.name.replace(/ · house$/, '') }), // the badge says house, for Tally as for the other bots (11-07)
    h('small', { class: 'held-n', text: held ? `${held} cards` : '' }), // a small "5 cards" where it fits (Phase A)
    h('span', { class: seat.left ? 'chips left' : 'chips' }, seat.left ? leftText(seat) : [h('img', { class: 'px', src: '/art/coin.png', alt: '' }), String(seat.chips)]),
    h('span', { class: 'held', title: held ? `${held} cards, face down` : 'No cards', 'aria-label': held ? `${held} cards held` : 'no cards' }, ...Array.from({ length: Math.min(held, 5) }, () => h('i', { class: 'held-card' }))),
    actionEl(action, kind, short),
    turnNoteEl({ mine, turn }),
    h('div', { class: 'tags' },
      mine ? h('span', { class: 'tag you', text: 'you' }) : null,
      agentTag(seat),
      seat.kind === 'house' ? h('span', { class: 'tag house', text: 'house' }) : null,
      seat.away ? h('span', { class: 'tag away', text: 'away' }) : null),
    h('span', { class: 'rep', title: 'claims called / checked / caught', text: `${seat.rep.called}/${seat.rep.proven}/${seat.rep.caught}` }),
    view.lapRaise?.paid[i] ? h('span', { class: 'rep lap-paid', text: `in for ${view.lapRaise.paid[i]}` }) : null,
    seat.left ? h('span', { class: 'rep', text: 'left' }) : null,
    seat.leaving ? h('span', { class: 'rep', text: 'leaving' }) : null,
    passRow(seat, i)));
  }
  plates.replaceChildren(...nodes);
}

// ---------- the action on the cards (Phase A, 11-07, as Cup & Claim's round 3) ----------

const effects = makeEffects($('plates'), (seat) => $('plates').querySelector(`[data-plate="${seat}"]`));
let effectsPrimed = false;
let seenActN = 0;
let seenResult = '';

/**
 * What just happened, on the card it happened to: a claim pops in large on the claimer's card (a second, then it settles into
 * the card's line); a call flashes Called! on the caller's card and puts Checked or Bluff! with the chips on the claimer's; the
 * round's end puts Won or Lost and the net on every card that moved, held three seconds. Reduced motion: no pop, no flash.
 */
function renderCardEffects() {
  const acts = roundActs();
  const newest = acts.at(-1) ?? null;
  const r = view.lastResult;
  const resultKey = r && r.round === view.round && ['settled', 'over'].includes(view.phase) && r.kind !== 'returned' ? `${r.round}` : '';
  if (!effectsPrimed) { // the first view of the table: nothing pops for what's already on it
    effectsPrimed = true;
    seenActN = newest?.n ?? 0;
    seenResult = resultKey;
    return;
  }
  const quiet = reduceMotion();
  for (const l of acts) {
    if (l.n <= seenActN) continue;
    const a = l.act;
    if (a.seat === null || a.seat === undefined) continue;
    if ((a.kind === 'claim' || a.kind === 'stop') && !quiet) effects.add(a.seat, 'claim', 1100, () => popEl(a.label));
    else if (a.kind === 'raise' && !quiet) effects.add(a.seat, 'claim', 1100, () => popEl(a.passNo ? `Raise ${a.n}` : `Raise to ${a.n}`));
    else if (a.kind === 'call') {
      effects.add(a.seat, 'call', 3000, () => flashEl('Called!'));
      effects.add(a.target, 'verdict', 3000, () => verdictEl(a.result === 'bluff' ? 'wrong' : 'right', a.result === 'bluff' ? 'Bluff!' : 'Checked', a.result === 'bluff' ? `−${a.paid}` : `+${a.paid}`));
    }
  }
  seenActN = Math.max(seenActN, newest?.n ?? 0);
  if (resultKey && resultKey !== seenResult) {
    seenResult = resultKey;
    for (const [seat, m] of Object.entries(r.money ?? {})) {
      const net = (m?.out ?? 0) - (m?.in ?? 0);
      if (!net) continue;
      effects.add(Number(seat), 'verdict', 3000, () => verdictEl(net > 0 ? 'right' : 'wrong', net > 0 ? 'Won' : 'Lost', signed(net)));
    }
  }
  effects.lay();
}

/** A move in the round log, in words: "claims <b>pair of 9s</b>", "calls Tally: <b>it was true</b>". */
function actWords(a) {
  switch (a.kind) {
    case 'raise': return a.passNo ? [`passes and raises ${a.n}`] : [`raises to ${a.n}`];
    case 'match': return a.passNo ? [`passes and stays in for ${a.n}`] : [`stays in for ${a.n}`];
    case 'fold': return [a.withdrew ? 'folds, claim withdrawn' : 'folds'];
    case 'stop': return ['stops & claims ', h('b', { text: a.label })];
    case 'claim': return ['claims ', h('b', { text: a.label })];
    case 'call': return [`calls ${nameOf(a.target)}: `, h('b', { text: a.result === 'bluff' ? 'bluff!' : 'it was true' })];
    case 'check': return ['checks'];
    default: return [''];
  }
}

/** The left panel's live list of this round's moves, newest at the bottom and lit (as Cup & Claim's bids). */
function renderRoundLog() {
  const list = $('round-log');
  const acts = roundActs();
  const key = JSON.stringify([view.round, acts.map((l) => l.n)]);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  const rows = acts.map((l, i) => {
    const top = i === acts.length - 1 ? 'top' : '';
    const a = l.act;
    if (a.seat === null || a.seat === undefined) return h('li', { class: `plain ${top}`, text: l.text.replace(/\.$/, '') });
    return h('li', { class: top }, faceEl(view.seats[a.seat] ?? {}, 18), h('span', { class: 'who' }, seatWord2(a.seat), agentMark(view.seats[a.seat])), h('span', { class: 'what' }, ...actWords(a)));
  });
  list.replaceChildren(...(rows.length ? rows : [h('li', { class: 'empty', text: IN_ROUND.includes(view.phase) ? 'No moves yet this round.' : 'The moves show here once the cards are dealt.' })]));
  list.scrollTop = list.scrollHeight;
}

/** A seat's passes this round as tiny face-down backs, and which way its cards go. Counts only: never a card. */
function passRow(seat, i) {
  if (view.round === 0) return null;
  const n = view.seatsTotal;
  let to = null;
  if (seat.status === 'in') {
    for (let k = 1; k < n; k++) {
      const other = view.seats[(i + k) % n];
      if (other?.status === 'in') {
        to = (i + k) % n;
        break;
      }
    }
  }
  const backs = Array.from({ length: seat.passCount ?? 0 }, () => h('span', { class: 'tiny-back', 'aria-hidden': 'true' }));
  const label = to === null ? null : `Passes to ${nameOf(to)}`;
  return h('div', { class: 'pass-row', title: `${seat.passCount ?? 0} passed this round` }, backs,
    to === null ? null : h('span', { class: 'pass-arrow', dataset: { to }, title: label, 'aria-label': label, role: 'img', text: to > i ? '→' : '↩' }));
}

// ---------- status ----------

const nameOf = (seat) => view.seats[seat]?.name ?? `Seat ${seat}`;
/** The round as its record numbers it: at a tNIGHT table, the round the chain counts it as, as Cup & Claim's page shows it. */
const shownRound = (round) => (view.cage ? (view.cage.chainBase ?? 0) + round : round);

/** The round has ended: its record is complete, with the deck opened. */
const roundOver = () => !!view && (view.phase === 'settled' || view.phase === 'over') && view.lastResult?.round === view.round;

/** The deck seal in the status panel: sealed at the deal, opened when the round ends. */
function paintSeal(record) {
  const row = $('sp-seal-row');
  if (!row) return;
  const seal = view?.deal?.seal ?? null;
  row.hidden = !seal;
  if (!seal) return;
  const opened = !!view.deal.opened;
  const a = view.anchor?.seal === seal ? view.anchor : null;
  const key = `${seal}:${opened}:${record?.href ?? ''}:${a?.state ?? ''}:${a?.block ?? ''}`;
  if (row.dataset.key === key) return;
  row.dataset.key = key;
  $('sp-seal').textContent = `${seal.slice(0, 12)}…`;
  $('sp-seal').title = seal;
  const chip = anchorChip(a);
  $('sp-seal-note').replaceChildren(opened ? 'opened: recheck it on the receipt' : 'sealed before the deal', ...(chip ? [h('br'), chip] : []));
}

function phaseText() {
  const { phase, passNo, limits } = view;
  const round = shownRound(view.round);
  if (phase === 'lobby') return view.cage && (view.seats.length > 0 || view.cage.waiting.length > 0) && (view.cage.housePending || view.cage.waiting.length) ? 'Seating the table' : 'Waiting for players';
  if (phase === 'pass') return `Round ${round} · Pass ${passNo} of ${limits.maxPasses}${view.passRaise?.high ? ` · Raise ${view.passRaise.high}` : ''}`;
  // On a phone the panel is a scroll below the table, so the price goes up here too.
  if (me?.facing && view.waitingOn[0] === me.seat) return `Round ${round} · Stay in for ${me.facing.owed}, or fold`;
  if (phase === 'claim') return `Round ${round} · Claim lap`;
  if (phase === 'answer') return `Round ${round} · Stay in or fold`;
  if (phase === 'settled') return `Round ${round} over`;
  return 'Table closed';
}

/** The top bar: what's on the table, what's in the purse. */
async function renderPurse() {
  const token = store.get(PLAYER_KEY);
  const asked = `${seatToken ? 1 : 0}:${view.phase}:${view.round}:${Math.floor(Date.now() / PURSE_REFRESH_MS)}`;
  if (token && asked !== purseAsked) {
    purseAsked = asked;
    try {
      purseChips = (await api('GET', '/players/me', { token })).purse.amount;
    } catch {
      purseAsked = ''; // try again on the next poll
    }
  }
  paintPurse();
}

function paintPurse() {
  const seat = me && view.seats[me.seat];
  if (seat && !seat.left) store.set(MODE_KEY, view.cage ? 'tnight' : 'chips'); // a seat says how they play: the Hall keeps to it
  const parts = [];
  // "Your stack N · Purse N" (chips) or "Your stack N · In the cage N tNIGHT" (11-06, round 2): "On the table" read like the pot. The pot stays in the status line.
  if (seat && !seat.left && view.phase !== 'over') parts.push(`Your stack ${fmt(seat.chips)}`);
  if (seat && !seat.left && !view.cage && view.phase !== 'over') parts.push(sessionText(sessionOpen('sealed-hand', tableId, seat.chips), seat.chips)); // what the night is costing or paying, since sitting down
  const inCage = me && view.cage?.seats.find((x) => x.seat === me.seat);
  if (view.cage) {
    if (inCage) parts.push(`In the cage ${cageLive(inCage, seat)} tNIGHT${cageSplit(inCage, seat)}`);
  } else if (store.get(PLAYER_KEY) && purseChips !== null) parts.push(`Purse ${fmt(purseChips)}`);
  const text = parts.join(' · ');
  // Each part keeps together and the line breaks between parts, so a narrow header reads as tidy lines, never a column of single words.
  $('purse-bar').replaceChildren(...parts.flatMap((part, i) => [i ? ' · ' : '', h('span', { class: 'pb', text: part })]));
  $('purse-line').textContent = text;
  renderAddChips();
}

// ---------- add chips: from the purse to the stack, between rounds ----------

function renderAddChips() {
  const box = $('add-chips');
  box.hidden = watching || !me?.canAddChips || purseChips === null;
  const stackNow = me && view.seats[me.seat]?.chips;
  $('fill-up').hidden = box.hidden || !me.canFillUp || !(stackNow < STACK_FULL); // one tap back to the full stack, free and as often as you like
  if (box.hidden) {
    $('add-chips-form').hidden = true;
    return;
  }
  $('add-chips-open').disabled = purseChips < 1;
  if (purseChips < 1) $('add-chips-form').hidden = true;
  $('add-chips-amount').max = purseChips;
  $('add-chips-of').textContent = `of your ${purseChips}`;
  paintAddConfirm();
}

const STACK_FULL = 1000; // what a chip table seats you with, and what Fill up brings you back to

/** Fill up: the stack back to 1,000, free, as often as it's wanted. The chips added are not winnings: the session total leaves them out. */
async function fillUp() {
  if (busy || !seatToken) return;
  busy = true;
  $('error').textContent = '';
  const release = pressing(pressedButton() ?? $('fill-up'), 'Filling up');
  try {
    const res = await api('POST', `${path}/fill-up`, { token: seatToken, body: {} });
    sessionAdded('sealed-hand', tableId, res.added);
    me = res.me;
    if (res.purse) purseChips = res.purse.amount;
    $('add-chips-form').hidden = true;
    accept(res.state);
    release();
    render();
  } catch (err) {
    release();
    $('error').textContent = err.message;
  } finally {
    busy = false;
  }
}

const addAmount = () => Number($('add-chips-amount').value);
const addAmountOk = () => Number.isInteger(addAmount()) && addAmount() >= 1 && addAmount() <= purseChips;

function paintAddConfirm() {
  const confirm = $('add-chips-confirm');
  confirm.disabled = !addAmountOk();
  confirm.textContent = addAmountOk() ? `Add ${addAmount()} to the table` : `Choose 1 to ${purseChips}`;
}

function openAddChips() {
  const form = $('add-chips-form');
  form.hidden = !form.hidden;
  if (form.hidden) return;
  $('add-chips-amount').value = purseChips;
  const half = Math.floor(purseChips / 2);
  $('add-chips-presets').replaceChildren(...[[purseChips, 'All'], [half, 'Half'], [100, '100']].filter(([n], i) => n >= 1 && n <= purseChips && (i === 0 || n !== purseChips)).map(([n, label]) => h('button', {
    type: 'button',
    class: 'btn small',
    text: label,
    dataset: { add: n },
    onClick: () => {
      $('add-chips-amount').value = n;
      paintAddConfirm();
    },
  })));
  paintAddConfirm();
}

async function confirmAddChips(e) {
  e.preventDefault();
  if (!addAmountOk() || busy) return;
  busy = true;
  $('error').textContent = '';
  const release = pressing($('add-chips-confirm'), 'Adding', { lock: $('add-chips') });
  try {
    let res;
    try {
      res = await api('POST', `${path}/add-chips`, { body: { amount: addAmount() }, token: seatToken });
    } finally {
      release(); // before the redraw, which decides for itself what is on or off
    }
    sessionAdded('sealed-hand', tableId, addAmount());
    me = res.me;
    purseChips = res.purse.amount;
    $('add-chips-form').hidden = true;
    accept(res.state);
    render();
  } catch (err) {
    $('error').textContent = err.message;
    purseAsked = ''; // the purse may not be what this page thought
  } finally {
    busy = false;
  }
}

function renderStatus() {
  const record = roundRecord(view, 'sealed-hand');
  paintPhase($('phase'), phaseText(), record); // "Table 3 · Round 41", the round's public number
  paintReceiptButton($('round-receipt-open'), { record, finished: roundOver() }); // "This round's receipt", once the round has ended (11-07)
  paintSeal(record);
  $('pot').textContent = view.pot;
}

function renderClock() {
  if (!view) return;
  const now = Date.now() + clockOffset;
  const seating = $('seating');
  if (!seating.hidden && view.cage) { // the judge's count-up; at a chip table the notice holds the deal-now button instead
    const from = view.cage?.timings?.claimedAt ?? view.cage?.waitingSince;
    seating.lastChild.textContent = from ? `${mmss(Math.max(0, now - from))} so far` : '';
  }
  if (view.deadline) {
    const left = Math.max(0, Math.ceil((view.deadline - now) / 1000));
    $('clock').textContent = view.phase === 'settled' ? `Next round in ${left}s` : `${left}s`;
    $('clock').classList.toggle('urgent', left <= 10 && IN_ROUND.includes(view.phase));
  } else {
    $('clock').textContent = ''; // a table with no clock still has bots thinking, so their rings run on below
    $('clock').classList.remove('urgent');
  }
  for (const clock of view.clocks ?? []) {
    const ring = $('scene').querySelector(`[data-ring="${clock.seat}"]`);
    if (!ring || !clock.until) continue; // no clock at this table: the ring just shows whose turn it is
    const span = Math.max(1, clock.until - (clock.from ?? clock.until - view.limits.turnMs));
    const share = Math.max(0, Math.min(1, (clock.until - now) / span));
    ring.style.setProperty('--p', Math.ceil(share * RING_STEPS) / RING_STEPS);
    ring.firstChild.textContent = String(Math.max(0, Math.ceil((clock.until - now) / 1000)));
  }
}

/** The left panel: claim to beat, pot, your stack, passes left, round, whose turn. On a phone, the same in one line. */
function renderStatusPanel() {
  const top = topStanding();
  const inRound = IN_ROUND.includes(view.phase);
  const beat = top ? `${seatWord2(top.seat)}: ${top.label}` : view.phase === 'pass' ? 'Claims come after the passing' : inRound ? 'No claim yet' : '—';
  const stack = me && !watching && view.seats[me.seat] ? view.seats[me.seat].chips : null;
  const passesLeft = view.phase === 'pass' ? Math.max(0, view.limits.maxPasses - view.passNo + 1) : null;
  const turn = inRound && view.waitingOn.length ? view.waitingOn.map(seatWord2).join(', ') : view.phase === 'settled' ? 'Between rounds' : view.phase === 'lobby' ? 'Waiting for players' : '—';
  const yours = inRound && me && view.waitingOn.includes(me.seat);
  $('sp-beat').textContent = beat;
  $('sp-stack').textContent = stack === null ? 'Watching' : String(stack);
  $('sp-passes').textContent = passesLeft === null ? '—' : `${passesLeft} of ${view.limits.maxPasses}${view.limits.minPasses ? ` · stop from pass ${view.limits.minPasses}` : ''}`;
  $('sp-round').textContent = view.round ? `Round ${shownRound(view.round)}` : '—';
  $('sp-turn').textContent = turn;
  $('sp-turn').closest('div').classList.toggle('yours', !!yours);
  $('status-panel').classList.toggle('your-turn', !!yours);
  $('sp-line').textContent = [top ? `Beat ${top.label}` : null, `Pot ${view.pot}`, stack === null ? null : `You ${stack}`, passesLeft === null ? null : `${passesLeft} passes left`, inRound && view.waitingOn.length ? (yours ? 'Your turn' : `${seatWord2(view.waitingOn[0])}’s turn`) : null].filter(Boolean).join(' · ');
  const banner = $('claim-banner');
  const raise = view.lapRaise?.high || view.passRaise?.high;
  const text = top && ['claim', 'answer'].includes(view.phase) ? `To beat: ${top.label}` : raise && inRound ? `Raise stands at ${raise}` : '';
  banner.hidden = !text;
  banner.textContent = text;
  banner.title = top ? `${nameOf(top.seat)}’s claim, ${top.status === 'proven' ? 'called and checked' : 'not shown'}` : '';
}

/** "You", or the seat's name. */
const seatWord2 = (seat) => (me && !watching && seat === me.seat ? 'You' : nameOf(seat));

function renderClaims() {
  const list = view.claims.map((c) => h('li', {},
    h('span', { text: `${nameOf(c.seat)}: ${c.label}` }),
    h('span', { class: `st ${c.status}`, text: c.status })));
  if (list.length === 0) list.push(h('li', { class: 'empty', text: view.phase === 'claim' ? 'No claims yet.' : 'Claims open after the passing.' }));
  $('claims').replaceChildren(...list);
}

const lineParts = (entry) => (entry.say
  ? [view.seats[entry.seat] ? faceEl(view.seats[entry.seat], 20) : null, h('b', {}, entry.name, agentMark(view.seats[entry.seat]), ': '), entry.text]
  : [entry.text, ...anchorLinkFor(entry)]);

function renderLog() {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  for (const entry of view.log) {
    const known = logEls.get(entry.n);
    if (known) {
      if (known.text !== entry.text) { // a scripted bot line that became an AI line
        known.el.replaceChildren(...lineParts(entry));
        known.text = entry.text;
      }
      continue;
    }
    if (entry.n <= lastLogN) continue;
    lastLogN = entry.n;
    const el = h('p', { class: entry.say ? 'said' : undefined }, lineParts(entry));
    logEls.set(entry.n, { el, text: entry.text });
    log.append(el);
  }
  while (log.children.length > 200) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** The latest thing anyone said, with who said it, right under the table. */
function renderTalkLine() {
  const entry = view.log.findLast((l) => l.say);
  const line = $('talk-line');
  line.hidden = !entry;
  if (!entry) return;
  const key = `${entry.n}:${entry.text}`;
  if (line.dataset.key === key) return;
  line.dataset.key = key;
  line.replaceChildren(view.seats[entry.seat] ? faceEl(view.seats[entry.seat], 28) : '', h('span', {}, h('b', {}, entry.name, agentMark(view.seats[entry.seat]), ': '), entry.text));
}

// ---------- hand and actions (only when seated) ----------

function sealedCard() {
  if (useBack() === 'midnight') return h('div', { class: 'card back midnight', role: 'img', 'aria-label': 'A sealed card' }, h('img', { src: MIDNIGHT.symbol, alt: '' }));
  return h('div', { class: 'card back', vars: { col: 0, row: 4 }, role: 'img', 'aria-label': 'A sealed card' });
}

/** Your five cards while the deal is in the air or the round waits on its lock: face down, the Midnight mark up. */
const heldCard = () => h('div', { class: 'card back midnight held', role: 'img', 'aria-label': 'A card, face down until the lock lands' }, h('img', { src: MIDNIGHT.symbol, alt: '' }));

function renderHand() {
  const box = $('hand-box');
  if (watching || !me) {
    box.hidden = !watching;
    $('hand-confirm').replaceChildren();
    rowFromHand = {};
    $('pass-log').replaceChildren();
    if (watching) {
      $('hand-title').textContent = 'Hands stay sealed';
      if (handKey !== 'watch') {
        handKey = 'watch';
        $('hand').replaceChildren(...[0, 1, 2, 3, 4].map(sealedCard));
      }
    }
    return;
  }
  box.hidden = false;
  if (me.handHeld || dealing || lockPanel.open) { // dealt, sealed, not yet yours to see: until the lock lands (or fails), the deal has flown, and its ✓ has had its moment
    if (handKey !== 'held') {
      handKey = 'held';
      $('hand-title').textContent = me.handHeld || lockPanel.open ? 'Your hand: locking it on Midnight…' : 'Your hand: dealing…';
      $('hand').replaceChildren(...[0, 1, 2, 3, 4].map(heldCard));
      $('hand-confirm').replaceChildren();
      flipNext = true;
    }
    return;
  }
  notePasses();
  renderPassLog();
  const passable = me.legal.find((a) => a.action === 'pass');
  if (pickedCard && !me.hand.includes(pickedCard)) pickedCard = null;
  const lifted = me.pendingPass ?? (passable ? pickedCard : null);
  const received = me.passLog?.at(-1)?.got ?? null;
  const key = JSON.stringify([me.hand, passable ?? null, lifted, received, newCard, me.legal.some((a) => a.action === 'fold'), view.passRaise?.high ?? 0, view.potLimitReached]);
  if (key === handKey) return;
  handKey = key;
  const before = cardRects();
  if (me.pendingPass) $('hand-title').textContent = 'Your hand: card chosen';
  else $('hand-title').textContent = passable ? 'Your hand: tap a card to pick it' : 'Your hand';
  $('hand').replaceChildren(...me.hand.map((code) => {
    const { col, row, name } = cardInfo(code);
    return h(passable ? 'button' : 'div', {
      class: `card face ${lifted === code ? 'chosen' : ''} ${received === code ? 'received' : ''} ${newCard === code ? 'new' : ''}`,
      type: passable ? 'button' : undefined,
      role: passable ? undefined : 'img',
      'aria-label': name,
      'aria-pressed': passable ? String(lifted === code) : undefined,
      dataset: { card: code },
      vars: { col, row },
      onClick: passable ? () => pickCard(code) : undefined,
    }, newCard === code ? h('span', { class: 'new-badge', text: 'NEW' }) : null);
  }));
  if (flying) {
    flyCards(flying, before);
    flying = null;
  }
  if (flipNext) { // they were face down a moment ago: turn them over, one after another
    flipNext = false;
    if (!stillMotion()) [...$('hand').children].forEach((el, i) => { el.classList.add('flip-in'); el.style.setProperty('--i', i); });
  }
  $('hand-confirm').replaceChildren(...passPanel(passable));
  rowFromHand = pickMoves($('hand-confirm'));
  if (view) renderMoveRow();
}

/**
 * Passing and raising are one move: pick a card, then Pass, or Pass + raise X. Facing a raise it's Pass + match, Pass +
 * raise on top of it, or Fold, all from the server's list of what's legal and what each costs.
 */
function passPanel(pass) {
  const foldable = view.phase === 'pass' && !view.raise && me.legal.some((a) => a.action === 'fold');
  if (!pass && !foldable) return [];
  const card = pickedCard;
  const out = [];
  const match = pass?.match;
  if (foldable) out.push(h('p', { class: 'menu-note', id: 'pass-facing', text: match ? `${nameOf(view.passRaise.by)} raised. The raise stands at ${match.level}.` : `The raise stands at ${view.passRaise.high}, more than you can cover.` }));
  if (pass) {
    const label = match ? (match.cost > 0 ? `Pass + ${match.cost} to stay in` : 'Pass + stay in (pot limit: nothing to pay)') : 'Pass';
    out.push(h('button', {
      type: 'button',
      class: 'btn primary',
      id: 'pass-confirm',
      disabled: !card,
      text: card ? label : 'Pick a card to pass',
      onClick: () => send({ action: 'pass', card, ...(match ? { match: true } : {}) }),
    }));
  }
  if (pass?.raise) {
    const range = pass.raise;
    raiseAmount = Math.max(range.min, Math.min(range.max, Math.floor(raiseAmount) || range.min));
    const paying = (n) => n + (match?.cost ?? 0);
    const button = h('button', { type: 'button', class: 'btn', id: 'pass-raise', onClick: () => send({ action: 'pass', card, raise: raiseAmount }) });
    const paint = () => {
      const ok = Number.isInteger(raiseAmount) && raiseAmount >= range.min && raiseAmount <= range.max;
      button.disabled = !card || !ok;
      button.textContent = `Pass + raise ${ok ? raiseAmount : '…'}${match && ok ? ` (you pay ${paying(raiseAmount)})` : ''}`;
    };
    const input = h('input', {
      id: 'pass-raise-amount', type: 'number', inputmode: 'numeric', min: range.min, max: range.max, value: raiseAmount,
      'aria-label': `Raise amount, ${range.min} to ${range.max}`,
      onInput: (e) => { raiseAmount = Number(e.target.value); paint(); },
    });
    const presets = [5, 10, 25].filter((n) => n >= range.min && n <= range.max).map((n) => h('button', {
      type: 'button',
      class: 'btn small',
      text: String(n),
      dataset: { passRaiseAmount: n },
      onClick: () => {
        raiseAmount = n;
        input.value = n;
        paint();
      },
    }));
    paint();
    out.push(h('div', { class: 'pass-raise' }, h('div', { class: 'raise-row' }, input, h('div', { class: 'raise-amounts' }, presets)), button));
  } else if (view.potLimitReached) {
    out.push(h('p', { class: 'menu-note', id: 'pass-limit', text: `Pot limit reached: ${view.limits.potLimit} in the pot, so no more raises this round.` }));
  }
  if (foldable) out.push(h('button', { type: 'button', class: 'btn', id: 'pass-fold', dataset: { action: 'fold' }, text: 'Fold', onClick: () => send({ action: 'fold' }) }));
  return out;
}

/** Notices a pass that has just gone round, for the badge and the animation. */
function notePasses() {
  const log = me.passLog ?? [];
  if (seenPasses !== null && log.length > seenPasses) {
    const entry = log.at(-1);
    newCard = entry.got;
    flying = entry;
    clearTimeout(newTimer);
    if (!document.hidden) {
      newTimer = setTimeout(() => {
        newCard = null;
        renderHand();
      }, NEW_MS);
    }
  } else if (log.length < (seenPasses ?? 0)) { // a new round
    newCard = null;
    clearTimeout(newTimer);
  }
  seenPasses = log.length;
}

const cardShort = (code) => {
  const { name } = cardInfo(code);
  const suit = { c: '♣', d: '♦', h: '♥', s: '♠' }[code[1]];
  return h('b', { class: `mini-card ${'dh'.includes(code[1]) ? 'red' : ''}`, title: name }, `${code[0] === 'T' ? '10' : code[0]}${suit}`);
};

/** One line per pass this round. Only ever your own cards: the server sends no one else's. */
function renderPassLog() {
  const log = me.passLog ?? [];
  const list = $('pass-log');
  list.classList.toggle('expect', view.phase === 'pass'); // its line is reserved before the first pass, so nothing below jumps
  if (list.children.length === log.length && list.dataset.round === String(view.round)) return;
  list.dataset.round = view.round;
  list.replaceChildren(...log.map((entry) => h('li', { dataset: { pass: entry.n } },
    `Pass ${entry.n}: you sent `, cardShort(entry.sent), ` → ${nameOf(entry.to)}, got `, cardShort(entry.got), ` ← ${nameOf(entry.from)}`)));
  list.scrollTop = list.scrollHeight;
}

function cardRects() {
  return new Map([...$('hand').querySelectorAll('[data-card]')].map((el) => [el.dataset.card, el.getBoundingClientRect()]));
}

/** One card flies off from where it sat, and one comes in to where it now sits. Only you see your own two. */
function flyCards(entry, before) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const seatRect = (seat) => $('scene').querySelector(`[data-seat="${seat}"]`)?.getBoundingClientRect();
  const fly = (code, from, to, delay) => {
    const { col, row } = cardInfo(code);
    const el = h('div', { class: 'card face fly-card', 'aria-hidden': 'true', vars: { col, row } });
    el.style.left = `${from.left}px`;
    el.style.top = `${from.top}px`;
    document.body.append(el);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const animation = el.animate(
      [{ transform: 'translate(0, 0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.5)`, opacity: 0.25 }],
      { duration: FLY_MS, delay, easing: 'ease-in-out', fill: 'both' },
    );
    animation.finished.finally(() => el.remove());
  };
  const start = before.get(entry.sent);
  const nextSeat = seatRect(entry.to);
  if (start && nextSeat) fly(entry.sent, start, nextSeat, 0);

  const target = $('hand').querySelector(`[data-card="${entry.got}"]`);
  const prevSeat = seatRect(entry.from);
  if (!target || !prevSeat) return;
  const landing = target.getBoundingClientRect();
  const { col, row } = cardInfo(entry.got);
  const el = h('div', { class: 'card face fly-card', 'aria-hidden': 'true', vars: { col, row } });
  el.style.left = `${landing.left}px`;
  el.style.top = `${landing.top}px`;
  document.body.append(el);
  target.classList.add('arriving');
  const dx = prevSeat.left + prevSeat.width / 2 - (landing.left + landing.width / 2);
  const dy = prevSeat.top + prevSeat.height / 2 - (landing.top + landing.height / 2);
  el.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(0.5)`, opacity: 0.25 }, { transform: 'translate(0, 0) scale(1)', opacity: 1 }],
    { duration: FLY_MS, delay: FLY_MS / 3, easing: 'ease-in-out', fill: 'both' },
  ).finished.finally(() => {
    el.remove();
    $('hand').querySelector(`[data-card="${entry.got}"]`)?.classList.remove('arriving');
  });
}

function pickCard(code) {
  pickedCard = pickedCard === code ? null : code; // a second tap puts it back
  renderHand();
  $('hand').querySelector(`[data-card="${code}"]`)?.focus({ preventScroll: true });
}

const CHAIN_TX = (hash) => `https://preprod.midnightexplorer.com/transactions/${hash}`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** Why this seat was paid, in words. "Nobody called it" is all a claim's truth anyone ever learns unless it was called. */
function paidWhy(claim, place, paidCount) {
  const placeWords = place === 0 ? (paidCount > 1 ? 'best standing claim' : 'the only standing claim') : '2nd standing claim';
  return `${placeWords}, ${claim?.status === 'proven' ? 'called and checked' : 'nobody called it'}`;
}

/** The chain's part of the story, at a tNIGHT table. */
function roundChainLine(r) {
  if (!view.cage) return null;
  const receipt = view.cage.receipts.find((x) => x.rounds.includes(r.round));
  if (receipt) {
    return h('p', { class: 'result-chain', id: 'result-chain' }, 'Settled on chain · tx ', h('a', { href: CHAIN_TX(receipt.hash), target: '_blank', rel: 'noopener', text: `${receipt.hash.slice(0, 12)}…` }), ` · block ${receipt.block}`);
  }
  const text = view.cage.status !== 'open' ? 'This round didn’t reach the chain: the table closed first.'
    : r.kind === 'carried' ? 'The pot carries, so this settles on chain with the next paid pot.'
    : view.cage.unsettled.includes(r.round) ? 'Settling on chain…'
    : 'No chips moved, so there’s nothing to settle on chain.';
  return h('p', { class: 'result-chain', id: 'result-chain', text });
}

/** The panel at the top of the table when a round is over. Table talk stays the detailed log. */
function renderRoundResult() {
  const box = $('round-result');
  const r = view.lastResult;
  if (!r || r.round !== view.round || !['settled', 'over'].includes(view.phase)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const claims = r.claims ?? [];
  const claimOf = (seat) => claims.find((c) => c.seat === seat);
  const rows = [];
  if (r.kind === 'carried') rows.push(h('li', { text: `No claim stands. The pot of ${r.pot} carries to the next round.` }));
  for (const [place, a] of (r.awards ?? []).entries()) {
    const claim = claimOf(a.seat);
    const why = r.kind === 'uncontested' ? 'everyone else folded' : r.kind === 'returned' ? 'the pot went back as the table closed' : paidWhy(claim, place, r.awards.length);
    const said = claim && r.kind !== 'returned' ? ` · ${claim.label}` : '';
    rows.push(h('li', { class: 'result-paid' }, h('b', { text: `${nameOf(a.seat)} takes ${a.amount}` }), `${said} · ${why}`));
  }
  const paidSeats = new Set((r.awards ?? []).map((a) => a.seat));
  for (const c of claims) {
    if (paidSeats.has(c.seat)) continue;
    if (c.status === 'caught') rows.push(h('li', { text: `${nameOf(c.seat)} · ${c.label} · caught bluffing, out of the pot` }));
    else if (c.status === 'standing' || c.status === 'proven') rows.push(h('li', { text: `${nameOf(c.seat)} · ${c.label} · ${c.status === 'proven' ? 'called and checked' : 'nobody called it'}, but only the top two claims are paid` }));
  }
  const folded = (r.folded ?? []).map((seat) => `${nameOf(seat)}${claimOf(seat)?.status === 'withdrawn' ? ' (claim withdrawn)' : ''}`);
  const mine = me && r.money?.[me.seat];
  const net = mine ? mine.out - mine.in : 0;
  box.replaceChildren(...[
    h('h3', { class: 'round-result-title', id: 'round-result-title', text: `Round ${shownRound(r.round)} result · pot ${r.pot}` }),
    h('ul', { class: 'result-rows' }, rows),
    folded.length ? h('p', { class: 'result-folded', text: `Folded: ${folded.join(', ')}.` }) : null,
    mine ? h('p', { class: `result-mine ${net > 0 ? 'up' : net < 0 ? 'down' : ''}`, id: 'result-mine', text: `You put in ${mine.in}, got back ${mine.out} → net ${signed(net)}.` }) : null,
    roundChainLine(r),
  ].filter(Boolean));
}

/** Your round, as a card: result, place at the table, the top three, Play again and Invite. Only for a seat that was dealt in. */
let afterRoundShown = false;
let sawRound = false; // a round played out on this page, so a result that turns up later is news and not an old one
let flashedRound = 0;
let ended = false; // you left: the card keeps the result and drops its moves
function renderAfterRoundCard() {
  const r = view.lastResult;
  const money = me && r?.money?.[me.seat];
  if (IN_ROUND.includes(view.phase)) sawRound = true;
  const seat = me && view.seats[me.seat];
  afterRoundShown = !watching && !!me && !!r && r.round === view.round && ['settled', 'over'].includes(view.phase) && r.kind !== 'returned' && !!money && (money.in > 0 || money.out > 0);
  renderAfterRound($('after-round'), {
    show: afterRoundShown,
    round: r ? shownRound(r.round) : r?.round, // the table's own number for the round, as the status line has it
    net: money ? money.out - money.in : 0,
    seats: view.seats,
    mySeat: me?.seat,
    link: `${window.location.origin}/?play=sealed-hand`, // a seat for a friend: the doorman takes their name and finds a waiting table, or opens one
    canNext: !!me?.legal.some((a) => a.action === 'next'),
    onNext: () => send({ action: 'next' }),
    againLabel: view.dealByPlayer && view.cage ? 'Shuffle & deal' : undefined, // chips tables say Next round
    playerToken: view.cage ? null : store.get(PLAYER_KEY), // the leaderboard is play chips only
    firstWin: afterRoundShown && !view.cage && firstWin({ where: `sealed-hand:${tableId}`, round: r?.round, net: money ? money.out - money.in : 0 }), // once per browser: where the chips live
    againHref: '/?play=sealed-hand',
    onReceipt: roundOver() && roundRecord(view, 'sealed-hand') ? () => openReceiptWindow({ href: roundRecord(view, 'sealed-hand').href, label: roundRecord(view, 'sealed-hand').label }) : null,
    // chips tables: your number in plain words, the session total, the way on when you're out of chips (tNIGHT tables are as they were)
    stack: view.cage || !seat ? null : seat.chips,
    session: view.cage || !seat || seat.left ? '' : sessionText(sessionOpen('sealed-hand', tableId, seat.chips), seat.chips),
    broke: !view.cage && !!me?.broke,
    onFillUp: !view.cage && me?.canFillUp ? fillUp : null,
    onLeave: !view.cage && me?.canLeave ? leaveTable : null,
    closed: view.phase === 'over' || ended,
  });
  if (afterRoundShown && !view.cage && r && flashedRound !== r.round) {
    if (sawRound && money) flashNet(document.querySelector('.seat-card.mine') ?? $('me-corner'), money.out - money.in);
    flashedRound = r.round;
  }
}

function placeEnd(panel) {
  $('table-end')?.remove();
  $('after-round').before(panel);
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** A table that closed under a seated player (everyone left, or no human moved for 30 minutes): the result stays, and the choice is theirs. */
function renderTableClosed() {
  const old = $('table-end');
  const seat = me && view.seats[me.seat];
  const closed = !watching && !!seat && !view.cage && view.phase === 'over';
  if (ended) return; // the leave panel is up
  if (!closed) { old?.remove(); return; }
  const stack = seat.chips > 0 ? seat.chips : seat.leftWith ?? 0;
  const summary = summaryText(sessionOpen('sealed-hand', tableId, stack), stack);
  const key = `${summary}|${view.overReason}`;
  if (old?.dataset.key === key) return;
  const panel = tableEnd({ kind: 'closed', summary, reason: view.overReason ?? '', stack, onNew: () => newTable(stack), hallHref: leaveTo });
  panel.dataset.key = key;
  placeEnd(panel);
}

const newTable = (stack) => sitAtNewTable({ game: 'sealed-hand', apiBase: GAME.api, page: GAME.page, fromId: tableId, stack, token: store.get(PLAYER_KEY) });

function resultText() {
  const r = view.lastResult;
  if (!r) return '';
  if (r.kind === 'returned') return `The pot of ${r.pot} went back: ${r.awards.map((a) => `${nameOf(a.seat)} ${a.amount}`).join(', ')}.`;
  if (r.kind === 'carried') return `No claim stands. The pot of ${r.pot} carries over.`;
  if (r.kind === 'uncontested') {
    const [{ seat, amount, label }] = r.awards;
    return `Everyone else folded. ${nameOf(seat)} takes ${amount}${label ? ` with ${label}` : ''}.`;
  }
  const parts = r.awards.map((a) => `${nameOf(a.seat)} takes ${a.amount}`);
  if (r.carried) parts.push(`${r.carried} carries over`);
  return `${parts.join(', ')}.`;
}

/** A tNIGHT table before its first deal: the float and the seats come from the chain, and the judge reads them. */
function cageLobbyLine() {
  const c = view.cage;
  const someone = view.seats.length > 0 || c.waiting.length > 0;
  if (!someone) return 'Waiting for someone to bring tNIGHT to this table.';
  if (c.housePending) return 'Seating the table.';
  if (c.waiting.length) return 'Reading the seats from the cage.';
  return 'Dealing.';
}


/** "Deal me in now, with bots" (11-06, round 2): at a chip table still in the lobby, a seated player can fill the seats and start at once; the clock stays for anyone who'd rather wait. */
function renderDealNow() {
  const el = $('seating');
  if (view.cage) return; // renderSeating owns it at a tNIGHT table
  const on = view.phase === 'lobby' && !!me && !!seatToken && !watching && !view.seats[me.seat]?.left && view.seats.length < view.seatsTotal;
  el.hidden = !on;
  if (!on) { if (el.dataset.text === 'deal-now') { el.replaceChildren(); el.dataset.text = ''; } return; }
  if (el.dataset.text === 'deal-now') return;
  el.dataset.text = 'deal-now';
  const button = h('button', { class: 'btn primary small deal-start', id: 'deal-now', type: 'button' }, view.dealByPlayer ? 'Shuffle & deal' : 'Deal me in now, with bots');
  button.addEventListener('click', async () => {
    const release = pressing(button, 'Dealing');
    try {
      await api('POST', `${path}/deal-now`, { token: seatToken, body: {} });
      await poll();
    } catch (err) {
      $('error').textContent = err.message;
      release();
    }
  });
  el.replaceChildren(h('span', { class: 'mid-spin', 'aria-hidden': 'true' }), h('span', { text: 'Waiting for players. ' }), button);
}

/** The seating notice: what the judge is doing on chain before the first deal, and how long it has been. Only at a tNIGHT table. */
function renderSeating() {
  const el = $('seating');
  const c = view.cage;
  const on = view.phase === 'lobby' && !!c && c.status === 'open' && (view.seats.length > 0 || c.waiting.length > 0) && (c.housePending || c.waiting.length > 0);
  el.hidden = !on;
  if (!on) return;
  const text = c.housePending
    ? 'The judge is putting the house float on chain: two transactions, about 2 minutes. Then the deal.'
    : `The judge is reading ${c.waiting.join(', ')}’s seat from the cage. Under a minute, then the deal.`;
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.replaceChildren(h('span', { class: 'mid-spin', 'aria-hidden': 'true' }), text, h('small'));
}

function turnLine() {
  const { phase, waitingOn } = view;
  if (phase === 'lobby') {
    if (view.cage) return cageLobbyLine();
    const open = view.seatsTotal - view.seats.length;
    return view.seats.length ? `${open} seat${open === 1 ? '' : 's'} open. Bots take any left when the clock runs out.` : 'Nobody has sat down yet.';
  }
  if (phase === 'settled') {
    const said = view.lastResult?.round === view.round ? '' : `${resultText()} `; // the result panel above says it
    if (view.deadline) return `${said}The next round deals itself when the clock runs out.`;
    if (me?.broke && !view.cage) return `${said}You’re out of chips: fill up to keep playing, or leave.`;
    return `${said}${view.seats.some((x) => x.away) && view.seats.filter((x) => !x.bot && !x.left).length > 1 ? 'Waiting for someone to come back.' : 'Deal when you’re ready.'}`;
  }
  if (phase === 'over') {
    const stack = me && !view.seats[me.seat]?.left ? view.seats[me.seat]?.chips : null;
    return `Table closed: ${plainClose(view.overReason ?? '')}${view.lastResult?.kind === 'returned' ? ` ${resultText()}` : ''}${stack ? ` Your ${stack} chips are back in your purse.` : ''}`;
  }
  if (me?.away) return `You’re marked away, so moves are made for you. You sit out from the next round until you’re back.`;
  const who = (seat) => (me?.seat === seat ? 'you' : nameOf(seat));
  if (view.anchor?.held) return 'The hand is being locked on Midnight. Nobody moves until it lands.';
  if (view.raise && waitingOn[0] !== undefined) {
    const raiser = nameOf(view.raise.by);
    return me?.seat === waitingOn[0] ? `${raiser} raised ${view.raise.amount}. Pay it to stay in, or fold.` : `${raiser} raised ${view.raise.amount}. ${nameOf(waitingOn[0])} to stay in or fold.`;
  }
  if (phase === 'pass') {
    const names = waitingOn.map(who).join(', ');
    const high = view.passRaise?.high ?? 0;
    if (high && me && waitingOn.includes(me.seat) && (view.passRaise.paid[me.seat] ?? 0) < high) return `${nameOf(view.passRaise.by)} raised. The raise stands at ${high}: pass and pay to stay in, or fold.`;
    return names ? `Waiting on ${names} to choose a card.` : '';
  }
  if (waitingOn[0] === undefined) return '';
  if (phase === 'answer') {
    if (me?.seat !== waitingOn[0]) return `${nameOf(waitingOn[0])} to stay in or fold.`;
    return me.legal.some((a) => a.action === 'call') ? 'Your turn: pay to stay in, or fold, and you can call a claim a bluff as you do.' : 'Your turn: pay to stay in, or fold.';
  }
  return me?.seat === waitingOn[0] ? 'Your turn.' : `${nameOf(waitingOn[0])} to act.`;
}

/** The standing claim everyone has to beat, and whose it is. */
function topStanding() {
  return view.top ? view.claims.find((c) => c.status !== 'caught' && String(c.claim) === String(view.top)) ?? null : null;
}

const seatWord = (seat) => (seat === me?.seat ? 'you' : nameOf(seat));

/** The raise on the table. For the seat that has to answer it now, that's the first thing it reads. */
function renderFacing() {
  const banner = $('facing');
  const raise = view.lapRaise;
  banner.hidden = !raise?.high;
  if (banner.hidden) {
    banner.replaceChildren();
    banner.dataset.key = '';
    return;
  }
  const facing = me?.facing;
  const raiser = raise.by === me?.seat ? 'You' : nameOf(raise.by);
  const more = facing?.paid ? ` You’re in for ${facing.paid}, so it’s ${facing.owed} more.` : '';
  const big = facing && view.waitingOn[0] === me.seat ? `Stay in for ${facing.owed}, or fold` : `Raised to ${raise.high}`;
  const small = facing && view.waitingOn[0] === me.seat
    ? `${raiser} raised to ${raise.high}.${more}`
    : facing ? `By ${raiser}. On your turn, pay to stay in, or fold.${more}` : `By ${raiser}.`;
  const key = `${big}|${small}`;
  if (banner.dataset.key === key) return;
  banner.dataset.key = key;
  banner.replaceChildren(h('span', { class: 'facing-big', id: 'facing-big', text: big }), h('span', { class: 'facing-small', id: 'facing-small', text: small }));
}

/** The claim to beat, big, at the head of the panel, all through the claim lap. */
function renderToBeat() {
  renderFacing();
  const el = $('to-beat');
  el.hidden = !['claim', 'answer'].includes(view.phase);
  if (el.hidden) return;
  const top = topStanding();
  if (!top) {
    el.replaceChildren(h('b', { text: me && view.waitingOn[0] === me.seat ? 'No claims yet — you open.' : 'No claims yet.' }));
    return;
  }
  // "Checked" means someone called it and the house found it held: the cards stay hidden either way. The field is still `proven`.
  el.replaceChildren(h('b', { text: view.phase === 'answer' ? 'Top claim: ' : 'To beat: ' }), `${seatWord(top.seat)} — ${top.label} (${top.status === 'proven' ? 'checked, not shown' : 'claimed, not shown'})`);
}

function renderActions() {
  $('turn-line').textContent = turnLine();
  renderSeating();
  renderDealNow();
  renderToBeat();
  const box = $('action-box');
  if (watching || !me) {
    $('action-title').textContent = 'At the table';
    $('actions').replaceChildren();
    rowFromActions = {};
    actionsKey = '';
    box.hidden = false;
    return;
  }
  const legal = me.legal.filter((a) => a.action !== 'pass' && !(afterRoundShown && a.action === 'next')); // the card has Play again
  const stop = !me.away && view.phase === 'pass' ? legal.find((a) => a.action === 'stop') : null;
  const stopOpen = !!stop && stopOpenFor === `${view.round}:${view.passNo}`;
  const key = JSON.stringify([legal, me.bestTrue, view.top, me.facing, view.lapRaise?.high, stopOpen, afterRoundShown]);
  if (key === actionsKey) return;
  actionsKey = key;
  const passable = me.legal.some((a) => a.action === 'pass');
  $('action-title').textContent = legal.length || passable ? 'Your move' : 'At the table';
  const playing = !me.away;
  let panel;
  if (playing && view.phase === 'answer') panel = answerPanel(legal);
  else if (playing && view.phase === 'claim' && legal.length) panel = claimPanel(legal);
  else if (stopOpen) panel = stopPanel(stop);
  else panel = [view.phase === 'claim' && me.bestTrue ? bestLine() : null, ...legal.flatMap(actionControls)]; // your best is there before your turn
  $('actions').replaceChildren(...panel.filter(Boolean));
  rowFromActions = pickMoves($('actions'));
  if (view) renderMoveRow();
}

// ---------- the move row: one row of moves under your hand ----------

/**
 * The row holds the real controls the panels below build (same buttons, same requests), moved up into one row in a fixed
 * order. A move that needs choosing first (which claim, whom to call) keeps its picker below, and its row button takes you
 * there. A move you can't make now stays in the row, greyed, and says why on hover or tap. Nothing is ever hidden.
 */
const MOVES = [
  { id: 'pass', label: 'Pass' },
  { id: 'stop', label: 'Stop & claim' },
  { id: 'claim', label: 'Claim' },
  { id: 'check', label: 'Check' },
  { id: 'call', label: 'Call' },
  { id: 'match', label: 'Stay in' }, // was Match: next to Check and Call it read as a poker bet word (11-08)
  { id: 'fold', label: 'Fold' },
];
let rowFromHand = {};
let rowFromActions = {};
let rowKey = '';

/** The move buttons a panel just built, by move. Each element goes to one move only. */
function pickMoves(box) {
  const used = new Set();
  const one = (sel) => {
    const els = [...box.querySelectorAll(sel)].filter((el) => el.tagName === 'BUTTON' && !used.has(el));
    return els;
  };
  const found = {};
  const take = (move, els, { single = true } = {}) => {
    if (!els.length || (single && els.length > 1)) return;
    found[move] = els[0];
    used.add(els[0]);
  };
  take('pass', one('#pass-confirm'));
  take('stop', one('#stop-open'));
  take('check', one('#true-moves [data-action="check"], #true-moves [data-action="fold"]:not(.call)'));
  take('call', one('[data-action="call"]'));
  take('match', one('[data-action="match"]'));
  take('fold', one('[data-action="fold"]'));
  return found;
}

/** Why a move isn't open right now, in a few words. */
function moveReason(move) {
  const inRound = IN_ROUND.includes(view.phase);
  if (!inRound) return view.phase === 'lobby' ? 'The round hasn’t started' : 'Between rounds';
  if (me?.away) return 'You’re marked away';
  const mine = view.waitingOn.includes(me.seat);
  const other = view.waitingOn[0] !== undefined ? `${nameOf(view.waitingOn[0])}’s turn` : 'Not your turn';
  const facing = view.passRaise?.high && (view.passRaise.paid?.[me.seat] ?? 0) < view.passRaise.high;
  switch (move) {
    case 'pass':
      if (view.phase !== 'pass') return 'Only while passing';
      return me.pendingPass ? 'Passed: waiting on the others' : 'Not now';
    case 'stop':
      if (view.phase !== 'pass') return 'Only while passing';
      if (view.passRaise?.high) return 'Not with a raise out';
      if (view.passNo < (view.limits.minPasses ?? 0)) return `From pass ${view.limits.minPasses}`;
      return me.pendingPass ? 'You’ve passed this window' : 'Not now';
    case 'claim':
      if (view.phase === 'pass') return 'After the passing, or Stop & claim';
      if (view.phase === 'answer') return 'No new claims now';
      return mine ? 'Not now' : other;
    case 'check':
      if (view.phase !== 'claim') return 'Only in the claim lap';
      return mine ? 'Not now' : other;
    case 'call':
      if (view.phase === 'pass') return 'Only after the passing';
      if (!view.claims.some((c) => c.seat !== me.seat && c.status === 'standing')) return 'No claim to call';
      return mine ? 'Not now' : other;
    case 'match':
      if (!(facing || view.lapRaise?.high)) return 'No raise to answer';
      if (mine && me.facing && view.phase === 'claim') return 'It goes with your move: pick Stay in below, then Check, Claim or Call';
      return mine ? 'Not now' : other;
    case 'fold':
      return mine ? 'Nothing to fold against' : other;
    default:
      return 'Not now';
  }
}

/** A row button for a move that has a picker below: it takes you there. */
function pickerButton(move, label, target) {
  return h('button', {
    type: 'button',
    class: `btn move go ${move}`,
    dataset: { move },
    text: label,
    onClick: () => {
      target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
    },
  });
}

function ghostButton(move, label) {
  const reason = moveReason(move);
  return h('button', {
    type: 'button',
    class: `btn move ghost ${move}`,
    dataset: { move },
    'aria-disabled': 'true',
    title: reason,
    'aria-describedby': 'move-reason',
    onClick: () => {
      const line = $('move-reason');
      line.hidden = false;
      line.textContent = whyNot(move, reason);
      clearTimeout(line.timer);
      line.timer = setTimeout(() => { line.hidden = true; }, 6000);
    },
  }, label, h('small', { text: reason }));
}

function renderMoveRow() {
  const row = $('move-row');
  const on = !watching && !!me && !view.seats[me.seat]?.left && IN_ROUND.concat(['lobby']).includes(view.phase);
  row.hidden = !on;
  if (!on) { // nothing left behind: a button from a finished round can't be pressed
    if (row.children.length) row.replaceChildren();
    rowKey = '';
    return;
  }
  const found = { ...rowFromActions, ...rowFromHand };
  const claimBox = $('actions').querySelector('#claim-box, #claim-picker');
  const callList = $('actions').querySelectorAll('[data-action="call"]');
  const slots = MOVES.map(({ id, label }) => {
    if (found[id] && found[id].isConnected) {
      found[id].classList.add('move', id);
      found[id].dataset.move = id;
      return found[id];
    }
    if (id === 'claim' && claimBox && view.phase === 'claim') return pickerButton('claim', 'Claim', claimBox);
    if (id === 'stop' && claimBox && view.phase === 'pass') return pickerButton('stop', 'Stop & claim', claimBox);
    if (id === 'call' && callList.length > 1) return pickerButton('call', 'Call…', callList[0].parentElement);
    return ghostButton(id, label);
  });
  const key = slots.map((el) => (el.classList.contains('ghost') || el.classList.contains('go') ? `${el.dataset.move}:${el.className}:${el.title}` : el.id || el.dataset.action)).join('|') + slots.filter((el) => !el.classList.contains('ghost') && !el.classList.contains('go')).length;
  if (rowHolds(row, slots)) return;
  if (key === rowKey && slots.every((el) => el.classList.contains('ghost') || el.classList.contains('go'))) return;
  rowKey = key;
  placeMoves(row, slots.map((el, i) => ({ id: MOVES[i].id, el }))); // each move in its cell, with what it does under it
}

function menuButton(label, body, extra = {}) {
  return h('button', { type: 'button', class: 'menu-item', dataset: { action: body.action }, onClick: () => send(body), ...extra }, label);
}

// ---------- the claim panel ----------

const KINDS = [
  { cat: 1, label: 'Pair', rank: 'Pair of…' },
  { cat: 2, label: 'Two pair', rank: 'Higher pair…', second: 'With…' },
  { cat: 3, label: 'Three of a kind', rank: 'Three…' },
  { cat: 4, label: 'Straight', rank: 'Up to the…' },
  { cat: 5, label: 'Flush', rank: 'High card…' },
  { cat: 6, label: 'Full house', rank: 'Three…', second: 'Over a pair of…' },
  { cat: 7, label: 'Four of a kind', rank: 'Four…' },
  { cat: 8, label: 'Straight flush' },
];

const rankWord = (r) => (r === 0 ? 'Any' : ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] ?? String(r)));

/** One line, whatever else happens: the best thing you could truthfully say, and whether it's enough. */
function bestLine(pickIt) {
  const best = me.bestTrue;
  const top = topStanding();
  const words = [h('span', { class: 'best-label', text: 'Your best true claim: ' }), h('b', { text: best.label ?? 'none' })];
  if (best.label && !best.beats && top) words.push(`. It doesn’t beat ${seatWord(top.seat) === 'you' ? 'your own' : `${nameOf(top.seat)}’s`} ${top.label}.`);
  else if (!best.label) words.push('. You hold no pair or better.');
  return h('div', { class: 'best-true', id: 'best-true' }, h('p', {}, words),
    pickIt && best.beats ? h('button', { type: 'button', class: 'btn small', id: 'use-best', text: 'Pick it', onClick: pickIt }) : null);
}

/**
 * Kind, then rank (then the second rank, for two pair and a full house), then confirm. Every chip comes from the
 * server's list, so it can only show what's legal, and the server says which are true for this hand.
 */
function claimPicker(a, stake) {
  const stopping = a.action === 'stop';
  const trueKeys = new Set(a.truthful.map((t) => t.claim.join()));
  const isTrue = (o) => trueKeys.has(o.claim.join());
  const ofKind = (cat) => a.options.filter((o) => o.claim[0] === cat);
  const pick = { cat: null, r1: null };
  const body = h('div', { class: 'picker', id: 'claim-picker' });
  const confirm = h('button', {
    type: 'button', class: 'btn primary big', id: 'claim-confirm', dataset: { action: a.action }, disabled: true, text: 'Pick a claim',
    onClick: () => pickedClaim && stake.ready(a.action) && send({ action: a.action, claim: pickedClaim.claim, ...stake.body() }),
  });
  const verdict = h('p', { class: 'menu-note', id: 'claim-verdict', text: 'You can claim anything. A bluff costs 5 if someone calls it.' });

  const chip = (label, { pressed, options, data, onClick, disabled }) => {
    const anyTrue = options.some(isTrue);
    return h('button', {
      type: 'button',
      class: 'chip',
      disabled,
      'aria-pressed': String(!!pressed),
      dataset: { ...data, ...(anyTrue ? { truthful: '1' } : {}) },
      onClick,
    }, h('span', { text: label }), disabled ? null : h('span', { class: `chip-tag ${anyTrue ? 'true' : 'bluff'}`, text: anyTrue ? 'true' : 'bluff' }));
  };

  const draw = () => {
    const rows = [h('div', { class: 'pick-row kinds', role: 'group', 'aria-label': 'Kind of hand' }, KINDS.map((kind) => chip(kind.label, {
      pressed: pick.cat === kind.cat,
      options: ofKind(kind.cat),
      disabled: ofKind(kind.cat).length === 0,
      data: { kind: kind.cat },
      onClick: () => {
        pick.cat = kind.cat;
        pick.r1 = null;
        const only = ofKind(kind.cat);
        choose(only.length === 1 ? only[0] : null);
      },
    })))];
    const kind = KINDS.find((x) => x.cat === pick.cat);
    if (kind?.rank) {
      const ranks = [...new Set(ofKind(pick.cat).map((o) => o.claim[1]))];
      rows.push(h('p', { class: 'chips-label', text: kind.rank }), h('div', { class: 'pick-row ranks', role: 'group', 'aria-label': kind.rank }, ranks.map((r1) => {
        const options = ofKind(pick.cat).filter((o) => o.claim[1] === r1);
        return chip(rankWord(r1), {
          pressed: pick.r1 === r1,
          options,
          data: { rank: r1 },
          onClick: () => {
            pick.r1 = r1;
            // Two pair and a full house may leave the other rank open: that's the plain claim, picked for you until you say.
            choose(options.find((o) => o.claim[2] === 0) ?? (options.length === 1 ? options[0] : null));
          },
        });
      })));
    }
    if (kind?.second && pick.r1 !== null) {
      const options = ofKind(pick.cat).filter((o) => o.claim[1] === pick.r1);
      rows.push(h('p', { class: 'chips-label', text: kind.second }), h('div', { class: 'pick-row ranks', role: 'group', 'aria-label': kind.second }, options.map((o) => chip(rankWord(o.claim[2]), {
        pressed: pickedClaim === o,
        options: [o],
        data: { second: o.claim[2] },
        onClick: () => choose(o),
      }))));
    }
    body.replaceChildren(...rows);
  };

  const paintConfirm = () => {
    const option = pickedClaim;
    confirm.disabled = !option || !stake.ready(a.action);
    confirm.textContent = option ? `${stopping ? 'Stop & claim' : 'Make claim'}: ${option.label}${stake.words(a.action)}` : 'Pick a claim';
  };

  const choose = (option) => {
    pickedClaim = option;
    paintConfirm();
    if (option) verdict.textContent = isTrue(option) ? 'True: your hand holds this.' : 'A bluff: it costs you 5 if someone calls it.';
    else verdict.textContent = 'You can claim anything. A bluff costs 5 if someone calls it.';
    draw();
    (option ? confirm : body.lastElementChild).scrollIntoView?.({ block: 'nearest' }); // the next step stays under your thumb
  };

  pickedClaim = null;
  draw();
  return {
    nodes: [body, confirm, verdict],
    paintConfirm,
    pickBest: () => {
      const best = a.options.find((o) => o.claim.join() === me.bestTrue.claim.join());
      if (!best) return;
      [pick.cat, pick.r1] = best.claim;
      choose(best);
    },
  };
}

const raisePresets = (a) => [...new Set([a.min, 5, 10, a.max])].filter((n) => n >= a.min && n <= a.max).sort((x, y) => x - y);

/**
 * What goes with a lap move: nothing, a raise, a match, or a fold. One choice, above the moves, and every move's label
 * says what it will cost before it's tapped. Each move's own limits come from the server's list.
 */
function stakeControl(legal, repaint) {
  const claim = legal.find((a) => a.action === 'claim');
  const call = legal.find((a) => a.action === 'call');
  const check = legal.find((a) => a.action === 'check');
  const free = claim ?? legal.find((a) => a.action === 'stop') ?? check;
  const facing = me.facing;
  const raiseRange = free?.raise ?? call?.raise;
  const options = facing
    ? [free?.match || call?.match ? ['match', `Stay in for ${facing.owed}`] : null, raiseRange ? ['raise', 'Raise'] : null, ['fold', 'Fold']]
    : [['none', 'No raise'], raiseRange ? ['raise', 'Raise'] : null];
  const modes = options.filter(Boolean);
  const turn = `${view.round}:${view.lapRaise?.high}:${facing?.owed ?? 0}`;
  if (stakeFor !== turn || !modes.some(([mode]) => mode === stakeMode)) {
    stakeFor = turn;
    stakeMode = modes[0][0];
  }
  const moveOf = (action) => legal.find((a) => a.action === action);
  const amountOk = (limit) => !!limit && Number.isInteger(raiseAmount) && raiseAmount >= limit.min && raiseAmount <= limit.max;

  const stake = {
    mode: () => stakeMode,
    ready: (action) => {
      const move = moveOf(action);
      if (stakeMode === 'raise') return amountOk(move?.raise);
      if (stakeMode === 'match') return !!move?.match;
      if (stakeMode === 'fold') return action !== 'claim';
      return true;
    },
    body: () => (stakeMode === 'raise' ? { raise: raiseAmount } : stakeMode === 'match' ? { match: true } : stakeMode === 'fold' ? { fold: true } : {}),
    words: (action) => {
      if (stakeMode === 'raise') return ` + raise to ${Number.isInteger(raiseAmount) ? raiseAmount : '…'}`;
      if (stakeMode === 'match') return ` + ${facing.owed} to stay in`;
      if (stakeMode === 'fold' && action === 'call') return ', then fold';
      return '';
    },
  };

  const buttons = modes.map(([mode, label]) => h('button', {
    type: 'button',
    class: 'btn',
    'aria-pressed': String(stakeMode === mode),
    dataset: { stake: mode },
    text: label,
    onClick: () => {
      stakeMode = mode;
      paint();
    },
  }));
  const row = h('div', { class: 'stake-row', id: 'stake-row', role: 'group', 'aria-label': facing ? 'Answer the raise' : 'Raise with your move' }, buttons);

  let amount = null;
  let quick = null;
  if (raiseRange) {
    raiseAmount = Math.max(raiseRange.min, Math.min(raiseRange.max, Math.floor(raiseAmount) || raiseRange.min));
    const input = h('input', {
      id: 'raise-amount', type: 'number', inputmode: 'numeric', min: raiseRange.min, max: raiseRange.max, value: raiseAmount,
      'aria-label': `Raise to, ${raiseRange.min} to ${raiseRange.max}`,
      onInput: (e) => {
        raiseAmount = Number(e.target.value);
        repaint();
      },
    });
    const presets = raisePresets(raiseRange).map((n) => h('button', {
      type: 'button',
      class: 'btn small',
      text: String(n),
      dataset: { raiseAmount: n },
      onClick: () => {
        raiseAmount = n;
        input.value = n;
        repaint();
      },
    }));
    amount = h('div', { class: 'stake-amount', id: 'stake-amount' }, h('label', {}, 'Raise to', input), h('div', { class: 'raise-amounts' }, presets));
    // Always in sight, so a raise isn't hidden behind the toggle. A raise here is to a level, so these go up from the highest so far.
    const high = view.lapRaise?.high ?? 0;
    const quickButtons = [5, 10, 25].filter((up) => high + up >= raiseRange.min && high + up <= raiseRange.max).map((up) => h('button', {
      type: 'button',
      class: 'btn small',
      text: `+${up}`,
      dataset: { quickRaise: up },
      onClick: () => {
        raiseAmount = high + up;
        input.value = raiseAmount;
        stakeMode = 'raise';
        paint();
      },
    }));
    if (quickButtons.length) quick = h('div', { class: 'raise-amounts stake-quick', id: 'stake-quick', role: 'group', 'aria-label': 'Raise quickly' }, quickButtons);
  }
  const note = h('p', { class: 'menu-note', id: 'stake-note' });

  function paint() {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stake === stakeMode)));
    if (amount) amount.hidden = stakeMode !== 'raise';
    note.textContent = stakeMode === 'raise' && raiseRange
      ? `${raiseRange.min} to ${raiseRange.max}, above the highest raise. Anyone who hasn’t paid up to it answers.`
      : stakeMode === 'fold' ? 'You pay nothing more, and you can’t share this pot.' : '';
    note.hidden = !note.textContent;
    repaint();
  }

  return { stake, nodes: [row, quick, amount, note], paint };
}

/** The claim lap, on your turn. Whatever the hand, a true move is in plain sight: Check, or Fold when there's a raise to answer. */
function claimPanel(legal) {
  const claim = legal.find((a) => a.action === 'claim');
  const call = legal.find((a) => a.action === 'call');
  const check = legal.find((a) => a.action === 'check');
  const canFold = legal.some((a) => a.action === 'fold');
  const nothingBetter = !me.bestTrue?.beats;
  const style = nothingBetter ? 'btn primary big' : 'btn big';
  const repaint = () => paintMoves();
  const { stake, nodes: stakeNodes, paint } = stakeControl(legal, repaint);
  const picker = claim ? claimPicker(claim, stake) : null;
  const pickerBox = picker ? h('div', { id: 'claim-box' }, h('h3', { class: 'chips-title', text: nothingBetter ? 'Or claim anyway' : 'Make a claim' }), ...picker.nodes) : null;

  const callButtons = (call?.seats ?? []).map((seat) => {
    const label = `Call ${nameOf(seat)}: ${view.claims.find((c) => c.seat === seat)?.label ?? 'their claim'}`;
    return { label, el: h('button', {
      type: 'button',
      class: style,
      dataset: { action: 'call', seat },
      onClick: () => stake.ready('call') && send({ action: 'call', seat, ...stake.body() }),
    }) };
  });
  // Check and fold is a fold, and a plain fold is what a seat that can't cover the raise has left.
  const checkButton = check || canFold ? h('button', {
    type: 'button',
    class: style,
    onClick: () => {
      if (stake.mode() === 'fold') send({ action: 'fold' });
      else if (stake.ready('check')) send({ action: 'check', ...stake.body() });
    },
  }) : null;

  function paintMoves() {
    for (const { label, el } of callButtons) {
      el.textContent = `${label}${stake.words('call')}`;
      el.disabled = !stake.ready('call');
    }
    if (checkButton) {
      const folding = stake.mode() === 'fold';
      checkButton.dataset.action = folding ? 'fold' : 'check';
      checkButton.textContent = folding ? 'Fold' : `Check${stake.words('check')}`;
      checkButton.disabled = !folding && !stake.ready('check');
    }
    if (pickerBox) pickerBox.hidden = stake.mode() === 'fold';
    picker?.paintConfirm();
  }

  paint();
  return [
    me.bestTrue ? bestLine(picker ? () => {
      if (stake.mode() === 'fold') return;
      picker.pickBest();
    } : undefined) : null,
    ...stakeNodes,
    h('div', { class: `true-moves ${nothingBetter ? 'strong' : ''}`, id: 'true-moves' }, callButtons.map((b) => b.el), checkButton),
    pickerBox,
  ].filter(Boolean);
}

/** Stopping the passing is your claim and your one turn in the lap, so all of it is chosen here, in one move. */
function stopPanel(stop) {
  const { stake, nodes, paint } = stakeControl([stop], () => picker.paintConfirm());
  const picker = claimPicker(stop, stake);
  paint();
  return [
    h('h3', { class: 'chips-title', text: 'Stop & claim' }),
    h('p', { class: 'menu-note', id: 'stop-note', text: 'The passing stops here. This claim is your turn, and the next seat goes after you.' }),
    me.bestTrue ? bestLine(() => picker.pickBest()) : null,
    ...nodes,
    ...picker.nodes,
    h('button', {
      type: 'button',
      class: 'btn',
      id: 'stop-cancel',
      text: 'Keep passing',
      onClick: () => {
        stopOpenFor = null;
        renderActions();
      },
    }),
  ];
}

/** After the lap: what you're backing, what it costs to stay, and the two moves. Everyone sees the numbers; only the one to act gets buttons. */
function answerPanel(legal) {
  const { high } = view.lapRaise;
  const mine = view.claims.find((c) => c.seat === me.seat && (c.status === 'standing' || c.status === 'proven'));
  const caught = view.claims.some((c) => c.seat === me.seat && c.status === 'caught');
  const myLine = caught ? 'Your claim was caught, so you’re out of the pot.' : mine ? `Your claim: ${mine.label}.` : 'You have no claim, so you can’t share this pot.';
  const summary = h('p', { class: 'answer-line', id: 'answer-line' }, `${myLine} `, h('b', { text: `Highest raise: ${high}.` }));
  if (legal.length === 0) return [summary];
  const match = legal.find((a) => a.action === 'match');
  const call = legal.find((a) => a.action === 'call');
  const callRow = (seat) => {
    const label = view.claims.find((c) => c.seat === seat)?.label ?? 'their claim';
    return [
      call.match ? h('button', { type: 'button', class: 'btn big', dataset: { action: 'call', seat, with: 'match' }, text: `Call ${nameOf(seat)}: ${label} + ${call.match.cost} to stay in`, onClick: () => send({ action: 'call', seat, match: true }) }) : null,
      h('button', { type: 'button', class: 'btn big', dataset: { action: 'call', seat, with: 'fold' }, text: `Call ${nameOf(seat)}: ${label}, then fold`, onClick: () => send({ action: 'call', seat, fold: true }) }),
    ];
  };
  return [
    summary,
    match ? h('button', {
      type: 'button',
      class: `btn big ${mine ? 'primary' : ''}`,
      dataset: { action: 'match' },
      text: match.cost === match.level ? `Stay in for ${match.level}` : `Stay in: ${match.cost} more (to ${match.level})`,
      onClick: () => send({ action: 'match' }),
    }) : null,
    h('button', {
      type: 'button',
      class: `btn big ${!mine ? 'primary' : ''}`,
      dataset: { action: 'fold' },
      text: mine ? 'Fold: withdraw my claim' : 'Fold',
      onClick: () => send({ action: 'fold' }),
    }),
    call ? h('h3', { class: 'chips-title', text: 'Or call a claim as you do' }) : null,
    call ? h('p', { class: 'menu-note', id: 'answer-call-note', text: `A bluff pays you ${view.limits.callStake} and is out of the pot. A true claim costs you ${view.limits.callStake}.` }) : null,
    ...(call?.seats ?? []).flatMap(callRow),
  ];
}

/** One control for each thing the server says is legal. */
function actionControls(a) {
  switch (a.action) {
    case 'back':
      return [h('button', { type: 'button', class: 'btn primary', dataset: { action: 'back' }, text: 'I’m back', onClick: () => send({ action: 'back' }) })];
    case 'next':
      return [h('button', { type: 'button', class: 'btn primary', dataset: { action: 'next' }, text: view.dealByPlayer ? 'Shuffle & deal' : 'Next round', onClick: () => send({ action: 'next' }) })];
    case 'match':
      return [menuButton(`Stay in for ${a.cost}`, { action: 'match' })];
    case 'fold':
      if (view.phase === 'pass' && !view.raise) return []; // it's with the cards, in the pass panel
      return [menuButton('Fold', { action: 'fold' })];
    case 'stop':
      return [h('button', {
        type: 'button',
        class: 'menu-item',
        id: 'stop-open',
        dataset: { action: 'stop-open' },
        text: 'Stop & claim',
        onClick: () => {
          stopOpenFor = `${view.round}:${view.passNo}`;
          renderActions();
        },
      })];
    default:
      return [];
  }
}

async function send(body) {
  if (busy) return;
  busy = true;
  $('error').textContent = '';
  const pressed = pressedButton();
  const releases = [pressing(pressed, WAIT_WORDS[body.action] ?? 'Sending'), locking($('actions'), pressed), locking($('hand-confirm'), pressed)];
  try {
    let res;
    try {
      res = await api('POST', `${path}/act`, { body, token: seatToken });
    } finally {
      for (const release of releases) release(); // before the redraw, which decides for itself what is on or off
    }
    if (body.action === 'pass') pickedCard = null;
    if (body.action === 'claim') pickedClaim = null;
    me = res.me;
    accept(res.state);
    render();
    wakeSoon();
  } catch (err) {
    if (body.action === 'next' && err.code === 'wrong_phase') await poll(); // someone else pressed first
    else $('error').textContent = err.message;
  } finally {
    busy = false;
  }
}

// ---------- talk ----------

/** Suggested lines come from the server, and change with the moment. */
async function renderQuick() {
  if (watching || !me || !view) return;
  const key = `${view.round}:${view.phase}`;
  if (key === quickKey) return;
  quickKey = key;
  try {
    const { lines } = await api('GET', `${path}/quick`, { token: seatToken });
    $('quick').replaceChildren(...lines.map((text) => h('button', { type: 'button', class: 'btn small', text, onClick: () => sayLine(text) })));
  } catch {
    quickKey = ''; // try again on the next poll
  }
}

function renderLeave() {
  const button = $('leave');
  button.hidden = watching || !me || !me.canLeave;
  renderCashOut();
  if (button.hidden) return;
  const midRound = IN_ROUND.includes(view.phase);
  button.disabled = me.leaving;
  if (me.leaving) button.textContent = 'Leaving after this round';
  else if (view.cage) button.textContent = midRound ? 'Leave after this round' : 'Leave table';
  else button.textContent = midRound ? 'Leave after this round' : 'Leave table: cash out';
}

/**
 * At a tNIGHT table: one tap takes the money home. The cage page stands you up on chain, waits for the judge to free the seat,
 * and withdraws it all, in one window; and one tap tops up through the same tiles. No server leave here: the stand is the leave,
 * so nothing races the judge.
 */
function renderCashOut() {
  let row = $('leave-cash');
  if (!view?.cage) { if (row) row.hidden = true; return; }
  if (!row) {
    startCage();
    row = h('div', { class: 'cash-row', id: 'leave-cash' },
      h('button', { class: 'btn small', id: 'cash-out', type: 'button' }),
      h('p', { class: 'why', id: 'cash-out-why' }),
      h('button', { class: 'btn small', id: 'top-up', type: 'button', text: 'Top up', onClick: () => toggleTopUp() }),
      h('button', { class: 'btn small', id: 'hop', type: 'button', text: `Move to ${otherGame(GAME.page).name}`, onClick: () => hopHere() }),
      h('p', { class: 'why', id: 'hop-why' }),
      h('p', { class: 'cage-note', id: 'cash-note', text: 'Cash out can only go back to your own wallet.' }),
      h('div', { id: 'top-up-body', hidden: true }));
    $('leave').parentElement.after(row);
    // Cash out asks how much (11-07): All <n>, or an amount; the figure is the live one, what a cash-out pays once this table settles
    mountCashAsk(row, { balance: () => cage.balance(), live: () => BigInt(cageLive(view.cage.seats.find((x) => x.seat === me?.seat) ?? { balance: 0, behind: 0 }, view.seats[me?.seat])) * 1_000_000n, onGo: (amount) => cashOutHere(amount) });
    cage.on(renderCashOut);
  }
  const inCage = me && view.cage.seats.find((x) => x.seat === me.seat);
  row.hidden = watching || !me || !inCage;
  if (row.hidden) return;
  const button = row.querySelector('#cash-out'); // scoped: the join box's buy-in carries a cash row of its own
  if (button.getAttribute('aria-busy') === 'true') return;
  button.textContent = `Cash out ${cageLive(inCage, view.seats[me.seat])} tNIGHT`;
  const reason = !cage.state.api ? 'Choose your wallet above to cash out from here.' : cage.notReady();
  button.disabled = !!reason && !!cage.state.api;
  const split = cageSplit(inCage, view.seats[me.seat]);
  row.querySelector('#cash-out-why').textContent = cage.state.api && reason ? reason : split ? `Cash out pays ${split.slice(2, -1)} = ${cageLive(inCage, view.seats[me.seat])} tNIGHT, once this table settles.` : '';
  row.querySelector('#top-up').disabled = !!reason && !!cage.state.api;
  const hop = row.querySelector('#hop');
  if (hop.getAttribute('aria-busy') !== 'true') {
    const canMove = cage.permit().good && cage.doorUsable() && !cage.state.seat?.standing && !me.leaving; // a move asks nothing of the wallet (pass #23)
    hop.disabled = !canMove || cage.state.running || cage.state.busy;
    row.querySelector('#hop-why').textContent = canMove ? 'Nothing to approve: the judge settles this table, then moves your seat.' : me.leaving ? 'You’re leaving this table already.' : (!cage.state.door ? 'Reading your session at the door…' : cage.state.door.expired || cage.state.door.status !== 'verified' ? 'Your session at the door has run out: leave, and your next seat takes one approval.' : 'Your permit can’t place a seat here any more: leave, and your next seat takes one approval.');
  }
}

/** Move straight to the other game's table: nothing to approve. The judge settles here first, then moves the seat in one transaction. */
async function hopHere() {
  const button = $('leave-cash').querySelector('#hop');
  const status = (t) => { $('error').textContent = ''; $('turn-line').textContent = t; };
  try {
    const to = await hopTarget(GAME.page);
    clearTimeout(pollTimer);
    const token = await cage.hop({ from: { api: GAME.api, tableId, token: seatToken, cageTable: view.cage.table }, to, name: hallName || null, avatar: hallLook, button, status });
    if (!token) { poll(); return; }
    store.set(seatKey(to.tableId), token);
    store.remove(seatKey(tableId));
    window.location.href = `${to.page}?id=${to.tableId}`;
  } catch (err) {
    $('error').textContent = err.message;
    poll();
  }
}

/** Cash out right here: stand, the judge frees the seat, withdraw it all, in the window. The seat goes, and the page shows the way back in. */
async function cashOutHere(amount = null) {
  if (!cage.state.api) { mountCageJoin(); $('join-box').hidden = false; cageJoin.box.hidden = false; return; }
  const got = await cage.cashOut({ amount, button: $('leave-cash').querySelector('#cash-out'), status: (t) => { $('error').textContent = ''; $('turn-line').textContent = t; } });
  if (got) { seatToken = null; store.remove(seatKey(tableId)); me = null; await poll(); }
}

/**
 * What the cage holds for this seat now: what waits behind the seat plus the live stack on the table, which is what a cash-out pays once the
 * table settles. The cage's own figure moves only at a settle (11-07: the header said 145 all session while the cash-out paid 186).
 */
const cageLive = (inCage, seat) => (seat && !seat.left && Number.isInteger(inCage.behind) ? inCage.behind + seat.chips : inCage.balance);
/** " (70 at the table + 2 not seated)": what the cage figure is made of, said once, when part of it isn't on the table (pass #21). */
const cageSplit = (inCage, seat) => (seat && !seat.left && Number.isInteger(inCage.behind) && inCage.behind > 0 ? ` (${seat.chips} at the table + ${inCage.behind} not seated)` : '');

/** Top up right here: the same tiles, in a panel under the cash row, in top-up mode (stand, the judge, the money, a seat where one is going). */
function toggleTopUp() {
  const body = $('leave-cash').querySelector('#top-up-body');
  if (!cageJoin.topup) {
    startCage();
    const wallets = h('div', { class: 'wallet-list' });
    const connect = h('div');
    const buy = h('div');
    body.append(wallets, connect, buy);
    mountPicker(wallets);
    mountConnectStatus(connect);
    cageJoin.topup = mountBuyIn(buy, { table: view, tableId, game: GAME, topup: true, name: () => hallName, avatar: () => hallLook, onSeated: (token) => { seatToken = token; store.set(seatKey(tableId), token); poll(); } });
  }
  body.hidden = !body.hidden;
  if (!body.hidden) cageJoin.topup.setTable(view);
}

/** After a leave: the judge frees the seat on chain at its next settle. Wait for that here, then the Hall, free to sit anywhere. */
async function freeSeatThenHome() {
  startCage();
  const name = cage.state.wallet?.name ?? 'your wallet';
  cage.openWaiting({ title: `Leaving table ${view.cage.table}`, intro: `The judge frees your seat as soon as your last round is settled: about a minute, two if a round was still on. Nothing to approve in ${name}.`, total: 1, why: cage.WHY.leave });
  const status = (t) => { $('turn-line').textContent = t; };
  // The chain is read through the wallet's session when there is one. With none, the judge still frees the seat; this page can only say so.
  const until = Date.now() + 120000;
  while (!cage.state.session && Date.now() < until && cage.state.api) await new Promise((r) => setTimeout(r, 1000));
  let freed = false;
  if (cage.state.session) {
    await cage.refreshCage();
    freed = !cage.state.seat?.seated || await cage.waitFree({ status, retry: freeSeatThenHome });
  } else {
    cage.setStages(['The judge frees your seat', 'Free']);
    cage.stageAt(0);
    cage.waitingLine('no wallet connected here, so this page can’t watch the chain: the judge frees the seat once your last round is settled, about a minute');
    await new Promise((r) => setTimeout(r, 4000));
    freed = true;
  }
  if (!freed) return;
  cage.waitingLine('your seat is free: the Hall is next, and you can sit anywhere');
  store.set(LEFT_KEY, JSON.stringify({ id: tableId, page: GAME.page, amount: null, told: true }));
  // The release is the judge's transaction, so its card comes from the table's record. The way on waits, so there's time to read it.
  const mine = cage.state.view?.id ?? cage.state.door?.cageId;
  const fresh = await api('GET', path).catch(() => null);
  const receipt = fresh?.cage?.seatReceipts?.findLast((r) => r.kind === 'release' && r.cageId === mine);
  if (receipt) {
    await cage.addResult({ action: 'release', ms: receipt.ms, hash: receipt.hash, report: false });
    cage.offerGo('Back to the Hall', leaveTo);
    return;
  }
  window.location.replace(leaveTo); // not a new history entry: Back can't bring up the table they left, stale
}

async function leaveTable() {
  if (leavingNow) return;
  $('error').textContent = '';
  const release = pressing($('leave'), 'Leaving');
  try {
    leavingNow = true;
    const res = await api('POST', `${path}/leave`, { token: seatToken, body: {} });
    if (!res.queued) goHome(res.amount); // the button stays busy until the next page is up
    else await poll(); // renderLeave now says "Leaving after this round"
  } catch (err) {
    leavingNow = false;
    release();
    $('error').textContent = err.message;
  }
}

/** Back to the Hall, which says what reached the purse. Once: a poll that lands while the Hall is loading must not start it again. */
let leaveTo = '/'; // where Leave ends: the Hall, or the page a nav link was heading for
let leaveAndGo = false; // they chose "Leave and go" to a named place: that is where they are headed, so no end panel in between
let goneHome = false;
function goHome(amount) {
  if (goneHome) return;
  goneHome = true;
  clearTimeout(pollTimer);
  store.remove(seatKey(tableId));
  if (view?.cage) { // the seat on chain is freed first, right here, so nobody walks away still seated
    freeSeatThenHome();
    return;
  }
  const back = Number.isInteger(amount) ? amount : view?.seats[me?.seat]?.chips ?? 0;
  if (Number.isInteger(amount)) store.set(LEFT_KEY, JSON.stringify({ id: tableId, page: '/table', amount, told: false }));
  if (leaveAndGo) {
    window.location.replace(leaveTo); // not a new history entry: Back can't bring up the table they left, stale
    return;
  }
  // Nothing sends them anywhere: what the night came to first, then a fresh table with their stack or the Hall, their pick.
  ended = true;
  for (const id of ['leave', 'add-chips']) if ($(id)) $(id).hidden = true;
  if (view) renderAfterRoundCard();
  placeEnd(tableEnd({ kind: 'left', summary: summaryText(sessionOpen('sealed-hand', tableId, back), back), stack: back, onNew: () => newTable(back), hallHref: leaveTo }));
}

function setupAddChips() {
  $('add-chips-open').addEventListener('click', openAddChips);
  $('fill-up').addEventListener('click', fillUp);
  $('add-chips-amount').addEventListener('input', paintAddConfirm);
  $('add-chips-form').addEventListener('submit', confirmAddChips);
}

function setupTalk() {
  $('leave').addEventListener('click', leaveTable);
  $('say-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('say-input');
    if (input.value.trim()) {
      sayLine(input.value);
      input.value = '';
    }
  });
}

async function sayLine(text) {
  try {
    await api('POST', `${path}/say`, { body: { text }, token: seatToken });
    $('error').textContent = '';
    await poll();
  } catch (err) {
    $('error').textContent = err.message;
  }
}

// ---------- joining ----------

// ---------- the cage on this page: the wallet, the tiles, the seat, in place ----------

const GAME = { api: '/tables', page: '/table', name: 'Sealed Hand' };
const cageJoin = { box: null, buy: null, started: false, topup: null };
let hallName = '';
let hallLook = null;

/** The cage session starts once, the first time this page shows a tNIGHT table (to sit, to leave, or to cash out). */
function startCage() {
  if (cageJoin.started) return;
  cageJoin.started = true;
  cage.start();
  const token = store.get(PLAYER_KEY);
  if (token) api('GET', '/players/me', { token }).then((p) => { hallName = p.name ?? ''; hallLook = p.avatar ?? null; }).catch(() => {});
}

function mountCageJoin() {
  if (cageJoin.box) return;
  startCage();
  const box = h('div', { class: 'cage-join', id: 'cage-join' });
  const wallets = h('div', { class: 'wallet-list', id: 'wallets' });
  const connect = h('div', { id: 'connect-root' });
  const body = h('div', { id: 'buy-body' });
  box.append(wallets, connect, body);
  $('join-box').append(box);
  mountPicker(wallets);
  mountConnectStatus(connect);
  cageJoin.box = box;
  cageJoin.buy = mountBuyIn(body, {
    table: view, tableId, game: GAME, name: () => hallName, avatar: () => hallLook,
    blocked: () => (!view?.cage?.joinable ? 'This table has started, so it can’t take another seat now.' : cage.state.seat?.seated && !cage.seatedAt(view.cage.table) ? `You’re seated at table ${cage.state.view.seat.table}. Leave it first, or wait for it to go quiet.` : ''),
    onSeated: (token) => { seatToken = token; store.set(seatKey(tableId), token); joinOffer = null; conn.clearMoved(); poll(); },
  });
}

function renderJoin() {
  const box = $('join-box');
  const seated = !!seatToken;
  if (watching || seated) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (view.cage) { // a seat here comes from the cage, and the player takes it right here: the wallet, the tiles, one button
    $('join-form').hidden = true;
    $('join-title').textContent = view.cage.joinable ? 'Sit at this table' : 'This table has started';
    mountCageJoin();
    cageJoin.box.hidden = !view.cage.joinable;
    cageJoin.buy.setTable(view);
    $('join-note').replaceChildren(view.cage.joinable
      ? h('span', {}, `This table plays for test NIGHT from the cage on preprod: no real money. ${cage.state.api && cage.balance() >= BigInt(view.limits?.ante ?? 5) * 1_000_000n ? 'The cage covers your seat: sit, and the judge seats you.' : 'Choose your wallet, pick how much, and sit.'}`)
      : h('span', {}, 'Every seat is taken. ', h('a', { href: `${path.replace('/tables/', '/table?id=')}&watch=1`, text: 'Watch this table' }), ' or ', h('a', { href: '/', text: 'find another' }), '.'));
    return;
  }
  const hasPlayer = !!store.get(PLAYER_KEY);
  $('join-name-label').hidden = hasPlayer || !!joinOffer;
  const open = view.phase === 'lobby' && view.seats.length < view.seatsTotal;
  $('join-form').hidden = (!open && !joinOffer) || seatedElsewhere;
  $('join-buyin-row').hidden = !open || !!joinOffer;
  $('join-submit').textContent = joinOffer?.label ?? 'Sit down';
  $('join-title').textContent = seatedElsewhere ? 'You’re already at a table' : joinOffer?.title ?? (open ? 'Take a seat' : 'This table has started');
  if (joinProblem) $('join-note').replaceChildren(joinProblem);
  else if (joinOffer) $('join-note').textContent = joinOffer.note;
  else if (open) $('join-note').textContent = 'Your stack goes back to your purse when you leave or the table ends.';
  else $('join-note').replaceChildren(h('span', {}, 'Every seat is taken. ', h('a', { href: `${path.replace('/tables/', '/table?id=')}&watch=1`, text: 'Watch this table' }), ' or ', h('a', { href: '/', text: 'find another' }), '.'));
}

/** A seat of theirs here, with no seat token to reach it: the player token finds it. */
async function findMySeat({ displaced = false } = {}) {
  const token = store.get(PLAYER_KEY);
  if (watching || seatToken || !token) return;
  try {
    const [where, purse] = await Promise.all([api('GET', `${path}/seat`, { token }), api('GET', '/players/me', { token })]);
    purseChips = purse.purse.amount;
    const input = $('join-buyin');
    const fixed = !!purse.purse.readOnly; // a purse that can't be filled brings what it has, up to the default
    input.max = fixed ? purseChips : Math.max(purseChips, STACK_FULL);
    input.value = fixed ? Math.min(purseChips, STACK_FULL) : STACK_FULL; // every seat starts at 1,000; a short purse is filled up when they sit
    $('join-buyin-of').textContent = purseChips >= STACK_FULL || fixed ? `of your ${fmt(purseChips)}` : `(your purse ${fmt(purseChips)}: it fills up to 1,000)`;
    if (where.status === 'seated' && displaced) {
      joinOffer = { title: 'Your seat is open somewhere else', note: `Your stack of ${where.stack} is safe. This page lost the seat when it was opened in another tab or on another device.`, label: 'Take it back here' };
    } else if (where.status === 'seated') {
      await joinTable(null);
    } else if (where.status === 'left') {
      joinOffer = where.stood
        ? { title: 'You were away too long', note: `After 30 minutes away, your ${where.stack} went back to your purse. You can sit back down, and your whole purse comes with you.`, label: `Sit back down with ${purseChips}` }
        : { title: 'You left this table', note: 'You can sit back down, and your whole purse comes with you.', label: `Sit back down with ${purseChips}` };
      if (autoJoin) await joinTable(null, urlBuyIn);
    }
    render();
  } catch { /* they can still use the form */ }
}

const chosenBuyIn = () => {
  const amount = Number($('join-buyin').value);
  return Number.isInteger(amount) && amount >= 1 ? amount : undefined;
};

async function joinTable(name, buyIn) {
  if (joining) return;
  joining = true;
  joinProblem = null;
  $('error').textContent = '';
  try {
    let token = store.get(PLAYER_KEY);
    if (!token) {
      const player = await api('POST', '/players', { body: { name } });
      token = player.token;
      store.set(PLAYER_KEY, token);
    }
    // The default stack (1,000) is not sent: the table seats them with it and fills a short purse itself, and gives that back if the seat is refused.
    const res = await api('POST', `${path}/join`, { token, body: { kind: 'human', ...(buyIn && buyIn !== STACK_FULL ? { buyIn } : {}) } });
    seatToken = res.token;
    joinOffer = null;
    conn.clearMoved(); // the seat is this page's again
    store.set(seatKey(tableId), seatToken);
    if (!view?.cage && !res.rejoined) sessionOpen('sealed-hand', tableId, buyIn || STACK_FULL); // what they sat down with: the ante may already be in by the first look
    accept(res.state);
    await poll();
  } catch (err) {
    if (err.status === 401) store.remove(PLAYER_KEY);
    joinProblem = err.message;
    if (err.code === 'seated_elsewhere') {
      seatedElsewhere = true;
      joinProblem = await elsewhereNote(err.message);
    } else if (err.code === 'not_enough_chips') {
      const note = await elsewhereNote(null); // an empty purse usually means the chips are at another table
      if (note) {
        seatedElsewhere = true;
        joinProblem = note;
      }
    }
    renderJoin();
    $('join-box').hidden = false;
    $('join-topup').hidden = err.code !== 'not_enough_chips' || (purseChips ?? 0) >= 100; // asking for more than the purse isn't being broke
  } finally {
    joining = false;
  }
}

/** Why a seat was refused, and the way back to the one they already have. */
async function elsewhereNote(message) {
  return elsewhereOffer(message, { sitHere: async () => {
    seatedElsewhere = false;
    joinProblem = null;
    const now = await api('GET', '/players/me', { token: store.get(PLAYER_KEY) }).catch(() => null); // the stack that came back is in the purse: it comes here whole
    await joinTable(null, now?.purse?.amount > 0 ? now.purse.amount : undefined);
  } });
}

// ---------- the loop ----------

function accept(state) {
  view = state;
  clockOffset = state.now - Date.now();
}

// ---------- the deal, shown (11-08) ----------
/** The mode line, kept at the foot of a box, drawn only when it changes. */
function paintModeLine(box, el) {
  const old = document.getElementById('anchor-mode');
  if (!el) { old?.remove(); return; }
  if (old?.textContent === el.textContent) return;
  old?.remove();
  box?.append(el);
}

let dealing = false;
let flipNext = false;
let dealtRound = null; // the last round this page has shown dealt: a page opened mid-round doesn't replay the deal
const anchorNote = mountAnchorNote({ noun: 'hand' });
const lockPanel = mountLockPanel({ noun: 'hand', clock: () => Date.now() + clockOffset, onDone: () => { handKey += '.'; render(); } });

/** A new round reached this page while it was open: shuffle, deal five face down to every seat, then (lock) the lock panel. */
function maybeDeal() {
  const seated = !watching && !!me && view.seats[me.seat] && !view.seats[me.seat].left;
  if (!IN_ROUND.includes(view.phase)) { if (view.phase === 'lobby' || view.phase === 'settled') dealtRound ??= view.round; return; }
  if (dealtRound === null) { dealtRound = view.round; return; } // opened mid-round: no replay
  if (view.round <= dealtRound || dealing) return;
  dealtRound = view.round;
  if (!seated) return;
  if (store.get('hall.dealShow') === 'off') return; // this browser asked for no deal show (the test browsers do)
  dealing = true;
  handKey = '';
  const scene = $('scene');
  renderScene();
  scene.classList.add('dealing');
  const targets = [...scene.querySelectorAll('.backs[data-backs]')].map((el) => ({ el, slots: () => [...el.children] }));
  renderHand();
  targets.push({ el: $('hand'), me: true, slots: () => [...$('hand').children] });
  dealCards({ from: scene, targets }).then(() => {
    dealing = false;
    scene.classList.remove('dealing');
    handKey += '.';
    render();
  });
}

function render() {
  if (!view) return;
  maybeDeal();
  renderStatus();
  renderPurse();
  renderScene();
  renderPot();
  renderChipMoves();
  renderPlates();
  renderCardEffects();
  renderRoundLog();
  renderClaims();
  renderRoundResult();
  renderAfterRoundCard();
  renderTableClosed();
  renderLog();
  renderTalkLine();
  paintTrust(view);
  renderJoin();
  renderHand();
  renderActions();
  renderMoveRow();
  renderStatusPanel();
  renderLeave();
  renderQuick();
  $('say-form').hidden = watching || !me;
  renderClock();
  if (!dealing) lockPanel.update(view.anchor, view.round);
  anchorNote.update(view.anchor, view.round);
  paintRoundId({ record: roundRecord(view, 'sealed-hand'), seal: view.roundSeal ?? view.anchor?.seal ?? null, what: 'seal', onReceipt: (r) => openReceiptWindow({ href: r.href, label: r.label }) }); // the round's name in the top banner (11-08)
  paintModeLine($('hand-box'), modeLine(view, 'sealed-hand'));
  // Tally's lap walkthrough, once, the first time a seat is theirs (11-08): page-side only, the deal never waits for it
  guide.onFirstSit({ seated: !watching && !!me && !!seatToken && !view.seats[me.seat]?.left, art, rules: $('rules') });
}

async function poll() {
  const startedAt = Date.now();
  try {
    accept(await api('GET', path));
    if (seatToken) {
      try {
        me = await api('GET', `${path}/me`, { token: seatToken });
      } catch (err) {
        if (err.status === 401) { // this seat was reopened elsewhere, or we've left it
          if (me?.leaving || leavingNow) return goHome(view.seats[me?.seat]?.leftWith);
          const stored = store.get(seatKey(tableId));
          me = null;
          if (stored && stored !== seatToken) seatToken = stored; // another tab of this browser took it back: so do we
          else {
            seatToken = null;
            store.remove(seatKey(tableId));
            await findMySeat({ displaced: true });
            if (joinOffer) conn.moved(); // the newest page has the seat; this one only watches, and says so
          }
        }
      }
    }
    render();
    conn.ok(startedAt);
  } catch (err) {
    if (err.status !== 404) conn.failed(err);
    if (err.status === 404) {
      $('phase').textContent = 'No such table';
      $('turn-line').textContent = 'That table isn’t here any more.';
      return false;
    }
    $('phase').textContent = 'Reconnecting…';
  }
  return true;
}

let pollTimer = null;

/** Look again now: the browser is back online, or the tab is shown again. Not on a page that has stopped polling. */
function pollNow() {
  if (pollTimer === null) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loop, 0);
}
/** Connection lost / back in / seat moved, said in a banner (connection.js, shared by both games). */
const conn = mountConnection({
  noun: 'cards',
  wake: () => pollNow(),
  situation: () => {
    if (!view) return {};
    if (!me || watching) return { seated: false };
    const myTurn = view.turn === me.seat || (view.waitingOn ?? []).includes(me.seat);
    return { seated: true, myTurn, turnName: view.turn !== null && view.turn !== undefined ? view.seats[view.turn]?.name ?? null : null, deadlineIn: view.deadline ? view.deadline - (Date.now() + clockOffset) : null, away: !!me.away };
  },
});

/** Polls on the usual beat, or just after the next bot is due, so a move shows when its ring runs out. */
function nextPollDelay() {
  if (document.hidden) return HIDDEN_POLL_MS;
  const now = Date.now() + clockOffset;
  const soonest = Math.min(...(view?.clocks ?? []).map((c) => c.until ?? Infinity));
  return Math.min(POLL_MS, Math.max(250, soonest - now + 120));
}

async function loop() {
  const keepGoing = await poll();
  if (keepGoing === false) return;
  pollTimer = setTimeout(loop, nextPollDelay());
}

/** After a move, the next poll's timing depends on who is now on the clock. */
function wakeSoon() {
  if (pollTimer === null) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loop, nextPollDelay());
}

async function start() {
  setupSound($('sound'));
  setupTalk();
  setupAddChips();
  await loadArt();
  fit();
  window.addEventListener('resize', () => {
    fit();
    handKey += '.';
    if (view) render();
  });
  setInterval(renderClock, 200);
  setInterval(() => lockPanel.tick(), 500);
  if (!tableId) {
    $('phase').textContent = 'No table chosen';
    return;
  }
  $('mode').textContent = watching ? 'watching' : '';
  guide.mount([$('guide-open'), $('guide-again')], { art: () => art, rules: $('rules') });
  $('join-topup').addEventListener('click', async () => {
    try {
      await api('POST', '/players/me/fill-up', { token: store.get(PLAYER_KEY) });
      $('join-topup').hidden = true;
      await joinTable(null, chosenBuyIn());
    } catch (err) {
      $('join-note').textContent = err.message;
    }
  });
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinTable($('join-name').value, joinOffer ? undefined : chosenBuyIn());
  });
  await poll();
  await findMySeat();
  if (autoJoin && !seatToken && !watching && !joinOffer && store.get(PLAYER_KEY) && view?.phase === 'lobby') {
    await joinTable(null, urlBuyIn);
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted) poll(); }); // back to this page out of the browser's cache
  if (seatToken || watching) history.replaceState(null, '', `/table?id=${tableId}${watching ? '&watch=1' : ''}`);
  loop();
}

start();

mountSupport(document.getElementById('support'));

// The top bar. Seated, a link that leaves the table asks first, with the same confirm as the Hall button always did.
mountNav({
  guard: (href, label) => {
    if (!seatToken || !me || watching || me.leaving || leavingNow) return false;
    confirmLeave({ game: GAME.name, stack: view?.seats[me.seat]?.chips ?? 0, unit: view?.cage ? 'tNIGHT' : 'chips', where: label === 'The Hall' ? 'the Hall' : label, onLeave: () => { leaveTo = href; leaveAndGo = true; leaveTable(); } });
    return true;
  },
});
