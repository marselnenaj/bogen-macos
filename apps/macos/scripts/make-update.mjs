#!/usr/bin/env node
// Makes the update files for the app's own updater (src/main/update-core.ts) from notarized release builds.
// macOS only. Publishes nothing: it writes release/updates/, which the owner uploads to the update feed.
//
//   BOGEN_RELEASE_KEY_FILE=~/keys/bogen-release.pem node scripts/make-update.mjs --arch arm64 [--arch x64] [--notes "…"]
//
// For each architecture: Bogen-<version>-<arch>.zip of the stapled app (ditto, as Squirrel.Mac expects), then
// bogen-macos-release.json listing every zip with its size and SHA-256, and bogen-macos-release.json.sig, the
// Ed25519 signature by the release key (the same key format and key list as `bogen verify`, release-key.ts).
// It refuses an app that is not Developer ID signed and stapled, a key inside the repository, and a key that others
// can read. The private key is read from the file and never printed or copied.

import { spawnSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, releaseDir, repoRoot, requireDarwin, run, runtime, sha256File } from './lib.mjs';
import { readSigningKey } from './release-key.mjs';

const { values } = parseArgs({ options: { arch: { type: 'string', multiple: true }, notes: { type: 'string' } } });
requireDarwin('make-update');
const arches = values.arch?.length ? values.arch : ['arm64', 'x64'];
if (new Set(arches).size !== arches.length || arches.some(arch => !runtime.architectures.includes(arch))) fail('--arch must name each of arm64 and x64 at most once.');
const version = JSON.parse(readFileSync(join(repoRoot, 'packages', 'server', 'package.json'), 'utf8')).version;

const key = readSigningKey(process.env.BOGEN_RELEASE_KEY_FILE);

const out = join(releaseDir, 'updates');
mkdirSync(out, { recursive: true });
const builds = {};
for (const arch of arches) {
  const app = join(releaseDir, 'release', arch, `${runtime.productName}.app`);
  const signer = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' }).stderr;
  if (!/Authority=Developer ID Application: /.test(signer)) fail(`${app} is not Developer ID signed.`);
  if (spawnSync('xcrun', ['stapler', 'validate', app]).status !== 0) fail(`${app} has no stapled notarization ticket. Run notarize.mjs first.`);
  const file = `Bogen-${version}-${arch}.zip`;
  const zip = join(out, file);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  builds[arch] = { file, size: statSync(zip).size, sha256: await sha256File(zip) };
}

const manifest = Buffer.from(`${JSON.stringify({
  schema: 1, product: 'bogen-macos', version, date: new Date().toISOString(), minimumSystemVersion: runtime.minimumSystemVersion,
  ...(values.notes ? { notes: values.notes } : {}), builds,
}, null, 2)}\n`);
writeFileSync(join(out, 'bogen-macos-release.json'), manifest);
writeFileSync(join(out, 'bogen-macos-release.json.sig'), `${sign(null, manifest, key).toString('base64')}\n`);
process.stdout.write(`Wrote ${out}: bogen-macos-release.json(.sig) and ${Object.values(builds).map((b) => b.file).join(', ')}. Upload them to the update feed; nothing was published.\n`);
