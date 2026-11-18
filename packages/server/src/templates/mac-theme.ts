// The boards of a new Mac theme file. Every colour is a `mac-*` token, so a change with tokens_set reaches every
// board, the wallpapers and the export. Dark boards are the same layers in the file's `dark` mode.
//
// Desktop scope: the palette, one wallpaper board per display and appearance at the display's size in points (the
// export renders it at the display's scale, so the PNG has the display's pixels: native for a preset, current backing
// pixels for this Mac's displays), and an illustrative desktop
// preview that says, on the board itself, that the menu bar, Dock and window are not something a theme changes.
// App scope: a sample window of the person's own app in light and dark, drawn from the semantic tokens.

import { appearancesOf, pointsOf, type MacAppearance, type MacDisplay, type MacScope, type MacToken } from '../mac-theme.ts';

export interface MacBoard { name: string; x: number; y: number; width: number; height: number; background: string; html: string; components: string[]; mode?: 'dark' }

export const MAC_BOARD_NAMES = {
  palette: 'Palette',
  wallpaper: 'Wallpaper',
  preview: 'Desktop preview',
  app: 'App appearance',
} as const;
export const WALLPAPER_COMPONENT = 'Mac wallpaper';
export const PREVIEW_NOTE = 'Illustration only. macOS draws its own menu bar, Dock, Finder and windows; a theme does not change them. You set the wallpaper in System Settings › Wallpaper and Light, Dark or Auto in System Settings › Appearance.';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const v = (name: string) => `var(--${name})`;

/** "Wallpaper · MacBook Pro 14″ · dark". */
export const wallpaperBoardName = (d: MacDisplay, appearance: 'light' | 'dark') => `${MAC_BOARD_NAMES.wallpaper} · ${d.label} · ${appearance}`;

function wallpaperArt(): string {
  // A calm starting point from the palette, laid out in percentages so it fits every display's shape.
  return `<div data-name="${WALLPAPER_COMPONENT}" style="position:relative;display:flex;width:100%;height:100%;flex:1 1 auto;overflow:hidden;background:linear-gradient(180deg, ${v('mac-wallpaper-sky')} 0%, ${v('mac-wallpaper-horizon')} 100%)">`
    + `<div data-name="Glow" style="position:absolute;left:52%;top:30%;width:46%;height:70%;border-radius:50%;background:radial-gradient(circle, ${v('mac-wallpaper-glow')} 0%, transparent 68%);opacity:0.85"></div>`
    + `<div data-name="Far hill" style="position:absolute;left:-20%;right:20%;bottom:-38%;height:70%;border-radius:50%;background:${v('mac-wallpaper-ink')};opacity:0.55"></div>`
    + `<div data-name="Near hill" style="position:absolute;left:30%;right:-30%;bottom:-48%;height:72%;border-radius:50%;background:${v('mac-wallpaper-ink')}"></div>`
    + '</div>';
}

function paletteHtml(tokens: readonly MacToken[]): string {
  const group = (title: string, list: readonly MacToken[]) => list.length ? `<div data-name="${esc(title)}" style="display:flex;flex-direction:column;gap:12px">`
    + `<div style="font:600 15px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;color:#1d1d1f">${esc(title)}</div>`
    + `<div style="display:flex;flex-wrap:wrap;gap:12px">${list.map((t) => `<div data-name="${esc(t.label)}" style="display:flex;flex-direction:column;gap:6px;width:150px">`
      + `<div style="display:flex;height:56px;border-radius:10px;overflow:hidden;border:1px solid #0000001a"><div style="flex:1;background:${v(t.name)}"></div><div data-mode-sample="dark" style="flex:1;background:${v(t.name)}"></div></div>`
      + `<div style="font:500 12px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;color:#1d1d1f">${esc(t.label)}</div>`
      + `<div style="font:11px/1.3 ui-monospace, Menlo, monospace;color:#6e6e73">--${esc(t.name)}${t.macos ? ` · ${esc(t.macos)}` : ''}</div></div>`).join('')}</div></div>` : '';
  const colors = tokens.filter((t) => t.kind === 'color');
  return `<div data-name="Palette" style="display:flex;flex-direction:column;gap:28px;padding:40px">`
    + `<div style="font:700 26px/1.2 -apple-system, BlinkMacSystemFont, sans-serif;color:#1d1d1f">Palette</div>`
    + group('Desktop', colors.filter((t) => t.scope === 'desktop'))
    + group('Your app', colors.filter((t) => t.scope === 'app'))
    + '</div>';
}

