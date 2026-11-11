// The wallet page in a real browser with pretend wallets. It can't reach a chain, so it covers the picker, connect, balances,
// reconnecting and the stops. The contract code is a stub here; wallet-app/test/live-check.mjs runs the real bundle.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { startServer, stopServers } from './server.js';

const PORT = Number(process.env.WALLET_BROWSER_PORT ?? 8833);
const BASE = `http://127.0.0.1:${PORT}`;
const ADDRESS = 'mn_addr_preprod1qqqqtestaddress';
const JUDGE = 'test-judge-token';
const CAGE = 'd'.repeat(64);
// The Hall's own indexer: this test stands in for its upstream. Down unless a test turns it on.
const UP = PORT + 1;
const HALL_KEY = 'hall-test-project-key';
// What a real indexer answers the page's check with: a block height, and a copy of the cage (a height alone is not enough: 11-09).
const INDEXER_ANSWER = '{"data":{"block":{"height":3300000},"contract":{"address":"' + CAGE + '"}}}';
let hallUp = false;
const upstreamSeen = [];
let upstream;
let browser;

before(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      upstreamSeen.push({ path: url.pathname, key: url.searchParams.get('project_id'), body });
      if (!hallUp || url.searchParams.get('project_id') !== HALL_KEY) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(INDEXER_ANSWER);
    });
  });
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  await startServer(PORT, ['--var', 'WALLET_PAGE:on', '--var', 'TNIGHT_TABLES:on', '--var', `JUDGE_TOKEN:${JUDGE}`, '--var', `CAGE_ADDRESS:${CAGE}`, '--var', 'ALLOW_TEST_CONFIG:1', '--var', `INDEXER_KEY:${HALL_KEY}`, '--var', `INDEXER_UPSTREAM:http://127.0.0.1:${UP}/api/v0`]);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  seenHandGuide(browser); // Tally's Sealed Hand walkthrough already seen, unless a test asks for it ({ guide: true })
}, { timeout: 90000 });

after(async () => {
  await browser?.close();
  await stopServers();
  upstream?.close();
});

const LACE = '[data-wallet="io.lace.wallet"]';
const ONE_AM = '[data-wallet="com.midnight.1am"]';
const PNG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// One injected wallet. `connect` is the body of its connect(), for a wallet that refuses or never answers.
const entry = ({ name = 'lace', rdns = 'io.lace.wallet', apiVersion = '4.0.1', icon = PNG, ...o } = {}) => `{
  name: ${JSON.stringify(name)}, rdns: ${JSON.stringify(rdns)}, apiVersion: ${JSON.stringify(apiVersion)}, icon: ${JSON.stringify(icon)},
  connect: async (network) => {
    window.__connects += 1;
    window.__connected.push(${JSON.stringify(rdns)});
    ${o.connect ?? ''}
    if (${JSON.stringify(o.refuse ?? false)}) throw new Error('Unsupported network ' + network);
    // Each connect() is a new connector. A "restart" (window.__deadBelow) kills every connector made before it, as Lace's background
    // restarting does (11-09): only a fresh connect() gives one that works.
    const gen = (window.__gen = (window.__gen ?? 0) + 1);
    const dead = () => { if ((window.__deadBelow ?? 0) >= gen) throw new Error(window.__SHUTDOWN); };
    return {
      __gen: gen,
      getConnectionStatus: async () => {
        dead();
        window.__statusCalls = (window.__statusCalls ?? 0) + 1;
        return window.__statusCalls <= ${o.disconnectedAtFirst ?? 0} ? { status: 'disconnected' } : { status: 'connected', networkId: ${JSON.stringify(o.network ?? 'preprod')} };
      },
      getUnshieldedAddress: async () => { dead(); return { unshieldedAddress: window.__address ?? ${JSON.stringify(o.address ?? ADDRESS)} }; },
      getDustAddress: async () => ({ dustAddress: 'mn_dust_preprod1qqqqtest' }),
      getUnshieldedBalances: async () => { dead(); return { ['0'.repeat(64)]: window.__night ?? 5000000000n }; }, // a deposit or a withdraw in the stub cage moves it, as a real wallet would
      getDustBalance: async () => ({ balance: ${o.dust ?? '2500000000000000'}n, cap: 25000000000000000000n }),
      getProvingProvider: async () => ({}),
      signData: async (data, options) => {
        window.__signed = { data, options };
        if (window.__refuseSign) throw new Error('declined');
        return { data, signature: 'sig', verifyingKey: 'vk' };
      },
      getConfiguration: async () => ({ networkId: ${JSON.stringify(o.configNetwork ?? 'preprod')}, ${o.noIndexer ? '' : `indexerUri: ${JSON.stringify(o.indexer ?? 'https://indexer.test/graphql?project_id=nightpreprodSECRET')}, indexerWsUri: 'wss://indexer.test/ws', `}${o.noProver ? '' : "proverServerUri: 'http://localhost:6300', "}substrateNodeUri: 'https://node.test' }),
    };
  },
}`;

const installed = (...wallets) => `
  window.__SHUTDOWN = "Remote API with channel 'feature-flags' was shutdown: object can no longer be used";
  window.__connects = 0;
  window.__connected = [];
  window.midnight = {};
  ${wallets.map((w) => `window.midnight[crypto.randomUUID()] = ${entry(w)};`).join('\n')}
`;

const lace = (overrides = {}) => installed(overrides);
const oneAm = (overrides = {}) => ({ name: '1AM', rdns: 'com.midnight.1am', icon: PNG, noProver: true, ...overrides });

// Stands in for the contract code, with a call that plays the script in window.__calls: what each call does in turn.
const STUB_CAGE = `
  export async function openCage({ api }) {
    let sent = false;
    window.__apis = [api];
    return {
      payoutOf: () => ({ bytes: new Uint8Array(32) }),
      useApi(next) { window.__apis.push(next); },
      sent: () => sent,
      async read() { window.__cage ??= { balance: 5000000n }; return { id: 'ab'.repeat(32), judge: '11'.repeat(32), balance: window.__cage.balance, seat: null, table: null, permit: null, bound: true, ours: true, escapeSecs: 1800n }; },
      async findByAddress() { return []; },
      async call(circuit, sk, args) {
        window.__calledArgs = (window.__calledArgs ?? []).concat([circuit]);
        if ((window.__deadBelow ?? 0) >= (window.__apis.at(-1).__gen ?? 1)) throw new Error(window.__SHUTDOWN); // a dead connector, reused
        const step = (window.__script ?? []).shift() ?? 'ok';
        sent = step === 'lost-after-send';
        if (step === 'restarted') { window.__deadBelow = window.__apis.at(-1).__gen; throw new Error(window.__SHUTDOWN); }
        if (step === 'odd') throw new Error('something odd happened');
        if (step.startsWith('lost')) throw Object.assign(new Error('Wallet UI disconnected'), { code: 'Disconnected' });
        if (circuit === 'deposit') window.__cage.balance += args[1];
        return { blockHeight: 42, status: 'SucceedEntirely', txHash: 'cafe' };
      },
    };
  }
`;

/** A saved player in this context, as every tNIGHT visitor has since the Hall asks who first (11-10). */
async function savePlayer(context, name = 'Tester') {
  const saved = await (await fetch(`${BASE}/players`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json();
  await context.addInitScript((t) => { try { localStorage.setItem('hall.player', t); } catch { /* storage off */ } }, saved.token);
  return saved;
}

async function open(script, { indexerOk = true, indexerBody = INDEXER_ANSWER, viewport = { width: 1280, height: 900 }, cage = null, path = '/wallet', player = true } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  if (player) await savePlayer(context); // a seat is never asked for without a valid avatar
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (script) await page.addInitScript(script);
  await page.route('https://indexer.test/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    return indexerOk
      ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: indexerBody })
      : r.fulfill({ status: 410, headers: { 'access-control-allow-origin': '*' }, body: '{"error":"Gone"}' });
  });
  await page.route('http://localhost:6300/**', (r) => r.fulfill({ status: 200, body: '{"status":"ok"}' }));
  await page.route('**/cage-config.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: cage ? 'cage #3' : 'cage #2', writable: !!cage, network: 'preprod', address: 'b38a'.repeat(16), escapeSecs: 900, clockSlack: 300, seats: 6 }) }));
  if (cage) await page.route('**/wallet-app/cage.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: cage }));
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}${path}`);
  return { page, errors, context };
}

test('the page answers when on, with its own headers, and the Hall keeps its own', async () => {
  const res = await fetch(`${BASE}/wallet`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /'wasm-unsafe-eval'/);
  assert.match(csp, /connect-src 'self' https: wss: http:\/\/localhost:6300/);
  assert.match(csp, /img-src 'self' data: https: chrome-extension: moz-extension:/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' https:\/\/static\.cloudflareinsights\.com chrome-extension: moz-extension:/);
  assert.ok(!(await (await fetch(`${BASE}/`)).headers.get('content-security-policy')).includes('wasm-unsafe-eval'), 'the Hall keeps its own headers');
});

test('connect shows the address, tNIGHT and tDUST, with no secret on the page', async () => {
  const { page, errors, context } = await open(lace());
  await page.click(LACE);
  await page.waitForSelector('#wallet:not([hidden])');
  await page.waitForFunction(() => document.querySelector('[data-check="Indexer"]'));
  assert.equal(await page.textContent('#address'), ADDRESS);
  assert.equal(await page.textContent('#night'), '5,000 tNIGHT');
  assert.equal(await page.textContent('#dust'), '2.5 tDUST');
  assert.equal(await page.evaluate(() => window.__connects), 1);
  const text = await page.evaluate(() => document.body.textContent);
  assert.ok(!text.includes('SECRET'), 'project id hidden');
  assert.match(await page.textContent('[data-check="Indexer"]'), /indexer\.test/);
  assert.match(await page.textContent('[data-check="Proof server"]'), /Running/);
  assert.equal(await page.isVisible('#indexer-form'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('cage #2 is read-only: every button that sends is off', async () => {
  const { page, context } = await open(lace());
  await page.click(LACE);
  await page.waitForSelector('[data-check="Contract code"]');
  await page.evaluate(() => { document.getElementById('my-cage').open = true; });
  await page.waitForSelector('#read-only:not([hidden])');
  assert.match(await page.textContent('#read-only'), /Read-only/);
  for (const id of ['buy-go', 'stand', 'withdraw']) assert.equal(await page.isDisabled(`#${id}`), true, id);
  assert.match(await page.textContent('#buy-go-why'), /read-only/);
  await context.close();
});

test('a dead indexer asks for a project id and the balances still show', async () => {
  const { page, context } = await open(lace(), { indexerOk: false });
  await page.click(LACE);
  await page.waitForSelector('#indexer-form:not([hidden])');
  assert.equal(await page.textContent('#night'), '5,000 tNIGHT');
  assert.match(await page.textContent('[data-check="Indexer"]'), /didn’t answer \(HTTP 410\)/);
  await context.close();
});

for (const [name, overrides] of [
  ['Lace on another network', { network: 'mainnet' }],
  ['an address not on preprod', { address: 'mn_addr1qqqq' }],
  ['settings on another network', { configNetwork: 'mainnet' }],
  ['a mainnet indexer', { indexer: 'https://midnight-mainnet.blockfrost.io/api/v0' }],
]) {
  test(`stops on ${name}`, async () => {
    const { page, context } = await open(lace(overrides));
    await page.click(LACE);
    await page.waitForSelector('#stop:not([hidden])');
    assert.match(await page.textContent('#stop'), /Stopped/);
    assert.equal(await page.isDisabled('#buy-go'), true);
    await context.close();
  });
}

test('a wallet that refuses the network says so and lets you retry', async () => {
  const { page, context } = await open(lace({ refuse: true }));
  await page.click(LACE);
  await page.waitForFunction(() => /Set Lace to Preprod/.test(document.getElementById('connect-status').textContent));
  assert.equal(await page.isDisabled(LACE), false);
  await context.close();
});

test('no wallet: says what to do', async () => {
  const { page, context } = await open(null);
  await page.waitForFunction(() => /No Midnight wallet here/.test(document.getElementById('connect-status').textContent), null, { timeout: 15000 });
  assert.equal(await page.locator('.wallet-choice').count(), 0);
  await context.close();
});

// ---------- the picker ----------

