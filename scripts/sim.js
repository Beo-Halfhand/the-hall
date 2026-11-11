// How do the bots actually play? Runs tables in memory, with a stand-in for the human seat, and prints rates.
// node scripts/sim.js [tables] [plain]   plain: the stand-in only ever passes the plain way, to see what the other styles cost the bots

import { HOUSE_NAME, createTable, currentTurn, join, publicView, act } from '../src/games/sealed-hand/engine.js';
import { PERSONAS, decide, paceBots } from '../src/games/sealed-hand/bots.js';
import { contains, rankOf } from '../src/games/sealed-hand/cards.js';

const tables = Number(process.argv[2] ?? 200);
const ROUNDS = 20;
const PLAIN_STAND_IN = process.argv[3] === 'plain';
const standIn = PLAIN_STAND_IN ? { ...PERSONAS[HOUSE_NAME], pass: undefined } : PERSONAS[HOUSE_NAME];

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

const passWatch = {};
function notePass(name, hand, move) {
  if (move.action !== 'pass') return;
  const low = Math.min(...hand.map(rankOf));
  const by = (passWatch[name] ??= { passes: 0, lowest: 0, sum: 0 });
  by.passes += 1;
  by.sum += rankOf(move.card);
  if (rankOf(move.card) === low) by.lowest += 1;
}

const stats = {};
const row = (name) => (stats[name] ??= { turns: 0, claims: 0, falseClaims: 0, calls: 0, checks: 0, caught: 0, called: 0, chips: 0 });
const kinds = { settled: 0, carried: 0, uncontested: 0 };
const passes = [];
const lap = {};
const lapTotals = { rounds: 0, raised: 0, answers: 0, raisedClaims: 0, raisedClaimsCalled: 0, raisedClaimsCaught: 0, plainClaims: 0, plainClaimsCalled: 0, biggest: 0, sum: 0, n: 0, uncallable: 0, uncallableBluffs: 0 };
let botErrors = 0;
const byCat = {};
let rounds = 0;

const afterLap = { calls: 0, caught: 0, lastTurnClaims: 0, lastTurnRaisedBluffs: 0, lastTurnRaisedBluffsCaught: 0, neverCallable: 0 };
const stops = { rounds: 0, raised: 0, raiseSum: 0, bluffs: 0, bluffsRaised: 0, called: 0, caught: 0, allFold: 0, allFoldBluffs: 0, withdrawn: 0 };
const stopsBy = {};

/** What became of the stop in one finished round, if there was one. */
function noteStop(s, lines) {
  const at = lines.findIndex((l) => l.text.includes(' stops the passing and claims '));
  if (at < 0) return;
  const seat = s.seats.findIndex((x) => lines[at].text.startsWith(`${x.name} `));
  const c = s.claims.find((x) => x.seat === seat);
  const by = (stopsBy[s.seats[seat].name] ??= { stops: 0, raised: 0, bluffs: 0 });
  const raise = / raises to (\d+)\.$/.exec(lines[at + 1]?.text ?? '');
  const bluff = !contains(s.hands[seat], c.claim);
  stops.rounds += 1;
  by.stops += 1;
  if (raise) { stops.raised += 1; stops.raiseSum += Number(raise[1]); by.raised += 1; }
  if (bluff) { stops.bluffs += 1; by.bluffs += 1; if (raise) stops.bluffsRaised += 1; }
  if (c.status === 'proven' || c.status === 'caught') stops.called += 1;
  if (c.status === 'caught') stops.caught += 1;
  if (c.status === 'withdrawn') stops.withdrawn += 1;
  if (s.lastResult?.kind === 'uncontested' && s.lastResult.awards[0].seat === seat) {
    stops.allFold += 1;
    if (bluff) stops.allFoldBluffs += 1;
  }
}

