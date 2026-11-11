// Copies the cage's generated contract into src/generated. Reads sealed-cage, never writes to it.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireV4b } from '../../scripts/cage-build-check.mjs';

const CAGE = process.env.SEALED_CAGE_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-v4b-wire');
const from = join(CAGE, 'contracts', 'managed', 'sealed-cage', 'contract');
const to = new URL('../src/generated', import.meta.url).pathname;
if (!existsSync(join(from, 'index.js'))) throw new Error(`No compiled contract at ${from}. Compile sealed-cage first.`);
// This page speaks v4b with L1: permits, atRisk in its own map, a move as seatByJudge with a from-table, a revoke as a deposit,
// a settleBatch of 4 entries, and maxGrant. It can't use an older cage, so an older build stops here, not in a player's browser.
const build = requireV4b(readFileSync(join(from, 'index.js'), 'utf8'), from);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (f) => !f.endsWith('.map') });
console.log(`contract copied to src/generated: cage v4b, settleBatch of ${build.width}, with L1 (maxGrant)`);

// dice-proof, only if its contract has been compiled: DICE_PROOF_DIR, by default the dice-proof worktree of sealed-cage.
const diceDir = process.env.DICE_PROOF_DIR ?? join(process.env.WORKSPACE ?? '..', 'sealed-cage-dice-proof');
const diceFrom = join(diceDir, 'contracts', 'managed', 'dice-proof', 'contract');
const diceTo = new URL('../src/generated-dice', import.meta.url).pathname;
rmSync(diceTo, { recursive: true, force: true });
if (existsSync(join(diceFrom, 'index.js'))) {
  cpSync(diceFrom, diceTo, { recursive: true, filter: (f) => !f.endsWith('.map') });
  console.log('dice-proof contract copied to src/generated-dice');
}
