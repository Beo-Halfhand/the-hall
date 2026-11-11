// A player's side of a proof table. The seed is made here and stays here: it goes into the wallet's prover and nowhere else. It isn't in any
// request to the Hall, so the server can't work out this player's dice. This page does it, from the seed and the salt on chain.
//
// The contract's address, and everything public about the round, comes from the server's view. So this page reads the chain itself and says
// out loud if the two differ: a seat shown as a bot that the chain has as a player's, a seal it never named, or a bid that isn't the one called.
// It can't stop any of them. It can only tell the player, who can leave.

import * as cage from './cage-session.js';
import { commitOf, countsOf, diceOf, keyIdOf, newSeed, preSealOf } from './dice-roll.js';

const seedKey = (p, seat) => `dice.seed.${p.address}.${p.table}.${p.round}.${seat}`;
const st = { client: null, busy: false, line: '', trouble: '', holderFor: null, diceFor: null, dice: null, failed: null, answered: null, autoFor: null, warnings: [], checkedSeats: null, checkedBid: null };
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* the seed stays in this page's memory, and a reload would lose the cup */ } },
};
const memory = new Map();
const seedOf = (p, seat) => memory.get(seedKey(p, seat)) ?? store.get(seedKey(p, seat));

async function clientFor(p) {
  if (st.client) return st.client;
  if (!cage.state.api || !cage.state.indexer) throw new Error('Connect your wallet first: see the window.');
  const code = await import('/wallet-app/dice-proof.js');
  st.client = await code.openDiceProof({ api: cage.state.api, address: p.address, indexerHttp: cage.state.indexer.http, indexerWs: cage.state.indexer.ws, zkBase: `${location.origin}/wallet-app/zk-dice`, walletName: cage.walletName() });
  return st.client;
}
const cupOf = (p, seat) => ({ table: BigInt(p.table), round: BigInt(p.round), seat: BigInt(seat) });

/** Compares what the table shows with what the chain holds, once per step of the round. */
async function checkChain(view, me, rerender) {
  const p = view.proof;
  const stage = `${p.table}.${p.round}`;
  if (!p.round || !cage.state.api || !cage.state.indexer || !['sealing', 'revealing', 'answering'].includes(p.stage)) return;
  const wantsSeats = st.checkedSeats !== stage;
  const wantsBid = p.stage === 'answering' && st.checkedBid !== stage;
  if (!wantsSeats && !wantsBid) return;
  if (wantsSeats) st.checkedSeats = stage;
  if (wantsBid) st.checkedBid = stage;
  try {
    const client = await clientFor(p);
    const seats = view.seats.map((x) => x.seat ?? view.seats.indexOf(x));
    const onChain = await client.readRound(p.table, p.round, seats);
    if (!onChain) return;
    const out = [];
    if (wantsSeats) {
      for (const x of view.seats) {
        const seat = x.seat ?? view.seats.indexOf(x);
        if (x.kind === 'house' && x.cup && !onChain.seats[seat]?.houseRun) out.push(`${x.name} is shown as a house bot, but the chain has it as a player’s seat.`);
      }
      const mine = onChain.seats[me.seat];
      const seed = seedOf(p, me.seat);
      if (mine && seed) {
        const named = await preSealOf(await commitOf(seed, p.table, p.round, me.seat, p.address), p.table, p.round, me.seat);
        if (mine.preseal !== named || mine.holder !== await keyIdOf(cage.myKey())) out.push('The chain names a different seal for your seat than the one this page sent. You can’t seal this cup.');
      }
    }
    if (wantsBid && view.duel) {
      const { bidder, caller, bid } = view.duel;
      if (onChain.bidder !== bidder || onChain.caller !== caller || onChain.bidCount !== bid.count || onChain.bidFace !== bid.face) out.push(`The bid on chain isn’t the one called here: the chain has ${onChain.bidCount} of face ${onChain.bidFace}, seat ${onChain.bidder} called by seat ${onChain.caller}.`);
    }
    if (out.length) { st.warnings.push(...out); rerender(); }
  } catch { // a read that fails says nothing either way, so it's tried again at the next step
    if (wantsSeats) st.checkedSeats = null;
    if (wantsBid) st.checkedBid = null;
  }
}

async function work(rerender, line, job, failKey) {
  st.busy = true;
  st.trouble = '';
  st.line = line;
  rerender();
  try { await job(); st.failed = null; } catch (e) { st.failed = failKey; st.trouble = cage.errorText(e); }
  st.busy = false;
  st.line = '';
  rerender();
}

