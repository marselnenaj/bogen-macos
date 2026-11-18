import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSigningKey } from '../scripts/release-key.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-mac-release-key-')); dirs.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'packages/server/src'), { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  writeFileSync(join(root, 'packages/server/src/release-key.ts'), `export const RELEASE_PUBLIC_KEYS: readonly string[] = ['${publicKey}'];\n`);
  const file = join(dir, 'release.pem');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  writeFileSync(file, pem, { mode: 0o600 });
  return { dir, root, file, pem };
}

describe('Mac OTA signing key', () => {
  it('accepts the existing key trusted by the app', () => {
    const f = fixture(); expect(readSigningKey(f.file, f.root).asymmetricKeyType).toBe('ed25519');
  });
  it('refuses a different Ed25519 key before producing an unverifiable update', () => {
    const f = fixture();
    writeFileSync(f.file, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
    expect(() => readSigningKey(f.file, f.root)).toThrow(/does not match RELEASE_PUBLIC_KEYS/);
  });
  it('refuses a key stored inside the repository, including an outside symlink to it', () => {
    const f = fixture(); const inside = join(f.root, 'private.pem');
    writeFileSync(inside, f.pem, { mode: 0o600 });
    const link = join(f.dir, 'linked.pem'); symlinkSync(inside, link);
    expect(() => readSigningKey(inside, f.root)).toThrow(/outside the repository/);
    expect(() => readSigningKey(link, f.root)).toThrow(/outside the repository/);
  });
  it('refuses a key readable by other users and an unconfigured key', () => {
    const f = fixture(); chmodSync(f.file, 0o644);
    expect(() => readSigningKey(f.file, f.root)).toThrow(/owner only/);
    expect(() => readSigningKey(undefined, f.root)).toThrow(/BOGEN_RELEASE_KEY_FILE/);
  });
});
