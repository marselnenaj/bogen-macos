// A Mac app opened from Finder or the Dock gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `claude` and `codex`, which
// people install with npm, Homebrew, the Claude installer, nvm, Volta or bun, would not be found. The backend spawns
// both by name. So the app asks the person's login shell for its PATH, once per launch, and adds the usual install
// folders that exist.
//
// Only PATH is read. API keys and other variables in shell profiles are not taken over: both CLIs keep their own login
// (`claude` in the Keychain, `codex` in ~/.codex), which works from a GUI launch. Nothing is stripped either: the
// backend gets the app's environment with this PATH.

import { basename, isAbsolute, join } from 'node:path';

const START = '__BOGEN_PATH_START__';
const END = '__BOGEN_PATH_END__';
export const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** The command that prints PATH between markers. Interactive, so that ~/.zshrc and ~/.bashrc run as in Terminal. */
export function shellPathCommand(shell: string): { file: string; args: string[] } | null {
  if (!isAbsolute(shell) || /[\s'"`$;&|<>]/.test(shell)) return null;
  const name = basename(shell);
  if (name === 'fish') return { file: shell, args: ['-l', '-i', '-c', `printf '${START}%s${END}' (string join : $PATH)`] };
  if (['zsh', 'bash', 'sh', 'ksh', 'dash'].includes(name)) return { file: shell, args: ['-l', '-i', '-c', `printf '${START}%s${END}' "$PATH"`] };
  return null;
}

/** The PATH between the markers. Shell profiles may print banners and escape codes around it. */
export function parseShellPath(stdout: string): string[] {
  const start = stdout.lastIndexOf(START);
  if (start < 0) return [];
  const end = stdout.indexOf(END, start);
  if (end < 0) return [];
  return stdout.slice(start + START.length, end).split(':').filter((p) => isAbsolute(p) && !p.includes('\n'));
}

/** Install folders of the CLIs Bogen runs, in the order a person would expect them to win. */
export function knownDirs(home: string): string[] {
  return [
    join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'), join(home, 'Library', 'pnpm'), join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
  ];
}

/**
 * The shell's PATH first (it is what the person sees in Terminal), then known folders that exist and are missing,
 * then the system folders. No duplicates, no relative entries.
 */
export function mergePath(shellPath: string[], home: string, exists: (dir: string) => boolean): string {
  const out: string[] = [];
  const add = (p: string) => {
    if (isAbsolute(p) && !out.includes(p)) out.push(p);
  };
  shellPath.forEach(add);
  knownDirs(home).filter(exists).forEach(add);
  SYSTEM_PATH.forEach(add);
  return out.join(':');
}
