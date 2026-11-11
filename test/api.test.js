// The real thing over HTTP: spawns `wrangler dev` (local only, no account), plays through the API,
// and shuts the server down. ALLOW_TEST_CONFIG switches on repeatable shuffles and short clocks for this run.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startServer, stopServers } from './server.js';
import { answering, stopping } from './helpers.js';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const CARD_JSON = /"[2-9TJQKA][cdhs]"/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']), { timeout: 90_000 });

after(stopServers);

async function call(method, path, opts = {}) {
  // These do their sums at an ante of 1: stakes are a table setting, and the defaults have a test of their own.
  const { token, raw } = opts;
  const body = method === 'POST' && path === '/tables' && opts.body && opts.body.stakes === undefined ? { ...opts.body, stakes: { ante: 1 } } : opts.body;
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json() };
}

const totalChips = (v) => v.seats.reduce((sum, x) => sum + x.chips, v.pot) - (v.houseStaked ?? 0); // the house topping a bot up is new money, counted apart

async function newTable(test = {}) {
  // These do their sums at an ante of 1: stakes are a table setting, and the defaults have a test of their own.
  const t = await call('POST', '/tables', { body: { lobbySeconds: 0, stakes: { ante: 1 }, test: { rng: 42, roundGapMs: 1500, ...test } } });
  assert.equal(t.status, 201);
  return t.body.id;
}

/** Public state must never hold a card, a token or a private field. */
function assertClean(view, token) {
  // Once the round is over the deck is opened for all to recheck (the deck seal, 2026-11-07): that part is the one place a card may be.
  const over = view.phase === 'settled' || view.phase === 'over';
  const text = JSON.stringify(over && view.deal ? { ...view, deal: { ...view.deal, opened: view.deal.opened ? 'opened' : null } } : view);
  assert.ok(!CARD_JSON.test(text), 'a card is in the public state');
  assert.ok(!/"hands"|"hand"|"passes"|"tokens"|"testRng"/.test(text), 'a private field is in the public state');
  if (token) assert.ok(!text.includes(token), 'the token is in the public state');
}

test('routes: help, unknown, wrong method, bad JSON, no table', async () => {
  const help = await call('GET', '/api');
  assert.equal(help.status, 200);
  assert.ok(help.body.routes);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/tables')).status, 405);
  assert.equal((await call('GET', '/tables/not-an-id')).status, 404);
  assert.equal((await call('GET', `/tables/${'a'.repeat(64)}`)).status, 404, 'well-formed id, never created');
  assert.equal((await call('POST', '/tables', { raw: '{oops' })).status, 400);
  assert.equal((await call('POST', '/tables', { body: { lobbySeconds: 999 } })).status, 400);
  const id = await newTable();
  assert.equal((await call('POST', `/tables/${id}/join`, { raw: 'nope' })).status, 400);
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { name: '' } })).status, 400);
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { name: 'Brannock' } })).status, 409, 'bot names are reserved');
  assert.equal((await call('GET', `/tables/${id}/junk`)).status, 404);
  assert.equal((await call('POST', `/tables/${id}/me`, { body: {} })).status, 405);
});

test('scripted full round: 1 HTTP player + 3 bots', async () => {
  const id = await newTable();
  const path = `/tables/${id}`;

  const joined = await call('POST', `${path}/join`, { body: { name: 'Probe' } });
  assert.equal(joined.status, 201);
  const { seat, token } = joined.body;
  assert.equal(seat, 0);
  assert.match(token, /^[0-9a-f]{64}$/);

  let view = (await call('GET', path)).body;
  assertClean(view, token);
  assert.deepEqual(view.seats.map((s) => [s.name, s.bot]), [['Probe', false], ['Tally · house', true], ['Brannock', true], ['Old Wick', true]]);
  assert.equal(view.phase, 'pass');
  assert.equal(view.round, 1);
  assert.equal(view.pot, 4);
  const startTotal = totalChips(view);
  assert.equal(startTotal, 4000, "a guest seat sits down with 1,000, and so do the three house bots");

  // No token, a wrong token, and joining a started table.
  assert.equal((await call('GET', `${path}/me`)).status, 401);
  assert.equal((await call('GET', `${path}/me`, { token: 'f'.repeat(64) })).status, 401);
  assert.equal((await call('POST', `${path}/act`, { body: { action: 'check' } })).status, 401);
  assert.equal((await call('POST', `${path}/join`, { body: { name: 'Late' } })).status, 409);

  // My own hand, and legal actions.
  let me = (await call('GET', `${path}/me`, { token })).body;
  assert.equal(me.hand.length, 5);
  assert.equal(me.legal[0].action, 'pass');
  assertClean((await call('GET', path)).body, token);

  // Illegal moves get clear 4xx errors and change nothing.
  const illegal = [
    [{ action: 'dance' }, 400, 'bad_action'],
    [{ action: 'pass', card: 'nope' }, 400, 'bad_card'],
    [{ action: 'stop', claim: [1, 9] }, 409, 'too_early'],
    [{ action: 'claim', claim: [1, 9] }, 409, 'wrong_phase'],
    [{ action: 'match' }, 409, 'wrong_phase'],
    [{ action: 'next' }, 409, 'wrong_phase'],
    [{ action: 'call', seat: 1 }, 409, 'wrong_phase'],
    [{ action: 'check' }, 409, 'wrong_phase'],
  ];
  for (const [body, status, error] of illegal) {
    const r = await call('POST', `${path}/act`, { body, token });
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error, error);
    assert.ok(r.body.message.length > 5, 'has a readable message');
  }
  const notMine = 'AcAdAhAs2c2d2h2s3c3d3h3s'.match(/../g).find((c) => !me.hand.includes(c));
  assert.equal((await call('POST', `${path}/act`, { body: { action: 'pass', card: notMine }, token })).body.error, 'not_in_hand');

  // Table talk.
  assert.equal((await call('POST', `${path}/say`, { body: { text: 'x'.repeat(121) }, token })).status, 400);
  assert.equal((await call('POST', `${path}/say`, { body: { text: 'hello' } })).status, 401);
  const talk = await call('POST', `${path}/say`, { body: { text: 'well fuck, good luck all' }, token });
  assert.equal(talk.status, 201);
  assert.equal(talk.body.text, 'well ****, good luck all');
  view = (await call('GET', path)).body;
  assert.ok(view.log.some((l) => l.say && l.seat === 0 && l.text === 'well ****, good luck all'));

  // Play: pass twice, raise once, stop, claim truthfully if I can. Bots answer inside each request.
  let raised = false;
  const actions = [];
  for (let step = 0; step < 60 && view.round === 1 && view.phase !== 'settled'; step++) {
    me = (await call('GET', `${path}/me`, { token })).body;
    const has = (a) => me.legal.find((l) => l.action === a);
    let body;
    if (has('stop') && !has('pass')?.match) body = stopping(me);
    else if (has('pass') && has('pass').raise && !raised) { body = { action: 'pass', card: has('pass').cards[0], raise: 3 }; raised = true; }
    else if (has('pass')) body = { action: 'pass', card: has('pass').cards[0], ...(has('pass').match ? { match: true } : {}) };
    else if (has('match')) body = { action: 'match' };
    else if (has('claim')?.truthful.length) body = { action: 'claim', claim: has('claim').truthful[0].claim };
    else if (has('check')) body = { action: 'check' };
    else if (has('fold')) body = { action: 'fold' };
    else { view = (await call('GET', path)).body; if (me.legal.length === 0) break; continue; }
    body = answering(me, body);
    const r = await call('POST', `${path}/act`, { body, token });
    assert.equal(r.status, 200, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    actions.push(body.action);
    view = r.body.state;
    assertClean(view, token);
    assert.equal(totalChips(view), startTotal, 'chips conserved');
    assert.ok(view.phase === 'settled' || view.waitingOn.includes(0) || view.phase === 'pass', `the server stops at me, not a bot (${view.phase}, ${view.waitingOn})`);
  }

  assert.ok(actions.filter((a) => a === 'pass').length >= 2, `at least two passes: ${actions}`);
  assert.equal(view.phase, 'settled', `round finished; moves: ${actions}`);
  assert.equal(view.lastResult.round, 1);
  assert.ok(['settled', 'carried', 'uncontested'].includes(view.lastResult.kind));
  const awarded = view.lastResult.awards.reduce((sum, a) => sum + a.amount, 0);
  assert.equal(awarded + view.lastResult.carried, view.lastResult.pot);
  assert.ok(view.log.some((l) => /^Round 1\./.test(l.text)));

  // One player against the house: the round waits for them, and Next round deals.
  await sleep(1800);
  assert.equal((await call('GET', path)).body.round, 1, 'no auto-deal');
  view = (await call('POST', `${path}/act`, { body: { action: 'next' }, token })).body.state;
  assert.equal(view.round, 2);
  assert.equal(view.phase, 'pass');
  assert.equal(view.starter, 1, 'the starter moved on');
  assert.equal(totalChips(view), startTotal);
  assertClean(view, token);
});

test('call over HTTP: the player calls a bot claim and 5 chips move', async () => {
  // Try a few shuffles until a bot leaves a claim standing on the player's turn.
  let called = false;
  for (let rngStart = 1; rngStart <= 12 && !called; rngStart++) {
    const id = await newTable({ rng: rngStart });
    const path = `/tables/${id}`;
    const { token } = (await call('POST', `${path}/join`, { body: { name: 'Probe' } })).body;
    for (let step = 0; step < 40; step++) {
      const me = (await call('GET', `${path}/me`, { token })).body;
      const has = (a) => me.legal.find((l) => l.action === a);
      if (has('call') && !me.facing) {
        const target = has('call').seats[0];
        const before = (await call('GET', path)).body;
        const r = await call('POST', `${path}/act`, { body: { action: 'call', seat: target }, token });
        assert.equal(r.status, 200);
        const status = r.body.state.claims.find((c) => c.seat === target).status;
        assert.ok(['proven', 'caught'].includes(status));
        const moved = r.body.state.seats[0].chips - before.seats[0].chips;
        if (r.body.state.phase === 'claim') {
          assert.equal(moved, status === 'caught' ? 5 : -5, 'caller wins or pays 5');
          assert.equal(r.body.state.seats[target].chips - before.seats[target].chips, -moved, 'claimer pays or wins 5');
        }
        assert.equal(r.body.state.seats[target].rep.called, before.seats[target].rep.called + 1);
        assert.equal(r.body.state.seats[target].rep[status], before.seats[target].rep[status] + 1);
        assertClean(r.body.state, token);
        called = true;
        break;
      }
      let body;
      if (has('pass')) body = { action: 'pass', card: has('pass').cards[0] };
      else if (has('match')) body = { action: 'fold' };
      else if (has('check')) body = { action: 'check' };
      else if (has('fold')) body = { action: 'fold' };
      else break;
      body = answering(me, body);
      const r = await call('POST', `${path}/act`, { body, token });
      if (r.status !== 200) break; // this shuffle took a turn the simple script can't answer: try the next seed
      if (['settled', 'over'].includes(r.body.state.phase) || r.body.me.legal.length === 0) break;
    }
  }
  assert.ok(called, 'no shuffle offered a call in 12 tries');
});

