// The Records book: one public number for every round, searchable by table and round. A Durable Object like a receipt book (it is the
// ReceiptBook class under another name), so it outlives any table. A part of a record is written once: a different second version
// is refused. Nothing here can move money, and nothing here holds a die or a card: only what the game posted for the public.
// Two games keep a book here: Cup & Claim (games/cup-and-claim/records.js) and Sealed Hand (games/sealed-hand/records.js).
//
//   GET /records                              the page
//   GET /records/search?table=3&round=41      JSON: records by table and/or round (no filter: the latest). &game= &kind=play|tnight &before=<seq> &limit=
//   GET /records/<game>/<number>[.json]       one round. Number is 3-41 for a play-chip table, t114-47 for a tNIGHT one.
//
// Keys, so every lookup is a prefix read and nothing scans:
//   rec:<game>:<kind>:<table>:<round>       the record
//   recr:<game>:<round>:<kind>:<table>      -> its key, to find a round at any table
//   reci:<seq>                              -> its key, in the order records were first written, for "the latest"

import { fail, json, withPageHeaders } from './http.js';

const GAMES = { 'cup-and-claim': 'Cup & Claim', 'sealed-hand': 'Sealed Hand' };
const KINDS = ['play', 'tnight'];
const LIMIT = 50;
const pad = (n, w = 12) => String(n).padStart(w, '0');
const keyOf = (game, kind, table, round) => `rec:${game}:${kind}:${pad(table, 10)}:${pad(round)}`;

export const slugOf = (kind, table, round) => `${kind === 'tnight' ? 't' : ''}${table}-${round}`;
export const labelOf = (game, kind, table, round) => `${GAMES[game] ?? game} · ${kind === 'tnight' ? 'tNIGHT table' : 'table'} ${table} · round ${round}`;
// "opened" is a round over with its seal open (Cup & Claim's dice, Sealed Hand's deck); "over" is a Sealed Hand round from before the deck
// was sealed (2026-11-07), which has a result and nothing to open.
export const statusOf = (r) => (r.void ? 'void' : r.settle ? 'settled' : r.opened ? 'opened' : r.result ? 'over' : 'posted');

/** The book's side: `storage` is the Durable Object's. */
export async function recPut(storage, { game, kind, table, round, patch }) {
  if (!GAMES[game] || !KINDS.includes(kind) || !Number.isInteger(table) || !Number.isInteger(round) || table < 0 || round < 1 || !patch || typeof patch !== 'object') return fail(400, 'bad_record', 'A record needs game, kind, table, round and a patch.');
  const key = keyOf(game, kind, table, round);
  let was = await storage.get(key);
  if (!was) {
    const seq = ((await storage.get('seq')) ?? 0) + 1;
    was = { number: slugOf(kind, table, round), label: labelOf(game, kind, table, round), game, kind, table, round, seq };
    await storage.put({ seq, [`reci:${pad(seq)}`]: key, [`recr:${game}:${pad(round)}:${kind}:${pad(table, 10)}`]: key });
  }
  for (const [part, value] of Object.entries(patch)) {
    if (['number', 'label', 'game', 'kind', 'table', 'round', 'seq'].includes(part)) continue;
    if (was[part] !== undefined && JSON.stringify(was[part]) !== JSON.stringify(value)) return fail(409, 'written', `Record ${was.number} already has a different ${part}.`);
    was[part] = value;
  }
  await storage.put(key, was);
  return json({ ok: true, number: was.number });
}

export async function recGet(storage, { game, kind, table, round }) {
  const r = await storage.get(keyOf(game, kind, table, round));
  return r ? json(r) : fail(404, 'no_record', 'No record with that number here.');
}

/** The line a search result shows: enough to pick a round, nothing a viewer needs to check it. */
const summary = (r) => ({
  number: r.number,
  label: r.label,
  game: r.game,
  kind: r.kind,
  table: r.table,
  round: r.round,
  status: statusOf(r),
  url: `/records/${r.game}/${r.number}`,
  fingerprint: r.fingerprint?.hash ?? null,
  seal: r.seal?.hash ?? null, // Sealed Hand's deck seal
  claim: r.claim ? { name: r.claim.name, count: r.claim.count, face: r.claim.face } : null,
  call: r.call ? { name: r.call.name } : null,
  result: r.result ? { kind: r.result.kind, held: r.result.held ?? null, total: r.result.total ?? null, pot: r.result.pot ?? null, loser: r.result.loser?.name ?? null, winner: r.result.winner?.name ?? (r.result.awards?.length === 1 ? r.result.awards[0].name : null), awards: r.result.awards ? r.result.awards.map((a) => ({ name: a.name, amount: a.amount })) : null } : null,
  claims: r.claims ? r.claims.map((c) => ({ name: c.name, label: c.label, status: c.status })) : null, // Sealed Hand's
  chips: r.chips ? r.chips.map((c) => ({ name: c.name, delta: c.delta })) : null,
  tx: r.settle?.hash ?? null,
  block: r.settle?.block ?? null,
  postedAt: r.postedAt ?? r.fingerprint?.postedAt ?? null, // this server's clock: when the round's number went up
  closedAt: r.closedAt ?? r.opened?.at ?? null, // and when it ended
});

