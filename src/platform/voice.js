// AI lines, for any game. Three promises live here: a slow or failed model never costs more than the
// timeout, nothing unusable reaches the table, and every caller keeps its own scripted fallback.

import { isProfane } from './filter.js';

// The next size up from the 1B: better at holding a voice, still quick, and about 1.7× the cost of the 1B per token.
export const VOICE_MODEL = '@cf/meta/llama-3.2-3b-instruct';
export const AI_TIMEOUT_MS = 1500;
export const AI_PER_MINUTE = 12;
const MAX_TOKENS = 40;
const LINE_MAX = 120;

// A line about cards, or any address, could mislead a player. Anything like this falls back to scripted.
const OFF_LIMITS = /\b(aces?|kings?|queens?|jacks?|deuces?|spades?|hearts?|diamonds?|clubs?|flush(es)?|straights?|pairs?|trips|full house|royal|two of|three of|four of)\b|\b\d+s\b|\b[2-9TJQKA][cdhs]\b|https?:|www\.|@/i;

// A line from outside the inn breaks the spell: anything about software, the model itself, or the modern world.
// A false alarm costs nothing, since the scripted line just stays.
const OUT_OF_WORLD = /\b(bugs?|buggy|debug\w*|glitch\w*|codes?|coded|coding|coders?|programs?|programm\w+|software|hardware|computers?|laptops?|servers?|databases?|data|scripts?|scripted|algorithms?|apps?|websites?|web|internet|online|offline|browsers?|emails?|phones?|smartphones?|screens?|pixels?|wi-?fi|crypto\w*|blockchain|bitcoin|ai|a\.i\.|artificial|machine learning|neural|llm|gpt|chatbots?|bots?|robots?|models?|prompts?|assistants?|tokens?|cloudflare|llama|openai|anthropic|claude|users?|developers?|devs?|updates?|updated|patch(es)?|versions?|errors?|crash(es|ed)?|systems?|simulation|npcs?|video games?|television|tv|movies?|cars?|fictional|role-?play\w*|in character)\b|\bI (cannot|can't|am unable to) (help|assist|comply|fulfil)|\bas an? \w*\s?(language|assistant)/i;

/** The first usable line of a model's answer, or null if there isn't one. */
export function cleanLine(raw) {
  if (typeof raw !== 'string') return null;
  const line = raw.split('\n').map((x) => x.trim()).find(Boolean)?.replace(/^[-*•\d.)\s]+/, '').replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!line || line.length > LINE_MAX || line.length < 2) return null;
  if (OFF_LIMITS.test(line) || OUT_OF_WORLD.test(line)) return null;
  if (line.split(/[^\p{L}\p{N}@$!]+/u).some(isProfane)) return null;
  return line;
}

/** Asks the model, and gives up at the timeout. Resolves to the answer's text, or null on any failure. */
export async function askModel(ai, { system, user }, timeoutMs = AI_TIMEOUT_MS) {
  if (!ai) return null;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    const answer = ai.run(VOICE_MODEL, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: MAX_TOKENS,
      temperature: 0.8,
    }).then((r) => r?.response ?? null).catch(() => null);
    return await Promise.race([answer, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Per-table budget of AI calls. Over it, callers use their scripted lines. */
export class AiBudget {
  constructor(perMinute = AI_PER_MINUTE) {
    this.perMinute = perMinute;
    this.times = [];
  }

  take(now) {
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length >= this.perMinute) return false;
    this.times.push(now);
    return true;
  }
}

/** A stand-in for Workers AI, for tests only. Records every prompt it's given. */
export function mockAi(mode, prompts) {
  return {
    async run(model, input) {
      prompts.push({ model, system: input.messages[0].content, user: input.messages[1].content });
      switch (mode) {
        case 'slow': return new Promise((resolve) => { setTimeout(() => resolve({ response: 'Too late to matter.' }), 5000); });
        case 'error': throw new Error('mock failure');
        case 'profane': return { response: 'Well fuck that then.' };
        case 'cards': return { response: 'I hold the ace of spades.' };
        case 'offworld': return { response: 'This table has a bug in its code.' };
        case 'long': return { response: 'x'.repeat(500) };
        case 'empty': return {};
        default: return { response: 'Mock line one.\nMock line two.\nMock line three.\nMock line four.' };
      }
    },
  };
}
