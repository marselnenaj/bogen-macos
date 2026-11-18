// The app's own settings: what the shell decides. The server keeps its own settings in its data folder (tailnet,
// phone, pairings), changed through the editor as on every other platform.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_PORT = 29990;

export interface WindowBounds { x: number; y: number; width: number; height: number; maximized?: boolean; fullScreen?: boolean }

export interface Settings {
  /** Loopback port of the backend. 29990 is what agents and the CLI expect; another one only after a clash. */
  port: number;
  /** Ask the update feed once a day. Only has an effect in a signed build with a feed. */
  updateChecks: boolean;
  /** Last window frame, restored on launch. */
  window?: WindowBounds;
  /** The person has seen, and answered, the offer to import from ~/.local/share/bogen. */
  legacyImportAnswered: boolean;
  /** The welcome screen has been seen once. */
  welcomed: boolean;
  /** Bogen's icon in the menu bar. On unless the person hid it; the Dock icon and Settings stay either way. */
  menuBarIcon: boolean;
}

export const DEFAULTS: Settings = { port: DEFAULT_PORT, updateChecks: true, legacyImportAnswered: false, welcomed: false, menuBarIcon: true };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function bounds(v: unknown): WindowBounds | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  if (![b.x, b.y, b.width, b.height].every(finite)) return undefined;
  const out: WindowBounds = { x: Math.round(b.x as number), y: Math.round(b.y as number), width: Math.round(b.width as number), height: Math.round(b.height as number) };
  if (out.width < 200 || out.height < 150 || out.width > 20000 || out.height > 20000) return undefined;
  if (b.maximized === true) out.maximized = true;
  if (b.fullScreen === true) out.fullScreen = true;
  return out;
}

export function validPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/** Whatever is on disk, made safe: unknown keys dropped, wrong types replaced by defaults. Never throws. */
export function parseSettings(text: string | null): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // A damaged file is replaced on the next save.
  }
  const window = bounds(raw.window);
  return {
    port: validPort(raw.port) ? raw.port : DEFAULTS.port,
    updateChecks: typeof raw.updateChecks === 'boolean' ? raw.updateChecks : DEFAULTS.updateChecks,
    legacyImportAnswered: raw.legacyImportAnswered === true,
    welcomed: raw.welcomed === true,
    menuBarIcon: typeof raw.menuBarIcon === 'boolean' ? raw.menuBarIcon : DEFAULTS.menuBarIcon,
    ...(window ? { window } : {}),
  };
}

export function loadSettings(path: string): Settings {
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // First launch.
  }
  return parseSettings(text);
}

/** Same folder, temp name, rename: a crash leaves the old file or the new one, never half of one. */
export function saveSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The launcher's environment file: only what it may read, one `KEY=value` per line. */
export function cliEnvText(port: number, appId: string): string {
  if (!validPort(port)) throw new Error(`Not a port: ${port}`);
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(appId)) throw new Error(`Not a bundle id: ${appId}`);
  return `BOGEN_PORT=${port}\nBOGEN_MACOS_APP_ID=${appId}\n`;
}
