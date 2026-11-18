#!/usr/bin/env node
// Checks a Bogen disk image the way a person uses it. macOS only. Exits non-zero on the first failed check, and prints
// what it checked.
//
//   node scripts/verify-dmg.mjs --dmg release/dev/Bogen-0.1.0-arm64-dev-unsigned.dmg [--release] [--notarized]
//
// Always: the image's checksum (hdiutil verify); mounted read-only and privately (nothing opens in Finder), the top of
// the volume holds exactly the app, Applications as a link to /Applications, the background, the volume icon and the
// window layout; the volume shows its own icon; the layout's window, icon view, background alias and icon positions
// (dmg-layout.mjs's reader, and plutil for the property lists); the app's bundle id, version and strict signature.
// Then an install the way Finder does it, by copying the app with ditto into a folder with spaces and non-ASCII
// characters in its path (standing in for Applications, so nothing on this Mac is touched and no password is asked),
// the copy's signature and the bundled command line launcher run from the copy. The image is detached in every case.
// --release:   the image is signed with a Developer ID Application identity, as is the app in it.
// --notarized: Gatekeeper accepts the image (spctl, open) and its ticket is stapled.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, output, repoRoot, requireDarwin, runtime } from './lib.mjs';
import { dmgPlan, readAlias, readDsStore, readIloc } from './dmg-layout.mjs';

const { values } = parseArgs({ options: { dmg: { type: 'string' }, release: { type: 'boolean' }, notarized: { type: 'boolean' } } });
requireDarwin('verify-dmg');
const dmg = values.dmg ?? fail('--dmg <path to the .dmg> is required.');
if (!existsSync(dmg)) fail(`${dmg} does not exist.`);
const ok = (what) => process.stdout.write(`ok    ${what}\n`);
const must = (cond, what) => {
  if (!cond) throw new Error(`FAILED ${what}`);
  ok(what);
};
const plistJson = (input) => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input }).toString('utf8'));
/** One value of a property list, by Apple's own parser; data comes back as base64. Works where JSON cannot hold data. */
const pget = (input, key) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', '-'], { input }).toString('utf8').trim();

const version = JSON.parse(readFileSync(join(repoRoot, 'packages', 'server', 'package.json'), 'utf8')).version;
const arch = /-(arm64|x64)(?:-dev-unsigned)?\.dmg$/.exec(basename(dmg))?.[1] ?? fail(`${basename(dmg)} is not named like a Bogen disk image.`);
const plan = dmgPlan({ version, arch, release: Boolean(values.release), productName: runtime.productName });
if (basename(dmg) !== plan.fileName) fail(`${basename(dmg)} should be named ${plan.fileName} for a ${values.release ? 'release' : 'development'} image of ${version}.`);
ok(`named ${plan.fileName}`);

const verified = spawnSync('hdiutil', ['verify', dmg], { encoding: 'utf8' });
if (verified.status !== 0) fail(`FAILED hdiutil verify: ${verified.stderr.trim()}`);
ok('checksum (hdiutil verify)');
const format = pget(execFileSync('hdiutil', ['imageinfo', '-plist', dmg]), 'Format');
if (format !== 'ULFO') fail(`FAILED the image is ${format}, not compressed read-only ULFO`);
ok('compressed read-only image (ULFO)');
if (values.release) {
  const sig = spawnSync('codesign', ['-dvv', dmg], { encoding: 'utf8' }).stderr;
  if (!/Authority=Developer ID Application: /.test(sig)) fail('FAILED the image is not signed with a Developer ID Application identity');
  ok('image signed with a Developer ID Application identity');
}
if (values.notarized) {
  if (spawnSync('xcrun', ['stapler', 'validate', dmg]).status !== 0) fail('FAILED no stapled notarization ticket on the image');
  const gk = spawnSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg], { encoding: 'utf8' });
  if (gk.status !== 0 || !/source=Notarized Developer ID/.test(gk.stderr)) fail(`FAILED Gatekeeper: ${gk.stderr.trim()}`);
  ok('Gatekeeper accepts the image, notarized and stapled');
}

