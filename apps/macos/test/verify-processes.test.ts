import { describe, expect, it } from 'vitest';
import { ownTree, parsePs, stopOwn, waitForFile } from '../scripts/verify-processes.mjs';

const BUNDLE = '/tmp/ci/release/dev/arm64/Bogen.app/Contents';

/** A fake process table with a fake clock: signals change it the way the real processes would. */
function world(procs: { pid: number; ppid: number; command: string; onTerm?: 'exit' | 'ignore' | 'quit-tree' }[], meanwhile?: (table: Map<number, { pid: number; ppid: number; command: string; onTerm?: string }>, signals: [number, string][]) => void) {
  const table = new Map<number, { pid: number; ppid: number; command: string; onTerm?: string }>(procs.map((p) => [p.pid, { ...p }]));
  const signals: [number, string][] = [];
  let clock = 0;
  const deps = {
    ps: () => [...table.values()].map((p) => `${p.pid} ${p.ppid} ${p.command}`).join('\n'),
    kill: (pid: number, sig: string) => {
      signals.push([pid, sig]);
      const p = table.get(pid);
      if (!p) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (sig === 'SIGKILL' || p.onTerm === 'exit') table.delete(pid);
      else if (p.onTerm === 'quit-tree') {
        // The app quits: its own server and helpers go with it, as before-quit does.
        const doomed = ownTree(parsePs(deps.ps()), [pid], BUNDLE);
        for (const d of doomed) if (table.get(d)?.onTerm !== 'ignore' || d === pid) table.delete(d);
      }
    },
    sleep: async (ms: number) => { clock += ms; meanwhile?.(table, signals); },
    now: () => clock,
  };
  return { deps, table, signals, elapsed: () => clock };
}

