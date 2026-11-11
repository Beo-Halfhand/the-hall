// A round's receipt, drawn once for every place it shows: the full page (/receipt/114-47, /records/<game>/<number>) and the window that
// opens over a table once its round has ended. It reads nothing but the record's JSON, and checks what it can in this browser
// (round-check.js): Cup & Claim's dice against their seals, Sealed Hand's hands and verdicts against the opened deck. What can't be
// checked here is said to be so.

import { runChecks } from './round-check.js';

export const CHAIN_TX = (hash) => `https://preprod.midnightexplorer.com/transactions/${hash}`;
export const GAME_NAME = { 'cup-and-claim': 'Cup & Claim', 'sealed-hand': 'Sealed Hand' };

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') el.addEventListener('click', v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined));
  return el;
}

const row = (...cells) => h('tr', {}, cells.map((c) => h('td', { class: typeof c === 'number' ? 'rc-num' : null }, String(c))));
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const when = (ms) => (ms ? new Date(ms).toISOString() : '—');

/** The status line under the title, for either game. */
export function statusLine(r) {
  const play = r.kind === 'play';
  if (r.game === 'sealed-hand') {
    const say = {
      posted: r.seal ? 'The deck is sealed and the round is in play.' : 'The cards are dealt and the round is in play.',
      opened: play ? 'The round is over and the deck is open. Play chips: nothing settles on chain.' : 'The round is over and the deck is open. Settling on chain…',
      over: play ? 'The round is over. Play chips: nothing settles on chain.' : 'The round is over. Settling on chain…',
      settled: 'The round is over, the deck is open, and the money is settled on chain.',
      void: 'This round didn’t reach the chain: the table closed first. No money moved for it.',
    };
    return say[r.status] ?? r.status;
  }
  const say = play
    ? { posted: 'The dice are sealed and the round is in play.', opened: 'The round is over and the seal is open. Play chips: nothing settles on chain.' }
    : { posted: 'The dice are sealed and the round is in play.', opened: 'The round is over and the seal is open. Settling on chain…', settled: 'The round is over, the seal is open, and the money is settled on chain.', void: 'This round didn’t reach the chain: the table closed first. No money moved for it.' };
  return say[r.status] ?? r.status;
}

/** The kicker's tail: "Cup & Claim · play chips" or "Sealed Hand · Midnight preprod". */
export const kickerTail = (r) => `${GAME_NAME[r.game] ?? r.game}${r.kind === 'play' ? ' · play chips' : ' · Midnight preprod'}`;

/** How the pot was split at Cup & Claim: the loser of the call pays, the others get their stake back and an equal share (a right caller counts double). */
function splitLine(res) {
  const aw = res.awards ?? [];
  if (!res.loser || aw.length <= 1) return `${res.winner.name} takes the pot of ${res.pot}.`;
  return `${res.loser.name} lost ${res.loserStake}${res.pool > res.loserStake ? `, and the folders' chips made it ${res.pool}` : ''}. The pot of ${res.pot} is paid out: ${aw.map((a) => `${a.name} ${a.amount} (${a.back} back + ${a.share}${a.bonus ? ', double share for the right call' : ''})`).join(', ')}.`;
}

/** The "Check this round" section: a button, and the results drawn under it. `state.checked` keeps the results through a redraw. */
function checkSection(r, state) {
  const results = h('ul', { class: 'rc-check', id: 'rc-checks' });
  const run = async () => {
    state.checked = true;
    const checks = await runChecks(r, { indexer: '/indexer/graphql' }); // the Hall's own indexer: the key stays on the server
    results.replaceChildren(...checks.map((c) => h('li', { class: c.kind, text: c.text })));
  };
  if (state.checked) run();
  return h('section', { class: 'rc-box' }, h('h2', { text: 'Check this round' }),
    h('p', { class: 'rc-note', text: 'Done here in your browser, from the receipt alone.' }),
    h('button', { class: 'btn primary', id: 'check-now', type: 'button', text: 'Check this round', on: run }), results);
}

