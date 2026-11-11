// The seal-anchor gate (src/platform/anchor.js) and the receipt's anchor checks (public/js/round-check.js), pure: no server, no chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LOCK_MAX_MS, anchorAfterSeal, anchorApplyResult, anchorBeginRound, anchorExpire, anchorFail, anchorHolding, anchorQueuedLine, anchorRecord, anchorView, tableAnchorMode } from '../src/platform/anchor.js';
import { anchorChecks, anchorMetaOf } from '../public/js/round-check.js';

const SEAL = 'ab'.repeat(32);
const table = (mode, extra = {}) => ({ anchorMode: mode, round: 1, phase: 'pass', deadline: 1_000 + 25_000, botDue: { 2: { at: 5 } }, ...extra });
const said = () => { const lines = []; const say = (t, x) => lines.push({ t, x }); return { lines, say }; };
const seal = (s, now = 1_000) => anchorAfterSeal(s, { game: 'sealed-hand', tableId: 'f'.repeat(64), recordId: '7-1', seal: SEAL, now });

test('mode: off unless the queue is bound and a mode is set; scope tnight leaves chips tables alone; the picker chooses', () => {
  assert.equal(tableAnchorMode({}, 'lock'), null);
  assert.equal(tableAnchorMode({ ANCHOR_MODE: 'lock' }, 'lock'), null, 'no queue bound');
  const env = { ANCHOR_QUEUE: {}, ANCHOR_MODE: 'lock' };
  assert.equal(tableAnchorMode(env, undefined), null, 'staging shape: chips tables unchanged');
  assert.equal(tableAnchorMode(env, undefined, { cage: true }), 'lock');
  assert.equal(tableAnchorMode(env, 'background', { cage: true }), 'lock', 'no picker: the Worker decides');
  const preview = { ...env, ANCHOR_SCOPE: 'all', ANCHOR_PICKER: 'on' };
  assert.equal(tableAnchorMode(preview, 'background'), 'background');
  assert.equal(tableAnchorMode(preview, 'off'), null);
  assert.equal(tableAnchorMode(preview, 'nonsense'), 'lock');
});

test('lock: the round holds from the deal (clock and bots stopped) until the block, then plays with its time intact', () => {
  const s = table('lock');
  assert.equal(anchorBeginRound(s, 1_000), true);
  assert.equal(anchorHolding(s), true);
  assert.equal(s.deadline, null, 'no clock while locking');
  assert.deepEqual(s.botDue, {}, 'no bot moves while locking');
  assert.equal(anchorBeginRound(s, 1_100), false, 'once per round');
  const item = seal(s);
  assert.equal(item.seal, SEAL);
  assert.equal(item.recordId, '7-1');
  assert.equal(seal(s), null, 'queued once');
  const { lines, say } = said();
  anchorApplyResult(s, { round: 1, seal: SEAL, outcome: 'started', step: 'taken' }, 2_000, say);
  assert.equal(anchorView(s).state, 'started');
  anchorApplyResult(s, { round: 1, seal: SEAL, outcome: 'progress', step: 'sent' }, 9_000, say);
  assert.equal(anchorView(s).step, 'sent');
  assert.equal(anchorHolding(s), true);
  const { patch } = anchorApplyResult(s, { round: 1, seal: SEAL, ok: true, outcome: 'anchored', block: 4242, txHash: 'cd'.repeat(32), blockAt: 20_000 }, 21_000, say);
  assert.equal(anchorHolding(s), false);
  assert.equal(s.deadline, 21_000 + 25_000, 'the turn clock gets back the time it had');
  assert.equal(patch.anchor.block, 4242);
  assert.equal(patch.anchor.payload, SEAL);
  assert.match(lines.at(-1).t, /Locked on Midnight ✓ block 4242/);
  assert.equal(lines.at(-1).x.act.tx, 'cd'.repeat(32), 'the line carries the transaction for the explorer link');
});

