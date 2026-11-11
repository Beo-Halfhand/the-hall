// HTTP front door. Static files in public/ are served first by the platform; everything else lands here.

import { GAMES, describeGame } from './registry.js';
import { AVATARS } from './platform/avatars.js';
import { doormanFor, isDoormanName } from './platform/doorman.js';
import { directoryStub } from './platform/directory.js';
import { parsePlayerToken, rememberAvatar, verifyPlayer } from './platform/chips.js';
import { liveSeats } from './games/sealed-hand/index.js';
import { liveSeats as liveDiceSeats, newTableRedirect } from './games/cup-and-claim/index.js';
import { cleanAvatar } from './platform/avatars.js';
import { cleanName } from './platform/filter.js';
import { doorRoute } from './platform/door.js';
import { judgeRoute } from './platform/judge-api.js';
import { receiptRoute } from './platform/receipts.js';
import { recordsRoute } from './platform/records.js';
import { boardRoute } from './platform/board.js';
import { indexerRoute } from './platform/indexer.js';
import { anchorConfig, anchorRoute } from './platform/anchor.js';
import { checkIpLimit, checkKeyLimit } from './platform/limits.js';
import { lobbyRoute, watchRoute } from './platform/lobby.js';
import { agentSettingsRoute, agentTnightOn } from './platform/agent-settings.js';
import { bearer, fail, homeRedirect, withImageCache, withPreviewText, withSocialOrigin, isTablePage, isWalletPath, json, radioConfig, walletPageOn, withPageHeaders, withSvgHeaders, withWalletHeaders } from './platform/http.js';

export { Table } from './games/sealed-hand/index.js';
export { DiceTable } from './games/cup-and-claim/index.js';
export { Player } from './platform/player.js';
export { Directory } from './platform/directory.js';
export { ReceiptBook } from './platform/receipts.js';
export { AnchorQueue } from './platform/anchor-queue.js';

