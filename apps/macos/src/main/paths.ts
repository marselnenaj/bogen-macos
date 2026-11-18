// Where Bogen for macOS keeps things. Pure: tests call it with any home folder.
//
// ~/Library/Application Support/Bogen        Electron's own profile (localStorage, IndexedDB of the editor), settings
// ~/Library/Application Support/Bogen/data   BOGEN_HOME: designs, assets, history, pairings. Same format as on Omarchy
// ~/Library/Caches/Bogen                     things that may be thrown away: crash dumps, the backend's temp files
// ~/Library/Logs/Bogen                       backend.log (rotated), app.log
//
// Nothing here points at ~/.local/share/bogen, where the Linux build and the old script install keep their data.
// That folder is only ever read, when the person asks to import from it.

import { join } from 'node:path';
import runtimeJson from '../../runtime.json' with { type: 'json' };

export interface AppPaths {
  /** Electron's userData. */
  support: string;
  /** BOGEN_HOME of the backend. */
  data: string;
  caches: string;
  logs: string;
  settings: string;
  /** Read by the `bogen` launcher in the bundle: the port, so terminal agents find the app's server. */
  cliEnv: string;
  backendLog: string;
  /** Where the script install (integrations/macos) and the Linux build keep data. Only read, for an import. */
  legacyData: string;
}

export const PRODUCT = 'Bogen';

export function macPaths(home: string, product = PRODUCT): AppPaths {
  const support = join(home, 'Library', 'Application Support', product);
  const logs = join(home, 'Library', 'Logs', product);
  return {
    support,
    data: join(support, 'data'),
    caches: join(home, 'Library', 'Caches', product),
    logs,
    settings: join(support, 'settings.json'),
    cliEnv: join(support, 'cli.env'),
    backendLog: join(logs, 'backend.log'),
    legacyData: join(home, '.local', 'share', 'bogen'),
  };
}

/**
 * The backend's environment is the app's own, passed on whole (credentials and the person's variables included), with
 * exactly three runtime settings forced:
 * - BOGEN_NO_SANDBOX=0: the render and export browser always keeps Chromium's sandbox. The shared server keeps an
 *   escape hatch for containers (`=1`); the Mac app sets it off explicitly rather than trusting its absence.
 * - NODE_OPTIONS and ELECTRON_RUN_AS_NODE removed: the bundled Node runs the bundled server only, with no
 *   `--require`/`--import` injected from a launchctl environment. Neither carries a credential.
 */
export function withAppRuntimePolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, BOGEN_NO_SANDBOX: '0' };
  delete out.NODE_OPTIONS;
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

/** Where the bundle keeps what it ships, from `process.resourcesPath` (…/Bogen.app/Contents/Resources). */
export interface BundleLayout {
  node: string;
  cli: string;
  headlessShell: string;
  launcher: string;
  licenses: string;
}

/**
 * `npm start` in apps/macos: the app runs from apps/macos/out/app, the server from the checkout's build, on the Node
 * on PATH. Nothing of this reaches a packaged app.
 */
export function devLayout(appPath: string): BundleLayout {
  const repo = join(appPath, '..', '..', '..', '..');
  return {
    node: 'node',
    cli: join(repo, 'packages', 'server', 'dist', 'cli.js'),
    // apps/macos/out/app → apps/macos/vendor/<arch>, where fetch-runtime.mjs puts it.
    headlessShell: join(appPath, '..', '..', 'vendor', process.arch, RUNTIME_LAYOUT.headlessShell),
    launcher: join(appPath, '..', '..', 'resources', 'bin', 'bogen'),
    licenses: repo,
  };
}

/** runtime.json's `layout`: one source for the scripts that place the runtimes and the app that runs them. */
export const RUNTIME_LAYOUT: { node: string; headlessShell: string } = { node: runtimeJson.layout.node, headlessShell: runtimeJson.layout.headlessShell };

export function bundleLayout(resources: string): BundleLayout {
  return {
    node: join(resources, RUNTIME_LAYOUT.node),
    cli: join(resources, 'server', 'dist', 'cli.js'),
    headlessShell: join(resources, RUNTIME_LAYOUT.headlessShell),
    launcher: join(resources, 'bin', 'bogen'),
    licenses: join(resources, 'licenses'),
  };
}