/** Called on every redraw. Does whatever this seat owes the round, if nothing is running. */
export function step({ view, me, post, rerender }) {
  const p = view?.proof;
  if (!p || !me?.proof) return;
  void checkChain(view, me, rerender);
  if (st.busy) return;
  // Before the round opens: this round's seed, made here. Only the hash of the hash of it goes to the server. It's fixed from here on, so
  // no seat, the house's or anyone's, can wait to see the others' and pick a seed that suits it.
  if (me.proof.needSeal && cage.myKey() && st.holderFor !== `${p.table}.${p.round}.${me.seat}`) {
    st.holderFor = `${p.table}.${p.round}.${me.seat}`;
    const key = seedKey(p, me.seat);
    const seed = seedOf(p, me.seat) ?? newSeed();
    memory.set(key, seed);
    store.set(key, seed);
    (async () => {
      const preseal = await preSealOf(await commitOf(seed, p.table, p.round, me.seat, p.address), p.table, p.round, me.seat);
      await post('/proof-holder', { holder: await keyIdOf(cage.myKey()), preseal });
      rerender();
    })().catch(() => { st.holderFor = null; });
    return;
  }
  if (p.stage === 'sealing' && !me.proof.sealed && cage.state.api && cage.state.indexer && cage.myKey() && st.failed !== `seal.${p.round}`) {
    const key = seedKey(p, me.seat);
    if (store.get(`${key}.sent`)) return;
    void work(rerender, `Sealing your cup. Approve in ${cage.walletName()}. The seed stays on this device.`, async () => {
      const seed = seedOf(p, me.seat);
      if (!seed) throw new Error('This browser doesn’t hold the seed for this round.');
      const commit = await commitOf(seed, p.table, p.round, me.seat, p.address);
      const client = await clientFor(p);
      await client.call('commitCup', { sk: fromHex(cage.myKey()) }, [cupOf(p, me.seat), fromHex(commit)], (t) => { st.line = t; rerender(); });
      store.set(`${key}.sent`, '1');
    }, `seal.${p.round}`);
    return;
  }
  if (p.salt && st.diceFor !== `${p.table}.${p.round}.${me.seat}`) {
    const seed = seedOf(p, me.seat);
    if (!seed) return;
    st.diceFor = `${p.table}.${p.round}.${me.seat}`;
    diceOf(p.salt, seed, me.seat).then((dice) => { st.dice = dice; rerender(); });
    return;
  }
  // A folded cup still counts. There's nothing to choose: it proves, once it's its turn.
  const reveal = me.legal?.find((a) => a.action === 'reveal');
  if (reveal?.folded && reveal.ready && st.autoFor !== `${p.round}.${me.seat}`) {
    st.autoFor = `${p.round}.${me.seat}`;
    void answer({ view, me, mode: 'prove', post, rerender });
  }
}

/** The server has no dice for this seat, so the page fills them in. */
export function withMyDice(view, me) {
  const p = view?.proof;
  if (!p || !me || !st.dice || st.diceFor !== `${p.table}.${p.round}.${me.seat}`) return me;
  return { ...me, dice: st.dice, counts: countsOf(st.dice) };
}

/** Keep the cup shut, or show. The wallet proves it, and the chain checks it: the server hears about it from the chain. */
export function answer({ view, me, mode, post, rerender }) {
  const p = view.proof;
  const seed = seedOf(p, me.seat);
  if (!seed || !st.dice) { st.trouble = 'This browser doesn’t hold the seed for this cup, so it can’t answer. It may be on the device you sealed it from.'; rerender(); return Promise.resolve(); }
  const face = view.duel.bid.face;
  const count = BigInt(countsOf(st.dice)[face]);
  return work(rerender, `Proving your ${mode === 'show' ? 'dice' : 'count'}. Approve in ${cage.walletName()}.`, async () => {
    await post('/act', { action: 'reveal', mode }); // says what this seat is doing. The answer itself is the chain's to report.
    const client = await clientFor(p);
    const state = { seed: fromHex(seed) };
    const result = mode === 'show'
      ? await client.call('showCup', state, [cupOf(p, me.seat), st.dice.map(BigInt)], (t) => { st.line = t; rerender(); })
      : await client.call('proveCount', state, [cupOf(p, me.seat), count], (t) => { st.line = t; rerender(); });
    st.answered = { round: p.round, hash: result?.txHash ?? null };
  }, `answer.${p.round}`);
}

export const warnings = () => st.warnings;
export const line = () => st.line;
export const trouble = () => st.trouble;
export const busy = () => st.busy;
export const retry = (rerender) => { st.failed = null; st.trouble = ''; rerender(); };

/** One sentence on where a proof table's round is. */
export function stageLine(view, me) {
  const p = view.proof;
  const secs = (at) => Math.max(0, at - Math.floor(Date.now() / 1000));
  switch (p.stage) {
    case 'holders': return 'Each seat fixes its secret for this round.';
    case 'opening': return 'The house is locking its seed and every seat’s seal on chain.';
    case 'sealing': return me?.proof?.sealed ? 'Your cup is sealed. Waiting for the other seats.' : `Each player seals a cup from their own wallet: ${secs(p.sealBy)} s left.`;
    case 'revealing': return 'Every cup is sealed. The house is opening its seed on chain.';
    case 'calling': return p.callBy && Math.floor(Date.now() / 1000) > p.callBy ? 'The house didn’t post this call in time. The round voids, and that’s on the chain for anyone to see.' : 'The house is posting the called bid on chain.';
    case 'answering': return p.houseDone ? `The chain is taking each cup’s answer: ${secs(p.answerBy)} s left.` : `The house’s cups answer first, so it can’t wait to see yours: up to ${secs(p.houseBy)} s.`;
    default: return '';
  }
}
