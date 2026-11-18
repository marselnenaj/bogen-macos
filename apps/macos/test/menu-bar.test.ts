import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { IpcRefused, parseIpc } from '../src/main/ipc.ts';
import { DEFAULTS, parseSettings } from '../src/main/settings.ts';
import { markInk, TRAY_POINTS, trayAlpha, trayIconRepresentations } from '../src/main/tray-icon.ts';
import {
  agentLines, backendLine, MenuBarIcon, parseAgents, STATUS_TIMEOUT_MS, trayItems, trayToolTip, type TrayBackend, type TrayHandle, type TrayHost, type TrayItem,
} from '../src/main/tray-menu.ts';

const APP = resolve(import.meta.dirname, '..');

/** Decodes the RGBA PNGs the tray icon makes (filter 0 rows only, which is what it writes). */
function decode(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let at = 8;
  let width = 0, height = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === 'IDAT') idat.push(data);
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    expect(raw[row * (1 + width * 4)]).toBe(0);
    rgba.set(raw.subarray(row * (1 + width * 4) + 1, (row + 1) * (1 + width * 4)), row * width * 4);
  }
  return { width, height, rgba };
}

describe('the menu-bar template image', () => {
  it('is Bogen\'s mark in black and alpha only, at 18 pt with real 1x and 2x pixels', () => {
    const reps = trayIconRepresentations();
    expect(reps.map((r) => [r.scaleFactor, r.width, r.height])).toEqual([[1, 18, 18], [2, 18, 18]]);
    for (const r of reps) {
      const { width, height, rgba } = decode(r.png);
      expect([width, height]).toEqual([TRAY_POINTS * r.scaleFactor, TRAY_POINTS * r.scaleFactor]);
      let ink = 0, clear = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        // A template image: AppKit tints it, so every pixel is black and only its alpha says anything.
        expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([0, 0, 0]);
        if (rgba[i + 3] === 255) ink++;
        if (rgba[i + 3] === 0) clear++;
      }
      // Bold enough to read at menu-bar size, with clear space around and inside it.
      expect(ink / (width * height)).toBeGreaterThan(0.3);
      expect(clear / (width * height)).toBeGreaterThan(0.25);
    }
  });

  it('cuts the chevron, the underscore and the fold out of the page, and leaves nothing outside it', () => {
    expect(markInk(15, 20)).toBe(true); // the page
    expect(markInk(37, 56)).toBe(false); // on the chevron's stroke
    expect(markInk(67, 78)).toBe(false); // the underscore
    expect(markInk(66, 18)).toBe(false); // the fold line
    expect(markInk(85, 25)).toBe(true); // the dog-ear itself
    expect(markInk(5, 50)).toBe(false); // outside the page
    expect(markInk(90, 8)).toBe(false); // the cut corner
    // The 2x image is the same drawing with more pixels, not a different one.
    const one = trayAlpha(18), two = trayAlpha(36);
    let diff = 0;
    for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) {
      const avg = (two[(2 * y) * 36 + 2 * x]! + two[(2 * y) * 36 + 2 * x + 1]! + two[(2 * y + 1) * 36 + 2 * x]! + two[(2 * y + 1) * 36 + 2 * x + 1]!) / 4;
      diff += Math.abs(avg - one[y * 18 + x]!);
    }
    expect(diff / (18 * 18)).toBeLessThan(24);
    expect(Buffer.compare(trayIconRepresentations()[1]!.png, trayIconRepresentations()[1]!.png)).toBe(0);
  });
});

