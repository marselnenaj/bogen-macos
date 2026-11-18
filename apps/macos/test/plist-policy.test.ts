// Info.plist policy: no App Transport Security exceptions anywhere in Bogen.app. plutil exists only on macOS; here a
// stand-in edits the XML property lists the way Electron's template is written, so the walk, the decisions and the
// failure path are checked on any OS. The third native CI run found the key in the packaged app.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appInfoPlists, ATS_KEY, stripTransportSecurity, transportSecurityLeft, type PlistTool } from '../scripts/plist-policy.mjs';

const APP_ROOT = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The shape of Electron's template: ATS loosened with arbitrary loads, local networking and loopback exceptions. */
const ELECTRON_ATS = `  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key>
      <dict>
        <key>NSTemporaryExceptionAllowsInsecureHTTPLoads</key>
        <true/>
      </dict>
    </dict>
  </dict>
`;

function plist(id: string, ats: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
${ats ? ELECTRON_ATS : ''}  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>abc</string></dict>
  </dict>
</dict>
</plist>
`;
}

/** Edits XML plists as plutil would for a top-level key: finds `<key>K</key>` at depth 1 and its value element. */
function xmlTool(): PlistTool & { removed: string[] } {
  const span = (text: string, key: string): [number, number] | null => {
    const marker = `\n  <key>${key}</key>\n`;
    const start = text.indexOf(marker);
    if (start < 0) return null;
    let i = start + marker.length;
    let depth = 0;
    const re = /<(\/?)(dict|array)>|<(true|false)\/>|<(string|integer|real|date|data)>[^<]*<\/\4>/g;
    re.lastIndex = i;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[2]) depth += m[1] ? -1 : 1;
      if (depth === 0) return [start, re.lastIndex + 1];
    }
    return null;
  };
  const removed: string[] = [];
  return {
    removed,
    has: (p, key) => span(readFileSync(p, 'utf8'), key) !== null,
    remove: (p, key) => {
      const text = readFileSync(p, 'utf8');
      const s = span(text, key);
      if (!s) throw new Error(`No ${key} in ${p}`);
      writeFileSync(p, text.slice(0, s[0] + 1) + text.slice(s[1]));
      removed.push(p);
    },
  };
}

function put(root: string, rel: string, data: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
}

/** Bogen.app as packager leaves it: the main Info.plist and the helpers' all from Electron's templates. */
function packagedApp(): string {
  const root = mkdtempSync(join(tmpdir(), 'bogen-plist-'));
  dirs.push(root);
  const app = join(root, 'Bogen.app');
  put(app, 'Contents/Info.plist', plist('dev.bogen.app', true));
  for (const helper of ['Bogen Helper', 'Bogen Helper (Renderer)', 'Bogen Helper (GPU)', 'Bogen Helper (Plugin)']) {
    put(app, `Contents/Frameworks/${helper}.app/Contents/Info.plist`, plist(`dev.bogen.app.helper`, helper !== 'Bogen Helper (Plugin)'));
  }
  put(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist', plist('com.github.Electron.framework', false));
  put(app, 'Contents/Library/LoginItems/Bogen Login Helper.app/Contents/Info.plist', plist('dev.bogen.app.loginhelper', true));
  put(app, 'Contents/Resources/runtime/headless-shell/ABOUT', 'not a plist');
  return app;
}

describe('App Transport Security in Bogen.app', () => {
  it('finds the Info.plist of the app and of every nested app, and no framework plists', () => {
    const app = packagedApp();
    expect(appInfoPlists(app).map((p) => relative(app, p)).sort()).toEqual([
      'Contents/Frameworks/Bogen Helper (GPU).app/Contents/Info.plist',
      'Contents/Frameworks/Bogen Helper (Plugin).app/Contents/Info.plist',
      'Contents/Frameworks/Bogen Helper (Renderer).app/Contents/Info.plist',
      'Contents/Frameworks/Bogen Helper.app/Contents/Info.plist',
      'Contents/Info.plist',
      'Contents/Library/LoginItems/Bogen Login Helper.app/Contents/Info.plist',
    ]);
  });

  it('removes Electron\'s exceptions wherever they are, adds nothing, and leaves every other key alone', () => {
    const app = packagedApp();
    const tool = xmlTool();
    expect(transportSecurityLeft(app, tool)).toHaveLength(5);
    const changed = stripTransportSecurity(app, tool).map((p) => relative(app, p)).sort();
    expect(changed).toHaveLength(5);
    expect(changed).not.toContain('Contents/Frameworks/Bogen Helper (Plugin).app/Contents/Info.plist');
    expect(transportSecurityLeft(app, tool)).toEqual([]);
    const main = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    expect(main).not.toContain('NSAllowsArbitraryLoads');
    expect(main).not.toContain('NSAllowsLocalNetworking');
    expect(main).not.toContain('NSExceptionDomains');
    expect(main).toContain('<string>dev.bogen.app</string>');
    expect(main).toContain('<key>ElectronAsarIntegrity</key>');
    expect(main).toContain('<key>hash</key><string>abc</string>');
    // Run again: nothing left to change.
    expect(stripTransportSecurity(app, tool)).toEqual([]);
  });

  it('fails loudly when a removal does not take, instead of shipping the exception', () => {
    const app = packagedApp();
    const real = xmlTool();
    const stubborn: PlistTool = { has: real.has, remove: () => {} };
    expect(() => stripTransportSecurity(app, stubborn)).toThrow(/App Transport Security exceptions are still in/);
  });

  it('strips before fuses and signing, and verify-app keeps refusing any exception', () => {
    const pkg = readFileSync(join(APP_ROOT, 'scripts', 'package.mjs'), 'utf8');
    const strip = pkg.indexOf('stripTransportSecurity(app)');
    expect(strip).toBeGreaterThan(0);
    expect(strip).toBeLessThan(pkg.indexOf('await flipFuses('));
    expect(strip).toBeLessThan(pkg.indexOf('await signApp('));
    expect(pkg).not.toMatch(/NSAppTransportSecurity\s*:/); // never re-added through extendInfo
    const verify = readFileSync(join(APP_ROOT, 'scripts', 'verify-app.mjs'), 'utf8');
    expect(verify).toContain("check(!('NSAppTransportSecurity' in info), 'no App Transport Security exceptions');");
    expect(verify).toContain('transportSecurityLeft(app)');
    expect(ATS_KEY).toBe('NSAppTransportSecurity');
  });
});
