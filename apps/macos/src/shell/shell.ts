// App-owned pages: starting, error, the one-time import offer, Settings, Help and Acknowledgements.
// Built with DOM calls and textContent only, so nothing the server or a log says is ever parsed as HTML.

interface ShellApi {
  invoke(channel: string, payload?: Record<string, unknown>): Promise<unknown>;
  onState(fn: (state: ShellState) => void): void;
}
interface Failure { title: string; detail: string; choices: ('retry' | 'other-port' | 'logs' | 'quit')[] }
interface ShellState {
  view: string;
  detail?: unknown;
  backend: { phase: string; port: number; restarts: number };
  updates: { state: string; message: string };
  settings: { port: number; updateChecks: boolean };
  release: boolean;
  version: string;
}
interface AboutInfo {
  version: string; electron: string; chromium: string; arch: string; release: boolean; licenses: string;
  terms: { summary: string; source: string }; license: string; ffmpeg: string | null;
}

const api = (window as unknown as { bogenShell: ShellApi }).bogenShell;
const root = document.getElementById('root')!;
const view = new URLSearchParams(location.search).get('view') ?? 'starting';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c !== null) node.append(c);
  return node;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  return el('button', { type: 'button', className: primary ? 'primary' : '', textContent: label, onclick: onClick });
}

function render(...nodes: Node[]): void {
  root.replaceChildren(...nodes);
}

function note(text: string, isError = false): HTMLDivElement {
  return el('div', { className: `note${isError ? ' error' : ''}`, textContent: text, role: isError ? 'alert' : 'status' });
}

// ---------------------------------------------------------------- starting, error, import

function starting(state: ShellState): void {
  root.className = 'centered';
  const phase = state.backend.phase;
  render(
    el('div', { className: 'spinner', ariaHidden: 'true' }),
    el('h1', { textContent: phase === 'restarting' ? 'Restarting Bogen…' : 'Starting Bogen…' }),
    el('p', { textContent: phase === 'restarting' ? `The server stopped unexpectedly and is starting again (attempt ${state.backend.restarts}). Your designs are saved on disk.` : `Starting the design server on this Mac (127.0.0.1:${state.backend.port}). It stays on this computer unless you turn on device sync.` }),
  );
}

function failure(state: ShellState): void {
  root.className = 'centered';
  const f = (state.detail ?? { title: 'Bogen could not start', detail: '', choices: ['retry', 'quit'] }) as Failure;
  const portInput = el('input', { type: 'number', min: '1024', max: '65535', value: String(state.backend.port === 29990 ? 29991 : state.backend.port + 1) });
  const actions = el('div', { className: 'actions' });
  for (const c of f.choices) {
    if (c === 'retry') actions.append(button('Try Again', () => void api.invoke('shell:retry'), true));
    if (c === 'logs') actions.append(button('Show Log in Finder', () => void api.invoke('shell:show-logs')));
    if (c === 'quit') actions.append(button('Quit Bogen', () => void api.invoke('shell:quit')));
    if (c === 'other-port') {
      actions.append(el('span', {}, 'Use port ', portInput, ' '), button('Use This Port', () => {
        void api.invoke('shell:use-port', { port: Number(portInput.value) }).catch((e: Error) => actions.after(note(e.message, true)));
      }));
    }
  }
  render(el('h1', { textContent: f.title }), el('pre', { textContent: f.detail }), actions,
    el('p', { textContent: 'Agents in Terminal reach this app through its `bogen` command, which follows the port you choose here.' }));
}

function legacy(state: ShellState): void {
  root.className = 'centered';
  const offer = state.detail as { from: string; files: number };
  render(
    el('h1', { textContent: 'Bring your designs along?' }),
    el('p', { textContent: `An earlier Bogen on this Mac keeps ${offer.files} design${offer.files === 1 ? '' : 's'} in ${offer.from}. Bogen.app keeps its own folder in Application Support. It can copy them over now; the originals stay where they are.` }),
    el('div', { className: 'actions' },
      button('Copy My Designs', () => void api.invoke('legacy:import'), true),
      button('Start Empty', () => void api.invoke('legacy:skip'))),
  );
}

// ---------------------------------------------------------------- settings

