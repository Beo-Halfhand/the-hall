// Sealed Hand's tNIGHT tables: the Hall's cage rules, bound to this game's engine. The rules are in platform/cage.js.

import { makeCage } from '../../platform/cage.js';
import { addLog, fillBots, inRound, join, returnPot, startRound, tick } from './engine.js';

export { CAGE_ROUND_CAP, CAGE_TURN_MS, FOLD_BEFORE_SECS, MAX_PENDING_CLAIMS, MIN_ROUND_SECS, STAR_PER_CHIP, isCageId, seatMessage } from '../../platform/cage.js';

export const {
  newCage, cageJoinable, claimRefusal, cageAfterChange, cageMaybeStart, cageSeatVerified, cageHouseSeated, cageDead, cageWork, cageSettled, cageAlert, cageReleased, cageView, cageStanding, cageClock, cageSeated, cageMoving, cageForceRoundEnd, cageDealBlocked,
} = makeCage({ addLog, fillBots, inRound, join, returnPot, startRound, tick });
