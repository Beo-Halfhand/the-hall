// How long each tNIGHT action takes, for the line under "Confirmed in Xs": a running median over the last samples of each. Words only: nothing here touches money.

export const TIMED = new Set(['deposit', 'sit', 'stand', 'withdraw', 'revoke', 'rescue', 'seat', 'move', 'release']);
/** What a page can report for itself. A seat, a move or a release is the judge's, so only the judge reports those. */
export const PAGE_TIMED = new Set(['deposit', 'sit', 'stand', 'withdraw', 'revoke', 'rescue']);
export const MAX_SAMPLES = 51;
const MAX_MS = 30 * 60_000;

export const goodTiming = (action, ms) => TIMED.has(action) && Number.isFinite(ms) && ms > 0 && ms <= MAX_MS;

export function medianOf(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function addSample(samples, ms) {
  const next = [...samples, Math.round(ms)];
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
}
