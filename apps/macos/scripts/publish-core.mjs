// Verify OTA files before any network write. No signing key is needed to publish an already signed release.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppManifest } from '../src/main/update-core.ts';
import { checkSignature, rawKey, RELEASE_PUBLIC_KEYS } from '../../../packages/server/src/release-key.ts';
import { sha256File } from './lib.mjs';

export async function verifyUpdateFiles(directory, publicKeys = RELEASE_PUBLIC_KEYS) {
  const manifestPath = join(directory, 'bogen-macos-release.json');
  const signaturePath = manifestPath + '.sig';
  if (statSync(manifestPath).size > 65536 || statSync(signaturePath).size > 4096) throw new Error('Update metadata exceeds its size limit.');
  const bytes = readFileSync(manifestPath);
  const signature = readFileSync(signaturePath);
  const checked = checkSignature(publicKeys.map(rawKey).filter(Boolean), bytes, signature);
  if (!checked.ok) throw new Error('Refusing to publish: ' + checked.reason);
  const manifest = parseAppManifest(bytes);
  const builds = Object.values(manifest.builds);
  if (!builds.length) throw new Error('The update must contain at least one architecture.');
  for (const build of builds) {
    const file = join(directory, build.file);
    if (statSync(file).size !== build.size || await sha256File(file) !== build.sha256) throw new Error('Update ZIP does not match the signed manifest: ' + build.file);
  }
  return { manifest, files: [...builds.map(b => b.file), 'bogen-macos-release.json', 'bogen-macos-release.json.sig'] };
}
