// Processes this server starts in process groups of their own (agent CLIs, the headless render browser), written to
// `$BOGEN_HOME/children.json` while they run. If the server dies without stopping them (crash, out of memory,
// SIGKILL), its supervisor (Bogen.app) reads the file and ends exactly those groups, and nothing else: an entry only
// counts while the process with that pid still leads its own group and started when the entry says (see
// apps/macos/src/main/reaper.ts). A graceful stop ends them itself and leaves the file empty.
//
// Off unless `configureChildRegistry` was called, which `bogen serve` does. Writes are small and synchronous, so the
// file is right even if the process dies a moment later.

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

export interface ChildRecord { pid: number; startedAt: number; kind: string }

let file: string | null = null;
let owner: string | undefined;
const children = new Map<number, ChildRecord>();

function write(): void {
  if (!file) return;
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ server: process.pid, ...(owner ? { instance: owner } : {}), children: [...children.values()] }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

export function configureChildRegistry(path: string, instance?: string): void {
  file = path;
  owner = instance;
  children.clear();
  write();
}

/** Records a child that leads its own process group. `startedAt` is now, right after spawn returned. */
export function trackChild(pid: number | undefined, kind: string): void {
  if (!pid || !file) return;
  children.set(pid, { pid, startedAt: Date.now(), kind });
  write();
}

export function untrackChild(pid: number | undefined): void {
  if (!pid || !file || !children.delete(pid)) return;
  write();
}

/**
 * A supervisor's random id for this one launch of the server (`BOGEN_INSTANCE_ID`, 32 hex digits). Reported in
 * `/api/status` and `server.json`, so the supervisor can tell its own earlier server from any other Bogen that later
 * got the same pid.
 */
export function instanceFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.BOGEN_INSTANCE_ID;
  return id && /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

export function trackedChildren(): ChildRecord[] {
  return [...children.values()];
}
