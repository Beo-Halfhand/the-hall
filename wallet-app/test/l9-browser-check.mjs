// Ledger 9 check of the BUILT bundle (dist/cage.js, dist/dice-proof.js) in headless Chrome, under the wallet page's own CSP
// (withWalletHeaders in src/platform/http.js): the two ledgers' WebAssembly load, and the page code reads cage4 and dice-proof
// from preprod through Midnight.js 5. Read only: the pretend wallet refuses to balance or submit. 11-09.
// Endpoint values go to the page in memory only, and are never printed. Run by hand: node wallet-app/test/l9-browser-check.mjs
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const DIST = new URL('../dist', import.meta.url).pathname;
const L9 = process.env.SEALED_CAGE_L9 ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-l9');
const CAGE_BUILD = join(process.env.WORKSPACE ?? '..', 'sealed-cage-v4b-wire', 'contracts', 'managed', 'sealed-cage');
const DICE_BUILD = join(process.env.WORKSPACE ?? '..', 'sealed-cage-dice-proof', 'contracts', 'managed', 'dice-proof');
const { redact } = await import(join(L9, 'scripts', 'mask-stdio.mjs'));
const { loadEndpoints } = await import(join(L9, 'scripts', 'endpoints.mjs'));
const say = (m) => console.log(redact(m));
const EP = loadEndpoints();
if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}`);
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' chrome-extension: moz-extension:; worker-src 'self' blob: chrome-extension: moz-extension:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https: chrome-extension: moz-extension:; connect-src 'self' https: wss: http://localhost:6300; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };
const cageAddress = JSON.parse(readFileSync(join(L9, 'deployment.cage4.json'), 'utf8')).address;
const diceAddress = JSON.parse(readFileSync(join(process.env.WORKSPACE ?? '..', 'sealed-cage-dice-proof', 'deployment.dice.json'), 'utf8')).address;
const walletAddress = readFileSync(join(L9, '.wallets', 'a.address'), 'utf8').trim(); // public

const fileFor = (path) => {
  const p = normalize(path);
  if (p.includes('..')) return null;
  if (p === '/' || p === '/check.html') return { body: '<!doctype html><meta charset="utf-8"><title>l9 check</title><script type="module" src="/check.js"></script>', type: '.html' };
  if (p === '/check.js') return { body: 'window.__ready = true;', type: '.js' };
  const zk = /^\/wallet-app\/(zk|zk-dice)\/((?:keys|zkir|compiler)\/.+)$/.exec(p);
  if (zk) { const f = join(zk[1] === 'zk' ? CAGE_BUILD : DICE_BUILD, zk[2]); return existsSync(f) ? { body: readFileSync(f), type: extname(f) } : null; }
  const m = /^\/wallet-app\/(.+)$/.exec(p);
  if (m) { const f = join(DIST, m[1]); return existsSync(f) ? { body: readFileSync(f), type: extname(f) } : null; }
  return null;
};
const server = createServer((req, res) => {
  const f = fileFor(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[f.type] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
  res.end(f.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const { chromium } = createRequire(`${ROOT}/`)('playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
let ok = false;
try {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => problems.push(redact(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) problems.push(redact(m.text()).slice(0, 300)); });
  // 404s are listed by path. The two expected: favicon, and compiler/contract-manifest.json, which 0.31.1 doesn't write (require-if-present).
  page.on('response', (r) => { if (r.status() === 404) { const path = new URL(r.url()).pathname; if (!/favicon|contract-manifest\.json$/.test(path)) problems.push(`404 ${path}`); else say(`expected 404: ${path}`); } });
  await page.goto(`${BASE}/check.html`);
  await page.waitForFunction(() => window.__ready === true);
  const out = await page.evaluate(async ({ cageAddress, diceAddress, http, ws, walletAddress }) => {
    const api = {
      getShieldedAddresses: async () => ({ shieldedAddress: 'x', shieldedCoinPublicKey: '00'.repeat(32), shieldedEncryptionPublicKey: '00'.repeat(32) }),
      balanceUnsealedTransaction: async () => { throw new Error('stub-stop: nothing is sent from this check'); },
      submitTransaction: async () => { throw new Error('stub-stop: submit refused'); },
    };
    const r = {};
    const cage = await import('/wallet-app/cage.js');
    const s = await cage.openCage({ api, address: cageAddress, indexerHttp: http, indexerWs: ws, walletAddress, zkBase: `${location.origin}/wallet-app/zk`, walletName: 'Lace' });
    const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const v = await s.read(sk);
    r.cage = { escape: String(v.escapeSecs), cap: String(v.roundCap), maxGrant: String(v.maxGrant), judge: v.judge.slice(0, 12), balance: String(v.balance) };
    r.found = (await s.findByAddress()).map((f) => ({ id: f.id.slice(0, 12), balance: String(f.balance) }));
    const dice = await import('/wallet-app/dice-proof.js');
    const d = await dice.openDiceProof({ api, address: diceAddress, indexerHttp: http, indexerWs: ws, zkBase: `${location.origin}/wallet-app/zk-dice`, walletName: 'Lace' });
    r.diceRoundMissing = (await d.readRound(999999, 1, [0, 1])) === null;
    return r;
  }, { cageAddress, diceAddress, http: EP.indexer, ws: EP.indexerWS, walletAddress });
  say(`cage4 read in Chrome: ${JSON.stringify(out.cage)}`);
  say(`ids paying out to wallet a: ${JSON.stringify(out.found)}`);
  say(`dice-proof read in Chrome: an unplayed round reads as none: ${out.diceRoundMissing}`);
  ok = out.cage.escape === '1800' && out.cage.maxGrant === '2592000' && out.found.length > 0 && out.diceRoundMissing === true;
} catch (e) { problems.push(redact(e?.message ?? e).slice(0, 600)); }
await browser.close();
server.close();
const real = problems.filter((p) => !/no ZK artifact manifest/.test(p));
say(real.length ? `page problems:\n  ${real.join('\n  ')}` : 'page problems: none');
say(ok && !real.length ? 'PASS: the built bundle loads under the wallet CSP and reads cage4 and dice-proof on ledger 9' : 'FAIL');
process.exit(ok && !real.length ? 0 : 1);
