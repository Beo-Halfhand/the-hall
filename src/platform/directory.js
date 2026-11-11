// One Durable Object for the whole Hall: which tables are open, across every game. Tables report in;
// GET /games reads it. It holds nothing secret and nothing a table can't rebuild by reporting again.

import { addSample, goodTiming, medianOf } from './timings.js';
import { DurableObject } from 'cloudflare:workers';
import { json } from './http.js';
import { boardAdd, boardList } from './board.js';
import { noteOpened, pickTable, tableBinding } from './lobby-pick.js';
import { agentStore } from './agent-settings.js';
import { listClosures, logClosure } from './closures.js';

const STALE_MS = 2 * 60 * 60_000;
const MAX_LISTED = 25;

export class Directory extends DurableObject {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/update') return this.update(await request.json());
    if (pathname === '/list') return this.list();
    if (pathname === '/closures') return this.closures(await request.json());
    if (pathname === '/lobby/open') return this.lobbyOpen(await request.json());
    if (pathname === '/board/add') return boardAdd(this.ctx.storage, await request.json());
    if (pathname === '/board/list') return boardList(this.ctx.storage, await request.json());
    if (pathname === '/cage/new') return this.cageNew(await request.json());
    if (pathname.startsWith('/door/')) return this.door(pathname.slice(6), request);
    if (pathname.startsWith('/agent/')) return agentStore(this.ctx.storage, pathname.slice(7), request.method === 'POST' ? await request.json() : {});
    if (pathname === '/cage/list') {
      const games = Object.fromEntries([...(await this.ctx.storage.list({ prefix: 'cage:game:' }))].map(([key, game]) => [key.slice(10), game]));
      return json({ tables: [...(await this.ctx.storage.list({ prefix: 'cage:t:' })).keys()].map((key) => key.slice(7)), games });
    }
    if (pathname === '/cage/game') return json({ game: (await this.ctx.storage.get(`cage:game:${(await request.json()).id}`)) ?? 'sealed-hand' });
    if (pathname === '/cage/done') {
      const { id } = await request.json();
      await this.ctx.storage.delete([`cage:t:${id}`, `cage:game:${id}`]);
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  }

  /** Sessions at the door, by the hash of their token. Pending ones are for the judge; a verified one lasts until it expires. */
  async door(op, request) {
    const body = request.method === 'POST' ? await request.json() : {};
    const key = `door:${body.key}`;
    if (op === 'put') {
      const all = await this.ctx.storage.list({ prefix: 'door:' });
      const pending = [...all.values()].filter((s) => s.status === 'pending').length;
      if (pending >= 50) return json({ error: 'busy' }, 429);
      await this.ctx.storage.put(key, body.session);
      return json({ ok: true });
    }
    if (op === 'get') {
      const session = await this.ctx.storage.get(key);
      return session ? json(session) : json({ error: 'none' }, 404);
    }
    if (op === 'result') {
      const session = await this.ctx.storage.get(key);
      if (!session) return json({ error: 'none' }, 404);
      if (body.ok === true) session.status = 'verified';
      if (body.agent === true) session.kind = 'agent'; // in on an owner's setting: an agent's own key, whatever the session said it was
      if (body.ok === false) Object.assign(session, { status: 'refused', reason: String(body.reason ?? '').slice(0, 200) });
      if (body.balanceStar !== undefined) session.balanceStar = body.balanceStar;
      if (body.permit !== undefined) session.permit = body.permit;
      await this.ctx.storage.put(key, session);
      return json({ ok: true });
    }
    if (op === 'timing-add') {
      if (!goodTiming(body.action, body.ms)) return json({ error: 'bad_timing' }, 400);
      const k = `timing:${body.action}`;
      await this.ctx.storage.put(k, addSample((await this.ctx.storage.get(k)) ?? [], body.ms));
      return json({ ok: true });
    }
    if (op === 'timing-list') {
      const medians = {};
      for (const [k, samples] of await this.ctx.storage.list({ prefix: 'timing:' })) medians[k.slice(7)] = { ms: medianOf(samples), n: samples.length };
      return json({ medians });
    }
    if (op === 'list') {
      const all = await this.ctx.storage.list({ prefix: 'door:' });
      const now = Date.now();
      const out = [];
      for (const [k, s] of all) {
        // Done with: past its time, or refused or never answered long ago.
        if (s.expires * 1000 < now || (s.status !== 'verified' && now - s.at > 3_600_000)) {
          await this.ctx.storage.delete(k);
          continue;
        }
        if (s.status !== 'refused') out.push({ key: k.slice(5), ...s });
      }
      return json({ doors: out });
    }
    return json({ error: 'not_found' }, 404);
  }

