// skill-tank "table" (牌桌) — every active session on one table, one tank each.
// Same parser as the single-session view (lib/parser.mjs); its events are turned into the compact
// event log the table page polls (events.jsonl + HTTP Range), one JSON object per line:
//   {type:"session", session, title, aiTitle, cwd, project, test, compacts, snap?}
//   {type:"status",  session, used, size, compactAt, model, src?}      compactAt = (limit − 33K) / limit
//   {type:"skill",   session, ts, skill:{name, desc, tokens, source}, snap?}
//   {type:"compact", session, ts, trigger, pre, post}
//   {type:"kept",    session, ts, names:[…], snap?}                     invoked_skills re-injected after a compaction
//   {type:"end",     session, ts, reason:"idle"}
// A session gets a tank while its transcript was written within IDLE minutes. When a file is first picked up
// (server start, or an idle session wakes up) its whole history is parsed silently and only a snapshot is logged
// (snap:true → the page places the cards without the throw animation).
import fs from 'node:fs';
import path from 'node:path';
import { createParser, COMPACT_RESERVE, estTokens, parseFrontmatter } from './parser.mjs';
import { createDeck, fsDeck, scanFs } from './deck.mjs';
import { projectName } from './names.mjs';

const MAX_LOG = 4 * 1024 * 1024;
const prettyModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}(?=$|\[)/, '')
  .replace(/-(\d+)(?:-(\d+))?/, (_, a, b) => ' ' + a + (b ? '.' + b : '')).replace(/\[1m\]/i, ' 1M').replace(/^(\w)/, (c) => c.toUpperCase());
const projectToPath = (p) => p.replace(/^([A-Za-z])--/, '$1:\\').replace(/-/g, '\\');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

const tokCache = new Map();
function skillTokens(dir) {
  if (!dir) return 0;
  if (tokCache.has(dir)) return tokCache.get(dir);
  let n = 0;
  for (const f of [path.join(dir, 'SKILL.md'), path.join(dir, 'skill.md'), dir.endsWith('.md') ? dir : '']) {
    if (!f) continue;
    try { n = estTokens(parseFrontmatter(fs.readFileSync(f, 'utf8')).body); break; } catch {}
  }
  tokCache.set(dir, n); return n;
}

/**
 * @param {{roots:string[], extra?:string[], idleMs:number, hookEvents?:string, log?:Function}} o
 */
