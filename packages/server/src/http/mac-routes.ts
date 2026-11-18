import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { MAC_CAPABILITIES, MAC_DISPLAY_PRESETS, MAC_SCOPES } from '../mac-theme.ts';
import { currentBranchId, MAIN_BRANCH } from '@bogen/core';
import { createMacThemeFile, exportMacTheme, isMacThemeChoice, macDisplays, macHost, macThemeInfo, macThemeZip, requireMacTheme, updateMacThemeMeta, type MacHost } from '../mac-themes.ts';
import { HttpError } from '../util.ts';
import type { RouteTools } from './agent-routes.ts';
import type { BogenServer } from './server.ts';

const Id = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);
const Name = z.string().trim().min(1).max(64);
const Scope = z.enum(['desktop', 'app']);
const Appearance = z.enum(['light', 'dark', 'auto']);
const DisplayId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Create = z.object({
  name: Name.optional(), scopes: z.array(Scope).min(1).max(2).optional(), appearance: Appearance.optional(), displays: z.array(DisplayId).min(1).max(6).optional(),
  /** Continue this Mac theme file; nothing is made. */
  file_id: Id.optional(),
  /** A separate new Mac theme on purpose (Home's New buttons), even when one with this name and scopes exists. */
  new_project: z.boolean().optional(),
  /** Deprecated: the same as new_project. */
  copy: z.boolean().optional(),
}).strict();
const Patch = z.object({ name: Name.optional(), appearance: Appearance.optional() }).strict();
const Export = z.object({ to: z.literal('zip') }).strict();
const ReportedDisplay = z.object({ label: z.string().max(120), width: z.number().int(), height: z.number().int(), scale: z.number() }).strict();
const Displays = z.object({ displays: z.array(ReportedDisplay).max(16) }).strict();

const hosts = new WeakMap<BogenServer, MacHost>();
/** Tests only: what the server takes itself for. Not reachable over HTTP. */
export function setMacHostForTests(app: BogenServer, host: MacHost): void {
  hosts.set(app, host);
}
const hostOf = (app: BogenServer): MacHost => hosts.get(app) ?? macHost();

/**
 * `/api/mac/*`: Mac theme files and their export, and the displays Bogen for macOS reports. For a person at this
 * machine only (the prefix is on `isLocalOnlyPath`, and every route checks again). Nothing here changes the system.
 */
export async function macThemeRoutes(app: BogenServer, req: IncomingMessage, res: ServerResponse, parts: string[], tools: RouteTools): Promise<boolean> {
  const [, b, c, d] = parts;
  const method = req.method ?? 'GET';
  const { json, send, local } = tools;
  if (!local(req)) throw new HttpError(403, 'Mac themes are only for a person at this machine.');
  const host = hostOf(app);

  if (b === 'themes' && !c && method === 'GET') {
    send(res, 200, { host, scopes: MAC_SCOPES, displays: macDisplays(app).all(), presets: MAC_DISPLAY_PRESETS, capabilities: MAC_CAPABILITIES });
    return true;
  }
  if (b === 'themes' && !c && method === 'POST') {
    const { file_id, new_project, copy, ...body } = await json(req, Create);
    // A Mac theme that has a project goes back to it; new_project (or copy) makes a separate one on purpose.
    const out = await createMacThemeFile(app, { ...body, ...(file_id ? { fileId: file_id } : {}), newProject: new_project === true || copy === true, origin: 'bogen:mac-theme' });
    // Several files could be the one meant: nothing was made, and the person picks.
    if (isMacThemeChoice(out)) send(res, 409, { needs_choice: true, choose: out.candidates, message: out.message, next: out.next });
    else send(res, out.reused ? 200 : 201, out);
    return true;
  }
  if (b === 'displays' && !c && method === 'POST') {
    // Only Bogen for macOS has a Mac's displays to report; a server on Linux has none, whoever asks.
    if (host !== 'macos') throw new HttpError(409, 'This server does not run on a Mac, so it has no Mac displays. Use the display presets.');
    const body = await json(req, Displays);
    send(res, 200, { displays: macDisplays(app).set(body.displays) });
    return true;
  }
  if (b === 'theme' && c) {
    const fileId = Id.parse(c);
    app.requireFile(fileId);
    const room = await app.rooms.get(fileId);
    if (!d && method === 'GET') {
      // Not a Mac theme: say so, and say when it is an Omarchy theme, rather than an error.
      const omarchy = Boolean(room.doc.meta.get('omarchyTheme'));
      try {
        send(res, 200, { theme: macThemeInfo(room.doc, host) });
      } catch {
        send(res, 200, { theme: null, ...(omarchy ? { other: 'omarchy-theme' } : {}) });
      }
      return true;
    }
    if (!d && method === 'PATCH') {
      const body = await json(req, Patch);
      const before = requireMacTheme(room.doc).name;
      const next = updateMacThemeMeta(room.doc, body, 'person:editor');
      // On a branch the name is that version's: the file, and the project's identity in the index, stay main's.
      const onMain = currentBranchId(room.doc) === MAIN_BRANCH;
      if (onMain && next.name !== before && app.storage.get(fileId)?.name === `${before} · Mac theme`) app.renameFile(fileId, `${next.name} · Mac theme`);
      send(res, 200, { theme: macThemeInfo(room.doc, host) });
      return true;
    }
    if (d === 'export' && method === 'POST') {
      await json(req, Export);
      const out = await exportMacTheme(app, fileId);
      const bytes = macThemeZip(out);
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${out.slug}-mac-theme.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        // The problems travel in a header, so the editor can say what was left out of the download.
        'X-Bogen-Problems': encodeURIComponent(JSON.stringify(out.problems.slice(0, 20))),
      });
      res.end(bytes);
      return true;
    }
  }
  return false;
}
