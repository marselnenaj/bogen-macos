// Bogen for macOS: the Electron main process. See docs/macos/adr-0001-app-runtime.md for why it is built this way.
//
// It owns: the windows and the menu bar, the backend's life (backend.ts), opening and saving .bogen files with native
// panels, the app's settings, updates (updater.ts), and the policy for what windows may load and ask for (policy.ts).
// It does not own designs: the backend does, exactly as on Omarchy.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, screen, session, shell, systemPreferences, Tray, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { Backend, describeFailure, probeBogen, type BackendState } from './backend.ts';
import { IpcRefused, parseIpc, type AgentClient } from './ipc.ts';
import { bundleOf, installAdvice } from './install-location.ts';
import { importLegacy, legacyOffer, type LegacyOffer } from './legacy-import.ts';
import { mergePath, parseShellPath, shellPathCommand } from './login-path.ts';
import { closeAction, menuTemplate, parseEditorTabs, tabOfHash, windowForFile, type Command, type EditorTabs, type Item, type PageKey } from './menu-template.ts';
import { bundleLayout, devLayout, macPaths, withAppRuntimePolicy } from './paths.ts';
import { decideNavigation, decidePermission, decideWindowOpen, editorOrigin, isEditorUrl, isShellUrl, SHELL_CSP, SHELL_ORIGIN, SHELL_SCHEME } from './policy.ts';
import { LICENSE_NOTE, TERMS } from './product.ts';
import { reapChildren, systemReapDeps } from './reaper.ts';
import { DisplayReporter } from './displays.ts';
import { cliEnvText, loadSettings, saveSettings, type Settings } from './settings.ts';
import { trayIconRepresentations } from './tray-icon.ts';
import { MenuBarIcon, TRAY_GUID, type TrayCommand, type TrayHandle, type TrayItem } from './tray-menu.ts';
import { dockProgress, updateNotice } from './update-core.ts';
import { AppUpdater, type UpdateStatus } from './updater.ts';
import { restoreBounds, MIN_SIZE } from './window-state.ts';

declare const __BOGEN_FLAVOR__: 'release' | 'dev';
declare const __BOGEN_UPDATE_FEED__: string;
declare const __BOGEN_APP_ID__: string;

const RELEASE = __BOGEN_FLAVOR__ === 'release';
const APP_ID = __BOGEN_APP_ID__;
const FILE_ID = /^[0-9a-zA-Z_-]{1,64}$/;
const OPEN_LIMIT = 512 * 1024 * 1024;

// ---------------------------------------------------------------- before ready

protocol.registerSchemesAsPrivileged([{ scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Bogen');
// Development builds only: an isolated home for automated smoke tests, so they never touch a person's real data.
// A release build ignores it.
const smokeHome = !RELEASE && process.env.BOGEN_APP_HOME?.startsWith('/') ? process.env.BOGEN_APP_HOME : null;
const paths = macPaths(smokeHome ?? app.getPath('home'));
app.setPath('userData', paths.support);
app.setPath('crashDumps', join(paths.caches, 'Crashpad'));
app.setAppLogsPath(paths.logs);
for (const dir of [paths.support, paths.data, paths.caches, paths.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });

const layout = app.isPackaged ? bundleLayout(process.resourcesPath) : devLayout(app.getAppPath());
const shellRoot = join(app.getAppPath(), 'shell');
let settings: Settings = loadSettings(paths.settings);
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let quitting = false;
let shellView: { view: string; detail?: unknown } = { view: 'starting' };
const pendingOpens: string[] = [];

function appLog(line: string): void {
  try {
    writeFileSync(join(paths.logs, 'app.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a', mode: 0o600 });
  } catch {
    // Logging must never take the app down.
  }
}

// Finder and the Dock hand over documents before `ready` too.
app.on('open-file', (event, path) => {
  event.preventDefault();
  pendingOpens.push(path);
  if (app.isReady()) void drainOpens();
});

// ---------------------------------------------------------------- backend

function rotate(path: string, limit = 5 * 1024 * 1024): void {
  try {
    if (statSync(path).size > limit) renameSync(path, path.replace(/\.log$/, '.1.log'));
  } catch {
    // No log yet.
  }
}

rotate(paths.backendLog);
const backendLog = createWriteStream(paths.backendLog, { flags: 'a', mode: 0o600 });

/** PATH as the person's login shell sets it, so the backend finds claude and codex from a Dock launch. */
function loginPath(): Promise<string> {
  const shellPath = process.env.SHELL || '/bin/zsh';
  const cmd = shellPathCommand(shellPath);
  const home = app.getPath('home');
  const known = (dir: string) => existsSync(dir);
  if (!cmd) return Promise.resolve(mergePath((process.env.PATH ?? '').split(':'), home, known));
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { timeout: 6000, maxBuffer: 1024 * 1024, env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
      const found = parseShellPath(String(stdout ?? ''));
      if (err && !found.length) appLog(`login shell PATH: ${err.message}; using the known install folders`);
      resolve(mergePath(found.length ? found : (process.env.PATH ?? '').split(':'), home, known));
    });
  });
}

function backendEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path,
    BOGEN_HOME: paths.data,
    // The app updates itself; the server's npm updater must not even look (it also refuses inside a bundle).
    BOGEN_UPDATE_CHECK: 'off',
    BOGEN_SELF_COMMAND: layout.launcher,
    BOGEN_MACOS_APP_ID: APP_ID,
  };
  if (existsSync(layout.headlessShell)) env.BOGEN_BROWSER = layout.headlessShell;
  return withAppRuntimePolicy(env);
}

/** server.json in the app's own data folder: the pid and instance id of this app's server, if one ran. */
function previousServer(): { pid: number; instance: string } | null {
  try {
    const { pid, instance } = JSON.parse(readFileSync(join(paths.data, 'server.json'), 'utf8')) as { pid?: unknown; instance?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
    if (typeof instance !== 'string' || !/^[0-9a-f]{32}$/.test(instance)) return null;
    return { pid, instance };
  } catch {
    return null;
  }
}

const backend = new Backend(
  { node: layout.node, cli: layout.cli, port: settings.port, env: { ...process.env }, cwd: paths.data },
  {
    spawn: (command, args, options) => spawn(command, args, options),
    probe: (port) => probeBogen(port),
    kill: (pid, signal) => process.kill(pid, signal),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    previousServer,
    newInstance: () => randomBytes(16).toString('hex'),
    reap: async () => {
      await reapChildren(join(paths.data, 'children.json'), systemReapDeps(appLog));
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (chunk) => backendLog.write(chunk),
  },
);

backend.onChange((state) => {
  appLog(`backend: ${state.phase}${state.reason ? ` (${state.reason.code})` : ''}`);
  if (state.phase === 'ready') {
    writeCliEnv(state.port);
    void displays.report();
    if (mainWindow && !isEditorUrl(mainWindow.webContents.getURL(), state.port)) void showEditor();
    void drainOpens();
  } else if (state.phase === 'failed' && state.reason) {
    showShell('error', describeFailure(state.reason));
  }
  pushState();
  menuBar.update();
});

function writeCliEnv(port: number): void {
  try {
    writeFileSync(paths.cliEnv, cliEnvText(port, APP_ID), { mode: 0o600 });
  } catch (e) {
    appLog(`cli.env: ${(e as Error).message}`);
  }
}

async function startBackend(): Promise<void> {
  showShell('starting');
  const path = await loginPath();
  appLog(`backend PATH: ${path}`);
  backend.setPort(settings.port);
  // The environment is fixed per start, so a new login PATH applies after Retry.
  backend.setEnv(backendEnv(path));
  const nodeOk = !app.isPackaged || existsSync(layout.node);
  if (!nodeOk || !existsSync(layout.cli)) {
    showShell('error', { title: 'This copy of Bogen is incomplete', detail: `The bundled server is missing (${nodeOk ? layout.cli : layout.node}). ${app.isPackaged ? 'Download Bogen again.' : 'Run npm run build in the checkout first.'}`, choices: ['quit'] });
    return;
  }
  await backend.start();
}

// ---------------------------------------------------------------- windows

const webPreferences = (): Electron.WebPreferences => ({
  preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  spellcheck: true,
  devTools: !RELEASE,
});

function createMainWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const frame = restoreBounds(settings.window, screen.getAllDisplays().map((d) => d.workArea), display.workArea);
  const win = new BrowserWindow({
    ...frame,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Bogen',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    webPreferences: webPreferences(),
  });
  if (frame.maximized) win.maximize();
  if (frame.fullScreen) win.setFullScreen(true);
  win.once('ready-to-show', () => win.show());
  const remember = () => {
    if (win.isDestroyed()) return;
    const normal = win.getNormalBounds();
    settings = { ...settings, window: { ...normal, ...(win.isMaximized() ? { maximized: true } : {}), ...(win.isFullScreen() ? { fullScreen: true } : {}) } };
    saveSettings(paths.settings, settings);
  };
  win.on('close', remember);
  // The Window menu lists the editor's file tabs: read again when the editor navigates, gains focus or finishes loading.
  for (const event of ['did-navigate-in-page', 'did-navigate', 'did-finish-load'] as const) win.webContents.on(event as 'did-finish-load', () => void refreshTabs());
  win.on('focus', () => void refreshTabs());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    const s = backend.current;
    if (s.phase === 'ready') void showEditor();
    else void mainWindow.loadURL(shellUrl(shellView.view));
  }
  return mainWindow;
}

function shellUrl(view: string): string {
  return `${SHELL_ORIGIN}/index.html?view=${encodeURIComponent(view)}`;
}

function showShell(view: string, detail?: unknown): void {
  shellView = { view, detail };
  const win = ensureMainWindow();
  if (!isShellUrl(win.webContents.getURL()) || !win.webContents.getURL().includes(`view=${view}`)) void win.loadURL(shellUrl(view));
  pushState();
}

