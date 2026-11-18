// What verify-app.mjs waits for and what it stops, kept apart so the logic is tested without a Mac.
//
// - A started app's server answers /api/status a moment before the app itself has seen it answer: the app probes its
//   own server every 150 ms and only then (phase "ready") writes cli.env. So "ready" for the verifier is the app's own
//   signal, waited for with a deadline, never a fixed sleep and never skipped.
// - When a check fails, the verifier stops only what it started: the processes it spawned and their descendants as
//   ps shows them, plus the server pid the app reported, each only while its command line is inside the app bundle
//   being verified. SIGTERM first so the app quits its own server and headless shells, then SIGKILL after a deadline.

/** Parses `ps -axo pid=,ppid=,command=` into rows. */
export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/**
 * The given roots and every descendant of them, as pids, walking only through processes whose command line is inside
 * `bundle` (the verified app's Contents folder): a root that is gone or outside the bundle is not followed, nor is any
 * child outside it, so a user's other processes are never in the result.
 */
export function ownTree(rows, roots, bundle) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const inside = (pid) => Boolean(byPid.get(pid)?.command.includes(bundle));
  const children = new Map();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const seen = new Set();
  const queue = roots.filter((p) => Number.isInteger(p) && p > 1 && inside(p));
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) if (inside(c.pid)) queue.push(c.pid);
  }
  return [...seen];
}

/**
 * Stops the verifier's own processes: SIGTERM to the roots (the app quits its server and shells itself), then
 * SIGTERM to what remains of the tree, then SIGKILL, each step bounded. A process is known by its pid and its exact
 * command line as first seen; before every signal a fresh `ps` must still show that pid with that command, else it
 * is forgotten (it exited, or its pid now belongs to something else) and never signalled. Returns the pids of its own
 * processes still running at the end (empty when everything is gone).
 * `deps`: { ps(): string, kill(pid, signal), sleep(ms), now() }.
 */
export async function stopOwn(roots, bundle, deps, { graceMs = 20_000, termMs = 10_000, killMs = 5_000 } = {}) {
  /** pid -> command line, of processes known to be ours. */
  const own = new Map();
  const fresh = () => new Map(parsePs(deps.ps()).map((r) => [r.pid, r.command]));
  const adopt = (rows, from) => {
    const commands = new Map(rows.map((r) => [r.pid, r.command]));
    for (const pid of ownTree(rows, from, bundle)) if (!own.has(pid)) own.set(pid, commands.get(pid));
  };
  /** Forgets every remembered process that ps no longer shows with the same command; returns what is left. */
  const still = () => {
    const now = fresh();
    for (const [pid, command] of own) if (now.get(pid) !== command) own.delete(pid);
    return [...own.keys()];
  };
  const signal = (pids, sig) => {
    for (const pid of pids) {
      // Identity again, right before the signal: never a pid that was reused for another command.
      if (!own.has(pid) || fresh().get(pid) !== own.get(pid)) {
        own.delete(pid);
        continue;
      }
      try {
        deps.kill(pid, sig);
      } catch {
        own.delete(pid); // already gone
      }
    }
  };
  const waitGone = async (ms) => {
    const end = deps.now() + ms;
    while (deps.now() < end) {
      // Children that appeared meanwhile under one of its own live processes are its own too.
      const live = still();
      if (!live.length) return;
      adopt(parsePs(deps.ps()), live);
      await deps.sleep(200);
    }
  };
  adopt(parsePs(deps.ps()), roots);
  signal(roots.filter((p) => own.has(p)), 'SIGTERM');
  await waitGone(graceMs);
  let left = still();
  if (left.length) {
    signal(left, 'SIGTERM');
    await waitGone(termMs);
    left = still();
  }
  if (left.length) {
    signal(left, 'SIGKILL');
    await waitGone(killMs);
    left = still();
  }
  return left;
}

/**
 * Waits, up to `ms`, for a file the app writes once it is ready to say what it should: `read()` returns its text or
 * throws while it is not there; `accept(text)` says whether it is complete. Returns the text, or throws an Error that
 * says what never came, so the caller's cleanup runs.
 */
export async function waitForFile(read, accept, what, deps, ms) {
  const end = deps.now() + ms;
  let last = 'not written';
  while (deps.now() < end) {
    try {
      const text = read();
      if (accept(text)) return text;
      last = 'written without the expected content';
    } catch (e) {
      last = e && e.code === 'ENOENT' ? 'not written' : String(e && e.message ? e.message : e);
    }
    await deps.sleep(150);
  }
  throw new Error(`FAILED waiting ${Math.round(ms / 1000)} s for ${what} (${last})`);
}
