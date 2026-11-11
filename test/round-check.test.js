// The round page's own checks (public/js/round-check.js), run here in node with the same WebCrypto. A proof table's receipt: the house
// seal is dice-proof's hash (the vectors from sealed-cage), every chain-checked cup is said to be so, with or without a transaction hash
// (a player's own answer goes from the wallet, so the Worker has no hash for it), and nothing is called the house's word that the chain checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { proofHouseCommitOf, runChecks } from '../public/js/round-check.js';

const utf8 = (x) => new TextEncoder().encode(x);
const fromHex = (x) => Uint8Array.from(x.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const sha = async (...parts) => { const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', all)); };
/** The round's fingerprint as the Worker posts it (fair.js roundFingerprint): the page recomputes it from the parts. */
const fingerprintBytes = async ({ table, round, houseCommit, commits }) => toHex(await sha(utf8('cup-and-claim/fingerprint/v1'), u32(table), u32(0), u32(round), fromHex(houseCommit), ...commits.map((c) => (c ? fromHex(c) : new Uint8Array(32)))));

const vectors = JSON.parse(readFileSync(new URL('./dice-vectors.json', import.meta.url), 'utf8'));

test('a proof table seals the house secret with dice-proof\'s hash: the page recomputes every vector', async () => {
  for (const v of Object.values(vectors)) assert.equal(await proofHouseCommitOf(v.houseSeed, v.table, v.round), v.houseCommit);
});

test('a proof round\'s receipt: the seal passes, each cup is the chain\'s check (hash or not), a silent cup is said so, the house\'s word never', async () => {
  const v = vectors['0'];
  const commits = [v.commit, v.commit, null];
  const fingerprint = await fingerprintBytes({ table: v.table, round: v.round, houseCommit: v.houseCommit, commits });
  const r = {
    number: `${v.table}-${v.round}`, table: v.table, round: v.round, engineRound: v.round, status: 'settled',
    fingerprint: { hash: fingerprint, houseCommit: v.houseCommit, commits, domain: 'cup-and-claim/fingerprint/v1' },
    opened: { houseSeed: v.houseSeed },
    dice: { contract: 'c'.repeat(64), salt: 'a'.repeat(64), tx: { finish: 'f'.repeat(64) } },
    claim: { face: 4, count: 5 },
    reveals: [
      { seat: 0, name: 'agent-b', mode: 'prove', count: 5, attested: 'compact-proof' },
      { seat: 1, name: 'Tally · house', mode: 'prove', count: 1, attested: 'compact-proof', proofHash: '27ad1e0116be1aad'.padEnd(64, '0') },
      { seat: 2, name: 'Old Wick', mode: 'silent', count: null, attested: null },
    ],
    result: { kind: 'call', total: 6, held: true },
    chips: [{ delta: -5 }, { delta: 5 }],
  };
  const out = await runChecks(r);
  const by = (text) => out.find((c) => c.text.includes(text));
  assert.equal(by('opened house secret').kind, 'pass');
  assert.match(by('opened house secret').text, /the seal the chain holds/);
  assert.equal(by('agent-b').kind, 'word');
  assert.match(by('agent-b').text, /the chain checked this count of 5 against the seal, on its own record of the cup/);
  assert.match(by('Tally').text, /the chain checked this count of 1 against the seal, in transaction 27ad1e0116be…/);
  assert.match(by('Old Wick').text, /never answered/);
  assert.ok(!out.some((c) => /house.s word/.test(c.text)), 'nothing the chain checked is called the house\'s word');
  assert.equal(by('counts add up').kind, 'pass');
});

test('a plain tNIGHT round\'s receipt keeps the old seal and the house\'s word for a shut cup', async () => {
  const v = vectors['0'];
  const houseCommit = await (async () => { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...new TextEncoder().encode('cup-and-claim/house/v1'), ...Uint8Array.from(v.houseSeed.match(/../g), (x) => parseInt(x, 16))]))); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); })();
  const commits = [null, null];
  const fingerprint = await fingerprintBytes({ table: 3, round: 2, houseCommit, commits });
  const r = { table: 3, round: 2, engineRound: 2, fingerprint: { hash: fingerprint, houseCommit, commits, domain: 'cup-and-claim/fingerprint/v1' }, opened: { houseSeed: v.houseSeed }, claim: { face: 2, count: 1 }, reveals: [{ seat: 0, name: 'Shut', mode: 'prove', count: 1, attested: 'house' }], result: { kind: 'call', total: 1, held: true } };
  const out = await runChecks(r);
  assert.equal(out.find((c) => c.text.includes('opened house secret')).kind, 'pass');
  assert.match(out.find((c) => c.text.includes('Shut')).text, /house’s word/);
});