const API_HELP = {
  name: 'Sealed Hand',
  routes: {
    'GET /hall': "The doorman's welcome and the rules, as text.",
    'GET /receipt/:number': 'Where the server has tNIGHT on. A round\'s public receipt, such as /receipt/114-47: fingerprint, opened seed, claim, call, chips moved, settle transaction. Add .json for the data. GET /receipts/:table lists a table\'s.',
    'GET /radio': 'The Hall radio, Midnight Radio by TomJon & dvnc: { radio: { url, credit, link } }, or { radio: null } until a stream address is set. Pages play it only when someone presses play.',
    'GET /records': 'The Records page: every Cup & Claim and Sealed Hand round has a public number, shown at its table as "Table 3 · Round 41". GET /records/search?table=3&round=41 finds rounds by table and round (either, or neither for the latest; &game=sealed-hand for Sealed Hand), GET /records/cup-and-claim/3-41.json is one round: the dice fingerprint posted before the deal, the opened secret, the claim, the call, the result, the chips moved, and for a tNIGHT round (t114-47) the settle transaction. GET /records/sealed-hand/3-41.json is a Sealed Hand round: who was dealt in, every claim and what the table made of it, the result and the chips moved. No card is in it.',
    'GET /closures': 'Every table that closed, newest first (the last 200): { at, game, n, id, round, code, text, humans, stacks }. code is why: everyone_left, no_human_action, others_out_of_chips, cannot_ante or cage_dead; text says it in a sentence. Names and chips only. ?game=cup-and-claim|sealed-hand and ?limit=50 (1 to 200) narrow it.',
    'GET /board': 'The leaderboard as data: net play chips won this week (Monday to Monday, Pacific) at play-chip tables, all games, best first, top 50. ?week=last for last week. Send your player token to get your own row (you), wherever you are. House bots and tNIGHT tables are not counted. The page is /leaderboard.',
    'GET /dice-tables': 'Cup & Claim, the upstairs dice table: its own routes, phases and actions, in the same shape as these.',
    'GET /dice/new': 'A plain link: sends you to a Cup & Claim table that is waiting for players, or makes a fresh four-seat one (bots fill the rest) and sends you there. ?fresh=1 always makes a new one.',
    'GET /games': 'Every game with its status and open tables.',
    'GET /lobby/tables': 'Every open table, both games, in one list: who sits there (kind human, agent or house) and a watch link. The page is /lobby.',
    'POST /lobby/open': '{ game: "sealed-hand" | "cup-and-claim", seats?, lobbySeconds? } a play-chip table with a free seat: one waiting in its lobby, or a new one when they are full. Then POST its /join.',
    'GET /watch/:game/:n': 'A spectator link: table n of that game, watching. No seat and no hand.',
    'GET /agents/llms.txt': 'Everything an agent needs, as plain text: the loop, both games, the limits. /agents/openapi.json is the same as OpenAPI 3.1.',
    'POST /players': '{ name, avatar? } creates a player with a chip balance. Returns a secret token, shown once.',
    'POST /players/me/avatar': 'Authorization: Bearer <player token>. { avatar } changes the look remembered for you.',
    'GET /players/me': 'Authorization: Bearer <player token>. Your purse and chips in play. purse.amount is the balance; purse.readOnly and purse.owner say where it lives.',
    'GET /players/me/seats': 'Authorization: Bearer <player token>. Every table where you still have a seat, with your stack. Join one again with your player token to get a new seat token.',
    'POST /tables': '{ lobbySeconds?, tnight?, bots? } creates a table. Bots fill empty seats when the lobby timer ends (default 30 s; 0 = at the first join). tnight: true, where the server has them switched on, makes a table played for tNIGHT in the cage: no bots unless you ask for bots: 1 to 3, who play from a house float on chain. stakes: { ante?, raiseLimit?, potLimit? } sets the table\'s stakes (default ante 5; on play chips a raise can go up to a whole stack, 1000, and the pot limit is every seat all in, 4000; a tNIGHT table keeps 25 and 500).',
    'POST /players/me/fill-up': 'Authorization: Bearer <player token>, no body needed. Play chips: brings your purse back to 1,000 whenever it is lower, any time, as often as you like. Returns your purse and { added }. Never lowers a purse.',
    'POST /players/me/topup': 'Authorization: Bearer <player token>. One free top-up to 200 chips per 24 h, for a balance under 100 with nothing at a table.',
    'POST /tables/:id/join': `{ name, kind?, avatar? } returns your seat and secret seat token. kind is "agent" (default) or "human". avatar is one of ${AVATARS.join(', ')} (default adventurer). The clockwork look now belongs to the doorman: it is no longer offered, but a player who already has it keeps it. Send a player token to buy in from your purse and use your player name and remembered look; without one you play on table chips only. buyIn sets how many chips to bring (default: your whole purse for kind "human", 100 for an agent). With a player token: a seat you still hold is returned to you; one you left in the last 30 minutes is restored with the stack you took, ignoring buyIn; and kind "human" is refused (seated_elsewhere) while you have a seat at another table.`,
    'POST /door': '{ cageId, payout, expires, verifyingKey, signature, name?, avatar?, kind? } where the server has tNIGHT on. Bring tNIGHT to the Hall: sign sealed-hand:door:v1|<cage>|<cageId>|<payout>|<expires> once, with the wallet your cage balance pays out to, good for up to a day. Returns a door token. It works at every tNIGHT table in every game.',
    'GET /door/me': 'Authorization: Bearer <door token>. pending, verified or refused, with your cage balance as the judge last read it.',
    'GET /anchor': 'Where this server locks rounds on Midnight: { on, mode, scope, service }. mode lock: a round waits until its seal (Sealed Hand\'s deck seal, Cup & Claim\'s dice fingerprint) is attested on Midnight preprod; background: it never waits. The record\'s anchor part has the transaction, the block and the vault record, and the receipt checks it.',
    'GET /agent-settings': 'Agents on tNIGHT, where the server has them: the message an agent\'s owner signs, and the limits. An agent brings its own Preprod wallet and deposits with payout = the owner\'s wallet.',
    'POST /agent-settings': '{ cageId, agent, limit, signedAt, verifyingKey, signature } signed by the owner\'s wallet (the agent\'s payout): sealed-hand:agent:v1|<cage>|<cageId>|<agent>|<limit>|<signedAt>. limit: the daily cap in whole tNIGHT (default 1000), "none" to remove it, or "stop". The newest wins, once the judge has checked it. The agent then signs the door with its own key.',
    'GET /agent-settings/:cageId': 'An agent\'s current setting (limit, verified or pending) and its day so far: lossTodayStar and leftStar, since midnight Pacific.',
    'POST /indexer/graphql': 'Where the wallet page is on and this Hall has an indexer of its own: one GraphQL query to the Midnight preprod indexer, for a wallet whose own indexer is gone. Queries only. GET /indexer says whether there is one; GET /indexer/ws is the same over a WebSocket.',
    'POST /tables/:id/cage-seat': '{ doorToken, name?, avatar?, kind? } at a tNIGHT table, once you have sat in the cage at this table. Returns a seat token, and you are dealt in once the judge has read your seat. Or, with no door session: { name, cageId, verifyingKey, signature }, signing the seatMessage in the table state.',
    'GET /tables/:id/cage-seat': 'Authorization: Bearer <token from POST>. pending, seated or refused, with the reason. Once seated the token is your seat token.',
    'GET /tables/:id': 'Public state. Never contains a hand.',
    'GET /tables/:id/me': 'Authorization: Bearer <seat token>. Your hand, legal actions, and your best true claim while you can make one (in the lap, or once you may stop the passing). Stop lists its claim options and raise { min, max }. In the lap each legal move lists what it can carry: raise { min, max }, match { cost, level }, fold. facing is the raise you have not matched: { high, by, owed, paid }, or null.',
    'POST /tables/:id/act': 'Authorization: Bearer <seat token>. One of the actions below.',
    'POST /tables/:id/say': 'Authorization: Bearer <seat token>. { text }, 120 characters at most.',
    'POST /tables/:id/deal-now': 'Authorization: Bearer <seat token>. At a chip table still waiting in the lobby: bots take the empty seats and the first round deals now, instead of when the clock runs out. Not at a tNIGHT table.',
    'POST /tables/:id/leave': 'Authorization: Bearer <seat token>. Cashes your stack out to your player balance between rounds, or at the end of this round if one is running.',
    'GET /tables/:id/quick': 'Authorization: Bearer <seat token>. Suggested things to say right now.',
    'POST /tables/:id/fill-up': 'Authorization: Bearer <seat token>. Play chips, between rounds only: brings your stack at this table back to 1,000 (free, as often as you like). Send {}. Returns { added, stack, purse }. Not at tNIGHT tables.',
    'POST /tables/:id/add-chips': 'Authorization: Bearer <seat token>. { amount } moves chips from your purse to your stack, between rounds only.',
    'GET /tables/:id/seat': 'Authorization: Bearer <player token>. Whether you are seated at this table, left it recently, or neither, with your stack.',
  },
  phases: {
    lobby: 'Waiting for players.',
    pass: 'One move a window, all at once. pass carries the card, and may carry raise: n (1 to the raise limit: 1000 on play chips, 25 at a tNIGHT table; added to what you owe, and you pay both) or, facing a raise, must carry match: true unless it raises; or fold. Whoever passed before a raise answers with match or fold once the cards are in. Nobody can stop in a window with a raise out. The pot stops at limits.potLimit (4000 on play chips, 500 at a tNIGHT table): then no more raises, and a match pays only what fits (legal moves show the cost; potLimitReached in the public state). Stopping the passing is a claim: stop must carry claim, and may carry raise: n up to limits.raiseLimit. That was your turn in the lap. Stopping without a claim is refused (bad_claim).',
    claim: 'One turn each, from the seat after the stopper, or from the starter if five passes went by: check, claim or call. Any of them can carry raise: n, any amount above the highest raise so far, up to limits.raiseLimit (1000 on play chips, 25 at a tNIGHT table). Facing a raise you must also send match: true or fold: true, or raise higher. A raise is to a level: you pay the difference up to it. fold: true works with call, or send { action: "fold" } alone. It costs nothing more and withdraws any claim you hold. GET /tables/:id/me lists what each move can carry, and facing says what you owe. Calls stay open all lap.',
    answer: 'After the lap, if a claim stands: seats still in that have not matched the highest raise get one turn each, starting after the raiser. match pays the difference; fold withdraws your claim. You can also call an uncalled claim, with match: true or fold: true: { action: "call", seat, match: true }. Stakes as in the lap. No new claims or raises. lapRaise in the public state has high, by, paid, waiting and stopper.',
    settled: 'The pot is paid. In lastResult, a seat that won with everyone else folded has its standing claim on its award. next deals the next round.',
    over: 'The table has closed.',
  },
  actions: [
    { action: 'pass', card: 'Ah' },
    { action: 'pass', card: 'Ah', raise: 5 },
    { action: 'pass', card: 'Ah', match: true },
    { action: 'match' },
    { action: 'fold' },
    { action: 'stop', claim: [1, 14, 0] },
    { action: 'stop', claim: [1, 14, 0], raise: 10 },
    { action: 'claim', claim: [1, 14, 0] },
    { action: 'claim', claim: [1, 14, 0], raise: 12 },
    { action: 'claim', claim: [1, 14, 0], match: true },
    { action: 'call', seat: 2 },
    { action: 'call', seat: 2, raise: 12 },
    { action: 'call', seat: 2, match: true },
    { action: 'call', seat: 2, fold: true },
    { action: 'check' },
    { action: 'check', raise: 12 },
    { action: 'check', match: true },
    { action: 'next' },
    { action: 'back' },
  ],
  claims: {
    format: '[cat, r1, r2], compared in that order. Ranks 2..14 (A = 14). Trailing zeros may be left off.',
    pair: '[1, r]',
    twoPair: '[2, r1, r2] with r1 > r2, or [2, r1] for "r1 high"',
    three: '[3, r]',
    straight: '[4, top], 5 (the wheel) to 14',
    flush: '[5] or [5, top]',
    fullHouse: '[6, r1, r2] or [6, r1] for "r1 full"',
    four: '[7, r]',
    straightFlush: '[8]',
  },
};

