// A stand-in for the Mini's seal-anchor service, for tests and local runs: it long-polls the Worker's /anchor/queue with the
// test token and answers each seal as the real one does (started, proving, sent, then a result), without any chain.
//   const svc = fakeAnchor({ base, token, delayMs: 3000, outcome: 'anchored' })   ... svc.stop()
// outcome 'anchored' gives a made-up tx and block; 'failed' a failure; 'silent' takes the item and never answers.
// A real anchor's hash is checked by the receipt against the chain, so a page that checks one of these marks it ✗ or a note.

import { createHash } from 'node:crypto';

export function fakeAnchor({ base, token, delayMs = 2000, outcome = 'anchored', blockStart = 900000 } = {}) {
  let stopped = false;
  let block = blockStart;
  const seen = [];
  const auth = { authorization: `Bearer ${token}` };
  const post = (body) => fetch(`${base}/anchor/result`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loop = (async () => {
    while (!stopped) {
      let items = [];
      try {
        const res = await fetch(`${base}/anchor/queue?wait=2`, { headers: auth });
        if (res.ok) items = (await res.json()).items ?? [];
      } catch {
        await sleep(300);
        continue;
      }
      for (const item of items) {
        seen.push({ ...item, takenAt: Date.now() });
        const base0 = { id: item.id, recordId: item.recordId, seal: item.seal };
        await post({ ...base0, outcome: 'started', step: 'taken' });
        if (outcome === 'silent') continue;
        await post({ ...base0, outcome: 'progress', step: 'proving' });
        await sleep(delayMs / 2);
        await post({ ...base0, outcome: 'progress', step: 'sent' });
        await sleep(delayMs / 2);
        block += 1;
        const txHash = createHash('sha256').update(`fake-tx|${item.seal}`).digest('hex');
        await post(outcome === 'anchored'
          ? { ...base0, ok: true, outcome: 'anchored', txHash, ledgerId: `00${txHash.slice(0, 62)}`, block, blockAt: Date.now(), vault: 'f'.repeat(64), attesterId: 'e'.repeat(64), recordKey: 'd'.repeat(64), metadataHash: 'c'.repeat(64), ms: { total: delayMs }, feeRaw: '300000000000000' }
          : { ...base0, ok: false, outcome: 'failed', error: 'test: the fake service was told to fail' });
      }
    }
  })();
  return { seen, stop: async () => { stopped = true; await loop.catch(() => {}); } };
}
