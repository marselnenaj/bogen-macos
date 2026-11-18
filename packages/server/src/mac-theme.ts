// A Mac theme as data: what Bogen designs for a Mac, and what it can honestly hand over. Pure: no files, no processes.
// The file side (making a theme file, rendering, the export) is in mac-themes.ts.
//
// A Mac theme has two scopes, which are kept apart on purpose:
//
// - desktop: the person's own Mac desktop. What a person can really change there is the wallpaper (per display), the
//   appearance (Light, Dark or Auto) and an accent colour out of macOS's fixed set plus a highlight colour, all in
//   System Settings. Bogen designs wallpapers at each display's pixel size (a preset's native panel resolution, or the
//   backing pixels macOS renders this Mac's display at now) and records the appearance and accent
//   the theme was made for. The menu bar, Dock, Finder and window controls in the previews are illustrations: macOS
//   draws them itself, and no theme reskins them.
// - app: the appearance of the person's own apps. Semantic colours (light and dark), type and spacing, exported as
//   CSS custom properties, JSON design tokens and an Xcode asset catalog of colour sets. Bogen designs; it does not
//   compile or ship an app.
//
// The export is data only: PNG, JSON, CSS and Markdown, every file 0644. Nothing in it runs, and reading a bundle back
// only parses JSON. Bogen does not apply anything to the system: wallpaper and appearance are set by the person.

import { normalizeColor, type Token, type TokenKind } from '@bogen/core';

export const MAC_META_KEY = 'macTheme';
/** Version of `meta.macTheme`. A reader takes any version it knows. */
export const MAC_THEME_FORMAT = 1;
/** The bundle's manifest: `format` names it, `version` is its schema version. */
export const BUNDLE_FORMAT = 'dev.bogen.mac-theme';
export const BUNDLE_VERSION = 1;
export const MANIFEST_FILE = 'bogen-mac-theme.json';

export type MacScope = 'desktop' | 'app';
export const MAC_SCOPES: readonly MacScope[] = ['desktop', 'app'];
/** What the desktop is designed for: one appearance, or both for macOS's Auto. */
export type MacAppearance = 'light' | 'dark' | 'auto';

export interface MacDisplay {
  /** Stable within the file, also the wallpaper's file name: macbook-pro-14, display-2. */
  id: string;
  label: string;
  /**
   * Pixels: what the wallpaper PNG is. For a preset, the model's native panel resolution. For a display this Mac
   * reported, its current backing pixels (Electron: Display.size × scaleFactor), which under a scaled "Looks like"
   * resolution is the size macOS renders the desktop at, not necessarily the panel's native resolution.
   */
  width: number;
  height: number;
  /** Backing scale: points are pixels divided by it. Built-in Retina displays are 2. */
  scale: 1 | 2 | 3;
  source: 'preset' | 'this-mac' | 'custom';
}

/** Stored in the file's `meta.macTheme`. */
export interface MacThemeMeta {
  format: number;
  name: string;
  scopes: MacScope[];
  appearance: MacAppearance;
  displays: MacDisplay[];
  /** Stable id of the logical theme, given when the file was made; files made before it have none. */
  project?: string;
}

/** What a project id looks like (the same as an Omarchy theme's). */
export const MAC_PROJECT_RE = /^[0-9a-z]{4,40}$/;

// ---------------------------------------------------------------- displays

/**
 * Common Mac displays at their native resolution, from Apple's published technical specifications of each model
 * (support.apple.com/specs). A wallpaper exported for one is exactly that many pixels.
 */
export const MAC_DISPLAY_PRESETS: readonly MacDisplay[] = [
  { id: 'macbook-air-13', label: 'MacBook Air 13″', width: 2560, height: 1664, scale: 2, source: 'preset' },
  { id: 'macbook-air-15', label: 'MacBook Air 15″', width: 2880, height: 1864, scale: 2, source: 'preset' },
  { id: 'macbook-pro-14', label: 'MacBook Pro 14″', width: 3024, height: 1964, scale: 2, source: 'preset' },
  { id: 'macbook-pro-16', label: 'MacBook Pro 16″', width: 3456, height: 2234, scale: 2, source: 'preset' },
  { id: 'imac-24', label: 'iMac 24″', width: 4480, height: 2520, scale: 2, source: 'preset' },
  { id: 'studio-display', label: 'Studio Display', width: 5120, height: 2880, scale: 2, source: 'preset' },
  { id: 'pro-display-xdr', label: 'Pro Display XDR', width: 6016, height: 3384, scale: 2, source: 'preset' },
];
export const DEFAULT_DISPLAY = 'macbook-pro-14';
export const MAX_DISPLAYS = 6;