/** The editor window that shows a file already (the main window or one the editor opened), if any. */
function editorWindowFor(fileId: string): BrowserWindow | null {
  const port = backend.current.phase === 'ready' ? backend.current.port : null;
  if (port === null) return null;
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({ win: w, url: w.webContents.getURL() }));
  return windowForFile(wins, fileId, (url) => isEditorUrl(url, port))?.win ?? null;
}

/**
 * One window per file: a file another window shows already is shown there, brought forward, with the link's page or
 * layer applied; true when that happened.
 */
function showInWindowWithFile(hash: string): boolean {
  const fileId = tabOfHash(hash);
  const win = fileId ? editorWindowFor(fileId) : null;
  if (!win) return false;
  if (hashOf(win.webContents.getURL()) !== hash) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`, false).catch(() => undefined);
  bringForward(win);
  return true;
}

/** Loads the editor in the main window. `reload`: load it there even when another window shows the file (Reload). */
async function showEditor(hash = '', reload = false): Promise<void> {
  if (hash && !reload && showInWindowWithFile(hash)) return;
  const win = ensureMainWindow();
  const port = backend.current.port;
  await win.loadURL(`${editorOrigin(port)}/${hash}`).catch((e: Error) => appLog(`editor load: ${e.message}`));
}

function stateForShell(): unknown {
  return { ...shellView, backend: backend.current, updates: updater.current, settings: { port: settings.port, updateChecks: settings.updateChecks }, release: RELEASE, version: app.getVersion() };
}

function pushState(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && isShellUrl(win.webContents.getURL())) win.webContents.send('bogen:state', stateForShell());
  }
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640, height: 620, resizable: false, minimizable: false, fullscreenable: false, title: 'Settings', show: false,
    parent: undefined, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff', webPreferences: webPreferences(),
  });
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  void settingsWindow.loadURL(shellUrl('settings'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function openShellWindow(view: 'help' | 'licenses', title: string): void {
  const win = new BrowserWindow({ width: 760, height: 680, title, webPreferences: webPreferences(), backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff' });
  void win.loadURL(shellUrl(view));
}

// ---------------------------------------------------------------- web contents policy

app.on('web-contents-created', (_e, contents: WebContents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const port = backend.current.port;
    const d = decideWindowOpen(url, port);
    if (d.action === 'external') void shell.openExternal(d.url);
    if (d.action === 'child') return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 860, webPreferences: webPreferences() } };
    return { action: 'deny' };
  });
  // Only navigations a page starts reach here; main's own loadURL (shell ⇄ editor) does not. So a page may move to an
  // app page only from an app page: the editor, which shows untrusted design HTML, can never reach the shell bridge.
  const guard = (event: Electron.Event, url: string) => {
    if (isShellUrl(url)) {
      if (!isShellUrl(contents.getURL())) {
        event.preventDefault();
        appLog(`blocked navigation from ${contents.getURL().slice(0, 120)} to an app page`);
      }
      return;
    }
    const d = decideNavigation(url, backend.current.port);
    if (d.action === 'allow') return;
    event.preventDefault();
    if (d.action === 'external') void shell.openExternal(d.url);
    else appLog(`blocked navigation to ${url.slice(0, 200)}`);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-frame-navigate', (event) => {
    // Subframes (code components, previews) stay inside the editor's origin or about:/blob:/data: documents it made.
    const url = event.url;
    if (event.isMainFrame) return;
    if (isEditorUrl(url, backend.current.port) || /^(about|blob|data):/.test(url)) return;
    event.preventDefault();
  });
});

/**
 * macOS's own microphone permission (System Settings › Privacy & Security › Microphone). Asked once, when the editor
 * first records; a refusal there reaches the editor as a blocked microphone, which says where to allow it.
 */
async function microphoneAccess(): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
  return false;
}

function installSessionPolicy(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    const allowed = decidePermission(permission, details.requestingUrl || wc.getURL(), backend.current.port, mediaTypes);
    if (!allowed || permission !== 'media') return callback(allowed);
    microphoneAccess().then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => decidePermission(permission, requestingOrigin, backend.current.port, details.mediaType ? [details.mediaType] : []));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  // Downloads from the editor (exports, .bogen copies, theme archives) get the native save panel.
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
  });
}

function serveShellProtocol(): void {
  protocol.handle(SHELL_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = join(shellRoot, rel || 'index.html');
    if (!file.startsWith(shellRoot + sep)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (!res || !res.ok) return new Response('Not found', { status: 404 });
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', SHELL_CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: 200, headers });
  });
}

// ---------------------------------------------------------------- files

async function api(path: string, init?: RequestInit): Promise<Response> {
  if (backend.current.phase !== 'ready') throw new Error('The Bogen server is not running.');
  return fetch(`${backend.url}${path}`, init);
}

async function importBogenFile(path: string): Promise<string> {
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > OPEN_LIMIT) throw new Error('The file is larger than 512 MB, which is more than Bogen opens.');
  const bytes = await readFile(path);
  const res = await api('/api/files/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Bogen-Filename': encodeURIComponent(path.split('/').pop() ?? 'design').replace(/%20/g, ' ') }, body: bytes });
  const body = await res.json().catch(() => ({})) as { id?: string; error?: string };
  if (!res.ok || !body.id || !FILE_ID.test(body.id)) throw new Error(body.error ?? `The server answered ${res.status}.`);
  return body.id;
}

async function drainOpens(): Promise<void> {
  if (backend.current.phase !== 'ready') return;
  while (pendingOpens.length) {
    const path = pendingOpens.shift()!;
    try {
      if (!path.toLowerCase().endsWith('.bogen')) throw new Error('Bogen opens .bogen files. Import HTML, images, SVG, Figma and websites from inside a design.');
      const id = await importBogenFile(path);
      await showEditor(`#/file/${id}`);
      app.addRecentDocument(path);
    } catch (e) {
      void dialog.showMessageBox({ type: 'warning', message: `Could not open ${path.split('/').pop()}`, detail: (e as Error).message });
    }
  }
}

