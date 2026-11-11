// The Cup & Claim saloon at midnight, code-drawn: 320 x 180, a three-quarter view from above, every pixel one of the 64
// colours of Resurrect 64 (art-source/palette/resurrect-64.hex), gradients by ordered dithering.
//   The back wall: dark warm wood, with one window strip on Midnight City. Purple and teal live in that strip only.
//   One brass lamp hangs over the table. Its warm pool lights a round saloon table seen from above (planked top, brass
//   rim) and the floorboards round it. Deep shadow at the edges. Nothing is drawn where the cups go: the page sets the
//   cups, dice and pot on the table as art of their own (public/art/dice/cup-top.png), never text.
// Usage: node scripts/art/saloon.mjs public/art/dice/saloon.png [public/art/dice/cup-top.png]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');

const W = 320, H = 180;
const PALETTE = readFileSync(new URL('../../art-source/palette/resurrect-64.hex', import.meta.url), 'utf8').trim().split(/\s+/).map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
const hex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((r) => r.map((v) => (v + 0.5) / 16 - 0.5));
// The room keeps to warm wood and lamplight. Purple and teal are only ever placed exactly, inside the window.
const ROOM = new Set(['2e222f', '6e2727', '9e4539', 'cd683d', 'e6904e', 'fbb954', 'f9c22b', 'f79617', 'fbff86', '7a3045', 'b33831', 'ae2334', 'ea4f36', 'f57d4a', 'fdcbb0']);
const ALLOWED = PALETTE.filter((p) => ROOM.has(p.map((v) => v.toString(16).padStart(2, '0')).join('')));
const near = (c) => { let best = 0, d = Infinity; ALLOWED.forEach((p, i) => { const e = (p[0] - c[0]) ** 2 * 0.3 + (p[1] - c[1]) ** 2 * 0.59 + (p[2] - c[2]) ** 2 * 0.11; if (e < d) { d = e; best = i; } }); return ALLOWED[best]; };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const img = Array.from({ length: H }, () => Array(W).fill(hex('2e222f')));
const exact = Array.from({ length: H }, () => Array(W).fill(false));
const put = (x, y, c, ex = false) => { if (x >= 0 && x < W && y >= 0 && y < H) { img[y][x] = c; exact[y][x] = ex; } };

// back wall, y 0-47: vertical planks of dark warm wood
const WALL = 47;
for (let y = 0; y < WALL; y++) for (let x = 0; x < W; x++) {
  const p = Math.floor(x / 12);
  let c = mix(hex('2e222f'), hex('6e2727'), 0.6 + ((p * 5) % 3) * 0.1);
  if (x % 12 === 0) c = hex('2e222f');
  else if (x % 12 === 1) c = mix(c, hex('9e4539'), 0.35);
  if ((x * 7 + y * 13 + p) % 41 === 0) c = mix(c, hex('2e222f'), 0.5);
  put(x, y, c);
}
// the window strip: the only cool light in the room
const win = { x0: 34, x1: 286, y0: 7, y1: 33 };
for (let y = win.y0; y < win.y1; y++) for (let x = win.x0; x < win.x1; x++) {
  const t = (y - win.y0) / (win.y1 - win.y0);
  const sky = t < 0.35 ? hex('2e222f') : t < 0.7 ? hex('323353') : hex('484a77');
  put(x, y, (x + y) % 2 === 0 && t > 0.3 && t < 0.4 ? hex('323353') : (x + y) % 2 === 0 && t > 0.65 && t < 0.75 ? hex('484a77') : sky, true);
}
for (let i = 0; i < 26; i++) put(win.x0 + Math.floor(rnd() * (win.x1 - win.x0)), win.y0 + Math.floor(rnd() * 9), rnd() > 0.6 ? hex('ffffff') : hex('8fd3ff'), true);
for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) if (x * x + y * y <= 17 && (x + 2) ** 2 + y * y > 12) put(258 + x, 13 + y, hex('c7dcd0'), true); // a crescent moon
let bx = win.x0;
while (bx < win.x1) {
  const w = 5 + Math.floor(rnd() * 10);
  const top = win.y1 - 5 - Math.floor(rnd() * 15);
  const body = rnd() > 0.5 ? hex('323353') : hex('45293f');
  for (let y = top; y < win.y1; y++) for (let x = bx; x < Math.min(bx + w, win.x1); x++) put(x, y, body, true);
  if (rnd() > 0.85) for (let y = top - 5; y < top; y++) put(bx + Math.floor(w / 2), y, body, true);
  for (let y = top + 2; y < win.y1 - 1; y += 3) for (let x = bx + 1; x < Math.min(bx + w - 1, win.x1); x += 2) if (rnd() > 0.55) put(x, y, [hex('0eaf9b'), hex('30e1b9'), hex('a884f3'), hex('905ea9'), hex('f9c22b')][Math.floor(rnd() * 5)], true);
  bx += w + (rnd() > 0.7 ? 1 : 0);
}
for (let y = win.y0 - 2; y < win.y1 + 1; y++) for (const x of [win.x0 - 2, win.x0 - 1, win.x1, win.x1 + 1, 97, 98, 160, 161, 223, 224]) put(x, y, hex('2e222f'), true);
for (let x = win.x0 - 2; x < win.x1 + 2; x++) { put(x, win.y0 - 2, hex('2e222f'), true); put(x, win.y1, hex('6e2727'), true); put(x, win.y1 + 1, hex('9e4539'), true); put(x, win.y1 + 2, hex('2e222f'), true); }
// skirting
for (let x = 0; x < W; x++) { put(x, WALL, hex('9e4539'), true); put(x, WALL + 1, hex('6e2727'), true); put(x, WALL + 2, hex('2e222f'), true); }

