// The art ingest, on made-up JPEGs in a temporary folder, and the real output committed in public/art/hall/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { breathSheet, columnRuns, cornerColour, decode, dropSpecks, ingest, keyOut, toGrid, trimBox } from '../scripts/art/ingest.mjs';
import { CARD, RANKS, SUITS, SUIT_COLOURS, drawCard, pipCount } from '../scripts/art/cards.mjs';
import { CONFIG, SOURCES } from '../scripts/art/ingest.config.mjs';
import { Img } from '../scripts/art/lib.js';
import { ART } from '../public/js/hall-config.js';
import { AVATARS } from '../src/platform/avatars.js';

const here = (p) => new URL(`../${p}`, import.meta.url).pathname;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Reads an indexed PNG as RGBA. */
async function pixels(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, d: data, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
}

const paletteOf = (path) => {
  const png = readFileSync(path);
  assert.equal(png[25], 3, `${path} is indexed`);
  const at = png.indexOf(Buffer.from('PLTE'));
  return png.subarray(at + 4, at + 4 + png.readUInt32BE(at - 4)).toString('hex');
};

/**
 * A figure on a coloured ground, as a noisy JPEG: a body in one colour, a "cape" in dull green, a gap between arm
 * and body that shows the ground, and a soft edge between figure and ground.
 */
async function fakeCharacter(path, { ground = [8, 250, 8], body = [120, 60, 40], width = 1152, height = 1728 } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="rgb(${ground})"/>
    <g filter="url(#s)"><rect x="${width * 0.3}" y="${height * 0.1}" width="${width * 0.4}" height="${height * 0.8}" fill="rgb(${body})"/>
    <rect x="${width * 0.34}" y="${height * 0.4}" width="${width * 0.1}" height="${height * 0.3}" fill="rgb(60,110,50)"/></g>
    <rect x="${width * 0.6}" y="${height * 0.4}" width="${width * 0.05}" height="${height * 0.1}" fill="rgb(${ground})"/>
    <defs><filter id="s"><feGaussianBlur stdDeviation="2"/></filter></defs></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toFile(path);
}

async function fakeScene(path, colour = '#352e6e') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="1728"><rect width="100%" height="100%" fill="${colour}"/><rect x="200" y="400" width="500" height="500" fill="#ad723d"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(path);
}

async function fixture() {
  const from = mkdtempSync(join(tmpdir(), 'ingest-from-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'ingest-source-'));
  const outDir = mkdtempSync(join(tmpdir(), 'ingest-out-'));
  const characters = {};
  await fakeCharacter(join(from, 'A.jpeg'));
  await fakeCharacter(join(from, 'B.jpeg'), { ground: [4, 129, 7], body: [200, 170, 120] }); // a dark green ground, like Brannock's
  for (const [id, file] of [['clockwork', 'A'], ['halfhand', 'A'], ['tally', 'A'], ['brannock', 'B']]) characters[id] = join(from, `${file}.jpeg`);
  await fakeScene(join(from, 'Hall.jpeg'));
  await fakeScene(join(from, 'Table.jpeg'), '#42263a');
  return { from, sourceDir, outDir, sources: { characters, rooms: { v1: join(from, 'Hall.jpeg') }, table: join(from, 'Table.jpeg'), drop: join(from, 'sealed-hand') } };
}

// ---------- keying ----------

test('key: samples the corners, so a dark green ground is found as well as a bright one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-'));
  await fakeCharacter(join(dir, 'bright.jpeg'));
  await fakeCharacter(join(dir, 'dark.jpeg'), { ground: [4, 129, 7] });
  const bright = cornerColour(await decode(join(dir, 'bright.jpeg')));
  const dark = cornerColour(await decode(join(dir, 'dark.jpeg')));
  assert.ok(bright[1] > 230 && bright[0] < 30, String(bright));
  assert.ok(dark[1] > 110 && dark[1] < 150 && dark[0] < 30, String(dark));
});

