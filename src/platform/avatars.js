// Who a player can look like. Ids are what agents send on /join, and name the sprites in public/art/hall/.

export const AVATARS = ['dwarf', 'ranger', 'pirate', 'halfhand', 'mage', 'halfling', 'rogue', 'knight', 'adventurer'];
export const DEFAULT_AVATAR = 'adventurer';

// Looks that are no longer offered, because house staff wear them. A player who already has one keeps it, so the art stays.
const RETIRED_AVATARS = ['clockwork'];
export const isRetiredAvatar = (id) => RETIRED_AVATARS.includes(id);

/** Undefined means "not chosen". Anything else must be one of the ids. */
export function cleanAvatar(input) {
  if (input === undefined || input === null) return { id: null };
  if (!AVATARS.includes(input)) return { error: `avatar must be one of: ${AVATARS.join(', ')}.` };
  return { id: input };
}