function currentFileId(): string | null {
  const url = mainWindow?.webContents.getURL() ?? '';
  const m = /#\/file\/([^/?#]+)/.exec(url);
  return m && FILE_ID.test(m[1]!) && isEditorUrl(url, backend.current.port) ? m[1]! : null;
}

async function saveCopy(): Promise<void> {
  const id = currentFileId();
  if (!id) {
    void dialog.showMessageBox({ type: 'info', message: 'Open a design first', detail: 'Save a Copy writes the design that is open as a .bogen file.' });
    return;
  }
  const list = await (await api('/api/files')).json() as { id: string; name: string }[];
  const name = (list.find((f) => f.id === id)?.name ?? 'Design').replace(/[/:]/g, '-');
  const target = await dialog.showSaveDialog(mainWindow!, { title: 'Save a Copy', defaultPath: join(app.getPath('documents'), `${name}.bogen`), filters: [{ name: 'Bogen design', extensions: ['bogen'] }] });
  if (target.canceled || !target.filePath) return;
  const res = await api(`/api/files/${id}/download`);
  if (!res.ok || !res.body) throw new Error(`The server answered ${res.status}.`);
  const tmp = `${target.filePath}.bogen-part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp, { mode: 0o644 }));
  renameSync(tmp, target.filePath);
  app.addRecentDocument(target.filePath);
}

async function newDesign(): Promise<void> {
  const res = await api('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const body = await res.json() as { id?: string };
  if (!res.ok || !body.id || !FILE_ID.test(body.id)) throw new Error(`The server answered ${res.status}.`);
  await showEditor(`#/file/${body.id}`);
}

async function openPanel(): Promise<void> {
  const picked = await dialog.showOpenDialog({ title: 'Open', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Bogen design', extensions: ['bogen'] }] });
  if (picked.canceled) return;
  pendingOpens.push(...picked.filePaths);
  await drainOpens();
}

// ---------------------------------------------------------------- command line tool and agents

/** Links ~/.local/bin/bogen to the launcher in the bundle. Never replaces a `bogen` that is not ours. */
function installCli(): { ok: boolean; message: string } {
  const bin = join(app.getPath('home'), '.local', 'bin');
  const link = join(bin, 'bogen');
  if (!existsSync(layout.launcher)) return { ok: false, message: 'This build has no command line launcher.' };
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && readlinkSync(link) === layout.launcher) return { ok: true, message: `${link} already points at this app.` };
    const text = st.isFile() ? readFileSync(link, 'utf8').slice(0, 4096) : '';
    if (!(st.isSymbolicLink() && readlinkSync(link).endsWith('/Contents/Resources/bin/bogen')) && !text.includes('Managed by Bogen')) {
      return { ok: false, message: `${link} exists and is not Bogen's, so it was left alone. Remove it yourself to link the app's launcher there.` };
    }
    renameSync(link, `${link}.replaced-by-bogen-app`);
  } catch {
    // Nothing there yet.
  }
  mkdirSync(bin, { recursive: true });
  symlinkSync(layout.launcher, link);
  const onPath = (process.env.PATH ?? '').split(':').includes(bin);
  return { ok: true, message: `Linked ${link} to Bogen.app.${onPath ? '' : ' Add ~/.local/bin to PATH in ~/.zprofile to use it in Terminal: export PATH="$HOME/.local/bin:$PATH"'}` };
}

/** Runs `bogen install <client>` through the app's launcher: the client's config then starts `bogen mcp` from the app. */
function connectAgent(client: AgentClient): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile(layout.launcher, ['install', client], { timeout: 60_000, env: backendEnv(process.env.PATH ?? '') }, (err, stdout, stderr) => {
      resolve({ ok: !err, message: `${String(stdout)}${String(stderr)}`.trim() || (err ? err.message : 'Done.') });
    });
  });
}

/**
 * FFmpeg is not bundled. MP4 and WebM exports and replays encode in the bundled headless Chromium (WebCodecs); a GIF
 * replay, AVIF with transparency and local voice transcription need the person's own ffmpeg. Settings says which.
 */
