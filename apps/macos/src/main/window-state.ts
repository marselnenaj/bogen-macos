// Restoring the window where it was, unless that place no longer exists (a display was unplugged).

import type { WindowBounds } from './settings.ts';

export interface Rect { x: number; y: number; width: number; height: number }

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MIN_SIZE = { width: 720, height: 480 };

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The saved frame when at least a quarter of it, and its title bar, lie on a current display; else a default frame
 * centred on the primary display's work area, no larger than it.
 */
export function restoreBounds(saved: WindowBounds | undefined, workAreas: Rect[], primary: Rect): Rect & { maximized?: boolean; fullScreen?: boolean } {
  if (saved) {
    const visible = workAreas.reduce((sum, area) => sum + overlap(saved, area), 0);
    const titleBar = { x: saved.x, y: saved.y, width: saved.width, height: 28 };
    const titleVisible = workAreas.some((area) => overlap(titleBar, area) >= Math.min(titleBar.width, 200) * 10);
    if (visible >= (saved.width * saved.height) / 4 && titleVisible) {
      return { x: saved.x, y: saved.y, width: Math.max(MIN_SIZE.width, saved.width), height: Math.max(MIN_SIZE.height, saved.height), ...(saved.maximized ? { maximized: true } : {}), ...(saved.fullScreen ? { fullScreen: true } : {}) };
    }
  }
  const width = Math.min(DEFAULT_SIZE.width, primary.width);
  const height = Math.min(DEFAULT_SIZE.height, primary.height);
  return { x: Math.round(primary.x + (primary.width - width) / 2), y: Math.round(primary.y + (primary.height - height) / 2), width, height };
}
