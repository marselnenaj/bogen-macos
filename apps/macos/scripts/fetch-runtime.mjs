#!/usr/bin/env node
// Downloads the runtimes Bogen.app bundles, as pinned in runtime.json, and verifies them:
//
//   vendor/<arch>/runtime/node/bin/node                       official Node.js for macOS (only the binary and LICENSE)
//   vendor/<arch>/runtime/headless-shell/chrome-headless-shell  Chrome for Testing's headless shell and every file of
//                                                             its archive (licenses, paks, ICU data, libraries)
// Paths come from runtime.json's `layout`. The shell's folder is deliberately not named like its executable.
//
//   node scripts/fetch-runtime.mjs --arch arm64 [--frozen]
//
// Verification:
// - Node: the tarball's SHA-256 must appear in nodejs.org's SHASUMS256.txt for that version, AND equal the value
//   pinned in runtime.json when one is pinned.
// - Headless shell: Chrome for Testing publishes no checksum list, so the SHA-256 pinned in runtime.json is the only
//   check: a value observed from the complete official archive over HTTPS and recorded with its provenance there
//   (not a Google-published checksum). --frozen (CI and releases) refuses unpinned or mismatching files; without
//   it, an unpinned hash is printed for review when a version is bumped.
// - Both: the version a binary reports must be the pinned one, and the headless shell's must meet the browser floor.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { archArg, fail, layout, output, requireDarwin, run, runtime, sha256File, template, vendorDir, versionAtLeast } from './lib.mjs';

const { values } = parseArgs({ options: { arch: { type: 'string' }, frozen: { type: 'boolean' } } });
requireDarwin('fetch-runtime');
const arch = archArg(values.arch);
const frozen = Boolean(values.frozen);
const dest = vendorDir(arch);
const cache = join(dest, '..', 'cache');
mkdirSync(cache, { recursive: true });

async function download(url, file) {
  if (existsSync(file)) return file;
  process.stdout.write(`Downloading ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);
  const part = `${file}.part`;
  writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  renameSync(part, file);
  return file;
}

function checkPinned(what, pinned, actual) {
  if (pinned && pinned !== actual) fail(`${what}: SHA-256 ${actual} does not match the pinned ${pinned}. Refusing it.`);
  if (!pinned) {
    if (frozen) fail(`${what}: no SHA-256 is pinned in runtime.json, and --frozen refuses unpinned files. Observed ${actual}.`);
    process.stdout.write(`UNPINNED ${what}: sha256 ${actual}. Review, then pin it in runtime.json.\n`);
  }
}

// ---------------------------------------------------------------- Node.js

{
  const v = runtime.node.version;
  const node = runtime.node.version;
  const url = template(runtime.node.url, { version: node, arch });
  const name = url.split('/').pop();
  const tarball = await download(url, join(cache, name));
  const sums = await (await fetch(template(runtime.node.shasums, { version: v }))).text();
  const actual = await sha256File(tarball);
  const listed = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}`))?.split(/\s+/)[0];
  if (!listed) fail(`${name} is not listed in SHASUMS256.txt for Node ${v}.`);
  if (listed !== actual) fail(`${name}: SHA-256 ${actual} differs from nodejs.org's ${listed}. Refusing it.`);
  checkPinned(`node-v${v}-darwin-${arch}`, runtime.node.sha256[arch], actual);

  const unpack = join(cache, `node-${arch}`);
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', unpack]);
  const top = join(unpack, readdirSync(unpack)[0]);
  const nodeBin = join(dest, layout.node);
  const target = dirname(dirname(nodeBin));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(nodeBin), { recursive: true });
  // Only the interpreter: the server needs no npm, corepack or headers inside the app.
  copyFileSync(join(top, 'bin', 'node'), nodeBin);
  chmodSync(nodeBin, 0o755);
  copyFileSync(join(top, 'LICENSE'), join(target, 'LICENSE'));
  // Only a binary for this Mac's CPU is run; the other architecture is checked by its digest alone (no Rosetta, no
  // attempt to execute an incompatible file).
  if (arch === process.arch) {
    const reported = output(nodeBin, ['--version']);
    if (reported !== `v${v}`) fail(`The bundled node says ${reported}, expected v${v}.`);
  } else {
    process.stdout.write(`Node for ${arch} not run on this ${process.arch} Mac; verified by SHA-256 only.\n`);
  }
  process.stdout.write(`Node ${v} (${arch}) ready, sha256 ${actual}\n`);
}

// ---------------------------------------------------------------- headless shell

{
  const v = runtime.headlessShell.version;
  if (!versionAtLeast(v, runtime.browserFloor)) fail(`The pinned headless shell ${v} is below the browser floor ${runtime.browserFloor}.`);
  const platform = runtime.headlessShell.platforms[arch];
  const url = template(runtime.headlessShell.url, { version: v, platform });
  const zip = await download(url, join(cache, `chrome-headless-shell-${v}-${platform}.zip`));
  const actual = await sha256File(zip);
  checkPinned(`chrome-headless-shell-${v}-${platform}`, runtime.headlessShell.sha256[arch], actual);
  const unpack = join(cache, `shell-${arch}`);
  rmSync(unpack, { recursive: true, force: true });
  // ditto keeps symlinks, modes and extended attributes the way the zip has them.
  run('ditto', ['-x', '-k', zip, unpack]);
  const top = join(unpack, readdirSync(unpack).find((d) => d.startsWith('chrome-headless-shell')));
  // The whole archive folder, every file kept, under a folder NOT named like the executable (see runtime.json layout).
  const executable = join(dest, layout.headlessShell);
  const target = dirname(executable);
  rmSync(target, { recursive: true, force: true });
  // A folder from an earlier layout (runtime/chrome-headless-shell/chrome-headless-shell) would be copied into the app
  // with everything under runtime/, and codesign would take it for a bundle.
  rmSync(join(dest, 'runtime', 'chrome-headless-shell'), { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(top, target);
  if (!existsSync(executable)) fail(`${executable} is not in the archive where runtime.json's layout expects it.`);
  if (arch === process.arch) {
    const reported = output(executable, ['--version']);
    const m = /(\d+\.\d+\.\d+\.\d+)/.exec(reported);
    if (!m || m[1] !== v) fail(`The headless shell says "${reported}", expected ${v}.`);
  }
  process.stdout.write(`chrome-headless-shell ${v} (${arch}) ready, sha256 ${actual}\n`);
}