/** Two agents at one table, so it's a mixed table, with bots in the other seats. */
async function mixedTable(test = {}) {
  const t = await call('POST', '/tables', { body: { lobbySeconds: 1, test: { rng: 42, ...test } } });
  const path = `/tables/${t.body.id}`;
  const a = (await call('POST', `${path}/join`, { body: { name: 'Sleeper' } })).body;
  const b = (await call('POST', `${path}/join`, { body: { name: 'Keen' } })).body;
  let view = b.state;
  for (let i = 0; i < 30 && view.phase === 'lobby'; i++) {
    await sleep(100);
    view = (await call('GET', path)).body;
  }
  return { id: t.body.id, path, sleeper: a.token, keen: b.token };
}

test('mixed table: a player who never acts is marked away, not folded, and can\'t freeze the table', async () => {
  const { id, path, sleeper, keen } = await mixedTable({ turnMs: 400, roundGapMs: 300 });
  const round = async () => (await call('GET', path)).body.round;
  await playSeat(id, keen, async () => (await round()) >= 2, 200);
  const view = (await call('GET', path)).body;
  assert.ok(view.round >= 2, `still in round ${view.round}, phase ${view.phase}`);
  assert.ok(view.log.some((l) => l.text === 'Sleeper timed out and is marked away.'));
  assert.equal(view.seats[0].away, true);
  assert.equal(view.seats[0].status, 'out', 'sitting the new round out');
  assert.equal(totalChips(view) <= 4000, true, "two 1,000-chip guest seats and two house bots");
  assertClean(view);
  const me = (await call('GET', `${path}/me`, { token: sleeper })).body;
  assert.equal(me.away, true);
  assert.deepEqual(me.legal, [{ action: 'back' }]);
  assert.equal((await call('POST', `${path}/act`, { body: { action: 'pass', card: 'Ah', raise: 1 }, token: sleeper })).body.error, 'away');
  const back = await call('POST', `${path}/act`, { body: { action: 'back' }, token: sleeper });
  assert.equal(back.status, 200);
  assert.equal(back.body.state.seats[0].away, false);
  assert.ok(back.body.state.log.some((l) => l.text === 'Sleeper is back.'));
});

test('solo table: no clock, nobody marked away, no auto-deal; a table untouched too long closes and pays out', async () => {
  const id = await newTable({ turnMs: 200, roundGapMs: 200 });
  const path = `/tables/${id}`;
  const { body: { token, state } } = await call('POST', `${path}/join`, { body: { name: 'Lone' } });
  assert.equal(state.deadline, null);
  assert.equal(state.clocks.find((k) => k.seat === 0).until, null);
  await sleep(700);
  let view = (await call('GET', path)).body;
  assert.equal(view.passNo, 1, 'it waited');
  assert.equal(view.seats[0].away, false);

  await playSeat(id, token, async () => (await call('GET', path)).body.phase === 'settled', 100);
  view = (await call('GET', path)).body;
  assert.equal(view.phase, 'settled');
  assert.equal(view.deadline, null);
  await sleep(600);
  assert.equal((await call('GET', path)).body.round, 1, 'no auto-deal');
  assert.equal((await call('POST', `${path}/act`, { body: { action: 'next' }, token })).body.state.round, 2);

  const player = (await call('POST', '/players', { body: { name: 'Gone Fishing' } })).body;
  const closing = await newTable({ waitingIdleMs: 600 });
  await call('POST', `/tables/${closing}/join`, { body: {}, token: player.token });
  let phase = 'pass';
  for (let i = 0; i < 40 && phase !== 'over'; i++) {
    await sleep(100);
    phase = (await call('GET', `/tables/${closing}`)).body.phase;
  }
  assert.equal(phase, 'over');
  let me;
  for (let i = 0; i < 30; i++) {
    me = (await call('GET', '/players/me', { token: player.token })).body;
    if (me.inPlay.length === 0) break;
    await sleep(100);
  }
  assert.equal(me.inPlay.length, 0, 'the stack went home');
  assert.equal(me.chips, 1000, 'the stack back, and the ante out of the pot too');
});

test('lobby timer: bots fill the seats when it ends', async () => {
  const t = await call('POST', '/tables', { body: { lobbySeconds: 1, test: { rng: 5 } } });
  const path = `/tables/${t.body.id}`;
  const a = await call('POST', `${path}/join`, { body: { name: 'Ann' } });
  const b = await call('POST', `${path}/join`, { body: { name: 'Bo' } });
  assert.deepEqual([a.body.seat, b.body.seat], [0, 1]);
  assert.equal(b.body.state.phase, 'lobby');
  assert.equal((await call('POST', `${path}/join`, { body: { name: 'ann' } })).status, 409);
  let view = b.body.state;
  for (let i = 0; i < 20 && view.phase === 'lobby'; i++) {
    await sleep(200);
    view = (await call('GET', path)).body;
  }
  assert.equal(view.phase, 'pass');
  assert.deepEqual(view.seats.map((s) => s.name), ['Ann', 'Bo', 'Tally · house', 'Brannock']);
  // Each token opens only its own seat, and neither sees the other's hand.
  const meA = (await call('GET', `${path}/me`, { token: a.body.token })).body;
  const meB = (await call('GET', `${path}/me`, { token: b.body.token })).body;
  assert.deepEqual([meA.seat, meB.seat], [0, 1]);
  assert.ok(!meA.hand.some((c) => meB.hand.includes(c)));
  assert.ok(!JSON.stringify(meA).includes(`"${meB.hand[0]}"`));
});

test('registry: GET /games lists every game, and tables appear and leave as they run', async () => {
  const games = (await call('GET', '/games')).body.games;
  assert.deepEqual(games.map((g) => [g.name, g.status]), [['Sealed Hand', 'live'], ['Cup & Claim', 'live'], ['Axe Lane', 'soon'], ['Roulette Wheel', 'soon'], ['Second Card Table', 'soon']]);
  assert.ok(!JSON.stringify(games).includes('route'), 'internal handlers stay private');
  const live = games[0];
  assert.equal(live.page, '/table');
  assert.equal(live.api, '/tables');
  assert.equal(live.seats, 4);

  const t = await call('POST', '/tables', { body: { lobbySeconds: 2, test: { rng: 8, waitingIdleMs: 3000, roundGapMs: 100, turnMs: 200 } } });
  const id = t.body.id;
  const row = async () => (await call('GET', '/games')).body.games[0].tables.find((x) => x.id === id);
  assert.equal(await row(), undefined, 'a table nobody sat at is not listed');
  await call('POST', `/tables/${id}/join`, { body: { name: 'Ann' } });
  await sleep(150);
  const open = await row();
  assert.deepEqual([open.seatsFilled, open.seats, open.phase, open.joinable], [1, 4, 'lobby', true]);
  assert.equal(open.ante, 1, 'the table picker shows the ante');
  assert.deepEqual(open.faces, [{ name: 'Ann', kind: 'agent', avatar: 'adventurer' }], 'and who sits there, as name and look only');
  await call('POST', `/tables/${id}/join`, { body: { name: 'Bo' } });
  await sleep(150);
  assert.equal((await row()).seatsFilled, 2);
  let now = await row();
  for (let i = 0; i < 40 && now?.phase === 'lobby'; i++) { await sleep(150); now = await row(); }
  assert.deepEqual([now.seatsFilled, now.phase, now.joinable], [4, 'playing', false], 'bots filled it');
  assert.equal(now.faces.length, 4);
  assert.ok(now.faces.filter((f) => f.kind === 'house').every((f) => f.avatar === null), 'a house bot has no look of its own: the page draws it by name');
  // With nobody acting, both go away, the deal waits, and the short limit closes the table. It leaves the list.
  for (let i = 0; i < 100 && now; i++) { await sleep(200); now = await row(); }
  assert.equal(now, undefined, 'a finished table leaves the list');
});

test('the clockwork look: refused to new picks, kept by a player who already has it', async () => {
  // New picks, everywhere one can be made.
  assert.equal((await call('POST', `/tables/${await newTable()}/join`, { body: { name: 'New', avatar: 'clockwork' } })).body.error, 'bad_avatar');
  assert.equal((await call('POST', '/players', { body: { name: 'New', avatar: 'clockwork' } })).body.error, 'bad_avatar');
  const someone = (await call('POST', '/players', { body: { name: 'Someone', testChips: 500 } })).body;
  assert.equal((await call('POST', '/players/me/avatar', { body: { avatar: 'clockwork' }, token: someone.token })).body.error, 'bad_avatar');
  const refused = await call('POST', `/tables/${await newTable()}/join`, { body: { avatar: 'clockwork', buyIn: 100 }, token: someone.token }); // a named buy-in: the default would fill the purse to 1,000 first
  assert.equal(refused.body.error, 'bad_avatar', 'a player who never had it can\'t ask for it');
  const after = (await call('GET', '/players/me', { token: someone.token })).body;
  assert.equal(after.purse.amount, 500, 'the refused buy-in went back');
  assert.deepEqual(after.inPlay, []);
  assert.equal(after.avatar, 'adventurer');

  // A saved player, as old purses have it.
  const saved = (await call('POST', '/players', { body: { name: 'Old Purse', testChips: 500, testSavedAvatar: 'clockwork' } })).body;
  assert.equal(saved.avatar, 'clockwork');
  assert.equal((await call('GET', '/players/me', { token: saved.token })).body.avatar, 'clockwork');
  const sits = await call('POST', `/tables/${await newTable()}/join`, { body: {}, token: saved.token });
  assert.equal(sits.status, 201);
  assert.equal(sits.body.state.seats[0].avatar, 'clockwork', 'it follows them to a table');
  const asks = await call('POST', `/tables/${await newTable()}/join`, { body: { avatar: 'clockwork' }, token: saved.token });
  assert.equal(asks.status, 201, 'an agent still sending its own look isn\'t turned away');
  assert.equal(asks.body.state.seats[0].avatar, 'clockwork');
  assert.equal((await call('GET', '/players/me', { token: saved.token })).body.avatar, 'clockwork');

  // And they can leave it behind for good.
  assert.equal((await call('POST', '/players/me/avatar', { body: { avatar: 'halfhand' }, token: saved.token })).body.avatar, 'halfhand');
  assert.equal((await call('POST', '/players/me/avatar', { body: { avatar: 'clockwork' }, token: saved.token })).body.error, 'bad_avatar');
});

test('doorman: GET /hall gives an agent the same welcome and rules as a visitor', async () => {
  const hall = (await call('GET', '/hall')).body;
  assert.equal(hall.name, 'Tally', 'Tally keeps the door');
  assert.ok(hall.greeting.some((line) => line.includes("I'm Tally")));
  assert.ok(!JSON.stringify({ ...hall, games: null }).includes('Halfhand'), 'Halfhand is not house staff');
  assert.ok(hall.greeting.length >= 1);
  assert.deepEqual(hall.menu.map((m) => m.label), ['Take a seat', 'Just watching', 'How do I play?', 'Play with tNIGHT']);
  assert.deepEqual(hall.menu.map((m) => m.available), [true, true, true, false]);
  assert.ok(hall.rules.length >= 4 && hall.rules.length <= 7); // the last is the way upstairs
  assert.ok(hall.rules.some((r) => r.includes("When the lap's done")));
  assert.ok(!hall.rules.some((r) => /last call/i.test(r)));
  assert.ok(hall.games.some((g) => g.id === 'sealed-hand'));
});

