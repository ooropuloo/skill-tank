// node tools/verify.mjs   — headless Chrome (GPU) acceptance test against the running server (127.0.0.1:4700)
//   1. live page on a real session: __ready, card count == parser, water level == ctx/limit, 0 console errors
//   2. demo mode: drop card (screenshot on splash), compaction overflow (screenshot), no errors
//   3. live tail: copy a jsonl into test-data/, append a fake Skill event → +1 card within 2s, level changes
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../lib/parser.mjs';
import { sessionArg, cwdOf, SKILLS_DIR } from './sessions.mjs';
import { projectName } from '../lib/names.mjs';
import { launch } from './browser.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.SKILL_TANK_URL || 'http://127.0.0.1:4700/';
const SHOTS = path.join(HERE, 'docs', 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
// session under test: argv[2], else the newest transcript that loaded a skill; replay test: newest one with a real compaction
const S0 = sessionArg(process.argv[2], { minSkills: 1 }); const SID = S0.id; const SRC = S0.file;
console.log('session', SID, '(' + S0.project + ')');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const b = await launch();
async function open(url, vp = { width: 1440, height: 860 }) {
  const p = await b.newPage({ viewport: vp }); const errors = [];
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(url); await p.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return { p, errors };
}
const stats = (p) => p.evaluate(() => window.__tank.stats());

// ---------- 1. real session ----------
{
  // snapshot the file first so parser and page see the same bytes
  const { events } = parseFile(SRC);
  const want = events.filter((e) => e.type === 'skill').length;
  const lim = events.filter((e) => e.type === 'limit').pop().limit;
  const lastCtx = events.filter((e) => e.type === 'usage').pop().ctx;
  const { p, errors } = await open(BASE + '?session=' + SID);
  await p.waitForTimeout(3500);
  const s = await stats(p);
  console.log('session stats', JSON.stringify(s));
  ok(s.skillCards >= want && s.skillCards <= want + 1, `card count ${s.skillCards} == parser ${want} (+1 allowed if session grew)`);
  ok(s.meshSkill === s.aliveSkill, `meshes ${s.meshSkill} == alive skill cards ${s.aliveSkill}`);
  ok(s.limit === lim, `limit ${s.limit} == parser ${lim}`);
  ok(Math.abs(s.level - s.ctx / s.limit) < 0.01, `water level ${s.level.toFixed(4)} == ctx/limit ${(s.ctx / s.limit).toFixed(4)} (parser last ctx ${lastCtx})`);
  ok(s.frames > 30, `rendering (${s.frames} frames)`);
  const proj = projectName(cwdOf(SRC), S0.project); const hud = await p.$eval('#hTitle', (e) => e.textContent);
  ok(proj && hud.startsWith(proj + ' · '), `HUD title "${hud}" starts with the project name "${proj} · "`);
  const opt = await p.$eval('#selSess', (e) => { const o = e.options[e.selectedIndex]; return { text: o.textContent, group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '' }; });
  ok(opt.group === proj && opt.text.startsWith(proj + ' · '), `session menu: optgroup "${opt.group}", entry "${opt.text}"`);
  await p.screenshot({ path: path.join(SHOTS, '01-overview-live.png') });
  ok(errors.length === 0, 'live page console errors: ' + (errors.join(' | ') || 0));
  await p.close();
}

// ---------- 2. demo mode ----------
{
  const { p, errors } = await open(BASE + '?demo&still');
  for (let i = 0; i < 5; i++) { await p.evaluate(() => window.__tank.demo.card()); await p.waitForTimeout(700); }
  await p.evaluate(() => window.__tank.demo.water(0.3)); await p.waitForTimeout(2500);
  await p.evaluate(() => window.__tank.demo.card()); await p.waitForTimeout(1230);
  await p.screenshot({ path: path.join(SHOTS, '02-card-splash.png') });
  await p.waitForTimeout(3500);
  const before = await stats(p);
  await p.evaluate(() => window.__tank.demo.water(0.22)); await p.waitForTimeout(2600);
  const near = await stats(p);
  await p.screenshot({ path: path.join(SHOTS, '03-near-threshold.png') });
  await p.evaluate(() => window.__tank.demo.compact('auto')); await p.waitForTimeout(1900);
  const mid = await stats(p);
  await p.screenshot({ path: path.join(SHOTS, '04-compact-overflow.png') });
  await p.waitForTimeout(2600);
  await p.screenshot({ path: path.join(SHOTS, '05-compact-after.png') });
  await p.waitForTimeout(4000);
  const after = await stats(p);
  console.log('demo before', JSON.stringify(before)); console.log('demo near', JSON.stringify(near)); console.log('demo mid', JSON.stringify(mid)); console.log('demo after', JSON.stringify(after));
  ok(before.skillCards === 6 && before.meshSkill === 6, `demo: 6 cards dropped (${before.meshSkill} meshes)`);
  ok(mid.compactAnim && mid.level > 0.98, `demo: compaction overflow running, level ${mid.level.toFixed(3)} > rim`);
  ok(!after.compactAnim && after.compactions === 1 && after.summaries === 1, 'demo: compaction finished, 1 summary card');
  ok(after.aliveSkill <= 2 && after.meshSkill === after.aliveSkill, `demo: washed away, ${after.aliveSkill} kept cards remain`);
  ok(after.level < 0.25, `demo: water drained to ${after.level.toFixed(3)}`);
  ok(errors.length === 0, 'demo console errors: ' + (errors.join(' | ') || 0));
  await p.close();
}

// ---------- 3. live tail ----------
{
  const dir = path.join(HERE, 'test-data', 'live'); fs.mkdirSync(dir, { recursive: true });
  const tid = '00000000-test-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
  const f = path.join(dir, tid + '.jsonl'); fs.copyFileSync(SRC, f);
  const { p, errors } = await open(BASE + '?session=' + tid);
  await p.waitForTimeout(1500);
  const s0 = await stats(p);
  const now = new Date().toISOString(); const tu = 'toolu_test_' + Date.now();
  const base = { isSidechain: false, sessionId: tid, cwd: cwdOf(SRC), userType: 'external' };
  const ctx1 = s0.ctx + 23456;
  const lines = [
    { ...base, type: 'assistant', timestamp: now, requestId: 'req_test_a', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Skill', input: { skill: 'skill-tank' } }], usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: s0.ctx - 1002, output_tokens: 50 } } },
    { ...base, type: 'user', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Launching skill: skill-tank' }] }, toolUseResult: { success: true, commandName: 'skill-tank' } },
    { ...base, type: 'user', timestamp: now, isMeta: true, sourceToolUseID: tu, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: ' + path.join(SKILLS_DIR, 'skill-tank') + '\n\n# skill-tank (fake test event)\n\nThis line was appended by tools/verify.mjs.' }] } },
    { ...base, type: 'assistant', timestamp: now, requestId: 'req_test_b', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, cache_creation_input_tokens: 23454, cache_read_input_tokens: s0.ctx, output_tokens: 10 } } },
  ];
  const t0 = Date.now();
  fs.appendFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  let s1 = s0;
  while (Date.now() - t0 < 4000) { s1 = await stats(p); if (s1.skillCards > s0.skillCards && s1.ctx !== s0.ctx) break; await p.waitForTimeout(100); }
  const dt = Date.now() - t0;
  console.log(`live: before cards=${s0.skillCards} ctx=${s0.ctx}  after cards=${s1.skillCards} ctx=${s1.ctx}  in ${dt}ms`);
  ok(s1.skillCards === s0.skillCards + 1 && dt <= 2000, `live: +1 card within 2s (${dt}ms)`);
  ok(s1.ctx === ctx1, `live: ctx ${s0.ctx} → ${s1.ctx} (expected ${ctx1})`);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(SHOTS, '06-live-append.png') });
  await p.waitForTimeout(2500);
  const s2 = await stats(p);
  ok(Math.abs(s2.level - ctx1 / s2.limit) < 0.01, `live: water rose to ${s2.level.toFixed(4)} (target ${(ctx1 / s2.limit).toFixed(4)})`);
  ok(errors.length === 0, 'live tail console errors: ' + (errors.join(' | ') || 0));
  await p.close();
  fs.rmSync(f);
}
// ---------- 4. replay (session with a real compaction) ----------
{
  const RS = sessionArg(process.argv[3], { compact: true }).id; console.log('replay session', RS);
  const { p, errors } = await open(BASE + '?session=' + RS);
  await p.waitForTimeout(1500);
  const s0 = await stats(p);
  await p.selectOption('#selSpeed', '16');
  await p.click('#btnReplay');
  let sawCompact = false, sMid = null; const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const s = await stats(p); if (s.compactAnim) { sawCompact = true; if (!sMid) { sMid = s; await p.screenshot({ path: path.join(SHOTS, '08-replay-real-compaction.png') }); } }
    if (s.applied >= s.events && !s.compactAnim && Date.now() - t0 > 2000) break; await p.waitForTimeout(250);
  }
  await p.waitForTimeout(3500);
  const s1 = await stats(p);
  console.log('replay before', JSON.stringify(s0)); console.log('replay after ', JSON.stringify(s1), (Date.now() - t0) + 'ms');
  ok(sawCompact, 'replay: real compaction animation played');
  ok(s1.skillCards === s0.skillCards && s1.aliveSkill === s0.aliveSkill && s1.summaries === s0.summaries && s1.meshes === s0.meshes, `replay: end state matches (${s1.aliveSkill} skill + ${s1.summaries} summary)`);
  ok(Math.abs(s1.level - s0.level) < 0.01, `replay: level back to ${s1.level.toFixed(4)}`);
  // click on the chart → seek + replay from there
  const box = await p.locator('#chart').boundingBox();
  await p.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2); await p.waitForTimeout(300);
  const s2 = await stats(p);
  ok(s2.applied < s0.applied, `chart click seeks back (applied ${s2.applied} < ${s0.applied})`);
  ok(errors.length === 0, 'replay console errors: ' + (errors.join(' | ') || 0));
  await p.close();
}
await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
