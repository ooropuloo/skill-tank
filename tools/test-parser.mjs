// node tools/test-parser.mjs [file.jsonl] [--all]
// Parser unit test on real transcripts: prints skill cards, usage curve summary, compactions; asserts invariants.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseFile, LIMIT_1M, LIMIT_STD } from '../lib/parser.mjs';
import { ROOTS, pickSession } from './sessions.mjs';

// default: the newest transcript on this machine that loaded at least one skill
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || (pickSession({ minSkills: 1 }) || {}).file;
if (!file) { console.error('no transcript with a skill load under ' + ROOTS.join(';')); process.exit(2); }
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) fails++; };
const k = (n) => (n == null ? '-' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));

function report(f, verbose) {
  const { events, state, lines } = parseFile(f);
  const skills = events.filter((e) => e.type === 'skill');
  const usage = events.filter((e) => e.type === 'usage');
  const comps = events.filter((e) => e.type === 'compact');
  const costs = new Map(events.filter((e) => e.type === 'skillcost').map((e) => [e.id, e]));
  const lim = events.filter((e) => e.type === 'limit').pop();
  console.log(`\n== ${path.basename(path.dirname(f))}/${path.basename(f)}  (${lines} lines)`);
  console.log(`  model=${state.model} attachModel=${state.modelAttr || '-'} limit=${k(lim && lim.limit)} threshold=${k(lim && lim.threshold)} (${lim && lim.reason})`);
  console.log(`  usage points=${usage.length}  max ctx=${k(state.maxCtx)}  last ctx=${k(state.lastCtx)}  skills=${skills.length}  compactions=${comps.length}`);
  if (verbose) {
    console.log('  -- skill cards (first 10)');
    skills.slice(0, 10).forEach((s, i) => {
      const c = costs.get(s.id);
      console.log(`  ${String(i + 1).padStart(2)}. L${s.line} ${s.t}  ${s.name.padEnd(22)} [${s.category}/${s.source}] est≈${k(s.est)} Δctx=${k(c && c.delta)}  ctxBefore=${k(s.ctxBefore)}  desc="${(s.desc || '').slice(0, 50)}"`);
    });
    console.log('  -- usage curve (every ~10%)');
    const step = Math.max(1, Math.floor(usage.length / 10));
    console.log('  ' + usage.filter((_, i) => i % step === 0 || i === usage.length - 1).map((u) => `L${u.line}:${k(u.ctx)}`).join('  '));
    comps.forEach((c) => console.log(`  -- compact L${c.line} trigger=${c.trigger} pre=${k(c.pre)} post=${k(c.post)}`));
    events.filter((e) => e.type === 'kept').forEach((e) => console.log(`  -- kept after compact L${e.line}: ${e.names.join(', ')}`));
  }
  return { events, state, skills, usage, comps, lim };
}

const r = report(file, true);
console.log('\n== assertions');
ok(r.usage.length > 0, 'has usage points');
ok(r.usage.every((u) => u.ctx > 0), 'all ctx > 0');
ok(r.skills.every((s) => s.name && s.category), 'every skill has name + category');
ok(!r.skills.some((s) => ['clear', 'model', 'goal', 'compact'].includes(s.name)), 'built-in slash commands not counted as cards');
ok(r.skills.every((s) => r.events.some((e) => e.type === 'skillcost' && e.id === s.id) || s === r.skills[r.skills.length - 1]), 'every card (except maybe the last) gets a Δctx');
{
  // as many cards as "Base directory for this skill:" injections on the main chain (fork-type skills without one are rare)
  const text = fs.readFileSync(file, 'utf8'); let base = 0;
  for (const l of text.split('\n')) {
    if (!l.includes('Base directory for this skill:')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const c = o.message && o.message.content; const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
    if (o.type === 'user' && o.isMeta && !o.isSidechain && /^Base directory for this skill:/.test(t)) base++;
  }
  ok(r.skills.length >= base, `cards ${r.skills.length} ≥ Base-directory injections ${base}`);
  const oneM = /\[1m\]/i.test(r.state.modelAttr) || r.state.maxCtx > LIMIT_STD;
  ok(r.lim.limit === (oneM ? LIMIT_1M : LIMIT_STD), `limit ${r.lim.limit} matches model attachment / max ctx (${oneM ? '1M' : '200K'})`);
}

if (args.includes('--all')) {
  console.log('\n== all sessions: compaction fit (pre vs limit-33K)');
  for (const ROOT of ROOTS) for (const d of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, d); if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const { events } = parseFile(path.join(dir, f));
      for (const c of events.filter((e) => e.type === 'compact')) {
        const lim = events.filter((e) => e.type === 'limit' && e.seq < c.seq).pop();
        const L = lim ? lim.limit : LIMIT_STD;
        console.log(`  ${d.slice(0, 18).padEnd(18)} ${f.slice(0, 8)} L${c.line} ${c.trigger} pre=${k(c.pre)} limit=${k(L)} pre/limit=${(c.pre / L * 100).toFixed(1)}% pre-(limit-33K)=${k(c.pre - (L - 33000))}`);
        ok(c.trigger !== 'auto' || Math.abs(c.pre - (L - 33000)) < 8000, `auto compact within 8K of limit-33K`);
      }
    }
  }
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
