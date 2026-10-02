#!/usr/bin/env node
// Claude Code hook → one line in ~/.claude/context-tank/events.jsonl.
// Runs with async:true; always silent and exit 0 so it never interferes with Claude Code.
import path from 'node:path';
import { append, rotateIfBig, scanDeck, lookupSkill, readJson, writeJson, COUNTS, DECK } from './lib.mjs';

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (body += c));
process.stdin.on('end', () => { try { handle(JSON.parse(body || '{}')); } catch {} process.exit(0); });
setTimeout(() => process.exit(0), 3000);

function bumpCount(id, n) { const c = readJson(COUNTS, {}); c[id] = n === 0 ? 0 : (c[id] || 0) + n; writeJson(COUNTS, c); }

function handle(p) {
  const session = p.session_id; if (!session) return;
  const cwd = p.cwd || '';
  const title = cwd ? path.basename(cwd) : session.slice(0, 8);
  switch (p.hook_event_name) {
    case 'SessionStart': {
      rotateIfBig();
      const prev = readJson(DECK, { projects: [] });
      scanDeck([...(prev.projects || []), cwd]);
      append({ type: 'session', session, title, cwd, model: typeof p.model === 'string' ? p.model : '', source: p.source || 'startup' });
      if (p.source === 'clear') bumpCount(session, 0);
      break;
    }
    case 'PreToolUse': {
      if (p.tool_name !== 'Skill') return;
      const ti = p.tool_input || {};
      const sk = lookupSkill(ti.skill || ti.command || ti.name, cwd); if (!sk) return;
      append({ type: 'skill', session, title, skill: sk }); bumpCount(session, 1);
      break;
    }
    case 'UserPromptSubmit': {
      if (typeof p.prompt !== 'string' || !p.prompt.startsWith('/')) return;
      const name = p.prompt.slice(1).split(/\s/)[0];
      const sk = lookupSkill(name, cwd);
      if (!sk || sk.source === 'builtin') return; // only real SKILL.md files, not /help, /compact…
      append({ type: 'skill', session, title, skill: sk }); bumpCount(session, 1);
      break;
    }
    case 'PreCompact':
      append({ type: 'compact', session, title, trigger: p.trigger || 'auto' }); bumpCount(session, 0);
      break;
    case 'SessionEnd':
      append({ type: 'end', session, reason: p.reason || '' });
      break;
  }
}
