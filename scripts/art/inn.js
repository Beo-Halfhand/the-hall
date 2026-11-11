// The inn: floor, walls, bar, rug, door, the table sprites, the rope and sign, cards and the wax seal.

import { Img, INK, R, makeNoise, shade } from './lib.js';
import { lantern } from './characters.js';

const T = 32;

// ---------- room ----------

function floorTile(g, tx, ty, noise) {
  const x0 = tx * T;
  const y0 = ty * T;
  for (let row = 0; row < 3; row++) {
    const y = y0 + row * 11 - (row === 2 ? 1 : 0);
    const h = row === 2 ? 10 : 10;
    const base = 0.4 + noise() * 0.1;
    g.area(x0, y, T, h, (x, yy) => shade(R.plank, x, yy, base + (Math.sin((x + row * 7 + tx * 11) * 0.31) + Math.sin(yy * 2.1 + x * 0.07)) * 0.03));
    g.rect(x0, y + h, T, 1, R.plank[0]); // the seam between boards
    const joint = x0 + Math.floor(noise() * T);
    g.rect(joint, y, 1, h, R.plank[0]);
    g.px(joint + 1, y + 1, R.plank[3]);
    if (noise() < 0.28) { // a knot
      const kx = x0 + 3 + Math.floor(noise() * 24);
      const ky = y + 3 + Math.floor(noise() * 4);
      g.rect(kx, ky, 3, 2, R.plank[0]);
      g.px(kx + 1, ky, R.plank[1]);
    }
  }
}

function wallBand(g, w, topH) {
  // upper stone wall
  const noise = makeNoise(9);
  for (let row = 0; row * 16 < topH - 22; row++) {
    const offset = row % 2 ? 16 : 0;
    for (let col = -1; col * 32 < w; col++) {
      const x = col * 32 + offset;
      const y = row * 16;
      const v = 0.3 + noise() * 0.28;
      g.area(x, y, 31, 15, (px, py) => shade(R.night, px, py, v + (15 - (py - y)) * 0.006));
      g.rect(x, y, 31, 1, R.night[2]);
      g.rect(x, y + 15, 32, 1, INK);
      g.rect(x + 31, y, 1, 16, INK);
    }
  }
  // wainscot
  const top = topH - 22;
  g.area(0, top, w, 22, (x, y) => shade(R.oak.slice(0, 2).concat(R.plank[3]), x, y, 0.15 + (x % 32 < 2 ? 0.45 : 0) + (y - top < 2 ? 0.5 : 0)));
  g.rect(0, top, w, 2, R.oak[1]);
  g.rect(0, top + 2, w, 1, R.plank[0]);
  g.rect(0, topH - 2, w, 2, INK);
}

function windowAt(g, x, y) {
  g.rect(x - 2, y - 2, 36, 36, R.oak[0]);
  g.rect(x - 1, y - 1, 34, 34, R.oak[1]);
  g.area(x, y, 32, 32, (px, py) => shade(R.night.slice(0, 3).concat(R.slate[0]), px, py, (py - y) / 42 + 0.05));
  g.ball(x + 22, y + 9, 4.5, 4.5, R.cream, { light: 0.7 }); // moon
  g.ball(x + 24, y + 8, 3.5, 3.5, [R.night[1]], {});
  for (const [sx, sy] of [[5, 6], [12, 3], [8, 15], [27, 20], [17, 24], [4, 24]]) g.px(x + sx, y + sy, R.slate[3]);
  g.rect(x + 15, y, 2, 32, R.oak[0]); // muntins
  g.rect(x, y + 15, 32, 2, R.oak[0]);
  g.rect(x - 3, y + 33, 38, 3, R.oak[2]);
  g.rect(x - 3, y + 35, 38, 1, R.oak[0]);
}

function shelfWithBottles(g, x, y, w) {
  const noise = makeNoise(x + y);
  for (const sy of [y, y + 22]) {
    g.rect(x, sy + 18, w, 3, R.oak[1]);
    g.rect(x, sy + 18, w, 1, R.oak[2]);
    g.rect(x, sy + 21, w, 1, INK);
    for (let bx = x + 2; bx < x + w - 6; bx += 7 + Math.floor(noise() * 4)) {
      const ramp = [R.felt, R.wine, R.amber, R.slate][Math.floor(noise() * 4)];
      const h = 8 + Math.floor(noise() * 6);
      g.area(bx, sy + 18 - h, 5, h, (px, py) => shade(ramp, px, py, 0.65 - (px - bx) * 0.12));
      g.rect(bx + 1, sy + 18 - h - 3, 3, 3, ramp[0]);
      g.px(bx + 1, sy + 18 - h + 1, R.cream[1]);
      g.rect(bx, sy + 18 - h + 4, 5, 2, R.cream[0]); // label
    }
  }
}

