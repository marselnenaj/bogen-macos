#!/usr/bin/env node
// Assembles Bogen.app for one architecture. macOS only.
//
//   node scripts/package.mjs --arch arm64                                   # dev: ad-hoc signed, this Mac only
//   node scripts/package.mjs --arch arm64 --release \
//        --identity "Developer ID Application: Name (TEAMID)" [--update-feed https://…]   # distribution
//
// Needs, first: `npm ci && npm run build` at the repository root (server bundle and editor), `npm ci` here, and
// `node scripts/fetch-runtime.mjs --arch <arch>`. Writes release/<dev|release>/<arch>/Bogen.app.
//
// What goes into Contents/Resources besides Electron's own app.asar:
//   server/    dist/ (cli.js, shader-runtime.js, vectorize-worker.js, editor/) and the npm packages the bundle leaves
//              external (puppeteer-core, esbuild, tailwindcss and theirs), copied exactly as package-lock.json resolves
//              them; esbuild's macOS binary for the target CPU is fetched from the lock's URL and checked against the
//              lock's integrity hash.
//   runtime/   node/ and headless-shell/ from vendor/<arch> (fetch-runtime.mjs), as runtime.json's layout names them
//   bin/bogen  the command line launcher
//   licenses/  Bogen's GPL-3.0-or-later license and its exception, THIRD_PARTY_NOTICES.md, Electron's and Chromium's, Node's, the headless shell's

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';
import { packager } from '@electron/packager';
import { shippedPackages, isPlatform, nameOf } from '../../../scripts/shipped-packages.mjs';
import { appRoot, archArg, fail, layout, outDir, releaseDir, repoRoot, requireDarwin, run, runtime, vendorDir, versionAtLeast } from './lib.mjs';
import { stripTransportSecurity } from './plist-policy.mjs';
import { signApp } from './sign-lib.mjs';
import { shallowBundleTraps } from './sign-plan.mjs';

