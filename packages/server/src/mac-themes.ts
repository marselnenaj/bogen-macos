// Mac theme files: making one, what the editor and agents are told about it, and its export. The data model and the
// honest list of what a Mac theme can change are in mac-theme.ts.
//
// Nothing here touches the system. The export is rendered and packed in memory; the HTTP route hands it to the
// person's save panel, and the agent tool writes it into the export folder. No wallpaper is set, no appearance is
// changed, no script is written or run. An Omarchy theme file stays an Omarchy theme: this module never reads or
// rewrites `meta.omarchyTheme`, and an Omarchy file is refused here rather than converted.

import { createComponent, createMode, currentBranchId, getDesignBranch, getModes, importHtml, MAIN_BRANCH, newId, resolveInstanceRefs, setTokenMode, type BogenDoc, type BogenNode, type NewNode } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import {
  appCss, appearancesOf, appTokensJson, appTokensOf, assetCatalog, capabilitiesFor, cleanDisplay, cleanMeta, DEFAULT_DISPLAY, MAC_DISPLAY_PRESETS, MAC_META_KEY, MAC_SCOPES, MAC_THEME_FORMAT,
  macManifest, macReadme, macSlug, macTokensFor, MANIFEST_FILE, MAX_DISPLAYS, nearestSystemAccent, resolveToken, type BundleWallpaper, type MacAppearance, type MacCapability, type MacDisplay, type MacManifest, type MacScope, type MacThemeMeta,
} from './mac-theme.ts';
import { MAC_BOARD_NAMES, macThemeBoards, wallpaperBoardName, type MacBoard } from './templates/mac-theme.ts';
import { MAC_FILE_SUFFIX, refreshMacThemeIndex, resolveMacThemeProject, type MacThemeCandidate } from './mac-theme-projects.ts';
import { serialized } from './theme-projects.ts';
import { errorMessage, HttpError } from './util.ts';
import { VERSION } from './version.ts';
import { makeZip } from './zip.ts';

/** Where the server runs: a Mac, or anything else. Tests set it. */
export type MacHost = 'macos' | 'other';
export function macHost(platform: NodeJS.Platform = process.platform): MacHost {
  return platform === 'darwin' ? 'macos' : 'other';
}

// ---------------------------------------------------------------- this Mac's displays

/**
 * The displays of the Mac the app runs on, as Bogen for macOS reported them (Electron's screen module, on its
 * display events). Kept in memory only; a server without the app, or on Linux, has none and offers the presets.
 */
export class MacDisplays {
  private list: MacDisplay[] = [];
  set(raw: unknown[]): MacDisplay[] {
    const out: MacDisplay[] = [];
    for (const [i, r] of raw.slice(0, MAX_DISPLAYS).entries()) {
      const d = cleanDisplay({ ...(r as object), id: `this-mac-${i + 1}`, source: 'this-mac' });
      if (d) out.push(d);
    }
    this.list = out;
    return this.all();
  }
  all(): MacDisplay[] {
    return this.list.map((d) => ({ ...d }));
  }
}

const registries = new WeakMap<BogenServer, MacDisplays>();
export function macDisplays(app: BogenServer): MacDisplays {
  let r = registries.get(app);
  if (!r) registries.set(app, (r = new MacDisplays()));
  return r;
}

/** Display requests: a preset id, or one of this Mac's displays by its id. Unknown ones are refused, not guessed. */
export function pickDisplays(requested: string[] | undefined, here: MacDisplay[]): MacDisplay[] {
  const wanted = requested?.length ? requested : here.length ? here.map((d) => d.id) : [DEFAULT_DISPLAY];
  const out: MacDisplay[] = [];
  for (const id of wanted) {
    const d = here.find((x) => x.id === id) ?? MAC_DISPLAY_PRESETS.find((x) => x.id === id);
    if (!d) throw new HttpError(400, `There is no display "${id}". Use a preset (${MAC_DISPLAY_PRESETS.map((p) => p.id).join(', ')}) or one of this Mac's displays.`);
    if (!out.some((x) => x.id === d.id)) out.push({ ...d });
  }
  if (out.length > MAX_DISPLAYS) throw new HttpError(400, `A Mac theme designs for at most ${MAX_DISPLAYS} displays.`);
  return out;
}