function bar(g, x, y, w) {
  // counter top seen from above, face below
  g.area(x, y, w, 20, (px, py) => shade(R.oak, px, py, 0.55 + Math.sin((py - y) * 1.2 + px * 0.05) * 0.1));
  g.rect(x, y, w, 2, R.oak[3]);
  g.rect(x, y + 20, w, 2, R.oak[0]);
  g.area(x, y + 22, w, 18, (px, py) => shade(R.oak.slice(0, 2).concat(R.plank[2]), px, py, 0.32 + ((px - x) % 24 < 2 ? 0.5 : 0) - (py - y - 22) * 0.012));
  g.rect(x, y + 40, w, 2, INK);
  // tankards and a stack of plates on the counter
  for (const kx of [x + 22, x + 58, x + w - 34]) {
    g.rect(kx, y + 6, 7, 9, R.slate[1]);
    g.rect(kx, y + 6, 2, 9, R.slate[3]);
    g.rect(kx + 7, y + 8, 2, 5, R.slate[0]);
    g.rect(kx, y + 5, 7, 2, R.cream[1]);
  }
  // stools
  for (let sx = x + 16; sx < x + w - 12; sx += 40) {
    g.ball(sx, y + 52, 9, 6, R.oak, { light: 0.55 });
    g.ball(sx, y + 51, 6, 3.5, R.oak.slice(1), { light: 0.7 });
    g.rect(sx - 6, y + 57, 2, 6, R.oak[0]);
    g.rect(sx + 5, y + 57, 2, 6, R.oak[0]);
    g.rect(sx - 6, y + 63, 13, 1, INK);
  }
}

function rug(g, x, y, w, h) {
  g.rect(x, y, w, h, R.wine[0]);
  g.area(x + 2, y + 2, w - 4, h - 4, (px, py) => shade(R.wine, px, py, 0.45 + (Math.sin(px * 0.8) * Math.sin(py * 0.8)) * 0.06));
  g.rect(x + 6, y + 6, w - 12, 2, R.amber[1]);
  g.rect(x + 6, y + h - 8, w - 12, 2, R.amber[1]);
  g.rect(x + 6, y + 6, 2, h - 12, R.amber[1]);
  g.rect(x + w - 8, y + 6, 2, h - 12, R.amber[1]);
  g.area(x + 10, y + 10, w - 20, h - 20, (px, py) => ((px + py) % 16 === 0 || (px - py + 1600) % 16 === 0 ? R.wine[0] : 0));
  for (let i = x + 4; i < x + w - 3; i += 4) { // fringe
    g.rect(i, y - 3, 2, 3, R.cream[0]);
    g.rect(i, y + h, 2, 3, R.cream[0]);
  }
}

function door(g, x, y) {
  // the entrance in the bottom wall: warm threshold and a mat
  g.rect(x - 4, y - 4, 72, 40, R.oak[0]);
  g.area(x, y, 64, 36, (px, py) => shade(R.oak.slice(0, 3), px, py, 0.32 + ((px - x) % 16 < 1 ? -0.25 : 0.05) + (py - y) * 0.004));
  g.rect(x + 31, y, 2, 36, INK);
  g.rect(x, y + 8, 64, 2, R.slate[0]);
  g.rect(x, y + 26, 64, 2, R.slate[0]);
  g.ball(x + 26, y + 18, 2, 2, R.amber, { light: 0.7 });
  g.ball(x + 37, y + 18, 2, 2, R.amber, { light: 0.7 });
  // mat
  g.area(x + 8, y - 22, 48, 16, (px, py) => shade(R.slate.slice(0, 3), px, py, 0.42 + ((px + py) % 4 === 0 ? 0.25 : 0)));
  g.rect(x + 8, y - 22, 48, 1, R.slate[2]);
  g.rect(x + 8, y - 7, 48, 1, INK);
}

