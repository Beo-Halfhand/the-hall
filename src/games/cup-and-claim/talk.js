// AI table talk for Cup & Claim. Prompts are built only from the named public facts below: no dice, no count, no
// face, and no player text. The output filter here adds a dice-specific pass on top of the platform's.

import { HOUSE_NAME } from './engine.js';
import { AiBudget, askModel, cleanLine } from '../../platform/voice.js';

const STYLES = {
  [HOUSE_NAME]: {
    name: 'Tally',
    style: 'The house dealer: neat, unhurried, green visor and pocket watch. Keeps the count and misses nothing. Dry and exact.',
    examples: ['Every chip gets written down, friend.', 'The count never lies. People do.', 'A shut cup still has a number.', 'I have seen that look. It cost someone dearly.'],
  },
  Brannock: {
    name: 'Brannock',
    style: 'A brash, loud tavern regular. Playful trash talk, never cruel. Loves to slam the cup.',
    examples: ['Pour another, this pot is getting heavy!', 'My mule rattles a cup better than you!', 'Sing for your supper, friends, or pay up!', 'Ha! I can hear your knees knock!'],
  },
  'Old Wick': {
    name: 'Old Wick',
    style: 'A quiet old smith. Talks of forge and metal. Honest to a fault.',
    examples: ['Slow heat makes the strongest steel.', 'Hm. Even old iron remembers the hammer.', 'Soot on my hands, nothing up my sleeve.'],
  },
  'Red Mab': {
    name: 'Red Mab',
    style: 'A retired pirate captain. Salt, tides and treasure in every line. Bold and amused.',
    examples: ['The tide is in, lads. Pay up.', 'I have sailed through worse odds than this.', 'A pirate hides her gold, not her nerve.'],
  },
  'Sister Ivy': {
    name: 'Sister Ivy',
    style: 'A soft-spoken nun who loves arithmetic. Gentle, wry, a little too calm.',
    examples: ['Forgive me. I do not believe you.', 'Numbers are the one honest thing at this table.', 'A small offering, then.'],
  },
};

const MOVES = {
  bid: () => 'raise the bid on the table',
  raise: (amount) => `put ${amount} more chips behind your bid`,
  liar: () => 'call the last bidder a liar',
  show: () => 'lift your cup and show your dice',
  prove: () => 'keep your cup shut and give only your count',
};

const RULES = 'Say one short line of table talk, 12 words at most. Stay in character. You live in this inn and know nothing beyond its walls and the old roads. Never say a number, a count, or which face a die shows. No quotation marks.';

// A number word or a digit could read as a hint about the dice. Those lines fall back to the scripted ones.
const DICE_TALK = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|twos?|threes?|fours?|fives?|sixes|pips?|wild|aces?)\b/i;

export const cleanDiceLine = (raw) => {
  const line = cleanLine(raw);
  return line && !DICE_TALK.test(line) ? line : null;
};

export function botPrompt({ speaker, action, amount, pot, round }) {
  const who = STYLES[speaker];
  const examples = who ? ` Lines you might say:\n${who.examples.map((line) => `- ${line}`).join('\n')}` : '';
  return {
    system: `You are ${who?.name ?? 'a regular'}, at a dice table upstairs in a fantasy inn. ${who?.style ?? ''} ${RULES}${examples}`,
    user: `Round ${Number(round)}. The pot is ${Number(pot)} chips. You are about to ${(MOVES[action] ?? MOVES.bid)(Number(amount))}. Say your line.`,
  };
}

const PHASE_WORDS = {
  lobby: 'waiting for everyone to sit down',
  bid: 'bidding on how many dice show a number',
  duel: 'deciding whether to lift the cups after a Liar call',
  settled: 'between rounds',
  over: 'the table has closed',
};

export function quickPrompt({ phase, pot }) {
  return {
    system: 'You suggest short things a player could say at a dice table in a fantasy inn. Give exactly 4 lines, one per line, 8 words at most each. Friendly, a little playful. Never say a number or which face a die shows. No numbering or quotation marks.',
    user: `Right now the table is ${PHASE_WORDS[phase] ?? 'playing'}. The pot is ${Number(pot)} chips.`,
  };
}

export const QUICK_LINES = {
  lobby: ['Evening, all.', 'Room for one more?', 'Shake them up.', 'Good luck, all.'],
  bid: ["I don't believe you.", 'Bold words.', 'Higher, then.', 'Careful now.'],
  duel: ['Lift it or prove it.', 'The number will do.', 'Show us, then.', 'Moment of truth.'],
  settled: ['Well played.', 'Next round.', 'One more?', 'The cups are shaking.'],
  over: ['Good game.', 'Well played, all.', 'Until next time.', 'Mind the stairs.'],
};

/** Swaps queued scripted bot lines for AI ones, in place. On any failure the scripted line simply stays. */
export async function voiceBots(s, ai, budget, now, timeoutMs) {
  const queue = s.talkQueue.splice(0);
  if (!ai || queue.length === 0) return;
  await Promise.all(queue.map(async (t) => {
    if (!budget.take(now)) return;
    const raw = await askModel(ai, botPrompt({ speaker: s.seats[t.seat].name, action: t.action, amount: t.amount, pot: s.pot, round: s.round }), timeoutMs);
    const line = cleanDiceLine(raw);
    const entry = line && s.log.find((l) => l.n === t.n);
    if (entry) {
      entry.text = line;
      entry.ai = true;
    }
  }));
}

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
    const scripted = { lines: QUICK_LINES[s.phase] ?? QUICK_LINES.bid, source: 'scripted' };
    if (!ai || !budget.take(now)) return scripted;
    const raw = await askModel(ai, quickPrompt({ phase: s.phase, pot: s.pot }), timeoutMs);
    const lines = String(raw ?? '').split('\n').map(cleanDiceLine).filter(Boolean).slice(0, 4);
    return lines.length >= 2 ? { lines, source: 'ai' } : scripted;
  }
}

export { AiBudget };
