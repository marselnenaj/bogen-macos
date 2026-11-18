// The app updater's verification, against a local feed. Squirrel.Mac's code-signature check, the last gate, only
// exists on macOS and is in the manual smoke checklist.

import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAppUpdate, compareVersions, downloadVerified, feedUrl, MANIFEST, osAtLeast, parseAppManifest, squirrelFeed } from '../src/main/update-core.ts';

const raw = (key: KeyObject) => {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
};
const release = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const zip = Buffer.from('PK\u0003\u0004 pretend this is a signed Bogen.app zip');
const zipSha = createHash('sha256').update(zip).digest('hex');
const manifest = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  schema: 1, product: 'bogen-macos', version: '0.2.0', minimumSystemVersion: '13.0', notes: 'Faster canvas.',
  builds: { arm64: { file: 'Bogen-0.2.0-arm64.zip', size: zip.length, sha256: zipSha } }, ...over,
}));

let files: Record<string, Buffer> = {};
let hits: string[] = [];
/** When set, the manifest is served chunked, with no Content-Length, at this many bytes. */
let hugeManifest = 0;
let hugeSent = 0;
let server: Server;
let feed: URL;
const dir = mkdtempSync(join(tmpdir(), 'bogen-app-update-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = (req.url ?? '').split('/').pop()!;
    hits.push(name);
    if (name === MANIFEST && hugeManifest) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      hugeSent = 0;
      const pump = () => {
        while (hugeSent < hugeManifest && !res.destroyed) {
          hugeSent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        if (!res.destroyed) res.end();
      };
      res.on('close', () => res.destroy());
      return pump();
    }
    const body = files[name];
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Length': String(body.length) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  feed = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/feed/`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function publish(m: Buffer, by = release.privateKey, extra: Record<string, Buffer> = {}) {
  files = { [MANIFEST]: m, [`${MANIFEST}.sig`]: Buffer.from(sign(null, m, by).toString('base64')), 'Bogen-0.2.0-arm64.zip': zip, ...extra };
}

const base = () => ({ feed, releaseBuild: true, keys: [raw(release.privateKey)], current: '0.1.0', arch: 'arm64' as const, osVersion: '14.5.0' });

describe('checking for an app update', () => {
  it('never updates a dev build or a build without a feed or key, and says so', async () => {
    expect((await checkAppUpdate({ ...base(), releaseBuild: false })).state).toBe('dev-build');
    expect((await checkAppUpdate({ ...base(), feed: null })).state).toBe('not-configured');
    expect((await checkAppUpdate({ ...base(), keys: [] })).state).toBe('no-key');
  });

  it('finds a newer signed release for this CPU', async () => {
    publish(manifest());
    const r = await checkAppUpdate(base());
    expect(r).toMatchObject({ state: 'available', current: '0.1.0', build: { file: 'Bogen-0.2.0-arm64.zip', sha256: zipSha } });
    expect((await checkAppUpdate({ ...base(), current: '0.2.0' })).state).toBe('up-to-date');
    expect((await checkAppUpdate({ ...base(), arch: 'x64' })).message).toMatch(/no build for this Mac \(x64\)/);
  });

  it('refuses a manifest signed by another key, or altered after signing', async () => {
    publish(manifest(), stranger.privateKey);
    expect(await checkAppUpdate(base())).toMatchObject({ state: 'error', message: expect.stringMatching(/Refused the update information/) });
    publish(manifest());
    files[MANIFEST] = manifest({ version: '9.9.9' });
    expect((await checkAppUpdate(base())).state).toBe('error');
  });

  it('refuses manifests with odd file names, sizes or digests', () => {
    expect(() => parseAppManifest(manifest({ builds: { arm64: { file: '../../evil.zip', size: 1, sha256: zipSha } } }))).toThrow(/bad file name/);
    expect(() => parseAppManifest(manifest({ builds: { arm64: { file: 'Bogen-0.2.0-x64.zip', size: 1, sha256: zipSha } } }))).toThrow(/bad file name/);
    expect(() => parseAppManifest(manifest({ builds: { arm64: { file: 'Bogen-0.2.0-arm64.zip', size: -1, sha256: zipSha } } }))).toThrow(/bad size/);
    expect(() => parseAppManifest(manifest({ builds: { arm64: { file: 'Bogen-0.2.0-arm64.zip', size: 1, sha256: 'nope' } } }))).toThrow(/bad SHA-256/);
    expect(() => parseAppManifest(manifest({ product: 'bogen-design' }))).toThrow(/not one for Bogen for macOS/);
  });
});

describe('the macOS version an update needs', () => {
  it('offers an update only when this Mac runs its minimum macOS, and refuses before any download', async () => {
    publish(manifest({ minimumSystemVersion: '14.0' }));
    hits = [];
    const old = await checkAppUpdate({ ...base(), osVersion: '13.6.1' });
    expect(old).toMatchObject({ state: 'unsupported-os', latest: '0.2.0', minimumSystemVersion: '14.0' });
    expect(old.message).toMatch(/needs macOS 14\.0 or newer; this Mac runs 13\.6\.1/);
    expect(hits.some((h) => h.endsWith('.zip'))).toBe(false);
    expect((await checkAppUpdate({ ...base(), osVersion: '14.0' })).state).toBe('available');
    expect((await checkAppUpdate({ ...base(), osVersion: '15.1' })).state).toBe('available');
    expect((await checkAppUpdate({ ...base(), osVersion: '' })).state).toBe('unsupported-os');
  });

  it('compares dotted numbers, not strings', () => {
    expect(osAtLeast('13.10', '13.9')).toBe(true);
    expect(osAtLeast('13.6.1', '14')).toBe(false);
    expect(osAtLeast('14', '14.0.0')).toBe(true);
    expect(osAtLeast('fourteen', '13.0')).toBe(false);
  });
});

describe('small update files are capped while streaming', () => {
  it('cancels a manifest with no Content-Length once it passes the cap, without buffering it', async () => {
    hugeManifest = 64 * 1024 * 1024;
    try {
      const r = await checkAppUpdate(base());
      expect(r).toMatchObject({ state: 'error', message: expect.stringMatching(/larger than expected/) });
      // The server was cut off long before it could send the whole 64 MB.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hugeSent).toBeLessThan(8 * 1024 * 1024);
    } finally {
      hugeManifest = 0;
    }
  });
});

describe('downloading an app update', () => {
  const build = () => ({ file: 'Bogen-0.2.0-arm64.zip', size: zip.length, sha256: zipSha });

  it.runIf(existsSync('/dev/full'))('reports a full disk, removes the partial file, and installs nothing', async () => {
    publish(manifest());
    const d = join(dir, 'full');
    mkdirSync(d, { recursive: true });
    const dest = join(d, 'Bogen-0.2.0-arm64.zip');
    // Every write to /dev/full fails with ENOSPC: a real disk-full error, not a stub.
    symlinkSync('/dev/full', `${dest}.part`);
    await expect(downloadVerified(build(), feed, dest)).rejects.toThrow(/Not enough disk space/);
    expect(readdirSync(d)).toEqual([]);
  });

  it.runIf(process.getuid?.() !== 0)('reports a folder it may not write to, and leaves nothing behind', async () => {
    publish(manifest());
    const d = join(dir, 'locked');
    mkdirSync(d, { recursive: true });
    chmodSync(d, 0o500);
    try {
      await expect(downloadVerified(build(), feed, join(d, 'Bogen-0.2.0-arm64.zip'))).rejects.toThrow(/Could not write .* \(EACCES\)/);
      expect(readdirSync(d)).toEqual([]);
    } finally {
      chmodSync(d, 0o700);
    }
  });

  it('keeps the zip only when size and digest match the signed manifest', async () => {
    publish(manifest());
    const dest = join(dir, 'ok', 'Bogen-0.2.0-arm64.zip');
    await downloadVerified({ file: 'Bogen-0.2.0-arm64.zip', size: zip.length, sha256: zipSha }, feed, dest);
    expect(readFileSync(dest)).toEqual(zip);

    const swapped = Buffer.from(zip);
    swapped[10] = 0x21;
    publish(manifest(), release.privateKey, { 'Bogen-0.2.0-arm64.zip': swapped });
    const bad = join(dir, 'bad', 'Bogen-0.2.0-arm64.zip');
    await expect(downloadVerified({ file: 'Bogen-0.2.0-arm64.zip', size: zip.length, sha256: zipSha }, feed, bad)).rejects.toThrow(/SHA-256 does not match/);
    expect(existsSync(bad) || existsSync(`${bad}.part`)).toBe(false);

    publish(manifest(), release.privateKey, { 'Bogen-0.2.0-arm64.zip': Buffer.concat([zip, Buffer.from('more')]) });
    await expect(downloadVerified({ file: 'Bogen-0.2.0-arm64.zip', size: zip.length, sha256: zipSha }, feed, bad)).rejects.toThrow(/larger than the signed manifest/);
  });

  it('hands Squirrel.Mac the JSON it reads, and accepts only plain https feeds', () => {
    expect(JSON.parse(squirrelFeed('http://127.0.0.1:5/t/update.zip', '0.2.0'))).toEqual({ url: 'http://127.0.0.1:5/t/update.zip', name: '0.2.0' });
    expect(feedUrl('https://updates.example.com/bogen-macos')?.href).toBe('https://updates.example.com/bogen-macos/');
    for (const bad of ['http://updates.example.com/', 'https://u:p@example.com/', 'https://example.com/?token=x', 'file:///tmp/feed', undefined]) expect(feedUrl(bad)).toBeNull();
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.2', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0+abc', '1.0.0')).toBe(0);
  });
});

describe('update feedback', () => {
  it('tells the person when a download they asked for ends, and only then', async () => {
    const { updateNotice, dockProgress } = await import('../src/main/update-core.ts');
    expect(updateNotice({ state: 'downloading' }, { state: 'installing' })).toBeNull();
    expect(updateNotice({ state: 'installing' }, { state: 'ready' })).toBe('ready');
    expect(updateNotice({ state: 'downloading' }, { state: 'error' })).toBe('error');
    expect(updateNotice({ state: 'available' }, { state: 'error' })).toBeNull();
    expect(updateNotice({ state: 'up-to-date' }, { state: 'available' })).toBeNull();
    expect(dockProgress({ state: 'downloading', done: 50, total: 200 })).toBe(0.25);
    expect(dockProgress({ state: 'installing' })).toBe(2);
    expect(dockProgress({ state: 'ready' })).toBe(-1);
  });
});