async function findFfmpegOnPath(): Promise<string | null> {
  const path = await loginPath();
  return path.split(':').map((dir) => join(dir, 'ffmpeg')).find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------- IPC

let offer: LegacyOffer | null = null;
let decideLegacy: (() => void) | null = null;

// The editor asks for its own window to come forward (one window per file); at most once a second per window, and
// only from the top frame of the running server's editor, never from a design's frame.
const lastFocusAsk = new WeakMap<WebContents, number>();
ipcMain.on('bogen-editor:focus-window', (event) => {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null || backend.current.phase !== 'ready' || !isEditorUrl(frame.url, backend.current.port)) return;
  const now = Date.now();
  if (now - (lastFocusAsk.get(event.sender) ?? 0) < 1000) return;
  lastFocusAsk.set(event.sender, now);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) bringForward(win);
});

ipcMain.handle('bogen', async (event, channel: unknown, payload: unknown) => {
  const frame = event.senderFrame;
  let req;
  try {
    req = parseIpc(channel, payload, frame?.url ?? '', Boolean(frame && frame.parent === null));
  } catch (e) {
    appLog(`ipc refused from ${(frame?.url ?? '?').slice(0, 120)}: ${(e as Error).message}`);
    throw e instanceof IpcRefused ? new Error(e.message) : e;
  }
  switch (req.channel) {
    case 'shell:state':
      return stateForShell();
    case 'shell:retry':
      void startBackend();
      return true;
    case 'shell:use-port':
      settings = { ...settings, port: req.port };
      saveSettings(paths.settings, settings);
      void startBackend();
      return true;
    case 'shell:open-editor':
      if (backend.current.phase === 'ready') void showEditor();
      return true;
    case 'shell:show-logs':
      shell.showItemInFolder(paths.backendLog);
      return true;
    case 'shell:quit':
      app.quit();
      return true;
    case 'settings:get':
      return { port: settings.port, updateChecks: settings.updateChecks, menuBarIcon: settings.menuBarIcon, data: paths.data, logs: paths.logs, release: RELEASE };
    case 'settings:set':
      settings = { ...settings, ...(req.updateChecks !== undefined ? { updateChecks: req.updateChecks } : {}), ...(req.port !== undefined ? { port: req.port } : {}), ...(req.menuBarIcon !== undefined ? { menuBarIcon: req.menuBarIcon } : {}) };
      saveSettings(paths.settings, settings);
      if (req.menuBarIcon !== undefined) menuBar.setVisible(req.menuBarIcon && MENU_BAR_HOST);
      if (req.port !== undefined && req.port !== backend.current.port) {
        await backend.stop();
        void startBackend();
      }
      return { port: settings.port, updateChecks: settings.updateChecks, menuBarIcon: settings.menuBarIcon };
    case 'settings:connect-agent':
      return connectAgent(req.client);
    case 'settings:install-cli':
      return installCli();
    case 'settings:reveal-data':
      void shell.openPath(paths.data);
      return true;
    case 'updates:check':
      return updater.check();
    case 'updates:install':
      if (updater.current.state === 'available') return updater.download();
      if (updater.current.state === 'ready') updater.restartToInstall();
      return updater.current;
    case 'legacy:import':
    case 'legacy:skip': {
      if (offer && req.channel === 'legacy:import') {
        const out = await importLegacy(offer.from, paths.data);
        appLog(`legacy import: copied ${out.copied} entries from ${offer.from}`);
      }
      settings = { ...settings, legacyImportAnswered: true };
      saveSettings(paths.settings, settings);
      decideLegacy?.();
      return true;
    }
    case 'about:info':
      return {
        version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, arch: process.arch,
        terms: TERMS, license: LICENSE_NOTE, release: RELEASE, licenses: layout.licenses,
        legacy: offer, ffmpeg: await findFfmpegOnPath(),
      };
  }
});

// ---------------------------------------------------------------- menu

// ---------------------------------------------------------------- file tabs (the editor's, shown in the menu)

let editorTabs: EditorTabs | null = null;
let menuKey = '';

/** The main window's editor, when it shows the editor of the running server. */
function editorContents(): WebContents | null {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  return wc && backend.current.phase === 'ready' && isEditorUrl(wc.getURL(), backend.current.port) ? wc : null;
}

function hashOf(url: string): string {
  const at = url.indexOf('#');
  return at < 0 ? '' : url.slice(at);
}

function setMenu(): void {
  const key = JSON.stringify(editorTabs);
  if (key === menuKey) return;
  menuKey = key;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenu(menuTemplate('Bogen', editorTabs))));
}

/** Reads the editor's tab list (its own localStorage entry, parsed strictly here) and rebuilds the menu when it changed. */
async function refreshTabs(): Promise<void> {
  const wc = editorContents();
  if (!wc) {
    editorTabs = null;
    setMenu();
    return;
  }
  const raw: unknown = await wc.executeJavaScript('(() => { try { return localStorage.getItem("bogen-tabs"); } catch { return null; } })()', false).catch(() => null);
  if (wc.isDestroyed()) return;
  editorTabs = parseEditorTabs(raw, tabOfHash(hashOf(wc.getURL())));
  setMenu();
}