function previewHtml(scopes: readonly MacScope[]): string {
  const app = scopes.includes('app');
  const window = app
    ? { bg: v('mac-app-window-background'), content: v('mac-app-content-background'), label: v('mac-app-label'), muted: v('mac-app-secondary-label'), line: v('mac-app-separator'), accent: v('mac-app-accent'), onAccent: v('mac-app-on-accent'), font: v('mac-app-font') }
    : { bg: '#f5f5f7', content: '#ffffff', label: '#1d1d1f', muted: '#6e6e73', line: '#d2d2d7', accent: v('mac-accent'), onAccent: '#ffffff', font: '-apple-system, BlinkMacSystemFont, sans-serif' };
  return `<x-instance component="${WALLPAPER_COMPONENT}" style="position:absolute;inset:0;width:100%;height:100%"></x-instance>`
    + `<div data-name="Menu bar (illustration)" style="position:absolute;top:0;left:0;right:0;height:24px;display:flex;align-items:center;gap:18px;padding:0 14px;background:#ffffff40;font:500 13px/1 -apple-system, BlinkMacSystemFont, sans-serif;color:#1d1d1f"><span style="font-weight:700">Finder</span><span>File</span><span>Edit</span><span>View</span><span>Go</span><span>Window</span><span>Help</span></div>`
    + `<div data-name="Window (illustration)" style="position:absolute;left:22%;top:16%;width:56%;height:56%;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;background:${window.bg};box-shadow:0 22px 70px #00000059;font-family:${window.font}">`
    + `<div data-name="Title bar" style="display:flex;align-items:center;gap:8px;height:38px;padding:0 14px;border-bottom:1px solid ${window.line}"><span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span><span style="margin-left:12px;font-weight:600;font-size:13px;color:${window.label}">Your app</span></div>`
    + `<div data-name="Content" style="flex:1;display:flex;flex-direction:column;gap:10px;padding:20px;background:${window.content}"><div style="font-size:20px;font-weight:700;color:${window.label}">Good morning</div><div style="font-size:13px;color:${window.muted}">Text and controls in the theme's colours.</div><div style="display:flex;align-self:flex-start;padding:5px 14px;border-radius:6px;background:${window.accent};color:${window.onAccent};font-size:13px">Continue</div></div></div>`
    + `<div data-name="Dock (illustration)" style="position:absolute;left:34%;right:34%;bottom:8px;height:62px;display:flex;align-items:center;justify-content:center;gap:10px;border-radius:18px;background:#ffffff38;border:1px solid #ffffff4d">${['#4f8ef7', '#f2b33d', '#6bd06b', '#e8655a', '#9b7bf0'].map((c) => `<span style="width:46px;height:46px;border-radius:11px;background:${c}"></span>`).join('')}</div>`
    + `<div data-name="Note" style="position:absolute;left:24px;bottom:84px;max-width:420px;padding:10px 12px;border-radius:8px;background:#000000b3;color:#ffffff;font:12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif">${esc(PREVIEW_NOTE)}</div>`;
}

