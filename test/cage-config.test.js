// The cut-over guards: which cage a compiled contract is (copy-contract.mjs and preview-build.mjs stop on anything older than v4b),
// and the [build] check that stops a tNIGHT config deploying with the placeholder address, cage #3's, or a .preview-dist built for another cage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cageBuildOf, requireV4b } from '../scripts/cage-build-check.mjs';
import { CAGE3, PLACEHOLDER, cageConfigProblems, tomlVar } from '../scripts/check-cage-config.mjs';

const entries = (n) => `settleBatch(context, entries: Vector<${n}, struct Maybe<is_some: Boolean, value: struct Entry<table: Uint<32>>>>)`;
const L1 = "get maxGrant() { } 'a permit runs at most maxGrant'"; // the ledger field and deposit's check, as the compiler writes them
const V4B = `seatByJudge deposit stand ${entries(4)} ${L1}`;

test('a build is v4b only with seatByJudge, no moveByJudge, a settleBatch of 4, and L1 (maxGrant)', () => {
  assert.deepEqual(cageBuildOf(V4B), { seatByJudge: true, moveByJudge: false, width: 4, maxGrant: true });
  assert.equal(requireV4b(V4B, 'x').width, 4);
  assert.throws(() => requireV4b(`deposit sit ${entries(8)}`, 'x'), /isn't cage v4b .*cage #3 or older/);
  assert.throws(() => requireV4b(`seatByJudge moveByJudge revoke ${entries(8)}`, 'x'), /isn't cage v4b .*moveByJudge: that is v4/);
  assert.throws(() => requireV4b(`seatByJudge ${entries(8)}`, 'x'), /batches of 8 entries, and cage v4b takes 4/);
  assert.throws(() => requireV4b('seatByJudge', 'x'), /an unknown number of/, 'no entry vector: fails closed');
  assert.equal(cageBuildOf(`seatByJudge ${entries(4)}`).maxGrant, false);
  assert.throws(() => requireV4b(`seatByJudge deposit ${entries(4)}`, 'x'), /cage v4b from before L1: it has no maxGrant/, 'the 4-entry v4b build from before L1');
  assert.throws(() => requireV4b(`seatByJudge ${entries(4)} maxGrant`, 'x'), /before L1/, 'the word alone isn\'t L1');
  assert.throws(() => requireV4b(`seatByJudge ${entries(4)} get maxGrant() { }`, 'x'), /before L1/, 'the field without deposit\'s check isn\'t L1');
});

test('the real builds on this machine read as they should, where they exist', () => {
  const at = (dir) => join(process.env.WORKSPACE ?? '..', dir, 'contracts', 'managed', 'sealed-cage', 'contract', 'index.js');
  for (const dir of ['sealed-cage-v4b-wire', 'sealed-cage-v4b']) {
    const b = at(dir);
    if (existsSync(b)) assert.deepEqual(requireV4b(readFileSync(b, 'utf8'), b), { seatByJudge: true, moveByJudge: false, width: 4, maxGrant: true }, dir);
  }
  const v4 = at('sealed-cage-v4');
  if (existsSync(v4)) assert.throws(() => requireV4b(readFileSync(v4, 'utf8'), v4), /moveByJudge/);
});

function project({ address, previewDist = true, distFor = address, bundle = null }) {
  const root = mkdtempSync(join(tmpdir(), 'cage-config-'));
  writeFileSync(join(root, 'w.toml'), `name = "x"\n[build]\ncommand = "node scripts/check-cage-config.mjs w.toml"\n\n[vars]\nTNIGHT_TABLES = "on"\n${address === undefined ? '' : `CAGE_ADDRESS = "${address}"\n`}\n[assets]\n${previewDist ? 'directory = "./.preview-dist"' : 'directory = "./public"'}\n`);
  if (previewDist && distFor) {
    mkdirSync(join(root, '.preview-dist'), { recursive: true });
    writeFileSync(join(root, '.preview-dist', 'cage-config.json'), JSON.stringify({ address: distFor }));
  }
  if (bundle !== null) {
    mkdirSync(join(root, '.preview-dist', 'wallet-app'), { recursive: true });
    writeFileSync(join(root, '.preview-dist', 'wallet-app', 'cage.js'), '');
    if (bundle) {
      mkdirSync(join(root, 'wallet-app', 'src', 'generated'), { recursive: true });
      writeFileSync(join(root, 'wallet-app', 'src', 'generated', 'index.js'), bundle);
    }
  }
  return (file = 'w.toml') => cageConfigProblems(file, { root });
}

test('a tNIGHT config deploys only with a real v4b cage, and a .preview-dist built for it', () => {
  const NEW = 'a7'.repeat(32);
  assert.match(project({ address: PLACEHOLDER })().join(), /placeholder/);
  assert.match(project({ address: CAGE3 })().join(), /names cage #3/);
  assert.match(project({ address: 'abc' })().join(), /isn't 64 lowercase hex/);
  assert.match(project({ address: NEW.toUpperCase() })().join(), /isn't 64 lowercase hex/);
  assert.match(project({ address: undefined })().join(), /no CAGE_ADDRESS/);
  assert.deepEqual(project({ address: NEW })(), []);
  assert.deepEqual(project({ address: NEW, previewDist: false })(), [], 'the tNIGHT preview serves public/: the address is all');
  assert.match(project({ address: NEW, distFor: null })().join(), /no cage-config\.json/);
  assert.match(project({ address: NEW, distFor: '8'.repeat(64) })().join(), /built for another cage/);
  assert.deepEqual(project({ address: NEW, bundle: V4B })(), []);
  assert.match(project({ address: NEW, bundle: `seatByJudge ${entries(8)}` })().join(), /takes 4/);
  assert.match(project({ address: NEW, bundle: false })().join(), /generated is gone/);
});

test('tomlVar reads [vars] only', () => {
  const t = 'CAGE_ADDRESS = "top"\n[vars]\nCAGE_ADDRESS = "here" # note\n[other]\nCAGE_ADDRESS = "later"\n';
  assert.equal(tomlVar(t, 'CAGE_ADDRESS'), 'here');
  assert.equal(tomlVar(t, 'NOPE'), null);
});

test('live has tNIGHT on (L2) with its own config check', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  // Live, from L2 (11-10): tNIGHT on, on a real v4b cage, tables from 2000, its deploy checked like staging's, and no seal anchoring.
  const live = read('wrangler.toml');
  assert.equal(tomlVar(live, 'TNIGHT_TABLES'), 'on');
  assert.equal(tomlVar(live, 'WALLET_PAGE'), 'on');
  assert.equal(tomlVar(live, 'CAGE_TABLE_BASE'), '2000', 'chain tables 1001-1004 are taken; staging owns 101-1000');
  assert.match(tomlVar(live, 'CAGE_ADDRESS'), /^[0-9a-f]{64}$/);
  assert.notEqual(tomlVar(live, 'CAGE_ADDRESS'), CAGE3, 'live speaks cage v4b, not cage #3');
  assert.match(live, /\[build\]\ncommand = "node scripts\/check-cage-config\.mjs wrangler\.toml"/);
  assert.ok(!/ANCHOR_(MODE|SCOPE|PICKER|QUEUE)|AnchorQueue/.test(live), 'no seal anchoring on live');
});
