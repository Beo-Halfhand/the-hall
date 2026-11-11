// The Hall. Everything about which games exist comes from GET /games; the doorman's words from GET /hall.

import { RETIRED_LOOKS, lookLabel, pickLook } from './look.js';
import { HALL_ART, LEFT_KEY, MIDNIGHT, MODE_KEY, PLAYER_KEY, api, art, faceEl, fitScale, go, h, loadArt, looksAvailable, pageScale, pressing, seatKey, setupSound, store } from './common.js';
import { setupSettings } from './settings.js';
import { ART } from './hall-config.js';
import { mountSupport } from './support.js';
import { mountNav } from './nav.js';

const STACK_FULL = 1000; // every chips seat starts here, and Fill up brings a purse back to it
const LOBBY_SECONDS = 15; // a table made from the room gives friends a moment, then bots fill in
const POLL_MS = 5000;
const SMALL_BUY_IN = 100;

// Where things go in each code-drawn room image, the fallback. Spots fill in registry order.
const LAYOUTS = {
  wide: {
    w: 640, h: 384, image: '/art/room-wide.png',
    spots: [[272, 170], [44, 186], [476, 122], [476, 258], [152, 268], [376, 280]],
    doorman: [356, 318],
    lights: [[156, 26, 70, 0.45], [216, 26, 70, 0.45], [408, 26, 70, 0.45], [490, 26, 70, 0.45], [616, 26, 70, 0.45], [572, 86, 130, 0.65], [372, 350, 60, 0.5]],
  },
  tall: {
    w: 320, h: 544, image: '/art/room-tall.png',
    spots: [[112, 170], [14, 296], [210, 296], [112, 402], [14, 416], [210, 416]],
    doorman: [230, 476],
    lights: [[146, 26, 60, 0.45], [186, 26, 60, 0.45], [268, 26, 60, 0.45], [160, 520, 50, 0.5]],
  },
};

const TABLE_ART = { cards: '/art/table-cards.png', axes: '/art/table-axes.png', wheel: '/art/table-wheel.png' };
const SOON_ART = { cards: '/art/table-cards-dark.png' };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const roomEl = $('room');
let layoutName = null;
let games = [];
let hall = null;
const spotEls = new Map();
let me = null; // this player, as the server last said
let seats = []; // every table where they still have a seat, biggest stack first
let notice = null; // said once, with the next greeting
let door = null; // the door session, if this browser signed at the door: name, cage balance as the judge last read it
let userOpened = false; // they tapped something before the greeting landed: the greeting then keeps out of the way
let openSign = null; // the game whose sign is open in the dialogue, so a table that opens or fills shows up on it
let menuKey = ''; // what the menu shows, so a refresh redraws it only when something changed
const TNIGHT_BOTS = 2; // house bots at a tNIGHT table opened from the Hall, as the judge's warm tables have
const WALLET_KEY = 'cage.wallet-read'; // the cage page's last reading of the wallet, for the banner: { name, night, at }
let tnightSeats = []; // tNIGHT tables where this browser still holds a seat, as each table said

// ---------- chips or tNIGHT ----------

const tnightOn = () => !!hall?.features?.tnight;

// The seal-anchor preview (11-08): with the picker on, ?anchor=lock|background|off on the Hall's address picks how this browser's
// next table locks its rounds on Midnight, and a seat always opens a fresh table in that mode (a waiting one may be in the other).
const ANCHOR_KEY = 'hall.anchor';
{ const asked = new URLSearchParams(window.location.search).get('anchor'); if (['lock', 'background', 'off'].includes(asked)) store.set(ANCHOR_KEY, asked); }
const anchorPicker = () => !!hall?.features?.anchor?.picker;
const newTableBody = () => ({ lobbySeconds: LOBBY_SECONDS, ...(anchorPicker() ? { anchor: store.get(ANCHOR_KEY) ?? hall.features.anchor.mode } : {}) });
// Only where chips rounds are anchored (scope "all", the preview) does the picker open a fresh chips table; on staging chips are as ever.
const anchorChips = () => anchorPicker() && hall.features.anchor.scope === 'all';
const waitingTable = (game) => (anchorChips() ? null : game.tables.find((t) => t.joinable && !t.tnight)?.id);
/** A tNIGHT player who picked the other mode gets a fresh tNIGHT table in it: the judge's warm tables play the Worker's default. */
const anchorAsked = () => (anchorPicker() && store.get(ANCHOR_KEY) && store.get(ANCHOR_KEY) !== hall.features.anchor.mode ? store.get(ANCHOR_KEY) : null);
/** 'chips' or 'tnight', as they chose, remembered in this browser. Null while they haven't said. With tNIGHT off there's only chips. */
function mode() {
  if (!tnightOn()) return 'chips';
  const m = store.get(MODE_KEY);
  return m === 'chips' || m === 'tnight' ? m : null;
}
const setMode = (m) => store.set(MODE_KEY, m);
/** The door signed, and the cage holding something, as the judge last read it. */
const funded = () => !!door && Number(door.balanceStar ?? 0) > 0;

// ---------- layout ----------

/** The painted room, if its image is here. Otherwise the room falls back to the code-drawn layouts below. */
const paintedRoom = () => {
  const image = art.rooms?.[ART.room];
  return image ? { ...image, ...ART.rooms[ART.room] } : null;
};

function fit() {
  const painted = paintedRoom();
  if (painted) return fitPainted(painted);
  const name = window.innerWidth < 640 || window.innerWidth / window.innerHeight < 1 ? 'tall' : 'wide';
  const layout = LAYOUTS[name];
  const available = document.documentElement.clientWidth;
  const byWidth = fitScale(available, layout.w);
  // On a wide screen, don't let the room grow far past the window's height.
  const scale = name === 'wide' ? Math.min(byWidth, Math.max(fitScale(window.innerHeight * 1.15, layout.h), fitScale(layout.w, layout.w))) : byWidth;
  document.documentElement.style.setProperty('--s', scale);
  roomEl.style.setProperty('--w', layout.w);
  roomEl.style.setProperty('--h', layout.h);
  roomEl.style.backgroundImage = `url(${layout.image})`;
  if (name !== layoutName) {
    layoutName = name;
    placeLights(layout);
    placeDoorman(layout);
    placeSpots();
  }
}

function fitPainted(room) {
  const available = document.documentElement.clientWidth;
  const { scale, soft } = pageScale(available, room.w);
  // On a wide screen, don't let the room grow far past the window's height.
  const s = soft ? scale : Math.min(scale, Math.max(fitScale(window.innerHeight * 1.2, room.h), fitScale(room.w, room.w)));
  document.documentElement.style.setProperty('--s', s);
  roomEl.style.setProperty('--w', room.w);
  roomEl.style.setProperty('--h', room.h);
  roomEl.classList.toggle('soft', soft);
  if (layoutName !== 'painted') {
    layoutName = 'painted';
    document.body.classList.add('art-room');
    document.body.classList.toggle('art-debug', params.get('art-debug') === '1');
    roomEl.style.backgroundImage = `url(${HALL_ART}${room.file})`;
    if (art.side) $('stage').style.backgroundImage = `url(${HALL_ART}${art.side.file})`;
    placeLights({ lights: room.lights });
    placeBrand(room);
    placeDoorman({ doorman: room.doorman });
    placeSpots();
    // A mark brightens while the way in it belongs to is hovered or focused (pass #26).
    const wake = (on) => (e) => { const spot = e.target.closest?.('.hotspot'); if (!spot) return; const id = spot.dataset.game ?? spot.dataset.hotspot; for (const m of $('brand').querySelectorAll(`.hall-mark[data-for="${id}"]`)) m.classList.toggle('on', on); };
    for (const [type, on] of [['pointerover', true], ['pointerout', false], ['focusin', true], ['focusout', false]]) roomEl.addEventListener(type, wake(on));
  }
}

