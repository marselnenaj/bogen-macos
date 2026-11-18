import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyUpdateFiles } from '../scripts/publish-core.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const promotion = new URL('../scripts/promote-update.py', import.meta.url).pathname;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-ota-publish-')); dirs.push(dir);
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const file = 'Bogen-0.2.0-arm64.zip', zip = Buffer.from('Fixture app archive');
  const manifest = { schema: 1, product: 'bogen-macos', version: '0.2.0', minimumSystemVersion: '13.0', builds: { arm64: { file, size: zip.length, sha256: createHash('sha256').update(zip).digest('hex') } } };
  const write = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(dir, file), zip);
    writeFileSync(join(dir, 'bogen-macos-release.json'), bytes);
    writeFileSync(join(dir, 'bogen-macos-release.json.sig'), sign(null, bytes, privateKey).toString('base64'));
  };
  write(); return { dir, publicKey, manifest, file, write };
}
describe('OTA publication', () => {
  it('verifies the trusted signature and ZIP bytes before preparing an upload', async () => {
    const f = fixture(), verified = await verifyUpdateFiles(f.dir, [f.publicKey]);
    expect(verified.manifest.version).toBe('0.2.0');
    expect(verified.files).toContain(f.file);
    await expect(verifyUpdateFiles(f.dir)).rejects.toThrow(/signature/);
    writeFileSync(join(f.dir, f.file), 'changed');
    await expect(verifyUpdateFiles(f.dir, [f.publicKey])).rejects.toThrow(/ZIP does not match/);
  });
  it('rejects signed metadata that names an unsafe file or contains no builds', async () => {
    const f = fixture(); f.manifest.builds.arm64.file = '../outside.zip'; f.write();
    await expect(verifyUpdateFiles(f.dir, [f.publicKey])).rejects.toThrow(/bad file name/);
    delete (f.manifest.builds as { arm64?: unknown }).arm64; f.write();
    await expect(verifyUpdateFiles(f.dir, [f.publicKey])).rejects.toThrow(/at least one architecture/);
  });
  it('activates both metadata files through one pointer and preserves immutable old assets', () => {
    const f = fixture(), base = join(f.dir, 'remote'), stage = join(base, '.incoming-fixture');
    mkdirSync(stage, { recursive: true });
    for (const name of [f.file, 'bogen-macos-release.json', 'bogen-macos-release.json.sig']) writeFileSync(join(stage, name), readFileSync(join(f.dir, name)));
    execFileSync('python3', [promotion, base, stage, '0.2.0']);
    expect(readlinkSync(join(base, 'current'))).toBe('manifests/0.2.0');
    expect(JSON.parse(readFileSync(join(base, 'current/health.json'), 'utf8')).otaReady).toBe(true);
    const original = readFileSync(join(base, 'assets', f.file));
    mkdirSync(stage);
    for (const name of ['bogen-macos-release.json', 'bogen-macos-release.json.sig']) writeFileSync(join(stage, name), readFileSync(join(f.dir, name)));
    writeFileSync(join(stage, f.file), 'tampered staged ZIP');
    expect(() => execFileSync('python3', [promotion, base, stage, '0.2.0'], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(join(base, 'assets', f.file))).toEqual(original);
    expect(readlinkSync(join(base, 'current'))).toBe('manifests/0.2.0');
    const replacement = Buffer.from('different bytes for an existing version');
    const changed = JSON.parse(readFileSync(join(stage, 'bogen-macos-release.json'), 'utf8'));
    changed.builds.arm64.size = replacement.length;
    changed.builds.arm64.sha256 = createHash('sha256').update(replacement).digest('hex');
    writeFileSync(join(stage, f.file), replacement);
    writeFileSync(join(stage, 'bogen-macos-release.json'), JSON.stringify(changed));
    expect(() => execFileSync('python3', [promotion, base, stage, '0.2.0'], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(join(base, 'assets', f.file))).toEqual(original);
  });
});
