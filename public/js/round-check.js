// The checks a round's page runs in the browser, from the record alone. Cup & Claim: the fingerprint recomputed, the house secret against
// its seal, every shown cup re-rolled and re-counted. Sealed Hand: the deck seal recomputed, the deck as the seed's shuffle, every hand
// rebuilt from the opened deck and the passes, every called claim's verdict against the cards. Shared by a tNIGHT receipt and a play-chip
// round's record, which are the same arithmetic. What can't be checked here is said to be so.

const utf8 = (s) => new TextEncoder().encode(s);
const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const sha = async (...parts) => new Uint8Array(await crypto.subtle.digest('SHA-256', join(...parts)));

async function fingerprintOf(r) {
  const f = r.fingerprint;
  const zero = new Uint8Array(32);
  return toHex(await sha(utf8(f.domain), u32(r.table), u32(Math.floor(r.round / 2 ** 32)), u32(r.round >>> 0), fromHex(f.houseCommit), ...f.commits.map((c) => (c ? fromHex(c) : zero))));
}

// A proof table seals with dice-proof's own hashes (fair.js, proofHouseCommit): a 32-byte tag, the seed, then the table and round as little-endian words.
const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const tag = (name) => { const out = new Uint8Array(32); out.set(utf8(`cup-and-claim:${name}:v2`)); return out; };
export const proofHouseCommitOf = async (houseSeed, table, round) => toHex(await sha(tag('house'), fromHex(houseSeed), le32(table), le32(round)));

async function rollOf(houseSeed, seed, seat, round) {
  const b = await sha(utf8('cup-and-claim/roll/v1'), fromHex(houseSeed), fromHex(seed), u32(seat), u32(round));
  return [0, 1, 2, 3, 4].map((k) => (((b[2 * k] << 8) | b[2 * k + 1]) % 6) + 1);
}

/** Runs every check this page can do. Each result is pass, fail, or word: the server's word, which nobody here can recheck. */
export async function runChecks(r, opts = {}) {
  if (r.game === 'sealed-hand') return [...(await runHandChecks(r)), ...(await anchorChecks(r, opts))];
  return [...(await runDiceChecks(r)), ...(await anchorChecks(r, opts))];
}

// ---------- the lock on Midnight (11-08): the round's seal, attested on chain before the deal was played ----------

/** The metadata the vault holds beside the seal: binds it to this round's number (the same rule as seal-anchor.mjs). */
export const anchorMetaOf = async (number) => toHex(await sha(utf8(`sealed-hand/anchor/v1|${number}`)));

