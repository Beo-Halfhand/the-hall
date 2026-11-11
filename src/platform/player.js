// One Durable Object per player: identity and chip balance, shared across every game.
//
// A game never touches the balance directly. It holds a buy-in under a key (game + table) and later
// cashes out under that same key. Both are idempotent, so retries can't lose or double chips. This is
// the seam the cage contract replaces later: chips.js is the interface, this class is today's backing.

import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_AVATAR } from './avatars.js';
import { FILL_TO, TOPUP_TO, applyGrant, topUpCheck } from './chips.js';
import { purseView } from './purse.js';
import { ApiError, fail, json, randomToken, sha256 } from './http.js';

export const START_BALANCE = 1000;

export class Player extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.p = null;
    ctx.blockConcurrencyWhile(async () => {
      this.p = (await ctx.storage.get('p')) ?? null;
    });
  }

  async fetch(request) {
    try {
      return await this.route(request);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.status, err.code, err.message);
      console.error('player error:', err?.message);
      return fail(500, 'server_error', 'Something went wrong on the server.');
    }
  }

  async authorize(secret) {
    if (!this.p) throw new ApiError(401, 'bad_token', 'That player token is not valid.');
    const hash = await sha256(secret ?? '');
    if (hash !== this.p.tokenHash) throw new ApiError(401, 'bad_token', 'That player token is not valid.');
  }

  view() {
    return {
      playerId: this.ctx.id.toString(),
      name: this.p.name,
      avatar: this.p.avatar ?? DEFAULT_AVATAR,
      chips: this.p.chips,
      purse: purseView(this.p, this.ctx.id.toString()),
      inPlay: Object.entries(this.p.holds).map(([key, amount]) => ({ key, amount })),
      topUp: topUpCheck(this.p, Date.now()).ok,
      fillUp: this.p.chips < FILL_TO,
    };
  }

  async route(request) {
    const { pathname } = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : {};
    if (this.p && applyGrant(this.p, this.ctx.id.toString(), this.env.PURSE_GRANT, Date.now())) await this.ctx.storage.put('p', this.p);

    switch (pathname) {
      case '/create': {
        if (this.p) throw new ApiError(409, 'exists', 'Player already exists.');
        const secret = randomToken();
        const tokenHash = await sha256(secret);
        this.p = { name: body.name, avatar: body.avatar ?? DEFAULT_AVATAR, tokenHash, chips: body.chips ?? START_BALANCE, holds: {} };
        await this.ctx.storage.put('p', this.p);
        return json({ ...this.view(), token: `${this.ctx.id.toString()}.${secret}` }, 201);
      }
      case '/me': {
        await this.authorize(request.headers.get('x-secret'));
        return json(this.view());
      }
      case '/avatar': {
        await this.authorize(body.secret);
        this.p.avatar = body.avatar;
        await this.ctx.storage.put('p', this.p);
        return json(this.view());
      }
      case '/topup': {
        await this.authorize(body.secret);
        const check = topUpCheck(this.p, Date.now());
        if (!check.ok) throw new ApiError(409, check.code, check.message);
        this.p.chips = TOPUP_TO;
        this.p.lastTopUp = Date.now();
        await this.ctx.storage.put('p', this.p);
        return json(this.view());
      }
      case '/fill-up': {
        // Play chips: the purse back to FILL_TO, any time (chips at a table don't matter), as often as wanted. Never lowers a purse.
        await this.authorize(body.secret);
        const before = this.p.chips;
        if (before < FILL_TO) {
          this.p.chips = FILL_TO;
          await this.ctx.storage.put('p', this.p);
        }
        return json({ ...this.view(), added: this.p.chips - before });
      }
      case '/fill': {
        // Internal only. A table raises the purse to `to` so a move to a stack can be paid. Never lowers it.
        const to = Number(body.to);
        if (!this.p || !Number.isInteger(to) || to < 0) throw new ApiError(400, 'bad_amount', 'to is a whole number of chips.');
        if (this.p.chips < to) {
          this.p.chips = to;
          await this.ctx.storage.put('p', this.p);
        }
        return json(this.view());
      }
      case '/hold': {
        await this.authorize(body.secret);
        const { key, amount, upTo, all, fillTo } = body;
        if (this.p.holds[key] !== undefined) return json({ ...this.view(), held: this.p.holds[key], alreadyHeld: true });
        // A default buy-in: the purse is filled to it first (play chips). What was added is remembered under the hold, so a seat that
        // never happens (a refusal after this) gives back only what the player really had.
        const minted = Number.isInteger(fillTo) && fillTo > this.p.chips ? fillTo - this.p.chips : 0;
        const have = this.p.chips + minted;
        const take = all ? have : upTo ? Math.min(have, amount) : amount; // upTo: as much of it as the purse has
        if (take < 1 || have < take) throw new ApiError(409, 'not_enough_chips', all ? 'Your purse is empty.' : `That buy-in is ${amount} chips; you have ${this.p.chips}.`);
        this.p.chips = this.p.chips + minted - take;
        this.p.holds[key] = take;
        if (minted) this.p.mints = { ...this.p.mints, [key]: minted };
        await this.ctx.storage.put('p', this.p);
        return json({ ...this.view(), held: take, alreadyHeld: false });
      }
      case '/hold-more': {
        // Internal only. More chips for a seat already held: from the purse, or back to it if the seat couldn't take them.
        const { key, amount } = body;
        if (this.p.holds[key] === undefined) throw new ApiError(409, 'not_held', 'You have no seat holding chips at that table.');
        if (amount > 0 && this.p.chips < amount) throw new ApiError(409, 'not_enough_chips', `Your purse has ${this.p.chips}.`);
        this.p.chips -= amount;
        this.p.holds[key] += amount;
        await this.ctx.storage.put('p', this.p);
        return json(this.view());
      }
      case '/release': {
        // Internal only. Gives a buy-in back when the seat never happened.
        if (this.p && this.p.holds[body.key] !== undefined) {
          this.p.chips += this.p.holds[body.key] - (this.p.mints?.[body.key] ?? 0);
          delete this.p.holds[body.key];
          if (this.p.mints) delete this.p.mints[body.key];
          await this.ctx.storage.put('p', this.p);
        }
        return json({ ok: true });
      }
      case '/cashout': {
        // Internal only. No hold under this key means it was already paid.
        if (this.p && this.p.holds[body.key] !== undefined) {
          this.p.chips += Math.max(0, body.amount | 0);
          delete this.p.holds[body.key];
          if (this.p.mints) delete this.p.mints[body.key];
          await this.ctx.storage.put('p', this.p);
        }
        return json({ ok: true });
      }
      default:
        return fail(404, 'not_found', 'No such route.');
    }
  }
}
