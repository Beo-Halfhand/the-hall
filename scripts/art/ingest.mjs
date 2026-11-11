// Turns painted art into the sprites and backgrounds in public/art/hall/, on one shared palette.
//   npm run art:ingest
//
// Originals are only ever read. They are copied into art-source/ first, so a rebuild doesn't need the originals folder.
// Anything missing is skipped and left out of the manifest, and the pages keep the code-drawn art for it.

import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Img, encodePng } from './lib.js';
import { CONFIG, SOURCES } from './ingest.config.mjs';

// ---------- reading and keying ----------

export async function decode(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, d: data };
}

const median = (list) => list.slice().sort((a, b) => a - b)[list.length >> 1];

/** The background colour: the median of small patches in the four corners. */
export function cornerColour(image, patch = 24) {
  const { w, h, d } = image;
  const r = [];
  const g = [];
  const b = [];
  for (const [cx, cy] of [[0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch]]) {
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        const i = (y * w + x) * 4;
        r.push(d[i]);
        g.push(d[i + 1]);
        b.push(d[i + 2]);
      }
    }
  }
  return [median(r), median(g), median(b)];
}

/**
 * Keys out the background, in place, by distance from its colour. Inside `soft`, alpha ramps up, which rides out
 * JPEG noise. The loose test applies only to pixels joined to the image's edge, so a green cape survives; the
 * `hard` test applies everywhere, so gaps closed in by an arm go too. Edge pixels then lose the background's spill.
 */
export function keyOut(image, { hard, soft, spillRadius }) {
  const { w, h, d } = image;
  const bg = cornerColour(image);
  const n = w * h;
  const dist = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    dist[p] = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
  }

  // Flood in from the edges through anything inside the soft threshold.
  const reached = new Uint8Array(n);
  const stack = [];
  const push = (p) => {
    if (!reached[p] && dist[p] < soft) {
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

  const alpha = new Uint8Array(n).fill(255);
  for (let p = 0; p < n; p++) {
    if (dist[p] < hard) alpha[p] = 0;
    else if (reached[p]) alpha[p] = Math.round(((dist[p] - hard) / (soft - hard)) * 255);
  }

  // How far is each pixel from the background? Two sweeps of a city-block distance.
  const near = new Uint16Array(n).fill(65535);
  for (let p = 0; p < n; p++) {
    if (alpha[p] < 128) near[p] = 0;
    else {
      if (p % w > 0) near[p] = Math.min(near[p], near[p - 1] + 1);
      if (p >= w) near[p] = Math.min(near[p], near[p - w] + 1);
    }
  }
  for (let p = n - 1; p >= 0; p--) {
    if ((p + 1) % w !== 0 && p + 1 < n) near[p] = Math.min(near[p], near[p + 1] + 1);
    if (p + w < n) near[p] = Math.min(near[p], near[p + w] + 1);
  }

  // Spill: on the edge, take out what the background's dominant channel added, fading away from the edge.
  const key = bg.indexOf(Math.max(...bg));
  const [o1, o2] = [0, 1, 2].filter((c) => c !== key);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    d[i + 3] = alpha[p];
    if (alpha[p] === 0 || near[p] > spillRadius) continue;
    const limit = Math.max(d[i + o1], d[i + o2]);
    if (d[i + key] > limit) {
      const strength = 1 - (near[p] - 1) / spillRadius;
      d[i + key] = Math.round(d[i + key] - (d[i + key] - limit) * Math.max(0, Math.min(1, strength)));
    }
  }
  return bg;
}