/** Hands the editor one of its tab keys, as a keydown on its window (the editor's tab handler listens there first). */
function sendPageKey(wc: WebContents, k: PageKey): void {
  const init = { key: k.key, code: k.code, ctrlKey: Boolean(k.ctrl), metaKey: Boolean(k.meta), shiftKey: Boolean(k.shift), bubbles: true, cancelable: true };
  void wc.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))`, false).catch(() => undefined);
}

/** ⌘W: the open file tab in the editor, else the window (Home with no file tab, Settings, Help), else nothing. */
function closeTabOrWindow(): void {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  const editor = win === mainWindow ? editorContents() : null;
  const action = closeAction(Boolean(editor), editor ? hashOf(editor.getURL()) : '', editorTabs);
  if (action === 'close-tab' && editor) sendPageKey(editor, { key: 'w', code: 'KeyW', meta: true });
  else if (action === 'close-window') win.close();
  else shell.beep();
  setTimeout(() => void refreshTabs(), 150);
}

function runTabCommand(command: Command, item: Item): boolean {
  if (command === 'close-tab') {
    closeTabOrWindow();
    return true;
  }
  if (command !== 'next-tab' && command !== 'previous-tab' && command !== 'tab-at' && command !== 'go-to-tab') return false;
  const wc = editorContents();
  if (!wc) return true;
  if (command === 'go-to-tab' && item.fileId && FILE_ID.test(item.fileId) && showInWindowWithFile(`#/file/${item.fileId}`)) return true;
  if (mainWindow && !mainWindow.isFocused()) bringForward(mainWindow);
  if (command === 'go-to-tab' && item.fileId && FILE_ID.test(item.fileId)) {
    void wc.executeJavaScript(`location.hash = ${JSON.stringify(`#/file/${item.fileId}`)}`, false).catch(() => undefined);
  } else if (item.pageKey) {
    sendPageKey(wc, item.pageKey);
  }
  setTimeout(() => void refreshTabs(), 150);
  return true;
}

function runCommand(command: Command, item: Item): void {
  if (runTabCommand(command, item)) return;
  const wc = BrowserWindow.getFocusedWindow()?.webContents;
  if (item.sendKey && wc) {
    if (isShellUrl(wc.getURL())) {
      if (command === 'undo') wc.undo();
      else if (command === 'redo') wc.redo();
      else if (command === 'select-all') wc.selectAll();
      return;
    }
    const keyCode = item.sendKey.key;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: item.sendKey.modifiers });
    wc.sendInputEvent({ type: 'char', keyCode, modifiers: item.sendKey.modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: item.sendKey.modifiers });
    return;
  }
  const fail = (e: Error) => void dialog.showMessageBox({ type: 'warning', message: 'That did not work', detail: e.message });
  switch (command) {
    case 'about': app.showAboutPanel(); break;
    case 'settings': openSettings(); break;
    case 'check-updates': void updater.check().then((s) => dialog.showMessageBox({ type: 'info', message: 'Updates', detail: s.state === 'available' ? `${s.message} It downloads in the background (${Math.round(s.build.size / 1e6)} MB, progress on the Dock icon and in Settings); Bogen tells you when it is ready.` : s.message, buttons: s.state === 'available' ? ['Download and Install', 'Later'] : ['OK'] }).then((r) => {
      if (s.state === 'available' && r.response === 0) void updater.download();
    })); break;
    case 'new-design': newDesign().catch(fail); break;
    case 'open': openPanel().catch(fail); break;
    case 'save-copy': saveCopy().catch(fail); break;
    case 'home': {
      // In the editor already: change the address only, so the files open behind their tabs stay loaded.
      const editor = editorContents();
      if (editor) void editor.executeJavaScript('location.hash = "#/"', false).catch(() => undefined);
      else if (backend.current.phase === 'ready') void showEditor('#/');
      break;
    }
    case 'reload-editor': if (backend.current.phase === 'ready') void showEditor(currentFileId() ? `#/file/${currentFileId()}` : '', true); break;
    case 'show-logs': shell.showItemInFolder(paths.backendLog); break;
    case 'show-data': void shell.openPath(paths.data); break;
    case 'help': openShellWindow('help', 'Bogen Help'); break;
    case 'acknowledgements': openShellWindow('licenses', 'Acknowledgements'); break;
    case 'install-cli': { const r = installCli(); void dialog.showMessageBox({ type: r.ok ? 'info' : 'warning', message: 'Command line tool', detail: r.message }); break; }
    default: break;
  }
}

function buildMenu(items: Item[]): MenuItemConstructorOptions[] {
  return items.filter((i) => !(i.devOnly && RELEASE)).map((i): MenuItemConstructorOptions => {
    if (i.separator) return { type: 'separator' };
    const out: MenuItemConstructorOptions = {};
    if (i.label) out.label = i.label;
    if (i.role) out.role = i.role as MenuItemConstructorOptions['role'];
    if (i.accelerator) out.accelerator = i.accelerator;
    if (i.registerAccelerator === false) out.registerAccelerator = false;
    if (i.checked !== undefined) {
      out.type = 'checkbox';
      out.checked = i.checked;
    }
    if (i.submenu) out.submenu = buildMenu(i.submenu);
    if (i.command) {
      const command = i.command;
      out.click = () => runCommand(command, i);
    }
    return out;
  });
}

