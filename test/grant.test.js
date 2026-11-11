// The one-time purse grant against a real Durable Object: the setting goes in as a deploy would set it, and a
// restart with the same setting must not pay it twice.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServers } from './server.js';

const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), 'sealed-hand-grant-'));

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

after(stopServers);

test('grant: inert until set, pays the one player once, and survives restarts without paying again', { timeout: 120_000 }, async () => {
  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1'], persist);
  const owner = (await call('POST', '/players', { body: { name: 'Halfhand', testChips: 100 } })).body;
  const namesake = (await call('POST', '/players', { body: { name: 'Halfhand', testChips: 100 } })).body;
  assert.equal((await call('GET', '/players/me', { token: owner.token })).body.chips, 100, 'nothing without the setting');
  await stopServers();

  const setting = ['--var', 'ALLOW_TEST_CONFIG:1', '--var', `PURSE_GRANT:${owner.playerId}:1209`];
  await startServer(PORT, setting, persist);
  assert.equal((await call('GET', '/players/me', { token: owner.token })).body.chips, 1209);
  assert.equal((await call('GET', '/players/me', { token: namesake.token })).body.chips, 100, 'the same name earns nothing');
  const late = (await call('POST', '/players', { body: { name: 'Halfhand', testChips: 100 } })).body;
  assert.equal((await call('GET', '/players/me', { token: late.token })).body.chips, 100, 'nor does taking the name after the deploy');

  const { id } = (await call('POST', '/tables', { body: { lobbySeconds: 30, test: { rng: 5 } } })).body;
  assert.equal((await call('POST', `/tables/${id}/join`, { body: { kind: 'human', buyIn: 200 }, token: owner.token })).status, 201);
  assert.equal((await call('GET', '/players/me', { token: owner.token })).body.chips, 1009, 'a normal purse from here');
  await stopServers();

  await startServer(PORT, setting, persist);
  assert.equal((await call('GET', '/players/me', { token: owner.token })).body.chips, 1009, 'not paid again');
  await stopServers();

  await startServer(PORT, ['--var', 'ALLOW_TEST_CONFIG:1'], persist);
  assert.equal((await call('GET', '/players/me', { token: owner.token })).body.chips, 1009, 'and it stays once the setting is gone');
});