/** Official marks over the art, per the config. The files are unaltered. */
function placeBrand(room) {
  const nodes = [];
  if (ART.midnight.rug) {
    const [x, y, size] = room.rug;
    nodes.push(h('img', { class: 'rug-mark', src: MIDNIGHT.symbol, alt: '', vars: { x: x - size / 2, y: y - size / 2, size, a: ART.midnight.rugOpacity } }));
    // The rug goes under the table: the room's own picture of the table and chairs is laid back on top of it.
    const [cx, cy, rx, ry] = room.furniture;
    const cover = h('div', { class: 'rug-cover', 'aria-hidden': 'true' });
    cover.style.backgroundImage = `url(${HALL_ART}${room.file})`;
    cover.style.clipPath = `ellipse(${(rx / room.w) * 100}% ${(ry / room.h) * 100}% at ${(cx / room.w) * 100}% ${(cy / room.h) * 100}%)`;
    nodes.push(cover);
  }
  if (ART.midnight.marks) {
    for (const [cx, cy, size, a, forGame] of room.marks) {
      nodes.push(h('span', { class: 'hall-mark', 'aria-hidden': 'true', dataset: { for: forGame, src: MIDNIGHT.symbol }, vars: { x: cx - size / 2, y: cy - size / 2, size, a } }));
    }
  }
  $('brand').replaceChildren(...nodes);
}

function placeLights(layout) {
  $('lights').replaceChildren(...layout.lights.map(([x, y, r, a], i) => h('div', { class: 'glow', vars: { x, y, r, a, d: `${-i * 0.7}s` } })));
}

/** Tally keeps the door (11-06): Tally's Hall sprite, from the first paint, before GET /hall is in. Null only if the art failed. */
const doormanLook = () => art.sprites?.[typeof hall?.look === 'string' ? hall.look : 'tally'] ?? null;

let doorAt = null; // where the room put the doorman, so a look that arrives later can be drawn in the same place

/** The doorman's figure: the setting's sprite (from GET /hall), scaled to the door's height, or the original doorman art. */
function doormanSheet() {
  const look = doormanLook();
  const base = art.doorman ?? { w: 32, h: 48 };
  if (!look) return art.doorman ? { file: art.doorman.file, w: base.w, h: base.h } : null; // manifest sizes are one frame
  const h = base.h; // the door is as tall as it was
  return { file: look.file, w: Math.round((look.w * h) / look.h), h, look };
}

function placeDoorman(layout) {
  doorAt = layout;
  const [x, y] = layout.doorman;
  const sheet = doormanSheet();
  const sw = sheet ? sheet.w : 32;
  const sh = sheet ? sheet.h : 48;
  const el = $('doorman');
  el.classList.add('frames');
  if (sheet) el.style.backgroundImage = `url(${sheet.file.startsWith('/') ? sheet.file : HALL_ART + sheet.file})`;
  for (const [k, v] of Object.entries({ x, y, sw, sh })) el.style.setProperty(`--${k}`, v);
  roomEl.querySelector('.bubble')?.remove();
  roomEl.append(h('div', { class: 'bubble', text: '!', vars: { x, y, sw }, 'aria-hidden': 'true' }));
  if (!sheet) $('lights').append(h('div', { class: 'glow', vars: { x: x + 25, y: y + 40, r: 54, a: 0.6 } }));
}

// ---------- spots: the registry drawn as furniture ----------

/** On the painted room each game has a hotspot by id. A game with no place in the picture goes on a sign below. */
function spotBox(game, i) {
  if (layoutName !== 'painted') {
    const [x, y] = LAYOUTS[layoutName].spots[i % LAYOUTS[layoutName].spots.length];
    return [x, y, 96, 80];
  }
  return paintedRoom().hotspots[game.id] ?? null;
}

function placeCage() {
  if (layoutName !== 'painted' || $('spots').querySelector('.hotspot-cage')) return;
  const [x, y, sw, sh] = paintedRoom().hotspots.cage;
  $('spots').append(h('button', {
    type: 'button',
    class: 'sprite hotspot hotspot-cage',
    dataset: { hotspot: 'cage' },
    'aria-label': 'The cage: not open yet',
    vars: { x, y, sw, sh },
    onClick: () => {
      if (!hall) return; // the Hall's words aren't in yet: nothing to say
      userOpened = true;
      return hall.features?.tnight ? go('/wallet?door=1') : say(hall.cageClosed, [{ id: 'back', label: 'Back', run: showGreeting }]);
    },
  }), h('div', { class: 'plate soon above', id: 'cage-plate', 'aria-hidden': 'true', vars: { x, y, sw, sh } }, 'The cage', h('small', { text: 'Later' }))); // above the bar, clear of Tally's window at the foot of the page (11-07)
}

/** Once the Hall says whether tNIGHT is on, the cage's plate says what it's for. */
function labelCage() {
  const plate = $('cage-plate');
  const button = $('spots').querySelector('.hotspot-cage');
  if (!plate || !button) return;
  const open = !!hall?.features?.tnight;
  plate.hidden = false; // with tNIGHT off (live) the sign says "Coming soon", and the spot says the tables are in testing (11-07)
  plate.className = `plate above ${open ? 'live' : 'soon'}`;
  const holds = open && funded() ? `${cageWhole(cageLiveStar())} tNIGHT · Cash out` : null; // what it holds, whenever it holds something (11-07)
  plate.lastChild.textContent = holds ?? (open ? 'Bring tNIGHT' : 'Coming soon');
  button.setAttribute('aria-label', holds ? `The cage: ${holds.replace(' · ', ', ')} or top up` : open ? 'The cage: bring tNIGHT to the Hall' : 'The cage: coming soon, tNIGHT tables are in testing');
}

function placeSpots() {
  const wanted = new Set();
  placeCage();
  labelCage();
  const signs = $('signs');
  games.forEach((game, i) => {
    const box = spotBox(game, i);
    wanted.add(game.id);
    if (!box) {
      let sign = spotEls.get(game.id);
      if (!sign) {
        sign = { button: h('button', { type: 'button', class: 'btn small spot soon', dataset: { game: game.id, status: game.status }, onClick: () => { userOpened = true; openSpot(game.id); }, text: `${game.name}: coming soon` }) };
        spotEls.set(game.id, sign);
        signs.append(sign.button);
      }
      return;
    }
    const pos = box;
    let spot = spotEls.get(game.id);
    if (!spot) {
      spot = makeSpot(game);
      spotEls.set(game.id, spot);
      $('spots').append(spot.button, spot.plate, spot.light);
    }
    for (const el of [spot.button, spot.plate, spot.light]) {
      el.style.setProperty('--x', pos[0]);
      el.style.setProperty('--y', pos[1]);
      el.style.setProperty('--sw', pos[2]);
      el.style.setProperty('--sh', pos[3]);
    }
    spot.light.style.setProperty('--x', pos[0] + pos[2] / 2);
    spot.light.style.setProperty('--y', pos[1] + pos[3] / 2);
    updateSpot(spot, game);
  });
  for (const [id, spot] of spotEls) {
    if (!wanted.has(id)) {
      spot.button.remove();
      spot.plate?.remove();
      spot.light?.remove();
      spotEls.delete(id);
    }
  }
}

function makeSpot(game) {
  const live = game.status === 'live';
  const painted = layoutName === 'painted';
  const drawn = painted ? null : h('div', { class: 'art' });
  if (drawn) drawn.style.backgroundImage = `url(${(!live && SOON_ART[game.art]) || TABLE_ART[game.art] || TABLE_ART.cards})`;
  const button = h('button', {
    type: 'button',
    class: `sprite spot ${live ? 'live' : 'soon'} ${painted ? 'hotspot' : ''}`,
    dataset: { game: game.id, status: game.status },
    onClick: () => {
      userOpened = true;
      // Picking a live game is picking where to sit, the way they play: chips ask how much to bring, tNIGHT goes to the table. Nobody is seated without being asked.
      return playGame(game);
    },
  }, drawn, live || painted ? null : h('div', { class: 'rope' }));
  const plate = h('div', { class: `plate ${live ? 'live' : 'soon'}`, 'aria-hidden': 'true' });
  const light = h('div', { class: 'glow', vars: live && !painted ? { r: 130, a: 0.62 } : { r: 1, a: 0 } });
  return { button, plate, light };
}

