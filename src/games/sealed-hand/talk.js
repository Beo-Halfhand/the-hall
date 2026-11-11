// AI table talk for Sealed Hand. The prompts are built only from the named public facts below, so a card,
// a hand, a claim or whether anyone is bluffing has no way in. Player names and player talk stay out too,
// since both are text a stranger wrote.

import { HOUSE_NAME } from './engine.js';
import { AiBudget, askModel, cleanLine } from '../../platform/voice.js';

// Who each bot is, and how it sounds. The examples set the voice: they never name a card or a hand.
const STYLES = {
  [HOUSE_NAME]: {
    name: 'Tally',
    style: 'The house dealer: neat, unhurried, green visor and pocket watch. Keeps the count and misses nothing. Dry and exact.',
    examples: ['Every chip gets written down, friend.', 'My watch says you are thinking too long.', 'The count never lies. People do.', 'I have seen that look. It cost someone dearly.'],
  },
  Brannock: {
    name: 'Brannock',
    style: 'A brash, loud tavern regular. Playful trash talk, never cruel.',
    examples: ['Pour another, this pot is getting heavy!', 'My mule plays a tighter game than you lot!', 'Sing for your supper, friends, or pay up!', 'Ha! The whole inn can hear your knees knock!'],
  },
  'Old Wick': {
    name: 'Old Wick',
    style: 'A quiet old smith. Talks of forge and metal. Honest to a fault.',
    examples: ['Slow heat makes the strongest steel.', 'I have mended worse than this at my forge.', 'Hm. Even old iron remembers the hammer.', 'Soot on my hands, and nothing up my sleeve.'],
  },
};

const MOVES = {
  raise: (amount) => `raise the stakes to ${amount} chips`,
  claim: () => 'make your claim',
  call: () => "challenge another player's claim",
};

const RULES = 'Say one short line of table talk, 12 words at most. Stay in character. You live in this inn and know nothing beyond its walls and the old roads. Never name specific cards, ranks, suits or poker hands. No quotation marks.';

/** Takes only these public facts. Anything else passed in is ignored. */
export function botPrompt({ speaker, action, amount, pot, round }) {
  const who = STYLES[speaker];
  const examples = who ? ` Lines you might say:\n${who.examples.map((line) => `- ${line}`).join('\n')}` : '';
  return {
    system: `You are ${who?.name ?? 'a regular'}, at a card table in a fantasy inn. ${who?.style ?? ''} ${RULES}${examples}`,
    user: `Round ${Number(round)}. The pot is ${Number(pot)} chips. You are about to ${MOVES[action](Number(amount))}. Say your line.`,
  };
}

const PHASE_WORDS = {
  lobby: 'waiting for everyone to sit down',
  pass: 'passing cards around',
  claim: 'making and calling claims',
  answer: 'answering a raise: match it or fold',
  settled: 'between rounds',
  over: 'the table has closed',
};

/** Takes only the phase and the pot: no hand, not even the asker's own. */
export function quickPrompt({ phase, pot }) {
  return {
    system: 'You suggest short things a player could say at a card table in a fantasy inn. Give exactly 4 lines, one per line, 8 words at most each. Friendly, a little playful. Never name specific cards, ranks, suits or poker hands. No numbering or quotation marks.',
    user: `Right now the table is ${PHASE_WORDS[phase] ?? 'playing'}. The pot is ${Number(pot)} chips.`,
  };
}

// The scripted quick lines, and the fallback for the AI ones.
export const QUICK_LINES = {
  lobby: ['Evening, all.', 'Room for one more?', 'Deal me in.', 'Good luck, all.'],
  pass: ['Something for you.', 'Careful with that one.', 'Too rich for me?', "Let's see who blinks."],
  claim: ["I don't believe you.", 'Prove it.', 'Bold words.', 'Nice try.'],
  answer: ['Last chance, friends.', 'Back it or fold it.', 'Still with me?', 'Steady now.'],
  settled: ['Well played.', 'Nice hand.', 'Next round.', 'One more?'],
  over: ['Good game.', 'Well played, all.', 'Until next time.', 'Mind the door.'],
};

/** Swaps queued scripted bot lines for AI ones, in place. On any failure the scripted line simply stays. */
export async function voiceBots(s, ai, budget, now, timeoutMs) {
  const queue = s.talkQueue.splice(0);
  if (!ai || queue.length === 0) return;
  await Promise.all(queue.map(async (t) => {
    if (!budget.take(now)) return;
    const raw = await askModel(ai, botPrompt({ speaker: s.seats[t.seat].name, action: t.action, amount: t.amount, pot: s.pot, round: s.round }), timeoutMs);
    const line = cleanLine(raw);
    const entry = line && s.log.find((l) => l.n === t.n);
    if (entry) {
      entry.text = line;
      entry.ai = true;
    }
  }));
}

/** Suggested quick lines for this moment, cached by round and phase, so polling can't run up calls. */
export class QuickLines {
  constructor() {
    this.key = '';
    this.value = null;
    this.pending = null;
  }

  async get(s, ai, budget, now, timeoutMs) {
    const key = `${s.round}:${s.phase}`;
    if (key === this.key && this.value) return this.value;
    if (key === this.key && this.pending) return this.pending;
    this.key = key;
    this.value = null;
    this.pending = this.fetch(s, ai, budget, now, timeoutMs).then((value) => {
      if (this.key === key) this.value = value;
      return value;
    });
    return this.pending;
  }

  async fetch(s, ai, budget, now, timeoutMs) {
    const scripted = { lines: QUICK_LINES[s.phase] ?? QUICK_LINES.pass, source: 'scripted' };
    if (!ai || !budget.take(now)) return scripted;
    const raw = await askModel(ai, quickPrompt({ phase: s.phase, pot: s.pot }), timeoutMs);
    const lines = String(raw ?? '').split('\n').map(cleanLine).filter(Boolean).slice(0, 4);
    return lines.length >= 2 ? { lines, source: 'ai' } : scripted;
  }
}

export { AiBudget };
