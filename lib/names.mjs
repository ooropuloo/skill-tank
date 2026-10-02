// Display name of a session's project: the last folder of the session's cwd (e.g. ".../src/my-app" → "my-app").
// Without a cwd, fall back to the ~/.claude/projects folder name ("C--src-my-app"): drop the drive prefix, keep the
// last '-' segment ("app" — lossy, since '-' also replaced the path separators, but better than nothing).
import fs from 'node:fs';

export function projectName(cwd, projectDir = '') {
  const last = String(cwd || '').split(/[\\/]/).filter(Boolean).pop();
  if (last && !/^[A-Za-z]:$/.test(last)) return last;
  const p = String(projectDir || '').replace(/^[A-Za-z]--/, '').replace(/^-+/, '');
  return p.split('-').filter(Boolean).pop() || p || '';
}

const cwdCache = new Map(); // file -> cwd (a session's cwd is recorded in its first lines and does not change)
/** first "cwd" recorded in a transcript (reads at most the first 256 KB, cached once found) */
export function transcriptCwd(file) {
  if (cwdCache.has(file)) return cwdCache.get(file);
  let cwd = '';
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(256 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n)); if (m) cwd = JSON.parse('"' + m[1] + '"');
  } catch {}
  if (cwd) cwdCache.set(file, cwd);
  return cwd;
}
