// Every game in the Hall. The room and GET /games both render from this list.
//
// To add a game: write its module under src/games/ and add it here. If it has live tables it also needs
// a Durable Object binding and a migration in wrangler.toml, and its class exported from src/index.js.
// A "soon" game is just an entry like the ones below.

import { sealedHand } from './games/sealed-hand/index.js';
import { cupAndClaim } from './games/cup-and-claim/index.js';

export const GAMES = [
  sealedHand,
  cupAndClaim,
  { id: 'axe-lane', name: 'Axe Lane', status: 'soon', art: 'axes', blurb: 'Throw for the board.' },
  { id: 'roulette', name: 'Roulette Wheel', status: 'soon', art: 'wheel', blurb: 'Round she goes.' },
  { id: 'second-card-table', name: 'Second Card Table', status: 'soon', art: 'cards', blurb: 'Another game, another night.' },
];

/** Public description of a game. Internal handlers stay out of it. */
export function describeGame(game, tables = []) {
  const { id, name, status, art, blurb, page, api, seats, plaque, sign, entry } = game;
  return {
    id, name, status, art, blurb,
    ...(plaque ? { plaque } : {}),
    ...(sign ? { sign } : {}), // what the sign in the room says, when it isn't the name
    ...(entry ? { entry } : {}), // a plain link that seats you, for a tap from a phone
    ...(status === 'live' ? { page, api, seats } : {}),
    openTables: tables.length,
    tables: tables.map(({ updatedAt, ...t }) => t),
  };
}
