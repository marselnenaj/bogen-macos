// Info.plist policy of Bogen.app: no App Transport Security exceptions, in the app or any helper app.
//
// Electron's template Info.plist (copied by @electron/packager, which merges `extendInfo` with Object.assign and so can
// add keys but never remove one) ships an NSAppTransportSecurity dictionary that loosens ATS (arbitrary loads, local
// networking). Bogen needs none of it:
// - The editor window, its WebSockets and every renderer load go through Chromium's own network stack, which does not
//   consult ATS. Loopback (http://127.0.0.1:<port>) keeps working as before.
// - The only Cocoa networking is Squirrel.Mac reading the verified update from http://127.0.0.1:<random>/; ATS's
//   defaults (macOS 10.12 and later) already allow loads to IP addresses, so that needs no exception either.
// - Node (the backend) and the main process's fetch are not Cocoa networking.
// So the key is removed from every .app Info.plist in the bundle before signing, and verify-app.mjs refuses an app
// that still has one. Nothing is added in its place: the defaults are the strict policy.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export const ATS_KEY = 'NSAppTransportSecurity';

/** Contents/Info.plist of the app and of every .app nested in it (Electron's helpers, login items). */
export function appInfoPlists(app) {
  const out = [];
  const visit = (bundle) => {
    out.push(join(bundle, 'Contents', 'Info.plist'));
    const walk = (dir) => {
      let names = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const p = join(dir, name);
        if (!lstatSync(p).isDirectory()) continue;
        if (extname(name) === '.app') visit(p);
        else walk(p);
      }
    };
    walk(join(bundle, 'Contents'));
  };
  visit(app);
  return out;
}

/** plutil, macOS's own property list tool: XML, binary and JSON plists alike, edited in place. */
export const plutil = {
  has: (plistPath, key) => spawnSync('plutil', ['-extract', key, 'xml1', '-o', '/dev/null', plistPath]).status === 0,
  remove: (plistPath, key) => {
    execFileSync('plutil', ['-remove', key, plistPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  },
};

/** Removes ATS exceptions from every app Info.plist; returns the files it changed. Throws if one survives. */
export function stripTransportSecurity(app, tool = plutil) {
  const changed = [];
  for (const file of appInfoPlists(app)) {
    if (!tool.has(file, ATS_KEY)) continue;
    tool.remove(file, ATS_KEY);
    changed.push(file);
  }
  const left = transportSecurityLeft(app, tool);
  if (left.length) throw new Error(`App Transport Security exceptions are still in ${left.join(', ')}.`);
  return changed;
}

/** The app Info.plists that still carry ATS exceptions; empty is the only acceptable answer. */
export function transportSecurityLeft(app, tool = plutil) {
  return appInfoPlists(app).filter((file) => tool.has(file, ATS_KEY));
}
