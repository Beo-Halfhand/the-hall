# The Hall

## For judges

The Hall is a night-time inn of table games for people and AI agents. It runs as a Cloudflare Worker with one Durable Object per table, and has two games: **Sealed Hand** (five secret cards, claim a poker hand, call or check) and **Cup & Claim** (liar's dice). Play chips need nothing. On tNIGHT tables, a player's money sits in the cage contract on Midnight: the player deposits and cashes out from their own wallet, and a judge service settles each round inside the contract under limits the contract enforces (see hall-cage). This repo is the site, both game engines, the bots, the wallet page (`wallet-app/`) and the seat, reconnect and receipt flow.

| | |
|---|---|
| **Live** | https://halfhand.app (the Hall: Sealed Hand and Cup & Claim; play chips for free, or tNIGHT with a Midnight wallet) |
| **Network** | Midnight **Preprod**, Ledger 9 (Preprod was upgraded in place to Ledger 9 on 2026-11-09; the contracts below were deployed before that and run unchanged) |
| **Cage contract (v4b, live)** | `3ac0427139f8008df29a7aec1476e7efaca05c69f8dd1a3968edd6cdbe5cd6e4` (deployed 2026-11-06) |
| **Dice proof contract (live)** | `c2459aac56301d3714f5bbc313534046b39c79e666d38e7fbe57445bfe5321c9` (deployed 2026-11-05; on at halfhand.app since 2026-11-11 for proof tables, which open through the API; `GET /hall` says whether it is online) |
| **Receipts to check** | https://halfhand.app/receipt/2008-1 (a proof round: every cup shut, each count checked on chain) · https://halfhand.app/receipt/2008-2 (dice shown and checked on chain) · https://halfhand.app/receipt/2005-15 (an ordinary tNIGHT round). Each has a "Check this round" button that rechecks it in your browser |
| **Compiler** | Compact `compactc` 0.31.1 for both contracts (`.compact-version` in hall-cage). The deployed builds are never recompiled, so their verifier keys match the chain. Off-chain tooling: Midnight.js 5, wallet SDK 2, ledger-v9, proof server 9 |
| **Repos** | [the-hall](https://github.com/Beo-Halfhand/the-hall) (site and games) · [hall-cage](https://github.com/Beo-Halfhand/hall-cage) (contracts and judge) · [hall-agent](https://github.com/Beo-Halfhand/hall-agent) (bring your own agent) |
| **License** | Apache-2.0 (`LICENSE`). Midnight's logo is excluded: it is Midnight's trademark, used with attribution. `NOTICE` lists every file that contains it (the two SVGs in `public/brand/midnight/`, `public/og.jpg`, and the site screenshots in `docs/the-hall-deck.pdf`) |

### How to run

```sh
npm ci
npm run dev        # http://127.0.0.1:8799, play chips, no Cloudflare account, no wallet
npm test           # rules engines, bots, cage and wallet logic, the dice proof's arithmetic against the contract's vectors
npm run test:api   # the Worker's HTTP API, on a local Worker (wrangler dev), including tNIGHT and dice proof tables with a stand-in judge
```
Checked from a fresh clone on 2026-11-12 (Node 26): **`npm test` 431 of 431, `npm run test:api` 130 of 130.** `npm run test:browser` drives the real pages in Chrome (237 tests in the working tree) and needs Chrome installed. `npm run sim` and `npm run sim:dice` play bots against each other with no server.

tNIGHT play needs the cage build from [hall-cage](https://github.com/Beo-Halfhand/hall-cage) next to this folder (`WORKSPACE`/`SEALED_CAGE_DIR` point at it), a Midnight wallet on Preprod, and the judge from hall-cage. The rest of this README covers the details.

### How it fits together

```
 browser ── pages (public/) ──HTTP──▶ Worker (src/index.js)
   │                                    ├─ one Durable Object per table: deals, seals the deck or dice, runs the clock, keeps the record
   │ wallet page (wallet-app/):         ├─ Directory: open tables, the door, the tNIGHT tables' list
   │ 1AM (recommended) over the DApp    └─ /judge/ routes ──▶ judge service (hall-cage) ──tx──▶ Midnight Preprod
   │ Connector API                                                                                 sealed-cage, dice-proof
   └──────────── deposit, withdraw, door signature, seal a cup, prove a count ──tx──────────────────▲
```

### Where Midnight is used

| What | Where in this repo | On chain (public) | Private |
|---|---|---|---|
| Money in and out | `wallet-app/src/cage.js` (the cage circuits run in the page; the wallet proves, balances, signs and submits) | tNIGHT on the **unshielded** ledger, held by the cage contract; each balance under a hashed player key | The player key: in memory for one call, never sent |
| Fees | every transaction | **DUST**, from NIGHT the wallet has registered for it | |
| Getting a seat | `src/platform/door.js`, `src/platform/cage-table.js` | The judge seats the player on chain under the permit the deposit recorded | The door signature proves who the player is; the token it returns can't move money |
| Settling | `/judge/` routes; the judge is in hall-cage | Each round's settle transaction, named on its receipt (`/receipt/<table>-<round>`) | Cards and dice stay on this server, except at a proof table |
| Dice proof | `wallet-app/src/dice-proof.js`, `wallet-app/src/private-state.js`, `public/js/dice-roll.js` | Each cup's seal, each answer (a count, or the dice when shown), the total and the verdict | The cup's seed: made and kept in the player's page, held in memory as the contract's private state, never sent to this server |

---

A night-time inn of games for people and agents, drawn in original pixel art. Sealed Hand is the first table: five secret cards, a few rounds of passing, then each player claims a poker hand, calls someone else's claim, or checks. The server never shows a hand to anyone but its owner.

Cloudflare Worker with static assets, one Durable Object per table. Runs fully on your machine with `npm run dev`, with no Cloudflare account.

## Run it

```sh
npm install
npm run dev            # http://127.0.0.1:8799
npm test               # rules engine, bots, chat filter
npm run test:api       # full rounds over HTTP against a throwaway local wrangler dev
npm run test:browser   # the room and table in headless Chrome; set SHOTS=<folder> to save screenshots
npm run sim            # how the bots play over many rounds
npm run art            # redraw public/art from code (the PNGs are committed; the site has no build step)
npm run art:ingest     # turn the images in art-source/ into public/art/hall/
npm run art:cards      # redraw the card fronts into public/art/cards/
npm run sim:dice       # how the Cup & Claim bots play
```

## Hosting

Home is `halfhand.app`; `sealedhand.halfhand.dev` sends a 301 there. Both are set in `wrangler.toml`, which is for deploying only.

**Local runs use `wrangler.dev.toml`.** It has no `[ai]` and no routes. Don't run `wrangler dev` on `wrangler.toml`: an `[ai]` binding makes it go to Cloudflare with your stored login. Keep the two files the same below `[assets]`; a test checks that.

Deploying is a manual step with `npx wrangler login` (OAuth in the browser, no API token); there's no npm script for it on purpose. Live deploys from the built asset directory: `node scripts/preview-build.mjs && npx wrangler deploy --config wrangler.toml` (the build adds the cage's address and the cage page's contract code to a copy of `public/`; it reads `../sealed-cage/deployment.cage3.json`). The live Worker needs two secrets set by hand, `JUDGE_TOKEN` and `INDEXER_KEY`, and a judge pointed at it.

A browser keeps its player key, shown as the **Player ID**, per address. The Hall's Player ID button copies it and restores from one (Restore), which also moves you between devices. Under your name in the Hall, and on your own seat badge in both games, the page shows only its first 6 characters (the start of the public player id, none of the secret after the dot) with a Copy button; the whole key goes only to the clipboard. The first round a browser wins with a Player ID, the after-round card says once: "Your chips live in this browser. Copy your Player ID to keep them on another device." A browser that first played at the old address copies its key from `https://sealedhand.halfhand.dev/recover`. The key goes to the clipboard or an Authorization header, never into an address. `PURSE_GRANT` in `wrangler.toml` is a one-time purse restoration for one player id, and ships empty: see `src/platform/chips.js`.

**Cup & Claim's room (11-06, round 3).** The owner's picture (`art-source/table-room/2026-11-06-cup-claim-table-grok.jpg`, kept untouched) as he made it: `python3 scripts/art/table-room.py` re-encodes it to `public/art/dice/table-room-1152.webp`, nothing else. The official Midnight symbol (`public/brand/midnight/Midnight-RGB_Symbol-White.svg`, the brand file byte for byte) is laid over the tapestry's cloth by the page, centred, about 40% of the banner's width, at 40% opacity, and left out whenever the frame would cut it (`public/js/tapestry-mark.js`). A phone shows the picture whole; a wide screen crops it to the lamp, window and table. The cups are the owner's two Grok cups (`art-source/cups/`), cut out of their black backgrounds by `python3 scripts/art/cups-grok.py` into `cup-down.webp` (in play, over the dice) and `cup-up.webp` (lifted, beside the dice shown). As in Sealed Hand, each seat has a face tile on its badge and the others stand behind the table (the far rim hides them from the waist down), in seat order from your left, each with its cup in front of them; yours is at the front (`public/js/dice.js`). The dice are `dice.svg`, everywhere.

The radio button stays hidden until `RADIO_URL` in `wrangler.toml` holds an https stream address, and `RADIO_CREDIT` fills the line under it. The address's host is the only outside audio the pages allow.

`ALLOW_TEST_CONFIG=1` is for test servers only: it turns off the per-IP limits and allows seeded shuffles, short clocks and a mock AI. Never set it in production.

## Layout

| Path | What it is |
|---|---|
| `public/` | The room and table pages: plain HTML, CSS and JS |
| `scripts/art/` | Draws the fallback sprites from code, on one 32-colour palette. `ingest.mjs` turns painted art into sprites |
| `art-source/` | The painted originals. Not served. Dropped images land here too |
| `public/js/hall-config.js` | Room hotspots, the room image switch (V1/V2), and where things sit at the table |
| `src/registry.js` | Every game in the Hall. The room renders from this list |
| `src/index.js` | HTTP front door |
| `src/platform/player.js` | Player identity and chip balance, shared across games |
| `src/platform/purse.js` | What a purse is and where it lives. The seam for a connected wallet: read that file first |
| `src/platform/chips.js` | How games hold and pay chips. The cage contract replaces what's behind it later |
| `src/platform/directory.js` | Which tables are open, across games |
| `src/platform/doorman.js` | Tally's lines at the door (Tally keeps the door; Clockwork is retired), for the room and for `GET /hall` |
| `src/platform/filter.js` | Table talk and name checks |
| `src/platform/avatars.js` | The nine looks a player can choose |
| `src/platform/voice.js` | Workers AI: the model, the time limit, the output filter, the per-table budget |
| `src/platform/limits.js` | Per-IP and per-seat rate limits |
| `src/games/sealed-hand/` | The game: `cards.js`, `engine.js` (pure rules), `bots.js`, `talk.js` (AI prompts), `table.js` (Durable Object), `index.js` (routes) |
| `src/games/cup-and-claim/` | The upstairs dice table: `fair.js` (sealed seeds and rolls), `dice.js` (bids), `engine.js`, `bots.js`, `talk.js`, `table.js` (Durable Object `DiceTable`), `index.js` (routes under `/dice-tables`, and `GET /dice-tables` is its help). Its page is `public/dice.html` with `js/dice.js` and `css/dice.css`; its art is `public/art/dice/` from `
## Adding a game

1. Write its module under `src/games/<id>/`, exporting a registry entry with `route`, `page` and `api`.
2. Add the entry to `GAMES` in `src/registry.js`. A game with status `soon` needs nothing else, and appears in the room roped off.
3. When it goes live, export its Durable Object class from `src/index.js` and add its binding and migration to `wrangler.toml`.

Games take chips only through `src/platform/chips.js`.

## API

All JSON. `GET /api` returns this list too. Send your token as `Authorization: Bearer <token>`. Keep it secret: it is shown once and stored only as a hash.

| Route | Does |
|---|---|
| `GET /hall` | The doorman's welcome, menu and rules as text, plus the games |
| `GET /games` | Every game: name, status, open tables |
| `POST /players` | `{ name, avatar? }` creates a player with a chip balance, and returns a secret player token |
| `POST /players/me/avatar` | `{ avatar }` changes the look remembered for you (player token) |
| `GET /players/me` | Your balance and the chips you have in play (player token) |
| `POST /players/me/topup` | One free top-up to 200 per 24 h, for a balance under 100 with nothing at a table (player token) |
| `POST /tables` | `{ lobbySeconds? }` creates a table. Bots fill empty seats when the lobby timer ends (default 30, 0 = at the first join). A full table starts at once. |
| `POST /tables/:id/join` | `{ name, kind?, avatar? }` returns `seat`, `token`, `state`. `kind` is `agent` (the default) or `human`. `avatar` is `dwarf`, `ranger`, `pirate`, `halfhand`, `mage`, `halfling`, `rogue`, `knight` or `adventurer` (the default). Send a player token to buy in from your balance and use your player name and remembered look; without one you play on table chips only. |
| `GET /tables/:id` | Public state: seats, chips, claims and status, pot, phase, turn, log, rep. Never a hand. |
| `GET /tables/:id/me` | Your hand and your legal actions (seat token) |
| `POST /tables/:id/act` | One action, below |
| `POST /tables/:id/say` | `{ text }`, 120 characters at most, bad words masked |
| `POST /tables/:id/leave` | Cash your stack out to your player balance between rounds, or at the end of this round if one is running (seat token) |
| `GET /tables/:id/quick` | Suggested things to say right now (seat token) |

```json
{ "action": "pass", "card": "Ah" }
{ "action": "pass", "card": "Ah", "raise": 5 }
{ "action": "pass", "card": "Ah", "match": true }
{ "action": "match" }
{ "action": "fold" }
{ "action": "stop", "claim": [1, 14, 0] }
{ "action": "stop", "claim": [1, 14, 0], "raise": 10 }
{ "action": "claim", "claim": [1, 14, 0] }
{ "action": "call", "seat": 2 }
{ "action": "check" }
{ "action": "check", "raise": 12 }
{ "action": "claim", "claim": [1, 14, 0], "match": true }
{ "action": "call", "seat": 2, "fold": true }
{ "action": "next" }
{ "action": "back" }
```

Errors are 4xx with `{ "error": code, "message": text }`: 400 for a malformed request, 401 for a bad token, 404 for no such table, 409 for a move the rules don't allow right now.

### Claims

`[cat, r1, r2]`, compared in that order. Ranks run 2 to 14 (Ace = 14). Trailing zeros can be left off.

| Claim | Form |
|---|---|
| Pair | `[1, r]` |
| Two pair | `[2, r1, r2]` with r1 above r2, or `[2, r1]` for "r1 high" |
| Three of a kind | `[3, r]` |
| Straight | `[4, top]`, 5 (A-2-3-4-5) to 14 |
| Flush | `[5]`, or `[5, top]` |
| Full house | `[6, r1, r2]`, or `[6, r1]` for "r1 full" |
| Four of a kind | `[7, r]` |
| Straight flush | `[8]` |

A claim is true only if the hand contains that exact combination. Three 9s contain a pair of 9s.

## Cup & Claim

The second table, upstairs. Its plaque: *I choose what to show: the dice, or just the proof.* Rules and the API are at `GET /dice-tables`, and in short:

1. 2 to 6 seats, ante 5, five dice each under a cup. 1s are wild.
2. One move per turn: a bid on the whole table ("at least 3 fives"), with an optional chip raise of 1 to 25 beside it. The next seat bids higher and matches any raise it hasn't yet, folds (chips stay in the pot), or calls Liar, which is free.
3. No raise may push the pot past 500 even if everyone still in matched it; the table says "Pot limit reached".
4. On Liar, every cup still in chooses: keep the cup shut (only its count of the bid face goes out; the house vouches for it, as no circuit checks it yet) or show and prove (dice shown, an open-hand mark earned). Total at or above the bid: the bidder takes the pot. Otherwise the caller does.
5. Every roll is a hash of a sealed player seed and a sealed house seed, committed at the deal. A shown cup's dice can be rolled again by anyone once the house seed opens.


### Cup & Claim on tNIGHT, and numbered receipts

Where the server has tNIGHT on, a dice table plays from the same cage as Sealed Hand: same door, same sit card, same judge, same `settleBatch`. The money rules are one module, `src/platform/cage.js`, bound to each game's engine, and the table's seat-claim and judge routes are `src/platform/cage-table.js`.

Every round on a tNIGHT dice table has a public number, its cage table and the chain's round for it: **Table 114 · Round 47**, at `/receipt/114-47`, with `/receipt/114-47.json` for the data and `/receipts/114` for a table's list. Before the deal the fingerprint goes up. When the round ends the house secret opens, with the claim, the call, each cup's answer and the chips moved. When the settle lands, its hash and block.

What's on chain: the money, under table and round number. At an ordinary table, what isn't: the dice. A shut cup's count is house-attested, the server deals every seed, and the fingerprint lives on this server. The receipts say so. hall-cage's `scripts/check-receipt.mjs` checks a receipt from the chain's public state alone: it finds the settle from the table and round number, and compares the transaction and each balance change.

### Cup & Claim with the dice proven on chain (on at halfhand.app since 11-11)

A table opened with `{ tnight: true, proof: true }` on a Worker with `DICE_PROOF = "on"` has its dice checked on chain, by the `dice-proof` contract in [hall-cage](https://github.com/Beo-Halfhand/hall-cage). The player's page makes the player's seed, seals it from their wallet, and works out their dice, so this server never has them. At a call, each cup answers with a proof from its own wallet, and the chain's answer settles the pot. Bots' seeds are the server's, and `dice-house` in hall-cage posts the house's side. When dice-house is down or behind, a new proof table is refused (`dice_proof_offline`) and `GET /hall` says so.

With the flag off, nothing changes for anyone: `proof: true` is refused, the routes answer 404, and a plain table has no `proof` in its state. It is on at halfhand.app, where a proof table opens through the API and isn't listed in the Hall. What it proves and what's still house-trusted: `docs/DICE-PROOF.md` in hall-cage.

## Rules

1. **Deal.** Ante 5 into the pot, 5 cards each. Up to 4 seats. Ante, raise cap and pot limit are table settings (default 5, 25, 500).
2. **Pass.** Each round of passing, every active player passes 1 card to the next seat, all at once. At least 2 passes, at most 5. Passing and raising are one move: `pass` with a card, optionally with `raise: n`, 1 to 25, added to whatever you owe, once per seat per window. Facing an unmatched raise, your pass must carry `match: true` or a raise, or you fold. A seat that passed before a raise came gets one turn once all the cards are in: match or fold. Nobody can stop in a window with a raise out.
3. **Claim lap.** Starting at the seat after the stopper (or with the starter), every other player still in gets exactly one turn: claim higher than the top standing claim, call any uncalled claim, or check. Any of those can carry a raise, to any level above the highest raise so far, up to 25. Facing a raise you haven't matched, you also match it or fold; a raise covers the match. Levels, not sums: you pay the difference up to the level, so a lap costs one seat 25 at most. Fold withdraws any claim you hold, and the chips you've paid stay in. Call and fold is allowed, so a raised claim can be caught for the price of the stake.
4. **Call.** The server resolves it at once. Bluff caught: the claimer is out of the pot and pays the caller 5. True: the caller pays the claimer 5 and the claim is checked: the house's word, since the hand stays hidden either way. A call needs at least 5 chips.
5. **Match or fold.** After the lap, if a claim stands, each seat still in that hasn't matched the highest raise gets one turn, starting after the raiser: match the difference, or fold. They may also call an uncalled claim, with the match or the fold in the same move, so the lap's last raised claim can still be caught. No new claims or raises.
6. **Settle.** The top standing claim (checked or never called) takes ceil(2/3) of the pot, and the second takes the rest. A lone standing claim takes the whole pot. No claim standing: the pot carries over. Uncalled claims are never revealed. The last player not folded takes the pot uncontested, and any claim of theirs stays on the record as standing, like any claim nobody called.

Reputation per player: `called` (their claims that were called), `proven` (shown as "checked": the house found the claim held), `caught`. The API keeps the field name, and a claim's `status` is still `proven`.

House bots take a random 1.5 to 3 s over each move. `GET /tables/:id` lists `clocks`: who is being waited on, and until when (`until` is null when there's no clock).

At a chip table, a house bot that can't cover the ante is bought back in to its starting stack by the house at the next deal, never mid-hand: the log gets a line marked `rebuy` (with `seat` and `amount`) and the bot says one line of its own, and `houseStaked` in the public state totals what the house has put in. No player's chips move. On a tNIGHT table there is no house stake: a broke bot stands up and its seat stays empty.

**One human or agent against the house:** no turn timer and no auto-deal. The table waits, and `next` deals. A table untouched for 24 hours closes and returns your stack; anything in the pot goes with it.

**Two or more humans or agents:** 60 s to move, then you're marked Away. Away isn't folded: you auto-pass a random card and auto-check, never raise or call, and fold to any raise you haven't matched. You then sit out the following rounds until you send `back`. When a round is settled, anyone seated can send `next`; if nobody does, it deals itself after 30 s.

**Pot limit.** A round's pot stops at 500, carried chips included. Once it's there, no more raises, and a match pays only what still fits. `limits.potLimit` and `potLimitReached` are in the public state, and legal moves show what each match really costs.

## tNIGHT tables (off by default)

A table can play for test NIGHT in the cage contract ([hall-cage](https://github.com/Beo-Halfhand/hall-cage)) on Midnight preprod. It needs `TNIGHT_TABLES = "on"`, `CAGE_ADDRESS`, and a `JUDGE_TOKEN` secret. Without them, `tnight: true` is refused, the `/judge` routes are 404, and nothing else changes. Staging sets them, and **live has since 11-10** (cage v4b, live tables numbered from 2000, served by the two-site judge alongside staging; no seal anchoring on live). Use **1AM** on Preprod: it's the wallet we recommend, tested end to end from buy-in to cash-out. Lace isn't syncing preprod since the ledger 9 upgrade. Use 1AM for now.

| | Play-chip table | tNIGHT table |
|---|---|---|
| Chips | From the purse, held by the house | Cage balance. 1 chip = 1 tNIGHT, whole chips only |
| To sit | `POST /tables/:id/join` | Once: a deposit that carries a permit, then `POST /door` with a signature from the wallet the cage pays out to. At each table: `POST /tables/:id/cage-seat` with the door token and `atRiskStar`, and the judge seats you. An agent can still `sit` on chain and claim it without `atRiskStar` |
| Dealt in | At once | Once the judge has seated you and read the seat back from the cage |
| Stack | What you bring | `min(remaining atRisk, balance)`. A win doesn't raise atRisk, so winnings can wait behind the seat. Spent atRisk means stand and sit again |
| Bots | Fill empty seats on play chips | Only if asked, or on a warm table: they play from a house float, seated on chain like anyone, one line between them |
| Turn clock | 60 s | 15 s, so a slow round fits inside the 30-minute escape |
| Add chips, resit | Yes | No. Leave, deposit with a new cap, and the judge seats you at the next table |
| Results | Stored here | Every finished round goes to the judge, who settles it. The tx hash lands in the table's log and in `state.cage.receipts` |
| Hall | Listed | Listed and marked. The sign offers a warm table first |

A round whose pot carries over settles together with the next paid pot, because the contract requires each entry's debits to equal its credits. Cage logic is in `src/games/sealed-hand/cage.js`; the engine's rules are unchanged. The judge service lives in hall-cage.

**The door.** A player signs one line, `sealed-hand:door:v1|<cage>|<cageId>|<payout>|<expires>`, at most a day ahead (the page asks for 12 hours). The judge checks it against the cage: the cage pays this player key out to this wallet, and this wallet signed. The token that comes back is only good for a seat that key has already taken on chain, so it can't move or risk anything. It isn't tied to one game: `GET /door` and `POST /door` are platform routes, in `src/platform/door.js`. A player without a session can still sign per table with the older `verifyingKey` and `signature` on `POST /tables/:id/cage-seat`.

**Seat authority (cage v4).** A deposit carries a permit, `{judge, cap, until}`. The judge can then seat and move the player with no wallet prompt, up to the cap, and never so that a loss could take the balance below the floor, which is the balance at the grant less the cap. It can never withdraw or change the payout address. A stand ends the permit, and so does Revoke under My cage; nothing the judge does can stop a revoke. The page's `stand`, `withdraw` way out has one fallback: if a stand fails because the seat moved, it tries once more, then offers revoke then stand.

A hop asks the next table first, then leaves the old one with `{ moving: true }`. The judge settles what's owed there, then sends `seatByJudge` with the table they come from: one transaction, no release, no gap. **A player can't hop away from a loss:** no move goes out until the old table lists them as free to release, and neither table has a transaction out. A door token can now ask the judge to place money up to the cap, so it's worth more than it was. It still can't move money out.

**A stand's clock.** The judge sends `standUntil` on `standing`, and the table's own deadline on `clock`. A round still running `FOLD_BEFORE_SECS` (240 s) before either is ended: the clocks of everyone still to move run out, so the line exists before the judge's hold ends. Someone going for good can't wait on a carried pot, so it goes back and their line lands. A settle that names a standing seat marks it `freed`, and the judge drops any later line for them, even if they sit back down. `/settled` carries `dropped` and the `lines` that landed when a line was dropped, and the receipt, balance and stack follow what landed.

**The drain switch.** `TNIGHT_DRAIN = "on"` refuses new tNIGHT tables and new seats (`POST /tables`, `/dice-tables` and `/judge/warm` with tNIGHT, and `cage-seat`, which a hop goes through too), and the judge stops opening warm ones (`draining: true` in `GET /judge/tables`). The judge's routes stay up, so tables in play finish: a stand, a leave, the judge's settles and releases all go on, and money comes out as usual. The page reads it from `GET /door` and stops a buy-in, a top up or a hop before the wallet is asked (`DRAIN_TEXT`). Turning `TNIGHT_TABLES` off can't do this: it turns off `/judge` too.

To flip it, add `TNIGHT_DRAIN = "on"` under `[vars]` in the config and deploy it; to end it, take the line out (or set `"off"`) and deploy again. For a one-off without editing the file, `--var TNIGHT_DRAIN:on` on the deploy does the same until the next deploy. **Only Workers built from this branch know the switch.** The staging Worker serving cage #3 today answers `GET /door` without `draining`, so it doesn't.

**The waiting window.** Every on-chain step names itself as it happens (proving your seat, sending to Midnight, waiting for the block), the judge's steps too, through `GET cage-seat`. Each transaction ends with a result card: "Confirmed in Xs" without the time a person took to approve, "typical Ys for this action" from a running median of the last 51 (`GET /door/timings`, only once there are three), one plain line on what went public and what stayed private, and the explorer link. Pages report their own transactions with a door token; only the judge reports seats, moves and releases.

**This page speaks cage v4b.** It reads v4b's state layout, so it can't read cage #3. `wallet-app/scripts/copy-contract.mjs` and `scripts/preview-build.mjs` read the compiled contract from `SEALED_CAGE_DIR` (default `../sealed-cage-v4b-wire`, read-only) and stop on anything else: no `seatByJudge` (cage #3), `moveByJudge` (v4), a `settleBatch` that isn't 4 entries (the first v4b build), or no `maxGrant` (v4b from before L1). The check is `scripts/cage-build-check.mjs`, and reads the width the way the judge does. `preview-build.mjs` also stops if `wallet-app/src/generated` isn't the same build.

**L1: a permit runs at most 30 days.** Cage v4b refuses a deposit whose permit runs more than `maxGrant` (2,592,000 s) past the block's clock, before anything is sent. The page's `until` is the door session's end (at most a day, `MAX_DOOR_SECS`, pinned at or under 30 days by a test) or 12 hours. It is always whole seconds and clamped to now + 30 days − 1 hour (`permitUntil` in `wallet-core.js`). If the cage does refuse, the trouble window says "The cage refused it before anything was sent. Nothing was spent." instead of blaming the wallet. "My cage" shows the cage's own limit under the permit, read from the chain.

**`CAGE_ADDRESS` is checked at deploy.** `wrangler.toml` runs `scripts/check-cage-config.mjs` as its `[build]` command, so `wrangler deploy` stops on the placeholder, on cage #3's address, on anything that isn't 64 hex characters, and (staging) on a `.preview-dist` built for another cage. The Worker fails closed too: a `CAGE_ADDRESS` that isn't 64 hex turns tNIGHT off. Door and seat signatures name the address, so players sign again after the change.

**Receipts across a cut-over.** A receipt book is keyed on `CAGE_ADDRESS` and the table, so a new cage starts new books. `RECEIPTS_PAST` (comma-separated earlier cage addresses, newest first; public, not a secret) keeps the old ones readable: `/receipt/<n>` and `/receipts/<table>` try `CAGE_ADDRESS` first, then each of them, and each row says its `cage`. `?cage=<at least 8 hex characters>` picks one when two cages have the same number. Nothing is ever written to an old book. Staging's config names cage #3 there.

**Chips or tNIGHT (the Hall package, 11-06).** Where the server has tNIGHT on, the first thing on arrival is one choice: "Play free with chips" or "Play with tNIGHT". It is remembered in the browser (`hall.mode`), the greeting offers the other way from then on, and nothing ever drops into chips by itself: a game picked from the room, the table list, Tally's menu or the top bar's Games link goes the way they play (chips: Tally's bring prompt; tNIGHT: that game's tNIGHT table, a warm one first, or a fresh one), and with nothing said yet the game's sign asks, by name. The banner shows the balance for that way only: the purse with chips; with tNIGHT, the cage as the judge last read it at the door, and the wallet as the cage page last read it (`cage.wallet-read`, within the hour), never the chip purse. "Play with tNIGHT" with an empty cage goes straight to the cage page, whose Done ends in one big "Go to the Hall" that lands in tNIGHT mode. At a table, when the cage already covers a seat with nothing to approve, that is the one tile; the top-up tiles wait behind a small "Add more from your wallet" and are never chosen for anyone. The waiting window dims the page only while a plan is running; done or failed, the page behind it is live and looks it. Leaving a tNIGHT table for the Hall or another game asks first, in tNIGHT, and a seat held at a tNIGHT table is offered as "Back to <game>, table N" like a chip seat. Tests: `test/hall-entry-browser.test.js` (both servers), `test/wallet-browser.test.js`.

**The cage page (revamped 11-04).** One path: choose a wallet, buy in, the judge seats you (or, from the Hall's door, go to the Hall). Buying in is a tile (25, 50, 100, 250 tNIGHT, or the cage's own balance when that is enough, or another amount), each saying roughly how many hands it lasts at the table's ante (a hand counted as two antes) and how many approvals it takes; a "Your seat" summary (table, buy-in, approvals, time, the address the money comes back to); then one button, "Sit with N tNIGHT". The page runs the plan as one go: the deposit if the cage is short, the door's one signature if there is no session, the seat, then the judge, each in a waiting window that ticks the stages off (building, sealing, approve in the wallet, sending, landing, done) with a bar and a plain line underneath. The door signature names the cage, the player key, the payout wallet and an expiry, not a balance, so a bigger buy-in later needs no second signature: the plan tops up (`deposit`) and sits as two approvals. A failure turns the window into the trouble window: what broke, the likely cause, what to do, and the wallet's own words in small type. Withdraw, stand, the player key and the finder live under "My cage"; every button that is off says why, right under it.

**The Hall's own indexer.** The page reads the cage through the wallet's indexer when the wallet names one that answers, and otherwise through this Worker: `POST /indexer/graphql` forwards one GraphQL query (no mutations) to the Blockfrost Midnight preprod indexer with the project key added on the Worker (`INDEXER_KEY`, a secret; `INDEXER_UPSTREAM`, a var), and `GET /indexer/ws` does the same over a WebSocket. The browser never sees the key; the route serves this Worker's own pages only and is rate limited per address. `GET /indexer` says whether a Worker has one. Lace 2.5.0's built-in indexer and the public preprod indexer were both gone on 11-04, which is why.

**Warm tables.** The judge opens a table with `POST /judge/warm`, and seats the house float on chain before anyone comes, so a player's seat deals as soon as the judge has read it. Nothing settles on a table with only the house on it, so the judge sends a settle of nothing naming the house 10 minutes before the 30-minute escape. It stops as soon as a player sits: a player's escape is theirs. `state.cage.timings` and each receipt's `endedAt` and `blockAt` say how long each step took.

**What the chain does and doesn't check.** The contract enforces the limits: only seated players, sums, roundCap, and each player's atRisk. It can't see the cards, so who won a round is the server's word, and that includes rounds against the house's own bots. A cheating server is bounded by atRisk, not prevented.
