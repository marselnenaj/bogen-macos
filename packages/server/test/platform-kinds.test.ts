import { describe, expect, it } from 'vitest';
import { kindHost, kindPlatform, listedKinds, menuKinds, PENDING_KIND_PLATFORM, PROJECT_TYPES, usableScope, type KindPlatform, type ProjectType } from '@bogen/core';
import { setKindHostForTests, serverKindHost } from '../src/kind-host.ts';
import { startServer } from './helpers.ts';

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const counts = (files: Partial<Record<ProjectType, number>>) => (type: ProjectType) => files[type] ?? 0;
const OMARCHY: ProjectType[] = ['omarchy-theme', 'omarchy-plugin', 'omasidebar-widget'];

describe('kinds of project per computer', () => {
  it('a native Mac lists and offers Mac kinds, never Omarchy ones, and makes Mac themes', () => {
    const mac = kindPlatform(kindHost('darwin', false));
    expect(mac.host).toBe('macos');
    expect(mac.themes).toBe('mac-theme');
    expect(mac.native).toContain('mac-theme');
    for (const k of OMARCHY) expect(mac.native).not.toContain(k);
    expect(mac.foreign).toEqual(OMARCHY);
    // No files of an Omarchy kind: none is listed, not even empty.
    expect(listedKinds(mac, counts({}))).toEqual({ own: mac.native, elsewhere: [] });
    expect(menuKinds(mac, 'design')).toEqual(PROJECT_TYPES.map((k) => k.type).filter((t) => !OMARCHY.includes(t)));
  });

  it('actual Omarchy keeps its kinds with the desktop and mobile distinction, and makes Omarchy themes', () => {
    const omarchy = kindPlatform(kindHost('linux', true));
    expect(omarchy.host).toBe('omarchy');
    expect(omarchy.themes).toBe('omarchy-theme');
    for (const k of OMARCHY) expect(omarchy.native).toContain(k);
    expect(omarchy.foreign).toEqual(['mac-theme']);
    expect(listedKinds(omarchy, counts({})).own).toEqual(expect.arrayContaining(OMARCHY));
    // Linux without Omarchy, and other systems: nothing changes, every kind as before, no theme made on Home.
    const other = kindPlatform(kindHost('linux', false));
    expect(other).toMatchObject({ host: 'other', themes: null, foreign: [] });
    expect(other.native).toEqual(PROJECT_TYPES.map((k) => k.type));
    expect(kindHost('win32', false)).toBe('other');
  });

  it('a synced Omarchy theme on a Mac stays listed apart, keeps its kind, and is never offered to make', () => {
    const mac = kindPlatform('macos');
    const files = counts({ 'omarchy-theme': 2, design: 3 });
    expect(listedKinds(mac, files)).toEqual({ own: mac.native, elsewhere: ['omarchy-theme'] });
    // The Kind menu of that file still names its kind, so the person keeps or changes it knowingly; other files' menus don't.
    expect(menuKinds(mac, 'omarchy-theme')).toContain('omarchy-theme');
    expect(menuKinds(mac, 'omarchy-theme')).not.toContain('omarchy-plugin');
    expect(menuKinds(mac, 'website')).not.toContain('omarchy-theme');
    expect(mac.themes).not.toBe('omarchy-theme');
    // A remembered Omarchy filter works while such files exist, and falls back to all kinds once there are none.
    const scope = { kind: 'omarchy-theme' as const, platform: 'mobile' };
    expect(usableScope(mac, scope, files)).toEqual(scope);
    expect(usableScope(mac, scope, counts({}))).toEqual({ kind: null, platform: null });
    expect(usableScope(mac, { kind: 'mac-theme' as const, platform: null }, counts({}))).toEqual({ kind: 'mac-theme', platform: null });
  });

  it('is platform-safe while the host is unknown: no system kind offered or listed empty, no theme made', () => {
    const p: KindPlatform = PENDING_KIND_PLATFORM;
    expect(p.host).toBe('unknown');
    expect(p.themes).toBeNull();
    for (const k of [...OMARCHY, 'mac-theme' as const]) {
      expect(p.native).not.toContain(k);
      expect(menuKinds(p, 'design')).not.toContain(k);
    }
    expect(listedKinds(p, counts({}))).toEqual({ own: ['website', 'app', 'brand', 'design'], elsewhere: [] });
    // Files that already have a system kind still list it, in its usual place and not as "other devices".
    expect(listedKinds(p, counts({ 'omarchy-theme': 1, 'mac-theme': 1 }))).toEqual({ own: ['website', 'app', 'mac-theme', 'omarchy-theme', 'brand', 'design'], elsewhere: [] });
  });
});

describe('GET /api/platform', () => {
  it('answers with this computer\'s kinds, and the index keeps a synced Omarchy theme file as it is', async () => {
    const h = await startServer();
    try {
      setKindHostForTests(h.server, 'macos');
      const res = await fetch(`${h.base}/api/platform`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(kindPlatform('macos'));
      // A file that arrived from an Omarchy device: real, listed, of its own kind, its document untouched.
      const { id } = await (await fetch(`${h.base}/api/files`, json('POST', { name: 'Ember (from the laptop)' }))).json() as { id: string };
      const room = await h.server.rooms.get(id);
      const record = { name: 'Ember', format: 2, target: 'mobile' };
      room.doc.transact(() => room.doc.meta.set('omarchyTheme', record), 'peer');
      await new Promise((r) => setTimeout(r, 1800));
      const files = await (await fetch(`${h.base}/api/files`)).json() as { id: string; project?: { type: string; platforms?: string[] } }[];
      expect(files.find((f) => f.id === id)?.project).toMatchObject({ type: 'omarchy-theme', platforms: ['mobile'] });
      expect(room.doc.meta.get('omarchyTheme')).toEqual(record);
      setKindHostForTests(h.server, 'omarchy');
      expect(await (await fetch(`${h.base}/api/platform`)).json()).toMatchObject({ host: 'omarchy', themes: 'omarchy-theme' });
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  it('detects a Mac from the operating system alone', async () => {
    const h = await startServer();
    try {
      expect(serverKindHost(h.server, 'darwin')).toBe('macos');
      expect(serverKindHost(h.server, 'win32')).toBe('other');
    } finally {
      await h.cleanup();
    }
  });
});
