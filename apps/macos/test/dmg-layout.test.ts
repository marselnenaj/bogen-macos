import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { aliasRecord, backgroundSvg, bplist, dmgPlan, dsStore, layoutRecords, readAlias, readDsStore, readIloc } from '../scripts/dmg-layout.mjs';

/** Python's plistlib, a decoder written independently of ours, when this machine has Python (the Mac runner does). */
function decodeWithPython(b: Buffer): unknown {
  const r = spawnSync('python3', ['-I', '-c', 'import sys,plistlib,json,base64\nv=plistlib.loads(sys.stdin.buffer.read())\nprint(json.dumps(v, default=lambda o: {"data": base64.b64encode(o).decode()}))'], { input: b, encoding: 'utf8' });
  if (r.error && 'code' in r.error && r.error.code === 'ENOENT') return undefined;
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Python's independent plist decoder failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const target = { volumeName: 'Bogen 0.1.0 Dev', volumeCreated: Date.UTC(2026, 10, 6, 12), mountPoint: '/Volumes/Bogen 0.1.0 Dev', path: '/.background/background.tiff', cnid: 23, parentCnid: 19, created: Date.UTC(2026, 10, 6, 12, 1) };

describe('the disk image plan', () => {
  it('names a development image as such and a release image plainly', () => {
    const dev = dmgPlan({ version: '0.1.0', arch: 'arm64', release: false });
    expect(dev).toMatchObject({ volumeName: 'Bogen 0.1.0 Dev', fileName: 'Bogen-0.1.0-arm64-dev-unsigned.dmg', app: 'Bogen.app', release: false });
    expect(dev.words.note.join(' ')).toMatch(/Development build, ad-hoc signed/);
    expect(dev.words.note.join(' ')).toMatch(/Open Anyway in System Settings › Privacy & Security/);
    const rel = dmgPlan({ version: '1.2.3', arch: 'x64', release: true });
    expect(rel).toMatchObject({ volumeName: 'Bogen 1.2.3', fileName: 'Bogen-1.2.3-x64.dmg' });
    expect(rel.words.note.join(' ')).not.toMatch(/Development|ad-hoc/);
    // The app on the left, Applications on the right, both inside the window.
    const [app, apps] = rel.items;
    expect(app!.name).toBe('Bogen.app');
    expect(apps!.name).toBe('Applications');
    for (const i of rel.items) {
      expect(i.x - rel.iconSize / 2).toBeGreaterThan(0);
      expect(i.x + rel.iconSize / 2).toBeLessThan(rel.window.width);
    }
  });

  it('refuses names that could reach a shell, a path or an alias badly', () => {
    for (const version of ['1.0', '1.0.0; rm -rf /', '../1.0.0', '1.0.0/x', '1.0.0 beta', '']) expect(() => dmgPlan({ version, arch: 'arm64', release: false }), version).toThrow();
    expect(() => dmgPlan({ version: '1.0.0', arch: 'ppc', release: false })).toThrow();
    expect(() => dmgPlan({ version: '1.0.0-rc.1', arch: 'arm64', release: true })).not.toThrow();
    expect(() => dmgPlan({ version: '1.0.0-averyveryverylongprerelease', arch: 'arm64', release: false })).toThrow(/27 bytes/);
  });

  it('draws the background with the words escaped and both icon name plates', () => {
    const svg = backgroundSvg(dmgPlan({ version: '0.1.0', arch: 'arm64', release: false }));
    expect(svg).toContain('Install Bogen');
    expect(svg).toContain('Drag Bogen onto Applications');
    expect(svg).toContain('Privacy &amp; Security');
    expect(svg).not.toMatch(/& /);
    expect(svg.match(/fill="#75727a"/g)).toHaveLength(2);
    expect(svg).toMatch(/^<svg [^>]*width="660" height="400"/);
  });
});

describe('binary property lists', () => {
  it('decode with an independent reader to what was written', () => {
    const value = { ShowToolbar: false, WindowBounds: '{{200, 120}, {660, 400}}', iconSize: { real: 128 }, viewOptionsVersion: 1, big: 70000, name: 'Bogen – Ü', data: Buffer.from([1, 2, 3]), list: [1, 'a', true] };
    const decoded = decodeWithPython(bplist(value));
    if (decoded === undefined) return; // no Python here: the native CI runner has it
    expect(decoded).toEqual({ ShowToolbar: false, WindowBounds: '{{200, 120}, {660, 400}}', iconSize: 128, viewOptionsVersion: 1, big: 70000, name: 'Bogen – Ü', data: { data: 'AQID' }, list: [1, 'a', true] });
  });

  it('starts with the bplist00 magic and keeps dictionaries of 15 or more keys', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const b = bplist(many);
    expect(b.subarray(0, 8).toString()).toBe('bplist00');
    const decoded = decodeWithPython(b);
    if (decoded !== undefined) expect(decoded).toEqual(many);
  });
});