test('key: removes the ground and closed-in gaps, keeps a green cape, and leaves no spill on the edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-'));
  const file = join(dir, 'x.jpeg');
  await fakeCharacter(file);
  const image = await decode(file);
  const bg = keyOut(image, CONFIG.key);
  const px = (fx, fy) => [...image.d.subarray((Math.floor(fy * image.h) * image.w + Math.floor(fx * image.w)) * 4, (Math.floor(fy * image.h) * image.w + Math.floor(fx * image.w)) * 4 + 4)];

  assert.equal(px(0.05, 0.05)[3], 0, 'the ground is gone');
  assert.equal(px(0.625, 0.45)[3], 0, 'and so is the gap by the arm, though it does not touch the edge');
  assert.equal(px(0.5, 0.5)[3], 255, 'the body stays');
  const cape = px(0.39, 0.55);
  assert.equal(cape[3], 255, 'the green cape stays');
  assert.ok(cape[1] > cape[0] && cape[1] > cape[2], `and stays green: ${cape}`);

  // Walk along the body's edge: nothing opaque there is anywhere near the ground's colour.
  const y = Math.floor(image.h * 0.2);
  for (let x = 0; x < image.w; x++) {
    const i = (y * image.w + x) * 4;
    if (image.d[i + 3] < 128) continue;
    const distance = Math.hypot(image.d[i] - bg[0], image.d[i + 1] - bg[1], image.d[i + 2] - bg[2]);
    assert.ok(distance > CONFIG.key.hard, `x=${x} is close to the ground colour`);
    assert.ok(image.d[i + 1] <= Math.max(image.d[i], image.d[i + 2]) + 40, `x=${x} has green spill: ${[...image.d.subarray(i, i + 3)]}`);
  }
});

test('key: soft threshold: a pixel just outside the ground colour fades rather than cuts', () => {
  const w = 40;
  const d = new Uint8Array(w * w * 4).fill(255);
  for (let i = 0; i < d.length; i += 4) [d[i], d[i + 1], d[i + 2]] = [0, 255, 0];
  const mid = (20 * w + 20) * 4;
  [d[mid], d[mid + 1], d[mid + 2]] = [40, 215, 20]; // a noisy pixel in the ground
  const edge = (20 * w + 21) * 4;
  [d[edge], d[edge + 1], d[edge + 2]] = [30, 200, 30];
  keyOut({ w, h: w, d }, { hard: 30, soft: 90, spillRadius: 4 });
  assert.ok(d[edge + 3] > 0 && d[edge + 3] < 255, `alpha ${d[edge + 3]}`);
});

// ---------- grid, frames ----------

test('grid: a speck is dropped, trim finds the figure, and the pixel size is the same whatever the source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grid-'));
  await fakeCharacter(join(dir, 'a.jpeg'));
  await fakeCharacter(join(dir, 'b.jpeg'), { width: 768, height: 1152 });
  for (const [name, source] of [['a', 1152], ['b', 768]]) {
    const image = await decode(join(dir, `${name}.jpeg`));
    keyOut(image, CONFIG.key);
    const box = trimBox(image);
    const grid = toGrid(image, box, CONFIG.seatPixel * (source / 1152));
    assert.ok(Math.abs(grid.h - Math.round(1728 * 0.8 / CONFIG.seatPixel)) <= 2, `${name}: ${grid.h}`);
  }
  const g = { w: 20, h: 20, d: new Uint8Array(1600) };
  g.d[3] = 255; // one stray opaque pixel
  for (let i = 100; i < 200; i++) g.d[i * 4 + 3] = 255;
  dropSpecks(g);
  assert.equal(g.d[3], 0);
  assert.equal(g.d[150 * 4 + 3], 255);
});

test('idle: the second frame is the same figure with the top sunk one pixel, and the feet still', () => {
  const img = new Img(10, 20);
  img.rect(3, 0, 4, 20, 5);
  const sheet = breathSheet(img, 0.6);
  assert.equal(sheet.w, 20);
  assert.equal(sheet.h, 21);
  assert.equal(sheet.get(4, 0), 0, 'frame 1 has an empty top row');
  assert.equal(sheet.get(4, 1), 5);
  assert.equal(sheet.get(14, 1), 0, 'frame 2 starts a pixel lower');
  assert.equal(sheet.get(14, 2), 5);
  assert.equal(sheet.get(14, 20), sheet.get(4, 20), 'the feet match');
});

// ---------- a whole run ----------