/** Reads one finished round's log for the lap's raises, matches and folds. */
function noteLap(s) {
  const lines = s.log.filter((l) => l.round === s.round && !l.say);
  botErrors += lines.filter((l) => l.botError).length;
  const open = lines.findIndex((l) => l.text.startsWith('Claims open.') || l.text.includes(' stops the passing and claims '));
  if (open < 0) return;
  lapTotals.rounds += 1;
  const raisedBy = new Set();
  let answered = false;
  for (const line of lines.slice(open)) {
    if (line.text.startsWith('The raise stands at')) answered = true;
    const who = s.seats.find((x) => line.text.startsWith(`${x.name} `));
    if (!who) continue;
    const row = (lap[who.name] ??= { turns: 0, raises: 0, trueClaims: 0, trueRaised: 0, bluffClaims: 0, bluffRaised: 0, empties: 0, emptyRaised: 0, matches: 0, folds: 0, withdrew: 0, calledRaised: 0 });
    const raise = / raises to (\d+)\.$/.exec(line.text);
    if (raise) {
      row.raises += 1;
      raisedBy.add(s.seats.indexOf(who));
      lapTotals.sum += Number(raise[1]);
      lapTotals.n += 1;
      lapTotals.biggest = Math.max(lapTotals.biggest, Number(raise[1]));
    }
    if (/ matches \d+\.$/.test(line.text)) row.matches += 1;
    if (/ folds\.$/.test(line.text)) row.folds += 1;
    if (/ folds and withdraws/.test(line.text)) { row.folds += 1; row.withdrew += 1; }
    if (!answered && / claims |checks\.$| calls /.test(line.text)) row.turns += 1;
    if (answered && / calls /.test(line.text)) {
      afterLap.calls += 1;
      if (/ is a BLUFF\./.test(line.text)) afterLap.caught += 1;
    }
  }
  noteStop(s, lines);
  if (raisedBy.size) lapTotals.raised += 1;
  if (answered) lapTotals.answers += 1;
  for (const c of s.claims) {
    const row = lap[s.seats[c.seat].name];
    const held = contains(s.hands[c.seat], c.claim);
    if (held) row.trueClaims += 1;
    else row.bluffClaims += 1;
    const raised = raisedBy.has(c.seat);
    if (raised && held) row.trueRaised += 1;
    if (raised && !held) row.bluffRaised += 1;
    const called = c.status === 'proven' || c.status === 'caught';
    lapTotals[raised ? 'raisedClaims' : 'plainClaims'] += 1;
    if (called) lapTotals[raised ? 'raisedClaimsCalled' : 'plainClaimsCalled'] += 1;
    if (raised && c.status === 'caught') lapTotals.raisedClaimsCaught += 1;
  }
  // The last seat in the lap has nobody after it, so its claim can't be called.
  const end = lines.findIndex((l, i) => i > open && (l.text.startsWith('The raise stands at') || / takes \d+| carries/.test(l.text)));
  const turns = lines.slice(open + 1, end < 0 ? undefined : end).filter((l) => / claims | checks\.$| calls | folds/.test(l.text));
  const lastTurn = turns.at(-1);
  const closer = lastTurn && s.claims.find((c) => lastTurn.text.startsWith(`${s.seats[c.seat].name} claims `));
  if (closer) {
    afterLap.lastTurnClaims += 1;
    if (!answered) afterLap.neverCallable += 1;
    if (raisedBy.has(closer.seat) && !contains(s.hands[closer.seat], closer.claim)) {
      afterLap.lastTurnRaisedBluffs += 1;
      if (closer.status === 'caught') afterLap.lastTurnRaisedBluffsCaught += 1;
    }
  }
}

