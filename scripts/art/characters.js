// Original characters, drawn from shapes. 32×48 sprites, two idle frames side by side.
// Seated sprites are drawn down to the waist; the table covers the rest.

import { Img, INK, R, shade } from './lib.js';

const W = 32;
const H = 48;

/** Chair back behind a seated character. */
function chair(g, cx, top) {
  g.rect(cx - 11, top, 22, H - top, R.oak[0]);
  g.rect(cx - 10, top + 1, 20, 2, R.oak[1]);
  g.rect(cx - 11, top, 2, H - top, R.oak[1]);
  g.rect(cx + 9, top, 2, H - top, R.oak[0]);
  g.px(cx - 10, top + 1, R.oak[2]);
  g.px(cx + 9, top + 1, R.oak[2]);
}

function strip(frames) {
  const sheet = new Img(W * frames.length, H);
  frames.forEach((f, i) => sheet.blit(f, i * W, 0));
  return sheet;
}

/** Shaded vertical torso between two widths. */
function torso(g, cx, top, bottom, topHalf, bottomHalf, ramp) {
  g.poly([[cx - topHalf, top], [cx + topHalf, top], [cx + bottomHalf, bottom], [cx - bottomHalf, bottom]], (x, y) => {
    const span = topHalf + ((y - top) / (bottom - top)) * (bottomHalf - topHalf);
    return shade(ramp, x, y, 0.62 - ((x - cx) / span) * 0.38);
  });
}

/** The brass doorman, standing, for when the painted set is missing. Two small lights for eyes, gears at chest and knees. */
function clockworkBody(flicker) {
  const g = new Img(W, H);
  const cx = 16;
  const eye = flicker ? R.amber[3] : R.amber[2];
  const gear = (x, y, r) => {
    g.ball(x, y, r, r, R.amber, { light: 0.6 });
    g.px(x, y, R.oak[0]);
  };
  // legs and boots
  g.rect(cx - 6, 30, 5, 13, R.oak[2]);
  g.rect(cx + 1, 30, 5, 13, R.oak[1]);
  g.rect(cx - 7, 43, 6, 3, R.oak[1]);
  g.rect(cx + 1, 43, 6, 3, R.oak[0]);
  gear(cx - 4, 36, 2);
  gear(cx + 3, 36, 2);
  // arms
  g.rect(cx - 11, 17, 3, 13, R.oak[2]);
  g.rect(cx + 8, 17, 3, 13, R.oak[1]);
  g.rect(cx - 11, 30, 3, 3, R.slate[1]);
  g.rect(cx + 8, 30, 3, 3, R.slate[1]);
  // body
  torso(g, cx, 15, 30, 8, 5, R.amber);
  g.ball(cx - 8, 16, 3, 3, R.amber, { light: 0.7 }); // shoulders
  g.ball(cx + 8, 16, 3, 3, R.amber, { light: 0.45 });
  gear(cx, 21, 3);
  g.rect(cx - 5, 27, 10, 2, R.oak[1]); // belt
  // head
  g.rect(cx - 2, 12, 4, 3, R.slate[1]);
  g.ball(cx, 8, 6, 6, R.amber, { light: 0.6 });
  g.rect(cx - 5, 7, 10, 3, R.oak[0]);
  g.rect(cx - 4, 8, 2, 1, eye);
  g.rect(cx + 2, 8, 2, 1, eye);
  g.rect(cx - 2, 11, 4, 2, R.oak[0]); // jaw
  return g;
}

export function lantern(g, cx, top, flicker = 0) {
  g.rect(cx - 2, top, 5, 1, R.slate[1]);
  g.rect(cx - 3, top + 1, 7, 7, R.slate[0]);
  g.rect(cx - 2, top + 2, 5, 5, flicker ? R.amber[2] : R.amber[1]);
  g.rect(cx - 1, top + 3, 3, 3, flicker ? R.amber[3] : R.amber[2]);
  g.px(cx, top + 4, R.amber[3]);
  g.rect(cx - 3, top + 8, 7, 1, R.slate[1]);
  g.px(cx - 3, top + 1, R.slate[2]);
}

export const clockworkDoorman = () => framed([clockworkBody(0), clockworkBody(1)]);

function framed(frames) {
  frames.forEach((f) => f.outline());
  return strip(frames);
}