test('ingest: originals untouched and copied in; one palette; two-frame sprites; the portrait; no ground left', async () => {
  const f = await fixture();
  const before = Object.fromEntries(readdirSync(f.from).map((n) => [n, [sha(join(f.from, n)), statSync(join(f.from, n)).mtimeMs]]));
  const { manifest, missing, palette } = await ingest({ sources: f.sources, sourceDir: f.sourceDir, outDir: f.outDir });
  assert.deepEqual(missing, []);
  for (const [name, [hash, mtime]] of Object.entries(before)) {
    assert.equal(sha(join(f.from, name)), hash, `${name} unchanged`);
    assert.equal(statSync(join(f.from, name)).mtimeMs, mtime, `${name} not touched`);
  }
  assert.ok(existsSync(join(f.sourceDir, 'halfhand.jpeg')));
  assert.equal(sha(join(f.sourceDir, 'halfhand.jpeg')), sha(f.sources.characters.halfhand));

  const pngs = readdirSync(f.outDir).filter((n) => n.endsWith('.png'));
  assert.equal(new Set(pngs.map((n) => paletteOf(join(f.outDir, n)))).size, 1, 'one shared palette');
  assert.ok(palette.length <= CONFIG.colours);

  const sprite = await pixels(join(f.outDir, 'seat-brannock.png'));
  assert.equal(sprite.w, manifest.sprites.brannock.w * 2, 'two frames');
  assert.equal(sprite.h, manifest.sprites.brannock.h);
  assert.equal(sprite.at(0, 0)[3], 0, 'transparent corner');
  let opaque = 0;
  for (let y = 0; y < sprite.h; y++) {
    for (let x = 0; x < sprite.w; x++) {
      const [r, g, b, a] = sprite.at(x, y);
      if (!a) continue;
      opaque += 1;
      assert.ok(Math.hypot(r - 4, g - 129, b - 7) > CONFIG.key.hard, `ground colour survived at ${x},${y}`);
    }
  }
  assert.ok(opaque > 1000);

  assert.equal(manifest.sprites.tally.h, manifest.sprites.brannock.h, 'same figure height at the same pixel size');
  assert.ok(manifest.sprites.halfhand && existsSync(join(f.outDir, 'seat-halfhand.png')), 'Halfhand is a look a player can have');
  assert.ok(manifest.doorman && manifest.sprites.clockwork, 'the doorman, and the seat sprite for players who already have that look');
  const portrait = await pixels(join(f.outDir, 'portrait.png'));
  assert.deepEqual([portrait.w, portrait.h], [CONFIG.portraitSize * 2, CONFIG.portraitSize], 'a square, two frames');
  assert.equal(manifest.rooms.v1.w, CONFIG.roomWidth);
  assert.equal(manifest.table.w, CONFIG.tableWidth);
  assert.ok(manifest.side.file);
});

test('ingest: a missing file is left out of the manifest, and a dropped room.png or table.png is picked up', async () => {
  const f = await fixture();
  const gone = { ...f.sources, characters: { ...f.sources.characters, oldwick: join(f.from, 'never-painted.jpeg') } };
  const first = await ingest({ sources: gone, sourceDir: f.sourceDir, outDir: f.outDir });
  assert.deepEqual(first.missing, ['oldwick.jpeg']);
  assert.equal(first.manifest.sprites.oldwick, undefined);
  assert.ok(first.manifest.sprites.brannock, 'the rest still build');

  const roomBefore = sha(join(f.outDir, 'room-v1.png'));
  const tableBefore = sha(join(f.outDir, 'table.png'));
  const drop = f.sources.drop;
  const { mkdirSync } = await import('node:fs');
  mkdirSync(drop);
  await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#7f4b2b' } }).png().toFile(join(drop, 'room.png'));
  await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#2a7d68' } }).png().toFile(join(drop, 'table.png'));
  const second = await ingest({ sources: gone, sourceDir: f.sourceDir, outDir: f.outDir });
  assert.notEqual(sha(join(f.outDir, 'room-v1.png')), roomBefore);
  assert.notEqual(sha(join(f.outDir, 'table.png')), tableBefore);
  assert.equal(second.manifest.rooms.v1.w, CONFIG.roomWidth, 'scaled to the same grid');
  assert.ok(second.notes.some((n) => n.includes('room.png')));
});

// ---------- the real art ----------

