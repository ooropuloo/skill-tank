#!/usr/bin/env node
// OPTIONAL hook mode. Installs (or removes) the context-tank hooks and status line in ~/.claude/settings.json.
// The skill-tank server does NOT need this: it reads the transcripts. With SKILL_TANK_HOOK_EVENTS=1 the server
// additionally merges the status lines (Claude Code's own context-window size + usage) written by statusline.mjs.
//   node install.mjs                    install / update hooks + status line (idempotent, backs up settings first)
//   node install.mjs --statusline-only  install only the status line (all the server merges)
//   node install.mjs --uninstall remove, and restore the previous status line
//   node install.mjs --check     print whether it is installed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = process.env.CONTEXT_TANK_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const DATA = path.join(os.homedir(), '.claude', 'context-tank');
const CHAIN = path.join(DATA, 'chain.json');
const fwd = p => p.replace(/\\/g, '/');
const HOOK_CMD = `node "${fwd(path.join(HERE, 'hook.mjs'))}"`;
const STATUS_CMD = `node "${fwd(path.join(HERE, 'statusline.mjs'))}"`;
const MARKS = ['context-tank/scripts/', fwd(HERE) + '/']; // legacy context-tank install, or this folder
const isOurs = h => typeof h?.command === 'string' && MARKS.some(m => fwd(h.command).includes(m));

const EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', 'Skill'],
  ['PreCompact', null],
  ['SessionEnd', null],
];

function load() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { if (fs.existsSync(SETTINGS)) { console.error('settings.json 不是合法 JSON，先修正再安裝：' + SETTINGS); process.exit(1); } return {}; } }
function strip(cfg) {
  for (const ev of Object.keys(cfg.hooks || {})) {
    cfg.hooks[ev] = (cfg.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
}
const installed = cfg => Object.values(cfg.hooks || {}).some(gs => gs.some(g => (g.hooks || []).some(isOurs)));

const mode = process.argv[2] || '';
const cfg = load();
if (mode === '--check') { console.log(installed(cfg) ? '已安裝' : '未安裝'); process.exit(0); }

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(SETTINGS)) {
  const bak = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SETTINGS, bak);
  console.log('已備份 settings：' + bak);
}

strip(cfg);
if (mode === '--uninstall') {
  if (isOurs(cfg.statusLine)) {
    try { const prev = JSON.parse(fs.readFileSync(CHAIN, 'utf8')); if (prev.command) cfg.statusLine = prev.statusLine || { type: 'command', command: prev.command }; else delete cfg.statusLine; }
    catch { delete cfg.statusLine; }
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  console.log('已移除 context-tank 的 hooks 與 status line。');
  process.exit(0);
}

cfg.hooks ||= {};
for (const [ev, matcher] of mode === '--statusline-only' ? [] : EVENTS) {
  const group = { hooks: [{ type: 'command', command: HOOK_CMD, async: true, timeout: 5 }] };
  if (matcher) group.matcher = matcher;
  (cfg.hooks[ev] ||= []).push(group);
}
if (cfg.statusLine && !isOurs(cfg.statusLine) && cfg.statusLine.command) {
  fs.writeFileSync(CHAIN, JSON.stringify({ command: cfg.statusLine.command, statusLine: cfg.statusLine }, null, 2));
  console.log('原本的 status line 會保留並串在魚缸水位前面顯示。');
}
cfg.statusLine = { type: 'command', command: STATUS_CMD, padding: 0 };
fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
console.log('已安裝到 ' + SETTINGS);
console.log('新開的 Claude Code session 會開始丟牌；目前已開著的 session 可用 /hooks 檢視或重開。');