describe('the background alias', () => {
  it('records the volume, the file, its folder and both paths', () => {
    const a = aliasRecord(target);
    const r = readAlias(a);
    expect(r).toMatchObject({ version: 2, size: a.length, volumeName: 'Bogen 0.1.0 Dev', fileName: 'background.tiff', parentCnid: 19, cnid: 23, posixPath: '/.background/background.tiff', mountPoint: '/Volumes/Bogen 0.1.0 Dev', carbonPath: 'Bogen 0.1.0 Dev:.background:background.tiff', unicodeName: 'background.tiff' });
    expect(a.length % 2).toBe(0);
    expect(a.readInt16BE(a.length - 4)).toBe(-1);
  });
});

describe('the .DS_Store', () => {
  it('holds the window, the icon view with the background picture, and every icon position', () => {
    const plan = dmgPlan({ version: '0.1.0', arch: 'arm64', release: false });
    const alias = aliasRecord(target);
    const file = dsStore(layoutRecords(plan, alias));
    expect(file.readUInt32BE(0)).toBe(1);
    expect(file.subarray(4, 8).toString()).toBe('Bud1');
    const { records, count } = readDsStore(file);
    expect(count).toBe(records.length);
    expect(records.map((r) => `${r.name}/${r.code}`)).toEqual(['./bwsp', './icvp', './vSrn', './vstl', 'Applications/Iloc', 'Bogen.app/Iloc']);
    const at = (name: string) => readIloc(records.find((r) => r.name === name && r.code === 'Iloc')!.value as Buffer);
    expect(at('Bogen.app')).toEqual({ x: 180, y: 200 });
    expect(at('Applications')).toEqual({ x: 480, y: 200 });
    const icvp = decodeWithPython(records.find((r) => r.code === 'icvp')!.value as Buffer) as Record<string, unknown> | undefined;
    if (icvp) {
      expect(icvp).toMatchObject({ backgroundType: 2, arrangeBy: 'none', iconSize: 128, labelOnBottom: true, showItemInfo: false, viewOptionsVersion: 1 });
      expect(Buffer.from((icvp.backgroundImageAlias as { data: string }).data, 'base64').equals(alias)).toBe(true);
      const bwsp = decodeWithPython(records.find((r) => r.code === 'bwsp')!.value as Buffer);
      expect(bwsp).toMatchObject({ ShowToolbar: false, ShowSidebar: false, ShowStatusBar: false, ShowPathbar: false, WindowBounds: '{{200, 120}, {660, 400}}' });
    }
  });

  it('lays out the allocator as Finder does: header, allocator block, master, one leaf page', () => {
    const file = dsStore(layoutRecords(dmgPlan({ version: '0.1.0', arch: 'arm64', release: true })));
    expect(file.readUInt32BE(8)).toBe(2048);
    expect(file.readUInt32BE(16)).toBe(2048);
    expect(file.length).toBe(4 + 8192);
    const info = file.subarray(4 + 2048);
    expect(info.readUInt32BE(0)).toBe(3);
    expect([info.readUInt32BE(8), info.readUInt32BE(12), info.readUInt32BE(16)]).toEqual([2048 | 11, 32 | 5, 4096 | 12]);
    // Without an alias the window falls back to a plain colour, never a missing picture.
    const icvp = decodeWithPython(readDsStore(file).records.find((r) => r.code === 'icvp')!.value as Buffer) as Record<string, unknown> | undefined;
    if (icvp) {
      expect(icvp.backgroundType).toBe(1);
      expect(icvp).not.toHaveProperty('backgroundImageAlias');
    }
  });
});