test('real art: the committed set is built from the copies in art-source, on one palette', async () => {
  const manifest = JSON.parse(readFileSync(here('public/art/hall/manifest.json')));
  assert.deepEqual(Object.keys(manifest.sprites).sort(), [...AVATARS, 'brannock', 'clockwork', 'oldwick', 'tally'].sort(), 'every look, the house bots, and the retired clockwork');
  assert.ok(AVATARS.includes('halfhand') && !AVATARS.includes('clockwork'), 'Halfhand plays; Clockwork keeps the door');
  assert.deepEqual(Object.keys(manifest.rooms).sort(), ['v1', 'v2']);
  assert.ok(manifest.portrait && manifest.doorman && manifest.table && manifest.side);
  const dir = here('public/art/hall');
  const pngs = readdirSync(dir).filter((n) => n.endsWith('.png'));
  assert.equal(new Set(pngs.map((n) => paletteOf(join(dir, n)))).size, 1);
  for (const id of Object.keys(manifest.sprites)) {
    const { w, h } = manifest.sprites[id];
    const sheet = await pixels(join(dir, `seat-${id}.png`));
    assert.deepEqual([sheet.w, sheet.h], [w * 2, h], id);
    assert.equal(sheet.at(0, h - 1)[3], 0, `${id}: a clear corner`);
  }
  const figures = Object.entries(SOURCES.characters).map(([id, path]) => `${id}${path.slice(path.lastIndexOf('.'))}`);
  for (const name of [...figures, 'Hall_V1.jpeg', 'Hall_V2.jpeg', 'Table_V1.jpeg']) {
    assert.ok(existsSync(here(`art-source/${name}`)), `${name} is in the repo`);
    const source = name.startsWith('Hall') ? SOURCES.rooms[name.includes('V1') ? 'v1' : 'v2'] : name.startsWith('Table') ? SOURCES.table : SOURCES.characters[name.split('.')[0]];
    if (existsSync(source)) assert.equal(sha(here(`art-source/${name}`)), sha(source), `${name} matches the original`);
  }
});

test('real art: the door is brass, not the purple cloak', async () => {
  for (const file of ['doorman.png', 'portrait.png']) {
    const sheet = await pixels(here(`public/art/hall/${file}`));
    let brass = 0;
    let purple = 0;
    for (let y = 0; y < sheet.h; y++) {
      for (let x = 0; x < sheet.w; x++) {
        const [r, g, b, a] = sheet.at(x, y);
        if (!a) continue;
        if (r > b + 25 && g > b + 10) brass += 1;
        if (b > g + 25 && r > g) purple += 1;
      }
    }
    assert.ok(brass > 500, `${file}: ${brass} brass pixels`);
    assert.ok(purple < brass / 50, `${file}: ${purple} purple pixels`);
  }
});

test('real art: no sprite pixel is near its own background, and the green cape is still green', async () => {
  let green = 0;
  let visor = 0;
  for (const [id, source] of Object.entries(SOURCES.characters)) {
    const { hard } = CONFIG.keys?.[id] ?? CONFIG.key;
    const bg = cornerColour(await decode(here(`art-source/${id}${source.slice(source.lastIndexOf('.'))}`)));
    const sheet = await pixels(here(`public/art/hall/seat-${id}.png`));
    for (let y = 0; y < sheet.h; y++) {
      for (let x = 0; x < sheet.w; x++) {
        const [r, g, b, a] = sheet.at(x, y);
        if (!a) continue;
        assert.ok(Math.hypot(r - bg[0], g - bg[1], b - bg[2]) > hard, `${id} ${x},${y}: rgb(${r},${g},${b})`);
        if (id === 'adventurer' && g > r + 15 && g > b + 15) green += 1;
        if (id === 'tally' && y < sheet.h * 0.12 && g > r + 15 && g > b + 15) visor += 1;
      }
    }
  }
  assert.ok(green > 500, `${green} green cape pixels`);
  assert.ok(visor > 100, `${visor} green visor pixels: Tally's visor survives a green backdrop`);
});

test('config: hotspots and marks sit inside each room image; the switch names a real one', () => {
  const manifest = JSON.parse(readFileSync(here('public/art/hall/manifest.json')));
  assert.ok(ART.rooms[ART.room] && manifest.rooms[ART.room]);
  for (const [id, room] of Object.entries(ART.rooms)) {
    const { w, h } = manifest.rooms[id];
    assert.deepEqual(Object.keys(room.hotspots).sort(), ['axe-lane', 'cage', 'cup-and-claim', 'roulette', 'sealed-hand'].sort(), id);
    const marks = room.marks.map(([cx, cy, size], i) => [`mark ${i}`, [cx - size / 2, cy - size / 2, size, size]]);
    assert.equal(room.marks.length, 2, `${id}: two marks`);
    for (const m of room.marks) assert.ok(Object.keys(room.hotspots).includes(m[4]), `${id}: each mark belongs to a hotspot`);
    for (const [, , size, a] of room.marks) assert.ok(size <= 16 && a <= 0.6, `${id}: small and subtle`);
    for (const [name, [x, y, sw, sh]] of [...Object.entries(room.hotspots), ...marks]) {
      assert.ok(x >= 0 && y >= 0 && x + sw <= w && y + sh <= h, `${id} ${name}`);
    }
  }
  assert.ok(ART.scene.frontTop < manifest.table.h);
  assert.equal(ART.scene.seats.length, 4);
  assert.ok(['midnight', 'seal'].includes(ART.cardBack));
});

