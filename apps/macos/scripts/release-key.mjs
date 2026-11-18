// Shared by the release command and update-artifact writer. Never prints or copies the private key.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { repoRoot } from './lib.mjs';

export function readSigningKey(file, root = repoRoot) {
  if (!file) throw new Error('Set BOGEN_RELEASE_KEY_FILE to the existing release signing key outside the repository.');
  const path = realpathSync(file.replace(/^~(?=\/)/, homedir()));
  const inside = relative(realpathSync(root), path);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('../'))) throw new Error('The release key must stay outside the repository, including through symlinks.');
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('The release key must be a regular file readable by its owner only (chmod 600).');
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release key must be Ed25519.');
  const source = readFileSync(join(root, 'packages/server/src/release-key.ts'), 'utf8');
  const list = source.match(/RELEASE_PUBLIC_KEYS: readonly string\[\] = \[([^\]]*)\]/)?.[1] ?? '';
  const trusted = [...list.matchAll(/'([A-Za-z0-9+/=]{44})'/g)].map(m => m[1]);
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  if (!trusted.includes(publicKey)) throw new Error('The signing key does not match RELEASE_PUBLIC_KEYS; installed apps would refuse this update.');
  return key;
}
