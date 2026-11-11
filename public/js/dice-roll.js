// The dice arithmetic of a proof table, in the browser. The same as contracts/dice-proof.compact in sealed-cage, to the bit:
// test/dice-proof-fair.test.js holds it to vectors the compiled contract wrote. persistentHash is SHA-256 of the fields in order.

const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const tag = (name) => { const out = new Uint8Array(32); out.set(new TextEncoder().encode(`cup-and-claim:${name}:v2`)); return out; };
const le32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
async function sha(...parts) {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}
const LIMITS = [10923, 21846, 32768, 43691, 54614];

export const newSeed = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
export const keyIdOf = async (skHex) => toHex(await sha(tag('seat'), fromHex(skHex)));
export const commitOf = async (seedHex, table, round, seat, selfHex) => toHex(await sha(tag('commit'), fromHex(seedHex), le32(table), le32(round), new Uint8Array([seat]), fromHex(selfHex)));
export const preSealOf = async (commitHex, table, round, seat) => toHex(await sha(tag('preseal'), fromHex(commitHex), le32(table), le32(round), new Uint8Array([seat])));
export async function diceOf(saltHex, seedHex, seat) {
  const r = await sha(tag('roll'), fromHex(saltHex), fromHex(seedHex), new Uint8Array([seat]));
  return [0, 2, 4, 6, 8].map((i) => { const w = r[i] * 256 + r[i + 1]; return 1 + LIMITS.filter((t) => w >= t).length; });
}
export const countsOf = (dice) => Object.fromEntries([2, 3, 4, 5, 6].map((f) => [f, dice.filter((d) => d === f || d === 1).length]));