function hearth(g, x, y) {
  g.rect(x - 4, y - 4, 72, 62, R.slate[0]);
  const noise = makeNoise(77);
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 8; col++) {
      const bx = x - 4 + col * 9 + (row % 2 ? 4 : 0);
      const by = y - 4 + row * 9;
      if (bx > x + 62) continue;
      g.area(bx, by, 8, 8, (px, py) => shade(R.slate.slice(0, 3), px, py, 0.25 + noise() * 0.03 + (row + col) % 3 * 0.12));
    }
  }
  g.rect(x + 10, y + 16, 44, 42, INK);
  g.ball(x + 32, y + 50, 16, 13, R.amber, { light: 0.55 });
  g.ball(x + 26, y + 46, 7, 13, R.amber.slice(1), { light: 0.8 });
  g.ball(x + 38, y + 44, 6, 15, R.amber.slice(1), { light: 0.7 });
  g.ball(x + 32, y + 50, 6, 8, R.amber.slice(2), { light: 0.9 });
  g.rect(x + 16, y + 54, 32, 4, R.oak[0]);
  g.line(x + 14, y + 57, x + 50, y + 53, R.oak[1]);
  g.rect(x - 8, y - 8, 80, 6, R.oak[1]);
  g.rect(x - 8, y - 8, 80, 2, R.oak[3]);
  g.rect(x - 8, y - 2, 80, 1, INK);
}

function wallLantern(g, cx, y) {
  g.line(cx, y - 6, cx, y, R.slate[0]);
  g.rect(cx - 5, y - 7, 11, 2, R.slate[1]);
  lantern(g, cx, y, 1);
}

/** Builds a room. `layout` says where the fixed furniture goes. */
export function room(cols, rows, layout) {
  const w = cols * T;
  const h = rows * T;
  const g = new Img(w, h);
  const noise = makeNoise(cols * 100 + rows);
  for (let ty = 3; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) floorTile(g, tx, ty, noise);
  wallBand(g, w, 96);
  g.area(0, 96, w, 8, (x, y) => shade(R.plank.slice(0, 2), x, y, 0.75 - (y - 96) * 0.1)); // shadow at the wall's foot
  for (const x of layout.windows) windowAt(g, x, 12);
  if (layout.shelf) shelfWithBottles(g, layout.shelf.x, 8, layout.shelf.w);
  if (layout.hearth !== undefined) hearth(g, layout.hearth, 40);
  for (const x of layout.lanterns) wallLantern(g, x, 16);
  rug(g, layout.rug.x, layout.rug.y, layout.rug.w, layout.rug.h);
  bar(g, layout.bar.x, layout.bar.y, layout.bar.w);
  // side and bottom walls
  g.area(0, 96, 8, h - 96, (x, y) => shade(R.night, x, y, 0.2 + x * 0.05));
  g.area(w - 8, 96, 8, h - 96, (x, y) => shade(R.night, x, y, 0.45 - (x - (w - 8)) * 0.05));
  g.rect(8, 96, 1, h - 96, INK);
  g.rect(w - 9, 96, 1, h - 96, INK);
  g.area(0, h - 16, w, 16, (x, y) => shade(R.night, x, y, 0.42 - (y - (h - 16)) * 0.02));
  g.rect(0, h - 17, w, 1, INK);
  door(g, layout.door, h - 34);
  return g;
}

// ---------- table sprites (96×80) ----------

function roundTable(g, feltRamp, topRamp, chairRamp) {
  // chairs
  for (const [cx, cy] of [[48, 10], [10, 34], [86, 34], [48, 68]]) {
    g.ball(cx, cy, 8, 7, chairRamp, { light: 0.5 });
    g.ball(cx, cy - 1, 5, 4, chairRamp.slice(1), { light: 0.65 });
  }
  // pedestal shadow
  g.ball(48, 58, 34, 11, [INK], {});
  // rim
  g.ball(48, 38, 36, 24, topRamp, { light: 0.5 });
  // felt
  g.ball(48, 36, 31, 20, feltRamp, { light: 0.45 });
  // inner line on the felt
  for (let a = 0; a < 6.3; a += 0.015) g.px(Math.round(48 + Math.cos(a) * 25), Math.round(36 + Math.sin(a) * 15), feltRamp[Math.max(0, feltRamp.length - 2)]);
  // apron below the rim
  g.area(16, 56, 64, 8, (x, y) => {
    const inside = Math.hypot((x - 48) / 36, (y - 38) / 28);
    return inside < 1 && y > 38 + 24 * Math.sqrt(Math.max(0, 1 - ((x - 48) / 36) ** 2)) - 1 ? shade(topRamp.slice(0, 2), x, y, 0.45 - (x - 48) * 0.009) : 0;
  });
}

