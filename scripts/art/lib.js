// A tiny pixel-art toolkit. Everything is drawn in palette indices, so no image can use a colour outside
// the 32-colour palette, and images are written as indexed PNGs with Node's own zlib.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Each ramp runs dark to light. Index 0 is transparent.
const RAMPS = {
  ink: ['#0a0816'],
  night: ['#141230', '#221d4a', '#352e6e', '#4f4796'], // walls, shadow, the night itself
  slate: ['#2a2f52', '#454f78', '#6f7ca6', '#a9b6d6'], // stone, steel, moonlight
  plank: ['#2a1a2e', '#42263a', '#5c3542', '#7f4b2b'], // floor boards, in the dark; the top step is shared with oak
  oak: ['#55301f', '#7f4b2b', '#ad723d', '#d6a05c'], // furniture, lit
  amber: ['#a4501a', '#e08a24', '#ffc24d', '#ffeaa0'], // lantern light
  felt: ['#11383c', '#1a5650', '#2a7d68'], // card table
  wine: ['#3f1230', '#761c38', '#ad3040', '#d9604f'], // rug, wax, hearts
  skin: ['#8a5548', '#c58868', '#efc096'],
  cream: ['#b9b2c4', '#f4efe2'],
};

export const R = {};
const hex = [];
for (const [name, list] of Object.entries(RAMPS)) {
  R[name] = list.map((color) => {
    if (!hex.includes(color)) hex.push(color);
    return hex.indexOf(color) + 1; // 1-based; 0 is transparent
  });
}
export const PALETTE = hex;
if (PALETTE.length > 32) throw new Error(`palette has ${PALETTE.length} colours`);

export const INK = R.ink[0];
const BAYER = [[0, 2], [3, 1]];

export class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(w * h);
  }

  get(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.d[y * this.w + x];
  }

  px(x, y, c) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c;
    return this;
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
    return this;
  }

  /** Fills with fn(x, y) → colour (0 = leave as is). */
  area(x, y, w, h, fn) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const c = fn(x + i, y + j, i, j);
      if (c) this.px(x + i, y + j, c);
    }
    return this;
  }

  line(x0, y0, x1, y1, c) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) this.px(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), c);
    return this;
  }

  /** A shaded, roughly round shape, lit from upper left, with dithered steps between ramp colours. */
  ball(cx, cy, rx, ry, ramp, { light = 0.35, topOnly = false } = {}) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const d = nx * nx + ny * ny;
        if (d > 1 || (topOnly && y > cy)) continue;
        this.px(x, y, shade(ramp, x, y, light + (-nx * 0.45 - ny * 0.55) * 0.75));
      }
    }
    return this;
  }

  /** A filled polygon with fn(x, y) → colour. */
  poly(points, fn) {
    const ys = points.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const hits = [];
      for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        if (y0 === y1) continue;
        if (y + 0.5 >= Math.min(y0, y1) && y + 0.5 < Math.max(y0, y1)) hits.push(x0 + ((y + 0.5 - y0) / (y1 - y0)) * (x1 - x0));
      }
      hits.sort((a, b) => a - b);
      for (let k = 0; k + 1 < hits.length; k += 2) {
        for (let x = Math.round(hits[k]); x < Math.round(hits[k + 1]); x++) {
          const c = typeof fn === 'function' ? fn(x, y) : fn;
          if (c) this.px(x, y, c);
        }
      }
    }
    return this;
  }

  /** Dark outline around everything non-transparent. */
  outline(c = INK) {
    const out = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y)) continue;
      if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) out.push([x, y]);
    }
    for (const [x, y] of out) this.px(x, y, c);
    return this;
  }

  blit(src, x = 0, y = 0) {
    for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) {
      const c = src.d[j * src.w + i];
      if (c) this.px(x + i, y + j, c);
    }
    return this;
  }

  /** Copies a region out as a new image. */
  crop(x, y, w, h) {
    const out = new Img(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.d[j * w + i] = this.get(x + i, y + j);
    return out;
  }

  /** Swaps colours: map is { from: to }. */
  recolor(map) {
    const out = new Img(this.w, this.h);
    for (let i = 0; i < this.d.length; i++) out.d[i] = map[this.d[i]] ?? this.d[i];
    return out;
  }

  /** Text in the 3×5 font. */
  text(str, x, y, c) {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const glyph = TINY[ch];
      if (glyph) glyph.forEach((row, j) => [...row].forEach((bit, i) => { if (bit === '#') this.px(cx + i, y + j, c); }));
      cx += 4;
    }
    return this;
  }
}

/** Picks from a ramp by a 0..1 value, dithering between neighbouring steps. */
export function shade(ramp, x, y, value) {
  const v = Math.max(0, Math.min(0.999, value)) * (ramp.length - 1);
  const low = Math.floor(v);
  const threshold = (BAYER[y & 1][x & 1] + 0.5) / 4;
  return ramp[Math.min(ramp.length - 1, v - low > threshold ? low + 1 : low)];
}

/** Repeatable noise for tile variation. */
export function makeNoise(start = 1) {
  let a = start | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TINY = {
  A: ['###', '#.#', '###', '#.#', '#.#'], C: ['###', '#..', '#..', '#..', '###'], E: ['###', '#..', '##.', '#..', '###'],
  G: ['###', '#..', '#.#', '#.#', '###'], I: ['###', '.#.', '.#.', '.#.', '###'], M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['###', '#.#', '#.#', '#.#', '###'], S: ['###', '#..', '###', '..#', '###'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'], ' ': ['...', '...', '...', '...', '...'],
};

// ---------- PNG ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(4 + typed.length + 4);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 4 + typed.length);
  return out;
}

export function encodePng(img, palette = PALETTE) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.w, 0);
  header.writeUInt32BE(img.h, 4);
  header[8] = 8; // bit depth
  header[9] = 3; // indexed colour
  const plte = Buffer.alloc((palette.length + 1) * 3);
  palette.forEach((color, i) => {
    plte[(i + 1) * 3] = parseInt(color.slice(1, 3), 16);
    plte[(i + 1) * 3 + 1] = parseInt(color.slice(3, 5), 16);
    plte[(i + 1) * 3 + 2] = parseInt(color.slice(5, 7), 16);
  });
  const trns = Buffer.from([0]); // only index 0 is transparent
  const raw = Buffer.alloc((img.w + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w + 1)] = 0;
    Buffer.from(img.d.buffer, img.d.byteOffset + y * img.w, img.w).copy(raw, y * (img.w + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const save = (img, path, palette = PALETTE) => writeFileSync(path, encodePng(img, palette));