export function createTable({ roots, extra = [], idleMs, hookEvents = '', log = () => {} }) {
  const files = new Map(); // file -> F
  let chunks = []; let size = 0;
  const emit = (ev) => { const b = Buffer.from(JSON.stringify(ev) + '\n'); chunks.push(b); size += b.length; };

  function listFiles() {
    const out = [];
    for (const [root, test] of [...roots.map((r) => [r, false]), ...extra.map((r) => [r, true])]) {
      let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
      for (const d of dirs) {
        const dir = path.join(root, d.name);
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(dir, e.name), project: d.name, test });
      }
    }
    return out;
  }

  function newF(file, project, test) {
    const id = path.basename(file, '.jsonl');
    return {
      file, id, project, test, offset: 0, partial: '', lineNo: 0, parser: createParser({ cwd: '' }), deck: createDeck(),
      tracked: false, ended: true, mtime: 0, aiTitle: '', used: 0, limit: 200000, threshold: 200000 - COMPACT_RESERVE,
      model: '', modelAttr: '', cards: [], prevCards: [], compacts: 0, hookSize: 0, deckRev: 0,
    };
  }
  const cwdOf = (F) => F.parser.state.cwd || projectToPath(F.project);
  // tank title = project folder name (+ the session's ai-title on the page): "my-app · Fix login bug"
  const projOf = (F) => projectName(F.parser.state.cwd, F.project) || F.id.slice(0, 8);
  const titleOf = (F) => (F.test ? '[測試] ' : '') + projOf(F);
  const sizeOf = (F) => Math.max(F.limit, F.hookSize || 0);
  const statusEv = (F, src) => {
    const sz = sizeOf(F); const thr = F.hookSize > F.limit ? F.hookSize - COMPACT_RESERVE : F.threshold;
    return { type: 'status', session: F.id, used: F.used, size: sz, compactAt: +(thr / sz).toFixed(4), model: F.model, ...(src ? { src } : {}) };
  };
  const sessionEv = (F, snap) => ({ type: 'session', session: F.id, title: titleOf(F), proj: projOf(F), aiTitle: F.aiTitle, cwd: cwdOf(F), project: F.project, test: F.test, compacts: F.compacts, ...(snap ? { snap: true } : {}) });
  const cardOf = (e) => ({ name: e.name, desc: String(e.desc || '').slice(0, 200), tokens: e.est || skillTokens(e.dir), source: e.category, ts: Date.parse(e.t || '') || 0 });

  function snapshot(F, ts) {
    emit(sessionEv(F, true));
    for (const c of F.cards) emit({ type: 'skill', session: F.id, ts: c.ts, snap: true, skill: { name: c.name, desc: c.desc, tokens: c.tokens, source: c.source } });
    emit(statusEv(F));
    void ts;
  }

  // parser events → per-session state (+ log lines when live)
  function apply(F, e, live) {
    const ts = Date.parse(e.t || '') || Date.now();
    switch (e.type) {
      case 'title': F.aiTitle = e.title; if (live) emit(sessionEv(F)); break;
      case 'model': F.modelAttr = e.model; F.model = prettyModel(e.model); break;
      case 'limit': F.limit = e.limit; F.threshold = e.threshold; if (live) emit(statusEv(F)); break;
      case 'usage':
        if (!F.modelAttr && e.model) F.model = prettyModel(e.model);
        F.used = e.ctx; if (live) emit(statusEv(F)); break;
      case 'skill': { const c = cardOf(e); F.cards.push(c); if (live) emit({ type: 'skill', session: F.id, ts: c.ts || ts, skill: { name: c.name, desc: c.desc, tokens: c.tokens, source: c.source } }); break; }
      case 'compact':
        F.compacts++; F.prevCards = F.cards; F.cards = []; if (e.post) F.used = e.post;
        if (live) emit({ type: 'compact', session: F.id, ts, trigger: e.trigger, pre: e.pre, post: e.post }); break;
      case 'kept': {
        if (!e.afterCompact) break;
        const seen = new Set(); const kept = [];
        for (const n of e.names) {
          if (seen.has(n)) continue; seen.add(n);
          const prev = [...F.prevCards].reverse().find((c) => c.name === n);
          kept.push(prev ? { ...prev } : { name: n, desc: '', tokens: 0, source: 'user', ts });
        }
        F.cards = kept.concat(F.cards);
        if (live) emit({ type: 'kept', session: F.id, ts, names: [...seen] });
        break;
      }
      case 'deck': F.deck.feed(e); F.deckRev++; break;
    }
  }

  function readNew(F, live) {
    let st; try { st = fs.statSync(F.file); } catch { return false; }
    F.mtime = st.mtimeMs;
    if (st.size < F.offset) { // rewritten: start over
      const keep = { tracked: F.tracked, ended: F.ended }; Object.assign(F, newF(F.file, F.project, F.test), keep); live = false;
    }
    if (st.size === F.offset) return false;
    const fd = fs.openSync(F.file, 'r'); const len = st.size - F.offset; const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, F.offset); fs.closeSync(fd); F.offset = st.size;
    const lines = (F.partial + buf.toString('utf8')).split('\n'); F.partial = lines.pop();
    for (const l of lines) { F.lineNo++; if (!l.trim()) continue; for (const e of F.parser.feed(l, F.lineNo)) apply(F, e, live); }
    return true;
  }

  function poll() {
    const now = Date.now();
    for (const { file, project, test } of listFiles()) {
      let F = files.get(file);
      let st; try { st = fs.statSync(file); } catch { continue; }
      const active = now - st.mtimeMs <= idleMs;
      if (!F) { if (!active) continue; F = newF(file, project, test); files.set(file, F); }
      if (F.ended) {
        if (!active) continue;
        // (re)activate: catch up silently, then log a snapshot of the tank as it is now
        readNew(F, false); F.ended = false; F.tracked = true; snapshot(F, now);
        continue;
      }
      readNew(F, true);
      if (now - F.mtime > idleMs) { F.ended = true; emit({ type: 'end', session: F.id, ts: now, reason: 'idle' }); }
    }
    // files that disappeared
    for (const F of files.values()) if (!F.ended && !fs.existsSync(F.file)) { F.ended = true; emit({ type: 'end', session: F.id, ts: now, reason: 'gone' }); }
    if (hook) hook.poll();
    if (size > MAX_LOG) rebuild();
  }
  // fast path between full scans: tail only the tanks already on the table
  function tick() {
    for (const F of files.values()) if (!F.ended) readNew(F, true);
    if (hook) hook.poll();
  }
  // keep memory bounded: the page sees the log shrink and re-reads it from the start
  function rebuild() { chunks = []; size = 0; for (const F of files.values()) if (!F.ended) snapshot(F, Date.now()); }

  // ---- optional: hook mode events (hooks/statusline.mjs writes {type:"status", session, used, size}) ----
  // Only status lines are merged: the status line reports Claude Code's own context_window_size and current usage.
  // Skills / compactions keep coming from the transcript (the hook copies would be duplicates).
  const hook = hookEvents ? (() => {
    let off = 0; let part = ''; let primed = false;
    return {
      file: hookEvents,
      poll() {
        let st; try { st = fs.statSync(hookEvents); } catch { return; }
        if (st.size < off) { off = 0; part = ''; }
        if (!primed) { off = st.size; primed = true; return; } // start from "now": old hook lines are history
        if (st.size === off) return;
        const fd = fs.openSync(hookEvents, 'r'); const buf = Buffer.alloc(st.size - off); fs.readSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); off = st.size;
        const lines = (part + buf.toString('utf8')).split('\n'); part = lines.pop();
        for (const l of lines) {
          let o; try { o = JSON.parse(l); } catch { continue; }
          if (!o || o.type !== 'status' || !o.session) continue;
          const F = [...files.values()].find((x) => x.id === o.session && !x.ended); if (!F) continue;
          if (o.size) F.hookSize = o.size;
          if (typeof o.used === 'number') F.used = o.used;
          emit(statusEv(F, 'hook'));
        }
      },
    };
  })() : null;

  // ---- deck.json: union of the active sessions' skill_listing decks (fs scan when none has one) ----
  let deckCache = null;
  function deckJson() {
    const act = [...files.values()].filter((F) => !F.ended);
    const key = act.map((F) => F.id + ':' + F.deckRev).join(',');
    if (deckCache && deckCache.key === key && Date.now() - deckCache.t < 30000) return deckCache.body;
    const out = new Map();
    for (const F of act) {
      const cwd = cwdOf(F); const cards = F.deck.build(cwd) || []; const fsMap = scanFs(cwd);
      for (const c of cards) if (!out.has(c.name)) { const hit = fsMap.get(c.name); out.set(c.name, { name: c.name, desc: c.description, tokens: skillTokens(hit && hit.dir), source: c.category }); }
    }
    if (!out.size) {
      const fsMap = scanFs('');
      for (const c of fsDeck('')) { const hit = fsMap.get(c.name); out.set(c.name, { name: c.name, desc: c.description, tokens: skillTokens(hit && hit.dir), source: c.category }); }
    }
    const skills = [...out.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
    const body = { updated: Date.now(), source: act.some((F) => F.deck.size) ? 'transcript' : 'fs', skills };
    deckCache = { key, t: Date.now(), body }; return body;
  }

  return {
    poll,
    tick,
    deckJson,
    get size() { return size; },
    slice(start) { if (start >= size) return Buffer.alloc(0); if (chunks.length > 1) chunks = [Buffer.concat(chunks)]; const all = chunks[0]; return all.subarray(start); },
    /** active sessions as the parser sees them (for /table/health and the verifier) */
    sessions() {
      return [...files.values()].filter((F) => !F.ended).map((F) => ({
        id: F.id, title: titleOf(F), proj: projOf(F), aiTitle: F.aiTitle, project: F.project, test: F.test, used: F.used, size: sizeOf(F),
        limit: F.limit, threshold: F.threshold, compactAt: statusEv(F).compactAt, cards: F.cards.length, compacts: F.compacts, mtime: F.mtime,
      }));
    },
    hookFile: hook ? hook.file : '',
    log,
  };
}