// floor, y 50-180: floorboards seen from above, staggered ends
for (let y = WALL + 3; y < H; y++) for (let x = 0; x < W; x++) {
  const row = Math.floor((y - WALL - 3) / 7);
  const seam = (y - WALL - 3) % 7 === 0;
  const end = (x + row * 37) % 64 === 0;
  let c = mix(hex('2e222f'), hex('6e2727'), 0.3 + (row % 2) * 0.06);
  if (seam || end) c = hex('2e222f');
  put(x, y, c);
}

// the table: a round saloon table from above (a three-quarter view squashes it)
const T = { cx: 160, cy: 116, rx: 100, ry: 54, edge: 7 };
// its shadow on the floor
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = ((x - T.cx) / (T.rx + 6)) ** 2 + ((y - T.cy - 9) / (T.ry + 5)) ** 2;
  if (d <= 1) img[y][x] = mix(img[y][x], hex('2e222f'), 0.75 * (1 - d * 0.5));
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = (x - T.cx) / T.rx, dyTop = (y - T.cy) / T.ry, dySide = (y - T.cy - T.edge) / T.ry;
  const onTop = dx * dx + dyTop * dyTop <= 1;
  const onSide = !onTop && dx * dx + dySide * dySide <= 1 && y > T.cy; // the table's thickness, seen under the front edge
  if (onSide) { img[y][x] = y > T.cy + T.ry + T.edge - 2 ? hex('2e222f') : hex('6e2727'); exact[y][x] = false; continue; }
  if (!onTop) continue;
  const d = dx * dx + dyTop * dyTop;
  const board = Math.floor((y - (T.cy - T.ry)) / 8);
  const seam = (y - (T.cy - T.ry)) % 8 === 0;
  let c = mix(hex('6e2727'), hex('9e4539'), 0.08 + (board % 2) * 0.1);
  if (seam) c = hex('2e222f');
  else if ((y - (T.cy - T.ry)) % 8 === 1) c = mix(c, hex('9e4539'), 0.35); // each board's lit edge
  else if ((x + board * 23) % 53 < 9 && (y - (T.cy - T.ry)) % 8 === 4) c = mix(c, hex('2e222f'), 0.4); // a long grain line
  if (d > 0.86) c = dyTop < 0 ? hex('cd683d') : hex('9e4539'); // the brass-bound rim, lit from the lamp above
  if (d > 0.94) c = hex('2e222f');
  img[y][x] = c;
}
// the lamp: a chain from the ceiling and a brass shade over the table
const L = { x: 160, y: 58 };
for (let y = 0; y < L.y - 5; y++) if (y % 3 !== 2) put(L.x, y, hex('4c3e24'), true);
for (let y = L.y - 5; y < L.y; y++) { const w = (y - (L.y - 5)) * 2 + 2; for (let x = -w; x <= w; x++) put(L.x + x, y, Math.abs(x) === w ? hex('2e222f') : y < L.y - 2 ? hex('cd683d') : hex('f79617'), true); }
for (let x = -3; x <= 3; x++) put(L.x + x, L.y, hex('fbff86'), true);
// lamplight: a halo round the lamp, and its warm pool on the table and the floor below
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (exact[y][x]) continue;
  const halo = Math.max(0, 1 - Math.hypot(x - L.x, (y - L.y) * 1.4) / 40) ** 2 * 0.45;
  const pool = Math.max(0, 1 - Math.hypot((x - T.cx) / 115, (y - (T.cy - 6)) / 64)) ** 1.3 * 0.7;
  let c = img[y][x];
  if (halo > 0) c = mix(c, hex('fbb954'), halo);
  if (pool > 0) c = mix(c, hex('e6904e'), pool);
  img[y][x] = c;
}
// deep shadow at the edges
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (exact[y][x]) continue;
  const v = Math.max(0, Math.hypot((x - W / 2) / (W * 0.6), (y - H * 0.6) / (H * 0.7)) - 0.6) * 1.8;
  if (v > 0) img[y][x] = mix(img[y][x], hex('2e222f'), Math.min(0.9, v));
}

