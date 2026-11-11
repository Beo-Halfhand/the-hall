// Play-chip tables with big stakes: does a table survive a heavy bettor? One chips table per game, four seats, the engine driven directly with
// a fake clock (no waiting). Seat 0 is a human-like aggressive bettor: it bids or raises as high as it can every turn, up to its whole
// stack, calls when it can, and fills up when it is out. The other three are the house bots, sitting with 1,000 and topped up between rounds.
//
//   node scripts/chips-sim.js [rounds=30] [seed=7]
//
// Checks, for both games, and exits non-zero on any violation:
//   - the table never reaches phase 'over'
//   - no house bot ever has left/standing set, and none sits a round out for lack of chips
//   - the round plays to a result every time (no stuck table)
// Prints a compact table: rounds, min stack each bot reached, bot refills, the human's fill-ups, the biggest bid/raise and the biggest pot.

import { fileURLToPath } from 'node:url';
import * as dice from '../src/games/cup-and-claim/engine.js';
import * as diceBots from '../src/games/cup-and-claim/bots.js';
import * as hand from '../src/games/sealed-hand/engine.js';
import * as handBots from '../src/games/sealed-hand/bots.js';
import { chipsStakes } from '../src/platform/stakes.js';

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

const GAMES = {
  'cup-and-claim': {
    engine: dice,
    bots: diceBots,
    /** The aggressive bettor's next move, built from what is legal: the highest bid it can, a Liar call half the time when there is a bid. */
    move(s, ctx, note) {
      const legal = dice.legalActions(s, 0);
      const by = (a) => legal.find((l) => l.action === a);
      if (by('reveal')) return { action: 'reveal', mode: ctx.rng() < 0.5 ? 'show' : 'prove' };
      if (by('liar') && (!by('bid') || ctx.rng() < 0.5)) return { action: 'liar' };
      if (by('bid')) {
        const b = by('bid');
        const raise = b.raise.max >= 1 ? b.raise.max : 0;
        note.biggest = Math.max(note.biggest, raise);
        note.bigBid = Math.max(note.bigBid, b.lowest.count);
        return { action: 'bid', ...b.lowest, ...(raise ? { raise } : {}) };
      }
      return { action: 'fold' };
    },
  },
  'sealed-hand': {
    engine: hand,
    bots: handBots,
    /** The house's own idea of a move, with every raise it carries pushed as high as the table lets it go. */
    move(s, ctx, note, attempt) {
      const base = handBots.decide(hand.publicView(s), 0, s.hands[0], ctx.rng, { persona: handBots.PERSONAS[hand.HOUSE_NAME], received: s.received[0] });
      const chips = s.seats[0].chips;
      const cap = Math.max(0, Math.min(s.cfg.raiseLimit, chips - 30, (s.cfg.potLimit ?? Infinity) - s.pot - 30));
      const raisable = ['pass', 'stop', 'claim', 'raise', 'check'].includes(base.action);
      if (!raisable || cap < 1) return base;
      for (let r = cap; r >= 1; r = Math.floor(r / 2)) {
        const move = { ...base, raise: r };
        if (attempt(move)) {
          note.biggest = Math.max(note.biggest, r);
          return null; // played
        }
        if (r === 1) break;
      }
      return base;
    },
  },
};

