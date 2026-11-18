import { PROJECT_TYPES, type ProjectType } from './project-kind.ts';

/**
 * Which kinds of project belong to the computer Bogen runs on. One place for Home's kinds list, the Kind menu and the
 * theme sections, so none of them guesses the platform on its own.
 *
 * A kind for another operating system (an Omarchy theme on a Mac, a Mac theme on Omarchy) is foreign here: Bogen does
 * not offer to make one, and does not list it as a kind of this computer. Files of a foreign kind are still real
 * documents, often synced from another device: they stay in All kinds, open like any file, and their kind is listed
 * apart, under the other devices, only while such files exist.
 */

/**
 * The computer the server runs on: a Mac, a Linux machine running Omarchy, or anything else. `unknown` is the editor's
 * state until the server has said (or when it could not be asked): platform-neutral, see `PENDING_KIND_PLATFORM`.
 */
export type KindHost = 'macos' | 'omarchy' | 'other' | 'unknown';

export interface KindPlatform {
  host: KindHost;
  /** Kinds this computer makes and lists as its own, in Home's order. */
  native: ProjectType[];
  /** Kinds for another system: listed only while files of them exist, never offered to make. */
  foreign: ProjectType[];
  /** The kind of theme Home's theme section makes here, if any. */
  themes: 'mac-theme' | 'omarchy-theme' | null;
}

const OMARCHY_KINDS: readonly ProjectType[] = ['omarchy-theme', 'omarchy-plugin', 'omasidebar-widget'];
const MAC_KINDS: readonly ProjectType[] = ['mac-theme'];
/** Kinds that belong to one system. Everything else (websites, apps, brands, designs) is a kind on every computer. */
export const SYSTEM_KINDS: readonly ProjectType[] = [...MAC_KINDS, ...OMARCHY_KINDS];

/** The host from what the server knows: its operating system and, on Linux, whether Omarchy is there. */
export function kindHost(platform: string, omarchy: boolean): KindHost {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux' && omarchy) return 'omarchy';
  return 'other';
}

/**
 * What a host makes and lists. A Mac has Mac themes and no Omarchy kinds; Omarchy has its themes, plugins and widgets
 * and no Mac themes. Anywhere else (Linux without Omarchy, a server on another system) nothing changes: every kind is
 * listed, as before, and Home makes no theme. While the host is unknown, no system's kind is offered or listed empty:
 * only kinds every computer has, plus the system kinds files already have, and no theme is made.
 */
export function kindPlatform(host: KindHost): KindPlatform {
  const all = PROJECT_TYPES.map((k) => k.type);
  const foreign: readonly ProjectType[] = host === 'macos' ? OMARCHY_KINDS : host === 'omarchy' ? MAC_KINDS : host === 'unknown' ? SYSTEM_KINDS : [];
  return {
    host,
    native: all.filter((t) => !foreign.includes(t)),
    foreign: all.filter((t) => foreign.includes(t)),
    themes: host === 'macos' ? 'mac-theme' : host === 'omarchy' ? 'omarchy-theme' : null,
  };
}

/**
 * Until the server has answered, and when it could not be asked: platform-safe. A Mac must not show Omarchy's kinds or
 * its theme section for a moment while the answer is on its way (nor Omarchy a Mac's), so nothing system-specific is
 * offered; files that already have such a kind still list it. Never guessed from the browser.
 */
export const PENDING_KIND_PLATFORM: KindPlatform = kindPlatform('unknown');

/**
 * Home's kinds list: this computer's kinds, then the foreign kinds that have files (in the current folder and search),
 * shown apart. `count` gives the number of files of a kind. While the host is unknown nothing is called foreign yet:
 * the system kinds that have files list in their usual place, and none is shown empty.
 */
export function listedKinds(p: KindPlatform, count: (type: ProjectType) => number): { own: ProjectType[]; elsewhere: ProjectType[] } {
  const present = p.foreign.filter((t) => count(t) > 0);
  if (p.host === 'unknown') return { own: PROJECT_TYPES.map((k) => k.type).filter((t) => p.native.includes(t) || present.includes(t)), elsewhere: [] };
  return { own: p.native, elsewhere: present };
}

/**
 * The kinds the Kind menu offers for one file: this computer's, and the file's own kind when it is a foreign one, so a
 * synced Omarchy theme on a Mac still says what it is and keeps it until the person changes it.
 */
export function menuKinds(p: KindPlatform, current: ProjectType | null | undefined): ProjectType[] {
  return PROJECT_TYPES.map((k) => k.type).filter((t) => p.native.includes(t) || t === current);
}

/**
 * Home's remembered kind filter, checked against this computer: a foreign kind with no files left (an Omarchy filter
 * kept from another visit, say) falls back to all kinds rather than showing an empty list with no way back in the list.
 */
export function usableScope<S extends { kind: ProjectType | null; platform: string | null }>(p: KindPlatform, scope: S, count: (type: ProjectType) => number): S {
  if (!scope.kind || !p.foreign.includes(scope.kind) || count(scope.kind) > 0) return scope;
  return { ...scope, kind: null, platform: null };
}
