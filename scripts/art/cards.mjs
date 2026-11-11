// Draws the card fronts in-house: parchment, rank and suit in both corners, classic pip layouts, and original
// little portraits for J, Q and K. Drawn on an 84×120 grid and written at twice that, so a phone or a retina
// screen shows every art pixel sharply.
//   npm run art:cards

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Img, encodePng } from './lib.js';

export const CARD = { w: 84, h: 120, export: 2 };
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

export const SUIT_COLOURS = {
  h: { base: hex('#c4202e'), dark: hex('#7c0f1e'), light: hex('#ec6a62') }, // hearts: red
  d: { base: hex('#d9481c'), dark: hex('#8f2410'), light: hex('#f58a4c') }, // diamonds: crimson-orange
  s: { base: hex('#1e1b26'), dark: hex('#0c0a12'), light: hex('#4d4a5e') }, // spades: near-black
  c: { base: hex('#123a2c'), dark: hex('#071a14'), light: hex('#2f6d55') }, // clubs: deep green-black
};

const PARCHMENT = hex('#efe0bd');
const INK = hex('#241a14');
const GOLD = { base: hex('#c8962e'), dark: hex('#7e5a18'), light: hex('#f0d27a') };
const SKIN = { base: hex('#e6b48c'), dark: hex('#b57f5c'), light: hex('#f6d3b0') };

function noise(x, y, seed = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(w * h * 4);
  }

  put(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.d[i] = c[0];
    this.d[i + 1] = c[1];
    this.d[i + 2] = c[2];
    this.d[i + 3] = 255;
  }

  get(x, y) {
    const i = (y * this.w + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2]];
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, c);
  }

  /** A shaded oval: light towards the upper left, dark on its rim. */
  oval(cx, cy, rx, ry, { base, dark, light }, { clipBelow = Infinity } = {}) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const d = nx * nx + ny * ny;
        if (d > 1 || y > clipBelow) continue;
        const lit = -nx * 0.6 - ny * 0.7;
        this.put(x, y, d > 0.72 ? dark : lit > 0.42 ? light : base);
      }
    }
  }

  /** Rotates a region 180° onto another position: the mirrored half of a court card. */
  rotateInto(x0, y0, w, h, toX, toY) {
    const copy = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) copy.push(this.get(x0 + x, y0 + y));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.put(toX + w - 1 - x, toY + h - 1 - y, copy[y * w + x]);
  }
}

// ---------- suit shapes: u, v run -1 to 1 across the box ----------

const inHeart = (u, v) => {
  const x = u * 1.14;
  const y = -(v - 0.12) * 1.14;
  return (x * x + y * y - 1) ** 3 - x * x * y ** 3 <= 0;
};
const inStem = (u, v) => v > 0.28 && v <= 1 && Math.abs(u) < 0.07 + (v - 0.28) * 0.42;

const SHAPES = {
  h: inHeart,
  d: (u, v) => Math.abs(u) / 0.78 + Math.abs(v) <= 1,
  s: (u, v) => inHeart(u * 0.98, -(v + 0.18) * 1.12 + 0.12) || inStem(u, v),
  c: (u, v) => {
    const round = (cx, cy, r) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
    return round(0, -0.5, 0.44) || round(-0.5, 0.12, 0.44) || round(0.5, 0.12, 0.44) || (Math.abs(u) < 0.2 && Math.abs(v) < 0.4) || inStem(u, v);
  },
};

/** Draws one pip, sharp and shaded, centred at cx, cy. `flip` turns it upside down, as on the card's lower half. */
export function pip(canvas, cx, cy, size, suit, flip = false) {
  const shape = SHAPES[suit];
  const { base, dark, light } = SUIT_COLOURS[suit];
  const half = size / 2;
  const hit = (px, py) => {
    const u = (px - cx + 0.5) / half;
    const v = (py - cy + 0.5) / half;
    return shape(flip ? -u : u, flip ? -v : v);
  };
  for (let y = Math.floor(cy - half) - 1; y <= cy + half + 1; y++) {
    for (let x = Math.floor(cx - half) - 1; x <= cx + half + 1; x++) {
      if (!hit(x, y)) continue;
      const rim = !hit(x - 1, y) || !hit(x + 1, y) || !hit(x, y - 1) || !hit(x, y + 1);
      const up = !hit(x - 2, y - 2) && !rim;
      canvas.put(x, y, rim && size > 8 ? dark : up ? light : base);
    }
  }
}

// ---------- rank glyphs: 6×9, drawn at double size ----------