test('every wallet shows with its name and icon, and 1AM leads as the tested, recommended one (11-08 pass #15)', async () => {
  const { page, errors, context } = await open(installed(oneAm(), {}, { name: 'Odd', rdns: 'xyz.odd', icon: 'javascript:alert(1)' }, { name: 'Old', rdns: 'xyz.old', apiVersion: '3.0.0' }));
  await page.waitForSelector(LACE);
  assert.deepEqual(await page.$$eval('.wallet-choice', (b) => b.map((x) => x.dataset.wallet)), ['com.midnight.1am', 'io.lace.wallet', 'xyz.odd', 'xyz.old']);
  assert.match(await page.textContent(LACE), /Lace.*Works, but can be fussy.*connector 4\.0\.1/s);
  assert.match(await page.textContent(ONE_AM), /1AM.*Tested · recommended · fastest/s);
  assert.match(await page.getAttribute(`${LACE} img`, 'src'), /^data:image\/gif/);
  await page.waitForFunction(() => { const i = document.querySelector('[data-wallet="com.midnight.1am"] img'); return i?.complete && i.naturalWidth > 0; });
  assert.equal(await page.locator('[data-wallet="xyz.odd"] img').count(), 0, 'a bad icon address is never loaded');
  assert.equal(await page.isDisabled('[data-wallet="xyz.old"]'), true);
  assert.match(await page.textContent('[data-wallet="xyz.old"]'), /needs version 4/);
  assert.equal(await page.evaluate(() => window.__connects), 0, 'nothing connects before a click');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a name with markup in it stays text', async () => {
  const { page, context } = await open(installed({ name: '<img src=x onerror="window.__xss=1">', rdns: 'xyz.bad' }));
  await page.waitForSelector('[data-wallet="xyz.bad"]');
  assert.match(await page.textContent('[data-wallet="xyz.bad"] .wallet-name'), /<img/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await context.close();
});

test('a wallet that injects late still appears', async () => {
  const { page, context } = await open(`${installed({})}
    setTimeout(() => { window.midnight[crypto.randomUUID()] = ${entry(oneAm())}; }, 1200);`);
  await page.waitForSelector(ONE_AM, { timeout: 5000 });
  assert.equal(await page.locator('.wallet-choice').count(), 2);
  await context.close();
});

test('connects only the wallet you picked, runs on its own prover, and remembers it', async () => {
  const { page, context } = await open(installed({}, oneAm()));
  await page.click(ONE_AM);
  await page.waitForSelector('#wallet:not([hidden])');
  await page.waitForSelector('[data-check="Proof server"]');
  assert.deepEqual(await page.evaluate(() => window.__connected), ['com.midnight.1am']);
  assert.equal(await page.isVisible('#wallets'), false);
  assert.match(await page.textContent('[data-check="Wallet"]'), /1AM \(com\.midnight\.1am\), connector 4\.0\.1/);
  assert.match(await page.textContent('[data-check="Proving"]'), /1AM can prove/);
  assert.match(await page.textContent('[data-check="Proof server"]'), /1AM chooses where to prove/);
  assert.equal(await page.evaluate(() => localStorage.getItem('cage.wallet')), 'com.midnight.1am');
  await context.close();
});

test('a wallet that says disconnected for a moment after connect is not given up on', async () => {
  const { page, context } = await open(installed(oneAm({ disconnectedAtFirst: 2 })));
  await page.click(ONE_AM);
  await page.waitForSelector('#wallet:not([hidden])');
  assert.equal(await page.isVisible('#stop'), false);
  await context.close();
});

// ---------- reconnecting on load ----------

async function connectOnce(page, selector = LACE) {
  await page.click(selector);
  await page.waitForSelector('[data-check="Contract code"]');
}

test('a returning player reconnects with no click, to the wallet they chose', async () => {
  const { page, errors, context } = await open(installed({}, oneAm()));
  await connectOnce(page, ONE_AM);
  await page.reload();
  await page.waitForSelector('#wallet:not([hidden])');
  assert.deepEqual(await page.evaluate(() => window.__connected), ['com.midnight.1am']);
  assert.equal(await page.textContent('#address'), ADDRESS);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a wallet that injects late is still reconnected', async () => {
  const { page, context } = await open(`if (location.search !== '?late') { ${installed({})} } else { window.__connects = 0; window.__connected = []; setTimeout(() => { window.midnight = { a: ${entry({})} }; }, 1500); }`);
  await connectOnce(page);
  await page.goto(`${BASE}/wallet?late`);
  assert.equal(await page.isVisible('#wallet'), false);
  await page.waitForSelector('#wallet:not([hidden])', { timeout: 6000 });
  assert.equal(await page.evaluate(() => window.__connects), 1);
  await context.close();
});

test('a wallet that no longer approves: the picker stays, and the next load doesn’t ask again', async () => {
  const { page, context } = await open(lace());
  await connectOnce(page);
  await page.addInitScript(`for (const w of Object.values(window.midnight)) Object.defineProperty(w, 'connect', { value: async () => { window.__connects += 1; throw Object.assign(new Error('Access to wallet api denied'), { code: 'Rejected' }); } });`);
  await page.reload();
  await page.waitForFunction(() => /Couldn’t reconnect to Lace/.test(document.getElementById('connect-status').textContent));
  assert.equal(await page.isVisible(LACE), true);
  assert.equal(await page.isDisabled(LACE), false);
  assert.equal(await page.evaluate(() => window.__connects), 1);
  await page.reload();
  await page.waitForSelector(LACE);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__connects), 0, 'no second ask');
  await context.close();
});

test('a wallet that never answers falls back to the button, and a click still works', async () => {
  const { page, context } = await open(lace());
  await connectOnce(page);
  await page.addInitScript(`window.__hang = true; for (const w of Object.values(window.midnight)) { const real = w.connect; Object.defineProperty(w, 'connect', { value: (n) => window.__hang ? (window.__hang = false, new Promise(() => {})) : real(n) }); }`);
  await page.reload();
  await page.waitForFunction(() => /Reconnecting to Lace/.test(document.getElementById('connect-status').textContent));
  assert.equal(await page.isDisabled(LACE), false, 'the button works while it waits');
  await page.waitForFunction(() => /didn’t answer/.test(document.getElementById('connect-status').textContent), null, { timeout: 14000 });
  await page.click(LACE);
  await page.waitForSelector('#wallet:not([hidden])');
  await context.close();
});

test('an approval that comes after the wait still connects', async () => {
  const { page, context } = await open(lace());
  await connectOnce(page);
  await page.addInitScript(`for (const w of Object.values(window.midnight)) { const real = w.connect; Object.defineProperty(w, 'connect', { value: (n) => new Promise((ok) => setTimeout(ok, 11500)).then(() => real(n)) }); }`);
  await page.reload();
  await page.waitForFunction(() => /didn’t answer/.test(document.getElementById('connect-status').textContent), null, { timeout: 14000 });
  await page.waitForSelector('#wallet:not([hidden])', { timeout: 5000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('cage.wallet.auto')), '1');
  await context.close();
});

test('reconnecting still stops on anything not preprod, and turns itself off', async () => {
  const { page, context } = await open(lace());
  await connectOnce(page);
  await page.addInitScript(`window.__address = 'mn_addr1qqqq';`);
  await page.reload();
  await page.waitForSelector('#stop:not([hidden])');
  assert.equal(await page.isVisible('#tiles'), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('cage.wallet.auto')), null);
  await context.close();
});

test('a first connect that stops isn’t remembered for next time', async () => {
  const { page, context } = await open(lace({ network: 'mainnet' }));
  await page.click(LACE);
  await page.waitForSelector('#stop:not([hidden])');
  assert.equal(await page.evaluate(() => localStorage.getItem('cage.wallet.auto')), null);
  await context.close();
});

test('Use another wallet stops the reconnecting and shows the picker', async () => {
  const { page, context } = await open(installed({}, oneAm()));
  await connectOnce(page);
  await page.click('#switch-wallet');
  await page.waitForLoadState('load');
  await page.waitForSelector(ONE_AM);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__connects), 0);
  assert.match(await page.textContent(LACE), /last used/);
  await context.close();
});

// ---------- a wallet that never answers, as after turning the extension off and on ----------

// The first connect() hangs until window.__release() is called. Later ones work.
const HANG_FIRST = `
  window.__hangs = 0;
  for (const w of Object.values(window.midnight)) {
    const real = w.connect;
    Object.defineProperty(w, 'connect', { value: (n) => {
      window.__hangs += 1;
      return window.__hangs === 1 ? new Promise((ok) => { window.__release = () => ok(real(n)); }) : real(n);
    } });
  }
`;
const status = (page) => page.textContent('#connect-status');
const noAnswer = (page) => page.waitForFunction(() => /didn’t answer — open Lace, unlock it, and try again/.test(document.getElementById('connect-status').textContent), null, { timeout: 25000 });

test('a click that gets no answer says what to do after 20 seconds, and Try again works', async () => {
  const { page, errors, context } = await open(`${lace()}${HANG_FIRST}`);
  await page.waitForSelector(LACE);
  const started = Date.now();
  await page.click(LACE);
  assert.match(await status(page), /Approve in Lace/);
  assert.equal(await page.isDisabled(LACE), true);
  assert.equal(await page.isVisible('#retry-connect'), false);
  await noAnswer(page);
  const waited = Date.now() - started;
  assert.ok(waited > 18000 && waited < 23000, `${waited} ms`);
  assert.match(await status(page), /refresh this page/);
  assert.equal(await page.isVisible('#retry-connect'), true);
  assert.equal(await page.isDisabled(LACE), false, 'no stuck button');
  await page.click('#retry-connect');
  await page.waitForSelector('#wallet:not([hidden])');
  assert.equal(await page.isVisible('#retry-connect'), false);
  assert.equal(await status(page), '');
  assert.equal(await page.isVisible('#stop'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an approval that comes after the 20 seconds still connects', async () => {
  const { page, context } = await open(`${lace()}${HANG_FIRST}`);
  await page.click(LACE);
  await noAnswer(page);
  await page.evaluate(() => window.__release());
  await page.waitForSelector('#wallet:not([hidden])');
  assert.equal(await page.isVisible('#retry-connect'), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('cage.wallet.auto')), '1');
  await context.close();
});

test('after Try again, both answers arriving connect only once', async () => {
  const { page, context } = await open(`${lace()}${HANG_FIRST}`);
  await page.click(LACE);
  await noAnswer(page);
  await page.click('#retry-connect');
  await page.waitForSelector('#wallet:not([hidden])');
  await page.evaluate(() => window.__release());
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-check="Wallet"]').count(), 1);
  assert.equal(await page.isVisible('#stop'), false);
  await context.close();
});

test('an old answer that turns out broken leaves the page able to take the next one', async () => {
  const { page, context } = await open(`${lace()}
    window.__answers = [];
    for (const w of Object.values(window.midnight)) {
      const real = w.connect;
      Object.defineProperty(w, 'connect', { value: (n) => new Promise((ok) => { window.__answers.push(async (broken) => {
        const api = await real(n);
        ok(broken ? { ...api, getUnshieldedAddress: async () => { throw new Error('account gone'); } } : api);
      }); }) });
    }`);
  await page.click(LACE);
  await noAnswer(page);
  await page.click('#retry-connect');
  await page.evaluate(() => window.__answers[0](true));
  await page.waitForFunction(() => /account gone/.test(document.getElementById('connect-status').textContent));
  assert.equal(await page.isDisabled(LACE), false);
  await page.evaluate(() => window.__answers[1](false));
  await page.waitForSelector('#wallet:not([hidden])');
  await context.close();
});

test('choosing another wallet ends the wait for the first', async () => {
  const { page, context } = await open(`${installed({}, oneAm())}${HANG_FIRST}`);
  await page.click(LACE);
  await noAnswer(page);
  await page.click(ONE_AM);
  await page.waitForSelector('#wallet:not([hidden])');
  await page.evaluate(() => window.__release());
  await page.waitForTimeout(300);
  assert.match(await page.textContent('[data-check="Wallet"]'), /1AM/);
  assert.equal(await page.evaluate(() => localStorage.getItem('cage.wallet')), 'com.midnight.1am');
  await context.close();
});

test('a wallet that connects and then stops answering is treated the same', async () => {
  const { page, context } = await open(`${lace()}
    for (const w of Object.values(window.midnight)) {
      const real = w.connect;
      Object.defineProperty(w, 'connect', { value: async (n) => {
        window.__tries = (window.__tries ?? 0) + 1;
        const api = await real(n);
        return window.__tries === 1 ? { ...api, getUnshieldedAddress: () => new Promise(() => {}) } : api;
      } });
    }`);
  await page.click(LACE);
  await noAnswer(page);
  assert.equal(await page.isVisible('#wallet'), false);
  assert.equal(await page.isVisible('#retry-connect'), true);
  await page.click('#retry-connect');
  await page.waitForSelector('#wallet:not([hidden])');
  await context.close();
});

test('a balance that never answers says so, and the rest of the page carries on', async () => {
  const { page, context } = await open(`${lace()}
    for (const w of Object.values(window.midnight)) {
      const real = w.connect;
      Object.defineProperty(w, 'connect', { value: async (n) => ({ ...(await real(n)), getDustBalance: () => new Promise(() => {}) }) });
    }`);
  await page.click(LACE);
  await page.waitForFunction(() => /didn’t answer/.test(document.getElementById('dust').textContent), null, { timeout: 25000 });
  assert.equal(await page.textContent('#night'), '5,000 tNIGHT');
  await page.waitForSelector('[data-check="Contract code"]');
  await context.close();
});

test('reconnecting on load that gets no answer offers Try again too', async () => {
  const { page, context } = await open(lace());
  await connectOnce(page);
  await page.addInitScript(HANG_FIRST);
  await page.reload();
  await noAnswer(page);
  assert.equal(await page.isVisible('#retry-connect'), true);
  await page.click('#retry-connect');
  await page.waitForSelector('#wallet:not([hidden])');
  await context.close();
});

test('Reconnect mid-call that gets no answer can be clicked again, and runs the call once', async () => {
  const { page, context } = await open(installed(oneAm()), { cage: STUB_CAGE });
  await page.click(ONE_AM);
  await tilesUp(page);
  await page.fill('#bring-name', 'The owner');
  await page.evaluate(() => {
    window.__script = ['lost'];
    const w = Object.values(window.midnight)[0];
    const real = w.connect.bind(w);
    window.__hangs = 0;
    Object.defineProperty(w, 'connect', { value: (n) => {
      window.__hangs += 1;
      return window.__hangs === 1 ? new Promise((ok) => { window.__release = () => ok(real(n)); }) : real(n);
    } });
  });
  await page.click('#buy-go');
  await page.waitForSelector('#reconnect:not([hidden])');
  await page.click('#reconnect');
  await page.waitForSelector('#waiting.no-answer:not([hidden])', { timeout: 25000 });
  assert.match(await page.textContent('#trouble-steps'), /Press Reconnect and try again/);
  assert.equal(await page.isDisabled('#reconnect'), false);
  await page.click('#reconnect');
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('log').textContent));
  await page.evaluate(() => window.__release());
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit', 'deposit']);
  await context.close();
});

// ---------- a wallet that drops the page halfway ----------

async function atCage(script, steps) {
  const opened = await open(script, { cage: STUB_CAGE });
  await opened.page.click(ONE_AM);
  await tilesUp(opened.page);
  await opened.page.fill('#bring-name', 'The owner');
  await opened.page.evaluate((s) => { window.__script = s; }, steps);
  return opened;
}

