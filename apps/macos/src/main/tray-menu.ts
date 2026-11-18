// The Bogen menu-bar extra (an Electron Tray, which is an NSStatusItem on macOS): what its menu says and does, and its
// life. Pure apart from the injected host, so tests drive it on any OS without Electron.
//
// - One status item for the app's whole life, held here (a strong reference: a Tray that is garbage-collected
//   disappears from the menu bar). Showing it twice keeps the one; window recreation, activation and a second
//   instance never touch it. destroy() removes it on quit.
// - The menu is built when the person clicks the icon, from the backend's actual state and one bounded look at
//   /api/status (one request at a time, with a timeout). There is no timer, no polling and no screenshot: closed, the
//   icon costs nothing but its tooltip, which follows backend state changes as they are reported.
// - It says only what is known: a server phase from the Backend state machine, and agents from the server's own
//   presence list. When the server is not running or did not answer in time, it says that instead of guessing.

export type TrayCommand = 'open' | 'new-design' | 'settings' | 'hide-icon' | 'quit';

export interface TrayItem {
  label?: string;
  command?: TrayCommand;
  enabled?: boolean;
  separator?: true;
}

/** What the menu needs from the Backend state machine (backend.ts). */
export interface TrayBackend {
  phase: 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping' | 'stopped';
  port: number;
}

export interface TrayAgent { name: string; fileName: string; working: boolean }

/** Agents: what /api/status said, or why there is nothing to say. */
export type TrayAgents = { kind: 'known'; agents: TrayAgent[] } | { kind: 'server-off' } | { kind: 'no-answer' };

export interface TrayView { backend: TrayBackend; agents: TrayAgents }

export const TRAY_TOOLTIP_PREFIX = 'Bogen';
/** The status item's identity, so macOS keeps the place the person dragged it to between launches. */
export const TRAY_GUID = 'b0a6e1a2-7c2e-4a8e-9a55-6d0f3c1b2e47';
/** How long a click waits for /api/status before the menu opens without agent details. */
export const STATUS_TIMEOUT_MS = 750;
const MAX_AGENT_LINES = 4;

// Control characters, bidi overrides and line breaks: a menu label is one plain line, whatever a file is called.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
function clean(text: string, max = 48): string {
  const one = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The agent list of a /api/status answer, checked: anything malformed is dropped, never shown. */
export function parseAgents(body: unknown): TrayAgent[] {
  const list = body && typeof body === 'object' ? (body as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(list)) return [];
  const out: TrayAgent[] = [];
  for (const a of list.slice(0, 64)) {
    if (!a || typeof a !== 'object') continue;
    const { name, fileName, status } = a as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || (status !== 'working' && status !== 'idle')) continue;
    out.push({ name: clean(name, 32), fileName: typeof fileName === 'string' ? clean(fileName) : '', working: status === 'working' });
  }
  return out;
}

export function backendLine(b: TrayBackend): string {
  switch (b.phase) {
    case 'ready': return `Server running on 127.0.0.1:${b.port}`;
    case 'starting': case 'idle': return 'Server starting…';
    case 'restarting': return 'Server restarting…';
    case 'failed': return 'Server stopped: open Bogen for details';
    case 'stopping': return 'Server stopping…';
    case 'stopped': return 'Server stopped';
  }
}

export function agentLines(a: TrayAgents): string[] {
  if (a.kind === 'server-off') return [];
  if (a.kind === 'no-answer') return ['Agent status unavailable right now'];
  const working = a.agents.filter((x) => x.working);
  if (!working.length) return ['No agent is working'];
  const lines = working.slice(0, MAX_AGENT_LINES).map((x) => (x.fileName ? `${x.name} is working on ${x.fileName}` : `${x.name} is working`));
  if (working.length > MAX_AGENT_LINES) lines.push(`and ${working.length - MAX_AGENT_LINES} more working`);
  return lines;
}

export function trayToolTip(b: TrayBackend): string {
  return `${TRAY_TOOLTIP_PREFIX}: ${backendLine(b)}`;
}

/** The menu, top to bottom. Status lines are disabled items: information, not actions. */
export function trayItems(view: TrayView): TrayItem[] {
  const ready = view.backend.phase === 'ready';
  return [
    { label: 'Open Bogen', command: 'open' },
    { label: 'New Design', command: 'new-design', enabled: ready },
    { separator: true },
    { label: backendLine(view.backend), enabled: false },
    ...agentLines(view.agents).map((label): TrayItem => ({ label, enabled: false })),
    { separator: true },
    { label: 'Settings…', command: 'settings' },
    { label: 'Hide Menu Bar Icon', command: 'hide-icon' },
    { separator: true },
    { label: 'Quit Bogen', command: 'quit' },
  ];
}

// ---------------------------------------------------------------- the status item's life

/** The part of an Electron Tray this uses. */
export interface TrayHandle {
  setToolTip(text: string): void;
  /** Opens a menu built from `items` under the icon. */
  popUp(items: TrayItem[]): void;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface TrayHost {
  /** Makes the status item: template image, GUID, tooltip, and `onClick` for a click or a right-click. */
  create(onClick: () => void): TrayHandle;
  backend(): TrayBackend;
  /** GET /api/status of the app's own server, with this abort signal. Only called while the backend is ready. */
  status(signal: AbortSignal): Promise<unknown>;
  timeout(ms: number): AbortSignal;
}

export class MenuBarIcon {
  private tray: TrayHandle | null = null;
  private looking: Promise<TrayAgents> | null = null;
  /** Clicks handled, for tests and app.log: never more than one status request is in flight for them. */
  requests = 0;

  constructor(private readonly host: TrayHost) {}

  get visible(): boolean {
    return Boolean(this.tray && !this.tray.isDestroyed());
  }

  /** Shows or removes the icon. Showing it again keeps the one there is. */
  setVisible(on: boolean): void {
    if (!on) {
      this.destroy();
      return;
    }
    if (this.visible) return;
    this.tray = this.host.create(() => void this.open());
    this.update();
  }

  /** The tooltip follows the backend: called on every backend state change. */
  update(): void {
    if (this.visible) this.tray!.setToolTip(trayToolTip(this.host.backend()));
  }

  /** What the agents are doing, asked once per click; a second click while it is asking shares the answer. */
  agents(): Promise<TrayAgents> {
    if (this.host.backend().phase !== 'ready') return Promise.resolve({ kind: 'server-off' });
    if (this.looking) return this.looking;
    this.requests++;
    this.looking = this.host.status(this.host.timeout(STATUS_TIMEOUT_MS))
      .then((body): TrayAgents => ({ kind: 'known', agents: parseAgents(body) }))
      .catch((): TrayAgents => ({ kind: 'no-answer' }))
      .finally(() => {
        this.looking = null;
      });
    return this.looking;
  }

  async open(): Promise<void> {
    if (!this.visible) return;
    const agents = await this.agents();
    // The icon may have been hidden, or the app quit, while the status came back.
    if (!this.visible) return;
    this.update();
    this.tray!.popUp(trayItems({ backend: this.host.backend(), agents }));
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