const GLYPHS = {
  2: ['.####.', '##..##', '....##', '...##.', '..##..', '.##...', '##....', '##..##', '######'],
  3: ['.####.', '##..##', '....##', '...##.', '..###.', '....##', '....##', '##..##', '.####.'],
  4: ['...##.', '..###.', '.####.', '##.##.', '##.##.', '######', '...##.', '...##.', '..####'],
  5: ['######', '##....', '##....', '#####.', '....##', '....##', '....##', '##..##', '.####.'],
  6: ['.####.', '##..##', '##....', '#####.', '##..##', '##..##', '##..##', '##..##', '.####.'],
  7: ['######', '##..##', '....##', '...##.', '...##.', '..##..', '..##..', '..##..', '..##..'],
  8: ['.####.', '##..##', '##..##', '.####.', '.####.', '##..##', '##..##', '##..##', '.####.'],
  9: ['.####.', '##..##', '##..##', '##..##', '.#####', '....##', '....##', '##..##', '.####.'],
  1: ['..##', '.###', '####', '..##', '..##', '..##', '..##', '..##', '####'],
  0: ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  J: ['..####', '...##.', '...##.', '...##.', '...##.', '...##.', '##.##.', '##.##.', '.###..'],
  Q: ['.####.', '##..##', '##..##', '##..##', '##..##', '##.###', '##.###', '##..##', '.###.#'],
  K: ['##..##', '##.##.', '####..', '###...', '###...', '####..', '##.##.', '##..##', '##..##'],
  A: ['..##..', '.####.', '##..##', '##..##', '##..##', '######', '##..##', '##..##', '##..##'],
};

function rankGlyph(canvas, rank, x, y, colour, flip, w) {
  const text = rank === 'T' ? '10' : rank;
  let at = 0;
  for (const ch of text) {
    const rows = GLYPHS[ch];
    rows.forEach((row, j) => [...row].forEach((bit, i) => {
      if (bit !== '#') return;
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          const px = x + at + i * 2 + a;
          const py = y + j * 2 + b;
          canvas.put(flip ? w - 1 - px : px, flip ? CARD.h - 1 - py : py, colour);
        }
      }
    }));
    at += rows[0].length * 2 + 1;
  }
}

// ---------- layouts ----------

const L = 30;
const M = 42;
const R = 54;
const Y = { top: 24, up: 48, mid: 60, down: 72, bot: 96, a: 42, b: 78 };
const LAYOUT = {
  2: [[M, Y.top], [M, Y.bot]],
  3: [[M, Y.top], [M, Y.mid], [M, Y.bot]],
  4: [[L, Y.top], [R, Y.top], [L, Y.bot], [R, Y.bot]],
  5: [[L, Y.top], [R, Y.top], [M, Y.mid], [L, Y.bot], [R, Y.bot]],
  6: [[L, Y.top], [R, Y.top], [L, Y.mid], [R, Y.mid], [L, Y.bot], [R, Y.bot]],
  7: [[L, Y.top], [R, Y.top], [M, Y.a], [L, Y.mid], [R, Y.mid], [L, Y.bot], [R, Y.bot]],
  8: [[L, Y.top], [R, Y.top], [M, Y.a], [L, Y.mid], [R, Y.mid], [M, Y.b], [L, Y.bot], [R, Y.bot]],
  9: [[L, Y.top], [R, Y.top], [L, Y.up], [R, Y.up], [M, Y.mid], [L, Y.down], [R, Y.down], [L, Y.bot], [R, Y.bot]],
  T: [[L, Y.top], [R, Y.top], [M, 36], [L, Y.up], [R, Y.up], [L, Y.down], [R, Y.down], [M, 84], [L, Y.bot], [R, Y.bot]],
};
export const pipCount = (rank) => LAYOUT[rank]?.length ?? 0;

// ---------- court portraits: the top half is drawn, the bottom half is that turned round ----------

const ROBES = {
  h: { base: hex('#b4242e'), dark: hex('#6e101c'), light: hex('#e0605a') },
  d: { base: hex('#c9581f'), dark: hex('#7e3010'), light: hex('#ee9a54') },
  s: { base: hex('#37344c'), dark: hex('#16141f'), light: hex('#6c6a88') },
  c: { base: hex('#21604a'), dark: hex('#0c2c22'), light: hex('#4d9a7c') },
};
const HAIR = {
  h: { base: hex('#8a4a22'), dark: hex('#54280f'), light: hex('#b8733c') },
  d: { base: hex('#c98f3a'), dark: hex('#8a5c1e'), light: hex('#ecc16e') },
  s: { base: hex('#2c2830'), dark: hex('#141216'), light: hex('#544e5c') },
  c: { base: hex('#6b4a2a'), dark: hex('#3e2a16'), light: hex('#967044') },
};