export async function recSearch(storage, { game, table, round, kind, before, limit }) {
  const kinds = kind ? [kind] : KINDS;
  const max = Math.min(Math.max(limit || LIMIT, 1), 100);
  const keys = [];
  if (table !== null && round !== null) {
    for (const k of kinds) keys.push(keyOf(game, k, table, round));
  } else if (table !== null) {
    for (const k of kinds) for (const [key] of await storage.list({ prefix: `rec:${game}:${k}:${pad(table, 10)}:`, reverse: true, limit: max })) keys.push(key);
  } else if (round !== null) {
    for (const k of kinds) for (const [, key] of await storage.list({ prefix: `recr:${game}:${pad(round)}:${k}:`, limit: max })) keys.push(key);
  } else {
    const range = { prefix: 'reci:', reverse: true, limit: max * 3 + 1 };
    const rows = await storage.list(before ? { ...range, end: `reci:${pad(before)}` } : range);
    for (const key of rows.values()) if (key.startsWith(`rec:${game}:`) && (!kind || key.includes(`:${kind}:`))) keys.push(key);
  }
  const found = (await Promise.all(keys.map((key) => storage.get(key)))).filter(Boolean).sort((a, b) => b.seq - a.seq);
  const page = found.slice(0, max);
  return json({ records: page.map(summary), next: table === null && round === null && found.length > max ? page.at(-1).seq : null });
}

const stub = (env) => env.RECEIPTS.get(env.RECEIPTS.idFromName('records:v1'));

/** Sends a table's queued parts to the book, in order, stopping at the first that fails (the alarm tries again). Returns whether any went. */
export async function flushRecords(env, s, game) {
  const q = s.rec?.queue;
  if (!q?.length || !env.RECEIPTS) return false;
  let sent = false;
  while (q.length) {
    const { kind, table, round, patch } = q[0];
    let res;
    try {
      res = await stub(env).fetch(new Request('https://book/rec/put', { method: 'POST', body: JSON.stringify({ game, kind, table, round, patch }) }));
    } catch (err) {
      console.error('record will retry:', err?.message);
      break;
    }
    if (!res.ok && res.status !== 409) break;
    if (res.status === 409) console.error('record part refused:', kind, table, round, Object.keys(patch).join());
    q.shift();
    sent = true;
  }
  return sent;
}

const NUMBER = /^(t?)(\d{1,10})-(\d{1,15})(\.json)?$/;
const WHOLE = /^\d{1,15}$/;

/** The money half of how to check a record: the chain for a tNIGHT round, the table's own count for a play one. */
const moneyCheck = (r) => (r.kind === 'tnight'
  ? { chain: `The money settled on the cage ${r.cage?.address ?? ''} (Midnight preprod): the settleBatch entry with table ${r.table} and roundNo ${r.settle?.chainRound ?? r.round}. Its balance changes are the chips moved here.` }
  : { chips: 'A play-chip round: no chain money moved. The chips moved are what each seat won or lost at the table, net of what it put in.' });

