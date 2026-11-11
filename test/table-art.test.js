// Cup & Claim's table art, round 3 (The owner, 11-06): the room as he made it, the official symbol laid on the tapestry whole or
// not at all, and his two Grok cups cut out of their black backgrounds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { markWhole } from '../public/js/tapestry-mark.js';

const MARK = { cy: 330, size: 120, cloth: { top: 90, bottom: 690 } }; // as in public/js/dice.js: on the wood wall beside the tapestry, round 2
const H = 1728;

test('tapestry symbol: whole in every frame the page uses, and left out (not clipped) by a frame that would cut it', () => {
  assert.equal(markWhole({ top: 0, bottom: 0 }, H, MARK), true, 'a phone: the whole room');
  assert.equal(markWhole({ top: 175 / H, bottom: 318 / H }, H, MARK), true, 'a wide screen: rows 175 to 1410');
  assert.equal(markWhole({ top: 330 / H, bottom: 0 }, H, MARK), false, 'a crop through the symbol: left out');
  assert.equal(markWhole({ top: 310 / H, bottom: 0 }, H, MARK), false, 'a crop just above it, no cloth round it: left out');
  assert.equal(markWhole({ top: 0, bottom: (H - 420) / H }, H, MARK), false, 'cut from below: left out');
});

const webpHasAlpha = (file) => {
  const b = readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WEBP');
  return b.toString('ascii', 12, 16) === 'VP8X' && (b[20] & 0x10) !== 0;
};

test('the cups: The owner\'s two Grok cups, kept as he made them, cut out with transparency for the table', () => {
  for (const [src, original] of [['art-source/cups/2026-11-06-dice-cup-down-grok-A.png', 'down'], ['art-source/cups/2026-11-06-dice-cup-upright-grok.png', 'up']]) {
    assert.ok(readFileSync(src).length > 500_000, `${original}: The owner's original is kept`);
    assert.ok(webpHasAlpha(`public/art/dice/cup-${original}.webp`), `cup-${original}.webp has an alpha channel`);
    assert.ok(webpHasAlpha(`public/art/dice/cup-${original}-s.webp`), `cup-${original}-s.webp (the small sharpened copy, round 3) has an alpha channel`);
  }
});

test('the room: The owner\'s picture re-encoded, the symbol no longer baked into it; the symbol is the brand file', () => {
  assert.ok(!webpHasAlpha('public/art/dice/table-room-1152.webp'));
  const svg = readFileSync('public/brand/midnight/Midnight-RGB_Symbol-White.svg', 'utf8');
  assert.match(svg, /^<svg|<\?xml/);
  // the official Midnight Logo Pack file, 02_Symbol/Midnight-RGB_Symbol-White.svg, byte for byte
  assert.equal(createHash('sha256').update(readFileSync('public/brand/midnight/Midnight-RGB_Symbol-White.svg')).digest('hex'), 'dcc0606d0cedf617b26132a96659f1f3fa74e7027fea9ae983d875d9a1b702b2');
  const css = readFileSync('public/css/dice.css', 'utf8');
  assert.match(css, /url\(\/art\/dice\/dice\.svg\)/, 'the dice are the sharp, bright faces');
  assert.doesNotMatch(css, /dice-px\.svg/, 'not the pixel-art faces');
});