const chainBox = (r) => h('section', { class: 'rc-box' }, h('h2', { text: 'The chain' }), r.settle
  ? [
    h('p', { class: 'rc-line' }, 'Settle transaction: ', h('a', { id: 'rc-tx', class: 'rc-hash', href: CHAIN_TX(r.settle.hash), target: '_blank', rel: 'noopener', text: r.settle.hash })),
    h('p', { class: 'rc-line', id: 'rc-block', text: `Block ${r.settle.block} · ${r.settle.status} · cage table ${r.table}, chain round ${r.settle.chainRound ?? r.round}` }),
    r.settle.chainRound !== null && r.settle.chainRound !== undefined && r.settle.chainRound !== r.round ? h('p', { class: 'rc-line', text: `This round settled on chain as round ${r.settle.chainRound}.` }) : null,
    r.settle.rounds?.length > 1 ? h('p', { class: 'rc-line', text: `One transaction entry settled these rounds together: ${r.settle.rounds.join(', ')}.` }) : null,
  ]
  : h('p', { class: 'rc-line', text: r.void ? r.void.why : r.result?.kind === 'carried' ? 'The pot carried, so it settles with the next paid pot.' : 'Not settled yet.' }),
h('p', { class: 'rc-line rc-note' }, 'Cage ', h('span', { class: 'rc-hash', text: r.cage?.address ?? 'not recorded' })));

const chipsBox = (r, play) => h('section', { class: 'rc-box' }, h('h2', { text: play ? 'Chips moved (play chips, net of what each seat put in)' : 'Chips moved (1 chip = 1 tNIGHT)' }), h('table', { class: 'rc-table', id: 'rc-chips' },
  r.chips.map((l) => row(l.kind === 'house' && !play ? 'House (its bots, one line)' : l.kind === 'agent' ? `${l.name} · Agent` : l.name, signed(l.delta))))); // at a play table each bot is its own line

/** The links at the foot of the proof box: the JSON, and the tNIGHT receipt where there is one. */
const jsonLine = (r, { jsonHref }) => h('p', { class: 'rc-line' }, h('a', { href: jsonHref, id: 'rc-json', text: r.game === 'sealed-hand' || jsonHref.startsWith('/records/') ? 'This record as JSON' : 'This receipt as JSON' }), r.receipt ? [' · ', h('a', { href: r.receipt, id: 'rc-receipt', text: 'The tNIGHT receipt' })] : null);

const shortHex = (x) => (x ? `${String(x).slice(0, 12)}…${String(x).slice(-6)}` : '');

/** The lock on Midnight (11-08): the round's seal attested on chain, with the transaction, the block, and the vault entry. */
function anchorBox(r) {
  const a = r.anchor;
  if (!a && !r.anchorNote) return null;
  if (!a || !a.ok) {
    return h('section', { class: 'rc-box', id: 'rc-anchor' }, h('h2', { text: 'Locked on Midnight' }),
      h('p', { class: 'rc-line', text: `Not locked: ${a?.error ?? r.anchorNote?.why ?? 'no word from the chain'}. The round played on with its seal on this server's record only.` }));
  }
  return h('section', { class: 'rc-box', id: 'rc-anchor' }, h('h2', { text: 'Locked on Midnight' }),
    h('p', { class: 'rc-line' }, h('b', { text: 'Transaction: ' }), a.txHash ? h('a', { href: CHAIN_TX(a.txHash), target: '_blank', rel: 'noopener', text: shortHex(a.txHash) }) : 'unknown', ` · block ${a.block}${a.blockAt ? ` · ${when(a.blockAt)}` : ''}`),
    h('p', { class: 'rc-line rc-note' }, 'One attestation on Midnight preprod: the vault ', h('span', { class: 'rc-hash', text: shortHex(a.vault) }), ' holds ', h('span', { class: 'rc-hash', text: shortHex(a.payload) }), ` under the Hall's anchor identity ${shortHex(a.attester)}, with this round's number bound beside it.`));
}

