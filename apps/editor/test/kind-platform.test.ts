import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kindPlatform, PENDING_KIND_PLATFORM, type KindPlatform } from '@bogen/core';
import { askKindPlatformForTests, fromAnswer, kindPlatformNow, resetKindPlatformForTests } from '../src/lib/kind-platform.ts';
import { KindList, type KindScope } from '../src/home/ProjectFilters.tsx';
import type { FileEntry } from '../src/lib/api.ts';

const ALL: KindScope = { kind: null, platform: null };
const file = (id: string, type: string, platforms?: string[]): FileEntry => ({ id, name: id, updatedAt: 0, project: { type, ...(platforms ? { platforms } : {}), source: 'file' } });
const kinds = (html: string) => [...html.matchAll(/data-kind="([^"]*)" data-platform="([^"]*)"/g)].map((m) => (m[2] ? `${m[1]}/${m[2]}` : m[1]));
const list = (platform: KindPlatform, files: FileEntry[]) => renderToStaticMarkup(createElement(KindList, { files, scope: ALL, onScope: () => {}, platform }));

afterEach(() => {
  vi.unstubAllGlobals();
  resetKindPlatformForTests();
});

describe('Home\'s kinds per computer', () => {
  it('a native Mac lists Mac themes and no Omarchy kind when it has no such file', () => {
    const shown = kinds(list(kindPlatform('macos'), [file('a', 'design')]));
    expect(shown).toContain('mac-theme/desktop');
    expect(shown.filter((k) => k?.startsWith('omarchy') || k?.startsWith('omasidebar'))).toEqual([]);
  });

  it('a Mac with a synced Omarchy theme lists its kind apart, under Other devices, with its target', () => {
    const html = list(kindPlatform('macos'), [file('a', 'design'), file('ember', 'omarchy-theme', ['mobile'])]);
    expect(html).toContain('data-testid="kind-elsewhere"');
    const apart = html.slice(html.indexOf('kind-elsewhere'));
    expect(kinds(apart)).toEqual(['omarchy-theme', 'omarchy-theme/desktop', 'omarchy-theme/mobile']);
    expect(kinds(apart)).not.toContain('omarchy-plugin');
  });

  it('actual Omarchy keeps its own kinds with desktop and mobile, and lists Mac themes only when there are some', () => {
    const shown = kinds(list(kindPlatform('omarchy'), []));
    expect(shown).toEqual(expect.arrayContaining(['omarchy-theme', 'omarchy-theme/desktop', 'omarchy-theme/mobile', 'omarchy-plugin', 'omasidebar-widget']));
    expect(shown).not.toContain('mac-theme');
    expect(list(kindPlatform('omarchy'), [])).not.toContain('kind-elsewhere');
  });

  it('while the platform is not known, nothing system-specific is listed empty', () => {
    const shown = kinds(list(PENDING_KIND_PLATFORM, [file('a', 'design')]));
    expect(shown).toEqual(['', 'website', 'app', 'app/ios', 'app/android', 'app/desktop', 'brand', 'design']);
    // An existing file's kind is never hidden, and is not called "other devices" before the server said so.
    const withFile = list(PENDING_KIND_PLATFORM, [file('ember', 'omarchy-theme', ['desktop'])]);
    expect(kinds(withFile)).toContain('omarchy-theme/desktop');
    expect(withFile).not.toContain('kind-elsewhere');
  });
});

describe('asking the server which computer it is', () => {
  it('stays platform-safe while the answer is slow, then takes it', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const asking = askKindPlatformForTests();
    await Promise.resolve();
    expect(kindPlatformNow()).toMatchObject({ host: 'unknown', known: false, themes: null });
    expect(kindPlatformNow().native).not.toContain('omarchy-theme');
    answer(new Response(JSON.stringify(kindPlatform('macos')), { status: 200 }));
    await asking;
    expect(kindPlatformNow()).toMatchObject({ host: 'macos', known: true, themes: 'mac-theme' });
  });

  it('stays platform-safe when the answer fails, errs or makes no sense, and never falls back to every kind', async () => {
    for (const reply of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('{"error":"nope"}', { status: 500 })),
      () => Promise.resolve(new Response('{"host":"amiga"}', { status: 200 })),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    ]) {
      resetKindPlatformForTests();
      vi.stubGlobal('fetch', vi.fn(reply));
      await askKindPlatformForTests();
      const now = kindPlatformNow();
      expect(now).toMatchObject({ host: 'unknown', known: false, themes: null });
      expect(now.native).not.toContain('omarchy-theme');
      expect(now.native).not.toContain('mac-theme');
    }
  });

  it('rebuilds the lists from the host alone, never from what the answer lists', () => {
    expect(fromAnswer({ host: 'macos', native: ['omarchy-theme'], themes: 'omarchy-theme' })).toEqual(kindPlatform('macos'));
    expect(fromAnswer({ host: 'unknown' })).toBeNull();
    expect(fromAnswer(null)).toBeNull();
  });
});