function smallCard(g, x, y, faceUp) {
  g.rect(x, y, 7, 10, INK);
  g.rect(x + 1, y + 1, 5, 8, faceUp ? R.cream[1] : R.wine[1]);
  if (faceUp) {
    g.px(x + 2, y + 2, R.wine[2]);
    g.px(x + 3, y + 4, R.wine[2]);
    g.px(x + 4, y + 6, R.wine[2]);
  } else {
    g.rect(x + 2, y + 3, 3, 4, R.wine[3]);
    g.px(x + 3, y + 4, R.amber[2]);
  }
}

export function cardTableLit() {
  const g = new Img(96, 80);
  roundTable(g, R.felt, R.oak, R.oak);
  for (const [x, y, up] of [[30, 26, false], [40, 24, false], [50, 26, false], [36, 40, true], [46, 41, true]]) smallCard(g, x, y, up);
  // chips and pot
  g.ball(62, 38, 5, 3, R.wine, { light: 0.7 });
  g.ball(62, 36, 5, 3, R.amber.slice(1), { light: 0.65 });
  g.ball(70, 42, 3.5, 2, R.slate.slice(1), { light: 0.65 });
  // lantern on the table, the light of the room
  lantern(g, 26, 40, 1);
  return g.outline();
}

export function cardTableDark() {
  const g = new Img(96, 80);
  roundTable(g, R.night, R.plank, R.plank);
  smallCard(g, 42, 30, false);
  return g.outline();
}

export function axeLane() {
  const g = new Img(96, 80);
  // lane boards
  g.area(10, 22, 76, 50, (x, y) => shade(R.plank, x, y, 0.38 + ((y - 22) % 10 < 1 ? -0.25 : 0.06)));
  g.line(10, 40, 85, 40, R.night[1]);
  // rack of axes along the bottom
  for (const ax of [22, 44, 66]) {
    g.line(ax, 50, ax + 8, 67, R.plank[3]);
    g.line(ax + 1, 50, ax + 9, 67, R.plank[2]);
    g.poly([[ax - 6, 46], [ax + 6, 46], [ax + 7, 53], [ax - 5, 56]], (x, y) => shade(R.slate, x, y, 0.45 - (x - ax) * 0.03 + (y < 48 ? 0.22 : 0)));
  }
  // target board stands at the far end
  g.rect(32, 28, 4, 12, R.plank[1]);
  g.rect(60, 28, 4, 12, R.plank[1]);
  g.ball(48, 18, 18, 18, R.plank, { light: 0.6 });
  g.ball(48, 18, 13, 13, R.night.slice(1), { light: 0.45 });
  g.ball(48, 18, 8, 8, R.wine.slice(0, 2), { light: 0.45 });
  g.ball(48, 18, 3, 3, R.plank.slice(2), { light: 0.6 });
  return g.outline();
}

export function rouletteWheel() {
  const g = new Img(96, 80);
  g.ball(48, 46, 38, 26, [INK], {});
  g.ball(48, 42, 38, 26, R.plank, { light: 0.55 });
  g.ball(48, 38, 30, 21, R.plank.slice(0, 2), { light: 0.45 });
  for (let a = 0; a < 6.283; a += 0.008) {
    for (let r = 0.62; r < 0.98; r += 0.02) {
      const pocket = Math.floor((a / 6.283) * 18);
      const x = Math.round(48 + Math.cos(a) * 30 * r);
      const y = Math.round(38 + Math.sin(a) * 21 * r);
      g.px(x, y, pocket % 2 ? R.wine[1] : R.night[0]);
    }
  }
  g.ball(48, 38, 15, 10.5, R.plank.slice(1), { light: 0.55 });
  g.ball(48, 38, 7, 5, R.slate.slice(0, 2), { light: 0.6 });
  g.rect(46, 26, 4, 22, R.slate[1]);
  g.rect(36, 36, 24, 3, R.slate[0]);
  g.ball(48, 37, 2.5, 2.5, R.slate.slice(1), { light: 0.7 });
  g.ball(72, 30, 2, 2, R.slate.slice(2), { light: 0.7 }); // the little ball
  return g.outline();
}