test('identity: a player has one balance, buys in from it, and is paid back when the table ends', async () => {
  assert.equal((await call('POST', '/players', { body: { name: '<nope>' } })).status, 400);
  assert.equal((await call('GET', '/players/me')).status, 401);
  assert.equal((await call('GET', '/players/me', { token: 'junk' })).status, 401);
  assert.equal((await call('GET', '/players/me', { token: `${'a'.repeat(64)}.wrong` })).status, 401, 'never created');

  const created = await call('POST', '/players', { body: { name: 'Wanderer' } });
  assert.equal(created.status, 201);
  const { token, playerId } = created.body;
  assert.equal(created.body.chips, 1000);
  assert.equal((await call('GET', '/players/me', { token: `${playerId}.wrong` })).status, 401);

  const a = await newTable({ waitingIdleMs: 1500 });
  const seated = await call('POST', `/tables/${a}/join`, { body: { name: 'ignored', kind: 'human', buyIn: 100 }, token });
  assert.equal(seated.status, 201);
  assert.equal(seated.body.state.seats[0].name, 'Wanderer', 'the player name wins');
  assert.ok(!JSON.stringify(seated.body.state).includes(playerId), 'the player id stays private');

  let me = (await call('GET', '/players/me', { token })).body;
  assert.equal(me.chips, 900, 'buy-in left the balance');
  assert.deepEqual(me.inPlay.map((h) => h.amount), [100]);

  // Same player again gets their seat back with a new token, at no charge. The old token stops working.
  const again = await call('POST', `/tables/${a}/join`, { body: {}, token });
  assert.equal(again.status, 200);
  assert.equal(again.body.seat, 0);
  assert.equal((await call('GET', `/tables/${a}/me`, { token: seated.body.token })).status, 401);
  assert.equal((await call('GET', `/tables/${a}/me`, { token: again.body.token })).status, 200);
  assert.equal((await call('GET', '/players/me', { token })).body.chips, 900);

  // A refused join gives the buy-in straight back.
  const late = (await call('POST', '/players', { body: { name: 'Late' } })).body.token;
  assert.equal((await call('POST', `/tables/${a}/join`, { body: {}, token: late })).status, 409);
  assert.equal((await call('GET', '/players/me', { token: late })).body.chips, 1000);

  // Left untouched, the table closes (a short limit here), and the stack goes home.
  let view = (await call('GET', `/tables/${a}`)).body;
  for (let i = 0; i < 100 && view.phase !== 'over'; i++) { await sleep(200); view = (await call('GET', `/tables/${a}`)).body; }
  assert.equal(view.phase, 'over');
  const stack = view.seats[0].chips;
  for (let i = 0; i < 30; i++) {
    me = (await call('GET', '/players/me', { token })).body;
    if (me.inPlay.length === 0) break;
    await sleep(100);
  }
  assert.equal(me.inPlay.length, 0, 'no chips left on the table');
  assert.equal(me.chips, 900 + stack, 'balance + stack');
  assert.equal((await call('POST', `/tables/${a}/join`, { body: {}, token })).status, 409, 'a finished table takes no one');
  assert.equal((await call('GET', '/players/me', { token })).body.chips, 900 + stack, 'and that refusal costs nothing');
});

test('identity: one balance across tables, and not enough chips is refused', async () => {
  const { token } = (await call('POST', '/players', { body: { name: 'Spender' } })).body;
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', `/tables/${await newTable()}/join`, { body: { buyIn: 100 }, token });
    assert.equal(r.status, 201, `buy-in ${i}`);
  }
  assert.equal((await call('GET', '/players/me', { token })).body.chips, 0);
  const broke = await call('POST', `/tables/${await newTable()}/join`, { body: { buyIn: 100 }, token });
  assert.equal(broke.status, 409);
  assert.equal(broke.body.error, 'not_enough_chips');
  assert.equal((await call('POST', `/tables/${await newTable()}/join`, { body: {}, token: `${'a'.repeat(64)}.wrong` })).status, 401);
});

test('looks: a named avatar on /join, adventurer by default, and the old image address is refused', async () => {
  const hall = (await call('GET', '/hall')).body;
  assert.deepEqual(hall.avatars, ['dwarf', 'ranger', 'pirate', 'halfhand', 'mage', 'halfling', 'rogue', 'knight', 'adventurer']);
  assert.equal(hall.features.avatars, undefined);

  const id = await newTable();
  const named = await call('POST', `/tables/${id}/join`, { body: { name: 'Rusty', avatar: 'halfhand' } });
  assert.equal(named.status, 201);
  assert.equal(named.body.state.seats[0].avatar, 'halfhand');
  for (const seat of named.body.state.seats.slice(1)) assert.equal(seat.avatar, null, 'house bots have their own art');

  const plain = await call('POST', `/tables/${await newTable()}/join`, { body: { name: 'Plain' } });
  assert.equal(plain.body.state.seats[0].avatar, 'adventurer');

  for (const bad of ['https://example.com/me.png', 'wizard', 3, '', {}]) {
    const r = await call('POST', `/tables/${await newTable()}/join`, { body: { name: 'Nope', avatar: bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.error, 'bad_avatar');
    assert.match(r.body.message, /dwarf/);
  }
  const page = await fetch(BASE);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self';/);
});

test('looks: remembered per player, across tables, and changeable', async () => {
  const created = await call('POST', '/players', { body: { name: 'Picky', avatar: 'mage' } });
  assert.equal(created.body.avatar, 'mage');
  const { token } = created.body;
  assert.equal((await call('POST', '/players', { body: { name: 'Bad', avatar: 'wizard' } })).status, 400);

  const first = await call('POST', `/tables/${await newTable()}/join`, { body: {}, token });
  assert.equal(first.body.state.seats[0].avatar, 'mage', 'no need to say it again');

  const changed = await call('POST', '/players/me/avatar', { body: { avatar: 'rogue' }, token });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.avatar, 'rogue');
  assert.equal((await call('GET', '/players/me', { token })).body.avatar, 'rogue');
  assert.equal((await call('POST', '/players/me/avatar', { body: { avatar: 'nope' }, token })).status, 400);
  assert.equal((await call('POST', '/players/me/avatar', { body: { avatar: 'mage' } })).status, 401);
  assert.equal((await call('POST', `/tables/${await newTable()}/join`, { body: {}, token })).body.state.seats[0].avatar, 'rogue');

  const onJoin = await call('POST', `/tables/${await newTable()}/join`, { body: { avatar: 'knight' }, token });
  assert.equal(onJoin.body.state.seats[0].avatar, 'knight');
  assert.equal((await call('GET', '/players/me', { token })).body.avatar, 'knight', 'a look given on /join is remembered too');
  assert.equal((await call('POST', '/players', { body: { name: 'Default' } })).body.avatar, 'adventurer');
});

test('seats: agent tag, and the house name', async () => {
  const id = await newTable();
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { name: 'X', kind: 'robot' } })).status, 400);
  const r = await call('POST', `/tables/${id}/join`, { body: { name: 'Halfhand' } });
  assert.equal(r.status, 201, 'plain Halfhand is free for a real agent');
  const [me, house] = r.body.state.seats;
  assert.deepEqual([me.name, me.kind], ['Halfhand', 'agent'], 'no kind sent means agent');
  assert.deepEqual([house.name, house.kind], ['Tally · house', 'house']);
  assert.equal((await call('GET', '/hall')).body.name, 'Tally', 'a player called Halfhand is just a player');

  const other = await newTable();
  const human = await call('POST', `/tables/${other}/join`, { body: { name: 'Person', kind: 'human' } });
  assert.deepEqual([human.body.state.seats[0].kind, human.body.state.seats[0].avatar], ['human', 'adventurer']);
});

test('the claim menu needs no logic in the client: labels for every claim above the top', async () => {
  const id = await newTable({ turnMs: 60000 });
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { name: 'Menu' } })).body;
  let me;
  for (let i = 0; i < 30; i++) {
    me = (await call('GET', `/tables/${id}/me`, { token })).body;
    const has = (a) => me.legal.find((l) => l.action === a);
    if (has('claim')) break;
    const body = has('pass') ? { action: 'pass', card: has('pass').cards[0], ...(has('pass').match ? { match: true } : {}) } : has('stop') ? stopping(me) : has('match') ? { action: 'match' } : has('check') ? { action: 'check' } : null;
    if (!body) break;
    await call('POST', `/tables/${id}/act`, { body: answering(me, body), token });
  }
  const claim = me.legal.find((l) => l.action === 'claim');
  assert.ok(claim, 'the player reached the claim lap');
  assert.ok(claim.options.length > 0);
  assert.ok(claim.options.every((o) => Array.isArray(o.claim) && typeof o.label === 'string'));
});

/** Plays a table's seat with the plainest legal moves, until `done`. */
async function playSeat(id, token, done, limit = 60) {
  for (let i = 0; i < limit; i++) {
    if (await done()) return;
    const me = (await call('GET', `/tables/${id}/me`, { token })).body;
    const has = (a) => me.legal?.find((l) => l.action === a);
    const body = has('pass') ? { action: 'pass', card: has('pass').cards[0], ...(has('pass').match ? { match: true } : {}) } : has('match') ? { action: 'match' } : has('stop') ? stopping(me) : has('claim')?.truthful.length ? { action: 'claim', claim: has('claim').truthful[0].claim } : has('check') ? { action: 'check' } : has('fold') ? { action: 'fold' } : null;
    if (body) await call('POST', `/tables/${id}/act`, { body: answering(me, body), token });
    else await sleep(100);
  }
}

test('leave: between rounds pays the stack back at once, and the seat token stops working', async () => {
  const { token: player } = (await call('POST', '/players', { body: { name: 'Leaver' } })).body;
  const id = await newTable({ roundGapMs: 20_000 });
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { buyIn: 100 }, token: player })).body;
  assert.equal((await call('GET', '/players/me', { token: player })).body.chips, 900);
  const phase = async () => (await call('GET', `/tables/${id}`)).body.phase;
  await playSeat(id, token, async () => (await phase()) === 'settled');
  assert.equal(await phase(), 'settled');
  const stack = (await call('GET', `/tables/${id}`)).body.seats[0].chips;
  assert.equal((await call('GET', `/tables/${id}/me`, { token })).body.canLeave, true);

  const left = await call('POST', `/tables/${id}/leave`, { body: {}, token });
  assert.equal(left.status, 200);
  assert.deepEqual([left.body.queued, left.body.amount], [false, stack]);
  assert.equal(left.body.state.seats[0].left, true);
  assert.equal(left.body.state.seats[0].chips, 0);
  const me = (await call('GET', '/players/me', { token: player })).body;
  assert.equal(me.chips, 900 + stack, 'stack is back in the balance');
  assert.deepEqual(me.inPlay, []);
  assert.equal((await call('GET', `/tables/${id}/me`, { token })).status, 401);
  assert.equal((await call('POST', `/tables/${id}/leave`, { body: {}, token })).status, 401);
  assert.equal((await call('POST', `/tables/${id}/leave`, { body: {} })).status, 401, 'needs a token');
});

test('leave, solo table: during a round it plays itself out, pays out and closes, since nothing else would end it', async () => {
  const { token: player } = (await call('POST', '/players', { body: { name: 'Early' } })).body;
  const id = await newTable();
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { buyIn: 100 }, token: player })).body;
  const queued = await call('POST', `/tables/${id}/leave`, { body: {}, token });
  assert.equal(queued.body.queued, true);
  assert.equal(queued.body.state.phase, 'over', 'test bots move at once, so the round is already done');
  assert.deepEqual([queued.body.state.overCode, queued.body.state.overReason, queued.body.state.overRound], ['everyone_left', 'Everyone else left.', queued.body.state.round]);
  assert.equal(queued.body.state.seats[0].left, true);
  let me;
  for (let i = 0; i < 30; i++) {
    me = (await call('GET', '/players/me', { token: player })).body;
    if (me.inPlay.length === 0) break;
    await sleep(100);
  }
  assert.deepEqual(me.inPlay, []);
  assert.ok(me.chips >= 900, `balance ${me.chips}`);
});

