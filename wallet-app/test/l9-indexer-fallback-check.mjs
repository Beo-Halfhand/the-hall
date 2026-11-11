// The wallet page on a Hall (default: staging) in headless Chrome, with the REAL Ledger 9 bundle reading the REAL cage, and a DApp Connector
// stand-in for 1AM whose own indexer answers a block height but has no copy of the cage (the 11-09 browser test). Nothing is sent: the
// stand-in refuses to balance or submit. The wallet address is wallet a's public faucet address; no key or seed is read.
//   node wallet-app/test/l9-indexer-fallback-check.mjs [baseUrl] [shotsDir] [tag]
// Prints what the page said (the Indexer check, the cage line, the first-step note, the DUST badge) and exits 1 if the cage was not read.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const BASE = (process.argv[2] ?? 'https://sealed-hand-staging.halfhand.workers.dev').replace(/\/$/, '');
const SHOTS = process.argv[3] ?? null;
const TAG = process.argv[4] ?? 'check';
const ADDRESS = readFileSync(join(process.env.WORKSPACE ?? '..', 'sealed-cage-l9', '.wallets', 'a.address'), 'utf8').trim(); // public
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE ?? join(process.env.WORKSPACE ?? '..', 'sealed-hand-hall-package', 'node_modules', 'playwright-core');
const { chromium } = createRequire(`${ROOT}/`)(PLAYWRIGHT);
const mask = (t) => String(t).replace(/mn_[a-z_]+1[0-9a-z]+/g, 'mn_…');

const INSTALL = (address) => `
  const toBig = (s) => BigInt(s);
  const api = {
    getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }),
    getUnshieldedAddress: async () => ({ unshieldedAddress: ${JSON.stringify(address)} }),
    getDustAddress: async () => ({ dustAddress: 'mn_dust_preprod1standin' }),
    getShieldedAddresses: async () => ({ shieldedAddress: 'standin', shieldedCoinPublicKey: '00'.repeat(32), shieldedEncryptionPublicKey: '00'.repeat(32) }),
    getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: 5006400000n }),
    getDustBalance: async () => ({ balance: 4387000000000000000n, cap: 9000000000000000000n }),
    getConfiguration: async () => ({ networkId: 'preprod', indexerUri: 'https://1am-indexer.test/graphql', indexerWsUri: 'wss://1am-indexer.test/ws', substrateNodeUri: 'https://node.test' }),
    hintUsage: async () => {},
    balanceUnsealedTransaction: async () => { throw new Error('stand-in: nothing is sent from this check'); },
    submitTransaction: async () => { throw new Error('stand-in: submit refused'); },
  };
  window.midnight = { [crypto.randomUUID()]: { name: '1AM', rdns: 'com.midnight.1am', apiVersion: '4.1.0', icon: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', connect: async () => api } };
`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let ok = false;
for (const [label, viewport, mobile] of [['1280', { width: 1280, height: 900 }, {}], ['390', { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(mask(e.message).slice(0, 200)));
  await page.addInitScript(INSTALL(ADDRESS));
  // 1AM's own indexer, as in the test: it answers { block { height } } and has no copy of the cage.
  await page.route('https://1am-indexer.test/**', (r) => (r.request().method() === 'OPTIONS'
    ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"data":{"block":{"height":3351900,"protocolVersion":2001100},"contract":null}}' })));
  await page.goto(`${BASE}/wallet?door=1`);
  await page.click('[data-wallet="com.midnight.1am"]');
  // Done when either the amounts show, or the page has given up on reading the cage.
  await page.waitForFunction(() => document.querySelector('.tile[data-amount]') || !document.getElementById('cage-trouble')?.hidden || /Couldn’t read the cage|No contract/.test(document.body.textContent), null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const t = (sel) => page.textContent(sel).then((x) => x.replace(/\s+/g, ' ').trim()).catch(() => '(none)');
  const tiles = (await page.$$('.tile[data-amount]')).length;
  console.log(`--- ${label}px`);
  console.log(`Indexer check : ${mask(await t('[data-check="Indexer"]'))}`);
  console.log(`First-step note: ${await t('#connected-note')}`);
  console.log(`DUST badge     : ${await t('#dust-badge')}`);
  console.log(`In the cage now: ${await t('#cage-balance')}`);
  console.log(`Trouble box    : ${(await page.isVisible('#cage-trouble').catch(() => false)) ? `${await t('#cage-trouble-text')} || raw: ${mask(await t('#cage-trouble-raw'))}` : '(none)'}`);
  console.log(`Under the button: ${await t('#buy-go-why')}`);
  console.log(`Amount tiles   : ${tiles}`);
  console.log(`Page errors    : ${errors.length ? errors.join(' | ') : 'none'}`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${TAG}-${label}.png`), fullPage: true });
  if (label === '1280') ok = tiles > 0 && !(await page.isVisible('#cage-trouble').catch(() => false)) && errors.length === 0;
  await context.close();
}
await browser.close();
console.log(ok ? 'PASS: the page read the cage and showed amounts' : 'FAIL: the page did not read the cage');
process.exit(ok ? 0 : 1);
