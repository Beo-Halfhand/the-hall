// A player's avatar, checked before a seat is asked for (11-10, the owner's first tNIGHT run on live: "Sit me down at Sealed Hand" failed with
// bad_avatar because his saved look wasn't one the server accepts, and nothing on the page had looked at it first).
//
//   ensureLook(current)   a valid avatar id, or null if the player chose not to pick one. No seat request is sent without one.
//   pickLook({ why })     "Pick an avatar": the portraits as buttons; saves the choice on the player; resolves to the id, or null.
//                         With { title: 'Change look', current } it is the Change look window (the Hall's welcome card, Menu → Player):
//                         the same player, the same Player ID, a new face. A saved pick is announced as the window event 'hall:look'.
//   isLook(id, list)      pure: is `id` one of the ids the server accepts?
//
// The list is the Hall's own (GET /hall avatars: what POST /join and the door accept). A page that can't read it uses the built-in one.

import { PLAYER_KEY, api, faceEl, h, loadArt, looksAvailable, art, store } from './common.js';

export const BUILT_IN_LOOKS = ['dwarf', 'ranger', 'pirate', 'halfhand', 'mage', 'halfling', 'rogue', 'knight', 'adventurer'];
/** Looks no longer offered (house staff wear them). A player who has one keeps it at chips tables; a tNIGHT seat refuses it, and asks for another. */
export const RETIRED_LOOKS = ['clockwork'];
export const isLook = (id, list = BUILT_IN_LOOKS) => typeof id === 'string' && list.includes(id);

export const LOOK_LABELS = { halfhand: 'Hooded' }; // as the Hall's door calls it (the id stays halfhand)
export const lookLabel = (id) => LOOK_LABELS[id] ?? id[0].toUpperCase() + id.slice(1);
const labelOf = lookLabel;

let listPromise = null;
let pickedHere = null; // what they picked on this page: the door and then the seat both ask, and a visitor with no saved player is asked once
/** The ids the server accepts. Read once per page; the built-in list if the Hall can't be read. */
export function looksAccepted() {
  listPromise ??= api('GET', '/hall').then((hall) => (Array.isArray(hall?.avatars) && hall.avatars.length ? hall.avatars : BUILT_IN_LOOKS)).catch(() => BUILT_IN_LOOKS);
  return listPromise;
}

/** This player's saved look, read fresh (the page may not have it yet, or may hold an old one). Null with no player. */
async function savedLook() {
  const token = store.get(PLAYER_KEY);
  if (!token) return null;
  try { return (await api('GET', '/players/me', { token }))?.avatar ?? null; } catch { return null; }
}

/** "Pick an avatar" as a small window over the page. Saves the choice on the player. Resolves to the id, or null on "Not now". */
export async function pickLook({ why = 'You need an avatar to sit down. Pick one: it follows you to every table.', title = 'Pick an avatar', current = null, cancel = 'Not now' } = {}) {
  await loadArt().catch(() => {});
  const accepted = await looksAccepted();
  const shown = looksAvailable(accepted);
  const options = shown.length ? shown : accepted; // no art for any of them: still pickable, by name
  return new Promise((resolve) => {
    let picked = options.includes(current) ? current : null;
    const box = h('div', { class: 'look-ask', id: 'look-ask', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'look-ask-title' });
    const problem = h('p', { class: 'look-problem', id: 'look-ask-problem', role: 'alert', hidden: '' });
    const ok = h('button', { type: 'button', class: 'btn primary', id: 'look-ask-ok', disabled: picked ? null : '', text: 'This one' });
    const no = h('button', { type: 'button', class: 'btn', id: 'look-ask-cancel', text: cancel });
    const done = (value) => { box.remove(); resolve(value); };
    const buttons = options.map((id) => h('button', {
      type: 'button', class: 'look', dataset: { look: id }, 'aria-pressed': String(id === picked),
      onClick: () => {
        picked = id;
        for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.look === id));
        ok.removeAttribute('disabled');
      },
    }, art.sprites?.[id] ? faceEl({ kind: 'agent', avatar: id }, 64) : null, h('span', { text: labelOf(id) })));
    ok.addEventListener('click', async () => {
      if (!picked) return;
      ok.setAttribute('disabled', '');
      try {
        if (store.get(PLAYER_KEY)) await api('POST', '/players/me/avatar', { token: store.get(PLAYER_KEY), body: { avatar: picked } }); // no saved player: the door carries it
        pickedHere = picked;
        window.dispatchEvent(new CustomEvent('hall:look', { detail: picked })); // the Hall's card and face follow
        done(picked);
      } catch (err) {
        problem.textContent = err.message || 'That didn’t save. Try again.';
        problem.hidden = false;
        ok.removeAttribute('disabled');
      }
    });
    no.addEventListener('click', () => done(null));
    box.append(h('h2', { id: 'look-ask-title', text: title }), h('p', { class: 'look-why', text: why }), h('div', { class: 'looks look-ask-looks' }, ...buttons), problem, h('div', { class: 'look-ask-row' }, ok, no));
    document.body.append(box);
    (buttons.find((b) => b.dataset.look === picked) ?? buttons[0])?.focus({ preventScroll: true });
  });
}

/**
 * A valid avatar for a seat request, or null if the player won't pick one. The page's own value is used if the server accepts it; else
 * the player's saved one is read fresh (the page may have loaded before it was set); else the player is asked.
 */
export async function ensureLook(current) {
  const accepted = await looksAccepted();
  if (isLook(current, accepted)) return current;
  const saved = await savedLook();
  if (isLook(saved, accepted)) return saved;
  if (isLook(pickedHere, accepted)) return pickedHere;
  return pickLook();
}