/** One query to the chain through the Hall's indexer (the key stays on the server). Null when there's no indexer or no answer. */
async function chainTx(txHash, indexer) {
  if (!indexer || !/^[0-9a-f]{64}$/.test(String(txHash ?? ''))) return null;
  try {
    const res = await fetch(indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ transactions(offset: { hash: "${txHash}" }) { hash raw block { height timestamp } } }` }) });
    if (!res.ok) return null;
    const t = (await res.json())?.data?.transactions?.[0];
    return t ? { hash: t.hash, raw: String(t.raw ?? '').toLowerCase(), block: t.block?.height ?? null, at: t.block?.timestamp ?? null } : { missing: true };
  } catch {
    return null;
  }
}

/**
 * The anchor's checks: the anchored hash is this record's seal, the vault entry names this round, the transaction on chain carries
 * the seal, and it landed before the round was revealed. `opts.indexer` is the Hall's /indexer/graphql (or none: the page says so).
 */
export async function anchorChecks(r, { indexer = null, fetchTx = chainTx } = {}) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  const seal = r.game === 'sealed-hand' ? r.seal?.hash : r.fingerprint?.hash;
  const what = r.game === 'sealed-hand' ? 'deck seal' : 'dice fingerprint';
  const a = r.anchor;
  if (!a) {
    if (r.anchorNote) add('word', `Not locked on Midnight: ${r.anchorNote.why}. The ${what} stands on this server's record only.`);
    return out;
  }
  if (!a.ok) {
    add('word', `The lock on Midnight failed (${a.error ?? a.outcome}). The ${what} stands on this server's record only.`);
    return out;
  }
  add(a.payload === seal ? 'pass' : 'fail', a.payload === seal ? `The hash locked on Midnight is this round's ${what}: ${seal.slice(0, 16)}…` : `The hash locked on Midnight (${String(a.payload).slice(0, 16)}…) is not this round's ${what} (${String(seal).slice(0, 16)}…).`);
  if (a.metadataHash) {
    const meta = await anchorMetaOf(r.number);
    add(meta === a.metadataHash ? 'pass' : 'fail', meta === a.metadataHash ? `The vault entry names this round, ${r.number}.` : `The vault entry names another round, not ${r.number}.`);
  }
  const tx = await fetchTx(a.txHash, indexer);
  let at = a.blockAt;
  if (!tx) add('word', `This page couldn't read the chain${indexer ? '' : ' (this Hall has no indexer of its own)'}: open transaction ${String(a.txHash ?? '').slice(0, 12)}… on the explorer to see it in block ${a.block}.`);
  else if (tx.missing) add('fail', `The chain has no transaction ${String(a.txHash).slice(0, 12)}…`);
  else {
    const carries = !!seal && tx.raw.includes(seal);
    add(carries ? 'pass' : 'fail', carries ? `On chain: transaction ${tx.hash.slice(0, 12)}… in block ${tx.block} carries this ${what}.` : `The transaction on chain (block ${tx.block}) does not carry this ${what}.`);
    if (tx.block !== null && a.block !== null && Number(tx.block) !== Number(a.block)) add('fail', `The record says block ${a.block}, the chain says ${tx.block}.`);
    at = tx.at ?? at;
  }
  const revealed = r.opened?.at ?? null;
  if (revealed === null) add('word', 'The round hasn’t been revealed yet: once it is, this checks the lock came first.');
  else if (at === null || at === undefined) add('word', 'No block time to compare with the reveal.');
  else {
    const t = (ms) => new Date(Number(ms)).toISOString().slice(11, 19);
    const before = Number(at) < Number(revealed);
    if (before) add('pass', `Locked before the reveal: block time ${t(at)} UTC, revealed ${t(revealed)} UTC.`);
    // Background mode doesn't wait for the lock, so a quick round can end first. Said plainly, not as a failure: the lock then fixes the
    // seal from its block on, but can't show the seal was fixed before play. Lock-first rounds can; a lock-first round locked late is ✗.
    else if (a.mode === 'background') add('word', `Locked ${Math.round((Number(at) - Number(revealed)) / 1000)} s after the reveal (block time ${t(at)} UTC, revealed ${t(revealed)} UTC). This round played in background mode, which doesn't wait for the lock: the lock fixes the ${what} from block ${a.block} on, but it can't show the ${what} was fixed before play. Lock-first rounds can.`);
    else add('fail', `Locked after the reveal: block time ${t(at)} UTC, revealed ${t(revealed)} UTC.`);
  }
  return out;
}

async function runDiceChecks(r) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  const fp = await fingerprintOf(r);
  add(fp === r.fingerprint.hash ? 'pass' : 'fail', `The fingerprint recomputes from its parts: ${fp.slice(0, 16)}…`);
  if (r.opened) {
    const house = r.dice ? await proofHouseCommitOf(r.opened.houseSeed, r.table, r.round) : toHex(await sha(utf8('cup-and-claim/house/v1'), fromHex(r.opened.houseSeed)));
    add(house === r.fingerprint.houseCommit ? 'pass' : 'fail', `The opened house secret matches the seal posted at the deal${r.dice ? ' (the seal the chain holds)' : ''}.`);
  } else add('word', 'The house secret is still sealed: the round hasn’t ended.');
  let counted = 0;
  for (const c of r.reveals ?? []) {
    const face = r.claim.face;
    if (r.dice) { // a proof table: the chain checked it, and this page can't read the chain, so it points at the transaction
      if (c.mode === 'silent') add('word', `${c.name} never answered. The chain shows no answer from that seat.`);
      else if (c.attested === 'compact-proof') add('word', `${c.name}: the chain checked ${c.mode === 'show' ? 'these dice' : `this count of ${c.count}`} against the seal${c.proofHash ? `, in transaction ${c.proofHash.slice(0, 12)}…` : ', on its own record of the cup'}.`);
      else add('word', `${c.name}: ${c.mode === 'show' ? 'showed the dice' : `a count of ${c.count}`} that the chain did not check: the house's word.`);
    } else if (c.mode === 'show') {
      const commit = toHex(await sha(utf8('cup-and-claim/commit/v1'), fromHex(c.seed)));
      const dice = await rollOf(r.opened.houseSeed, c.seed, c.seat, r.engineRound);
      const count = dice.filter((d) => d === face || d === 1).length;
      const good = commit === c.commit && r.fingerprint.commits[c.seat] === c.commit && dice.join() === c.dice.join() && count === c.count;
      add(good ? 'pass' : 'fail', `${c.name} showed ${c.dice.join(' ')}: the seal, the re-roll and the count of ${count} all match.`);
    } else add('word', `${c.name} kept the cup shut. The count of ${c.count} is the house’s word: nobody else can recheck it.`);
    counted += c.count ?? 0;
  }
  if (r.result?.kind === 'call') {
    const held = counted >= r.claim.count;
    add(counted === r.result.total && held === r.result.held ? 'pass' : 'fail', `The counts add up to ${counted}, and at least ${r.claim.count} ${held ? 'holds' : 'falls'}, as the receipt says.`);
  }
  const net = (r.chips ?? []).reduce((sum, l) => sum + l.delta, 0);
  if (r.chips?.length) add(net === 0 ? 'pass' : 'fail', 'The chips moved add up to zero: what one side lost, the other won.');
  if (r.settle) add('word', `Settled in block ${r.settle.block}. This page can’t read the chain itself: open the transaction above, or run check-receipt for table ${r.table}, round ${r.settle.chainRound ?? r.round}.`);
  else if (r.cage) add('word', 'No settle transaction yet.');
  else add('word', 'A play-chip round: no money moved on chain, so there is no settle transaction to find.');
  return out;
}


