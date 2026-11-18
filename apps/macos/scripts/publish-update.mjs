#!/usr/bin/env node
import { readFileSync } from 'node:fs';
// Publish previously signed OTA files over SSH. Works from Linux or a Mac; needs no private signing key.
// npm run publish-update -- --from release/updates --host <ssh-alias> --remote-root /srv/feed [--ssh-config ~/.ssh/config] [--dry-run]
// --host and --remote-root default to BOGEN_UPDATE_HOST and BOGEN_UPDATE_ROOT.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { releaseDir } from './lib.mjs';
import { verifyUpdateFiles } from './publish-core.mjs';

const { values } = parseArgs({ options: {
  from: { type: 'string' }, host: { type: 'string', default: process.env.BOGEN_UPDATE_HOST },
  'remote-root': { type: 'string', default: process.env.BOGEN_UPDATE_ROOT },
  'ssh-config': { type: 'string' }, 'dry-run': { type: 'boolean' },
} });
const directory = resolve(values.from ?? join(releaseDir, 'updates'));
const { manifest, files } = await verifyUpdateFiles(directory);
console.log(`Verified ${manifest.version}: ${files.join(', ')}.`);
if (values['dry-run']) process.exit(0);
const host = values.host ?? '', root = values['remote-root'] ?? '';
if (!host || !root) throw new Error('Name the feed server: --host <ssh-alias> --remote-root <absolute path> (or BOGEN_UPDATE_HOST and BOGEN_UPDATE_ROOT).');
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)) throw new Error('--host must be a plain SSH host alias.');
if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(root) || root.split('/').some(s => s === '.' || s === '..')) throw new Error('--remote-root must be an absolute path without traversal or shell characters.');
const stage = `${root}/.incoming-${manifest.version}-${randomUUID()}`;
const config = values['ssh-config'] ? ['-F', resolve(values['ssh-config'])] : [];
const ssh = (args, input) => execFileSync('ssh', [...config, '-o', 'BatchMode=yes', host, ...args], { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', ...(input ? { input } : {}) });
ssh(['mkdir', '-m', '755', stage]);
execFileSync('scp', [...config, ...files.map(f => join(directory, f)), `${host}:${stage}/`], { stdio: 'inherit' });
// The remote lock serializes publication. ZIP names are immutable; the manifest and its signature switch together.
const promote = readFileSync(new URL('./promote-update.py', import.meta.url), 'utf8');
ssh(['python3', '-', root, stage, manifest.version], promote);
console.log('Published. Check the public HTTPS feed from outside before distributing the first signed DMG.');
