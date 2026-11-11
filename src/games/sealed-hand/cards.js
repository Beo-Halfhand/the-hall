// Cards and claims. Pure: no I/O, no clock, no randomness of its own.
//
// A card is a two-character string, rank then suit: "Ah", "Td", "2c".
// A claim is [cat, r1, r2], compared lexicographically. Ranks are 2..14 (A = 14); 0 = not stated.

export const CAT = { PAIR: 1, TWO_PAIR: 2, THREE: 3, STRAIGHT: 4, FLUSH: 5, FULL: 6, FOUR: 7, STRAIGHT_FLUSH: 8 };

const RANK_CHARS = '23456789TJQKA';
const SUITS = 'cdhs';
const RANK_NAMES = { 2: '2s', 3: '3s', 4: '4s', 5: '5s', 6: '6s', 7: '7s', 8: '8s', 9: '9s', 10: '10s', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const RANK_ONE = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };

export const rankOf = (card) => RANK_CHARS.indexOf(card[0]) + 2;
export const suitOf = (card) => card[1];
export const isCard = (c) => typeof c === 'string' && c.length === 2 && RANK_CHARS.includes(c[0]) && SUITS.includes(c[1]);

export function newDeck() {
  const deck = [];
  for (const r of RANK_CHARS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

/** Fisher-Yates using an injected rng() in [0, 1). */
export function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function compareClaims(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

const isRank = (r) => Number.isInteger(r) && r >= 2 && r <= 14;

/** Pads [cat, r1] to [cat, r1, 0]. Returns null if the shape can never be a legal claim. */
export function normalizeClaim(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) return null;
  const c = [raw[0], raw[1] ?? 0, raw[2] ?? 0];
  if (!c.every(Number.isInteger)) return null;
  const [cat, r1, r2] = c;
  switch (cat) {
    case CAT.PAIR:
    case CAT.THREE:
    case CAT.FOUR:
      return isRank(r1) && r2 === 0 ? c : null;
    case CAT.TWO_PAIR: // r1 & r2, or "r1 high" with r2 = 0. r1 is the higher pair.
      return isRank(r1) && r1 >= 3 && (r2 === 0 || (isRank(r2) && r2 < r1)) ? c : null;
    case CAT.STRAIGHT: // top 5 is the wheel (A-2-3-4-5)
      return r1 >= 5 && r1 <= 14 && r2 === 0 ? c : null;
    case CAT.FLUSH: // optional top. Lowest possible top card of 5 suited cards is 6.
      return (r1 === 0 || (r1 >= 6 && r1 <= 14)) && r2 === 0 ? c : null;
    case CAT.FULL: // r1 over r2, or "r1 full" with r2 = 0
      return isRank(r1) && (r2 === 0 || (isRank(r2) && r2 !== r1)) ? c : null;
    case CAT.STRAIGHT_FLUSH: // no rank in the claim, per the rules
      return r1 === 0 && r2 === 0 ? c : null;
    default:
      return null;
  }
}

function rankCounts(hand) {
  const counts = {};
  for (const card of hand) counts[rankOf(card)] = (counts[rankOf(card)] ?? 0) + 1;
  return counts;
}

function straightTop(hand) {
  const ranks = [...new Set(hand.map(rankOf))].sort((a, b) => a - b);
  if (ranks.length !== 5) return 0;
  if (ranks[4] - ranks[0] === 4) return ranks[4];
  if (ranks.join() === '2,3,4,5,14') return 5; // wheel
  return 0;
}

const isFlush = (hand) => hand.length === 5 && hand.every((c) => suitOf(c) === suitOf(hand[0]));

/** TRUE only if the hand CONTAINS that exact combination. A set of 9s contains a pair of 9s. */
export function contains(hand, [cat, r1, r2]) {
  const n = rankCounts(hand);
  const has = (r, k) => (n[r] ?? 0) >= k;
  const otherAtLeast = (k, test) => Object.keys(n).some((r) => Number(r) !== r1 && n[r] >= k && test(Number(r)));
  switch (cat) {
    case CAT.PAIR:
      return has(r1, 2);
    case CAT.TWO_PAIR:
      if (!has(r1, 2)) return false;
      return r2 ? has(r2, 2) : otherAtLeast(2, (r) => r < r1);
    case CAT.THREE:
      return has(r1, 3);
    case CAT.STRAIGHT:
      return straightTop(hand) === r1;
    case CAT.FLUSH:
      return isFlush(hand) && (r1 === 0 || Math.max(...hand.map(rankOf)) === r1);
    case CAT.FULL:
      if (!has(r1, 3)) return false;
      return r2 ? has(r2, 2) : otherAtLeast(2, () => true);
    case CAT.FOUR:
      return has(r1, 4);
    case CAT.STRAIGHT_FLUSH:
      return isFlush(hand) && straightTop(hand) > 0;
    default:
      return false;
  }
}

export function labelClaim([cat, r1, r2]) {
  switch (cat) {
    case CAT.PAIR: return `pair of ${RANK_NAMES[r1]}`;
    case CAT.TWO_PAIR: return r2 ? `two pair, ${RANK_NAMES[r1]} and ${RANK_NAMES[r2]}` : `two pair, ${RANK_NAMES[r1]} high`;
    case CAT.THREE: return `three ${RANK_NAMES[r1]}`;
    case CAT.STRAIGHT: return `straight to the ${RANK_ONE[r1]}`;
    case CAT.FLUSH: return r1 ? `${RANK_ONE[r1]}-high flush` : 'flush';
    case CAT.FULL: return r2 ? `full house, ${RANK_NAMES[r1]} over ${RANK_NAMES[r2]}` : `${RANK_NAMES[r1]} full`;
    case CAT.FOUR: return `four ${RANK_NAMES[r1]}`;
    case CAT.STRAIGHT_FLUSH: return 'straight flush';
    default: return 'unknown claim';
  }
}

function buildLadder() {
  const out = [];
  for (let cat = CAT.PAIR; cat <= CAT.STRAIGHT_FLUSH; cat++)
    for (let r1 = 0; r1 <= 14; r1++)
      for (let r2 = 0; r2 <= 14; r2++) {
        const c = normalizeClaim([cat, r1, r2]);
        if (c) out.push(c);
      }
  return out.sort(compareClaims);
}

/** Every legal claim, lowest to highest. */
export const LADDER = buildLadder();

const ladderKey = (c) => c.join();
const LADDER_INDEX = new Map(LADDER.map((c, i) => [ladderKey(c), i]));

/** Index of the first rung strictly above `top` (0 when there is no top). */
export function firstRungAbove(top) {
  return top ? LADDER_INDEX.get(ladderKey(top)) + 1 : 0;
}

export function truthfulAbove(hand, top) {
  return LADDER.slice(firstRungAbove(top)).filter((c) => contains(hand, c));
}

/** The highest rung this hand can truthfully claim, or null. */
export function bestClaim(hand) {
  for (let i = LADDER.length - 1; i >= 0; i--) if (contains(hand, LADDER[i])) return LADDER[i];
  return null;
}

export const handCategory = (hand) => bestClaim(hand)?.[0] ?? 0;

/** Heuristic value of the cards left after a pass. Used by bots and by the auto-pass on timeout. */
function keepScore(cards) {
  const counts = Object.values(rankCounts(cards)).sort((a, b) => b - a);
  let score = 0;
  if (counts[0] === 4) score += 800;
  else if (counts[0] === 3) score += 300;
  else if (counts[0] === 2 && counts[1] === 2) score += 200;
  else if (counts[0] === 2) score += 100;
  const suitRun = Math.max(...SUITS.split('').map((s) => cards.filter((c) => suitOf(c) === s).length));
  if (suitRun === 4) score += 60;
  else if (suitRun === 3) score += 10;
  const ranks = [...new Set(cards.map(rankOf))].sort((a, b) => a - b);
  if (ranks.length === 4 && ranks[3] - ranks[0] <= 4) score += 50;
  const lowAce = [...new Set(cards.map((c) => (rankOf(c) === 14 ? 1 : rankOf(c))))].sort((a, b) => a - b);
  if (lowAce.length === 4 && lowAce[3] - lowAce[0] <= 4) score += 40;
  return score + cards.reduce((sum, c) => sum + rankOf(c), 0) / 100;
}

/** The card whose loss hurts the hand least. Deterministic. */
export function leastHurtCard(hand) {
  let best = hand[0];
  let bestScore = -Infinity;
  for (const card of hand) {
    const score = keepScore(hand.filter((c) => c !== card));
    if (score > bestScore) [best, bestScore] = [card, score];
  }
  return best;
}
