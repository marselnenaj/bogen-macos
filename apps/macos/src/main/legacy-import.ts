// The script install (integrations/macos) kept designs in ~/.local/share/bogen. The app keeps its own folder and
// never writes there. When the old folder has designs and the app's has none, the app offers to copy them, once.
// Copy, never move: the old install, if still there, keeps working on its own files.

import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Runtime files of a server, not data: copying them would make the app think another server owns its folder. */
const SKIP = new Set(['server.json', 'server.log']);

async function fileCount(dir: string): Promise<number> {
  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as unknown;
    if (Array.isArray(index)) return index.length;
    if (index && typeof index === 'object') {
      const files = (index as { files?: unknown }).files;
      if (Array.isArray(files)) return files.length;
      if (files && typeof files === 'object') return Object.keys(files).length;
    }
    return 0;
  } catch {
    return 0;
  }
}

export interface LegacyOffer { from: string; files: number }

/** Whether to offer the import: old folder with designs, and the app's folder has none yet. */
export async function legacyOffer(legacy: string, data: string): Promise<LegacyOffer | null> {
  const old = await fileCount(legacy);
  if (!old) return null;
  if (await fileCount(data)) return null;
  return { from: legacy, files: old };
}

/** Copies the old folder into the app's (empty) data folder. Never overwrites a file that is there. */
export async function importLegacy(legacy: string, data: string): Promise<{ copied: number }> {
  const info = await stat(legacy);
  if (!info.isDirectory()) throw new Error(`${legacy} is not a folder.`);
  await mkdir(data, { recursive: true, mode: 0o700 });
  let copied = 0;
  for (const entry of await readdir(legacy)) {
    if (SKIP.has(entry) || entry.endsWith('.tmp')) continue;
    await cp(join(legacy, entry), join(data, entry), { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true, verbatimSymlinks: true });
    copied++;
  }
  return { copied };
}
