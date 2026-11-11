// A sealed deck. Every round's cards come from one secret the house draws before the deal: the seed. The deck is shuffled from
// it by a fixed rule, and a seal, one hash over the table, the round, the seed and the whole deck order, goes up before any
// card is dealt or passed. When the round ends the seed and the deck order open, so anyone can recheck, from the record alone:
// the seal, that the deck is the seed's shuffle, every pass, every hand, and every claim's verdict.
//
// What it proves and what it doesn't: the house can't change a card once the seal is up, and the deck follows from the seed by
// a rule anyone can run. Nothing mixes a player's randomness into the seed yet (Cup & Claim's dice do that), and the seal
// lives on this server, not on chain. It is not a zero-knowledge proof: the hands are public once the round is over.
//
// The same piece as Cup & Claim's (platform/seal.js): SHA-256, hex, domain tags as strings in the hash.

import { newDeck } from './cards.js';
import { concat, fromHex, newSeed, sha256, toHex, u32, u64, utf8 } from '../../platform/seal.js';

export const DOMAIN = { shuffle: 'sealed-hand/shuffle/v1', seal: 'sealed-hand/seal/v1' };

/** A fresh deck seed from the table's generator. */
export const newDeckSeed = newSeed;

/**
 * The shuffle, from the seed alone: Fisher-Yates over the fresh deck (2 to A of clubs, diamonds, hearts, spades), where the
 * pick at step i is the first four bytes of SHA-256(domain ‖ seed ‖ u32 i) taken mod (i + 1). The bias of the mod is below one
 * part in eighty million; fine for play chips, and the page runs the same rule.
 */
export function deckOrder(seedHex) {
  const deck = newDeck();
  const seed = fromHex(seedHex);
  for (let i = deck.length - 1; i > 0; i--) {
    const r = sha256(concat(utf8(DOMAIN.shuffle), seed, u32(i)));
    const j = (((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export const SEAL_NOTE = 'SHA-256(domain ‖ u32 table ‖ u64 round ‖ seed ‖ the 52 cards in order, space-separated, as text)';

/** The round's deck seal: one hash over the record's number, the seed and the whole deck order. Posted before any card moves. */
export const deckSeal = ({ table, round, seed, deck }) => toHex(sha256(concat(utf8(DOMAIN.seal), u32(table), u64(round), fromHex(seed), utf8(deck.join(' ')))));

/** Anyone can check an opened deck: the seal recomputes, the deck is the seed's shuffle, and it is a whole deck. */
export function verifyDeck({ table, round, seed, deck, seal }) {
  if (!Array.isArray(deck) || deck.length !== 52 || new Set(deck).size !== 52) return false;
  if (deckSeal({ table, round, seed, deck }) !== seal) return false;
  const again = deckOrder(seed);
  return again.every((c, i) => c === deck[i]);
}