async function settings(): Promise<void> {
  const s = await api.invoke('settings:get') as { port: number; updateChecks: boolean; menuBarIcon: boolean; data: string; logs: string; release: boolean };
  const about = await api.invoke('about:info') as AboutInfo;
  const status = el('div');
  const say = (text: string, isError = false) => status.replaceChildren(note(text, isError));
  const port = el('input', { type: 'number', min: '1024', max: '65535', value: String(s.port) });
  const checks = el('input', { type: 'checkbox', checked: s.updateChecks, disabled: !s.release });
  checks.onchange = () => void api.invoke('settings:set', { updateChecks: checks.checked });
  const menuBarIcon = el('input', { type: 'checkbox', checked: s.menuBarIcon });
  menuBarIcon.onchange = () => void api.invoke('settings:set', { menuBarIcon: menuBarIcon.checked });
  const row = (title: string, hint: string, ...control: Node[]) => el('div', { className: 'row' }, el('div', { className: 'what' }, el('div', { textContent: title }), el('div', { textContent: hint })), ...control);
  const agent = (client: 'claude-code' | 'codex' | 'opencode', name: string) => button(`Connect ${name}`, () => {
    say(`Adding Bogen to ${name}…`);
    void api.invoke('settings:connect-agent', { client }).then((r) => {
      const out = r as { ok: boolean; message: string };
      say(out.message, !out.ok);
    });
  });
  // The update's own state, kept current: downloading with its percent, ready with a restart, or what went wrong.
  const updateRow = el('div');
  const showUpdate = (u: { state: string; message: string }) => {
    const action = u.state === 'available' ? button('Download and Install', () => void api.invoke('updates:install'))
      : u.state === 'ready' ? button('Restart to Update', () => void api.invoke('updates:install')) : null;
    updateRow.replaceChildren(row('Status', u.message, ...(action ? [action] : [])));
  };
  api.onState((state) => showUpdate(state.updates));
  void api.invoke('shell:state').then((state) => showUpdate((state as ShellState).updates));
  render(
    el('h1', { textContent: 'Settings' }),
    el('h2', { textContent: 'General' }),
    el('section', { className: 'box' },
      row('Show Bogen in the menu bar', 'Opens Bogen, starts a new design and shows whether the server is running and which agents are working. Bogen stays in the Dock either way.', menuBarIcon),
    ),
    el('h2', { textContent: 'Agents' }),
    el('section', { className: 'box' },
      row('Claude Code, Codex and OpenCode', 'Bogen runs your own claude, codex and opencode with your own plan. Connecting adds Bogen’s MCP server to that tool, and the Bogen skill to Claude Code and Codex, so it can draw here from a terminal too. Restart a session that was already open.', agent('claude-code', 'Claude Code'), agent('codex', 'Codex'), agent('opencode', 'OpenCode')),
      row('Command line tool', 'Links ~/.local/bin/bogen to this app, for bogen mcp, bogen status and the rest in Terminal.', button('Install…', () => void api.invoke('settings:install-cli').then((r) => say((r as { message: string }).message, !(r as { ok: boolean }).ok)))),
      row('FFmpeg (optional)', about.ffmpeg ? `Found at ${about.ffmpeg}. Used for GIF replays, AVIF with transparency and, with whisper.cpp, speaking instead of typing.` : 'Not found. MP4 and WebM exports work without it. GIF replays, AVIF with transparency and speaking instead of typing need your own ffmpeg, for example from Homebrew (brew install ffmpeg; for speech also whisper-cpp and a model).'),
    ),
    el('h2', { textContent: 'Server' }),
    el('section', { className: 'box' },
      row('Port', 'The design server listens on 127.0.0.1 only. Device sync over Tailscale is turned on per device in the editor, under Devices.', port, button('Apply', () => {
        void api.invoke('settings:set', { port: Number(port.value) }).then(() => say(`Restarting on port ${port.value}…`)).catch((e: Error) => say(e.message, true));
      })),
      row('Data folder', s.data, button('Show in Finder', () => void api.invoke('settings:reveal-data'))),
      row('Logs', s.logs, button('Show in Finder', () => void api.invoke('shell:show-logs'))),
    ),
    el('h2', { textContent: 'Updates' }),
    el('section', { className: 'box' },
      row('Check once a day', s.release ? 'Asks the update feed for a newer signed release. Nothing installs without your click.' : 'This is a development build. It does not update itself.', checks),
      row('Check now', '', button('Check for Updates', () => void api.invoke('updates:check').then((r) => say((r as { message: string }).message)))),
      updateRow,
    ),
    el('h2', { textContent: 'Bogen for macOS' }),
    el('section', { className: 'box' },
      row(about.terms.summary, about.terms.source),
      row(`Version ${about.version}${about.release ? '' : ' (development build)'}`, `Electron ${about.electron}, Chromium ${about.chromium}, ${about.arch}. ${about.license}`),
    ),
    status,
  );
}

// ---------------------------------------------------------------- help and acknowledgements

