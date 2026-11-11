// Draws every sprite and writes it to public/art/. All original, from code.
// You only need this to change the art; the PNGs are committed and the site has no build step.
//   node scripts/art/build.js

import { PALETTE, save } from './lib.js';
import * as C from './characters.js';
import * as I from './inn.js';

const OUT = new URL('../../public/art/', import.meta.url).pathname;

// Fixed furniture in each room. Table spots are in public/js/room.js, so the registry can fill them.
const WIDE = {
  windows: [168, 440],
  shelf: { x: 26, w: 120 },
  hearth: 540,
  lanterns: [156, 216, 408, 490, 616],
  rug: { x: 216, y: 150, w: 208, h: 130 },
  bar: { x: 20, y: 96, w: 140 },
  door: 288,
};
const TALL = {
  windows: [198],
  shelf: { x: 14, w: 120 },
  lanterns: [146, 186, 268],
  rug: { x: 56, y: 160, w: 208, h: 122 },
  bar: { x: 12, y: 96, w: 128 },
  door: 128,
};

const files = {
  'room-wide.png': I.room(20, 12, WIDE),
  'room-tall.png': I.room(10, 17, TALL),
  'table-cards.png': I.cardTableLit(),
  'table-cards-dark.png': I.cardTableDark(),
  'table-axes.png': I.axeLane(),
  'table-wheel.png': I.rouletteWheel(),
  'rope-sign.png': I.ropeAndSign(),
  'doorman.png': C.clockworkDoorman(),
  'portrait-doorman.png': C.clockworkPortrait(),
  'seat-brannock.png': C.brannockSeated(),
  'seat-oldwick.png': C.oldWickSeated(),
  'seat-adventurer.png': C.adventurerSeated(),
  'seal.png': I.seal(24),
  'cards.png': I.cardAtlas(),
  'back-mini.png': I.miniBack(),
  'coin.png': I.coin(),
  'scene-wall.png': I.tableScene(),
  'scene-table.png': I.tableFront(),
};

for (const [name, img] of Object.entries(files)) {
  save(img, OUT + name);
  console.log(`${name.padEnd(24)} ${img.w}×${img.h}`);
}
console.log(`palette: ${PALETTE.length} colours`);