test('leave, mixed table: during a round it waits for the round to end', async () => {
  const { id, path, keen } = await mixedTable({ turnMs: 400, roundGapMs: 20_000 });
  const queued = await call('POST', `${path}/leave`, { body: {}, token: keen });
  assert.equal(queued.body.queued, true);
  assert.equal(queued.body.state.seats[1].leaving, true);
  assert.notEqual(queued.body.state.phase, 'over');
  const phase = async () => (await call('GET', path)).body.phase;
  await playSeat(id, keen, async () => (await phase()) === 'settled', 200);
  const view = (await call('GET', path)).body;
  assert.equal(view.seats[1].left, true);
  assert.equal(view.seats[1].chips, 0, 'the stack went with them');
});

test('top-up: broke players get one, to 200, once', async () => {
  const rich = (await call('POST', '/players', { body: { name: 'Rich' } })).body;
  assert.equal(rich.topUp, false);
  assert.equal((await call('POST', '/players/me/topup', { body: {}, token: rich.token })).body.error, 'not_broke');
  assert.equal((await call('POST', '/players/me/topup', { body: {} })).status, 401);

  const broke = (await call('POST', '/players', { body: { name: 'Broke', testChips: 3 } })).body;
  assert.deepEqual([broke.chips, broke.topUp], [3, true]);
  const refused = await call('POST', `/tables/${await newTable()}/join`, { body: { buyIn: 100 }, token: broke.token });
  assert.equal(refused.body.error, 'not_enough_chips');
  const up = await call('POST', '/players/me/topup', { body: {}, token: broke.token });
  assert.equal(up.status, 200);
  assert.deepEqual([up.body.chips, up.body.topUp], [200, false]);
  const again = await call('POST', '/players/me/topup', { body: {}, token: broke.token });
  assert.equal(again.body.error, 'not_broke');
  assert.equal((await call('POST', `/tables/${await newTable()}/join`, { body: {}, token: broke.token })).status, 201, 'can sit down again');
});

test('say: per-seat limit', async () => {
  const id = await newTable();
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { name: 'Talker' } })).body;
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/tables/${id}/say`, { body: { text: `line ${i}` }, token })).status, 201);
  const sixth = await call('POST', `/tables/${id}/say`, { body: { text: 'one more' }, token });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'rate_limited');
});

/** Plays one round on a mock-AI table and returns what the table said and what the model was asked. */
async function roundWithAi(mode, extra = {}) {
  const id = await newTable({ aiMock: mode, aiTimeoutMs: 80, roundGapMs: 20_000, ...extra });
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { name: 'Listener' } })).body;
  const phase = async () => (await call('GET', `/tables/${id}`)).body.phase;
  // Several rounds of bot moves, so that talk (which is occasional) is sure to happen.
  await playSeat(id, token, async () => (await phase()) === 'settled');
  const view = (await call('GET', `/tables/${id}`)).body;
  const quick = (await call('GET', `/tables/${id}/quick`, { token })).body;
  const prompts = (await call('GET', `/tables/${id}/test-prompts`)).body.prompts;
  const me = (await call('GET', `/tables/${id}/me`, { token })).body;
  return { view, quick, prompts, me };
}

test('AI talk over HTTP (mocked): lines land in the log, and no card reaches a prompt', async () => {
  let talked = 0;
  const allPrompts = [];
  for (let i = 0; i < 6; i++) {
    const { view, quick, prompts, me } = await roundWithAi('ok', { rng: 100 + i });
    allPrompts.push(...prompts);
    assert.equal(quick.source, 'ai');
    assert.equal(quick.lines[0], 'Mock line one.');
    for (const line of view.log.filter((l) => l.say)) {
      assert.equal(line.text, 'Mock line one.', `${line.name}: ${line.text}`);
      talked += 1;
    }
    // My own hand is the one this test can see: it must not be in anything the model was told.
    for (const p of prompts) for (const card of me.hand) assert.ok(!`${p.system} ${p.user}`.includes(card), card);
  }
  assert.ok(talked > 0, 'a bot spoke');
  assert.ok(allPrompts.length > 1);
  for (const p of allPrompts) {
    const text = `${p.system} ${p.user}`;
    assert.ok(!/\b[2-9TJQKA][cdhs]\b/.test(text), text);
    assert.ok(!/\b(aces?|kings?|queens?|jacks?|pair|flush|proven|checked|caught|bluff\w*)\b/i.test(text), text);
  }
});

test('AI talk over HTTP (mocked): any failure falls back to scripted lines', async () => {
  for (const mode of ['error', 'slow', 'profane', 'cards']) {
    let talked = 0;
    for (let i = 0; i < 4; i++) {
      const { view, quick } = await roundWithAi(mode, { rng: 200 + i });
      assert.equal(quick.source, 'scripted', mode);
      for (const line of view.log.filter((l) => l.say)) {
        assert.ok(!line.ai, `${mode}: ${line.text}`);
        assert.ok(!/ace of spades|fuck|Too late/.test(line.text), line.text);
        talked += 1;
      }
    }
    assert.ok(talked > 0, `${mode}: a bot spoke`);
  }
});

test('no AI binding (local dev): scripted lines, and the test route is closed', async () => {
  const id = await newTable();
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { name: 'Plain' } })).body;
  assert.equal((await call('GET', `/tables/${id}/quick`, { token })).body.source, 'scripted');
  assert.equal((await call('GET', `/tables/${id}/quick`)).status, 401);
  assert.equal((await call('GET', `/tables/${id}/test-prompts`)).status, 404);
});

test('pages: the room and table are served with security headers', async () => {
  for (const path of ['/', '/table']) {
    const res = await fetch(BASE + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('pages: Cloudflare Web Analytics is allowed (script-src, connect-src), and nothing else in the Hall policy changed (11-10)', async () => {
  for (const path of ['/', '/table', '/dice']) {
    const csp = (await fetch(BASE + path)).headers.get('content-security-policy');
    const dir = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]));
    assert.equal(dir['script-src'], "'self' https://static.cloudflareinsights.com", path);
    assert.equal(dir['connect-src'], "'self' https://cloudflareinsights.com", path);
    assert.equal(dir['default-src'], "'none'");
    assert.equal(dir['style-src'], "'self' https://fonts.googleapis.com");
    assert.equal(dir['font-src'], 'https://fonts.gstatic.com');
    assert.equal(dir['img-src'], "'self'");
    assert.equal(dir['base-uri'], "'none'");
    assert.equal(dir['form-action'], "'none'");
    assert.equal(dir['frame-ancestors'], "'none'");
    assert.deepEqual(Object.keys(dir).filter((k) => !['default-src', 'script-src', 'style-src', 'font-src', 'img-src', 'media-src', 'connect-src', 'base-uri', 'form-action', 'frame-ancestors'].includes(k)), [], 'no new directive');
  }
});

test('the old address redirects home with a 301, through the real Worker', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path: '/table?id=abc', headers: { host: 'sealedhand.halfhand.dev' } }, (r) => {
      r.resume();
      resolve(r);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, 'https://halfhand.app/table?id=abc');
});

test('a plain server (no test flag) refuses repeatable shuffles and short clocks', { timeout: 90_000 }, async () => {
  const port = PORT + 1;
  await startServer(port);
  const post = (body) => fetch(`http://127.0.0.1:${port}/tables`, { method: 'POST', body: JSON.stringify(body) });
  const refused = await post({ test: { rng: 42 } });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, 'test_config_off');
  assert.equal((await post({ lobbySeconds: 0 })).status, 201);
  assert.equal((await post({ lobbySeconds: 'soon' })).status, 400);

  // No test flag also means the per-IP limits are on.
  const plain = `http://127.0.0.1:${port}`;
  const hit = (path, body) => fetch(plain + path, { method: 'POST', body: JSON.stringify(body) });
  const firstPlayer = await hit('/players', { name: 'Cap', testChips: 0 });
  assert.equal((await firstPlayer.json()).chips, 1000, 'test-only chips are ignored here');
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await hit('/players', { name: `Cap${i}` })).status);
  assert.deepEqual(statuses.slice(0, 4), [201, 201, 201, 201], 'five players a minute');
  assert.equal(statuses.at(-1), 429);
  const limited = await hit('/players', { name: 'Late' });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'rate_limited');
  assert.equal(limited.headers.get('retry-after'), '60');

  const open = (await (await post({ lobbySeconds: 60 })).json()).id;
  const tables = [];
  for (let i = 0; i < 12; i++) tables.push((await post({ lobbySeconds: 60 })).status);
  assert.ok(tables.includes(429), `tables: ${tables}`);

  // Join and say count every attempt, even refused ones, so guessing is limited too.
  const joins = [];
  for (let i = 0; i < 22; i++) joins.push((await hit(`/tables/${open}/join`, { name: '' })).status);
  assert.equal(joins[0], 400);
  assert.equal(joins.at(-1), 429, `join: ${joins}`);
  const says = [];
  for (let i = 0; i < 32; i++) says.push((await hit(`/tables/${open}/say`, { text: 'hi' })).status);
  assert.equal(says[0], 401);
  assert.equal(says.at(-1), 429, `say: ${says}`);

  // Each route has its own count, so being limited on one doesn't block the others.
  assert.equal((await fetch(`${plain}/games`)).status, 200);
});

test('pass window over HTTP: a raise goes with the pass, and the bots answer it', async () => {
  const id = await newTable();
  const { body: { token } } = await call('POST', `/tables/${id}/join`, { body: { name: 'Early Bird' } });
  const me = (await call('GET', `/tables/${id}/me`, { token })).body;
  assert.deepEqual(me.legal.map((a) => a.action), ['pass']);
  assert.deepEqual(me.legal[0].raise, { min: 1, max: 999 }, 'a play-chip raise can go up to the stack (1,000 less the ante of 1 here)');
  assert.equal((await call('POST', `/tables/${id}/act`, { body: { action: 'raise', n: 3 }, token })).body.error, 'wrong_phase', 'no standalone raise');
  const r = await call('POST', `/tables/${id}/act`, { body: { action: 'pass', card: me.legal[0].cards[0], raise: 3 }, token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state.raise, null, 'every bot has answered');
  assert.ok(r.body.state.log.some((l) => l.text === 'Early Bird passes and raises 3.'));
  assertClean(r.body.state, token);
  const help = (await call('GET', '/api')).body;
  assert.ok(!help.actions.some((a) => a.action === 'raise'), 'and it is gone from the help');
  assert.ok(help.actions.some((a) => a.action === 'pass' && a.raise));
  assert.ok(help.actions.some((a) => a.action === 'pass' && a.match));
  assert.match(help.phases.pass, /potLimit/);
});

test('stakes over HTTP: 5, 1,000 and 4,000 by default on play chips (a raise up to a stack, a pot of every seat all in); a table can set its own; bad ones and a tNIGHT pot too big for the cage are refused', async () => {
  const plain = (await call('POST', '/tables', { body: { lobbySeconds: 30, stakes: {} } })).body.state.limits;
  assert.deepEqual([plain.ante, plain.raiseLimit, plain.potLimit], [5, 1000, 4000]);
  const tier = (await call('POST', '/tables', { body: { lobbySeconds: 30, stakes: { ante: 2, raiseLimit: 10, potLimit: 100 } } })).body.state.limits;
  assert.deepEqual([tier.ante, tier.raiseLimit, tier.potLimit], [2, 10, 100]);
  for (const stakes of [{ ante: 0 }, { ante: 1.5 }, { potLimit: 9 }, { rake: 3 }, 'high', { ante: 400, potLimit: 500 }]) {
    assert.equal((await call('POST', '/tables', { body: { stakes } })).body.error, 'bad_stakes', JSON.stringify(stakes));
  }
});

test('next round over HTTP: on the legal list when a round is settled, and it deals', async () => {
  const id = await newTable({ roundGapMs: 25_000 });
  const { body: { token } } = await call('POST', `/tables/${id}/join`, { body: { name: 'Dealer' } });
  const phase = async () => (await call('GET', `/tables/${id}`)).body.phase;
  await playSeat(id, token, async () => (await phase()) === 'settled');
  assert.equal(await phase(), 'settled');
  const me = (await call('GET', `/tables/${id}/me`, { token })).body;
  assert.deepEqual(me.legal, [{ action: 'next' }]);
  const r = await call('POST', `/tables/${id}/act`, { body: { action: 'next' }, token });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.round, 2);
  assert.equal(r.body.state.phase, 'pass');
  assert.equal((await call('POST', `/tables/${id}/act`, { body: { action: 'next' }, token })).status, 409);
});

