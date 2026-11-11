// Runs before every `wrangler deploy` (and `wrangler dev`) of a tNIGHT config, as its [build] command, and stops it unless the config
// names a real v4b cage. Usage: node scripts/check-cage-config.mjs wrangler.toml
//
// It stops on:
//   - the placeholder this branch ships with, or anything that isn't 64 hex characters;
//   - cage #3's address, because this branch's page and judge speak cage v4b and can't read cage #3;
//   - for a config that serves .preview-dist (staging): a .preview-dist built for a different address, or none, or a wallet
//     bundle from an older build. Run node scripts/preview-build.mjs after setting the address.
// It reads the toml and the files named, and prints only the first 12 characters of an address. It never writes anything.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireV4b } from './cage-build-check.mjs';

export const PLACEHOLDER = 'SET-ME-new-v4b-cage-address';
export const CAGE3 = '802bf6bb1759ced14f3ffd39dcb56bc6e4051ff09bea1194f9b16967fcfe5bf6';
const ROOT = new URL('..', import.meta.url).pathname;

/** The [vars] value of `name` in a wrangler toml, or null. Only plain `NAME = "value"` lines, which is how these configs write them. */
export function tomlVar(text, name) {
  let inVars = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) inVars = t === '[vars]';
    else if (inVars) {
      const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`).exec(t);
      if (m) return m[1];
    }
  }
  return null;
}

/** Returns a list of reasons to stop; empty means the config may deploy. */
export function cageConfigProblems(configFile, { root = ROOT } = {}) {
  const text = readFileSync(join(root, configFile), 'utf8');
  const address = tomlVar(text, 'CAGE_ADDRESS');
  const problems = [];
  if (address === null) problems.push(`${configFile} has no CAGE_ADDRESS in [vars].`);
  else if (address === PLACEHOLDER) problems.push(`${configFile} still has the placeholder CAGE_ADDRESS. Put the new v4b cage's address there first (cut-over step 6).`);
  else if (!/^[0-9a-f]{64}$/.test(address)) problems.push(`${configFile}'s CAGE_ADDRESS isn't 64 lowercase hex characters.`);
  else if (address === CAGE3) problems.push(`${configFile} names cage #3 (${CAGE3.slice(0, 12)}…). This branch speaks cage v4b and can't read cage #3.`);
  if (problems.length) return problems;
  if (/^directory\s*=\s*"\.\/\.preview-dist"/m.test(text)) {
    const cfg = join(root, '.preview-dist', 'cage-config.json');
    if (!existsSync(cfg)) problems.push('.preview-dist has no cage-config.json. Run node scripts/preview-build.mjs.');
    else if (JSON.parse(readFileSync(cfg, 'utf8')).address !== address) problems.push(`.preview-dist was built for another cage than ${configFile}'s CAGE_ADDRESS (${address.slice(0, 12)}…). Run node scripts/preview-build.mjs with the new deployment file.`);
    const generated = join(root, 'wallet-app', 'src', 'generated', 'index.js');
    if (existsSync(join(root, '.preview-dist', 'wallet-app', 'cage.js'))) {
      if (!existsSync(generated)) problems.push('The wallet bundle is in .preview-dist, but wallet-app/src/generated is gone, so nothing says which cage it was built from. Run cd wallet-app && npm run build, then preview-build again.');
      else try { requireV4b(readFileSync(generated, 'utf8'), generated); } catch (err) { problems.push(err.message.replace(/^STOP: /, '')); }
    }
  }
  return problems;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const configFile = process.argv[2];
  if (!configFile) { console.error('usage: node scripts/check-cage-config.mjs <wrangler config>'); process.exit(2); }
  const problems = cageConfigProblems(configFile);
  if (problems.length) {
    for (const p of problems) console.error(`STOP: ${p}`);
    console.error('Nothing was deployed.');
    process.exit(1);
  }
  console.log(`${configFile}: CAGE_ADDRESS is a v4b cage (${tomlVar(readFileSync(join(ROOT, configFile), 'utf8'), 'CAGE_ADDRESS').slice(0, 12)}…), go on.`);
}