describe('the menu-bar menu', () => {
  const ready: TrayBackend = { phase: 'ready', port: 29990 };
  const labels = (items: TrayItem[]) => items.map((i) => (i.separator ? '—' : i.label));

  it('opens Bogen, makes a design, says what the server and agents really do, and has Settings and Quit', () => {
    const items = trayItems({ backend: ready, agents: { kind: 'known', agents: [{ name: 'Claude Code', fileName: 'Poster', working: true }, { name: 'Codex', fileName: 'Deck', working: false }] } });
    expect(labels(items)).toEqual(['Open Bogen', 'New Design', '—', 'Server running on 127.0.0.1:29990', 'Claude Code is working on Poster', '—', 'Settings…', 'Hide Menu Bar Icon', '—', 'Quit Bogen']);
    expect(items.filter((i) => i.command).map((i) => i.command)).toEqual(['open', 'new-design', 'settings', 'hide-icon', 'quit']);
    // Status lines are information, never buttons.
    for (const i of items) if (!i.command && !i.separator) expect(i.enabled).toBe(false);
  });

  it('offers New Design only with a running server, and never invents agent activity', () => {
    for (const phase of ['idle', 'starting', 'restarting', 'failed', 'stopping', 'stopped'] as const) {
      const items = trayItems({ backend: { phase, port: 29990 }, agents: { kind: 'server-off' } });
      expect(items.find((i) => i.command === 'new-design')!.enabled).toBe(false);
      expect(labels(items).some((l) => l && /agent/i.test(l))).toBe(false);
      expect(backendLine({ phase, port: 29990 })).not.toMatch(/running/);
    }
    expect(agentLines({ kind: 'known', agents: [] })).toEqual(['No agent is working']);
    expect(agentLines({ kind: 'known', agents: [{ name: 'Codex', fileName: '', working: false }] })).toEqual(['No agent is working']);
    expect(agentLines({ kind: 'no-answer' })).toEqual(['Agent status unavailable right now']);
    const many = Array.from({ length: 6 }, (_, n) => ({ name: `Agent ${n}`, fileName: 'F', working: true }));
    expect(agentLines({ kind: 'known', agents: many })).toHaveLength(5);
    expect(trayToolTip(ready)).toBe('Bogen: Server running on 127.0.0.1:29990');
  });

  it('reads the server\'s agent list strictly and keeps file names to one plain line', () => {
    expect(parseAgents(null)).toEqual([]);
    expect(parseAgents({ agents: 'x' })).toEqual([]);
    expect(parseAgents({ agents: [{ name: 'A', status: 'busy' }, { name: '', status: 'working' }, 7, { name: 'Codex', status: 'working', fileName: 'Line\nbreak‮evil' }] }))
      .toEqual([{ name: 'Codex', fileName: 'Line break evil', working: true }]);
    expect(parseAgents({ agents: [{ name: 'C', status: 'idle', fileName: 'x'.repeat(200) }] })[0]!.fileName).toHaveLength(48);
  });
});

/** A stand-in for Electron's Tray and the app's server. */
function harness(phase: TrayBackend['phase'] = 'ready') {
  const made: { tips: string[]; menus: TrayItem[][]; destroyed: boolean; click: () => void }[] = [];
  let state: TrayBackend = { phase, port: 29990 };
  let answer: () => Promise<unknown> = async () => ({ agents: [] });
  const signals: AbortSignal[] = [];
  const timeouts: number[] = [];
  const host: TrayHost = {
    create(onClick) {
      const t = { tips: [] as string[], menus: [] as TrayItem[][], destroyed: false, click: onClick };
      made.push(t);
      const handle: TrayHandle = { setToolTip: (s) => t.tips.push(s), popUp: (items) => t.menus.push(items), destroy: () => { t.destroyed = true; }, isDestroyed: () => t.destroyed };
      return handle;
    },
    backend: () => state,
    status: (signal) => {
      signals.push(signal);
      return answer();
    },
    timeout: (ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    },
  };
  return { host, made, signals, timeouts, set: (s: TrayBackend) => { state = s; }, answer: (fn: () => Promise<unknown>) => { answer = fn; } };
}

describe('the status item\'s life', () => {
  it('makes one icon however often it is shown, and removes it for good on destroy', () => {
    const h = harness();
    const icon = new MenuBarIcon(h.host);
    icon.setVisible(true);
    icon.setVisible(true);
    icon.setVisible(true);
    expect(h.made).toHaveLength(1);
    expect(h.made[0]!.tips).toEqual(['Bogen: Server running on 127.0.0.1:29990']);
    icon.destroy();
    expect(h.made[0]!.destroyed).toBe(true);
    expect(icon.visible).toBe(false);
    icon.destroy();
    // Shown again after the person turned it back on: a new item, still only one at a time.
    icon.setVisible(true);
    expect(h.made.filter((t) => !t.destroyed)).toHaveLength(1);
  });

  it('follows backend state in its tooltip, without asking the server', () => {
    const h = harness('starting');
    const icon = new MenuBarIcon(h.host);
    icon.setVisible(true);
    h.set({ phase: 'ready', port: 30001 });
    icon.update();
    h.set({ phase: 'failed', port: 30001 });
    icon.update();
    expect(h.made[0]!.tips).toEqual(['Bogen: Server starting…', 'Bogen: Server running on 127.0.0.1:30001', 'Bogen: Server stopped: open Bogen for details']);
    expect(h.signals).toHaveLength(0);
    // Hidden, updates do nothing.
    icon.setVisible(false);
    icon.update();
    expect(h.made[0]!.tips).toHaveLength(3);
  });

  it('asks /api/status once per click with a timeout, shares one request between quick clicks, and opens the menu even without an answer', async () => {
    const h = harness();
    let release!: (v: unknown) => void;
    h.answer(() => new Promise((r) => { release = r; }));
    const icon = new MenuBarIcon(h.host);
    icon.setVisible(true);
    const a = icon.open();
    const b = icon.open();
    expect(h.signals).toHaveLength(1);
    expect(h.timeouts).toEqual([STATUS_TIMEOUT_MS]);
    release({ agents: [{ name: 'Claude Code', fileName: 'Poster', status: 'working' }] });
    await Promise.all([a, b]);
    expect(h.made[0]!.menus).toHaveLength(2);
    expect(h.made[0]!.menus[0]!.map((i) => i.label)).toContain('Claude Code is working on Poster');

    h.answer(() => Promise.reject(new Error('timeout')));
    await icon.open();
    expect(h.made[0]!.menus.at(-1)!.map((i) => i.label)).toContain('Agent status unavailable right now');
    expect(icon.requests).toBe(2);
  });

  it('does not ask a server that is not running, and does not open a menu for an icon removed meanwhile', async () => {
    const h = harness('stopped');
    const icon = new MenuBarIcon(h.host);
    icon.setVisible(true);
    await icon.open();
    expect(h.signals).toHaveLength(0);
    expect(h.made[0]!.menus[0]!.find((i) => i.command === 'new-design')!.enabled).toBe(false);

    h.set({ phase: 'ready', port: 29990 });
    let release!: (v: unknown) => void;
    h.answer(() => new Promise((r) => { release = r; }));
    const pending = icon.open();
    icon.destroy();
    release({ agents: [] });
    await pending;
    expect(h.made[0]!.menus).toHaveLength(1);
  });
});