function portrait(g, rank, suit) {
  const robe = ROBES[suit];
  const hair = HAIR[suit];
  const cx = 42;
  const headY = 32;

  // Long hair behind the queen's shoulders.
  if (rank === 'Q') g.oval(cx, headY + 7, 14, 19, hair);

  // Shoulders and robe, down to the card's midline.
  for (let y = 44; y <= 60; y++) {
    const halfW = Math.min(23, 9 + (y - 44) * 1.6);
    for (let x = -Math.floor(halfW); x <= halfW; x++) {
      const edge = Math.abs(x) > halfW - 1.5;
      const fold = (x + 40) % 9 === 0 && y > 48;
      g.put(cx + x, y, edge ? robe.dark : fold ? robe.dark : x < -3 && y < 52 ? robe.light : robe.base);
    }
  }
  // Gold collar and a chain or a tunic line, by rank.
  for (let i = 0; i <= 8; i++) {
    g.put(cx - i, 44 + i, GOLD.light);
    g.put(cx + i, 44 + i, GOLD.base);
    g.put(cx - i, 45 + i, GOLD.dark);
    g.put(cx + i, 45 + i, GOLD.dark);
  }
  if (rank === 'K') {
    g.rect(cx - 1, 47, 3, 13, GOLD.base);
    g.rect(cx, 47, 1, 13, GOLD.light);
  } else if (rank === 'Q') {
    g.oval(cx, 53, 3, 3, GOLD);
  }

  // Neck and head.
  g.rect(cx - 3, 40, 7, 6, SKIN.dark);
  g.oval(cx, headY, 9, 11, SKIN);

  // Face: eyes, brows, nose, mouth.
  for (const side of [-4, 3]) {
    g.rect(cx + side, headY - 1, 2, 2, INK);
    g.put(cx + side, headY - 1, [250, 245, 235]);
    g.rect(cx + side - 1, headY - 3, 4, 1, hair.dark);
  }
  g.rect(cx, headY, 1, 4, SKIN.dark);
  g.rect(cx - 2, headY + 6, 5, 1, rank === 'Q' ? hex('#b02a38') : hex('#8a4a3a'));

  if (rank === 'J') {
    // Short hair, and a feathered cap.
    g.oval(cx - 9, headY + 1, 3, 7, hair);
    g.oval(cx + 9, headY + 1, 3, 7, hair);
    g.oval(cx, headY - 9, 12, 5, robe, { clipBelow: headY - 7 });
    g.rect(cx - 12, headY - 7, 25, 2, GOLD.base);
    g.rect(cx - 12, headY - 7, 25, 1, GOLD.light);
    for (let i = 0; i < 7; i++) { // a short feather in the band
      const y = headY - 8 - Math.round(i * 0.9);
      g.rect(cx + 8 + i, y, 2, 1, GOLD.light);
      g.put(cx + 8 + i, y + 1, GOLD.base);
    }
  } else if (rank === 'Q') {
    // A fringe, and a fine tiara.
    g.oval(cx, headY - 8, 10, 5, hair, { clipBelow: headY - 5 });
    for (const [x, tall] of [[-7, 2], [-3, 4], [0, 6], [3, 4], [7, 2]]) g.rect(cx + x, headY - 11 - tall, 1, tall, GOLD.light);
    g.rect(cx - 8, headY - 11, 17, 2, GOLD.base);
    g.rect(cx - 1, headY - 14, 3, 3, SUIT_COLOURS[suit].light);
  } else {
    // A full beard and moustache, and a tall crown.
    for (let y = headY + 3; y <= headY + 14; y++) {
      const halfW = Math.max(1, 9.5 - Math.max(0, y - headY - 7) * 1.1);
      for (let x = -Math.floor(halfW); x <= halfW; x++) {
        if (y < headY + 7 && Math.abs(x) < 6) continue;
        g.put(cx + x, y, (x + y) % 3 === 0 ? hair.light : (x + y) % 5 === 0 ? hair.dark : hair.base);
      }
    }
    g.rect(cx - 4, headY + 4, 9, 2, hair.base);
    g.rect(cx - 1, headY + 6, 3, 1, hex('#8a4a3a'));
    g.rect(cx - 11, headY - 11, 23, 4, GOLD.base);
    g.rect(cx - 11, headY - 11, 23, 1, GOLD.light);
    g.rect(cx - 11, headY - 8, 23, 1, GOLD.dark);
    for (const x of [-11, -5, 0, 5, 11]) {
      for (let k = 0; k < 7; k++) {
        const width = Math.max(0, 2 - (k >> 1));
        for (let w = -width; w <= width; w++) g.put(cx + x + w, headY - 12 - k, k === 6 ? GOLD.light : GOLD.base);
      }
    }
    g.rect(cx - 1, headY - 10, 3, 2, SUIT_COLOURS[suit].light);
  }
}

