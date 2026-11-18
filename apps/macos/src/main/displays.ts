// This Mac's displays, for Mac theme wallpapers: what Electron's screen module says, as the server's
// POST /api/mac/displays takes it. Sent to the app's own server on backend ready and on the screen module's display
// events, one request at a time; never polled. Pure apart from the injected send.

/** The part of Electron's Display this reads (electron.d.ts, interface Display). */
export interface ScreenDisplay { label: string; size: { width: number; height: number }; scaleFactor: number; internal: boolean }

export interface DisplayReport { label: string; width: number; height: number; scale: number }

/**
 * Backing pixels (Display.size × scaleFactor) and the scale of each display. Under a scaled "Looks like" resolution this is
 * the size macOS renders the desktop at, not necessarily the panel's native resolution, and the server labels it so.
 * A fractional scale is left out: no Mac wallpaper is made for it.
 */
export function displayReport(displays: ScreenDisplay[]): DisplayReport[] {
  const out: DisplayReport[] = [];
  // The built-in display first, as System Settings lists it.
  for (const d of [...displays].sort((a, b) => Number(b.internal) - Number(a.internal)).slice(0, 6)) {
    if (!Number.isInteger(d.scaleFactor) || d.scaleFactor < 1 || d.scaleFactor > 3) continue;
    out.push({ label: (d.label || (d.internal ? 'Built-in display' : 'Display')).slice(0, 60), width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor), scale: d.scaleFactor });
  }
  return out;
}

/**
 * Sends the latest report, one request at a time: a change while one is in flight is sent once after it, never
 * queued up. Failures are dropped (the theme then offers presets); there is no retry timer.
 */
export class DisplayReporter {
  private inFlight = false;
  private dirty = false;
  sent = 0;

  constructor(private readonly deps: { read(): ScreenDisplay[]; ready(): boolean; send(report: DisplayReport[]): Promise<void> }) {}

  async report(): Promise<void> {
    if (!this.deps.ready()) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.dirty = false;
        this.sent++;
        await this.deps.send(displayReport(this.deps.read())).catch(() => {});
      } while (this.dirty && this.deps.ready());
    } finally {
      this.inFlight = false;
    }
  }
}