async function listGames(env) {
  const res = await directoryStub(env).fetch('https://directory/list');
  const byGame = await res.json();
  return GAMES.map((game) => describeGame(game, byGame[game.id] ?? []));
}

async function playersRoute(request, env, parts) {
  if (parts.length === 1) {
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /players.');
    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'bad_json', 'Request body is not valid JSON.');
    }
    const cleaned = cleanName(body?.name);
    if (cleaned.error) return fail(400, 'bad_name', cleaned.error);
    if (isDoormanName(cleaned.name) && !(env.ALLOW_TEST_CONFIG === '1' && body.testSaved)) return fail(409, 'name_reserved', `"${cleaned.name}" keeps the door here. Pick another name.`);
    const look = cleanAvatar(body?.avatar);
    if (look.error) return fail(400, 'bad_avatar', look.error);
    const id = env.PLAYER.newUniqueId();
    return env.PLAYER.get(id).fetch(new Request('https://player/create', {
      method: 'POST',
      body: JSON.stringify({ name: cleaned.name, ...(look.id ? { avatar: look.id } : {}), ...(env.ALLOW_TEST_CONFIG === '1' && Number.isInteger(body.testChips) ? { chips: body.testChips } : {}), ...(env.ALLOW_TEST_CONFIG === '1' && body.testSavedAvatar ? { avatar: body.testSavedAvatar } : {}) }),
    }));
  }
  if (parts.length === 3 && parts[1] === 'me' && parts[2] === 'topup') {
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /players/me/topup.');
    const parsed = parsePlayerToken(env, bearer(request));
    if (!parsed) return fail(401, 'bad_token', 'Send your player token as "Authorization: Bearer <token>".');
    return env.PLAYER.get(env.PLAYER.idFromString(parsed.playerId)).fetch(new Request('https://player/topup', { method: 'POST', body: JSON.stringify({ secret: parsed.secret }) }));
  }
  if (parts.length === 3 && parts[1] === 'me' && parts[2] === 'fill-up') {
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /players/me/fill-up.');
    const parsed = parsePlayerToken(env, bearer(request));
    if (!parsed) return fail(401, 'bad_token', 'Send your player token as "Authorization: Bearer <token>".');
    return env.PLAYER.get(env.PLAYER.idFromString(parsed.playerId)).fetch(new Request('https://player/fill-up', { method: 'POST', body: JSON.stringify({ secret: parsed.secret }) }));
  }
  if (parts.length === 3 && parts[1] === 'me' && parts[2] === 'avatar') {
    if (request.method !== 'POST') return fail(405, 'method', 'Use POST /players/me/avatar.');
    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'bad_json', 'Request body is not valid JSON.');
    }
    const look = cleanAvatar(body?.avatar);
    if (look.error || !look.id) return fail(400, 'bad_avatar', look.error ?? `avatar must be one of: ${AVATARS.join(', ')}.`);
    try {
      return json(await rememberAvatar(env, bearer(request), look.id));
    } catch (err) {
      return fail(err.status ?? 500, err.code ?? 'server_error', err.message);
    }
  }
  if (parts.length === 3 && parts[1] === 'me' && parts[2] === 'seats') {
    if (request.method !== 'GET') return fail(405, 'method', 'Use GET /players/me/seats.');
    try {
      const me = await verifyPlayer(env, bearer(request));
      const seats = [...(await liveSeats(env, me.inPlay, me.playerId)), ...(await liveDiceSeats(env, me.inPlay, me.playerId))];
      return json({ seats: seats.map((seat) => ({ ...seat, page: GAMES.find((g) => g.id === seat.game)?.page })) });
    } catch (err) {
      return fail(err.status ?? 500, err.code ?? 'server_error', err.message);
    }
  }
  if (parts.length === 2 && parts[1] === 'me') {
    if (request.method !== 'GET') return fail(405, 'method', 'Use GET /players/me.');
    const parsed = parsePlayerToken(env, bearer(request));
    if (!parsed) return fail(401, 'bad_token', 'Send your player token as "Authorization: Bearer <token>".');
    return env.PLAYER.get(env.PLAYER.idFromString(parsed.playerId)).fetch(new Request('https://player/me', { headers: { 'x-secret': parsed.secret } }));
  }
  return fail(404, 'not_found', 'No such route. GET /api lists them.');
}

