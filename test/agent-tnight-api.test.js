// Agents on tNIGHT (phase 2, 11-08) over HTTP on a local `wrangler dev`, with this test standing in for the judge:
// the owner's signed settings (pending until the judge says), the judge's list, the day so far, Stop at a table, an agent's own
// door marked as an agent, and the table's buy-in max of 250 on every seat ask.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServers } from './server.js';

const ON = 8957;
const OFF_AGENTS = 8959;
const JUDGE = 'test-judge-token';
const CAGE = 'd'.repeat(64);
const A = 'a'.repeat(64);
const AGENT = 'a9'.repeat(32);
const OWNER = 'c'.repeat(64);
const star = (n) => String(n * 1_000_000);
const now = () => Math.floor(Date.now() / 1000);

before(async () => {
  const on = ['--var', 'ALLOW_TEST_CONFIG:1', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${CAGE}`, '--var', 'CAGE_TABLE_BASE:700'];
  await startServer(ON, on);
  await startServer(OFF_AGENTS, [...on, '--var', 'AGENT_TNIGHT:off']);
}, { timeout: 120_000 });
after(stopServers);

async function call(method, path, { body, token, port = ON } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const judgeList = async () => (await call('GET', '/judge/tables', { token: JUDGE })).body;
const judgeAgent = (body) => call('POST', '/judge/agent', { token: JUDGE, body });
const setting = (over = {}) => ({ cageId: A, agent: AGENT, limit: '1000', signedAt: now() - 5, verifyingKey: 'owner-vk', signature: 'owner-sig', ...over });

test('on with tNIGHT, off with AGENT_TNIGHT=off: the Hall says which, and the routes follow', async () => {
  assert.equal((await call('GET', '/hall')).body.features.agentTnight, true);
  assert.equal((await call('GET', '/hall', { port: OFF_AGENTS })).body.features.agentTnight, false);
  assert.equal((await call('GET', '/agent-settings', { port: OFF_AGENTS })).status, 404);
  const info = (await call('GET', '/agent-settings')).body;
  assert.equal(info.message, `sealed-hand:agent:v1|${CAGE}|<cageId>|<agent>|<limit>|<signedAt>`);
  assert.deepEqual(info.limits, { defaultDailyCap: 1000, buyInMax: 250 });
});

test('an owner\'s setting waits for the judge; only a newer one replaces it; verified, it is what the agent plays under, with its day so far', async () => {
  const bad = await call('POST', '/agent-settings', { body: setting({ limit: '0' }) });
  assert.deepEqual([bad.status, bad.body.error], [400, 'bad_setting']);
  assert.equal((await call('POST', '/agent-settings', { body: setting({ signedAt: now() + 3600 }) })).status, 400, 'not from the future');

  const s1 = setting();
  const put = await call('POST', '/agent-settings', { body: s1 });
  assert.deepEqual([put.status, put.body.status], [202, 'pending']);
  const read = (await call('GET', `/agent-settings/${A}`)).body;
  assert.deepEqual([read.status, read.pending.limit, read.current], ['pending', '1000', null]);
  assert.equal(read.signature, undefined, 'no signature on the public view');

  const row = (await judgeList()).agents.find((a) => a.cageId === A);
  assert.equal(row.message, `sealed-hand:agent:v1|${CAGE}|${A}|${AGENT}|1000|${s1.signedAt}`, 'the Worker writes the message, so the judge checks what was claimed');
  assert.equal(row.status, 'pending');

  assert.equal((await call('POST', '/judge/agent', { body: { cageId: A, signedAt: s1.signedAt, ok: true } })).status, 401, 'only the judge answers');
  await judgeAgent({ cageId: A, signedAt: s1.signedAt, ok: true });
  const v = (await call('GET', `/agent-settings/${A}`)).body;
  assert.deepEqual([v.status, v.limit, v.pending], ['verified', '1000', null]);

  const older = await call('POST', '/agent-settings', { body: setting({ limit: 'none', signedAt: s1.signedAt - 10 }) });
  assert.deepEqual([older.status, older.body.error], [409, 'older_setting']);

  // the owner removes the cap; a stranger's signature is refused by the judge and changes nothing
  const s2 = setting({ limit: 'none', signedAt: s1.signedAt + 1 });
  assert.equal((await call('POST', '/agent-settings', { body: s2 })).status, 202);
  await judgeAgent({ cageId: A, signedAt: s2.signedAt, ok: false, reason: 'Only the wallet this cage id pays out to (the agent\'s owner) can sign its settings.' });
  const r = (await call('GET', `/agent-settings/${A}`)).body;
  assert.deepEqual([r.limit, r.status, r.pending.status], ['1000', 'verified', 'refused']);
  assert.match(r.pending.reason, /Only the wallet/);

  // the judge tells the day so far
  await judgeAgent({ cageId: A, signedAt: s1.signedAt, lossTodayStar: star(60), leftStar: star(940), day: '2026-11-08T08:00:00.000Z' });
  const d = (await call('GET', `/agent-settings/${A}`)).body;
  assert.deepEqual([d.lossTodayStar, d.leftStar], [star(60), star(940)]);
  assert.ok((await judgeList()).agents.some((a) => a.cageId === A && a.status === 'verified' && a.limit === '1000'), 'the judge keeps the current one');
});

test('an agent\'s own key at the door: the judge says agent, so its seat is an Agent, whatever it called itself', async () => {
  const expires = now() + 3600;
  const d = await call('POST', '/door', { body: { cageId: 'f'.repeat(64), payout: OWNER, expires, verifyingKey: 'agent-vk', signature: 'agent-sig', name: 'Sly', kind: 'human' } });
  assert.equal(d.status, 202);
  const row = (await judgeList()).doors.find((x) => x.expires === expires);
  await call('POST', '/judge/door', { token: JUDGE, body: { key: row.key, ok: true, agent: true, balanceStar: star(300) } });
  const t = await call('POST', '/tables', { body: { tnight: true, lobbySeconds: 0, stakes: { ante: 1 } } });
  const c = await call('POST', `/tables/${t.body.id}/cage-seat`, { body: { doorToken: d.body.token, atRiskStar: star(900) } });
  assert.equal(c.status, 202);
  const work = (await judgeList()).tables.find((x) => x.id === t.body.id);
  const claim = work.claims.find((x) => x.cageId === 'f'.repeat(64));
  assert.equal(claim.ask.atRiskStar, star(250), 'the buy-in max: an ask for 900 goes to the judge as 250');
  const v = await call('POST', `/judge/tables/${t.body.id}/verified`, { token: JUDGE, body: { cageId: 'f'.repeat(64), ok: true, atRiskStar: star(250), balanceStar: star(300), epoch: 1 } });
  assert.equal(v.status, 200);
  const state = (await call('GET', `/tables/${t.body.id}`)).body;
  assert.equal(state.seats.find((x) => x.name === 'Sly').kind, 'agent');
});

test('Stop at a table: the agent\'s seat finishes the round it is in, then leaves, and the log says why', async () => {
  const t = await call('POST', '/tables', { body: { tnight: true, lobbySeconds: 0, stakes: { ante: 1 }, test: { rng: 7, roundGapMs: 200 } } });
  const id = t.body.id;
  for (const [cageId, name] of [[A, 'Bot9'], ['b'.repeat(64), 'Ann']]) {
    const c = await call('POST', `/tables/${id}/cage-seat`, { body: { name, cageId, verifyingKey: 'vk', signature: 'sig' } });
    assert.equal(c.status, 202);
    await call('POST', `/judge/tables/${id}/verified`, { token: JUDGE, body: { cageId, ok: true, atRiskStar: star(20), balanceStar: star(20), epoch: 1 } });
  }
  const s = await call('POST', `/judge/tables/${id}/stop`, { token: JUDGE, body: { cageId: A } });
  assert.equal(s.status, 200);
  const view = (await call('GET', `/tables/${id}`)).body;
  const bot = view.seats.find((x) => x.name === 'Bot9');
  assert.ok(bot.leaving || bot.left, 'leaving after this round');
  assert.ok(view.log.some((l) => /Bot9's owner stopped it: it leaves after this round/.test(typeof l === 'string' ? l : l.text)));
  assert.equal((await call('POST', `/judge/tables/${id}/stop`, { body: { cageId: A } })).status, 401, 'only the judge');
});