test('pacing over HTTP: bots wait, the clocks say until when, and the alarm moves them with no request from anyone', async () => {
  const id = await newTable({ botDelayMs: [400, 700] });
  const { body: { token, state } } = await call('POST', `/tables/${id}/join`, { body: { name: 'Patient' } });
  assert.equal(state.phase, 'pass');
  assert.deepEqual(state.waitingOn, [0, 1, 2, 3], 'nobody has moved');
  const start = state.now;
  for (const seat of [1, 2, 3]) {
    const { from, until } = state.clocks.find((k) => k.seat === seat);
    assert.ok(until - from >= 400 && until - from <= 700, `seat ${seat}: ${until - from} ms`);
    assert.ok(from >= start - 1000);
  }
  assert.equal(state.clocks.find((k) => k.seat === 0).until, null, 'one human: no clock');
  assertClean(state, token);

  await sleep(1100); // only the alarm can have moved them
  const view = (await call('GET', `/tables/${id}`)).body;
  assert.deepEqual(view.waitingOn, [0], 'each has chosen, in its own time');
  assert.deepEqual(view.clocks.map((k) => k.seat), [0]);
});

test('real defaults: a mixed table gives 60 s, and bots wait 1.5 to 3 s', async () => {
  const t = await call('POST', '/tables', { body: { lobbySeconds: 1 } });
  await call('POST', `/tables/${t.body.id}/join`, { body: { name: 'Regular' } });
  await call('POST', `/tables/${t.body.id}/join`, { body: { name: 'Other' } });
  let state = (await call('GET', `/tables/${t.body.id}`)).body;
  for (let i = 0; i < 30 && state.phase === 'lobby'; i++) {
    await sleep(100);
    state = (await call('GET', `/tables/${t.body.id}`)).body;
  }
  assert.equal(state.limits.turnMs, 60_000);
  assert.equal(state.deadline - state.clocks.find((k) => k.seat === 0).from, 60_000);
  for (const seat of [2, 3]) {
    const { from, until } = state.clocks.find((k) => k.seat === seat);
    assert.ok(until - from >= 1500 && until - from <= 3000, `seat ${seat}: ${until - from} ms`);
  }
});

// ---------- the purse, and finding your seat ----------

const purse = async (token) => (await call('GET', '/players/me', { token })).body;
const newPlayer = async (name, testChips) => (await call('POST', '/players', { body: { name, ...(testChips === undefined ? {} : { testChips }) } })).body.token;
const settle = async (id, token) => {
  const phase = async () => (await call('GET', `/tables/${id}`)).body.phase;
  await playSeat(id, token, async () => (await phase()) === 'settled');
  assert.equal(await phase(), 'settled');
};

test('buy-in: chosen from the purse, default 100, never more than the purse, and refusals cost nothing', async () => {
  const token = await newPlayer('Chooser');
  const id = await newTable({ botDelayMs: [20_000, 20_000] });
  const seated = await call('POST', `/tables/${id}/join`, { body: { buyIn: 250 }, token });
  assert.equal(seated.status, 201);
  assert.equal(seated.body.state.seats[0].chips, 249, '250 less the ante');
  assert.equal(seated.body.state.seats[1].chips, 999, 'house bots sit down with 1,000 too (less the ante)');
  assert.equal((await purse(token)).chips, 750);
  assert.deepEqual((await purse(token)).inPlay.map((h) => h.amount), [250]);

  for (const bad of [0, -5, 1.5, '100', null]) {
    const r = await call('POST', `/tables/${await newTable()}/join`, { body: { buyIn: bad }, token });
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.body.error, 'bad_buyin');
  }
  const over = await call('POST', `/tables/${await newTable()}/join`, { body: { buyIn: 751 }, token });
  assert.equal(over.body.error, 'not_enough_chips');
  assert.equal((await purse(token)).chips, 750);

  const all = await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { buyIn: 750 }, token });
  assert.equal(all.status, 201, 'the whole purse');
  assert.equal((await purse(token)).chips, 0);

  const plain = await newPlayer('Plain');
  assert.equal((await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: {}, token: plain })).body.state.seats[0].chips, 999, 'no buyIn means 1,000 (less the ante of 1 here)');
  const whole = await newPlayer('Whole Purse', 640);
  const seatedWhole = await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { kind: 'human' }, token: whole });
  assert.equal(seatedWhole.body.state.seats[0].chips, 999, 'a person with no buyIn sits down with 1,000: a purse of 640 is filled to it first');
  assert.equal((await purse(whole)).chips, 0, 'and all 1,000 went to the seat');
  const emptyJoin = await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { kind: 'human' }, token: await newPlayer('Empty', 0) });
  assert.equal(emptyJoin.body.state.seats[0].chips, 999, 'an empty purse is filled for the default buy-in: nobody sits down small');
  assert.equal((await call('POST', `/tables/${await newTable()}/join`, { body: { kind: 'human', buyIn: 50 }, token: await newPlayer('Empty named', 0) })).body.error, 'not_enough_chips', 'a named buy-in is never minted');
  const whale = await newPlayer('Whale', 5000);
  const whaleSeat = await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { kind: 'human' }, token: whale });
  assert.equal(whaleSeat.body.state.seats[0].chips, 999, 'a big purse still sits down with the 1,000 default');
  assert.equal((await purse(whale)).chips, 4000);
  const free = await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { name: 'Nobody', buyIn: 900 } });
  assert.equal(free.body.state.seats[0].chips, 999, 'with no purse behind it, a buyIn buys nothing: the table\'s own 1,000');
});

test('seats: the stack at each live table, for its owner only, gone once they leave', async () => {
  const token = await newPlayer('Seated');
  const other = await newPlayer('Other');
  assert.deepEqual((await call('GET', '/players/me/seats', { token })).body, { seats: [] });
  assert.equal((await call('GET', '/players/me/seats')).status, 401);
  assert.equal((await call('GET', '/players/me/seats', { token: `${'a'.repeat(64)}.wrong` })).status, 401);

  const id = await newTable({ roundGapMs: 20_000 });
  const { token: seatToken } = (await call('POST', `/tables/${id}/join`, { body: { buyIn: 209, kind: 'human' }, token })).body;
  await settle(id, seatToken);
  const stack = (await call('GET', `/tables/${id}`)).body.seats[0].chips;
  assert.notEqual(stack, 209, 'it has moved since the buy-in');
  const { seats } = (await call('GET', '/players/me/seats', { token })).body;
  assert.equal(seats.length, 1);
  assert.deepEqual([seats[0].tableId, seats[0].stack, seats[0].status, seats[0].seat, seats[0].page, seats[0].phase], [id, stack, 'seated', 0, '/table', 'settled']);
  assert.deepEqual((await call('GET', '/players/me/seats', { token: other })).body, { seats: [] });

  assert.equal((await call('GET', `/tables/${id}/seat`, { token })).body.status, 'seated');
  assert.equal((await call('GET', `/tables/${id}/seat`, { token: other })).body.status, 'none');
  assert.equal((await call('GET', `/tables/${id}/seat`)).status, 401);
  assert.equal((await call('POST', `/tables/${id}/seat-of`, { body: { playerId: 'x' } })).status, 404, 'the internal route isn\'t reachable');

  await call('POST', `/tables/${id}/leave`, { body: {}, token: seatToken });
  assert.deepEqual((await call('GET', '/players/me/seats', { token })).body, { seats: [] });
  const { n: leftN, ...leftSeat } = (await call('GET', `/tables/${id}/seat`, { token })).body;
  assert.ok(Number.isInteger(leftN), 'the table names its Hall number even after it closed');
  assert.deepEqual(leftSeat, { status: 'left', seat: 0, stack, stood: false });
});

test('recover: the player token gets the seat back from a table already running, at no charge', async () => {
  const token = await newPlayer('Lost Token');
  const id = await newTable({ botDelayMs: [20_000, 20_000] });
  const first = (await call('POST', `/tables/${id}/join`, { body: { buyIn: 209, kind: 'human' }, token })).body;
  assert.equal((await purse(token)).chips, 791);
  const again = await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 500 }, token });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.seat, again.body.rejoined, again.body.state.seats[0].chips], [0, true, 208]);
  assert.equal((await purse(token)).chips, 791, 'a buyIn on a seat you hold changes nothing');
  assert.equal((await call('GET', `/tables/${id}/me`, { token: first.token })).status, 401);
  assert.equal((await call('GET', `/tables/${id}/me`, { token: again.body.token })).status, 200);
});

test('one table at a time for a person: another seat is refused and costs nothing; agents may hold several', async () => {
  const token = await newPlayer('One Seat');
  const a = await newTable({ roundGapMs: 20_000 });
  const { token: seatToken } = (await call('POST', `/tables/${a}/join`, { body: { kind: 'human', buyIn: 100 }, token })).body;
  const b = await newTable();
  const refused = await call('POST', `/tables/${b}/join`, { body: { kind: 'human' }, token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'seated_elsewhere');
  assert.equal((await purse(token)).chips, 900);
  assert.equal((await purse(token)).inPlay.length, 1);
  assert.equal((await call('GET', `/tables/${b}`)).body.seats.length, 0, 'the other table never seated them');

  await settle(a, seatToken);
  await call('POST', `/tables/${a}/leave`, { body: {}, token: seatToken });
  assert.equal((await call('POST', `/tables/${b}/join`, { body: { kind: 'human' }, token })).status, 201, 'free once they\'ve left');

  const agent = await newPlayer('Busy Agent');
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', `/tables/${await newTable()}/join`, { body: { kind: 'agent' }, token: agent })).status, 201);
});

test('re-sit: the same table gives the same stack and seat back, and the purse pays exactly that', async () => {
  const token = await newPlayer('Round Tripper');
  const id = await newTable({ roundGapMs: 20_000 });
  const { token: seatToken } = (await call('POST', `/tables/${id}/join`, { body: { buyIn: 209, kind: 'human' }, token })).body;
  await settle(id, seatToken);
  const stack = (await call('GET', `/tables/${id}`)).body.seats[0].chips;
  const left = await call('POST', `/tables/${id}/leave`, { body: {}, token: seatToken });
  assert.deepEqual([left.body.queued, left.body.amount], [false, stack]);
  assert.equal(left.body.state.phase, 'over', 'the last one out closes it');
  assert.equal(left.body.state.seats[0].leftWith, stack);
  const inPurse = (await purse(token)).chips;
  assert.equal(inPurse, 791 + stack);

  const back = await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 7 }, token });
  assert.equal(back.status, 200);
  assert.deepEqual([back.body.seat, back.body.stack], [0, stack], 'the stack, whatever buyIn says');
  assert.equal(back.body.state.phase, 'settled', 'the table is open again');
  assert.equal(back.body.state.overReason, null);
  assert.deepEqual([back.body.state.seats[0].left, back.body.state.seats[0].chips, back.body.state.seats[0].leftWith], [false, stack, null]);
  assert.equal((await purse(token)).chips, inPurse - stack);
  assert.deepEqual((await purse(token)).inPlay.map((h) => h.amount), [stack]);
  assert.equal((await call('GET', `/tables/${id}/me`, { token: seatToken })).status, 401, 'the old seat token stays dead');

  const seats = (await call('GET', '/players/me/seats', { token })).body.seats;
  assert.deepEqual(seats.map((x) => x.stack), [stack]);
  const dealt = await call('POST', `/tables/${id}/act`, { body: { action: 'next' }, token: back.body.token });
  assert.equal(dealt.body.state.round, 2, 'and plays on');

  // Out again: the purse has it all back, once, however many round trips.
  await playSeat(id, back.body.token, async () => (await call('GET', `/tables/${id}`)).body.phase === 'settled');
  const end = (await call('GET', `/tables/${id}`)).body.seats[0].chips;
  await call('POST', `/tables/${id}/leave`, { body: {}, token: back.body.token });
  assert.equal((await purse(token)).chips, inPurse - stack + end);
  assert.deepEqual((await purse(token)).inPlay, []);
});

