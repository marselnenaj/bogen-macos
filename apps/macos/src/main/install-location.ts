// Where this copy of Bogen.app runs from, for a clear first launch. Pure: main.ts passes in what it read.
//
// A person who double-clicks Bogen inside the disk image runs it from a read-only volume, and macOS may run a
// downloaded app from a randomized read-only copy (App Translocation) until it has been moved with Finder. From there
// updates cannot replace the app and the disk image cannot be ejected while Bogen runs, so Bogen says so once and
// offers to move itself to /Applications, but only where that needs no administrator password: a person who cannot
// write /Applications is told to drag Bogen to the Applications folder in their home folder instead. Nothing here asks
// for elevated rights. Designs and settings live in ~/Library/Application Support/Bogen, never in the bundle, so a move
// or an update keeps them.

import { dirname, sep } from 'node:path';

export type InstallPlace = 'applications' | 'user-applications' | 'disk-image' | 'translocated' | 'elsewhere';

export interface InstallFacts {
  /** The .app bundle's path (three levels above Contents/MacOS/Bogen). */
  bundle: string;
  /** The person's home folder. */
  home: string;
  /** Whether the bundle's folder can be written to: false on a mounted disk image. */
  bundleFolderWritable: boolean;
  /** Whether this user can write /Applications without a password (members of the admin group, by default). */
  applicationsWritable: boolean;
}

export interface InstallAdvice {
  place: InstallPlace;
  /** Show the first-launch move prompt. */
  prompt: boolean;
  /** Bogen may move itself to /Applications (no elevation needed). */
  canMove: boolean;
  title: string;
  detail: string;
}

/** The .app bundle that contains this executable, or null outside one (a development run). */
export function bundleOf(execPath: string): string | null {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const app = dirname(contents);
  return macos.endsWith(`${sep}Contents${sep}MacOS`) && app.endsWith('.app') ? app : null;
}

export function installPlace(f: Pick<InstallFacts, 'bundle' | 'home' | 'bundleFolderWritable'>): InstallPlace {
  if (f.bundle.includes('/AppTranslocation/')) return 'translocated';
  if (f.bundle.startsWith('/Volumes/') && !f.bundleFolderWritable) return 'disk-image';
  if (dirname(f.bundle) === '/Applications') return 'applications';
  if (dirname(f.bundle) === `${f.home}/Applications`) return 'user-applications';
  return 'elsewhere';
}

/** What the first launch says. Only a disk image or a translocated copy prompts; any other folder is the person's call. */
export function installAdvice(f: InstallFacts): InstallAdvice {
  const place = installPlace(f);
  const prompt = place === 'disk-image' || place === 'translocated';
  const canMove = prompt && f.applicationsWritable;
  const where = place === 'disk-image' ? 'from the disk image' : 'from a temporary read-only copy that macOS made of the download';
  const detail = canMove
    ? `Bogen is running ${where}. Move it to Applications so it can update itself and the disk image can be ejected. Your designs and settings are kept in your Library folder either way.`
    : `Bogen is running ${where}. Quit Bogen, then drag it from the disk image into the Applications folder, or into the Applications folder in your home folder. No administrator password is needed for your own Applications folder.`;
  return { place, prompt, canMove, title: prompt ? 'Move Bogen to Applications?' : '', detail: prompt ? detail : '' };
}
