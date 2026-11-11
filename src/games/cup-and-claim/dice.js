// Bids and dice words. A bid is { count, face }: "at least `count` dice on the whole table show `face`", with 1s
// wild. Bids rise by count, then by face. Nobody bids on 1s.

import { FACES } from './fair.js';

const ONE = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
const MANY = { 2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes' };
export const PIPS = { 1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅' };

export const isFace = (face) => FACES.includes(face);

/** { count, face } with whole numbers, or null. */
export function normalizeBid(input) {
  if (!input || typeof input !== 'object') return null;
  const count = input.count;
  const face = input.face;
  if (!Number.isInteger(count) || !Number.isInteger(face) || count < 1 || !isFace(face)) return null;
  return { count, face };
}

/** Positive if a is the higher bid. */
export const compareBids = (a, b) => a.count - b.count || a.face - b.face;

/** The lowest bid above `bid`, or the opening bid when there is none. */
export function nextBidAbove(bid) {
  if (!bid) return { count: 1, face: FACES[0] };
  if (bid.face < FACES.at(-1)) return { count: bid.count, face: bid.face + 1 };
  return { count: bid.count + 1, face: FACES[0] };
}

export const labelBid = (bid) => (bid ? `at least ${bid.count} ${bid.count === 1 ? ONE[bid.face] : MANY[bid.face]}` : 'nothing');
export const faceWord = (face, plural = true) => (plural ? MANY[face] : ONE[face]);