/** Brannock: broad as a barrel, red beard, bald head, tankard up. */
function brannockBody(bob, tankardUp) {
  const g = new Img(W, H);
  const cx = 16;
  const t = bob;
  chair(g, cx, 18);
  torso(g, cx, 25 + t, H, 13, 14, R.wine); // huge chest in a wine-red shirt
  g.rect(cx - 13, 30 + t, 26, 2, R.oak[0]); // belt across
  g.rect(cx - 2, 30 + t, 4, 2, R.amber[1]);
  g.ball(cx - 13, 29 + t, 3.5, 4, R.wine, { light: 0.55 }); // shoulders
  g.ball(cx + 13, 29 + t, 3.5, 4, R.wine, { light: 0.25 });
  // head
  g.ball(cx, 15 + t, 7.5, 8, R.skin, { light: 0.55 });
  g.px(cx - 8, 15 + t, R.skin[1]);
  g.px(cx + 8, 15 + t, R.skin[0]);
  // brow, eyes
  g.line(cx - 5, 13 + t, cx - 2, 13 + t, R.wine[0]);
  g.line(cx + 2, 13 + t, cx + 5, 13 + t, R.wine[0]);
  g.px(cx - 3, 15 + t, INK);
  g.px(cx + 3, 15 + t, INK);
  g.px(cx - 4, 7 + t, R.skin[2]);
  // big red beard
  g.ball(cx, 22 + t, 8, 6.5, R.wine.slice(1).concat(R.amber[1]), { light: 0.5 });
  g.rect(cx - 2, 19 + t, 5, 1, R.wine[3]); // moustache
  g.rect(cx - 2, 21 + t, 5, 2, R.cream[1]); // grin
  g.line(cx - 2, 22 + t, cx + 2, 22 + t, R.cream[0]);
  // arm and tankard
  const ty = tankardUp ? 24 : 28;
  g.rect(24, ty + 4 + t, 5, 11 - (tankardUp ? 0 : 4), R.skin[1]);
  g.rect(24, ty + 4 + t, 1, 11 - (tankardUp ? 0 : 4), R.skin[2]);
  g.rect(23, ty + t, 7, 8, R.oak[1]);
  g.rect(23, ty + t, 2, 8, R.oak[2]);
  g.rect(23, ty + 2 + t, 7, 1, R.slate[2]);
  g.rect(23, ty - 1 + t, 7, 2, R.cream[1]); // froth
  g.px(30, ty + 3 + t, R.oak[1]);
  g.px(30, ty + 4 + t, R.oak[1]);
  return g;
}

/** Old Wick: thin and stooped, flat smith's cap, long white beard, leather apron, tongs at rest. */
function oldWickBody(bob, blink) {
  const g = new Img(W, H);
  const cx = 15;
  const t = bob;
  chair(g, 16, 14);
  torso(g, cx, 25 + t, H, 6, 7, R.slate);
  torso(g, cx, 28 + t, H, 4, 6, R.oak); // leather apron
  g.line(cx - 4, 24 + t, cx - 3, 29 + t, R.oak[0]); // straps
  g.line(cx + 4, 24 + t, cx + 3, 29 + t, R.oak[0]);
  g.ball(cx, 15 + t, 5, 6.5, R.skin, { light: 0.5 }); // long narrow head
  g.line(cx - 4, 16 + t, cx - 2, 16 + t, R.skin[0]); // lined face
  g.line(cx + 2, 16 + t, cx + 4, 16 + t, R.skin[0]);
  if (blink) {
    g.line(cx - 3, 14 + t, cx - 2, 14 + t, R.skin[0]);
    g.line(cx + 2, 14 + t, cx + 3, 14 + t, R.skin[0]);
  } else {
    g.px(cx - 2, 14 + t, INK);
    g.px(cx + 2, 14 + t, INK);
  }
  g.line(cx - 4, 12 + t, cx - 1, 13 + t, R.cream[1]); // white brows
  g.line(cx + 1, 13 + t, cx + 4, 12 + t, R.cream[1]);
  // flat cap
  g.ball(cx, 9 + t, 6.5, 3.5, R.slate, { light: 0.45 });
  g.rect(cx - 7, 10 + t, 15, 2, R.slate[0]);
  g.line(cx - 7, 10 + t, cx + 2, 10 + t, R.slate[1]);
  // long narrow beard, down to the apron
  g.poly([[cx - 4, 18 + t], [cx + 4, 18 + t], [cx + 2, 34 + t], [cx, 37 + t], [cx - 2, 34 + t]], (x, y) => shade(R.cream, x, y, 0.75 - (x - cx) * 0.11));
  g.line(cx - 1, 20 + t, cx - 1, 31 + t, R.cream[0]);
  g.line(cx - 2, 18 + t, cx + 2, 18 + t, R.cream[1]);
  g.rect(cx - 1, 19 + t, 3, 1, R.skin[0]); // quiet mouth
  // thin arm, hand on tongs leaning against the chair
  g.line(24, 16, 24, 40, R.slate[0]);
  g.line(25, 16, 25, 40, R.slate[1]);
  g.line(25, 12, 27, 16, R.slate[2]);
  g.line(24, 12, 22, 16, R.slate[1]);
  g.rect(21, 32 + t, 3, 8, R.slate[1]);
  g.ball(24, 34 + t, 2, 2, R.skin, { light: 0.5 });
  return g;
}

