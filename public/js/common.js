// Shared by the room and the table page: API calls, identity storage, scaling, sprites, sound.
// Tokens only ever travel in the Authorization header, never in a URL.

export async function api(method, path, { body, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message ?? `Request failed (${res.status}).`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

const memory = new Map(); // keeps the page working if browser storage is blocked

export const store = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch { /* memory only */ }
  },
  remove(key) {
    memory.delete(key);
    try {
      localStorage.removeItem(key);
    } catch { /* memory only */ }
  },
};

export const PLAYER_KEY = 'hall.player';
export const seatKey = (tableId) => `hall.seat.${tableId}`;
export const LEFT_KEY = 'hall.left'; // the table this browser last left: { id, page, amount, told }
export const MODE_KEY = 'hall.mode'; // how they play, as they chose at the door: 'chips' or 'tnight'. The Hall and the tables keep to it

/** Build an element. `props` may hold class, dataset, text, on<Event>, and attributes. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'vars') for (const [name, v] of Object.entries(value)) el.style.setProperty(`--${name}`, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) el.append(child);
  return el;
}

/**
 * This round's public number and its page in the Records book: "Table 3 · Round 41". A play-chip table goes by the Hall's number
 * for it and the round the engine dealt; a tNIGHT table by its cage table and the round the chain counts it as (its receipt's).
 * Null before the first deal, and at a play table the Hall hasn't numbered yet: no record goes up without a number.
 */
export function roundRecord(view, game) {
  if (!view || !(view.round >= 1)) return null;
  const c = view.cage;
  const table = c ? c.table : view.n;
  const round = c ? (c.chainBase ?? 0) + view.round : view.round;
  if (!Number.isInteger(table) || !Number.isInteger(round)) return null;
  return { round, label: `Table ${table} · Round ${round}`, href: `/records/${game}/${c ? 't' : ''}${table}-${round}` };
}

/**
 * The phase line, with the round's number up front when the line starts with that round: "Table 3 · Round 41 · Bidding". The number
 * is not a link any more (11-07): a record of a round in play is nearly empty. Once the round has ended, the page shows a labelled
 * "This round's receipt" button beside it (receipt-window.js), and Records has the old rounds.
 * Left alone when nothing changed.
 */
export function paintPhase(el, text, record) {
  const lead = record ? `Round ${record.round}` : null;
  const numbered = !!lead && text.startsWith(lead) && !/^\d/.test(text.slice(lead.length));
  const rest = numbered ? text.slice(lead.length) : text;
  const number = el.querySelector('.round-no');
  if (numbered ? !!number && el.textContent === record.label + rest : !number && el.textContent === text) return;
  if (!numbered) {
    el.textContent = text;
    return;
  }
  el.replaceChildren(h('span', { class: 'round-no', id: 'round-no', title: 'This round’s public number', text: record.label }), rest);
}

/** The largest scale that keeps pixels whole on this screen, in CSS pixels. Never below 1 device step. */
export function fitScale(available, native) {
  const ratio = window.devicePixelRatio || 1;
  return Math.max(1, Math.floor((available * ratio) / native)) / ratio;
}

/**
 * For the painted room and table. On a phone they fill the width: whole device pixels when that's within a
 * few percent, otherwise an exact fit, smoothed (`soft`) because uneven pixels shimmer. Elsewhere, whole pixels.
 */
/**
 * Narrow and short (a phone, or half a laptop screen): the page shows only a band of the table scene, from just above the
 * heads (or the far cups) down through the pot, and the scene is scaled so that band is CROP_BAND_PX tall. The wall and
 * window above are what goes. The hand and the move sit where they always did, and every face and the pot stay in frame.
 * \`top\` and \`bottom\` are fractions of the scene's height that are cut off. Returns { s, soft, top, bottom }.
 */
export const CROP_QUERY = '(max-width: 979px)'; // any narrow screen (Phase A, 11-07): the hand and the move come first, the room is a band under them
export const CROP_BAND_PX = 150;
export function cropScene(s, soft, sceneH, { top, bottom }) {
  if (!window.matchMedia(CROP_QUERY).matches) return { s, soft, top: 0, bottom: 0 };
  const fits = CROP_BAND_PX / ((1 - top - bottom) * sceneH);
  return fits < s ? { s: fits, soft: true, top, bottom } : { s, soft, top, bottom };
}

export function pageScale(available, native) {
  if (available >= 640) return { scale: fitScale(available, native), soft: false };
  const ratio = window.devicePixelRatio || 1;
  const steps = (available * ratio) / native;
  if (steps >= 1 && steps - Math.floor(steps) < 0.06) return { scale: Math.floor(steps) / ratio, soft: false };
  return { scale: available / native, soft: true };
}

