#!/usr/bin/env node
// The Bogen installer: a disk image that opens to one window, Bogen on the left, Applications on the right, an arrow
// between them and a line on what happens next. macOS only (hdiutil, ditto, tiffutil, xattr).
//
//   node scripts/make-dmg.mjs --arch arm64            # from release/dev/arm64: Bogen-<v>-arm64-dev-unsigned.dmg
//   node scripts/make-dmg.mjs --arch arm64 --release --identity "Developer ID Application: … (TEAMID)"
//
// How: a writable HFS+ image is made and mounted privately (no Finder window, not on the desktop, at a random mount
// point under out/), the app is copied in with ditto (signatures, symlinks and extended attributes intact), then
// Applications (a symbolic link to /Applications), the background picture (1× and 2× in one TIFF), the volume icon
// and the window layout (.DS_Store, written by dmg-layout.mjs, no Finder scripting). The image is detached, compressed
// read-only (ULFO) and checked with hdiutil verify. Everything is undone on failure. Nothing asks for administrator
// rights: installing is dragging the app into Applications, and updates replace it in place (docs/macos/building.md).
//
// A release DMG is signed with the same identity; notarize and staple it afterwards with notarize.mjs. A dev DMG is
// named as such, says so in its window and volume name, is not signed for distribution, and is never published.
// verify-dmg.mjs checks the result.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appRoot, archArg, fail, layout, outDir, releaseDir, repoRoot, requireDarwin, run, runtime, vendorDir } from './lib.mjs';
import { aliasRecord, BACKGROUND_SIZE, backgroundSvg, CUSTOM_ICON_FINDER_INFO, dmgPlan, dsStore, layoutRecords } from './dmg-layout.mjs';
import { checkIdentity } from './sign-lib.mjs';

const { values } = parseArgs({ options: { arch: { type: 'string' }, release: { type: 'boolean' }, identity: { type: 'string' } } });
requireDarwin('make-dmg');
const arch = archArg(values.arch);
const release = Boolean(values.release);
if (release && !values.identity) fail('--release needs --identity "Developer ID Application: … (TEAMID)". Without one, build a development DMG (no --release).');
if (!release && values.identity) fail('--identity is for --release DMGs.');
const version = JSON.parse(readFileSync(join(repoRoot, 'packages', 'server', 'package.json'), 'utf8')).version;
let plan;
try {
  plan = dmgPlan({ version, arch, release, productName: runtime.productName });
} catch (e) {
  fail(e.message);
}
const flavor = release ? 'release' : 'dev';
const app = join(releaseDir, flavor, arch, plan.app);
if (!existsSync(join(app, 'Contents', 'Info.plist'))) fail(`${app} is missing. Run node scripts/package.mjs --arch ${arch}${release ? ' --release --identity "…"' : ''} first.`);
if (release) {
  checkIdentity(values.identity);
  // A release image only ever holds an app signed for distribution: never a development build relabelled.
  const details = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' }).stderr;
  if (!/Authority=Developer ID Application: /.test(details)) fail(`${app} is not signed with a Developer ID Application identity. Build it with package.mjs --release first.`);
}

const work = join(outDir, `dmg-${arch}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ---------------------------------------------------------------- the background picture, 1× and 2×

async function renderBackground() {
  const shell = join(vendorDir(process.arch), layout.headlessShell);
  if (!existsSync(shell)) fail(`${shell} is missing: the background is drawn with this Mac's headless shell. Run node scripts/fetch-runtime.mjs --arch ${process.arch}.`);
  const { pathToFileURL } = await import('node:url');
  const { default: puppeteer } = await import(pathToFileURL(join(repoRoot, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js')).href);
  // Sandbox stays on: no --no-sandbox, on CI or anywhere else.
  const browser = await puppeteer.launch({ executablePath: shell, headless: true, pipe: true, args: ['--force-color-profile=srgb', '--disable-background-networking', '--disable-extensions', '--no-first-run'] });
  const files = [];
  try {
    const page = await browser.newPage();
    for (const scale of [1, 2]) {
      await page.setViewport({ ...BACKGROUND_SIZE, deviceScaleFactor: scale });
      await page.setContent(`<!doctype html><html><body style="margin:0">${backgroundSvg(plan)}</body></html>`);
      const file = join(work, scale === 1 ? 'background.png' : 'background@2x.png');
      writeFileSync(file, await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...BACKGROUND_SIZE } }));
      files.push(file);
    }
  } finally {
    await browser.close();
  }
  const tiff = join(work, 'background.tiff');
  run('tiffutil', ['-cathidpicheck', ...files, '-out', tiff]);
  return tiff;
}

const background = await renderBackground();
const icon = join(outDir, 'icon', 'Bogen.icns');
if (!existsSync(icon)) run(process.execPath, [join(appRoot, 'scripts', 'make-icon.mjs'), '--arch', process.arch]);

