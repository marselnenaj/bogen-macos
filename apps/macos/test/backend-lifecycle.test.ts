// The app's backend supervisor against real processes on this machine (Linux in CI and here; the same code paths run
// on macOS). A stand-in server answers /api/status like Bogen, and on request starts a grandchild in a process group of
// its own and records it in children.json the way packages/server/src/child-registry.ts does: exactly the shape of an
// agent CLI run or the render browser.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Backend, probeBogen, type BackendDeps } from '../src/main/backend.ts';
import { reapChildren, readProcess, systemReapDeps } from '../src/main/reaper.ts';

const FAKE = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const port = Number(process.env.BOGEN_PORT);
const home = process.env.BOGEN_HOME;
const children = [];
const save = () => { writeFileSync(join(home, 'children.json.tmp'), JSON.stringify({ server: process.pid, children })); renameSync(join(home, 'children.json.tmp'), join(home, 'children.json')); };
save();
writeFileSync(join(home, 'server.json'), JSON.stringify({ pid: process.pid, port, instance: process.env.BOGEN_INSTANCE_ID }));
const server = createServer((req, res) => {
  if (req.url === '/api/status') return res.end(JSON.stringify({ version: '0.1.0', pid: process.pid, instance: process.env.BOGEN_INSTANCE_ID }));
  if (req.url === '/spawn-agent') {
    // Like agents.ts: detached, so in a process group of its own, which killing the server's group does not reach.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    children.push({ pid: child.pid, startedAt: Date.now(), kind: 'agent:claude' });
    save();
    return res.end(String(child.pid));
  }
  res.statusCode = 404; res.end();
});
server.listen(port, '127.0.0.1');
if (process.env.BOGEN_EXIT_WITH_STDIN === '1') process.stdin.on('end', () => process.exit(0)).resume();
process.on('SIGTERM', () => process.exit(0));
`;

let dir: string;
let script: string;
const started: number[] = [];
const servers: Server[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out');
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** A process in a group of its own that nobody recorded: stands for any other program of the person's. */
function decoy(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  started.push(child.pid!);
  return child;
}

function deps(log: string[] = []): BackendDeps {
  return {
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      started.push(child.pid!);
      return child;
    },
    probe: (port) => probeBogen(port, 1000),
    kill: (pid, signal) => process.kill(pid, signal),
    alive,
    previousServer: () => {
      try {
        const { pid, instance } = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as { pid: number; instance: string };
        return typeof instance === 'string' ? { pid, instance } : null;
      } catch {
        return null;
      }
    },
    newInstance: () => randomBytes(16).toString('hex'),
    reap: async () => {
      await reapChildren(join(dir, 'children.json'), systemReapDeps((l) => log.push(l)), 2000);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (chunk) => log.push(chunk),
  };
}

function backend(port: number, log: string[] = [], extra: Partial<ConstructorParameters<typeof Backend>[0]> = {}): Backend {
  return new Backend({ node: process.execPath, cli: script, port, env: { ...process.env, BOGEN_HOME: dir }, cwd: dir, readyTimeoutMs: 8000, stopTimeoutMs: 3000, backoffMs: [100], ...extra }, deps(log));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bogen-app-backend-'));
  script = join(dir, 'fake-server.mjs');
  writeFileSync(script, FAKE);
});

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    }
  }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('the backend supervisor', () => {
  it('is ready only when its own child answers with the instance id it was given, and stop leaves no process behind', async () => {
    const port = await freePort();
    const b = backend(port);
    const state = await b.start();
    expect(state.phase).toBe('ready');
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { pid: number; instance: string };
    expect(status.pid).toBe(state.pid);
    expect(status.instance).toMatch(/^[0-9a-f]{32}$/);
    const agent = Number(await (await fetch(`http://127.0.0.1:${port}/spawn-agent`)).text());
    started.push(agent);
    expect(alive(agent)).toBe(true);
    await b.stop();
    expect(b.current.phase).toBe('stopped');
    expect(alive(state.pid!)).toBe(false);
    // The agent ran in its own group; only the reaper knew it.
    await until(() => !alive(agent));
  }, 20_000);

  it('after a crash, ends the recorded agent group, spares unrecorded and pid-reused processes, and restarts', async () => {
    const port = await freePort();
    const log: string[] = [];
    const b = backend(port, log);
    const first = await b.start();
    expect(first.phase).toBe('ready');
    const agent = Number(await (await fetch(`http://127.0.0.1:${port}/spawn-agent`)).text());
    started.push(agent);
    // Another program of the person's, in its own group, never recorded.
    const other = decoy();
    // A record whose pid now belongs to a different process (pid reuse): right pid, wrong start time.
    const reused = decoy();
    const file = join(dir, 'children.json');
    const registry = JSON.parse(readFileSync(file, 'utf8')) as { children: { pid: number; startedAt: number; kind: string }[] };
    registry.children.push({ pid: reused.pid!, startedAt: Date.now() - 3_600_000, kind: 'agent:codex' });
    writeFileSync(file, JSON.stringify(registry));

    process.kill(first.pid!, 'SIGKILL');
    await until(() => b.current.phase === 'ready' && b.current.pid !== first.pid, 15_000);
    await until(() => !alive(agent));
    expect(alive(other.pid!)).toBe(true);
    expect(alive(reused.pid!)).toBe(true);
    expect(log.join('')).toMatch(/left pid \d+ \(agent:codex\) alone/);
    await b.stop();
  }, 30_000);

  it('never ends another program on its port, and reports it instead', async () => {
    const port = await freePort();
    const foreign = createServer((_req, res) => res.end('hello'));
    servers.push(foreign);
    await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', r));
    const state = await backend(port).start();
    expect(state.phase).toBe('failed');
    expect(state.reason).toMatchObject({ code: 'port-other', port });
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it('ends an earlier server only when both its pid and its instance id match, never on a pid alone', async () => {
    const port = await freePort();
    // A Bogen that is not ours: its pid is what server.json says (pid reuse), but it reports another instance.
    const other = spawn(process.execPath, [script], { env: { ...process.env, BOGEN_HOME: join(dir, 'elsewhere'), BOGEN_PORT: String(port), BOGEN_INSTANCE_ID: 'f'.repeat(32) }, detached: true, stdio: 'ignore' });
    started.push(other.pid!);
    spawnSync('mkdir', ['-p', join(dir, 'elsewhere')]);
    await until(async () => (await probeBogen(port, 500)).kind === 'bogen');
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: other.pid, instance: 'a'.repeat(32) }));
    const refused = await backend(port).start();
    expect(refused.phase).toBe('failed');
    expect(refused.reason).toMatchObject({ code: 'port-bogen', pid: other.pid });
    expect(alive(other.pid!)).toBe(true);

    // The same process, now with the instance id this app recorded for it: it is the app's own earlier server.
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: other.pid, instance: 'f'.repeat(32) }));
    const b = backend(port);
    const recovered = await b.start();
    expect(recovered.phase).toBe('ready');
    expect(alive(other.pid!)).toBe(false);
    await b.stop();
  }, 30_000);

  it('gives up after repeated crashes instead of looping forever', async () => {
    const port = await freePort();
    const b = backend(port, [], { maxRestarts: 2, restartWindowMs: 60_000 });
    let s = await b.start();
    for (let i = 0; i < 3; i++) {
      const pid = s.pid!;
      process.kill(pid, 'SIGKILL');
      await until(() => (b.current.phase === 'ready' && b.current.pid !== pid) || b.current.phase === 'failed', 15_000);
      s = b.current;
      if (s.phase === 'failed') break;
    }
    expect(b.current.phase).toBe('failed');
    expect(b.current.reason?.code).toBe('crash-loop');
    await b.stop();
  }, 40_000);

  it('reads a live process the way the reaper needs it', () => {
    const self = readProcess(process.pid);
    expect(self).not.toBeNull();
    expect(Math.abs(self!.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(3000);
    expect(readProcess(2 ** 22 + 12345)).toBeNull();
  });
});
