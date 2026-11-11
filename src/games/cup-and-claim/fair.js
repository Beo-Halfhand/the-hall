// Fair dice. Every roll comes from two secrets sealed before anyone sees a die: the player's seed and the
// house's seed. Each is committed by hash at the deal; the dice are a hash of both. Nobody can pick a roll:
// the house can't (it commits first, and the player's seed is mixed in), and the player can't (the house seed is).
//
// In this play-chip build the server keeps every seed and "proves" a count by attesting it. The shape is the one a
// Compact circuit replaces: public (houseSeed, commit, face, count), witness (playerSeed), and the circuit checks
// commit == H(playerSeed), re-rolls the dice from both seeds, and counts the face with 1s wild. See the spec.
//
// SHA-256 is written out (platform/seal.js) so the rules engine stays synchronous and runs the same in Node and in a Worker.

// The hashing itself is the shared piece in platform/seal.js (Sealed Hand's deck seal uses the same one); re-exported here so
// nothing that imports fair.js has to move.
import { SEED_BYTES, concat, fromHex, newSeed, sha256, toHex, u32, utf8 } from '../../platform/seal.js';

export { SEED_BYTES, fromHex, newSeed, sha256, toHex };

// Domain tags, so a commitment can't be replayed as a roll or the other way round.
export const DOMAIN = { commit: 'cup-and-claim/commit/v1', house: 'cup-and-claim/house/v1', roll: 'cup-and-claim/roll/v1', fingerprint: 'cup-and-claim/fingerprint/v1' };

export const FACES = [2, 3, 4, 5, 6]; // what a bid can name. 1s are wild, so nobody bids on them.
export const WILD = 1;


/** The player's commitment: what goes public at the deal, before any die is seen. */
export const commitSeed = (seedHex) => toHex(sha256(concat(utf8(DOMAIN.commit), fromHex(seedHex))));

/** The house's commitment, published at the deal and opened when the round ends. */
export const commitHouse = (houseSeedHex) => toHex(sha256(concat(utf8(DOMAIN.house), fromHex(houseSeedHex))));

/**
 * The dice under one cup: `n` values 1..6 from the hash of both seeds, the seat and the round. Each die takes two
 * hash bytes mod 6; 65536 mod 6 is 4, so the bias toward 1..4 is 1 part in 16 384. Fine for play chips, and the
 * circuit can do the same arithmetic.
 */
export function rollDice(houseSeedHex, playerSeedHex, seat, round, n = 5) {
  const bytes = sha256(concat(utf8(DOMAIN.roll), fromHex(houseSeedHex), fromHex(playerSeedHex), u32(seat), u32(round)));
  const dice = [];
  for (let k = 0; k < n; k++) dice.push((((bytes[2 * k] << 8) | bytes[2 * k + 1]) % 6) + 1);
  return dice;
}

/** How many of `face` this cup holds, 1s counted as wild. */
export const countFace = (dice, face) => dice.filter((d) => d === face || d === WILD).length;

/**
 * What a seat sends out when it keeps its cup shut: the count, and an attestation that the house checked it against
 * the commitment. This is the one object the ZK proof replaces, so its shape is the proof's public interface.
 */
export function proveCount({ dice, face, commit, houseSeed, seat, round }) {
  return {
    kind: 'house-attested', // later: 'compact-proof', with the proof bytes beside it
    statement: { commit, houseSeed, seat, round, face, count: countFace(dice, face) },
  };
}

export const FINGERPRINT_NOTE = 'SHA-256(domain ‖ u32 table ‖ u64 round ‖ houseCommit ‖ each seat commit, 32 zero bytes for a seat not dealt in)';

/**
 * The round's dice fingerprint: one hash over everything sealed at the deal, tied to the round's public number. It goes up before
 * anyone sees a die. It binds the seeds, so neither the house's seed nor a seat's can be swapped once it's out.
 */
export function roundFingerprint({ table, round, houseCommit, commits }) {
  const zero = new Uint8Array(SEED_BYTES);
  const high = Math.floor(round / 2 ** 32);
  return toHex(sha256(concat(utf8(DOMAIN.fingerprint), u32(table), u32(high), u32(round >>> 0), fromHex(houseCommit), ...commits.map((c) => (c ? fromHex(c) : zero)))));
}

/** Anyone can check an opened cup: the seed matches the commitment, and the dice match the two seeds. */
export function verifyShown({ houseSeed, houseCommit, seed, commit, seat, round, dice }) {
  if (commitSeed(seed) !== commit) return false;
  if (commitHouse(houseSeed) !== houseCommit) return false;
  const again = rollDice(houseSeed, seed, seat, round, dice.length);
  return again.every((d, i) => d === dice[i]);
}

// ---------- proof tables: the same arithmetic as sealed-cage's contracts/dice-proof.compact, to the bit ----------
// test/dice-proof-fair.test.js holds these to vectors written by the compiled contract. persistentHash is SHA-256 of the fields in
// order: Bytes as they are, a Uint<N> little-endian. Here the server only ever computes the house's own seats: a player's seed
// never reaches it, so a player's dice can't be worked out here, or anywhere but that player's page.

const tag = (name) => { const out = new Uint8Array(32); out.set(utf8(`cup-and-claim:${name}:v2`)); return out; };
const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const roundBytes = (table, round) => concat(le32(table), le32(round));
const DIE_LIMITS = [10923, 21846, 32768, 43691, 54614];

export const proofKeyId = (skHex) => toHex(sha256(concat(tag('seat'), fromHex(skHex))));
export const proofHouseCommit = (seedHex, table, round) => toHex(sha256(concat(tag('house'), fromHex(seedHex), roundBytes(table, round))));
export const proofCommit = (seedHex, table, round, seat, selfHex) => toHex(sha256(concat(tag('commit'), fromHex(seedHex), roundBytes(table, round), new Uint8Array([seat]), fromHex(selfHex))));
export const proofPreSeal = (commitHex, table, round, seat) => toHex(sha256(concat(tag('preseal'), fromHex(commitHex), roundBytes(table, round), new Uint8Array([seat]))));
export const proofSalt = (houseSeedHex, table, round, cupsHex, selfHex) => toHex(sha256(concat(tag('salt'), fromHex(houseSeedHex), roundBytes(table, round), ...cupsHex.map(fromHex), fromHex(selfHex))));
const dieOf = (hi, lo) => { const w = hi * 256 + lo; return 1 + DIE_LIMITS.filter((t) => w >= t).length; };
/** The five dice under one cup, from the round's salt, that cup's seed and its seat. */
export function proofDice(saltHex, seedHex, seat) {
  const r = sha256(concat(tag('roll'), fromHex(saltHex), fromHex(seedHex), new Uint8Array([seat])));
  return [0, 2, 4, 6, 8].map((i) => dieOf(r[i], r[i + 1]));
}
