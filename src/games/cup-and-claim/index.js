// Cup & Claim as a Hall game: its registry entry, its HTTP routes and its API help. The rules are in engine.js.
// Routes mirror Sealed Hand's under /dice-tables, and GET /dice-tables returns this game's help.

import { fail, json } from '../../platform/http.js';
import { openCageOptions } from '../../platform/cage-table.js';
import { directoryStub } from '../../platform/directory.js';
import { DEFAULTS } from './engine.js';
import { FACES } from './fair.js';

export { DiceTable } from './table.js';
export { liveSeats } from './seats.js';

const MAX_BODY = 4096;
// The house answers for its bots one transaction at a time, about half a minute each, inside the contract's house window: at 240 s, three fit
// even when the chain is slow. A fourth or fifth bot would go quiet and lose the house a call it should win. See sealed-cage, docs/DICE-PROOF.md.
const PROOF_MAX_BOTS = 3;

export const PLAQUE = 'What this table shows: I choose what to show: the dice, or just the count.';

export const API_HELP = {
  name: 'Cup & Claim',
  plaque: PLAQUE,
  routes: {
    'GET /dice-tables': 'This help.',
    'POST /dice-tables': `{ lobbySeconds?, seats?, stakes? } creates a table. seats is ${DEFAULTS.minSeats} to ${DEFAULTS.maxSeats} (default ${DEFAULTS.seats}). stakes is { ante, raiseLimit, potLimit } for a tier. Play chips default to ante ${DEFAULTS.ante}, a raise up to a whole stack (1000) and a pot limit of every seat all in (seats x 1000); a tNIGHT table keeps ${DEFAULTS.raiseLimit} / ${DEFAULTS.potLimit}, and one round can never cost a seat more than 1000 there. Bots fill empty seats when the lobby timer ends (default 30 s; 0 = at the first join).`,
    'POST /dice-tables/:id/cage-seat': '{ doorToken, name?, avatar?, kind? } at a tNIGHT table, once you have sat in the cage at its table number. Same as POST /tables/:id/cage-seat.',
    'POST /dice-tables/:id/join': '{ name, kind?, avatar?, buyIn? } returns your seat and secret seat token, as at Sealed Hand. Send a player token to buy in from your purse.',
    'GET /dice-tables/:id': 'Public state. Never contains a die or a seed. fair.houseCommit and fair.commits are the sealed secrets behind this round; fair.opened is the house seed once the round is over.',
    'GET /dice-tables/:id/me': 'Authorization: Bearer <seat token>. Your dice, your count of each face (1s wild), what you owe to bid, and your legal actions.',
    'POST /dice-tables/:id/act': 'Authorization: Bearer <seat token>. One of the actions below.',
    'POST /dice-tables/:id/say': 'Authorization: Bearer <seat token>. { text }, 120 characters at most.',
    'POST /dice-tables/:id/leave': 'Authorization: Bearer <seat token>. Cashes your stack out between rounds, or at the end of this round.',
    'GET /dice-tables/:id/quick': 'Authorization: Bearer <seat token>. Suggested things to say right now.',
    'POST /dice-tables/:id/fill-up': 'Authorization: Bearer <seat token>. Play chips, between rounds only: brings your stack at this table back to 1,000 (free, as often as you like). Send {}. Returns { added, stack, purse }. Not at tNIGHT tables.',
    'POST /dice-tables/:id/add-chips': 'Authorization: Bearer <seat token>. { amount } from your purse to your stack, between rounds only.',
    'GET /dice-tables/:id/seat': 'Authorization: Bearer <player token>. Whether you are seated here, left recently, or neither.',
  },
  phases: {
    lobby: 'Waiting for players.',
    bid: 'One seat at a time: bid higher than the standing bid (more dice, or the same count with a higher face) with an optional chip raise, or call Liar, or fold. A raise someone else made must be matched before you bid again.',
    duel: 'Liar was called. Every cup still in answers: prove (cup stays shut; only your count of the bid face goes out) or show (your dice are shown; you earn an open-hand mark). Then the whole table is counted.',
    settled: 'The pot is paid. next deals the next round.',
    over: 'The table has closed.',
  },
  actions: [
    { action: 'bid', count: 3, face: 5, raise: 10 },
    { action: 'liar' },
    { action: 'fold' },
    { action: 'reveal', mode: 'prove' },
    { action: 'reveal', mode: 'show' },
    { action: 'next' },
    { action: 'back' },
  ],
  bids: {
    format: `{ count, face }: "at least count dice on the whole table show face". face is one of ${FACES.join(', ')}; 1s are wild and count for every face. A bid beats the last one with a higher count, or the same count and a higher face.`,
    raise: `raise is optional, 1 to limits.raiseLimit (1000 on play chips, ${DEFAULTS.raiseLimit} at a tNIGHT table), and must fit under the pot limit even if everyone still in matched it. GET /me says the room left; raise.potLimitReached is true when there is none.`,
    liar: 'Free to call unless the table was made with liarCostsMatch. The loser of the call pays: everyone else still in gets their stake back plus an equal share of the loser\'s stake and the folders\' stakes, and a caller who was right gets a double share. With two seats that is the winner taking the whole pot. lastResult.awards says who got what (back + share).',
  },
  fairness: {
    deal: 'Each cup is H(roll-tag, houseSeed, playerSeed, seat, round) cut into five dice. H(playerSeed) and H(houseSeed) are published at the deal, before anyone sees a die.',
    duel: 'A shut cup sends out only its count, and the server vouches for it (house-attested: no circuit checks it yet). A shown cup sends its seed and dice, which anyone can recompute once the house seed is opened. Money settles on chain; the count does not.',
    receipts: 'At a tNIGHT table every round has a public number, its cage table and chain round, such as 114-47. GET /receipt/114-47.json: the fingerprint posted before the deal, the opened house seed, the claim and the call, the chips moved, and the settle transaction.',
  },
};

