// How do the Cup & Claim bots play? Runs tables in memory, every seat driven by its persona (seat 0 is a stand-in
// human playing like the house), and prints rates: bluffs (bids the bidder's own dice make less than even odds),
// Liar calls, catches, raises, and how often each lifts the cup when called.
// node scripts/dice-sim.js [tables] [seats]

import { BOTS, HOUSE_NAME, act, createTable, join, publicView } from '../src/games/cup-and-claim/engine.js';
import { PERSONAS, atLeast, decide } from '../src/games/cup-and-claim/bots.js';
import { countFace } from '../src/games/cup-and-claim/fair.js';

const tables = Number(process.argv[2] ?? 200);
const seats = Number(process.argv[3] ?? 4);
const ROUNDS = 20;

function rngFrom(start) {
  let a = start | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stats = {};
const row = (name) => (stats[name] ??= { turns: 0, bids: 0, bluffs: 0, raises: 0, raised: 0, liars: 0, liarsWon: 0, folds: 0, called: 0, caught: 0, shows: 0, proves: 0, net: 0, lostMax: 0 });
const kinds = { duel: 0, uncontested: 0 };
let rounds = 0;
let bidsPerRound = 0;
let potSum = 0;
let potMax = 0;
let held = 0;

for (let t = 1; t <= tables; t++) {
  const ctx = { now: 1000, rng: rngFrom(t) };
  const s = createTable({ lobbyMs: 0, seats });
  join(s, 'Stand-in', ctx);
  const persona = (seat) => (seat === 0 ? PERSONAS[HOUSE_NAME] : PERSONAS[s.seats[seat].name]);

  for (let r = 0; r < ROUNDS && s.phase !== 'over'; r++) {
    const startChips = s.seats.map((x) => x.chips + s.cfg.ante);
    let bids = 0;
    for (let i = 0; i < 2000 && ['bid', 'duel'].includes(s.phase); i++) {
      const waiting = s.phase === 'bid' ? [s.turn] : [...s.duel.waiting];
      for (const seat of waiting) {
        if (!['bid', 'duel'].includes(s.phase)) break;
        const view = publicView(s);
        const move = decide(view, seat, s.dice[seat], ctx.rng, { persona: persona(seat) });
        const st = row(s.seats[seat].name);
        st.turns += 1;
        if (move.action === 'bid') {
          st.bids += 1;
          bids += 1;
          if (atLeast(move.count - countFace(s.dice[seat], move.face), view.totalDice - 5) < 0.5) st.bluffs += 1;
          if (move.raise) {
            st.raises += 1;
            st.raised += move.raise;
          }
        } else if (move.action === 'liar') st.liars += 1;
        else if (move.action === 'fold') st.folds += 1;
        else if (move.action === 'reveal') st[move.mode === 'show' ? 'shows' : 'proves'] += 1;
        act(s, seat, move, ctx);
      }
    }
    if (s.phase !== 'settled') break;
    rounds += 1;
    const result = s.lastResult;
    kinds[result.kind] += 1;
    potSum += result.pot;
    potMax = Math.max(potMax, result.pot);
    bidsPerRound += bids;
    if (result.kind === 'duel') {
      held += result.held ? 1 : 0;
      row(s.seats[result.bidder].name).called += 1;
      if (!result.held) {
        row(s.seats[result.bidder].name).caught += 1;
        row(s.seats[result.caller].name).liarsWon += 1;
      }
    }
    s.seats.forEach((x, i) => {
      const st = row(x.name);
      st.net += x.chips - startChips[i];
      st.lostMax = Math.max(st.lostMax, startChips[i] - x.chips);
    });
    ctx.now += 1000;
    for (const x of s.seats) if (x.chips < 30) x.chips = 100; // refill, so every table plays its rounds
    act(s, 0, { action: 'next' }, ctx);
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
console.log(`${tables} tables of ${seats} seats, ${rounds} rounds`);
console.log(`round ends: Liar call ${pct(kinds.duel, rounds)}, everyone folded ${pct(kinds.uncontested, rounds)}. bids per round ${(bidsPerRound / rounds).toFixed(1)}. called bids that held ${pct(held, kinds.duel)}. pot avg ${(potSum / rounds).toFixed(0)}, max ${potMax}`);
console.log('seat         turns  bids   bluff%  raise%  avg raise  liar%  liar wins  called  caught%  show%   max lost  net/round');
for (const [name, st] of Object.entries(stats)) {
  const label = name === 'Stand-in' ? 'Stand-in*' : name;
  console.log([
    label.padEnd(12), String(st.turns).padEnd(6), String(st.bids).padEnd(6), pct(st.bluffs, st.bids).padEnd(7), pct(st.raises, st.bids).padEnd(7),
    (st.raises ? (st.raised / st.raises).toFixed(1) : '0').padEnd(10), pct(st.liars, st.turns).padEnd(6), String(st.liarsWon).padEnd(10),
    String(st.called).padEnd(7), pct(st.caught, st.called).padEnd(8), pct(st.shows, st.shows + st.proves).padEnd(7), String(st.lostMax).padEnd(9), (st.net / rounds).toFixed(2),
  ].join(' '));
}
console.log(`* the stand-in human plays the house persona (${Object.entries(PERSONAS[HOUSE_NAME]).map(([k, v]) => `${k} ${v}`).join(', ')}). bots: ${BOTS.slice(1, seats).map((b) => b.name).join(', ')}`);
