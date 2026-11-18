import { stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { currentBranchId } from '@bogen/core';
import { MAC_CAPABILITIES, MAC_DISPLAY_PRESETS } from '../mac-theme.ts';
import { createMacThemeFile, exportMacTheme, isMacThemeChoice, macDisplays, macHost, macThemeInfo, macThemeZip, requireMacTheme } from '../mac-themes.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';
import { themeCreateGuard, type ThemeKind } from './tools-files.ts';

/** Mac themes: a desktop appearance and an appearance for the person's own apps, designed and exported. Nothing is applied. */

const MAC_THEME_KIND: ThemeKind = {
  tool: 'mac_theme_create',
  label: 'a Mac theme',
  is: (ctx, fileId) => Boolean(ctx.app.rooms.peek(fileId)?.doc.meta.get('macTheme') ?? ctx.app.storage.get(fileId)?.macTheme),
};

const HONEST = 'Nothing is applied to the Mac: the person sets the wallpaper in System Settings › Wallpaper and Light, Dark or Auto and the accent in System Settings › Appearance. The menu bar, Dock, Finder and window controls on the previews are illustrations; never tell the person a theme changes them, and never claim an app was built.';

export function registerMacTools(define: ToolDefiner): void {
  define('mac_theme_create', { description: `Open or make the file that designs a Mac theme, the default theme target on a Mac. One Mac theme is one project file: asking for one that has a project (by file_id, or by its name, with the same scopes) opens that file (reused: true) and makes nothing; a name is never permission to copy. Without a name, existing Mac themes of those scopes are a choice. Alternatives and redos are branches inside its file (design_branch_create), never new files: in a run asked to change or redo existing work, in a revision or on a branch it makes no new file under any name, and a session already working on a Mac theme makes another only with new_project: true. When several files could be the one meant, nothing is made: the answer is needs_choice with candidates; ask the person, then call again with the chosen file_id, or with new_project: true only when they want a separate new Mac theme. Only the person merges or discards branches, in the editor. Two scopes, kept apart: desktop (wallpapers for each Mac display, light and/or dark: a preset at its native resolution, this Mac's displays at the backing pixels macOS renders them at now, which a scaled resolution changes; a palette, and an illustrative desktop preview) and app (an appearance kit for the person's own apps: AppKit-style semantic colours with light values and a dark mode, the system font, type sizes, spacing and radii). Tokens are named mac-* (--mac-wallpaper-sky, --mac-accent, --mac-app-label, --mac-app-window-background…), never --omarchy-*; dark values are the file's dark mode (tokens_set with modes). Wallpaper boards are "Wallpaper · <display> · <light|dark>", all instances of the component "Mac wallpaper": design it once. Displays: this Mac's (when Bogen for macOS reported them) or presets: ${MAC_DISPLAY_PRESETS.map((p) => p.id).join(', ')}. ${HONEST} For an Omarchy Linux theme use omarchy_theme_create instead, only when the person asks for Omarchy.` }, {
    name: z.string().trim().min(1).max(64).optional().describe('The theme\'s name, such as Dusk Glass.'),
    scopes: z.array(z.enum(['desktop', 'app'])).min(1).max(2).default(['desktop', 'app']).describe('desktop, app, or both (default). Say which when the person asked for one.'),
    appearance: z.enum(['light', 'dark', 'auto']).default('auto').describe('What the desktop is designed for. auto designs a light and a dark wallpaper.'),
    displays: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).min(1).max(6).optional().describe('Display preset ids or this Mac\'s display ids from mac_theme_info. Default: this Mac\'s displays, else macbook-pro-14.'),
    file_id: z.string().optional().describe('Continue this Mac theme file: it is opened, checked to be a Mac theme, and nothing is made.'),
    new_project: z.boolean().default(false).describe('Make a separate new Mac theme file even when one with this name and scopes exists. Only when the person asks for a separate new theme, never to edit, revise or try an alternative (that is design_branch_create).'),
    copy: z.boolean().default(false).describe('Deprecated: the same as new_project.'),
  }, async ({ name, scopes, appearance, displays, file_id, new_project, copy }, ctx) => {
    const out = await createMacThemeFile(ctx.app, { ...(name ? { name } : {}), scopes, appearance, ...(displays ? { displays } : {}), ...(file_id ? { fileId: file_id } : {}), newProject: new_project || copy, beforeCreate: themeCreateGuard(ctx, MAC_THEME_KIND, new_project || copy), origin: `agent:${ctx.agent}` });
    if (isMacThemeChoice(out)) return { ...out, note: HONEST };
    // The session works in this file from now on, reused or new: a following call without file_id goes here.
    const room = await ctx.room(out.file_id);
    if (out.reused) {
      // Opening it is like file_open: this session continues on the branch that is checked out now.
      ctx.pinBranch(room, currentBranchId(room.doc));
      ctx.page(room, out.page_id || undefined);
      return { ...out, note: HONEST };
    }
    ctx.page(room, out.page_id);
    ctx.wrote = true;
    ctx.touch(out.boards.map((b) => b.id));
    return {
      ...out,
      next: 'Look at the boards with canvas_screenshot. Change colours with tokens_set on the mac-* tokens (with modes.dark for the dark appearance); every board follows. Compose the wallpaper on the first "Wallpaper · …" board, inside the "Mac wallpaper" component, in percentages so it fits every display. Then mac_theme_export. Follow-up changes stay in this file: do not make a new one. Alternatives later are design_branch_create branches in this file, not new files.',
      note: HONEST,
    };
  });

  define('mac_theme_info', { description: 'What a Mac theme file is and what it can really do: its scopes, appearance, displays, the System Settings accent nearest to its accent, the files an export holds, and capabilities, each supported, manual, preview-only or not-offered. Without file_id: this Mac\'s displays and the presets, and whether this server runs on a Mac. Read this before telling the person what a Mac theme changes.', readOnly: true }, {
    file_id: fileIdArg.optional(),
  }, async ({ file_id }, ctx) => {
    const host = macHost();
    if (!file_id) return { host, displays: macDisplays(ctx.app).all(), presets: MAC_DISPLAY_PRESETS, capabilities: MAC_CAPABILITIES };
    const room = await ctx.room(file_id);
    return macThemeInfo(room.doc, host);
  });

  define('mac_theme_export', { description: `Export a Mac theme file as a zip in the Bogen export folder and return its path: bogen-mac-theme.json (versioned manifest), README.md, wallpapers/<display>-<appearance>.png at each display's pixel size (the manifest says native or backing), and for the app scope app/tokens.css, app/tokens.json and app/Colors.xcassets (colour sets with Any and Dark). Data only: nothing in it runs. ${HONEST}` }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    requireMacTheme(room.doc);
    const out = await exportMacTheme(ctx.app, room.id);
    const dir = ctx.app.exportDir ?? process.env.BOGEN_EXPORT_DIR ?? join(homedir(), 'Downloads', 'Bogen');
    await mkdir(dir, { recursive: true });
    let path = join(dir, `${out.slug}-mac-theme.zip`);
    for (let n = 2; await stat(path).then(() => true, () => false); n++) path = join(dir, `${out.slug}-mac-theme-${n}.zip`);
    // wx: a file that appeared meanwhile is not replaced.
    await writeFile(path, macThemeZip(out), { flag: 'wx', mode: 0o644 });
    return { path, files: out.files.map((f) => f.path), problems: out.problems, manual: out.manifest.manual, preview_only: out.manifest.previewOnly };
  });
}