// ---------- a whole card ----------

export function drawCard(rank, suit) {
  const { w, h } = CARD;
  const g = new Canvas(w, h);
  const seed = RANKS.indexOf(rank) * 13 + SUITS.indexOf(suit);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Warm parchment: slow blotches, a little grain, a touch darker towards the edge.
      const blotch = Math.sin(x * 0.11 + seed) * Math.cos(y * 0.09 + seed * 0.5) * 5;
      const grain = (noise(x, y, seed) - 0.5) * 7;
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const fade = edge < 5 ? (5 - edge) * 3 : 0;
      g.put(x, y, PARCHMENT.map((v, k) => Math.round(v + blotch + grain - fade * (k === 2 ? 1.5 : 1))));
    }
  }
  const { base } = SUIT_COLOURS[suit];

  if ('JQK'.includes(rank)) {
    const frame = { x: 18, y: 12, w: 48, h: 96 };
    for (let y = frame.y; y < frame.y + frame.h; y++) {
      for (let x = frame.x; x < frame.x + frame.w; x++) {
        const c = g.get(x, y);
        g.put(x, y, [c[0] - 16, c[1] - 12, c[2] - 2]); // a slightly cooler panel
      }
    }
    portrait(g, rank, suit);
    g.rotateInto(frame.x, frame.y, frame.w, 48, frame.x, frame.y + 48);
    g.rect(frame.x, 59, frame.w, 2, GOLD.base);
    g.rect(frame.x, 59, frame.w, 1, GOLD.light);
    for (let i = 0; i < frame.w; i++) {
      g.put(frame.x + i, frame.y, base);
      g.put(frame.x + i, frame.y + frame.h - 1, base);
    }
    for (let i = 0; i < frame.h; i++) {
      g.put(frame.x, frame.y + i, base);
      g.put(frame.x + frame.w - 1, frame.y + i, base);
    }
    pip(g, frame.x + 8, frame.y + 8, 12, suit);
    pip(g, frame.x + frame.w - 8, frame.y + frame.h - 9, 12, suit, true);
  } else if (rank === 'A') {
    pip(g, 42, 60, 40, suit);
  } else {
    for (const [x, y] of LAYOUT[rank]) pip(g, x, y, 17, suit, y > Y.mid);
  }

  // Rank and suit in both corners; the lower right is the upper left turned round.
  const narrow = rank === 'T';
  rankGlyph(g, rank, narrow ? 2 : 3, 4, base, false, w);
  pip(g, 9, 30, 13, suit);
  rankGlyph(g, rank, narrow ? 2 : 3, 4, base, true, w);
  pip(g, w - 10, h - 31, 13, suit, true);
  return g;
}

/** Everything on one sheet, rows clubs to spades, columns 2 to Ace, on the grid. */
export function drawAtlas() {
  const { w, h } = CARD;
  const sheet = new Canvas(w * 13, h * 4);
  [...SUITS].forEach((suit, row) => [...RANKS].forEach((rank, col) => {
    const card = drawCard(rank, suit);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sheet.put(col * w + x, row * h + y, card.get(x, y));
  }));
  return sheet;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { buildPalette, toIndexed } = await import('./ingest.mjs');
  const sheet = drawAtlas();
  const palette = buildPalette([sheet], 128);
  const small = toIndexed(sheet, palette);
  const k = CARD.export;
  const big = new Img(small.w * k, small.h * k);
  for (let y = 0; y < big.h; y++) for (let x = 0; x < big.w; x++) big.d[y * big.w + x] = small.d[(y >> 1) * small.w + (x >> 1)];
  writeFileSync(new URL('../../public/art/cards/cards.png', import.meta.url), encodePng(big, palette));
  console.log(`cards.png ${big.w}×${big.h}, ${palette.length} colours`);
}