/** The box around everything opaque, or null. */
export function trimBox({ w, h, d }) {
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Groups of columns with something opaque in them, separated by clear gaps: the piles, left to right. */
export function columnRuns({ w, h, d }, gap = 12) {
  const runs = [];
  let start = -1;
  let lastHit = -1;
  for (let x = 0; x < w; x++) {
    let hit = false;
    for (let y = 0; y < h && !hit; y++) hit = d[(y * w + x) * 4 + 3] >= 128;
    if (hit) {
      if (start < 0) start = x;
      lastHit = x;
    } else if (start >= 0 && x - lastHit >= gap) {
      runs.push([start, lastHit]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, lastHit]);
  return runs.filter(([a, b]) => b - a > 20); // a loose speck isn't a pile
}

/** The same picture with everything outside these columns treated as empty. */
function windowOf(image, [x0, x1]) {
  const d = new Uint8Array(image.d);
  for (let y = 0; y < image.h; y++) {
    for (let x = 0; x < image.w; x++) if (x < x0 || x > x1) d[(y * image.w + x) * 4 + 3] = 0;
  }
  return { w: image.w, h: image.h, d };
}

// ---------- the pixel grid ----------

/**
 * Nearest-neighbour onto a grid of `pixelSize` source pixels per art pixel. Each art pixel takes the median of
 * the 3×3 at its cell's centre, not one source pixel, so a single JPEG speck can't land in the sprite. No colours
 * are blended across the cell, so edges stay hard.
 */
export function toGrid(image, box, pixelSize) {
  const w = Math.max(1, Math.round(box.w / pixelSize));
  const h = Math.max(1, Math.round(box.h / pixelSize));
  const d = new Uint8Array(w * h * 4);
  const sx = box.w / w;
  const sy = box.h / h;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const cx = Math.min(image.w - 1, Math.floor(box.x + (i + 0.5) * sx));
      const cy = Math.min(image.h - 1, Math.floor(box.y + (j + 0.5) * sy));
      if (image.d[(cy * image.w + cx) * 4 + 3] < 128) continue; // transparent: index stays 0
      const r = [];
      const g = [];
      const b = [];
      for (let y = Math.max(0, cy - 1); y <= Math.min(image.h - 1, cy + 1); y++) {
        for (let x = Math.max(0, cx - 1); x <= Math.min(image.w - 1, cx + 1); x++) {
          const at = (y * image.w + x) * 4;
          if (image.d[at + 3] < 128) continue;
          r.push(image.d[at]);
          g.push(image.d[at + 1]);
          b.push(image.d[at + 2]);
        }
      }
      const o = (j * w + i) * 4;
      d[o] = median(r);
      d[o + 1] = median(g);
      d[o + 2] = median(b);
      d[o + 3] = 255;
    }
  }
  return { w, h, d };
}

/** Removes specks: any opaque patch smaller than `min` art pixels that isn't part of the main body. */
export function dropSpecks(grid, min = 6) {
  const { w, h, d } = grid;
  const seen = new Uint8Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || d[start * 4 + 3] === 0) continue;
    const patch = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      patch.push(p);
      for (const q of [p % w > 0 ? p - 1 : -1, p % w < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < w * h && !seen[q] && d[q * 4 + 3]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (patch.length < min) for (const p of patch) d[p * 4 + 3] = 0;
  }
  return grid;
}

// ---------- the shared palette ----------

