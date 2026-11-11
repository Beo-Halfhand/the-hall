// Measures the seal anchor on a preview Worker: N rounds, each its own chips table, dealt and waited on until the lock lands or
// fails. Prints one line per round and a summary (deal-to-anchored, success rate, the service's steps). Chips only: no money moves.
//   node scripts/anchor-measure.mjs https://sealed-hand-anchor-preview.halfhand.workers.dev 20 [lock|background] [sealed-hand|cup-and-claim|both]
// Refuses staging and live. Writes nothing; the per-write DUST and fee come from the service's own receipts (anchors.jsonl).

const [base, nArg = '20', mode = 'lock', which = 'both'] = process.argv.slice(2);
if (!base || /sealed-hand-staging|halfhand\.app|sealed-hand\.halfhand\.workers/.test(base)) throw new Error('usage: anchor-measure.mjs <preview url> [n] [mode] [game]: preview Workers only');
const N = Number(nArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, { body, token } = {}) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) { await sleep(6000); continue; } // the per-IP table limit
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  throw new Error(`${path}: rate limited`);
}

const rows = [];
for (let i = 0; i < N; i++) {
  const api = which === 'both' ? (i % 2 ? '/dice-tables' : '/tables') : which === 'cup-and-claim' ? '/dice-tables' : '/tables';
  const t0 = Date.now();
  const { body: t } = await call('POST', api, { body: { lobbySeconds: 120, anchor: mode } });
  const { body: seat } = await call('POST', `${api}/${t.id}/join`, { body: { name: `Measure ${i + 1}`, kind: 'human' } });
  const tDeal = Date.now();
  const dn = await call('POST', `${api}/${t.id}/deal-now`, { token: seat.token, body: {} });
  if (dn.status !== 200) { rows.push({ i, api, ok: false, why: `deal ${dn.status}` }); continue; }
  let st;
  for (;;) {
    st = (await call('GET', `${api}/${t.id}`)).body;
    if (['anchored', 'failed', 'timeout'].includes(st.anchor?.state)) break;
    if (Date.now() - tDeal > 150_000) break;
    await sleep(500);
  }
  const a = st.anchor ?? {};
  const row = { i: i + 1, game: api === '/tables' ? 'sealed-hand' : 'cup-and-claim', table: st.n, ok: a.state === 'anchored', state: a.state, block: a.block ?? null,
    dealToAnchoredS: a.landedAt && a.queuedAt ? (a.landedAt - a.queuedAt) / 1000 : null, pageS: (Date.now() - tDeal) / 1000,
    svc: a.ms ?? null, tx: a.txHash ?? null, error: a.error ?? null };
  rows.push(row);
  console.log(JSON.stringify(row));
  await call('POST', `${api}/${t.id}/leave`, { token: seat.token, body: {} }).catch(() => {});
  void t0;
}
const good = rows.filter((r) => r.ok);
const times = good.map((r) => r.dealToAnchoredS).sort((a, b) => a - b);
const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : null);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const step = (k) => avg(good.map((r) => r.svc?.[k]).filter((x) => Number.isFinite(x))) / 1000;
console.log(JSON.stringify({ summary: true, rounds: rows.length, anchored: good.length, successRate: rows.length ? good.length / rows.length : null,
  dealToAnchoredS: { min: times[0] ?? null, median: pct(0.5), p90: pct(0.9), max: times.at(-1) ?? null, mean: avg(times) },
  serviceStepsMeanS: { build: step('build'), balance: step('balance'), submit: step('submit'), land: step('land'), verify: step('verify'), total: step('total') },
  failures: rows.filter((r) => !r.ok).map((r) => ({ i: r.i, state: r.state, error: r.error })) }));
