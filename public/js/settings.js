// The Player ID panel: copying your Player ID (the key to your purse), and restoring from one. The key goes only to the clipboard, or
// in an Authorization header to check it. It's never put on the page, in an address or in a log.

import { PLAYER_KEY, api, store } from './common.js';
import { maskText, REVEAL_MS } from './player-id.js';

const $ = (id) => document.getElementById(id);
const KEY_SHAPE = /^[0-9a-f]{64}\.[0-9a-f]+$/;
const say = (text) => { $('key-status').textContent = text; };

export function setupSettings({ current, changed, opening }) {
  const panel = $('settings');
  let pending = null; // a checked key, waiting for the player to say yes

  // Masked unless its owner taps Show; masked again after REVEAL_MS, on Hide, and whenever the panel closes or opens.
  let revealTimer = null;
  const mask = () => {
    clearTimeout(revealTimer);
    $('pid-value').textContent = maskText();
    $('pid-value').setAttribute('aria-label', 'Your Player ID, hidden');
    $('pid-value').classList.remove('shown');
    $('pid-reveal').textContent = 'Show';
    $('pid-reveal').setAttribute('aria-pressed', 'false');
  };
  $('pid-reveal').addEventListener('click', () => {
    const key = store.get(PLAYER_KEY);
    if (!key || $('pid-value').classList.contains('shown')) return mask();
    $('pid-value').textContent = key;
    $('pid-value').removeAttribute('aria-label');
    $('pid-value').classList.add('shown');
    $('pid-reveal').textContent = 'Hide';
    $('pid-reveal').setAttribute('aria-pressed', 'true');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(mask, REVEAL_MS);
  });

  const reset = () => {
    mask();
    pending = null;
    $('key-input').value = '';
    $('key-confirm').hidden = true;
    say('');
  };

  const open = () => {
    reset();
    opening?.();
    $('key-copy').disabled = !store.get(PLAYER_KEY);
    $('pid-reveal').disabled = !store.get(PLAYER_KEY);
    panel.hidden = false;
    $('settings-close').focus({ preventScroll: true });
  };

  $('settings-open').addEventListener('click', open);
  $('settings-close').addEventListener('click', () => {
    reset();
    panel.hidden = true;
  });

  $('key-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(store.get(PLAYER_KEY));
      say('Copied. Keep it somewhere private.');
    } catch {
      say('Your browser wouldn’t let me copy it.');
    }
  });

  $('key-restore').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('key-input').value.trim();
    $('key-input').value = '';
    $('key-confirm').hidden = true;
    pending = null;
    if (!KEY_SHAPE.test(key)) return say('That doesn’t look like a Player ID.');
    if (key === store.get(PLAYER_KEY)) return say('That’s the Player ID you’re using already.');
    try {
      const them = await api('GET', '/players/me', { token: key });
      const now = current();
      const warning = now ? ` You’re ${now.name} now, with ${now.purse.amount}. Copy that Player ID first if you might want it back.` : '';
      pending = key;
      say('');
      $('key-found').textContent = `This Player ID is ${them.name}, with ${them.purse.amount} in the purse.${warning}`;
      $('key-switch').textContent = `Switch to ${them.name}`;
      $('key-confirm').hidden = false;
    } catch (err) {
      say(err.status === 401 ? 'No purse matches that Player ID.' : 'I can’t check that just now. Try again in a moment.');
    }
  });

  $('key-switch').addEventListener('click', async () => {
    if (!pending) return;
    const previous = store.get(PLAYER_KEY);
    if (previous) store.set('hall.player.previous', previous); // never the only copy of a key
    store.set(PLAYER_KEY, pending);
    reset();
    panel.hidden = true;
    await changed();
  });

  $('key-cancel').addEventListener('click', reset);

  return { open };
}