const DISPLAY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A display as stored or reported, checked: sizes a Mac display can have, a scale it uses, a label of one line. */
export function cleanDisplay(raw: unknown): MacDisplay | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const scale = d.scale === 1 || d.scale === 2 || d.scale === 3 ? d.scale : null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 640 && n <= 8192;
  if (!scale || !ok(d.width) || !ok(d.height) || typeof d.id !== 'string' || !DISPLAY_ID.test(d.id)) return null;
  if (d.width % scale || d.height % scale) return null;
  const source = d.source === 'preset' || d.source === 'this-mac' || d.source === 'custom' ? d.source : 'custom';
  // eslint-disable-next-line no-control-regex
  const label = typeof d.label === 'string' ? d.label.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, 60) : '';
  return { id: d.id, label: label || `${d.width} × ${d.height}`, width: d.width, height: d.height, scale, source };
}

/**
 * What a display's pixel size is: a preset's native panel resolution, the current backing pixels of a display this Mac
 * reported (which a scaled "Looks like" resolution changes), or a size given by hand.
 */
export type PixelKind = 'native' | 'backing' | 'as-given';
export function pixelKind(d: Pick<MacDisplay, 'source'>): PixelKind {
  return d.source === 'preset' ? 'native' : d.source === 'this-mac' ? 'backing' : 'as-given';
}
const PIXEL_WORDS: Record<PixelKind, string> = { native: 'native resolution', backing: 'as this Mac renders it now (backing pixels)', 'as-given': 'size as given' };
export function pixelWords(d: Pick<MacDisplay, 'source'>): string {
  return PIXEL_WORDS[pixelKind(d)];
}

/** The point size of a display: its artboard on the canvas. */
export function pointsOf(d: MacDisplay): { width: number; height: number } {
  return { width: d.width / d.scale, height: d.height / d.scale };
}

// ---------------------------------------------------------------- meta

export function cleanMeta(raw: unknown): MacThemeMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.format !== 'number' || m.format < 1 || m.format > MAC_THEME_FORMAT) return null;
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, 64) : '';
  const scopes = Array.isArray(m.scopes) ? MAC_SCOPES.filter((s) => (m.scopes as unknown[]).includes(s)) : [];
  if (!name || !scopes.length) return null;
  const appearance = m.appearance === 'light' || m.appearance === 'dark' || m.appearance === 'auto' ? m.appearance : 'auto';
  const displays: MacDisplay[] = [];
  for (const d of Array.isArray(m.displays) ? m.displays : []) {
    const c = cleanDisplay(d);
    if (c && displays.length < MAX_DISPLAYS && !displays.some((x) => x.id === c.id)) displays.push(c);
  }
  return { format: m.format, name, scopes, appearance, displays, ...(typeof m.project === 'string' && MAC_PROJECT_RE.test(m.project) ? { project: m.project } : {}) };
}

/** The appearances a desktop is designed in: one, or both for Auto. */
export function appearancesOf(a: MacAppearance): ('light' | 'dark')[] {
  return a === 'auto' ? ['light', 'dark'] : [a];
}

/** A folder and file name: `Dusk Glass` is dusk-glass. */
export function macSlug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'mac-theme';
}

// ---------------------------------------------------------------- tokens

export interface MacToken { name: string; kind: TokenKind; light: string; dark?: string; scope: MacScope; label: string; macos?: string }

/**
 * The desktop's palette: what the wallpaper starting point and the illustrative previews are drawn from. Light values
 * are the base, dark ones the `dark` mode.
 */
