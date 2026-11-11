// Ledger 9 check of the wallet page's cage code (11-09), against preprod, with a real wallet behind a DApp Connector API.
// src/cage.js runs here unchanged. testkit's DAppConnectorWalletAdapter wraps a wallet SDK 2 wallet (the e2e wallet `a`) in the
// same ConnectedAPI Lace gives a page: getProvingProvider (proof server 9 on :6302), balanceUnsealedTransaction, submitTransaction.
// It reads cage4, deposits 1 tNIGHT (an empty permit) and withdraws it again: two real transactions, each about 30 s.
// Seeds, keys and endpoint values are never printed. Run by hand: node test/l9-connector-check.mjs   (CHECK_SEND=0: read only)
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import * as Rx from 'rxjs';

const L9 = process.env.SEALED_CAGE_L9 ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-l9');
const BUILD = process.env.SEALED_CAGE_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-v4b-wire', 'contracts', 'managed', 'sealed-cage');
const WHO = process.env.CHECK_WALLET ?? 'a';
const SEND = process.env.CHECK_SEND !== '0';
const { redact } = await import(join(L9, 'scripts', 'mask-stdio.mjs'));
const { loadEndpoints } = await import(join(L9, 'scripts', 'endpoints.mjs'));
const t0 = Date.now();
const say = (m) => console.log(redact(`${new Date().toISOString()} [${Math.round((Date.now() - t0) / 1000)}s] ${m}`));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); say(`${ok ? 'ok ' : 'NOT'} ${name}${detail ? ` · ${detail}` : ''}`); };

const EP = loadEndpoints();
if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}`);
for (const u of [EP.node, EP.indexer, EP.indexerWS]) if (!/preprod/i.test(new URL(u).host)) throw new Error('STOP: an endpoint is not preprod');
const env = { walletNetworkId: 'preprod', networkId: 'preprod', indexer: EP.indexer, indexerWS: EP.indexerWS, node: EP.nodeHttp, nodeWS: EP.node, proofServer: 'http://127.0.0.1:6302' };

// The ZK files as the Worker serves them under /wallet-app/zk: keys, zkir and compiler/contract-info.json (no manifest: 0.31.1 writes none).
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/zk\//, '');
  const file = join(BUILD, path);
  if (path.includes('..') || !/^(keys|zkir|compiler)\//.test(path) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const zkBase = `http://127.0.0.1:${server.address().port}/zk`;

// ---------- the wallet behind the connector ----------
const W = await import('@midnightntwrk/wallet-sdk');
const { MidnightWalletProvider, DAppConnectorWalletAdapter } = await import('@midnight-ntwrk/testkit-js');
const seed = Uint8Array.from(Buffer.from(readFileSync(join(L9, '.wallets', `${WHO}.seed`), 'utf8').trim(), 'hex'));
const STATE = join(L9, '.wallets', `${WHO}.l9-state.json`);
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
const seeds = W.WalletSeeds.fromMasterSeed(seed);
const ks = W.createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, 'preprod');
const wallet = await W.WalletFacade.init({
  configuration: {
    networkId: 'preprod', forks: W.DefaultForkSchedule,
    indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS },
    provers: { v9: { kind: 'server', url: new URL(env.proofServer) } }, relayURL: new URL(env.nodeWS),
    txHistoryStorage: new W.InMemoryTransactionHistoryStorage(W.WalletEntrySchema, W.mergeWalletEntries),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  },
  shielded: (c) => (saved ? W.ShieldedWallet(c).restore(saved.shielded) : W.ShieldedWallet(c).startWithSeed(seeds.shielded)),
  unshielded: (c) => (saved ? W.UnshieldedWallet(c).restore(saved.unshielded) : W.UnshieldedWallet(c).startWithPublicKey(W.PublicKey.fromKeyStore(ks))),
  dust: (c) => (saved ? W.DustWallet(c).restore(saved.dust) : W.DustWallet(c).startWithSeed(seeds.dust)),
});
await wallet.start(seeds);
const synced = await wallet.waitForSyncedState();
say(`wallet ${WHO} synced · tNIGHT ${Number(synced.unshielded.balances['0'.repeat(64)] ?? 0n) / 1e6} · protocol ${synced.activeProtocolVersion}`);
const save = async () => { writeFileSync(`${STATE}.tmp`, JSON.stringify({ savedAt: new Date().toISOString(), shielded: await wallet.shielded.serializeState(), unshielded: await wallet.unshielded.serializeState(), dust: await wallet.dust.serializeState() }), { mode: 0o600 }); renameSync(`${STATE}.tmp`, STATE); };
const wp = await MidnightWalletProvider.withWallet({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } }, env, wallet, seeds, ks);
const api = new DAppConnectorWalletAdapter(wp, env);
// testkit's adapter proves in-process with ZKIR v3 only (compactc 0.36 output), and cage4's kept 0.31.1 circuits are ZKIR v2. So by
// default this wallet proves on proof server 9, as a Lace set to use a proof server does (CHECK_PROVER=testkit keeps testkit's).
if (process.env.CHECK_PROVER !== 'testkit') {
  const { httpClientProvingProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const proving = httpClientProvingProvider(env.proofServer, new NodeZkConfigProvider(BUILD, { verify: 'require-if-present' }));
  api.getProvingProvider = async () => proving;
}

// ---------- the page's code ----------
const code = await import('../src/cage.js');
const address = JSON.parse(readFileSync(join(L9, 'deployment.cage4.json'), 'utf8')).address;
const bech32 = ks.getBech32Address().asString?.() ?? String(ks.getBech32Address());
const sk = readFileSync(join(L9, '.wallets', `${WHO}.cage-key`), 'utf8').trim();
const session = await code.openCage({ api, address, indexerHttp: env.indexer, indexerWs: env.indexerWS, walletAddress: bech32, zkBase, walletName: 'the test wallet' });
const before = await session.read(sk);
check('read cage4 through the bundle code (ledger 9 state, 0.16 build)', before.escapeSecs === 1800n && before.maxGrant === 2592000n, `balance ${before.balance} STAR · bound ${before.bound} · ours ${before.ours} · seat ${before.seat ? 'yes' : 'none'}`);
check('this wallet is the payout address', before.ours === true);
const found = await session.findByAddress();
check('findByAddress finds this player id', found.some((f) => f.id === before.id), `${found.length} id(s)`);

if (SEND) {
  const stages = [];
  const dep = await session.call('deposit', sk, [session.payoutOf(), 1_000_000n, new Uint8Array(32), 0n, 0n], (s) => stages.push(s));
  say(`TX deposit (page code) · hash ${dep.txHash} · id ${dep.txId} · block ${dep.blockHeight} · ${dep.status}`);
  const mid = await session.read(sk);
  check('deposit 1 tNIGHT landed and the balance moved by exactly 1,000,000 STAR', String(dep.status) === 'SucceedEntirely' && mid.balance - before.balance === 1_000_000n, `stages: ${stages.join(' → ')}`);
  check('sent() is true after a submit', session.sent() === true);
  await save();
  await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const wd = await session.call('withdraw', sk, [1_000_000n], () => {});
  say(`TX withdraw (page code) · hash ${wd.txHash} · id ${wd.txId} · block ${wd.blockHeight} · ${wd.status}`);
  const after = await session.read(sk);
  check('withdraw 1 tNIGHT landed and the balance is back', String(wd.status) === 'SucceedEntirely' && after.balance === before.balance, `balance ${after.balance} STAR`);
  await save();
}

server.close();
await wallet.stop();
say(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