const work = mkdtempSync(join(tmpdir(), 'bogen-verify-dmg-'));
let device = null;
let failure = null;
try {
  const attached = plistJson(execFileSync('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountrandom', work, '-plist']));
  const entity = attached['system-entities'].find((e) => e['mount-point']);
  device = attached['system-entities'].find((e) => /^\/dev\/disk\d+$/.test(e['dev-entry']))?.['dev-entry'] ?? entity?.['dev-entry'];
  must(entity, 'mounts read-only, privately');
  const mount = entity['mount-point'];
  const volumeName = pget(execFileSync('diskutil', ['info', '-plist', mount]), 'VolumeName');
  must(volumeName === plan.volumeName, `volume name "${volumeName}"`);

  // The top of the volume: exactly the plan's entries (macOS may add its own housekeeping folders while mounted).
  const top = readdirSync(mount).filter((n) => !['.fseventsd', '.Trashes', '.Spotlight-V100', '.TemporaryItems'].includes(n)).sort();
  must(JSON.stringify(top) === JSON.stringify([...plan.entries].sort()), `top of the volume: ${top.join(', ')}`);
  must(lstatSync(join(mount, 'Applications')).isSymbolicLink() && readlinkSync(join(mount, 'Applications')) === '/Applications', 'Applications links to /Applications');
  must(existsSync(join(mount, plan.background)), `background picture ${plan.background}`);
  const reps = output('tiffutil', ['-info', join(mount, plan.background)]);
  must((reps.match(/Image Width/g) ?? []).length >= 2, 'background has 1× and 2× representations');
  must(existsSync(join(mount, plan.volumeIcon)), 'volume icon present');
  const finderInfo = output('xattr', ['-px', 'com.apple.FinderInfo', mount]).replace(/\s+/g, '');
  must((parseInt(finderInfo.slice(16, 20), 16) & 0x0400) !== 0, 'the volume shows its own icon (kHasCustomIcon)');

  // The window: one view, no toolbar or sidebar, picture background, every icon in place.
  const { records } = readDsStore(readFileSync(join(mount, '.DS_Store')));
  const rec = (name, code) => records.find((r) => r.name === name && r.code === code);
  const bwsp = rec('.', 'bwsp').value;
  const { x, y, width, height } = plan.window;
  const bounds = pget(bwsp, 'WindowBounds');
  must(bounds === `{{${x}, ${y}}, {${width}, ${height}}}` && pget(bwsp, 'ShowToolbar') === 'false' && pget(bwsp, 'ShowSidebar') === 'false', `window ${bounds}, no toolbar or sidebar`);
  const icvp = rec('.', 'icvp').value;
  must(pget(icvp, 'backgroundType') === '2' && pget(icvp, 'arrangeBy') === 'none' && Number(pget(icvp, 'iconSize')) === plan.iconSize, `icon view, ${plan.iconSize} pt icons, picture background`);
  const alias = readAlias(Buffer.from(pget(icvp, 'backgroundImageAlias'), 'base64'));
  must(alias.volumeName === plan.volumeName && alias.posixPath === `/${plan.background}` && alias.cnid === lstatSync(join(mount, plan.background)).ino, `background alias names ${alias.carbonPath} (file id ${alias.cnid})`);
  for (const item of plan.items) {
    const r = rec(item.name, 'Iloc');
    const at = r && readIloc(r.value);
    must(at && at.x === item.x && at.y === item.y, `${item.name} at ${item.x}, ${item.y}`);
  }

  // The app in the image.
  const app = join(mount, plan.app);
  const infoPlist = readFileSync(join(app, 'Contents', 'Info.plist'));
  const [id, shortVersion] = [pget(infoPlist, 'CFBundleIdentifier'), pget(infoPlist, 'CFBundleShortVersionString')];
  must(id === runtime.bundleId && shortVersion === version, `${plan.app} ${id} ${shortVersion}`);
  const sig = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8' });
  must(sig.status === 0, `codesign --verify --deep --strict in the image${sig.status ? `: ${sig.stderr.trim()}` : ''}`);
  const details = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' }).stderr;
  if (values.release) must(/Authority=Developer ID Application: /.test(details), 'app signed with a Developer ID Application identity');
  else must(/Signature=adhoc/.test(details), 'development app is ad-hoc signed, as its name says');

  // Install by dragging: Finder copies the bundle; ditto copies it the same way. Into a stand-in for Applications
  // whose path has spaces and non-ASCII characters, as a person's folders may.
  const target = join(work, 'Install Test – Ü', 'Applications');
  mkdirSync(target, { recursive: true });
  const copied = join(target, plan.app);
  execFileSync('ditto', [app, copied]);
  const copySig = spawnSync('codesign', ['--verify', '--deep', '--strict', copied], { encoding: 'utf8' });
  must(copySig.status === 0, `the installed copy keeps a valid signature${copySig.status ? `: ${copySig.stderr.trim()}` : ''}`);
  const launcher = join(copied, 'Contents', 'Resources', 'bin', 'bogen');
  const arches = output('lipo', ['-archs', join(copied, 'Contents', 'Resources', 'runtime', 'node', 'bin', 'node')]).split(' ');
  if (arches.includes(process.arch)) {
    const home = join(work, 'home with space');
    const v = spawnSync(launcher, ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: 'validation-no-login-shell', BOGEN_HOME: join(home, 'data'), BOGEN_UPDATE_CHECK: 'off' }, timeout: 60_000 });
    must(v.status === 0 && v.stdout.includes(version), `the installed copy runs its bundled server code (${v.stdout.trim() || v.stderr.trim()})`);
  } else {
    ok(`the copy is for ${arches.join(' ')}; running it needs such a Mac (skipped, not passed)`);
  }
} catch (e) {
  failure = e;
} finally {
  if (device) {
    let detached = false;
    for (let i = 0; i < 5 && !detached; i++) {
      detached = spawnSync('hdiutil', ['detach', device, ...(i === 4 ? ['-force'] : [])], { stdio: 'ignore' }).status === 0;
      if (!detached) spawnSync('sleep', ['2']);
    }
    if (!detached) failure ??= new Error(`FAILED could not detach ${device}`);
  }
  rmSync(work, { recursive: true, force: true });
}
if (failure) fail(failure.message);
process.stdout.write(`${values.release ? 'Release' : 'Development'} disk image checked: ${dmg}\n`);