function help(): void {
  const section = (title: string, ...lines: string[]) => [el('h2', { textContent: title }), ...lines.map((l) => el('p', { textContent: l }))];
  render(
    el('h1', { textContent: 'Bogen Help' }),
    ...section('Getting started', 'File › New Design (⌘N) makes a design. Every layer is real HTML and CSS. Your own coding agents draw on the canvas with you: ask in the chat beside the canvas (⌘K), mention an agent in a comment, or connect Claude Code, Codex or OpenCode in Settings and work from a terminal.'),
    ...section('Agents', 'Bogen starts the claude and codex you installed, with your own login and plan. It finds them through your login shell’s PATH. If one is not found, open Terminal, check that `claude --version` or `codex --version` works, and restart Bogen. Bogen never asks for or stores API keys.'),
    ...section('Files', 'File › Open (⌘O) opens .bogen files, and so does double-clicking one in Finder. File › Save a Copy (⇧⌘S) writes the open design as a .bogen file. Exports from the editor ask where to save.'),
    ...section('Tabs', 'Every design you open gets a tab above the toolbar, with All Designs first. ⌃⇥ and ⌃⇧⇥ switch tabs, ⌘1 is All Designs, ⌘2 to ⌘8 a tab by place and ⌘9 the last one. ⌘W closes the tab in view; on All Designs with no tab open it closes the window (⇧⌘W always does). The Window menu lists the open tabs.'),
    ...section('Your designs', 'Designs live in ~/Library/Application Support/Bogen/data, in the same format as Bogen on Omarchy. Help › Show Data Folder opens it.'),
    ...section('Devices and sync', 'Bogen listens on this Mac only. To sync with your other devices over Tailscale, turn on device sync in the editor under Devices and pair them; edits merge, also after working offline.'),
    ...section('Mac themes', 'Home › Design a Mac theme makes a theme for this Mac: wallpapers for your displays in light and dark, and an appearance kit (colours, type, spacing) for apps you build. Export gives a folder of images, tokens and an Xcode colour catalog. Bogen changes nothing on your Mac: you set the wallpaper in System Settings › Wallpaper and Light, Dark or Auto and the accent in System Settings › Appearance. The menu bar, Dock and windows in the previews are illustrations.'),
    ...section('Menu bar', 'Bogen’s icon in the menu bar opens Bogen, starts a new design and shows whether the server runs and which agents are working. Hide it from its menu or in Settings › General; Bogen stays in the Dock.'),
    ...section('Omarchy themes', 'Theme files made for Omarchy Linux keep their format here and are labelled as such. To make one on the Mac, filter Home by Omarchy themes. Installing and applying happens on an Omarchy device: the file syncs there, or export it as a .tar.gz.'),
    ...section('Speaking instead of typing', 'The microphone in the chat and in comment boxes records your voice, and a speech model on this Mac writes it out into the field for you to check; nothing goes online. macOS asks once for microphone access (System Settings › Privacy & Security › Microphone). For the speech model, install whisper.cpp and ffmpeg with Homebrew (brew install whisper-cpp ffmpeg) and put a Whisper model such as ggml-base.bin in ~/.local/share/whisper.cpp/models; the editor’s Check again finds it. Without one, a comment keeps the recording as a voice note on this Mac.'),
    ...section('Video and images', 'PNG, JPG, WebP, PDF, SVG, MP4 and WebM work as they are. GIF replays, AVIF with transparency and speech transcription need your own ffmpeg; Settings shows whether one was found.'),
    ...section('When something goes wrong', 'Help › Show Logs in Finder opens backend.log and app.log. Quitting Bogen (⌘Q) stops the server and any agent run; closing the window keeps the server running for agents.'),
  );
}

async function licenses(): Promise<void> {
  const about = await api.invoke('about:info') as AboutInfo;
  render(
    el('h1', { textContent: 'Acknowledgements' }),
    el('p', { textContent: about.license }),
    el('p', { textContent: 'The license texts ship inside the app, in the folder below: Bogen’s GPL-3.0-or-later license with its exception for exported work, third-party notices, Electron and Chromium (LICENSES.chromium.html), Node.js, and the headless Chromium used for exports.' }),
    el('pre', { textContent: about.licenses }),
  );
}

// ---------------------------------------------------------------- boot

function show(state: ShellState): void {
  if (view === 'starting') starting(state);
  else if (view === 'error') failure(state);
  else if (view === 'legacy') legacy(state);
}

if (view === 'settings') void settings().catch((e: Error) => render(note(e.message, true)));
else if (view === 'help') help();
else if (view === 'licenses') void licenses().catch((e: Error) => render(note(e.message, true)));
else {
  api.onState(show);
  void api.invoke('shell:state').then((s) => show(s as ShellState));
}
