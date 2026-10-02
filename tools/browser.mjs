// Headless Chrome for the verify tools. Needs playwright-core (or playwright) — `npm i -D playwright-core` in this folder,
// or a global install — plus an installed Google Chrome (channel "chrome"; GPU flags so three.js renders for real).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tries = [
  () => createRequire(path.join(here, '..', 'package.json'))('playwright-core'),
  () => createRequire(path.join(here, '..', 'package.json'))('playwright'),
  ...(process.env.PLAYWRIGHT_CORE_FROM ? [() => createRequire(process.env.PLAYWRIGHT_CORE_FROM)('playwright-core')] : []),
  // a global install next to node: playwright-core itself, or any global CLI that bundles it
  ...(() => { const g = path.join(path.dirname(process.execPath), 'node_modules'); let ds = []; try { ds = fs.readdirSync(g); } catch {}
    return ['playwright-core', ...ds].map((d) => () => createRequire(path.join(g, d, 'package.json'))('playwright-core')); })(),
];
let pw = null;
for (const t of tries) { try { pw = t(); break; } catch {} }
if (!pw) { console.error('playwright-core not found: run `npm i -D playwright-core` here (or set PLAYWRIGHT_CORE_FROM)'); process.exit(2); }
export const { chromium } = pw;
export const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
export const launch = () => chromium.launch({ channel: 'chrome', headless: true, args: process.platform === 'win32' ? GPU_ARGS : ['--enable-gpu', '--ignore-gpu-blocklist'] });