// ---------------------------------------------------------------- menu-bar icon

/** The status item is a macOS menu-bar extra. A development run on another OS has no menu bar to put it in. */
const MENU_BAR_HOST = process.platform === 'darwin';

/** Brings the app forward from the menu bar: clicking a status item does not activate the app by itself. */
function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

function runTrayCommand(command: TrayCommand): void {
  const fail = (e: Error) => void dialog.showMessageBox({ type: 'warning', message: 'That did not work', detail: e.message });
  switch (command) {
    case 'open': bringForward(ensureMainWindow()); break;
    case 'new-design':
      bringForward(ensureMainWindow());
      newDesign().catch(fail);
      break;
    case 'settings':
      openSettings();
      app.focus({ steal: true });
      break;
    case 'hide-icon':
      settings = { ...settings, menuBarIcon: false };
      saveSettings(paths.settings, settings);
      menuBar.setVisible(false);
      void dialog.showMessageBox({ type: 'info', message: 'The menu bar icon is hidden', detail: 'Bogen keeps running in the Dock. To show the icon again, open Bogen › Settings… and turn on Show Bogen in the menu bar.' });
      break;
    case 'quit': app.quit(); break;
  }
}

function trayMenu(items: TrayItem[]): Menu {
  return Menu.buildFromTemplate(items.map((i): MenuItemConstructorOptions => {
    if (i.separator) return { type: 'separator' };
    const command = i.command;
    return { label: i.label ?? '', enabled: i.enabled !== false, ...(command ? { click: () => runTrayCommand(command) } : {}) };
  }));
}

function createStatusItem(onClick: () => void): TrayHandle {
  const image = nativeImage.createEmpty();
  for (const r of trayIconRepresentations()) image.addRepresentation({ scaleFactor: r.scaleFactor, buffer: r.png });
  // Black and alpha only: AppKit draws it in the menu bar's own colour, light or dark, and highlighted while open.
  image.setTemplateImage(true);
  const tray = new Tray(image, TRAY_GUID);
  tray.setIgnoreDoubleClickEvents(true);
  // No context menu is set: each click builds the menu from current state and opens it, so it is never stale.
  tray.on('click', onClick);
  tray.on('right-click', onClick);
  return {
    setToolTip: (text) => tray.setToolTip(text),
    popUp: (items) => tray.popUpContextMenu(trayMenu(items)),
    destroy: () => tray.destroy(),
    isDestroyed: () => tray.isDestroyed(),
  };
}

// Held for the app's whole life: a Tray nobody references is collected and vanishes from the menu bar.
const menuBar = new MenuBarIcon({
  create: createStatusItem,
  backend: () => backend.current,
  status: async (signal) => {
    const res = await fetch(`${backend.url}/api/status`, { signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return res.json();
  },
  timeout: (ms) => AbortSignal.timeout(ms),
});

// ---------------------------------------------------------------- this Mac's displays, for Mac theme wallpapers

const displays = new DisplayReporter({
  read: () => screen.getAllDisplays(),
  ready: () => backend.current.phase === 'ready',
  send: async (report) => {
    await fetch(`${backend.url}/api/mac/displays`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displays: report }), signal: AbortSignal.timeout(2000) });
  },
});

// ---------------------------------------------------------------- updates

const updater = new AppUpdater({ feed: __BOGEN_UPDATE_FEED__ || undefined, releaseBuild: RELEASE && app.isPackaged, version: app.getVersion(), cacheDir: paths.caches, log: appLog });
let lastUpdate: UpdateStatus = updater.current;
updater.onChange((next) => {
  pushState();
  const progress = dockProgress(next);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(progress);
  const notice = updateNotice(lastUpdate, next);
  lastUpdate = next;
  if (notice === 'ready') {
    void dialog.showMessageBox({ type: 'info', message: 'Update ready', detail: `${next.message} Restart now?`, buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1 }).then((r) => {
      if (r.response === 0) updater.restartToInstall();
    });
  } else if (notice === 'error') {
    void dialog.showMessageBox({ type: 'warning', message: 'The update did not install', detail: `${next.message}\n\nDetails are in app.log (Bogen › Settings › Logs).`, buttons: ['OK'] });
  }
});

function scheduleUpdateChecks(): void {
  if (!RELEASE || !__BOGEN_UPDATE_FEED__) return;
  const tick = () => {
    if (settings.updateChecks) void updater.check();
  };
  setTimeout(tick, 5 * 60_000).unref();
  setInterval(tick, 24 * 3600_000).unref();
}

// ---------------------------------------------------------------- lifecycle