function appHtml(): string {
  const row = (title: string, sub: string, selected = false) => `<div data-name="Row" style="display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-radius:${v('mac-app-radius-control')};${selected ? `background:${v('mac-app-selection')};` : ''}"><span style="font-size:${v('mac-app-text-body')};color:${v('mac-app-label')}">${title}</span><span style="font-size:${v('mac-app-text-caption')};color:${v('mac-app-secondary-label')}">${sub}</span></div>`;
  return `<div data-name="Window" style="display:flex;flex:1;margin:${v('mac-app-space-l')};border-radius:${v('mac-app-radius-window')};overflow:hidden;background:${v('mac-app-window-background')};font-family:${v('mac-app-font')};box-shadow:0 16px 48px #00000040">`
    + `<div data-name="Sidebar" style="display:flex;flex-direction:column;gap:4px;width:220px;padding:${v('mac-app-space-m')};background:${v('mac-app-sidebar-background')};border-right:1px solid ${v('mac-app-separator')}">`
    + `<div style="display:flex;gap:8px;padding:4px 4px 14px"><span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span><span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span><span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span></div>`
    + `<span style="font-size:${v('mac-app-text-caption')};font-weight:600;color:${v('mac-app-tertiary-label')};padding:0 12px">Library</span>${row('Inbox', '12 new', true)}${row('Drafts', '3 items')}${row('Archive', 'Last week')}</div>`
    + `<div data-name="Content" style="display:flex;flex-direction:column;flex:1;gap:${v('mac-app-space-m')};padding:${v('mac-app-space-l')};background:${v('mac-app-content-background')}">`
    + `<span data-name="Title" style="font-size:${v('mac-app-text-title')};font-weight:700;color:${v('mac-app-label')}">Inbox</span>`
    + `<span data-name="Headline" style="font-size:${v('mac-app-text-headline')};font-weight:600;color:${v('mac-app-label')}">Design review at three</span>`
    + `<span data-name="Body" style="font-size:${v('mac-app-text-body')};line-height:1.45;color:${v('mac-app-secondary-label')}">Semantic colours, type and spacing for your own app, in light and dark. Change a token and both appearances follow.</span>`
    + `<div style="height:1px;background:${v('mac-app-separator')}"></div>`
    + `<div data-name="Actions" style="display:flex;gap:${v('mac-app-space-s')}"><span data-name="Primary button" style="padding:5px 14px;border-radius:${v('mac-app-radius-control')};background:${v('mac-app-accent')};color:${v('mac-app-on-accent')};font-size:${v('mac-app-text-body')}">Reply</span><span data-name="Destructive" style="padding:5px 14px;font-size:${v('mac-app-text-body')};color:${v('mac-app-destructive')}">Delete</span><span data-name="Success" style="padding:5px 14px;font-size:${v('mac-app-text-body')};color:${v('mac-app-success')}">Done</span></div>`
    + '</div></div>';
}

/** The boards of a new file, in the order they must be written (the wallpaper component before its instances). */
export function macThemeBoards(input: { scopes: readonly MacScope[]; appearance: MacAppearance; displays: readonly MacDisplay[]; tokens: readonly MacToken[] }): MacBoard[] {
  const boards: MacBoard[] = [];
  const gap = 120;
  boards.push({ name: MAC_BOARD_NAMES.palette, x: 0, y: 0, width: 1100, height: input.scopes.includes('app') ? 620 : 300, background: '#ffffff', html: paletteHtml(input.tokens), components: [] });
  let y = boards[0]!.height + gap;
  if (input.scopes.includes('desktop')) {
    let first = true;
    for (const appearance of appearancesOf(input.appearance)) {
      let x = 0;
      let rowHeight = 0;
      for (const d of input.displays) {
        const p = pointsOf(d);
        boards.push({
          name: wallpaperBoardName(d, appearance), x, y, width: p.width, height: p.height, background: v('mac-wallpaper-sky'),
          html: first ? wallpaperArt() : `<x-instance component="${WALLPAPER_COMPONENT}" style="width:100%;height:100%;flex:1 1 auto"></x-instance>`,
          components: first ? [WALLPAPER_COMPONENT] : [], ...(appearance === 'dark' ? { mode: 'dark' as const } : {}),
        });
        first = false;
        x += p.width + gap;
        rowHeight = Math.max(rowHeight, p.height);
      }
      y += rowHeight + gap;
    }
    let x = 0;
    for (const appearance of appearancesOf(input.appearance)) {
      boards.push({ name: `${MAC_BOARD_NAMES.preview} · ${appearance}`, x, y, width: 1512, height: 982, background: v('mac-wallpaper-sky'), html: previewHtml(input.scopes), components: [], ...(appearance === 'dark' ? { mode: 'dark' as const } : {}) });
      x += 1512 + gap;
    }
    y += 982 + gap;
  }
  if (input.scopes.includes('app')) {
    let x = 0;
    for (const appearance of ['light', 'dark'] as const) {
      boards.push({ name: `${MAC_BOARD_NAMES.app} · ${appearance}`, x, y, width: 1000, height: 640, background: appearance === 'dark' ? '#141416' : '#f5f5f7', html: appHtml(), components: [], ...(appearance === 'dark' ? { mode: 'dark' as const } : {}) });
      x += 1000 + gap;
    }
  }
  return boards;
}
