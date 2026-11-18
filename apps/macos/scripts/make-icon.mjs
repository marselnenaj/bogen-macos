#!/usr/bin/env node
// Renders build/icon.svg to out/icon/Bogen.icns. macOS only: it uses the pinned headless shell from vendor/<arch>
// (fetch-runtime.mjs) through puppeteer-core over a pipe with Chromium's sandbox on, then sips and iconutil.
//
//   node scripts/make-icon.mjs --arch arm64

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appRoot, archArg, fail, layout, outDir, repoRoot, requireDarwin, run, vendorDir } from './lib.mjs';

const { values } = parseArgs({ options: { arch: { type: 'string' } } });
requireDarwin('make-icon');
const arch = archArg(values.arch);
if (arch !== process.arch) fail(`make-icon runs the headless shell, so --arch must be this Mac's (${process.arch}).`);

const { pathToFileURL } = await import('node:url');
const { default: puppeteer } = await import(pathToFileURL(join(repoRoot, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href);
const svg = readFileSync(join(appRoot, 'build', 'icon.svg'), 'utf8');
const browser = await puppeteer.launch({
  executablePath: join(vendorDir(arch), layout.headlessShell),
  headless: true,
  pipe: true,
  // Sandbox stays on: no --no-sandbox, on CI or anywhere else.
  args: ['--force-color-profile=srgb', '--disable-background-networking', '--disable-extensions', '--no-first-run'],
});
let png;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
} finally {
  await browser.close();
}

const dir = join(outDir, 'icon');
const set = join(dir, 'Bogen.iconset');
rmSync(dir, { recursive: true, force: true });
mkdirSync(set, { recursive: true });
const master = join(dir, 'icon-1024.png');
writeFileSync(master, png);
for (const size of [16, 32, 128, 256, 512]) {
  run('sips', ['-z', String(size), String(size), master, '--out', join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
  run('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
}
run('iconutil', ['-c', 'icns', '-o', join(dir, 'Bogen.icns'), set]);
process.stdout.write(`Wrote ${join(dir, 'Bogen.icns')}\n`);