  /**
   * A tNIGHT table's number in the cage contract, and its place on the list the judge reads. Numbers are never reused.
   * The chain outlives any one Worker, so a new Worker sharing a cage starts above the numbers used before it (CAGE_TABLE_BASE).
   */
  async cageNew({ id, base = 0, game = 'sealed-hand' }) {
    const table = Math.max((await this.ctx.storage.get('cage:next')) ?? 0, base) + 1;
    await this.ctx.storage.put({ 'cage:next': table, [`cage:t:${id}`]: table, [`cage:game:${id}`]: game });
    return json({ table });
  }

  /**
   * POST /lobby/open, one caller at a time: a play-chip table of this game with a free seat, or a new one opened here. A seat
   * handed out is held for a few seconds, so ten agents asking at once fill one table and spill to the next, not ten tables.
   */
  async lobbyOpen(opts) {
    this.lobby ??= { holds: [], fresh: [] };
    let out;
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const rows = [...(await this.ctx.storage.list({ prefix: `t:${opts.game}:` })).values()].filter((t) => now - t.updatedAt < STALE_MS);
      const picked = pickTable(opts, rows, this.lobby, now);
      if (picked) { out = picked; return; }
      const ns = this.env[tableBinding(opts.game)];
      if (!ns) { out = { error: 'no_game' }; return; }
      const id = ns.newUniqueId();
      const res = await ns.get(id).fetch(new Request('https://table/init', { method: 'POST', body: JSON.stringify({ lobbySeconds: opts.lobbySeconds, ...(opts.game === 'cup-and-claim' ? { seats: opts.seats } : {}) }) }));
      if (!res.ok) { out = { error: 'open_failed', status: res.status }; return; }
      noteOpened(opts, id.toString(), this.lobby, now);
      out = { id: id.toString(), created: true };
    });
    if (out.error) return json({ error: out.error, message: 'Could not open a table. Try again.' }, out.status ?? 500);
    return json(out);
  }

  async update(t) {
    const key = `t:${t.game}:${t.id}`;
    const old = await this.ctx.storage.get(key);
    if (old && old.seq > t.seq) return json({ ok: true }); // reports can arrive out of order
    if (t.phase === 'over') {
      await this.logClosure(t, old?.n ?? null);
      await this.ctx.storage.delete(key);
      return json({ ok: true, n: old?.n ?? null });
    }
    // A table's number: the next in its game, given the first time it reports and kept for its life, so people can say "table 2".
    let n = old?.n;
    if (n === undefined) {
      n = ((await this.ctx.storage.get(`n:${t.game}`)) ?? 0) + 1;
      await this.ctx.storage.put(`n:${t.game}`, n);
    }
    await this.ctx.storage.put(key, { ...t, n, updatedAt: Date.now() });
    return json({ ok: true, n }); // the table keeps its number, so it can be named after it has left the list
  }

  async logClosure(t, n) {
    await logClosure(this.ctx.storage, t, n);
  }

  async closures(opts) {
    return json({ closures: await listClosures(this.ctx.storage, opts) });
  }

  async list() {
    const rows = await this.ctx.storage.list({ prefix: 't:' });
    const now = Date.now();
    const byGame = {};
    for (const [key, t] of rows) {
      // A tNIGHT table in its lobby puts nothing on chain until someone comes, so it can wait as long as it likes.
      if (now - t.updatedAt > STALE_MS && !(t.tnight && t.phase === 'lobby')) {
        await this.ctx.storage.delete(key);
        continue;
      }
      if (t.n === undefined) { // listed before tables had numbers: number it now, once
        t.n = ((await this.ctx.storage.get(`n:${t.game}`)) ?? 0) + 1;
        await this.ctx.storage.put({ [`n:${t.game}`]: t.n, [key]: t });
      }
      (byGame[t.game] ??= []).push({ id: t.id, n: t.n, seatsFilled: t.seatsFilled, seats: t.seats, phase: t.phase, joinable: t.joinable, round: t.round, ...(t.ante ? { ante: t.ante } : {}), ...(Array.isArray(t.faces) ? { faces: t.faces } : {}), updatedAt: t.updatedAt, ...(t.tnight ? { tnight: true, table: t.table, warm: !!t.warm } : {}) });
    }
    for (const list of Object.values(byGame)) {
      list.sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.updatedAt - a.updatedAt);
      list.splice(MAX_LISTED);
    }
    return json(byGame);
  }
}

/** Who sits at a table, for the Hall's list: name and look only, the same as the table's public state shows. Seats that left are gone. */
export const tableFaces = (s) => s.seats.filter((x) => !x.left).map((x) => ({ name: x.name, kind: x.kind, avatar: x.avatar ?? null }));

export const directoryStub = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('hall'));
