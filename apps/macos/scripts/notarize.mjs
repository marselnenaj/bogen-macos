#!/usr/bin/env node
// Notarizes and staples a release Bogen.app or its DMG. macOS only.
//
//   node scripts/notarize.mjs --path release/release/arm64/Bogen.app --keychain-profile bogen-notary
//   node scripts/notarize.mjs --path release/release/Bogen-0.2.0-arm64.dmg --keychain-profile bogen-notary
//
// Credentials: a notarytool keychain profile the owner creates once on the signing Mac with
//   xcrun notarytool store-credentials bogen-notary --apple-id <id> --team-id <TEAMID>
// (it asks for an app-specific password and keeps it in the login keychain). This script never sees a password,
// never takes one as an argument, and never writes one anywhere. Without the profile it stops and says so.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, output, requireDarwin, run } from './lib.mjs';

const { values } = parseArgs({ options: { path: { type: 'string' }, 'keychain-profile': { type: 'string' } } });
requireDarwin('notarize');
const target = values.path ?? fail('--path <Bogen.app or .dmg> is required.');
const profile = values['keychain-profile'] ?? fail('--keychain-profile <name> is required (xcrun notarytool store-credentials).');
if (!existsSync(target)) fail(`${target} does not exist.`);
if (!/^[\w.-]{1,64}$/.test(profile)) fail('The keychain profile name may hold letters, digits, dots, dashes and underscores.');

// A development (ad-hoc) build cannot be notarized; say so before uploading anything.
const signer = spawnSync('codesign', ['-dvv', target], { encoding: 'utf8' }).stderr;
if (!/Authority=Developer ID Application: /.test(signer)) fail(`${target} is not signed with a Developer ID Application identity. Build it with package.mjs --release first.`);

let upload = target;
let temp = null;
if (extname(target) === '.app') {
  temp = mkdtempSync(join(tmpdir(), 'bogen-notarize-'));
  upload = join(temp, `${basename(target, '.app')}.zip`);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', target, upload]);
}
try {
  const r = spawnSync('xcrun', ['notarytool', 'submit', upload, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
  if (r.status !== 0 && /No Keychain password item found|profile/i.test(r.stderr)) fail(`The notarytool profile "${profile}" is not in this Mac's keychain. Create it with xcrun notarytool store-credentials (MACOS-PARENT-ACTIONS.md).`);
  const result = JSON.parse(r.stdout || '{}');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'Accepted') {
    if (result.id) process.stdout.write(output('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', profile]) + '\n');
    fail(`Notarization was not accepted (${result.status ?? `notarytool exited ${r.status}`}). Nothing was stapled.`);
  }
  run('xcrun', ['stapler', 'staple', target]);
  run('xcrun', ['stapler', 'validate', target]);
  process.stdout.write(`Notarized and stapled ${target}\n`);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