// ---------- art: the painted set from public/art/hall/, falling back to the code-drawn sprites ----------

export const HALL_ART = '/art/hall/';
export let art = {};

function filesIn(entry, out = []) {
  for (const value of Object.values(entry ?? {})) {
    if (value?.file) out.push(value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) filesIn(value, out);
  }
  return out;
}

function dropMissing(entry, missing) {
  for (const [key, value] of Object.entries(entry)) {
    if (missing.has(value)) delete entry[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) dropMissing(value, missing);
  }
}

/** Reads the manifest and checks each file is there. Anything missing just stays code-drawn. */
export async function loadArt() {
  try {
    const res = await fetch(`${HALL_ART}manifest.json`);
    if (!res.ok) return art;
    const manifest = await res.json();
    const missing = new Set();
    await Promise.all(filesIn(manifest).map(async (entry) => {
      const file = await fetch(HALL_ART + entry.file, { method: 'HEAD' }).catch(() => null);
      if (!file?.ok) missing.add(entry);
    }));
    dropMissing(manifest, missing);
    art = manifest;
  } catch { /* the code-drawn set */ }
  return art;
}

// Tally has no code-drawn figure, so it borrows the adventurer's.
const SEAT_ART = { 'Tally · house': ['seat-adventurer', 'tally'], Brannock: ['seat-brannock', 'brannock'], 'Old Wick': ['seat-oldwick', 'oldwick'] };

/** The looks with art here, in the order the server gives them. */
export const looksAvailable = (ids = []) => ids.filter((id) => art.sprites?.[id]);

/** A seat's two-frame sheet, its frame size, and where its face is: [x, y, size]. */
export function seatArt(seat) {
  const [drawn, painted] = (seat.kind === 'house' && SEAT_ART[seat.name]) || ['seat-adventurer', seat.avatar ?? 'adventurer'];
  const sprite = art.sprites?.[painted] ?? (drawn === 'seat-adventurer' ? art.sprites?.adventurer : null);
  if (sprite) return { url: HALL_ART + sprite.file, w: sprite.w, h: sprite.h, face: sprite.face };
  return { url: `/art/${drawn}.png`, w: 32, h: 48, face: [8, 2, 16] };
}

/** A small portrait: the face cut out of a seat's sprite sheet. */
export function faceEl(seat, size = 24) {
  const { url, w, h: height, face: [x, y, across] } = seatArt(seat);
  const k = size / across;
  const el = h('span', { class: 'face', 'aria-hidden': 'true' });
  el.style.backgroundImage = `url(${url})`;
  el.style.backgroundSize = `${w * 2 * k}px ${height * k}px`;
  el.style.backgroundPosition = `${-x * k}px ${-y * k}px`;
  return el;
}

/**
 * A press that takes a moment. The button goes busy at once, with its own wait word (the style adds the dots), and any other
 * buttons in `lock` go quiet until the answer. Returns the release: safe to call after the panel has been redrawn.
 */
export function pressing(button, wait = null, { lock = null } = {}) {
  if (!button || button.getAttribute('aria-busy') === 'true') return () => {};
  const was = { html: button.innerHTML, disabled: button.disabled };
  const others = lock ? [...lock.querySelectorAll('button')].filter((b) => b !== button && !b.disabled) : [];
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  if (wait) button.textContent = wait;
  for (const b of others) b.disabled = true;
  return () => {
    for (const b of others) if (b.isConnected) b.disabled = false;
    if (!button.isConnected) return; // redrawn since: nothing to put back
    button.removeAttribute('aria-busy');
    button.disabled = was.disabled;
    if (wait) button.innerHTML = was.html; // its own markup, as this page built it
  };
}

/** Every button in `box` but `except` waits until the release. For the rest of a panel while one press is on its way. */
export function locking(box, except = null) {
  const others = box ? [...box.querySelectorAll('button')].filter((b) => b !== except && !b.disabled) : [];
  for (const b of others) b.disabled = true;
  return () => { for (const b of others) if (b.isConnected) b.disabled = false; };
}

/** Leaves for another page. From this page's point of view that never finishes, so a busy button stays busy until it's gone. */
export function go(url) {
  window.location.href = url;
  return new Promise(() => {});
}

/** The button a click is landing on, caught before its own handler runs, so a send can mark it busy without every caller saying which. */
let lastPressed = null;
let lastPressedAt = 0;
document.addEventListener('click', (e) => { lastPressed = e.target.closest?.('button') ?? null; lastPressedAt = Date.now(); }, true);
export const pressedButton = () => (lastPressed?.isConnected && Date.now() - lastPressedAt < 1000 ? lastPressed : null);

