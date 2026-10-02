// skill-tank server — binds 127.0.0.1 by default (transcripts contain private content); SKILL_TANK_HOST opts in to LAN.
//   GET /                 index.html
//   GET /api/sessions     recent sessions (~/.claude/projects/*/*.jsonl by mtime)
//   GET /api/stream?session=<id|latest>   SSE: "reset" (full history) then "ev" (live tail)
//   GET /api/deck?session=<id|latest>   deck (牌庫): every skill the session can play ([{name,category,description,source}])
//   GET /api/health
//   GET /table            牌桌: every active session on one table (table.html)
//   GET /table/events.jsonl   table event log (one JSON per line, HTTP Range "bytes=<offset>-"), built by lib/table.mjs
//   GET /table/deck.json      hand cards for the table (union of the active sessions' decks)
//   GET /table/health
//   GET /tank/…           302 → /table/… (old context-tank URLs)
// env: SKILL_TANK_PORT (4700), SKILL_TANK_HOST (127.0.0.1), SKILL_TANK_ROOT (~/.claude/projects; several: ';' separated),
//      SKILL_TANK_EXTRA (extra roots shown as [測試], ';' separated), SKILL_TANK_IDLE_MIN (120: table shows sessions written within N min),
//      SKILL_TANK_HOOK_EVENTS (optional: hook-mode events.jsonl to merge status lines from; "1" = ~/.claude/context-tank/events.jsonl)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createParser } from './lib/parser.mjs';
import { createDeck, deckFromFile, fsDeck } from './lib/deck.mjs';
import { createTable } from './lib/table.mjs';
import { projectName, transcriptCwd } from './lib/names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.SKILL_TANK_PORT || 4700);
// Default stays local-only. Shared hosts (e.g. .7, next to the pixel-agents office view) opt in
// with SKILL_TANK_HOST=0.0.0.0 — the page shows session titles / skill names / context usage, not message text.
const HOST = process.env.SKILL_TANK_HOST || '127.0.0.1';
const ROOTS = (process.env.SKILL_TANK_ROOT || path.join(os.homedir(), '.claude', 'projects')).split(';').map((s) => s.trim()).filter(Boolean);
const ROOT = ROOTS[0];
const EXTRA = (process.env.SKILL_TANK_EXTRA ?? path.join(HERE, 'test-data')).split(';').filter(Boolean);
const IDLE_MIN = +(process.env.SKILL_TANK_IDLE_MIN || process.env.CONTEXT_TANK_IDLE_MIN || 120);
const HOOK_EVENTS = ((v) => (v === '1' ? path.join(os.homedir(), '.claude', 'context-tank', 'events.jsonl') : v))(process.env.SKILL_TANK_HOOK_EVENTS || '');
const VERSION = 'skill-tank server r5';
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="1" fill="#1aa6b8"/></svg>';

function listSessions(limit = 60) {
  const out = [];
  for (const root of [...ROOTS, ...EXTRA]) {
    let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      const dir = path.join(root, d.name);
      let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(dir, f));
          out.push({ id: f.replace(/\.jsonl$/, ''), project: d.name, test: !ROOTS.includes(root), file: path.join(dir, f), mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map((s) => { const cwd = transcriptCwd(s.file); return { ...s, title: tailTitle(s.file, s.size), cwd: cwd || projectToPath(s.project), proj: projectName(cwd, s.project) }; });
}
function projectToPath(p) { return p.replace(/^([A-Za-z])--/, '$1:\\').replace(/-/g, '\\'); }
function tailTitle(file, size) {
  try {
    const n = Math.min(size, 256 * 1024); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('"ai-title"')) { try { return JSON.parse(lines[i]).aiTitle || ''; } catch {} }
  } catch {}
  return '';
}
function findSession(id) {
  const all = listSessions(100000);
  if (!id || id === 'latest') return all.find((s) => !s.test) || all[0];
  return all.find((s) => s.id === id);
}

const clients = new Set();
function stream(req, res, sess) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const parser = createParser({ cwd: '' });
  const deck = createDeck();
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const sendDeck = (reason) => {
    const cwd = parser.state.cwd || sess.cwd; const cards = deck.build(cwd);
    send('deck', cards ? { source: 'transcript', reason, cards, ...deck.info() } : { source: 'fs', reason, cards: fsDeck(cwd) });
  };
  let offset = 0; let partial = ''; let lineNo = 0; let closed = false;
  const readNew = (initial) => {
    if (closed) return;
    let st; try { st = fs.statSync(sess.file); } catch { return; }
    if (st.size < offset) { offset = 0; partial = ''; lineNo = 0; } // truncated / rewritten
    if (st.size === offset) return;
    const fd = fs.openSync(sess.file, 'r'); const len = st.size - offset; const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset); fs.closeSync(fd); offset = st.size;
    const text = partial + buf.toString('utf8'); const lines = text.split('\n'); partial = lines.pop();
    const evs = [];
    let deckChanged = false;
    for (const l of lines) {
      lineNo++; if (!l.trim()) continue;
      for (const e of parser.feed(l, lineNo)) { if (e.type === 'deck') { deck.feed(e); deckChanged = true; } else evs.push(e); }
    }
    if (initial) { send('reset', { session: { id: sess.id, project: sess.project, proj: projectName(parser.state.cwd || transcriptCwd(sess.file), sess.project), cwd: parser.state.cwd || sess.cwd, file: sess.file, size: st.size, lines: lineNo, test: sess.test }, events: evs, server: VERSION }); sendDeck('reset'); }
    else { if (deckChanged) sendDeck('listing'); for (const e of evs) send('ev', e); }
  };
  readNew(true);
  const iv = setInterval(() => readNew(false), 300);
  let w = null; try { w = fs.watch(sess.file, () => readNew(false)); } catch {}
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  const c = { res }; clients.add(c);
  req.on('close', () => { closed = true; clearInterval(iv); clearInterval(hb); if (w) w.close(); clients.delete(c); });
}

