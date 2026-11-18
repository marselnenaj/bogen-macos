// `bogen serve` as Bogen.app runs it: with an instance id, a child registry, and its stdin tied to the app's life.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureChildRegistry, instanceFromEnv, trackChild, trackedChildren, untrackChild } from '../src/child-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('the child registry', () => {
  it('writes each detached child with its start time, and forgets it when it ends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-children-'));
    dirs.push(dir);
    const file = join(dir, 'children.json');
    configureChildRegistry(file, 'a'.repeat(32));
    const before = Date.now();
    trackChild(4242, 'agent:claude');
    trackChild(undefined, 'render-browser');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { server: number; instance: string; children: { pid: number; startedAt: number; kind: string }[] };
    expect(saved.server).toBe(process.pid);
    expect(saved.instance).toBe('a'.repeat(32));
    expect(saved.children).toHaveLength(1);
    expect(saved.children[0]).toMatchObject({ pid: 4242, kind: 'agent:claude' });
    expect(saved.children[0]!.startedAt).toBeGreaterThanOrEqual(before);
    untrackChild(4242);
    expect(trackedChildren()).toEqual([]);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { children: unknown[] }).children).toEqual([]);
  });

  it('takes only a 32-hex instance id from the environment', () => {
    expect(instanceFromEnv({ BOGEN_INSTANCE_ID: 'ab'.repeat(16) })).toBe('ab'.repeat(16));
    expect(instanceFromEnv({ BOGEN_INSTANCE_ID: 'xyz' })).toBeUndefined();
    expect(instanceFromEnv({})).toBeUndefined();
  });
});

describe('bogen serve under a supervisor', () => {
  it('reports its instance id, keeps a child registry, and stops when the supervisor\'s pipe closes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-supervised-'));
    dirs.push(home);
    const port = await freePort();
    const instance = 'c0ffee'.padEnd(32, '0');
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'packages/server/src/cli.ts'), 'serve', '--port', String(port)], {
      cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_INSTANCE_ID: instance, BOGEN_EXIT_WITH_STDIN: '1', BOGEN_WELCOME: '0', BOGEN_UPDATE_CHECK: 'off' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    try {
      let status: { pid?: number; instance?: string } | null = null;
      const end = Date.now() + 30_000;
      // HTTP binds before listen() finishes starting its listeners and writing server.json. Wait for both
      // observable readiness signals; a status response alone does not mean the supervisor can discover it yet.
      while ((!status || !existsSync(join(home, 'server.json'))) && Date.now() < end) {
        status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json() as Promise<{ pid: number; instance: string }>).catch(() => null);
        if (!status || !existsSync(join(home, 'server.json'))) await new Promise((r) => setTimeout(r, 200));
      }
      expect(status).toMatchObject({ pid: child.pid, instance });
      expect(JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'))).toMatchObject({ pid: child.pid, instance });
      expect(JSON.parse(readFileSync(join(home, 'children.json'), 'utf8'))).toMatchObject({ server: child.pid, instance, children: [] });
      // The app died: its end of the pipe closes. The server stops on its own.
      child.stdin!.end();
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
      expect(code).toBe(0);
    } finally {
      // A failed assertion must not leave this test's own server running on the CI machine.
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 45_000);
});