// ---------------------------------------------------------------- the file

export function macThemeMeta(doc: BogenDoc): MacThemeMeta | null {
  return cleanMeta(doc.meta.get(MAC_META_KEY));
}

const PAGE = 'Mac theme';

function writeBoards(doc: BogenDoc, pageId: string, boards: MacBoard[]): { id: string; name: string; width: number; height: number }[] {
  const out: { id: string; name: string; width: number; height: number }[] = [];
  for (const b of boards) {
    const id = doc.insert(pageId, {
      type: 'frame', tag: 'main', name: b.name, artboard: true, ...(b.mode ? { mode: b.mode } : {}),
      style: { position: 'absolute', left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, display: 'flex', flexDirection: 'column', backgroundColor: b.background, overflow: 'hidden' },
    });
    doc.invalidate();
    const { nodes } = importHtml(b.html);
    resolveInstanceRefs(doc, nodes as NewNode[]);
    doc.insertMany(id, nodes);
    doc.invalidate();
    for (const name of b.components) {
      const main = doc.descendants(id).find((n) => n.name === name && n.type === 'frame' && !n.virtual);
      if (!main) throw new Error(`Template error: no layer "${name}" in ${b.name}.`);
      createComponent(doc, main.id, { name });
      doc.invalidate();
    }
    // The palette's second half of each swatch shows the dark value.
    for (const n of doc.descendants(id)) if (n.attrs?.['data-mode-sample'] === 'dark') doc.updateFields(n.id, { mode: 'dark' });
    out.push({ id, name: b.name, width: b.width, height: b.height });
  }
  return out;
}

export interface MacThemeRun {
  name?: string;
  scopes?: MacScope[];
  appearance?: MacAppearance;
  /** Preset ids or this Mac's display ids. Default: this Mac's displays, or a MacBook Pro 14″. */
  displays?: string[];
  /** Continue this Mac theme file: it is opened, checked to be a Mac theme, and nothing is made. */
  fileId?: string;
  /**
   * Make a separate new Mac theme even when one for this name and scopes exists. Only when the person asks for a
   * separate theme (Home's New buttons are such an ask); never to edit, revise or try an alternative.
   */
  newProject?: boolean;
  /**
   * Called inside the one-at-a-time creation, right before a new Mac theme file would be made (never on reuse or
   * file_id continuation): throws to refuse, and then nothing is made (mcp/tools-files.ts themeCreateGuard).
   */
  beforeCreate?: () => void;
  origin: string;
}

export interface MacThemeCreated {
  file_id: string;
  file_name: string;
  page_id: string;
  name: string;
  scopes: MacScope[];
  appearance: MacAppearance;
  displays: MacDisplay[];
  boards: { id: string; name: string; width: number; height: number }[];
  tokens: number;
  capabilities: MacCapability[];
  /** The stable id of the logical theme. */
  project_id?: string;
  /** The branch checked out in the file: where edits go. */
  branch: { id: string; name: string };
  /** The file already there for this theme was opened; nothing was made. */
  reused?: boolean;
  /** For a reused file: what to do next without making another one. */
  next?: string;
}

/** Several Mac theme files could be the one meant: nothing was made. */
export interface MacThemeChoice {
  needs_choice: true;
  candidates: MacThemeCandidate[];
  message: string;
  next: string;
}

export type MacThemeOutcome = MacThemeCreated | MacThemeChoice;

export function isMacThemeChoice(out: MacThemeOutcome): out is MacThemeChoice {
  return (out as MacThemeChoice).needs_choice === true;
}

const DEFAULT_NAME = 'New Mac theme';
const REUSE_NEXT = 'This is the Mac theme\'s existing project, opened rather than copied. Small edits continue here, on the branch that is checked out. For an alternative or a redo the person asked for, call design_branch_create: a branch inside this same file. Pass new_project: true only when the person asks for a separate new Mac theme.';
const CHOOSE_NEXT = 'Ask the person which Mac theme to continue, or continue the one they named: call again with its file_id. For an alternative inside it, open it and call design_branch_create. Pass new_project: true only when the person asks for a separate new Mac theme. Never pick the newest one on your own.';