const seatsText = (game) => {
  const t = game.tables.find((x) => !x.tnight);
  return `${t ? t.seatsFilled : 0} of ${t ? t.seats : game.seats} seated`;
};

function updateSpot(spot, game) {
  const line = game.status === 'live' ? seatsText(game) : 'Coming soon';
  spot.plate.replaceChildren(document.createTextNode(game.sign ?? game.name), h('small', { text: line }));
  spot.plate.classList.toggle('sign', !!game.sign); // a longer sign wraps, so it doesn't run into the next plate
  spot.button.setAttribute('aria-label', `${game.sign ?? game.name}: ${line}`);
}

/** The table page seats a tNIGHT player in place, so the way to play for tNIGHT is the table itself. */
const bringHref = (game, id) => `${game.page}?id=${id}`;

/** The tNIGHT table of this game that is seating now, a warm one first. Null when none is open. */
const tnightTableFor = (game) => game.tables.find((x) => x.tnight && x.joinable && x.warm) ?? game.tables.find((x) => x.tnight && x.joinable) ?? null;
const tnightNote = (game) => { const t = tnightTableFor(game); return t ? `table ${t.table}, preprod` : 'opens a table, about 2 min to the first deal'; };

/** Play for tNIGHT at this game: its table that is seating, or a fresh one. The table page seats them from the cage, under their permit. Both games, the same cage. */
const TNIGHT_TOLD = 'hall.tnight.told'; // Tally has said, once, why the tNIGHT tables wait
function goTnight(game) {
  setMode('tnight');
  if (!store.get(TNIGHT_TOLD)) { // once, before their first tNIGHT seat: why the table waits, in Tally's words
    return say(hall.tnightWait, [
      { id: 'go', label: `Sit me down at ${game.name}`, primary: true, run: () => { store.set(TNIGHT_TOLD, '1'); return goTnight(game); } },
      { id: 'back', label: 'Not yet', run: backToHall },
    ]);
  }
  const table = anchorAsked() ? null : tnightTableFor(game); // the other lock mode: a fresh table in it, not the judge's warm one
  return table ? go(bringHref(game, table.id)) : openTnightTable(game);
}

/** The way to a seat at this game, the way they play. With nothing said yet, the game's sign asks: chips or tNIGHT, by name. Never chips by default. */
function playGame(game) {
  if (game.status !== 'live') return openSpot(game.id);
  const m = mode();
  if (m === 'tnight') return goTnight(game);
  if (m === 'chips') return goJoin(game, undefined, { named: true });
  return openSpot(game.id);
}

// ---------- the table picker: one row per table ----------

const FILTER_KEY = 'hall.tables.filter';
const FILTERS = [{ id: 'all', label: 'All' }, { id: 'cards', label: 'Cards' }, { id: 'dice', label: 'Dice' }];
/** Cards or dice, from the game's art. Anything else is a game this picker has no filter for yet: it shows under All. */
const kindOf = (game) => (game.art === 'cards' ? 'cards' : game.art === 'dice' ? 'dice' : 'other');
let tableFilter = FILTERS.some((f) => f.id === store.get(FILTER_KEY)) ? store.get(FILTER_KEY) : 'all';

/** Who's at the table, as faces, then the empty chairs, then "3/5". At most five faces drawn; past that, "+N". */
function seatStack(table) {
  const faces = table.faces ?? [];
  const shown = faces.slice(0, 5);
  const open = Math.max(0, Math.min(table.seats - table.seatsFilled, 5 - shown.length));
  return h('span', { class: 'seat-stack', 'aria-label': `${table.seatsFilled} of ${table.seats} seats taken`, title: faces.map((f) => f.name).join(', ') || 'Nobody yet' },
    h('span', { class: 'seat-faces', 'aria-hidden': 'true' },
      ...shown.map((f) => faceEl(f, 26)),
      ...(faces.length > shown.length ? [h('span', { class: 'face more', text: `+${faces.length - shown.length}` })] : []),
      ...Array.from({ length: open }, () => h('span', { class: 'face empty' }))),
    h('span', { class: 'seat-count', text: `${table.seatsFilled}/${table.seats}` }));
}

function tableRow(game, table) {
  const mine = seats.find((seat) => seat.tableId === table.id) ?? tnightSeats.find((seat) => seat.tableId === table.id);
  const unit = table.tnight ? 'tNIGHT' : 'chips';
  const waiting = table.phase === 'lobby';
  const openSeats = table.seats - table.seatsFilled;
  const status = waiting
    ? h('span', { class: 'pill wait', text: table.joinable ? `Waiting · ${openSeats} open` : 'Waiting' })
    : h('span', { class: 'pill live', text: `Hand in play · round ${table.round}` });
  const act = [
    mine ? h('a', { class: 'btn primary small', href: `${game.page}?id=${table.id}`, dataset: { return: table.id }, text: `Back to your seat (${mine.stack} ${unit})` }) : null,
    table.joinable && !mine && table.tnight ? h('a', { class: 'btn primary small', href: bringHref(game, table.id), dataset: { bring: table.id }, text: 'Play for tNIGHT', onClick: () => setMode('tnight') }) : null,
    table.joinable && !mine && !table.tnight ? h('button', { class: 'btn primary small', type: 'button', text: tnightOn() ? 'Play chips' : 'Join', onClick: (e) => { const release = pressing(e.currentTarget); userOpened = true; setMode('chips'); goJoin(game, table.id).finally(release); } }) : null,
    h('a', { class: 'btn small', href: `${game.page}?id=${table.id}&watch=1`, text: 'Watch' }),
  ].filter(Boolean);
  return h('div', { class: `row trow ${mine ? 'mine' : ''}`, dataset: { table: table.id, kind: kindOf(game) } },
    h('span', { class: 'label trow-game' },
      `${game.name}${table.tnight ? ` · Table ${table.table} · tNIGHT` : table.n ? ` · table ${table.n}` : ''}`, // one number, the one on the receipts (11-06, round 2)
      h('small', { text: [table.ante ? `Ante ${table.ante}` : null, table.tnight ? 'preprod' : 'play chips'].filter(Boolean).join(' · ') })),
    seatStack(table),
    status,
    h('span', { class: 'trow-act' }, ...act));
}

function renderFilters() {
  const counts = { all: 0, cards: 0, dice: 0, other: 0 };
  for (const game of games) for (const t of game.tables) { counts.all += 1; counts[kindOf(game)] += 1; }
  $('tables-filter').replaceChildren(...FILTERS.map((f) => h('button', {
    type: 'button',
    class: 'chip filter',
    'aria-pressed': String(tableFilter === f.id),
    dataset: { filter: f.id },
    onClick: () => {
      tableFilter = f.id;
      store.set(FILTER_KEY, f.id);
      renderInPlay();
    },
  }, f.label, h('small', { text: String(counts[f.id]) }))));
}

function renderInPlay() {
  renderFilters();
  const rows = [];
  const order = (game, t) => (seats.some((seat) => seat.tableId === t.id) ? 0 : t.joinable ? 1 : 2); // your seat, then seats to take, then hands in play
  const listed = games.flatMap((game) => game.tables.map((table) => ({ game, table })))
    .filter(({ game }) => tableFilter === 'all' || kindOf(game) === tableFilter)
    .sort((a, b) => order(a.game, a.table) - order(b.game, b.table));
  for (const { game, table } of listed) rows.push(tableRow(game, table));
  if (rows.length === 0) {
    const which = tableFilter === 'all' ? '' : `${tableFilter === 'cards' ? 'card' : 'dice'} `;
    rows.push(h('p', { class: 'prose tables-empty', text: `No ${which}tables open just now. Take a seat and one opens; bots fill the empty chairs.` }));
  }
  $('in-play').replaceChildren(...rows);
}