test('dropped before anything was sent: reconnect from a click, and the same call runs again', async () => {
  const { page, context } = await atCage(installed(oneAm()), ['lost']);
  await page.click('#buy-go');
  await page.waitForSelector('#reconnect:not([hidden])');
  assert.match(await page.textContent('#log'), /paused: 1AM dropped the connection\. Nothing was sent/);
  assert.match(await page.textContent('#waiting-title'), /1AM dropped this page/);
  assert.equal(await page.isDisabled('#buy-go'), true, 'nothing else can run meanwhile');
  assert.equal(await page.evaluate(() => window.__connects), 1);
  await page.click('#reconnect');
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('log').textContent));
  assert.equal(await page.evaluate(() => window.__connects), 2);
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit', 'deposit']);
  assert.equal(await page.evaluate(() => window.__apis.length), 2, 'the cage uses the new connection');
  assert.equal(await page.isVisible('#reconnect'), false);
  await signedAtTheDoor(page);
  await stepIs(page, 'done');
  assert.equal(await page.isDisabled('#buy-go'), false);
  await context.close();
});

// ---------- a wallet that restarts under the page (11-09, Lace on staging) ----------

async function atCageLace(steps) {
  const opened = await open(lace(), { cage: STUB_CAGE });
  await opened.page.click(LACE);
  await tilesUp(opened.page);
  await opened.page.fill('#bring-name', 'The owner');
  await opened.page.evaluate((s) => { window.__script = s; }, steps);
  return opened;
}

test('Lace restarts before anything is sent: a fresh connector and the same call once more, by itself', async () => {
  const { page, context, errors } = await atCageLace(['restarted']);
  await page.click('#buy-go');
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('log').textContent));
  assert.match(await page.textContent('#log'), /Lace restarted itself\. Nothing was sent\. Getting a fresh link to Lace and trying once more/);
  assert.equal(await page.evaluate(() => window.__connects), 2, 'connect() asked afresh');
  assert.equal(await page.evaluate(() => window.__apis.length), 2, 'the cage uses the new connector');
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit', 'deposit']);
  assert.equal(await page.isVisible('#reconnect'), false, 'no window: it recovered by itself');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Lace restarts again during the retry: plain words, the raw error small, and Try again gets a fresh connector', async () => {
  const { page, context } = await atCageLace(['restarted', 'restarted']);
  await page.click('#buy-go');
  await page.waitForSelector('#reconnect:not([hidden])');
  assert.match(await page.textContent('#waiting-title'), /Lace restarted itself/);
  assert.equal((await page.textContent('#trouble-what')).trim(), 'Lace restarted itself. Click Try again.');
  assert.match(await page.textContent('#trouble-raw'), /can no longer be used/);
  assert.equal((await page.textContent('#reconnect')).trim(), 'Try again');
  assert.equal(await page.isVisible('#trouble-retry'), false, 'one Try again button, not two');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/lace-restarted-window.png` });
  const before = await page.evaluate(() => window.__connects); // 2, or 3 when the balance read after the failure already got a fresh one quietly
  assert.ok(before >= 2, String(before));
  await page.click('#reconnect');
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('log').textContent));
  assert.equal(await page.evaluate(() => window.__connects), before + 1, 'Try again asked connect() afresh');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/lace-restarted-recovered.png` });
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit', 'deposit', 'deposit']);
  await context.close();
});

test('Try again after any failure asks the wallet for a fresh connector before the same step', async () => {
  const { page, context } = await atCageLace(['odd']);
  await page.click('#buy-go');
  await page.waitForSelector('#trouble-retry:not([hidden])');
  assert.equal(await page.evaluate(() => window.__connects), 1);
  await page.evaluate(() => { window.__deadBelow = window.__gen; }); // Lace restarts while the window is up: the old connector is dead
  await page.click('#trouble-retry');
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('log').textContent));
  assert.equal(await page.evaluate(() => window.__connects), 2, 'a fresh connect() before the step');
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit', 'deposit']);
  await context.close();
});

test('Lace restarts between calls: the next read of the wallet gets a fresh connector quietly', async () => {
  const { page, context } = await open(lace(), { cage: STUB_CAGE });
  await page.click(LACE);
  await tilesUp(page);
  await page.evaluate(() => { window.__deadBelow = window.__gen; });
  await page.click('#refresh');
  await page.waitForFunction(() => /A fresh link to Lace/.test(document.getElementById('log').textContent));
  assert.equal(await page.evaluate(() => window.__connects), 2);
  assert.doesNotMatch(await page.textContent('body'), /couldn’t say/);
  assert.equal(await page.isVisible('#waiting'), false);
  await context.close();
});

test('Lace restarts while connecting: asked once more by itself, then plain words', async () => {
  const { page, context } = await open(installed({ connect: 'if (window.__connects <= (window.__failConnects ?? 0)) throw new Error(window.__SHUTDOWN);' }), { cage: STUB_CAGE });
  await page.evaluate(() => { window.__failConnects = 1; });
  await page.click(LACE);
  await tilesUp(page);
  assert.equal(await page.evaluate(() => window.__connects), 2, 'one automatic second connect');
  await page.evaluate(() => { localStorage.clear(); });
  const second = await open(installed({ connect: 'if (window.__connects <= 5) throw new Error(window.__SHUTDOWN);' }), { cage: STUB_CAGE });
  await second.page.click(LACE);
  await second.page.waitForFunction(() => /Lace restarted itself\. Click Try again\./.test(document.body.textContent));
  assert.equal(await second.page.evaluate(() => window.__connects), 2, 'only once by itself');
  await second.context.close();
  await context.close();
});

test('dropped after sending: it never sends again', async () => {
  const { page, context } = await atCage(installed(oneAm()), ['lost-after-send']);
  await page.click('#buy-go');
  await page.waitForFunction(() => /won’t send it again/.test(document.getElementById('log').textContent));
  assert.equal(await page.isVisible('#reconnect'), false);
  assert.match(await page.textContent('#waiting-title'), /1AM dropped this page after sending/);
  assert.equal(await page.isVisible('#trouble-retry'), false, 'no Try again: it may have landed');
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit']);
  await context.close();
});

test('a wallet that comes back on another address stops the page and sends nothing', async () => {
  const { page, context } = await atCage(installed(oneAm()), ['lost']);
  await page.click('#buy-go');
  await page.waitForSelector('#reconnect:not([hidden])');
  await page.evaluate(() => { window.__address = 'mn_addr_preprod1qqqqsomeoneelse'; });
  await page.click('#reconnect');
  await page.waitForSelector('#stop:not([hidden])');
  assert.match(await page.textContent('#stop'), /different address/);
  assert.deepEqual(await page.evaluate(() => window.__calledArgs), ['deposit']);
  await context.close();
});

test('fits a phone with no sideways scroll', async () => {
  const { page, context } = await open(lace(), { viewport: { width: 390, height: 844 }, cage: STUB_CAGE });
  await page.click(LACE);
  await page.waitForSelector('.tile[data-amount]');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 0, `${over}px over`);
  await page.evaluate(() => { document.getElementById('checks-box').open = true; });
  const row = await page.$eval('[data-check="Indexer"] span', (el) => el.getBoundingClientRect());
  assert.ok(row.width > 250, `a check's words take the row, not a 22 px column: ${Math.round(row.width)} px`);
  const mark = await page.$eval('[data-check="Indexer"]', (el) => getComputedStyle(el, '::before').content);
  assert.match(mark, /✓/);
  await context.close();
});

// ---------- Bring tNIGHT: from the Hall's button, through the wallet, to a seat ----------

