// The receipt book: a permanent public record of a tNIGHT table's rounds, one Durable Object per cage table number, so it outlives
// the table. A receipt only grows: each part is written once, and a different second version is refused. Nothing here can move money.
//   GET /receipt/<table>-<round>        the page (JSON with Accept: application/json)
//   GET /receipt/<table>-<round>.json   the JSON
//   GET /receipts/<table>               the latest rounds at a table

import { DurableObject } from 'cloudflare:workers';
import { fail, json, withPageHeaders } from './http.js';
import { recGet, recPut, recSearch } from './records.js';

const LIST_MAX = 100;
const keyOf = (round) => `r:${String(round).padStart(12, '0')}`;

export class ReceiptBook extends DurableObject {
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/put') return this.put(await request.json());
    if (pathname === '/rec/put') return recPut(this.ctx.storage, await request.json());
    if (pathname === '/rec/get') return recGet(this.ctx.storage, await request.json());
    if (pathname === '/rec/search') return recSearch(this.ctx.storage, await request.json());
    if (pathname === '/get') {
      const receipt = await this.ctx.storage.get(keyOf(Number(searchParams.get('round'))));
      return receipt ? json(receipt) : fail(404, 'no_receipt', 'No receipt with that number here.');
    }
    if (pathname === '/list') {
      const rows = await this.ctx.storage.list({ prefix: 'r:', reverse: true, limit: LIST_MAX });
      return json({ receipts: [...rows.values()].map((r) => ({ number: r.number, label: r.label, status: statusOf(r), fingerprint: r.fingerprint?.hash ?? null, tx: r.settle?.hash ?? null, block: r.settle?.block ?? null })) });
    }
    return fail(404, 'not_found', 'No such route.');
  }

  async put({ table, round, game, address, patch }) {
    const key = keyOf(round);
    const number = `${table}-${round}`;
    const was = (await this.ctx.storage.get(key)) ?? { number, label: `Table ${table} · Round ${round}`, table, round, game, cage: { address, network: 'preprod' } };
    for (const [part, value] of Object.entries(patch)) {
      if (was[part] !== undefined && JSON.stringify(was[part]) !== JSON.stringify(value)) return fail(409, 'written', `Receipt ${number} already has a different ${part}.`);
      was[part] = value;
    }
    await this.ctx.storage.put(key, was);
    return json({ ok: true, number });
  }
}

const statusOf = (r) => (r.void ? 'void' : r.settle ? 'settled' : r.opened ? 'opened' : 'posted');

// A book is keyed on the cage's address and the table, so a new cage starts new books and table numbers can't collide. Writes
// only ever go to CAGE_ADDRESS's book. Reads try CAGE_ADDRESS first, then each address in RECEIPTS_PAST (comma-separated,
// public addresses, not secrets), so an earlier cage's receipts stay readable after the cut-over.
const HEX64 = /^[0-9a-f]{64}$/;
const bookAt = (env, address, table) => env.RECEIPTS.get(env.RECEIPTS.idFromName(`${address}:${table}`));
export const bookStub = (env, table) => bookAt(env, env.CAGE_ADDRESS, table);
export function bookAddresses(env) {
  const past = String(env.RECEIPTS_PAST ?? '').split(',').map((a) => a.trim().toLowerCase()).filter((a) => HEX64.test(a));
  return [...new Set([...(HEX64.test(env.CAGE_ADDRESS ?? '') ? [env.CAGE_ADDRESS] : []), ...past])];
}
/** The books to read for one request: all of them, or the one `?cage=` names (the full address, or at least its first 8 characters). */
function readable(env, url) {
  const all = bookAddresses(env);
  const want = (url.searchParams.get('cage') ?? '').toLowerCase();
  return want ? all.filter((a) => want.length >= 8 && a.startsWith(want)) : all;
}

