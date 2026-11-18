/**
 * The words of a Mac theme that reach the editor as data from the server (packages/server/src/mac-theme.ts), marked
 * here with `msg` so the extractor finds them and translators see them. They render with `t(...)` on the server's own
 * English: a capability or accent the server adds later, or rewords, shows its English rather than a stale
 * translation. Agents keep reading the server's English (MCP tools and the guide are not translated).
 *
 * apps/editor/test/mac-i18n.test.ts checks that every capability and accent the server has is declared here, word for
 * word, so the two lists cannot drift apart unnoticed.
 */
import { msg } from '../i18n/core.ts';
import type { MacCapability } from '../lib/agent-api.ts';

/** `MAC_CAPABILITIES`: what a Mac theme changes, as the dialog shows it before any click. */
export const MAC_CAPABILITY_WORDS: Readonly<Record<string, { title: string; detail: string }>> = {
  'wallpaper-export': {
    title: msg('Wallpapers for each display'),
    detail: msg('PNG, one per appearance the theme is designed for: at a preset’s native resolution, or at the size this Mac currently renders a display at (its backing pixels in the chosen scaled resolution, which may differ from the panel’s native resolution).'),
  },
  'wallpaper-apply': {
    title: msg('Setting the wallpaper'),
    detail: msg('You set it in System Settings › Wallpaper (Add Photo…), per display. Bogen does not change your desktop.'),
  },
  appearance: {
    title: msg('Light, Dark or Auto'),
    detail: msg('The bundle records the appearance the theme was designed for. You choose it in System Settings › Appearance.'),
  },
  accent: {
    title: msg('Accent and highlight colour'),
    detail: msg('macOS offers a fixed set of accent colours. The bundle names the nearest one to the theme’s accent, and its highlight colour for Highlight colour › Other.'),
  },
  'dynamic-wallpaper': {
    title: msg('Dynamic wallpaper'),
    detail: msg('A wallpaper that switches with Light and Dark by itself is a special HEIC file, which Bogen does not make. With Auto you get one PNG for each appearance.'),
  },
  'other-appearance': {
    title: msg('Other Appearance settings'),
    detail: msg('Newer macOS versions add options such as icon and widget style and folder colour to System Settings › Appearance. The bundle does not include them; set them as you like.'),
  },
  'system-chrome': {
    title: msg('Menu bar, Dock, Finder and windows'),
    detail: msg('They are illustrations in the previews. macOS draws them itself, and no theme reskins them.'),
  },
  'app-tokens': {
    title: msg('Your own apps’ appearance'),
    detail: msg('Semantic colours for light and dark, type and spacing, as CSS custom properties, JSON design tokens and an Xcode asset catalog of colour sets.'),
  },
  'app-build': {
    title: msg('Building an app'),
    detail: msg('Bogen designs the interface and exports its tokens. It does not compile, sign or ship an app.'),
  },
};

/** How sure a capability is, in front of its detail. */
export const MAC_STATUS_WORDS: Readonly<Record<MacCapability['status'], string>> = {
  supported: msg('Exported'),
  manual: msg('You set this'),
  'preview-only': msg('Preview only'),
  'not-offered': msg('Not offered'),
};

/**
 * `SYSTEM_ACCENTS`: the accent colours System Settings › Appearance offers, by the id the server sends. The person
 * picks one there, so these should read as macOS names them in the language.
 */
export const MAC_ACCENT_WORDS: Readonly<Record<string, string>> = {
  blue: msg('Blue'),
  purple: msg('Purple'),
  pink: msg('Pink'),
  red: msg('Red'),
  orange: msg('Orange'),
  yellow: msg('Yellow'),
  green: msg('Green'),
  graphite: msg('Graphite'),
};
