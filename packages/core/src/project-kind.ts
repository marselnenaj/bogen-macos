import type { BogenDoc } from './doc.ts';

/**
 * What a file is a design for, so Home can group files by kind beside their folders. A person can always say it; until
 * then Bogen reads only what a file states about itself: a Mac or an Omarchy theme record and its target, a brand, artboards
 * marked as web pages. A generic design stays "Other designs": a name or a size is not evidence of what it is for.
 * Plugins and widgets here are the designs of their UI and assets; nothing here builds or installs them.
 */

export type ProjectType = 'website' | 'app' | 'mac-theme' | 'omarchy-theme' | 'omarchy-plugin' | 'omasidebar-widget' | 'brand' | 'design';
export type AppPlatform = 'ios' | 'android' | 'desktop';
export type ThemePlatform = 'desktop' | 'mobile';

export interface ProjectInfo {
  type: ProjectType;
  /** For an app: one or more of ios, android, desktop. For a Mac theme: desktop and/or app. For an Omarchy theme: desktop or mobile. */
  platforms?: string[];
  /** Who said it: the person, or Bogen from the file's own records. */
  source: 'person' | 'file' | 'unknown';
}

export const PROJECT_TYPES: { type: ProjectType; label: string; one: string }[] = [
  { type: 'website', label: 'Websites', one: 'Website' },
  { type: 'app', label: 'Apps', one: 'App' },
  { type: 'mac-theme', label: 'Mac themes', one: 'Mac theme' },
  { type: 'omarchy-theme', label: 'Omarchy themes', one: 'Omarchy theme' },
  { type: 'omarchy-plugin', label: 'Omarchy plugins', one: 'Omarchy plugin' },
  { type: 'omasidebar-widget', label: 'Omasidebar widgets', one: 'Omasidebar widget' },
  { type: 'brand', label: 'Brand systems', one: 'Brand system' },
  { type: 'design', label: 'Other designs', one: 'Design' },
];

export const PLATFORMS: Partial<Record<ProjectType, { id: string; label: string }[]>> = {
  app: [{ id: 'ios', label: 'iOS' }, { id: 'android', label: 'Android' }, { id: 'desktop', label: 'Desktop' }],
  'mac-theme': [{ id: 'desktop', label: 'Mac desktop' }, { id: 'app', label: 'Mac app appearance' }],
  'omarchy-theme': [{ id: 'desktop', label: 'Omarchy Desktop' }, { id: 'mobile', label: 'Omarchy Mobile' }],
};

/** Where a person's own answer is kept: in the document, so it travels with the file and syncs with it. */
export const PROJECT_META_KEY = 'project';

const TYPES = new Set(PROJECT_TYPES.map((t) => t.type));

/** A person's answer as stored, checked: an unknown type or platform is dropped, never trusted. */
export function cleanProject(raw: unknown): Omit<ProjectInfo, 'source'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, platforms } = raw as { type?: unknown; platforms?: unknown };
  if (typeof type !== 'string' || !TYPES.has(type as ProjectType)) return null;
  const allowed = new Set((PLATFORMS[type as ProjectType] ?? []).map((p) => p.id));
  const list = Array.isArray(platforms) ? [...new Set(platforms.filter((p): p is string => typeof p === 'string' && allowed.has(p)))] : [];
  return { type: type as ProjectType, ...(list.length ? { platforms: list } : {}) };
}

/**
 * What a document says it is. Cheap: the meta map and the first level of each page, never every layer. The person's
 * answer wins; then a brand, an Omarchy theme with its target, or a page of artboards marked as web pages.
 */
export function readProject(doc: BogenDoc, isBrand = false): ProjectInfo {
  const own = cleanProject(doc.meta.get(PROJECT_META_KEY));
  if (own) return { ...own, source: 'person' };
  if (isBrand) return { type: 'brand', source: 'file' };
  // A Mac theme says which of its two scopes it designs: the desktop, the person's own apps, or both.
  const mac = doc.meta.get('macTheme') as { scopes?: unknown } | undefined;
  if (mac && typeof mac === 'object' && Array.isArray(mac.scopes)) {
    const scopes = ['desktop', 'app'].filter((s) => (mac.scopes as unknown[]).includes(s));
    if (scopes.length) return { type: 'mac-theme', platforms: scopes, source: 'file' };
  }
  const theme = doc.meta.get('omarchyTheme') as { target?: unknown } | undefined;
  if (theme && typeof theme === 'object') return { type: 'omarchy-theme', platforms: [theme.target === 'mobile' ? 'mobile' : 'desktop'], source: 'file' };
  for (const page of doc.getPages()) {
    if (doc.getChildren(page.id).some((n) => n.artboard && n.attrs?.['data-web'] === 'page')) return { type: 'website', source: 'file' };
  }
  return { type: 'design', source: 'unknown' };
}

/** Whether a file of this kind is in a filter: a type, and for apps and themes optionally one platform. */
export function inScope(info: Pick<ProjectInfo, 'type' | 'platforms'> | undefined, type: ProjectType | null, platform: string | null): boolean {
  const own = info ?? { type: 'design' as const };
  if (!type) return true;
  if (own.type !== type) return false;
  return !platform || (own.platforms ?? []).includes(platform);
}
