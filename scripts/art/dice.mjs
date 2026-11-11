// Art for Cup & Claim: The owner's painted upstairs room and dice cup become the table scene and the cup that shakes and
// slams, on a shared palette, the same way Tally's art is ingested. The dice faces are drawn from code on the Hall's
// 32-colour palette. Anything missing stays code-drawn, so the page always has something to show.
//   npm run art:dice
//
// Sources, first found wins:
//   $ART_ORIGINALS/Images/dice/cup.jpeg   or  Images/dice cup.jpeg
//   $ART_ORIGINALS/Images/dice/table.jpeg or  Images/Dice Table.jpeg
// Originals are only read; they are copied into art-source/dice/ first, so a rebuild doesn't need the originals folder.

import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Img, R, encodePng } from './lib.js';
import { buildPalette, decode, dropSpecks, toGrid, toIndexed, trimBox } from './ingest.mjs';

const IMAGES = join(process.env.ART_ORIGINALS ?? 'art-source/originals', 'Images');

export const SOURCES = {
  cup: [join(IMAGES, 'dice', 'cup.jpeg'), join(IMAGES, 'dice cup.jpeg')],
  room: [join(IMAGES, 'dice', 'table.jpeg'), join(IMAGES, 'Dice Table.jpeg')],
};

export const CONFIG = {
  roomWidth: 576,
  roomCrop: [0, 0.2, 1, 0.56], // the hanging lamp, the round table with its cups, the hearth. Fractions of the image.
  cupCrop: [0.26, 0.14, 0.74, 0.50], // the whole cup with its rim, leaving the candle out; a die's corner that gets in is dropped as a fragment
  cupPixel: 6, // source pixels per art pixel on a 1152-wide original
  cupClose: 2, // art pixels: the outline is closed over this much, where the shadowed leather meets the dark air with no edge to find
  heroWidth: 288, // the whole close-up, for the panel behind your cup
  colours: 96,
};

const cropBox = (image, [x, y, w, h]) => ({ x: Math.round(x * image.w), y: Math.round(y * image.h), w: Math.round(w * image.w), h: Math.round(h * image.h) });

function bringIn(candidates, sourceDir, name) {
  const target = join(sourceDir, name);
  const source = candidates.find((path) => existsSync(path));
  if (source) {
    const incoming = readFileSync(source);
    if (!existsSync(target) || !incoming.equals(readFileSync(target))) {
      copyFileSync(source, target);
      chmodSync(target, 0o644);
    }
  }
  return existsSync(target) ? target : null;
}

/** A window of the image as its own picture. */
function cut(image, box) {
  const d = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) d.set(image.d.subarray(((box.y + y) * image.w + box.x) * 4, ((box.y + y) * image.w + box.x + box.w) * 4), y * box.w * 4);
  return { w: box.w, h: box.h, d };
}

/**
 * Keys the cup out of its close-up. The background is two things, dark air and green felt, so the corner-colour key
 * can't do it. Only pixels that look like air or felt AND can be reached from the edge of the crop are removed, so
 * nothing enclosed by the cup's outline (its dark mouth, its shadowed leather) is ever cut. Then only the largest
 * solid piece is kept, so no fragment of felt or die floats beside it, and the edge is closed over so the rim isn't
 * torn where a shadow meets the air.
 */
export function keyCup(image, { closeRadius = 2 } = {}) {
  const { w, h, d } = image;
  const n = w * h;
  const bg = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const r = d[p * 4];
    const g = d[p * 4 + 1];
    const b = d[p * 4 + 2];
    // The air is a neutral near-black (about 3,4,6); the leather's shadow is darker still in places but reddish.
    const air = Math.max(r, g, b) < 16 && r <= g + 2;
    const felt = g > r + 6 && g >= b;
    if (air || felt) bg[p] = 1;
  }
  const reached = floodFromEdges(bg, w, h);
  let opaque = new Uint8Array(n);
  for (let p = 0; p < n; p++) opaque[p] = reached[p] ? 0 : 1;
  opaque = largestComponent(opaque, w, h);
  opaque = close(opaque, w, h, closeRadius);
  for (let p = 0; p < n; p++) d[p * 4 + 3] = opaque[p] ? 255 : 0;
  return image;
}

