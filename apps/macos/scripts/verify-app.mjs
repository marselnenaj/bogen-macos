#!/usr/bin/env node
// Checks a built Bogen.app. macOS only. Exits non-zero on the first failed check, and prints what it checked.
//
//   node scripts/verify-app.mjs --app release/dev/arm64/Bogen.app [--release] [--notarized] [--gui]
//
// Always: Info.plist (identity, minimum macOS, document type, no ATS exceptions), Electron fuses, nested signatures
//   (codesign --verify --deep --strict), the bundled node and headless shell versions (when the app is for this CPU),
//   and a functional run of the bundled server through the app's own launcher in a temporary data folder:
//   /api/status, the editor page, `bogen doctor --json` with a real render in the bundled headless shell, and the
//   engine's run-time files over `bogen mcp` (an icon set from server/dist/icon-sets, a WOFF2 font build, axe-core in
//   the headless shell; verify-engine.mjs); then a stop, after which no process from the bundle may remain.
// --release:   Developer ID authority, hardened runtime, the exact entitlements: allow-jit and audio input on the app
//              (build/entitlements-shell.plist), allow-jit alone on the bundled node (build/entitlements.plist).
// --notarized: Gatekeeper assessment (spctl) and a stapled ticket.
// --gui:       launches the app itself (dev builds: in an isolated BOGEN_APP_HOME), waits for its server, quits it with
//              SIGTERM, and checks that the server and every headless shell are gone.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { appRoot, fail, layout, output, repoRoot, requireDarwin, runtime, versionAtLeast } from './lib.mjs';
import { transportSecurityLeft } from './plist-policy.mjs';
import { payloadPlan, shallowBundleTraps } from './sign-plan.mjs';
import { engineChecks, expectedIconSets, mcpStdio, staticEngineProblems } from './verify-engine.mjs';
import { stopOwn, waitForFile } from './verify-processes.mjs';

