// Runs the Bogen server (`node cli.js serve`) as a child of the app, and owns its whole life:
//
//   idle → starting → ready ⇄ (crash → restarting) → failed | stopping → stopped
//
// - The child gets its own process group, so stop() reaches what it started (the headless Chromium for renders,
//   agent runs) even if it is wedged. It also exits by itself when its stdin closes, which is what happens when the
//   app dies without a chance to stop it (BOGEN_EXIT_WITH_STDIN), so no server or Chromium outlives the app.
// - It never kills a process it did not start. A port held by another program, or by a Bogen that is not this app's,
//   is reported with a choice for the person; the only exception is this app's own server from a previous launch,
//   recognised by the pid it wrote into this app's own data folder and the pid it reports over HTTP.
// - Ready means: the server answers /api/status on the port AND reports the pid of our child. Anything else on the
//   port is not ready, however healthy it looks.
//
// Pure apart from the injected dependencies; tests run it on Linux against real child processes.

import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type ProbeAnswer = { kind: 'bogen'; pid?: number; instance?: string; version: string } | { kind: 'other' } | { kind: 'none' } | { kind: 'busy' };

export type Phase = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping' | 'stopped';

export type FailReason =
  | { code: 'port-other'; port: number }
  | { code: 'port-bogen'; port: number; version: string; pid?: number }
  | { code: 'exited'; exitCode: number | null; signal: string | null; tail: string }
  | { code: 'timeout'; seconds: number; tail: string }
  | { code: 'spawn'; message: string }
  | { code: 'crash-loop'; restarts: number; tail: string };

export interface BackendState { phase: Phase; port: number; pid?: number; version?: string; reason?: FailReason; restarts: number }

