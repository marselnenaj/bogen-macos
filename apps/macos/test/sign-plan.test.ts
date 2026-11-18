// The signing plan of Bogen.app, checked on any OS against an app-shaped tree of files with real Mach-O headers.
// codesign itself only runs on macOS (packaging and CI); what it is asked to do, and in which order, is checked here.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codesignArgs, electronEntitlements, machOKind, payloadPlan, shallowBundleTraps } from '../scripts/sign-plan.mjs';
import { bundleLayout, RUNTIME_LAYOUT } from '../src/main/paths.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const APP_ROOT = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MH_EXECUTE = 2;
const MH_DYLIB = 6;
const MH_BUNDLE = 8;

/** A 64-bit little-endian Mach-O header (as on every Mac) of the given file type, padded. */
function thin(filetype: number): Buffer {
  const b = Buffer.alloc(64);
  b.write('cffaedfe', 0, 'hex'); // MH_MAGIC_64 as stored on disk
  b.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  b.writeUInt32LE(0, 8);
  b.writeUInt32LE(filetype, 12);
  return b;
}

/** A universal binary with one slice at 4096, as lipo writes them. */
function fat(filetype: number): Buffer {
  const b = Buffer.alloc(4096 + 64);
  b.write('cafebabe', 0, 'hex');
  b.writeUInt32BE(1, 4); // nfat_arch
  b.writeUInt32BE(0x0100000c, 8); // cputype
  b.writeUInt32BE(0, 12); // cpusubtype
  b.writeUInt32BE(4096, 16); // offset
  b.writeUInt32BE(64, 20); // size
  b.writeUInt32BE(12, 24); // align
  thin(filetype).copy(b, 4096);
  return b;
}

