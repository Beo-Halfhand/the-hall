// The owner's acceptance test, and the count of wallet prompts. The real pages in Chrome, the real Worker on a local `wrangler dev`, the real judge cycle from sealed-cage, and
// the real v4 circuits in the contract's simulator. The only stand-ins are the wallet and the proofs. No network, and nothing on preprod.
//
// Needs a sealed-cage checkout on v4b-wire with the contract compiled: SEALED_CAGE_DIR, default ../sealed-cage-v4b-wire.
// Cage v4b: a move is seatByJudge with a from-table, and a revoke is a deposit of 0 with the empty permit. The counts below name them as before.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';
import { baseOf, findByPayout, readPlayer } from '../wallet-app/src/cage-read.js';

const CAGE_DIR = process.env.SEALED_CAGE_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-v4b-wire');
const here = existsSync(join(CAGE_DIR, 'contracts/managed/sealed-cage/contract/index.js')) && existsSync(join(CAGE_DIR, 'scripts/judge-cycle.mjs'));
const from = (rel) => import(pathToFileURL(join(CAGE_DIR, rel)).href);

const PORT = Number(process.env.V4_TEST_PORT ?? 8871);
const BASE = `http://127.0.0.1:${PORT}`;
const JUDGE_TOKEN = 'test-judge-token';
const ADDRESS = 'mn_addr_preprod1qqqqtestaddress';
const PAYOUT = 'c1'.repeat(32);
const LACE = '[data-wallet="io.lace.wallet"]';
const M = 1_000_000n;

let browser, sim, judge, journalLog, stopLoop, hexOf, unhexOf, pureCircuits, ledgerNow;
const prompts = { connect: 0, tx: 0, signature: 0, txs: [] };
const countFrom = () => ({ ...prompts, txs: [...prompts.txs] });
const since = (a) => ({ connect: prompts.connect - a.connect, tx: prompts.tx - a.tx, signature: prompts.signature - a.signature, txs: prompts.txs.slice(a.txs.length) });
const total = (c) => c.connect + c.tx + c.signature;
let simHooks = {}; // a test can interfere with a call, as a stolen judge key would
const counts = {}; // the table for the report

async function jfetch(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, body: parsed };
}

