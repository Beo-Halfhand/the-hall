// Which cage a compiled contract is, read from its generated contract/index.js. The Hall speaks cage v4b with L1 only: permits,
// seatByJudge with a from-table (v4 had moveByJudge), a revoke as a deposit (v4 had revoke), a settleBatch of 4 entries
// (the first v4b build, and every older cage, took 8), and maxGrant (L1: a permit runs at most that long past the block's clock).
// copy-contract.mjs and preview-build.mjs both stop on anything else, so an older build stops on the owner's machine, not in a
// player's browser. The width pattern is the one the judge checks at start (checkBatchWidth in
// sealed-cage-v4b-wire/scripts/judge-cycle.mjs), so the Hall and the judge read a build the same way.

export const V4B_BATCH = 4;

export function cageBuildOf(source) {
  const width = /Vector<(\d+), struct Maybe<is_some: Boolean, value: struct Entry/.exec(source)?.[1];
  return {
    seatByJudge: source.includes('seatByJudge'),
    moveByJudge: source.includes('moveByJudge'),
    width: width ? Number(width) : null,
    // L1 is the ledger field and deposit's check of it, both: the word alone could be anything.
    maxGrant: /\bget maxGrant\(\)/.test(source) && source.includes('a permit runs at most maxGrant'),
  };
}

/** Throws a STOP line naming what's wrong, or returns what the build is. */
export function requireV4b(source, where) {
  const b = cageBuildOf(source);
  if (!b.seatByJudge || b.moveByJudge) throw new Error(`STOP: the contract at ${where} isn't cage v4b (it ${b.moveByJudge ? 'has moveByJudge: that is v4' : 'has no seatByJudge: that is cage #3 or older'}). Set SEALED_CAGE_DIR to a v4b checkout, such as ../sealed-cage-v4b-wire.`);
  if (b.width !== V4B_BATCH) throw new Error(`STOP: the contract at ${where} settles batches of ${b.width ?? 'an unknown number of'} entries, and cage v4b takes ${V4B_BATCH}. That is the first v4b build, which preprod refuses for small settles (error 168). Recompile from cage-v4b.`);
  if (!b.maxGrant) throw new Error(`STOP: the contract at ${where} is cage v4b from before L1: it has no maxGrant. The cage being deployed has it, and its deposit can't be proved with this build's keys. Recompile from cage-v4b (L1), or use ../sealed-cage-v4b-wire.`);
  return b;
}