const branchOf = (doc: BogenDoc): { id: string; name: string } => {
  const id = currentBranchId(doc);
  try {
    return { id, name: getDesignBranch(doc, id).name };
  } catch {
    return { id, name: id === MAIN_BRANCH ? 'Main' : id };
  }
};

/** Opens a Mac theme file to continue it: nothing is made. Refuses a file that is not a Mac theme, naming an Omarchy one. */
async function openMacThemeFile(app: BogenServer, fileId: string): Promise<MacThemeCreated> {
  const entry = app.requireFile(fileId);
  if (entry.kind === 'brand') throw new HttpError(422, `${entry.name} is a brand, not a Mac theme file.`);
  const room = await app.rooms.get(entry.id);
  const meta = requireMacTheme(room.doc);
  refreshMacThemeIndex(app.storage, entry.id, room.doc);
  const pageId = room.doc.getPages().find((p) => p.name === PAGE)?.id ?? room.doc.getPages()[0]?.id ?? '';
  return {
    file_id: entry.id, file_name: app.storage.get(entry.id)?.name ?? entry.name, page_id: pageId, name: meta.name, scopes: meta.scopes, appearance: meta.appearance, displays: meta.displays,
    boards: [], tokens: room.doc.getTokens().length, capabilities: capabilitiesFor(meta.scopes), ...(meta.project ? { project_id: meta.project } : {}), branch: branchOf(room.doc), reused: true, next: REUSE_NEXT,
  };
}

/**
 * The Mac theme file a request means: the one given by id, the one existing project its name and scopes name, or a
 * new one. Several plausible files are a choice for the caller, never the newest picked. One request at a time per
 * server (shared with Omarchy theme creation), so the same request sent twice at once makes one file; a request that
 * fails after its file was made leaves none.
 */
export function createMacThemeFile(app: BogenServer, run: MacThemeRun): Promise<MacThemeOutcome> {
  return serialized(app, () => resolveMacThemeFile(app, run));
}

async function resolveMacThemeFile(app: BogenServer, run: MacThemeRun): Promise<MacThemeOutcome> {
  if (run.fileId) return openMacThemeFile(app, run.fileId);
  const scopes = MAC_SCOPES.filter((s) => (run.scopes?.length ? run.scopes : MAC_SCOPES).includes(s));
  const given = run.name?.trim().slice(0, 64) || undefined;
  if (!run.newProject) {
    const found = await resolveMacThemeProject(app, { ...(given ? { name: given } : {}), scopes });
    if (found.kind === 'reuse') return openMacThemeFile(app, found.entry.id);
    if (found.kind === 'choose') return { needs_choice: true, candidates: found.candidates, message: `${found.reason} Nothing was made.`, next: CHOOSE_NEXT };
    if (found.unindexed) throw new HttpError(503, `Bogen is still reading ${found.unindexed} older Mac theme files to find this theme's project. Nothing was made; ask again.`);
  }
  // A name Bogen chose is not taken twice: a second deliberate new theme is "New Mac theme 2".
  let name = given ?? DEFAULT_NAME;
  if (!given) {
    const taken = new Set(app.storage.list().filter((e) => e.macTheme).map((e) => e.macTheme!.slug));
    for (let n = 2; taken.has(macSlug(name)) && n < 100; n++) name = `${DEFAULT_NAME} ${n}`;
  }
  // The last word before anything is made, still inside the lock: a refusal here leaves no file.
  run.beforeCreate?.();
  const entry = app.createFile(`${name}${MAC_FILE_SUFFIX}`);
  try {
    return await fillMacThemeFile(app, run, entry.id, { name, scopes });
  } catch (e) {
    // No half-made theme file is left behind for the next request to find.
    await app.deleteFile(entry.id).catch((err) => console.error(`bogen: could not remove the unfinished Mac theme file ${entry.id}: ${errorMessage(err)}`));
    throw e;
  }
}