export interface BackendDeps {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  probe(port: number): Promise<ProbeAnswer>;
  /** Sends a signal to a process group (negative pid) or a process. */
  kill(pid: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
  /**
   * What this app's server wrote into the app's own data folder last time (server.json): its pid and the random
   * instance id the app gave that launch. Both must match what answers on the port before the app ends it.
   */
  previousServer(): { pid: number; instance: string } | null;
  /** A fresh random instance id (32 hex digits) for the next launch. */
  newInstance(): string;
  /** Ends what a dead server left in process groups of their own (reaper.ts). Never runs while a server is up. */
  reap(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(chunk: string): void;
}

export interface BackendConfig {
  node: string;
  cli: string;
  port: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Restarts allowed within `restartWindowMs` before giving up. */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Delay before each restart, by attempt. */
  backoffMs?: number[];
}

const TAIL_LINES = 30;

export class Backend {
  private child: ChildProcess | null = null;
  private state: BackendState;
  private tail: string[] = [];
  private restartTimes: number[] = [];
  private listeners = new Set<(s: BackendState) => void>();
  private stopping: Promise<void> | null = null;
  private generation = 0;
  /** Reaps run one after another, so a late one cannot remove the registry of a server started after it. */
  private reaping: Promise<void> = Promise.resolve();

  constructor(private config: BackendConfig, private readonly deps: BackendDeps) {
    this.state = { phase: 'idle', port: config.port, restarts: 0 };
  }

  get current(): BackendState {
    return { ...this.state };
  }

  get url(): string {
    return `http://127.0.0.1:${this.state.port}`;
  }

  onChange(fn: (s: BackendState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: Partial<BackendState>): void {
    this.state = { ...this.state, ...next };
    if (next.phase && next.phase !== 'failed') delete this.state.reason;
    for (const fn of this.listeners) fn(this.current);
  }

  /** The last lines the server wrote, for an error screen. */
  tailText(): string {
    return this.tail.join('');
  }

  private remember(chunk: string): void {
    this.deps.log(chunk);
    for (const line of chunk.split(/(?<=\n)/)) this.tail.push(line);
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES);
  }

  /** The environment for the next start (a fresh login-shell PATH, say). */
  setEnv(env: NodeJS.ProcessEnv): void {
    this.config = { ...this.config, env };
  }

  /** Changes the port for the next start, after the person chose another one. */
  setPort(port: number): void {
    this.config = { ...this.config, port };
    this.set({ port });
  }

  async start(): Promise<BackendState> {
    if (this.state.phase === 'starting' || this.state.phase === 'ready') return this.current;
    if (this.stopping) await this.stopping;
    this.restartTimes = [];
    return this.launch(0);
  }

  /** Start after a failure, on the person's request. */
  retry(): Promise<BackendState> {
    if (this.state.phase === 'ready' || this.state.phase === 'starting') return Promise.resolve(this.current);
    this.set({ phase: 'idle', restarts: 0 });
    return this.start();
  }

  private async launch(restarts: number): Promise<BackendState> {
    const gen = ++this.generation;
    const port = this.config.port;
    this.tail = [];
    this.set({ phase: restarts ? 'restarting' : 'starting', port, restarts, pid: undefined, version: undefined });

    // Who has the port now?
    let answer = await this.deps.probe(port);
    const previous = this.deps.previousServer();
    if (answer.kind === 'bogen' && previous && answer.pid === previous.pid && answer.instance === previous.instance) {
      // Our own server from a previous launch (the app was killed before it could stop it): same pid AND the random
      // instance id only this app gave it. A pid alone could belong to any program by now. Ours to end.
      this.remember(`bogen-app: stopping this app's previous server, pid ${answer.pid}, instance ${previous.instance}\n`);
      await this.terminate(answer.pid, false);
      answer = await this.deps.probe(port);
    }
    if (answer.kind === 'busy') {
      // Something took the connection and did not answer. Give it a moment, then decide.
      await this.deps.sleep(3000);
      answer = await this.deps.probe(port);
    }
    if (answer.kind === 'bogen') return this.fail({ code: 'port-bogen', port, version: answer.version, ...(answer.pid ? { pid: answer.pid } : {}) });
    if (answer.kind === 'other' || answer.kind === 'busy') return this.fail({ code: 'port-other', port });

    // Whatever an earlier server of ours left running in groups of its own (it is not running now: the port is free).
    await this.reapNow();
    const instance = this.deps.newInstance();
    let child: ChildProcess;
    try {
      child = this.deps.spawn(this.config.node, [this.config.cli, 'serve', '--port', String(port)], {
        cwd: this.config.cwd,
        env: { ...this.config.env, BOGEN_PORT: String(port), BOGEN_EXIT_WITH_STDIN: '1', BOGEN_INSTANCE_ID: instance },
        // Its own process group, so that stop() reaches its children too.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return this.fail({ code: 'spawn', message: (e as Error).message });
    }
    this.child = child;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (e) => {
        this.remember(`bogen-app: ${e.message}\n`);
        resolve({ code: null, signal: null });
      });
    });
    child.stdout?.setEncoding('utf8').on('data', (d: string) => this.remember(d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => this.remember(d));
    // Keep stdin open and unused: its end is the server's signal that the app is gone.
    child.stdin?.on('error', () => {});
    void exited.then((exit) => this.onExit(gen, child, exit));

    const deadline = this.deps.now() + (this.config.readyTimeoutMs ?? 45_000);
    let done = false;
    void exited.then(() => {
      done = true;
    });
    while (!done && this.deps.now() < deadline && gen === this.generation) {
      const a = await this.deps.probe(port);
      if (a.kind === 'bogen' && a.pid === child.pid && a.instance === instance) {
        this.set({ phase: 'ready', pid: child.pid, version: a.version });
        return this.current;
      }
      await this.deps.sleep(150);
    }
    if (gen !== this.generation) return this.current;
    if (done) return this.current; // onExit reported it.
    await this.terminate(child.pid!, true);
    return this.fail({ code: 'timeout', seconds: Math.round((this.config.readyTimeoutMs ?? 45_000) / 1000), tail: this.tailText() });
  }

  private onExit(gen: number, child: ChildProcess, exit: { code: number | null; signal: string | null }): void {
    if (this.child === child) this.child = null;
    if (gen !== this.generation || this.state.phase === 'stopping' || this.state.phase === 'stopped') return;
    // Stray children of a server that crashed: its own group, and the agent runs and render browser it started in
    // groups of their own, which only the reaper knows.
    if (child.pid) this.signalGroup(child.pid, 'SIGTERM');
    void this.reapNow();
    const wasReady = this.state.phase === 'ready' || this.state.phase === 'restarting';
    this.remember(`bogen-app: the server exited (${exit.signal ?? `code ${exit.code}`})\n`);
    if (!wasReady) {
      this.fail({ code: 'exited', exitCode: exit.code, signal: exit.signal, tail: this.tailText() });
      return;
    }
    const now = this.deps.now();
    const window = this.config.restartWindowMs ?? 120_000;
    this.restartTimes = this.restartTimes.filter((t) => now - t < window);
    const max = this.config.maxRestarts ?? 3;
    if (this.restartTimes.length >= max) {
      this.fail({ code: 'crash-loop', restarts: this.restartTimes.length, tail: this.tailText() });
      return;
    }
    this.restartTimes.push(now);
    const backoff = this.config.backoffMs ?? [1000, 3000, 10_000];
    const delay = backoff[Math.min(this.restartTimes.length - 1, backoff.length - 1)] ?? 1000;
    this.set({ phase: 'restarting', restarts: this.restartTimes.length });
    void this.deps.sleep(delay).then(() => {
      if (gen === this.generation && this.state.phase === 'restarting') void this.launch(this.restartTimes.length);
    });
  }

  private reapNow(): Promise<void> {
    this.reaping = this.reaping.then(() => this.deps.reap()).catch((e: Error) => this.remember(`bogen-app: reaper: ${e.message}\n`));
    return this.reaping;
  }

  private fail(reason: FailReason): BackendState {
    this.state = { ...this.state, phase: 'failed', reason };
    for (const fn of this.listeners) fn(this.current);
    return this.current;
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      this.deps.kill(-pid, signal);
    } catch {
      // The group is gone.
    }
  }

  /** SIGTERM, wait, then SIGKILL. `group` for our own child; a single pid for a previous server of ours. */
  private async terminate(pid: number, group: boolean): Promise<void> {
    const send = (s: NodeJS.Signals) => {
      if (group) this.signalGroup(pid, s);
      else {
        try {
          this.deps.kill(pid, s);
        } catch {
          // Gone.
        }
      }
    };
    send('SIGTERM');
    const deadline = this.deps.now() + (this.config.stopTimeoutMs ?? 8000);
    while (this.deps.now() < deadline && this.deps.alive(pid)) await this.deps.sleep(100);
    if (this.deps.alive(pid)) {
      this.remember(`bogen-app: pid ${pid} did not stop in time, killing it\n`);
      send('SIGKILL');
    } else if (group) {
      // The server is gone; make sure nothing it started is left in its group.
      this.signalGroup(pid, 'SIGKILL');
    }
  }

  /** Stops the server and everything in its process group. Safe to call more than once. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.generation++;
    const child = this.child;
    this.set({ phase: 'stopping' });
    this.stopping = (async () => {
      if (child?.pid) await this.terminate(child.pid, true);
      this.child = null;
      // A server that stopped cleanly ended its children itself; one that had to be killed may not have.
      await this.reapNow();
      this.set({ phase: 'stopped', pid: undefined });
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
}

/** Asks `/api/status` on the loopback port, the way the CLI's own probe does. */
export async function probeBogen(port: number, timeoutMs = 2000, fetchImpl: typeof fetch = fetch): Promise<ProbeAnswer> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'other' };
    const body = await res.json().catch(() => null) as { version?: unknown; pid?: unknown; instance?: unknown } | null;
    if (!body || typeof body.version !== 'string') return { kind: 'other' };
    return { kind: 'bogen', version: body.version, ...(typeof body.pid === 'number' ? { pid: body.pid } : {}), ...(typeof body.instance === 'string' ? { instance: body.instance } : {}) };
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'busy' };
    const code = (e as { cause?: { code?: string } }).cause?.code;
    // Refused or unreachable: free. Anything stranger (a TLS server, garbage) means another program.
    if (code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL') return { kind: 'none' };
    return { kind: 'other' };
  }
}