/** "Take a seat" over the list: the filtered game, or the doorman asks which. Either way a waiting table, or a new one. */
function takeSeatFromList() {
  if (!hall) return null; // the doorman isn't in yet
  userOpened = true;
  const live = games.filter((g) => g.status === 'live');
  const picked = live.filter((g) => tableFilter !== 'all' && kindOf(g) === tableFilter);
  if (picked.length === 1) return playGame(picked[0]);
  return chooseGame();
}

/** Which game: there is no default. One live game goes straight on; more, and the doorman asks. With no way to play said yet, that comes first. */
function chooseGame() {
  if (!mode()) return chooseMode({ then: chooseGame });
  const live = games.filter((g) => g.status === 'live');
  if (live.length === 1) return playGame(live[0]);
  return say(hall.whichGame, [
    ...live.map((g) => ({ id: `pick-${g.id}`, label: g.name, note: mode() === 'tnight' ? tnightNote(g) : g.blurb, run: () => playGame(g) })),
    { id: 'back', label: 'Back', run: showGreeting },
  ]);
}

/** Just watching: the game with a table, or the doorman asks which. Nobody is sent to a default game's table. */
function chooseWatch() {
  const playing = games.filter((g) => g.status === 'live' && g.tables.length);
  if (playing.length <= 1) return goWatch(playing[0]);
  return say(hall.whichWatch, [
    ...playing.map((g) => ({ id: `watch-${g.id}`, label: g.name, note: seatsText(g), run: () => goWatch(g) })),
    { id: 'back', label: 'Back', run: showGreeting },
  ]);
}

/** "Not yet", or anything else that hands the room back: the dialogue closes and they stand in the Hall, purse as it was. */
function backToHall() {
  clearInterval(typing);
  openSign = null;
  $('dialogue').hidden = true;
}

// ---------- taking a seat ----------

const goToSeat = (seat) => go(`${seat.page}?id=${seat.tableId}`);

/** "Sealed Hand, table 2": the game's name and the table's number from the Hall's list, or just the game when the list doesn't have it. */
/** "Cup & Claim, table 2": the number comes from the Hall's list, or from the table itself (`n`) once it has left the list. */
function tableLabel(gameId, tableId, n = null) {
  const game = games.find((g) => g.id === gameId) ?? games.find((g) => g.page === gameId);
  const table = game?.tables.find((t) => t.id === tableId);
  const number = table?.tnight ? table.table : table?.n ?? n; // a tNIGHT table goes by its cage number, the one on the receipts
  return `${game?.name ?? gameId}${number ? `, table ${number}` : ''}`;
}
const seatLabel = (seat) => `${tableLabel(seat.game, seat.tableId, seat.n)} (${seat.stack} chips)`;

/**
 * Seated somewhere else and sitting down here: the old seat is left (its stack goes back to the purse, at the end of the hand if
 * one is on), then the new table takes the whole purse. One stack, carried. Ends on the new table.
 */