export function runSim(game, { rounds = 30, seed = 7 } = {}) {
  const g = GAMES[game];
  const E = g.engine;
  const ctx = { now: 1000, rng: rngFrom(seed) };
  const s = E.createTable({ lobbyMs: 0, ...chipsStakes(4) });
  E.join(s, 'Bettor', ctx, { kind: 'human', chips: 1000 });
  const bots = s.seats.map((x, i) => (x.bot ? i : null)).filter((i) => i !== null);
  const out = { game, rounds: 0, over: false, minStack: Object.fromEntries(bots.map((i) => [s.seats[i].name, Infinity])), refills: 0, fillUps: 0, biggest: 0, bigBid: 0, biggestPot: 0, houseStaked: 0, violations: [] };
  const note = out;
  const violate = (what) => { if (out.violations.length < 20) out.violations.push(`round ${s.round}: ${what}`); };
  const watch = () => {
    for (const i of bots) {
      const x = s.seats[i];
      out.minStack[x.name] = Math.min(out.minStack[x.name], x.chips);
      if (x.left) violate(`${x.name} left`);
      if (x.standing) violate(`${x.name} is standing`);
    }
    out.biggestPot = Math.max(out.biggestPot, s.pot);
    if (s.phase === 'over') { out.over = true; violate(`the table closed: ${s.overCode}`); }
  };

  const playOut = () => {
    for (let guard = 0; guard < 4000 && !['settled', 'over'].includes(s.phase); guard++) {
      g.bots.runBots(s, ctx);
      watch();
      if (['settled', 'over'].includes(s.phase)) break;
      if (E.legalActions(s, 0).length === 0) { violate(`stuck in ${s.phase}`); return false; }
      const attempt = (move) => { try { E.act(s, 0, move, ctx); return true; } catch { return false; } };
      let move = g.move(s, ctx, note, attempt);
      if (move === null) { watch(); continue; }
      if (!attempt(move)) {
        try { E.act(s, 0, E.autoAction(s, 0), { ...ctx, auto: true }); } catch (err) { violate(`no legal move for the bettor: ${err.code ?? err.message}`); return false; }
      }
      watch();
    }
    return s.phase === 'settled';
  };

  for (let r = 0; r < rounds && s.phase !== 'over'; r++) {
    if (!playOut()) break;
    out.rounds += 1;
    out.biggestPot = Math.max(out.biggestPot, s.lastResult?.pot ?? 0);
    // Out of chips: Fill up (the stack back to 1,000), then the next round. The table waits for that, it never closes.
    if (s.seats[0].chips < s.cfg.ante) {
      E.addChips(s, 0, 1000 - s.seats[0].chips, ctx);
      out.fillUps += 1;
    }
    ctx.now += 60_000;
    E.act(s, 0, { action: 'next' }, ctx);
    watch();
    // A bot that sits the round out for lack of chips is a violation.
    if (['bid', 'pass', 'claim', 'answer', 'duel'].includes(s.phase)) for (const i of bots) if (s.status[i] === 'out') violate(`${s.seats[i].name} sat the round out`);
  }
  out.refills = bots.reduce((n, i) => n + (s.seats[i].rebuys ?? 0), 0);
  out.houseStaked = s.houseStaked ?? 0;
  out.biggest = Math.max(out.biggest, 0);
  out.phase = s.phase;
  return out;
}

function main() {
  const rounds = Number(process.argv[2] ?? 30);
  const seed = Number(process.argv[3] ?? 7);
  let bad = 0;
  const rows = [];
  for (const game of Object.keys(GAMES)) {
    const r = runSim(game, { rounds, seed });
    bad += r.violations.length + (r.rounds < rounds ? 1 : 0);
    rows.push(r);
    for (const v of r.violations) console.error(`VIOLATION ${game}: ${v}`);
    if (r.rounds < rounds) console.error(`VIOLATION ${game}: only ${r.rounds} of ${rounds} rounds were played`);
  }
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`${pad('game', 15)}${pad('rounds', 8)}${pad('over', 6)}${pad('min bot stack', 15)}${pad('bot refills', 12)}${pad('fill-ups', 9)}${pad('biggest raise', 14)}${pad('biggest bid', 12)}biggest pot  house staked`);
  for (const r of rows) {
    const min = Math.min(...Object.values(r.minStack));
    console.log(`${pad(r.game, 15)}${pad(r.rounds, 8)}${pad(r.over ? 'YES' : 'no', 6)}${pad(min, 15)}${pad(r.refills, 12)}${pad(r.fillUps, 9)}${pad(r.biggest, 14)}${pad(r.bigBid || '-', 12)}${pad(r.biggestPot, 13)}${r.houseStaked}`);
  }
  console.log(bad === 0 ? 'OK: no violations' : `FAILED: ${bad} violation(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