/** Cup & Claim: the round, each cup, the chips, the chain, the fingerprint, the checks, what it proves. */
function diceBoxes(r, opts, state) {
  const play = r.kind === 'play';
  const boxes = [];
  if (r.claim || r.result) {
    const lines = [];
    if (r.claim) lines.push(h('p', { class: 'rc-line', id: 'rc-claim' }, h('b', { text: 'The claim: ' }), `${r.claim.name} bid at least ${r.claim.count} of the ${r.claim.face}s, 1s wild.`));
    if (r.call) lines.push(h('p', { class: 'rc-line', id: 'rc-call' }, h('b', { text: 'The call: ' }), `${r.call.name} called Liar.`));
    if (r.result?.kind === 'call') lines.push(h('p', { class: 'rc-line', id: 'rc-result' }, h('b', { text: 'The result: ' }), `The table counted ${r.result.total}. The bid ${r.result.held ? 'holds' : 'falls'}. ${splitLine(r.result)}`));
    else if (r.result?.awards) lines.push(h('p', { class: 'rc-line', id: 'rc-result' }, h('b', { text: 'The result: ' }), `Everyone else folded. ${r.result.awards.map((a) => `${a.name} takes ${a.amount}`).join(', ')}.`));
    else if (r.result) lines.push(h('p', { class: 'rc-line', id: 'rc-result' }, h('b', { text: 'The result: ' }), r.result.why ?? r.result.kind));
    boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'The round' }), lines));
  }
  if (r.reveals?.length) {
    boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'Each cup' }), h('table', { class: 'rc-table', id: 'rc-cups' },
      h('tr', {}, ['Seat', 'Answer', 'Dice', 'Count'].map((x) => h('th', { text: x }))),
      r.reveals.map((c) => row(c.name, c.mode === 'show' ? 'showed' : c.folded ? 'folded, cup shut' : 'cup shut', c.dice ? c.dice.join(' ') : 'not shown', c.count)))));
  }
  if (r.chips?.length) boxes.push(chipsBox(r, play));
  if (!play) boxes.push(chainBox(r));
  boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'Dice fingerprint' }),
    h('p', { class: 'rc-line rc-hash', id: 'rc-fingerprint', text: r.fingerprint?.hash ?? 'none' }),
    r.fingerprint ? h('p', { class: 'rc-line rc-note', text: `Posted ${when(r.fingerprint.postedAt)}, by this server’s clock, before anyone saw a die.` }) : null,
    r.opened ? h('p', { class: 'rc-line' }, 'House secret, opened: ', h('span', { class: 'rc-hash', text: r.opened.houseSeed })) : null));
  boxes.push(anchorBox(r));
  boxes.push(checkSection(r, state));
  boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'What this does and doesn’t prove' }),
    play
      ? h('p', { class: 'rc-line', text: 'This was played for play chips: no money moved on chain, so there is no settle transaction. What the record gives you is the dice: sealed before the deal, opened after, and every shown cup recomputable.' })
      : h('p', { class: 'rc-line', text: 'The chain holds the money: the settle transaction moved these balances, and it can be found from the table and round number alone.' }),
    r.dice ? h('p', { class: 'rc-line', text: (r.reveals ?? []).length && (r.reveals ?? []).every((c) => c.proofHash || c.mode === 'silent') ? 'The dice were sealed on chain before the house opened its seed, and every answer was proven on chain. The money is still settled by the judge: compare it with the chain’s answer.' : 'The dice were sealed on chain before the house opened its seed. The checks above say which answers the chain checked, and which are only the house’s word. The money is still settled by the judge.' }) : null,
    h('p', { class: 'rc-line', text: `The dice are the server’s word. It vouches for every shut cup’s count, and it dealt the seeds. The seal stops it changing the house secret after the deal${r.anchor?.ok ? `, and the fingerprint itself was locked on Midnight in block ${r.anchor.block}, before the round was revealed: check the lines above.` : ', but the fingerprint itself is on this server, not on chain.'}` }),
    jsonLine(r, opts)));
  return boxes;
}

// A claim's fate as the table knows it. "standing" says nobody called it; with the deck open, the cards say whether it was true.
const CLAIM_FATE = { standing: 'nobody called it', proven: 'called, and the cards held it', caught: 'called: a bluff, out of the pot', withdrawn: 'withdrawn' };