function put(root: string, rel: string, data: Buffer | string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

/** Bogen.app as package.mjs lays it out, with the headless shell archive's real file names. */
function fakeApp(shellDir = 'runtime/headless-shell'): string {
  const root = mkdtempSync(join(tmpdir(), 'bogen-sign-plan-'));
  dirs.push(root);
  const app = join(root, 'Bogen.app');
  put(app, 'Contents/MacOS/Bogen', thin(MH_EXECUTE));
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', thin(MH_DYLIB));
  put(app, 'Contents/Frameworks/Bogen Helper (Renderer).app/Contents/MacOS/Bogen Helper (Renderer)', thin(MH_EXECUTE));
  put(app, 'Contents/Resources/app.asar', 'asar');
  put(app, 'Contents/Resources/runtime/node/bin/node', fat(MH_EXECUTE));
  put(app, 'Contents/Resources/runtime/node/LICENSE', 'Node license');
  put(app, `Contents/Resources/${shellDir}/chrome-headless-shell`, thin(MH_EXECUTE));
  put(app, `Contents/Resources/${shellDir}/libEGL.dylib`, thin(MH_DYLIB));
  put(app, `Contents/Resources/${shellDir}/libvk_swiftshader.dylib`, thin(MH_DYLIB));
  put(app, `Contents/Resources/${shellDir}/ABOUT`, 'Chrome for Testing headless shell');
  put(app, `Contents/Resources/${shellDir}/LICENSE.headless_shell`, 'license');
  put(app, `Contents/Resources/${shellDir}/headless_lib_data.pak`, Buffer.from([0x05, 0, 0, 0, 1, 2, 3]));
  put(app, `Contents/Resources/${shellDir}/icudtl.dat`, Buffer.from('icu data'));
  put(app, 'Contents/Resources/server/node_modules/@esbuild/darwin-arm64/bin/esbuild', thin(MH_EXECUTE));
  put(app, 'Contents/Resources/server/node_modules/some-addon/build/addon.node', thin(MH_BUNDLE));
  put(app, 'Contents/Resources/server/dist/editor/icons/icon-512.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  put(app, 'Contents/Resources/server/dist/cli.js', '#!/usr/bin/env node');
  put(app, 'Contents/Resources/bin/bogen', '#!/bin/sh');
  // A Java class file starts with the universal-binary magic too; it is not code codesign should touch.
  put(app, 'Contents/Resources/server/node_modules/pkg/Foo.class', Buffer.from('cafebabe0000003400', 'hex'));
  return app;
}

describe('reading Mach-O headers', () => {
  it('tells executables from libraries, thin or universal, and ignores everything else', () => {
    const app = fakeApp();
    const r = join(app, 'Contents', 'Resources');
    expect(machOKind(join(r, 'runtime/node/bin/node'))).toBe('executable');
    expect(machOKind(join(r, 'runtime/headless-shell/chrome-headless-shell'))).toBe('executable');
    expect(machOKind(join(r, 'runtime/headless-shell/libEGL.dylib'))).toBe('library');
    expect(machOKind(join(r, 'server/node_modules/some-addon/build/addon.node'))).toBe('library');
    for (const plain of ['runtime/headless-shell/ABOUT', 'runtime/headless-shell/headless_lib_data.pak', 'runtime/headless-shell/icudtl.dat', 'server/dist/editor/icons/icon-512.png', 'server/dist/cli.js', 'bin/bogen', 'server/node_modules/pkg/Foo.class', 'app.asar']) {
      expect(machOKind(join(r, plain)), plain).toBeNull();
    }
    expect(machOKind(process.execPath === '' ? '' : join(r, 'does-not-exist'))).toBeNull();
  });
});

describe('the shallow-bundle trap', () => {
  it('finds an executable named like its folder outside a bundle: the layout that failed the second native run', () => {
    const bad = fakeApp('runtime/chrome-headless-shell');
    expect(shallowBundleTraps(bad).map((p) => relative(bad, p))).toEqual(['Contents/Resources/runtime/chrome-headless-shell/chrome-headless-shell']);
    // APFS compares names without case by default, and so does codesign's bundle lookup there.
    const mixed = fakeApp('runtime/Chrome-Headless-Shell');
    expect(shallowBundleTraps(mixed)).toHaveLength(1);
  });

  it('passes the layout package.mjs makes, and ignores what lives inside real bundles', () => {
    const app = fakeApp();
    put(app, 'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel', thin(MH_DYLIB));
    put(app, 'Contents/Frameworks/X.app/Contents/Thing/Thing', thin(MH_EXECUTE));
    expect(shallowBundleTraps(app)).toEqual([]);
  });
});

describe('the payload signing plan', () => {
  it('lists every Mach-O in Resources and nothing else, deepest first, libraries before executables', () => {
    const app = fakeApp();
    const plan = payloadPlan(app).map((p) => ({ ...p, file: relative(join(app, 'Contents', 'Resources'), p.file) }));
    expect(plan).toEqual([
      // Six levels deep, then five, four, three: whatever could be sealed by something above it is signed first.
      { file: 'server/node_modules/@esbuild/darwin-arm64/bin/esbuild', kind: 'executable', entitlements: true },
      { file: 'server/node_modules/some-addon/build/addon.node', kind: 'library', entitlements: false },
      { file: 'runtime/node/bin/node', kind: 'executable', entitlements: true },
      { file: 'runtime/headless-shell/libEGL.dylib', kind: 'library', entitlements: false },
      { file: 'runtime/headless-shell/libvk_swiftshader.dylib', kind: 'library', entitlements: false },
      { file: 'runtime/headless-shell/chrome-headless-shell', kind: 'executable', entitlements: true },
    ]);
    // Electron's own code is osx-sign's; resources and licenses are never signed as code, and never removed.
    expect(plan.some((p) => p.file.includes('Frameworks') || p.file.includes('MacOS'))).toBe(false);
  });

  it('asks codesign for ad-hoc without runtime in dev, hardened runtime with a timestamp in release, and never --deep', () => {
    const exe = { file: '/A/Bogen.app/Contents/Resources/runtime/headless-shell/chrome-headless-shell', kind: 'executable' as const, entitlements: true };
    const lib = { file: '/A/Bogen.app/Contents/Resources/runtime/headless-shell/libEGL.dylib', kind: 'library' as const, entitlements: false };
    const ent = '/repo/apps/macos/build/entitlements.plist';
    expect(codesignArgs(exe, { entitlements: ent })).toEqual(['--force', '--sign', '-', '--timestamp=none', '--entitlements', ent, exe.file]);
    expect(codesignArgs(lib, { entitlements: ent })).toEqual(['--force', '--sign', '-', '--timestamp=none', lib.file]);
    const id = 'Developer ID Application: Example (ABCDE12345)';
    expect(codesignArgs(exe, { identity: id, entitlements: ent })).toEqual(['--force', '--sign', id, '--options', 'runtime', '--timestamp', '--entitlements', ent, exe.file]);
    expect(codesignArgs(lib, { identity: id, entitlements: ent })).toEqual(['--force', '--sign', id, '--options', 'runtime', '--timestamp', lib.file]);
    for (const args of [codesignArgs(exe, { entitlements: ent }), codesignArgs(exe, { identity: id, entitlements: ent })]) expect(args).not.toContain('--deep');
  });

  it('grants the payload exactly allow-jit, and Electron\'s app and helpers allow-jit plus audio input', () => {
    const keys = (name: string) => [...readFileSync(join(APP_ROOT, 'build', name), 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys('entitlements.plist')).toEqual(['com.apple.security.cs.allow-jit']);
    expect(keys('entitlements-shell.plist')).toEqual(['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input']);
    const files = { payload: 'P', shell: 'S' };
    expect(electronEntitlements('/A/Bogen.app', files)).toBe('S');
    expect(electronEntitlements('/A/Bogen.app/Contents/Frameworks/Bogen Helper (Renderer).app', files)).toBe('S');
    expect(electronEntitlements('/A/Bogen.app/Contents/Frameworks/Electron Framework.framework', files)).toBe('P');
    expect(electronEntitlements('/A/Bogen.app/Contents/Frameworks/Electron Framework.framework/Libraries/libEGL.dylib', files)).toBe('P');
    const lib = readFileSync(join(APP_ROOT, 'scripts', 'sign-lib.mjs'), 'utf8');
    // Signing never falls back to osx-sign's default entitlements, and --deep only ever verifies.
    expect(lib).toContain('entitlements: ENTITLEMENTS');
    expect(lib).toContain('electronEntitlements(file, { payload: ENTITLEMENTS, shell: SHELL_ENTITLEMENTS })');
    expect([...lib.matchAll(/\[([^\]]*'--deep'[^\]]*)\]/g)].every((m) => m[1]!.includes("'--verify'"))).toBe(true);
  });
});

describe('one runtime layout everywhere', () => {
  it('names the headless shell\'s folder unlike its executable, and the app, launcher and CI agree on it', () => {
    const runtime = JSON.parse(readFileSync(join(APP_ROOT, 'runtime.json'), 'utf8')) as { layout: { node: string; headlessShell: string } };
    expect(RUNTIME_LAYOUT).toEqual({ node: runtime.layout.node, headlessShell: runtime.layout.headlessShell });
    expect(basename(runtime.layout.headlessShell)).not.toBe(basename(dirname(runtime.layout.headlessShell)));
    expect(basename(runtime.layout.headlessShell)).toBe('chrome-headless-shell');
    const b = bundleLayout('/Applications/Bogen.app/Contents/Resources');
    expect(b.headlessShell).toBe(`/Applications/Bogen.app/Contents/Resources/${runtime.layout.headlessShell}`);
    expect(b.node).toBe(`/Applications/Bogen.app/Contents/Resources/${runtime.layout.node}`);
    expect(readFileSync(join(APP_ROOT, 'resources', 'bin', 'bogen'), 'utf8')).toContain(`"$resources/${runtime.layout.headlessShell}"`);
    expect(readFileSync(join(ROOT, '.github', 'workflows', 'macos.yml'), 'utf8')).toContain(`vendor/arm64/${runtime.layout.headlessShell}`);
    // No file of the app still uses the folder name that made codesign see a bundle.
    for (const f of ['resources/bin/bogen', 'src/main/paths.ts', 'scripts/package.mjs', 'scripts/fetch-runtime.mjs', 'scripts/verify-app.mjs', 'scripts/make-icon.mjs']) {
      const text = readFileSync(join(APP_ROOT, f), 'utf8');
      expect(text.includes('chrome-headless-shell/chrome-headless-shell') && !text.includes('runtime/chrome-headless-shell/chrome-headless-shell) would'), f).toBe(false);
    }
  });
});