export const MIDNIGHT = {
  symbol: '/brand/midnight/Midnight-RGB_Symbol-White.svg',
  horizontal: '/brand/midnight/Midnight-RGB_Logo-Horizontal-White.svg',
};

const SUITS = 'cdhs';
const RANKS = '23456789TJQKA';
const RANK_WORDS = { T: '10', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const SUIT_WORDS = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

/** Where a card lives in the atlas, and its spoken name. Display only. */
export function cardInfo(code) {
  return {
    col: RANKS.indexOf(code[0]),
    row: SUITS.indexOf(code[1]),
    name: `${RANK_WORDS[code[0]] ?? code[0]} of ${SUIT_WORDS[code[1]]}`,
  };
}

// ---------- sound: small square-wave clicks, muted until asked for ----------

const SOUND_KEY = 'hall.sound';
let audio = null;

export function isSoundOn() {
  return store.get(SOUND_KEY) === 'on';
}

export function blip(freq = 520, ms = 45) {
  if (!isSoundOn()) return;
  audio ??= new AudioContext();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.value = 0.04;
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + ms / 1000);
}

/**
 * Midnight Radio, beside the sound button on every page: a play/pause, off by default, and nothing is fetched until it's
 * pressed. The credit links to the station. Only where the server has a stream address (GET /radio).
 */
export async function mountRadio(soundButton) {
  if (!soundButton || document.getElementById('radio')) return;
  let radio = null;
  try {
    radio = (await api('GET', '/radio')).radio;
  } catch { /* no radio */ }
  if (!radio) return;
  const toggle = h('button', { type: 'button', class: 'btn small radio-toggle', id: 'radio-toggle', 'aria-pressed': 'false', title: radio.credit });
  const credit = h('a', { class: 'radio-credit', id: 'radio-credit', href: radio.link, target: '_blank', rel: 'noopener', text: radio.credit });
  const box = h('span', { class: 'radio', id: 'radio' }, toggle, credit);
  soundButton.after(box);
  let audio = null;
  const RADIO_KEY = 'hall.radio'; // "on" while the listener has it playing: the next page picks it up (each page is its own document)
  const paint = (on) => {
    toggle.replaceChildren(h('span', { class: 'radio-icon', 'aria-hidden': 'true', text: on ? '❚❚' : '▶' }), h('span', { class: 'radio-word', text: ' Radio' }));
    toggle.setAttribute('aria-pressed', String(on));
    toggle.setAttribute('aria-label', on ? 'Pause Midnight Radio' : 'Play Midnight Radio');
  };
  const say = (text) => { credit.textContent = text || radio.credit; credit.classList.toggle('offline', !!text); };
  const stop = () => {
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // drops the connection to the stream
      audio = null;
    }
    paint(false);
  };
  /** Starts the stream. `quiet`: a resume on a new page, which the browser may refuse; then it just waits to be pressed. */
  const start = ({ quiet = false } = {}) => {
    say('');
    audio = new Audio(radio.url);
    const a = audio;
    const lost = () => { // a dropped stream is a quiet "offline", not an error: pressing play tries again
      if (audio !== a) return;
      stop();
      store.remove(RADIO_KEY);
      say('Radio offline');
    };
    a.addEventListener('error', lost);
    a.addEventListener('stalled', () => setTimeout(() => { if (audio === a && a.readyState < 3 && !a.paused) lost(); }, 8000));
    a.addEventListener('ended', lost);
    a.addEventListener('playing', () => say(''));
    paint(true);
    store.set(RADIO_KEY, 'on');
    a.play().catch(() => {
      if (audio !== a) return;
      audio = null;
      paint(false);
      if (quiet) say(''); else { store.remove(RADIO_KEY); say('Radio offline'); }
    });
  };
  toggle.addEventListener('click', () => {
    if (audio) {
      stop();
      store.remove(RADIO_KEY);
      say('');
    } else start();
  });
  paint(false);
  if (store.get(RADIO_KEY) === 'on') start({ quiet: true });
}

export function setupSound(button) {
  const paint = () => {
    button.textContent = isSoundOn() ? 'Sound on' : 'Sound off';
    button.setAttribute('aria-pressed', String(isSoundOn()));
  };
  paint();
  button.addEventListener('click', () => {
    store.set(SOUND_KEY, isSoundOn() ? 'off' : 'on');
    paint();
    blip(660);
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('button, a.btn') && e.target !== button) blip();
  });
  mountRadio(button);
}