const { values } = parseArgs({ options: { arch: { type: 'string' }, release: { type: 'boolean' }, identity: { type: 'string' }, 'update-feed': { type: 'string' } } });
requireDarwin('package');
const arch = archArg(values.arch);
const release = Boolean(values.release);
if (release && !values.identity) fail('--release needs --identity "Developer ID Application: … (TEAMID)". Without one, build a dev app (no --release).');
if (!release && values.identity) fail('--identity is for --release builds.');
if (!versionAtLeast(runtime.electron.chromium, runtime.browserFloor)) fail(`Electron ${runtime.electron.version} has Chromium ${runtime.electron.chromium}, below the floor ${runtime.browserFloor}.`);
const installedElectron = JSON.parse(readFileSync(join(appRoot, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
if (installedElectron !== runtime.electron.version) fail(`node_modules has Electron ${installedElectron}, runtime.json pins ${runtime.electron.version}. Run npm ci.`);

const serverDist = join(repoRoot, 'packages', 'server', 'dist');
if (!existsSync(join(serverDist, 'cli.js')) || !existsSync(join(serverDist, 'editor', 'index.html'))) fail('The server or the editor is not built. Run npm ci && npm run build at the repository root.');
const vendor = vendorDir(arch);
for (const p of [layout.node, layout.headlessShell]) if (!existsSync(join(vendor, p))) fail(`${join(vendor, p)} is missing. Run node scripts/fetch-runtime.mjs --arch ${arch}.`);
const nodeRoot = dirname(dirname(layout.node)); // runtime/node
const shellRoot = dirname(layout.headlessShell); // runtime/headless-shell

const version = JSON.parse(readFileSync(join(repoRoot, 'packages', 'server', 'package.json'), 'utf8')).version;
const flavor = release ? 'release' : 'dev';

// ---------------------------------------------------------------- the Electron app folder

run(process.execPath, [join(appRoot, 'scripts', 'build.mjs'), ...(release ? ['--release'] : []), ...(values['update-feed'] ? ['--update-feed', values['update-feed']] : [])]);

// ---------------------------------------------------------------- stage Resources

const stage = join(outDir, `stage-${arch}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
cpSync(serverDist, join(stage, 'server', 'dist'), { recursive: true });
// The server reads the portrait runtime as data on every platform, including for theme export.
cpSync(join(repoRoot, 'integrations', 'omarchy', 'portrait-background'), join(stage, 'server', 'integrations', 'omarchy', 'portrait-background'), { recursive: true });
writeFileSync(join(stage, 'server', 'package.json'), `${JSON.stringify({ name: 'bogen-design', version, private: true, type: 'module' }, null, 2)}\n`);

const { packages, merged } = shippedPackages(repoRoot);
const modules = join(stage, 'server', 'node_modules');
for (const { path, groups } of merged.values()) {
  if (!groups.has('npm')) continue;
  const entry = packages[path];
  const name = nameOf(path);
  const target = join(modules, name);
  if (isPlatform(entry)) {
    if (!(entry.os ?? []).includes('darwin') || !(entry.cpu ?? []).includes(arch)) continue;
    // The target CPU's binary, which this Mac may not have installed: from the lock's URL, checked against its hash.
    const res = await fetch(entry.resolved);
    if (!res.ok) fail(`${entry.resolved}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const [algo, expected] = entry.integrity.split('-');
    if (createHash(algo).update(bytes).digest('base64') !== expected) fail(`${name}: the download does not match package-lock.json's integrity. Refusing it.`);
    const tgz = join(outDir, `${name.replace('/', '-')}.tgz`);
    writeFileSync(tgz, bytes);
    mkdirSync(target, { recursive: true });
    run('tar', ['-xzf', tgz, '-C', target, '--strip-components', '1']);
    continue;
  }
  const from = join(repoRoot, path);
  if (!existsSync(from)) fail(`${path} is not installed. Run npm ci at the repository root.`);
  cpSync(from, target, { recursive: true, dereference: true });
}

// A package's own node_modules/.bin holds links for its command line tools, relative to where npm put them; copied
// into the app they point at nothing, and codesign refuses the bundle ("invalid destination for symbolic link").
// The app never runs them. Any other link must stay inside the server folder.
const strayLinks = [];
const prune = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isDirectory() && name === '.bin' && basename(dir) === 'node_modules') { rmSync(p, { recursive: true, force: true }); continue; }
    if (s.isSymbolicLink()) {
      const to = resolve(dirname(p), readlinkSync(p));
      if (!to.startsWith(join(stage, 'server') + sep) || !existsSync(to)) strayLinks.push(`${p.slice(stage.length + 1)} -> ${readlinkSync(p)}`);
    } else if (s.isDirectory()) prune(p);
  }
};
prune(modules);
if (strayLinks.length) fail(`These links in the server's node_modules point outside it or at nothing, which codesign refuses: ${strayLinks.join(', ')}.`);

// Exactly the two runtimes runtime.json names, each folder whole (the shell's licenses, paks, ICU data and libraries
// stay with it). Nothing else that may lie in vendor/<arch>/runtime from an earlier layout comes along.
for (const dir of [nodeRoot, shellRoot]) cpSync(join(vendor, dir), join(stage, dir), { recursive: true, verbatimSymlinks: true });
const traps = shallowBundleTraps(stage);
if (traps.length) fail(`These executables share their folder's name, which codesign would take for a bundle: ${traps.join(', ')}.`);
mkdirSync(join(stage, 'bin'), { recursive: true });
cpSync(join(appRoot, 'resources', 'bin', 'bogen'), join(stage, 'bin', 'bogen'));

const licenses = join(stage, 'licenses');
mkdirSync(licenses, { recursive: true });
cpSync(join(repoRoot, 'LICENSE'), join(licenses, 'Bogen-LICENSE.txt'));
cpSync(join(repoRoot, 'LICENSE-EXCEPTION.md'), join(licenses, 'Bogen-LICENSE-EXCEPTION.md'));
cpSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), join(licenses, 'THIRD_PARTY_NOTICES.md'));
cpSync(join(vendor, nodeRoot, 'LICENSE'), join(licenses, 'Node.js-LICENSE.txt'));
// Electron's own LICENSE and LICENSES.chromium.html come with the Electron zip packager downloads, below.
const shell = join(vendor, shellRoot);
for (const f of readdirSync(shell)) if (/license|notice|credits/i.test(f)) cpSync(join(shell, f), join(licenses, `chrome-headless-shell-${f}`));
writeFileSync(join(licenses, 'README.txt'), [
  'Licenses of what Bogen.app contains.',
  '',
  'Bogen-LICENSE.txt         Bogen, free and open source under GPL-3.0-or-later. Earlier MIT notices remain applicable to their code.',
  'Bogen-LICENSE-EXCEPTION.md  The additional permission for code Bogen writes into your exports.',
  'THIRD_PARTY_NOTICES.md    Packages bundled into the server, the editor and the shader runtime, and those next to it.',
  'Electron-*                Electron (MIT) and Chromium with its third-party components.',
  'Node.js-LICENSE.txt       Node.js and its bundled dependencies.',
  'chrome-headless-shell-*   Chrome for Testing headless shell, used for exports and screenshots.',
  '',
].join('\n'));