/** Sends a table's queued parts to the book, in order, stopping at the first that fails: the alarm tries again. Returns whether anything went. */
export async function flushReceipts(env, s, gameId) {
  const b = s.cage?.book;
  if (!b?.queue.length || !env.RECEIPTS) return false;
  let sent = false;
  while (b.queue.length) {
    const { table, round, patch } = b.queue[0];
    let res;
    try {
      res = await bookStub(env, table).fetch(new Request('https://book/put', { method: 'POST', body: JSON.stringify({ table, round, game: gameId, address: env.CAGE_ADDRESS, patch }) }));
    } catch (err) {
      console.error('receipt will retry:', err?.message);
      break;
    }
    if (!res.ok && res.status !== 409) break;
    if (res.status === 409) console.error('receipt part refused:', table, round, Object.keys(patch).join());
    b.queue.shift();
    sent = true;
  }
  return sent;
}

/** What a reader needs to check a receipt without trusting this page. */
const howToCheck = (r) => ({
  fingerprint: 'SHA-256 over the domain string, u32 table, u64 round, the house commitment and each seat\'s commitment (32 zero bytes for a seat not dealt in). Compare it with fingerprint.hash.',
  house: 'SHA-256("cup-and-claim/house/v1" ‖ opened.houseSeed) must equal fingerprint.houseCommit.',
  shownCups: 'For a cup with dice and seed: SHA-256("cup-and-claim/commit/v1" ‖ seed) must equal its commit, and SHA-256("cup-and-claim/roll/v1" ‖ houseSeed ‖ seed ‖ u32 seat ‖ u32 engineRound) cut into 16-bit words, each mod 6 plus 1, must be its dice.',
  chain: `On the cage ${r.cage?.address} (Midnight preprod), the settleBatch entry with table ${r.table} and roundNo ${r.settle?.chainRound ?? r.round} moves tables[${r.table}].lastRound to that number. Its balance changes are the chips moved here. Any indexer can find it by reading that counter over block height: sealed-cage/scripts/check-receipt.mjs does that.`,
  houseAttested: 'The fingerprint and the counts are this server\'s word, not the chain\'s: only the money settles on chain. A cup that stayed shut can\'t be recomputed by anyone else, so its count is house-attested. The fingerprint is not on chain either; postedAt is this server\'s clock.',
});

const NUMBER = /^(\d{1,10})-(\d{1,15})(\.json)?$/;

export async function receiptRoute(request, env, parts) {
  if (env.TNIGHT_TABLES !== 'on' || !env.RECEIPTS) return fail(404, 'not_found', 'No such route. GET /api lists them.');
  if (request.method !== 'GET') return fail(405, 'method', 'Receipts are read with GET.');
  const books = readable(env, new URL(request.url));
  if (parts[0] === 'receipts') {
    if (parts.length !== 2 || !/^\d{1,10}$/.test(parts[1])) return fail(404, 'not_found', 'Use GET /receipts/<table>.');
    const receipts = [];
    for (const address of books) { // the current cage's first, then each earlier one's, newest first
      const res = await bookAt(env, address, Number(parts[1])).fetch('https://book/list');
      if (res.ok) receipts.push(...(await res.json()).receipts.map((r) => ({ ...r, cage: address })));
    }
    return json({ receipts: receipts.slice(0, LIST_MAX) });
  }
  const m = parts.length === 2 ? NUMBER.exec(parts[1]) : null;
  if (!m) return fail(404, 'no_receipt', 'A receipt number looks like 114-47: the table, then the round.');
  const wantsJson = m[3] || (request.headers.get('accept') ?? '').includes('application/json');
  if (!wantsJson) {
    const page = await env.ASSETS.fetch(new Request(new URL('/receipt', request.url)));
    return withPageHeaders(page);
  }
  let res = fail(404, 'no_receipt', 'No receipt with that number here.');
  for (const address of books) { // a number from the current cage wins; ?cage= reaches an earlier one with the same number
    res = await bookAt(env, address, Number(m[1])).fetch(`https://book/get?round=${Number(m[2])}`);
    if (res.ok || res.status !== 404) break;
  }
  if (!res.ok) return res;
  const r = await res.json();
  return new Response(JSON.stringify({ ...r, status: statusOf(r), url: `/receipt/${r.number}`, howToCheck: howToCheck(r) }, null, 1), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}