test('real art: every look has a sprite at the same pixel size, a small original included', () => {
  const manifest = JSON.parse(readFileSync(here('public/art/hall/manifest.json')));
  const heights = AVATARS.map((id) => manifest.sprites[id].h);
  assert.ok(Math.max(...heights) <= 225 && Math.min(...heights) >= 180, heights.join());
  assert.ok(manifest.sprites.dwarf.h >= 180, 'Dwarf is a smaller file, and comes out the same scale');
  for (const id of AVATARS) {
    const [x, y, size] = manifest.sprites[id].face;
    assert.ok(x >= 0 && y >= 0 && x + size <= manifest.sprites[id].w && y + size <= manifest.sprites[id].h, id);
  }
});

test('Midnight files are byte-for-byte the official ones', () => {
  const pack = join(process.env.ART_ORIGINALS ?? 'art-source/originals', 'Images/Midnight Logo Pack');
  const files = {
    'Midnight-RGB_Symbol-White.svg': '02_Symbol',
    'Midnight-RGB_Logo-Horizontal-White.svg': '01_Symbol + Wordmark/Horizontal',
  };
  const fixed = {
    'Midnight-RGB_Logo-Horizontal-White.svg': 'b7af707fe02ecef8',
    'Midnight-RGB_Symbol-White.svg': 'dcc0606d0cedf617',
  };
  for (const [name, folder] of Object.entries(files)) {
    const copy = here(`public/brand/midnight/${name}`);
    assert.equal(sha(copy).slice(0, 16), fixed[name], `${name} unchanged since it was copied`);
    const original = join(pack, folder, name);
    if (existsSync(original)) assert.equal(sha(copy), sha(original), `${name} matches the pack`);
  }
});

// ---------- the pot ----------

async function fakePot(path) {
  const blob = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#d9a12c"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="1728"><rect width="100%" height="100%" fill="rgb(10,240,10)"/>${blob(150, 900, 60)}${blob(480, 880, 150)}${blob(880, 860, 220)}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(path);
}

test('pot: three piles found left to right, smallest first, keyed, on the shared palette', async () => {
  const f = await fixture();
  await fakePot(join(f.from, 'Pot.jpeg'));
  const { manifest } = await ingest({ sources: { ...f.sources, pot: join(f.from, 'Pot.jpeg') }, sourceDir: f.sourceDir, outDir: f.outDir });
  const { small, medium, large } = manifest.pot;
  assert.ok(small.w < medium.w && medium.w < large.w, `${small.w} ${medium.w} ${large.w}`);
  const sheet = await pixels(join(f.outDir, large.file));
  assert.equal(sheet.at(0, 0)[3], 0, 'a clear corner');
  assert.equal(new Set(readdirSync(f.outDir).filter((n) => n.endsWith('.png')).map((n) => paletteOf(join(f.outDir, n)))).size, 1);
});

test('pot: the wrong number of piles is reported, and left to fall back', async () => {
  const f = await fixture();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="1728"><rect width="100%" height="100%" fill="rgb(10,240,10)"/><circle cx="500" cy="800" r="200" fill="#d9a12c"/></svg>';
  await sharp(Buffer.from(svg)).jpeg().toFile(join(f.from, 'Pot.jpeg'));
  const { manifest, notes } = await ingest({ sources: { ...f.sources, pot: join(f.from, 'Pot.jpeg') }, sourceDir: f.sourceDir, outDir: f.outDir });
  assert.equal(manifest.pot, undefined);
  assert.ok(notes.some((n) => /three piles, found 1/.test(n)));
});