before(async () => {
  if (!here) return;
  const { simChain, simWallet, hex, unhex, idOf, pureCircuits: pc } = await from('test/sim-chain.mjs');
  const { makeJudge, houseKey } = await from('scripts/judge-cycle.mjs');
  const { Journal } = await from('scripts/judge-plan.mjs');
  hexOf = hex; unhexOf = unhex; pureCircuits = pc;
  sim = simChain();
  ledgerNow = () => sim.state();
  const wallet = simWallet(sim);
  sim.wallet = wallet;
  await startServer(PORT, ['--var', 'WALLET_PAGE:on', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE_TOKEN}`, '--var', `CAGE_ADDRESS:${sim.address}`, '--var', 'ALLOW_TEST_CONFIG:1', '--var', 'CAGE_TABLE_BASE:700']);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  journalLog = [];
  const journal = new Journal();
  const judgeKey = hex(sim.judge.sk);
  const record = (r) => journal.apply({ ...r, at: new Date().toISOString() });
  judge = makeJudge({
    address: sim.address, journal, record, log: (t) => journalLog.push(t), judgeKey, prewarm: 0, minDust: 0n, houseFloat: 60,
    worker: (m, p, b) => jfetch(m, p, { body: b, token: JUDGE_TOKEN }),
    readChain: async () => sim.state(),
    // A seat takes long enough for the page's one-second poll to see the judge prove it, as it would on chain.
    callCircuit: async (circuit, ...a) => { if (/ByJudge/.test(circuit)) await new Promise((r) => setTimeout(r, 1300)); return wallet.callCircuit(circuit, ...a); },
    probeTx: async () => null,
    dustNow: async () => 10n ** 18n,
    idOf: (k) => hex(idOf(unhex(k))),
    houseKeyFor: (t) => houseKey(judgeKey, sim.address, t),
    payoutOf: () => ({ bytes: unhex('ee'.repeat(32)) }),
    declaredNow: () => BigInt(Math.floor(Date.now() / 1000) - 60),
    checkOpts: () => ({ address: sim.address, addressFromKey: (k) => k, verify: () => true }),
  });
  let on = true;
  const loop = (async () => { while (on) { await judge.cycle().catch((e) => journalLog.push(`cycle error: ${e.message}`)); await new Promise((r) => setTimeout(r, 200)); } })();
  stopLoop = async () => { on = false; await loop; };
}, { timeout: 120000 });

after(async () => {
  await stopLoop?.();
  await browser?.close();
  await stopServers();
  if (Object.keys(counts).length) console.log(`PROMPTS ${JSON.stringify(counts)}`);
});

// ---------- the wallet stand-in: real pages, and the wallet's approvals counted in here ----------

const revive = (_, v) => (v?.$b !== undefined ? BigInt(v.$b) : v?.$u !== undefined ? unhexOf(v.$u) : v);
const replace = (_, v) => (typeof v === 'bigint' ? { $b: String(v) } : v instanceof Uint8Array ? { $u: hexOf(v) } : v);

const STUB = `
const replace = (_, v) => (typeof v === 'bigint' ? { $b: String(v) } : v instanceof Uint8Array ? { $u: [...v].map((b) => b.toString(16).padStart(2, '0')).join('') } : v);
const revive = (_, v) => (v?.$b !== undefined ? BigInt(v.$b) : v?.$u !== undefined ? Uint8Array.from({ length: v.$u.length / 2 }, (_x, i) => parseInt(v.$u.slice(i * 2, i * 2 + 2), 16)) : v);
const wire = async (op, ...a) => { const out = JSON.parse(await window.__sim(JSON.stringify({ op, a }, replace)), revive); if (out.error) throw new Error(out.error); return out.ok; };
export async function openCage() {
  let sent = false;
  return {
    payoutOf: () => ({ bytes: Uint8Array.from({ length: 32 }, () => 0xc1) }),
    useApi() {},
    sent: () => sent,
    read: (sk) => wire('read', sk),
    findByAddress: () => wire('find'),
    async call(circuit, sk, args, progress = () => {}) {
      sent = false;
      progress('Running the circuit.');
      progress('Proving with Lace. Approve there if it asks. This can take a few minutes.');
      progress('Approve in Lace.');
      const r = await wire('call', circuit, sk, args);
      sent = true;
      progress('Lace is sending it.');
      progress('Sent. Waiting for a block.');
      return r;
    },
  };
}`;

function simAnswer(json) {
  const { op, a } = JSON.parse(json, revive);
  try {
    const L = sim.state();
    if (op === 'read') {
      const sk = a[0];
      if (!sk) return JSON.stringify({ ok: { ...baseOf(L), id: null, balance: 0n, seat: null, table: null, permit: null, bound: false, ours: false } }, replace);
      return JSON.stringify({ ok: readPlayer(L, pureCircuits.playerId(unhexOf(sk)), PAYOUT) }, replace);
    }
    if (op === 'find') return JSON.stringify({ ok: findByPayout(L, PAYOUT) }, replace);
    if (op === 'call') {
      const [circuit, sk, args] = a;
      prompts.tx += 1;
      prompts.txs.push(circuit === 'deposit' && args[1] === 0n && args[3] === 0n ? 'revoke' : circuit); // a deposit of 0 with the empty permit is a revoke
      simHooks.before?.(circuit, sk, args);
      sim.call(unhexOf(sk), circuit, ...args);
      return JSON.stringify({ ok: { blockHeight: sim.block(), status: 'SucceedEntirely', txHash: `page${prompts.tx}` } }, replace);
    }
    throw new Error(`no such op ${op}`);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

const PNG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const WALLET = (payout) => `
  window.midnight = {
    lace: {
      name: 'lace', rdns: 'io.lace.wallet', apiVersion: '4.0.1', icon: ${JSON.stringify(PNG)},
      connect: async () => {
        await window.__connectPrompt();
        return {
          hintUsage: async () => {},
          getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }),
          getUnshieldedAddress: async () => ({ unshieldedAddress: ${JSON.stringify(ADDRESS)} }),
          getDustAddress: async () => ({ dustAddress: 'mn_dust_preprod1qqqqtest' }),
          getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: 5000000000n }),
          getDustBalance: async () => ({ balance: 2500000000000000n, cap: 25000000000000000000n }),
          getShieldedAddresses: async () => ({ shieldedCoinPublicKey: 'cpk', shieldedEncryptionPublicKey: 'epk' }),
          getProvingProvider: async () => ({}),
          signData: async (data) => { await window.__signPrompt(); return { data, signature: 'sig', verifyingKey: ${JSON.stringify(payout)} }; },
          getConfiguration: async () => ({ networkId: 'preprod', indexerUri: 'https://indexer.test/graphql', indexerWsUri: 'wss://indexer.test/ws', substrateNodeUri: 'wss://node.test' }),
        };
      },
    },
  };
