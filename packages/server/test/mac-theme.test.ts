import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BogenDoc, PROJECT_TYPES, PLATFORMS, readProject, setTokenMode } from '@bogen/core';
import { setMacHostForTests } from '../src/http/mac-routes.ts';
import { isLocalOnlyPath } from '../src/peers.ts';
import {
  appCss, assetCatalog, BUNDLE_FORMAT, cleanDisplay, MAC_CAPABILITIES, MAC_DISPLAY_PRESETS, MANIFEST_FILE, nearestSystemAccent, readMacBundle, type MacManifest,
} from '../src/mac-theme.ts';
import { exportMacTheme, macHost, pickDisplays } from '../src/mac-themes.ts';
import { applyTheme, installTheme, type ThemeEnv, type ThemeExport } from '../src/omarchy-themes.ts';
import { GUIDES, INSTRUCTIONS } from '../src/mcp/guide.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** A tiny real PNG, standing in for the renderer: these tests never start a browser. */
function onePixel(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3]))), chunk('IEND', Buffer.alloc(0))]);
}

/** Reads the zip makeZip writes: stored and deflated entries. */
function unzip(buf: Buffer): { path: string; bytes: Uint8Array }[] {
  const out: { path: string; bytes: Uint8Array }[] = [];
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLen);
    const body = buf.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
    out.push({ path: name, bytes: method === 8 ? inflateRawSync(body) : body });
    at += 30 + nameLen + extraLen + size;
  }
  return out;
}

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Mac theme kind and data', () => {
  it('is its own kind with two scopes, distinct from an Omarchy theme, which keeps its own label', () => {
    expect(PROJECT_TYPES.find((t) => t.type === 'mac-theme')).toEqual({ type: 'mac-theme', label: 'Mac themes', one: 'Mac theme' });
    expect(PROJECT_TYPES.find((t) => t.type === 'omarchy-theme')?.label).toBe('Omarchy themes');
    expect(PLATFORMS['mac-theme']!.map((p) => p.id)).toEqual(['desktop', 'app']);
    const doc = new BogenDoc();
    doc.meta.set('macTheme', { format: 1, name: 'Dusk', scopes: ['app'] });
    expect(readProject(doc)).toEqual({ type: 'mac-theme', platforms: ['app'], source: 'file' });
    const omarchy = new BogenDoc();
    omarchy.meta.set('omarchyTheme', { name: 'Ember', format: 2, target: 'desktop' });
    expect(readProject(omarchy)).toEqual({ type: 'omarchy-theme', platforms: ['desktop'], source: 'file' });
  });

  it('accepts only real display sizes and scales, and picks this Mac\'s displays before a preset', () => {
    expect(cleanDisplay({ id: 'x', width: 3024, height: 1964, scale: 2, label: 'A‮B\nC' })).toEqual({ id: 'x', label: 'ABC', width: 3024, height: 1964, scale: 2, source: 'custom' });
    for (const bad of [{ id: 'x', width: 3025, height: 1964, scale: 2 }, { id: 'x', width: 99999, height: 1964, scale: 2 }, { id: 'x', width: 3024, height: 1964, scale: 1.5 }, { id: '../x', width: 3024, height: 1964, scale: 2 }]) {
      expect(cleanDisplay(bad)).toBeNull();
    }
    expect(MAC_DISPLAY_PRESETS.every((p) => cleanDisplay(p))).toBe(true);
    expect(pickDisplays(undefined, []).map((d) => d.id)).toEqual(['macbook-pro-14']);
    const here = [{ id: 'this-mac-1', label: 'Built-in Retina Display', width: 3456, height: 2234, scale: 2 as const, source: 'this-mac' as const }];
    expect(pickDisplays(undefined, here).map((d) => d.id)).toEqual(['this-mac-1']);
    expect(() => pickDisplays(['nope'], here)).toThrow(/no display/);
  });

  it('names the nearest of macOS\'s fixed accents instead of claiming any colour can be the system accent', () => {
    expect(nearestSystemAccent('#6e56cf').id).toBe('purple');
    expect(nearestSystemAccent('#0a84ff').id).toBe('blue');
    expect(nearestSystemAccent('#34c759').id).toBe('green');
    expect(nearestSystemAccent('#777777').id).toBe('graphite');
    expect(nearestSystemAccent('not a colour').id).toBe('blue');
  });

  it('writes app tokens as CSS with a dark block, and an Xcode asset catalog with Any and Dark appearances', () => {
    const tokens = [{ name: 'mac-app-label', kind: 'color' as const, light: '#1d1d1f', dark: '#f2f2f4' }, { name: 'mac-app-space-m', kind: 'spacing' as const, light: '12px', dark: '12px' }, { name: 'mac-app-glass', kind: 'color' as const, light: 'linear-gradient(red, blue)', dark: 'red' }];
    const css = appCss('Dusk */ evil', tokens);
    expect(css).toContain('--mac-app-label: #1d1d1f;');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\n  :root \{\n    --mac-app-label: #f2f2f4;/);
    expect(css).not.toContain('*/ evil');
    const catalog = assetCatalog(tokens);
    expect(catalog.files.map((f) => f.path)).toEqual(['Colors.xcassets/Contents.json', 'Colors.xcassets/Label.colorset/Contents.json']);
    const set = JSON.parse(catalog.files[1]!.text);
    expect(set.colors[0].color.components).toEqual({ alpha: '1.000', blue: '0.122', green: '0.114', red: '0.114' });
    expect(set.colors[1].appearances).toEqual([{ appearance: 'luminosity', value: 'dark' }]);
    expect(catalog.problems[0]).toMatch(/not one colour/);
  });

  it('lists every capability with an honest status, and never claims the system chrome changes', () => {
    const byId = new Map(MAC_CAPABILITIES.map((c) => [c.id, c.status]));
    expect(byId.get('wallpaper-export')).toBe('supported');
    expect(byId.get('wallpaper-apply')).toBe('manual');
    expect(byId.get('system-chrome')).toBe('preview-only');
    expect(byId.get('app-build')).toBe('not-offered');
    expect(MAC_CAPABILITIES.map((c) => `${c.title} ${c.detail}`).join(' ')).not.toMatch(/reskins? (the|your) (menu bar|Dock)|applies? the theme|install(s|ed)? the theme/i);
  });

  it('reads a bundle back as data only, refusing anything that would run or leave the bundle', () => {
    const manifest = { format: BUNDLE_FORMAT, version: 1, name: 'X', slug: 'x', generator: 'Bogen', scopes: ['app'], manual: [], previewOnly: [] };
    const file = (path: string, text = '') => ({ path, bytes: new TextEncoder().encode(text) });
    expect(readMacBundle([file(MANIFEST_FILE, JSON.stringify(manifest))]).manifest.name).toBe('X');
    for (const bad of ['install.sh', 'app/run.js', '../escape.json', 'wallpapers/x.png.command', 'app/theme.lua', 'Contents/MacOS/x']) {
      expect(() => readMacBundle([file(MANIFEST_FILE, JSON.stringify(manifest)), file(bad)])).toThrow(/data only/);
    }
    expect(() => readMacBundle([file(MANIFEST_FILE, JSON.stringify({ ...manifest, format: 'omarchy' }))])).toThrow(/not a Bogen Mac theme/);
    expect(() => readMacBundle([file(MANIFEST_FILE, JSON.stringify({ ...manifest, version: 9 }))])).toThrow(/version 9/);
  });
});