/** A new file holding a Mac theme: its tokens (light, and dark as a mode), meta and boards, in one transaction. */
async function fillMacThemeFile(app: BogenServer, run: MacThemeRun, fileId: string, input: { name: string; scopes: MacScope[] }): Promise<MacThemeCreated> {
  const { name, scopes } = input;
  const appearance: MacAppearance = run.appearance ?? 'auto';
  const displays = scopes.includes('desktop') ? pickDisplays(run.displays, macDisplays(app).all()) : [];
  const tokens = macTokensFor(scopes);
  const project = newId();
  const meta: MacThemeMeta = { format: MAC_THEME_FORMAT, name, scopes, appearance, displays, project };
  const room = await app.rooms.get(fileId);
  const { doc } = room;
  let pageId = '';
  let boards: MacThemeCreated['boards'] = [];
  doc.transact(() => {
    if (!getModes(doc).some((m) => m.name === 'dark')) createMode(doc, 'dark', { baseName: 'light' });
    for (const t of tokens) {
      doc.setToken(t.name, t.kind, t.light);
      if (t.dark && t.dark !== t.light) setTokenMode(doc, t.name, 'dark', t.dark);
    }
    doc.meta.set(MAC_META_KEY, meta);
    const page = doc.getPages()[0];
    if (page) {
      doc.renamePage(page.id, PAGE);
      pageId = page.id;
    } else pageId = doc.createPage(PAGE);
    boards = writeBoards(doc, pageId, macThemeBoards({ scopes, appearance, displays, tokens }));
  }, run.origin);
  // Indexed before the next request is let through, so that it finds this file.
  refreshMacThemeIndex(app.storage, fileId, doc);
  const entry = app.storage.get(fileId)!;
  return { file_id: fileId, file_name: entry.name, page_id: pageId, name, scopes, appearance, displays, boards, tokens: tokens.length, capabilities: capabilitiesFor(scopes), project_id: project, branch: { id: MAIN_BRANCH, name: 'Main' } };
}

/** Changes the theme's own record: name, appearance. Scopes and displays stay as made. */
export function updateMacThemeMeta(doc: BogenDoc, patch: { name?: string; appearance?: MacAppearance }, origin: string): MacThemeMeta {
  const meta = requireMacTheme(doc);
  const next: MacThemeMeta = { ...meta, ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 64) } : {}), ...(patch.appearance ? { appearance: patch.appearance } : {}) };
  if (next.appearance !== meta.appearance) {
    // The wallpapers of an appearance are boards of the file: switching to one it was not made with would export
    // nothing for it, so that is refused rather than half done.
    const names = new Set(doc.getPages().flatMap((p) => doc.getChildren(p.id)).filter((n) => n.artboard).map((n) => n.name));
    const missing = wallpaperPlan(next).filter((w) => !names.has(w.board));
    if (missing.length) throw new HttpError(409, `This theme was made for ${meta.appearance === 'auto' ? 'light and dark' : meta.appearance}, and has no "${missing[0]!.board}" board. Make a new Mac theme for ${next.appearance === 'auto' ? 'Auto' : next.appearance}; nothing was changed.`);
  }
  doc.transact(() => doc.meta.set(MAC_META_KEY, next), origin);
  return next;
}

/** Refuses a file that is not a Mac theme, naming what it is when it is an Omarchy theme. Never converts one. */
export function requireMacTheme(doc: BogenDoc): MacThemeMeta {
  const meta = macThemeMeta(doc);
  if (meta) return meta;
  if (doc.meta.get('omarchyTheme')) throw new HttpError(422, 'This file is an Omarchy theme for Omarchy Linux, not a Mac theme. It keeps its format: export it with the Omarchy theme tools, or make a Mac theme as a new file.');
  throw new HttpError(422, 'This file is not a Mac theme. Make one with mac_theme_create, or New Mac theme on Home.');
}

export interface MacThemeInfo {
  name: string;
  slug: string;
  scopes: MacScope[];
  appearance: MacAppearance;
  displays: MacDisplay[];
  host: MacHost;
  accent: { designed: string | null; systemAccent: string };
  capabilities: MacCapability[];
  /** What the export will hold, before anyone clicks. */
  files: string[];
}

