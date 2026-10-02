#!/usr/bin/env node
// Claude Code status line: appends a `status` line to events.jsonl when context usage changes,
// then prints a tiny water gauge. A status line you had before installing is chained in front.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { append, readJson, writeJson, DATA, COUNTS, LAST } from './lib.mjs';

const CHAIN = path.join(DATA, 'chain.json');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  let d = {}; try { d = JSON.parse(input || '{}'); } catch {}
  const cw = d.context_window || {};
  const size = cw.context_window_size || 200000;
  const u = cw.current_usage;
  let used = null;
  if (u) used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  else if (typeof cw.used_percentage === 'number') used = Math.round(cw.used_percentage / 100 * size);

  const session = d.session_id;
  if (session && used != null) {
    try {
      const last = readJson(LAST, {});
      if (!last[session] || last[session].used !== used || last[session].size !== size) {
        const cwd = d.workspace?.current_dir || d.cwd || '';
        append({ type: 'status', session, title: cwd ? path.basename(cwd) : undefined, used, size, model: d.model?.display_name || '' });
        last[session] = { used, size, ts: Date.now() };
        for (const k of Object.keys(last)) if (Date.now() - last[k].ts > 6 * 3600e3) delete last[k];
        writeJson(LAST, last);
      }
    } catch {}
  }

  let prev = '';
  try {
    const { command } = JSON.parse(fs.readFileSync(CHAIN, 'utf8'));
    if (command) {
      const shell = process.platform === 'win32' ? (process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash') : '/bin/sh';
      prev = (spawnSync(shell, ['-c', command], { input, encoding: 'utf8', timeout: 2000 }).stdout || '').replace(/\s+$/, '');
    }
  } catch {}

  let gauge = '';
  if (used != null) {
    const pct = used / size, n = 8, filled = Math.min(n, Math.round(pct * n));
    const color = pct < 0.6 ? '\x1b[36m' : pct < 0.85 ? '\x1b[33m' : '\x1b[31m';
    gauge = `${color}🐟 ${'▓'.repeat(filled)}${'░'.repeat(n - filled)} ${Math.round(pct * 100)}%\x1b[0m`;
    const cards = session ? readJson(COUNTS, {})[session] : null;
    if (cards != null) gauge += ` · 🃏${cards}`;
  }
  process.stdout.write([prev, gauge].filter(Boolean).join('\n'));
  process.exit(0);
});
