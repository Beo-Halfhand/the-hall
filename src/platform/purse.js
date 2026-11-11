// The purse: what a player has to bring to a table. Pages and agents read it from purseView, and games change it only
// through chips.js, so there is one place to change when it stops being the house's own ledger.
//
// Today it's a number on the Player Durable Object, keyed by player id, which the house can write.
//
// Later, when a Lace wallet connects, the purse is the cage balance: keyed by wallet address and read-only from chain.
// Nothing here talks to a wallet or a chain yet. What that change needs:
//   1. Player record: remember the connected address, proven by the wallet, in place of relying on the player key.
//   2. purseView: for a connected player, return { amount: <cage balance>, source: 'cage', readOnly: true, owner: { kind: 'wallet', id: <address> } }.
//   3. chips.js: holdChips, cashOut and releaseChips become requests to the cage contract, since the house can't write the balance.
//   4. Top-ups stop for that player. The pages already hide them when readOnly is true.

export const PURSE_SOURCE = { HOUSE: 'house', CAGE: 'cage' };

/** What the player's purse is, wherever it lives. Pages show `amount`, and offer house-only things unless `readOnly`. */
export function purseView(player, playerId) {
  return { amount: player.chips, source: PURSE_SOURCE.HOUSE, readOnly: false, owner: { kind: 'player', id: playerId } };
}
