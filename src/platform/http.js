// Small helpers shared by the Worker and every Durable Object.

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const fail = (status, error, message) => json({ error, message }, status);

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Reads the Bearer value, or '' if there isn't one. */
export function bearer(request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Midnight Radio (TomJon & dvnc). The stream address comes when TomJon sends it: until RADIO_URL is set, there is no radio.
export const RADIO_DEFAULTS = { credit: 'Midnight Radio by TomJon & dvnc', link: 'https://midnightradio.cloud/' };

/** The Hall's radio, from RADIO_URL (and RADIO_CREDIT, RADIO_LINK to change the credit). Null, so no button, unless RADIO_URL is https. */
export function radioConfig(env) {
  try {
    const url = new URL(env.RADIO_URL);
    if (url.protocol !== 'https:') return null;
    let link = RADIO_DEFAULTS.link;
    try {
      if (env.RADIO_LINK && new URL(env.RADIO_LINK).protocol === 'https:') link = new URL(env.RADIO_LINK).href;
    } catch { /* keep the default */ }
    return { url: url.href, origin: url.origin, credit: env.RADIO_CREDIT || RADIO_DEFAULTS.credit, link };
  } catch {
    return null;
  }
}

/** Headers for every page. No outside images; audio only from the radio's host. */
export function withPageHeaders(res, { radio = null } = {}) {
  const out = new Response(res.body, res);
  out.headers.set('content-security-policy', `default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self';${radio ? ` media-src ${radio.origin};` : ''} connect-src 'self' https://cloudflareinsights.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
}

/** The link-preview image (/og.jpg). It is the same bytes every time, so crawlers and browsers may keep it for a year; new art gets a new file name. */
export function withImageCache(res) {
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'public, max-age=31536000, immutable');
  out.headers.set('x-content-type-options', 'nosniff');
  return out;
}

export const PREVIEW_TEXT = 'A night-time inn of games for people and agents. Sealed Hand and Cup & Claim are open, on play chips.';
/** What a link preview says about the Hall. Where tNIGHT tables are on (staging) it says so; on live it never does. */
export const previewText = (env) => (env.TNIGHT_TABLES === 'on' ? `${PREVIEW_TEXT} Test NIGHT tables on preprod.` : PREVIEW_TEXT);

/** The Hall's page with its link-preview text set for this Worker. Crawlers don't run scripts, so it's written into the HTML here. */
export function withPreviewText(res, env) {
  const text = previewText(env);
  const set = (content) => ({ element: (el) => el.setAttribute('content', content) });
  return new HTMLRewriter()
    .on('meta[name="description"]', set(text))
    .on('meta[property="og:description"]', set(text))
    .transform(res);
}

/**
 * The social card's absolute URLs name halfhand.app in the page files. Served from any other origin (the test build on workers.dev,
 * a preview), they point at that origin instead, so the picture and the link are that Worker's own. On halfhand.app it changes nothing.
 */
export function withSocialOrigin(res, origin) {
  if (origin === 'https://halfhand.app' || !(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  const own = (el) => { const v = el.getAttribute('content'); if (v?.startsWith('https://halfhand.app/')) el.setAttribute('content', origin + v.slice('https://halfhand.app'.length)); };
  const h = { element: own };
  return new HTMLRewriter().on('meta[property="og:url"]', h).on('meta[property="og:image"]', h).on('meta[name="twitter:image"]', h).transform(res);
}

/** The wallet page is off unless this Worker's config turns it on. Only the preview Worker does. */
export const walletPageOn = (env) => env.WALLET_PAGE === 'on';
// The cage page, its own script and style, the cage's address and the contract code. The shared modules (wallet-core.js,
// cage-session.js, buy-in.js, cage.css) are always served: the table pages import them whether or not the cage is on.
export const isWalletPath = (pathname) => pathname === '/wallet' || pathname === '/wallet.html' || pathname === '/js/wallet.js'
  || pathname === '/css/wallet.css' || pathname === '/cage-config.json' || pathname.startsWith('/wallet-app/');
/** The table pages seat a tNIGHT player in place, so where the cage page is on they get its headers too (wasm, the wallet's extension, its indexer). */
export const isTablePage = (pathname) => ['/table', '/table.html', '/dice', '/dice.html'].includes(pathname);

/**
 * Headers for the wallet page. It runs WebAssembly, and it must reach whichever indexer the player's wallet names, so
 * connect-src is wider than the Hall's: https, wss, and the proof server on this machine. The extension schemes let any
 * wallet put window.midnight on the page however it injects it, in Chrome or Firefox. Each wallet supplies its own icon,
 * as a data URL or a hosted one, and a wallet may prove in a Web Worker in this tab.
 */
export function withWalletHeaders(res, { radio = null } = {}) {
  const out = new Response(res.body, res);
  // media-src for the radio (11-06, round 2): the table pages carry these headers where the cage page is on, and without it the stream was blocked there ("Radio offline").
  out.headers.set('content-security-policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com chrome-extension: moz-extension:; worker-src 'self' blob: chrome-extension: moz-extension:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https: chrome-extension: moz-extension:;${radio ? ` media-src ${radio.origin};` : ''} connect-src 'self' https: wss: http://localhost:6300; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
}

/** The official logo files set their white fill in an inline <style>. They stay unaltered, so that's allowed here, and nothing else. */
export function withSvgHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  out.headers.set('x-content-type-options', 'nosniff');
  return out;
}

export const HOME_HOST = 'halfhand.app';
const OLD_HOSTS = new Set(['sealedhand.halfhand.dev']);
// A browser keeps its player key per address, so one that started at the old address can only copy it from there.
// /recover is new, so no browser has a cached redirect for it.
const STAYS_ON_OLD_HOST = new Set(['/recover', '/js/recover.js', '/css/inn.css']);

/** Sends the old address home, keeping the path and query. Null for anything else. */
export function homeRedirect(url) {
  const parsed = new URL(url);
  if (!OLD_HOSTS.has(parsed.hostname) || STAYS_ON_OLD_HOST.has(parsed.pathname)) return null;
  return new Response(null, { status: 301, headers: { location: `https://${HOME_HOST}${parsed.pathname}${parsed.search}` } });
}