for (let t = 1; t <= tables; t++) {
  const context = { now: 1000, rng: rngFrom(t), onBotMove: (seat, hand, move) => notePass(s.seats[seat].name, hand, move) };
  const s = createTable({ lobbyMs: 0 });
  join(s, 'Stand-in', context); // plays like the house's Tally, so every seat follows the same logic

  const stepHuman = () => {
    const view = publicView(s);
    const move = decide(view, 0, s.hands[0], context.rng, { persona: standIn, received: s.received[0] });
    notePass('Stand-in', s.hands[0], move);
    act(s, 0, move, context);
  };

  for (let r = 0; r < ROUNDS && s.phase !== 'over'; r++) {
    const seen = new Set();
    // On the real clock, so who moves first varies as it does at a live table. The stand-in takes as long as a bot.
    let standInAt = null;
    for (let i = 0; i < 1000 && !['settled', 'over'].includes(s.phase); i++) {
      paceBots(s, context);
      if (['settled', 'over'].includes(s.phase)) break;
      const mine = currentTurn(s) === 0 || (s.phase === 'pass' && !s.raise && s.passes[0] === null && s.status[0] === 'in');
      if (!mine) standInAt = null;
      else standInAt ??= context.now + 1500 + context.rng() * 1500;
      context.now = Math.min(standInAt ?? Infinity, ...Object.values(s.botDue).map((d) => d.at));
      if (mine && context.now >= standInAt) {
        standInAt = null;
        stepHuman();
      }
    }
    if (s.phase !== 'settled') break;
    rounds += 1;
    kinds[s.lastResult.kind] += 1;
    noteLap(s);
    passes.push(Math.max(...s.received.map((r) => r.length)));
    for (const c of s.claims) {
      const name = s.seats[c.seat].name;
      const st = row(name);
      st.claims += 1;
      if (!contains(s.hands[c.seat], c.claim)) st.falseClaims += 1;
      if (c.status !== 'standing') st.called += 1;
      if (c.status === 'caught') st.caught += 1;
      byCat[c.claim[0]] ??= { made: 0, called: 0 };
      byCat[c.claim[0]].made += 1;
      if (c.status !== 'standing') byCat[c.claim[0]].called += 1;
      seen.add(c.seat);
    }
    act(s, 0, { action: 'next' }, context);
  }
  s.seats.forEach((x) => { row(x.name).chips += x.chips; });
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
console.log(`${tables} tables, ${rounds} rounds`);
console.log(`round ends: settled ${pct(kinds.settled, rounds)}, carried ${pct(kinds.carried, rounds)}, uncontested ${pct(kinds.uncontested, rounds)}`);
console.log(`average passes: ${(passes.reduce((a, b) => a + b, 0) / passes.length).toFixed(2)}`);
console.log('seat       claims  false   called  caught  avg end chips');
for (const [name, st] of Object.entries(stats)) {
  console.log(`${name.padEnd(10)} ${String(st.claims).padEnd(7)} ${pct(st.falseClaims, st.claims).padEnd(7)} ${pct(st.called, st.claims).padEnd(7)} ${pct(st.caught, st.called).padEnd(7)} ${(st.chips / tables).toFixed(0)}`);
}
console.log('claim category   made    called');
for (const [cat, c] of Object.entries(byCat)) console.log(`${cat.padEnd(16)} ${String(c.made).padEnd(7)} ${pct(c.called, c.made)}`);

const n = (x) => String(x);
console.log(`claim lap: ${lapTotals.rounds} laps, a raise in ${pct(lapTotals.raised, lapTotals.rounds)}, a match-or-fold turn after ${pct(lapTotals.answers, lapTotals.rounds)}, average raise to ${(lapTotals.sum / Math.max(1, lapTotals.n)).toFixed(1)}, highest ${lapTotals.biggest}`);
console.log(`claims called: raised ${pct(lapTotals.raisedClaimsCalled, lapTotals.raisedClaims)} of ${lapTotals.raisedClaims}, not raised ${pct(lapTotals.plainClaimsCalled, lapTotals.plainClaims)} of ${lapTotals.plainClaims}. Caught of raised claims called: ${pct(lapTotals.raisedClaimsCaught, lapTotals.raisedClaimsCalled)}`);
console.log(`claims on the lap's last turn: ${afterLap.lastTurnClaims}, with no after-lap turn so nobody could call them: ${afterLap.neverCallable}. Raised bluffs among them: ${afterLap.lastTurnRaisedBluffs}, caught after the lap: ${afterLap.lastTurnRaisedBluffsCaught}`);
console.log(`after-lap calls: ${afterLap.calls}, bluffs caught: ${afterLap.caught}`);
console.log(`bot errors: ${botErrors}`);
const allPasses = Object.values(passWatch).reduce((a, b) => ({ passes: a.passes + b.passes, lowest: a.lowest + b.lowest }), { passes: 0, lowest: 0 });
const botPasses = Object.entries(passWatch).filter(([name]) => name !== 'Stand-in').reduce((a, [, b]) => ({ passes: a.passes + b.passes, lowest: a.lowest + b.lowest }), { passes: 0, lowest: 0 });
console.log(`passed card is the lowest: bots ${pct(botPasses.lowest, botPasses.passes)} of ${botPasses.passes}, everyone ${pct(allPasses.lowest, allPasses.passes)}`);
for (const [name, b] of Object.entries(passWatch).sort()) console.log(`  ${name.padEnd(14)} ${pct(b.lowest, b.passes).padEnd(5)} of ${String(b.passes).padEnd(6)} average rank passed ${(b.sum / b.passes).toFixed(1)}`);
console.log(`stops: in ${pct(stops.rounds, lapTotals.rounds)} of laps, raised ${pct(stops.raised, stops.rounds)} (average to ${(stops.raiseSum / Math.max(1, stops.raised)).toFixed(1)}), bluffs ${pct(stops.bluffs, stops.rounds)}`);
console.log(`what became of them: called ${pct(stops.called, stops.rounds)} (caught ${pct(stops.caught, stops.rounds)}), withdrawn ${pct(stops.withdrawn, stops.rounds)}, everyone else folded ${pct(stops.allFold, stops.rounds)} (on a bluff ${stops.allFoldBluffs})`);
for (const [name, b] of Object.entries(stopsBy).sort()) console.log(`  ${name.padEnd(14)} stops ${String(b.stops).padEnd(6)} raised ${pct(b.raised, b.stops).padEnd(5)} bluffs ${pct(b.bluffs, b.stops)}`);
console.log('seat           lap turns  raise%  true claims raised  bluffs raised  folds  claims withdrawn  matches');
for (const [name, c] of Object.entries(lap).sort()) {
  console.log(`${name.padEnd(14)} ${n(c.turns).padEnd(10)} ${pct(c.raises, c.turns).padEnd(7)} ${pct(c.trueRaised, c.trueClaims).padEnd(19)} ${pct(c.bluffRaised, c.bluffClaims).padEnd(14)} ${n(c.folds).padEnd(6)} ${n(c.withdrew).padEnd(17)} ${c.matches}`);
}