// The contract code, standing in for the chain: deposit and sit change what read() answers.
const BRING_CAGE = `
  export async function openCage() {
    window.__cage ??= { balance: 0n, seat: null, table: null };
    return {
      payoutOf: () => ({ bytes: new Uint8Array(32) }),
      useApi() {},
      sent: () => false,
      async read() { return { id: 'ab'.repeat(32), judge: '11'.repeat(32), balance: window.__cage.balance, seat: window.__cage.seat, table: window.__cage.table, permit: window.__cage.permit ?? null, bound: true, ours: true, escapeSecs: 1800n }; },
      async findByAddress() { return []; },
      async call(circuit, sk, args, progress = () => {}) {
        window.__calledArgs = (window.__calledArgs ?? []).concat([[circuit, ...args.map(String)]]);
        if (window.__askFirst) { progress('Approve in Lace.'); await new Promise((r) => setTimeout(r, window.__askFirst)); } // the wallet's window, held open so a test can read the line
        progress('Lace is sending it.');
        if (window.__refuse) throw new Error(window.__refuse);
        if (circuit === 'deposit') {
          window.__cage.balance += args[1];
          window.__night = (window.__night ?? 5000000000n) - args[1];
          if (args[3] > 0n) window.__cage.permit = { judge: '11'.repeat(32), cap: args[3], until: args[4], floor: window.__cage.balance > args[3] ? window.__cage.balance - args[3] : 0n };
        }
        if (circuit === 'stand') { window.__cage.seat.standing = true; window.__cage.seat.standAt = args[1]; window.__cage.permit = null; }
        if (circuit === 'sit') {
          const heartbeat = BigInt(Math.floor(Date.now() / 1000));
          window.__cage.seat = { table: args[0], epoch: 1n, atRisk: args[1], standing: false };
          window.__cage.table = { epoch: 1n, seated: 1n, heartbeat };
        }
        if (circuit === 'withdraw') { window.__cage.balance -= args[0]; window.__night = (window.__night ?? 5000000000n) + args[0]; }
        return { blockHeight: 42, status: 'SucceedEntirely', txHash: 'cafe' };
      },
    };
  }
`;
const CAGE_ID = 'ab'.repeat(32);
const tnightTable = async (body = {}) => (await (await fetch(`${BASE}/tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tnight: true, lobbySeconds: 0, stakes: { ante: 1 }, ...body }) })).json());
const judge = (id, op, body) => fetch(`${BASE}/judge/tables/${id}/${op}`, { method: 'POST', headers: { authorization: `Bearer ${JUDGE}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const stepIs = async (page, step) => page.waitForSelector(`[data-step="${step}"].now`, { timeout: 15000 });
// SHOTS=<dir> saves the pages the 11-09 tests reach (and SHOT_W=390 runs those at phone width): pictures for the report, nothing asserted.
const SHOT_W = process.env.SHOT_W === '390';
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}-${SHOT_W ? 390 : 1280}.png`, fullPage: false }).catch(() => {}) : null);
const tilesUp = (page) => page.waitForSelector('.tile[data-amount]', { timeout: 15000 });
const tile = (n) => `.tile[data-amount="${n * 1_000_000}"]`;
const text = async (page, sel) => (await page.innerText(sel)).replace(/\s+/g, ' ').trim();
const calls = (page) => page.evaluate(() => window.__calledArgs ?? []);
const checkRow = async (page, name) => (await page.textContent(`[data-check="${name}"]`)).replace(/\s+/g, ' ').trim();

const judgeHeaders = { authorization: `Bearer ${JUDGE}`, 'content-type': 'application/json' };
/** The judge answering whoever is waiting at the door. */
async function answerDoor(ok = true, reason) {
  const { doors } = await (await fetch(`${BASE}/judge/tables`, { headers: judgeHeaders })).json();
  const waiting = doors.filter((d) => d.status === 'pending');
  for (const d of waiting) await fetch(`${BASE}/judge/door`, { method: 'POST', headers: judgeHeaders, body: JSON.stringify({ key: d.key, ok, reason, balanceStar: '5000000' }) });
  return waiting.at(-1);
}
/** A session already signed and verified at the door, as a line for the page's start. */
async function signedIn(cageId = CAGE_ID, name = 'The owner') {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const { token } = await (await fetch(`${BASE}/door`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cageId, payout: '0'.repeat(64), expires, verifyingKey: 'vk', signature: 'sig', name, kind: 'human' }) })).json();
  await answerDoor();
  return `localStorage.setItem('cage.door', ${JSON.stringify(token)});`;
}
/** Waits for the door's signature to reach the judge, answers it, and waits for the plan to move on. */
async function signedAtTheDoor(page, ok = true, reason) {
  await page.waitForFunction(() => /checking/.test(document.getElementById('waiting-line').textContent), null, { timeout: 15000 });
  return answerDoor(ok, reason);
}

test('Bring tNIGHT: one tile, one button: the deposit, the door’s signature and the seat run as one plan, then the judge', { timeout: 90000 }, async () => {
  const { id, state } = await tnightTable();
  const { page, errors, context } = await open(lace(), { cage: BRING_CAGE, path: `/wallet?table=${id}`, player: false }); // no saved player: the name wall, and no avatar
  assert.equal(await page.textContent('#bring-title'), `Bring tNIGHT to table ${state.cage.table}`);
  await stepIs(page, 'wallet');
  assert.equal(await page.isDisabled('#buy-go'), true);
  assert.equal(await text(page, '#buy-go-why'), 'Choose your wallet first.');
  await page.click(LACE);
  await stepIs(page, 'buy');
  await tilesUp(page);

  // The tiles: whole buy-ins, what each lasts and costs. Nothing in the cage yet, so every one is a deposit, a signature and a seat.
  assert.deepEqual(await page.$$eval('.tile', (b) => b.map((x) => x.dataset.amount)), ['25000000', '50000000', '100000000', '250000000', 'other']);
  assert.equal(await page.getAttribute(tile(50), 'aria-checked'), 'true', '50 is picked for them');
  assert.match(await text(page, tile(50)), /50 tNIGHT ≈ 25 hands · 1 transaction \+ 1 signature/, 'the deposit carrying the permit, and the signature. The judge seats them');
  assert.match(await text(page, tile(250)), /≈ 125 hands/);
  assert.equal(await page.$('.tile[disabled]'), null, 'the wallet holds 5,000, so every tile is open');

  // The summary before the button: table, buy-in, approvals, time, and where the money comes back to.
  assert.match(await text(page, '#summary-table'), new RegExp(`Table ${state.cage.table} · Sealed Hand`));
  assert.match(await text(page, '#summary-amount'), /50 tNIGHT at risk: 50 from your wallet/);
  assert.match(await text(page, '#summary-approvals'), /^1 in Lace to put 50 in the cage, then one signature so you can play without pop-ups\.$/);
  assert.match(await text(page, '#summary-permit'), /up to 50 tNIGHT at risk\. That’s the most this permit can lose, plus anything you win while it’s live/);
  assert.match(await text(page, '#summary-time'), /About \d+ minutes/);
  assert.equal(await text(page, '#summary-payout'), ADDRESS);
  assert.equal(await text(page, '#buy-go'), 'Sit with 50 tNIGHT');
  assert.equal(await page.isDisabled('#buy-go'), true);
  assert.equal(await text(page, '#buy-go-why'), 'Type the name you’ll go by at the tables.');
  await page.click(tile(25));
  assert.equal(await text(page, '#buy-go'), 'Sit with 25 tNIGHT');
  await page.fill('#bring-name', 'The owner');
  assert.equal(await page.isDisabled('#buy-go'), false);
  assert.equal(await text(page, '#buy-go-why'), '');

  // One press. The window says what it will take, up front.
  await page.click('#buy-go');
  await page.waitForSelector('#waiting:not([hidden])');
  assert.equal(await text(page, '#waiting-title'), `Sitting at table ${state.cage.table} with 25 tNIGHT`);
  assert.match(await text(page, '#waiting-intro'), /^1 transaction: 1 prompt in Lace, and one signature\. About \d+ minutes\.$/, 'the deposit; the signature');
  assert.equal(await page.getAttribute('#buy-go', 'aria-busy'), 'true');

  // No avatar yet (no saved player here): asked once, before the door signs. Nothing is sent without one.
  await page.waitForSelector('#look-ask');
  assert.equal((await text(page, '#look-ask-title')), 'Pick an avatar');
  await page.click('#look-ask [data-look="adventurer"]');
  await page.click('#look-ask-ok');

  // The signature comes after the deposit and before the seat: no seat goes on chain that couldn't be claimed.
  const waiting = await signedAtTheDoor(page);
  const signed = await page.evaluate(() => window.__signed);
  assert.deepEqual((await calls(page)).map((c) => c[0]), ['deposit'], 'the deposit went first, and nothing else yet');
  assert.equal(signed.data, waiting.message);
  assert.match(signed.data, new RegExp(`^sealed-hand:door:v1\\|${CAGE}\\|${CAGE_ID}\\|${'0'.repeat(64)}\\|\\d+$`), 'this cage, this player key, this wallet, until a time');
  assert.deepEqual(signed.options, { encoding: 'text', keyType: 'unshielded' });
  assert.equal(waiting.verifyingKey, 'vk');

  await stepIs(page, 'seat');
  const made = await calls(page);
  assert.deepEqual(made.map((c) => c[0]), ['deposit'], 'no sit: the judge seats them');
  assert.equal(made[0][2], '25000000');
  assert.equal(made[0][4], '25000000', 'the cap is the tile');
  assert.ok(Number(made[0][5]) > Date.now() / 1000 + 11 * 3600, 'for about the door\'s 12 hours');
  assert.match(await text(page, '#seat-status'), /judge is seating you\. Nothing to approve/);
  assert.match(await text(page, '#stages'), /The judge is proving your seat/);
  await page.waitForTimeout(800);
  assert.ok(await page.evaluate(() => document.getElementById('trouble').hidden), 'one claim, not two: no false refusal in the window');
  assert.doesNotMatch(await page.textContent('#waiting-title'), /didn’t take/);
  assert.equal((await (await fetch(`${BASE}/tables/${id}`)).json()).cage.waiting.length, 1, 'one claim waiting for the judge');

  // Refreshing while the judge reads the cage picks up where it was.
  await page.waitForFunction((key) => !!localStorage.getItem(key), `cage.claim.${id}`);
  await page.reload();
  await stepIs(page, 'seat');

  const work = await (await fetch(`${BASE}/judge/tables`, { headers: judgeHeaders })).json();
  const row = work.tables.find((t) => t.id === id);
  assert.equal(row.claims[0].cageId, CAGE_ID);
  assert.equal(row.claims[0].door, true);
  assert.equal(row.claims[0].signature, undefined);
  assert.deepEqual(row.claims[0].ask, { atRiskStar: '25000000' });
  await judge(id, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '25000000', balanceStar: '25000000', epoch: 1 });

  await page.waitForURL(`${BASE}/table?id=${id}`, { timeout: 15000 });
  assert.ok(!page.url().includes('token'));
  await page.waitForFunction(() => /Your stack 25/.test(document.getElementById('purse-bar')?.textContent ?? ''));
  assert.match(await page.textContent('#purse-bar'), /In the cage 25 tNIGHT/);
  assert.ok(!(await page.isVisible('#join-box')), 'seated: no join form');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), `cage.claim.${id}`), null);
  const view = await (await fetch(`${BASE}/tables/${id}`)).json();
  assert.ok(view.cage.timings.seatedAt > 0, 'how long it took is kept');
  assert.ok(view.cage.timings.approvedAt > 0, 'from the moment the wallet said yes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the Hall’s door: bring an amount and sign once, then back to the Hall, and the session works at any table with nothing to approve', { timeout: 90000 }, async () => {
  const { page, errors, context } = await open(lace(), { cage: BRING_CAGE, path: '/wallet?door=1' });
  await page.waitForFunction(() => document.getElementById('bring-title').textContent === 'Bring tNIGHT to the Hall'); // nothing in the cage yet: the first time
  await page.click(LACE);
  await stepIs(page, 'buy');
  await tilesUp(page);
  assert.ok(!(await page.isVisible('[data-step="seat"]')), 'no table here, so no judge step');
  assert.equal(await text(page, '#connected-note'), 'Lace connected. Nothing has moved yet. Next: pick how much tNIGHT to bring.', 'what just happened, in plain words');
  assert.equal(await text(page, '#dust-badge'), 'You have DUST to pay fees');
  assert.match(await text(page, '#summary-table'), /Any tNIGHT table in the Hall/);
  assert.match(await text(page, tile(25)), /≈ 2 hands at ante 5 · 1 transaction \+ 1 signature/);
  await page.click('.tile[data-amount="other"]');
  await page.fill('#buy-custom', '20');
  assert.equal(await text(page, '#buy-go'), 'Bring 20 tNIGHT to the Hall');
  await page.fill('#bring-name', 'The owner');
  await page.click('#buy-go');
  await page.waitForSelector('#waiting:not([hidden])');
  assert.match(await text(page, '#waiting-intro'), /^1 transaction: 1 prompt in Lace, and one signature\./);
  await signedAtTheDoor(page);
  await stepIs(page, 'done');
  assert.ok(await page.isVisible('#bring-to-hall'));
  // Done ends in one big way on: Go to the Hall, in the window itself. The page behind it is live again, so it isn't dimmed.
  assert.equal(await text(page, '#waiting-go'), 'Go to the Hall');
  assert.ok(await page.isVisible('#waiting-go'));
  assert.equal(await page.$eval('#waiting', (w) => w.classList.contains('running')), false, 'no dim once the plan is done');
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.mode')), 'tnight', 'the Hall opens in tNIGHT mode');
  assert.match(await text(page, '#bring-status'), /^Brought 20 tNIGHT to the Hall\. In the cage: 20\. Your wallet: [\d,.]+\. Pick a table in the Hall/, 'what landed, in numbers');
  assert.equal(await page.isVisible('#connected-note'), false, 'the first-step note goes once something has moved');
  assert.deepEqual((await calls(page)).map((c) => [c[0], c[2]]), [['deposit', '20000000']]);
  const me = await page.evaluate(async () => (await fetch('/door/me', { headers: { authorization: `Bearer ${localStorage.getItem('cage.door')}` } })).json());
  assert.equal(me.status, 'verified');
  assert.equal(me.name, 'The owner');
  assert.match(await text(page, '.result-card[data-action="deposit"] .result-head'), /^Confirmed in /, 'the card stays, to be read');
  await page.click('#waiting-hide');
  assert.equal(await text(page, '#buy-go'), 'Add 50 tNIGHT to the cage', 'signed in: the tiles now only add');
  await page.click('#bring-to-hall');
  await page.waitForURL(`${BASE}/`);
  await page.waitForFunction(() => /the owner · tNIGHT: 5/.test(document.getElementById('who').textContent), null, { timeout: 15000 });
  assert.match(await page.textContent('#who'), /tNIGHT: 5 in the cage · [\d,]+ in Lace$/, 'the cage, and the wallet as this page last read it');
  assert.doesNotMatch(await page.textContent('#who'), /Purse/, 'never the chip balance in tNIGHT mode');
  await page.waitForSelector('#menu [data-id="seat"]', { timeout: 10000 });
  await page.waitForFunction(() => /^Welcome back, the owner\. The cage holds 5 tNIGHT for you\./.test(document.getElementById('line').textContent), null, { timeout: 10000 }); // the line types out
  assert.ok(await page.$('#menu [data-id="mode-chips"]'), 'chips are offered as the other way, never taken by default');

  const session = await page.evaluate(() => localStorage.getItem('cage.door'));
  assert.deepEqual(errors, []);
  await context.close();

  // Two tables on that one session and its permit: the cage's own balance is the first tile, nothing to approve, and no signature either time.
  for (const table of [await tnightTable(), await tnightTable()]) {
    const at = await open(`${lace()}; localStorage.setItem('cage.door', ${JSON.stringify(session)}); window.__cage = { balance: 20000000n, seat: null, table: null, permit: { judge: '11'.repeat(32), cap: 20000000n, until: BigInt(Math.floor(Date.now() / 1000) + 3600), floor: 0n } };`, { cage: BRING_CAGE, path: `/wallet?table=${table.id}` });
    await at.page.click(LACE);
    await tilesUp(at.page);
    assert.equal(await at.page.getAttribute(tile(20), 'aria-checked'), 'true');
    assert.match(await text(at.page, tile(20)), /20 tNIGHT what the cage holds for you · ≈ 10 hands · nothing to approve$/);
    // That is the one tile. Bringing more is a smaller Add more, and nothing in it is ever chosen for them.
    assert.equal(await at.page.$(tile(250)), null, 'the top-up tiles wait behind Add more');
    assert.equal(await text(at.page, '#add-more'), 'Add more from your wallet');
    await at.page.click('#add-more');
    await at.page.waitForSelector(tile(250));
    assert.equal(await at.page.getAttribute(tile(20), 'aria-checked'), 'true', 'still the cage’s own seat');
    assert.equal(await at.page.getAttribute(tile(250), 'aria-checked'), 'false');
    assert.equal(await text(at.page, '#add-more'), 'Just what the cage holds');
    await at.page.click('#add-more');
    await at.page.waitForSelector(tile(250), { state: 'detached' });
    assert.match(await text(at.page, '#summary-approvals'), /^None\. The judge seats you\.$/);
    assert.equal(await at.page.isVisible('#name-label'), false, 'no name asked: the door knows it');
    assert.equal(await text(at.page, '#buy-go'), 'Sit with 20 tNIGHT');
    await at.page.click('#buy-go');
    assert.match(await text(at.page, '#waiting-intro'), /^Nothing to approve\./);
    await stepIs(at.page, 'seat');
    await at.page.waitForFunction((key) => !!localStorage.getItem(key), `cage.claim.${table.id}`);
    assert.equal(await at.page.evaluate(() => window.__signed ?? null), null);
    assert.deepEqual((await calls(at.page)).map((c) => c[0]), []);
    await judge(table.id, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '20000000', balanceStar: '20000000', epoch: 1 });
    await at.page.waitForURL(`${BASE}/table?id=${table.id}`, { timeout: 15000 });
    await at.context.close();
  }
});

test('the look picked in the Hall comes to the table through the door', { timeout: 60000 }, async () => {
  const { id } = await tnightTable();
  const player = await (await fetch(`${BASE}/players`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hooded', avatar: 'rogue' }) })).json();
  const { page, context } = await open(`${lace()}; localStorage.setItem('hall.player', ${JSON.stringify(player.token)}); window.__cage = { balance: 7000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await page.click(LACE);
  await tilesUp(page);
  await page.waitForFunction(() => document.getElementById('bring-name').value === 'Hooded');
  assert.match(await text(page, '#summary-approvals'), /^1 in Lace to put 1 in the cage and renew your permit, then one signature so you can play without pop-ups\.$/);
  await page.click('#buy-go');
  await signedAtTheDoor(page);
  await stepIs(page, 'seat');
  await page.waitForFunction((key) => !!localStorage.getItem(key), `cage.claim.${id}`);
  assert.deepEqual((await calls(page)).map((c) => [c[0], c[2]]), [['deposit', '1000000']], 'the cage held enough: one tNIGHT, for the permit, and no sit');
  await judge(id, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '7000000', balanceStar: '7000000', epoch: 1 });
  await page.waitForURL(`${BASE}/table?id=${id}`, { timeout: 15000 });
  const { seats } = await (await fetch(`${BASE}/tables/${id}`)).json();
  assert.equal(seats[0].avatar, 'rogue');
  assert.equal(seats[0].name, 'Hooded');
  await context.close();
});