/** Rope posts around a 96×80 sprite, with a sign that says it plainly. */
export function ropeAndSign() {
  const g = new Img(112, 96);
  const post = (x, y) => {
    g.rect(x - 1, y, 4, 13, R.oak[0]);
    g.rect(x - 1, y, 2, 13, R.oak[2]);
    g.ball(x + 1, y - 1, 3, 3, R.amber, { light: 0.55 });
    g.rect(x - 3, y + 13, 8, 2, R.oak[0]);
  };
  const rope = (x0, y0, x1, y1) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sag = Math.sin(t * Math.PI) * 5;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t + sag);
      g.px(x, y, i % 4 < 2 ? R.wine[3] : R.wine[1]);
      g.px(x, y + 1, R.wine[0]);
    }
  };
  // Only the near side: the far side would run across the art.
  rope(6, 66, 56, 76);
  rope(56, 76, 106, 66);
  rope(6, 24, 6, 66);
  rope(106, 24, 106, 66);
  post(4, 66);
  post(54, 76);
  post(104, 66);
  // sign on a post
  g.rect(55, 30, 3, 28, R.oak[0]);
  g.rect(55, 30, 1, 28, R.oak[2]);
  g.rect(35, 18, 42, 21, INK);
  g.area(36, 19, 40, 19, (x, y) => shade(R.oak, x, y, 0.72 + ((y - 19) % 6 === 0 ? -0.2 : 0) - (x - 36) * 0.004));
  g.rect(37, 19, 38, 1, R.oak[3]);
  g.px(37, 21, INK);
  g.px(74, 21, INK);
  g.px(37, 35, INK);
  g.px(74, 35, INK);
  g.text('COMING', 44, 22, INK);
  g.text('SOON', 48, 30, INK);
  return g;
}

// ---------- the seal ----------

/** The wax-hand seal: an original mark. A wax blob pressed with an open hand missing two fingers. */
export function seal(size = 24) {
  const g = new Img(size, size);
  const c = size / 2 - 0.5;
  const r = size / 2 - 1.5;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = Math.atan2(y - c, x - c);
    const edge = r * (1 + Math.sin(a * 7 + 1) * 0.06 + Math.sin(a * 3) * 0.04);
    const d = Math.hypot(x - c, y - c);
    if (d <= edge) g.px(x, y, shade(R.wine, x, y, 0.62 - ((x - c) + (y - c)) / (size * 1.6) - (d < r * 0.72 ? 0.16 : 0)));
  }
  // the pressed hand, in dark and light for depth
  const s = size / 24;
  const px = (ix, iy, iw, ih, color) => g.rect(Math.round(c + ix * s), Math.round(c + iy * s), Math.max(1, Math.round(iw * s)), Math.max(1, Math.round(ih * s)), color);
  px(-3.5, 0, 7, 5.5, R.wine[0]); // palm
  px(-3, 5, 6, 1, R.wine[0]);
  px(-6.5, 0, 3, 2, R.wine[0]); // thumb
  px(-7.5, -2, 2, 3, R.wine[0]);
  px(-3, -6, 2, 6, R.wine[0]); // first finger
  px(0, -7.5, 2, 7.5, R.wine[0]); // second
  px(3, -1.5, 1.5, 1.5, R.wine[0]); // stumps of the missing two
  px(3, -1, 1, 1, R.wine[3]);
  px(-1, -1, 1, 1, R.wine[2]);
  px(-1, 1, 3, 1, R.wine[1]);
  return g.outline();
}

// ---------- cards ----------

export const CARD_W = 28;
export const CARD_H = 40;
const SUITS = 'cdhs';
const RANKS = '23456789TJQKA';