test('lock: no block in time lets the round play, says so, and a late landing still counts for the record', () => {
  const s = table('lock');
  anchorBeginRound(s, 1_000);
  seal(s);
  const { lines, say } = said();
  assert.equal(anchorExpire(s, 1_000 + LOCK_MAX_MS - 1, say), false);
  assert.equal(anchorExpire(s, 1_000 + LOCK_MAX_MS, say), true);
  assert.equal(anchorHolding(s), false);
  assert.equal(anchorView(s).state, 'timeout');
  assert.match(lines.at(-1).t, /Couldn't lock this hand on Midnight in time.*Playing on/);
  const late = anchorApplyResult(s, { round: 1, seal: SEAL, ok: true, outcome: 'anchored', block: 7, txHash: 'ee'.repeat(32) }, 200_000, say);
  assert.equal(late.patch.anchor.block, 7);
  assert.equal(anchorView(s).late, true);
  assert.match(lines.at(-1).t, /landed late/);
});

test('a refused or failed lock fails plainly and the round plays; a failure result goes on the record', () => {
  const s = table('lock');
  anchorBeginRound(s, 1_000);
  seal(s);
  const { lines, say } = said();
  assert.equal(anchorFail(s, 'the anchor service is offline', 1_500, say), true);
  assert.equal(anchorHolding(s), false);
  assert.match(lines.at(-1).t, /Couldn't lock this hand on Midnight: the anchor service is offline\. Playing on/);
  const s2 = table('lock');
  anchorBeginRound(s2, 1_000);
  seal(s2);
  const r = anchorApplyResult(s2, { round: 1, seal: SEAL, ok: false, outcome: 'refused', error: 'refused before the mempool' }, 3_000, say);
  assert.equal(r.patch.anchor.ok, false);
  assert.equal(anchorView(s2).state, 'failed');
});

test('background: nothing holds; table talk says anchoring, then anchored with the block', () => {
  const s = table('background');
  anchorBeginRound(s, 1_000);
  assert.equal(anchorHolding(s), false);
  assert.equal(s.deadline, 26_000, 'the clock runs');
  seal(s);
  const { lines, say } = said();
  anchorQueuedLine(s, say);
  anchorQueuedLine(s, say);
  assert.equal(lines.length, 1, 'said once');
  assert.match(lines[0].t, /^Locking this hand on Midnight \(30–60 s\)\. Enjoy your game\.$/);
  anchorApplyResult(s, { round: 1, seal: SEAL, ok: true, outcome: 'anchored', block: 9, txHash: 'aa'.repeat(32) }, 20_000, say);
  assert.match(lines.at(-1).t, /^Locked ✓ block 9 · tx /);
});

test('a result for another round or another seal patches only that record, never the live round', () => {
  const s = table('lock');
  anchorBeginRound(s, 1_000);
  seal(s);
  const other = anchorApplyResult(s, { round: 0, seal: 'cd'.repeat(32), ok: true, outcome: 'anchored', block: 1 }, 2_000);
  assert.equal(other.changed, false);
  assert.ok(other.patch, 'the earlier round still gets its record part');
  assert.equal(anchorHolding(s), true);
});

test('a round dealt by a path that never called anchorBeginRound is still caught at the seal', () => {
  const s = table('lock');
  const item = seal(s);
  assert.ok(item);
  assert.equal(anchorHolding(s), true);
});

// ---------- the receipt's checks ----------

const recordOf = (anchor, extra = {}) => ({ game: 'sealed-hand', number: '7-1', seal: { hash: SEAL }, opened: { at: 50_000 }, anchor, ...extra });
const goodAnchor = async (extra = {}) => ({ ...anchorRecord({ seal: SEAL, ok: true, outcome: 'anchored', txHash: 'cd'.repeat(32), block: 4242, blockAt: 20_000, vault: 'f'.repeat(64), attesterId: 'e'.repeat(64), recordKey: 'd'.repeat(64), metadataHash: await anchorMetaOf('7-1') }, 21_000), ...extra });
const chainSays = (raw, block = 4242, at = 20_000) => async () => ({ hash: 'cd'.repeat(32), raw, block, at });

test('receipt: a good anchor passes every check (the hash, the round, the chain, before the reveal)', async () => {
  const out = await anchorChecks(recordOf(await goodAnchor()), { indexer: '/x', fetchTx: chainSays(`00${SEAL}ff`) });
  assert.deepEqual(out.map((c) => c.kind), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(out));
  assert.match(out[0].text, /is this round's deck seal/);
  assert.match(out[3].text, /Locked before the reveal/);
});

test('receipt tamper: an anchored hash that is not the record\'s seal fails', async () => {
  const out = await anchorChecks(recordOf(await goodAnchor({ payload: 'cd'.repeat(32) })), { indexer: '/x', fetchTx: chainSays(`00${SEAL}ff`) });
  assert.equal(out[0].kind, 'fail');
  assert.match(out[0].text, /is not this round's deck seal/);
});

test('receipt tamper: the transaction on chain not carrying the seal fails; another block fails; a missing tx fails', async () => {
  const notCarried = await anchorChecks(recordOf(await goodAnchor()), { indexer: '/x', fetchTx: chainSays('00'.repeat(40)) });
  assert.ok(notCarried.some((c) => c.kind === 'fail' && /does not carry/.test(c.text)), JSON.stringify(notCarried));
  const otherBlock = await anchorChecks(recordOf(await goodAnchor()), { indexer: '/x', fetchTx: chainSays(SEAL, 9999) });
  assert.ok(otherBlock.some((c) => c.kind === 'fail' && /the chain says 9999/.test(c.text)));
  const missing = await anchorChecks(recordOf(await goodAnchor()), { indexer: '/x', fetchTx: async () => ({ missing: true }) });
  assert.ok(missing.some((c) => c.kind === 'fail' && /no transaction/.test(c.text)));
});

test('receipt: a lock that landed after the reveal fails the order check; another round\'s metadata fails', async () => {
  const after = await anchorChecks(recordOf(await goodAnchor()), { indexer: '/x', fetchTx: chainSays(SEAL, 4242, 60_000) });
  assert.ok(after.some((c) => c.kind === 'fail' && /Locked after the reveal/.test(c.text)), JSON.stringify(after));
  const wrongRound = await anchorChecks(recordOf(await goodAnchor({ metadataHash: await anchorMetaOf('7-2') })), { indexer: '/x', fetchTx: chainSays(SEAL) });
  assert.ok(wrongRound.some((c) => c.kind === 'fail' && /names another round/.test(c.text)));
});

test('receipt: no chain to read, a failed lock, or no lock: notes, never a pass', async () => {
  const blind = await anchorChecks(recordOf(await goodAnchor()), { indexer: null, fetchTx: async () => null });
  assert.ok(blind.some((c) => c.kind === 'word' && /couldn't read the chain/.test(c.text)));
  const failed = await anchorChecks(recordOf({ ok: false, outcome: 'unknown', error: 'not on the indexer' }));
  assert.deepEqual(failed.map((c) => c.kind), ['word']);
  const noted = await anchorChecks(recordOf(undefined, { anchorNote: { why: 'the anchor service is offline' } }));
  assert.match(noted[0].text, /Not locked on Midnight: the anchor service is offline/);
  assert.deepEqual(await anchorChecks(recordOf(undefined)), []);
});

test('receipt: the metadata rule is the anchor service\'s (sha256 over the tag and the round number)', async () => {
  assert.equal(await anchorMetaOf('t165-11'), createHash('sha256').update('sealed-hand/anchor/v1|t165-11').digest('hex'));
});

test('receipt: Cup & Claim checks its dice fingerprint', async () => {
  const r = { game: 'cup-and-claim', number: '3-4', fingerprint: { hash: SEAL }, opened: { at: 50_000 }, anchor: await goodAnchor({ metadataHash: await anchorMetaOf('3-4') }) };
  const out = await anchorChecks(r, { indexer: '/x', fetchTx: chainSays(SEAL) });
  assert.match(out[0].text, /dice fingerprint/);
  assert.ok(out.every((c) => c.kind === 'pass'), JSON.stringify(out));
});

test('tNIGHT: a hold never runs into the on-chain fold time (2 min margin), and with no room the round does not hold', async () => {
  const { CHAIN_CLOCK_MARGIN_MS } = await import('../src/platform/anchor.js');
  const s = table('lock', { cage: { foldAt: 1_000 + 200_000 } });
  anchorBeginRound(s, 1_000);
  assert.equal(anchorHolding(s), true);
  assert.equal(s.anchor.lockUntil, 1_000 + 200_000 - CHAIN_CLOCK_MARGIN_MS, 'capped below the 120 s lock limit');
  seal(s);
  const { lines, say } = said();
  assert.equal(anchorExpire(s, 1_000 + 200_000 - CHAIN_CLOCK_MARGIN_MS - 1, say), false);
  s.cage.foldAt = 1_000 + 150_000; // a stand brought the fold time closer during the hold
  assert.equal(anchorExpire(s, 1_000 + 150_000 - CHAIN_CLOCK_MARGIN_MS, say), true);
  assert.equal(anchorHolding(s), false);
  assert.match(lines.at(-1).t, /the table's on-chain clock comes first/);
  const tight = table('lock', { cage: { foldAt: 1_000 + CHAIN_CLOCK_MARGIN_MS + 10_000 } });
  anchorBeginRound(tight, 1_000);
  assert.equal(anchorHolding(tight), false, 'under 20 s of room: no hold at all, the round plays and the lock goes on in the background');
  assert.equal(tight.deadline, 26_000, 'its clock runs');
  const chips = table('lock');
  anchorBeginRound(chips, 1_000);
  assert.equal(chips.anchor.lockUntil, 1_000 + LOCK_MAX_MS, 'chips tables: no chain clock, the usual limit');
});

test('a table from before anchoring adopts the default: the round in play is skipped, the next one locks', async () => {
  const { anchorAdopt } = await import('../src/platform/anchor.js');
  const mid = table(undefined); delete mid.anchorMode;
  anchorAdopt(mid, 'lock');
  assert.equal(mid.anchorMode, 'lock');
  assert.equal(anchorBeginRound(mid, 1_000), false, 'never held halfway through a round');
  assert.equal(anchorHolding(mid), false);
  assert.equal(seal(mid), null, 'nor queued');
  mid.round = 2;
  assert.equal(anchorBeginRound(mid, 2_000), true, 'the next round locks');
  const between = table(undefined, { phase: 'settled' }); delete between.anchorMode;
  anchorAdopt(between, 'background');
  assert.equal(between.anchor, undefined, 'between rounds: nothing to skip');
  const off = table(undefined); anchorAdopt(off, null);
  assert.equal(off.anchorMode, null);
});

test('receipt: a background round that ended before its lock says so plainly (a note); a lock-first one late is ✗', async () => {
  const late = chainSays(SEAL, 4242, 60_000); // block time after the reveal at 50 000
  const bg = await anchorChecks(recordOf(await goodAnchor({ mode: 'background' })), { indexer: '/x', fetchTx: late });
  const order = bg.at(-1);
  assert.equal(order.kind, 'word');
  assert.match(order.text, /background mode, which doesn't wait for the lock/);
  assert.ok(!bg.some((c) => c.kind === 'fail'), JSON.stringify(bg));
  const lock = await anchorChecks(recordOf(await goodAnchor({ mode: 'lock' })), { indexer: '/x', fetchTx: late });
  assert.equal(lock.at(-1).kind, 'fail');
  const bgEarly = await anchorChecks(recordOf(await goodAnchor({ mode: 'background' })), { indexer: '/x', fetchTx: chainSays(SEAL) });
  assert.equal(bgEarly.at(-1).kind, 'pass', 'a background round whose lock came first still passes');
  const { anchorRecord } = await import('../src/platform/anchor.js');
  assert.equal(anchorRecord({ seal: SEAL, ok: true, outcome: 'anchored' }, 1, 'background').mode, 'background', 'the record says which mode');
});