/** Every `mask` pixel reachable from the border through `mask` pixels. */
function floodFromEdges(mask, w, h) {
  const n = w * h;
  const reached = new Uint8Array(n);
  const stack = [];
  const push = (p) => {
    if (mask[p] && !reached[p]) {
      reached[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < n - w) push(p + w);
  }
  return reached;
}

/** The biggest connected patch of a mask, alone. */
function largestComponent(mask, w, h) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    label[start] = id;
    while (stack.length) {
      const p = stack.pop();
      size += 1;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < n && mask[q] && label[q] < 0) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(size);
  }
  const best = sizes.indexOf(Math.max(...sizes));
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = label[p] === best ? 1 : 0;
  return out;
}

/** Morphological closing: grow by r, shrink by r. Fills cracks narrower than 2r without moving the outline. */
function close(mask, w, h, r) {
  if (r <= 0) return mask;
  const grow = (m, on) => {
    const out = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = !on;
        for (let j = -r; j <= r && hit === !on; j++) {
          for (let i = -r; i <= r; i++) {
            const xx = x + i;
            const yy = y + j;
            const v = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : m[yy * w + xx];
            if ((v === 1) === on) { hit = on; break; }
          }
        }
        out[y * w + x] = hit ? 1 : 0;
      }
    }
    return out;
  };
  return grow(grow(mask, true), false); // dilate, then erode
}

/**
 * On the art grid: closes the outline over `r` pixels, fills any cell enclosed by the outline, and gives every cell
 * that became solid the colour of its nearest painted neighbour. The sprite ends up one solid shape with no holes.
 */
export function solidify(grid, r = 2) {
  const { w, h, d } = grid;
  const n = w * h;
  let solid = new Uint8Array(n);
  for (let p = 0; p < n; p++) solid[p] = d[p * 4 + 3] >= 128 ? 1 : 0;
  solid = close(solid, w, h, r);
  const outside = floodFromEdges(solid.map((v) => (v ? 0 : 1)), w, h);
  for (let p = 0; p < n; p++) if (!solid[p] && !outside[p]) solid[p] = 1;
  for (let p = 0; p < n; p++) {
    if (!solid[p]) {
      d[p * 4 + 3] = 0;
      continue;
    }
    if (d[p * 4 + 3] >= 128) continue;
    // Newly solid: borrow the nearest painted cell's colour, searching outward.
    const x = p % w;
    const y = (p - x) / w;
    let found = false;
    for (let ring = 1; ring <= 6 && !found; ring++) {
      for (let j = -ring; j <= ring && !found; j++) {
        for (let i = -ring; i <= ring && !found; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const xx = x + i;
          const yy = y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = (yy * w + xx) * 4;
          if (d[q + 3] >= 128) {
            d[p * 4] = d[q];
            d[p * 4 + 1] = d[q + 1];
            d[p * 4 + 2] = d[q + 2];
            found = true;
          }
        }
      }
    }
    d[p * 4 + 3] = found ? 255 : 0;
  }
  return grid;
}

// ---------- drawn from code: the six faces, and a cup for when there's no painting ----------

const PIPS = {
  1: [[2, 2]],
  2: [[0, 0], [4, 4]],
  3: [[0, 0], [2, 2], [4, 4]],
  4: [[0, 0], [4, 0], [0, 4], [4, 4]],
  5: [[0, 0], [4, 0], [2, 2], [0, 4], [4, 4]],
  6: [[0, 0], [4, 0], [0, 2], [4, 2], [0, 4], [4, 4]],
};