`;

/** One person's browser. The site is approved in the wallet from the first connect on, as it would be: a reconnect asks nothing. */
async function person() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  let approved = false;
  await context.exposeFunction('__connectPrompt', () => { if (!approved) { approved = true; prompts.connect += 1; } });
  await context.exposeFunction('__signPrompt', () => { prompts.signature += 1; });
  await context.exposeFunction('__sim', (json) => simAnswer(json));
  await context.addInitScript(WALLET(PAYOUT));
  // A saved player, as every tNIGHT visitor has since the Hall asks who first (11-10): a seat is never asked for without a valid avatar.
  const saved = await jfetch('POST', '/players', { body: { name: 'The owner' } });
  await context.addInitScript((t) => { try { localStorage.setItem('hall.player', t); } catch { /* storage off */ } }, saved.body.token);
  // No deal show (as the other browser suites): the helper plays a round in about a second, faster than the deal animation, and the pass
  // log the animation holds back then drops in above Leave as the round settles (11-10, the third cause of "no good permit" flaking).
  await context.addInitScript(() => { try { localStorage.setItem('hall.dealShow', 'off'); } catch { /* storage off: the page plays it */ } });
  const errors = [];
  const newPage = async () => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://indexer.test/**', (r) => (r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: { block: { height: 3300000 }, contract: { address: sim.address } } }) }))); // a height and the cage: what the page checks an indexer for (11-09)
    await page.route('http://localhost:6300/**', (r) => r.fulfill({ status: 200, body: '{"status":"ok"}' }));
    await page.route('**/cage-config.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'cage v4', writable: true, network: 'preprod', address: sim.address, escapeSecs: 1800, clockSlack: 300, seats: 6 }) }));
    await page.route('**/wallet-app/cage.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
    await page.route('https://fonts.**', (r) => r.abort());
    return page;
  };
  return { context, newPage, errors };
}

const newTable = async (game) => {
  const api = game === 'dice' ? '/dice-tables' : '/tables';
  const res = await jfetch('POST', api, { body: { tnight: true, bots: 2, lobbySeconds: 0, test: { rng: 7, turnMs: 500, botDelayMs: [50, 100], roundGapMs: 400 } } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id, api, page: game === 'dice' ? '/dice' : '/table', table: res.body.state.cage.table };
};
const seatOnChain = (sk) => { const L = sim.state(); const id = pureCircuits.playerId(unhexOf(sk)); return L.seat.member(id) ? { ...L.seat.lookup(id), atRisk: L.risks.lookup(id) } : null; };
const permitOnChain = (sk) => { const L = sim.state(); const id = pureCircuits.playerId(unhexOf(sk)); return L.permits.member(id) ? L.permits.lookup(id) : null; };
const balanceOnChain = (sk) => { const L = sim.state(); const id = pureCircuits.playerId(unhexOf(sk)); return L.balance.member(id) ? L.balance.lookup(id) : 0n; };
const keyIn = (page) => page.evaluate((a) => localStorage.getItem(`cage.key.${a}`), ADDRESS);
const seatedOn = (page, t, timeout = 60000) => page.waitForURL(`${BASE}${t.page}?id=${t.id}`, { timeout, waitUntil: 'commit' }).catch(() => {});
const judgeSent = () => sim.wallet.sent.map((x) => (x.kind === 'move' ? 'seatByJudge (move)' : x.circuit));
const judgeSentSince = (n) => judgeSent().slice(n);

/** Waits for the page's seat token at a table: the judge has seated them. */
const tokenAt = async (page, t, timeout = 90000) => {
  await page.waitForFunction((id) => !!localStorage.getItem(`hall.seat.${id}`), t.id, { timeout });
  return page.evaluate((id) => localStorage.getItem(`hall.seat.${id}`), t.id);
};
/** Plays what's in front of this player, then waits until the Worker has an entry settled on chain. A table with one person has no clock: it waits for them. */
const aRoundSettled = async (t, token, after = 0, timeout = 90000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = (await jfetch('GET', `${t.api}/${t.id}`)).body;
    if (v.cage.receipts.filter((r) => r.lines.length).length > after) return v;
    const me = (await jfetch('GET', `${t.api}/${t.id}/me`, { token })).body;
    const can = (name) => me?.legal?.find((x) => x.action === name);
    const action = can('reveal') ? { action: 'reveal', mode: 'prove' } : can('fold') ? { action: 'fold' } : can('bid') ? { action: 'bid', ...can('bid').lowest }
      : can('pass') ? { action: 'pass', card: me.hand[0] } : can('stop') ? { action: 'stop', claim: can('stop').options[0].claim } : can('check') ? { action: 'check' }
      // Not "next" while a round's settle is on its way (11-10): it dealt the next round before the settle showed, so the caller's
      // Leave landed mid-round, was queued "after this round", and that round waited on this one player for good.
      : can('next') && !v.cage.unsettled?.length ? { action: 'next' } : null;
    if (action) await jfetch('POST', `${t.api}/${t.id}/act`, { token, body: action });
    if (Date.now() > end) throw new Error(`no settled round at table ${t.table}: phase ${v.phase}, round ${v.round}, unsettled ${v.cage.unsettled}, receipts ${JSON.stringify(v.cage.receipts.map((r) => r.lines))}, deadline ${v.deadline ?? v.turnDeadline} now ${v.now}, waitingOn ${v.waitingOn}, seats ${JSON.stringify(v.seats.map((x) => [x.name, x.chips, x.away, x.left]))}. Log: ${v.log.slice(-5).map((l) => l.text).join(' / ')}. Judge: ${journalLog.slice(-6).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
/**
 * The page has caught up with a round that just ended and settled: Leave says "Leave table" (not "after this round"), the round's chain
 * line says "Settled on chain", and the button has stopped moving for 1.5 s. The result above the button grows by ~57 px when the settle shows
 * ("Settling on chain…" becomes the settled line with its tx), so a click sent as that poll lands goes to the box the button just left
 * (11-10: pointerdown on #leave, mouseup on #result-chain, click on #action-box, nothing asked of the table, and #waiting-go never came).
 */
const betweenRounds = async (page) => {
  await page.waitForFunction(() => document.getElementById('leave')?.textContent === 'Leave table'
    && /^Settled on chain/.test(document.getElementById('result-chain')?.textContent ?? ''), null, { timeout: 30000 });
  // Still for 1.5 s: the result block above it grows in steps as the settle's parts arrive (24-57 px, up to ~2 s after the round ends),
  // so two equal readings 150 ms apart weren't enough.
  let last = '';
  let still = 0;
  for (let i = 0; i < 100 && still < 10; i += 1) {
    const now = await page.evaluate(() => JSON.stringify(document.getElementById('leave').getBoundingClientRect()));
    still = now === last ? still + 1 : 0;
    last = now;
    await page.waitForTimeout(150);
  }
};
const sitFromTile = async (page, tnight, { name } = {}) => {
  await page.waitForSelector(`.tile[data-amount="${tnight * 1_000_000}"]`, { timeout: 30000 });
  await page.click(`.tile[data-amount="${tnight * 1_000_000}"]`);
  if (name) { await page.waitForSelector('#bring-name'); await page.fill('#bring-name', name); }
  await page.waitForFunction(() => !document.getElementById('buy-go').disabled, null, { timeout: 15000 });
  await page.click('#buy-go');
};

test('The owner\'s acceptance: dice, leave, cards, sit, play, back to dice, with no wallet prompts after the first visit. Then a top up and a cash out, counted', { skip: !here && 'no compiled cage-v4 checkout', timeout: 420000 }, async () => {
  const { newPage, errors } = await person();

  // A seat has a typical time. A deposit, this early, doesn't.
  for (const ms of [30_000, 40_000, 50_000]) assert.equal((await jfetch('POST', '/judge/timing', { token: JUDGE_TOKEN, body: { action: 'seat', ms } })).status, 200);

  // ---------- first visit: connect, one deposit carrying the permit, one signature, and the judge seats them
  const dice = await newTable('dice');
  const page = await newPage();
  let mark = countFrom();
  await page.goto(`${BASE}${dice.page}?id=${dice.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  await sitFromTile(page, 50, { name: 'The owner' });
  const diceToken = await tokenAt(page, dice);
  let spent = since(mark);
  counts['first visit'] = total(spent);
  assert.deepEqual([spent.connect, spent.tx, spent.signature, spent.txs], [1, 1, 1, ['deposit']], 'connect, the deposit with its permit, and the door. No sit');
  const sk = await keyIn(page);
  assert.equal(seatOnChain(sk).atRisk, 50n * M);
  assert.equal(permitOnChain(sk).cap, 50n * M);
  assert.equal(permitOnChain(sk).floor, 0n);
  assert.ok(permitOnChain(sk).until > BigInt(Math.floor(Date.now() / 1000)) + 11n * 3600n, 'about the door\'s 12 hours');
  assert.ok(judgeSent().includes('seatByJudge'), 'the judge seated them');
  const seatedLog = (await jfetch('GET', `${dice.api}/${dice.id}`)).body.log.map((l) => l.text).join('\n');
  assert.match(seatedLog, /seated by the judge under their permit\. Tx hash-tx\d+/);
  assert.equal((await jfetch('GET', `${dice.api}/${dice.id}`)).body.cage.seatReceipts[0].kind, 'seat');

  // Live step names, as they happened, and a result card for each transaction.
  const steps = await page.textContent('#waiting-log');
  for (const said of ['building your deposit', 'proving your deposit', 'You’re signing to put', 'in the cage…', 'the judge is proving it', 'sent to Midnight: waiting for the block']) assert.ok(steps.includes(said), `${said}: ${steps}`);
  // One line per step, counting up in place (round 2): the judge's "sent" step was said on every poll, 35 lines deep.
  const sentLines = await page.$$eval('#waiting-log li', (els) => els.filter((li) => /sent to Midnight: waiting for the block/.test(li.textContent)).length);
  assert.equal(sentLines, 1, `one line for the judge's wait, not one a second: ${sentLines}`);
  const card = (action, part) => page.textContent(`.result-card[data-action="${action}"] .result-${part}`);
  assert.match(await card('deposit', 'head'), /^Confirmed in \d+s$/);
  assert.match(await card('deposit', 'typical'), /not enough timed yet/, 'nobody has timed a deposit here yet');
  assert.match(await card('deposit', 'says'), /^Public: the amount, your wallet’s address, your player id, and your permit’s cap and end time\. Private: your player key/);
  assert.match(await page.getAttribute('.result-card[data-action="deposit"] a', 'href'), /^https:\/\/preprod\.midnightexplorer\.com\/transactions\/page\d+$/);
  assert.equal(await page.getAttribute('.result-card[data-action="deposit"] a', 'target'), '_blank');
  assert.match(await card('seat', 'head'), /^Confirmed in \d+s$/);
  assert.equal(await card('seat', 'typical'), 'typical 35s for this action', 'the median of 30, 40, 50 and this one, which the judge reported as it landed');
  assert.match(await card('seat', 'says'), /Private: your player key, which this one never touched/);
  assert.match(await page.getAttribute('.result-card[data-action="seat"] a', 'href'), /transactions\/hash-tx\d+$/);

  if (process.env.SHOTS) {
    await page.screenshot({ path: join(process.env.SHOTS, 'cards-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(process.env.SHOTS, 'cards-phone.png') });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `${over}px over on a phone`);
    await page.setViewportSize({ width: 1280, height: 1000 });
  }

  // A timing goes in only from someone at the door, for their own kinds of transaction. The seat is the judge's to report: its own, and after this page's card was read.
  const door = await page.evaluate(() => localStorage.getItem('cage.door'));
  const medians = (await jfetch('GET', '/door/timings')).body.medians;
  assert.equal(medians.deposit.n, 1, 'the first deposit landed before there was a session: it was reported after the signature');
  assert.equal(medians.seat.n, 4);
  assert.equal((await jfetch('POST', '/door/timings', { body: { action: 'deposit', ms: 1 } })).status, 401);
  assert.equal((await jfetch('POST', '/door/timings', { token: door, body: { action: 'seat', ms: 1 } })).status, 400);
  assert.equal((await jfetch('POST', '/door/timings', { token: door, body: { action: 'deposit', ms: 99 * 60_000 } })).status, 400);

  // ---------- play at dice. The round plays itself at this clock, and settles
  mark = countFrom();
  await aRoundSettled(dice, diceToken);
  const afterDice = balanceOnChain(sk);
  assert.notEqual(afterDice, 50n * M, 'the round moved chips on chain');

  // ---------- leave dice: the judge settles and releases, with nothing to approve, and they land in the Hall
  await page.waitForSelector('#leave:not([hidden])', { timeout: 20000 });
  const sentBeforeLeave = judgeSent().length;
  await page.click('#leave');
  await page.waitForSelector('#waiting-go:not([hidden])', { timeout: 120000 });
  assert.match(await page.textContent('.result-card[data-action="release"] .result-head'), /^Confirmed in /);
  assert.match(await page.getAttribute('.result-card[data-action="release"] a', 'href'), /^https:\/\/preprod\.midnightexplorer\.com\/transactions\/hash-tx\d+$/);
  await page.click('#waiting-go');
  await page.waitForURL(`${BASE}/`, { timeout: 30000, waitUntil: 'commit' });
  assert.equal(seatOnChain(sk), null, 'the seat is free before they reach the Hall');
  assert.ok(judgeSentSince(sentBeforeLeave).includes('release'), 'a plain leave, with nowhere to go yet: a release');
  assert.ok(permitOnChain(sk), 'the permit is still there');

  // ---------- cards: sit, nothing to approve
  const cards = await newTable('cards');
  const leaveMark = since(mark);
  assert.equal(total(leaveMark), 0, 'playing and leaving asked nothing');
  mark = countFrom();
  await page.goto(`${BASE}${cards.page}?id=${cards.id}`);
  const room = await page.waitForSelector('.tile[data-amount]', { timeout: 30000 });
  assert.ok(room);
  await page.waitForFunction(() => /nothing to approve/.test(document.querySelector('.tile[aria-checked="true"]')?.textContent ?? ''), null, { timeout: 15000 });
  assert.match(await page.textContent('#summary-approvals'), /None\. The judge seats you\./);
  await page.click('#buy-go');
  const cardsToken = await tokenAt(page, cards);
  spent = since(mark);
  counts.sit = total(spent);
  assert.equal(total(spent), 0, `sitting asks nothing, got ${JSON.stringify(spent)}`);
  assert.equal(seatOnChain(sk).table, BigInt(cards.table));

  // ---------- play at cards
  mark = countFrom();
  await aRoundSettled(cards, cardsToken);

  // ---------- back to dice: a hop. One move, no release, nothing to approve
  const dice2 = await newTable('dice');
  await page.waitForSelector('#hop:not([disabled])', { timeout: 30000 });
  const sentBeforeHop = judgeSent().length;
  await page.click('#hop');
  await page.waitForURL(/\/dice\?id=/, { timeout: 180000, waitUntil: 'commit' });
  const landed = new URL(page.url()).searchParams.get('id');
  const seatNow = seatOnChain(sk);
  spent = since(mark);
  counts['hop cards to dice'] = total(spent);
  assert.equal(total(spent), 0, `a hop asks nothing, got ${JSON.stringify(spent)}`);
  assert.ok(judgeSentSince(sentBeforeHop).includes('seatByJudge (move)'), judgeSentSince(sentBeforeHop).join());
  const myId = hexOf(pureCircuits.playerId(unhexOf(sk))).slice(0, 12);
  assert.ok(!sim.wallet.sent.slice(sentBeforeHop).some((x) => x.circuit === 'release' && x.label.includes(myId)), 'no release of this player: no gap between seats');
  const target = (await jfetch('GET', `/dice-tables/${landed}`)).body;
  assert.equal(seatNow.table, BigInt(target.cage.table));
  assert.equal(target.cage.seatReceipts.at(-1).kind, 'move');
  // The card comes with them to the next page.
  await page.waitForSelector('.result-card[data-action="move"]', { timeout: 20000 });
  assert.match(await page.textContent('.result-card[data-action="move"] .result-head'), /^Confirmed in \d+s$/);
  assert.match(await page.textContent('.result-card[data-action="move"] .result-says'), /both tables/);
  assert.match(await page.getAttribute('.result-card[data-action="move"] a', 'href'), /transactions\/hash-tx\d+$/);
  const old = (await jfetch('GET', `${cards.api}/${cards.id}`)).body;
  assert.ok(old.seats.find((x) => x.name === 'The owner').left);
  assert.ok(dice2.id);

  // ---------- top up from the seat: leave, the judge frees it, one deposit with a new cap, and the table has moved on so the seat comes next
  const here = { id: landed, api: '/dice-tables', page: '/dice', table: target.cage.table };
  await aRoundSettled(here, await tokenAt(page, here));
  mark = countFrom();
  await page.waitForSelector('#top-up:not([disabled])', { timeout: 30000 });
  await page.click('#top-up');
  const wanted = `#top-up-body .tile[data-amount="${250 * 1_000_000}"]`;
  await page.waitForSelector(wanted, { timeout: 20000 });
  await page.click(wanted);
  await page.waitForFunction(() => !document.querySelector('#top-up-body #buy-go').disabled, null, { timeout: 15000 });
  assert.match(await page.textContent('#top-up-body #buy-go'), /^Leave and /);
  await page.click('#top-up-body #buy-go');
  await page.waitForFunction(() => /is in the cage|Done/.test(document.getElementById('waiting-title').textContent + document.getElementById('waiting-line').textContent), null, { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 60000 });
  spent = since(mark);
  counts['top up'] = total(spent);
  assert.deepEqual([spent.connect, spent.tx, spent.signature, spent.txs], [0, 1, 0, ['deposit']], 'one deposit, and no stand');
  assert.equal(permitOnChain(sk).cap, 250n * M, 'the new cap');
  assert.ok(!judgeSent().includes('stand'));

  // ---------- and the seat after a top up asks nothing
  const cards2 = await newTable('cards');
  mark = countFrom();
  await page.goto(`${BASE}${cards2.page}?id=${cards2.id}`);
  await page.waitForFunction(() => /nothing to approve/.test(document.querySelector('.tile[aria-checked="true"]')?.textContent ?? ''), null, { timeout: 30000 });
  await page.click('#buy-go');
  const cards2Token = await tokenAt(page, cards2);
  assert.equal(total(since(mark)), 0, 'top up, then sit: nothing more');
  await aRoundSettled(cards2, cards2Token);

  // ---------- cash out, in one press: stand, the judge frees it, withdraw, and it says what came back
  mark = countFrom();
  await page.waitForSelector('#leave-cash #cash-out:not([disabled])', { timeout: 30000 });
  await page.click('#leave-cash #cash-out');
  await page.click('#leave-cash #cash-all'); // Cash out asks how much (11-07): all of it
  await page.waitForFunction(() => /^Cashed out [\d,.]+ tNIGHT\./.test(document.getElementById('waiting-line')?.textContent ?? ''), null, { timeout: 60000 }).catch(async (e) => {
    const v = (await jfetch('GET', `${cards2.api}/${cards2.id}`)).body;
    throw new Error(`cash out stuck. Window: ${(await page.textContent('#waiting')).replace(/\s+/g, ' ')}. Chain seat ${JSON.stringify(seatOnChain(sk), (_, x) => (typeof x === 'bigint' ? String(x) : x))}. Table ${v.phase} seats ${JSON.stringify(v.seats.map((x) => [x.name, x.chips, x.left, x.leaving]))} unsettled ${v.cage.unsettled}. Txs ${JSON.stringify(since(mark).txs)}. Judge: ${journalLog.slice(-8).join(' | ')}. ${e.message}`);
  });
  spent = since(mark);
  counts['cash out'] = total(spent);
  assert.deepEqual(spent.txs, ['stand', 'withdraw'], 'one press, two approvals');
  assert.equal(spent.connect + spent.signature, 0);
  assert.match(await page.textContent('#waiting-line'), /^Cashed out [\d,.]+ tNIGHT\. Your wallet: [\d,.]+.*\. Left in the cage: 0\./); // in plain words (11-09)
  for (const action of ['stand', 'withdraw']) {
    assert.match(await page.textContent(`.result-card[data-action="${action}"] .result-head`), /^Confirmed in \d+s$/);
    assert.match(await page.getAttribute(`.result-card[data-action="${action}"] a`, 'href'), /midnightexplorer\.com\/transactions\/page\d+$/);
  }
  assert.equal(balanceOnChain(sk), 0n, 'all of it');
  assert.equal(permitOnChain(sk), null, 'the stand ended the permit');
  assert.deepEqual(errors, []);
});

test('the fallback: a stand that fails because the seat moved tries once more, then offers revoke then stand, and the way out still ends with the money home', { skip: !here && 'no compiled cage-v4 checkout', timeout: 240000 }, async () => {
  const { newPage, errors } = await person();
  const t = await newTable('cards');
  const page = await newPage();
  await page.goto(`${BASE}${t.page}?id=${t.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  await sitFromTile(page, 50, { name: 'Sam' });
  const samToken = await tokenAt(page, t);
  const sk = await keyIn(page);
  await aRoundSettled(t, samToken);
  await page.waitForSelector('#leave-cash #cash-out:not([disabled])', { timeout: 30000 });

  // A stolen judge key moves the seat just before each stand lands, while the permit lives.
  const thief = { moves: 0, table: 9000n };
  simHooks = {
    before: (circuit, playerSk) => {
      if (circuit !== 'stand' || playerSk !== sk) return;
      const seat = seatOnChain(sk);
      thief.table += 1n;
      sim.call(sim.judge.sk, 'seatByJudge', pureCircuits.playerId(unhexOf(sk)), { is_some: true, value: seat.table }, thief.table, seat.atRisk < balanceOnChain(sk) ? seat.atRisk : balanceOnChain(sk), BigInt(Math.floor(Date.now() / 1000) - 60));
      thief.moves += 1;
    },
  };
  const mark = countFrom();
  await page.click('#leave-cash #cash-out');
  await page.click('#leave-cash #cash-all'); // Cash out asks how much (11-07): all of it
  await page.waitForFunction(() => /keeps moving/.test(document.getElementById('waiting-title').textContent), null, { timeout: 60000 });
  assert.deepEqual(since(mark).txs, ['stand', 'stand'], 'one try, then once more');
  assert.equal(thief.moves, 2);
  assert.ok(await page.isVisible('#trouble-revoke'));
  assert.ok(!(await page.isVisible('#trouble-retry')), 'no plain Try again: that would only fail again');
  assert.match(await page.textContent('#trouble-do'), /Revoke the permit, then stand: two approvals/);

  // The revoke can't be knocked out. Once it lands the thief can't move them, and the stand lands.
  simHooks = {
    before: (circuit) => {
      if (circuit !== 'stand') return;
      const seat = seatOnChain(sk);
      assert.throws(() => sim.call(sim.judge.sk, 'seatByJudge', pureCircuits.playerId(unhexOf(sk)), { is_some: true, value: seat.table }, 9999n, seat.atRisk, BigInt(Math.floor(Date.now() / 1000) - 60)), /no permit/);
    },
  };
  // A seat moved to a table nobody knows has no Worker row: free it as the judge would after a stand: the settle that names them. Here the escape would do it, so the test settles.
  const freeIt = setInterval(() => {
    const seat = seatOnChain(sk);
    if (seat?.standing) { sim.call(sim.judge.sk, 'release', seat.table, pureCircuits.playerId(unhexOf(sk))); }
  }, 300);
  await page.click('#trouble-revoke');
  await page.waitForFunction(() => /^Cashed out [\d,.]+ tNIGHT\./.test(document.getElementById('waiting-line')?.textContent ?? ''), null, { timeout: 90000 });
  clearInterval(freeIt);
  simHooks = {};
  assert.deepEqual(since(mark).txs, ['stand', 'stand', 'revoke', 'stand', 'withdraw']);
  assert.equal(balanceOnChain(sk), 0n);
  assert.deepEqual(errors, []);
});

test('no good permit: the seat asks for one approval, then the judge seats them. An expired door or permit never fails silently', { skip: !here && 'no compiled cage-v4 checkout', timeout: 180000 }, async () => {
  const { newPage, errors } = await person();
  const t = await newTable('cards');
  const page = await newPage();
  await page.goto(`${BASE}${t.page}?id=${t.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  await sitFromTile(page, 25, { name: 'Ren' });
  const renToken = await tokenAt(page, t);
  const sk = await keyIn(page);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 30000 });
  await aRoundSettled(t, renToken);
  await betweenRounds(page);
  await page.click('#leave');
  await page.waitForSelector('#waiting-go:not([hidden])', { timeout: 120000 });
  sim.call(unhexOf(sk), 'deposit', { bytes: new Uint8Array(32) }, 0n, new Uint8Array(32), 0n, 0n); // a revoke, from another browser, say
  assert.equal(permitOnChain(sk), null);

  const next = await newTable('cards');
  const mark = countFrom();
  await page.goto(`${BASE}${next.page}?id=${next.id}`);
  await page.waitForSelector('.tile[aria-checked="true"]', { timeout: 30000 });
  await page.waitForFunction(() => /1 transaction/.test(document.querySelector('.tile[aria-checked="true"]').textContent), null, { timeout: 15000 });
  await page.waitForFunction(() => /renew your permit/.test(document.getElementById('summary-approvals')?.textContent ?? ''), null, { timeout: 15000 });
  assert.match(await page.textContent('#summary-permit'), /the most this permit can lose, plus anything you win while it’s live/);
  assert.ok(!/until/.test(await page.textContent('#summary-permit')), 'the tile must not say the risk ends at a time');
  await page.click('#buy-go');
  await tokenAt(page, next);
  assert.deepEqual(since(mark).txs, ['deposit'], 'one approval, and no sit');
  assert.ok(permitOnChain(sk));
  assert.deepEqual(errors, []);
});

test('reconnect at a tNIGHT table (11-10): the network drops mid-round and the page is hard-refreshed; the same seat, nothing asked of the wallet, no second hold, one settle', { skip: !here && 'no compiled cage-v4 checkout', timeout: 180000 }, async () => {
  const { newPage, errors } = await person();
  const t = await newTable('cards');
  const page = await newPage();
  await page.goto(`${BASE}${t.page}?id=${t.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  await sitFromTile(page, 25, { name: 'Ida' });
  const token = await tokenAt(page, t);
  const sk = await keyIn(page);
  await page.waitForSelector('#leave:not([hidden])', { timeout: 30000 });
  const big = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  const seatBefore = big(seatOnChain(sk));
  const balanceBefore = balanceOnChain(sk);
  const mark = countFrom();
  const judgeMark = judgeSent().length;
  // the network drops for 5 s mid-round
  await page.context().setOffline(true);
  await page.waitForFunction(() => /^Connection lost\. Your seat and cards are safe\./.test(document.getElementById('conn-banner')?.textContent?.trim() ?? ''), null, { timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.context().setOffline(false);
  await page.waitForFunction(() => /^Back in\./.test(document.getElementById('conn-banner')?.textContent?.trim() ?? ''), null, { timeout: 15000 });
  // a hard refresh mid-round
  await page.reload();
  await page.waitForSelector('#leave:not([hidden])', { timeout: 30000 });
  assert.equal(await page.evaluate((id) => localStorage.getItem(`hall.seat.${id}`), t.id), token, 'the same seat token: no new seat');
  assert.equal(big(seatOnChain(sk)), seatBefore, 'the seat on chain is the same one');
  assert.equal(balanceOnChain(sk), balanceBefore, 'no second hold on the cage');
  const asked = since(mark);
  assert.equal(asked.tx + asked.signature, 0, `nothing signed or sent by the wallet (connects: ${asked.connect})`);
  assert.deepEqual(asked.txs, []);
  assert.deepEqual(judgeSentSince(judgeMark).filter((c) => /^(sit|seatByJudge)/.test(c)), [], 'the judge seats nobody twice');
  // the round plays out and settles once
  await aRoundSettled(t, token);
  const settles = judgeSentSince(judgeMark).filter((c) => /settle/i.test(c));
  assert.equal(settles.length, 1, `one settle: ${JSON.stringify(judgeSentSince(judgeMark))}`);
  counts['reconnect (tNIGHT)'] = total(asked);
  assert.deepEqual(errors, []);
});

test('a deposit is never offered while a seat binds: the cage page says why', { skip: !here && 'no compiled cage-v4 checkout', timeout: 120000 }, async () => {
  const { newPage } = await person();
  const t = await newTable('cards');
  const page = await newPage();
  await page.goto(`${BASE}${t.page}?id=${t.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  await sitFromTile(page, 25, { name: 'Gus' });
  await tokenAt(page, t);
  const mark = countFrom();
  await page.goto(`${BASE}/wallet?door=1`);
  await page.waitForSelector('.tile[data-amount]', { timeout: 30000 });
  assert.match(await page.textContent(`.tile[data-amount="${25 * 1_000_000}"]`), /no deposit while a seat holds your balance/);
  // L1, item 6: the permit row says how long a permit can run, read from this cage (the simulator deploys with maxGrant 2,592,000).
  await page.waitForFunction(() => /^The judge can seat you .*A permit runs at most 30 days\.$/.test(document.getElementById('my-permit')?.textContent ?? ''), null, { timeout: 30000 });
  assert.equal(total(since(mark)), 0);
});

test('L1 on the page: a permit the cage refuses gets the cage\'s own card, before anything is sent, and nothing is spent', { skip: !here && 'no compiled cage-v4 checkout', timeout: 120000 }, async () => {
  const { newPage, errors } = await person();
  const t = await newTable('cards');
  const page = await newPage();
  await page.goto(`${BASE}${t.page}?id=${t.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  // A grant an hour past maxGrant, as a page clock running a month ahead would make. The real contract refuses it, on the simulator's block clock.
  simHooks = { before: (circuit, _sk, args) => { if (circuit === 'deposit' && args[3] > 0n) args[4] = BigInt(Math.floor(Date.now() / 1000)) + 2_592_000n + 3600n; } };
  try {
    await sitFromTile(page, 25, { name: 'Lia' });
    await page.waitForFunction(() => document.getElementById('waiting-title')?.textContent === 'The cage refused it', null, { timeout: 60000 });
  } finally {
    simHooks = {};
  }
  assert.equal(await page.textContent('#trouble-what'), 'The cage refused it before anything was sent. Nothing was spent.');
  assert.match(await page.textContent('#trouble-cause'), /longer than the cage allows/);
  assert.match(await page.textContent('#trouble-raw'), /failed assert: a permit runs at most maxGrant/, 'the cage\'s own words underneath');
  const sk = await keyIn(page);
  assert.equal(permitOnChain(sk), null, 'no permit was written');
  assert.equal(balanceOnChain(sk), 0n, 'and nothing went in');
  assert.deepEqual(errors, []);
});

test('the drain switch on the page: a buy-in says why and asks the wallet nothing', { skip: !here && 'no compiled cage-v4 checkout', timeout: 120000 }, async () => {
  const { newPage } = await person();
  const t = await newTable('cards');
  const page = await newPage();
  // The Worker's own drain test (v4-worker-api) turns the switch on for real. Here only the door's answer changes, so this page sees it as it would.
  await page.route('**/door', async (r) => {
    if (r.request().method() !== 'GET') return r.continue();
    const res = await r.fetch();
    return r.fulfill({ response: res, json: { ...(await res.json()), draining: true } });
  });
  const mark = countFrom();
  await page.goto(`${BASE}${t.page}?id=${t.id}`);
  await page.waitForSelector(LACE, { timeout: 30000 });
  await page.click(LACE);
  await page.waitForFunction(() => [...document.querySelectorAll('.tile .why')].some((e) => /isn’t taking new tNIGHT seats/.test(e.textContent)), null, { timeout: 30000 });
  assert.equal(await page.isDisabled('#buy-go'), true, 'nothing to press that would ask the wallet');
  const s = since(mark);
  assert.equal(s.tx + s.signature, 0, `no transaction or signature asked: ${JSON.stringify(s)}`);
});