async function moveSeat(from, game, tableId) {
  const token = store.get(PLAYER_KEY);
  const fromApi = apiOf(from.page);
  say(`Leaving ${tableLabel(from.game, from.tableId, from.n)}…`, []);
  try {
    let seatToken = store.get(`hall.seat.${from.tableId}`);
    if (!seatToken) { // this browser never held that seat (another device, or a cleared browser): take it back with the player token, then leave it
      const back = await api('POST', `${fromApi}/${from.tableId}/join`, { token, body: { kind: 'human' } });
      seatToken = back.token;
    }
    const left = await api('POST', `${fromApi}/${from.tableId}/leave`, { token: seatToken, body: {} });
    store.remove(`hall.seat.${from.tableId}`);
    if (left.queued) {
      const started = Date.now();
      const waitLine = () => `Finishing the hand at ${tableLabel(from.game, from.tableId, from.n)}. Your stack comes over when it ends: usually a minute or two, as the bots play the hand out.`;
      say(waitLine(), [{ id: 'back', label: 'Wait in the Hall', run: backToHall }], { told: 'Waiting on the hand… 0:00' });
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        const where = await api('GET', `${fromApi}/${from.tableId}/seat`, { token }).catch(() => ({ status: 'none' }));
        if (where.status !== 'seated') break;
        const s = Math.round((Date.now() - started) / 1000);
        if (!$('dialogue').hidden) $('notice').replaceChildren(h('span', { class: 'mid-spin', 'aria-hidden': 'true' }), `Waiting on the hand… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    store.remove(LEFT_KEY);
    await renderWho(); // the purse has the stack now
    if (seats[0]) return say(`You still have a seat at ${seatLabel(seats[0])}.`, [{ id: 'return', label: `Back to ${seatLabel(seats[0])}`, run: () => goToSeat(seats[0]) }, { id: 'back', label: 'Back', run: showGreeting }]);
    // From a sign or the Games menu no table was named: a waiting one, or a new one.
    const id = tableId ?? waitingTable(game) ?? (await api('POST', game.api, { body: newTableBody() })).id;
    const carry = me?.purse?.amount > 0 ? { buyIn: me.purse.amount } : {}; // the stack that came back is the purse: it goes to the new seat whole
    const sat = await api('POST', `${game.api}/${id}/join`, { token, body: { kind: 'human', ...carry } });
    store.set(`hall.seat.${id}`, sat.token);
    return go(`${game.page}?id=${id}`);
  } catch (err) {
    return say(`Couldn’t move your seat: ${err.message}`, [{ id: 'back', label: 'Back', run: showGreeting }]);
  }
}

/** Taking a seat always asks the server first: with a seat still live, this goes back to it and opens nothing new. */
async function goJoin(game, tableId, { named = false } = {}) {
  if (!store.get(PLAYER_KEY)) return askName(() => goJoin(game, tableId, { named }));
  const known = await renderWho();
  if (!store.get(PLAYER_KEY)) return askName(() => goJoin(game, tableId, { named }));
  if (!known) return say('I can’t find your name on the slate just now. Try me again in a moment.', [{ id: 'back', label: 'Back', run: showGreeting }]);
  // Take a seat, or asking for the game they're already playing: back to the seat they have.
  if (seats[0] && (tableId ? seats[0].tableId === tableId : !named || seats[0].game === game.id)) return goToSeat(seats[0]);
  if (seats[0]) { // a different table by name, or the other game's sign or Games link: leave the old seat and bring the stack, or go back to it
    const from = seats[0];
    return say(`You’re still seated at ${seatLabel(from)}. Leave it and bring your stack here?`, [
      { id: 'move', label: 'Yes, leave it and bring my stack', primary: true, run: () => moveSeat(from, game, tableId) },
      { id: 'return', label: `No, back to ${tableLabel(from.game, from.tableId, from.n)}`, run: () => goToSeat(from) },
    ]);
  }
  return askBuyIn(game, tableId);
}

/** "Bring: [N] of your N." The whole purse unless they say less. Nothing leaves it until the table takes the seat. */
function askBuyIn(game, tableId) {
  const purse = me.purse.amount;
  const back = { id: 'back', label: 'Not yet', run: backToHall };
  const where = tableLabel(game.id, tableId);
  if (purse < 1) {
    const topUp = {
      id: 'topup',
      label: 'Fill up to 1,000',
      primary: true,
      run: async () => {
        try {
          await api('POST', '/players/me/fill-up', { token: store.get(PLAYER_KEY) });
        } catch { /* the purse below says what happened */ }
        await renderWho();
        askBuyIn(game, tableId);
      },
    };
    return say(`${where}. ${hall.emptyPurse}`, !me.purse.readOnly ? [topUp, back] : [back]);
  }
  const input = $('buyin');
  const amount = () => Number(input.value);
  const fixed = !!me.purse.readOnly; // a purse that can't be filled (the wallet seam's) brings what it has, up to the default
  const most = fixed ? purse : Math.max(purse, STACK_FULL); // a short purse fills up to the full stack when they sit
  const valid = () => Number.isInteger(amount()) && amount() >= 1 && amount() <= most;
  const paint = () => {
    const sit = $('menu').querySelector('[data-id="sit"]');
    sit.disabled = !valid();
    sit.textContent = valid() ? `Sit down at ${game.name} with ${amount().toLocaleString('en-US')}` : `Choose 1 to ${most.toLocaleString('en-US')}`;
  };
  let sitting = false;
  const sitDown = async () => {
    if (!valid() || sitting) return;
    sitting = true;
    const release = pressing($('menu').querySelector('[data-id="sit"]'), 'Sitting you down', { lock: $('menu') });
    try {
      const id = tableId ?? waitingTable(game) ?? (await api('POST', game.api, { body: newTableBody() })).id;
      await go(`${game.page}?id=${id}&join=1&buyin=${amount()}`);
    } catch (err) {
      sitting = false;
      release();
      say(err.message, [back]);
    }
  };
  input.max = most;
  input.value = fixed ? Math.min(purse, STACK_FULL) : STACK_FULL; // every seat starts at 1,000
  input.oninput = paint;
  $('buyin-of').textContent = purse >= STACK_FULL || fixed ? `of your ${purse.toLocaleString('en-US')}` : `(your purse ${purse}: it fills up to 1,000)`;
  const presets = [[fixed ? Math.min(purse, STACK_FULL) : STACK_FULL, fixed ? 'All' : '1,000'], [Math.floor((fixed ? purse : STACK_FULL) / 2), 'Half'], [SMALL_BUY_IN, String(SMALL_BUY_IN)]].filter(([n], i) => n >= 1 && n <= most && (i === 0 || n !== STACK_FULL));
  $('buyin-presets').replaceChildren(...presets.map(([n, label]) => h('button', {
    type: 'button',
    class: 'btn small',
    text: label,
    dataset: { buyin: n },
    onClick: () => {
      input.value = n;
      paint();
    },
  })));
  $('buyin-form').onsubmit = (e) => {
    e.preventDefault();
    sitDown();
  };
  say(`${where}. ${hall.askBuyIn}`, [{ id: 'sit', label: '', primary: true, run: sitDown, own: true }, back], { buyin: true });
  paint();
}

function goWatch(game) {
  const table = game?.tables.find((t) => t.phase === 'playing') ?? game?.tables[0];
  if (table) return go(`${game.page}?id=${table.id}&watch=1`);
  return say(hall.nobodyPlaying, [{ label: 'Back', run: showGreeting }]);
}

// ---------- the doorman ----------

let typing = null;

function say(text, items, { form = false, look = false, buyin = false, told = null, welcome = false, go: goLabel = 'Chalk me in' } = {}) {
  const dialogue = $('dialogue');
  dialogue.hidden = false;
  paintWelcome(welcome);
  $('speaker').textContent = hall.name;
  $('seat-form').hidden = !form;
  if (form) {
    $('seat-go').textContent = goLabel;
    $('seat-go').classList.toggle('primary', goLabel !== 'Chalk me in');
  }
  $('looks').hidden = !look;
  $('buyin-form').hidden = !buyin;
  $('notice').hidden = !told;
  $('notice').textContent = told ?? '';
  clearInterval(typing);
  const line = $('line');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) line.textContent = text;
  else {
    let i = 0;
    line.textContent = '';
    typing = setInterval(() => {
      i += 2;
      line.textContent = text.slice(0, i);
      if (i >= text.length) clearInterval(typing);
    }, 18);
    line.onclick = () => {
      clearInterval(typing);
      line.textContent = text;
    };
  }
  openSign = null;
  renderMenu(items, { form });
}

/** The menu under the doorman's line. A pressed item goes busy, and the others wait, until what it started is over or the page has moved on. */
function renderMenu(items, { form = false, keepFocus = false } = {}) {
  const focused = keepFocus ? document.activeElement?.dataset?.id : null;
  menuKey = JSON.stringify(items.map((item) => [item.id, item.label, item.note ?? null, !!item.disabled]));
  $('menu').replaceChildren(...items.map((item) => h('button', {
    type: 'button',
    role: 'menuitem',
    class: `menu-item ${item.primary ? 'menu-primary' : ''}`,
    disabled: item.disabled,
    dataset: { id: item.id },
    onClick: async (e) => {
      if (item.own) return item.run(); // marks itself busy
      const release = pressing(e.currentTarget, item.wait ?? null, { lock: $('menu') });
      try {
        await item.run();
      } finally {
        release();
      }
    },
  }, item.label, item.note ? h('small', { text: item.note }) : null)));
  const first = (focused && $('menu').querySelector(`[data-id="${focused}"]:not([disabled])`)) ?? $('menu').querySelector('button:not([disabled])');
  if (!form) first?.focus({ preventScroll: true });
}

/**
 * The first visit, with chips only: the door asks a name and nothing else. "Enter the Hall" makes the player and lets them in,
 * standing, with the purse untouched. A game is picked in the Hall, and only then is the bring asked.
 */
function showDoor() {
  afterName = enterHall;
  askWho();
}

// ---------- who are you (11-10) ----------
// Before any door or table: no player saved here asks "New here, or bringing a Player ID?". New is a name, then an avatar; a Player ID is
// pasted in the Player ID panel. A returning player is welcomed by name and face, with a way to switch; one with no avatar the server
// accepts is asked for one right there (The owner's first tNIGHT run on live: a name and no avatar, and the seat was refused).

const acceptedLooks = () => (Array.isArray(hall?.avatars) ? hall.avatars : []);
// A retired look (Clockwork) is asked about here too (11-10, the owner's full run: his was, and the picker only came at the seat). The seat's own check stays as a safety net.
const hasValidLook = (player) => !!player && acceptedLooks().includes(player.avatar);
let pendingName = '';
let making = false;
let keepingPlayer = false; // "Not you? Switch player": the player stays until the new one is made or restored, and the old key is kept

function askWho() {
  say('New here, or bringing a Player ID?', [
    { id: 'who-new', label: 'New here', primary: true, run: askNewName },
    { id: 'who-restore', label: 'Bringing a Player ID', run: () => settings.open() },
    ...(keepingPlayer ? [{ id: 'who-cancel', label: 'Never mind', run: () => { keepingPlayer = false; showGreeting(); } }] : []),
  ]);
}

/** New: the name first, on the doorman's form. */
function askNewName(problem = null) {
  say(typeof problem === 'string' ? problem : hall.askName, [{ id: 'who-back', label: 'Back', run: askWho }], { form: true, go: 'Next: pick an avatar' });
  $('seat-name').focus({ preventScroll: true });
}

/** New, second step: the avatar, then the player is made with both. */
function askNewLook() {
  chooseLook(null, {
    onPick: async (picked) => {
      if (making) return; // a second press while the first is being chalked would make a second player
      making = true;
      try {
        const player = await api('POST', '/players', { body: { name: pendingName, ...(picked ? { avatar: picked } : {}) } });
        if (keepingPlayer && store.get(PLAYER_KEY)) store.set('hall.player.previous', store.get(PLAYER_KEY)); // never the only copy of a key
        keepingPlayer = false;
        store.set(PLAYER_KEY, player.token);
        myLook = player.avatar;
        await Promise.resolve(afterName?.()).catch(() => {});
      } catch (err) {
        askNewName(err.message); // the name was refused: back to the name, with why
      } finally {
        making = false;
      }
    },
    back: askNewName,
    title: `${pendingName}, pick an avatar.`,
  });
}

/** Returning, no avatar the server accepts (none, or a retired one): asked for one at the welcome card, once, before any door or table. */
function askLookHere(then) {
  chooseLook(then, {
    onPick: async (picked) => {
      await api('POST', '/players/me/avatar', { token: store.get(PLAYER_KEY), body: { avatar: picked } });
      me.avatar = picked;
      myLook = picked;
      await then();
    },
    title: RETIRED_LOOKS.includes(me.avatar) ? 'Your look has been retired: pick a new one.' : 'Pick an avatar before you sit down.',
    welcome: 'pick',
  });
}

/** "Welcome back, Halfhand" with their face, "Change look" and "Not you? Switch player", on the greeting menus. While a look is being asked for ('pick'), no Change look: the picker is open. */
function paintWelcome(on) {
  const card = $('welcome-back');
  card.hidden = !(on && me && store.get(PLAYER_KEY));
  if (card.hidden) return;
  $('welcome-text').textContent = `Welcome back, ${me.name}`;
  $('welcome-face').replaceChildren(faceEl({ kind: 'agent', avatar: me.avatar }, 40));
  $('change-look').hidden = on === 'pick';
}
/** Change look: the same player and Player ID, a new face. The window is look.js's, as in Menu → Player. */
$('change-look').addEventListener('click', () => pickLook({ title: 'Change look', why: 'Pick a new look. It follows you to every table.', current: me?.avatar, cancel: 'Keep this one' }));
window.addEventListener('hall:look', (e) => {
  if (!me || !e.detail) return;
  me.avatar = e.detail;
  myLook = e.detail;
  if (!$('welcome-back').hidden) paintWelcome(true);
  renderWho();
});
$('switch-player').addEventListener('click', () => {
  keepingPlayer = true;
  afterName = enterHall;
  askWho();
});

/** Through the door: standing in the Hall, the purse as it is. The doorman says so and points at the games. */
async function enterHall() {
  await renderWho();
  if (tnightOn() && mode() === null) return chooseMode(); // a player is made: now the one question, chips or tNIGHT
  welcomeIn();
}

function welcomeIn() {
  if (!me) return showGreeting();
  if (!hasValidLook(me)) return askLookHere(welcomeIn);
  const items = [
    { id: 'seat', label: 'Choose a game', primary: true, run: chooseGame },
    { id: 'watch', label: 'Just watching', run: chooseWatch },
    { id: 'rules', label: 'How do I play?', run: () => showRule(0) },
  ];
  items.push(tnightOn() ? { id: 'mode-tnight', label: 'Play with tNIGHT instead', note: 'your Midnight wallet, preprod', run: () => switchMode('tnight') } : tnightSoonItem(welcomeIn));
  say(hall.welcomeIn.replace('{name}', me.name).replace('{purse}', me.purse.amount), items, { welcome: true });
}

/** "Fill up to 1,000 chips": free, any time, as often as wanted; offered whenever the purse is short of it. */
const fillUpItems = () => (me && !me.purse.readOnly && me.purse.amount < STACK_FULL ? [{
  id: 'fill-up',
  label: 'Fill up to 1,000 chips',
  note: `your purse is ${me.purse.amount.toLocaleString('en-US')}`,
  run: async () => {
    try {
      await api('POST', '/players/me/fill-up', { token: store.get(PLAYER_KEY) });
      await renderWho();
      notice = 'Your purse is back to 1,000.';
    } catch (err) {
      notice = err.message;
    }
    showGreeting();
  },
}] : []);

/** tNIGHT off (live): the choice is there, and pressing it says the tables are coming, never a wallet flow (2026-11-07). */
const tnightSoonItem = (back) => ({ id: 'tnight', label: 'Play with tNIGHT', note: 'coming soon', run: () => say(hall.tnightSoon, [{ id: 'back', label: 'Back', run: back }]) });

/**
 * The greeting, the way they play. With tNIGHT on and nothing said yet, the first thing is the one choice: free chips, or tNIGHT
 * from a Midnight wallet. Chips: the door asks a name on a first visit, then the Hall as always. tNIGHT: the cage holds the stack.
 */
function showGreeting() {
  // Who first (11-10): no player saved here, or one the server wouldn't seat. Before the way to play, the door and every table.
  if (!store.get(PLAYER_KEY)) return showDoor();
  if (me && !hasValidLook(me)) return askLookHere(showGreeting);
  const m = mode();
  if (m === null) return chooseMode();
  if (m === 'tnight') return greetTnight();
  // One menu, the same choices in the same order every visit (11-07): the way back to a seat first (context), then Take a seat
  // (which always asks which game), Just watching, How do I play?, the cage whenever it holds tNIGHT, the look, the other way to play.
  const actions = { seat: chooseGame, watch: chooseWatch, rules: () => showRule(0) };
  const items = hall.menu
    .filter((item) => item.id !== 'tnight') // the tNIGHT line is the room's: "instead" with tNIGHT on, "coming soon" with it off (live), both at the end
    .map((item) => ({ id: item.id, label: item.label, note: item.available ? null : item.note, disabled: !item.available, run: actions[item.id] }));
  if (funded()) items.push(cageItem());
  items.push(...fillUpItems());
  // Change look is the welcome card's button now (11-10), and Menu → Player's: not a third time in this menu.
  items.push(tnightOn() ? { id: 'mode-tnight', label: 'Play with tNIGHT instead', note: 'your Midnight wallet, preprod', run: () => switchMode('tnight') } : tnightSoonItem(showGreeting));
  items.unshift(...seats.slice(0, 3).map((seat) => ({ id: 'return', label: `Back to ${seatLabel(seat)}`, primary: true, run: () => goToSeat(seat) })));
  say(hall.greeting.join(' '), items, { told: notice, welcome: true });
  notice = null;
}

/** "Cage: 186 tNIGHT · Cash out · Top up": the one line for the cage whenever it holds something, in every menu, in chips mode too (11-07). */
const cageItem = () => ({ id: 'cage', label: `Cage: ${cageWhole(cageLiveStar())} tNIGHT · Cash out · Top up`, run: () => go('/wallet?door=1') });

/** On arrival with tNIGHT on: the one choice, remembered in this browser. tNIGHT with an empty cage goes straight to the cage page. */
function chooseMode({ then = showGreeting } = {}) {
  say(`${hall.greeting[0]} ${hall.chooseMode}`, [
    { id: 'mode-chips', label: 'Play free with chips', note: 'nothing to install', primary: true, run: () => { setMode('chips'); return then(); } },
    { id: 'mode-tnight', label: 'Play with tNIGHT', note: 'your Midnight wallet, preprod', primary: true, run: () => { setMode('tnight'); return then === showGreeting && !funded() ? go('/wallet?door=1') : then(); } },
    { id: 'rules', label: 'How do I play?', run: () => showRule(0) },
  ]);
}

/** The greeting for tNIGHT: the cage is the first stop until it holds something; then a game, and the judge seats them. Chips are never offered by default. */
function greetTnight() {
  const name = door?.name ?? me?.name ?? null;
  const items = tnightSeats.slice(0, 3).map((seat) => ({ id: 'return', label: `Back to ${tableLabel(seat.game, seat.tableId, seat.n)} (${seat.stack} tNIGHT)`, primary: true, run: () => go(`${seat.page}?id=${seat.tableId}`) }));
  if (funded()) items.push({ id: 'seat', label: tnightSeats.length ? 'Another seat' : 'Take a seat', primary: !tnightSeats.length, run: chooseGame });
  else items.push({ id: 'cage', label: 'Bring tNIGHT at the cage', note: 'your Midnight wallet, preprod', primary: true, run: () => go('/wallet?door=1') });
  items.push({ id: 'watch', label: 'Just watching', run: chooseWatch }, { id: 'rules', label: 'How do I play?', run: () => showRule(0) });
  if (funded()) items.push(cageItem()); // the same order as the chips menu: seat, watching, rules, the cage, the other way
  items.push({ id: 'mode-chips', label: 'Play free with chips instead', run: () => switchMode('chips') });
  const line = funded() ? hall.tnightIn.replace('{name}', name ?? 'friend').replace('{cage}', cageWhole(cageLiveStar())) : hall.tnightEmpty;
  say(line, items, { told: notice, welcome: true });
  notice = null;
}

/** The other way to play, from the greeting. Chips with no purse here go by the door first; tNIGHT with an empty cage, by the cage. */
async function switchMode(m) {
  setMode(m);
  await renderWho();
  if (m === 'tnight' && !funded()) return go('/wallet?door=1');
  return showGreeting();
}

/** A game's API from its page: the Hall only ever stores the page, and each game answers for its own tables. */
const apiOf = (page) => games.find((g) => g.page === page)?.api ?? (page === '/dice' ? '/dice-tables' : '/tables');

/**
 * What the table page left behind: the chips it sent to the purse, said once. Standing up is standing up: the Hall doesn't
 * offer the table they just left as if they were still at it (11-06). They pick a game again like anyone else.
 */
async function readLeft() {
  let left = null;
  try {
    left = JSON.parse(store.get(LEFT_KEY));
  } catch { /* nothing usable */ }
  if (!left) return;
  if (left.told || !Number.isInteger(left.amount)) { store.remove(LEFT_KEY); return; } // a tNIGHT table says its own goodbye
  if (!me) return; // the purse isn't in yet: said next time
  notice = `${left.amount} returned to your purse (now ${me.purse.amount}).`;
  store.remove(LEFT_KEY);
}

/** A look's name in the picker. The id is what's saved on a player, so the hooded look stays `halfhand` underneath. */


/** "Choose your look": pick a portrait, then confirm. Remembered on the player, so it follows them to any table. */
function chooseLook(then, { onPick = null, back = null, title = null, welcome = false } = {}) {
  const looks = looksAvailable(hall.avatars);
  if (looks.length < 2) return onPick ? onPick(looks[0] ?? null) : then();
  let picked = looks.includes(myLook) ? myLook : 'adventurer';
  const paint = () => {
    for (const el of $('looks').querySelectorAll('[data-look]')) el.setAttribute('aria-pressed', String(el.dataset.look === picked));
  };
  $('looks').replaceChildren(...looks.map((id) => h('button', {
    type: 'button',
    class: 'look',
    dataset: { look: id },
    onClick: () => {
      picked = id;
      paint();
    },
  }, faceEl({ kind: 'agent', avatar: id }, 64), h('span', { text: lookLabel(id) }))));
  paint();
  const items = [{
    id: 'look-ok',
    label: 'This one',
    primary: true,
    run: async () => {
      if (onPick) return onPick(picked);
      try {
        await api('POST', '/players/me/avatar', { token: store.get(PLAYER_KEY), body: { avatar: picked } });
        myLook = picked;
      } catch { /* they keep the look they had, and can change it later */ }
      await then();
    },
  }];
  // A look no longer offered isn't in the list. Whoever has one can still walk away with it.
  if (!looks.includes(myLook) && !onPick) items.push({ id: 'look-keep', label: 'Keep the look I have', run: then });
  if (back) items.push({ id: 'look-back', label: 'Back', run: back });
  say(title ?? hall.chooseLook, items, { look: true, welcome });
}

function showRule(i) {
  const last = i === hall.rules.length - 1;
  say(hall.rules[i], [
    { id: 'next', label: last ? 'Got it' : `Go on (${i + 1} of ${hall.rules.length})`, run: () => (last ? showGreeting() : showRule(i + 1)) },
    i > 0 ? { id: 'prev', label: 'Back', run: () => showRule(i - 1) } : { id: 'prev', label: 'Never mind', run: showGreeting },
  ]);
}

let afterName = null;
let settings = null;
let myLook = 'adventurer';

function askName(then) {
  afterName = then;
  askWho(); // New here, or bringing a Player ID? (a name alone made a player with no avatar of their own choosing)
}

$('seat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // The name only here; the player is made after the avatar is picked (askNewLook), with both, in one request.
  const name = $('seat-name').value.trim();
  if (!name) { $('seat-name').focus({ preventScroll: true }); return; }
  pendingName = name;
  askNewLook();
});

$('dialogue-close').addEventListener('click', () => { $('dialogue').hidden = true; });
document.addEventListener('keydown', (e) => {
  const dialogue = $('dialogue');
  if (dialogue.hidden) return;
  if (e.key === 'Escape') dialogue.hidden = true;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = [...$('menu').querySelectorAll('button:not([disabled])')];
    const at = items.indexOf(document.activeElement);
    const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }
});
$('doorman').addEventListener('click', () => { userOpened = true; showGreeting(); });

/** What a live game's sign offers right now. Read again on every poll while the sign is open, so a table that opens or fills shows up. */
function spotItems(game) {
  const tnightTable = tnightTableFor(game);
  const ways = tnightOn() ? [ // chips or tNIGHT, by name: whichever they press is the way they play from here on
    { id: 'join', label: 'Play chips', note: 'free', run: () => { setMode('chips'); return goJoin(game, undefined, { named: true }); } },
    tnightTable && !anchorAsked()
      ? { id: 'bring', label: 'Play for tNIGHT', note: `table ${tnightTable.table}, preprod`, run: () => goTnight(game) }
      : { id: 'open', label: 'Open a tNIGHT table', note: 'about 2 min to the first deal', wait: 'Opening a table', run: () => goTnight(game) },
  ] : [{ id: 'join', label: 'Join', run: () => goJoin(game, undefined, { named: true }) }];
  return [
    ...ways,
    { id: 'watch', label: 'Watch', disabled: game.tables.length === 0, run: () => goWatch(game), note: game.tables.length ? null : 'no table yet' },
    { id: 'back', label: 'Back', run: showGreeting },
  ];
}

/** A fresh tNIGHT table with house bots, then the cage page for it. The judge seats the float once someone sits: about 2 minutes to the first deal. */
async function openTnightTable(game) {
  try {
    const made = await api('POST', game.api, { body: { tnight: true, bots: TNIGHT_BOTS, lobbySeconds: 0, ...(anchorAsked() ? { anchor: anchorAsked() } : {}) } });
    await go(bringHref(game, made.id));
  } catch (err) {
    say(`Couldn’t open a table: ${err.message}`, [{ id: 'back', label: 'Back', run: () => openSpot(game.id) }]);
  }
}

function openSpot(id) {
  const game = games.find((g) => g.id === id);
  if (!game) return;
  if (game.status !== 'live') {
    say(`${game.name}. ${game.blurb} Not open yet, so the rope stays up.`, [{ id: 'back', label: 'Back', run: showGreeting }]);
    return;
  }
  say(`${game.name}. ${game.blurb} ${seatsText(game)}.`, spotItems(game));
  openSign = id;
}

/** The sign that's open, redrawn if the games list changed under it. Keeps whatever was focused, and never restarts the line. */
function refreshSign() {
  const game = openSign && games.find((g) => g.id === openSign);
  if (!game || $('dialogue').hidden || game.status !== 'live') return;
  if ($('menu').querySelector('[aria-busy="true"]')) return; // something is on its way: leave it
  const items = spotItems(game);
  if (JSON.stringify(items.map((item) => [item.id, item.label, item.note ?? null, !!item.disabled])) === menuKey) return;
  renderMenu(items, { keepFocus: true });
}

// ---------- support ----------

function renderSupport() {
  mountSupport($('support'));
  mountNav({ current: 'The Hall' });
}

// ---------- identity badge ----------

/** Refreshes who this is, their purse and their seats. Returns false if that couldn't be found out just now. */
/** What this browser has brought to the Hall, if it signed at the door. */
async function doorSession() {
  const token = store.get('cage.door');
  if (!hall.features?.tnight || !token) return null;
  try {
    const door = await api('GET', '/door/me', { token });
    return door.status === 'verified' && !door.expired ? door : null;
  } catch {
    return null;
  }
}
const cageWhole = (star) => Math.floor(Number(star) / 1_000_000).toLocaleString();
/**
 * What the cage holds for them now, in stars: the door's figure (the judge's last read, which moves only when a table settles), or,
 * while a tNIGHT seat holds the balance, what waits behind the seat plus the live stack on the table: what a cash-out pays (11-07: the
 * header said 145 all session while the cage paid 186).
 */
function cageLiveStar() {
  const seat = tnightSeats.find((x) => x.live != null);
  if (seat) return BigInt(seat.live) * 1_000_000n;
  return door?.balanceStar ?? 0n;
}
const doorTnight = (door) => (door.balanceStar === null ? 'tNIGHT at the door' : `tNIGHT: ${cageWhole(cageLiveStar())} in the cage`);

/** What the cage page last read from the wallet, within the hour: "4,929 in Lace". Nothing older: this page has no wallet of its own. */
function walletRead() {
  try {
    const w = JSON.parse(store.get(WALLET_KEY));
    return w && Date.now() - w.at < 60 * 60_000 ? `${cageWhole(w.night)} in ${w.name}` : null;
  } catch {
    return null;
  }
}

/** tNIGHT tables where this browser holds a seat token that still works: the way back, by game and table, as the chip seats have. */
async function tnightSeatsNow() {
  const held = [];
  for (const game of games) {
    for (const table of game.tables) {
      const token = table.tnight ? store.get(seatKey(table.id)) : null;
      if (!token) continue;
      try {
        const [mine, view] = await Promise.all([api('GET', `${game.api}/${table.id}/me`, { token }), api('GET', `${game.api}/${table.id}`)]);
        const seat = view.seats?.[mine.seat];
        const cageSeat = view.cage?.seats?.find((x) => x.seat === mine.seat);
        if (seat && !seat.left && view.phase !== 'over') held.push({ game: game.id, page: game.page, tableId: table.id, n: table.table, stack: seat.chips, live: cageSeat ? (cageSeat.behind ?? 0) + seat.chips : null });
      } catch { /* not a seat any more */ }
    }
  }
  return held.sort((a, b) => b.stack - a.stack);
}

/** The banner says the balance for the way they play. Chips: the purse. tNIGHT: the cage, and the wallet as the cage page last read it. Never the other. */
function paintWho() {
  if (mode() === 'tnight') {
    const name = door?.name ?? me?.name ?? '';
    $('who').replaceChildren(h('span', { class: 'who-line', id: 'who-line', text: [name, door ? doorTnight(door) : 'tNIGHT: nothing in the cage yet', walletRead()].filter(Boolean).join(' · ') }));
    $('topup').hidden = true;
    return;
  }
  if (!me) {
    $('who').replaceChildren();
    $('topup').hidden = true;
    return;
  }
  const atTable = seats.reduce((sum, seat) => sum + seat.stack, 0);
  // the name and purse only: the Player ID is never on screen unless its owner taps Show in the Player ID panel (screenshots get posted)
  $('who').replaceChildren(h('span', { class: 'who-line', id: 'who-line', text: `${me.name} · Purse: ${me.purse.amount}${atTable ? ` (+${atTable} on the table)` : ''}` }));
  $('topup').hidden = !me.topUp || me.purse.readOnly;
}

async function renderWho() {
  const token = store.get(PLAYER_KEY);
  // All at once: the greeting waits for these, and a tap in that window shouldn't have to wait for three round trips.
  const [doorNow, found, held] = await Promise.all([
    doorSession(),
    token ? Promise.all([api('GET', '/players/me', { token }), api('GET', '/players/me/seats', { token })]).catch((err) => ({ err })) : null,
    tnightOn() ? tnightSeatsNow() : [],
  ]);
  door = doorNow;
  tnightSeats = held;
  labelCage(); // the plate on the map says what the cage holds
  let known = false;
  if (found && !found.err) {
    [me, { seats }] = found;
    myLook = me.avatar;
    known = true;
  } else if (found?.err?.status === 401) {
    store.remove(PLAYER_KEY);
    me = null;
    seats = [];
  }
  paintWho();
  renderInPlay();
  return known;
}

// ---------- start ----------

async function refresh() {
  try {
    games = (await api('GET', '/games')).games;
    $('room-status').textContent = '';
    placeSpots();
    renderInPlay();
    refreshSign();
  } catch {
    $('room-status').textContent = 'Can’t reach the tables just now. Trying again…';
  }
}

/** The portrait in the dialogue: the original doorman's, or the setting's figure with its face cropped, as the seats do. */
function paintDoormanLook() {
  const portrait = document.querySelector('.portrait');
  const look = doormanLook();
  const name = hall?.name ?? 'the doorman';
  $('doorman').setAttribute('aria-label', `Talk to ${name}, the doorman`);
  $('dialogue').setAttribute('aria-label', `${name} speaks`);
  if (doorAt) placeDoorman(doorAt);
  if (!look) {
    if (art.portrait) portrait.style.backgroundImage = `url(${HALL_ART}${art.portrait.file})`;
    return;
  }
  const [fx, fy, across] = look.face;
  // The sheet is two frames side by side. Sized for a 72 px box here; the sheet doubles with the box (inn.css), so the second frame
  // never shows beside the first (11-07: "two Tallys"). Read nothing from the box: it may not be laid out yet.
  const k = 72 / across;
  portrait.classList.add('cropped');
  portrait.style.backgroundImage = `url(${look.file.startsWith('/') ? look.file : HALL_ART + look.file})`;
  portrait.style.setProperty('--pw', `${look.w * 2 * k}px`);
  portrait.style.setProperty('--ph', `${look.h * k}px`);
  portrait.style.setProperty('--px', `${-fx * k}px`);
  portrait.style.setProperty('--py', `${-fy * k}px`);
}

async function start() {
  setupSound($('sound'));
  settings = setupSettings({
    current: () => me,
    opening: () => { $('dialogue').hidden = true; },
    changed: async () => {
      me = null;
      seats = [];
      await renderWho();
      await readLeft();
      renderInPlay();
      showGreeting();
    },
  });
  $('topup').addEventListener('click', async (e) => {
    const release = pressing(e.currentTarget, 'Topping up');
    try {
      await api('POST', '/players/me/topup', { token: store.get(PLAYER_KEY) });
    } catch { /* the next refresh shows the real balance */ }
    await renderWho();
    release();
  });
  renderSupport();
  renderFilters();
  $('tables-new').addEventListener('click', takeSeatFromList);
  const hallComing = api('GET', '/hall'); // alongside the art, not after it: the art's checks are two dozen requests
  await loadArt();
  for (const sprite of Object.values(art.sprites ?? {})) new Image().src = HALL_ART + sprite.file; // so the look picker opens with its faces drawn
  paintDoormanLook(); // Tally, at the door and in the portrait, from the first paint
  fit();
  window.addEventListener('resize', fit);
  try {
    hall = await hallComing;
    games = hall.games;
    paintDoormanLook();
    placeSpots();
    const asked = params.get('mode'); // a link can say the way to play, as the cage page's Go to the Hall does
    if (tnightOn() && (asked === 'chips' || asked === 'tnight')) setMode(asked);
    await renderWho(); // before the greeting, so a live seat is its first line
    await readLeft();
    renderInPlay();
    const wanted = games.find((g) => g.id === params.get('play')); // from the top bar's Games menu: sit down there, as Take a seat would, the way they play
    if (asked || params.has('play') || params.has('player-id')) window.history.replaceState(null, '', '/');
    if (params.has('player-id')) settings.open(); // Menu → Player → Player ID, from another page
    if (wanted && wanted.status === 'live') {
      userOpened = true;
      if (store.get(PLAYER_KEY) && me && !hasValidLook(me)) askLookHere(() => playGame(wanted)); // the Games menu is a door too
      else playGame(wanted);
    } else if (!userOpened) showGreeting(); // they may have opened a sign while that loaded: the greeting doesn't write over it
    if (!(wanted && wanted.status === 'live') && userOpened) refreshSign();
  } catch {
    $('room-status').textContent = 'The door’s stuck. Trying again…';
    hall = null;
  }
  window.addEventListener('pageshow', async (e) => { // back from a table, out of the browser's cache
    if (!e.persisted || !hall) return;
    await renderWho();
    await readLeft();
    showGreeting();
  });
  setInterval(() => {
    if (!document.hidden) {
      refresh();
      renderWho();
    }
  }, POLL_MS);
}

start();