function wallpaperPlan(meta: MacThemeMeta): { display: MacDisplay; appearance: 'light' | 'dark'; board: string; file: string }[] {
  if (!meta.scopes.includes('desktop')) return [];
  return appearancesOf(meta.appearance).flatMap((appearance) => meta.displays.map((display) => ({ display, appearance, board: wallpaperBoardName(display, appearance), file: `wallpapers/${display.id}-${appearance}.png` })));
}

export function macThemeInfo(doc: BogenDoc, host: MacHost): MacThemeInfo {
  const meta = requireMacTheme(doc);
  const map = new Map(doc.getTokens().map((t) => [t.name, t]));
  const accent = resolveToken(map, 'mac-accent', 'light');
  const files = [MANIFEST_FILE, 'README.md', ...wallpaperPlan(meta).map((w) => w.file), ...(meta.scopes.includes('app') ? ['app/tokens.css', 'app/tokens.json', 'app/Colors.xcassets/'] : [])];
  return {
    name: meta.name, slug: macSlug(meta.name), scopes: meta.scopes, appearance: meta.appearance, displays: meta.displays, host,
    accent: { designed: accent, systemAccent: nearestSystemAccent(accent ?? '').id }, capabilities: capabilitiesFor(meta.scopes), files,
  };
}

// ---------------------------------------------------------------- export

export interface MacExport { slug: string; manifest: MacManifest; files: { path: string; bytes: Uint8Array }[]; problems: string[] }

export type BoardRenderer = (doc: BogenDoc, node: BogenNode, scale: number) => Promise<Uint8Array>;

const enc = new TextEncoder();

/** Every file of the bundle, rendered and packed in memory. `render` is the server's renderer; tests pass a stand-in. */
export async function exportMacTheme(app: BogenServer, fileId: string, render?: BoardRenderer): Promise<MacExport> {
  const room = await app.rooms.get(app.requireFile(fileId).id);
  const { doc } = room;
  const meta = requireMacTheme(doc);
  const slug = macSlug(meta.name);
  const draw: BoardRenderer = render ?? (async (d, node, scale) => (await app.renderer.screenshot(d, { nodeIds: [node.id] }, { format: 'png', scale })).bytes);
  const problems: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const boards = doc.getPages().flatMap((p) => doc.getChildren(p.id)).filter((n) => n.artboard);
  const wallpapers: BundleWallpaper[] = [];
  for (const w of wallpaperPlan(meta)) {
    const board = boards.find((b) => b.name === w.board);
    if (!board) {
      problems.push(`There is no board "${w.board}", so ${w.file} is left out. Its name is how Bogen finds it.`);
      continue;
    }
    files.push({ path: w.file, bytes: await draw(doc, board, w.display.scale) });
    wallpapers.push({ file: w.file, display: w.display, appearance: w.appearance });
  }
  const tokens = doc.getTokens();
  const map = new Map(tokens.map((t) => [t.name, t]));
  let appCount = 0;
  if (meta.scopes.includes('app')) {
    const app = appTokensOf(tokens);
    problems.push(...app.problems);
    appCount = app.tokens.length;
    files.push({ path: 'app/tokens.css', bytes: enc.encode(appCss(meta.name, app.tokens)) });
    files.push({ path: 'app/tokens.json', bytes: enc.encode(appTokensJson(meta.name, app.tokens)) });
    const catalog = assetCatalog(app.tokens);
    problems.push(...catalog.problems);
    for (const f of catalog.files) files.push({ path: `app/${f.path}`, bytes: enc.encode(f.text) });
  }
  const manifest = macManifest({ name: meta.name, slug, version: VERSION, meta, accent: resolveToken(map, 'mac-accent', 'light'), highlight: resolveToken(map, 'mac-highlight', meta.appearance === 'dark' ? 'dark' : 'light'), wallpapers, appTokens: appCount });
  files.unshift({ path: MANIFEST_FILE, bytes: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`) }, { path: 'README.md', bytes: enc.encode(macReadme(manifest)) });
  return { slug, manifest, files, problems };
}

/** The bundle as one zip with a top folder of the theme's name, which Finder opens by itself. */
export function macThemeZip(out: MacExport): Buffer {
  return makeZip(out.files.map((f) => ({ name: `${out.slug}/${f.path}`, bytes: f.bytes })));
}

export { MAC_BOARD_NAMES };
