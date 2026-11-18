// The packaging dependencies the app bundle is built with, after the controlled update of @electron/asar's glob and
// minimatch (package.json "overrides"; GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249). Packager hands the app folder to
// asar, which crawls it with glob and decides what to unpack with minimatch; this builds and reads back a real archive
// with the same kinds of input Bogen's app folder has (dotfiles, nested folders, a native-style unpack pattern).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as asar from '@electron/asar';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { overrides?: Record<string, Record<string, string>> };
const versionOf = (name: string) => (JSON.parse(readFileSync(require.resolve(`${name}/package.json`, { paths: [require.resolve('@electron/asar')] }), 'utf8')) as { version: string }).version;
const dir = mkdtempSync(join(tmpdir(), 'bogen-asar-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('packaging dependencies', () => {
  it('use the patched glob and minimatch under @electron/asar, pinned exactly', () => {
    expect(pkg.overrides?.['@electron/asar']).toEqual({ glob: '14.0.4', minimatch: '11.0.5' });
    expect(versionOf('glob')).toBe('14.0.4');
    expect(versionOf('minimatch')).toBe('11.0.5');
  });

  it('pack an app folder into asar and read every file back, unpacking what the pattern names', async () => {
    const src = join(dir, 'app');
    mkdirSync(join(src, 'dist', 'nested deep'), { recursive: true });
    mkdirSync(join(src, 'native'), { recursive: true });
    writeFileSync(join(src, 'package.json'), '{"name":"bogen-app","main":"dist/main.cjs"}');
    writeFileSync(join(src, 'dist', 'main.cjs'), 'module.exports = 1;\n');
    writeFileSync(join(src, 'dist', 'nested deep', 'page – é.html'), '<!doctype html>');
    writeFileSync(join(src, '.hidden'), 'dot');
    writeFileSync(join(src, 'native', 'addon.node'), 'binary');
    const out = join(dir, 'app.asar');
    await asar.createPackageWithOptions(src, out, { dot: true, unpack: '*.node' });
    const listed = asar.listPackage(out, { isPack: false }).map((p) => p.replaceAll('\\', '/')).sort();
    expect(listed).toEqual(['/.hidden', '/dist', '/dist/main.cjs', '/dist/nested deep', '/dist/nested deep/page – é.html', '/native', '/native/addon.node', '/package.json']);
    expect(asar.extractFile(out, 'dist/nested deep/page – é.html').toString()).toBe('<!doctype html>');
    expect(existsSync(join(`${out}.unpacked`, 'native', 'addon.node'))).toBe(true);
    expect(existsSync(join(`${out}.unpacked`, 'dist'))).toBe(false);
  });
});