/** One die face, `size` pixels square: cream with a shadowed edge, ink pips, a wild 1 picked out in amber. */
export function dieFace(face, size = 24) {
  const img = new Img(size, size);
  const [cream0, cream1] = R.cream;
  img.rect(1, 1, size - 2, size - 2, cream1);
  img.rect(1, size - 3, size - 2, 2, cream0); // bottom shade
  img.rect(size - 3, 1, 2, size - 2, cream0); // right shade
  for (const c of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) img.px(c[0], c[1], 0); // rounded corners
  img.outline(R.ink[0]);
  const pip = Math.max(2, Math.round(size / 8));
  const step = (size - 2 * pip - 6) / 4;
  for (const [gx, gy] of PIPS[face]) {
    const x = Math.round(3 + gx * step);
    const y = Math.round(3 + gy * step);
    img.rect(x, y, pip, pip, face === 1 ? R.amber[1] : R.ink[0]);
    if (face === 1) img.rect(x + 1, y + 1, Math.max(1, pip - 2), Math.max(1, pip - 2), R.amber[2]);
  }
  return img;
}

/** The six faces as one SVG strip, so a die stays round and sharp at any size: soft corners and round pips. The wild 1 is amber. */
export function diceSvg() {
  // Round 3 (11-07): the sharp vector faces the owner preferred, redrawn with soft shading that suits the lamplit table: warm ivory
  // lit from the top left, a squarer body (the pixel ones read boxy, so the corners are soft but not round), a dark edge, a
  // bevel of light along the top and left and shade along the bottom and right, and big, dark, glossy pips that read at
  // phone size. The wild 1 is an amber pip with a dark ring. Six faces in a row, 100 units each: the page shows one at a
  // time by background position, at whole-pixel sizes.
  const at = [26, 50, 74];
  const face = (n, i) => {
    const o = i * 100;
    const pips = PIPS[n].map(([gx, gy]) => [at[gx / 2], at[gy / 2]]);
    const dot = (x, y, r, fill) => `<circle cx="${o + x}" cy="${y}" r="${r}" fill="${fill}"/><circle cx="${o + x - r * 0.3}" cy="${y - r * 0.32}" r="${(r * 0.3).toFixed(1)}" fill="#fff" fill-opacity=".38"/>`;
    const dots = n === 1
      ? `<circle cx="${o + 50}" cy="50" r="18" fill="#5a3708"/>${dot(50, 50, 14, 'url(#amber)')}`
      : pips.map(([x, y]) => dot(x, y, 10.5, 'url(#pip)')).join('');
    return [
      `<rect x="${o + 3}" y="3" width="94" height="94" rx="15" fill="url(#body)" stroke="#3b2a18" stroke-width="2.5"/>`,
      `<rect x="${o + 6.5}" y="6.5" width="87" height="87" rx="12" fill="none" stroke="url(#bevel)" stroke-width="3"/>`,
      `<rect x="${o + 6.5}" y="6.5" width="87" height="87" rx="12" fill="url(#sheen)"/>`,
      dots,
    ].join('');
  };
  const defs = [
    '<linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff8e8"/><stop offset=".55" stop-color="#f1e4c6"/><stop offset="1" stop-color="#d9c59c"/></linearGradient>',
    '<linearGradient id="bevel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf5" stop-opacity=".9"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#6b4e2a" stop-opacity=".45"/></linearGradient>',
    '<radialGradient id="sheen" cx=".3" cy=".25" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#8a6a3a" stop-opacity=".16"/></radialGradient>',
    '<radialGradient id="pip" cx=".38" cy=".34" r=".85"><stop offset="0" stop-color="#4e3b2a"/><stop offset=".6" stop-color="#231a12"/><stop offset="1" stop-color="#0e0906"/></radialGradient>',
    '<radialGradient id="amber" cx=".38" cy=".34" r=".85"><stop offset="0" stop-color="#ffd978"/><stop offset=".6" stop-color="#e59c2a"/><stop offset="1" stop-color="#b06a12"/></radialGradient>',
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 100" width="600" height="100"><defs>${defs}</defs>${[1, 2, 3, 4, 5, 6].map((n, i) => face(n, i)).join('')}</svg>\n`;
}

export function diceAtlas(size = 24) {
  const atlas = new Img(size * 6, size);
  for (let face = 1; face <= 6; face++) atlas.blit(dieFace(face, size), (face - 1) * size, 0);
  return atlas;
}

/** A leather cup, mouth down, from code: for the slam when there is no painting. */
export function drawnCup(w = 44, h = 52) {
  const img = new Img(w, h);
  const [oak0, oak1, oak2, oak3] = R.oak;
  img.poly([[6, 2], [w - 7, 2], [w - 2, h - 4], [1, h - 4]], (x, y) => (x < 8 ? oak0 : x < 14 ? oak1 : x > w - 12 ? oak0 : y % 9 === 0 ? oak1 : oak2));
  img.rect(2, h - 6, w - 4, 4, oak1); // the rim, down on the felt
  img.rect(3, h - 7, w - 6, 1, oak3);
  img.rect(8, 10, w - 16, 2, oak3); // a stitched band
  img.rect(8, h - 16, w - 16, 2, oak3);
  img.outline(R.ink[0]);
  return img;
}

// ---------- the run ----------

export async function ingestDice({ sources = SOURCES, config = CONFIG, sourceDir, outDir }) {
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const notes = [];
  const missing = [];
  const grids = {};

  const cupPath = bringIn(sources.cup, sourceDir, 'cup.jpeg');
  const roomPath = bringIn(sources.room, sourceDir, 'table.jpeg');
  if (!cupPath) missing.push('cup.jpeg');
  if (!roomPath) missing.push('table.jpeg');

  if (roomPath) {
    const image = await decode(roomPath);
    const box = cropBox(image, config.roomCrop);
    grids.room = toGrid(image, box, image.w / config.roomWidth);
    notes.push(`room: ${grids.room.w}×${grids.room.h} from a ${image.w}×${image.h} original`);
  }
  if (cupPath) {
    const image = await decode(cupPath);
    grids.hero = toGrid(image, { x: 0, y: 0, w: image.w, h: image.h }, image.w / config.heroWidth);
    const window = cut(image, cropBox(image, config.cupCrop));
    keyCup(window);
    const box = trimBox(window);
    if (box) {
      grids.cup = solidify(toGrid(window, box, config.cupPixel * (image.w / 1152)), config.cupClose); // one solid piece, edge closed over, no holes
      notes.push(`cup: ${grids.cup.w}×${grids.cup.h}, keyed out of the felt and the dark`);
    } else notes.push('cup: nothing left after keying; the drawn cup stays.');
  }

  const manifest = {};
  if (Object.keys(grids).length) {
    const palette = buildPalette(Object.values(grids), config.colours);
    manifest.colours = palette.length;
    for (const [name, grid] of Object.entries(grids)) {
      const img = toIndexed(grid, palette);
      writeFileSync(join(outDir, `${name}.png`), encodePng(img, palette));
      manifest[name] = { file: `${name}.png`, w: grid.w, h: grid.h };
    }
  }
  const atlas = diceAtlas(24);
  writeFileSync(join(outDir, 'dice.png'), encodePng(atlas));
  writeFileSync(join(outDir, 'dice.svg'), diceSvg());
  manifest.dice = { file: 'dice.png', size: 24, svg: 'dice.svg' };
  const cup = drawnCup();
  writeFileSync(join(outDir, 'cup-drawn.png'), encodePng(cup));
  manifest.cupDrawn = { file: 'cup-drawn.png', w: cup.w, h: cup.h };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, missing, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../../', import.meta.url).pathname;
  const { manifest, missing, notes } = await ingestDice({ sourceDir: join(root, 'art-source/dice'), outDir: join(root, 'public/art/dice') });
  for (const note of notes) console.log(note);
  console.log(`palette: ${manifest.colours ?? 'drawn only'}`);
  if (missing.length) console.log(`missing, so those stay code-drawn: ${missing.join(', ')}. Put cup.jpeg and table.jpeg in ${join(IMAGES, 'dice')} and run again.`);
}
