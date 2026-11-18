// Bogen's mark as a macOS menu-bar template image, drawn in code: no binary asset to keep in step with the mark, and
// nothing taken from another product's logo.
//
// A template image is black plus alpha only. AppKit tints it for the menu bar itself (dark on a light bar, light on a
// dark one, highlighted while the menu is open), which is what `nativeImage.setTemplateImage(true)` asks for (Electron
// 45 typings: NativeImage.setTemplateImage, "Marks the image as a macOS template image"). The status item is 18 pt
// square, the usual size of a menu-bar extra's glyph; the 1x and 2x representations are 18 and 36 px, so a Retina menu
// bar gets real pixels rather than a scaled-up 1x bitmap.
//
// The mark, from apps/editor/public/icons/icon.svg (viewBox 0 0 102 100): a page with a folded corner, a chevron and
// an underscore (a prompt). In one colour the page is filled and the chevron, the underscore and the fold line are
// cut out of it, so it reads as Bogen's mark at 18 pt.
//
// Pure: tests decode the PNGs on any OS.

import { deflateSync } from 'node:zlib';

/** Point size of the status item's image. */
export const TRAY_POINTS = 18;
/** The representations Electron gets: scale factor and pixel size. */
export const TRAY_SCALES = [1, 2] as const;

type Pt = readonly [number, number];

const PAGE: readonly Pt[] = [[10, 4], [66, 4], [92, 30], [92, 96], [10, 96]];
const FOLD: readonly Pt[] = [[66, 4], [66, 30], [92, 30]];
const CHEVRON: readonly Pt[] = [[26, 48], [48, 64], [26, 80]];
const CHEVRON_WIDTH = 10.5;
const UNDERSCORE = { x: 55, y: 73, w: 25, h: 10.5 };
/** The cut along the fold, in mark units: about 1 px at 1x. */
const FOLD_GAP = 6;
/** The mark's box inside the 18 pt square: 1 pt clear at the top and bottom. */
const MARK = { x0: 10, y0: 4, w: 82, h: 92 };

function insideConvex(poly: readonly Pt[], x: number, y: number): boolean {
  // Clockwise in screen space (y down): every edge has the point on its right, or on it.
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
}

function distToSegment(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function nearPolyline(line: readonly Pt[], x: number, y: number, half: number): boolean {
  for (let i = 0; i + 1 < line.length; i++) if (distToSegment(x, y, line[i]!, line[i + 1]!) <= half) return true;
  return false;
}

/** Whether a point of the mark (in its own units) is ink. */
export function markInk(x: number, y: number): boolean {
  if (!insideConvex(PAGE, x, y)) return false;
  if (nearPolyline(CHEVRON, x, y, CHEVRON_WIDTH / 2)) return false;
  if (x >= UNDERSCORE.x && x <= UNDERSCORE.x + UNDERSCORE.w && y >= UNDERSCORE.y && y <= UNDERSCORE.y + UNDERSCORE.h) return false;
  // The fold: a gap along its two inner edges, the dog-ear itself stays ink.
  if (nearPolyline([FOLD[0]!, FOLD[1]!, FOLD[2]!], x, y, FOLD_GAP / 2)) return false;
  return true;
}

/** Alpha coverage of the square icon at `px` pixels, 4 x 4 samples per pixel. Row-major, 0..255. */
export function trayAlpha(px: number): Uint8Array {
  const out = new Uint8Array(px * px);
  // The mark is fitted to the height with 1 pt clear above and below, and centred across.
  const unit = (px * (TRAY_POINTS - 2) / TRAY_POINTS) / MARK.h;
  const left = (px - MARK.w * unit) / 2;
  const top = (px - MARK.h * unit) / 2;
  const n = 4;
  for (let row = 0; row < px; row++) {
    for (let col = 0; col < px; col++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = MARK.x0 + (col + (sx + 0.5) / n - left) / unit;
          const y = MARK.y0 + (row + (sy + 0.5) / n - top) / unit;
          if (markInk(x, y)) hits++;
        }
      }
      out[row * px + col] = Math.round((hits / (n * n)) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, sum]);
}

/** A black RGBA PNG whose alpha is `alpha`: the shape of a template image. */
export function templatePng(px: number, alpha: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(px * (1 + px * 4));
  for (let row = 0; row < px; row++) {
    const at = row * (1 + px * 4);
    raw[at] = 0; // filter: none
    for (let col = 0; col < px; col++) raw[at + 1 + col * 4 + 3] = alpha[row * px + col]!;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

/** The status item's representations, ready for `nativeImage.addRepresentation`. */
export function trayIconRepresentations(): { scaleFactor: number; width: number; height: number; png: Buffer }[] {
  return TRAY_SCALES.map((scale) => {
    const px = TRAY_POINTS * scale;
    return { scaleFactor: scale, width: TRAY_POINTS, height: TRAY_POINTS, png: templatePng(px, trayAlpha(px)) };
  });
}