/** What a reader needs to check a record without trusting the page. The chain part is only for a tNIGHT round. */
const howToCheck = (r) => (r.game === 'sealed-hand' ? (r.seal ? {
  seal: 'SHA-256("sealed-hand/seal/v1" ‖ u32 table ‖ u64 round ‖ opened.seed ‖ the 52 cards of opened.deck in order, space-separated, as text) must equal seal.hash. It was posted before any card was dealt or passed; postedAt is this server\'s clock.',
  shuffle: 'The deck is the seed\'s shuffle: Fisher-Yates over the fresh deck (2 to A of c, d, h, s), where the pick at step i (51 down to 1) is the first four bytes of SHA-256("sealed-hand/shuffle/v1" ‖ seed ‖ u32 i), big-endian, mod (i + 1). It must give opened.deck.',
  hands: 'Each seat with dealt: true, in seat order, takes the next five cards of opened.deck. Then every pass in moves.passes, in order: each card moves from its sender\'s hand to its receiver\'s. The hands that come out must be hands[seat].',
  claims: 'For each claim in moves.claims: proven means it was called and the hand held that combination; caught means it was called and did not. Check it against the rebuilt hand. standing means nobody called it; the opened hand says whether it was true.',
  ...moneyCheck(r),
} : {
  deal: 'This round is from before the deck was sealed: the server shuffled and dealt, and nothing sealed the deck, so the cards, and every claim nobody called, are this server\'s word. postedAt and closedAt are its clock.',
  claims: 'A claim\'s status is the table\'s: proven means it was called and the cards held it, caught means they didn\'t, standing means nobody called it, and says nothing about whether it was true. No card is in this record.',
  ...moneyCheck(r),
}) : {
  fingerprint:'SHA-256 over the domain string, u32 table, u64 round, the house commitment and each seat\'s commitment (32 zero bytes for a seat not dealt in). Compare it with fingerprint.hash.',
  house: 'SHA-256("cup-and-claim/house/v1" ‖ opened.houseSeed) must equal fingerprint.houseCommit.',
  shownCups: 'For a cup with dice and seed: SHA-256("cup-and-claim/commit/v1" ‖ seed) must equal its commit, and SHA-256("cup-and-claim/roll/v1" ‖ houseSeed ‖ seed ‖ u32 seat ‖ u32 engineRound) cut into 16-bit words, each mod 6 plus 1, must be its dice.',
  houseAttested: 'The fingerprint and the counts are this server\'s word. A cup that stayed shut can\'t be recomputed by anyone else, so its count is house-attested. postedAt is this server\'s clock.',
  ...moneyCheck(r),
});

export async function recordsRoute(request, env, parts) {
  if (!env.RECEIPTS) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  if (request.method !== 'GET') return fail(405, 'method', 'Records are read with GET.');
  const url = new URL(request.url);
  if (parts.length === 1) return withPageHeaders(await env.ASSETS.fetch(new Request(new URL('/records', request.url))));
  if (parts.length === 2 && parts[1] === 'search') {
    const q = url.searchParams;
    const num = (name) => (q.get(name) === null || q.get(name) === '' ? null : WHOLE.test(q.get(name)) ? Number(q.get(name)) : NaN);
    const table = num('table');
    const round = num('round');
    const before = num('before');
    const game = q.get('game') || 'cup-and-claim';
    const kind = q.get('kind') || null;
    if (Number.isNaN(table) || Number.isNaN(round) || Number.isNaN(before)) return fail(400, 'bad_number', 'table, round and before are whole numbers, such as ?table=3&round=41.');
    if (!GAMES[game]) return fail(400, 'bad_game', `game is one of: ${Object.keys(GAMES).join(', ')}.`);
    if (kind && !KINDS.includes(kind)) return fail(400, 'bad_kind', `kind is one of: ${KINDS.join(', ')}.`);
    return stub(env).fetch(new Request('https://book/rec/search', { method: 'POST', body: JSON.stringify({ game, table, round, kind, before, limit: Number(q.get('limit')) || null }) }));
  }
  if (parts.length === 3 && GAMES[parts[1]]) {
    const m = NUMBER.exec(parts[2]);
    if (!m) return fail(404, 'no_record', 'A record number looks like 3-41 (table 3, round 41), or t114-47 for a tNIGHT table.');
    const wantsJson = m[4] || (request.headers.get('accept') ?? '').includes('application/json');
    if (!wantsJson) return withPageHeaders(await env.ASSETS.fetch(new Request(new URL('/receipt', request.url))));
    const res = await stub(env).fetch(new Request('https://book/rec/get', { method: 'POST', body: JSON.stringify({ game: parts[1], kind: m[1] ? 'tnight' : 'play', table: Number(m[2]), round: Number(m[3]) }) }));
    if (!res.ok) return res;
    const r = await res.json();
    return new Response(JSON.stringify({ ...r, status: statusOf(r), url: `/records/${r.game}/${r.number}`, howToCheck: howToCheck(r), ...(r.kind === 'tnight' ? { receipt: `/receipt/${r.table}-${r.round}` } : {}) }, null, 1), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  }
  return fail(404, 'not_found', 'Use GET /records, /records/search, or /records/cup-and-claim/3-41.');
}
