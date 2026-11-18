// Shared by the packaging scripts. Plain Node, no dependencies.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = join(appRoot, '..', '..');
export const runtime = JSON.parse(readFileSync(join(appRoot, 'runtime.json'), 'utf8'));
export const ARCHES = ['arm64', 'x64'];
/** Paths of the bundled runtimes, relative to Contents/Resources and to vendor/<arch>. One place: runtime.json. */
export const layout = runtime.layout;

export function fail(message) {
  process.stderr.write(`bogen-macos: ${message}\n`);
  process.exit(1);
}

/** Packaging steps run macOS tools (codesign, ditto, hdiutil, iconutil); say so instead of half-working elsewhere. */
export function requireDarwin(step) {
  if (process.platform !== 'darwin') fail(`${step} runs on macOS only (this is ${process.platform}). See docs/macos/building.md; on Linux run the tests and npm run build.`);
}

export function archArg(value) {
  const arch = value ?? process.arch;
  if (!ARCHES.includes(arch)) fail(`--arch must be one of ${ARCHES.join(', ')}, not ${arch}.`);
  return arch;
}

export function run(file, args, options = {}) {
  process.stdout.write(`$ ${file} ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
  const r = spawnSync(file, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) fail(`${file} exited with ${r.status ?? r.signal}`);
}

export function output(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

export const template = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`No value for {${k}}`);
  return vars[k];
});

/** a ≥ b for dotted numeric versions such as Chromium's 156.0.8078.80. */
export function versionAtLeast(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export const outDir = join(appRoot, 'out');
export const vendorDir = (arch) => join(appRoot, 'vendor', arch);
export const releaseDir = join(appRoot, 'release');