test('re-sit: only the player who left, only in time, only with what the purse still has', async () => {
  const token = await newPlayer('Time Limit');
  const expired = await newTable({ roundGapMs: 20_000, resitMs: 1 });
  const seated = (await call('POST', `/tables/${expired}/join`, { body: { kind: 'human' }, token })).body;
  await settle(expired, seated.token);
  await call('POST', `/tables/${expired}/leave`, { body: {}, token: seated.token });
  const before = (await purse(token)).chips;
  await sleep(30);
  assert.equal((await call('GET', `/tables/${expired}/seat`, { token })).body.status, 'none');
  assert.equal((await call('POST', `/tables/${expired}/join`, { body: { kind: 'human' }, token })).body.error, 'table_over');
  assert.equal((await purse(token)).chips, before);

  const owner = await newPlayer('Owner');
  const thief = await newPlayer('Thief');
  const id = await newTable({ roundGapMs: 20_000 });
  const mine = (await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: owner })).body;
  await settle(id, mine.token);
  const stack = (await call('GET', `/tables/${id}`)).body.seats[0].chips;
  await call('POST', `/tables/${id}/leave`, { body: {}, token: mine.token });
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: thief })).body.error, 'table_over');
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { name: 'Anonymous' } })).body.error, 'table_over');
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: `${(await purse(owner)).playerId}.wrong` })).status, 401, 'a wrong secret');
  assert.equal((await purse(thief)).chips, 1000);

  // Spend most of the purse at another table, as an agent, then come back: it restores what's left.
  const spent = (await purse(owner)).chips - 5;
  assert.equal((await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { kind: 'agent', buyIn: spent }, token: owner })).status, 201);
  const back = await call('POST', `/tables/${id}/join`, { body: { kind: 'agent' }, token: owner });
  assert.equal(back.status, 200);
  assert.equal(back.body.stack, Math.min(stack, 5));
  assert.equal((await purse(owner)).chips, 0);
});

test('re-sit at a table still running: back in the same seat, dealt in at the next round', async () => {
  const a = await newPlayer('Stays');
  const b = await newPlayer('Returns');
  const made = await call('POST', '/tables', { body: { lobbySeconds: 1, test: { rng: 8, roundGapMs: 20_000, turnMs: 20_000 } } });
  const { id } = made.body;
  const seatA = (await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: a })).body;
  const seatB = (await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: b })).body;
  const view = async () => (await call('GET', `/tables/${id}`)).body;
  for (let i = 0; i < 30 && (await view()).round === 0; i++) await sleep(100);
  await call('POST', `/tables/${id}/leave`, { body: {}, token: seatB.token });
  for (let i = 0; i < 120 && (await view()).phase !== 'settled'; i++) {
    for (const token of [seatA.token, seatB.token]) {
      const me = (await call('GET', `/tables/${id}/me`, { token })).body;
      const has = (x) => me.legal?.find((l) => l.action === x);
      const body = has('pass') ? { action: 'pass', card: has('pass').cards[0], ...(has('pass').match ? { match: true } : {}) } : has('match') ? { action: 'match' } : has('check') ? { action: 'check' } : has('fold') ? { action: 'fold' } : null;
      if (body) await call('POST', `/tables/${id}/act`, { body: answering(me, body), token });
    }
    await sleep(30);
  }
  const settled = await view();
  assert.equal(settled.phase, 'settled');
  assert.equal(settled.seats[1].left, true);
  const stack = settled.seats[1].leftWith;
  const back = await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: b });
  assert.equal(back.status, 200);
  assert.deepEqual([back.body.seat, back.body.stack], [1, stack]);
  assert.equal(back.body.state.seats[1].left, false);
  const dealt = await call('POST', `/tables/${id}/act`, { body: { action: 'next' }, token: seatA.token });
  assert.equal(dealt.body.state.round, 2);
  assert.equal(dealt.body.state.seats[1].status, 'in');
  assert.equal(dealt.body.state.seats[1].chips, stack - 1, 'anted from the stack they brought back');
});

test('the old address: /recover stays there, everything else still goes home', async () => {
  const fetchOld = (path) => new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, headers: { host: 'sealedhand.halfhand.dev' } }, (r) => { r.resume(); resolve(r); });
    req.end();
  });
  for (const path of ['/recover', '/js/recover.js']) assert.equal((await fetchOld(path)).statusCode, 200, path);
  for (const path of ['/', '/recover/x', '/js/room.js', '/players/me', '/table?id=abc']) {
    const res = await fetchOld(path);
    assert.equal(res.statusCode, 301, path);
    assert.equal(res.headers.location, `https://halfhand.app${path}`);
  }
});

// ---------- the purse model ----------

test('the purse: one read of it, with where it lives, and only for its owner', async () => {
  const token = await newPlayer('Reader', 640);
  const me = await purse(token);
  assert.deepEqual(me.purse, { amount: 640, source: 'house', readOnly: false, owner: { kind: 'player', id: me.playerId } });
  assert.equal(me.chips, 640, 'the older field stays for anything already reading it');
  assert.equal((await call('GET', '/players/me')).status, 401);
});

test('add chips: from purse to stack between rounds, refused mid-round, and every chip accounted for when they leave', async () => {
  const token = await newPlayer('Topper', 500);
  const id = await newTable({ roundGapMs: 20_000 });
  const seat = (await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 100 }, token })).body;
  const add = (amount, t = seat.token) => call('POST', `/tables/${id}/add-chips`, { body: { amount }, token: t });

  assert.equal((await call('GET', `/tables/${id}/me`, { token: seat.token })).body.canAddChips, false);
  const midRound = await add(50);
  assert.equal(midRound.status, 409);
  assert.equal(midRound.body.error, 'not_between_rounds');
  assert.equal((await purse(token)).chips, 400, 'a refusal costs nothing');

  await settle(id, seat.token);
  assert.equal((await call('GET', `/tables/${id}/me`, { token: seat.token })).body.canAddChips, true);
  const stack = (await call('GET', `/tables/${id}`)).body.seats[0].chips;

  for (const bad of [0, -5, 1.5, '50', null]) assert.equal((await add(bad)).body.error, 'bad_amount', String(bad));
  assert.equal((await add(401)).body.error, 'not_enough_chips');
  assert.equal((await call('POST', `/tables/${id}/add-chips`, { body: { amount: 10 } })).status, 401);
  assert.equal((await purse(token)).chips, 400);
  assert.equal((await call('GET', `/tables/${id}`)).body.seats[0].chips, stack);

  const added = await add(150);
  assert.equal(added.status, 200);
  assert.deepEqual([added.body.stack, added.body.purse.amount, added.body.state.seats[0].chips], [stack + 150, 250, stack + 150]);
  assert.deepEqual((await purse(token)).inPlay.map((h) => h.amount), [250]);
  assert.ok(added.body.state.log.some((l) => l.text === 'Topper adds 150 chips.'));
  assert.equal((await add(250)).body.purse.amount, 0, 'up to the whole purse');
  assert.equal((await add(1)).body.error, 'not_enough_chips');

  const left = await call('POST', `/tables/${id}/leave`, { body: {}, token: seat.token });
  assert.equal(left.body.amount, stack + 400);
  assert.equal((await purse(token)).chips, stack + 400, 'everything came back');
  assert.deepEqual((await purse(token)).inPlay, []);
  assert.equal((await add(1)).status, 401, 'no seat, no adding');
});

test('add chips: a seat on table chips alone has no purse to add from', async () => {
  const id = await newTable({ roundGapMs: 20_000 });
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { name: 'No Purse' } })).body;
  await settle(id, token);
  assert.equal((await call('POST', `/tables/${id}/add-chips`, { body: { amount: 5 }, token })).body.error, 'no_purse');
});

test('fill up: the purse back to 1,000 any time (chips at a table don\'t matter), unlimited, never lowered; the older top-up still works', async () => {
  const full = (await call('POST', '/players', { body: { name: 'Full Purse' } })).body;
  assert.equal(full.fillUp, false);
  const same = await call('POST', '/players/me/fill-up', { body: {}, token: full.token });
  assert.equal(same.status, 200);
  assert.deepEqual([same.body.added, same.body.chips], [0, 1000], 'idempotent at 1,000');
  assert.equal((await call('POST', '/players/me/fill-up', { body: {} })).status, 401);
  assert.equal((await call('GET', '/players/me/fill-up', { token: full.token })).status, 405);

  const broke = (await call('POST', '/players', { body: { name: 'Fill Me', testChips: 3 } })).body;
  assert.deepEqual([broke.fillUp, broke.topUp], [true, true]);
  const up = await call('POST', '/players/me/fill-up', { body: {}, token: broke.token });
  assert.deepEqual([up.body.added, up.body.chips, up.body.purse.amount, up.body.fillUp], [997, 1000, 1000, false]);
  // With chips at a table: the purse alone is filled, the stack is left as it is.
  const id = await newTable({ roundGapMs: 20_000 });
  const seat = (await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 700 }, token: broke.token })).body;
  assert.equal((await purse(broke.token)).chips, 300);
  const again = await call('POST', '/players/me/fill-up', { body: {}, token: broke.token });
  assert.deepEqual([again.body.added, again.body.chips, again.body.inPlay.length], [700, 1000, 1], 'any time, even seated');
  assert.equal((await call('GET', `/tables/${id}`)).body.seats[0].chips, 699);
  assert.equal((await call('POST', `/tables/${id}/leave`, { body: {}, token: seat.token })).status, 200);
  // A purse over 1,000 is never lowered.
  const rich = (await call('POST', '/players', { body: { name: 'Rich Purse', testChips: 4000 } })).body;
  assert.deepEqual([(await call('POST', '/players/me/fill-up', { body: {}, token: rich.token })).body.chips], [4000]);
});

