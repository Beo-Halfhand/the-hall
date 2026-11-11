// Table talk and names. Starter word list: whole words only, so "Scunthorpe" and "cocky" are safe.
// It doesn't catch spaced-out evasions like "f u c k".

const STEMS = ['fuck', 'shit', 'piss', 'bitch', 'wank', 'cunt', 'twat', 'bastard', 'whore', 'slut', 'nigger', 'faggot', 'retard'];
const EXACT = ['shitty', 'bitchy', 'asshole', 'assholes', 'arsehole', 'dick', 'dicks', 'dickhead', 'cock', 'cocks', 'motherfucker', 'bullshit', 'fag', 'fags', 'kike', 'kikes', 'spic', 'spics', 'chink', 'chinks'];
const SUFFIXES = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'in'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const squash = (word) => word.toLowerCase().replace(/[013457@$!]/g, (c) => LEET[c]).replace(/(.)\1+/g, '$1');

const BLOCKED = new Set([
  ...STEMS.flatMap((stem) => SUFFIXES.map((suffix) => squash(stem + suffix))),
  ...EXACT.map(squash),
]);

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

export const isProfane = (word) => BLOCKED.has(squash(word));

export const SAY_MAX = 120;
export const NAME_MAX = 24;

/** Returns the cleaned text with bad words masked, or { error } when it can't be posted. */
export function cleanSay(input) {
  if (typeof input !== 'string') return { error: 'text must be a string.' };
  const text = input.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'text is empty.' };
  if (text.length > SAY_MAX) return { error: `text is ${text.length} characters; the limit is ${SAY_MAX}.` };
  return { text: text.replace(/[\p{L}\p{N}@$!]+/gu, (word) => (isProfane(word) ? '*'.repeat(word.length) : word)) };
}

export function cleanName(input) {
  if (typeof input !== 'string') return { error: 'name must be a string.' };
  const name = input.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'name is empty.' };
  if (name.length > NAME_MAX) return { error: `name is ${name.length} characters; the limit is ${NAME_MAX}.` };
  if (!/^[\p{L}\p{N} '’_.-]+$/u.test(name)) return { error: 'name may use letters, numbers, spaces and \' _ . - only.' };
  if (name.split(/[^\p{L}\p{N}]+/u).some(isProfane)) return { error: 'name is not allowed.' };
  return { name };
}