export default {
  async fetch(request, env) {
    const moved = homeRedirect(request.url);
    if (moved) return moved;

    const { pathname, origin } = new URL(request.url);
    const parts = pathname.split('/').filter(Boolean);
    const isGet = request.method === 'GET';

    const limited = (await checkIpLimit(request, env, parts)) ?? (await checkKeyLimit(request, env, parts));
    if (limited) return limited;

    switch (parts[0]) {
      case 'api':
        return isGet && parts.length === 1 ? json(API_HELP) : fail(404, 'not_found', 'Use GET /api.');
      case 'hall':
        return isGet && parts.length === 1 ? json({ ...doormanFor(env, request.url), avatars: AVATARS, features: { radio: radioConfig(env), tnight: env.TNIGHT_TABLES === 'on', agentTnight: agentTnightOn(env), wallet: walletPageOn(env), fresh: env.FRESH_START === 'on', anchor: anchorConfig(env).on ? { mode: anchorConfig(env).mode, scope: anchorConfig(env).scope, picker: anchorConfig(env).picker } : null, dealByPlayer: env.DEAL_BY_PLAYER === 'on' }, games: await listGames(env) }) : fail(404, 'not_found', 'Use GET /hall.');
      case 'games':
        return isGet && parts.length === 1 ? json({ games: await listGames(env), features: { wallet: walletPageOn(env), fresh: env.FRESH_START === 'on' } }) : fail(404, 'not_found', 'Use GET /games.');
      case 'players':
        return playersRoute(request, env, parts);
      case 'dice':
        if (isGet && parts.length === 2 && parts[1] === 'new') return newTableRedirect(request, env);
        break;
      case 'receipt':
      case 'receipts':
        return receiptRoute(request, env, parts);
      case 'records':
        return withSocialOrigin(await recordsRoute(request, env, parts), origin); // the Records pages carry the card tags too
      case 'lobby':
        if (parts.length === 1) break; // the page, /lobby
        return lobbyRoute(request, env, parts).catch((err) => fail(err.status ?? 500, err.code ?? 'server_error', err.message));
      case 'watch':
        return watchRoute(request, env, parts).catch((err) => fail(err.status ?? 500, err.code ?? 'server_error', err.message));
      case 'radio':
        return isGet && parts.length === 1 ? json({ radio: radioConfig(env) }) : fail(404, 'not_found', 'Use GET /radio.');
      case 'board':
        return boardRoute(request, env, parts);
      case 'closures': {
        // The Hall's record of closed tables, newest first: no auth, names and chips only.
        if (request.method !== 'GET' || parts.length !== 1) return fail(404, 'not_found', 'Use GET /closures[?game=&limit=50].');
        const q = new URL(request.url).searchParams;
        const game = q.get('game');
        if (game && !GAMES.some((g) => g.id === game)) return fail(400, 'bad_game', `game is one of: ${GAMES.map((g) => g.id).join(', ')}.`);
        const limit = q.has('limit') ? Number(q.get('limit')) : 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(400, 'bad_limit', 'limit is a whole number from 1 to 200.');
        return env.DIRECTORY.get(env.DIRECTORY.idFromName('hall')).fetch(new Request('https://directory/closures', { method: 'POST', body: JSON.stringify({ game, limit }) }));
      }
      case 'judge':
        return judgeRoute(request, env, parts);
      case 'agent-settings':
        return agentSettingsRoute(request, env, parts).catch((err) => fail(err.status ?? 500, err.code ?? 'server_error', err.message));
      case 'door':
        return doorRoute(request, env, parts).catch((err) => fail(err.status ?? 500, err.code ?? 'server_error', err.message));
      case 'anchor':
        return anchorRoute(request, env, parts).catch((err) => fail(err.status ?? 500, err.code ?? 'server_error', err.message));
      case 'indexer':
        return indexerRoute(request, env, parts).catch((err) => fail(err.status ?? 500, err.code ?? 'server_error', err.message));
      default:
    }
    for (const game of GAMES) {
      if (game.route && parts[0] === game.api.slice(1)) return game.route(request, env, parts);
    }

    // Start here (a permanent page; its test-build parts show only where FRESH_START is on): /start, and /test, its first address.
    if (pathname === '/start') return withPageHeaders(withSocialOrigin(await env.ASSETS.fetch(new Request(new URL('/test', request.url), request)), origin), { radio: radioConfig(env) });
    const walletPath = isWalletPath(pathname);
    if (walletPath && !walletPageOn(env)) return fail(404, 'not_found', 'No such route. GET /api lists them.');
    // An agent's owner signs its settings with a wallet, so the page gets the wallet page's headers; it is there only where agents play tNIGHT.
    const ownerPage = ['/agents/owner', '/agents/owner.html', '/js/agent-owner.js'].includes(pathname);
    if (ownerPage && !agentTnightOn(env)) return fail(404, 'not_found', 'No such route. GET /api lists them.');
    const page = await env.ASSETS.fetch(request);
    if (page.status === 404) return fail(404, 'not_found', 'No such route. GET /api lists them.');
    if (walletPath || ownerPage || (walletPageOn(env) && isTablePage(pathname))) return withWalletHeaders(page, { radio: radioConfig(env) });
    if (pathname.endsWith('.svg')) return withSvgHeaders(page);
    if (pathname === '/og.jpg') return withImageCache(page);
    const served = pathname === '/' || pathname === '/index.html' ? withPreviewText(page, env) : page;
    return withPageHeaders(withSocialOrigin(served, origin), { radio: radioConfig(env) });
  },
};
