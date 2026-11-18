// Updates for Bogen.app, the installing half. See update-core.ts for the checks before this point.
//
// After the zip passed the signed-manifest checks, it is handed to Squirrel.Mac (Electron's autoUpdater) through a
// one-shot HTTP server on 127.0.0.1 with a random path. Squirrel unpacks it and refuses it unless its code signature
// satisfies the running app's designated requirement (same Developer ID team), then swaps the bundle on quit.
// The loopback server serves exactly two paths, only to 127.0.0.1, and closes after the hand-off or 10 minutes.

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { autoUpdater } from 'electron';
import { trustedKeys } from '../../../../packages/server/src/release-key.ts';
import { checkAppUpdate, downloadVerified, feedUrl, squirrelFeed, type Arch, type UpdateCheck } from './update-core.ts';

export interface UpdaterConfig {
  feed: string | undefined;
  releaseBuild: boolean;
  version: string;
  cacheDir: string;
  log: (line: string) => void;
}

export type UpdateStatus =
  | UpdateCheck
  | { state: 'downloading'; version: string; done: number; total: number; message: string }
  | { state: 'ready'; version: string; message: string }
  | { state: 'installing'; version: string; message: string };

export class AppUpdater {
  private status: UpdateStatus = { state: 'up-to-date', current: '', latest: '', message: 'Not checked yet.' };
  private busy = false;
  private feedServer: Server | null = null;
  private listeners = new Set<(s: UpdateStatus) => void>();

  constructor(private readonly config: UpdaterConfig) {
    autoUpdater.on('error', (e) => {
      this.config.log(`update: Squirrel refused or failed: ${e.message}`);
      this.set({ state: 'error', message: `The update was not installed: ${e.message}. Bogen stays as it is.` });
      this.closeFeed();
    });
    autoUpdater.on('update-downloaded', (_e, _notes, name) => {
      this.set({ state: 'ready', version: String(name), message: `Bogen ${String(name)} is ready. It is installed when Bogen restarts.` });
      this.closeFeed();
    });
  }

  get current(): UpdateStatus {
    return this.status;
  }

  onChange(fn: (s: UpdateStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: UpdateStatus): void {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Looks for an update. Never downloads by itself. */
  async check(): Promise<UpdateStatus> {
    if (this.busy) return this.status;
    this.busy = true;
    try {
      const result = await checkAppUpdate({
        feed: feedUrl(this.config.feed), releaseBuild: this.config.releaseBuild, keys: trustedKeys(), current: this.config.version, arch: process.arch as Arch, osVersion: process.getSystemVersion(),
      });
      this.config.log(`update: ${result.state}: ${result.message}`);
      this.set(result);
      return result;
    } finally {
      this.busy = false;
    }
  }

  /** Downloads and verifies the available update, then hands it to Squirrel.Mac. Asked for by the person. */
  async download(): Promise<UpdateStatus> {
    const s = this.status;
    if (s.state !== 'available' || this.busy) return this.status;
    const feed = feedUrl(this.config.feed);
    if (!feed) return this.status;
    this.busy = true;
    const version = s.manifest.version;
    const zip = join(this.config.cacheDir, 'updates', s.build.file);
    try {
      this.set({ state: 'downloading', version, done: 0, total: s.build.size, message: `Downloading Bogen ${version}…` });
      let shown = -1;
      await downloadVerified(s.build, feed, zip, fetch, (done, total) => {
        const percent = Math.floor((done / total) * 100);
        const next: UpdateStatus = { state: 'downloading', version, done, total, message: `Downloading Bogen ${version}… ${percent}%` };
        // Every whole percent reaches the Dock and Settings; finer steps only change what a later check reads.
        if (percent === shown) this.status = next;
        else {
          shown = percent;
          this.set(next);
        }
      });
      this.config.log(`update: ${s.build.file} matches the signed manifest (sha256 ${s.build.sha256})`);
      const url = await this.serveOnce(zip, version, s.manifest.notes);
      this.set({ state: 'installing', version, message: `Checking the signature of Bogen ${version}…` });
      autoUpdater.setFeedURL({ url, serverType: 'json' });
      autoUpdater.checkForUpdates();
      return this.status;
    } catch (e) {
      this.set({ state: 'error', message: (e as Error).message });
      return this.status;
    } finally {
      this.busy = false;
    }
  }

  /** Restarts into the new version, after Squirrel accepted it. */
  restartToInstall(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall();
  }

  private async serveOnce(zip: string, version: string, notes?: string): Promise<string> {
    this.closeFeed();
    const token = randomBytes(24).toString('hex');
    const size = (await stat(zip)).size;
    const server = createServer((req, res) => {
      const ok = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
      const port = (server.address() as AddressInfo).port;
      if (!ok || req.method !== 'GET') return void res.writeHead(403).end();
      if (req.url === `/${token}/feed.json`) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return void res.end(squirrelFeed(`http://127.0.0.1:${port}/${token}/update.zip`, version, notes));
      }
      if (req.url === `/${token}/update.zip`) {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(size), 'Cache-Control': 'no-store' });
        return void createReadStream(zip).pipe(res);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.feedServer = server;
    setTimeout(() => this.closeFeed(), 10 * 60_000).unref();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}/feed.json`;
  }

  private closeFeed(): void {
    this.feedServer?.close();
    this.feedServer = null;
  }
}