test('a seat already held goes straight to the table; a seat on chain with nothing claiming it is claimed without asking the wallet', { timeout: 60000 }, async () => {
  const { id, state } = await tnightTable();
  const claim = await (await fetch(`${BASE}/tables/${id}/cage-seat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ann', cageId: CAGE_ID, verifyingKey: 'vk', signature: 'sig' }) })).json();
  await judge(id, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '4000000', balanceStar: '4000000', epoch: 1 });
  const back = await open(`${lace()}; localStorage.setItem('hall.seat.${id}', '${claim.token}');`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await back.page.waitForURL(`${BASE}/table?id=${id}`, { timeout: 15000 });
  await back.context.close();

  const { id: id2, state: s2 } = await tnightTable();
  const onChain = `window.__cage = { balance: 7000000n, seat: { table: ${s2.cage.table}n, epoch: 1n, atRisk: 7000000n, standing: false }, table: { epoch: 1n, seated: 1n, heartbeat: BigInt(Math.floor(Date.now() / 1000)) } };`;
  const { page, context } = await open(`${lace()}; ${await signedIn()} ${onChain}`, { cage: BRING_CAGE, path: `/wallet?table=${id2}` });
  await page.click(LACE);
  await stepIs(page, 'seat');
  await page.waitForFunction((key) => !!localStorage.getItem(key), `cage.claim.${id2}`);
  assert.equal(await page.evaluate(() => window.__calledArgs ?? null), null, 'nothing more on chain');
  assert.equal(await page.evaluate(() => window.__signed ?? null), null);
  await judge(id2, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '7000000', balanceStar: '7000000', epoch: 1 });
  await page.waitForURL(`${BASE}/table?id=${id2}`, { timeout: 15000 });
  await context.close();
  void state;
});

test('a session for another player key, or one the door refused, asks for the signature again', { timeout: 60000 }, async () => {
  const { id } = await tnightTable();
  const other = await signedIn('cd'.repeat(32));
  const { page, context } = await open(`${lace()}; ${other} window.__cage = { balance: 7000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await page.click(LACE);
  await tilesUp(page);
  await page.waitForFunction(() => !document.getElementById('name-label').hidden, null, { timeout: 5000 }).catch(() => {});
  assert.ok(await page.isVisible('#name-label'), `that session is someone else’s key: a signature is asked for. Summary: ${await page.textContent('#seat-summary')} · why: ${await page.textContent('#buy-go-why')} · door: ${await page.evaluate(async () => (await fetch('/door/me', { headers: { authorization: `Bearer ${localStorage.getItem('cage.door')}` } })).text())}`);
  await page.fill('#bring-name', 'The owner');
  await page.click('#buy-go');
  await signedAtTheDoor(page, false, 'That key is not the payout address of this cage id.');
  await page.waitForFunction(() => /door refused this session: That key/.test(document.getElementById('trouble-what').textContent), null, { timeout: 15000 });
  assert.ok(await page.isVisible('#trouble-retry'));
  assert.ok(!(await calls(page)).some((c) => c[0] === 'sit'), 'no seat went on chain');
  await page.click('#waiting-hide');
  assert.ok(await page.isVisible('#name-label'));
  await context.close();
});

test('Bring tNIGHT: the judge refusing says why, and a seat elsewhere or a started table offers no way to spend', { timeout: 60000 }, async () => {
  const { id } = await tnightTable();
  const session = await signedIn();
  const { page, context } = await open(`${lace()}; ${session} window.__cage = { balance: 5000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await page.click(LACE);
  await tilesUp(page);
  await page.click('#buy-go');
  await stepIs(page, 'seat');
  await page.waitForFunction((key) => !!localStorage.getItem(key), `cage.claim.${id}`);
  await judge(id, 'verified', { cageId: CAGE_ID, ok: false, reason: 'That table has gone quiet on chain.' });
  await page.waitForFunction(() => /refused this seat: That table/.test(document.getElementById('bring-status').textContent), null, { timeout: 15000 });
  assert.match(await text(page, '#trouble-what'), /refused this seat: That table/);
  const after = (await calls(page)).length;
  await page.waitForTimeout(1500);
  assert.equal((await calls(page)).length, after);
  assert.equal((await (await fetch(`${BASE}/tables/${id}`)).json()).cage.waiting.length, 0, 'and it doesn\'t keep claiming by itself');
  await context.close();

  // Seated at another table on chain.
  const other = `${lace()}; ${await signedIn()} window.__cage = { balance: 5000000n, seat: { table: 999n, epoch: 1n, atRisk: 1000000n, standing: false }, table: { epoch: 1n, seated: 1n, heartbeat: BigInt(Math.floor(Date.now() / 1000)) } };`;
  const { id: id2 } = await tnightTable();
  const second = await open(other, { cage: BRING_CAGE, path: `/wallet?table=${id2}` });
  await second.page.click(LACE);
  await second.page.waitForFunction(() => /seated at table 999/.test(document.getElementById('bring-status').textContent), null, { timeout: 15000 });
  assert.equal(await second.page.isVisible('#tiles'), false);
  assert.equal(await second.page.isDisabled('#buy-go'), true);
  assert.match(await text(second.page, '#buy-go-why'), /seated at table 999/);
  await second.context.close();

  // A table already dealt.
  const { id: id3 } = await tnightTable();
  for (const [cageId, name] of [['a'.repeat(64), 'Ann'], ['b'.repeat(64), 'Bob']]) {
    await fetch(`${BASE}/tables/${id3}/cage-seat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, cageId, verifyingKey: 'vk', signature: 'sig' }) });
    await judge(id3, 'verified', { cageId, ok: true, atRiskStar: '4000000', balanceStar: '4000000', epoch: 1 });
  }
  const third = await open(`${lace()}; ${await signedIn()} window.__cage = { balance: 5000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: `/wallet?table=${id3}` });
  await third.page.waitForFunction(() => !!document.getElementById('bring-title')?.textContent.includes('table'));
  await third.page.click(LACE);
  await third.page.waitForFunction(() => /has started/.test(document.getElementById('bring-status').textContent), null, { timeout: 15000 });
  assert.equal(await third.page.isVisible('#tiles'), false);
  assert.equal(await third.page.isDisabled('#buy-go'), true);
  assert.match(await text(third.page, '#buy-go-why'), /has started/);
  assert.ok(await third.page.isVisible('#bring-to-table'));
  await third.context.close();
});

test('Bring tNIGHT at the real stakes: the tiles count hands at ante 5, and nothing under one ante or over the buy-in max (250 a seat) can be picked', { timeout: 60000 }, async () => {
  const { id } = await tnightTable({ stakes: {} });
  const { page, context } = await open(`${lace()}; ${await signedIn()}`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await page.waitForFunction(() => /Ante 5\. Raises 1 to 25\. Pot limit 500/.test(document.getElementById('bring-stakes').textContent));
  await page.click(LACE);
  await tilesUp(page);
  assert.match(await text(page, tile(50)), /50 tNIGHT ≈ 5 hands · 1 transaction$/, 'signed in already: a deposit, and the judge seats them');
  assert.match(await text(page, tile(250)), /≈ 25 hands/);
  await page.click('.tile[data-amount="other"]');
  assert.match(await text(page, '.tile[data-amount="other"]'), /at least the ante \(5\), up to 250 for one seat/);
  await page.fill('#buy-custom', '4');
  assert.equal(await page.isDisabled('#buy-go'), true);
  assert.match(await text(page, '#buy-go-why'), /ante is 5, so bring at least 5 tNIGHT/);
  await page.fill('#buy-custom', '251');
  assert.match(await text(page, '#buy-go-why'), /At most 250 tNIGHT can be at risk in one seat at this table/);
  await page.fill('#buy-custom', '46');
  assert.equal(await page.isDisabled('#buy-go'), false);
  assert.equal(await text(page, '#buy-go'), 'Sit with 46 tNIGHT');
  await page.click('#buy-go');
  await stepIs(page, 'seat');
  assert.deepEqual((await calls(page)).map((c) => [c[0], c[2]]), [['deposit', '46000000']]);
  await context.close();
});

test('Bring tNIGHT with money already in the cage: a bigger tile tops up first (one approval), and the judge seats them, and the buy-in max (250 a seat) caps the cage tile', { timeout: 60000 }, async () => {
  const { id, state } = await tnightTable({ stakes: {} }); // ante 5, pot limit 500
  const { page, context } = await open(`${lace()}; ${await signedIn()} window.__cage = { balance: 91000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await page.click(LACE);
  await tilesUp(page);
  assert.deepEqual(await page.$$eval('.tile', (b) => b.map((x) => x.dataset.amount)), ['91000000', '25000000', '50000000', '100000000', '250000000', 'other']);
  assert.equal(await page.getAttribute(tile(91), 'aria-checked'), 'true');
  assert.match(await text(page, tile(91)), /91 tNIGHT what the cage holds for you · ≈ 9 hands · 1 transaction$/);
  assert.match(await text(page, tile(100)), /≈ 10 hands · tops up 9 · 1 transaction$/);
  await page.click(tile(100));
  assert.match(await text(page, '#summary-amount'), /100 tNIGHT at risk: 91 already in the cage, 9 from your wallet/);
  assert.match(await text(page, '#summary-approvals'), /^1 in Lace to put 9 in the cage\.$/);
  assert.equal(await text(page, '#buy-go'), 'Sit with 100 tNIGHT');
  await page.evaluate(() => { window.__signed = null; });
  await page.click('#buy-go');
  await page.waitForSelector('#waiting:not([hidden])');
  assert.match(await text(page, '#waiting-intro'), /^1 transaction: 1 prompt in Lace\./);
  await stepIs(page, 'seat');
  const made = await calls(page);
  assert.deepEqual(made.map((c) => c[0]), ['deposit'], 'the top-up, and the judge seats them at this table');
  assert.equal(made[0][2], '9000000');
  assert.equal(made[0][4], '100000000', 'the cap is the whole seat');
  assert.ok(state.cage.table);
  assert.equal(await page.evaluate(() => window.__signed), null, 'still no second signature');
  await context.close();

  // More in the cage than one seat may put at risk (250): the cage tile is that most, and says so.
  const rich = await open(`${lace()}; ${await signedIn()} window.__cage = { balance: 700000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: `/wallet?table=${id}` });
  await rich.page.click(LACE);
  await tilesUp(rich.page);
  assert.match(await text(rich.page, tile(250)), /250 tNIGHT the most for one seat; the cage holds 700/);
  assert.equal(await rich.page.$('.tile[data-amount="500000000"]'), null, 'no tile over 250');
  await rich.context.close();
});

test('a table from before the stakes change has no pot limit, and the page says nothing about one', { timeout: 30000 }, async () => {
  const { id } = await tnightTable({ stakes: { ante: 2 } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(lace());
  await page.route(`**/tables/${id}`, async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.limits.potLimit = null; // what a saved table from before the change answers
    await r.fulfill({ response: res, json: body });
  });
  await page.route('**/cage-config.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'cage #3', writable: true, network: 'preprod', address: CAGE, escapeSecs: 1800, clockSlack: 300, seats: 6 }) }));
  await page.route('**/wallet-app/cage.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: BRING_CAGE }));
  await page.route('https://indexer.test/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: INDEXER_ANSWER }));
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/wallet?table=${id}`);
  await page.waitForFunction(() => /Ante 2/.test(document.getElementById('bring-stakes').textContent));
  assert.doesNotMatch(await page.textContent('#bring-stakes'), /null/);
  await page.click(LACE);
  await tilesUp(page);
  assert.doesNotMatch(await text(page, '.tile[data-amount="other"]'), /pot limit|null/);
  await context.close();
});

test('a bad table in the link says so, and an ordinary visit to the wallet page is the Hall’s door', async () => {
  const { page, context } = await open(lace(), { path: `/wallet?table=${'f'.repeat(64)}` });
  await page.waitForFunction(() => /isn’t here|Something|didn’t answer/.test(document.getElementById('bring-status').textContent));
  await page.click(LACE);
  await page.waitForFunction(() => /isn’t here|didn’t answer/.test(document.getElementById('buy-go-why').textContent), null, { timeout: 15000 });
  assert.equal(await page.isDisabled('#buy-go'), true);
  await context.close();
  const plain = await open(lace());
  assert.equal(await plain.page.textContent('#bring-title'), 'The Cage');
  assert.ok(await plain.page.isVisible('[data-step="done"]'), 'the door path: step 3 is the Hall');
  assert.ok(!(await plain.page.isVisible('[data-step="seat"]')));
  await plain.context.close();
});

test('the Hall: a tNIGHT table shows Play for tNIGHT, leading to the table page; a play-chip table still shows Join, and Take a seat never lands on tNIGHT', { timeout: 60000 }, async () => {
  const { id } = await tnightTable({ bots: 2 });
  const plain = await (await fetch(`${BASE}/tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lobbySeconds: 300, test: { rng: 1 } }) })).json();
  await fetch(`${BASE}/tables/${plain.id}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pat' }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await savePlayer(context);
  const page = await context.newPage();
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/`);
  const row = `#in-play .row[data-table="${id}"]`;
  await page.waitForSelector(row, { state: 'attached', timeout: 15000 });
  assert.equal((await page.textContent(`${row} [data-bring]`)).trim(), 'Play for tNIGHT');
  assert.equal(await page.getAttribute(`${row} [data-bring]`, 'href'), `/table?id=${id}`);
  assert.match(await page.textContent(row), /tNIGHT/);
  const playRow = `#in-play .row[data-table="${plain.id}"]`;
  assert.equal(await page.$(`${playRow} [data-bring]`) === null, true);
  assert.match(await page.textContent(playRow), /Play chips/, 'with tNIGHT on, a chips row says which way it is');
  // The room's own sign offers both, by name, and Take a seat asks the same question.
  await page.click('[aria-label^="Sealed Hand"]');
  await page.waitForSelector('#menu [data-id="bring"]', { timeout: 10000 });
  assert.match(await page.textContent('#menu [data-id="join"]'), /Play chips/);
  assert.match(await page.textContent('#menu [data-id="bring"]'), /Play for tNIGHT/);
  await page.click('#menu [data-id="back"]');
  await page.waitForSelector('#menu [data-id="mode-tnight"]'); // nothing said yet: the greeting is the one question, chips or tNIGHT
  assert.deepEqual(await page.$$eval('#menu .menu-item', (els) => els.map((e) => e.dataset.id)), ['mode-chips', 'mode-tnight', 'rules']);
  await page.click('[aria-label^="Sealed Hand"]');
  await page.waitForSelector('#menu [data-id="bring"]', { timeout: 10000 });
  assert.match(await page.textContent('#menu [data-id="join"]'), /Play chips/);
  await page.click('#menu [data-id="bring"]');
  await page.waitForSelector('#menu [data-id="go"]', { timeout: 10000 }); // once: why the tables wait
  await page.click('#menu [data-id="go"]');
  await page.waitForURL(new RegExp('/table\\?id='), { timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('hall.mode')), 'tnight', 'Play for tNIGHT is the way they play from here on');
  await context.close();

  // The table page, reached with no seat, seats the player right there: the wallet picker and the tiles, no form, no link away.
  const watcher = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tablePage = await watcher.newPage();
  await tablePage.route('https://fonts.**', (r) => r.abort());
  await tablePage.goto(`${BASE}/table?id=${id}`);
  await tablePage.waitForSelector('#cage-join', { state: 'attached', timeout: 15000 });
  assert.match(await tablePage.textContent('#join-title'), /Sit at this table/);
  assert.equal(await tablePage.$('#join-note a'), null, 'no link to the cage page');
  assert.ok(!(await tablePage.isVisible('#join-form')));
  await watcher.close();
});

test('an indexer that fails once: the page asks again and carries on, with no refresh', { timeout: 60000 }, async () => {
  const { id } = await tnightTable();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await savePlayer(context);
  const page = await context.newPage();
  await page.addInitScript(lace());
  let up = false;
  await page.route('https://indexer.test/**', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    return up
      ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: INDEXER_ANSWER })
      : r.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await page.route('http://localhost:6300/**', (r) => r.fulfill({ status: 200, body: '{"status":"ok"}' }));
  await page.route('**/cage-config.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'cage #3', writable: true, network: 'preprod', address: CAGE, escapeSecs: 1800, clockSlack: 300, seats: 6 }) }));
  await page.route('**/wallet-app/cage.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: BRING_CAGE }));
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/wallet?table=${id}`);
  await page.click(LACE);
  await page.waitForFunction(() => /didn’t answer/.test(document.querySelector('[data-check="Indexer"]')?.textContent ?? ''), null, { timeout: 20000 });
  assert.ok(await page.isVisible('#indexer-form'), 'the way to paste a project ID is still offered');
  assert.equal(await page.isDisabled('#buy-go'), true);
  assert.match(await text(page, '#buy-go-why'), /Waiting for an indexer: none answers yet/);
  up = true;
  await tilesUp(page);
  assert.ok(!(await page.isVisible('#indexer-form')));
  await context.close();
});

// ---------- the Hall's own indexer (11-04): a wallet whose indexer is gone still reads the cage ----------

test('the wallet’s indexer is dead: the Hall’s own reads the cage, and the browser never sees the key', { timeout: 60000 }, async () => {
  hallUp = true;
  const { id } = await tnightTable();
  const { page, errors, context } = await open(lace(), { indexerOk: false, cage: BRING_CAGE, path: `/wallet?table=${id}` });
  const asked = [];
  page.on('request', (r) => { if (/indexer/.test(r.url())) asked.push(r.url()); });
  await page.click(LACE);
  await page.waitForFunction(() => /Hall’s own/.test(document.querySelector('[data-check="Indexer"]')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match(await checkRow(page, 'Indexer'), /The Hall’s own, 127\.0\.0\.1:\d+, block 3,300,000\. Lace’s indexer\.test didn’t answer \(HTTP 410\), so the Hall reads the cage for you\./);
  assert.ok(!(await page.isVisible('#indexer-form')), 'nothing to paste');
  await tilesUp(page);
  assert.ok(asked.some((u) => u.endsWith('/indexer/graphql')), 'the check went through the Worker');
  assert.ok(!asked.some((u) => u.includes(HALL_KEY)), 'the key stays in the Worker');
  assert.ok(upstreamSeen.some((u) => u.key === HALL_KEY), 'and went upstream with the key');
  assert.ok(!(await page.evaluate(() => document.documentElement.outerHTML)).includes(HALL_KEY));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a 1AM-style wallet that names no indexer: the Hall’s own is used, and a dead Hall indexer leaves the paste box', { timeout: 60000 }, async () => {
  hallUp = true;
  const { page, context } = await open(installed(oneAm({ noIndexer: true })), { cage: STUB_CAGE });
  await page.click(ONE_AM);
  await page.waitForFunction(() => /Hall’s own/.test(document.querySelector('[data-check="Indexer"]')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match(await checkRow(page, 'Indexer'), /1AM names no indexer, so the Hall reads the cage for you/);
  await tilesUp(page);
  assert.ok(!(await page.isVisible('#indexer-form')));
  await context.close();

  hallUp = false;
  const down = await open(lace(), { indexerOk: false });
  await down.page.click(LACE);
  await down.page.waitForFunction(() => /None answers/.test(document.querySelector('[data-check="Indexer"]')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match(await checkRow(down.page, 'Indexer'), /Lace’s indexer\.test didn’t answer \(HTTP 410\), and the Hall’s own 127\.0\.0\.1:\d+ didn’t either \(HTTP 502\)/);
  assert.ok(await down.page.isVisible('#indexer-form'));
  assert.ok(await down.page.evaluate(() => document.getElementById('checks-box').open), 'the fold opens on a problem');
  await down.context.close();
});

// ---------- 11-09, the browser test on 1AM: an indexer that answers a height but has no cage ----------

const NO_CAGE_ANSWER = '{"data":{"block":{"height":3300000},"contract":null}}';
// The same stub, with a cage that can't be read until the test says so (what Midnight.js 5 says when the indexer has no copy).
const UNREADABLE_CAGE = STUB_CAGE.replace('async read() {', "async read() { if (!window.__readOk) throw new Error('No contract at ' + 'b38a'.repeat(16) + ' on Preprod.');");

test('a wallet indexer that answers a height but has no copy of the cage is passed over: the Hall reads the cage (1AM, 11-09)', { timeout: 60000 }, async () => {
  hallUp = true;
  const { page, errors, context } = await open(installed(oneAm({ indexer: 'https://indexer.test/graphql' })), { cage: STUB_CAGE, indexerBody: NO_CAGE_ANSWER });
  await page.click(ONE_AM);
  await page.waitForFunction(() => /Hall’s own/.test(document.querySelector('[data-check="Indexer"]')?.textContent ?? ''), null, { timeout: 20000 });
  assert.match(await checkRow(page, 'Indexer'), /1AM’s indexer\.test didn’t answer \(it answers, but has no copy of the cage\), so the Hall reads the cage for you\./);
  assert.ok(!(await page.isVisible('#indexer-form')), 'nothing to paste');
  await tilesUp(page);
  assert.ok(!(await page.isVisible('#cage-trouble')));
  assert.equal(await text(page, '#connected-note'), '1AM connected. Nothing has moved yet. Next: pick how much tNIGHT to bring.');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a cage that can’t be read says what that means, keeps the raw error small, offers Refresh, and never points at tiles that aren’t there', { timeout: 60000 }, async () => {
  hallUp = false;
  const { page, context } = await open(lace(), { cage: UNREADABLE_CAGE });
  await page.click(LACE);
  await page.waitForSelector('#cage-trouble:not([hidden])', { timeout: 20000 });
  assert.equal(await text(page, '#cage-trouble-text'), 'We can’t reach the table’s vault right now; your tNIGHT is safe in your wallet. Try Refresh in a minute.');
  assert.match(await text(page, '#cage-trouble-raw'), /^Couldn’t read the cage: .*No contract at b38a/);
  assert.equal(await text(page, '#cage-balance'), 'not available right now');
  assert.ok(!(await page.isVisible('.tile[data-amount]')), 'no tiles without a cage to put the money in');
  assert.doesNotMatch(await text(page, '#buy-go-why'), /Pick an amount/);
  assert.match(await text(page, '#buy-go-why'), /cage can’t be read right now: see above/);
  await page.evaluate(() => { window.__readOk = true; });
  await page.click('#cage-refresh');
  await tilesUp(page);
  assert.ok(!(await page.isVisible('#cage-trouble')));
  await context.close();
});

test('Round result at a tNIGHT table: settling, then settled on chain with a link to the transaction', { timeout: 60000 }, async () => {
  const { id } = await tnightTable();
  const post = (path, token, body) => fetch(`${BASE}/tables/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  const [ann, bob] = [await post('cage-seat', null, { name: 'Ann', cageId: 'a'.repeat(64), verifyingKey: 'vk', signature: 'sig' }), await post('cage-seat', null, { name: 'Bob', cageId: 'b'.repeat(64), verifyingKey: 'vk', signature: 'sig' })];
  for (const cageId of ['a'.repeat(64), 'b'.repeat(64)]) await judge(id, 'verified', { cageId, ok: true, atRiskStar: '9000000', balanceStar: '9000000', epoch: 1 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(({ k, t: token }) => localStorage.setItem(k, token), { k: `hall.seat.${id}`, t: ann.token });
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/table?id=${id}`);
  const me = (token) => fetch(`${BASE}/tables/${id}/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  for (let window = 0; window < 2; window += 1) for (const s of [ann, bob]) await post('act', s.token, { action: 'pass', card: (await me(s.token)).hand[0] });
  const state = await (await fetch(`${BASE}/tables/${id}`)).json();
  const [first, second] = state.starter === 0 ? [ann, bob] : [bob, ann];
  await post('act', first.token, { action: 'stop', claim: [1, 2] });
  await post('act', second.token, { action: 'check' });
  await page.waitForSelector('#round-result:not([hidden])', { timeout: 10000 });
  assert.match(await page.textContent('#round-result'), /nobody called it/);
  assert.match(await page.textContent('#result-chain'), /Settling on chain/);
  const hash = 'cd'.repeat(32);
  await judge(id, 'settled', { seqs: [1], tx: { hash, block: 77, chainRound: 1, status: 'SucceedEntirely' } });
  await page.waitForFunction(() => /Settled on chain/.test(document.getElementById('result-chain')?.textContent ?? ''), null, { timeout: 10000 });
  assert.equal(await page.getAttribute('#result-chain a', 'href'), `https://preprod.midnightexplorer.com/transactions/${hash}`);
  assert.match(await page.textContent('#result-chain'), /block 77/);
  assert.match(await page.textContent('#result-mine'), /You put in 1, got back \d+ → net/);
  await context.close();
});


// ---------- revamp (11-04): the waiting window, the trouble window, and every disabled button saying why ----------

const SLOW_BRING_CAGE = BRING_CAGE.replace("progress('Lace is sending it.');", `for (const line of ['Running the circuit.', 'Proving with Lace. Approve there if it asks. This can take a few minutes.', 'Approve in Lace.', 'Lace is sending it.', 'Sent. Waiting for a block.']) { progress(line); await new Promise((ok) => setTimeout(ok, 300)); }`);

test('the waiting window: stages tick off as the wallet and the chain answer, the bar fills, the line says where it is, then the next transaction', { timeout: 60000 }, async () => {
  const { id } = await tnightTable();
  const { page, errors, context } = await open(`${lace()}; ${await signedIn()}`, { cage: SLOW_BRING_CAGE, path: `/wallet?table=${id}` });
  await stepIs(page, 'wallet');
  await page.click(LACE);
  assert.equal(await page.getAttribute(LACE, 'aria-busy'), 'true', 'the chosen wallet is marked while it answers');
  await tilesUp(page);
  await page.click('#buy-go');
  await page.waitForSelector('#waiting:not([hidden])');
  assert.equal(await page.getAttribute('#buy-go', 'aria-busy'), 'true');
  assert.match(await text(page, '#waiting-intro'), /^1 transaction: 1 prompt in Lace\. About \d+ minutes\.$/);
  assert.deepEqual(await page.$$eval('#stages li', (l) => l.map((x) => x.textContent)), ['Building your deposit', 'Proving your deposit', 'Approve in Lace', 'Sending to Midnight', 'Waiting for the block', 'Done']);
  await page.waitForFunction(() => document.querySelector('#stages li:nth-child(3)')?.className === 'now', null, { timeout: 5000 });
  assert.deepEqual(await page.$$eval('#stages li', (l) => l.map((x) => x.className)), ['done', 'done', 'now', '', '', '']);
  assert.equal(await text(page, '#waiting-line'), 'You’re signing to put 50 tNIGHT from your wallet in the cage.', 'in plain words: what is being signed (11-09)');
  assert.equal(await text(page, '#buy-go'), 'Approve in Lace', 'the pressed button carries the stage too');
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('waiting-log').textContent), null, { timeout: 5000 });
  const width = await page.evaluate(() => document.getElementById('waiting-fill').style.width);
  assert.ok(parseInt(width, 10) >= 33 && parseInt(width, 10) <= 70, `the bar is part way: ${width}`);
  await stepIs(page, 'seat');
  assert.match(await text(page, '#stages'), /The judge is proving your seat/);
  assert.match(await text(page, '.result-card[data-action="deposit"] .result-head'), /^Confirmed in \d+s$/);
  assert.match(await text(page, '.result-card[data-action="deposit"] .result-says'), /^Public: .*Private: your player key/);
  assert.equal(await page.getAttribute('.result-card[data-action="deposit"] a', 'href'), 'https://preprod.midnightexplorer.com/transactions/cafe');
  await page.click('#waiting-hide');
  assert.ok(!(await page.isVisible('#waiting')));
  assert.deepEqual(errors, []);
  await context.close();
});

test('approve takes a while: after 10 seconds the window says it is still waiting on the wallet, which may ask twice', { timeout: 60000 }, async () => {
  const STALL = BRING_CAGE.replace("progress('Lace is sending it.');", "progress('Approve in Lace.'); await new Promise((ok) => setTimeout(ok, 11500)); progress('Lace is sending it.');");
  const { page, context } = await open(`${lace()}; ${await signedIn()} window.__cage = { balance: 5000000n, seat: null, table: null };`, { cage: STALL, path: '/wallet?door=1' });
  await page.click(LACE);
  await tilesUp(page);
  await page.evaluate(() => {
    window.__seen = {};
    new MutationObserver(() => {
      const stages = document.getElementById('stages').textContent;
      if (!window.__seen.approve && document.querySelector('#stages li:nth-child(3)')?.className === 'now') window.__seen.approve = performance.now();
      if (!window.__seen.still && /Still waiting on Lace\. It may ask twice \(1AM asks for the transaction and the DUST choice separately\): check its window\./.test(stages)) window.__seen.still = performance.now();
    }).observe(document.getElementById('stages'), { childList: true, subtree: true, attributes: true, characterData: true });
  });
  await page.click('#buy-go');
  await page.waitForFunction(() => window.__seen.still, null, { timeout: 20000 });
  const seen = await page.evaluate(() => window.__seen);
  assert.ok(seen.still - seen.approve >= 9500 && seen.still - seen.approve <= 12000, `${Math.round(seen.still - seen.approve)} ms after the approve stage began`);
  await page.waitForFunction(() => /landed in block 42/.test(document.getElementById('waiting-log').textContent), null, { timeout: 20000 });
  assert.doesNotMatch(await page.textContent('#stages'), /Still waiting/, 'gone once the wallet answered');
  await context.close();
});

test('the wallet says no: the window turns into the trouble window, with what broke, the cause, what to do and the raw error, and Try again runs the same step', { timeout: 60000 }, async () => {
  const { page, context } = await open(`${lace()}; ${await signedIn()} window.__refuse = 'User declined to sign the transaction';`, { cage: BRING_CAGE, path: '/wallet?door=1' });
  await page.click(LACE);
  await tilesUp(page);
  await page.click('#buy-go');
  await page.waitForSelector('#trouble:not([hidden])', { timeout: 15000 });
  assert.equal(await text(page, '#waiting-title'), 'You said no in Lace');
  assert.match(await text(page, '#trouble-what'), /Lace reports that the request to approve the deposit was declined\./);
  assert.match(await text(page, '#trouble-cause'), /closed or refused/);
  assert.match(await text(page, '#trouble-do'), /Try again, and approve it in Lace/);
  assert.equal(await text(page, '#trouble-raw'), 'User declined to sign the transaction');
  assert.ok(await page.$eval('#trouble-raw', (el) => getComputedStyle(el).fontFamily.includes('mono')));
  assert.ok(await page.isVisible('#trouble-retry'));
  assert.ok(await page.isVisible('#trouble-refresh'));
  assert.match(await text(page, '#stages'), /Approve in Lace/);
  assert.equal(await page.$eval('#stages', (el) => [...el.children].find((li) => li.className === 'failed')?.textContent), 'Sending to Midnight', 'the stub says no after saying it is sending');
  assert.equal(await page.getAttribute('#buy-go', 'aria-busy'), null, 'the button is free again');
  assert.equal(await page.isDisabled('#buy-go'), false);
  await page.evaluate(() => { window.__refuse = null; });
  await page.click('#trouble-retry');
  await stepIs(page, 'done');
  assert.deepEqual((await calls(page)).map((c) => c[0]), ['deposit', 'deposit']);
  await context.close();
});

test('a wallet that never answers the connect: the trouble window says what to do, and Try again is the same click', { timeout: 60000 }, async () => {
  const { page, context } = await open(`${lace()}${HANG_FIRST}`);
  await page.waitForSelector(LACE);
  await page.click(LACE);
  assert.match(await text(page, `${LACE} .wallet-note`), /^Waiting for Lace/);
  assert.match(await status(page), /^Waiting for Lace… Approve in Lace if it asks\./);
  await noAnswer(page);
  await page.waitForSelector('#trouble:not([hidden])');
  assert.equal(await text(page, '#waiting-title'), 'Lace didn’t answer');
  assert.match(await text(page, '#trouble-what'), /asked Lace to connect and heard nothing for 20 seconds/);
  assert.match(await text(page, '#trouble-cause'), /locked, or its background has stopped \(Lace 2\.5\.0 does this\)/);
  assert.match(await text(page, '#trouble-steps'), /Open Lace from your browser’s toolbar\..*Unlock it/);
  await page.click('#trouble-retry');
  await page.waitForSelector('#wallet:not([hidden])');
  assert.ok(!(await page.isVisible('#waiting')));
  await context.close();
});

test('every disabled button says why, right under it', { timeout: 60000 }, async () => {
  const { page, context } = await open(installed(oneAm()), { cage: STUB_CAGE });
  assert.equal(await text(page, '#buy-go-why'), 'Choose your wallet first.');
  await page.click('#my-cage summary');
  for (const [id, expected] of [['withdraw', /Choose your wallet first\./], ['stand', /Choose your wallet first\./], ['find', /Choose your wallet first\./], ['copy-key', /No key in this browser yet/]]) {
    assert.equal(await page.isDisabled(`#${id}`), true, id);
    assert.match(await text(page, `#${id}-why`), expected, id);
  }
  await page.click(ONE_AM);
  await tilesUp(page);
  assert.equal(await page.isDisabled('#withdraw'), false);
  assert.equal(await text(page, '#withdraw-why'), '');
  assert.match(await text(page, '#stand-why'), /not seated anywhere/);
  assert.match(await text(page, '#probe-why'), /^$/);
  await context.close();

  // Seated: withdraw is off and says so; the finder lists the held seat with its reason.
  const seated = await open(`${installed(oneAm())}; window.__cage = { balance: 5000000n, seat: { table: 7n, epoch: 1n, atRisk: 2000000n, standing: false }, table: { epoch: 1n, seated: 1n, heartbeat: BigInt(Math.floor(Date.now() / 1000)) } };`, { cage: BRING_CAGE });
  await seated.page.click(ONE_AM);
  await seated.page.waitForFunction(() => document.getElementById('stand').disabled === false, null, { timeout: 15000 });
  assert.equal(await seated.page.isDisabled('#withdraw'), true);
  assert.match(await seated.page.textContent('#withdraw-why'), /seated at table 7, so the cage refuses a withdrawal/);
  await seated.context.close();
});

test('the dice sign: Open a tNIGHT table when none is open, and an open sign sees a table that opens meanwhile', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await savePlayer(context);
  const page = await context.newPage();
  await page.route('https://fonts.**', (r) => r.abort());
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#menu [data-id="mode-tnight"]');
  await page.click('[data-game="cup-and-claim"]');
  await page.waitForSelector('#menu [data-id="open"]');
  assert.match(await page.textContent('#menu [data-id="open"]'), /Open a tNIGHT table.*about 2 min/);
  // A table opens elsewhere: the sign sees it on the next poll, with nothing pressed and the line untouched.
  const made = await (await fetch(`${BASE}/dice-tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tnight: true, bots: 2, lobbySeconds: 0 }) })).json();
  await page.waitForSelector('#menu [data-id="bring"]', { timeout: 10000 });
  assert.match(await page.textContent('#menu [data-id="bring"]'), new RegExp(`Play for tNIGHT.*table ${made.state.cage.table}, preprod`));
  assert.equal(await page.$('#menu [data-id="open"]'), null);
  assert.match(await page.textContent('#line'), /^Cup & Claim/);
  // It closes: the sign offers to open one again, and Open makes a table and leads to its cage page.
  await judge(made.id, 'dead', { reason: 'test' });
  await page.waitForSelector('#menu [data-id="open"]', { timeout: 10000 });
  await page.click('#menu [data-id="open"]');
  await page.waitForSelector('#menu [data-id="go"]', { timeout: 10000 }); // once: why the tables wait
  await page.click('#menu [data-id="go"]');
  await page.waitForURL(/\/dice\?id=[0-9a-f]{64}$/, { timeout: 15000 });
  const id = new URL(page.url()).searchParams.get('id');
  const view = await (await fetch(`${BASE}/dice-tables/${id}`)).json();
  assert.equal(view.cage.warm, false);
  assert.equal(view.cage.housePending, true, 'the float comes once someone sits');
  await context.close();
});

// ---------- one-tap cash out and top-ups (11-04) ----------

/** A player seated on chain and at the table, with the browser holding the seat token and the wallet remembered. */
async function seatedAtTable(opts = {}) {
  const { id, state } = await tnightTable({ stakes: { ante: 1 }, ...opts });
  const claim = await (await fetch(`${BASE}/tables/${id}/cage-seat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'The owner', cageId: CAGE_ID, verifyingKey: 'vk', signature: 'sig' }) })).json();
  await judge(id, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '7000000', balanceStar: '7000000', epoch: 1 });
  const onChain = `window.__cage = { balance: 7000000n, seat: { table: ${state.cage.table}n, epoch: 1n, atRisk: 7000000n, standing: false }, table: { epoch: 1n, seated: 1n, heartbeat: BigInt(Math.floor(Date.now() / 1000)) } };`;
  return { id, state, token: claim.token, onChain };
}

