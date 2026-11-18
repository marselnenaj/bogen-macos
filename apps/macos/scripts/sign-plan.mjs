// What gets signed in Bogen.app, and in which order. Pure file inspection, so it runs (and is tested) on any OS;
// sign-lib.mjs carries the plan out with codesign on macOS.
//
// Two kinds of code live in the bundle:
// - Electron's own (Contents/MacOS, Contents/Frameworks with its helper apps): @electron/osx-sign signs these.
// - Bogen's payload in Contents/Resources: the bundled node, the headless shell and its libraries, esbuild's binary.
//   These are signed here, explicitly, one file at a time, deepest first and libraries before executables, so that
//   every nested piece is signed before anything that could seal it.
//
// The trap this guards against (second native CI run, 2026-11-05): codesign treats a folder whose Mach-O executable
// has the folder's own name as a shallow bundle with that executable as its main program. Signing
// `runtime/chrome-headless-shell/chrome-headless-shell` therefore tried to seal the whole folder, and its plain files
// (ABOUT, …) became "subcomponents" that are "not signed at all". Outside a real .app or .framework, no Mach-O may
// share its folder's name; `shallowBundleTraps` finds any that do, and signing refuses to start.

import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

const THIN_LE = new Set(['cefaedfe', 'cffaedfe']); // MH_MAGIC, MH_MAGIC_64 as stored on little-endian Macs
const THIN_BE = new Set(['feedface', 'feedfacf']);
const FAT = new Set(['cafebabe', 'cafebabf']);
const MH_EXECUTE = 2;
const MH_DYLIB = 6;
const MH_BUNDLE = 8;

function readAt(path, offset, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return n === length ? buf : null;
  } finally {
    closeSync(fd);
  }
}

/** 'executable' | 'library' (dylib or loadable bundle such as a .node addon) | null when not Mach-O. */
export function machOKind(path) {
  try {
    if (!lstatSync(path).isFile()) return null;
    const head = readAt(path, 0, 8);
    if (!head) return null;
    const magic = head.subarray(0, 4).toString('hex');
    let thin = 0;
    if (FAT.has(magic)) {
      // Universal binary: the first architecture's header tells the file type (all slices share it).
      if (head.readUInt32BE(4) < 1) return null;
      const arch = readAt(path, 8, 20);
      if (!arch) return null;
      thin = magic === 'cafebabf' ? Number(readAt(path, 16, 8)?.readBigUInt64BE(0) ?? 0n) : arch.readUInt32BE(8);
    } else if (!THIN_LE.has(magic) && !THIN_BE.has(magic)) {
      return null;
    }
    const header = readAt(path, thin, 16);
    if (!header) return null;
    const m = header.subarray(0, 4).toString('hex');
    const type = THIN_LE.has(m) ? header.readUInt32LE(12) : THIN_BE.has(m) ? header.readUInt32BE(12) : -1;
    if (type === MH_EXECUTE) return 'executable';
    if (type === MH_DYLIB || type === MH_BUNDLE) return 'library';
    return null;
  } catch {
    return null;
  }
}

/** Files under `dir`, without following links, skipping nothing. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const insideBundle = (path, root) => relative(root, path).split(sep).some((part) => ['.app', '.framework'].includes(extname(part)));

/**
 * Mach-O files outside any .app/.framework whose name is their folder's name (compared without case, as on APFS):
 * codesign would take that folder for a shallow bundle.
 */
export function shallowBundleTraps(root) {
  return walk(root).filter((file) => !insideBundle(file, root) && machOKind(file) && basename(file).toLowerCase() === basename(dirname(file)).toLowerCase());
}

/**
 * Bogen's payload in Contents/Resources, in signing order: deepest first, libraries before executables at one depth,
 * then by path for a stable order. Each entry says whether it gets the app's entitlements (executables only;
 * entitlements on a library mean nothing to the system).
 */
export function payloadPlan(app) {
  const resources = join(app, 'Contents', 'Resources');
  const items = walk(resources)
    .filter((file) => !insideBundle(file, resources))
    .map((file) => ({ file, kind: machOKind(file) }))
    .filter((x) => x.kind);
  const depth = (f) => relative(resources, f).split(sep).length;
  items.sort((a, b) => depth(b.file) - depth(a.file) || (a.kind === b.kind ? 0 : a.kind === 'library' ? -1 : 1) || a.file.localeCompare(b.file));
  return items.map(({ file, kind }) => ({ file, kind, entitlements: kind === 'executable' }));
}

/**
 * The entitlements file for something @electron/osx-sign signs: the app and its helper apps (the editor window's
 * processes, which record from the microphone) get `shell`; frameworks and libraries get `payload`.
 */
export function electronEntitlements(file, { payload, shell }) {
  return extname(file) === '.app' ? shell : payload;
}

/** The codesign arguments for one payload file. Release: hardened runtime and a secure timestamp; dev: ad-hoc. */
export function codesignArgs(item, { identity, entitlements }) {
  const release = Boolean(identity);
  return [
    '--force', '--sign', release ? identity : '-',
    ...(release ? ['--options', 'runtime', '--timestamp'] : ['--timestamp=none']),
    ...(item.entitlements ? ['--entitlements', entitlements] : []),
    item.file,
  ];
}
