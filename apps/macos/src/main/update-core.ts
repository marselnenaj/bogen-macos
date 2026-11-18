// Updates for Bogen.app, the verification half. Electron-free so it runs in tests.
//
// A release publishes, in one public HTTPS folder (the feed):
//   bogen-macos-release.json       the manifest below
//   bogen-macos-release.json.sig   base64 Ed25519 signature of the manifest, by a key in RELEASE_PUBLIC_KEYS
//   Bogen-<version>-arm64.zip      the signed, notarized, stapled app, zipped with `ditto -c -k --keepParent`
//   Bogen-<version>-x64.zip
//
// The app installs an update only when all of these hold, in this order:
//   1. this is a release build (Developer ID signed, built with a feed URL); a dev build never installs anything,
//   2. the manifest's signature verifies against a key built into the app,
//   3. the manifest names a newer version and a build for this CPU,
//   4. the downloaded zip has exactly the size and SHA-256 the signed manifest gives,
//   5. Squirrel.Mac (Electron's autoUpdater) accepts the new app's code signature as satisfying the running app's
//      designated requirement: same Team ID, valid, not altered.
// Any failure leaves the installed app alone and says why. There is no "install anyway".

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkSignature } from '../../../../packages/server/src/release-key.ts';

/** Semantic version order (a pre-release before its release; build metadata ignored), as `bogen update` orders them. NaN for nonsense. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
  };
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const p = x.pre.split('.');
  const q = y.pre.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const numeric = /^\d+$/.test(p[i]!) && /^\d+$/.test(q[i]!);
    return numeric ? Number(p[i]) - Number(q[i]) : p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}

export const MANIFEST = 'bogen-macos-release.json';
const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 4096;
const ZIP_LIMIT = 2 * 1024 * 1024 * 1024;

export type Arch = 'arm64' | 'x64';
export interface AppBuild { file: string; size: number; sha256: string }
export interface AppManifest { schema: 1; product: 'bogen-macos'; version: string; date?: string; notes?: string; minimumSystemVersion: string; builds: Partial<Record<Arch, AppBuild>> }

export type UpdateCheck =
  | { state: 'not-configured'; message: string }
  | { state: 'dev-build'; message: string }
  | { state: 'no-key'; message: string }
  | { state: 'up-to-date'; current: string; latest: string; message: string }
  | { state: 'available'; current: string; manifest: AppManifest; build: AppBuild; message: string }
  | { state: 'unsupported-os'; current: string; latest: string; minimumSystemVersion: string; message: string }
  | { state: 'error'; message: string };

type Fetch = typeof fetch;

/** https only, no credentials, no query: the feed is a public folder. */
export function feedUrl(text: string | undefined): URL | null {
  if (!text) return null;
  try {
    const u = new URL(text.replace(/\/+$/, '') + '/');
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FILE_RE = /^Bogen-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(arm64|x64)\.zip$/;

export function parseAppManifest(bytes: Uint8Array): AppManifest {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('The release manifest is not JSON.');
  }
  const m = v as Record<string, unknown>;
  if (!m || typeof m !== 'object' || m.schema !== 1 || m.product !== 'bogen-macos') throw new Error('The release manifest is not one for Bogen for macOS.');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) throw new Error('The release manifest has no valid version.');
  if (typeof m.minimumSystemVersion !== 'string' || !/^\d+(\.\d+){0,2}$/.test(m.minimumSystemVersion)) throw new Error('The release manifest has no minimum macOS version.');
  const builds: Partial<Record<Arch, AppBuild>> = {};
  const raw = (m.builds ?? {}) as Record<string, unknown>;
  for (const arch of ['arm64', 'x64'] as const) {
    const b = raw[arch] as Record<string, unknown> | undefined;
    if (b === undefined) continue;
    if (!b || typeof b.file !== 'string' || FILE_RE.exec(b.file)?.[1] !== arch || !b.file.includes(`-${m.version}-`)) throw new Error(`The ${arch} build in the manifest has a bad file name.`);
    if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size <= 0 || b.size > ZIP_LIMIT) throw new Error(`The ${arch} build in the manifest has a bad size.`);
    if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) throw new Error(`The ${arch} build in the manifest has a bad SHA-256.`);
    builds[arch] = { file: b.file, size: b.size, sha256: b.sha256 };
  }
  return {
    schema: 1, product: 'bogen-macos', version: m.version, minimumSystemVersion: m.minimumSystemVersion, builds,
    ...(typeof m.date === 'string' ? { date: m.date.slice(0, 40) } : {}),
    ...(typeof m.notes === 'string' ? { notes: m.notes.slice(0, 4000) } : {}),
  };
}

/**
 * A small file (manifest, signature) read with its cap enforced while streaming: a wrong or missing Content-Length
 * cannot make it buffer more than `limit` bytes; past the cap the response is cancelled.
 */
