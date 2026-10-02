// node tools/verify-table.mjs   — headless Chrome (GPU) acceptance test for the 牌桌 view (/table) of the running server
//   1. tanks == active sessions (transcripts written within SKILL_TANK_IDLE_MIN), each tank's level vs. lib/parser.mjs (< 0.5 pp),
//      no tank above 100% (1M sessions), compaction line = (limit − 33K) / limit
//   2. copy a real jsonl into test-data/live → a new tank appears; append a Skill event → that tank +1 card within 2 s
//   3. tank title link → /?session=<id> opens the single-session view of that session; the single view links back to /table
//   4. demo mode (/table?demo): drop a card, overflow/compaction, drain
//   5. phone 390×844 (touch): /table panel collapsed and clear of the tanks; / HUD has the link
//   6. /tank/ → 302 /table, /favicon.ico 200, 0 console errors everywhere
// env: SKILL_TANK_URL (default http://127.0.0.1:4700/), SKILL_TANK_ROOT (same as the server), SKILL_TANK_IDLE_MIN (120)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseFile, LIMIT_STD } from '../lib/parser.mjs';
import { cwdOf, SKILLS_DIR } from './sessions.mjs';
import { launch } from './browser.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = (process.env.SKILL_TANK_URL || 'http://127.0.0.1:4700/').replace(/\/?$/, '/');
const ROOTS = (process.env.SKILL_TANK_ROOT || path.join(os.homedir(), '.claude', 'projects')).split(';').filter(Boolean);
const EXTRA = [path.join(HERE, 'test-data')];
const IDLE_MS = +(process.env.SKILL_TANK_IDLE_MIN || 120) * 60e3;
const SHOTS = path.join(HERE, 'docs', 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function activeFiles() {
  const out = []; const now = Date.now();
  for (const root of [...ROOTS, ...EXTRA]) {
    let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      let ents = []; try { ents = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
      for (const f of ents) if (f.endsWith('.jsonl')) { const p = path.join(root, d.name, f); try { if (now - fs.statSync(p).mtimeMs <= IDLE_MS) out.push(p); } catch {} }
    }
  }
  return out;
}
// what the single-session parser says about a file: current ctx (post-compaction size until the next reply) / limit
function parserLevel(file) {
  const { events } = parseFile(file); let ctx = 0; let lim = LIMIT_STD; let thr = LIMIT_STD - 33000;
  for (const e of events) { if (e.type === 'usage') ctx = e.ctx; else if (e.type === 'compact' && e.post) ctx = e.post; else if (e.type === 'limit') { lim = e.limit; thr = e.threshold; } }
  return { ctx, lim, thr, pct: ctx / lim, cards: null };
}

const b = await launch();
const allErrors = [];
async function open(url, opt = {}) {
  const ctx = await b.newContext({ viewport: opt.vp || { width: 1440, height: 860 }, ...(opt.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const p = await ctx.newPage(); const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await p.goto(url); await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return { p, errors, ctx };
}
const tstats = (p) => p.evaluate(() => window.__table.stats());
const done = async (o, label) => { ok(o.errors.length === 0, `${label}: console errors ${o.errors.join(' | ') || 0}`); allErrors.push(...o.errors); await o.ctx.close(); };

// ---------- 0. plain HTTP ----------
{
  const r = await fetch(BASE + 'tank/', { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === '/table', `/tank/ → ${r.status} ${r.headers.get('location')}`);
  const f = await fetch(BASE + 'favicon.ico'); ok(f.status === 200, `/favicon.ico ${f.status}`);
  const h = await (await fetch(BASE + 'api/health')).json(); ok(/r4$/.test(h.version), `/api/health version "${h.version}"`);
  const th = await (await fetch(BASE + 'table/health')).json(); ok(/r4$/.test(th.version), `/table/health version "${th.version}" (${th.sessions.length} sessions)`);
}

// ---------- 1. tanks == active sessions, levels == parser ----------
let SID0 = null;
{
  const o = await open(BASE + 'table');
  await o.p.waitForFunction(() => window.__table.stats().mode === 'live', null, { timeout: 15000 });
  await sleep(4500);
  const files = activeFiles();
  const st = await tstats(o.p);
  console.log(`active transcripts ${files.length}: ${files.map((f) => path.basename(f, '.jsonl').slice(0, 8)).join(', ')}`);
  console.log('tanks', JSON.stringify(st.sessions.map((s) => ({ id: s.id.slice(0, 8), t: s.title, pct: +(s.pct * 100).toFixed(2), size: s.size, at: s.compactAt, cards: s.cards }))));
  ok(st.sessions.length === files.length && files.length > 0, `tanks ${st.sessions.length} == active sessions ${files.length}`);
  for (const f of files) {
    const id = path.basename(f, '.jsonl'); let s = st.sessions.find((x) => x.id === id);
    let P = parserLevel(f);
    if (s && Math.abs(s.used / s.size - P.pct) * 100 >= 0.5) { await sleep(1800); s = (await tstats(o.p)).sessions.find((x) => x.id === id); P = parserLevel(f); } // session moved on mid-check
    if (!s) { ok(false, `tank for ${id.slice(0, 8)} missing`); continue; }
    const d = Math.abs(s.used / s.size - P.pct) * 100;
    ok(d < 0.5, `${id.slice(0, 8)} ${s.title}: page ${(s.used / s.size * 100).toFixed(2)}% vs parser ${(P.pct * 100).toFixed(2)}% (Δ ${d.toFixed(3)} pp) limit ${s.size}/${P.lim}`);
    ok(s.size === P.lim && Math.abs(s.compactAt - P.thr / P.lim) < 1e-3, `${id.slice(0, 8)}: compaction line ${(s.compactAt * 100).toFixed(1)}% == (limit−33K)/limit ${(P.thr / P.lim * 100).toFixed(1)}%`);
    ok(s.pct <= 1 && s.shown <= 1.0001, `${id.slice(0, 8)}: ≤100% (target ${(s.pct * 100).toFixed(1)}%, shown ${(s.shown * 100).toFixed(1)}%)`);
  }
  const th = await (await fetch(BASE + 'table/health')).json(); const st1 = await tstats(o.p);
  for (const h of th.sessions) { const s = st1.sessions.find((x) => x.id === h.id); const want = h.title + (h.aiTitle ? ' · ' + h.aiTitle : '');
    ok(s && s.label === want && s.label.startsWith(h.proj), `tank label "${s && s.label}" == "project · title" (${h.proj})`); }
  const labels = await o.p.$$eval('.pl strong', (els) => els.map((e) => parseFloat(e.textContent)));
  ok(labels.length === st.sessions.length && labels.every((x) => x <= 100), `level labels ${labels.join('%, ')}% all ≤ 100%`);
  SID0 = st.sessions[0] && st.sessions[0].id;
  await o.p.screenshot({ path: path.join(SHOTS, 'table-01-live.png') });

  // ---------- 2. new session appears, live Skill append → +1 card within 2 s ----------
  // copy the active real transcript whose tank has the most cards (keeps the test independent of session ids)
  const real = st.sessions.filter((x) => !x.test).sort((x, y) => y.cards - x.cards)[0];
  const SRC = files.find((f) => real && path.basename(f, '.jsonl') === real.id) || files[0];
  const inTank = (() => { let names = []; for (const e of parseFile(SRC).events) { if (e.type === 'compact') names = []; else if (e.type === 'kept' && e.afterCompact) names = [...e.names]; else if (e.type === 'skill') names.push(e.name); } return names; })();
  const KEEP2 = inTank.find((n) => n !== 'skill-tank');
  const dir = path.join(HERE, 'test-data', 'live'); fs.mkdirSync(dir, { recursive: true });
  const tid = '00000000-test-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const tf = path.join(dir, tid + '.jsonl'); fs.copyFileSync(SRC, tf);
  let t0 = Date.now(); let s0 = null;
  while (Date.now() - t0 < 8000) { s0 = (await tstats(o.p)).sessions.find((x) => x.id === tid); if (s0 && s0.used > 0) break; await sleep(150); }
  ok(!!s0, `copied transcript → new tank in ${Date.now() - t0} ms (${s0 && s0.title}, ${s0 && s0.cards} cards, ${s0 && (s0.pct * 100).toFixed(1)}%)`);
  await sleep(2500); s0 = (await tstats(o.p)).sessions.find((x) => x.id === tid);
  const now = new Date().toISOString(); const tu = 'toolu_test_' + Date.now();
  const base = { isSidechain: false, sessionId: tid, cwd: cwdOf(SRC), userType: 'external' };
  const lines = [
    { ...base, type: 'assistant', timestamp: now, requestId: 'req_tbl_a', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Skill', input: { skill: 'skill-tank' } }], usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: s0.used - 1002, output_tokens: 50 } } },
    { ...base, type: 'user', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Launching skill: skill-tank' }] }, toolUseResult: { success: true, commandName: 'skill-tank' } },
    { ...base, type: 'user', timestamp: now, isMeta: true, sourceToolUseID: tu, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: ' + path.join(SKILLS_DIR, 'skill-tank') + '\n\n# skill-tank (fake test event)\n\nAppended by tools/verify-table.mjs.' }] } },
  ];
  t0 = Date.now(); fs.appendFileSync(tf, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  let s1 = s0; let flew = false;
  while (Date.now() - t0 < 4000) { const st2 = await tstats(o.p); s1 = st2.sessions.find((x) => x.id === tid); if (st2.fly) flew = true; if (s1.cards > s0.cards) break; await sleep(80); }
  const dt = Date.now() - t0;
  ok(s1.cards === s0.cards + 1 && dt <= 2000, `append Skill → tank cards ${s0.cards} → ${s1.cards} in ${dt} ms (≤ 2000)`);
  await sleep(350); await o.p.screenshot({ path: path.join(SHOTS, 'table-02-live-append.png') });
  ok(flew, 'card was thrown from the hand (flying card seen)');
  // live compaction: compact_boundary + invoked_skills → overflow, only the re-injected skills stay, level = postTokens
  const cs = await tstats(o.p).then((x) => x.sessions.find((y) => y.id === tid));
  const ct = new Date().toISOString();
  fs.appendFileSync(tf, [
    { ...base, type: 'system', subtype: 'compact_boundary', timestamp: ct, content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: cs.used, postTokens: 23336 } },
    { ...base, type: 'user', timestamp: ct, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'summary (fake)' } },
    { ...base, type: 'attachment', timestamp: ct, attachment: { type: 'invoked_skills', skills: [{ name: 'skill-tank', path: 'x', content: '' }, ...(KEEP2 ? [{ name: KEEP2, path: 'x', content: '' }] : [])] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  t0 = Date.now(); let sawOverflow = false; let sc = cs;
  while (Date.now() - t0 < 9000) { sc = (await tstats(o.p)).sessions.find((y) => y.id === tid); if (sc.phase === 'overflow') { if (!sawOverflow) { sawOverflow = true; await o.p.screenshot({ path: path.join(SHOTS, 'table-02b-live-compact.png') }); } } if (sawOverflow && !sc.phase) break; await sleep(120); }
  console.log('after live compaction', JSON.stringify(sc));
  ok(sawOverflow, 'live compact_boundary → overflow animation');
  const wantKept = KEEP2 ? 2 : 1;
  ok(sc.compacts === cs.compacts + 1 && sc.cards === wantKept && sc.meshes === wantKept, `live compaction: kept ${sc.cards} cards == invoked_skills (skill-tank${KEEP2 ? ' + ' + KEEP2 : ''}), compactions ${cs.compacts} → ${sc.compacts}`);
  ok(sc.used === 23336, `live compaction: level = postTokens (${sc.used})`);
  // the copy goes away → its tank goes away
  fs.rmSync(tf); t0 = Date.now(); let gone = false;
  while (Date.now() - t0 < 8000) { if (!(await tstats(o.p)).sessions.some((x) => x.id === tid)) { gone = true; break; } await sleep(200); }
  ok(gone, `removed transcript → tank removed in ${Date.now() - t0} ms`);

  // ---------- 3. tank link → single-session view ----------
  const st3 = await tstats(o.p); const target = st3.sessions[0];
  const idx = 0; const link = o.p.locator('#labels .tl a').nth(idx);
  const href = await link.getAttribute('href');
  ok(href === '../?session=' + encodeURIComponent(target.id), `tank title link href ${href}`);
  await Promise.all([o.p.waitForURL((u) => u.pathname === '/' && u.searchParams.get('session') === target.id, { timeout: 10000 }), link.click()]);
  await o.p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 }); await sleep(2500);
  const single = await o.p.evaluate(() => ({ sid: document.getElementById('hSid').textContent, link: document.getElementById('toTable').getAttribute('href'), linkVisible: !document.getElementById('toTable').hidden, ver: document.getElementById('ver').textContent }));
  ok(single.sid.includes(target.id) && single.linkVisible && single.link === '/table', `single view opened for ${target.id.slice(0, 8)} (hSid "${single.sid}"), link back "${single.link}"`);
  ok(/r4$/.test(single.ver), `single view footer "${single.ver}"`);
  await o.p.screenshot({ path: path.join(SHOTS, 'table-03-single-from-table.png') });
  await Promise.all([o.p.waitForURL((u) => u.pathname === '/table', { timeout: 10000 }), o.p.click('#toTable')]);
  await o.p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  const ver = await o.p.$eval('#ver', (e) => e.textContent); ok(/table build .* r4$/.test(ver), `back on /table, footer "${ver}"`);
  await done(o, 'live table');
}

// ---------- 4. demo ----------
{
  const o = await open(BASE + 'table?demo');
  await sleep(1500);
  const a = await tstats(o.p);
  ok(a.mode === 'demo' && a.sessions.length === 2, `demo: ${a.sessions.length} demo tanks, mode ${a.mode}`);
  const f0 = a.sessions[a.focus];
  await o.p.click('#bAuto'); // stop autoplay so counts are deterministic (the opening throw fires ~0.9 s after the deck loads)
  await sleep(2500); await o.p.waitForFunction(() => window.__table.stats().fly === 0, null, { timeout: 10000 });
  const c0 = (await tstats(o.p)).sessions[a.focus].cards;
  await o.p.keyboard.press('Space'); await sleep(600);
  await o.p.screenshot({ path: path.join(SHOTS, 'table-04-demo-throw.png') });
  await sleep(1600);
  const c1 = (await tstats(o.p)).sessions[a.focus].cards;
  ok(c1 === c0 + 1, `demo: Space throws a card into "${f0.title}" (${c0} → ${c1})`);
  await o.p.keyboard.press('c'); await sleep(1700);
  const m = (await tstats(o.p)).sessions[a.focus];
  await o.p.screenshot({ path: path.join(SHOTS, 'table-05-demo-overflow.png') });
  ok(m.phase === 'overflow' && m.shown > 0.98, `demo: overflow running (shown ${(m.shown * 100).toFixed(1)}%)`);
  await sleep(5000);
  const z = (await tstats(o.p)).sessions[a.focus];
  ok(!z.phase && z.compacts >= 1 && z.shown < 0.3, `demo: drained to ${(z.shown * 100).toFixed(1)}%, compactions ${z.compacts}, ${z.cards} cards left`);
  await done(o, 'demo table');
}

// ---------- 5. phone ----------
{
  const o = await open(BASE + 'table', { vp: { width: 390, height: 844 }, mobile: true });
  await sleep(4000);
  const r = await o.p.evaluate(() => {
    const pn = document.getElementById('panel').getBoundingClientRect(); const hd = document.querySelector('body>header').getBoundingClientRect();
    const tanks = [...document.querySelectorAll('#labels .pl')].filter((e) => e.style.display !== 'none').map((e) => e.getBoundingClientRect());
    const tb = [...document.querySelectorAll('#labels .tl b')].map((e) => e.getBoundingClientRect().width);
    return { titleW: Math.max(0, ...tb), collapsed: document.getElementById('panel').classList.contains('collapsed'), pn: { l: pn.left, t: pn.top, r: pn.right, b: pn.bottom }, header: hd.height, sw: document.documentElement.scrollWidth, tanks: tanks.map((t) => ({ l: t.left, t: t.top, r: t.right, b: t.bottom })) };
  });
  console.log('phone /table', JSON.stringify(r));
  ok(r.collapsed && r.pn.b - r.pn.t < 60, `phone /table: panel collapsed (${Math.round(r.pn.b - r.pn.t)} px tall)`);
  ok(r.sw <= 390, `phone /table: no horizontal scroll (scrollWidth ${r.sw})`);
  ok(r.titleW <= 390 * 0.5, `phone /table: long tank titles are truncated (widest ${Math.round(r.titleW)} px)`);
  const over = r.tanks.filter((t) => !(t.r < r.pn.l || t.l > r.pn.r || t.b < r.pn.t || t.t > r.pn.b));
  ok(over.length === 0, `phone /table: collapsed panel overlaps ${over.length} level labels`);
  await o.p.screenshot({ path: path.join(SHOTS, 'table-06-mobile.png') });
  await o.p.tap('#bPanel'); await sleep(400);
  await o.p.screenshot({ path: path.join(SHOTS, 'table-07-mobile-panel-open.png') });
  const open1 = await o.p.evaluate(() => !document.getElementById('panel').classList.contains('collapsed'));
  await o.p.tap('#bPanel'); await sleep(300);
  const shut = await o.p.evaluate(() => document.getElementById('panel').classList.contains('collapsed'));
  ok(open1 && shut, 'phone /table: tap opens and closes the panel');
  await done(o, 'phone table');
  const o2 = await open(BASE + (SID0 ? '?session=' + SID0 : ''), { vp: { width: 390, height: 844 }, mobile: true });
  await sleep(3000);
  await o2.p.tap('#hud .ph'); await sleep(400); // HUD starts collapsed on phones
  const lk = await o2.p.evaluate(() => { const a = document.getElementById('toTable'); const r = a.getBoundingClientRect(); const t = document.getElementById('hTitle'); return { vis: !a.hidden && r.width > 0, href: a.getAttribute('href'), sw: document.documentElement.scrollWidth, title: t.textContent, th: t.getBoundingClientRect().height, tw: t.getBoundingClientRect().right }; });
  ok(lk.th <= 42 && lk.tw <= 390, `phone /: HUD title "${lk.title}" clamped to ≤ 2 lines (${Math.round(lk.th)} px tall, right edge ${Math.round(lk.tw)})`);
  ok(lk.vis && lk.href === '/table' && lk.sw <= 390, `phone /: HUD link to /table visible (scrollWidth ${lk.sw})`);
  await o2.p.screenshot({ path: path.join(SHOTS, 'table-08-mobile-single.png') });
  await done(o2, 'phone single');
}
await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