// ---------------------------------------------------------------- icon

const icon = join(outDir, 'icon', 'Bogen.icns');
if (!existsSync(icon)) run(process.execPath, [join(appRoot, 'scripts', 'make-icon.mjs'), '--arch', arch]);

// ---------------------------------------------------------------- package

const docTypes = {
  CFBundleDocumentTypes: [{ CFBundleTypeName: 'Bogen design', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Owner', LSItemContentTypes: ['dev.bogen.document'] }],
  UTExportedTypeDeclarations: [{
    UTTypeIdentifier: 'dev.bogen.document', UTTypeDescription: 'Bogen design', UTTypeConformsTo: ['public.data'],
    UTTypeTagSpecification: { 'public.filename-extension': ['bogen'], 'public.mime-type': 'application/x-bogen' },
  }],
};

const out = join(outDir, 'package');
rmSync(out, { recursive: true, force: true });
const [built] = await packager({
  dir: join(outDir, 'app'),
  out,
  name: runtime.productName,
  executableName: runtime.productName,
  platform: 'darwin',
  arch,
  electronVersion: runtime.electron.version,
  appVersion: version,
  buildVersion: version,
  appBundleId: runtime.bundleId,
  appCategoryType: 'public.app-category.graphics-design',
  appCopyright: 'Free and open source under GPL-3.0-or-later.',
  asar: true,
  icon,
  darwinDarkModeSupport: true,
  extraResource: ['server', 'runtime', 'bin', 'licenses'].map((d) => join(stage, d)),
  extendInfo: {
    ...docTypes,
    LSMinimumSystemVersion: runtime.minimumSystemVersion,
    NSLocalNetworkUsageDescription: 'Bogen connects to your own devices to sync designs, when you turn on device sync.',
    NSMicrophoneUsageDescription: 'Bogen records your voice when you choose to speak instead of typing in a chat or comment. A speech model on this Mac writes it out; the recording does not leave this Mac.',
  },
  prune: false,
  overwrite: true,
  osxSign: false,
  quiet: true,
});
const app = join(built, `${runtime.productName}.app`);
// packager leaves Electron's and Chromium's license files next to the app; they belong inside it.
for (const f of ['LICENSE', 'LICENSES.chromium.html']) {
  if (!existsSync(join(built, f))) fail(`Electron's ${f} is missing from the packaged output. Refusing to ship without it.`);
  cpSync(join(built, f), join(app, 'Contents', 'Resources', 'licenses', `Electron-${f}`));
}

// ---------------------------------------------------------------- Info.plist policy

// Electron's template Info.plist loosens App Transport Security; extendInfo cannot remove a key, so it is removed here,
// from the app and every helper app, before anything is signed (scripts/plist-policy.mjs explains why loopback and the
// updater need no exception).
for (const file of stripTransportSecurity(app)) process.stdout.write(`Removed NSAppTransportSecurity from ${file}\n`);

// ---------------------------------------------------------------- fuses

// Electron features Bogen never uses, switched off in the binary itself, so the signed app cannot be turned into a
// general Node interpreter or have code injected through environment variables or command line switches.
await flipFuses(join(app, 'Contents', 'MacOS', runtime.productName), {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});

// ---------------------------------------------------------------- sign and place

await signApp(app, release ? values.identity : undefined);
const dest = join(releaseDir, flavor, arch);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
renameSync(app, join(dest, `${runtime.productName}.app`));
process.stdout.write(`\n${release ? 'Signed (not yet notarized)' : 'Development (ad-hoc signed, this Mac only)'} Bogen ${version} for ${arch}: ${join(dest, `${runtime.productName}.app`)}\n`);
process.stdout.write(`Next: node scripts/verify-app.mjs --app "${join(dest, `${runtime.productName}.app`)}"${release ? ' --release' : ''}\n`);