export async function downloadCapped(fetchImpl: Fetch, url: URL, limit: number, timeoutMs: number): Promise<Uint8Array> {
  const name = url.pathname.split('/').pop();
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`${name}: the feed answered ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${name} is larger than expected.`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`${name} is larger than expected.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** Dotted numeric macOS versions: 13.6.1 against a minimum such as 14.0. False for anything that is not one. */
export function osAtLeast(current: string, minimum: string): boolean {
  const parse = (v: string) => (/^\d+(\.\d+){0,2}$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const c = parse(current);
  const m = parse(minimum);
  if (!c || !m) return false;
  for (let i = 0; i < 3; i++) {
    const d = (c[i] ?? 0) - (m[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export interface CheckOptions {
  feed: URL | null;
  /** True only for a Developer ID signed release build. */
  releaseBuild: boolean;
  keys: Buffer[];
  current: string;
  arch: Arch;
  /** This Mac's macOS version (Electron's process.getSystemVersion(), such as 14.5.0). */
  osVersion: string;
  fetch?: Fetch;
}

export async function checkAppUpdate(o: CheckOptions): Promise<UpdateCheck> {
  if (!o.releaseBuild) return { state: 'dev-build', message: 'This is a development build. It is not signed for distribution, so it never updates itself. Build or download a new one.' };
  if (!o.feed) return { state: 'not-configured', message: 'This build has no update feed. Updates come with a new download.' };
  if (!o.keys.length) return { state: 'no-key', message: 'This build has no release key to check updates with. Updates come with a new download.' };
  const f = o.fetch ?? fetch;
  try {
    const manifestBytes = await downloadCapped(f, new URL(MANIFEST, o.feed), MANIFEST_LIMIT, 30_000);
    const sig = await downloadCapped(f, new URL(`${MANIFEST}.sig`, o.feed), SIGNATURE_LIMIT, 30_000);
    const check = checkSignature(o.keys, manifestBytes, sig);
    if (!check.ok) return { state: 'error', message: `Refused the update information: ${check.reason}.` };
    const manifest = parseAppManifest(manifestBytes);
    const order = compareVersions(manifest.version, o.current);
    if (!(order > 0)) return { state: 'up-to-date', current: o.current, latest: manifest.version, message: `Bogen ${o.current} is up to date.` };
    const build = manifest.builds[o.arch];
    if (!build) return { state: 'error', message: `Bogen ${manifest.version} has no build for this Mac (${o.arch}) yet.` };
    // Before anything is downloaded: an update this macOS cannot run is never offered.
    if (!osAtLeast(o.osVersion, manifest.minimumSystemVersion)) {
      return { state: 'unsupported-os', current: o.current, latest: manifest.version, minimumSystemVersion: manifest.minimumSystemVersion, message: `Bogen ${manifest.version} needs macOS ${manifest.minimumSystemVersion} or newer; this Mac runs ${o.osVersion || 'an unknown version'}. Bogen ${o.current} stays.` };
    }
    return { state: 'available', current: o.current, manifest, build, message: `Bogen ${manifest.version} is available. You have ${o.current}.` };
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || (e as { cause?: { code?: string } }).cause?.code) return { state: 'error', message: 'Could not reach the update feed. Are you online?' };
    return { state: 'error', message: (e as Error).message };
  }
}

/**
 * Streams the zip to `dest` while hashing it; keeps it only if the size and SHA-256 match the signed manifest.
 * `dest` is written as `<dest>.part` first and renamed at the end.
 */
export async function downloadVerified(build: AppBuild, feed: URL, dest: string, fetchImpl: Fetch = fetch, onProgress?: (done: number, total: number) => void): Promise<void> {
  const url = new URL(build.file, feed);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  const part = `${dest}.part`;
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`${build.file}: the feed answered ${res.status}.`);
  const hash = createHash('sha256');
  let size = 0;
  // Counts, caps and hashes on the way to disk. pipeline() propagates an error from any side (network, a full disk, a
  // permission problem) to all of them, destroys the streams and rejects; nothing is left waiting on 'drain'.
  const check = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > build.size) return done(new Error(`Refused ${build.file}: it is larger than the signed manifest says.`));
      hash.update(chunk);
      onProgress?.(size, build.size);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), check, createWriteStream(part, { mode: 0o600 }));
    if (size !== build.size) throw new Error(`Refused ${build.file}: it is ${size} bytes, the signed manifest says ${build.size}.`);
    if (hash.digest('hex') !== build.sha256) throw new Error(`Refused ${build.file}: its SHA-256 does not match the signed manifest.`);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new Error(`Not enough disk space to download ${build.file}. Nothing was installed; Bogen stays as it is.`);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new Error(`Could not write ${build.file} (${code}). Nothing was installed; Bogen stays as it is.`);
    throw e;
  }
}

/** The JSON Squirrel.Mac reads (`serverType: 'json'`): where the verified zip is, served from loopback. */
export function squirrelFeed(zipUrl: string, version: string, notes?: string): string {
  return JSON.stringify({ url: zipUrl, name: version, ...(notes ? { notes } : {}) });
}

/**
 * What the person should be told when the status moves on after they asked for an update: the end of the hand-off
 * to Squirrel (ready, or refused) is otherwise silent, since the menu's dialog closed long before.
 */
export function updateNotice(prev: { state: string }, next: { state: string }): 'ready' | 'error' | null {
  const working = prev.state === 'downloading' || prev.state === 'installing';
  if (!working) return null;
  if (next.state === 'ready') return 'ready';
  if (next.state === 'error') return 'error';
  return null;
}

/** The Dock progress for a status: a fraction while downloading, indeterminate while Squirrel checks, else none. */
export function dockProgress(s: { state: string; done?: number; total?: number }): number {
  if (s.state === 'downloading') return s.total && s.total > 0 ? Math.min(1, (s.done ?? 0) / s.total) : 2;
  if (s.state === 'installing') return 2;
  return -1;
}
