// What the doorman says. One source: the room's dialogue boxes and GET /hall both read this, so an agent
// hears the same welcome and the same rules a visitor does.

// Tally keeps the door (The owner, 11-06 12:24 PM): the dealer, doubling as the doorman, everywhere. Clockwork is retired, and the
// mock-ups and the ?doorman= switch are gone. `look` names a sprite in public/art/hall/manifest.json; the room draws it at the
// door and crops its face for the portrait.
export const DOORMAN_ID = 'tally';

// Names nobody new can take, however they're spaced: the doorman's, and the retired Clockwork's, which an old purse may
// still carry (it keeps it).
const DOOR_NAMES = new Set(['tally', 'clockwork']);

/** The shared lines: the menu, the rules, and whatever a doorman doesn't say in their own words. */
export const DOORMAN = {
  name: 'Tally',
  look: 'tally',
  role: 'host',
  greeting: [
    'Evening. Come in out of the dark.',
    "I'm Tally. I deal the cards, and tonight I keep the door as well. What'll it be?",
  ],
  menu: [
    { id: 'seat', label: 'Take a seat', available: true },
    { id: 'watch', label: 'Just watching', available: true },
    { id: 'rules', label: 'How do I play?', available: true },
    // With tNIGHT off (live, 2026-11-07): the choice is shown and says `tnightSoon`; it never starts a wallet flow. The room replaces it when tNIGHT is on.
    { id: 'tnight', label: 'Play with tNIGHT', available: false, note: 'coming soon' },
  ],
  askName: "Good. What name do I chalk on the slate?",
  // The first visit: the door asks a name and nothing else, and lets you into the Hall standing, with your purse as it is.
  doorAsk: 'What name do I chalk on the slate?',
  // {name} and {purse} are filled in by the room.
  welcomeIn: "In you come, {name}. You're standing in the Hall with {purse} in your purse. Pick a game in the room, or a table from the list, and I'll ask how much to bring.",
  whichGame: 'Cards or dice?',
  // With tNIGHT on, the first thing on arrival is the one choice. It's remembered; the greeting offers the other way from then on.
  chooseMode: "Two ways to play tonight. Free chips, chalked on the slate here. Or tNIGHT from your Midnight wallet, by way of the cage along the bar: test money too, on preprod. Which is it?",
  // tNIGHT with nothing in the cage yet; then, with {name} and {cage} filled in by the room, the way to a seat.
  tnightEmpty: "tNIGHT it is. The cage along the bar is the first stop: your wallet, how much to bring, one signature, and you're in.",
  tnightIn: 'Welcome back, {name}. The cage holds {cage} tNIGHT for you. Pick a game and the judge seats you, nothing to approve.',
  // Said once, before a player's first tNIGHT seat: why the tables wait, with the times measured on preprod (a block 30 s to a minute).
  tnightWait: "One thing before you sit. At the tNIGHT tables every seat, every stack and every payout is settled on Midnight, so each one waits for a block, usually half a minute to a minute. That's what makes the table cheat-proof: nobody, not even the house, can move your stake without it. I'll not say it twice.",
  whichWatch: 'Which game do you want to watch?',
  chooseLook: 'And how will they know you? Choose your look.',
  askBuyIn: 'Your whole purse comes to the table with you, unless you say otherwise. It all goes back in when you leave.',
  emptyPurse: "Your purse's empty, friend. You can't sit down with nothing.",
  // tNIGHT off (live): what the tNIGHT choice and the cage say instead of a wallet flow (The owner, 2026-11-07).
  tnightSoon: "Coming soon: tNIGHT tables are in testing. For now the chips are free, chalked on the slate here.",
  cageClosed: "Coming soon: tNIGHT tables are in testing. That's the cage, along the bar: when they open, that's where you'll bring tNIGHT from your Midnight wallet.",
  nobodyPlaying: "Nobody's at the cards yet. Have a look round, or sit down and they'll deal you in.",
  rules: [
    "Sealed Hand. Everyone puts 5 chips in the pot and gets five cards. Your cards are yours. Nobody at the table ever sees them.",
    "First we pass. Each round, everyone picks one card and slides it to the next seat, all at once. Two rounds at least, five at most. A raise goes with your pass: Pass, or Pass and raise, 1 to 25, once a round. Face a raise and it's Pass and pay to stay in, or fold. Pass before someone raises, and you get your turn to stay in or fold when the cards are in.",
    "Once two passes are done, anyone can stop the passing, unless a raise is out that round, and that's their claim: they name a poker hand as they stop, and can raise with it, up to 25. Nobody stops without one. Then we go round once, from the next seat. On your one turn: claim better than the best claim standing, call someone else's claim, or check. Any of those can carry a raise, above the highest so far. Five passes and nobody's stopped, whoever started the round opens.",
    "Here's the trick. Nobody checks your claim unless they call it. Call a bluff, and the bluffer pays you 5 and drops out of the pot. Call a true claim, and you pay 5, so you need 5 chips to call. Either way I only say true or false. The cards stay hidden.",
    "Face a raise you haven't met, and you stay in or fold along with your move. Staying in, you only ever pay the difference. Fold and your claim is gone, and it can't share the pot, but what you've paid stays in. When the lap's done, anyone still in who hasn't met the highest raise gets one turn: stay in or fold, and they can call a claim along with it, so the last raise of the lap can still be caught. Nothing new gets claimed or raised.",
    "The pot stops at 500 a round. Once it's there, no more raises, and staying in pays only what fits. Then the pot. Best standing claim takes two thirds, rounded up. Second best takes the rest. If only one stands, it takes the lot. A bluff nobody called still counts, and nobody at the table learns it was one until the round is over and the deck opens on the record. No claims, and the pot waits for the next round. Everyone else folds, and it's all yours, and your claim stands as you said it.",
    "And if dice are more your thing: up the stairs is Cup & Claim. Five dice under a cup, bids on the whole table, and when someone calls Liar you choose what to show: the dice, or just the count.",
  ],
  upstairs: "Up the stairs is Cup & Claim, the dice table. Five dice under a cup, bids on the whole table, and when someone calls Liar you choose what to show: the dice, or just the count.",
  agents: 'You can read this at GET /hall. GET /games lists the tables and GET /api lists the routes. Say kind "agent" when you join.',
};

/** The doorman's words, for GET /hall. Tally, whatever the settings say. */
export const doormanFor = () => ({ ...DOORMAN, doorman: DOORMAN_ID });

/** Nobody new goes by the doorman's name (or the retired Clockwork's), however it's spaced. */
export const isDoormanName = (name) => DOOR_NAMES.has(name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