describe('the verifier stops only its own processes', () => {
  const procs = [
    { pid: 500, ppid: 1, command: `${BUNDLE}/MacOS/Bogen`, onTerm: 'quit-tree' as const },
    { pid: 501, ppid: 500, command: `${BUNDLE}/Frameworks/Bogen Helper (Renderer).app/Contents/MacOS/Bogen Helper (Renderer)` },
    { pid: 510, ppid: 500, command: `${BUNDLE}/Resources/node ${BUNDLE}/Resources/server/cli.mjs serve` },
    { pid: 520, ppid: 510, command: `${BUNDLE}/Resources/headless-shell/chrome-headless-shell --headless` },
    // The person's own processes: another Bogen from the same build, and an unrelated editor.
    { pid: 700, ppid: 1, command: `${BUNDLE}/MacOS/Bogen` },
    { pid: 701, ppid: 1, command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' },
    { pid: 702, ppid: 500, command: '/bin/sh -c something the app ran outside its bundle' },
  ];

  it('finds the spawned app\'s tree inside the bundle, and nothing of the person\'s', () => {
    const tree = ownTree(parsePs(world(procs).deps.ps()), [500], BUNDLE).sort();
    expect(tree).toEqual([500, 501, 510, 520]);
    // A server whose app is gone (reparented to launchd) is still found through the pid it reported.
    // (macOS reparents every child of an exited process to launchd, pid 1.)
    const orphaned = procs.map((p) => (p.ppid === 500 ? { ...p, ppid: 1 } : p)).filter((p) => p.pid !== 500);
    expect(ownTree(parsePs(world(orphaned).deps.ps()), [500, 510], BUNDLE).sort()).toEqual([510, 520]);
  });

  it('asks the app to quit first, and needs nothing else when it takes its server and shells with it', async () => {
    const w = world(procs);
    const left = await stopOwn([500, 510], BUNDLE, w.deps);
    expect(left).toEqual([]);
    // The server went with the app, so the fresh check before its signal finds it gone: it is not signalled.
    expect(w.signals).toEqual([[500, 'SIGTERM']]);
    expect([...w.table.keys()].sort()).toEqual([700, 701, 702]);
  });

  it('escalates within its deadlines to SIGKILL for a process that ignores SIGTERM, and never signals the person\'s', async () => {
    const stubborn = procs.map((p) => (p.pid === 520 ? { ...p, onTerm: 'ignore' as const } : p));
    const w = world(stubborn);
    const left = await stopOwn([500, 510], BUNDLE, w.deps, { graceMs: 2000, termMs: 1000, killMs: 500 });
    expect(left).toEqual([]);
    expect(w.signals.filter(([, s]) => s === 'SIGKILL')).toEqual([[520, 'SIGKILL']]);
    expect(w.signals.some(([pid]) => pid === 700 || pid === 701 || pid === 702)).toBe(false);
    expect(w.elapsed()).toBeLessThanOrEqual(2000 + 1000 + 500 + 600);
  });

  it('never signals a pid that was reused for another command before escalation, and does not count it as left', async () => {
    const stubborn = procs.map((p) => (p.pid === 520 ? { ...p, onTerm: 'ignore' as const } : p));
    let reused = false;
    // The headless shell exits on its own after the app's SIGTERM, and its pid is given to the person's editor.
    const w = world(stubborn, (table, signals) => {
      if (!reused && signals.some(([pid]) => pid === 500)) {
        table.set(520, { pid: 520, ppid: 1, command: '/usr/bin/vim notes.txt' });
        reused = true;
      }
    });
    const left = await stopOwn([500, 510], BUNDLE, w.deps, { graceMs: 2000, termMs: 1000, killMs: 500 });
    expect(reused).toBe(true);
    expect(left).toEqual([]);
    expect(w.signals.some(([pid]) => pid === 520)).toBe(false);
    expect(w.table.get(520)?.command).toBe('/usr/bin/vim notes.txt');
    expect([...w.table.keys()].sort()).toEqual([520, 700, 701, 702]);
  });

  it('never follows a root that is outside the bundle or gone, even to in-bundle children', async () => {
    const shell = [
      { pid: 800, ppid: 1, command: '/bin/zsh -l' },
      { pid: 801, ppid: 800, command: `${BUNDLE}/MacOS/Bogen` },
    ];
    expect(ownTree(parsePs(world(shell).deps.ps()), [800, 999], BUNDLE)).toEqual([]);
    const w = world(shell);
    expect(await stopOwn([800, 999], BUNDLE, w.deps)).toEqual([]);
    expect(w.signals).toEqual([]);
    expect([...w.table.keys()].sort()).toEqual([800, 801]);
  });

  it('is a no-op once everything already exited normally', async () => {
    const w = world(procs.filter((p) => p.pid >= 700));
    expect(await stopOwn([500, 510], BUNDLE, w.deps)).toEqual([]);
    expect(w.signals).toEqual([]);
  });
});

describe('the verifier waits for the app\'s own readiness, bounded', () => {
  it('reads cli.env once the app has written it, not when the server first answers', async () => {
    const w = world([]);
    let reads = 0;
    const read = () => {
      reads++;
      if (reads < 4) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return 'BOGEN_PORT=51234\nBOGEN_APP=dev.bogen.app\n';
    };
    const text = await waitForFile(read, (t: string) => t.includes('BOGEN_PORT=51234'), 'cli.env', w.deps, 20_000);
    expect(text).toContain('BOGEN_PORT=51234');
    expect(w.elapsed()).toBe(450);
  });

  it('fails with what never came after its deadline, never passing on the wrong content', async () => {
    const w = world([]);
    await expect(waitForFile(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, () => true, 'cli.env', w.deps, 3000)).rejects.toThrow('FAILED waiting 3 s for cli.env (not written)');
    expect(w.elapsed()).toBeLessThanOrEqual(3150);
    await expect(waitForFile(() => 'BOGEN_PORT=1\n', (t: string) => t.includes('BOGEN_PORT=51234'), 'cli.env', w.deps, 1000)).rejects.toThrow('written without the expected content');
  });

});
