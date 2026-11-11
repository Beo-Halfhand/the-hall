// The AnchorQueue Durable Object (platform/anchor.js has the rest, pure, so plain Node can test it).
// One queue for the Worker: items live in storage until a final result has been forwarded to their table.

import { DurableObject } from 'cloudflare:workers';
import { fail, json } from './http.js';
import { SERVICE_STALE_MS } from './anchor.js';

const REOFFER_MS = 6 * 60_000; // a handed-out item with no word back for this long is offered again (the service checks the vault first)
const ITEM_MAX_MS = 30 * 60_000;

export class AnchorQueue extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiters = [];
  }

  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    const now = Date.now();
    if (pathname === '/status') {
      const polledAt = (await this.ctx.storage.get('polledAt')) ?? null;
      const items = await this.ctx.storage.list({ prefix: 'i:' });
      return json({ polledAt, online: polledAt !== null && now - polledAt < SERVICE_STALE_MS, queued: [...items.values()].filter((x) => !x.handedAt).length });
    }
    if (pathname === '/enqueue') {
      const item = await request.json();
      const polledAt = (await this.ctx.storage.get('polledAt')) ?? null;
      const online = polledAt !== null && now - polledAt < SERVICE_STALE_MS;
      if (!online) return json({ ok: false, online: false, why: 'the anchor service is offline' });
      await this.ctx.storage.put(`i:${item.id}`, { ...item, queuedAt: now, handedAt: null });
      for (const w of this.waiters.splice(0)) w();
      return json({ ok: true, online: true });
    }
    if (pathname === '/queue') {
      await this.ctx.storage.put('polledAt', now);
      const wait = Math.min(25, Math.max(0, Number(searchParams.get('wait')) || 0)) * 1000;
      let items = await this.offer(now);
      if (!items.length && wait > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, wait);
          this.waiters.push(() => { clearTimeout(t); resolve(); });
        });
        await this.ctx.storage.put('polledAt', Date.now());
        items = await this.offer(Date.now());
      }
      return json({ items });
    }
    if (pathname === '/result') {
      await this.ctx.storage.put('polledAt', now); // a service busy anchoring is not offline: its word on a round is a sign of life too (measured 11-08)
      const r = await request.json();
      const key = `i:${r.id}`;
      const item = await this.ctx.storage.get(key);
      if (!item) return json({ ok: true, unknown: true });
      if (r.seal !== item.seal) return fail(400, 'bad_result', 'That result is for another seal.');
      const final = !['started', 'progress'].includes(r.outcome);
      const body = JSON.stringify({ ...r, round: item.round, recordId: item.recordId });
      const ns = item.game === 'cup-and-claim' ? this.env.DICE_TABLE : this.env.TABLE;
      try {
        await ns.get(ns.idFromString(item.tableId)).fetch(new Request('https://table/anchor-result', { method: 'POST', body }));
      } catch (err) {
        console.error('anchor result to table will retry on the next result:', err?.message);
        return fail(502, 'table_unreachable', 'The table did not take the result.');
      }
      if (final) await this.ctx.storage.delete(key);
      else await this.ctx.storage.put(key, { ...item, progressAt: Date.now() });
      return json({ ok: true });
    }
    return fail(404, 'not_found', 'No such route.');
  }

  /** Items nobody has, or that were handed out long ago with no word back. Old ones are dropped. */
  async offer(now) {
    const out = [];
    for (const [key, item] of await this.ctx.storage.list({ prefix: 'i:' })) {
      if (now - item.queuedAt > ITEM_MAX_MS) { await this.ctx.storage.delete(key); continue; }
      const last = item.progressAt ?? item.handedAt;
      if (item.handedAt && now - last < REOFFER_MS) continue;
      await this.ctx.storage.put(key, { ...item, handedAt: now });
      out.push({ id: item.id, recordId: item.recordId, seal: item.seal, game: item.game, round: item.round });
    }
    return out;
  }
}