// ---------- Sealed Hand: the deck seal, the same rule as src/games/sealed-hand/fair.js and cards.js ----------

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const rankOf = (card) => RANKS.indexOf(card[0]) + 2;
const freshDeck = () => { const d = []; for (const r of RANKS) for (const su of SUITS) d.push(r + su); return d; };

/** The deck order from the seed: Fisher-Yates, the pick at step i the first four bytes of SHA-256(domain ‖ seed ‖ u32 i) mod (i + 1). */
export async function deckOrderOf(seedHex) {
  const deck = freshDeck();
  const seed = fromHex(seedHex);
  for (let i = deck.length - 1; i > 0; i--) {
    const r = await sha(utf8('sealed-hand/shuffle/v1'), seed, u32(i));
    const j = (((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** The deck seal over the record's number, the seed and the whole deck order, as the Worker posts it. */
export const deckSealOf = async ({ table, round, seed, deck }) => toHex(await sha(utf8('sealed-hand/seal/v1'), u32(table), u32(Math.floor(round / 2 ** 32)), u32(round >>> 0), fromHex(seed), utf8(deck.join(' '))));

const rankCounts = (hand) => { const n = {}; for (const c of hand) n[rankOf(c)] = (n[rankOf(c)] ?? 0) + 1; return n; };
const straightTop = (hand) => { const ranks = [...new Set(hand.map(rankOf))].sort((a, b) => a - b); if (ranks.length !== 5) return 0; if (ranks[4] - ranks[0] === 4) return ranks[4]; return ranks.join() === '2,3,4,5,14' ? 5 : 0; };
const isFlush = (hand) => hand.length === 5 && hand.every((c) => c[1] === hand[0][1]);

/** TRUE only if the hand contains that exact combination (cards.js contains, to the letter). */
export function handContains(hand, [cat, r1, r2]) {
  const n = rankCounts(hand);
  const has = (r, k) => (n[r] ?? 0) >= k;
  const otherAtLeast = (k, test) => Object.keys(n).some((r) => Number(r) !== r1 && n[r] >= k && test(Number(r)));
  switch (cat) {
    case 1: return has(r1, 2);
    case 2: return has(r1, 2) && (r2 ? has(r2, 2) : otherAtLeast(2, (r) => r < r1));
    case 3: return has(r1, 3);
    case 4: return straightTop(hand) === r1;
    case 5: return isFlush(hand) && (r1 === 0 || Math.max(...hand.map(rankOf)) === r1);
    case 6: return has(r1, 3) && (r2 ? has(r2, 2) : otherAtLeast(2, () => true));
    case 7: return has(r1, 4);
    case 8: return isFlush(hand) && straightTop(hand) > 0;
    default: return false;
  }
}

/**
 * Rebuilds every hand from the opened deck and the passes: each seat dealt in, in seat order, takes the next five cards; then each pass
 * moves its card from sender to receiver. Returns the hands, and the first pass that could not have happened (a card its sender didn't hold).
 */
export function rebuildHands(r) {
  const hands = (r.seats ?? []).map(() => null);
  const draw = [...r.opened.deck];
  for (const x of (r.seats ?? []).filter((x) => x.dealt).sort((a, b) => a.seat - b.seat)) hands[x.seat] = draw.splice(0, 5);
  let bad = null;
  (r.moves?.passes ?? []).forEach((list, i) => {
    const taken = [];
    for (const m of list) { // every card leaves first, then every card arrives: the passes of a window are simultaneous
      const at = hands[m.from]?.indexOf(m.card) ?? -1;
      if (at < 0) { bad ??= { pass: i + 1, ...m }; continue; }
      hands[m.from].splice(at, 1);
      taken.push(m);
    }
    for (const m of taken) (hands[m.to] ??= []).push(m.card);
  });
  return { hands, bad };
}

const nameOf = (r, seat) => r.seats?.find((x) => x.seat === seat)?.name ?? `Seat ${seat}`;
const HELD = { proven: 'called, and the cards held it', caught: 'called: a bluff' };

/** A Sealed Hand round: the seal, the shuffle, the deck, the hands, and every claim's verdict, each pass or fail; what's unopened is said so. */
export async function runHandChecks(r) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (!r.seal) {
    add('word', 'This round is from before the deck was sealed: the cards were the server’s word, and nothing here can recheck them.');
  } else if (!r.opened) {
    add('word', `The deck is sealed (${r.seal.hash.slice(0, 16)}…) and the round is in play: the seed and the deck open when it ends.`);
  } else {
    const { seed, deck } = r.opened;
    const seal = await deckSealOf({ table: r.table, round: r.round, seed, deck });
    add(seal === r.seal.hash ? 'pass' : 'fail', `The seal recomputes from the table, the round, the opened seed and the deck order: ${seal.slice(0, 16)}…`);
    const whole = Array.isArray(deck) && deck.length === 52 && new Set(deck).size === 52 && deck.every((c) => c.length === 2 && RANKS.includes(c[0]) && SUITS.includes(c[1]));
    add(whole ? 'pass' : 'fail', whole ? 'The opened deck is a whole deck: 52 cards, each once.' : 'The opened deck is not a whole deck of 52 different cards.');
    const again = await deckOrderOf(seed);
    const same = again.length === deck.length && again.every((c, i) => c === deck[i]);
    add(same ? 'pass' : 'fail', same ? 'The deck order is the seed’s shuffle: the house didn’t pick the cards.' : 'The deck order is not what the seed shuffles to.');
    const { hands, bad } = rebuildHands(r);
    if (bad) add('fail', `Pass ${bad.pass}: ${nameOf(r, bad.from)} passed ${bad.card}, which was not in that hand.`);
    else add('pass', `Every pass could happen: each card sent was in its sender’s hand (${(r.moves?.passes ?? []).length} passes replayed).`);
    const recorded = r.hands ?? [];
    const dealtSeats = (r.seats ?? []).filter((x) => x.dealt).map((x) => x.seat);
    const handsMatch = dealtSeats.every((seat) => !recorded[seat] || (hands[seat] && [...hands[seat]].sort().join() === [...recorded[seat]].sort().join()));
    add(handsMatch ? 'pass' : 'fail', handsMatch ? `The hands rebuilt from the deck and the passes are the hands the record shows: ${dealtSeats.map((seat) => `${nameOf(r, seat)} ${(hands[seat] ?? []).join(' ')}`).join('; ')}.` : 'A hand rebuilt from the deck and the passes differs from the hand the record shows.');
    for (const c of r.moves?.claims ?? []) {
      const hand = hands[c.seat];
      if (!hand) { add('fail', `${c.name} claimed ${c.label} with no hand to check.`); continue; }
      const held = handContains(hand, c.claim);
      if (c.status === 'proven' || c.status === 'caught') {
        const ok = held === (c.status === 'proven');
        add(ok ? 'pass' : 'fail', `${c.name}: ${c.label}, ${HELD[c.status]}. The cards ${hand.join(' ')} ${held ? 'hold it' : 'don’t hold it'}${ok ? '' : ': the verdict is wrong'}.`);
      } else if (c.status === 'standing') add('word', `${c.name}: ${c.label}, nobody called it. The opened cards ${hand.join(' ')} ${held ? 'held it' : 'didn’t: a bluff that stood'}.`);
      else add('word', `${c.name}: ${c.label}, ${c.status}.`);
    }
  }
  const net = (r.chips ?? []).reduce((sum, l) => sum + l.delta, 0);
  if (r.chips?.length) add(net === 0 - (r.result?.carried ?? 0) ? 'pass' : 'fail', r.result?.carried ? 'The chips moved add up to the pot carried on: nothing was lost on the way.' : 'The chips moved add up to zero: what one side lost, the other won.');
  if (r.settle) add('word', `Settled in block ${r.settle.block}. This page can’t read the chain itself: open the transaction above.`);
  else if (r.cage) add('word', r.result?.kind === 'carried' ? 'The pot carried, so it settles with the next paid pot.' : 'No settle transaction yet.');
  else add('word', 'A play-chip round: no money moved on chain, so there is no settle transaction to find.');
  return out;
}
