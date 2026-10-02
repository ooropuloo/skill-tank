// Claude Code transcript (.jsonl) → skill-tank events.
// Incremental: feed one line at a time; returns zero or more events.
// Format facts (verified against real files on 2026-10-01, see README "資料格式查證"):
//   context  = usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens  (main chain only)
//   skill    = assistant tool_use name=="Skill" (+ user isMeta "Base directory for this skill: ..." with sourceToolUseID)
//            | user string "<command-name>/x</command-name>" followed by isMeta "Base directory for this skill: ..."
//   compact  = {type:"system", subtype:"compact_boundary", compactMetadata:{trigger, preTokens, postTokens}}
//              then attachment {type:"invoked_skills", skills:[{name,path,content}]} = skills re-injected after compaction
import fs from 'node:fs';
import path from 'node:path';

export const LIMIT_STD = 200_000;
export const LIMIT_1M = 1_000_000;
// Empirical: every auto compaction observed fired at preTokens ≈ limit − 33K
// (200K sessions: 167.3K–169.5K; 1M sessions: 967.4K–972.8K). 33K = 20K output reserve + 13K buffer.
export const COMPACT_RESERVE = 33_000;

const BASE_RE = /^Base directory for this skill:\s*(.+?)\s*(?:\r?\n|$)/;
const CMD_START_RE = /^\s*<command-(?:message|name)>/;
const CMD_RE = /<command-name>\/?([^<\s]+)<\/command-name>/;
const ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

export function estTokens(s) {
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) { const c = ch.codePointAt(0); if (c >= 0x2e80 && c <= 0xffef) cjk++; }
  return Math.round(cjk * 1.0 + (s.length - cjk) / 3.6);
}

export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(lines[i]);
    if (!km) continue;
    let v = km[2].trim();
    if (v === '|' || v === '>' || v === '|-' || v === '>-' || v === '') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[A-Za-z_][\w-]*:\s/.test(lines[i + 1])) v += ' ' + lines[++i].trim();
    }
    fm[km[1]] = v.replace(/^["']|["']$/g, '');
  }
  return { fm, body: text.slice(m[0].length) };
}

