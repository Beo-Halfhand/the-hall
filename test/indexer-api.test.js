// The Hall's own indexer: GraphQL from the wallet page goes through the Worker to an upstream with the key added there.
// This test stands in for the upstream (HTTP and WebSocket) and checks what reaches it and what comes back.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { startServer, stopServers } from './server.js';

const ON = 8851;
const OFF = 8853;
const UP = 8855;
const KEY = 'test-project-key';
const seen = [];
let upstreamStatus = 200;
let upstream;

before(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, key: url.searchParams.get('project_id'), body, type: req.headers['content-type'] });
      if (url.searchParams.get('project_id') !== KEY) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"forbidden"}'); return; }
      res.writeHead(upstreamStatus, { 'content-type': 'application/json', 'x-upstream-secret': 'should-not-pass' });
      res.end(upstreamStatus === 200 ? JSON.stringify({ data: { block: { height: 3300000 }, echo: JSON.parse(body).variables ?? null } }) : '{"error":"down"}');
    });
  });
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has('graphql-transport-ws') ? 'graphql-transport-ws' : false) });
  upstream.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ method: 'WS', path: url.pathname, key: url.searchParams.get('project_id'), protocol: req.headers['sec-websocket-protocol'] });
    if (url.pathname !== '/api/v0/ws' || url.searchParams.get('project_id') !== KEY) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => { ws.on('message', (m) => ws.send(`echo:${m}`)); });
  });
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  await startServer(ON, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'WALLET_PAGE:on', '--var', `INDEXER_KEY:${KEY}`, '--var', `INDEXER_UPSTREAM:http://127.0.0.1:${UP}/api/v0`]);
  await startServer(OFF, ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'WALLET_PAGE:on']);
}, { timeout: 120_000 });
after(async () => { await stopServers(); upstream?.close(); });

const post = (path, body, { port = ON, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('GET /indexer says whether this Hall has one, naming the host and never the key', async () => {
  const on = await (await fetch(`http://127.0.0.1:${ON}/indexer`)).json();
  assert.deepEqual(on, { on: true, network: 'preprod', host: `127.0.0.1:${UP}` });
  const off = await fetch(`http://127.0.0.1:${OFF}/indexer`);
  assert.equal(off.status, 404);
  assert.equal((await off.json()).error, 'no_indexer');
  const help = await (await fetch(`http://127.0.0.1:${ON}/api`)).json();
  assert.ok(help.routes['POST /indexer/graphql']);
});

test('a query goes upstream with the key on it, and the answer comes back without any of the upstream\'s headers', async () => {
  seen.length = 0;
  const res = await post('/indexer/graphql', { query: '{ block { height } }', variables: { a: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream-secret'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.data.block.height, 3300000);
  assert.deepEqual(body.data.echo, { a: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, KEY, 'the key is added by the Worker');
  assert.equal(seen[0].path, '/api/v0');
  assert.equal(seen[0].body, JSON.stringify({ query: '{ block { height } }', variables: { a: 1 } }), 'the body goes through as sent');
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test('named queries pass; mutations, subscriptions, bad JSON and big bodies are refused before anything goes upstream', async () => {
  seen.length = 0;
  assert.equal((await post('/indexer/graphql', { query: 'query Height { block { height } }' })).status, 200);
  assert.equal((await post('/indexer/graphql', { query: '# a comment\nquery { block { height } }' })).status, 200);
  assert.equal(seen.length, 2);
  for (const [query, why] of [['mutation { x }', 'mutation'], ['subscription { x }', 'subscription'], [42, 'not a string'], ['', 'empty']]) {
    const res = await post('/indexer/graphql', { query });
    assert.equal(res.status, 400, why);
    assert.equal((await res.json()).error, 'bad_query', why);
  }
  assert.equal((await post('/indexer/graphql', '{not json')).status, 400);
  assert.equal((await post('/indexer/graphql', { query: `{ block { height } } ${'#'.repeat(70000)}` })).status, 413);
  assert.equal((await fetch(`http://127.0.0.1:${ON}/indexer/graphql`)).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${ON}/indexer/other`)).status, 404);
  assert.equal(seen.length, 2, 'nothing else reached the upstream');
});

test('another site\'s page can\'t use it', async () => {
  const res = await post('/indexer/graphql', { query: '{ block { height } }' }, { headers: { origin: 'https://elsewhere.example' } });
  assert.equal(res.status, 403);
  const own = await post('/indexer/graphql', { query: '{ block { height } }' }, { headers: { origin: `http://127.0.0.1:${ON}` } });
  assert.equal(own.status, 200);
});

test('an upstream that is down answers as a GraphQL error with the status, and no address or key in it', async () => {
  upstreamStatus = 503;
  try {
    const res = await post('/indexer/graphql', { query: '{ block { height } }' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.errors[0].message, /answered HTTP 503/);
    assert.ok(!JSON.stringify(body).includes(KEY) && !JSON.stringify(body).includes(String(UP)));
  } finally {
    upstreamStatus = 200;
  }
  const off = await post('/indexer/graphql', { query: '{ block { height } }' }, { port: OFF });
  assert.equal(off.status, 404);
});

test('the WebSocket goes through with its subprotocol, the key added upstream and frames both ways', { timeout: 20000 }, async () => {
  seen.length = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${ON}/indexer/ws`, ['graphql-transport-ws']);
  const opened = await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => reject(new Error('socket refused')));
    ws.addEventListener('close', (e) => reject(new Error(`closed ${e.code} ${e.reason}`)));
  });
  assert.ok(opened);
  assert.equal(ws.protocol, 'graphql-transport-ws', 'the upstream\'s choice of subprotocol reaches the browser');
  const echo = new Promise((resolve) => ws.addEventListener('message', (e) => resolve(String(e.data))));
  ws.send('{"type":"connection_init"}');
  assert.equal(await echo, 'echo:{"type":"connection_init"}');
  const up = seen.find((s) => s.method === 'WS');
  assert.equal(up.key, KEY);
  assert.equal(up.path, '/api/v0/ws');
  assert.equal(up.protocol, 'graphql-transport-ws');
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.close(1000, 'done');
  assert.equal(await closed, 1000);
});