export const DESKTOP_TOKENS: readonly MacToken[] = [
  { name: 'mac-wallpaper-sky', kind: 'color', light: '#dce4f2', dark: '#10162a', scope: 'desktop', label: 'Wallpaper sky' },
  { name: 'mac-wallpaper-horizon', kind: 'color', light: '#f3d8c7', dark: '#2d2142', scope: 'desktop', label: 'Wallpaper horizon' },
  { name: 'mac-wallpaper-glow', kind: 'color', light: '#ffb36e', dark: '#e2845c', scope: 'desktop', label: 'Wallpaper glow' },
  { name: 'mac-wallpaper-ink', kind: 'color', light: '#3a4660', dark: '#070a14', scope: 'desktop', label: 'Wallpaper ink' },
  { name: 'mac-accent', kind: 'color', light: '#6e56cf', dark: '#8f7cf2', scope: 'desktop', label: 'Accent' },
  { name: 'mac-highlight', kind: 'color', light: '#d9d0fa', dark: '#3f3577', scope: 'desktop', label: 'Text highlight' },
];

/**
 * The own-app kit, named after the AppKit semantic colours they stand in for (`macos`), with starting values close to
 * the system's defaults. They are the design's values, never read from or written to the system.
 */
export const APP_TOKENS: readonly MacToken[] = [
  { name: 'mac-app-window-background', kind: 'color', light: '#ececec', dark: '#2b2b2d', scope: 'app', label: 'Window background', macos: 'windowBackgroundColor' },
  { name: 'mac-app-content-background', kind: 'color', light: '#ffffff', dark: '#1e1e20', scope: 'app', label: 'Content background', macos: 'controlBackgroundColor' },
  { name: 'mac-app-sidebar-background', kind: 'color', light: '#e6e3ea', dark: '#262429', scope: 'app', label: 'Sidebar background' },
  { name: 'mac-app-label', kind: 'color', light: '#1d1d1f', dark: '#f2f2f4', scope: 'app', label: 'Label', macos: 'labelColor' },
  { name: 'mac-app-secondary-label', kind: 'color', light: '#6e6e73', dark: '#a1a1a6', scope: 'app', label: 'Secondary label', macos: 'secondaryLabelColor' },
  { name: 'mac-app-tertiary-label', kind: 'color', light: '#a1a1a6', dark: '#6e6e73', scope: 'app', label: 'Tertiary label', macos: 'tertiaryLabelColor' },
  { name: 'mac-app-separator', kind: 'color', light: '#d2d2d7', dark: '#3a3a3c', scope: 'app', label: 'Separator', macos: 'separatorColor' },
  { name: 'mac-app-accent', kind: 'color', light: '#6e56cf', dark: '#8f7cf2', scope: 'app', label: 'Accent', macos: 'controlAccentColor' },
  { name: 'mac-app-on-accent', kind: 'color', light: '#ffffff', dark: '#ffffff', scope: 'app', label: 'On accent', macos: 'alternateSelectedControlTextColor' },
  { name: 'mac-app-selection', kind: 'color', light: '#d9d0fa', dark: '#3f3577', scope: 'app', label: 'Selection', macos: 'selectedContentBackgroundColor' },
  { name: 'mac-app-destructive', kind: 'color', light: '#e5484d', dark: '#ff6369', scope: 'app', label: 'Destructive', macos: 'systemRed' },
  { name: 'mac-app-success', kind: 'color', light: '#2f9e44', dark: '#4cc261', scope: 'app', label: 'Success', macos: 'systemGreen' },
  { name: 'mac-app-font', kind: 'font-family', light: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif', scope: 'app', label: 'Font (the system font)' },
  { name: 'mac-app-text-title', kind: 'font-size', light: '22px', scope: 'app', label: 'Title' },
  { name: 'mac-app-text-headline', kind: 'font-size', light: '15px', scope: 'app', label: 'Headline' },
  { name: 'mac-app-text-body', kind: 'font-size', light: '13px', scope: 'app', label: 'Body' },
  { name: 'mac-app-text-caption', kind: 'font-size', light: '11px', scope: 'app', label: 'Caption' },
  { name: 'mac-app-space-s', kind: 'spacing', light: '8px', scope: 'app', label: 'Space S' },
  { name: 'mac-app-space-m', kind: 'spacing', light: '12px', scope: 'app', label: 'Space M' },
  { name: 'mac-app-space-l', kind: 'spacing', light: '20px', scope: 'app', label: 'Space L (window margin)' },
  { name: 'mac-app-radius-control', kind: 'radius', light: '6px', scope: 'app', label: 'Control radius' },
  { name: 'mac-app-radius-window', kind: 'radius', light: '10px', scope: 'app', label: 'Window radius' },
];

export function macTokensFor(scopes: readonly MacScope[]): MacToken[] {
  // The desktop palette is also what the illustrative previews and the app kit's accent start from.
  return [...DESKTOP_TOKENS.filter((t) => scopes.includes('desktop') || t.name === 'mac-accent'), ...(scopes.includes('app') ? APP_TOKENS : [])];
}

/** Whether a token is part of a Mac theme: `mac-*`. Omarchy's `omarchy-*` tokens never are. */
export const isMacToken = (name: string): boolean => /^mac-[a-z0-9-]+$/.test(name);

/** A token's value in a mode, with `var(--x)` references followed through the file's tokens. */
export function resolveToken(tokens: Map<string, Token>, name: string, mode: 'light' | 'dark', depth = 0): string | null {
  const t = tokens.get(name);
  if (!t || depth > 8) return null;
  const value = (mode === 'dark' && t.modes?.dark) || t.value;
  const ref = /^var\(--([\w-]+)\)$/.exec(value.trim());
  return ref ? resolveToken(tokens, ref[1]!, mode, depth + 1) : value;
}

// ---------------------------------------------------------------- the accent macOS offers

/**
 * The accent colours System Settings › Appearance offers (besides Multicolour), with the system colours they show as.
 * The person picks one there; a theme cannot set an arbitrary accent for the whole system.
 */
export const SYSTEM_ACCENTS: readonly { id: string; label: string; color: string }[] = [
  { id: 'blue', label: 'Blue', color: '#007aff' },
  { id: 'purple', label: 'Purple', color: '#af52de' },
  { id: 'pink', label: 'Pink', color: '#ff2d55' },
  { id: 'red', label: 'Red', color: '#ff3b30' },
  { id: 'orange', label: 'Orange', color: '#ff9500' },
  { id: 'yellow', label: 'Yellow', color: '#ffcc00' },
  { id: 'green', label: 'Green', color: '#28cd41' },
  { id: 'graphite', label: 'Graphite', color: '#8e8e93' },
];

function hsl(hex: string): { h: number; s: number; l: number } {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const r = n(1), g = n(3), b = n(5);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** The System Settings accent closest to a colour: by hue, or Graphite for a grey. */
export function nearestSystemAccent(color: string): (typeof SYSTEM_ACCENTS)[number] {
  const hex = normalizeColor(color)?.slice(0, 7);
  if (!hex) return SYSTEM_ACCENTS[0]!;
  const c = hsl(hex);
  if (c.s < 0.18 || c.l < 0.08 || c.l > 0.94) return SYSTEM_ACCENTS.find((a) => a.id === 'graphite')!;
  let best = SYSTEM_ACCENTS[0]!;
  let gap = Infinity;
  for (const a of SYSTEM_ACCENTS) {
    if (a.id === 'graphite') continue;
    const d = Math.abs(hsl(a.color).h - c.h);
    const around = Math.min(d, 360 - d);
    if (around < gap) {
      gap = around;
      best = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------- what is real

export type CapabilityStatus = 'supported' | 'manual' | 'preview-only' | 'not-offered';

export interface MacCapability { id: string; scope: MacScope; status: CapabilityStatus; title: string; detail: string }

/**
 * What a Mac theme does and does not do, said before anyone clicks: the editor shows this list, agents read it, and
 * the bundle's README repeats it. Sources: Electron 45 has no wallpaper or appearance API for other apps (electron.d.ts:
 * nativeTheme.themeSource changes only this app's own appearance); macOS sets the wallpaper per display in System
 * Settings › Wallpaper, and the appearance and accent in System Settings › Appearance.
 */
export const MAC_CAPABILITIES: readonly MacCapability[] = [
  { id: 'wallpaper-export', scope: 'desktop', status: 'supported', title: 'Wallpapers for each display', detail: 'PNG, one per appearance the theme is designed for: at a preset’s native resolution, or at the size this Mac currently renders a display at (its backing pixels in the chosen scaled resolution, which may differ from the panel’s native resolution).' },
  { id: 'wallpaper-apply', scope: 'desktop', status: 'manual', title: 'Setting the wallpaper', detail: 'You set it in System Settings › Wallpaper (Add Photo…), per display. Bogen does not change your desktop.' },
  { id: 'appearance', scope: 'desktop', status: 'manual', title: 'Light, Dark or Auto', detail: 'The bundle records the appearance the theme was designed for. You choose it in System Settings › Appearance.' },
  { id: 'accent', scope: 'desktop', status: 'manual', title: 'Accent and highlight colour', detail: 'macOS offers a fixed set of accent colours. The bundle names the nearest one to the theme’s accent, and its highlight colour for Highlight colour › Other.' },
  { id: 'dynamic-wallpaper', scope: 'desktop', status: 'not-offered', title: 'Dynamic wallpaper', detail: 'A wallpaper that switches with Light and Dark by itself is a special HEIC file, which Bogen does not make. With Auto you get one PNG for each appearance.' },
  { id: 'other-appearance', scope: 'desktop', status: 'not-offered', title: 'Other Appearance settings', detail: 'Newer macOS versions add options such as icon and widget style and folder colour to System Settings › Appearance. The bundle does not include them; set them as you like.' },
  { id: 'system-chrome', scope: 'desktop', status: 'preview-only', title: 'Menu bar, Dock, Finder and windows', detail: 'They are illustrations in the previews. macOS draws them itself, and no theme reskins them.' },
  { id: 'app-tokens', scope: 'app', status: 'supported', title: 'Your own apps’ appearance', detail: 'Semantic colours for light and dark, type and spacing, as CSS custom properties, JSON design tokens and an Xcode asset catalog of colour sets.' },
  { id: 'app-build', scope: 'app', status: 'not-offered', title: 'Building an app', detail: 'Bogen designs the interface and exports its tokens. It does not compile, sign or ship an app.' },
];

export function capabilitiesFor(scopes: readonly MacScope[]): MacCapability[] {
  return MAC_CAPABILITIES.filter((c) => scopes.includes(c.scope));
}

// ---------------------------------------------------------------- export files

const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** `mac-app-window-background` is WindowBackground in an asset catalog. */
export function colorSetName(token: string): string {
  return token.replace(/^mac-(app-)?/, '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function components(hex: string): Record<string, string> {
  const n = (i: number) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3);
  return { alpha: hex.length === 9 ? n(7) : '1.000', blue: n(5), green: n(3), red: n(1) };
}

export interface AppTokenOut { name: string; kind: TokenKind; light: string; dark: string }

/** The app kit's tokens as the file has them now, both appearances resolved. */
export function appTokensOf(tokens: Token[]): { tokens: AppTokenOut[]; problems: string[] } {
  const map = new Map(tokens.map((t) => [t.name, t]));
  const out: AppTokenOut[] = [];
  const problems: string[] = [];
  for (const t of tokens) {
    if (!t.name.startsWith('mac-app-')) continue;
    const light = resolveToken(map, t.name, 'light');
    const dark = resolveToken(map, t.name, 'dark');
    if (!light || !dark) {
      problems.push(`--${t.name} refers to a token the file does not have, so it is left out.`);
      continue;
    }
    out.push({ name: t.name, kind: t.kind, light, dark });
  }
  return { tokens: out.sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** CSS custom properties: light on :root, dark under prefers-color-scheme. */
export function appCss(name: string, tokens: AppTokenOut[]): string {
  const safe = (v: string) => v.replace(/[{};<>]/g, '');
  const differs = tokens.filter((t) => t.dark !== t.light);
  return [
    `/* ${name.replace(/\*\//g, '')}: app appearance tokens made in Bogen. Data only. */`,
    ':root {',
    '  color-scheme: light dark;',
    ...tokens.map((t) => `  --${t.name}: ${safe(t.light)};`),
    '}',
    ...(differs.length ? ['', '@media (prefers-color-scheme: dark) {', '  :root {', ...differs.map((t) => `    --${t.name}: ${safe(t.dark)};`), '  }', '}'] : []),
    '',
  ].join('\n');
}

const DTCG_TYPE: Partial<Record<TokenKind, string>> = { color: 'color', 'font-family': 'fontFamily', 'font-size': 'dimension', spacing: 'dimension', radius: 'dimension', 'font-weight': 'fontWeight' };

/** Design tokens in the W3C community group's JSON format, the dark values as an extension. */
export function appTokensJson(name: string, tokens: AppTokenOut[]): string {
  const group: Record<string, unknown> = {};
  for (const t of tokens) {
    group[t.name.replace(/^mac-app-/, '')] = {
      $type: DTCG_TYPE[t.kind] ?? 'other',
      $value: t.light,
      ...(t.dark !== t.light ? { $extensions: { 'dev.bogen.appearance': { dark: t.dark } } } : {}),
    };
  }
  return pretty({ $description: `${name}: app appearance tokens made in Bogen. Light values; dark ones under $extensions.`, 'mac-app': group });
}

/** An Xcode asset catalog with one colour set per colour token, for Any and Dark appearance. */
export function assetCatalog(tokens: AppTokenOut[]): { files: { path: string; text: string }[]; problems: string[] } {
  const info = { info: { author: 'xcode', version: 1 } };
  const files = [{ path: 'Colors.xcassets/Contents.json', text: pretty(info) }];
  const problems: string[] = [];
  for (const t of tokens) {
    if (t.kind !== 'color') continue;
    const light = normalizeColor(t.light);
    const dark = normalizeColor(t.dark);
    if (!light || !dark) {
      problems.push(`--${t.name} is not one colour (${t.light}), so the asset catalog has no colour set for it.`);
      continue;
    }
    const colors = [
      { color: { 'color-space': 'srgb', components: components(light) }, idiom: 'universal' },
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], color: { 'color-space': 'srgb', components: components(dark) }, idiom: 'universal' },
    ];
    files.push({ path: `Colors.xcassets/${colorSetName(t.name)}.colorset/Contents.json`, text: pretty({ colors, ...info }) });
  }
  return { files, problems };
}

export interface BundleWallpaper { file: string; display: MacDisplay; appearance: 'light' | 'dark' }

export interface MacManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  name: string;
  slug: string;
  generator: string;
  scopes: MacScope[];
  desktop?: {
    appearance: MacAppearance;
    accent: { designed: string; systemAccent: string };
    highlight: string | null;
    wallpapers: { file: string; display: { id: string; label: string; width: number; height: number; scale: number; pixels: PixelKind }; appearance: 'light' | 'dark' }[];
  };
  app?: { css: string; tokens: string; assetCatalog: string; count: number };
  /** What the person does by hand: nothing here is applied for them. */
  manual: string[];
  /** What the previews show that no theme changes. */
  previewOnly: string[];
}

export function macManifest(input: { name: string; slug: string; version: string; meta: MacThemeMeta; accent: string | null; highlight: string | null; wallpapers: BundleWallpaper[]; appTokens: number }): MacManifest {
  const { meta } = input;
  const caps = capabilitiesFor(meta.scopes);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    name: input.name,
    slug: input.slug,
    generator: `Bogen ${input.version}`,
    scopes: [...meta.scopes],
    ...(meta.scopes.includes('desktop') ? {
      desktop: {
        appearance: meta.appearance,
        accent: { designed: input.accent ?? '', systemAccent: nearestSystemAccent(input.accent ?? '').id },
        highlight: input.highlight,
        wallpapers: input.wallpapers.map((w) => ({ file: w.file, display: { id: w.display.id, label: w.display.label, width: w.display.width, height: w.display.height, scale: w.display.scale, pixels: pixelKind(w.display) }, appearance: w.appearance })),
      },
    } : {}),
    ...(meta.scopes.includes('app') ? { app: { css: 'app/tokens.css', tokens: 'app/tokens.json', assetCatalog: 'app/Colors.xcassets', count: input.appTokens } } : {}),
    manual: caps.filter((c) => c.status === 'manual').map((c) => `${c.title}: ${c.detail}`),
    previewOnly: caps.filter((c) => c.status === 'preview-only').map((c) => `${c.title}: ${c.detail}`),
  };
}

export function macReadme(m: MacManifest): string {
  const accent = m.desktop ? SYSTEM_ACCENTS.find((a) => a.id === m.desktop!.accent.systemAccent) : undefined;
  const appearance = m.desktop ? ({ light: 'Light', dark: 'Dark', auto: 'Auto' } as const)[m.desktop.appearance] : null;
  return [
    `# ${m.name}`,
    '',
    `A Mac theme made in Bogen: ${m.scopes.map((s) => (s === 'desktop' ? 'a desktop appearance' : 'an appearance for your own apps')).join(' and ')}. This folder is data only: images, JSON, CSS and this file. Nothing in it runs, and nothing was changed on your Mac.`,
    '',
    ...(m.desktop ? [
      '## Desktop',
      '',
      ...m.desktop.wallpapers.map((w) => `- \`${w.file}\`: ${w.display.label}, ${w.display.width} × ${w.display.height} (${PIXEL_WORDS[w.display.pixels] ?? 'size as given'}), ${w.appearance}`),
      '',
      'A size "as this Mac renders it now" follows the display\'s current scaled resolution in System Settings › Displays; macOS scales a wallpaper to fit if you change it.',
      '',
      'To use it:',
      '',
      '1. Open System Settings › Wallpaper, choose Add Photo… and pick the wallpaper for that display. With several displays, set each one.',
      `2. In System Settings › Appearance, choose ${appearance}${accent ? `, accent colour ${accent.label}` : ''}${m.desktop.highlight ? `, and Highlight colour › Other… ${m.desktop.highlight}` : ''}.`,
      '',
      m.desktop.appearance === 'auto' ? 'macOS switches a dynamic wallpaper with Light and Dark by itself only for a special HEIC file, which Bogen does not make. Set the light or the dark PNG.' : '',
      'The menu bar, Dock, Finder and window controls in Bogen’s previews are illustrations. macOS draws them itself; no theme changes them.',
      '',
    ] : []),
    ...(m.app ? [
      '## Your own apps',
      '',
      `- \`${m.app.css}\`: CSS custom properties, light on :root and dark under prefers-color-scheme.`,
      `- \`${m.app.tokens}\`: the same tokens as JSON design tokens.`,
      `- \`${m.app.assetCatalog}\`: colour sets with Any and Dark appearances. Drag the folder into an Xcode project to use them as named colours.`,
      '',
      'Bogen designs the interface and exports these tokens. It does not compile or ship an app.',
      '',
    ] : []),
  ].filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
}

// ---------------------------------------------------------------- reading a bundle back

export interface BundleFile { path: string; bytes: Uint8Array }

/** What a bundle may contain: data an app or a person reads, never something that runs. */
const DATA_FILE = /^(bogen-mac-theme\.json|README\.md|wallpapers\/[a-z0-9-]+\.png|preview\/[a-z0-9-]+\.png|app\/tokens\.(css|json)|app\/Colors\.xcassets\/(Contents\.json|[A-Za-z0-9]+\.colorset\/Contents\.json))$/;

/**
 * Checks a bundle and reads its manifest. Throws on anything that is not this format, on a path outside the bundle,
 * and on any file that is not one of its data files. It never runs, loads or imports anything it reads.
 */
export function readMacBundle(files: BundleFile[]): { manifest: MacManifest; appTokens: { name: string; light: string; dark: string }[] } {
  for (const f of files) {
    if (!DATA_FILE.test(f.path) || f.path.includes('..')) throw new Error(`${f.path} is not part of a Mac theme bundle. A bundle is data only.`);
  }
  const text = (path: string) => {
    const f = files.find((x) => x.path === path);
    return f ? new TextDecoder().decode(f.bytes) : null;
  };
  const raw = text(MANIFEST_FILE);
  if (raw === null) throw new Error(`The bundle has no ${MANIFEST_FILE}.`);
  const manifest = JSON.parse(raw) as MacManifest;
  if (manifest?.format !== BUNDLE_FORMAT) throw new Error('This is not a Bogen Mac theme bundle.');
  if (typeof manifest.version !== 'number' || manifest.version > BUNDLE_VERSION) throw new Error(`This bundle is version ${manifest.version}; this Bogen reads up to ${BUNDLE_VERSION}.`);
  for (const w of manifest.desktop?.wallpapers ?? []) {
    if (!files.some((f) => f.path === w.file)) throw new Error(`The manifest names ${w.file}, which the bundle does not have.`);
  }
  const appTokens: { name: string; light: string; dark: string }[] = [];
  const json = manifest.app ? text(manifest.app.tokens) : null;
  if (json !== null) {
    const group = (JSON.parse(json) as Record<string, unknown>)['mac-app'] as Record<string, { $value: string; $extensions?: Record<string, { dark?: string }> }>;
    for (const [key, v] of Object.entries(group ?? {})) {
      appTokens.push({ name: `mac-app-${key}`, light: v.$value, dark: v.$extensions?.['dev.bogen.appearance']?.dark ?? v.$value });
    }
  }
  return { manifest, appTokens };
}
