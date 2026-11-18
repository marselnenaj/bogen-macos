// What the windows may load, open and ask for. Pure decisions; main.ts wires them to Electron's events.
//
// The editor window shows design HTML, SVG and imported pages as real DOM, so its content is treated as untrusted:
// it may only navigate within the backend's exact origin, gets no Node, no native bridge beyond static facts, and
// every permission it does not need is denied. App-owned pages (welcome, error, settings, licenses) come from
// bogen-shell://app inside app.asar and are the only senders the IPC handlers accept.

export const SHELL_SCHEME = 'bogen-shell';
export const SHELL_ORIGIN = `${SHELL_SCHEME}://app`;

export function editorOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isEditorUrl(url: string, port: number): boolean {
  const u = parse(url);
  return Boolean(u && u.origin === editorOrigin(port));
}

export function isShellUrl(url: string): boolean {
  const u = parse(url);
  // A custom standard scheme parses with host `app`; anything else (bogen-shell://evil) is not ours.
  return Boolean(u && u.protocol === `${SHELL_SCHEME}:` && u.host === 'app');
}

/** Opened in the person's browser: web pages and mail only. No file:, no custom schemes, no credentials in the URL. */
export function externalUrl(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  if (u.protocol === 'mailto:') return u.href;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

export type Navigation = { action: 'allow' } | { action: 'external'; url: string } | { action: 'deny' };

/** A navigation of the editor's main frame (link click, location change, form post). */
export function decideNavigation(url: string, port: number): Navigation {
  if (isEditorUrl(url, port)) return { action: 'allow' };
  const ext = externalUrl(url);
  return ext ? { action: 'external', url: ext } : { action: 'deny' };
}

/**
 * `window.open` and target=_blank. Same-origin pages (a prototype preview, a review page) open in another Bogen window
 * with the same locked-down preferences; web pages go to the browser; everything else is refused.
 */
export function decideWindowOpen(url: string, port: number): { action: 'child' } | { action: 'external'; url: string } | { action: 'deny' } {
  if (isEditorUrl(url, port)) return { action: 'child' };
  const ext = externalUrl(url);
  return ext ? { action: 'external', url: ext } : { action: 'deny' };
}

/** Permissions the editor uses: clipboard for copy and paste of layers and images, fullscreen for presenting, notifications for runs. */
const EDITOR_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications']);

/**
 * Whether the page at `requestingUrl` may have `permission`. `media` is the microphone of the editor's chat and comment
 * boxes (speaking instead of typing): audio only, never the camera, so it is granted only when every media type asked
 * for is `audio` (`mediaTypes` from Electron's request details, or the check's one `mediaType`). macOS then asks the
 * person once, under the app's NSMicrophoneUsageDescription; the recording goes only to Bogen's own local server.
 */
export function decidePermission(permission: string, requestingUrl: string, port: number, mediaTypes: readonly string[] = []): boolean {
  if (!isEditorUrl(requestingUrl, port)) return false;
  if (permission === 'media') return mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio');
  return EDITOR_PERMISSIONS.has(permission);
}

/** Electron's `web-contents-created` lets any page try to attach a <webview>; Bogen never uses one. */
export const ALLOW_WEBVIEW = false;

/** Strict CSP for app-owned pages. They have no inline script and talk to main only through the preload. */
export const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
