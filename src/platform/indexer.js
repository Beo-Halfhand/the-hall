// The Hall's own indexer, for a wallet whose indexer is gone. The wallet page reads the cage through this Worker, which
// forwards GraphQL to the Blockfrost Midnight preprod indexer with the project key added here. The key is a Worker secret
// (INDEXER_KEY) and never reaches a browser; the upstream (INDEXER_UPSTREAM) must be https on a preprod host.
//   GET  /indexer           whether this Worker has one: { on, network, host }
//   POST /indexer/graphql   one GraphQL query, JSON in and out. No mutations.
//   GET  /indexer/ws        the same over a WebSocket (graphql-transport-ws), for subscriptions

import { fail, json, walletPageOn } from './http.js';

const BODY_MAX = 64 * 1024;
const UPSTREAM_MS = 25000;

function upstreamOf(env) {
  try {
    const url = new URL(env.INDEXER_UPSTREAM ?? '');
    const local = env.ALLOW_TEST_CONFIG === '1' && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.host);
    if (!(url.protocol === 'https:' && /preprod/.test(url.host)) && !local) return null;
    if (/mainnet/i.test(url.href)) return null;
    return url;
  } catch {
    return null;
  }
}

// The wallet page reads the cage through it; the seal-anchor receipt reads its lock transaction through it (a Hall with anchoring on).
export const indexerOn = (env) => (walletPageOn(env) || (!!env.ANCHOR_QUEUE && ['lock', 'background'].includes(env.ANCHOR_MODE))) && typeof env.INDEXER_KEY === 'string' && env.INDEXER_KEY.length > 0 && !!upstreamOf(env);

/** The upstream address with the key on it. Only ever handed to fetch, never to a response or a log. */
function withKey(env, suffix = '') {
  const url = upstreamOf(env);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${suffix}`;
  url.searchParams.set('project_id', env.INDEXER_KEY);
  return url;
}

/** Any text about to leave this Worker, with the key taken out should it ever be in it. */
const scrub = (env, text) => String(text ?? '').split(env.INDEXER_KEY).join('***');

/** The operation a GraphQL document asks for: query, mutation or subscription. Anonymous `{ ... }` is a query. */
export function operationOf(query) {
  const text = String(query).replace(/#[^\n]*/g, '').trimStart();
  const m = /^(query|mutation|subscription)\b/.exec(text);
  return m ? m[1] : text.startsWith('{') ? 'query' : null;
}

async function proxyQuery(request, env) {
  if (request.method !== 'POST') return fail(405, 'method', 'Use POST /indexer/graphql with a JSON body.');
  const text = await request.text();
  if (text.length > BODY_MAX) return fail(413, 'too_big', 'That query is too big.');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'bad_json', 'Request body is not valid JSON.');
  }
  if (typeof body?.query !== 'string') return fail(400, 'bad_query', 'Send { query, variables? }.');
  const op = operationOf(body.query);
  if (op !== 'query') return fail(400, 'bad_query', 'Only queries go through here: no mutations or subscriptions.');
  let res;
  try {
    res = await fetch(withKey(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: text,
      signal: AbortSignal.timeout(UPSTREAM_MS),
    });
  } catch (err) {
    return json({ errors: [{ message: `The Hall’s indexer didn’t answer: ${scrub(env, err?.name === 'TimeoutError' ? 'no reply in 25 s' : err?.message)}.` }] }, 502);
  }
  if (!res.ok) return json({ errors: [{ message: `The Hall’s indexer answered HTTP ${res.status}.` }] }, 502);
  return new Response(res.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

const CLOSE_OK = (code) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

/** One socket to the browser, one to the indexer, frames passed straight through both ways. */
async function proxySocket(request, env) {
  if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return fail(426, 'upgrade', 'This route is a WebSocket.');
  const protocol = request.headers.get('sec-websocket-protocol') ?? '';
  if (protocol && !/^[\w\-., ]{1,200}$/.test(protocol)) return fail(400, 'bad_protocol', 'That subprotocol can’t be asked for.');
  let up;
  try {
    up = await fetch(withKey(env, '/ws'), { headers: { upgrade: 'websocket', ...(protocol ? { 'sec-websocket-protocol': protocol } : {}) } });
  } catch (err) {
    return fail(502, 'indexer_down', `The Hall’s indexer didn’t take the socket: ${scrub(env, err?.message)}.`);
  }
  const upstream = up.webSocket;
  if (!upstream) return fail(502, 'indexer_down', `The Hall’s indexer refused the socket (HTTP ${up.status}).`);
  upstream.accept();
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  const pipe = (from, to) => {
    from.addEventListener('message', (e) => { try { to.send(e.data); } catch { /* the other side has gone */ } });
    from.addEventListener('close', (e) => { try { to.close(CLOSE_OK(e.code) ? e.code : 1000, scrub(env, e.reason).slice(0, 120)); } catch { /* already closed */ } });
    from.addEventListener('error', () => { try { to.close(1011, 'the other side failed'); } catch { /* already closed */ } });
  };
  pipe(upstream, server);
  pipe(server, upstream);
  const headers = {};
  const chosen = up.headers.get('sec-websocket-protocol');
  if (chosen) headers['sec-websocket-protocol'] = chosen;
  return new Response(null, { status: 101, webSocket: client, headers });
}

export async function indexerRoute(request, env, parts) {
  if (!indexerOn(env)) return fail(404, 'no_indexer', 'This Hall has no indexer of its own.');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return fail(403, 'forbidden', 'The Hall’s indexer serves its own pages only.');
  if (parts.length === 1) return request.method === 'GET' ? json({ on: true, network: 'preprod', host: upstreamOf(env).host }) : fail(405, 'method', 'Use GET /indexer.');
  if (parts.length === 2 && parts[1] === 'graphql') return proxyQuery(request, env);
  if (parts.length === 2 && parts[1] === 'ws') return proxySocket(request, env);
  return fail(404, 'not_found', 'Use POST /indexer/graphql or GET /indexer/ws.');
}
