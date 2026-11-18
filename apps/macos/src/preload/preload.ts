// The one preload of every Bogen window. It runs sandboxed (no Node), with context isolation.
//
// - On app-owned pages (bogen-shell://app) it exposes `bogenShell`: invoke one of the fixed channels, and listen for
//   state pushes. Main checks the sender of every message again; this is only the convenience half.
// - On the editor (http://127.0.0.1:<port>) it exposes `bogenDesktop`: static facts, and `focusWindow`, which brings
//   the editor's own window to the front (one window per file: a second window asks the one that has the file to come
//   forward). Nothing that reaches files, processes or other windows.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const SHELL_CHANNELS = new Set([
  'shell:state', 'shell:retry', 'shell:use-port', 'shell:open-editor', 'shell:show-logs', 'shell:quit',
  'settings:get', 'settings:set', 'settings:connect-agent', 'settings:install-cli', 'settings:reveal-data',
  'updates:check', 'updates:install', 'legacy:import', 'legacy:skip', 'about:info',
]);

if (location.protocol === 'bogen-shell:' && location.host === 'app') {
  contextBridge.exposeInMainWorld('bogenShell', {
    invoke(channel: string, payload?: Record<string, unknown>): Promise<unknown> {
      if (!SHELL_CHANNELS.has(channel)) return Promise.reject(new Error('Unknown channel.'));
      return ipcRenderer.invoke('bogen', channel, payload ?? {});
    },
    onState(fn: (state: unknown) => void): void {
      ipcRenderer.on('bogen:state', (_e: IpcRendererEvent, state: unknown) => fn(state));
    },
  });
} else if (location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  contextBridge.exposeInMainWorld('bogenDesktop', Object.freeze({
    app: 'macos',
    platform: 'darwin',
    focusWindow(): void { ipcRenderer.send('bogen-editor:focus-window'); },
  }));
}