test('one-tap cash out at the table: stands you up, waits for the judge, withdraws, and says the money is back, with no page change', { timeout: 90000 }, async () => {
  const { id, token, onChain } = await seatedAtTable();
  // This browser brought 10 to the cage earlier: the window ends with what the session came to (11-09).
  const script = `${lace()}; ${await signedIn()} localStorage.setItem('hall.seat.${id}', ${JSON.stringify(token)}); localStorage.setItem('cage.wallet', 'io.lace.wallet'); localStorage.setItem('cage.wallet.auto', '1'); localStorage.setItem('cage.brought.${ADDRESS}', '10000000'); window.__askFirst = 1500; ${onChain}`;
  const { page, errors, context } = await open(script, { cage: BRING_CAGE, path: `/table?id=${id}`, ...(SHOT_W ? { viewport: { width: 390, height: 844 } } : {}) });
  await page.waitForSelector('#leave-cash #cash-out:not([disabled])', { timeout: 20000 }); // the remembered wallet reconnects with no click
  assert.equal(await text(page, '#leave-cash #cash-out'), 'Cash out 7 tNIGHT');
  assert.equal(await text(page, '#leave-cash #cash-note'), 'Cash out can only go back to your own wallet.');
  assert.ok(await page.isVisible('#leave-cash #top-up'));
  await page.click('#leave-cash #cash-out');
  await page.waitForSelector('#leave-cash #cash-ask:not([hidden])'); // Cash out asks how much (11-07): All, or an amount
  assert.equal(await text(page, '#leave-cash .cash-ask-title'), 'Cash out how much?');
  assert.equal(await text(page, '#leave-cash #cash-all'), 'All 7 tNIGHT');
  await page.click('#leave-cash #cash-all');
  await page.waitForSelector('#waiting:not([hidden])', { timeout: 20000 });
  assert.equal(await text(page, '#waiting-title'), 'Cashing out 7 tNIGHT');
  assert.match(await text(page, '#waiting-intro'), /^2 transactions: 2 prompts in Lace\. About \d+ minutes\. It can only go back to your own wallet\.$/);
  await page.waitForFunction(() => /^You’re signing to stand up from table \d+\. Nothing leaves the cage yet/.test(document.getElementById('waiting-line').textContent), null, { timeout: 15000 });
  await shot(page, 'cashout-signing-stand');
  await page.waitForFunction(() => (window.__calledArgs ?? []).some((c) => c[0] === 'stand'), null, { timeout: 15000 });
  await page.waitForFunction(() => /The judge frees your seat/.test(document.getElementById('stages').textContent), null, { timeout: 15000 });
  assert.match(await text(page, '#waiting-line'), /waiting for the judge to free the seat: 0:0\d so far/);
  assert.equal(await page.getAttribute('#leave-cash #cash-out', 'aria-busy'), 'true');
  // Another page, mid cash-out (11-09: The owner pressed Menu): the Hall says it's going on, and where it finishes.
  const hall = await context.newPage();
  await hall.route('https://fonts.**', (r) => r.abort());
  await hall.goto(`${BASE}/`);
  await hall.waitForSelector('#inflight:not([hidden])', { timeout: 10000 });
  if (SHOT_W) await hall.setViewportSize({ width: 390, height: 844 });
  await shot(hall, 'banner-cashout-hall');
  assert.match(await text(hall, '#inflight'), /^Cashing out 7 tNIGHT: waiting for the judge to free your seat\. It finishes on the cage page, with one approval\. \d:\d\d Finish cashing out$/);
  assert.equal(await hall.getAttribute('#inflight a', 'href'), '/wallet?cashout=1');
  assert.ok(!(await page.isVisible('#inflight')), 'not on the page that is running it: its own window says it');
  await judge(id, 'standing', { cageId: CAGE_ID });
  await judge(id, 'released', { cageId: CAGE_ID });
  await page.evaluate(() => { window.__cage.seat = null; window.__cage.table = null; });
  await page.waitForFunction(() => /^You’re signing to cash out 7 tNIGHT to your wallet\.$/.test(document.getElementById('waiting-line').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => /^Cashed out 7 tNIGHT\./.test(document.getElementById('waiting-line').textContent), null, { timeout: 20000 });
  await shot(page, 'cashout-done');
  assert.equal(await text(page, '#waiting-line'), 'Cashed out 7 tNIGHT. Your wallet: 5,007. Left in the cage: 0. You brought 10, you’re leaving with 7: down 3 this session.');
  const said = await page.$$eval('#waiting-log li', (lis) => lis.map((li) => li.textContent.replace(/^\S+ (AM|PM) /, '')));
  for (const line of ['Standing up from table', 'You’re signing to cash out 7 tNIGHT to your wallet.', 'Sending 7 tNIGHT back to your wallet…']) assert.ok(said.some((l) => l.startsWith(line)), `the window said "${line}": ${said.join(' | ')}`);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), `cage.brought.${ADDRESS}`), null, 'the cage is empty: the next deposit starts a new session');
  await hall.waitForFunction(() => document.getElementById('inflight')?.hidden === true, null, { timeout: 10000 });
  await hall.close();
  assert.deepEqual((await calls(page)).map((c) => [c[0], c[1]]), [['stand', String((await (await fetch(`${BASE}/tables/${id}`)).json()).cage.table)], ['withdraw', '7000000']]);
  assert.equal(await text(page, '#waiting-title'), 'Done');
  assert.ok(page.url().includes(`/table?id=${id}`), 'still at the table');
  await page.waitForSelector('#join-box:not([hidden])', { timeout: 10000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('cash out from the cage page itself, with nothing at a table: one approval, straight to the wallet', { timeout: 60000 }, async () => {
  const { page, context } = await open(`${lace()}; ${await signedIn()} window.__cage = { balance: 12000000n, seat: null, table: null };`, { cage: BRING_CAGE, path: '/wallet?door=1' });
  await page.click(LACE);
  await tilesUp(page);
  assert.equal(await text(page, '#cash-out'), 'Cash out 12 tNIGHT');
  assert.match(await text(page, '#cash-note'), /^Cash out can only go back to your own wallet: mn_addr_preprod1qqqqte…$/);
  assert.ok(await page.$eval('#cash-row', (el) => el.classList.contains('leads') && el.parentElement.firstElementChild === el), 'the cage holds something: Cash out leads the door page (11-07)');
  await page.click('#cash-out');
  await page.waitForSelector('#cash-ask:not([hidden])');
  await page.fill('#cash-amount', '5');
  await page.click('#cash-some'); // part of it: 5 of the 12
  await page.waitForSelector('#waiting:not([hidden])');
  assert.equal(await text(page, '#waiting-title'), 'Cashing out 5 tNIGHT');
  assert.match(await text(page, '#waiting-intro'), /^1 transaction: 1 prompt in Lace\. Under a minute\./);
  await page.waitForFunction(() => /^Cashed out 5 tNIGHT\./.test(document.getElementById('waiting-line').textContent), null, { timeout: 15000 });
  assert.equal(await text(page, '#waiting-line'), 'Cashed out 5 tNIGHT. Your wallet: 5,005. Left in the cage: 7.', 'what stays is said; no session line without a deposit seen in this browser');
  assert.deepEqual(await calls(page), [['withdraw', '5000000']], 'the amount asked for, and nothing else');
  await context.close();
});

test('already seated here with a good session: the button says there is nothing to approve; with no session it asks for the one signature (11-09)', { timeout: 60000 }, async () => {
  const { id, state } = await tnightTable();
  const onChain = `window.__cage = { balance: 52000000n, seat: { table: ${state.cage.table}n, epoch: 1n, atRisk: 50000000n, standing: false }, table: { epoch: 1n, seated: 1n, heartbeat: BigInt(Math.floor(Date.now() / 1000)) } };`;
  const auto = "localStorage.setItem('cage.wallet', 'io.lace.wallet'); localStorage.setItem('cage.wallet.auto', '1');";
  for (const [label, session, want] of [['signed in', await signedIn(), 'Sit with 50 tNIGHT · nothing to approve'], ['no session', '', 'Sign once and take my seat']]) {
    const { page, context } = await open(`${lace()}; ${session} ${auto} ${onChain}`, { cage: BRING_CAGE, path: `/table?id=${id}`, ...(SHOT_W ? { viewport: { width: 390, height: 844 } } : {}) });
    await page.waitForFunction((w) => document.querySelector('#cage-join #buy-go')?.textContent === w, want, { timeout: 20000 }).catch(() => {});
    await page.$eval('#cage-join #buy-go', (b) => b.scrollIntoView({ block: 'center' })).catch(() => {});
    await shot(page, `seat-button-${label.replace(/ /g, '-')}`);
    assert.equal(await text(page, '#cage-join #buy-go'), want, label);
    if (session) assert.equal(await text(page, '#cage-join #summary-amount'), '50 tNIGHT at risk, already on chain at this table: the judge only reads it', 'the summary says the same amount as the button');
    await context.close();
  }
});

test('a move still going on another page shows as a banner on any page, and finishes there: the seat is theirs once the judge has moved it (11-09)', { timeout: 60000 }, async () => {
  const { id: from } = await tnightTable();
  const { id: to, state: toState } = await tnightTable();
  const claim = await (await fetch(`${BASE}/tables/${to}/cage-seat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'The owner', cageId: CAGE_ID, verifyingKey: 'vk', signature: 'sig' }) })).json();
  const rec = { kind: 'move', to: { api: '/tables', page: '/table', name: 'Sealed Hand', tableId: to, table: toState.cage.table }, fromTableId: from, at: Date.now() };
  const script = `localStorage.setItem('hall.inflight', ${JSON.stringify(JSON.stringify(rec))}); localStorage.setItem('cage.claim.${to}', ${JSON.stringify(claim.token)}); localStorage.setItem('hall.seat.${from}', 'old-seat');`;
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const { page, errors, context } = await open(script, { viewport, path: '/' });
    await page.waitForSelector('#inflight:not([hidden])', { timeout: 10000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/banner-move-hall-${viewport.width}.png` });
    assert.match(await text(page, '#inflight'), new RegExp(`^Moving your seat to Sealed Hand, table ${toState.cage.table}: your last round finishes first, then the judge moves your seat\\. Nothing to approve\\. \\d:\\d\\d Go there$`));
    const box = await page.$eval('#inflight', (b) => { const r = b.getBoundingClientRect(); return { w: r.width, vw: window.innerWidth, scroll: document.documentElement.scrollWidth }; });
    assert.ok(box.w <= box.vw && box.scroll <= box.vw, `fits at ${viewport.width}: ${JSON.stringify(box)}`);
    if (viewport.width === 390) {
      await judge(to, 'verified', { cageId: CAGE_ID, ok: true, atRiskStar: '50000000', balanceStar: '52000000', epoch: 1 });
      await page.waitForFunction(() => /^Seated at Sealed Hand, table \d+ ✓/.test(document.getElementById('inflight')?.textContent ?? ''), null, { timeout: 15000 });
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/banner-move-seated-390.png` });
      assert.equal(await page.getAttribute('#inflight a', 'href'), `/table?id=${to}`);
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), `hall.seat.${to}`), claim.token, 'the seat token is theirs now, so the table shows the seat');
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), `hall.seat.${from}`), null, 'the old seat is gone');
      assert.equal(await page.evaluate(() => localStorage.getItem('hall.inflight')), null);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('top up at the table: the same tiles in a panel; the plan leaves, waits for the judge and puts in the difference, and a table that has moved on says so, in place', { timeout: 90000 }, async () => {
  const { id, state, token, onChain } = await seatedAtTable();
  const script = `${lace()}; ${await signedIn()} localStorage.setItem('hall.seat.${id}', ${JSON.stringify(token)}); localStorage.setItem('cage.wallet', 'io.lace.wallet'); localStorage.setItem('cage.wallet.auto', '1'); ${onChain}`;
  const { page, context } = await open(script, { cage: BRING_CAGE, path: `/table?id=${id}` });
  await page.waitForSelector('#leave-cash #top-up:not([disabled])', { timeout: 20000 });
  await page.click('#leave-cash #top-up');
  await page.waitForSelector('#top-up-body .tile[data-amount]', { timeout: 15000 });
  await page.click(`#top-up-body ${tile(100)}`);
  assert.match(await text(page, '#top-up-body #summary-approvals'), /^1 in Lace to put 93 in the cage\.$/, 'leaving asks nothing, and keeps the permit');
  assert.equal(await text(page, '#top-up-body #buy-go'), 'Leave and sit again with 100 tNIGHT');
  await page.click('#top-up-body #buy-go');
  await page.waitForSelector('#waiting:not([hidden])');
  assert.match(await text(page, '#waiting-intro'), /^1 transaction: 1 prompt in Lace\./);
  await page.waitForFunction(() => /The judge frees your seat/.test(document.getElementById('stages').textContent), null, { timeout: 15000 });
  assert.deepEqual(await calls(page), [], 'nothing on chain from this page yet: the table was told');
  await judge(id, 'released', { cageId: CAGE_ID });
  await page.evaluate(() => { window.__cage.seat = null; window.__cage.table = null; });
  await page.waitForFunction(() => /is in the cage\. This table has moved on/.test(document.querySelector('#top-up-body #bring-status')?.textContent ?? ''), null, { timeout: 20000 });
  assert.deepEqual((await calls(page)).map((c) => [c[0], c[2] ?? c[1]]), [['deposit', '93000000']], `no stand, at table ${state.cage.table}`);
  assert.equal(await text(page, '#waiting-title'), 'Money in the cage');
  assert.ok(page.url().includes(`/table?id=${id}`), 'still at the table');
  await context.close();
});

// ---------- the same footer everywhere (11-04): Support the build, with its copy buttons, on every public page ----------

test('Support the build sits at the bottom of the cage, table, dice and receipt pages, with a working Copy for each entry', { timeout: 60000 }, async () => {
  const { SUPPORT } = await import('../public/js/support.js');
  const { id } = await tnightTable();
  const dice = await (await fetch(`${BASE}/dice-tables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lobbySeconds: 300 }) })).json();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.route('https://fonts.**', (r) => r.abort());
  for (const path of ['/wallet', `/table?id=${id}`, `/dice?id=${dice.id}`, '/receipt/1-1']) {
    await page.goto(`${BASE}${path}`);
    await page.waitForSelector('#support #support-open', { timeout: 15000 });
    assert.deepEqual(await page.$$eval('#support [data-copy]', (els) => els.map((e) => e.dataset.copy)), SUPPORT.map((s) => s.label), path);
    assert.match(await page.textContent('.page-support #support-title'), /Support the build/, path);
    const last = await page.evaluate(() => { const f = document.querySelector('.page-support'); const rest = [...document.body.querySelectorAll('main, section.box, footer')].filter((el) => !el.hidden && !f.contains(el) && el !== f); return rest.every((el) => el.getBoundingClientRect().bottom <= f.getBoundingClientRect().top + 1); });
    assert.ok(last, `${path}: the footer is the last thing on the page`);
    await page.click('#support-open'); // the addresses open on a tap, shortened on screen (11-08)
    await page.click(`[data-copy="${SUPPORT[0].label}"]`);
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())) === SUPPORT[0].address, true, `${path} copies the exact address`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `${path}: ${over}px over on a phone`);
  }
  await context.close();
});

// ---------- a wallet that says nothing: a real window, with steps ----------

const noAnswerOpen = (page) => page.waitForSelector('#waiting.no-answer:not([hidden])', { timeout: 30000 });
const steps = (page) => page.$$eval('#trouble-steps li', (l) => l.map((x) => x.textContent));

test('Lace says nothing after a click: a pop-up with the steps, Try again and Refresh, not small text. A late answer closes it', { timeout: 60000 }, async () => {
  const { page, errors, context } = await open(lace({ connect: 'if (window.__hang) await new Promise((r) => { window.__answer = r; });' }));
  await page.evaluate(() => { window.__hang = true; });
  await page.waitForSelector(LACE);
  await page.click(LACE);
  await noAnswerOpen(page);
  assert.equal(await page.textContent('#waiting-title'), 'Lace didn’t answer');
  const list = await steps(page);
  assert.equal(list.length, 4);
  assert.match(list[0], /^Open Lace from your browser’s toolbar\.$/);
  assert.match(list[1], /^Unlock it/);
  assert.match(list[2], /Try again/);
  assert.match(list[3], /Refresh this page/);
  assert.ok(await page.isVisible('#trouble-retry'), 'retry');
  assert.ok(await page.isVisible('#trouble-refresh'), 'refresh');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/no-answer.png` });
  const box = await page.$eval('#waiting', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, shown: getComputedStyle(el).display !== 'none' }; });
  assert.ok(box.shown && box.w > 300 && box.h > 150, 'a window, not a line of text');
  await page.evaluate(() => window.__answer());
  await page.waitForSelector('#waiting.no-answer', { state: 'hidden', timeout: 10000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('Lace says nothing when the page reconnects by itself: the same pop-up, and Try again asks it again', { timeout: 60000 }, async () => {
  const { page, errors, context } = await open(`${lace({ connect: 'if (window.__hang) await new Promise(() => {});' })}; localStorage.setItem('cage.wallet', 'io.lace.wallet'); localStorage.setItem('cage.wallet.auto', '1'); window.__hang = true;`);
  await noAnswerOpen(page);
  assert.equal((await steps(page)).length, 4);
  await page.evaluate(() => { window.__hang = false; });
  await page.click('#trouble-retry');
  await page.waitForSelector('#wallet:not([hidden])', { timeout: 20000 });
  assert.ok(!(await page.isVisible('#waiting.no-answer')));
  assert.deepEqual(errors, []);
  await context.close();
});

test('Lace goes silent after connecting: reading the balance brings up the pop-up, not a word in the balance line', { timeout: 60000 }, async () => {
  const { page, errors, context } = await open(lace());
  await page.addInitScript('');
  await page.evaluate(() => {
    for (const w of Object.values(window.midnight)) {
      const real = w.connect;
      Object.defineProperty(w, 'connect', { value: async (n) => { const api = await real(n); return { ...api, getUnshieldedBalances: () => new Promise(() => {}) }; } });
    }
  });
  await page.click(LACE);
  await noAnswerOpen(page);
  assert.equal((await steps(page)).length, 4);
  assert.deepEqual(errors, []);
  await context.close();
});

/**
 * Every new context starts with Tally's Sealed Hand walkthrough marked as seen (it shows once, the first time a seat is
 * yours, and would sit over the moves), unless it's made with { guide: true }, as the tests of the walkthrough itself are.
 */
function seenHandGuide(b) {
  const make = b.newContext.bind(b);
  b.newContext = async ({ guide = false, ...options } = {}) => {
    const context = await make(options);
    if (!guide) await context.addInitScript(() => { try { localStorage.setItem('hall.hand.guided', '1'); } catch { /* storage blocked: the test says so itself */ } });
    return context;
  };
}

test('No DUST yet (11-08 pass #3, #7, #15): 1AM leads the picker; a Lace with tNIGHT and no DUST sees what to do, not amounts; Refresh reads again', { timeout: 60000 }, async () => {
  const { page, context, errors } = await open(installed(oneAm({ dust: 0 }), { dust: 0 }), { cage: BRING_CAGE });
  await page.waitForSelector(ONE_AM);
  assert.deepEqual(await page.$$eval('.wallet-choice', (b) => b.map((x) => x.dataset.wallet)), ['com.midnight.1am', 'io.lace.wallet']);
  assert.match(await text(page, '#wallet-tip'), /1AM is the tested wallet here/);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/picker-1am-recommended.png` });
  await page.click(LACE);
  await page.waitForSelector('#dust-wall:not([hidden])', { timeout: 15000 });
  assert.equal(await text(page, '#dust-wall-text'), 'Your wallet has no DUST yet, so it can’t pay the network fee. In Lace: DUST → register your tNIGHT (one signature), wait a few minutes, then Refresh.');
  assert.equal(await page.isHidden('#tiles'), true, 'no amounts offered yet');
  assert.equal(await text(page, '#dust-badge'), 'Not ready yet: no DUST');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/no-dust-wall.png`, fullPage: true });
  await page.click('#dust-refresh');
  await page.waitForSelector('#dust-wall:not([hidden])');
  assert.deepEqual(errors, []);
  await context.close();
});