const ROUTES = {
  '': { GET: '/' },
  join: { POST: '/join' },
  me: { GET: '/me' },
  act: { POST: '/act' },
  say: { POST: '/say' },
  leave: { POST: '/leave' },
  'deal-now': { POST: '/deal-now' },
  quick: { GET: '/quick' },
  seat: { GET: '/seat' },
  'cage-seat': { GET: '/cage-seat', POST: '/cage-seat' },
  'proof-holder': { POST: '/proof-holder' },
  'add-chips': { POST: '/add-chips' },
  'fill-up': { POST: '/fill-up' },
  'test-prompts': { GET: '/test-prompts' },
};

async function forwardBody(request, path) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: fail(413, 'too_large', `Request body is over ${MAX_BODY} bytes.`) };
  try {
    if (JSON.parse(text || 'null') === null) return { error: fail(400, 'bad_json', 'Send a JSON object in the request body.') };
  } catch {
    return { error: fail(400, 'bad_json', 'Request body is not valid JSON.') };
  }
  return { request: new Request(`https://table${path}`, { method: 'POST', headers: request.headers, body: text }) };
}

async function createTable(request, env) {
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, 'too_large', `Request body is over ${MAX_BODY} bytes.`);
  let options = {};
  if (text.trim()) {
    try {
      options = JSON.parse(text);
    } catch {
      return fail(400, 'bad_json', 'Request body is not valid JSON.');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail(400, 'bad_json', 'Send a JSON object.');
  }
  return openTable(env, options);
}

