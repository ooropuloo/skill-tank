// skill-tank "deck" (牌庫) = every skill card the session could play.
// Source of truth (verified 2026-10-02 on real transcripts, see README "牌庫資料來源"):
//   transcript attachment {type:"skill_listing", content:"- name: desc\n- name\n…", skillCount, isInitial, names:[…]}
//   — the exact list Claude Code shows the model. First one isInitial:true (full list), later ones are deltas (new skills).
// Fallback (no skill_listing in the transcript): scan the file system the same way Claude Code does —
//   ~/.claude/skills/*/SKILL.md, ~/.claude/commands/**/*.md, enabled plugins' skills/commands, <cwd>/.claude/{skills,commands}.
// The fs scan is also used to give every listed name a category (user/plugin/project/command/builtin) and to fill
// descriptions the listing left out (Claude Code drops descriptions when the list is over its budget).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseFrontmatter, parseListing as parseListingLite } from './parser.mjs';

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const fmOf = (f) => { try { return parseFrontmatter(fs.readFileSync(f, 'utf8')).fm; } catch { return {}; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const ls = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

function addSkillDirs(out, root, category, prefix = '', useFmName = false) {
  for (const d of ls(root)) {
    const dir = path.join(root, d.name); if (!isDir(dir)) continue; // isDir follows symlinks (~/.claude/skills/x -> elsewhere)
    const f =['SKILL.md', 'skill.md'].map((x) => path.join(dir, x)).find((x) => fs.existsSync(x));
    if (!f) continue;
    const fm = fmOf(f); if (String(fm['disable-model-invocation']) === 'true') continue; // not offered to the model
    const nm = prefix + ((useFmName && fm.name) || d.name).replace(/\s+/g, '-');
    if (!out.has(nm)) out.set(nm, { name: nm, category, description: fm.description || '', dir });
  }
}
// commands/**/*.md → "a:b:c"; a dir holding SKILL.md is one skill named after the dir (its sibling .md files are
// its reference docs, not commands — matches what the real listing shows, e.g. "my-skill" but no "my-skill:reference").
function addCommands(out, root, category, prefix = '') {
  const walk = (dir, rel) => {
    const ents = ls(dir); const hasSkill = ents.some((e) => e.isFile() && /^skill\.md$/i.test(e.name));
    if (hasSkill && rel.length) {
      const nm = prefix + rel.join(':'); const fm = fmOf(path.join(dir, ents.find((e) => /^skill\.md$/i.test(e.name)).name));
      if (!out.has(nm)) out.set(nm, { name: nm, category, description: fm.description || '', dir });
    }
    for (const e of ents) {
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))) walk(path.join(dir, e.name), [...rel, e.name]);
      else if (!hasSkill && e.isFile() && e.name.endsWith('.md')) {
        const nm = prefix + [...rel, e.name.slice(0, -3)].join(':');
        if (!out.has(nm)) out.set(nm, { name: nm, category, description: fmOf(path.join(dir, e.name)).description || '', dir: path.join(dir, e.name) });
      }
    }
  };
  if (isDir(root)) walk(root, []);
}

