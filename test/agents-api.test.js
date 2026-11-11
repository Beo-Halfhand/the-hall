// The agents page's promises, checked: the page and the example script are served, and the script — the very file the page
// shows — really does make a table, sit, play three rounds and leave on a running Worker.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startServer, stopServers } from './server.js';

const PORT = 8861;
const BASE = `http://127.0.0.1:${PORT}`;

before(() => startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1']), { timeout: 90_000 });
after(stopServers);

const run = (args, cmd = 'node', file = 'public/agent-example.mjs') => new Promise((resolve) => {
  const child = spawn(cmd, [file, ...args], { cwd: new URL('..', import.meta.url).pathname });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

test('the agents page and the example script are served, and the script on the page is the file that runs', async () => {
  const page = await fetch(`${BASE}/agents`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Bring your agent<\/title>/);
  for (const word of ['Connect your agent', 'For your model', 'The limits', 'Can it cheat?', 'The house bots', 'Coming soon', 'Support the build', 'MCP server', 'Midnight City', '/agents/llms.txt', '/agents/openapi.json', '/lobby/open']) assert.ok(html.includes(word), word);
  assert.ok(!/tnight tables are on|play for tnight/i.test(html), 'no claim that tNIGHT is open to agents');
  const script = await fetch(`${BASE}/agent-example.mjs`);
  assert.equal(script.status, 200);
  assert.equal(await script.text(), readFileSync(new URL('../public/agent-example.mjs', import.meta.url), 'utf8'));
});

test('every route the page lists exists and answers in JSON', async () => {
  const get = async (path, token) => (await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  assert.equal((await get('/api')).status, 200);
  assert.equal((await get('/dice-tables')).status, 200);
  assert.equal((await get('/games')).status, 200);
  const made = await (await fetch(`${BASE}/dice-tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lobbySeconds: 0, seats: 2 }) })).json();
  const joined = await (await fetch(`${BASE}/dice-tables/${made.id}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Doc', kind: 'agent' }) })).json();
  assert.ok(Number.isInteger(joined.seat) && /^[0-9a-f]{64}$/.test(joined.token));
  const me = await (await get(`/dice-tables/${made.id}/me`, joined.token)).json();
  assert.ok(Array.isArray(me.legal) && me.legal[0].action === 'bid');
  const pub = await (await get(`/dice-tables/${made.id}`)).json();
  assert.ok(['phase', 'pot', 'seats', 'lastResult', 'log', 'fair'].every((k) => k in pub));
  assert.ok(pub.seats.some((x) => x.bot && x.kind === 'house') && pub.seats.some((x) => !x.bot && x.kind === 'agent'));
  assert.ok(!JSON.stringify(pub).includes(joined.token) && !('dice' in pub), 'nothing private in the public state');
  const left = await (await fetch(`${BASE}/dice-tables/${made.id}/leave`, { method: 'POST', headers: { authorization: `Bearer ${joined.token}`, 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(left.ok, true);
});

test('the example agent plays three rounds and leaves', { timeout: 120_000 }, async () => {
  const { code, out } = await run([BASE, '3']);
  assert.equal(code, 0, out);
  assert.match(out, /seated at seat 0/);
  assert.equal((out.match(/^round \d+:/gm) ?? []).length, 3, out);
  assert.match(out, /(left with \d+ chips|leaving after this round)\n?$/);
});

test('the agent sheet and the OpenAPI file are served, say what is open and what is not, and every fixed route in them answers', async () => {
  const sheet = await fetch(`${BASE}/agents/llms.txt`);
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get('content-type'), /^text\/plain/);
  const text = await sheet.text();
  for (const words of ['POST /lobby/open', '## Cup & Claim', '## Sealed Hand', '## What you can see', '## Fair play', '## Limits', 'about 300 requests a minute', '/watch/']) assert.ok(text.includes(words), words);
  assert.ok(text.includes('## Agents on tNIGHT'), 'the tNIGHT path is in the sheet');
  assert.ok(/features\.agentTnight/.test(text) && /not halfhand\.app yet/.test(text), 'and says where it is on, honestly');
  assert.ok(/Midnight City wallets are on Preview/.test(text), 'Preview is not Preprod, said plainly');
  const spec = await (await fetch(`${BASE}/agents/openapi.json`)).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(spec, JSON.parse(readFileSync(new URL('../public/agents/openapi.json', import.meta.url), 'utf8')));
  const fixed = Object.entries(spec.paths).filter(([path, ops]) => !path.includes('{') && ops.get && !ops.get.security);
  const chips = fixed.filter(([, ops]) => ops.get['x-needs'] !== 'tnight').map(([path]) => path);
  const tnight = fixed.filter(([, ops]) => ops.get['x-needs'] === 'tnight').map(([path]) => path);
  assert.deepEqual(chips.sort(), ['/api', '/closures', '/dice-tables', '/games', '/lobby/tables']);
  assert.deepEqual(tnight.sort(), ['/agent-settings', '/door']);
  for (const path of chips) assert.equal((await fetch(BASE + path)).status, 200, path);
  for (const path of tnight) assert.equal((await fetch(BASE + path)).status, 404, `${path}: only where tNIGHT is on, and this test Hall plays chips`);
  const py = await fetch(`${BASE}/agent-example.py`);
  assert.equal(py.status, 200);
  assert.equal(await py.text(), readFileSync(new URL('../public/agent-example.py', import.meta.url), 'utf8'));
  const help = await (await fetch(`${BASE}/api`)).json();
  for (const route of ['GET /lobby/tables', 'POST /lobby/open', 'GET /watch/:game/:n', 'GET /agents/llms.txt']) assert.ok(help.routes[route], route);
});

test('POST /lobby/open: a waiting table with room, the same one for the next caller, a new one once it is full; GET /lobby/tables lists them with kinds; /watch/<game>/<n> leads there', { timeout: 60_000 }, async () => {
  const open = async (body) => { const res = await fetch(`${BASE}/lobby/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, ...(await res.json()) }; };
  const join = async (api, name) => (await fetch(`${BASE}${api}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, kind: 'agent' }) })).json();
  const first = await open({ game: 'cup-and-claim', seats: 2, lobbySeconds: 120 });
  assert.equal(first.status, 201);
  assert.equal(first.created, true);
  assert.equal(first.api, `/dice-tables/${first.id}`);
  assert.ok((await join(first.api, 'Lobby1')).token);
  const second = await open({ game: 'dice', seats: 2, lobbySeconds: 120 });
  assert.equal(second.status, 200);
  assert.equal(second.id, first.id, 'the same table: it has a seat left');
  assert.ok((await join(second.api, 'Lobby2')).token);
  const third = await open({ game: 'cup-and-claim', seats: 2, lobbySeconds: 120 });
  assert.notEqual(third.id, first.id, 'full: a new table');
  assert.equal(third.created, true);
  // Ten at once: they fill tables of four and spill, never over.
  const many = await Promise.all(Array.from({ length: 10 }, () => open({ game: 'sealed-hand', lobbySeconds: 120 })));
  const byTable = many.reduce((m, x) => ({ ...m, [x.id]: (m[x.id] ?? 0) + 1 }), {});
  assert.deepEqual(Object.values(byTable).sort(), [2, 4, 4], `ten callers, three tables: ${JSON.stringify(Object.values(byTable))}`);
  assert.equal(many.filter((x) => x.created).length, 3);
  for (const bad of [{}, { game: 'poker' }, { game: 'sealed-hand', seats: 6 }, { game: 'cup-and-claim', lobbySeconds: 999 }]) assert.equal((await open(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await fetch(`${BASE}/lobby/open`)).status, 405);
  // Listed, with kinds.
  const { tables, totals } = await (await fetch(`${BASE}/lobby/tables`)).json();
  const row = tables.find((t) => t.id === first.id);
  assert.ok(row, 'the table is listed');
  assert.deepEqual(row.players.map((p) => p.kind), ['agent', 'agent']);
  assert.ok(totals.agents >= 2);
  assert.ok(!JSON.stringify(tables).includes('token'), 'nothing secret');
  const watch = await fetch(BASE + row.watch, { redirect: 'manual' });
  assert.equal(watch.status, 302);
  assert.equal(watch.headers.get('location'), `/dice?id=${first.id}&watch=1`);
  assert.equal((await fetch(`${BASE}/watch/chess/1`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${BASE}/lobby`)).status, 200, 'the page');
});

test('the Python example plays three rounds and leaves', { timeout: 120_000 }, async () => {
  const { code, out } = await run([BASE, '3'], 'python3', 'public/agent-example.py');
  assert.equal(code, 0, out);
  assert.match(out, /seated at seat 0/);
  assert.equal((out.match(/^round \d+:/gm) ?? []).length, 3, out);
  assert.match(out, /(left with \d+ chips|leaving after this round)\n?$/);
});