/** Creates a table from options someone is allowed to set. A warm table comes only from the judge. */
async function openTable(env, options, { warm = false } = {}) {
  const opts = { ...options };
  delete opts.cage; // set here, never by a client
  delete opts.proofAddress; // the same
  const proof = opts.proof;
  delete opts.proof;
  if (proof !== undefined) { // dice checked on chain: off unless this Worker has DICE_PROOF = "on". See docs in sealed-cage, docs/DICE-PROOF.md.
    if (proof !== true || opts.tnight !== true) return fail(400, 'bad_proof', 'proof must be true, or left out, and needs tnight: true.');
    if (env.DICE_PROOF !== 'on' || !/^[0-9a-f]{64}$/.test(env.DICE_PROOF_ADDRESS ?? '')) return fail(400, 'proof_off', 'Proof tables are off on this server.');
    opts.proofAddress = env.DICE_PROOF_ADDRESS;
  }
  const id = env.DICE_TABLE.newUniqueId();
  if (opts.tnight !== undefined) {
    const seatsLeft = (opts.seats ?? DEFAULTS.seats) - 1;
    const opened = await openCageOptions(env, id.toString(), opts, { warm, maxBots: proof ? Math.min(seatsLeft, PROOF_MAX_BOTS) : seatsLeft, game: 'cup-and-claim' });
    if (opened.error) return opened.error;
    opts.cage = opened.cage;
  }
  const res = await env.DICE_TABLE.get(id).fetch(new Request('https://table/init', { method: 'POST', body: JSON.stringify(opts) }));
  if (!res.ok) return res;
  return json({ id: id.toString(), ...(await res.json()) }, 201);
}

async function route(request, env, parts) {
  if (parts.length > 3) return fail(404, 'not_found', 'No such route. GET /dice-tables lists them.');
  if (parts.length === 1) {
    if (request.method === 'GET') return json(API_HELP);
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /dice-tables to create a table, or GET for help.');
    return createTable(request, env);
  }
  let id;
  try {
    id = env.DICE_TABLE.idFromString(parts[1]);
  } catch {
    return fail(404, 'no_table', 'No such table.');
  }
  const methods = ROUTES[parts[2] ?? ''];
  if (!methods) return fail(404, 'not_found', 'No such route. GET /dice-tables lists them.');
  const path = methods[request.method];
  if (!path) return fail(405, 'method', `Use ${Object.keys(methods).join(' or ')} here.`);

  const stub = env.DICE_TABLE.get(id);
  if (request.method === 'GET') return stub.fetch(new Request(`https://table${path}`, { headers: request.headers }));
  const forwarded = await forwardBody(request, path);
  return forwarded.error ?? stub.fetch(forwarded.request);
}

/**
 * GET /dice/new: the way in from a phone. A dice table waiting in the lobby gets you, unless ?fresh=1; otherwise a
 * four-seat play-chip table is made (bots fill it at the first join) and you're sent to its page to sit down.
 */
export async function newTableRedirect(request, env) {
  const { searchParams } = new URL(request.url);
  const go = (id) => new Response(null, { status: 302, headers: { location: `/dice?id=${id}&join=1`, 'cache-control': 'no-store' } });
  if (searchParams.get('fresh') !== '1') {
    try {
      const byGame = await (await directoryStub(env).fetch('https://directory/list')).json();
      const waiting = (byGame['cup-and-claim'] ?? []).find((t) => t.joinable && !t.tnight); // a plain link is for play chips
      if (waiting) return go(waiting.id);
    } catch { /* make one */ }
  }
  const id = env.DICE_TABLE.newUniqueId();
  const res = await env.DICE_TABLE.get(id).fetch(new Request('https://table/init', { method: 'POST', body: JSON.stringify({ lobbySeconds: 0, seats: 4 }) }));
  if (!res.ok) return res;
  return go(id.toString());
}

export const cupAndClaim = {
  id: 'cup-and-claim',
  name: 'Cup & Claim',
  status: 'live',
  art: 'dice',
  blurb: 'Five dice under a cup. Bid on the whole table, or call Liar.',
  plaque: PLAQUE,
  sign: 'Upstairs: Cup & Claim',
  entry: '/dice/new',
  page: '/dice',
  api: '/dice-tables',
  binding: 'DICE_TABLE',
  seats: DEFAULTS.seats,
  route,
  openWarmTable: (env, bots) => openTable(env, { tnight: true, bots, lobbySeconds: 0 }, { warm: true }),
};