const table = createTable({ roots: ROOTS, extra: EXTRA, idleMs: IDLE_MIN * 60e3, hookEvents: HOOK_EVENTS });
// full scan (new / idle / woken-up sessions) every 2 s; active tanks tailed every 300 ms like the single view
table.poll(); setInterval(() => { try { table.poll(); } catch (e) { console.error('[table]', e); } }, 2000);
setInterval(() => { try { table.tick(); } catch (e) { console.error('[table]', e); } }, 300);
function tablePage() {
  // table.html is a full page; the server pins its base (relative fetches → /table/…) and flags live mode
  return fs.readFileSync(path.join(HERE, 'table.html'), 'utf8')
    .replace('<head>', '<head><base href="/table/"><script>window.CONTEXT_TANK_LIVE=true</script>');
}
function serveTable(req, res, sub) {
  const noStore = { 'Cache-Control': 'no-store' };
  if (sub === '' || sub === '/' || sub === '/index.html') { res.writeHead(200, { ...noStore, 'Content-Type': 'text/html; charset=utf-8' }); return res.end(tablePage()); }
  if (sub === '/deck.json') { res.writeHead(200, { ...noStore, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(table.deckJson())); }
  if (sub === '/events.jsonl') {
    const size = table.size; const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const start = m ? Number(m[1]) : 0;
    if (m && start >= size) { res.writeHead(204, { ...noStore, 'X-Size': size }); return res.end(); }
    const body = table.slice(start);
    res.writeHead(m ? 206 : 200, { ...noStore, 'X-Size': size, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Length': body.length, ...(m ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}) });
    return res.end(body);
  }
  if (sub === '/health') { res.writeHead(200, { ...noStore, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, version: VERSION, idleMin: IDLE_MIN, hook: table.hookFile || null, sessions: table.sessions() })); }
  res.writeHead(404); return res.end('not found');
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}`);
  try {
    if (u.pathname === '/favicon.ico' || u.pathname === '/favicon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' }); return res.end(FAVICON); }
    if (u.pathname === '/table' || u.pathname.startsWith('/table/')) return serveTable(req, res, u.pathname.slice(6));
    if (u.pathname === '/tank' || u.pathname.startsWith('/tank/')) { // old context-tank URLs (…/tank/) keep working
      const sub = u.pathname.slice(5); res.writeHead(302, { Location: '/table' + (sub === '/' || sub === '' ? '' : sub) + u.search }); return res.end();
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(HERE, 'index.html')));
    }
    if (u.pathname === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, version: VERSION, root: ROOT, roots: ROOTS, idleMin: IDLE_MIN, clients: clients.size })); }
    if (u.pathname === '/api/sessions') {
      const list = listSessions(+(u.searchParams.get('limit') || 60)).map(({ file, ...s }) => s);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ sessions: list, root: ROOT, roots: ROOTS }));
    }
    if (u.pathname === '/api/deck') {
      // ?session=<id|latest> (default latest) → transcript skill_listing (fs fallback); ?fs[&cwd=…] → fs scan only
      const fsOnly = u.searchParams.has('fs');
      const sess = fsOnly ? null : findSession(u.searchParams.get('session'));
      if (!fsOnly && !sess) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'session not found' })); }
      const d = sess ? deckFromFile(sess.file, { cwd: '' }) : { source: 'fs', cards: fsDeck(u.searchParams.get('cwd') || '') };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ session: sess ? sess.id : null, count: d.cards.length, ...d }));
    }
    if (u.pathname === '/api/stream') {
      const sess = findSession(u.searchParams.get('session'));
      if (!sess) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'session not found' })); }
      return stream(req, res, sess);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
});
server.listen(PORT, HOST, () => console.log(`[skill-tank] ${VERSION} http://${HOST}:${PORT}/ (+ /table)  roots=${ROOTS.join(';')}  extra=${EXTRA.join(';')}  idle=${IDLE_MIN}min${HOOK_EVENTS ? '  hook=' + HOOK_EVENTS : ''}`));
