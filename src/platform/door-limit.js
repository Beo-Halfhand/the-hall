// How far ahead a door session may end. The page grants each deposit's permit until the door's end (permitUntil in
// public/js/wallet-core.js), and cage v4b refuses a permit that runs more than maxGrant, 30 days, past the block's clock (L1).
// So this stays at or under 2,592,000 seconds: test/wallet.test.js pins it. Its own module so that test can import it.
export const MAX_DOOR_SECS = 24 * 60 * 60;
