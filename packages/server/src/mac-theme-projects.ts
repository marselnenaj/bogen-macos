// Mac theme projects: one Bogen file per logical Mac theme, found again by what it is (its scopes, its stable project
// id and its name), never by a file title alone and never by loading every file. The same rules as Omarchy theme
// projects (theme-projects.ts): exactly one strong match is reused, several plausible ones are the person's choice,
// none is a new theme, and only an explicit new_project makes a separate one. Alternatives and redos are branches
// inside the file (design branches), never new files.
//
// Each Mac theme file's identity and branches are kept in its index entry (FileEntry.macTheme), refreshed by
// brand-store as rooms load and change. Entries from before the index are read lazily and boundedly, one at a time
// into a document that is thrown away, and then indexed for good.

import { BogenDoc, branchContent, currentBranchId, getDesignBranch, listDesignBranches, MAIN_BRANCH, MAX_OPEN_BRANCHES, Y } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { cleanMeta, MAC_META_KEY, MAC_SCOPES, macSlug, type MacScope } from './mac-theme.ts';
import type { FileEntry, MacThemeIndex, Storage } from './storage.ts';
import { errorMessage } from './util.ts';

/** The title Bogen gives a Mac theme file: `<name> · Mac theme`. */
export const MAC_FILE_SUFFIX = ' · Mac theme';
/** Old entries read per create request when they have no index yet. */
export const MAC_RESOLVE_FALLBACK = 48;

type Identity = Pick<MacThemeIndex, 'name' | 'slug' | 'scopes' | 'project'>;

function identityOf(raw: unknown): Identity | null {
  const meta = cleanMeta(raw);
  if (!meta) return null;
  return { name: meta.name, slug: macSlug(meta.name), scopes: MAC_SCOPES.filter((s) => meta.scopes.includes(s)), ...(meta.project ? { project: meta.project } : {}) };
}

/**
 * A Mac theme file's index record. Its identity is main's: while another branch is checked out the previous identity
 * stays and only the branch fields move, so a branch renaming its theme never renames the project.
 */
export function macThemeIndexOf(doc: BogenDoc, previous?: MacThemeIndex): MacThemeIndex | undefined {
  const branch = currentBranchId(doc);
  let identity: Identity | null = null;
  if (branch === MAIN_BRANCH) identity = identityOf(doc.meta.get(MAC_META_KEY));
  else if (previous) identity = { name: previous.name, slug: previous.slug, scopes: previous.scopes, ...(previous.project ? { project: previous.project } : {}) };
  else {
    try {
      identity = identityOf(branchContent(doc, MAIN_BRANCH).extra?.meta?.[MAC_META_KEY]);
    } catch {
      identity = null;
    }
    identity ??= identityOf(doc.meta.get(MAC_META_KEY));
  }
  if (!identity) return undefined;
  const branches = listDesignBranches(doc).filter((b) => b.status === 'open').slice(0, MAX_OPEN_BRANCHES + 1).map((b) => ({ id: b.id, name: b.name }));
  let branchName = branches.find((b) => b.id === branch)?.name;
  if (!branchName) {
    try {
      branchName = getDesignBranch(doc, branch).name;
    } catch {
      branchName = undefined;
    }
  }
  return { ...identity, branch, ...(branchName ? { branchName } : {}), branches };
}

/** Puts a document's Mac theme record in its index entry. True when it changed. */
export function refreshMacThemeIndex(storage: Storage, id: string, doc: BogenDoc): boolean {
  const entry = storage.get(id);
  if (!entry) return false;
  const next = macThemeIndexOf(doc, entry.macTheme);
  if (JSON.stringify(next) === JSON.stringify(entry.macTheme)) return false;
  storage.update(id, { macTheme: next });
  return true;
}

/** Could be a Mac theme file: its index says so, or its kind does, or it has the name Bogen gives one. */
function macLike(e: FileEntry): boolean {
  return Boolean(e.macTheme) || e.project?.type === 'mac-theme' || e.name.endsWith(MAC_FILE_SUFFIX);
}

/** Entries read and found not to be Mac themes, by the updatedAt they were read at, so they are not read again. */
const notMacThemes = new WeakMap<Storage, Map<string, number>>();

