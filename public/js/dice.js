// The Cup & Claim table page. It holds no game logic: every control comes from the server's legal list, and every
// result from the public state. Watch mode sends no token and never asks for /me. Built on the same bones as
// table.js (joining, the purse, polling, talk), with the cups, the bid picker, the Liar button and the prove/show
// moment in place of cards and claims.

import { mountSupport } from './support.js';
import { confirmLeave, elsewhereOffer, hopTarget, otherGame, paintTrust } from './table-flow.js';
import { mountNav } from './nav.js';
import { renderAfterRound } from './after-round.js';
import { flashNet, fmt, plainClose, sessionAdded, sessionOpen, sessionText, sitAtNewTable, summaryText, tableEnd } from './money.js';
import { anchorLinkFor, modeLine, mountAnchorNote, mountLockPanel, paintRoundId } from './deal-show.js';
import { openReceiptWindow, paintReceiptButton } from './receipt-window.js';
import { firstWin } from './player-id.js';
import { markWhole } from './tapestry-mark.js';
import * as cage from './cage-session.js';
import { tallyGuide } from './tally-guide.js';
import { placeMoves, rowHolds, whyNot } from './move-help.js';
import * as proofSeat from './dice-proof.js';
import { mountBuyIn, mountCashAsk, mountConnectStatus, mountPicker } from './buy-in.js';
import { flashEl, makeEffects, popEl, reduceMotion, turnNoteEl, verdictEl, agentMark, agentTag } from './seat-cards.js';
import { HALL_ART, LEFT_KEY, MODE_KEY, PLAYER_KEY, api, art, faceEl, go, seatArt, h, loadArt, locking, paintPhase, pressedButton, pressing, roundRecord, seatKey, setupSound, store } from './common.js';
import { mountConnection } from './connection.js';