/** Sealed Hand: the deal, the round, the hands once open, the chips, the chain, the deck seal, the checks, what it proves. */
function handBoxes(r, opts, state) {
  const play = r.kind === 'play';
  const boxes = [];
  const dealt = (r.seats ?? []).filter((x) => x.dealt);
  if (dealt.length) boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'The deal' }), h('p', { class: 'rc-line', id: 'rc-deal' }, `Dealt in: ${dealt.map((x) => `${x.name}${x.bot ? ' (a house bot)' : ''}`).join(', ')}. Ante ${r.ante}.`)));
  if (r.result) {
    const res = r.result;
    const paid = (res.awards ?? []).map((a) => `${a.name} takes ${a.amount}${a.label ? ` with ${a.label}` : ''}`).join(', ');
    const said = { settled: `${paid}.`, uncontested: `Everyone else folded. ${paid}.`, carried: `No claim stood. The pot of ${res.pot} carries to the next round.`, returned: `The table closed, and the pot of ${res.pot} went back${paid ? `: ${paid}` : ''}.`, void: res.why ?? 'The round did not finish.' };
    boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'The round' }),
      r.claims?.length
        ? h('table', { class: 'rc-table', id: 'rc-claims' }, h('tr', {}, ['Seat', 'Claim', 'What the table made of it'].map((x) => h('th', { text: x }))), r.claims.map((c) => row(c.name, c.label, CLAIM_FATE[c.status] ?? c.status)))
        : h('p', { class: 'rc-line', text: 'Nobody claimed a hand.' }),
      r.folded?.length ? h('p', { class: 'rc-line', id: 'rc-folded', text: `Folded: ${r.folded.map((x) => x.name).join(', ')}.` }) : null,
      h('p', { class: 'rc-line', id: 'rc-result' }, h('b', { text: 'The result: ' }), said[res.kind] ?? res.kind, res.pot !== undefined && res.kind !== 'carried' ? ` Pot ${res.pot}.` : '')));
  }
  if (r.opened && r.hands) {
    const names = (seat) => r.seats?.find((x) => x.seat === seat)?.name ?? `Seat ${seat}`;
    boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'The hands, as they stood' }),
      h('table', { class: 'rc-table', id: 'rc-hands' }, h('tr', {}, ['Seat', 'Cards at the end'].map((x) => h('th', { text: x }))),
        r.hands.map((hand, seat) => (hand ? row(names(seat), hand.join(' ')) : null))),
      r.moves?.passes?.length ? h('p', { class: 'rc-line rc-note', id: 'rc-passes', text: `${r.moves.passes.length} pass${r.moves.passes.length === 1 ? '' : 'es'}: ${r.moves.passes.map((list, i) => `${i + 1}: ${list.map((m) => `${names(m.from)} → ${names(m.to)} ${m.card}`).join(', ')}`).join('. ')}.` }) : null));
  }
  if (r.chips?.length) boxes.push(chipsBox(r, play));
  if (!play) boxes.push(chainBox(r));
  boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'Deck seal' }),
    h('p', { class: 'rc-line rc-hash', id: 'rc-seal', text: r.seal?.hash ?? 'none: this round is from before the deck was sealed' }),
    r.seal ? h('p', { class: 'rc-line rc-note', text: `Posted ${when(r.seal.postedAt)}, by this server’s clock, before any card was dealt or passed.` }) : null,
    r.opened ? h('p', { class: 'rc-line' }, 'Seed, opened: ', h('span', { class: 'rc-hash', text: r.opened.seed })) : null,
    r.opened ? h('p', { class: 'rc-line rc-note', id: 'rc-deck' }, 'Deck, opened: ', h('span', { class: 'rc-deck', text: r.opened.deck.join(' ') })) : null));
  boxes.push(anchorBox(r));
  boxes.push(checkSection(r, state));
  boxes.push(h('section', { class: 'rc-box' }, h('h2', { text: 'What this does and doesn’t prove' }),
    play
      ? h('p', { class: 'rc-line', text: 'This was played for play chips: no money moved on chain, so there is no settle transaction.' })
      : h('p', { class: 'rc-line', text: 'The chain holds the money: the settle transaction moved these balances, and it can be found from the table and round number alone.' }),
    r.seal
      ? h('p', { class: 'rc-line', text: `The cards were sealed before the deal and opened after it, so anyone can recheck them: the seal recomputes from the opened seed and deck, the deck is the seed’s shuffle, every hand follows from the deck and the passes, and every verdict follows from the hands. The house could not change a card once the seal was up. It is not a zero-knowledge proof: the hands are public once the round is over${r.anchor?.ok ? `. The seal was locked on Midnight in block ${r.anchor.block} before the round was revealed (the lines above check it), so not even this server could have swapped it afterwards` : ', and the seal is on this server, not on chain'}. The house still picked the seed: mixing each player's own seed in is the next step.` })
      : h('p', { class: 'rc-line', text: 'This round is from before the deck was sealed: the server shuffled and dealt, and nothing sealed the deck, so nobody else can recheck a hand. A claim’s fate is what the table showed. No card is in this record.' }),
    jsonLine(r, opts)));
  return boxes;
}

/**
 * The receipt's boxes for a record, either game. `state` is kept by the caller between redraws ({ checked }), so a receipt that grows
 * (a settle transaction landing) keeps its check results. `opts.jsonHref` is where the JSON is.
 */
export function receiptBoxes(r, opts, state = {}) {
  return r.game === 'sealed-hand' ? handBoxes(r, opts, state) : diceBoxes(r, opts, state);
}
