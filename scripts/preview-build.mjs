// Assembles .preview-dist for the preview Worker: public/, the cage's address, and, once built, the contract code and ZK files.
// This page speaks cage v4b and can't read an older cage, so it needs a v4b deployment: CAGE_FILE in SEALED_CAGE_DIR (default deployment.cage4.json),
// and a v4b build there (scripts/cage-build-check.mjs). The bundle in wallet-app/dist has to be from the same build: it is checked too.
// Reads sealed-cage, never writes to it. Copies only the address and public settings from a deployment file.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireV4b } from './cage-build-check.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.preview-dist');
const CAGE = process.env.SEALED_CAGE_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-v4b-wire');
const PLAYER_CIRCUITS = ['deposit', 'sit', 'stand', 'withdraw', 'rescue']; // cage v4b: a revoke is a deposit, so it has no files of its own

const managedIndex = join(CAGE, 'contracts', 'managed', 'sealed-cage', 'contract', 'index.js');
if (!existsSync(managedIndex)) throw new Error(`STOP: no compiled contract at ${managedIndex}. Compile cage v4b there first.`);
const build = requireV4b(readFileSync(managedIndex, 'utf8'), managedIndex);
const generated = join(ROOT, 'wallet-app', 'src', 'generated', 'index.js');
if (existsSync(join(ROOT, 'wallet-app', 'dist', 'cage.js'))) {
  if (!existsSync(generated)) throw new Error('STOP: wallet-app/dist is built, but wallet-app/src/generated is gone, so nothing says which cage it was built from. Run cd wallet-app && npm run build again.');
  requireV4b(readFileSync(generated, 'utf8'), generated);
  if (readFileSync(generated, 'utf8') !== readFileSync(managedIndex, 'utf8')) throw new Error(`STOP: the wallet bundle was built from a different contract than ${managedIndex}. Run cd wallet-app && npm run build again.`);
}

const file = join(CAGE, process.env.CAGE_FILE ?? 'deployment.cage4.json');
if (!existsSync(file)) throw new Error(`STOP: no ${file}. This page speaks cage v4b and can't read an older cage. Deploy v4b, or set CAGE_FILE.`);
const d = JSON.parse(readFileSync(file, 'utf8'));
if (d.network !== 'preprod') throw new Error(`STOP: ${file} says network ${d.network}. Preprod only.`);
if (!/^[0-9a-f]{64}$/.test(d.address)) throw new Error(`STOP: ${file} has no contract address.`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
writeFileSync(join(OUT, 'cage-config.json'), `${JSON.stringify({
  name: 'cage v4b',
  writable: true,
  network: d.network,
  address: d.address,
  escapeSecs: d.escapeSecs,
  clockSlack: d.clockSlack,
  seats: d.seats,
}, null, 1)}\n`);

// The contract code and the player circuits' ZK files. Judge circuits aren't served: this page can't use them.
const bundle = join(ROOT, 'wallet-app', 'dist');
if (existsSync(join(bundle, 'cage.js'))) {
  cpSync(bundle, join(OUT, 'wallet-app'), { recursive: true });
  const managed = join(CAGE, 'contracts', 'managed', 'sealed-cage');
  for (const dir of ['keys', 'zkir']) mkdirSync(join(OUT, 'wallet-app', 'zk', dir), { recursive: true });
  for (const c of PLAYER_CIRCUITS) {
    for (const [dir, ext] of [['keys', 'prover'], ['keys', 'verifier'], ['zkir', 'bzkir']]) {
      cpSync(join(managed, dir, `${c}.${ext}`), join(OUT, 'wallet-app', 'zk', dir, `${c}.${ext}`));
    }
  }
  // Ledger 9 (11-09): Midnight.js 5 reads the build's runtime version from compiler/ to pick the contract's ledger. 0.31.1 writes
  // contract-info.json (runtime 0.16.0, so a ledger 8 contract) and no manifest.
  mkdirSync(join(OUT, 'wallet-app', 'zk', 'compiler'), { recursive: true });
  cpSync(join(managed, 'compiler', 'contract-info.json'), join(OUT, 'wallet-app', 'zk', 'compiler', 'contract-info.json'));
}

// dice-proof's player circuits, once its bundle is built. The bundle does nothing unless this Worker has DICE_PROOF = "on".
const DICE_DIR = process.env.DICE_PROOF_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-dice-proof');
if (existsSync(join(bundle, 'dice-proof.js'))) {
  const managed = join(DICE_DIR, 'contracts', 'managed', 'dice-proof');
  for (const dir of ['keys', 'zkir']) mkdirSync(join(OUT, 'wallet-app', 'zk-dice', dir), { recursive: true });
  for (const c of ['commitCup', 'proveCount', 'showCup']) {
    for (const [dir, ext] of [['keys', 'prover'], ['keys', 'verifier'], ['zkir', 'bzkir']]) cpSync(join(managed, dir, `${c}.${ext}`), join(OUT, 'wallet-app', 'zk-dice', dir, `${c}.${ext}`));
  }
  mkdirSync(join(OUT, 'wallet-app', 'zk-dice', 'compiler'), { recursive: true });
  cpSync(join(managed, 'compiler', 'contract-info.json'), join(OUT, 'wallet-app', 'zk-dice', 'compiler', 'contract-info.json'));
}
console.log(`.preview-dist ready: cage v4b (settleBatch of ${build.width}, L1) ${d.address.slice(0, 12)}…, contract code ${existsSync(join(bundle, 'cage.js')) ? 'included' : 'not built yet'}`);
