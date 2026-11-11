/** Small repeatable generator for tests. */
export function makeRng(start = 1) {
  let a = start | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stopping the passing is a claim: the best true one if the hand has one, or the lowest there is. */
export function stopping(me) {
  const stop = me.legal.find((l) => l.action === 'stop');
  return { action: 'stop', claim: (stop.truthful[0] ?? stop.options[0]).claim };
}

/** For a player that doesn't care about the raise: matches when a lap move has to meet one, or folds if it can't. */
export function answering(me, body) {
  if (!body || !me.facing || !['check', 'claim', 'call'].includes(body.action)) return body;
  return me.legal.find((l) => l.action === body.action)?.match ? { ...body, match: true } : { action: 'fold' };
}