const descCache = new Map();
function diskDescription(dir) {
  if (!dir) return '';
  if (descCache.has(dir)) return descCache.get(dir);
  let d = '';
  for (const f of ['SKILL.md', 'skill.md']) {
    try { d = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8')).fm.description || ''; if (d) break; } catch {}
  }
  if (!d) { try { d = parseFrontmatter(fs.readFileSync(dir + '.md', 'utf8')).fm.description || ''; } catch {} }
  descCache.set(dir, d); return d;
}

export function categorize(dir, name, cwd) {
  const p = (dir || '').replace(/\//g, '\\').toLowerCase();
  if (p.includes('\\.claude\\plugins\\')) return 'plugin';
  if (p.includes('\\.claude\\commands\\')) return 'command';
  if (cwd && p.startsWith(cwd.replace(/\//g, '\\').toLowerCase()) && p.includes('\\.claude\\skills\\')) return 'project';
  if (p.includes('\\.claude\\skills\\')) return 'user';
  if (name && name.includes(':')) return 'plugin';
  return dir ? 'user' : 'command';
}

function skillInfo(content, dir) {
  const body0 = (content || '').replace(BASE_RE, '');
  const { fm, body } = parseFrontmatter(body0.replace(/^\s+/, ''));
  const desc = fm.description || diskDescription(dir) || '';
  const lines = body.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^```/.test(l) && !/^[|>-]{1,3}$/.test(l) && !/^\|[-\s|:]+\|$/.test(l));
  const head = (/^#\s+(.+)$/m.exec(body) || [])[1] || '';
  return { desc, title: head, preview: lines.slice(0, 4).join('\n').slice(0, 400), est: estTokens(content), chars: (content || '').length };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

export function createParser({ cwd = '' } = {}) {
  const st = {
    cwd, lastCtx: 0, maxCtx: 0, model: '', modelAttr: '', seenReq: new Set(),
    pendingTool: new Map(), // tool_use_id -> {name, t, line, ctxBefore}
    pendingCmd: null, awaitingDelta: [], limit: 0, threshold: 0, nSkill: 0, inCompact: null,
  };
  let seq = 0;
  const out = [];
  const push = (e) => { e.seq = ++seq; out.push(e); };

  function limitFor() {
    const oneM = /\[1m\]/i.test(st.modelAttr) || /\[1m\]/i.test(st.model) || st.maxCtx > LIMIT_STD;
    return oneM ? LIMIT_1M : LIMIT_STD;
  }
  function checkLimit(reason) {
    const lim = limitFor();
    if (lim !== st.limit) { st.limit = lim; st.threshold = lim - COMPACT_RESERVE; push({ type: 'limit', limit: lim, threshold: st.threshold, reason }); }
  }

  function emitSkill(p, content, dir, source) {
    const info = skillInfo(content, dir);
    const e = {
      type: 'skill', id: 'L' + p.line, line: p.line, t: p.t, name: p.name, source, args: p.args || '',
      category: categorize(dir, p.name, st.cwd), dir: dir || '', ctxBefore: st.lastCtx, delta: null, ...info,
    };
    st.nSkill++; push(e); st.awaitingDelta.push(e);
  }

  function feed(line, lineNo) {
    out.length = 0;
    let o; try { o = JSON.parse(line); } catch { return out.slice(); }
    if (!o || typeof o !== 'object') return [];
    if (o.isSidechain) return [];
    const t = o.timestamp || null;
    if (!st.cwd && o.cwd) st.cwd = o.cwd;

    if (o.type === 'ai-title' && o.aiTitle) push({ type: 'title', title: o.aiTitle });

    if (o.type === 'attachment' && o.attachment) {
      const a = o.attachment;
      if (a.type === 'model' && a.identity && a.identity.modelId) { st.modelAttr = a.identity.modelId; push({ type: 'model', model: st.modelAttr, line: lineNo, t }); checkLimit('model attachment ' + st.modelAttr); }
      if (a.type === 'skill_listing' && Array.isArray(a.names)) {
        // the list Claude Code shows the model ("- name: description"); first one isInitial, later ones are deltas
        push({ type: 'deck', line: lineNo, t, initial: !!a.isInitial, count: a.skillCount ?? a.names.length, entries: parseListing(a.content || '', a.names) });
      }
      if (a.type === 'invoked_skills' && Array.isArray(a.skills)) {
        push({ type: 'kept', line: lineNo, t, names: a.skills.map((s) => s.name), afterCompact: !!st.inCompact });
      }
    }

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const m = o.compactMetadata || {};
      st.inCompact = { line: lineNo };
      if (m.preTokens > st.maxCtx) st.maxCtx = m.preTokens;
      checkLimit('preTokens');
      push({ type: 'compact', line: lineNo, t, trigger: m.trigger || 'auto', pre: m.preTokens || st.lastCtx, post: m.postTokens ?? null, durationMs: m.durationMs || null });
      st.lastCtx = m.postTokens || 0; st.awaitingDelta = []; st.pendingCmd = null;
    }

    if (o.type === 'assistant' && o.message) {
      const m = o.message; const u = m.usage;
      if (m.model && m.model !== '<synthetic>') st.model = m.model;
      const rid = o.requestId || m.id;
      if (u && !(rid && st.seenReq.has(rid))) {
        if (rid) st.seenReq.add(rid);
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (ctx > 0) {
          // flush Skill tool calls that succeeded but never got a "Base directory" message
          for (const [id, p] of st.pendingTool) if (p.ok) { emitSkill(p, '', '', 'tool'); st.pendingTool.delete(id); }
          if (st.pendingCmd && st.pendingCmd.ok) emitSkill(st.pendingCmd, st.pendingCmd.content || '', '', 'slash');
          st.pendingCmd = null;
          for (const e of st.awaitingDelta) push({ type: 'skillcost', id: e.id, delta: ctx - e.ctxBefore, ctxAfter: ctx });
          st.awaitingDelta = [];
          if (ctx > st.maxCtx) st.maxCtx = ctx;
          st.lastCtx = ctx; st.inCompact = null;
          push({ type: 'usage', line: lineNo, t, ctx, out: u.output_tokens || 0, model: st.model });
          checkLimit('usage ' + ctx);
        }
      }
      if (Array.isArray(m.content)) for (const c of m.content) {
        if (c && c.type === 'tool_use' && c.name === 'Skill' && c.input && c.input.skill) {
          st.pendingTool.set(c.id, { name: String(c.input.skill).replace(/^\//, ''), args: c.input.args || '', t, line: lineNo, ctxBefore: st.lastCtx });
        }
      }
    }

    if (o.type === 'user' && o.message) {
      const content = o.message.content;
      if (Array.isArray(content)) for (const c of content) {
        if (c && c.type === 'tool_result' && st.pendingTool.has(c.tool_use_id)) {
          const p = st.pendingTool.get(c.tool_use_id);
          const ok = !c.is_error && !(o.toolUseResult && o.toolUseResult.success === false);
          if (ok) p.ok = true; else st.pendingTool.delete(c.tool_use_id);
        }
      }
      const text = textOf(content);
      const bm = BASE_RE.exec(text);
      if (bm) {
        const dir = bm[1].replace(/\\\\/g, '\\');
        if (o.sourceToolUseID && st.pendingTool.has(o.sourceToolUseID)) {
          const p = st.pendingTool.get(o.sourceToolUseID); st.pendingTool.delete(o.sourceToolUseID);
          emitSkill(p, text, dir, 'tool');
        } else if (st.pendingCmd) {
          const p = st.pendingCmd; st.pendingCmd = null;
          emitSkill(p, text, dir, 'slash');
        }
      } else if (typeof content === 'string' && !o.isMeta) {
        const cm = CMD_START_RE.test(content) && CMD_RE.exec(content);
        if (cm) {
          const am = ARGS_RE.exec(content);
          st.pendingCmd = { name: cm[1], args: am ? am[1].trim() : '', t, line: lineNo, ctxBefore: st.lastCtx, ok: false };
        }
      } else if (o.isMeta && st.pendingCmd && text && !st.pendingCmd.content) {
        // custom command (~/.claude/commands/x.md) expands into an isMeta prompt without "Base directory"
        if (commandFileExists(st.pendingCmd.name, st.cwd)) { st.pendingCmd.ok = true; st.pendingCmd.content = text; }
      }
    }
    if (o.type === 'system' && o.subtype === 'local_command') st.pendingCmd = null; // built-in (/clear, /model …)
    return out.slice();
  }

  return { feed, state: st };
}

// skill_listing.content: one "- <name>" or "- <name>: <description>" line per name (same order as names[]);
// a description can continue on following lines that do not start with "- ".
export function parseListing(content, names) {
  const set = new Set(names); const desc = new Map(); let cur = null;
  for (const line of String(content).split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      const rest = line.slice(2); let nm = null;
      if (set.has(rest.trim())) nm = rest.trim();
      else { const i = rest.indexOf(': '); if (i > 0 && set.has(rest.slice(0, i))) nm = rest.slice(0, i); }
      if (nm) { cur = nm; desc.set(nm, nm === rest.trim() ? '' : rest.slice(nm.length + 2).trim()); continue; }
    }
    if (cur && line.trim()) desc.set(cur, (desc.get(cur) + ' ' + line.trim()).trim());
  }
  return names.map((n) => ({ name: n, desc: desc.get(n) || '' }));
}

function commandFileExists(name, cwd) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const rel = name.replace(/:/g, path.sep) + '.md';
  return [path.join(home, '.claude', 'commands', rel), cwd ? path.join(cwd, '.claude', 'commands', rel) : ''].some((f) => f && fs.existsSync(f));
}

// Parse a whole file → {events, state}
export function parseFile(file, opts = {}) {
  const p = createParser(opts);
  const events = [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim()) events.push(...p.feed(lines[i], i + 1)); }
  return { events, state: p.state, parser: p, bytes: Buffer.byteLength(text, 'utf8'), lines: lines.length };
}