/** Human words for a failure, for the error screen. */
export function describeFailure(r: FailReason): { title: string; detail: string; choices: ('retry' | 'other-port' | 'logs' | 'quit')[] } {
  switch (r.code) {
    case 'port-other':
      return { title: `Port ${r.port} is used by another program`, detail: `Bogen listens on 127.0.0.1:${r.port}, and another program answers there. Bogen does not stop programs it did not start. Pick another port, or quit that program and try again.`, choices: ['other-port', 'retry', 'quit'] };
    case 'port-bogen':
      return { title: `Another Bogen already runs on port ${r.port}`, detail: `A Bogen server (version ${r.version}${r.pid ? `, pid ${r.pid}` : ''}) that this app did not start answers on 127.0.0.1:${r.port}, for example one from the script install (LaunchAgent dev.bogen.server) or a \`bogen serve\` in a terminal. It keeps its designs in another folder. Stop it there, or let this app use another port.`, choices: ['other-port', 'retry', 'quit'] };
    case 'exited':
      return { title: 'The Bogen server stopped while starting', detail: r.tail.trim() || `It exited with ${r.signal ?? `code ${r.exitCode}`}.`, choices: ['retry', 'logs', 'quit'] };
    case 'timeout':
      return { title: `The Bogen server did not answer within ${r.seconds} s`, detail: r.tail.trim() || 'It wrote nothing. A very slow disk can do this.', choices: ['retry', 'logs', 'quit'] };
    case 'spawn':
      return { title: 'The Bogen server could not be started', detail: `${r.message}. The app may be damaged; download it again.`, choices: ['retry', 'logs', 'quit'] };
    case 'crash-loop':
      return { title: 'The Bogen server keeps stopping', detail: `It stopped ${r.restarts} times in two minutes, so Bogen stopped restarting it.\n\n${r.tail.trim()}`, choices: ['retry', 'logs', 'quit'] };
  }
}
