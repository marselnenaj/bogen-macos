// Code signing of Bogen.app, inside out, with the narrowest entitlements that let it run under the hardened runtime.
//
// - Release: a "Developer ID Application" identity, hardened runtime, secure timestamp, on every Mach-O in the bundle:
//   Electron and its helpers, the bundled node, the headless shell and its libraries, esbuild's binary.
// - Development: ad-hoc ("-"), no hardened runtime, so it runs on this Mac and nowhere else. Never distributed.
//
// Order (see sign-plan.mjs for why):
//   1. Refuse to start if any Mach-O outside a .app/.framework shares its folder's name (codesign's shallow-bundle trap).
//   2. Bogen's payload in Contents/Resources, one file at a time, deepest first, libraries before executables.
//   3. Electron's own code with @electron/osx-sign, told to leave the payload alone (already signed with our
//      entitlements) and every non-Mach-O file alone (no signatures in extended attributes of images or fonts).
//   4. Verify: each payload file strictly, then the whole app with `codesign --verify --deep --strict`. --deep is used
//      to verify only, never to sign.
//
// Entitlements, in both modes: com.apple.security.cs.allow-jit, which V8 needs for its JIT under the hardened runtime
// (Electron, Node and Chromium alike), on every executable (build/entitlements.plist). Electron's app and helper apps,
// which run the editor window, also get com.apple.security.device.audio-input for the microphone of the editor's chat
// and comment boxes (build/entitlements-shell.plist); the bundled node, headless shell and esbuild do not. No camera,
// no disable-library-validation (all code is signed by the same team), no allow-unsigned-executable-memory, no dyld
// environment variables, no get-task-allow, no App Sandbox. Libraries get no entitlements; they mean nothing there.

import { extname, join, relative } from 'node:path';
import { sign } from '@electron/osx-sign';
import { appRoot, fail, output, run } from './lib.mjs';
import { codesignArgs, electronEntitlements, machOKind, payloadPlan, shallowBundleTraps } from './sign-plan.mjs';

export const ENTITLEMENTS = join(appRoot, 'build', 'entitlements.plist');
export const SHELL_ENTITLEMENTS = join(appRoot, 'build', 'entitlements-shell.plist');

export function checkIdentity(identity) {
  if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity)) fail(`"${identity}" is not a Developer ID Application identity ("Developer ID Application: Name (TEAMID)").`);
  const found = output('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!found.includes(`"${identity}"`)) fail(`The identity "${identity}" is not in this Mac's keychain. Nothing was signed.`);
}

export async function signApp(app, identity) {
  if (identity) checkIdentity(identity);

  const traps = shallowBundleTraps(app);
  if (traps.length) fail(`These executables share their folder's name, which codesign would take for a bundle: ${traps.map((t) => relative(app, t)).join(', ')}. Rename the folder; nothing was signed.`);

  const plan = payloadPlan(app);
  if (!plan.some((p) => p.file.endsWith('/runtime/node/bin/node'))) fail('The bundled node is missing from the signing plan. Nothing was signed.');
  for (const item of plan) run('codesign', codesignArgs(item, { identity, entitlements: ENTITLEMENTS }));
  const signed = new Set(plan.map((p) => p.file));

  // Electron's own code. Bundles (.app/.framework) are signed as bundles; plain files only when they are Mach-O and not
  // already signed above.
  const leaveAlone = (file) => !['.app', '.framework'].includes(extname(file)) && (signed.has(file) || !machOKind(file));
  const options = (file) => ({ hardenedRuntime: Boolean(identity), entitlements: electronEntitlements(file, { payload: ENTITLEMENTS, shell: SHELL_ENTITLEMENTS }), ...(identity ? {} : { timestamp: 'none' }) });
  await sign(identity
    ? { app, identity, platform: 'darwin', type: 'distribution', ignore: leaveAlone, optionsForFile: options }
    : { app, identity: '-', identityValidation: false, platform: 'darwin', type: 'development', preAutoEntitlements: false, ignore: leaveAlone, optionsForFile: options });

  for (const item of plan) run('codesign', ['--verify', '--strict', '--verbose=2', item.file]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
}
