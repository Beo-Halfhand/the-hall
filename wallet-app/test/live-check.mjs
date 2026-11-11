// Runs the real bundle in headless Chrome under the page's real CSP, with a pretend Lace. Reads the cage from preprod and
// proves through the proof server on this machine. Lace's balance and submit are stubbed to refuse, so nothing can be sent.
// Run by hand: node wallet-app/test/live-check.mjs   (needs sealed-cage installed, its endpoints file, and localhost:6300)
// Endpoints come from sealed-cage's loader and go to the page in memory. They're never printed, logged or written.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../..', import.meta.url).pathname;
const CAGE = process.env.SEALED_CAGE_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage');
const PORT = 8841;
const BASE = `http://127.0.0.1:${PORT}`;
const scrub = (s) => String(s).replace(/project_id=[^&\s"'<>)]+/gi, 'project_id=***').replace(/night(preprod|mainnet|preview)[A-Za-z0-9]+/g, 'night$1***');
const say = (...a) => console.log(scrub(a.join(' ')));
const fromCage = (spec) => import(pathToFileURL(join(CAGE, spec)).href);
const hex = (u8) => Buffer.from(u8).toString('hex');

await fromCage('scripts/pin-runtime.mjs');
const { WebSocket } = await fromCage('node_modules/ws/wrapper.mjs');
globalThis.WebSocket = WebSocket;
const { chromium } = createRequire(`${ROOT}/`)('playwright-core');
const { loadEndpoints } = await fromCage('scripts/endpoints.mjs');
const EP = loadEndpoints();
if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}`);
if (/mainnet/i.test(EP.indexer)) throw new Error('STOP: indexer names mainnet');

const { httpClientProvingProvider } = await fromCage('node_modules/@midnight-ntwrk/midnight-js-http-client-proof-provider/dist/index.mjs');
const { NodeZkConfigProvider } = await fromCage('node_modules/@midnight-ntwrk/midnight-js-node-zk-config-provider/dist/index.mjs');
const ledger = await fromCage('node_modules/@midnight-ntwrk/midnight-js-protocol/dist/ledger.mjs');
const { HDWallet, Roles, createKeystore } = await fromCage('node_modules/@midnightntwrk/wallet-sdk/dist/index.js').catch(() => ({}));

let results = [];
const check = (name, ok, detail = '') => { results.push(ok); say(`${ok ? 'ok ' : 'NOT'} ${name}${detail ? ` · ${detail}` : ''}`); };

// A throwaway keystore: a random seed held in memory, for checking the address conversion. It never holds funds.
const seed = crypto.getRandomValues(new Uint8Array(32));
const hd = HDWallet.fromSeed(seed);
const key = hd.hdWallet.selectAccount(0).selectRoles([Roles.NightExternal]).deriveKeysAt(0).keys[Roles.NightExternal];
const keystore = createKeystore(key, 'preprod');
const bech32 = keystore.getBech32Address().asString();
const addressHex = String(keystore.getAddress());
const mainnetAddress = createKeystore(key, 'mainnet').getBech32Address().asString();

// A real depositor's address from cage #2's public payout list, for reading a real entry. Public data only.
const { indexerPublicDataProvider } = await fromCage('node_modules/@midnight-ntwrk/midnight-js-indexer-public-data-provider/dist/index.mjs');
const { ledger: cageLedger } = await fromCage('contracts/managed/sealed-cage/contract/index.js');
const { MidnightBech32m, UnshieldedAddress } = await fromCage('node_modules/@midnightntwrk/wallet-sdk-address-format/dist/index.js');
const { readFileSync } = await import('node:fs');
const cageTwo = JSON.parse(readFileSync(join(CAGE, 'deployment.cage2.json'), 'utf8')).address;
const onChain = cageLedger((await indexerPublicDataProvider(EP.indexer, EP.indexerWS).queryContractState(cageTwo)).data);
const [firstId, firstTo] = [...onChain.payTo][0];
const realAddress = MidnightBech32m.encode('preprod', new UnshieldedAddress(Buffer.from(firstTo.bytes))).asString();

const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
for (const name of Object.keys(env)) if (name.startsWith('CLOUDFLARE_') || name.startsWith('CF_')) delete env[name];
const server = spawn(join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '--config', 'wrangler.dev.toml', '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', String(PORT + 1000), '--persist-to', mkdtempSync(join(tmpdir(), 'cage-live-')), '--log-level', 'warn', '--var', 'WALLET_PAGE:on', '--var', 'TNIGHT_TABLES:on'], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page;
const problems = [];
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/wallet`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const zk = new NodeZkConfigProvider(join(CAGE, 'contracts/managed/sealed-cage'));
  const prover = httpClientProvingProvider('http://127.0.0.1:6300', zk);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage();
  page.on('pageerror', (e) => problems.push(scrub(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|wasm/i.test(m.text())) problems.push(scrub(m.text())); });

  await page.exposeFunction('__nodeCheck', async (preimageHex, loc) => (await prover.check(Buffer.from(preimageHex, 'hex'), loc)).map((v) => (v === undefined ? null : v.toString())));
  await page.exposeFunction('__nodeProve', async (preimageHex, loc, overwrite) => hex(await prover.prove(Buffer.from(preimageHex, 'hex'), loc, overwrite == null ? undefined : BigInt(overwrite))));
  // Binds the unbound transaction the way a wallet would, adding nothing, so the no-tDUST count has something real to read.
  await page.exposeFunction('__nodeBind', async (txHex) => hex(ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(txHex, 'hex')).bind().serialize()));
  await page.addInitScript(({ address, http, ws }) => {
    const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    const fromHex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
    window.__seen = { balance: [], submits: 0, material: {} };
    window.__stopAtBalance = true;
    const api = {
      getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }),
      getUnshieldedAddress: async () => ({ unshieldedAddress: address }),
      getDustAddress: async () => ({ dustAddress: 'mn_dust_preprod1test' }),
      getShieldedAddresses: async () => ({ shieldedAddress: 'x', shieldedCoinPublicKey: '00'.repeat(32), shieldedEncryptionPublicKey: '00'.repeat(32) }),
      getUnshieldedBalances: async () => ({ ['0'.repeat(64)]: 5000000000n }),
      getDustBalance: async () => ({ balance: 2500000000000000n, cap: 25000000000000000000n }),
      getConfiguration: async () => ({ networkId: 'preprod', indexerUri: http, indexerWsUri: ws, proverServerUri: 'http://localhost:6300', substrateNodeUri: 'https://node.test' }),
      getProvingProvider: async (km) => {
        const pull = async (loc) => {
          const [p, v, z] = await Promise.all([km.getProverKey(loc), km.getVerifierKey(loc), km.getZKIR(loc)]);
          window.__seen.material[loc] = [p.length, v.length, z.length];
        };
        return {
          check: async (pre, loc) => { await pull(loc); return (await window.__nodeCheck(toHex(pre), loc)).map((v) => (v === null ? undefined : BigInt(v))); },
          prove: async (pre, loc, over) => fromHex(await window.__nodeProve(toHex(pre), loc, over === undefined ? null : over.toString())),
        };
      },
      balanceUnsealedTransaction: async (tx, options) => {
        window.__seen.balance.push({ hexLength: tx.length, options: options ?? null });
        if (window.__stopAtBalance) throw new Error('stub-stop: nothing is sent from this test');
        return { tx: await window.__nodeBind(tx) };
      },
      submitTransaction: async () => { window.__seen.submits += 1; throw new Error('stub-stop: submit refused'); },
    };
    window.__api = api;
    window.midnight = { [crypto.randomUUID()]: { name: 'lace', rdns: 'io.lace.wallet', apiVersion: '4.0.1', connect: async () => api } };
  }, { address: bech32, http: EP.indexer, ws: EP.indexerWS });

  // ---------- the real page, end to end, reading cage #2 ----------
  await page.goto(`${BASE}/wallet`);
  await page.click('[data-wallet="io.lace.wallet"]');
  await page.waitForFunction(() => /\S/.test(document.getElementById('cage-seat').textContent) && document.getElementById('cage-seat').textContent !== '…', null, { timeout: 45000 });
  check('page reads the cage through the bundle', (await page.textContent('[data-check="Contract code"]')).includes('Loaded'), scrub(await page.textContent('[data-check="Indexer"]')));
  check('balance shows', /tNIGHT|No player key/.test(await page.textContent('#cage-balance')), await page.textContent('#cage-balance'));
  check('buttons stay off on cage #2', await page.isDisabled('#deposit') && await page.isDisabled('#withdraw') && await page.isDisabled('#stand') && await page.isDisabled('#sit'));
  const body = await page.evaluate(() => document.documentElement.outerHTML);
  check('no project id on the page', !body.includes('project_id=') && !/nightpreprod[A-Za-z0-9]{4}/.test(body));

  // ---------- the module directly: nothing on the page can reach a write on cage #2 ----------
  const address = (await page.textContent('#cage-address')).trim();
  const out = await page.evaluate(async ({ address, http, ws, bech32, mainnetAddress, realAddress }) => {
    const code = await import('/wallet-app/cage.js');
    const session = await code.openCage({ api: window.__api, address, indexerHttp: http, indexerWs: ws, walletAddress: bech32, zkBase: `${location.origin}/wallet-app/zk`, walletName: 'Lace' });
    const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    const sk = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const r = { payout: toHex(session.payoutOf().bytes) };
    const v = await session.read(sk);
    r.read = { id: v.id, balance: String(v.balance), bound: v.bound, ours: v.ours, seat: v.seat, escape: String(v.escapeSecs), cap: String(v.roundCap) };
    r.found = (await session.findByAddress()).length;
    r.notPreprod = await code.openCage({ api: window.__api, address, indexerHttp: http, indexerWs: ws, walletAddress: mainnetAddress, zkBase: `${location.origin}/wallet-app/zk` }).then(() => 'opened', (e) => `refused: ${e.message}`);
    const real = await code.openCage({ api: window.__api, address, indexerHttp: http, indexerWs: ws, walletAddress: realAddress, zkBase: `${location.origin}/wallet-app/zk` });
    const hits = await real.findByAddress();
    r.real = hits.map((h) => ({ id: h.id, balance: String(h.balance), idBytes: h.idBytes.length }));
    const stages = [];
    try {
      await session.call('deposit', sk, [session.payoutOf(), 1000000n], (s) => stages.push(s));
      r.deposit = 'returned';
    } catch (e) { r.deposit = e.message; }
    r.stages = stages;
    window.__stopAtBalance = false;
    const stages2 = [];
    try {
      r.probe = await session.probeNoDust('deposit', sk, [session.payoutOf(), 1000000n], (s) => stages2.push(s));
    } catch (e) { r.probe = { error: e.message }; }
    r.stages2 = stages2;
    r.seen = JSON.parse(JSON.stringify(window.__seen));

    // A wallet that drops the page, first before sending and then after, on the real bundle. These wallets send nothing.
    const core = await import('/js/wallet-core.js');
    const lost = () => Object.assign(new Error('gone'), { type: 'DAppConnectorAPIError', code: 'Disconnected' });
    const dropped = { provers: 0, submits: 0, wrongBalance: 0 };
    const original = window.__api;
    const counted = (km) => { dropped.provers += 1; return original.getProvingProvider(km); };
    const report = async () => {
      try {
        await session.call('deposit', sk, [session.payoutOf(), 1000000n]);
        return { returned: true };
      } catch (e) { return { lost: core.isSessionLost(e), sent: session.sent(), message: e.message }; }
    };
    session.useApi({ ...original, getProvingProvider: counted, balanceUnsealedTransaction: async () => { throw lost(); } });
    r.dropBefore = await report();
    window.__stopAtBalance = false;
    session.useApi({ ...original, getProvingProvider: counted, submitTransaction: async () => { dropped.submits += 1; throw lost(); } });
    r.dropAfter = await report();
    r.dropped = dropped;
    return r;
  }, { address, http: EP.indexer, ws: EP.indexerWS, bech32, mainnetAddress, realAddress });

  check('bech32 address converts to the keystore’s address bytes', out.payout === addressHex);
  check('read with a fresh key', out.read.balance === '0' && !out.read.bound && out.read.seat === null && /^[0-9a-f]{64}$/.test(out.read.id), `escape ${out.read.escape}s, cap ${out.read.cap}`);
  check('payout list scanned', out.found === 0, `${out.found} entries for a new address`);
  check('a real depositor’s entry is found by address', out.real.some((h) => h.id === hex(firstId) && h.idBytes === 32), `${out.real.length} entries, balances ${out.real.map((h) => h.balance).join(', ')}`);
  check('an address not on preprod is refused', out.notPreprod.startsWith('refused'), out.notPreprod.slice(0, 90));
  check('deposit ran, proved, and stopped at balancing', /stub-stop/.test(out.deposit), out.deposit.slice(0, 90));
  check('ZK files fetched from this origin', JSON.stringify(out.seen.material.deposit ?? []) !== '[]' && out.seen.material.deposit.every((n) => n > 0), JSON.stringify(out.seen.material));
  check('a proven transaction reached balancing', out.seen.balance[0]?.hexLength > 1000, `${out.seen.balance[0]?.hexLength} hex chars, options ${JSON.stringify(out.seen.balance[0]?.options)}`);
  check('nothing was submitted', out.seen.submits === 0);
  check('stages shown in order', out.stages.join(' > ').includes('Proving') && out.stages.at(-1).includes('Lace'), out.stages.join(' > '));
  check('no-tDUST test asks Lace not to pay fees', out.seen.balance[1]?.options?.payFees === false);
  check('no-tDUST test reads the balanced transaction', out.probe?.dustSpends === 0, JSON.stringify(out.probe));
  check('a drop before sending reads as lost and not sent', out.dropBefore.lost === true && out.dropBefore.sent === false, JSON.stringify(out.dropBefore).slice(0, 160));
  check('a drop at submit reads as lost and sent, so it never resends', out.dropAfter.lost === true && out.dropAfter.sent === true && out.dropped.submits === 1, JSON.stringify(out.dropAfter).slice(0, 160));
  check('each new connection brings its own prover', out.dropped.provers === 2, `${out.dropped.provers} provers asked for`);
  check('no CSP or wasm errors', problems.length === 0, problems.slice(0, 3).join(' | ').slice(0, 300));
} catch (e) {
  results.push(false);
  say('FAILED', e?.message ?? e);
  if (page) say('page:', (await page.evaluate(() => document.getElementById('checks').innerText + ' | ' + document.getElementById('cage-balance').textContent + ' | ' + document.getElementById('log').innerText).catch((x) => x.message)));
  say('problems:', problems.slice(0, 6).join(' | '));
} finally {
  await browser.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
}
say(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