// Validation never starts a real agent CLI or reaches a model provider: stand-ins that say "not installed" come first
// on PATH, then only the system folders. The login shell is not asked (SHELL is not a path).
const OFFLINE_PATH = [join(appRoot, 'test', 'fixtures', 'offline-bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const offline = (extra) => ({ ...process.env, PATH: OFFLINE_PATH, SHELL: 'validation-no-login-shell', ...extra });

const { values } = parseArgs({ options: { app: { type: 'string' }, release: { type: 'boolean' }, notarized: { type: 'boolean' }, gui: { type: 'boolean' } } });
requireDarwin('verify-app');
const app = values.app ?? fail('--app <path to Bogen.app> is required.');
const contents = join(app, 'Contents');
const resources = join(contents, 'Resources');
const ok = (what) => process.stdout.write(`ok    ${what}\n`);
const check = (cond, what) => (cond ? ok(what) : fail(`FAILED ${what}`));
const plist = (path) => JSON.parse(output('plutil', ['-convert', 'json', '-o', '-', path]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Info.plist

const info = plist(join(contents, 'Info.plist'));
check(info.CFBundleIdentifier === runtime.bundleId, `bundle id ${info.CFBundleIdentifier}`);
check(info.LSMinimumSystemVersion === runtime.minimumSystemVersion, `minimum macOS ${info.LSMinimumSystemVersion}`);
check(!('NSAppTransportSecurity' in info), 'no App Transport Security exceptions');
const atsLeft = transportSecurityLeft(app);
check(atsLeft.length === 0, `no App Transport Security exceptions in any helper app either${atsLeft.length ? `: ${atsLeft.join(', ')}` : ''}`);
check(info.CFBundleDocumentTypes?.some((d) => d.LSItemContentTypes?.includes('dev.bogen.document')), '.bogen document type');
check(typeof info.NSMicrophoneUsageDescription === 'string' && info.NSMicrophoneUsageDescription.length > 20, 'microphone usage description (speaking instead of typing)');
check(Boolean(info.ElectronAsarIntegrity), 'asar integrity hash in Info.plist');
const framework = plist(join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist'));
if (framework.LSMinimumSystemVersion) check(versionAtLeast(runtime.minimumSystemVersion, framework.LSMinimumSystemVersion), `Electron needs macOS ${framework.LSMinimumSystemVersion}, the app declares ${runtime.minimumSystemVersion}`);

// ---------------------------------------------------------------- fuses

const wire = await getCurrentFuseWire(join(contents, 'MacOS', runtime.productName));
const want = {
  RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: false,
};
for (const [name, on] of Object.entries(want)) {
  const state = wire[FuseV1Options[name]];
  check(state === (on ? FuseState.ENABLE : FuseState.DISABLE), `fuse ${name} ${on ? 'on' : 'off'}`);
}

// ---------------------------------------------------------------- signatures

const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8' });
check(verify.status === 0, `codesign --verify --deep --strict${verify.status ? `: ${verify.stderr.trim()}` : ''}`);
if (values.release) {
  const details = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' }).stderr;
  check(/Authority=Developer ID Application: /.test(details), 'signed with a Developer ID Application identity');
  check(/flags=0x10000\(runtime\)/.test(details), 'hardened runtime');
  check(/Timestamp=/.test(details), 'secure timestamp');
  const entitlementKeys = (file) => [...output('codesign', ['-d', '--entitlements', ':-', file]).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
  const keys = entitlementKeys(join(contents, 'MacOS', runtime.productName));
  check(JSON.stringify(keys) === JSON.stringify(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input']), `app entitlements are exactly allow-jit and audio input (${keys.join(', ')})`);
  const nodeKeys = entitlementKeys(join(resources, layout.node));
  check(JSON.stringify(nodeKeys) === JSON.stringify(['com.apple.security.cs.allow-jit']), `bundled node entitlements are exactly allow-jit (${nodeKeys.join(', ')})`);
}
if (values.notarized) {
  check(spawnSync('xcrun', ['stapler', 'validate', app]).status === 0, 'notarization ticket stapled');
  const gk = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { encoding: 'utf8' });
  check(gk.status === 0 && /source=Notarized Developer ID/.test(gk.stderr), `Gatekeeper accepts it: ${gk.stderr.trim()}`);
}

// ---------------------------------------------------------------- bundled runtimes

const node = join(resources, layout.node);
const shell = join(resources, layout.headlessShell);
check(shallowBundleTraps(app).length === 0, 'no executable outside a bundle shares its folder\'s name');
// Every Mach-O of Bogen's payload carries a valid signature of its own, strictly checked.
for (const { file } of payloadPlan(app)) {
  const v = spawnSync('codesign', ['--verify', '--strict', file], { encoding: 'utf8' });
  if (v.status !== 0) fail(`FAILED payload signature ${file}: ${v.stderr.trim()}`);
}
ok(`payload signatures (${payloadPlan(app).length} Mach-O files in Resources)`);
for (const f of ['ABOUT', 'LICENSE.headless_shell']) {
  if (!statSync(join(dirname(shell), f), { throwIfNoEntry: false })) fail(`FAILED ${f} is missing next to the headless shell`);
}
ok('the headless shell keeps its own license files');
const engineProblems = staticEngineProblems(join(resources, 'server', 'dist'), expectedIconSets(repoRoot));
check(engineProblems.length === 0, `server/dist has the editor, workers and every icon set${engineProblems.length ? `: ${engineProblems.join('; ')}` : ''}`);
const binArch = output('lipo', ['-archs', node]);
const native = binArch.split(' ').includes(process.arch);
if (native) {
  check(output(node, ['--version']) === `v${runtime.node.version}`, `bundled node v${runtime.node.version}`);
  const shellVersion = /(\d+\.\d+\.\d+\.\d+)/.exec(output(shell, ['--version']))?.[1] ?? '';
  check(versionAtLeast(shellVersion, runtime.browserFloor), `headless shell ${shellVersion} ≥ floor ${runtime.browserFloor}`);
} else {
  ok(`runtimes are ${binArch}; version and functional checks need a ${binArch} Mac (skipped, not passed)`);
}

// ---------------------------------------------------------------- functional: the server through the app's launcher

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function bundleProcesses() {
  const ps = output('ps', ['-axo', 'pid=,command=']);
  return ps.split('\n').filter((l) => l.includes(resources));
}

// Inside the functional sections a failed check throws, so that their finally stops what they started before the
// process exits; fail() would exit at once and leave the app, its helpers and its server running.
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`FAILED waiting for ${what}`);
}
const must = (cond, what) => {
  if (!cond) throw new Error(`FAILED ${what}`);
  ok(what);
};
const procDeps = {
  ps: () => output('ps', ['-axo', 'pid=,ppid=,command=']),
  kill: (pid, signal) => process.kill(pid, signal),
  sleep,
  now: () => Date.now(),
};
/** Resolves when the child has exited, or throws after `ms`. */
function exitWithin(exited, ms, what) {
  let timer;
  return Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`FAILED ${what} did not exit within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer));
}
/** Waits, bounded, for every process of the bundle to be gone, then checks it strictly. */
async function noneLeft(what) {
  const end = Date.now() + 15_000;
  while (Date.now() < end && bundleProcesses().length) await sleep(250);
  const left = bundleProcesses();
  must(left.length === 0, `${what}${left.length ? `: ${left.join('; ')}` : ''}`);
}
/** After a failure: stops only this verifier's own processes, and says what it stopped or could not. */
async function cleanUp(roots, failure) {
  const left = await stopOwn(roots.filter((p) => Number.isInteger(p)), contents, procDeps);
  if (left.length) process.stderr.write(`bogen-macos: could not stop the verifier's own processes ${left.join(', ')}\n`);
  return failure ?? (left.length ? new Error(`FAILED the verifier's own processes ${left.join(', ')} kept running`) : null);
}

if (native) {
  const home = mkdtempSync(join(tmpdir(), 'bogen-verify-'));
  const port = await freePort();
  const env = offline({ BOGEN_HOME: join(home, 'data'), BOGEN_PORT: String(port), BOGEN_WELCOME: '0' });
  const launcher = join(resources, 'bin', 'bogen');
  let server;
  let mcp = null;
  let failure = null;
  try {
    must(output(launcher, ['--version'], { env }).length > 0, 'launcher runs the bundled server code');
    server = spawn(launcher, ['serve'], { env, stdio: ['pipe', 'inherit', 'inherit'] });
    const exited = new Promise((r) => server.once('exit', r));
    const status = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json(), 30_000, 'the bundled server');
    must(typeof status.version === 'string', `server ${status.version} answers on 127.0.0.1:${port}`);
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    must(/<div id="root"|<script type="module"/.test(page), 'editor page is served');
    // doctor exits non-zero when anything on this runner fails (no Tailscale, say); only its Browser line matters here.
    const doctorRun = spawnSync(launcher, ['doctor', '--json'], { env, timeout: 120_000, encoding: 'utf8' });
    const doctor = JSON.parse(doctorRun.stdout || '[]');
    const browserCheck = doctor.find((c) => c.label === 'Browser');
    must(browserCheck?.state === 'ok', `a real render in the bundled headless shell (${browserCheck?.detail ?? 'no Browser check'})`);
    mcp = mcpStdio(launcher, ['mcp'], { env });
    await engineChecks((name, args) => mcp.call(name, args), must);
    await mcp.close();
    mcp = null;
    server.kill('SIGTERM');
    await exitWithin(exited, 30_000, 'the bundled server');
    await noneLeft('no process from the bundle is left after stop');
  } catch (e) {
    failure = e;
  } finally {
    if (mcp) await mcp.close().catch(() => {});
    failure = await cleanUp([server?.pid, mcp?.pid], failure);
    rmSync(home, { recursive: true, force: true });
  }
  if (failure) fail(failure.message);
}

// ---------------------------------------------------------------- functional: the app itself

if (values.gui) {
  if (values.release) fail('--gui runs development builds only: a release build always uses the real home folder.');
  if (!native) fail('--gui needs an app for this Mac\'s CPU.');
  const home = mkdtempSync(join(tmpdir(), 'bogen-gui-'));
  const port = await freePort();
  const support = join(home, 'Library', 'Application Support', 'Bogen');
  mkdirSync(support, { recursive: true });
  writeFileSync(join(support, 'settings.json'), JSON.stringify({ port, legacyImportAnswered: true, welcomed: true }));
  let gui;
  let serverPid;
  let failure = null;
  try {
    gui = spawn(join(contents, 'MacOS', runtime.productName), [], { env: offline({ BOGEN_APP_HOME: home }), stdio: 'inherit' });
    const exited = new Promise((r) => gui.once('exit', r));
    const status = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json(), 60_000, 'the app to start its server');
    serverPid = status.pid;
    must(/^[0-9a-f]{32}$/.test(status.instance ?? ''), `the app started its own server (pid ${status.pid}, instance ${status.instance})`);
    // The server answers a moment before the app has seen it answer; the app writes cli.env once it has (phase ready).
    await waitForFile(() => readFileSync(join(support, 'cli.env'), 'utf8'), (text) => text.includes(`BOGEN_PORT=${port}`), 'the app to write the launcher environment (cli.env)', procDeps, 20_000);
    ok('the app wrote the launcher environment');
    await waitForFile(() => String(statSync(join(home, 'Library', 'Logs', 'Bogen', 'backend.log')).size), (size) => Number(size) > 0, 'backend.log in ~/Library/Logs/Bogen', procDeps, 10_000);
    ok('backend.log is written to ~/Library/Logs/Bogen');
    gui.kill('SIGTERM');
    await exitWithin(exited, 30_000, 'the app');
    await noneLeft('quitting the app leaves no server or headless shell');
  } catch (e) {
    failure = e;
  } finally {
    failure = await cleanUp([gui?.pid, serverPid], failure);
    rmSync(home, { recursive: true, force: true });
  }
  if (failure) fail(failure.message);
}

const size = output('du', ['-sh', app]).split('\t')[0];
process.stdout.write(`\nAll checks passed for ${app} (${size}).\n`);
