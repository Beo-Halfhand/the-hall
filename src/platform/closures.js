// The Hall's record of closed tables. Every table that closes (whatever the reason) leaves one entry, so a player who says "the table just shut"
// can be answered from this list: which table, which round, why in a code and in words, and who was left with what. Names and chips only, never a
// player id or a token, so GET /closures can show it to anyone. Kept in the Directory's storage; plain functions of a storage, so plain Node can test them.
//
// closed:<time, zero-padded>:<table id>  ->  { at, game, n, id, round, code, text, humans, stacks }   (the last CLOSED_KEEP are kept)
// closedid:<game>:<table id>             ->  the key above, so a table that reports its close twice is logged once

export const CLOSED_KEEP = 200;

/** `t` is the table's last report to the Directory (phase 'over' with overCode/overReason/overRound/humans/stacks); `n` its number, if it had one. */
export async function logClosure(storage, t, n, now = Date.now()) {
  const mark = `closedid:${t.game}:${t.id}`;
  if (await storage.get(mark)) return null;
  const entry = {
    at: now, game: t.game, n: n ?? null, id: t.id, round: t.overRound ?? t.round ?? null, code: t.overCode ?? 'unknown', text: t.overReason ?? '',
    humans: Array.isArray(t.humans) ? t.humans.map(String) : [],
    stacks: Array.isArray(t.stacks) ? t.stacks.map((x) => ({ name: String(x.name), chips: Number(x.chips) || 0, ...(x.left ? { left: true } : {}) })) : [],
  };
  const key = `closed:${String(now).padStart(15, '0')}:${t.id}`;
  await storage.put({ [key]: entry, [mark]: key });
  const all = [...(await storage.list({ prefix: 'closed:' })).keys()];
  for (const old of all.slice(0, Math.max(0, all.length - CLOSED_KEEP))) {
    const gone = await storage.get(old);
    await storage.delete(old);
    if (gone) await storage.delete(`closedid:${gone.game}:${gone.id}`);
  }
  return entry;
}

/** Newest first. `game` narrows it; `limit` is 1 to CLOSED_KEEP (default 50). */
export async function listClosures(storage, { game = null, limit = 50 } = {}) {
  const n = Math.min(CLOSED_KEEP, Math.max(1, Number.isInteger(limit) ? limit : 50));
  const rows = [...(await storage.list({ prefix: 'closed:', reverse: true })).values()].filter((e) => !game || e.game === game);
  return rows.slice(0, n);
}

/** What a table adds to its last report when it has closed: why, in a code and in words, and who was left with what (names and chips only). */
export const closureFields = (s) => {
  const people = s.seats.filter((x) => !x.bot);
  return {
    overCode: s.overCode ?? null, overReason: s.overReason ?? null, overRound: s.overRound ?? s.round,
    humans: people.map((x) => x.name),
    stacks: people.map((x) => ({ name: x.name, chips: x.left ? x.leftWith ?? 0 : x.chips, ...(x.left ? { left: true } : {}) })),
  };
};
