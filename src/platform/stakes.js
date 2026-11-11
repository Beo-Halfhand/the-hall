// Play-chip tables only: what a seat sits down with, what a fill-up brings it back to, and the stakes that let a bid or raise go up to a stack.
// Plain constants with no Workers imports, so the engines, the sims and the plain-Node tests can all read them. tNIGHT tables never use these:
// their stakes and the cage's roundCap stay as the engines' DEFAULTS and the table checks have them.

export const FILL_TO = 1000; // Fill up: a purse or a stack back to this much
export const SEAT_DEFAULT = 1000; // a person or an agent sits down with this unless they name a buy-in
export const BOT_STACK = 1000; // a house bot's stack at a play-chip table
export const CHIPS_RAISE_LIMIT = 1000; // one raise can go up to a whole stack

/**
 * The table settings a play-chip table starts from (the caller's own stakes win). The pot limit is every seat all in, so nobody is capped before
 * they are all in. House bots sit with BOT_STACK and are topped up between rounds whenever they are below botLow (a full stack: the biggest
 * raise a stack can make is a full stack, and a bot that can't match it would have to fold). botLogMin keeps the log from filling up with
 * small top-ups: the house's stake is always counted, but only a top-up of this many chips or more gets a line of its own.
 */
export function chipsStakes(seats) {
  return { startChips: BOT_STACK, raiseLimit: CHIPS_RAISE_LIMIT, potLimit: seats * BOT_STACK, botLow: BOT_STACK, botLogMin: 100 };
}