const BIG = {
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['#..#.', '#..#.', '#..#.', '#####', '...#.', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '..#..', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  A: ['..#..', '.#.#.', '#...#', '#...#', '#####', '#...#', '#...#'],
};

const TEN = ['##.#####', '##.##.##', '##.##.##', '##.##.##', '##.##.##', '##.##.##', '##.#####'];

const PIPS = {
  h: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  d: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
  s: ['...#...', '..###..', '.#####.', '#######', '#######', '.#.#.#.', '...#...'],
  c: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
};

const SMALL_PIPS = {
  h: ['##.##', '#####', '.###.', '..#..'],
  d: ['..#..', '.###.', '#####', '.###.', '..#..'],
  s: ['..#..', '.###.', '#####', '#.#.#', '..#..'],
  c: ['.###.', '.###.', '#####', '..#..', '.###.'],
};

function glyph(g, rows, x, y, color) {
  rows.forEach((row, j) => [...row].forEach((bit, i) => { if (bit === '#') g.px(x + i, y + j, color); }));
}

function cardFace(rank, suit) {
  const g = new Img(CARD_W, CARD_H);
  g.rect(1, 0, CARD_W - 2, CARD_H, INK);
  g.rect(0, 1, CARD_W, CARD_H - 2, INK);
  g.rect(1, 1, CARD_W - 2, CARD_H - 2, R.cream[1]);
  g.rect(CARD_W - 2, 2, 1, CARD_H - 4, R.cream[0]);
  g.rect(2, CARD_H - 2, CARD_W - 4, 1, R.cream[0]);
  const red = suit === 'h' || suit === 'd';
  const ink = red ? R.wine[2] : R.night[1];
  // rank large and top-left: the thing you have to read at phone size
  if (rank === 'T') glyph(g, TEN, 3, 3, ink); // already drawn at full weight, and two digits wide
  else {
    glyph(g, BIG[rank], 3, 3, ink);
    glyph(g, BIG[rank], 4, 3, ink); // doubled for weight
  }
  glyph(g, SMALL_PIPS[suit], 3, 12, ink);
  // large pip lower right
  const pip = PIPS[suit];
  const scale = 2;
  pip.forEach((row, j) => [...row].forEach((bit, i) => {
    if (bit === '#') g.rect(11 + i * scale, 19 + j * scale, scale, scale, ink);
  }));
  if (red) {
    g.px(13, 21, R.wine[3]);
    g.px(14, 21, R.wine[3]);
    g.px(13, 22, R.wine[3]);
  } else {
    g.px(17, 23, R.night[3]);
    g.px(18, 23, R.night[3]);
  }
  return g;
}

function cardBack() {
  const g = new Img(CARD_W, CARD_H);
  g.rect(1, 0, CARD_W - 2, CARD_H, INK);
  g.rect(0, 1, CARD_W, CARD_H - 2, INK);
  g.area(1, 1, CARD_W - 2, CARD_H - 2, (x, y) => ((x + y) % 6 === 0 || (x - y + 60) % 6 === 0 ? R.night[2] : R.night[1]));
  g.rect(2, 2, CARD_W - 4, 1, R.amber[0]);
  g.rect(2, CARD_H - 3, CARD_W - 4, 1, R.amber[0]);
  g.rect(2, 2, 1, CARD_H - 4, R.amber[0]);
  g.rect(CARD_W - 3, 2, 1, CARD_H - 4, R.amber[0]);
  g.blit(seal(24), 2, 8);
  return g;
}

/** 13 columns × 4 rows of faces, then the back in a final row. */
export function cardAtlas() {
  const g = new Img(CARD_W * 13, CARD_H * 5);
  [...SUITS].forEach((suit, row) => [...RANKS].forEach((rank, col) => g.blit(cardFace(rank, suit), col * CARD_W, row * CARD_H)));
  g.blit(cardBack(), 0, CARD_H * 4);
  return g;
}

// ---------- small UI ----------

/** A tiny card back for the seats on the felt. */
export function miniBack() {
  const g = new Img(10, 14);
  g.rect(0, 0, 10, 14, INK);
  g.rect(1, 1, 8, 12, R.night[2]);
  g.rect(1, 1, 8, 1, R.amber[0]);
  g.rect(1, 12, 8, 1, R.amber[0]);
  g.ball(4.5, 6.5, 3, 3, R.wine, { light: 0.7 });
  g.rect(4, 5, 2, 3, R.wine[0]);
  return g;
}

export function coin() {
  const g = new Img(8, 8);
  g.ball(3.5, 3.5, 3.5, 3.5, R.amber, { light: 0.55 });
  g.rect(3, 2, 2, 4, R.amber[0]);
  return g;
}

export function tableScene() {
  // The back wall behind the seated players. Native 320×96; the table sits in front in the page.
  const g = new Img(320, 104);
  wallBand(g, 320, 104);
  for (const x of [24, 288]) wallLantern(g, x, 20);
  windowAt(g, 144, 10);
  return g;
}

export function tableFront() {
  // Felt running the full width in front of the seats.
  const g = new Img(320, 40);
  g.area(0, 0, 320, 6, (x, y) => shade(R.oak, x, y, 0.8 - y * 0.08));
  g.rect(0, 0, 320, 1, R.oak[3]);
  g.area(0, 6, 320, 28, (x, y) => shade(R.felt, x, y, 0.42 + Math.sin(x * 0.11 + y * 0.3) * 0.04 - Math.abs(x - 160) * 0.0008));
  g.rect(0, 34, 320, 4, R.oak[1]);
  g.rect(0, 34, 320, 1, R.oak[2]);
  g.rect(0, 38, 320, 2, INK);
  return g;
}