async function indexStored(app: BogenServer, entry: FileEntry): Promise<boolean> {
  const live = app.rooms.peek(entry.id);
  if (live) return refreshMacThemeIndex(app.storage, entry.id, live.doc) || Boolean(app.storage.get(entry.id)?.macTheme);
  const state = await app.storage.readDoc(entry.id).catch(() => null);
  if (!state) return false;
  const probe = new BogenDoc(new Y.Doc());
  try {
    Y.applyUpdate(probe.y, state);
    refreshMacThemeIndex(app.storage, entry.id, probe);
    return Boolean(app.storage.get(entry.id)?.macTheme);
  } catch (e) {
    console.error(`bogen: could not read Mac theme ${entry.id}: ${errorMessage(e)}`);
    return false;
  } finally {
    probe.y.destroy();
  }
}

/** Indexes up to `limit` Mac-theme-like entries without an index, those `first` prefers first. Returns how many remain. */
async function fillIndex(app: BogenServer, limit: number, first?: (e: FileEntry) => boolean): Promise<number> {
  const skip = notMacThemes.get(app.storage) ?? new Map<string, number>();
  notMacThemes.set(app.storage, skip);
  const missing = app.storage.list().filter((e) => !e.macTheme && macLike(e) && skip.get(e.id) !== e.updatedAt);
  if (first) missing.sort((a, b) => Number(first(b)) - Number(first(a)));
  let read = 0;
  for (const entry of missing) {
    if (read >= limit) break;
    read++;
    if (!(await indexStored(app, entry))) skip.set(entry.id, entry.updatedAt);
  }
  return Math.max(0, missing.length - read);
}

const lower = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const scopeKey = (scopes: readonly MacScope[]) => MAC_SCOPES.filter((s) => scopes.includes(s)).join('+');

export interface MacThemeCandidate {
  file_id: string;
  file_name: string;
  name: string;
  scopes: MacScope[];
  project_id?: string;
  updatedAt: number;
  folder?: string;
  branch: { current: string; current_name: string; open: { id: string; name: string }[] };
}

function candidateOf(e: FileEntry): MacThemeCandidate {
  const m = e.macTheme!;
  return {
    file_id: e.id, file_name: e.name, name: m.name, scopes: m.scopes, ...(m.project ? { project_id: m.project } : {}), updatedAt: e.updatedAt, ...(e.folder ? { folder: e.folder } : {}),
    branch: { current: m.branch, current_name: m.branchName ?? (m.branch === MAIN_BRANCH ? 'Main' : m.branch), open: m.branches },
  };
}

export interface MacResolveInput { name?: string; scopes: readonly MacScope[] }

export type MacResolution =
  | { kind: 'reuse'; entry: FileEntry }
  | { kind: 'choose'; candidates: MacThemeCandidate[]; reason: string }
  | { kind: 'create'; unindexed: number };

/**
 * Which existing Mac theme a create request means, among those of the same scopes. A name names one theme: exactly one
 * such file is reused, several are a choice, none is a new theme. Without a name, any Mac theme of those scopes is a
 * choice for the caller (continue one, or make a separate new one on purpose). Never picks the newest of several. The
 * caller holds the creation lock.
 */
export async function resolveMacThemeProject(app: BogenServer, input: MacResolveInput): Promise<MacResolution> {
  const want = input.name?.trim();
  const named = (name: string) => Boolean(want) && (macSlug(name) === macSlug(want!) || lower(name) === lower(want!));
  const titleName = (e: FileEntry) => (e.name.endsWith(MAC_FILE_SUFFIX) ? e.name.slice(0, -MAC_FILE_SUFFIX.length) : e.name);
  const unindexed = await fillIndex(app, MAC_RESOLVE_FALLBACK, (e) => named(titleName(e)));
  const key = scopeKey(input.scopes);
  const same = app.storage.list().filter((e) => e.macTheme && scopeKey(e.macTheme.scopes) === key);
  if (want) {
    const byName = same.filter((e) => named(e.macTheme!.name));
    if (byName.length === 1) return { kind: 'reuse', entry: byName[0]! };
    if (byName.length > 1) return { kind: 'choose', candidates: byName.map(candidateOf), reason: `${byName.length} Mac theme files are named ${want}.` };
    return { kind: 'create', unindexed };
  }
  if (same.length) {
    return {
      kind: 'choose', candidates: same.slice(0, 20).map(candidateOf),
      reason: `No name was given, and ${same.length === 1 ? 'a Mac theme' : `${same.length} Mac themes`} for ${key.replace('+', ' and ')} exist${same.length === 1 ? 's' : ''}: continue one, or make a separate new Mac theme on purpose.`,
    };
  }
  return { kind: 'create', unindexed };
}