// ---------------------------------------------------------------- a writable image, mounted privately

const sizeKb = Number(execFileSync('du', ['-sk', app], { encoding: 'utf8' }).split(/\s/)[0]);
const sizeMb = Math.ceil((sizeKb * 1.15) / 1024) + 40;
const rw = join(work, 'rw.dmg');
run('hdiutil', ['create', '-size', `${sizeMb}m`, '-fs', 'HFS+', '-volname', plan.volumeName, '-ov', rw]);

const plist = (text) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: text, encoding: 'utf8' }));
const mounts = mkdtempSync(join(work, 'mnt-'));
let device = null;
let mount = null;

/** Like run(), but throws, so that a failure while the image is attached still detaches it. */
function step(file, args) {
  process.stdout.write(`$ ${file} ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
  const r = spawnSync(file, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${file} exited with ${r.status ?? r.signal}`);
}

function detach(force = false) {
  for (let i = 0; device && i < 6; i++) {
    const r = spawnSync('hdiutil', ['detach', device, ...(force || i === 5 ? ['-force'] : [])], { encoding: 'utf8' });
    if (r.status === 0) {
      device = null;
      return;
    }
    process.stdout.write(`hdiutil detach: ${r.stderr.trim()} (try ${i + 1})\n`);
    spawnSync('sleep', ['2']);
  }
  if (device) throw new Error(`Could not detach ${device}`);
}

try {
  const attached = plist(execFileSync('hdiutil', ['attach', rw, '-readwrite', '-noverify', '-noautoopen', '-nobrowse', '-owners', 'off', '-mountrandom', mounts, '-plist'], { encoding: 'utf8' }));
  const entity = attached['system-entities'].find((e) => e['mount-point']);
  if (!entity) throw new Error('hdiutil attach reported no mount point');
  mount = entity['mount-point'];
  device = attached['system-entities'].find((e) => /^\/dev\/disk\d+$/.test(e['dev-entry']))?.['dev-entry'] ?? entity['dev-entry'];
  process.stdout.write(`Mounted ${plan.volumeName} at ${mount} (${device})\n`);

  step('ditto', ['--rsrc', '--extattr', app, join(mount, plan.app)]);
  symlinkSync('/Applications', join(mount, 'Applications'));
  mkdirSync(join(mount, '.background'));
  cpSync(background, join(mount, plan.background));
  cpSync(icon, join(mount, plan.volumeIcon));
  // The volume shows its own icon: "has custom icon" in the root folder's Finder info.
  step('xattr', ['-wx', 'com.apple.FinderInfo', CUSTOM_ICON_FINDER_INFO, mount]);

  // The layout, with the background referenced from the files just written on this volume.
  const bg = statSync(join(mount, plan.background));
  const alias = aliasRecord({
    volumeName: plan.volumeName, volumeCreated: statSync(mount).birthtimeMs, mountPoint: `/Volumes/${plan.volumeName}`,
    path: `/${plan.background}`, cnid: bg.ino, parentCnid: statSync(join(mount, '.background')).ino, created: bg.birthtimeMs,
  });
  writeFileSync(join(mount, '.DS_Store'), dsStore(layoutRecords(plan, alias)));

  // Only what the plan names stays at the top of the volume (macOS adds .fseventsd and the like while mounted).
  for (const name of readdirSync(mount)) if (!plan.entries.includes(name)) rmSync(join(mount, name), { recursive: true, force: true });
  step('chmod', ['-Rf', 'go-w', mount]);
  step('sync', []);
  detach();

  const name = plan.fileName;
  const dmg = join(releaseDir, flavor, name);
  rmSync(dmg, { force: true });
  step('hdiutil', ['convert', rw, '-format', 'ULFO', '-o', dmg]);
  if (release) {
    step('codesign', ['--sign', values.identity, '--timestamp', dmg]);
    step('codesign', ['--verify', '--verbose=2', dmg]);
  }
  step('hdiutil', ['verify', dmg]);
  rmSync(work, { recursive: true, force: true });
  process.stdout.write(`${dmg}\n`);
  process.stdout.write(`Check it: node scripts/verify-dmg.mjs --dmg "${dmg}"${release ? ' --release' : ''}\n`);
  process.stdout.write(release ? `Next: node scripts/notarize.mjs --path "${dmg}" --keychain-profile <profile>\n` : 'Development DMG: ad-hoc signed app, image not signed for distribution, not notarized. For Macs you control.\n');
} catch (e) {
  try {
    detach(true);
  } catch (d) {
    process.stderr.write(`bogen-macos: ${d.message}\n`);
  }
  fail(`The disk image was not made: ${e.message}`);
}