describe('host guards', () => {
  it('keeps every Mac theme route to a person at this machine: never the tailnet or the phone', () => {
    for (const p of ['/api/mac/themes', '/api/mac/displays', '/api/mac/theme/abc/export']) expect(isLocalOnlyPath(p)).toBe(true);
  });

  it('knows a Mac only by its platform', () => {
    expect(macHost('darwin')).toBe('macos');
    expect(macHost('linux')).toBe('other');
  });

  it('never installs or applies an Omarchy theme on a Mac, and runs nothing trying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bogen-mac-guard-'));
    try {
      // A stand-in omarchy that would leave a mark if it ever ran.
      const env: ThemeEnv = { home: join(root, 'home'), omarchyPath: join(root, 'omarchy'), bin: join(root, 'omarchy-must-not-run'), stateFile: join(root, 'state.json'), omamobilePath: join(root, 'none'), platform: 'darwin' };
      await expect(applyTheme(env, 'catppuccin')).rejects.toThrow(/does not run Omarchy/);
      const theme = { name: 'X', slug: 'x', mode: 'dark', target: 'desktop', files: [], generated: [], problems: [], notes: [] } as unknown as ThemeExport;
      await expect(installTheme(env, theme)).rejects.toThrow(/does not run Omarchy/);
      expect(existsSync(join(root, 'home'))).toBe(false);
      expect(existsSync(env.stateFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Mac theme files over HTTP and MCP', () => {
  let h: Harness;
  const scales: number[] = [];
  beforeAll(async () => {
    h = await startServer();
    // The renderer is a stand-in: it records the scale it was asked for and returns a real PNG.
    (h.server.renderer as unknown as { screenshot: (...a: unknown[]) => Promise<{ bytes: Uint8Array }> }).screenshot = async (_doc, _target, options) => {
      scales.push((options as { scale: number }).scale);
      return { bytes: onePixel() };
    };
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('refuses this Mac\'s displays on a server that is not a Mac, and takes them, cleaned, on one', async () => {
    const report = { displays: [{ label: 'Built-in Retina Display', width: 3456, height: 2234, scale: 2 }, { label: 'Bad', width: 3, height: 3, scale: 2 }] };
    setMacHostForTests(h.server, 'other');
    expect((await fetch(`${h.base}/api/mac/displays`, json('POST', report))).status).toBe(409);
    setMacHostForTests(h.server, 'macos');
    const res = await fetch(`${h.base}/api/mac/displays`, json('POST', report));
    expect(res.status).toBe(200);
    expect((await res.json()).displays).toEqual([{ id: 'this-mac-1', label: 'Built-in Retina Display', width: 3456, height: 2234, scale: 2, source: 'this-mac' }]);
    expect((await fetch(`${h.base}/api/mac/displays`, json('POST', { displays: [], path: '/etc' }))).status).toBe(400);
    const state = await (await fetch(`${h.base}/api/mac/themes`)).json();
    expect(state.host).toBe('macos');
    expect(state.capabilities.length).toBe(MAC_CAPABILITIES.length);
  });

  it('creates, edits and exports a Mac theme whose bundle reads back to the same tokens and display-size wallpapers labelled native or backing', async () => {
    const created = await (await fetch(`${h.base}/api/mac/themes`, json('POST', { name: 'Dusk Glass', appearance: 'auto', displays: ['this-mac-1', 'studio-display'] }))).json();
    expect(created.file_name).toBe('Dusk Glass · Mac theme');
    expect(created.scopes).toEqual(['desktop', 'app']);
    expect(created.boards.map((b: { name: string }) => b.name)).toEqual([
      'Palette',
      'Wallpaper · Built-in Retina Display · light', 'Wallpaper · Studio Display · light',
      'Wallpaper · Built-in Retina Display · dark', 'Wallpaper · Studio Display · dark',
      'Desktop preview · light', 'Desktop preview · dark', 'App appearance · light', 'App appearance · dark',
    ]);
    // Boards are in points; the export renders at the display's scale.
    expect(created.boards[1]).toMatchObject({ width: 1728, height: 1117 });
    const room = await h.server.rooms.get(created.file_id);
    const tokens = room.doc.getTokens();
    expect(tokens.every((t) => t.name.startsWith('mac-'))).toBe(true);
    expect(tokens.find((t) => t.name === 'mac-app-label')).toMatchObject({ value: '#1d1d1f', modes: { dark: '#f2f2f4' } });
    expect(h.server.storage.get(created.file_id)?.project).toMatchObject({ type: 'mac-theme', platforms: ['desktop', 'app'] });
    const darkBoard = room.doc.getChildren(created.page_id).find((n) => n.name === 'Wallpaper · Studio Display · dark')!;
    expect(darkBoard.mode).toBe('dark');

    // An edit in the file, as a person or an agent makes it, reaches the export.
    setTokenMode(room.doc, 'mac-app-accent', 'dark', '#ff9f0a');
    const info = await (await fetch(`${h.base}/api/mac/theme/${created.file_id}`)).json();
    expect(info.theme).toMatchObject({ name: 'Dusk Glass', slug: 'dusk-glass', appearance: 'auto', host: 'macos', accent: { systemAccent: 'purple' } });
    expect(info.theme.files).toContain('wallpapers/studio-display-dark.png');
    // Auto has both appearances' boards, so either alone is fine; going back to Auto from one is checked the same way.
    const dark = await fetch(`${h.base}/api/mac/theme/${created.file_id}`, json('PATCH', { appearance: 'dark' }));
    expect((await dark.json()).theme.appearance).toBe('dark');
    expect((await (await fetch(`${h.base}/api/mac/theme/${created.file_id}`, json('PATCH', { appearance: 'auto' }))).json()).theme.appearance).toBe('auto');
    const renamed = await (await fetch(`${h.base}/api/mac/theme/${created.file_id}`, json('PATCH', { name: 'Dusk' }))).json();
    expect(renamed.theme.name).toBe('Dusk');
    expect(h.server.storage.get(created.file_id)?.name).toBe('Dusk · Mac theme');

    scales.length = 0;
    const res = await fetch(`${h.base}/api/mac/theme/${created.file_id}/export`, json('POST', { to: 'zip' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('dusk-mac-theme.zip');
    const entries = unzip(Buffer.from(await res.arrayBuffer()));
    expect(entries.every((e) => e.path.startsWith('dusk/'))).toBe(true);
    const files = entries.map((e) => ({ path: e.path.slice('dusk/'.length), bytes: e.bytes }));
    expect(scales).toEqual([2, 2, 2, 2]);
    // Data only: no script, no binary that runs, nothing outside the folder.
    expect(files.map((f) => f.path).filter((p) => !/\.(json|css|md|png)$/.test(p))).toEqual([]);
    const { manifest, appTokens } = readMacBundle(files);
    expect(manifest).toMatchObject({ format: 'dev.bogen.mac-theme', version: 1, name: 'Dusk', slug: 'dusk', scopes: ['desktop', 'app'] });
    expect(manifest.desktop!.wallpapers.map((w) => [w.file, w.display.width, w.display.height, w.appearance])).toEqual([
      ['wallpapers/this-mac-1-light.png', 3456, 2234, 'light'], ['wallpapers/studio-display-light.png', 5120, 2880, 'light'],
      ['wallpapers/this-mac-1-dark.png', 3456, 2234, 'dark'], ['wallpapers/studio-display-dark.png', 5120, 2880, 'dark'],
    ]);
    // This Mac's display is its current backing size; a preset is the panel's native resolution. The bundle says which.
    expect(manifest.desktop!.wallpapers.map((w) => w.display.pixels)).toEqual(['backing', 'native', 'backing', 'native']);
    expect(manifest.desktop!.accent).toEqual({ designed: '#6e56cf', systemAccent: 'purple' });
    expect(manifest.manual.join(' ')).toMatch(/System Settings › Wallpaper/);
    expect(manifest.previewOnly.join(' ')).toMatch(/no theme reskins them/);
    // Round trip: every app token in the file comes back with both appearances.
    const fromFile = tokens.filter((t) => t.name.startsWith('mac-app-')).map((t) => t.name).sort();
    expect(appTokens.map((t) => t.name).sort()).toEqual(fromFile);
    expect(appTokens.find((t) => t.name === 'mac-app-accent')).toEqual({ name: 'mac-app-accent', light: '#6e56cf', dark: '#ff9f0a' });
    const css = new TextDecoder().decode(files.find((f) => f.path === 'app/tokens.css')!.bytes);
    expect(css).toContain('--mac-app-accent: #ff9f0a;');
    expect(css).not.toMatch(/omarchy/);
    expect(files.some((f) => f.path === 'app/Colors.xcassets/WindowBackground.colorset/Contents.json')).toBe(true);
    const readme = new TextDecoder().decode(files.find((f) => f.path === 'README.md')!.bytes);
    expect(readme).toContain('accent colour Purple');
    expect(readme).toContain('3456 × 2234 (as this Mac renders it now (backing pixels))');
    expect(readme).toContain('5120 × 2880 (native resolution)');
    expect(readme).toContain('Nothing in it runs, and nothing was changed on your Mac.');
  });

  it('makes a desktop-only or app-only theme with just that scope\'s boards and files', async () => {
    const app = await (await fetch(`${h.base}/api/mac/themes`, json('POST', { name: 'Kit', scopes: ['app'] }))).json();
    expect(app.boards.map((b: { name: string }) => b.name)).toEqual(['Palette', 'App appearance · light', 'App appearance · dark']);
    expect(app.capabilities.every((c: { scope: string }) => c.scope === 'app')).toBe(true);
    const out = await exportMacTheme(h.server, app.file_id, async () => onePixel());
    expect(out.files.map((f) => f.path).filter((p) => p.startsWith('wallpapers/'))).toEqual([]);
    expect(out.manifest.desktop).toBeUndefined();
    const desk = await (await fetch(`${h.base}/api/mac/themes`, json('POST', { name: 'Desk', scopes: ['desktop'], appearance: 'dark', displays: ['macbook-air-13'] }))).json();
    // Made for dark only: switching it to light would export a wallpaper it has no board for, so it is refused.
    const refused = await fetch(`${h.base}/api/mac/theme/${desk.file_id}`, json('PATCH', { appearance: 'light' }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/nothing was changed/);
    const d = await exportMacTheme(h.server, desk.file_id, async () => onePixel());
    expect(d.files.map((f) => f.path).filter((p) => p.startsWith('wallpapers/') || p.startsWith('app/'))).toEqual(['wallpapers/macbook-air-13-dark.png']);
    expect(d.manifest.desktop!.appearance).toBe('dark');
  });

  it('leaves an Omarchy theme file as it is: identified, refused for Mac export, never converted', async () => {
    const { id } = await (await fetch(`${h.base}/api/files`, json('POST', { name: 'Ember · Omarchy theme' }))).json() as { id: string };
    const room = await h.server.rooms.get(id);
    const meta = { name: 'Ember', format: 2, target: 'desktop' };
    room.doc.meta.set('omarchyTheme', meta);
    room.doc.setToken('omarchy-accent', 'color', '#ff8800');
    const info = await (await fetch(`${h.base}/api/mac/theme/${id}`)).json();
    expect(info).toEqual({ theme: null, other: 'omarchy-theme' });
    const res = await fetch(`${h.base}/api/mac/theme/${id}/export`, json('POST', { to: 'zip' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Omarchy theme for Omarchy Linux, not a Mac theme/);
    expect((await fetch(`${h.base}/api/mac/theme/${id}`, json('PATCH', { name: 'Mac now' }))).status).toBe(422);
    expect(room.doc.meta.get('omarchyTheme')).toEqual(meta);
    expect(room.doc.meta.get('macTheme')).toBeUndefined();
    expect(room.doc.getTokens().map((t) => t.name)).toEqual(['omarchy-accent']);
  });

  it('tells agents the Mac target and its limits, and exports into the export folder without overwriting', async () => {
    expect(INSTRUCTIONS).toContain('Themes: mac_theme_create, guide_get mac; Omarchy if named');
    expect(GUIDES.mac).toMatch(/no theme changes the menu bar, Dock, Finder or window controls/);
    const agent = await connectAgent(h.base, 'Claude Code');
    try {
      const tools = (await agent.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['mac_theme_create', 'mac_theme_info', 'mac_theme_export']));
      const made = await call(agent, 'mac_theme_create', { name: 'Agent Theme', scopes: ['desktop'], appearance: 'light', displays: ['imac-24'] });
      expect(made.note).toMatch(/Nothing is applied to the Mac/);
      const info = await call(agent, 'mac_theme_info', { file_id: made.file_id });
      expect(info.capabilities.find((c: { id: string }) => c.id === 'wallpaper-apply').status).toBe('manual');
      const first = await call(agent, 'mac_theme_export', { file_id: made.file_id });
      const second = await call(agent, 'mac_theme_export', { file_id: made.file_id });
      expect(first.path).toBe(join(h.home, 'exports', 'agent-theme-mac-theme.zip'));
      expect(second.path).toBe(join(h.home, 'exports', 'agent-theme-mac-theme-2.zip'));
      expect(readdirSync(join(h.home, 'exports')).sort()).toEqual(['agent-theme-mac-theme-2.zip', 'agent-theme-mac-theme.zip']);
      const bundle = readMacBundle(unzip(readFileSync(first.path)).map((e) => ({ path: e.path.slice('agent-theme/'.length), bytes: e.bytes })));
      expect((bundle.manifest as MacManifest).desktop!.wallpapers).toHaveLength(1);
      const guide = await call<string>(agent, 'guide_get', { topic: 'mac' });
      expect(guide).toContain('Designing a Mac theme');
      const refused = await callRaw(agent, 'mac_theme_create', { displays: ['../../etc'] });
      expect(refused.isError).toBe(true);
    } finally {
      await agent.close();
    }
  });
});
