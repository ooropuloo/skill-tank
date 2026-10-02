// node tools/verify-deck.mjs   — r3 deck (牌庫) acceptance, headless Chrome (GPU) against the running server + docs/demo.html
//   1. live real session: deck size == transcript skill_listing, plays == parser skill cards, 0 console errors
//   2. live tail: append a Skill event → that deck card is marked and the card is drawn out of its DOM slot
//      (ghost starts on the slot, 3D spawn projects back onto the ghost's end point); append a skill_listing delta → deck +1;
//      collapse the panel → next card flies out of the panel's pile icon
//   3. demo (docs/demo.html, file://): click a deck card → it drops into the tank, counters update; compaction still works
//   4. phone 390×844 touch: drawer collapsed by default, opens without covering the tank, scrolls, tap a card plays it
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFile } from '../lib/parser.mjs';
import { deckFromFile } from '../lib/deck.mjs';
import { sessionArg, cwdOf, SKILLS_DIR } from './sessions.mjs';
import { launch } from './browser.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.SKILL_TANK_URL || 'http://127.0.0.1:4700/';
const SHOTS = path.join(HERE, 'docs', 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
// session under test: argv[2], else the newest transcript with a skill_listing and a skill load
const S0 = sessionArg(process.argv[2], { minSkills: 1, listing: true }); const SID = S0.id; const SRC = S0.file;
console.log('session', SID, '(' + S0.project + ')');
// demo page: a generated docs/demo.html if there is one (private, may embed a deck snapshot), else the server in ?demo mode
const DEMO_FILE = path.join(HERE, 'docs', 'demo.html');
const DEMO = fs.existsSync(DEMO_FILE) && fs.readFileSync(DEMO_FILE, 'utf8').includes('window.SKILL_TANK_DECK = [') ? pathToFileURL(DEMO_FILE).href : BASE + '?demo';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const b = await launch();
async function open(url, opt = {}) {
  const ctx = await b.newContext({ viewport: opt.vp || { width: 1440, height: 860 }, hasTouch: !!opt.touch, isMobile: !!opt.touch, deviceScaleFactor: opt.touch ? 2 : 1 });
  const p = await ctx.newPage(); const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(url); await p.waitForFunction(() => window.__ready === true && window.__deckReady === true, null, { timeout: 60000 });
  return { p, errors, ctx };
}
const ds = (p) => p.evaluate(() => window.__tank.deck.stats());
const st = (p) => p.evaluate(() => window.__tank.stats());

// ---------- 1. live, real session ----------
{
  const want = deckFromFile(SRC);
  const { events } = parseFile(SRC); const plays = events.filter((e) => e.type === 'skill').length;
  const { p, errors, ctx } = await open(BASE + '?session=' + SID);
  await p.waitForTimeout(4000);
  const d = await ds(p); const s = await st(p);
  console.log('deck', JSON.stringify(d), 'transcript listing', want.source, want.cards.length, 'L' + want.initialLine, 'deltas', want.deltas.map((x) => 'L' + x.line + ':' + x.names).join(' '));
  ok(want.source === 'transcript' && d.source === 'transcript', 'deck source = transcript skill_listing');
  ok(d.deck === want.cards.length, `deck size ${d.deck} == skill_listing ${want.cards.length}`);
  ok(d.plays === plays && s.skillCards === plays, `已出 ${d.plays} == parser skill cards ${plays}`);
  ok(d.extras === 0, `no unlisted played cards (${d.extras})`);
  const head = await p.textContent('#deck .ph'); ok(head.includes(`牌庫 ${want.cards.length} 張`) && head.includes(`已出 ${plays} 張`), 'header: ' + head.replace(/\s+/g, ' ').trim());
  await p.screenshot({ path: path.join(SHOTS, '09-deck-desktop.png') });
  ok(errors.length === 0, 'live console errors: ' + (errors.join(' | ') || 0));
  await ctx.close();
}

// ---------- 2. live tail: draw from the deck ----------
{
  const dir = path.join(HERE, 'test-data', 'live'); fs.mkdirSync(dir, { recursive: true });
  const tid = '00000000-deck-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const f = path.join(dir, tid + '.jsonl'); fs.copyFileSync(SRC, f);
  const { p, errors, ctx } = await open(BASE + '?session=' + tid);
  await p.waitForTimeout(2500);
  const s0 = await st(p); const d0 = await ds(p);
  const base = { isSidechain: false, sessionId: tid, cwd: cwdOf(SRC), userType: 'external' };
  let n = 0;
  const skillLines = (skill, extraCtx) => { const now = new Date().toISOString(); const tu = 'toolu_deck_' + Date.now() + '_' + (++n); return [
    { ...base, type: 'assistant', timestamp: now, requestId: 'req_deck_a' + n + Date.now(), message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Skill', input: { skill } }], usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: s0.ctx - 1002, output_tokens: 50 } } },
    { ...base, type: 'user', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Launching skill: ' + skill }] }, toolUseResult: { success: true, commandName: skill } },
    { ...base, type: 'user', timestamp: now, isMeta: true, sourceToolUseID: tu, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${path.join(SKILLS_DIR, skill)}\n\n# ${skill} (fake test event by tools/verify-deck.mjs)` }] } },
    { ...base, type: 'assistant', timestamp: now, requestId: 'req_deck_b' + n + Date.now(), message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, cache_creation_input_tokens: extraCtx, cache_read_input_tokens: s0.ctx, output_tokens: 10 } } },
  ]; };
  const append = (lines) => fs.appendFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // pick deck cards that have never been played in this session
  const unplayed = await p.evaluate(() => window.__tank.deck.D.cards.map((c) => c.name).filter((n) => { const r = window.__tank.deck.rect(n); return r && !r.played && r.h > 0; }));
  const target = unplayed[0]; const target2 = unplayed[1] || unplayed[0];
  console.log('unplayed deck cards', unplayed.length, '→ test with', target, '/', target2);
  const r0 = await p.evaluate((n) => window.__tank.deck.rect(n), target);
  const t0 = Date.now(); append(skillLines(target, 12000));
  let ld = null, sawDrawing = false, shot = false;
  while (Date.now() - t0 < 5000) {
    const r = await p.evaluate((n) => window.__tank.deck.rect(n), target);
    if (r && r.drawing) { sawDrawing = true; if (!shot) { shot = true; await p.waitForTimeout(260); await p.screenshot({ path: path.join(SHOTS, '10-deck-draw-ghost.png') }); } }
    ld = await p.evaluate(() => window.__tank.deck.lastDraw());
    if (ld && ld.name === target) break; await p.waitForTimeout(40);
  }
  const dt = Date.now() - t0;
  await p.waitForTimeout(380); await p.screenshot({ path: path.join(SHOTS, '11-deck-draw-3d.png') });
  const elNow = await p.evaluate((n) => window.__tank.deck.rect(n), target);
  console.log('lastDraw', JSON.stringify(ld), 'element now', JSON.stringify(elNow), 'before', JSON.stringify(r0), dt + 'ms');
  ok(!r0.played, `${target} was unplayed before`);
  ok(sawDrawing, 'slot emptied while the card is being drawn (drawing class)');
  ok(ld && ld.name === target && ld.src === 'card', `drawn from its deck slot (src=${ld && ld.src}) within ${dt}ms`);
  ok(ld && near(ld.srcRect.x, elNow.x, 2) && near(ld.srcRect.y, elNow.y, 2) && near(ld.srcRect.w, elNow.w, 1), `ghost start == DOM slot rect (${ld && Math.round(ld.srcRect.x)},${ld && Math.round(ld.srcRect.y)} vs ${Math.round(elNow.x)},${Math.round(elNow.y)})`);
  ok(ld && near(ld.spawnScreen.x, ld.ghostEnd.x, 3) && near(ld.spawnScreen.y, ld.ghostEnd.y, 3), `3D spawn projects onto ghost end (${ld && ld.spawnScreen.x.toFixed(1)},${ld && ld.spawnScreen.y.toFixed(1)} vs ${ld && ld.ghostEnd.x.toFixed(1)},${ld && ld.ghostEnd.y.toFixed(1)})`);
  await p.waitForTimeout(3500);
  const s1 = await st(p); const d1 = await ds(p); const r1 = await p.evaluate((n) => window.__tank.deck.rect(n), target);
  ok(s1.skillCards === s0.skillCards + 1 && d1.plays === d0.plays + 1 && r1.played && r1.count === '1', `card marked played (count ${r1.count}), 已出 ${d0.plays} → ${d1.plays}, ghosts left ${d1.ghosts}`);
  ok(s1.meshSkill === s1.aliveSkill, `3D cards ${s1.meshSkill} == alive ${s1.aliveSkill}`);
  // skill_listing delta → new card appears in the deck
  const newName = 'deck-test-skill-' + (Date.now() % 100000);
  append([{ ...base, type: 'attachment', timestamp: new Date().toISOString(), attachment: { type: 'skill_listing', content: `- ${newName}: fake skill added by verify-deck`, skillCount: 1, isInitial: false, names: [newName] } }]);
  let d2 = d1; const t2 = Date.now(); while (Date.now() - t2 < 3000) { d2 = await ds(p); if (d2.deck > d1.deck) break; await p.waitForTimeout(100); }
  const fresh = await p.evaluate((n) => { const el = window.__tank.deck.D.els.get(n); return !!el && el.classList.contains('fresh'); }, newName);
  ok(d2.deck === d1.deck + 1 && fresh, `skill_listing delta → deck ${d1.deck} → ${d2.deck}, new card highlighted (${fresh})`);
  // collapsed panel → the card flies out of the pile icon
  await p.click('#deck .ph'); await p.waitForTimeout(300);
  const pile = await p.evaluate(() => { const r = document.getElementById('deckPile').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  append(skillLines(target2, 8000));
  let ld2 = null; const t3 = Date.now(); while (Date.now() - t3 < 4000) { ld2 = await p.evaluate(() => window.__tank.deck.lastDraw()); if (ld2 && ld2.name === target2) break; await p.waitForTimeout(50); }
  ok(ld2 && ld2.src === 'panel' && near(ld2.srcRect.x, pile.x, 2) && near(ld2.srcRect.y, pile.y, 2), `collapsed panel: drawn from the pile icon (src=${ld2 && ld2.src})`);
  await p.click('#deck .ph'); await p.waitForTimeout(3500);
  ok(errors.length === 0, 'live tail console errors: ' + (errors.join(' | ') || 0));
  await ctx.close(); fs.rmSync(f);
}

// ---------- 3. demo: click a deck card ----------
{
  // generated docs/demo.html → deck = the snapshot embedded in it; server ?demo → deck = this machine's own skills (/api/deck)
  const demoHtml = fs.existsSync(DEMO_FILE) ? fs.readFileSync(DEMO_FILE, 'utf8') : '';
  const em = /window\.SKILL_TANK_DECK = (\[.*?\]);<\/script>/s.exec(demoHtml); const embedded = em ? JSON.parse(em[1]) : null;
  const { p, errors, ctx } = await open(DEMO + (DEMO.includes('?') ? '&' : '?') + 'still');
  await p.waitForTimeout(1500);
  const d0 = await ds(p); const s0 = await st(p);
  if (embedded) ok(d0.source === 'snapshot' && d0.deck === embedded.length, `demo deck = embedded snapshot (${d0.deck} == ${embedded.length})`);
  else { const api = await (await fetch(BASE + 'api/deck')).json(); ok(d0.deck === api.count, `demo deck = server deck of this machine (${d0.deck} == ${api.count}, ${d0.source})`); }
  const names = await p.evaluate(() => { const seen = new Set(); return window.__tank.deck.D.cards.map((c) => c.name).filter((n) => /^[\w:.-]+$/.test(n) && !seen.has(n) && seen.add(n)).slice(0, 4); });
  console.log('demo clicks', names.join(', '));
  for (const nm of names) {
    await p.fill('#deckQ', nm); await p.waitForTimeout(80);
    await p.click(`.mc[data-name="${nm}"]`); await p.waitForTimeout(260);
    if (nm === names[1]) await p.screenshot({ path: path.join(SHOTS, '12-demo-click-draw.png') });
    await p.waitForTimeout(900);
  }
  await p.fill('#deckQ', ''); await p.waitForTimeout(3500);
  const s1 = await st(p); const d1 = await ds(p); const ld = await p.evaluate(() => window.__tank.deck.lastDraw());
  ok(s1.skillCards === s0.skillCards + names.length && s1.meshSkill === s1.aliveSkill, `demo: ${names.length} clicks → +${s1.skillCards - s0.skillCards} cards in the tank (${s1.meshSkill} meshes)`);
  ok(d1.plays === names.length && d1.playedSlots === names.length, `demo: 已出 ${d1.plays}, ${d1.playedSlots} slots marked`);
  ok(ld && ld.name === names[names.length - 1] && ld.src === 'card', 'demo: last card drawn from its slot');
  const head = await p.textContent('#deck .ph'); ok(head.includes(`已出 ${names.length} 張`), 'demo header: ' + head.replace(/\s+/g, ' ').trim());
  // compaction still works
  await p.evaluate(() => window.__tank.demo.water(0.5)); await p.waitForTimeout(1500);
  await p.evaluate(() => window.__tank.demo.compact('auto')); await p.waitForTimeout(1900);
  const mid = await st(p); let after = mid; const tc = Date.now(); while (Date.now() - tc < 25000) { await p.waitForTimeout(300); after = await st(p); if (!after.compactAnim) break; } await p.waitForTimeout(800); after = await st(p); const d2 = await ds(p);
  console.log('compaction mid', JSON.stringify(mid), 'after', JSON.stringify(after), (Date.now() - tc) + 'ms');
  ok(mid.compactAnim && after.compactions === 1 && !after.compactAnim && after.summaries === 1, 'demo: compaction overflow ran and finished');
  ok(after.aliveSkill <= 2 && after.meshSkill === after.aliveSkill && d2.plays === names.length, `demo: washed to ${after.aliveSkill} kept cards; deck still shows 已出 ${d2.plays}`);
  await p.click('#dCard'); await p.waitForTimeout(2500); const s3 = await st(p);
  ok(s3.skillCards === after.skillCards + 1, 'demo: 隨機抽一張 still drops a card');
  ok(errors.length === 0, 'demo console errors: ' + (errors.join(' | ') || 0));
  await ctx.close();
}

// ---------- 4. phone drawer ----------
{
  const { p, errors, ctx } = await open(DEMO + (DEMO.includes('?') ? '&' : '?') + 'still', { vp: { width: 390, height: 844 }, touch: true });
  await p.waitForTimeout(1500);
  const closed = await p.evaluate(() => { const d = document.getElementById('deck'); const r = d.getBoundingClientRect(); return { exp: d.querySelector('.ph').getAttribute('aria-expanded'), top: r.top, h: r.height, text: d.querySelector('.ph').textContent.replace(/\s+/g, ' ').trim() }; });
  const tr0 = await p.evaluate(() => window.__tank.tankRect());
  console.log('phone closed', JSON.stringify(closed), 'tank', JSON.stringify(tr0));
  ok(closed.exp === 'false' && closed.h < 70 && closed.text.includes('牌庫'), `drawer collapsed by default (${Math.round(closed.h)}px: "${closed.text}")`);
  await p.screenshot({ path: path.join(SHOTS, '13-mobile-drawer-closed.png') });
  await p.tap('#deck .ph'); await p.waitForTimeout(900);
  const opened = await p.evaluate(() => { const d = document.getElementById('deck'); const r = d.getBoundingClientRect(); const L = document.getElementById('deckList'); return { exp: d.querySelector('.ph').getAttribute('aria-expanded'), top: r.top, h: r.height, stageBottom: document.getElementById('stage').getBoundingClientRect().bottom, sh: L.scrollHeight, ch: L.clientHeight, ls: (() => { try { return localStorage.getItem('skilltank.panel.deck'); } catch { return 'x'; } })() }; });
  const tr1 = await p.evaluate(() => window.__tank.tankRect());
  console.log('phone open', JSON.stringify(opened), 'tank', JSON.stringify(tr1));
  ok(opened.exp === 'true' && opened.ls === 'true', 'drawer opens (aria-expanded=true, saved to localStorage)');
  ok(near(opened.stageBottom, opened.top, 2) && tr1.bottom <= opened.top + 1 && tr1.top >= 0 && tr1.left >= -2 && tr1.right <= 392, `open drawer does not cover the tank (tank y ${Math.round(tr1.top)}–${Math.round(tr1.bottom)}, drawer top ${Math.round(opened.top)})`);
  // touch scroll inside the list
  const L = await p.locator('#deckList').boundingBox();
  const sc0 = await p.evaluate(() => document.getElementById('deckList').scrollTop);
  const cdp = await ctx.newCDPSession(p);
  { const x = Math.round(L.x + L.width / 2), y0 = Math.round(L.y + L.height * 0.85); // real touch events (finger drag up)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - i * 14 }] }); await p.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
  await p.waitForTimeout(500); const sc1 = await p.evaluate(() => document.getElementById('deckList').scrollTop);
  ok(opened.sh > opened.ch && sc1 > sc0 + 20, `list scrolls by touch (scrollTop ${sc0} → ${Math.round(sc1)}, content ${opened.sh}px in ${opened.ch}px)`);
  await p.screenshot({ path: path.join(SHOTS, '14-mobile-drawer-open.png') });
  const s0 = await st(p);
  const first = await p.evaluate(() => { const L = document.getElementById('deckList').getBoundingClientRect(); for (const el of document.querySelectorAll('#deckList .mc')) { const r = el.getBoundingClientRect(); if (!el.hidden && r.top > L.top + 24 && r.bottom < L.bottom) return el.dataset.name; } return null; });
  await p.tap(`.mc[data-name="${first}"]`); await p.waitForTimeout(450);
  await p.screenshot({ path: path.join(SHOTS, '15-mobile-tap-draw.png') });
  await p.waitForTimeout(3000); const s1 = await st(p); const ld = await p.evaluate(() => window.__tank.deck.lastDraw());
  ok(s1.skillCards === s0.skillCards + 1 && ld && ld.name === first && ld.src === 'card', `tap "${first}" → card drawn from its slot into the tank`);
  ok(errors.length === 0, 'phone console errors: ' + (errors.join(' | ') || 0));
  await ctx.close();
}
await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
