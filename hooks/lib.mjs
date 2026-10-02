// Shared helpers: data paths, JSONL append/rotate, skill deck scan, token estimate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const DATA = process.env.CONTEXT_TANK_DIR || path.join(HOME, '.claude', 'context-tank');
export const EVENTS = path.join(DATA, 'events.jsonl');
export const DECK = path.join(DATA, 'deck.json');
export const COUNTS = path.join(DATA, 'counts.json');
export const LAST = path.join(DATA, 'last-status.json');
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_MS = 6 * 3600e3;

export function ensureDir() { fs.mkdirSync(DATA, { recursive: true }); }

// One event per line. Small single writes with O_APPEND, so concurrent hooks don't interleave.
export function append(ev) {
  ensureDir();
  fs.appendFileSync(EVENTS, JSON.stringify({ ts: Date.now(), ...ev }) + '\n');
}

// Keep the file small: drop events older than 6h and sessions that already ended.
// The page notices the file shrank and re-reads it from the start.
export function rotateIfBig() {
  try {
    if (fs.statSync(EVENTS).size < MAX_BYTES) return;
    const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const ended = new Set(lines.filter(e => e.type === 'end').map(e => e.session));
    const cut = Date.now() - KEEP_MS;
    const keep = lines.filter(e => e.ts >= cut && !ended.has(e.session));
    const tmp = EVENTS + '.tmp';
    fs.writeFileSync(tmp, keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, EVENTS);
  } catch {}
}

export function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export function writeJson(file, obj) { ensureDir(); const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }

export function estimateTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of text) { const c = ch.codePointAt(0); if ((c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF)) cjk++; else other++; }
  return Math.round(cjk * 1.05 + other / 3.6);
}

function parseSkill(file, source) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    const fm = m ? m[1] : ''; const body = m ? m[2] : raw;
    const get = k => { const r = fm.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')); return r ? r[1].trim().replace(/^["']|["']$/g, '') : ''; };
    return { name: get('name') || path.basename(path.dirname(file)), desc: get('description').slice(0, 200), tokens: estimateTokens(body), source };
  } catch { return null; }
}
function scanDir(dir, source, out, depth = 0) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name), f = path.join(sub, 'SKILL.md');
    if (fs.existsSync(f)) { const s = parseSkill(f, source); if (s && (!out.has(s.name) || source !== 'plugin')) out.set(s.name, s); }
    else if (depth < 2) scanDir(sub, source, out, depth + 1);
  }
}
function scanPlugins(dir, out, depth = 0) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    if (e.name === 'skills') scanDir(sub, 'plugin', out); else if (depth < 6) scanPlugins(sub, out, depth + 1);
  }
}
// Scans plugin, personal and (given) project skill folders; writes deck.json for the page.
export function scanDeck(projectDirs = []) {
  const out = new Map();
  scanPlugins(path.join(HOME, '.claude', 'plugins'), out);
  scanDir(path.join(HOME, '.claude', 'skills'), 'personal', out);
  for (const p of projectDirs) if (p) scanDir(path.join(p, '.claude', 'skills'), 'project', out);
  const prev = readJson(DECK, { projects: [] });
  const deck = { updated: Date.now(), projects: [...new Set([...(prev.projects || []), ...projectDirs])].slice(-20), skills: [...out.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)) };
  writeJson(DECK, deck);
  return deck;
}
export function lookupSkill(raw, cwd) {
  const name = String(raw || '').trim().replace(/^\//, '');
  if (!name) return null;
  const short = name.includes(':') ? name.split(':').pop() : name;
  const find = d => d.skills?.find(s => s.name === name || s.name === short);
  let deck = readJson(DECK, null);
  let hit = deck && find(deck);
  if (!hit) { deck = scanDeck([...(deck?.projects || []), cwd]); hit = find(deck); }
  return hit || { name: short, desc: '', tokens: 1500, source: 'builtin' };
}