test('real art: the three pot tiers are in, growing, and fit the felt', () => {
  const { pot, table } = JSON.parse(readFileSync(here('public/art/hall/manifest.json')));
  assert.ok(pot.small.w < pot.medium.w && pot.medium.w < pot.large.w);
  assert.ok(pot.large.w <= 110 && pot.large.h <= 110, `${pot.large.w}×${pot.large.h}`);
  assert.ok(pot.large.w < table.w / 4);
  assert.ok(ART.pot.medium < ART.pot.large);
  assert.equal(columnRuns({ w: 3, h: 1, d: new Uint8Array(12) }).length, 0);
});

// ---------- the card fronts ----------

const cardPx = (card, x, y) => {
  const i = (y * card.w + x) * 4;
  return [card.d[i], card.d[i + 1], card.d[i + 2], card.d[i + 3]];
};

test('card fronts: every card is full parchment with no gaps, and the corners match turned round', () => {
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const card = drawCard(rank, suit);
      assert.deepEqual([card.w, card.h], [CARD.w, CARD.h]);
      assert.ok(card.d.every((v, i) => i % 4 !== 3 || v === 255), `${rank}${suit} has gaps`);
      // Corner marks in the suit's colour: count them in the upper left and the lower right.
      const { base } = SUIT_COLOURS[suit];
      const marked = (x0, y0, w, h) => {
        let n = 0;
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            const [r, g, b] = cardPx(card, x, y);
            if (Math.hypot(r - base[0], g - base[1], b - base[2]) < 12) n += 1;
          }
        }
        return n;
      };
      const upper = marked(0, 0, 20, 38);
      const lower = marked(CARD.w - 20, CARD.h - 38, 20, 38);
      assert.ok(upper > 40, `${rank}${suit}: ${upper} in the upper corner`);
      assert.ok(Math.abs(upper - lower) <= upper * 0.1, `${rank}${suit}: corners ${upper} and ${lower}`);
    }
  }
});

test('card fronts: classic pip counts, and no two cards alike', () => {
  assert.deepEqual([...'23456789T'].map(pipCount), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const seen = new Set();
  for (const suit of SUITS) for (const rank of RANKS) seen.add(Buffer.from(drawCard(rank, suit).d).toString('base64'));
  assert.equal(seen.size, 52);
});

test('card fronts: the four suits are told apart by colour', () => {
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const { h, d, s, c } = SUIT_COLOURS;
  assert.ok(h.base[0] > 170 && h.base[1] < 60, 'hearts are red');
  assert.ok(d.base[1] > h.base[1] + 30, 'diamonds lean orange');
  assert.ok(s.base.every((v) => v < 50), 'spades are near-black');
  assert.ok(c.base[1] > c.base[0] && c.base[1] > c.base[2], 'clubs lean green');
  assert.ok(distance(h.base, d.base) > 40);
  assert.ok(distance(s.base, c.base) > 30);
});

test('card fronts: the sheet is 2× the art, indexed, with every art pixel a sharp 2×2 block', async () => {
  const sheet = await pixels(here('public/art/cards/cards.png'));
  assert.deepEqual([sheet.w, sheet.h], [CARD.w * 13 * CARD.export, CARD.h * 4 * CARD.export]);
  paletteOf(here('public/art/cards/cards.png'));
  for (const [x, y] of [[40, 40], [400, 300], [1500, 700], [2000, 900]]) {
    const ax = x & ~1;
    const ay = y & ~1;
    assert.deepEqual(sheet.at(ax, ay), sheet.at(ax + 1, ay + 1));
    assert.deepEqual(sheet.at(ax, ay), sheet.at(ax + 1, ay));
  }
});

test('fonts: Alegreya SC for labels, Alegreya for reading, Cinzel for the title; the pixel faces are gone', () => {
  const css = readFileSync(here('public/css/inn.css'), 'utf8');
  for (const page of ['public/index.html', 'public/table.html']) {
    const html = readFileSync(here(page), 'utf8');
    assert.match(html, /Alegreya\+SC/, page);
    assert.match(html, /family=Alegreya:/, page);
    assert.match(html, /Cinzel/, page);
    assert.ok(!/Pixelify|Atkinson|Press\+Start|Silkscreen/.test(html), page);
  }
  assert.ok(!/Pixelify|Atkinson|Press Start|Silkscreen/.test(css));
  assert.match(css, /--title: 'Cinzel'/);
  assert.match(css, /--label: 'Alegreya SC'/);
  assert.match(css, /--body: 'Alegreya'/);
  assert.equal(ART.titleFont, undefined, 'the title is no longer a switch');
});
