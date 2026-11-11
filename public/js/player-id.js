// Your Player ID: the key to your chips, kept in this browser. It works like a password, so it is never on a seat card or in the
// header (screenshots get posted). The only place it shows is the Hall's Player ID panel: masked, until its owner taps Show, and
// masked again on its own. Copy puts the whole key on the clipboard and nowhere else: not in an address, a log or a receipt.

import { PLAYER_KEY, h, store } from './common.js';

/** The masked Player ID says how long it is (it is much longer than any row of dots): "140-character ID, hidden" (11-10). Nothing of the ID itself. */
export const maskText = (key = store.get(PLAYER_KEY)) => (key ? `${String(key).length}-character ID, hidden` : 'No Player ID yet');
export const REVEAL_MS = 20_000;

export const FIRST_WIN_LINE = 'Your chips live in this browser. To keep them on another device, copy your Player ID from the Player ID button in the Hall.';
const FIRST_WIN_KEY = 'hall.firstWin';

/** The short form: the first 6 characters. Null with no key. */
export const shortId = (token = store.get(PLAYER_KEY)) => (token ? String(token).split('.')[0].slice(0, 6) : null);

/** Copies text. The clipboard API needs a secure page and a recent press; the old way covers the rest. Returns whether it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  const area = h('textarea', { 'aria-hidden': 'true' });
  area.value = text;
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch { /* not allowed */ }
  area.remove();
  return ok;
}

/**
 * Whether this round's card says FIRST_WIN_LINE: once per browser, on the first round won here with a Player ID. It keeps
 * saying it while that same card shows (the card is drawn on every poll), and never again after.
 */
export function firstWin({ where, round, net }) {
  if (!store.get(PLAYER_KEY) || round === undefined || round === null) return false;
  const told = store.get(FIRST_WIN_KEY);
  const here = `${where}#${round}`;
  if (told) return told === here;
  if (!(net > 0)) return false;
  store.set(FIRST_WIN_KEY, here);
  return true;
}