/** Median cut over a pooled histogram. Each image counts the same whatever its size, so a sprite keeps its colours beside a whole room. */
export function buildPalette(grids, colours) {
  const pool = new Map();
  for (const grid of grids) {
    const opaque = grid.d.length / 4;
    const weight = 1 / opaque;
    for (let p = 0; p < opaque; p++) {
      const i = p * 4;
      if (grid.d[i + 3] === 0) continue;
      const key = ((grid.d[i] >> 2) << 12) | ((grid.d[i + 1] >> 2) << 6) | (grid.d[i + 2] >> 2);
      pool.set(key, (pool.get(key) ?? 0) + weight);
    }
  }
  const entries = [...pool].map(([key, weight]) => ({ c: [((key >> 12) & 63) * 4 + 2, ((key >> 6) & 63) * 4 + 2, (key & 63) * 4 + 2], weight }));
  const boxes = [entries];
  const stats = (box) => {
    let best = 0;
    let channel = 0;
    let weight = 0;
    for (let k = 0; k < 3; k++) {
      const values = box.map((e) => e.c[k]);
      const range = Math.max(...values) - Math.min(...values);
      if (range > best) [best, channel] = [range, k];
    }
    for (const e of box) weight += e.weight;
    return { score: best * Math.sqrt(weight), channel, range: best };
  };
  while (boxes.length < colours) {
    let pick = -1;
    let info = null;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const s = stats(box);
      if (s.range > 0 && (!info || s.score > info.score)) [pick, info] = [i, s];
    });
    if (pick < 0) break;
    const box = boxes[pick].sort((a, b) => a.c[info.channel] - b.c[info.channel]);
    const half = box.reduce((sum, e) => sum + e.weight, 0) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].weight;
      if (acc >= half) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  const hex = boxes.map((box) => {
    const total = box.reduce((sum, e) => sum + e.weight, 0);
    const mean = [0, 1, 2].map((k) => Math.round(box.reduce((sum, e) => sum + e.c[k] * e.weight, 0) / total));
    return `#${mean.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  });
  return [...new Set(hex)].sort();
}

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Maps a grid onto the palette, as an image of indices. Index 0 is transparent. */
export function toIndexed(grid, palette) {
  const rgb = palette.map(rgbOf);
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let found = cache.get(key);
    if (found === undefined) {
      let bestDist = Infinity;
      rgb.forEach(([pr, pg, pb], i) => {
        const dist = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
        if (dist < bestDist) [bestDist, found] = [dist, i + 1];
      });
      cache.set(key, found);
    }
    return found;
  };
  const out = new Img(grid.w, grid.h);
  for (let p = 0; p < grid.w * grid.h; p++) {
    const i = p * 4;
    if (grid.d[i + 3]) out.d[p] = nearest(grid.d[i], grid.d[i + 1], grid.d[i + 2]);
  }
  return out;
}

// ---------- frames ----------

/**
 * A two-frame sheet: the figure, then the same with everything above `waist` sunk one pixel, which reads as a
 * breath. One empty row on top gives it nowhere to clip.
 */
export function breathSheet(img, waist = 0.62) {
  const h = img.h + 1;
  const sheet = new Img(img.w * 2, h);
  const line = Math.round(h * waist);
  sheet.blit(img, 0, 1);
  for (let y = 0; y < h; y++) {
    const fromY = y <= line ? Math.max(0, y - 1) : y;
    for (let x = 0; x < img.w; x++) sheet.px(img.w + x, y, sheet.get(x, fromY));
  }
  return sheet;
}

/**
 * The head: a square from the top of the sprite. It centres on the widest run of each row, so a staff or a
 * pick held up beside the head doesn't pull the crop away from the face.
 */
function faceBox(img, share = 0.2) {
  const size = Math.max(8, Math.round(img.h * share));
  const middles = [];
  for (let y = 0; y < size; y++) {
    let best = 0;
    let bestMid = null;
    let start = -1;
    for (let x = 0; x <= img.w; x++) {
      if (x < img.w && img.get(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start > best) [best, bestMid] = [x - start, (start + x) >> 1];
        start = -1;
      }
    }
    if (bestMid !== null) middles.push(bestMid);
  }
  const cx = middles.length ? median(middles) : Math.round(img.w / 2);
  return [Math.max(0, Math.min(img.w - size, cx - (size >> 1))), 1, size];
}

// ---------- the run ----------

/** Copies an original into the repo. The original is only read. Returns the copy's path, or null if there's neither. */
function bringIn(source, sourceDir, name) {
  const target = join(sourceDir, name);
  if (source && existsSync(source)) {
    const incoming = readFileSync(source);
    if (!existsSync(target) || !incoming.equals(readFileSync(target))) {
      copyFileSync(source, target);
      chmodSync(target, 0o644);
    }
  }
  return existsSync(target) ? target : null;
}

const cropBox = (image, [x, y, w, h]) => ({ x: Math.round(x * image.w), y: Math.round(y * image.h), w: Math.round(w * image.w), h: Math.round(h * image.h) });

function darken(grid, keep) {
  for (let i = 0; i < grid.d.length; i += 4) for (let k = 0; k < 3; k++) grid.d[i + k] = Math.round(grid.d[i + k] * keep);
  return grid;
}

/** Repeats seamlessly: the tile, mirrored both ways. */
function mirrorTile(grid) {
  const { w, h, d } = grid;
  const out = { w: w * 2, h: h * 2, d: new Uint8Array(w * h * 16) };
  for (let y = 0; y < h * 2; y++) {
    for (let x = 0; x < w * 2; x++) {
      const sx = x < w ? x : w * 2 - 1 - x;
      const sy = y < h ? y : h * 2 - 1 - y;
      for (let k = 0; k < 4; k++) out.d[(y * out.w + x) * 4 + k] = d[(sy * w + sx) * 4 + k];
    }
  }
  return out;
}

/**
 * Builds whatever it can find. `activeRoom` is the variant a dropped room.png replaces.
 * Returns { manifest, missing, notes }.
 */
export async function ingest({ sources = SOURCES, config = CONFIG, sourceDir, outDir, activeRoom = 'v1' }) {
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const notes = [];
  const missing = [];
  const opened = {};

  const open = (key, source, name) => {
    const path = bringIn(source, sourceDir, name);
    if (path) opened[key] = path;
    else missing.push(name);
  };

  for (const [id, source] of Object.entries(sources.characters)) open(`character:${id}`, source, `${id}${source ? source.slice(source.lastIndexOf('.')) : '.jpeg'}`);
  for (const [id, source] of Object.entries(sources.rooms)) open(`room:${id}`, source, basename(source));
  open('table', sources.table, basename(sources.table));
  if (sources.pot) open('pot', sources.pot, basename(sources.pot));

  // Dropping room.png or table.png in the art folder replaces the active room or the table image.
  if (sources.drop) {
    const room = bringIn(join(sources.drop, 'room.png'), sourceDir, 'room.png');
    if (room) {
      opened[`room:${activeRoom}`] = room;
      notes.push(`room.png replaces room ${activeRoom}. Check its hotspots in public/js/hall-config.js.`);
    }
    const table = bringIn(join(sources.drop, 'table.png'), sourceDir, 'table.png');
    if (table) {
      opened.table = table;
      notes.push('table.png replaces the table image. Check the crop in scripts/art/ingest.config.mjs.');
    }
  }

  const grids = {};
  const backgrounds = [];

  for (const [key, path] of Object.entries(opened)) {
    const image = await decode(path);
    if (key.startsWith('character:')) {
      const id = key.slice(10);
      const bg = keyOut(image, config.keys?.[id] ?? config.key);
      notes.push(`${id}: background rgb(${bg.join(', ')})`);
      const box = trimBox(image);
      if (!box) {
        notes.push(`${id}: nothing left after keying, skipped.`);
        continue;
      }
      grids[`seat-${id}`] = dropSpecks(toGrid(image, box, config.seatPixel * (image.w / 1152)));
      if (id === config.doorman) {
        grids.doorman = dropSpecks(toGrid(image, box, config.doormanPixel));
        const p = cropBox(image, config.portraitCrop);
        p.h = p.w; // square, in source pixels
        grids.portrait = dropSpecks(toGrid(image, p, p.w / config.portraitSize));
      }
    } else if (key.startsWith('room:')) {
      const id = key.slice(5);
      grids[`room-${id}`] = toGrid(image, { x: 0, y: 0, w: image.w, h: image.h }, image.w / config.roomWidth);
      backgrounds.push(`room-${id}`);
    } else if (key === 'pot') {
      keyOut(image, config.key);
      const piles = columnRuns(image);
      if (piles.length !== 3) {
        notes.push(`Pot image: expected three piles, found ${piles.length}. Coins stay in-house.`);
        continue;
      }
      ['small', 'medium', 'large'].forEach((tier, i) => {
        const box = trimBox(windowOf(image, piles[i]));
        grids[`pot-${tier}`] = dropSpecks(toGrid(image, box, config.potPixel * (image.w / 1152)));
      });
    } else if (key === 'table') {
      const box = cropBox(image, config.tableCrop);
      grids.table = toGrid(image, box, image.w / config.tableWidth);
      backgrounds.push('table');
      const sideBox = cropBox(image, config.sideCrop);
      grids.side = mirrorTile(darken(toGrid(image, sideBox, image.w / config.tableWidth), config.sideKeep));
    }
  }

  // One palette, over everything built.
  const palette = buildPalette(Object.values(grids), config.colours);
  const manifest = { colours: palette.length };
  const write = (name, img) => writeFileSync(join(outDir, name), encodePng(img, palette));
  const indexed = Object.fromEntries(Object.entries(grids).map(([name, grid]) => [name, toIndexed(grid, palette)]));

  for (const [name, img] of Object.entries(indexed)) {
    if (name.startsWith('seat-')) {
      const id = name.slice(5);
      const sheet = breathSheet(img);
      write(`${name}.png`, sheet);
      (manifest.sprites ??= {})[id] = { file: `${name}.png`, w: img.w, h: img.h + 1, face: faceBox(img) };
    } else if (name === 'doorman') {
      write('doorman.png', breathSheet(img));
      manifest.doorman = { file: 'doorman.png', w: img.w, h: img.h + 1 };
    } else if (name === 'portrait') {
      const square = new Img(img.w, img.w);
      square.blit(img, 0, img.w - img.h);
      const sheet = breathSheet(square.crop(0, 0, img.w, img.w - 1), 0.75); // stays one square with its empty top row
      write('portrait.png', sheet);
      manifest.portrait = { file: 'portrait.png', size: img.w };
    } else if (name.startsWith('room-')) {
      write(`${name}.png`, img);
      (manifest.rooms ??= {})[name.slice(5)] = { file: `${name}.png`, w: img.w, h: img.h };
    } else if (name === 'table') {
      write('table.png', img);
      manifest.table = { file: 'table.png', w: img.w, h: img.h };
    } else if (name.startsWith('pot-')) {
      write(`${name}.png`, img);
      (manifest.pot ??= {})[name.slice(4)] = { file: `${name}.png`, w: img.w, h: img.h };
    } else if (name === 'side') {
      write('side.png', img);
      manifest.side = { file: 'side.png', w: img.w, h: img.h };
    }
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, missing, notes, palette };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../../', import.meta.url).pathname;
  const { ART } = await import('../../public/js/hall-config.js');
  const { manifest, missing, notes } = await ingest({ sourceDir: join(root, 'art-source'), outDir: join(root, 'public/art/hall'), activeRoom: ART.room });
  for (const note of notes) console.log(note);
  console.log(`palette: ${manifest.colours} colours`);
  for (const [id, s] of Object.entries(manifest.sprites ?? {})) console.log(`${id.padEnd(12)} ${s.w}×${s.h} face ${s.face}`);
  if (manifest.doorman) console.log(`doorman      ${manifest.doorman.w}×${manifest.doorman.h}`);
  if (manifest.portrait) console.log(`portrait     ${manifest.portrait.size}`);
  for (const [id, r] of Object.entries(manifest.rooms ?? {})) console.log(`room ${id}      ${r.w}×${r.h}`);
  if (manifest.table) console.log(`table        ${manifest.table.w}×${manifest.table.h}`);
  if (missing.length) console.log(`missing, so those stay code-drawn: ${missing.join(', ')}`);
}
