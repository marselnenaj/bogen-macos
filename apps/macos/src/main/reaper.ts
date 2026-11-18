// Ends what a dead backend left behind, and nothing else.
//
// The backend writes every child it starts in a process group of its own (agent CLIs, the headless render browser)
// to `<data>/children.json` (packages/server/src/child-registry.ts). Killing the backend's own group does not reach
// them. After the backend exits, and before a new one starts, the app reads that file and ends a recorded group only
// if the process with that pid
//   1. still exists,
//   2. still leads its own process group (pgid == pid), as every recorded child did when it was started, and
//   3. started within a few seconds of when the backend recorded it (from `ps -o etime`),
// so a pid the system has since given to an unrelated program is left alone. Works the same with macOS and Linux `ps`.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

export interface ChildRecord { pid: number; startedAt: number; kind: string }
export interface ProcessInfo { pgid: number; startedAt: number }

const TOLERANCE_MS = 3000;

export function readChildren(file: string): ChildRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { children?: unknown };
    if (!Array.isArray(parsed.children)) return [];
    return parsed.children.filter((c): c is ChildRecord => {
      const r = c as Record<string, unknown>;
      return Boolean(r) && Number.isInteger(r.pid) && (r.pid as number) > 1 && typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) && typeof r.kind === 'string';
    });
  } catch {
    return [];
  }
}

/** `ps -o etime`: `[[dd-]hh:]mm:ss`, as both BSD and procps print it. Seconds, or null. */
export function parseEtime(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(s);
}

/** pgid and start of a live process from one `ps` line (`<pgid> <etime>`), or null when there is none. */
export function parsePs(line: string, now: number): ProcessInfo | null {
  const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line.trim());
  if (!m) return null;
  const elapsed = parseEtime(m[2]!);
  if (elapsed === null) return null;
  return { pgid: Number(m[1]), startedAt: now - elapsed * 1000 };
}

export function readProcess(pid: number, now = Date.now()): ProcessInfo | null {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return parsePs(out.split('\n').find((l) => l.trim()) ?? '', now);
  } catch {
    return null; // ps exits 1 when there is no such process.
  }
}

/** Whether a live process is the recorded child: same group leader, and started when the record says. */
export function isRecordedChild(rec: ChildRecord, info: ProcessInfo | null): boolean {
  if (!info) return false;
  if (info.pgid !== rec.pid) return false;
  // etime has one-second steps, and the record is taken just after spawn returned.
  return Math.abs(info.startedAt - rec.startedAt) <= TOLERANCE_MS;
}

export interface ReapDeps {
  readProcess(pid: number): ProcessInfo | null;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export const systemReapDeps = (log: (line: string) => void): ReapDeps => ({
  readProcess: (pid) => readProcess(pid),
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
});

/**
 * Ends every recorded group that still is the recorded child: SIGTERM, up to `graceMs`, then SIGKILL. Removes the file
 * afterwards. Returns what it ended and what it left alone.
 */
export async function reapChildren(file: string, deps: ReapDeps, graceMs = 3000): Promise<{ ended: ChildRecord[]; left: ChildRecord[] }> {
  const records = readChildren(file);
  const ended: ChildRecord[] = [];
  const left: ChildRecord[] = [];
  for (const rec of records) {
    if (isRecordedChild(rec, deps.readProcess(rec.pid))) ended.push(rec);
    else left.push(rec);
  }
  for (const rec of ended) {
    deps.log(`reaper: ending ${rec.kind} group ${rec.pid}, left by the server`);
    try {
      deps.kill(-rec.pid, 'SIGTERM');
    } catch {
      // Gone meanwhile.
    }
  }
  if (ended.length) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && ended.some((r) => isRecordedChild(r, deps.readProcess(r.pid)))) await deps.sleep(100);
    for (const rec of ended) {
      if (!isRecordedChild(rec, deps.readProcess(rec.pid))) continue;
      try {
        deps.kill(-rec.pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }
  for (const rec of left) deps.log(`reaper: left pid ${rec.pid} (${rec.kind}) alone: it is gone or is no longer the process Bogen started`);
  rmSync(file, { force: true });
  return { ended, left };
}