async function confirmQuit(): Promise<boolean> {
  if (backend.current.phase !== 'ready') return true;
  try {
    const status = await (await api('/api/status')).json() as { agents?: { name: string; status: string }[] };
    const working = (status.agents ?? []).filter((a) => a.status !== 'idle');
    if (!working.length) return true;
    const r = await dialog.showMessageBox({ type: 'warning', message: 'An agent is still working', detail: `${working.map((a) => a.name).join(', ')} ${working.length === 1 ? 'is' : 'are'} working in Bogen. Quitting stops the server, and with it ${working.length === 1 ? 'that run' : 'those runs'}. Changes made so far are saved.`, buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1 });
    return r.response === 0;
  } catch {
    return true;
  }
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void (async () => {
    if (!(await confirmQuit())) return;
    quitting = true;
    await backend.stop();
    backendLog.end();
    app.quit();
  })();
});

// Last step of a quit that went ahead (the server is stopped by now): the status item goes with the app.
app.on('will-quit', () => menuBar.destroy());

// A logout, `kill`, or a test harness: quit the normal way, which stops the backend and its children first.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => app.quit());

// A Mac app stays open without windows; the server keeps serving agents. Quit is ⌘Q.
app.on('window-all-closed', () => {});

app.on('activate', () => {
  ensureMainWindow().show();
});

app.on('second-instance', () => {
  const win = ensureMainWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

/**
 * First launch from the disk image (or from macOS's translocated copy of a download): say so once per launch and offer
 * to move Bogen to /Applications, only where no administrator password is needed (install-location.ts). Returns false
 * when Bogen is about to relaunch from its new place.
 */
async function checkInstallLocation(): Promise<boolean> {
  const bundle = app.isPackaged ? bundleOf(process.execPath) : null;
  if (!bundle) return true;
  const writable = (path: string) => {
    try {
      accessSync(path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const advice = installAdvice({ bundle, home: app.getPath('home'), bundleFolderWritable: writable(dirname(bundle)), applicationsWritable: writable('/Applications') });
  if (!advice.prompt) return true;
  appLog(`install location: ${advice.place} (${bundle}), move ${advice.canMove ? 'offered' : 'explained'}`);
  const buttons = advice.canMove ? ['Move to Applications', 'Not Now'] : ['Quit', 'Continue from Here'];
  const r = await dialog.showMessageBox({ type: 'info', message: advice.title, detail: advice.detail, buttons, defaultId: 0, cancelId: 1 });
  if (!advice.canMove) {
    if (r.response === 0) app.quit();
    return r.response !== 0;
  }
  if (r.response !== 0) return true;
  try {
    // An older Bogen already in Applications goes to the Trash (recoverable) after the person agrees; a running one
    // is never replaced. The data folder in Library is not touched by either.
    return !app.moveToApplicationsFolder({
      conflictHandler: (kind) => {
        if (kind === 'existsAndRunning') {
          dialog.showMessageBoxSync({ type: 'warning', message: 'Bogen is already open from Applications', detail: 'Quit that Bogen first, then open this one again to replace it.' });
          return false;
        }
        return dialog.showMessageBoxSync({ type: 'question', message: 'Replace the Bogen in Applications?', detail: 'The Bogen already in Applications moves to the Trash. Your designs and settings stay where they are.', buttons: ['Replace', 'Cancel'], defaultId: 0, cancelId: 1 }) === 0;
      },
    });
  } catch (e) {
    appLog(`install location: move failed: ${(e as Error).message}`);
    await dialog.showMessageBox({ type: 'warning', message: 'Bogen could not move itself', detail: `${(e as Error).message} Drag Bogen from the disk image into Applications instead.` });
    return true;
  }
}

app.whenReady().then(async () => {
  // Before anything starts: a move relaunches Bogen from Applications, and this copy quits.
  if (!(await checkInstallLocation())) return;
  app.setAboutPanelOptions({
    applicationName: 'Bogen', applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
    copyright: 'Free and open source under GPL-3.0-or-later. See Help > Acknowledgements for all bundled components.',
    credits: `${TERMS.summary} ${TERMS.source}`,
  });
  serveShellProtocol();
  installSessionPolicy();
  setMenu();
  // A tab closed or moved in the strip does not navigate: while the window has focus, the list is read every 2 s too.
  setInterval(() => { if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) void refreshTabs(); }, 2000).unref();
  menuBar.setVisible(settings.menuBarIcon && MENU_BAR_HOST);
  // Displays plugged in, removed, rotated or rescaled: the Mac theme's "this Mac" displays follow. Events only.
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(event as 'display-added', () => void displays.report());
  mainWindow = createMainWindow();
  void mainWindow.loadURL(shellUrl('starting'));

  offer = settings.legacyImportAnswered ? null : await legacyOffer(paths.legacyData, paths.data).catch(() => null);
  if (offer) {
    showShell('legacy', offer);
    await new Promise<void>((resolve) => {
      decideLegacy = resolve;
    });
    decideLegacy = null;
  }
  if (!settings.welcomed) {
    settings = { ...settings, welcomed: true };
    saveSettings(paths.settings, settings);
  }
  await startBackend();
  scheduleUpdateChecks();
}).catch((e: Error) => {
  appLog(`startup: ${e.stack ?? e.message}`);
  dialog.showErrorBox('Bogen could not start', e.message);
});

// Keep dirname referenced for bundlers that tree-shake path helpers used only in type positions.
void dirname;