function enabledPlugins(cwd) {
  // installed (installed_plugins.json) ∩ enabled (settings enabledPlugins === true; project settings override user)
  const inst = (readJson(path.join(CLAUDE, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const en = { ...((readJson(path.join(CLAUDE, 'settings.json')) || {}).enabledPlugins || {}) };
  if (cwd) for (const f of ['settings.json', 'settings.local.json']) Object.assign(en, (readJson(path.join(cwd, '.claude', f)) || {}).enabledPlugins || {});
  const norm = (p) => (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const out = [];
  for (const [key, entries] of Object.entries(inst)) {
    if (en[key] !== true) continue;
    const e = (entries || []).find((x) => x.scope === 'user' || (cwd && norm(x.projectPath) === norm(cwd)));
    if (e && isDir(e.installPath)) out.push({ key, dir: e.installPath });
  }
  return out;
}
function addPlugin(out, { key, dir }) {
  const [pkey, market] = key.split('@');
  const pj = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
  const mk = readJson(path.join(dir, '.claude-plugin', 'marketplace.json'));
  const name = pj.name || pkey; const prefix = name + ':';
  const entry = mk && Array.isArray(mk.plugins) && mk.plugins.find((p) => p.name === pkey);
  if (entry && Array.isArray(entry.skills)) {
    for (const s of entry.skills) {
      const sd = path.join(dir, s); const f = path.join(sd, 'SKILL.md'); if (!fs.existsSync(f)) continue;
      const fm = fmOf(f); const nm = prefix + (fm.name || path.basename(sd)).replace(/\s+/g, '-');
      if (!out.has(nm)) out.set(nm, { name: nm, category: 'plugin', description: fm.description || '', dir: sd });
    }
  } else {
    for (const sub of ['skills', path.join('.claude', 'skills')]) addSkillDirs(out, path.join(dir, sub), 'plugin', prefix, true);
  }
  addCommands(out, path.join(dir, 'commands'), 'plugin', prefix);
  void market;
}

// Skills bundled inside Claude Code itself have no files on disk. Rather than shipping a list of their names, a listed
// name that the fs scan cannot find is treated as built-in, unless it has a "plugin:" prefix (claude.ai-synced and
// cached plugin skills). On real transcripts this classifies exactly the built-ins (simplify, loop, init, …).

const cache = new Map();
/** fs scan → Map(name → {name, category, description, dir}). Cached 30 s per cwd. */
export function scanFs(cwd = '') {
  const k = (cwd || '').toLowerCase(); const c = cache.get(k);
  if (c && Date.now() - c.t < 30000) return c.map;
  const out = new Map();
  if (cwd) { addSkillDirs(out, path.join(cwd, '.claude', 'skills'), 'project'); addCommands(out, path.join(cwd, '.claude', 'commands'), 'project'); }
  addSkillDirs(out, path.join(CLAUDE, 'skills'), 'user');
  addCommands(out, path.join(CLAUDE, 'commands'), 'command');
  for (const p of enabledPlugins(cwd)) addPlugin(out, p);
  cache.set(k, { t: Date.now(), map: out });
  return out;
}

export const DESC_MAX = 300;
const trim = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function categoryFor(name, hit) {
  if (hit) return hit.category;
  return name.includes(':') ? 'plugin' : 'builtin';
}

/** Accumulates skill_listing events (parser type:'deck') into the session's deck. */
export function createDeck() {
  const names = new Map(); // name -> listing desc
  let initialLine = 0; const deltas = [];
  return {
    feed(e) {
      if (e.initial) { names.clear(); initialLine = e.line; }
      else deltas.push({ line: e.line, names: e.entries.map((x) => x.name) });
      for (const x of e.entries) names.set(x.name, x.desc || names.get(x.name) || '');
    },
    get size() { return names.size; },
    info() { return { initialLine, deltas }; },
    build(cwd, max = DESC_MAX) {
      if (!names.size) return null;
      const fsMap = scanFs(cwd); const out = [];
      for (const [name, d] of names) { const hit = fsMap.get(name); out.push({ name, category: categoryFor(name, hit), description: trim(d || (hit && hit.description) || '', max), source: 'transcript' }); }
      return out;
    },
  };
}
export function fsDeck(cwd, max = DESC_MAX) {
  return [...scanFs(cwd).values()].map((x) => ({ name: x.name, category: x.category, description: trim(x.description, max), source: 'fs' }));
}

/** Quick deck for a transcript file without running the full parser (only lines holding a skill_listing). */
export function deckFromFile(file, { cwd = '', max = DESC_MAX } = {}) {
  const deck = createDeck(); let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { source: 'fs', cards: fsDeck(cwd, max), cwd }; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!cwd && l.includes('"cwd"')) { try { cwd = JSON.parse(l).cwd || ''; } catch {} }
    if (!l.includes('"skill_listing"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.isSidechain || !o.attachment || o.attachment.type !== 'skill_listing') continue;
    const a = o.attachment;
    deck.feed({ line: i + 1, initial: !!a.isInitial, entries: parseListingLite(a.content, a.names || []) });
  }
  const cards = deck.build(cwd, max);
  return cards ? { source: 'transcript', cards, cwd, ...deck.info() } : { source: 'fs', cards: fsDeck(cwd, max), cwd };
}