test('fill up at a table: the stack back to 1,000 between rounds, from a purse short of it or not; refused mid-round; a purse-less seat gets the chips too', async () => {
  const token = await newPlayer('Filler', 150);
  const id = await newTable({ roundGapMs: 20_000 });
  const seat = (await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 100 }, token })).body;
  const fill = (t = seat.token) => call('POST', `/tables/${id}/fill-up`, { body: {}, token: t });
  assert.equal((await call('GET', `/tables/${id}/me`, { token: seat.token })).body.canFillUp, false, 'mid-round');
  const mid = await fill();
  assert.equal(mid.status, 409);
  assert.equal(mid.body.error, 'not_between_rounds');
  assert.equal((await purse(token)).chips, 50, 'a refusal costs nothing');
  assert.equal((await fill('f'.repeat(64))).status, 401);

  await settle(id, seat.token);
  const stack = (await call('GET', `/tables/${id}`)).body.seats[0].chips;
  const me = (await call('GET', `/tables/${id}/me`, { token: seat.token })).body;
  assert.deepEqual([me.canFillUp, me.broke], [true, false]);
  const filled = await fill();
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.deepEqual([filled.body.added, filled.body.stack, filled.body.state.seats[0].chips], [1000 - stack, 1000, 1000]);
  assert.equal(filled.body.purse.amount, 0, 'the 50 in the purse went first; the rest of the shortfall was added');
  assert.ok(filled.body.state.log.some((l) => l.text === `Filler adds ${1000 - stack} chips.`));
  const twice = await fill();
  assert.deepEqual([twice.status, twice.body.added, twice.body.stack], [200, 0, 1000], 'idempotent at 1,000');
  const left = await call('POST', `/tables/${id}/leave`, { body: {}, token: seat.token });
  assert.equal(left.body.amount, 1000);
  assert.equal((await purse(token)).chips, 1000);

  const none = await newTable({ roundGapMs: 20_000 });
  const guest = (await call('POST', `/tables/${none}/join`, { body: { name: 'No Purse' } })).body;
  await settle(none, guest.token);
  const gstack = (await call('GET', `/tables/${none}`)).body.seats[0].chips;
  const gfill = await call('POST', `/tables/${none}/fill-up`, { body: {}, token: guest.token });
  assert.deepEqual([gfill.status, gfill.body.added, gfill.body.stack, gfill.body.purse], [200, Math.max(0, 1000 - gstack), Math.max(1000, gstack), null]);
});

test('default buy-in: 1,000 for a person and an agent alike, a purse below it filled first; a refused seat gives the minted chips back', async () => {
  for (const kind of ['human', 'agent']) {
    const short = await newPlayer(`Short ${kind}`, 300);
    const seat = await call('POST', `/tables/${await newTable({ botDelayMs: [20_000, 20_000] })}/join`, { body: { kind }, token: short });
    assert.equal(seat.body.state.seats[0].chips, 999, `${kind}: 1,000 less the ante of 1`);
    assert.equal((await purse(short)).chips, 0);
  }
  const clock = await newPlayer('Refused', 300);
  const refused = await call('POST', `/tables/${await newTable()}/join`, { body: { kind: 'human', avatar: 'clockwork' }, token: clock });
  assert.equal(refused.body.error, 'bad_avatar');
  assert.equal((await purse(clock)).chips, 300, 'the fill-up that was made for the seat went back with it');
  const view = (await call('GET', `/tables/${await newTable()}`)).body;
  assert.equal(view.buyIn, 1000, 'the table says what a seat sits down with');
});

test('GET /closures: a table that closes is recorded with its number, round, code and words, newest first; the open API lists the route', async () => {
  const id = await newTable({ roundGapMs: 20_000 });
  const { token } = (await call('POST', `/tables/${id}/join`, { body: { name: 'Closer', kind: 'human' } })).body;
  await settle(id, token);
  const round = (await call('GET', `/tables/${id}`)).body.round;
  assert.equal((await call('POST', `/tables/${id}/leave`, { body: {}, token })).status, 200);
  const over = (await call('GET', `/tables/${id}`)).body;
  assert.deepEqual([over.phase, over.overCode, over.overReason, over.overRound], ['over', 'everyone_left', 'Everyone else left.', round]);
  let mine;
  for (let i = 0; i < 40 && !mine; i++) {
    await sleep(100);
    mine = (await call('GET', '/closures?game=sealed-hand&limit=50')).body.closures?.find((e) => e.id === id);
  }
  assert.ok(mine, 'the Directory logged the close');
  assert.deepEqual([mine.game, mine.round, mine.code, mine.text, mine.humans], ['sealed-hand', round, 'everyone_left', 'Everyone else left.', ['Closer']]);
  assert.ok(Number.isInteger(mine.n), 'the table\'s number');
  assert.equal(mine.stacks[0].name, 'Closer');
  assert.ok(Number.isInteger(mine.at));
  const all = (await call('GET', '/closures')).body.closures;
  assert.ok(all.every((e, i) => i === 0 || all[i - 1].at >= e.at), 'newest first');
  assert.equal((await call('GET', '/closures?limit=0')).status, 400);
  assert.equal((await call('GET', '/closures?game=nope')).status, 400);
  assert.equal((await call('POST', '/closures', { body: {} })).status, 404);
  assert.ok(Object.keys((await call('GET', '/api')).body.routes ?? (await call('GET', '/api')).body).some((k) => k === 'GET /closures') || JSON.stringify((await call('GET', '/api')).body).includes('GET /closures'));
});

test('away too long: a table with other people stands the seat up and pays the purse; they can sit back down', async () => {
  const gone = await newPlayer('Gone Away', 500);
  const here = await newPlayer('Still Here', 500);
  const { id } = (await call('POST', '/tables', { body: { lobbySeconds: 1, test: { rng: 8, turnMs: 300, awayStandMs: 700, roundGapMs: 60_000 } } })).body;
  await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 200 }, token: gone });
  await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 200 }, token: here });
  const view = async () => (await call('GET', `/tables/${id}`)).body;
  let state = await view();
  for (let i = 0; i < 100 && !state.seats[0]?.left; i++) { await sleep(150); state = await view(); }
  assert.equal(state.seats[0].left, true, 'stood up');
  assert.ok(state.log.some((l) => l.text === 'Gone Away has been away too long and stands up.'));
  const stack = state.seats[0].leftWith;
  assert.equal((await purse(gone)).chips, 300 + stack, 'every chip of the stack is back');
  assert.deepEqual((await purse(gone)).inPlay, []);
  const { n: stoodN, ...stoodSeat } = (await call('GET', `/tables/${id}/seat`, { token: gone })).body;
  assert.ok(Number.isInteger(stoodN));
  assert.deepEqual(stoodSeat, { status: 'left', seat: 0, stack, stood: true });
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { kind: 'human' }, token: gone })).body.stack, 300 + stack, 'one stack: the whole purse');
});

test('solo table, untouched: after awayStandMs the one seat stands up by the table\'s own alarm, and the stack goes back to the purse (The owner, 11-07)', async () => {
  const token = await newPlayer('Solo Away', 500);
  const id = await newTable({ turnMs: 200, awayStandMs: 300, roundGapMs: 200 });
  await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 200 }, token });
  let state = null;
  for (let i = 0; i < 40; i++) { // the alarm fires at 300 ms; the round it had dealt plays itself out for the leaver
    await sleep(300);
    state = (await call('GET', `/tables/${id}`)).body;
    if (state.seats[0].left) break;
  }
  assert.equal(state.seats[0].left, true, 'stood up with nobody touching the table');
  assert.equal(state.phase, 'over');
  assert.ok(state.log.some((l) => /Solo Away has been away too long and stands up/.test(l.text)), 'says why');
  const chips = (await purse(token)).chips;
  assert.ok(chips >= 300 + 150 && chips <= 500, `the stack is back in the purse, less the round it had to play out: ${chips}`);
});

// ---------- raising in the claim lap ----------

/** Four agents, no bots, and all five passes go round, so the lap opens empty on the starter, seat 0. Nothing here depends on the deal. */
async function fourAgentsInTheLap(rng) {
  const { id } = (await call('POST', '/tables', { body: { lobbySeconds: 60, test: { rng } } })).body;
  const path = `/tables/${id}`;
  const tokens = [];
  for (const name of ['One', 'Two', 'Three', 'Four']) tokens.push((await call('POST', `${path}/join`, { body: { name } })).body.token);
  const me = async (seat) => (await call('GET', `${path}/me`, { token: tokens[seat] })).body;
  const act = (seat, body) => call('POST', `${path}/act`, { body, token: tokens[seat] });
  for (let window = 0; window < 5; window++) {
    for (let seat = 0; seat < 4; seat++) await act(seat, { action: 'pass', card: (await me(seat)).hand[0] });
  }
  return { path, tokens, me, act };
}

test('stop and claim: one move for an agent, from /api and /me through to an all-fold win with the claim on it', async () => {
  const help = (await call('GET', '/api')).body;
  assert.match(help.phases.pass, /Stopping the passing is a claim/);
  assert.ok(help.actions.some((a) => a.action === 'stop' && a.claim && a.raise));
  assert.ok(!help.actions.some((a) => a.action === 'stop' && !a.claim), 'no bare stop');

  const { id } = (await call('POST', '/tables', { body: { lobbySeconds: 60, test: { rng: 7 } } })).body;
  const path = `/tables/${id}`;
  const tokens = [];
  for (const name of ['One', 'Two', 'Three', 'Four']) tokens.push((await call('POST', `${path}/join`, { body: { name } })).body.token);
  const me = async (seat) => (await call('GET', `${path}/me`, { token: tokens[seat] })).body;
  const act = (seat, body) => call('POST', `${path}/act`, { body, token: tokens[seat] });
  for (let window = 0; window < 2; window++) {
    for (let seat = 0; seat < 4; seat++) await act(seat, { action: 'pass', card: (await me(seat)).hand[0] });
  }

  const mine = await me(1);
  const stop = mine.legal.find((l) => l.action === 'stop');
  assert.deepEqual(stop.raise, { min: 1, max: 999 });
  assert.ok(stop.options.length > 50 && Array.isArray(stop.truthful));
  assert.ok('beats' in mine.bestTrue);

  const bare = await act(1, { action: 'stop' });
  assert.deepEqual([bare.status, bare.body.error], [400, 'bad_claim']);
  assert.equal((await act(1, { action: 'stop', claim: [7, 14], raise: 1000 })).body.error, 'bad_raise');
  const done = await act(1, { action: 'stop', claim: [7, 14], raise: 10 });
  assert.equal(done.status, 200);

  const next = await me(2);
  assert.deepEqual(next.facing, { high: 10, by: 1, owed: 10, paid: 0 });
  assert.deepEqual(next.legal.map((l) => l.action), ['claim', 'call', 'check', 'fold']);
  assert.equal((await act(2, { action: 'check' })).body.error, 'must_answer');
  for (const seat of [2, 3, 0]) assert.equal((await act(seat, { action: 'fold' })).status, 200);

  const after = (await call('GET', path)).body;
  assert.equal(after.phase, 'settled');
  assert.equal(after.lastResult.kind, 'uncontested');
  assert.deepEqual(after.lastResult.awards[0].claim, [7, 14, 0]);
  assert.equal(after.lastResult.awards[0].seat, 1);
  assert.equal(after.claims[0].status, 'standing');
  assert.deepEqual(after.seats[1].rep, { called: 0, proven: 0, caught: 0 });
  assert.equal(after.lapRaise, null);
});