/** The generic adventurer for a seat with no art of its own: cap, cape, nothing fancy. */
function adventurerBody(bob, blink) {
  const g = new Img(W, H);
  const cx = 16;
  const t = bob;
  chair(g, cx, 18);
  g.poly([[cx - 8, 25 + t], [cx + 8, 25 + t], [cx + 11, H], [cx - 11, H]], (x, y) => shade(R.felt, x, y, 0.4 - ((x - cx) / 11) * 0.3)); // cape
  torso(g, cx, 25 + t, H, 7, 8, R.slate); // plain traveller's tunic
  g.rect(cx - 3, 25 + t, 6, 2, R.cream[0]); // collar
  g.rect(cx - 7, 34 + t, 14, 2, R.oak[1]); // belt
  g.px(cx, 34 + t, R.amber[2]);
  g.line(cx, 27 + t, cx, 33 + t, R.slate[0]);
  g.ball(cx, 17 + t, 6.5, 7, R.skin, { light: 0.55 });
  if (blink) {
    g.line(cx - 3, 18 + t, cx - 2, 18 + t, R.skin[0]);
    g.line(cx + 2, 18 + t, cx + 3, 18 + t, R.skin[0]);
  } else {
    g.rect(cx - 3, 17 + t, 1, 2, INK);
    g.rect(cx + 3, 17 + t, 1, 2, INK);
  }
  g.line(cx - 1, 22 + t, cx + 1, 22 + t, R.skin[0]);
  // hair and pointed cap with a feather
  g.ball(cx, 12 + t, 7, 5, R.felt, { light: 0.5, topOnly: true });
  g.rect(cx - 7, 12 + t, 14, 2, R.felt[1]);
  g.line(cx - 7, 12 + t, cx + 6, 12 + t, R.felt[2]);
  g.poly([[cx - 2, 8 + t], [cx + 6, 3 + t], [cx + 5, 9 + t]], R.felt[2]);
  g.line(cx + 6, 3 + t, cx + 10, 7 + t, R.wine[3]); // feather
  g.line(cx + 6, 4 + t, cx + 9, 8 + t, R.wine[2]);
  g.rect(cx - 7, 14 + t, 2, 3, R.oak[0]); // hair
  g.rect(cx + 6, 14 + t, 2, 3, R.oak[0]);
  return g;
}

export const brannockSeated = () => framed([brannockBody(0, false), brannockBody(1, true)]);
export const oldWickSeated = () => framed([oldWickBody(0, false), oldWickBody(0, true)]);
export const adventurerSeated = () => framed([adventurerBody(0, false), adventurerBody(1, true)]);

/** The doorman's dialogue portrait, for when the painted set is missing: a brass head and shoulders, eyes lit. */
export function clockworkPortrait() {
  const frames = [0, 1].map((flicker) => {
    const g = new Img(72, 72);
    g.area(0, 0, 72, 72, (x, y) => shade(R.night.slice(0, 3), x, y, 0.5 - (Math.hypot(x - 36, y - 24) / 72)));
    // shoulders
    g.poly([[2, 72], [8, 54], [24, 46], [48, 46], [64, 54], [70, 72]], (x, y) => shade(R.amber, x, y, 0.72 - (Math.hypot(x - 28, y - 46) / 60)));
    g.ball(11, 56, 8, 8, R.amber, { light: 0.7 });
    g.ball(61, 56, 8, 8, R.amber, { light: 0.45 });
    // chest gear
    g.ball(36, 64, 7, 7, R.amber, { light: 0.65 });
    g.ball(36, 64, 2, 2, [R.oak[0]], {});
    // neck and collar
    g.rect(29, 38, 14, 10, R.slate[1]);
    g.rect(24, 44, 24, 3, R.oak[1]);
    // head
    g.ball(36, 22, 17, 20, R.amber, { light: 0.62 });
    g.line(36, 3, 36, 15, R.oak[1]); // a seam over the crown
    // visor and eyes
    g.rect(22, 18, 28, 9, R.oak[0]);
    g.rect(25, 20, 7, 5, INK);
    g.rect(40, 20, 7, 5, INK);
    g.rect(26, 21, 5, 3, flicker ? R.amber[3] : R.amber[2]);
    g.rect(41, 21, 5, 3, flicker ? R.amber[3] : R.amber[2]);
    // jaw
    g.rect(30, 30, 12, 8, R.oak[1]);
    g.line(33, 31, 33, 37, R.oak[0]);
    g.line(36, 31, 36, 37, R.oak[0]);
    g.line(39, 31, 39, 37, R.oak[0]);
    // ear gear
    g.ball(52, 16, 4, 4, R.amber, { light: 0.5 });
    return g;
  });
  const sheet = new Img(144, 72);
  frames.forEach((f, i) => sheet.blit(f, i * 72, 0));
  return sheet;
}
