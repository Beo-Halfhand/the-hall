// An agent's owner's page (/agents/owner?cage=<cageId>&agent=<agent wallet, hex>): the daily cap, removing it, and Stop, each one
// signature from the wallet the agent's cage id pays out to. The Worker keeps the setting pending; the judge checks the signature
// against the cage and only then does it count. Nothing here moves money, and no key ever leaves the wallet.

import { mountSupport } from './support.js';
import { mountNav } from './nav.js';
import { NETWORK, listWallets } from './wallet-core.js';

const $ = (id) => document.getElementById(id);
const HEX64 = /^[0-9a-f]{64}$/;
const REMOVE_PHRASE = 'No daily cap: this agent can lose everything it deposits.';
const tn = (star) => (star == null ? null : Number(star) / 1e6);
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
mountNav({ current: 'Agents' });
mountSupport($('support'));

const params = new URLSearchParams(location.search);
let cageId = HEX64.test(params.get('cage') ?? '') ? params.get('cage') : null;
let agent = HEX64.test(params.get('agent') ?? '') ? params.get('agent') : null;
let current = null;
let api = null;
let busy = false;

const say = (text) => { $('sign-status').textContent = text; };
function limitText(limit) {
  if (limit === 'stop') return 'Stopped: no new seats.';
  if (limit === 'none') return 'No daily cap (removed by you).';
  return `${fmt(limit)} tNIGHT a day`;
}

async function look() {
  if (!cageId) { $('owner-now').hidden = true; $('now-none').hidden = true; return; }
  $('cage-id').value = cageId;
  const res = await fetch(`/agent-settings/${cageId}`, { cache: 'no-store' });
  if (res.status === 404) { current = null; $('owner-now').hidden = true; $('now-none').hidden = false; paintActions(); return; }
  const s = await res.json();
  current = s.current;
  agent ??= s.current?.agent ?? s.pending?.agent ?? null;
  $('now-none').hidden = !!s.current;
  $('owner-now').hidden = !s.current && !s.pending;
  $('now-limit').textContent = s.current ? limitText(s.current.limit) : 'none in force yet';
  const lost = tn(s.current?.lossTodayStar), left = tn(s.current?.leftStar);
  $('now-day').textContent = !s.current ? '—' : `lost ${fmt(Math.max(0, lost ?? 0))} tNIGHT${lost != null && lost < 0 ? ` (up ${fmt(-lost)})` : ''}${s.current.limit === 'none' ? '' : left != null ? `, ${fmt(left)} left` : ''}`;
  $('now-agent').textContent = agent ? `${agent.slice(0, 12)}…${agent.slice(-6)}` : 'not known yet';
  const p = s.pending;
  $('now-pending').textContent = !p ? 'nothing' : p.status === 'refused' ? `refused: ${p.reason}` : `${limitText(p.limit)} (the judge is checking your signature)`;
  paintActions();
}

function paintActions() {
  $('actions').hidden = !api || !cageId;
  $('stop-go').textContent = current?.limit === 'stop' ? 'Stopped' : 'Stop the agent';
  $('stop-go').disabled = busy || current?.limit === 'stop';
  $('cap-go').textContent = current?.limit === 'stop' ? 'Start again with this daily cap' : 'Set the daily cap';
  $('cap-go').disabled = busy;
  $('remove-go').disabled = busy || $('remove-typed').value.trim() !== REMOVE_PHRASE;
}

function paintWallets() {
  const list = listWallets(window.midnight);
  if (!list.length) { $('wallets').replaceChildren(); $('wallet-status').textContent = 'No Midnight wallet on this page. Install 1AM (the tested wallet), set it to Preprod, and reload. Lace is not yet working here.'; return; }
  $('wallets').replaceChildren(...list.map((w) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = api ? `${w.name}${api.wallet === w.id ? ' ✓' : ''}` : `Connect ${w.name}`;
    b.disabled = !w.compatible || !!api;
    b.addEventListener('click', () => connect(w));
    return b;
  }));
}

function connect(w) {
  $('wallet-status').textContent = `Approve in ${w.name}…`;
  // connect() straight from the click: a pop-up blocker allows it only then
  Promise.resolve().then(() => w.api.connect(NETWORK)).then((conn) => {
    if (typeof conn.signData !== 'function') throw new Error(`${w.name} can't sign a message for a page.`);
    api = { conn, wallet: w.id, name: w.name };
    $('wallet-status').textContent = `${w.name} connected. Each button below asks it for one signature.`;
    paintWallets();
    paintActions();
  }).catch((e) => { $('wallet-status').textContent = `${w.name} didn't connect: ${e?.message ?? e}`; });
}

async function sign(limit) {
  if (!api || !cageId || busy) return;
  if (!agent) { say('This page needs the agent\'s wallet address: open it from the link the agent\'s setup printed (…?cage=…&agent=…).'); return; }
  busy = true;
  paintActions();
  try {
    const { address } = await (await fetch('/agent-settings', { cache: 'no-store' })).json(); // the cage this Hall's judge reads
    const signedAt = Math.floor(Date.now() / 1000) - 5;
    const message = `sealed-hand:agent:v1|${address}|${cageId}|${agent}|${limit}|${signedAt}`;
    say(`Approve in ${api.name}: one line, nothing moves.`);
    const signed = await api.conn.signData(message, { encoding: 'text', keyType: 'unshielded' });
    const res = await fetch('/agent-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cageId, agent, limit, signedAt, verifyingKey: signed.verifyingKey, signature: signed.signature }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? `refused (${res.status})`);
    say('Signed. The judge is checking it against the cage (a few seconds)…');
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await (await fetch(`/agent-settings/${cageId}`, { cache: 'no-store' })).json();
      if (s.current?.signedAt === signedAt) { say(`Done: ${limitText(limit)}`); break; }
      if (s.pending?.signedAt === signedAt && s.pending.status === 'refused') { say(`The judge refused it: ${s.pending.reason}`); break; }
    }
  } catch (e) {
    say(`Not signed: ${e?.message ?? e}`);
  } finally {
    busy = false;
    await look();
  }
}

$('which').addEventListener('submit', (e) => { e.preventDefault(); const v = $('cage-id').value.trim().toLowerCase(); if (HEX64.test(v)) { cageId = v; look(); } else say('A cage id is 64 hex characters.'); });
$('cap-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number($('cap').value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) { say('The daily cap is a whole number of tNIGHT, 1 or more.'); return; }
  sign(String(n));
});
$('remove-typed').addEventListener('input', paintActions);
$('remove-go').addEventListener('click', () => { if ($('remove-typed').value.trim() === REMOVE_PHRASE) sign('none'); });
$('stop-go').addEventListener('click', () => sign('stop'));

paintWallets();
window.addEventListener('load', paintWallets); // a wallet may inject after this module runs
setTimeout(paintWallets, 800);
look();
setInterval(() => { if (!busy) look(); }, 15_000);
