// The collusion watch (11-08): every table, chips and tNIGHT, both games. Two seats working together never challenge each other
// while they challenge everyone else, or come from one place. Nothing in an HTTP API can stop two programs talking, so the Hall
// watches for what that looks like and says so on the table: a flag means "look at this table", never a verdict.
//
// What it counts, per seat and per other seat:
//   - a chance: the seat could challenge that seat with its move (Call liar on its bid; Call on its claim), from the game's own
//     legal moves at the time; and whether it did.
//   - where each seat came from: a salted hash of its network address (never the address), and at a tNIGHT table the wallet it
//     pays out to (one owner, two seats).
// A pair is flagged when its calls on each other are improbably few against how often each calls the rest (chance by luck
// under FLAG_P over at least FLAG_MIN chances: the bar the table simulator settled on, where honest pairs never crossed it), or
// when two seats share a network address or a payout. Households share an address: a flag is a look, not a block.

export const FLAG_P = 0.002;
export const FLAG_MIN = 12;

const w = (s) => (s.watch ??= { pairs: {}, origin: {}, flagged: [] });

/** The seats a move could challenge right now, from the game's legal moves: Cup & Claim's liar (one bidder), Sealed Hand's call. */
export function challengeTargets(legal) {
  const out = new Set();
  for (const a of legal ?? []) {
    if (a.action === 'liar' && Number.isInteger(a.seat)) out.add(a.seat);
    if (a.action === 'call' && Array.isArray(a.seats)) for (const x of a.seats) if (Number.isInteger(x)) out.add(x);
  }
  return [...out];
}

/** After a seat's move: one chance against each seat it could have challenged, and a call if it did. */
export function watchMove(s, seat, legalBefore, move) {
  const targets = challengeTargets(legalBefore);
  if (!targets.length) return;
  const pairs = w(s).pairs;
  for (const t of targets) {
    if (t === seat) continue;
    const p = (pairs[`${seat}>${t}`] ??= { chances: 0, calls: 0 });
    p.chances += 1;
    if ((move?.action === 'liar' && targets.length === 1) || (move?.action === 'call' && move.seat === t)) p.calls += 1;
  }
}

/** A seat's origin, when someone sits there. A new sitter starts that seat's counts afresh. */
export function watchOrigin(s, seat, { ipHash = null, payout = null } = {}) {
  const x = w(s);
  x.origin[seat] = { ipHash, payout };
  for (const k of Object.keys(x.pairs)) if (k.startsWith(`${seat}>`) || k.endsWith(`>${seat}`)) delete x.pairs[k];
  x.flagged = x.flagged.filter((f) => !f.seats.includes(seat));
}

/** P(X <= k) for X ~ Binomial(n, p). */
function binomCdf(k, n, p) {
  let term = (1 - p) ** n;
  let sum = term;
  for (let i = 1; i <= k; i += 1) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return Math.min(1, sum);
}

/** Every pair worth a look now, with plain reasons. `seated(i)`: whether seat i is someone (not empty, not the house). */
export function watchFlags(s, seated) {
  const x = s.watch;
  if (!x) return [];
  const seats = Object.keys(x.origin).map(Number).filter((i) => seated(i));
  const out = [];
  const pairOf = (i, j) => x.pairs[`${i}>${j}`] ?? { chances: 0, calls: 0 };
  for (let a = 0; a < seats.length; a += 1) {
    for (let b = a + 1; b < seats.length; b += 1) {
      const i = seats[a], j = seats[b];
      const why = [];
      const oi = x.origin[i], oj = x.origin[j];
      if (oi?.payout && oi.payout === oj?.payout) why.push('one payout wallet: one owner, two seats');
      else if (oi?.ipHash && oi.ipHash === oj?.ipHash) why.push('the same network address');
      const both = [pairOf(i, j), pairOf(j, i)];
      const chances = both[0].chances + both[1].chances;
      const calls = both[0].calls + both[1].calls;
      if (chances >= FLAG_MIN) {
        // how often each calls everyone else, smoothed so a seat that never calls anyone isn't evidence
        let oc = 0, ok = 0;
        for (const [k, p] of Object.entries(x.pairs)) {
          const [from, to] = k.split('>').map(Number);
          if ((from === i && to !== j) || (from === j && to !== i)) { oc += p.chances; ok += p.calls; }
        }
        const rate = (ok + 1) / (oc + 2);
        const p = binomCdf(calls, chances, rate);
        if (p < FLAG_P) why.push(`${calls} call${calls === 1 ? '' : 's'} on each other in ${chances} chances, against ${Math.round(rate * 100)}% on the rest (by luck: ${(p * 100).toFixed(p < 0.001 ? 3 : 2)}%)`);
      }
      if (why.length) out.push({ seats: [i, j], why: why.join('; ') });
    }
  }
  return out;
}

/** New flags since the last look, for the table's log, once each. */
export function newFlags(s, flags) {
  const x = w(s);
  const fresh = flags.filter((f) => !x.flagged.some((g) => g.seats[0] === f.seats[0] && g.seats[1] === f.seats[1] && g.why === f.why));
  for (const f of fresh) {
    x.flagged = x.flagged.filter((g) => !(g.seats[0] === f.seats[0] && g.seats[1] === f.seats[1]));
    x.flagged.push(f);
  }
  return fresh;
}

/** A salted hash of where a request came from: the same address gives the same hash at one table, and nothing else. */
export async function originHash(request, salt) {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return null; // a local or test server: no address to compare
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}`)));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const seatedHere = (s) => (i) => !!s.seats[i] && s.seats[i].kind !== 'house' && !s.seats[i].left;
/** After a move or a seat: log any new flag once, in plain words. */
export function watchCheck(s, addLog) {
  for (const f of newFlags(s, watchFlags(s, seatedHere(s)))) addLog(s, `The Hall's watch: ${f.seats.map((i) => s.seats[i].name).join(' and ')}: ${f.why}. Worth a look, not a verdict.`);
}
/** What anyone may see: the flags at this table now. No address, no hash, no payout. */
export const watchView = (s) => ({ flags: watchFlags(s, seatedHere(s)).map((f) => ({ seats: f.seats, names: f.seats.map((i) => s.seats[i].name), why: f.why })) });