test('after-lap call: an agent sees it in /api and /me, and can catch the last seat\'s raised claim', async () => {
  assert.match((await call('GET', '/api')).body.phases.answer, /call an uncalled claim/);
  const { me, act, path } = await fourAgentsInTheLap(9);
  for (const seat of [0, 1, 2]) assert.equal((await act(seat, { action: 'check' })).status, 200);
  assert.equal((await act(3, { action: 'claim', claim: [7, 14], raise: 12 })).status, 200);
  const mine = await me(0);
  assert.deepEqual(mine.legal.map((l) => l.action), ['match', 'call', 'fold']);
  assert.deepEqual(mine.legal[1], { action: 'call', seats: [3], match: { cost: 12, level: 12 }, fold: true });
  assert.equal((await act(0, { action: 'call', seat: 3 })).body.error, 'must_answer');
  assert.equal((await act(0, { action: 'call', seat: 3, raise: 20 })).body.error, 'bad_stake');
  assert.equal((await act(0, { action: 'call', seat: 3, match: true })).status, 200);
  const view = (await call('GET', path)).body;
  assert.ok(['caught', 'proven'].includes(view.claims[0].status));
});

test('the name Clockwork: refused to new players, however it is written, and kept by a purse that has it', async () => {
  for (const name of ['Clockwork', 'clockwork', 'CLOCKWORK', ' Clock Work ', 'Clock-work', 'clock_work.']) {
    const r = await call('POST', '/players', { body: { name } });
    assert.deepEqual([r.status, r.body.error], [409, 'name_reserved'], name);
    const seat = await call('POST', `/tables/${await newTable()}/join`, { body: { name } });
    assert.deepEqual([seat.status, seat.body.error], [409, 'name_reserved'], `${name}, at a table`);
  }
  for (const name of ['Clockworker', 'Clocks', 'Work']) assert.equal((await call('POST', '/players', { body: { name, testChips: 10 } })).status, 201, name);

  const saved = (await call('POST', '/players', { body: { name: 'Clockwork', testChips: 300, testSaved: true } })).body;
  assert.equal(saved.name, 'Clockwork');
  assert.equal((await call('GET', '/players/me', { token: saved.token })).body.name, 'Clockwork');
  const sits = await call('POST', `/tables/${await newTable()}/join`, { body: {}, token: saved.token });
  assert.equal(sits.status, 201, 'an old purse still sits down');
  assert.equal(sits.body.state.seats[0].name, 'Clockwork');
  assert.equal((await call('GET', '/hall')).body.name, 'Tally', 'the door is Tally\'s; an old Clockwork purse is just a player');
});

test('lap raise: an agent sees the new moves in /api and /me, and the server holds it to them', async () => {
  const help = (await call('GET', '/api')).body;
  assert.equal(help.phases.lastcall, undefined, 'last call is gone');
  assert.match(help.phases.claim, /raise: n/);
  assert.match(help.phases.claim, /match: true or fold: true/);
  assert.match(help.phases.answer, /match pays the difference/);
  assert.ok(help.actions.some((a) => a.action === 'check' && a.raise));
  assert.ok(help.actions.some((a) => a.action === 'claim' && a.match));
  assert.ok(help.actions.some((a) => a.action === 'call' && a.fold));
  assert.match(help.routes['GET /tables/:id/me'], /facing/);

  const { path, me, act } = await fourAgentsInTheLap(101);
  const first = await me(0);
  assert.equal(first.facing, null);
  assert.deepEqual(first.legal.find((l) => l.action === 'check'), { action: 'check', raise: { min: 1, max: 999 } });
  assert.deepEqual(first.legal.find((l) => l.action === 'claim').raise, { min: 1, max: 999 });
  assert.equal((await act(0, { action: 'check', raise: 1000 })).status, 400);
  assert.equal((await act(0, { action: 'check', match: true })).body.error, 'no_raise_to_answer');

  const claimed = await act(0, { action: 'claim', claim: [1, 2], raise: 12 });
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.body.state.lapRaise, { high: 12, by: 0, paid: { 0: 12 }, waiting: [1, 2, 3], stopper: null });

  const second = await me(1);
  assert.deepEqual(second.facing, { high: 12, by: 0, owed: 12, paid: 0 });
  assert.deepEqual(second.legal.map((l) => l.action).sort(), ['call', 'check', 'claim', 'fold']);
  assert.deepEqual(second.legal.find((l) => l.action === 'check').match, { cost: 12, level: 12 });
  assert.equal(second.legal.find((l) => l.action === 'call').fold, true);
  const refused = await act(1, { action: 'check' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'must_answer');
  assert.match(refused.body.message, /match: true or fold: true/);
  assert.equal((await act(1, { action: 'check', raise: 12 })).status, 400, 'above the highest');
  assert.equal((await act(1, { action: 'raise', n: 14 })).body.error, 'wrong_phase');
  const matched = await act(1, { action: 'check', match: true });
  assert.equal(matched.status, 200);
  assert.deepEqual(matched.body.state.lapRaise.paid, { 0: 12, 1: 12 });

  assert.equal((await act(2, { action: 'fold' })).status, 200);
  assert.equal((await act(3, { action: 'check', raise: 20 })).status, 200);

  const view = (await call('GET', path)).body;
  assert.equal(view.phase, 'answer');
  assert.equal(view.turn, 0);
  assert.deepEqual(view.lapRaise, { high: 20, by: 3, paid: { 0: 12, 1: 12, 3: 20 }, waiting: [0, 1], stopper: null });
  assert.equal('lastCall' in view, false);
  assert.equal('facing' in view, false, 'what a seat owes is its own');
  const owing = await me(0);
  assert.deepEqual(owing.legal, [{ action: 'match', cost: 8, level: 20 }, { action: 'fold' }]);
  assert.deepEqual(owing.facing, { high: 20, by: 3, owed: 8, paid: 12 });
  for (const body of [{ action: 'claim', claim: [8] }, { action: 'call', seat: 3 }, { action: 'check' }, { action: 'raise', n: 25 }]) {
    assert.equal((await act(0, body)).status, 409, body.action);
  }
  const hands = JSON.stringify(view);
  for (const card of owing.hand) assert.ok(!hands.includes(`"${card}"`), 'no hand in the public state');
  assert.equal((await act(0, { action: 'match' })).status, 200);
  const folded = await act(1, { action: 'fold' });
  assert.equal(folded.status, 200);
  assert.equal(folded.body.state.phase, 'settled');
  assert.equal(folded.body.state.lapRaise, null);
});

test('lap raise: call and fold costs an agent the stake and no more, and a raised bluff can be caught', async () => {
  const { path, act, me } = await fourAgentsInTheLap(202);
  assert.equal((await act(0, { action: 'claim', claim: [8], raise: 25 })).status, 200); // a straight flush nobody here holds, near enough always
  const before = (await call('GET', path)).body;
  const chips = before.seats[1].chips;
  const pot = before.pot;
  const called = await act(1, { action: 'call', seat: 0, fold: true });
  assert.equal(called.status, 200);
  const { state } = called.body;
  assert.equal(state.pot, pot, 'nothing more into the pot');
  assert.equal(state.seats[1].status, 'folded');
  assert.equal(Math.abs(state.seats[1].chips - chips), 5, 'only the sting moved');
  assert.deepEqual((await me(1)).legal, []);
});


test('link preview: the Hall says what is open, on play chips, in the page itself; the Hall and games lists say whether the cage page is on', async () => {
  const html = (await (await fetch(BASE + '/')).text()).replaceAll('&amp;', '&'); // the rewriter writes a bare &, the file an entity: same text
  const want = 'A night-time inn of games for people and agents. Sealed Hand and Cup & Claim are open, on play chips.';
  assert.ok(html.includes(`<meta name="description" content="${want}"`), 'description');
  assert.ok(html.includes(`<meta property="og:description" content="${want}"`), 'og:description');
  assert.ok(!/tnight|preprod/i.test(html.match(/<meta[^>]*description[^>]*>/g).join('')), 'nothing about tNIGHT where it is off');
  assert.equal((await call('GET', '/hall')).body.features.wallet, false);
  assert.equal((await call('GET', '/games')).body.features.wallet, false);
});

test('link preview image: every public page names /og.jpg (1200x630) with the card tags, and /og.jpg is a long-cached JPEG', async () => {
  // The page files name halfhand.app; served from any other origin (this test server, staging) the card's own URLs follow that origin (withSocialOrigin).
  for (const [path, url] of [['/', `${BASE}/`], ['/leaderboard', `${BASE}/leaderboard`], ['/records', `${BASE}/records`]]) {
    const html = await (await fetch(BASE + path)).text();
    for (const tag of [
      '<meta property="og:title" content="', '<meta property="og:description" content="', '<meta property="og:type" content="website">', '<meta property="og:site_name" content="halfhand.app">',
      `<meta property="og:url" content="${url}">`, `<meta property="og:image" content="${BASE}/og.jpg?v=3">`, '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">', '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:image" content="${BASE}/og.jpg?v=3">`,
      '<meta name="theme-color" content="#c98a2e">',
    ]) assert.ok(html.includes(tag), `${path}: ${tag}`);
  }
  const img = await fetch(BASE + '/og.jpg');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /max-age=31536000/);
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert.ok(bytes.length > 100_000 && bytes.length < 300_000, `size ${bytes.length}`);
  assert.deepEqual([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff], 'JPEG signature');
  let i = 2, size = null; // walk the JPEG segments to the frame header: height then width, big-endian
  while (i < bytes.length && !size) {
    const marker = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xc2) size = { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    i += 2 + len;
  }
  assert.deepEqual(size, { w: 1200, h: 630 });
});

test('one stack: sitting back down brings a person\u2019s whole purse; a named amount is never less than they left with; an agent gets its stack', async () => {
  for (const base of ['/tables', '/dice-tables']) {
    const open = async () => (await call('POST', base, { body: { lobbySeconds: 300 } })).body.id;
    const sitLeave = async (id, token, buyIn) => {
      const seat = (await call('POST', `${base}/${id}/join`, { body: { kind: 'human', buyIn }, token })).body;
      await call('POST', `${base}/${id}/leave`, { body: {}, token: seat.token });
    };
    const whole = await newPlayer('One Stack');
    const a = await open();
    await sitLeave(a, whole, 100);
    const back = await call('POST', `${base}/${a}/join`, { body: { kind: 'human' }, token: whole });
    assert.equal(back.body.stack, 1000, `${base}: the whole purse`);
    assert.equal((await purse(whole)).chips, 0);

    const named = await newPlayer('Named Amount');
    const b = await open();
    await sitLeave(b, named, 100);
    assert.equal((await call('POST', `${base}/${b}/join`, { body: { kind: 'human', buyIn: 300 }, token: named })).body.stack, 300, `${base}: what they asked for`);
    assert.equal((await purse(named)).chips, 700);

    const low = await newPlayer('Low Amount');
    const c = await open();
    await sitLeave(c, low, 100);
    assert.equal((await call('POST', `${base}/${c}/join`, { body: { kind: 'human', buyIn: 10 }, token: low })).body.stack, 100, `${base}: not less than they walked away with`);

    const agent = await newPlayer('Agent Stack');
    const d = await open();
    const seat = (await call('POST', `${base}/${d}/join`, { body: { kind: 'agent', buyIn: 100 }, token: agent })).body;
    await call('POST', `${base}/${d}/leave`, { body: {}, token: seat.token });
    assert.equal((await call('POST', `${base}/${d}/join`, { body: { kind: 'agent' }, token: agent })).body.stack, 100, `${base}: an agent keeps its own stack`);
    assert.equal((await purse(agent)).chips, 900);
  }
});