const guide = tallyGuide('cup-and-claim'); // Tally's first-sit card; "?" and How to play reopen it
const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;
const RING_STEPS = 24;
const PURSE_REFRESH_MS = 20_000;
const IN_ROUND = ['bid', 'duel'];
// What a pressed move says while the table answers.
const WAIT_WORDS = { bid: 'Bidding', liar: 'Calling Liar', fold: 'Folding', next: 'Shaking the cups', back: 'Sitting back down' };
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const DICE_ART = '/art/dice/';
const FACE_WORDS = { 2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes' };
const FACE_ONE = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const tableId = params.get('id');
const watching = params.get('watch') === '1';
const autoJoin = params.get('join') === '1';
const urlBuyIn = Number(params.get('buyin')) || undefined;
const path = `/dice-tables/${tableId}`;

let seatToken = watching ? null : store.get(seatKey(tableId));
let view = null;
let me = null;
let diceArt = {};
// The table art (11-06), as it was drawn (scripts/art/table-room.py only re-encodes it): a portrait 1152 x 1728 picture.
// A phone shows it whole. A wide screen crops it to the lamp, the window and the table (rows 175 to 1410, every column),
// and draws it no taller than the window has room for, never stretched.
const ROOM = { w: 1152, h: 1728, file: '/art/dice/table-room-1152.webp', crop: { top: 175 / 1728, bottom: (1728 - 1410) / 1728 }, narrowCrop: { top: 690 / 1728, bottom: (1728 - 1380) / 1728 } };
const WIDE_FOCUS = 960; // from 1280 the picture is cropped about this row: between the figures' heads (~700) and the cups and dice (~1300)
const WIDE_MIN_ROWS = 700;
// The official Midnight symbol (the brand file, unaltered), laid on the bare wood wall to the right of the tapestry at a lower
// opacity (11-06, round 2: the tapestry keeps only its own woven emblem). In the picture's pixels the planks run x 270 to
// 450, between the banner's pole and the lamp, from the beam at row 90 down to the cabinet at 690. The symbol is 120 wide (half
// again the 80 it was on the cloth). If the frame would cut it, or the wall round it, it isn't drawn.
const MARK = { file: '/brand/midnight/Midnight-RGB_Symbol-White.svg', cx: 360, cy: 330, size: 120, cloth: { top: 90, bottom: 690 } };
let clockOffset = 0;
let lastLogN = 0;
let actionsKey = '';
let cupsKey = '';
let callKey = '';
let joining = false;
let joinOffer = null;
let joinProblem = null;
let seatedElsewhere = false;
let leavingNow = false;
let purseChips = null;
let purseAsked = '';
let quickKey = '';
const logEls = new Map();
let busy = false;

// The shake and the slam: once per round, for the owner of the cup.
let shownRound = null; // the round whose dice this page has already revealed
let shaking = false;
let myDiceKey = '';

// Picked, not yet confirmed.
let pick = { count: null, face: null, key: '' };

// Round 3: the action on the seat cards. What's been shown already, so a page opened mid-round pops nothing for what's on the
// table, and the live overlays (re-laid when the strip is rebuilt), each with the moment it's spent.
let effectsPrimed = false;
let seenBidN = 0;
let seenCall = '';
let seenVerdict = '';
const effects = makeEffects($('cups'), (seat) => $('cups').querySelector(`.cup-card[data-cup="${seat}"]`)); // the overlays, shared with Sealed Hand (seat-cards.js)
let raiseAmount = 0;

// ---------- layout ----------

function fit() {
  const width = document.documentElement.clientWidth;
  const wide = width >= 980;
  const zone = $('scene').closest('.zone-mid');
  const colW = Math.max(200, zone.clientWidth || Math.min(width, 1280) - 16);
  let crop = wide ? ROOM.crop : ROOM.narrowCrop; // a phone shows a band of the table (Phase A, 11-07): the cups, the pot and the heads, under your cup and your move
  const shownH = ROOM.h * (1 - crop.top - crop.bottom);
  let s = colW / ROOM.w;
  if (wide) { // the room, the bid board and your cup under it fit the window's height, so the cup is never below the fold
    const top = zone.getBoundingClientRect().top + window.scrollY;
    const room = Math.max(300, window.innerHeight - top - 78 - 200); // pixels of height for the picture
    if (width >= 1280) {
      // From 1280 the picture fills its column, as Sealed Hand's does (11-10): drawn the column's width, cropped in height to what the
      // window has room for, on a focal point between the figures' heads and the cups so the table, the cups, the dice and the others
      // stay in frame. Rows are never fewer than WIDE_MIN_ROWS; a window too short for that draws it smaller, centred, as before.
      const rows = Math.min(shownH, Math.max(WIDE_MIN_ROWS, room / s));
      if (rows < shownH) {
        const first = Math.min(ROOM.h * (1 - ROOM.crop.bottom) - rows, Math.max(ROOM.h * ROOM.crop.top, WIDE_FOCUS - rows / 2));
        crop = { top: first / ROOM.h, bottom: (ROOM.h - first - rows) / ROOM.h };
      }
      if (room / s < WIDE_MIN_ROWS) s = room / WIDE_MIN_ROWS;
    } else s = Math.min(s, room / shownH);
  }
  const root = document.documentElement.style;
  root.setProperty('--s', s.toFixed(4));
  root.setProperty('--crop-top', crop.top.toFixed(4));
  root.setProperty('--crop-bottom', crop.bottom.toFixed(4));
  root.setProperty('--scene-w', ROOM.w);
  root.setProperty('--scene-h', ROOM.h);
  // The symbol is whole or not there: shown only if the rows in view hold it with a margin of cloth round it.
  document.documentElement.classList.toggle('mark-cut', !markWhole(crop, ROOM.h, MARK));
  // Five dice across your cup, with room to breathe.
  const cupCol = wide ? colW : width; // your cup sits under the room now (Phase A): its dice size from the centre column
  const across = Math.floor((cupCol - 80) / 5 / 1.2);
  const die = Math.max(36, Math.min(48, across));
  root.setProperty('--die', die);
  const moveCol = wide ? (width >= 1280 ? 340 : 300) : width; // the picker's five faces fit the move column (table3.css widths), never past it
  root.setProperty('--pick-die', Math.max(30, Math.min(48, Math.floor((moveCol - 70 - 4 * 6) / 5) - 12)));
  // your cup, drawn at whole pixels (round 3): a raster drawn at a fraction of a pixel goes soft
  root.setProperty('--cup-w', Math.round(die * 2.6));
  root.setProperty('--cup-h', Math.round(die * 2.5));
  document.documentElement.classList.toggle('short', window.innerHeight < 940);
  document.documentElement.classList.toggle('laptop', wide && window.innerHeight < 960);
}

const labelBid = (bid) => (bid ? `at least ${bid.count} ${bid.count === 1 ? FACE_ONE[bid.face] : FACE_WORDS[bid.face]}` : 'nothing');
/** "left · 1,011": a seat that left shows what went back to the purse, not 0 chips (which reads as busted), for one round. */
const leftText = (seat) => (Number.isFinite(seat.leftWith) ? `left · ${seat.leftWith.toLocaleString('en-US')}` : 'left');

/** What a bid is about, in plain words (11-10, Adam: new players think a bid is about their own cup). The real count: tables run 2 to 6 seats. */
const bidScope = (total) => (total ? `Bids count every die at the table, all ${total}, not just yours.` : 'Bids count every die at the table, not just yours.');

const nameOf = (seat) => view.seats[seat]?.name ?? `Seat ${seat}`;
const seatWord = (seat) => (seat === me?.seat ? 'you' : nameOf(seat));
const SeatWord = (seat) => (seat === me?.seat ? 'You' : nameOf(seat));
const possessive = (seat) => (seat === me?.seat ? 'your' : `${nameOf(seat)}’s`);

function dieEl(face, { small = false, wild = true, label = true } = {}) {
  return h('span', {
    class: `die ${small ? 'small' : ''} ${wild && face === 1 ? 'wild' : ''}`,
    vars: { face },
    role: label ? 'img' : undefined,
    'aria-label': label ? (face === 1 ? 'a one, wild' : `a ${FACE_ONE[face]}`) : undefined,
    'aria-hidden': label ? undefined : 'true',
  });
}

const cupClass = () => (diceArt.cup ? '' : 'drawn');

// ---------- the scene: the room, the pot and the standing bid ----------

const potTier = (amount) => (amount >= 60 ? 'large' : amount >= 20 ? 'medium' : 'small');

function pileEl(tier) {
  const sprite = art.pot?.[tier];
  if (sprite) {
    const el = h('div', { class: 'pile sprite-pile', dataset: { tier }, vars: { pw: sprite.w, ph: sprite.h } });
    el.style.backgroundImage = `url(${HALL_ART}${sprite.file})`;
    return el;
  }
  const coins = { small: 2, medium: 5, large: 9 }[tier];
  return h('div', { class: 'pile coin-pile', dataset: { tier } }, Array.from({ length: coins }, () => h('img', { class: 'px', src: '/art/coin.png', alt: '' })));
}

function renderScene() {
  const scene = $('scene');
  if (!scene.querySelector('.pot-on-felt')) scene.append(h('div', { class: 'pot-on-felt', id: 'felt-pot' })); // the bid board is under the scene, off the table
  const pot = scene.querySelector('.pot-on-felt');
  pot.hidden = view.pot <= 0;
  const key = `${view.pot}`;
  if (pot.dataset.key !== key) {
    pot.dataset.key = key;
    pot.dataset.tier = potTier(view.pot);
    pot.replaceChildren(h('div', { class: 'piles' }, pileEl(potTier(view.pot))), h('div', { class: 'pot-amount', text: String(view.pot) }));
  }
  const bid = $('felt-bid');
  const standing = view.phase === 'duel' ? view.duel.bid : view.bid;
  bid.hidden = !IN_ROUND.includes(view.phase);
  if (!bid.hidden) {
    const mine = me && view.waitingOn[0] === me.seat;
    if (!standing) {
      bid.replaceChildren(h('span', { class: 'big-bid', text: 'No bid yet' }), h('small', { text: view.anchor?.held ? 'locking the roll on Midnight first' : mine ? 'you open the bidding' : `${nameOf(view.waitingOn[0])} opens the bidding` }));
    } else {
      const seat = view.phase === 'duel' ? view.duel.bidder : view.bid.seat;
      const under = `${labelBid(standing)} · ${view.phase === 'duel' ? `${nameOf(view.duel.caller)} called Liar on ${nameOf(seat)}` : mine ? 'beat it or call liar' : `${nameOf(seat)}’s · ${nameOf(view.waitingOn[0])} to beat it or call liar`}`;
      bid.replaceChildren(h('span', { class: 'big-bid', id: 'big-bid' }, bigBid(standing), ' ', dieEl(standing.face, { label: false })), h('small', { text: under }));
    }
  }
  scene.querySelectorAll('.ring').forEach((el) => el.remove());
  renderTableCups();
}

// Where each seat sits, in the 1152 x 1728 picture. You're at the front, your cup nearest you; the others stand behind the
// table's far rim, in seat order from your left, spread over the back so none is under the lamp's foot or off the picture,
// each with their cup on the table in front of them. A watcher sees every seat at the back. (Sealed Hand does the same:
// the others face you across the table.) The top's playing surface is an ellipse centred at (576, 1108), radii 554 x 228;
// the cups stand on a ring inside it. The far rim, fitted to the picture, is the line the figures stand behind. The lamp's
// pool of light on the table is round (590, 1030). A cup or a figure nearer the lamp is brighter, its lit side turned to it,
// its shadow falling away from it; one nearer the back is a little smaller.
const TABLE = { cx: 576, cy: 1108, rx: 554 * 0.72, ry: 228 * 0.66 };
const RIM = { cx: 576, cy: 1096, rx: 557, ry: 235 };
const LAMP = { x: 590, y: 1030 };
const rimY = (x) => RIM.cy - RIM.ry * Math.sqrt(Math.max(0, 1 - ((x - RIM.cx) / RIM.rx) ** 2));
// Half the back arc the others are spread over, by how many there are (degrees): two face you from either side of the lamp.
const BACK_SPREAD = [0, 0, 40, 56, 62, 66];
const FIGURE_SCALE = 2.45; // a Hall sprite, in the picture's pixels: head and shoulders over the rim, clear of the lamp
let cupsOnTableKey = '';

/** Each seat's angle round the table: 0 is the front (you), pi the middle of the back. */
function seatAngles(n, front) {
  const others = [];
  for (let k = front === null ? 0 : 1; k < n; k++) others.push(front === null ? k : (front + k) % n);
  const angles = new Map(front === null ? [] : [[front, 0]]);
  const m = others.length;
  const spread = (BACK_SPREAD[Math.min(m, BACK_SPREAD.length - 1)] * Math.PI) / 180;
  others.forEach((i, k) => angles.set(i, m === 1 ? Math.PI : Math.PI - spread + (2 * spread * k) / (m - 1)));
  return angles;
}

/** Lamplight at a point of the table: brighter in the pool, dusk at the rim, and which way the light comes from. */
function lampAt(x, y) {
  const dx = (x - LAMP.x) / TABLE.rx;
  const dy = (y - LAMP.y) / TABLE.ry;
  const far = Math.min(1.4, Math.hypot(dx, dy));
  const len = Math.hypot(dx, dy) || 1;
  return { lit: 1.18 - 0.36 * far, flip: x < LAMP.x ? -1 : 1, shx: (dx / len) * 16, shy: (dy / len) * 7 };
}

function cupPlace(a) {
  const x = TABLE.cx - TABLE.rx * Math.sin(a);
  const y = TABLE.cy + TABLE.ry * Math.cos(a);
  const depth = 0.84 + 0.26 * ((y - (TABLE.cy - TABLE.ry)) / (2 * TABLE.ry)); // 0.84 at the back, 1.1 at the front
  return { x, y, depth, side: x < TABLE.cx - 4 ? -1 : 1, ...lampAt(x, y) };
}

/** A figure behind the far rim, in the picture's pixels, and the rim's line across it (for the clip: the table hides the rest). */
function figurePlace(seat, a) {
  const look = seatArt(seat);
  const x = RIM.cx - RIM.rx * 0.84 * Math.sin(a);
  const base = rimY(x);
  const k = FIGURE_SCALE * (1 + (0.1 * (base - RIM.cy + RIM.ry)) / RIM.ry); // the sides are nearer: a little bigger
  const w = look.w * k;
  const hgt = look.h * k;
  const left = x - w / 2;
  const top = base - hgt * 0.5; // the top half over the rim, as Sealed Hand's players stand over its table
  const edge = [];
  for (let t = 0; t <= 8; t++) {
    const px = left + (w * t) / 8;
    edge.push(`${((t / 8) * 100).toFixed(1)}% ${(((rimY(px) - top) / hgt) * 100).toFixed(1)}%`);
  }
  return { look, left, top, w, hgt, clip: `polygon(0% 0%, 100% 0%, ${edge.reverse().join(', ')})`, ...lampAt(x, base + 60) };
}

/**
 * The table: each seat's character (but yours) standing behind it, and each seat's cup on it. Art only, no words. A shut cup
 * is the cup turned down over the dice; a cup whose owner shows on a call stands up beside its dice, and so does yours, for
 * you, with your dice in front of it.
 */
function renderTableCups() {
  const scene = $('scene');
  if (!scene.querySelector('.tapestry-mark')) scene.append(h('span', { class: 'tapestry-mark', dataset: { src: MARK.file }, 'aria-hidden': 'true', vars: { mx: ((MARK.cx / ROOM.w) * 100).toFixed(2), my: ((MARK.cy / ROOM.h) * 100).toFixed(2), mw: ((MARK.size / ROOM.w) * 100).toFixed(2) } }));
  const last = view.phase === 'settled' && view.lastDuel?.round === view.round ? view.lastDuel : null;
  const n = view.seatsTotal;
  const front = me && !watching && view.seats[me.seat] && !view.seats[me.seat].left ? me.seat : null;
  const angles = seatAngles(n, front);
  const myDice = me && !watching && me.dice?.length && IN_ROUND.includes(view.phase) ? me.dice : null;
  const cups = view.seats.map((seat, i) => {
    if (!seat || seat.left || !seat.cup && !last?.reveals.some((r) => r.seat === i)) return null;
    const shown = last?.reveals.find((r) => r.seat === i && r.mode === 'show') ?? (view.duel?.modes[i] === 'show' ? { dice: null } : null);
    const mine = i === me?.seat && !watching;
    const dice = shown?.dice ?? (mine && !last ? myDice : null);
    return { i, folded: seat.status === 'folded', turn: view.waitingOn.includes(i) && IN_ROUND.includes(view.phase), dice, lifted: !!shown || !!(mine && dice), mine };
  }).filter(Boolean);
  const figures = view.seats.map((seat, i) => (seat && !seat.left && i !== front ? { i, name: seat.name, kind: seat.kind, avatar: seat.avatar, folded: seat.status === 'folded', away: !!seat.away } : null)).filter(Boolean);
  const s = Number(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
  const key = JSON.stringify([cups, figures, n, front, s.toFixed(3)]);
  if (key === cupsOnTableKey) return;
  cupsOnTableKey = key;
  scene.querySelectorAll('.table-cup, .table-figure').forEach((el) => el.remove());
  for (const f of figures) {
    const p = figurePlace(view.seats[f.i], angles.get(f.i));
    const el = h('div', {
      class: `sprite frames table-figure ${f.folded ? 'folded' : ''} ${f.away ? 'away' : ''}`,
      dataset: { figure: f.i, sprite: f.kind },
      'aria-hidden': 'true',
      vars: { x: p.left.toFixed(1), y: p.top.toFixed(1), sw: p.w.toFixed(1), sh: p.hgt.toFixed(1), lit: Math.min(1.12, p.lit + 0.08).toFixed(3) },
    });
    el.style.backgroundImage = `url(${p.look.url})`;
    el.style.clipPath = p.clip; // the table's far rim hides them from the waist down
    el.style.animationDelay = `${-f.i * 0.37}s`;
    scene.append(el);
  }
  for (const c of cups) {
    const p = cupPlace(angles.get(c.i));
    const u = s * p.depth; // the picture's pixel at this depth, in CSS px; the cup and its dice are drawn at whole pixels (round 3)
    scene.append(h('div', {
      class: `table-cup ${c.folded ? 'folded' : ''} ${c.turn ? 'turn' : ''} ${c.lifted ? 'lifted' : ''} ${c.mine ? 'mine' : ''}`,
      dataset: { tableCup: c.i },
      'aria-hidden': 'true',
      // custom properties: the page's CSP refuses a style attribute
      vars: { cx: ((p.x / ROOM.w) * 100).toFixed(2), cy: ((p.y / ROOM.h) * 100).toFixed(2), depth: p.depth.toFixed(3), lit: p.lit.toFixed(3), flip: p.flip, side: p.side, shx: p.shx.toFixed(1), shy: p.shy.toFixed(1), cw: Math.round((c.lifted ? 74 : 112) * u), ch: Math.round((c.lifted ? 117 : 127) * u), dpx: Math.round((c.mine ? 51 : 34) * u) },
    }, h('span', { class: 'cup-shadow' }), h('span', { class: 'cup-art' }), c.dice ? h('span', { class: 'cup-dice' }, c.dice.map((d) => dieEl(d, { small: true, label: false }))) : null));
  }
}

// ---------- the cups ----------

function cupCard(seat, i) {
  const mine = me?.seat === i;
  const duel = view.duel;
  const last = view.phase === 'settled' && view.lastDuel?.round === view.round ? view.lastDuel : null;
  const reveal = last?.reveals.find((r) => r.seat === i);
  const mode = duel?.modes[i] ?? reveal?.mode ?? null;
  const turn = view.waitingOn.includes(i) && IN_ROUND.includes(view.phase);
  // the glow is for the one whose bid it is; on a call every cup answers, so the cards say "choosing…" without every one of them pulsing
  const classes = ['seat-card', 'cup-card', seat.status, turn && view.phase === 'bid' ? 'turn' : '', mine ? 'mine' : '',
    duel?.bidder === i || last?.bidder === i ? 'bidder' : '', duel?.caller === i || last?.caller === i ? 'caller' : ''];
  const answer = [];
  if (reveal) {
    if (reveal.mode === 'show') answer.push(...reveal.dice.map((d) => dieEl(d, { small: true })));
    else if (reveal.mode === 'silent') answer.push(h('span', { class: 'mode-tag', text: 'never answered' }));
    else if (reveal.proof?.kind === 'compact-proof') answer.push(h('span', { class: 'count-badge', title: 'Cup shut. The chain checked this count against the seal.' }, `${reveal.count}`, h('small', { text: `of ${FACE_WORDS[last.bid.face]} · proven` })));
    else answer.push(h('span', { class: 'count-badge', title: 'Cup shut. The house vouches for this count.' }, `${reveal.count}`, h('small', { text: `of ${FACE_WORDS[last.bid.face]} · house’s word` })));
  } else if (duel) {
    if (duel.waiting.includes(i)) answer.push(h('span', { class: 'mode-tag', text: 'choosing…' }));
    else if (mode) answer.push(h('span', { class: `mode-tag ${mode}`, text: mode === 'show' ? 'lifts the cup' : 'cup shut' }));
    else answer.push(h('span', { class: 'mode-tag prove', text: 'folded: cup shut' }));
  }
  // Laid out as Sealed Hand's seat badges (11-06): the face tile, the name and the stack; under them the cup and the last bid.
  return h('div', { class: classes.join(' '), dataset: { cup: i, seatCard: i } },
    faceEl(seat, 32),
    h('span', { class: 'name', text: seat.name.replace(/ · house$/, '') }), // the badge says house, for Tally as for the other bots (11-07)
    h('span', { class: `cup-icon ${cupClass()} ${seat.cup ? '' : 'empty'} ${mode === 'show' ? 'lifted' : ''}`, role: 'img', 'aria-label': seat.cup ? `${seat.cup} dice under the cup` : 'no cup this round' }),
    // whose turn (round 3): thinking… on theirs, YOUR TURN on yours; on a call, who is still choosing
    turnNoteEl({ mine, turn, deciding: view.phase === 'duel' }),
    h('div', { class: 'cup-answer' }, answer),
    lastBidOf(i) ? h('span', { class: 'last-bid', title: 'Their last bid this round' }, `${lastBidOf(i).count}×`, dieEl(lastBidOf(i).face, { small: true, label: false })) : h('span', { class: 'last-bid none', text: IN_ROUND.includes(view.phase) ? 'no bid yet' : '' }),
    h('span', { class: seat.left ? 'chips left' : 'chips' }, seat.left ? leftText(seat) : [h('img', { class: 'px', src: '/art/coin.png', alt: '' }), String(seat.chips)]),
    seat.owed ? h('span', { class: 'owed', text: `owes ${seat.owed} to bid` }) : null,
    h('div', { class: 'tags' },
      mine ? h('span', { class: 'tag you', text: 'you' }) : null,
      agentTag(seat),
      seat.kind === 'house' ? h('span', { class: 'tag house', text: 'house' }) : null,
      seat.away ? h('span', { class: 'tag away', text: 'away' }) : null,
      seat.status === 'folded' ? h('span', { class: 'tag', text: 'folded' }) : null,
      seat.left ? h('span', { class: 'tag', text: 'left' }) : null,
      seat.leaving ? h('span', { class: 'tag', text: 'leaving' }) : null),
    h('span', { class: 'rep', title: 'bids called / proven / caught', text: `${seat.rep.called}/${seat.rep.proven}/${seat.rep.caught}` }),
    h('span', { class: 'rep', title: 'times this seat lifted the cup', text: `open hands ${seat.rep.open}` }));
}

/** This round's bids, oldest first, from the table's own log lines (each bid line carries the bid). */
const roundBids = () => (view?.log ?? []).filter((l) => l.bid && l.round === view.round).map((l) => ({ ...l.bid, n: l.n }));
const lastBidOf = (seat) => roundBids().filter((b) => b.seat === seat).at(-1) ?? null;
const BID_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** "four 4s": how a bid reads at a glance. */
const bigBid = (bid) => `${BID_WORDS[bid.count] ?? bid.count} ${bid.face}${bid.count === 1 ? '' : 's'}`;

function renderCups() {
  const cups = $('cups');
  cups.style.setProperty('--n', view.seatsTotal);
  const key = JSON.stringify([view.seats, view.waitingOn, view.duel, view.phase, view.lastDuel?.round, me?.seat, roundBids().length]);
  if (key === cupsKey) return;
  cupsKey = key;
  const nodes = [];
  for (let i = 0; i < view.seatsTotal; i++) {
    const seat = view.seats[i];
    nodes.push(seat && !seat.gone ? cupCard(seat, i) : h('div', { class: 'seat-card cup-card out open', title: 'An open seat' }, h('span', { class: 'name', text: 'Open seat' })));
  }
  cups.replaceChildren(...nodes);
}

// ---------- the action on the cards (round 3) ----------

/**
 * What just happened, on the card it happened to: a new claim pops in large on the claimer's card (a second, then it settles
 * into the chip); a Lie! call flashes on the caller's; the count puts Wrong and the cost on the loser's card and what each other
 * player took on theirs, held three seconds. The log panel keeps the whole history. Reduced motion: no pop, no flash, just the
 * verdict as a state change.
 */
function renderCardEffects() {
  const bids = roundBids();
  const newest = bids.at(-1) ?? null;
  const last = view.phase === 'settled' && view.lastDuel?.round === view.round ? view.lastDuel : null;
  const callKey = view.phase === 'duel' && view.duel ? `${view.round}:${view.duel.caller}` : last ? `${last.round}:${last.caller}` : '';
  const verdictKey = last ? `${last.round}` : '';
  if (!effectsPrimed) { // the first view of the table: nothing pops for what's already on it
    effectsPrimed = true;
    seenBidN = newest?.n ?? 0;
    seenCall = callKey;
    seenVerdict = verdictKey;
    return;
  }
  const quiet = reduceMotion();
  if (newest && newest.n > seenBidN) {
    seenBidN = newest.n;
    if (!quiet && IN_ROUND.includes(view.phase)) effects.add(newest.seat, 'claim', 1100, () => popEl(`${newest.count} ×`, dieEl(newest.face, { label: false })));
  }
  if (callKey && callKey !== seenCall) {
    seenCall = callKey;
    const caller = view.duel?.caller ?? last.caller;
    effects.add(caller, 'lie', 3000, () => flashEl('Lie!'));
  }
  if (verdictKey && verdictKey !== seenVerdict) {
    seenVerdict = verdictKey;
    const r = view.lastResult?.round === view.round ? view.lastResult : null;
    const cost = r?.loserStake ?? 0;
    effects.add(last.loser, 'verdict', 3000, () => verdictEl('wrong', last.loser === last.caller ? 'Wrong call' : 'Wrong', cost ? `−${cost}` : ''));
    for (const a of r?.awards ?? []) {
      if (a.seat === last.loser || !(a.share > 0)) continue;
      effects.add(a.seat, 'verdict', 3000, () => verdictEl('right', a.seat === last.winner ? (last.held ? 'Held' : 'Right call') : 'Share', `+${a.share}`));
    }
  }
  effects.lay(); // the live overlays, on the cards as they are now (a rebuilt strip lost them)
}

// ---------- your cup ----------

function renderMyCup() {
  const box = $('cup-box');
  const felt = $('cup-felt');
  const cup = $('cup-sprite');
  const diceBox = $('my-dice');
  felt.classList.toggle('painted', !!diceArt.hero);
  cup.classList.toggle('drawn', !diceArt.cup);
  if (watching || !me) {
    box.hidden = false;
    if (view.phase === 'lobby') shownRound = 0; // the first deal after sitting down gets the shake
    $('cup-title').textContent = watching ? 'Every cup stays shut' : 'Your cup';
    if (myDiceKey !== 'sealed') {
      myDiceKey = 'sealed';
      diceBox.className = 'my-dice sealed';
      diceBox.replaceChildren(...[1, 2, 3, 4, 5].map((f) => dieEl(f, { wild: false, label: false })));
      cup.className = `cup-sprite shut ${cupClass()}`;
    }
    $('counts').textContent = watching ? 'Nobody sees under a cup but its owner. On a call, each cup sends out a count, or its dice.' : '';
    return;
  }
  box.hidden = false;
  if (me.diceHeld || lockPanel.open) { // shaken and sealed, not yet yours to see: the cup stays down until the lock lands (or fails) and its ✓ has had its moment
    const heldKey = `held:${view.round}`;
    if (myDiceKey === heldKey) return;
    myDiceKey = heldKey;
    diceBox.className = 'my-dice sealed';
    diceBox.replaceChildren(...[1, 2, 3, 4, 5].map((f) => dieEl(f, { wild: false, label: false })));
    $('counts').textContent = 'Your cup stays down until this roll is locked on Midnight.';
    if (shownRound !== view.round && !shaking && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && shownRound !== null) shakeAndSlam({ stayDown: true });
    else {
      shownRound = view.round;
      cup.className = `cup-sprite shut ${cupClass()}`;
      $('cup-title').textContent = 'Your cup: locking it on Midnight…';
    }
    return;
  }
  const dealt = (me.dice?.length ?? 0) > 0;
  const key = JSON.stringify([view.round, me.dice, view.phase === 'lobby']);
  if (key === myDiceKey) return;
  if (!dealt) {
    myDiceKey = key;
    if (view.phase === 'lobby') shownRound = 0;
    $('cup-title').textContent = 'Your cup';
    diceBox.className = 'my-dice sealed';
    diceBox.replaceChildren(...[1, 2, 3, 4, 5].map((f) => dieEl(f, { wild: false, label: false })));
    cup.className = `cup-sprite shut ${cupClass()}`;
    $('counts').textContent = view.phase === 'lobby' ? (view.cage?.housePending && view.seats.length ? 'The cups are shaken once the house float is on chain.' : 'The cups are shaken when the table starts.') : 'You sit this round out.';
    return;
  }
  myDiceKey = key;
  const fresh = shownRound !== view.round && !shaking;
  diceBox.replaceChildren(...me.dice.map((d) => dieEl(d)));
  if (fresh && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && shownRound !== null) {
    shakeAndSlam();
  } else {
    shownRound = view.round;
    diceBox.className = 'my-dice shown';
    cup.className = `cup-sprite lifted ${cupClass()}`;
  }
  const wilds = me.dice.filter((d) => d === 1).length;
  $('cup-title').textContent = 'Your cup';
  $('counts').replaceChildren(
    h('span', { text: 'You hold, with wilds: ' }),
    ...[2, 3, 4, 5, 6].map((face) => h('span', { class: 'count-chip' }, dieEl(face, { small: true, label: false }), h('b', { text: String(me.counts[face]) }))),
    wilds ? h('span', { class: 'quiet-note', text: ` · ${wilds} wild${wilds === 1 ? '' : 's'}` }) : '', // none: nothing after the counts (replaceChildren would print a null as the word)
  );
}

/** The cup comes down over the dice, rattles, slams, and lifts. Then the dice are yours to see. */
function shakeAndSlam({ stayDown = false } = {}) {
  const cup = $('cup-sprite');
  const felt = $('cup-felt');
  const diceBox = $('my-dice');
  shaking = true;
  diceBox.className = 'my-dice';
  cup.className = `cup-sprite shake ${cupClass()}`;
  $('cup-title').textContent = 'Shaking…';
  const others = [...document.querySelectorAll('.table-cup:not(.mine)')]; // every cup at the table is shaken, closed
  others.forEach((el) => el.classList.add('rattle'));
  setTimeout(() => others.forEach((el) => el.classList.remove('rattle')), 900);
  setTimeout(() => {
    cup.className = `cup-sprite slam ${cupClass()}`;
    felt.classList.add('rattle');
    setTimeout(() => felt.classList.remove('rattle'), 300);
    $('cup-title').textContent = 'Slam.';
  }, 900);
  setTimeout(() => {
    shownRound = view.round;
    shaking = false;
    if (stayDown || me?.diceHeld) { // the lock first: the cup stays where it slammed
      cup.className = `cup-sprite shut ${cupClass()}`;
      $('cup-title').textContent = 'Your cup: locking it on Midnight…';
      return;
    }
    cup.className = `cup-sprite lifted ${cupClass()}`;
    diceBox.className = 'my-dice shown';
    $('cup-title').textContent = 'Your cup';
  }, 1500);
}

// ---------- status ----------

function phaseText() {
  const { phase } = view;
  const round = view.receipt ? view.receipt.number.split('-')[1] : view.round; // at a tNIGHT table, the number on its receipt
  if (phase === 'lobby') return view.cage && (view.seats.length > 0 || view.cage.waiting.length > 0) && (view.cage.housePending || view.cage.waiting.length) ? 'Seating the table' : 'Waiting for players';
  if (phase === 'seal') return `Round ${round} · Sealing the cups`;
  if (phase === 'bid') return `Round ${round} · Bidding`;
  if (phase === 'duel') return `Round ${round} · Liar!`;
  if (phase === 'settled') return `Round ${round} over`;
  return 'Table closed';
}

function renderStatusPanel() {
  const bids = roundBids();
  const ladder = $('bid-ladder');
  const key = JSON.stringify([view.round, bids.map((b) => b.n)]);
  if (ladder.dataset.key !== key) {
    ladder.dataset.key = key;
    ladder.replaceChildren(...(bids.length ? bids.map((b, i) => h('li', { class: i === bids.length - 1 ? 'top' : '' }, faceEl(view.seats[b.seat] ?? {}, 18), h('span', { class: 'who' }, b.seat === me?.seat ? 'You' : nameOf(b.seat), agentMark(view.seats[b.seat])), h('b', { text: bigBid(b) }), dieEl(b.face, { small: true, label: false })))
      : [h('li', { class: 'empty', text: IN_ROUND.includes(view.phase) ? 'No bids yet this round.' : 'The bids show here once the cups are shaken.' })]));
    ladder.scrollTop = ladder.scrollHeight;
  }
  const stack = me && !watching && view.seats[me.seat] ? view.seats[me.seat].chips : null;
  $('sp-stack').textContent = stack === null ? 'Watching' : String(stack);
  $('sp-dice').textContent = view.totalDice ? `${view.totalDice} under the cups` : '—';
  $('scope-note').textContent = bidScope(view.totalDice);
  const yours = IN_ROUND.includes(view.phase) && me && view.waitingOn.includes(me.seat);
  $('status-panel').classList.toggle('your-turn', !!yours);
  const top = view.phase === 'duel' ? view.duel.bid : view.bid;
  $('sp-line').textContent = [top ? `Beat ${bigBid(top)}` : null, `Pot ${view.pot}`, stack === null ? null : `You ${stack}`, view.totalDice ? `${view.totalDice} dice` : null, '1s wild', IN_ROUND.includes(view.phase) && view.waitingOn.length ? (yours ? 'Your turn' : `${nameOf(view.waitingOn[0])}’s turn`) : null].filter(Boolean).join(' · ');
}

/** "You hold three 4s, with wilds": for the bid on the table, right under your dice. */
function renderHoldLine() {
  const el = $('hold-now');
  const top = view.phase === 'duel' ? view.duel?.bid : view.bid;
  const n = top && me?.counts ? me.counts[top.face] : null;
  el.hidden = n === null || n === undefined || watching;
  if (!el.hidden) el.textContent = `You hold ${n === 0 ? 'no' : BID_WORDS[n] ?? n} ${top.face}${n === 1 ? '' : 's'}, with wilds.`;
}

// ---------- the move row: Bid and Call liar, right under the picker ----------

const DICE_MOVES = [
  { id: 'bid', label: 'Bid', sel: '#bid-confirm' },
  { id: 'liar', label: 'Call liar', sel: '#liar' },
  { id: 'fold', label: 'Fold', sel: '[data-action="fold"]', what: 'sitout' },
];
let rowKey = '';
let rowFound = {}; // the move buttons of the panel last built, by move

function diceReason(move) {
  if (!IN_ROUND.includes(view.phase)) return view.phase === 'lobby' ? 'The cups aren’t shaken yet' : 'Between rounds';
  if (me?.away) return 'You’re marked away';
  if (view.phase === 'duel') return 'The call is being counted';
  if (view.anchor?.held) return 'Locking on Midnight';
  if (me && view.waitingOn[0] !== me.seat) return `${nameOf(view.waitingOn[0])}’s turn`;
  if (move === 'liar' && !view.bid) return 'No bid to call yet';
  if (move === 'bid') return 'You owe more than you can cover';
  return 'Not now';
}

function renderMoveRow() {
  const row = $('move-row');
  // Only while a round is on (or about to be): once it's over, the after-round card's Play again and Leave are the moves.
  const on = !watching && !!me && !view.seats[me.seat]?.left && (IN_ROUND.includes(view.phase) || view.phase === 'lobby');
  row.hidden = !on;
  if (!on) { // nothing left behind: a button from a finished round can't be pressed
    if (row.children.length) row.replaceChildren();
    rowKey = '';
    return;
  }
  const slots = DICE_MOVES.map(({ id, label, what = id }) => {
    const el = rowFound[id]?.isConnected ? rowFound[id] : null; // only from the panel just built: a button from an earlier one is stale
    if (el) {
      el.classList.add('move', id);
      return el;
    }
    const reason = diceReason(id);
    return h('button', {
      type: 'button', class: `btn move ghost ${id}`, dataset: { move: id }, 'aria-disabled': 'true', title: reason, 'aria-describedby': 'move-reason',
      onClick: () => { const line = $('move-reason'); line.hidden = false; line.textContent = whyNot(what, reason); clearTimeout(line.timer); line.timer = setTimeout(() => { line.hidden = true; }, 6000); },
    }, label, h('small', { text: reason }));
  });
  if (rowHolds(row, slots)) return;
  const key = slots.map((el) => (el.classList.contains('ghost') ? `${el.dataset.move}:${el.title}` : el.id || el.dataset.action)).join('|');
  if (key === rowKey && slots.every((el) => el.classList.contains('ghost'))) return;
  rowKey = key;
  placeMoves(row, slots.map((el, i) => ({ id: DICE_MOVES[i].id, el, what: DICE_MOVES[i].what }))); // each move in its cell, with what it does under it
}

function renderStatus() {
  paintPhase($('phase'), phaseText(), roundRecord(view, 'cup-and-claim')); // "Table 3 · Round 41", the round's public number
  paintReceiptButton($('round-receipt-open'), { record: roundRecord(view, 'cup-and-claim'), finished: diceRoundOver() }); // "This round's receipt", once the round has ended (11-07)
  $('pot').textContent = view.pot;
  const limit = $('pot-limit');
  const reached = view.raiseRoom?.potLimitReached || (IN_ROUND.includes(view.phase) && view.pot >= view.limits.potLimit);
  limit.textContent = reached ? 'Pot limit reached' : `limit ${view.limits.potLimit}`;
  limit.classList.toggle('reached', !!reached);
}

async function renderPurse() {
  const token = store.get(PLAYER_KEY);
  const asked = `${seatToken ? 1 : 0}:${view.phase}:${view.round}:${Math.floor(Date.now() / PURSE_REFRESH_MS)}`;
  if (token && asked !== purseAsked) {
    purseAsked = asked;
    try {
      purseChips = (await api('GET', '/players/me', { token })).purse.amount;
    } catch {
      purseAsked = '';
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
  if (seat && !seat.left && !view.cage && view.phase !== 'over') parts.push(sessionText(sessionOpen('cup-and-claim', tableId, seat.chips), seat.chips)); // what the night is costing or paying, since sitting down
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

// ---------- add chips ----------

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
    sessionAdded('cup-and-claim', tableId, res.added);
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
    type: 'button', class: 'btn small', text: label, dataset: { add: n }, onClick: () => { $('add-chips-amount').value = n; paintAddConfirm(); },
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
    sessionAdded('cup-and-claim', tableId, addAmount());
    me = res.me;
    purseChips = res.purse.amount;
    $('add-chips-form').hidden = true;
    accept(res.state);
    render();
  } catch (err) {
    $('error').textContent = err.message;
    purseAsked = '';
  } finally {
    busy = false;
  }
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
    const bot = (view.clocks ?? []).find((k) => k.until && view.seats[k.seat]?.bot);
    $('clock').textContent = bot ? `${nameOf(bot.seat)} ${Math.max(0, Math.ceil((bot.until - now) / 1000))}s` : '';
    $('clock').classList.remove('urgent');
  }
  for (const clock of view.clocks ?? []) {
    const card = $('cups').querySelector(`[data-cup="${clock.seat}"]`);
    if (!card || !clock.until) continue;
    const span = Math.max(1, clock.until - (clock.from ?? clock.until - view.limits.turnMs));
    const share = Math.max(0, Math.min(1, (clock.until - now) / span));
    card.style.setProperty('--p', Math.ceil(share * RING_STEPS) / RING_STEPS);
  }
}

// ---------- the log ----------

const lineParts = (entry) => (entry.say
  ? [view.seats[entry.seat] ? faceEl(view.seats[entry.seat], 20) : null, h('b', {}, entry.name, agentMark(view.seats[entry.seat]), ': '), entry.text]
  : [entry.text, ...anchorLinkFor(entry)]);

function renderLog() {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  for (const entry of view.log) {
    const known = logEls.get(entry.n);
    if (known) {
      if (known.text !== entry.text) {
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

// ---------- the move ----------

/** How a call's pot was split: the loser of the call pays; everyone else still in gets their stake back and an equal share (the caller counts double when right). */
function splitText(r) {
  if (r.awards.length === 1 && !r.loser && r.loser !== 0) return `${SeatWord(r.awards[0].seat)} took the pot of ${r.pot}.`;
  if (r.awards.length === 1) return `${SeatWord(r.awards[0].seat)} took the pot of ${r.pot}: ${nameOf(r.loser)} lost ${r.loserStake}${r.pool > r.loserStake ? `, and the folders' chips made it ${r.pool}` : ''}.`;
  const paid = r.awards.map((a) => `${SeatWord(a.seat)} ${a.amount} (${a.back} back + ${a.share}${a.bonus ? ', double share for the right call' : ''})`).join(', ');
  return `${nameOf(r.loser)} lost ${r.loserStake}${r.pool > r.loserStake ? `, and the folders' chips made it ${r.pool}` : ''}. The pot of ${r.pot} is paid out: ${paid}.`;
}

/** Your round, as a card: result, place at the table, the top three, Play again and Invite. Only for a seat that was dealt in. */
let afterRoundShown = false;
let sawRound = false; // a round played out on this page, so a result that turns up later is news and not an old one
let flashedRound = 0;
let ended = false; // you left: the card keeps the result and drops its moves
function renderAfterRoundCard() {
  const r = view.lastResult;
  const stake = (me && r?.stakes?.[me.seat]) ?? 0;
  const award = (me && r?.awards?.find((a) => a.seat === me.seat)?.amount) ?? 0;
  if (IN_ROUND.includes(view.phase)) sawRound = true;
  const seat = me && view.seats[me.seat];
  afterRoundShown = !watching && !!me && !!r && r.round === view.round && ['settled', 'over'].includes(view.phase) && r.kind !== 'returned' && Array.isArray(r.stakes) && (stake > 0 || award > 0);
  renderAfterRound($('after-round'), {
    show: afterRoundShown,
    round: r ? (view.cage?.chainBase ?? 0) + r.round : r?.round, // the table's own number for the round, as the status line has it (review shots, 11-07: a card saying Round 1 under Round 20)
    net: award - stake,
    seats: view.seats,
    mySeat: me?.seat,
    link: `${window.location.origin}/?play=cup-and-claim`, // a seat for a friend: the doorman takes their name and finds a waiting table, or opens one
    canNext: !!me?.legal.some((a) => a.action === 'next'),
    onNext: () => send({ action: 'next' }),
    againLabel: view.dealByPlayer && view.cage ? 'Shake' : undefined, // chips tables say Next round
    playerToken: view.cage ? null : store.get(PLAYER_KEY), // the leaderboard is play chips only
    firstWin: afterRoundShown && !view.cage && firstWin({ where: `cup-and-claim:${tableId}`, round: r?.round, net: award - stake }), // once per browser: where the chips live
    againHref: '/?play=cup-and-claim',
    onReceipt: diceRoundOver() && roundRecord(view, 'cup-and-claim') ? () => openReceiptWindow({ href: roundRecord(view, 'cup-and-claim').href, label: roundRecord(view, 'cup-and-claim').label }) : null,
    // chips tables: your number in plain words, the session total, the way on when you're out of chips (tNIGHT tables are as they were)
    stack: view.cage || !seat ? null : seat.chips,
    session: view.cage || !seat || seat.left ? '' : sessionText(sessionOpen('cup-and-claim', tableId, seat.chips), seat.chips),
    broke: !view.cage && !!me?.broke,
    onFillUp: !view.cage && me?.canFillUp ? fillUp : null,
    onLeave: !view.cage && me?.canLeave ? leaveTable : null,
    closed: view.phase === 'over' || ended,
  });
  if (afterRoundShown && !view.cage && r && flashedRound !== r.round) {
    if (sawRound) flashNet(document.querySelector('.cup-card.mine'), award - stake);
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
  const summary = summaryText(sessionOpen('cup-and-claim', tableId, stack), stack);
  const key = `${summary}|${view.overReason}`;
  if (old?.dataset.key === key) return;
  const panel = tableEnd({ kind: 'closed', summary, reason: view.overReason ?? '', stack, onNew: () => newTable(stack), hallHref: leaveTo });
  panel.dataset.key = key;
  placeEnd(panel);
}

const newTable = (stack) => sitAtNewTable({ game: 'cup-and-claim', apiBase: GAME.api, page: GAME.page, fromId: tableId, stack, token: store.get(PLAYER_KEY) });

function resultText() {
  const r = view.lastResult;
  if (!r) return '';
  if (r.kind === 'returned') return `The pot of ${r.pot} went back: ${r.awards.map((a) => `${nameOf(a.seat)} ${a.amount}`).join(', ')}.`;
  if (r.kind === 'uncontested') return `Everyone else folded: ${SeatWord(r.awards[0].seat)} took the pot of ${r.pot}.`;
  if (r.kind === 'duel') return `${labelBid(r.bid)} ${r.held ? 'held' : 'fell'}: the table showed ${r.total}. ${splitText(r)}`;
  return '';
}

/** A tNIGHT table before its first deal: the float and the seats come from the chain, and the judge reads them. */
function cageLobbyLine() {
  const c = view.cage;
  const someone = view.seats.length > 0 || c.waiting.length > 0;
  if (!someone) return 'Waiting for someone to bring tNIGHT to this table.';
  if (c.housePending) return 'Seating the table.';
  if (c.waiting.length) return 'Reading the seats from the cage.';
  return 'Shaking the cups.';
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
  const button = h('button', { class: 'btn primary small deal-start', id: 'deal-now', type: 'button' }, view.dealByPlayer ? 'Shake' : 'Deal me in now, with bots');
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
    ? 'The judge is putting the house float on chain: two transactions, about 2 minutes. Then the cups are shaken.'
    : `The judge is reading ${c.waiting.join(', ')}’s seat from the cage. Under a minute, then the cups are shaken.`;
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
    if (view.deadline) return `${resultText()} The next round deals itself when the clock runs out.`;
    if (me?.broke && !view.cage) return `${resultText()} You’re out of chips: fill up to keep playing, or leave.`;
    return `${resultText()} ${view.seats.some((x) => x.away) && view.seats.filter((x) => !x.bot && !x.left).length > 1 ? 'Waiting for someone to come back.' : 'Shake the cups when you’re ready.'}`;
  }
  if (phase === 'over') {
    const stack = me && !view.seats[me.seat]?.left ? view.seats[me.seat]?.chips : null;
    return `Table closed: ${plainClose(view.overReason ?? '')}${view.lastResult?.kind === 'returned' ? ` ${resultText()}` : ''}${stack ? ` Your ${stack} chips are back in your purse.` : ''}`;
  }
  if (me?.away) return 'You’re marked away, so moves are made for you: your cup stays shut and you fold to any bid. You sit out from the next round until you’re back.';
  if (phase === 'duel') {
    const names = waitingOn.map(seatWord);
    return names.length ? `Waiting on ${names.join(', ')} to answer for their cup${names.length > 1 ? 's' : ''}.` : 'Counting the table…';
  }
  if (waitingOn[0] === undefined) return '';
  if (me?.seat === waitingOn[0]) return view.bid ? 'Your turn: bid higher, call Liar, or fold.' : 'Your turn: you open the bidding.';
  return `${nameOf(waitingOn[0])} to act.`;
}

function renderToBeat() {
  const el = $('to-beat');
  el.hidden = view.phase !== 'bid';
  if (el.hidden) return;
  if (!view.bid) {
    el.replaceChildren(h('b', { text: me && view.waitingOn[0] === me.seat ? 'No bid yet — you open.' : 'No bid yet.' }));
    return;
  }
  el.replaceChildren(h('b', { text: 'To beat: ' }), `${seatWord(view.bid.seat)} bid ${view.bid.label} `, dieEl(view.bid.face, { label: false }), h('span', { class: 'quiet-note', text: ` (${view.totalDice} dice out)` }),
    me && view.waitingOn[0] === me.seat ? h('span', { class: 'bid-hint', id: 'bid-hint', text: 'Bid more dice, or the same number of a higher die, or call Liar.' }) : '');
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
    rowFound = {};
    actionsKey = '';
    box.hidden = false;
    return;
  }
  const legal = me.legal.filter((a) => !(afterRoundShown && a.action === 'next')); // the card has Play again
  const key = JSON.stringify([legal, view.bid, view.duel?.waiting, me.mode, view.round, afterRoundShown, view.proof ? [proofSeat.busy(), me.counts] : 0]);
  if (key === actionsKey) return;
  actionsKey = key;
  $('action-title').textContent = legal.length ? 'Your move' : view.phase === 'duel' ? 'The call' : 'At the table';
  let panel;
  if (view.phase === 'duel') panel = duelPanel(legal);
  else if (legal.some((a) => a.action === 'bid' || a.action === 'liar')) panel = bidPanel(legal);
  else panel = legal.flatMap(actionControls);
  $('actions').replaceChildren(...panel.filter(Boolean));
  rowFound = Object.fromEntries(DICE_MOVES.map(({ id, sel }) => [id, $('actions').querySelector(sel)]).filter(([, el]) => el?.tagName === 'BUTTON'));
  renderMoveRow();
}

/** Picked bid as the server will read it, or null. */
function pickedBid(a) {
  if (pick.count === null || pick.face === null) return null;
  const above = a.above;
  if (above && (pick.count < above.count || (pick.count === above.count && pick.face <= above.face))) return null;
  if (pick.count > a.maxCount) return null;
  return { count: pick.count, face: pick.face };
}

/** Count stepper, the five faces, the raise beside it, the Bid button. Every bound comes from the server. */
function bidPicker(a) {
  const key = `${view.round}:${a.above ? `${a.above.count}.${a.above.face}` : ''}`;
  if (pick.key !== key) pick = { count: a.lowest.count, face: a.lowest.face, key };
  const minCount = a.above ? (a.above.face === 6 ? a.above.count + 1 : a.above.count) : 1;
  const body = h('div', { class: 'bid-picker', id: 'bid-picker' });
  const raiseBox = h('div', { class: `raise-beside ${a.raise.max < 1 ? 'off' : ''}`, id: 'raise-beside' });
  const confirm = h('button', { type: 'button', class: 'btn primary big', id: 'bid-confirm', dataset: { action: 'bid' } });
  const owed = a.owed ? h('p', { class: 'owed-line', id: 'owed-line', text: `You owe ${a.owed} to stay in. The Bid button pays it.` }) : null;

  const paintConfirm = () => {
    const bid = pickedBid(a);
    confirm.disabled = !bid;
    const extras = [];
    if (a.owed) extras.push(`${a.owed} to stay in`); // was "match 5": a poker word that read like Call (11-08)
    if (raiseAmount > 0) extras.push(`raise ${raiseAmount}`);
    confirm.textContent = bid ? `Bid: ${labelBid(bid)}${extras.length ? ` + ${extras.join(' + ')}` : ''}` : 'Pick a bigger bid';
  };

  const draw = () => {
    const faceAllowed = (face) => pick.count > minCount || !a.above || pick.count > a.above.count || face > a.above.face;
    body.replaceChildren(
      h('p', { class: 'picker-label', text: `How many? (${a.maxCount} dice on the table)` }),
      h('div', { class: 'count-row', role: 'group', 'aria-label': 'How many' },
        h('button', { type: 'button', class: 'btn', id: 'count-down', 'aria-label': 'Fewer', disabled: pick.count <= minCount, text: '−', onClick: () => { pick.count = Math.max(minCount, pick.count - 1); if (!faceAllowed(pick.face)) pick.face = null; draw(); } }),
        h('span', { class: 'count-value', id: 'count-value', text: String(pick.count) }),
        h('button', { type: 'button', class: 'btn', id: 'count-up', 'aria-label': 'More', disabled: pick.count >= a.maxCount, text: '+', onClick: () => { pick.count = Math.min(a.maxCount, pick.count + 1); draw(); } })),
      h('p', { class: 'picker-label', text: 'showing…' }),
      h('div', { class: 'face-row', role: 'group', 'aria-label': 'Number on the dice' }, a.faces.map((face) => h('button', {
        type: 'button', class: 'face-btn', dataset: { face }, 'aria-pressed': String(pick.face === face), disabled: !faceAllowed(face),
        'aria-label': `${FACE_WORDS[face]}`,
        onClick: () => { pick.face = face; draw(); },
      }, dieEl(face, { label: false })))),
      h('p', { class: 'hold-line', id: 'hold-line', text: pick.face ? `You hold ${me.counts?.[pick.face] ?? 0} of these (1s count as wild).` : 'Tap a die. 1s count as wild.' }),
    );
    paintConfirm();
  };

  const drawRaise = () => {
    const { max, potLimitReached } = a.raise;
    raiseAmount = Math.max(0, Math.min(max, raiseAmount));
    if (max < 1) {
      raiseBox.replaceChildren(h('p', { class: 'raise-title' }, 'Raise beside it: ', potLimitReached ? h('span', { class: 'limit-tag', id: 'limit-tag', text: 'Pot limit reached' }) : h('span', { text: 'no chips to raise with' })));
      paintConfirm();
      return;
    }
    const input = h('input', { id: 'raise-amount', type: 'number', inputmode: 'numeric', min: 0, max, value: raiseAmount, 'aria-label': `Raise, 0 to ${max}`, onInput: (e) => { raiseAmount = Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0))); paintConfirm(); } });
    const presets = [[0, 'None'], [5, '5'], [10, '10'], [25, '25'], [max, `Max ${max}`]].filter(([n], i, all) => n <= max && all.findIndex(([m]) => m === n) === i).map(([n, label]) => h('button', {
      type: 'button', class: 'btn small', text: label, dataset: { raiseAmount: n }, onClick: () => { raiseAmount = n; input.value = n; paintConfirm(); },
    }));
    raiseBox.replaceChildren(
      h('p', { class: 'raise-title' }, 'Raise beside it: ', h('b', { text: `up to ${max}` }), a.raise.limitedBy === 'pot' ? h('span', { class: 'quiet-note', text: ' (the pot limit)' }) : null),
      h('div', { class: 'raise-row' }, input, h('div', { class: 'raise-amounts' }, presets)),
    );
    paintConfirm();
  };

  confirm.addEventListener('click', () => {
    const bid = pickedBid(a);
    if (bid) send({ action: 'bid', ...bid, ...(raiseAmount > 0 ? { raise: raiseAmount } : {}) });
  });
  draw();
  drawRaise();
  return [owed, body, raiseBox, confirm];
}

function bidPanel(legal) {
  const bid = legal.find((a) => a.action === 'bid');
  const liar = legal.find((a) => a.action === 'liar');
  const fold = legal.find((a) => a.action === 'fold');
  const nodes = [];
  if (liar) {
    nodes.push(h('button', { type: 'button', class: 'btn liar', id: 'liar', dataset: { action: 'liar' }, onClick: () => send({ action: 'liar' }) },
      'LIAR!', h('small', { text: `Call ${possessive(liar.seat)} bid: ${liar.bid.label}${liar.cost ? ` · costs ${liar.cost}` : ''}` })));
  }
  if (bid) nodes.push(h('h3', { class: 'chips-title', text: view.bid ? 'Or bid higher' : 'Open the bidding' }), h('p', { class: 'bid-scope', id: 'bid-scope', text: bidScope(view.totalDice) }), ...bidPicker(bid));
  else nodes.push(h('p', { class: 'owed-line', text: `You owe ${me.owed} to stay in, and can’t cover it to bid. Call Liar, or fold.` }));
  if (fold) nodes.push(h('button', { type: 'button', class: 'btn', dataset: { action: 'fold' }, text: me.owed ? `Fold: don’t pay the ${me.owed}` : 'Fold: sit this round out', onClick: () => send({ action: 'fold' }) }));
  return nodes;
}

/** The star moment. The cup is yours: the dice, or just the count. */
function duelPanel(legal) {
  const { duel } = view;
  const reveal = legal.find((a) => a.action === 'reveal');
  const head = h('p', { class: 'duel-head', id: 'duel-head' },
    h('b', { text: SeatWord(duel.caller) }), ` call${duel.caller === me?.seat ? '' : 's'} Liar on `, h('b', { text: `${possessive(duel.bidder)} bid: ${duel.bid.label}` }), '. Every cup still in answers, then the whole table is counted.');
  if (!reveal) {
    const chosen = me.mode ? (me.mode === 'show' ? 'You lifted your cup: your dice go out for everyone to see.' : `Your cup stays shut. Only your count of ${FACE_WORDS[duel.bid.face]} goes out.`) : 'You folded, so your cup stays shut and the house counts it.';
    return [head, h('p', { class: 'chosen-line', id: 'chosen-line', text: chosen })];
  }
  const face = FACE_WORDS[duel.bid.face];
  const myCount = me.counts?.[duel.bid.face] ?? 0;
  if (view.proof) {
    if (reveal.folded) return [head, h('p', { class: 'chosen-line', id: 'chosen-line', text: `You folded, but your cup still counts. Your wallet proves its ${myCount} when the house's cups have answered.` })];
    const off = !reveal.ready || proofSeat.busy();
    const go = (mode) => proofSeat.answer({ view, me, mode, post: proofPost, rerender: render });
    const live = ['calling', 'answering'].includes(view.proof.stage); // the chain is checking this round: only then does the choice promise it
    return [
      head,
      h('p', { class: 'picker-label', text: reveal.ready ? `Your cup holds ${myCount} ${myCount === 1 ? FACE_ONE[duel.bid.face] : face}, wilds counted. What do you show?` : 'The house\'s cups answer first, so it can\'t wait to see yours.' }),
      h('div', { class: 'choices', role: 'group', 'aria-label': 'Keep it shut, or show' },
        h('button', { type: 'button', class: 'choice prove', id: 'choose-prove', disabled: off, dataset: { mode: 'prove' }, onClick: () => go('prove') },
          h('span', { class: 'choice-title', text: live ? 'Let the chain prove it' : 'Keep the cup shut' }),
          h('span', { class: 'choice-what', text: `Your cup stays shut. The table learns one number: ${myCount}. Not which dice.` }),
          h('span', { class: 'choice-note', text: live ? 'Your wallet proves the count from your sealed cup, and the chain checks the proof.' : 'The chain isn’t checking this round any more.' })),
        h('button', { type: 'button', class: 'choice show', id: 'choose-show', disabled: off, dataset: { mode: 'show' }, onClick: () => go('show') },
          h('span', { class: 'choice-title', text: live ? 'Show and prove' : 'Show the dice' }),
          h('span', { class: 'choice-what', text: 'Lift the cup. Everyone sees all five dice.' }),
          h('span', { class: 'choice-note', text: live ? 'The chain checks them against your seal. Earns a public open-hand mark.' : 'Earns a public open-hand mark.' }))),
    ];
  }
  return [
    head,
    h('p', { class: 'picker-label', text: `Your cup holds ${myCount} ${myCount === 1 ? FACE_ONE[duel.bid.face] : face}, wilds counted. What do you show?` }),
    h('div', { class: 'choices', role: 'group', 'aria-label': 'Keep it shut, or show' },
      h('button', { type: 'button', class: 'choice prove', id: 'choose-prove', dataset: { mode: 'prove' }, onClick: () => send({ action: 'reveal', mode: 'prove' }) },
        h('span', { class: 'choice-title', text: 'Keep the cup shut' }),
        h('span', { class: 'choice-what', text: `Your cup stays shut. The table learns one number: ${myCount}. Not which dice.` }),
        h('span', { class: 'choice-note', text: `The house vouches for that number; no one else can recheck it.${view.cage ? ' Only the money settles on chain.' : ''}` })),
      h('button', { type: 'button', class: 'choice show', id: 'choose-show', dataset: { mode: 'show' }, onClick: () => send({ action: 'reveal', mode: 'show' }) },
        h('span', { class: 'choice-title', text: 'Show and prove' }),
        h('span', { class: 'choice-what', text: 'Lift the cup. Everyone sees all five dice.' }),
        h('span', { class: 'choice-note', text: 'Anyone can recheck shown dice against the seal. Earns a public open-hand mark.' }))),
  ];
}

function actionControls(a) {
  switch (a.action) {
    case 'back':
      return [h('button', { type: 'button', class: 'btn primary', dataset: { action: 'back' }, text: 'I’m back', onClick: () => send({ action: 'back' }) })];
    case 'next':
      return [h('button', { type: 'button', class: 'btn primary big', dataset: { action: 'next' }, text: view.dealByPlayer ? 'Shake' : 'Shake the cups: next round', onClick: () => send({ action: 'next' }) })];
    default:
      return [];
  }
}

async function send(body) {
  if (busy) return;
  busy = true;
  $('error').textContent = '';
  const pressed = pressedButton();
  const word = body.action === 'reveal' ? (body.mode === 'show' ? 'Lifting the cup' : 'Keeping it shut') : WAIT_WORDS[body.action] ?? 'Sending';
  const releases = [pressing(pressed, word), locking($('actions'), pressed)];
  try {
    let res;
    try {
      res = await api('POST', `${path}/act`, { body, token: seatToken });
    } finally {
      for (const release of releases) release(); // before the redraw, which decides for itself what is on or off
    }
    if (body.action === 'bid') raiseAmount = 0;
    me = res.me;
    accept(res.state);
    render();
    wakeSoon();
  } catch (err) {
    if (body.action === 'next' && err.code === 'wrong_phase') await poll();
    else $('error').textContent = err.message;
  } finally {
    busy = false;
  }
}

// ---------- the call, counted ----------

function renderCall() {
  const box = $('call-box');
  const last = view.lastDuel;
  const showLast = view.phase === 'settled' && last?.round === view.round;
  const duel = view.duel;
  box.hidden = !duel && !showLast;
  if (box.hidden) return;
  const key = JSON.stringify([duel, showLast && last.round, me?.seat]);
  if (key === callKey) return;
  callKey = key;
  if (duel) {
    $('call-title').textContent = 'The call';
    $('call').replaceChildren(
      h('p', { class: 'prose' }, h('b', { text: nameOf(duel.caller) }), ' calls Liar on ', h('b', { text: `${nameOf(duel.bidder)}’s ${duel.bid.label}` }), '. Each cup answers in its own way:'),
      h('div', { class: 'call-rows' }, view.seats.filter((x) => x.cup).map((x) => {
        const mode = duel.modes[x.seat];
        const text = duel.waiting.includes(x.seat) ? 'choosing…' : mode === 'show' ? 'lifts the cup' : mode === 'prove' ? 'cup shut' : 'folded: cup shut, still counted';
        return h('div', { class: 'call-row' }, faceEl(x, 20), h('span', { class: 'call-name', text: x.name }), h('span', { class: `mode-tag ${mode ?? ''}`, text }));
      })),
    );
    return;
  }
  $('call-title').textContent = 'The call, counted';
  const face = FACE_WORDS[last.bid.face];
  $('call').replaceChildren(
    h('div', { class: 'call-rows' }, last.reveals.map((r) => {
      const seat = view.seats[r.seat];
      if (r.mode === 'silent') return h('div', { class: 'call-row' }, faceEl(seat, 20), h('span', {}, h('span', { class: 'call-name', text: seat.name }), h('br'), h('span', { class: 'call-how', text: 'never answered: the window closed' })), h('span', { class: 'count-badge', text: '–' }));
      return h('div', { class: `call-row ${r.mode === 'show' ? 'shown' : ''}` },
        faceEl(seat, 20),
        h('span', {}, h('span', { class: 'call-name', text: seat.name }), h('br'), h('span', { class: 'call-how', text: r.mode === 'show' ? 'showed the dice' : r.proof?.kind === 'compact-proof' ? (r.folded ? 'folded, cup shut, the chain checked it' : 'cup shut, the chain checked it') : r.folded ? 'folded, cup shut, house-counted' : 'cup shut, house-counted' })),
        r.mode === 'show'
          ? h('span', { class: 'call-dice' }, r.dice.map((d) => dieEl(d, { small: true })))
          : h('span', { class: 'count-badge' }, String(r.count), h('small', { text: face })));
    })),
    h('p', { class: 'call-total' }, `Table: ${last.total} ${last.total === 1 ? FACE_ONE[last.bid.face] : face}. The bid (${labelBid(last.bid)}) `, h('span', { class: last.held ? 'holds' : 'falls', text: last.held ? 'HOLDS' : 'FALLS' }), ` ${view.lastResult?.round === last.round ? splitText(view.lastResult) : `${nameOf(last.winner)} takes ${last.pot}.`}`),
    view.proof && last.reveals.every((r) => r.proof?.kind === 'compact-proof' || r.mode === 'silent')
      ? h('p', { class: 'call-fair', text: 'Every cup was sealed on chain before the house opened its seed. The chain checked each answer against its seal, added them up, and said whether the bid holds.' })
      : view.proof
        ? h('p', { class: 'call-fair', text: 'Every cup was sealed on chain before the house opened its seed. Not every answer reached the chain: a count without a proof transaction is the house’s word.' })
      : h('p', { class: 'call-fair' }, 'Every cup was sealed at the deal. House secret opened: ', h('code', { text: `${last.houseSeed.slice(0, 16)}…` }), '. A shown cup can be rechecked by anyone. A shut cup’s count is the house’s word: no circuit checks it yet.'),
  );
}

// ---------- the reveal: under the room, after a call ----------

const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Four 5s needed, five showing: bid holds": what decided the call, in one plain line. */
function decidedLine(duel) {
  const { bid, total, held } = duel;
  const need = `${cap(BID_WORDS[bid.count] || String(bid.count))} ${bid.face}${bid.count === 1 ? '' : 's'} needed`;
  const have = total === 0 ? 'none showing' : `${BID_WORDS[total] || total} showing`;
  return `${need}, ${have}: bid ${held ? 'holds' : 'falls'}`;
}

/** Every cup that answered the call: a shown cup's dice big enough to count on a phone (the ones that count lit, the rest dim), a shut cup's count. */
function renderReveal() {
  const box = $('reveal');
  const last = view.phase === 'settled' && view.lastDuel?.round === view.round ? view.lastDuel : null;
  box.hidden = !last;
  if (!last) { delete box.dataset.key; return; }
  const key = JSON.stringify([last.round, me?.seat, last.reveals]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const face = last.bid.face;
  box.replaceChildren(
    h('p', { class: `reveal-line ${last.held ? 'holds' : 'falls'}`, id: 'reveal-line', text: decidedLine(last) }),
    h('ul', { class: 'reveal-cups' }, last.reveals.map((r) => {
      const seat = view.seats[r.seat] ?? {};
      return h('li', { class: `reveal-cup ${r.mode === 'show' ? 'shown' : 'shut'}`, dataset: { revealSeat: r.seat } },
        h('span', { class: 'reveal-who' }, faceEl(seat, 22), h('span', { class: 'reveal-name', text: r.seat === me?.seat ? 'You' : seat.name ?? `Seat ${r.seat}` })),
        r.mode === 'show'
          ? h('span', { class: 'reveal-dice' }, r.dice.map((d) => { const el = dieEl(d); el.classList.add(d === face || d === 1 ? 'hit' : 'miss'); return el; }))
          : h('span', { class: 'reveal-count', text: `cup shut: ${r.count} ${r.count === 1 ? FACE_ONE[face] : FACE_WORDS[face]}, house-counted` }));
    })),
  );
}

// ---------- the round's receipt ----------

const CHAIN_TX = (hash) => `https://preprod.midnightexplorer.com/transactions/${hash}`;

/** Table 114 · Round 47, with its fingerprint from the deal, and what the chain has said so far. Only a tNIGHT table has one. */
/** The round has ended: its record is complete, with the seal opened. */
const diceRoundOver = () => !!view && (view.phase === 'settled' || view.phase === 'over') && view.lastResult?.round === view.round;

function renderRoundReceipt() {
  const box = $('round-receipt');
  const receipt = view.receipt;
  box.hidden = !receipt;
  if (!receipt) return;
  const [table, number] = receipt.number.split('-');
  const finished = view.phase === 'settled' || view.phase === 'over';
  const onChain = view.cage.receipts.find((x) => x.rounds.includes(view.round));
  let line;
  if (onChain) line = h('p', { class: 'result-chain', id: 'result-chain' }, 'Settled on chain · tx ', h('a', { href: CHAIN_TX(onChain.hash), target: '_blank', rel: 'noopener', text: `${onChain.hash.slice(0, 12)}…` }), ` · block ${onChain.block}`);
  else if (!finished) line = h('p', { class: 'result-chain', id: 'result-chain', text: 'Dice sealed before the deal. The seal opens when the round ends.' });
  else if (view.cage.status !== 'open') line = h('p', { class: 'result-chain', id: 'result-chain', text: 'This round didn’t reach the chain: the table closed first.' });
  else if (view.cage.unsettled.includes(view.round)) line = h('p', { class: 'result-chain', id: 'result-chain', text: 'Settling on chain…' });
  else line = h('p', { class: 'result-chain', id: 'result-chain', text: 'No chips moved, so there’s nothing to settle on chain.' });
  const key = JSON.stringify([receipt.number, finished, onChain?.hash, line.textContent]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  $('round-receipt-body').replaceChildren(
    h('p', { class: 'receipt-number', id: 'receipt-number', text: `Table ${table} · Round ${number}` }),
    finished && view.lastResult?.round === view.round ? h('p', { class: 'prose', id: 'round-result-line', text: resultText() }) : '',
    h('p', { class: 'prose receipt-print' }, 'Dice fingerprint ', h('code', { id: 'receipt-fingerprint', title: receipt.fingerprint, text: `${receipt.fingerprint.slice(0, 16)}…` })),
    line,
    finished ? h('button', { class: 'btn small', id: 'check-round', type: 'button', text: 'Check this round', onClick: () => openReceiptWindow({ href: receipt.url, label: `Table ${table} · Round ${number}` }) }) : '', // over the table, once the round has ended; the full page is a link inside
  );
}

// ---------- talk ----------

async function renderQuick() {
  if (watching || !me || !view) return;
  const key = `${view.round}:${view.phase}`;
  if (key === quickKey) return;
  quickKey = key;
  try {
    const { lines } = await api('GET', `${path}/quick`, { token: seatToken });
    $('quick').replaceChildren(...lines.map((text) => h('button', { type: 'button', class: 'btn small', text, onClick: () => sayLine(text) })));
  } catch {
    quickKey = '';
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

let leaveTo = '/'; // where Leave ends: the Hall, or the page a nav link was heading for
let leaveAndGo = false; // they chose "Leave and go" to a named place: that is where they are headed, so no end panel in between
let goneHome = false;
function goHome(amount) {
  if (goneHome) return; // a poll that lands while the next page is loading must not start it again
  goneHome = true;
  clearTimeout(pollTimer);
  store.remove(seatKey(tableId));
  if (view?.cage) { // the seat on chain is freed first, right here, so nobody walks away still seated
    freeSeatThenHome();
    return;
  }
  const back = Number.isInteger(amount) ? amount : view?.seats[me?.seat]?.chips ?? 0;
  if (Number.isInteger(amount)) store.set(LEFT_KEY, JSON.stringify({ id: tableId, page: '/dice', amount, told: false }));
  if (leaveAndGo) {
    window.location.replace(leaveTo); // not a new history entry: Back can't bring up the table they left, stale
    return;
  }
  // Nothing sends them anywhere: what the night came to first, then a fresh table with their stack or the Hall, their pick.
  ended = true;
  for (const id of ['leave', 'add-chips']) if ($(id)) $(id).hidden = true;
  if (view) renderAfterRoundCard();
  placeEnd(tableEnd({ kind: 'left', summary: summaryText(sessionOpen('cup-and-claim', tableId, back), back), stack: back, onNew: () => newTable(back), hallHref: leaveTo }));
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

const GAME = { api: '/dice-tables', page: '/dice', name: 'Cup & Claim' };
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
      : h('span', {}, 'Every seat is taken. ', h('a', { href: `/dice?id=${tableId}&watch=1`, text: 'Watch this table' }), ' or ', h('a', { href: '/', text: 'find another' }), '.'));
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
  else $('join-note').replaceChildren(h('span', {}, 'Every seat is taken. ', h('a', { href: `/dice?id=${tableId}&watch=1`, text: 'Watch this table' }), ' or ', h('a', { href: '/', text: 'find another' }), '.'));
}

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
    if (where.status === 'none' && purseChips < 1) {
      const note = await elsewhereNote(null);
      if (note) {
        seatedElsewhere = true;
        joinProblem = note;
        render();
        return;
      }
    }
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
  } catch { /* the form still works */ }
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
    if (!view?.cage && !res.rejoined) sessionOpen('cup-and-claim', tableId, buyIn || STACK_FULL); // what they sat down with: the ante may already be in by the first look
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
    $('join-topup').hidden = err.code !== 'not_enough_chips' || (purseChips ?? 0) >= 100;
  } finally {
    joining = false;
  }
}

/** Where their chips are, with the way back. With `message` null, returns null when there's no seat elsewhere. */
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

/** At a proof table: where the round is on chain, what this seat's wallet is doing, and any trouble with it. */
function renderProof() {
  let line = $('proof-line');
  if (!view.proof) { if (line) line.hidden = true; return; }
  if (!line) {
    line = h('p', { class: 'prose', id: 'proof-line' });
    $('actions').before(line);
  }
  const trouble = proofSeat.trouble();
  line.hidden = false;
  line.replaceChildren(
    proofSeat.line() || proofSeat.stageLine(view, me),
    ...(view.proof.alert ? [h('span', { class: 'error', text: ` The house: ${view.proof.alert}` })] : []),
    ...proofSeat.warnings().map((w) => h('span', { class: 'error proof-warning', text: ` ${w}` })),
    ...(trouble ? [h('span', { class: 'error', id: 'proof-trouble', text: ` ${trouble} ` }), h('button', { type: 'button', class: 'btn small', id: 'proof-retry', text: 'Try again', onClick: () => proofSeat.retry(render) })] : []),
  );
}

const proofPost = (route, body) => api('POST', `${path}${route}`, { body, token: seatToken });

// the lock panel (11-08): the cup has slammed; it waits for the block, then lifts
const anchorNote = mountAnchorNote({ noun: 'cup' });
const lockPanel = mountLockPanel({ noun: 'cup', clock: () => Date.now() + clockOffset, onDone: () => { myDiceKey = ''; render(); } });

function render() {
  if (!view) return;
  if (view.proof) {
    if (seatToken) startCage();
    me = proofSeat.withMyDice(view, me);
    proofSeat.step({ view, me, post: proofPost, rerender: render });
  }
  renderProof();
  renderStatus();
  renderPurse();
  renderScene();
  renderCups();
  renderCardEffects();
  renderLog();
  renderTalkLine();
  paintTrust(view);
  renderJoin();
  renderMyCup();
  renderHoldLine();
  renderAfterRoundCard();
  renderTableClosed();
  renderActions();
  renderMoveRow();
  renderStatusPanel();
  renderCall();
  renderReveal();
  renderRoundReceipt();
  renderLeave();
  renderQuick();
  $('say-form').hidden = watching || !me;
  renderClock();
  if (!shaking) lockPanel.update(view.anchor, view.round);
  anchorNote.update(view.anchor, view.round);
  paintRoundId({ record: roundRecord(view, 'cup-and-claim'), seal: view.roundSeal ?? view.anchor?.seal ?? null, what: 'fingerprint', onReceipt: (r) => openReceiptWindow({ href: r.href, label: r.label }) }); // the round's name in the top banner (11-08)
  { const el = modeLine(view, 'cup-and-claim'); const old = document.getElementById('anchor-mode'); if (!el) old?.remove(); else if (old?.textContent !== el.textContent) { old?.remove(); $('cup-box')?.append(el); } }
  // Tally's guide, once, the first time a seat is theirs (round 3): page-side only, the deal never waits for it
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
        if (err.status === 401) {
          if (me?.leaving || leavingNow) return goHome(view.seats[me?.seat]?.leftWith);
          const stored = store.get(seatKey(tableId));
          me = null;
          if (stored && stored !== seatToken) seatToken = stored;
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
  noun: 'cup',
  wake: () => pollNow(),
  situation: () => {
    if (!view) return {};
    if (!me || watching) return { seated: false };
    const myTurn = view.turn === me.seat || (view.waitingOn ?? []).includes(me.seat);
    return { seated: true, myTurn, turnName: view.turn !== null && view.turn !== undefined ? view.seats[view.turn]?.name ?? null : null, deadlineIn: view.deadline ? view.deadline - (Date.now() + clockOffset) : null, away: !!me.away };
  },
});

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

function wakeSoon() {
  if (pollTimer === null) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loop, nextPollDelay());
}

/** /dice with no table: say so, and offer the way to one. The link makes a table (or finds one waiting) and comes back here. */
function renderNoTable() {
  $('phase').textContent = 'No table yet';
  $('turn-line').textContent = '';
  for (const id of ['cup-box', 'action-box', 'call-box']) $(id).hidden = true;
  const box = $('join-box');
  box.hidden = false;
  $('join-title').textContent = 'No table yet';
  $('join-note').textContent = 'This page needs a table. Start one and the house bots fill the other seats the moment you sit down, or go back to the Hall and take the stairs.';
  $('join-form').hidden = true;
  $('join-topup').hidden = true;
  box.append(h('div', { class: 'no-table-row', id: 'no-table' },
    h('a', { class: 'btn primary big', id: 'start-table', href: '/dice/new', text: 'Start a table' }),
    h('a', { class: 'btn', id: 'back-to-hall', href: '/', text: '◂ Back to the Hall' })));
}

async function loadDiceArt() {
  try {
    const res = await fetch(`${DICE_ART}manifest.json`);
    if (res.ok) diceArt = await res.json();
  } catch { /* the drawn set */ }
}

async function start() {
  setupSound($('sound'));
  setupTalk();
  $('add-chips-open').addEventListener('click', openAddChips);
  $('fill-up').addEventListener('click', fillUp);
  $('add-chips-amount').addEventListener('input', paintAddConfirm);
  $('add-chips-form').addEventListener('submit', confirmAddChips);
  await Promise.all([loadArt(), loadDiceArt()]);
  fit();
  // the badges above the room grow once the table answers: the room's height follows, so the board under it stays in view
  if ('ResizeObserver' in window) new ResizeObserver(() => fit()).observe(document.querySelector('.zone-top'));
  window.addEventListener('resize', () => {
    fit();
    if (view) render();
  });
  setInterval(renderClock, 200);
  setInterval(() => lockPanel.tick(), 500);
  if (!tableId) {
    renderNoTable();
    return;
  }
  $('mode').textContent = watching ? 'watching' : '';
  guide.mount([$('guide-open'), $('guide-again')], { art: () => art, rules: $('rules') });
  $('join-topup').addEventListener('click', async () => {
    try {
      await api('POST', '/players/me/fill-up', { token: store.get(PLAYER_KEY) });
      $('join-topup').hidden = true;
      joinProblem = null;
      await joinTable(null, chosenBuyIn());
    } catch (err) {
      // Kept in joinProblem, so the next poll's redraw doesn't wipe it. Chips at another table is the usual reason.
      joinProblem = err.code === 'chips_in_play' ? await elsewhereNote(`${err.message} The free top-up is for an empty purse with nothing on any table.`) : err.message;
      $('join-topup').hidden = true;
      renderJoin();
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
  window.addEventListener('pageshow', (e) => { if (e.persisted) poll(); });
  if (seatToken || watching) history.replaceState(null, '', `/dice?id=${tableId}${watching ? '&watch=1' : ''}`);
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
