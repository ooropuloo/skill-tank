// Shared helpers for the test tools: find transcripts on this machine instead of hard-coding session ids.
//   SKILL_TANK_ROOT  transcript roots (default ~/.claude/projects; several: ';' separated) — same as the server
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROOTS = (process.env.SKILL_TANK_ROOT || path.join(os.homedir(), '.claude', 'projects')).split(';').map((s) => s.trim()).filter(Boolean);
export const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** every main-chain transcript: [{file, id, project, mtime, size}] newest first (subagent files live deeper and are skipped) */
export function allTranscripts() {
  const out = [];
  for (const root of ROOTS) {
    let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      let ents = []; try { ents = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
      for (const f of ents) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(root, d.name, f);
        try { const st = fs.statSync(file); out.push({ file, id: f.slice(0, -6), project: d.name, mtime: st.mtimeMs, size: st.size }); } catch {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
export function findSession(id) { return allTranscripts().find((s) => s.id === id); }

/**
 * Newest transcript that is good test material.
 * @param {{minSkills?:number, compact?:boolean, listing?:boolean, maxBytes?:number}} o
 */
export function pickSession({ minSkills = 1, compact = false, listing = false, maxBytes = 200e6 } = {}) {
  for (const s of allTranscripts()) {
    if (s.size > maxBytes || s.size < 2000) continue;
    let text = ''; try { text = fs.readFileSync(s.file, 'utf8'); } catch { continue; }
    const skills = (text.match(/Base directory for this skill:/g) || []).length;
    if (skills < minSkills) continue;
    if (compact && !text.includes('"compact_boundary"')) continue;
    if (listing && !text.includes('"skill_listing"')) continue;
    return s;
  }
  return null;
}
/** sessionId argument (argv) → transcript, else pickSession(opts); exits with a message when nothing fits */
export function sessionArg(arg, opts) {
  const s = arg ? findSession(arg) : pickSession(opts);
  if (!s) { console.error(arg ? `session ${arg} not found under ${ROOTS.join(';')}` : `no transcript under ${ROOTS.join(';')} fits ${JSON.stringify(opts || {})}`); process.exit(2); }
  return s;
}
/** cwd recorded in a transcript (first "cwd" field) */
export function cwdOf(file) {
  try { const head = fs.readFileSync(file, 'utf8').slice(0, 200000); const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head); return m ? JSON.parse('"' + m[1] + '"') : ''; } catch { return ''; }
}
