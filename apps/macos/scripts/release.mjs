#!/usr/bin/env node
// Build signed, notarized DMGs and OTA files on a signing Mac. Publishes nothing.
// npm run release -- --identity "Developer ID Application: Name (TEAMID)" \
//   --keychain-profile bogen-notary --update-feed https://example.com/bogen/macos
// BOGEN_RELEASE_KEY_FILE must name the existing trusted key outside this repository.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appRoot, fail, output, releaseDir, repoRoot, requireDarwin, run, runtime } from './lib.mjs';
import { readSigningKey } from './release-key.mjs';
import { checkIdentity } from './sign-lib.mjs';
import { checkVersions } from '../../../scripts/set-version.mjs';

const { values } = parseArgs({ options: {
  arch: { type: 'string', multiple: true }, identity: { type: 'string' },
  'keychain-profile': { type: 'string' }, 'update-feed': { type: 'string' }, notes: { type: 'string' },
} });
requireDarwin('release');
const arches = values.arch ?? ['arm64', 'x64'];
if (new Set(arches).size !== arches.length || arches.some(a => !runtime.architectures.includes(a))) fail('--arch must name each of arm64 and x64 at most once.');
const identity = values.identity ?? fail('--identity is required.');
const profile = values['keychain-profile'];
if (!profile || !/^[\w.-]{1,64}$/.test(profile)) fail('--keychain-profile must name an existing notarytool profile.');
let feed;
try { feed = new URL(values['update-feed']); } catch { fail('--update-feed must be a public HTTPS folder.'); }
if (feed.protocol !== 'https:' || feed.username || feed.password || feed.search || feed.hash) fail('--update-feed must be HTTPS without credentials, query or fragment.');
// Check signing prerequisites before building or contacting Apple's notarization service.
readSigningKey(process.env.BOGEN_RELEASE_KEY_FILE);
const version = checkVersions(repoRoot);
checkIdentity(identity);
if (output('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot })) fail('Commit tracked changes before a release build.');
output('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json']);

run('npm', ['run', 'typecheck'], { cwd: repoRoot });
run('npm', ['run', 'typecheck'], { cwd: appRoot });
run('npm', ['run', 'check:docs'], { cwd: repoRoot });
run('npm', ['run', 'build'], { cwd: repoRoot });
const script = (name, args) => run(process.execPath, [join(appRoot, 'scripts', name + '.mjs'), ...args], { cwd: appRoot });
for (const arch of arches) {
  const app = join(releaseDir, 'release', arch, runtime.productName + '.app');
  const dmg = join(releaseDir, 'release', `Bogen-${version}-${arch}.dmg`);
  script('fetch-runtime', ['--arch', arch, '--frozen']);
  script('package', ['--arch', arch, '--release', '--identity', identity, '--update-feed', feed.href.replace(/\/$/, '')]);
  script('notarize', ['--path', app, '--keychain-profile', profile]);
  // The verifier's GUI mode is intentionally development-only: release apps cannot redirect their real data home.
  // Native release verification still starts the bundled server and performs a real sandboxed render.
  script('verify-app', ['--app', app, '--release', '--notarized']);
  script('make-dmg', ['--arch', arch, '--release', '--identity', identity]);
  script('notarize', ['--path', dmg, '--keychain-profile', profile]);
  script('verify-dmg', ['--dmg', dmg, '--release', '--notarized']);
}
script('make-update', [...arches.flatMap(a => ['--arch', a]), ...(values.notes ? ['--notes', values.notes] : [])]);
console.log(`Verified release in ${releaseDir}/release and signed OTA files in ${releaseDir}/updates. Nothing was published. Upload all ZIPs before the signed manifest and its signature to ${feed.href}.`);
