// Starts a throwaway local `wrangler dev` in its own process group. No account, no login.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(port, vars = [], persistDir = mkdtempSync(join(tmpdir(), 'sealed-hand-'))) {
  // Someone else's server on this port would answer every test with their code. It's happened: another checkout's test left one running.
  const already = await fetch(`http://127.0.0.1:${port}/api`).then(() => true).catch(() => false);
  if (already) throw new Error(`Port ${port} already has a server on it, so these tests wouldn't be testing this checkout. Stop it, or pick another port.`);
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (name.startsWith('CLOUDFLARE_') || name.startsWith('CF_')) delete env[name];
  const args = ['dev', '--config', 'wrangler.dev.toml', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(port + 1000), '--persist-to', persistDir, '--log-level', 'warn', ...vars];
  const child = spawn('node_modules/.bin/wrangler', args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api`)).ok) return;
    } catch { /* still starting */ }
    await sleep(500);
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-2000)}`);
}

export async function stopServers() {
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(500);
}
