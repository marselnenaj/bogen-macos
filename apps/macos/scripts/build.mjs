#!/usr/bin/env node
// Builds the Electron app folder apps/macos/out/app: the main process, the preload and the app-owned pages.
// Runs on any OS (it is plain esbuild); packaging, signing and the bundled runtimes are macOS-only steps.
//
//   node scripts/build.mjs [--release] [--update-feed https://…]
//
// --release marks a build as a distribution build: dev tools off, and the updater may install updates. Only
// scripts/package.mjs passes it, and only together with a Developer ID identity. Without it, a build is a dev build.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const repo = join(root, '..', '..');
const out = join(root, 'out', 'app');

const { values } = parseArgs({ options: { release: { type: 'boolean' }, 'update-feed': { type: 'string' } } });
const runtime = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(repo, 'packages', 'server', 'package.json'), 'utf8'));

const feed = values['update-feed'] ?? '';
if (feed && !/^https:\/\/[^\s?#@]+$/.test(feed)) throw new Error('--update-feed must be a plain https URL.');

function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

const define = {
  __BOGEN_FLAVOR__: JSON.stringify(values.release ? 'release' : 'dev'),
  __BOGEN_UPDATE_FEED__: JSON.stringify(feed),
  __BOGEN_APP_ID__: JSON.stringify(runtime.bundleId),
  __BOGEN_BUILD__: JSON.stringify(commit()),
};

await build({
  entryPoints: [join(root, 'src', 'main', 'main.ts')],
  outfile: join(out, 'dist', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define,
  legalComments: 'none',
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, 'src', 'preload', 'preload.ts')],
  outfile: join(out, 'dist', 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'chrome140',
  external: ['electron'],
  legalComments: 'none',
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, 'src', 'shell', 'shell.ts')],
  outfile: join(out, 'shell', 'shell.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome140',
  legalComments: 'none',
  logLevel: 'warning',
});
cpSync(join(root, 'src', 'shell', 'index.html'), join(out, 'shell', 'index.html'));
cpSync(join(root, 'src', 'shell', 'shell.css'), join(out, 'shell', 'shell.css'));

// The app's package.json: what Electron reads from app.asar. No dependencies: everything is bundled.
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'bogen', productName: runtime.productName, version: serverPkg.version, main: 'dist/main.cjs', license: 'GPL-3.0-or-later', private: true,
}, null, 2)}\n`);

console.log(`Built ${values.release ? 'release' : 'dev'} app ${serverPkg.version} into ${out}${feed ? ` (update feed ${feed})` : ''}.`);