const out = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const c = exact[y][x] ? img[y][x] : near(img[y][x].map((v) => Math.max(0, Math.min(255, v + BAYER[y % 4][x % 4] * 12))));
  out.set(c, (y * W + x) * 3);
}
await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png({ palette: true, colours: 64, dither: 0 }).toFile(process.argv[2] ?? 'saloon.png');

// A dice cup, upside down on the table, seen from above at the same three-quarter angle: dark leather, a stitched band, the
// lamp catching its top. 18 x 20, transparent round it, one-pixel dark outline.
const CW = 18, CH = 20;
const cup = Array.from({ length: CH }, () => Array(CW).fill(null));
for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
  const cx = (CW - 1) / 2;
  const topD = ((x - cx) / 6.5) ** 2 + ((y - 5) / 3) ** 2; // the cup's base, now its top
  const bodyHalf = 6.5 + (y - 5) * 0.18; // it widens towards the mouth
  const inBody = y >= 5 && y <= 15 && Math.abs(x - cx) <= bodyHalf;
  const mouthD = ((x - cx) / 8.4) ** 2 + ((y - 15) / 3.2) ** 2;
  if (topD <= 1) cup[y][x] = topD < 0.45 ? hex('9e4539') : hex('6e2727');
  else if (inBody || mouthD <= 1) {
    const side = (x - cx) / bodyHalf;
    cup[y][x] = side < -0.55 ? hex('6e2727') : side > 0.5 ? hex('2e222f') : hex('7a3045');
    if (y === 11 || y === 12) cup[y][x] = (x % 2 === 0) ? hex('9e4539') : hex('2e222f'); // the stitched band
  }
}
const cupOut = cup.map((row, y) => row.map((c, x) => c ?? ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cup[y + dy]?.[x + dx]) ? hex('2e222f') : null)));
const buf = Buffer.alloc(CW * CH * 4);
cupOut.forEach((row, y) => row.forEach((c, x) => { if (c) buf.set([...c, 255], (y * CW + x) * 4); }));
if (process.argv[3]) await sharp(buf, { raw: { width: CW, height: CH, channels: 4 } }).png({ palette: true, colours: 16 }).toFile(process.argv[3]);
console.log('saloon', `${W}x${H}`, process.argv[3] ? `cup ${CW}x${CH}` : '');