describe('the menu-bar preference', () => {
  it('defaults to visible, survives garbage and is set only with a boolean from an app page', () => {
    expect(DEFAULTS.menuBarIcon).toBe(true);
    expect(parseSettings(JSON.stringify({ menuBarIcon: 'no' })).menuBarIcon).toBe(true);
    expect(parseSettings(JSON.stringify({ menuBarIcon: false })).menuBarIcon).toBe(false);
    const shell = 'bogen-shell://app/index.html?view=settings';
    expect(parseIpc('settings:set', { menuBarIcon: false }, shell, true)).toEqual({ channel: 'settings:set', menuBarIcon: false });
    expect(() => parseIpc('settings:set', { menuBarIcon: 'false' }, shell, true)).toThrow(IpcRefused);
    expect(() => parseIpc('settings:set', { menuBarIcon: false }, 'http://127.0.0.1:29990/', true)).toThrow(IpcRefused);
  });
});

describe('main process wiring (read from the source, since Electron does not run here)', () => {
  const main = readFileSync(join(APP, 'src', 'main', 'main.ts'), 'utf8');
  const tray = readFileSync(join(APP, 'src', 'main', 'tray-menu.ts'), 'utf8');

  it('creates the status item in one place, as a template image with a GUID, and destroys it once the quit went ahead', () => {
    expect(main.match(/new Tray\(/g)).toHaveLength(1);
    expect(main.match(/new MenuBarIcon\(/g)).toHaveLength(1);
    expect(main).toContain('image.setTemplateImage(true)');
    expect(main).toContain('new Tray(image, TRAY_GUID)');
    expect(main).toMatch(/app\.on\('will-quit', \(\) => menuBar\.destroy\(\)\)/);
    // Shown at launch from the preference, only on macOS, and never from activate or second-instance.
    expect(main).toContain('menuBar.setVisible(settings.menuBarIcon && MENU_BAR_HOST)');
    const activate = main.slice(main.indexOf("app.on('activate'"), main.indexOf("app.whenReady()"));
    expect(activate).not.toMatch(/menuBar|Tray/);
  });

  it('quits through app.quit, so the before-quit flow still stops the owned server and asks about running agents', () => {
    expect(main).toMatch(/case 'quit': app\.quit\(\); break;/);
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"));
    expect(beforeQuit).toContain('confirmQuit()');
    expect(beforeQuit).toContain('await backend.stop()');
  });

  it('has no timer, interval, child process or screenshot in the tray code', () => {
    for (const bad of ['setInterval', 'setTimeout', 'child_process', 'capturePage', 'screenshot(', 'spawn(', 'exec(']) expect(tray).not.toContain(bad);
    const section = main.slice(main.indexOf('// ---------------------------------------------------------------- menu-bar icon'), main.indexOf('// ---------------------------------------------------------------- updates'));
    for (const bad of ['setInterval', 'setTimeout', 'capturePage', 'execFile', 'spawn(']) expect(section).not.toContain(bad);
    expect(section).toContain('AbortSignal.timeout(ms)');
  });
});
