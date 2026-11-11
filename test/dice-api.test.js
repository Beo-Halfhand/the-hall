// Cup & Claim over HTTP: spawns `wrangler dev` (local only), plays rounds through the API, and shuts it down.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServers } from './server.js';
import { commitHouse, commitSeed, verifyShown } from '../src/games/cup-and-claim/fair.js';

const PORT = 8841;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']), { timeout: 90_000 });
after(stopServers);

async function call(method, path, { body, token, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json() };
}

const totalChips = (v) => v.seats.reduce((sum, x) => sum + x.chips, v.pot) - (v.houseStaked ?? 0); // the house topping a bot up is new money, counted apart

async function newTable(options = {}, test = {}) {
  const t = await call('POST', '/dice-tables', { body: { lobbySeconds: 0, ...options, test: { rng: 42, roundGapMs: 1500, ...test } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  return t.body.id;
}

/** Public state must never hold a die, a seed or a token. */
function assertClean(view, token, seeds = []) {
  const text = JSON.stringify({ ...view, lastDuel: null }); // a shown cup's dice live in lastDuel, by its owner's choice
  assert.ok(!/"dice":\[/.test(text), 'dice are in the public state');
  for (const r of view.lastDuel?.reveals ?? []) if (r.mode !== 'show') assert.equal(r.dice, undefined, 'a shut cup leaked its dice');
  assert.ok(!/"seeds"|"tokens"|"testRng"|"houseSeed":"[0-9a-f]{64}"/.test(text) || view.phase === 'settled', 'a private field is in the public state');
  if (token) assert.ok(!text.includes(token), 'the token is in the public state');
  for (const seed of seeds) assert.ok(!text.includes(seed), 'a seed is in the public state');
}

/** Waits until it's our turn, the round is over, or the table is waiting on us in a duel. */
async function waitForMe(path, token, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const me = (await call('GET', `${path}/me`, { token })).body;
    if (me.legal.length) return me;
    await sleep(100);
  }
  throw new Error('timed out waiting for a legal move');
}

test('help and routes: GET /dice-tables is the help; the Hall lists the game; errors are clear', async () => {
  const help = await call('GET', '/dice-tables');
  assert.equal(help.status, 200);
  assert.equal(help.body.name, 'Cup & Claim');
  assert.match(help.body.plaque, /I choose what to show/);
  assert.ok(help.body.routes['POST /dice-tables/:id/act']);
  const hall = await call('GET', '/api');
  assert.ok(hall.body.routes['GET /dice-tables'], 'the Hall help points here');
  const games = (await call('GET', '/games')).body.games;
  const dice = games.find((g) => g.id === 'cup-and-claim');
  assert.equal(dice.status, 'live');
  assert.equal(dice.page, '/dice');
  assert.equal(dice.api, '/dice-tables');
  assert.match(dice.plaque, /the dice, or just the count/);
  assert.equal((await call('GET', '/dice-tables/not-an-id')).status, 404);
  assert.equal((await call('POST', '/dice-tables', { raw: '{oops' })).status, 400);
  assert.equal((await call('POST', '/dice-tables', { body: { seats: 7 } })).status, 400);
  assert.equal((await call('POST', '/dice-tables', { body: { stakes: { potLimit: 5000 } } })).status, 400, 'a tier that could cost over 1000 in a round');
  assert.equal((await call('POST', '/dice-tables', { body: { stakes: { ante: 0 } } })).status, 400);
  const id = await newTable();
  assert.equal((await call('POST', `/dice-tables/${id}/join`, { body: { name: 'Brannock' } })).status, 409, 'bot names are reserved');
  assert.equal((await call('POST', `/dice-tables/${id}/join`, { body: { name: 'Red Mab' } })).status, 409);
  assert.equal((await call('GET', `/dice-tables/${id}/junk`)).status, 404);
});

test('GET /dice/new: makes a four-seat table and redirects to its page; a second tap finds the waiting one; ?fresh=1 makes another', async () => {
  const first = await fetch(`${BASE}/dice/new`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  const location = first.headers.get('location');
  assert.match(location, /^\/dice\?id=[0-9a-f]{64}&join=1$/);
  const id = location.slice(9, 73);
  const view = (await call('GET', `/dice-tables/${id}`)).body;
  assert.equal(view.phase, 'lobby');
  assert.equal(view.seatsTotal, 4);
  // The directory lists it once someone sits down; a fresh tap before that makes another, a waiting one is reused after.
  await call('POST', `/dice-tables/${id}/join`, { body: { name: 'Early' } }); // lobbySeconds 0: the table starts at once, so it isn't joinable
  const hall = (await call('GET', '/hall')).body;
  assert.match(hall.upstairs, /Cup & Claim/);
  assert.ok(hall.rules.at(-1).includes('Cup & Claim'), 'the doorman has a line about the dice table');
  const game = (await call('GET', '/games')).body.games.find((g) => g.id === 'cup-and-claim');
  assert.equal(game.sign, 'Upstairs: Cup & Claim');
  assert.equal(game.entry, '/dice/new');
  const again = await fetch(`${BASE}/dice/new?fresh=1`, { redirect: 'manual' });
  assert.equal(again.status, 302);
  assert.notEqual(again.headers.get('location'), location);
});

test('a full round over HTTP: join, bid with a raise, bots answer, Liar, prove or show, the pot is paid', async () => {
  const id = await newTable();
  const path = `/dice-tables/${id}`;
  const joined = await call('POST', `${path}/join`, { body: { name: 'Probe' } });
  assert.equal(joined.status, 201);
  const { seat, token } = joined.body;
  assert.equal(seat, 0);

  let view = (await call('GET', path)).body;
  assertClean(view, token);
  assert.deepEqual(view.seats.map((s) => [s.name, s.bot]), [['Probe', false], ['Tally · house', true], ['Brannock', true], ['Old Wick', true]]);
  assert.equal(view.phase, 'bid');
  assert.equal(view.pot, 20);
  assert.equal(view.totalDice, 20);
  assert.equal(totalChips(view), 4000, 'a guest seat and three house bots, 1,000 each');
  assert.match(view.fair.houseCommit, /^[0-9a-f]{64}$/);
  assert.equal(view.fair.commits.length, 4);
  assert.equal(view.fair.opened, null);
  assert.equal(view.turn, 0);

  assert.equal((await call('GET', `${path}/me`)).status, 401);
  let me = (await call('GET', `${path}/me`, { token })).body;
  assert.equal(me.dice.length, 5);
  assert.ok(me.dice.every((d) => d >= 1 && d <= 6));
  assert.equal(me.commit, view.fair.commits[0]);
  assert.deepEqual(me.legal.map((a) => a.action), ['bid']);
  const bidAction = me.legal[0];
  assert.deepEqual(bidAction.lowest, { count: 1, face: 2 });
  assert.equal(bidAction.raise.max, 995, 'a play-chip table lets a raise go up to the whole stack (1,000 less the ante)');

  const illegal = [
    [{ action: 'dance' }, 400, 'bad_action'],
    [{ action: 'bid', count: 1, face: 1 }, 400, 'bad_bid'],
    [{ action: 'bid', count: 1, face: 2, raise: 996 }, 400, 'bad_raise'], // more than the stack
    [{ action: 'liar' }, 409, 'no_bid'],
    [{ action: 'fold' }, 409, 'no_bid'],
    [{ action: 'reveal', mode: 'show' }, 409, 'wrong_phase'],
    [{ action: 'next' }, 409, 'wrong_phase'],
  ];
  for (const [body, status, error] of illegal) {
    const r = await call('POST', `${path}/act`, { body, token });
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error, error);
  }

  // Open with a bid and a raise of 10. The bots (no delay on a test table) play round to us or end the round.
  const opened = await call('POST', `${path}/act`, { body: { action: 'bid', count: 2, face: me.dice.find((d) => d > 1) ?? 2, raise: 10 }, token });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  view = opened.body.state; // the bots have no delay on a test table, so they may already have moved on
  assert.ok(view.pot >= 30, `pot ${view.pot}`);
  assert.ok(view.chipLog.some((m) => m.kind === 'ante' && m.from === 0 && m.amount === 5));
  assert.ok(view.chipLog.some((m) => m.kind === 'raise' && m.from === 0 && m.amount === 10));
  assertClean(view, token);

  // Play until the round settles, answering whatever the table asks of us.
  let rounds = 0;
  for (let guard = 0; guard < 60 && rounds < 2; guard++) {
    view = (await call('GET', path)).body;
    assertClean(view, token);
    assert.ok(view.pot <= 4000);
    if (view.phase === 'settled') {
      assert.ok(['duel', 'uncontested'].includes(view.lastResult.kind));
      assert.equal(totalChips(view), 4000, 'chips are conserved');
      assert.match(view.fair.opened, /^[0-9a-f]{64}$/, 'the house seed opens at the end of the round');
      assert.equal(commitHouse(view.fair.opened), view.fair.houseCommit, 'and matches its commitment');
      if (view.lastResult.kind === 'duel') {
        const { lastDuel } = view;
        assert.equal(lastDuel.reveals.length, 4);
        for (const r of lastDuel.reveals) {
          if (r.mode === 'show') assert.ok(verifyShown({ houseSeed: lastDuel.houseSeed, houseCommit: lastDuel.houseCommit, seed: r.seed, commit: r.commit, seat: r.seat, round: lastDuel.round, dice: r.dice }), `seat ${r.seat} shown dice verify`);
          else {
            assert.equal(r.dice, undefined);
            assert.equal(r.proof.kind, 'house-attested');
            assert.equal(commitSeed.length, 1);
          }
        }
        assert.equal(lastDuel.reveals.reduce((n, r) => n + r.count, 0), lastDuel.total);
      }
      rounds += 1;
      const next = await call('POST', `${path}/act`, { body: { action: 'next' }, token });
      assert.equal(next.status, 200, JSON.stringify(next.body));
      continue;
    }
    if (view.phase === 'over') break;
    me = (await call('GET', `${path}/me`, { token })).body;
    if (!me.legal.length) {
      await sleep(100);
      continue;
    }
    const liar = me.legal.find((a) => a.action === 'liar');
    const reveal = me.legal.find((a) => a.action === 'reveal');
    const bid = me.legal.find((a) => a.action === 'bid');
    let body;
    if (reveal) body = { action: 'reveal', mode: guard % 2 ? 'show' : 'prove' };
    else if (liar && (view.bid.count >= 5 || !bid)) body = { action: 'liar' };
    else body = { action: 'bid', ...bid.lowest };
    const r = await call('POST', `${path}/act`, { body, token });
    assert.equal(r.status, 200, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
  }
  assert.equal(rounds, 2, 'two rounds were played and settled');

  // Talk, leave.
  const talk = await call('POST', `${path}/say`, { body: { text: 'well shit, nice cups' }, token });
  assert.equal(talk.status, 201);
  assert.equal(talk.body.text, 'well ****, nice cups');
  const quick = await call('GET', `${path}/quick`, { token });
  assert.equal(quick.body.lines.length, 4);
  const left = await call('POST', `${path}/leave`, { token, body: {} });
  assert.equal(left.status, 200);
});

test('six seats with a player purse: buy in, the seat is found by player token, stakes settings are reported', async () => {
  const player = (await call('POST', '/players', { body: { name: 'Purse', testChips: 500 } })).body;
  const id = await newTable({ seats: 6, stakes: { ante: 10, raiseLimit: 50, potLimit: 900 } });
  const path = `/dice-tables/${id}`;
  const joined = await call('POST', `${path}/join`, { token: player.token, body: { kind: 'human', buyIn: 200 } });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  const view = joined.body.state;
  assert.equal(view.seatsTotal, 6);
  assert.equal(view.seats.length, 6);
  assert.deepEqual(view.seats.slice(1).map((x) => x.name), ['Tally · house', 'Brannock', 'Old Wick', 'Red Mab', 'Sister Ivy']);
  assert.equal(view.seats[4].avatar, 'pirate');
  assert.equal(view.limits.ante, 10);
  assert.equal(view.limits.raiseLimit, 50);
  assert.equal(view.limits.potLimit, 900);
  assert.equal(view.pot, 60);
  assert.equal(view.totalDice, 30);
  const seat = await call('GET', `${path}/seat`, { token: player.token });
  assert.equal(seat.body.status, 'seated');
  assert.equal(seat.body.stack, 190);
  const seats = await call('GET', '/players/me/seats', { token: player.token });
  assert.deepEqual(seats.body.seats.map((s) => [s.game, s.page]), [['cup-and-claim', '/dice']]);
  const purse = (await call('GET', '/players/me', { token: player.token })).body;
  assert.equal(purse.purse.amount, 300);
  assert.deepEqual(purse.inPlay, [{ key: `cup-and-claim:${id}`, amount: 200 }]);
});

test('a person with chips at one dice table is sent back to it from another, before the purse is touched', async () => {
  const player = (await call('POST', '/players', { body: { name: 'Wanderer' } })).body;
  assert.equal(player.purse.amount, 1000, 'a new player starts with the normal purse');
  const first = await fetch(`${BASE}/dice/new?fresh=1`, { redirect: 'manual' });
  const idA = first.headers.get('location').slice(9, 73);
  const joinedA = await call('POST', `/dice-tables/${idA}/join`, { token: player.token, body: { kind: 'human' } });
  assert.equal(joinedA.status, 201, JSON.stringify(joinedA.body));
  assert.equal(joinedA.body.state.seats[0].chips, 995, 'the whole purse came to the table');
  assert.equal((await call('GET', '/players/me', { token: player.token })).body.purse.amount, 0);
  const second = await fetch(`${BASE}/dice/new?fresh=1`, { redirect: 'manual' });
  const idB = second.headers.get('location').slice(9, 73);
  const joinedB = await call('POST', `/dice-tables/${idB}/join`, { token: player.token, body: { kind: 'human' } });
  assert.equal(joinedB.status, 409);
  assert.equal(joinedB.body.error, 'seated_elsewhere', 'not "your purse is empty"');
  assert.match(joinedB.body.message, /stack of 995/);
  const topup = await call('POST', '/players/me/topup', { token: player.token });
  assert.equal(topup.status, 409);
  assert.equal(topup.body.error, 'chips_in_play');
  const seats = (await call('GET', '/players/me/seats', { token: player.token })).body.seats;
  assert.deepEqual(seats.map((s) => [s.tableId, s.stack, s.page]), [[idA, 995, '/dice']], 'the way back');
  // Back at the first table the seat is theirs again, with a new seat token.
  const back = await call('POST', `/dice-tables/${idA}/join`, { token: player.token, body: { kind: 'human' } });
  assert.equal(back.status, 200);
  assert.equal(back.body.rejoined, true);
  // An agent may hold seats at several tables, as before.
  const agent = (await call('POST', '/players', { body: { name: 'Agent' } })).body;
  assert.equal((await call('POST', `/dice-tables/${idA}/join`, { token: agent.token, body: { kind: 'agent' } })).status, 409, 'table A has started');
  const idC = (await fetch(`${BASE}/dice/new?fresh=1`, { redirect: 'manual' })).headers.get('location').slice(9, 73);
  assert.equal((await call('POST', `/dice-tables/${idC}/join`, { token: agent.token, body: { kind: 'agent', buyIn: 100 } })).status, 201);
});

test('the pot limit over HTTP: raise.potLimitReached shows up and no raise past it is accepted', async () => {
  const id = await newTable({ seats: 2, stakes: { ante: 5, raiseLimit: 25, potLimit: 40 } });
  const path = `/dice-tables/${id}`;
  const { token } = (await call('POST', `${path}/join`, { body: { name: 'Probe' } })).body;
  let me = await waitForMe(path, token);
  const bid = me.legal.find((a) => a.action === 'bid');
  assert.equal(bid.raise.max, 15, '(40 − 10) / 2');
  assert.equal(bid.raise.limitedBy, 'pot');
  assert.equal((await call('POST', `${path}/act`, { body: { action: 'bid', ...bid.lowest, raise: 16 }, token })).body.error, 'bad_raise');
  const r = await call('POST', `${path}/act`, { body: { action: 'bid', ...bid.lowest, raise: 15 }, token });
  assert.equal(r.status, 200);
  assert.ok(r.body.state.pot >= 25 && r.body.state.pot <= 40, `pot ${r.body.state.pot}`);
  assert.ok(r.body.state.chipLog.some((m) => m.kind === 'raise' && m.from === 0 && m.amount === 15));
  assert.equal(r.body.state.raiseRoom?.potLimitReached ?? true, true);
  me = await waitForMe(path, token);
  const view = (await call('GET', path)).body;
  assert.ok(view.pot <= 40);
  if (view.phase === 'bid') {
    const again = me.legal.find((a) => a.action === 'bid');
    if (again) {
      assert.equal(again.raise.max, 0);
      assert.equal(again.raise.potLimitReached, true);
      assert.equal((await call('POST', `${path}/act`, { body: { action: 'bid', ...again.lowest, raise: 1 }, token })).body.error, 'pot_limit');
    }
  }
});

/** The plainest legal play for the one human, until the round is over. */
async function playToSettled(path, token) {
  for (let i = 0; i < 400; i++) {
    const view = (await call('GET', path)).body;
    if (['settled', 'over'].includes(view.phase)) return view;
    const me = (await call('GET', `${path}/me`, { token })).body;
    const has = (a) => me.legal?.find((l) => l.action === a);
    const body = has('reveal') ? { action: 'reveal', mode: 'prove' } : has('liar') ? { action: 'liar' } : has('bid') ? { action: 'bid', ...has('bid').lowest } : null;
    if (body) await call('POST', `${path}/act`, { body, token });
    else await sleep(50);
  }
  throw new Error('the round never ended');
}

test('play chips: out of chips at a Cup & Claim table, the table stays open with the result up; Fill up brings the stack back to 1,000 and the next round deals', async () => {
  let found = null;
  for (let rng = 1; rng < 40 && !found; rng++) {
    const player = (await call('POST', '/players', { body: { name: `Bust ${rng}`, testChips: 40 } })).body;
    const id = await newTable({}, { rng, roundGapMs: 30_000 });
    const path = `/dice-tables/${id}`;
    const joined = await call('POST', `${path}/join`, { token: player.token, body: { kind: 'human', buyIn: 5 } });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    const view = await playToSettled(path, joined.body.token);
    if (view.phase === 'settled' && view.seats[0].chips < 5) found = { player, id, path, token: joined.body.token, round: view.round };
  }
  assert.ok(found, 'a seat with 5 chips loses its ante-sized stake in some round');
  const { path, token, round } = found;
  const me = (await call('GET', `${path}/me`, { token })).body;
  assert.deepEqual([me.broke, me.canFillUp], [true, true]);
  // Pressing Next with nothing to ante with changes nothing: not closed, no round dealt, the result stays.
  const next = await call('POST', `${path}/act`, { body: { action: 'next' }, token });
  assert.equal(next.status, 200);
  const waiting = (await call('GET', path)).body;
  assert.deepEqual([waiting.phase, waiting.round, waiting.overCode, waiting.lastResult.round], ['settled', round, null, round]);
  assert.ok(waiting.log.some((l) => /out of chips: fill up to keep playing, or leave/.test(l.text)));
  // Fill up: the stack to 1,000, the purse topped up with just the shortfall.
  const filled = await call('POST', `${path}/fill-up`, { body: {}, token });
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.deepEqual([filled.body.stack, filled.body.added + (waiting.seats[0].chips), filled.body.me.broke], [1000, 1000, false]);
  assert.equal((await call('POST', `${path}/fill-up`, { body: {}, token })).body.added, 0, 'idempotent at 1,000');
  const dealt = await call('POST', `${path}/act`, { body: { action: 'next' }, token });
  assert.equal(dealt.status, 200);
  assert.equal(dealt.body.state.round, round + 1, 'the next round dealt');
  assert.equal(dealt.body.state.seats[0].chips, 995);
});

test('fill up and the default buy-in at a Cup & Claim table', async () => {
  const player = (await call('POST', '/players', { body: { name: 'Dice Short', testChips: 250 } })).body;
  const id = await newTable();
  const path = `/dice-tables/${id}`;
  const joined = await call('POST', `${path}/join`, { token: player.token, body: { kind: 'agent' } });
  assert.equal(joined.body.state.seats[0].chips, 995, 'an agent sits down with 1,000 too (less the ante), a short purse filled first');
  assert.equal((await call('GET', '/players/me', { token: player.token })).body.purse.amount, 0);
  assert.equal((await call('GET', path)).body.buyIn, 1000);
  const mid = await call('POST', `${path}/fill-up`, { body: {}, token: joined.body.token });
  assert.equal(mid.status, 409, 'mid-round');
  assert.equal(mid.body.error, 'not_between_rounds');
  assert.equal((await call('POST', `${path}/fill-up`, { body: {} })).status, 401);
});

test('GET /closures: a Cup & Claim table that closes is recorded', async () => {
  const id = await newTable({}, { roundGapMs: 30_000 });
  const path = `/dice-tables/${id}`;
  const { token } = (await call('POST', `${path}/join`, { body: { name: 'Closer', kind: 'human' } })).body;
  const view = await playToSettled(path, token);
  assert.equal(view.phase, 'settled');
  await call('POST', `${path}/leave`, { body: {}, token });
  const over = (await call('GET', path)).body;
  assert.deepEqual([over.phase, over.overCode, over.overReason, over.overRound], ['over', 'everyone_left', 'Everyone else left.', view.round]);
  let mine;
  for (let i = 0; i < 40 && !mine; i++) {
    await sleep(100);
    mine = (await call('GET', '/closures?game=cup-and-claim')).body.closures?.find((e) => e.id === id);
  }
  assert.ok(mine);
  assert.deepEqual([mine.round, mine.code, mine.text, mine.humans], [view.round, 'everyone_left', 'Everyone else left.', ['Closer']]);
  assert.ok(Number.isInteger(mine.n));
});

test('one table at a time across both games, even though a short purse is filled to the default at join: the card table refuses a person seated at dice, and the purse is left as it was', async () => {
  const player = (await call('POST', '/players', { body: { name: 'Crosser', testChips: 500 } })).body;
  const dice = await newTable();
  const seated = await call('POST', `/dice-tables/${dice}/join`, { token: player.token, body: { kind: 'human', buyIn: 500 } });
  assert.equal(seated.status, 201, JSON.stringify(seated.body));
  assert.equal((await call('GET', '/players/me', { token: player.token })).body.purse.amount, 0);
  const cards = (await call('POST', '/tables', { body: { lobbySeconds: 0 } })).body;
  const refused = await call('POST', `/tables/${cards.id}/join`, { token: player.token, body: { kind: 'human' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'seated_elsewhere', 'the default stack is minted at join, so an empty purse no longer stops a second seat: the rule has to');
  const me = (await call('GET', '/players/me', { token: player.token })).body;
  assert.equal(me.purse.amount, 0, 'the chips minted for the refused seat were given back');
  assert.equal(me.inPlay.length, 1, 'one seat, at dice');
});
