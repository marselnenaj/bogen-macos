# Security of Bogen for macOS

What the Mac app adds to [SECURITY.md](../../SECURITY.md), which still describes the server's threat model.

## Processes

| Process | Runs | Can |
| --- | --- | --- |
| Electron main (`Bogen`) | app code from the integrity-checked `app.asar` | windows, menus, native panels, settings, starting and stopping the backend |
| Renderer, editor window | `http://127.0.0.1:<port>` only, sandboxed, context isolation, no Node | what the editor can do over HTTP and WebSockets, as in a browser |
| Renderer, app pages | `bogen-shell://app` from `app.asar`, strict CSP | the fixed IPC channels below |
| Backend (`node cli.js serve`) | the Bogen server, unchanged, own process group | designs, MCP, agent runs, renders, sync |
| Agent runs, headless shell | started by the backend in their own process groups | what they do on every platform |

## Electron hardening

- Fuses locked in the binary: `RunAsNode` off, `NODE_OPTIONS` ignored, `--inspect` ignored, app code only from
  `app.asar` with its integrity checked, cookie encryption on, no extra `file://` privileges.
- Every window: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (also in subframes and workers),
  `webviewTag: false`, `webSecurity: true`, dev tools off in release builds.
- One preload. On app pages it exposes `bogenShell.invoke(channel, payload)` for 16 named channels; on the editor it
  exposes only `{ app: 'macos', platform: 'darwin' }`. Design HTML in the editor can reach nothing native.
- Main validates every IPC message again (`src/main/ipc.ts`): the sender must be the top frame of
  `bogen-shell://app`, the channel one of the 16, the payload exactly its shape. No channel takes a path, a URL or a
  command; "connect an agent" takes one of three client names (Claude Code, Codex, OpenCode) and runs the app's own launcher with fixed arguments.

## Navigation and permissions

- The editor window stays on its exact origin. Links elsewhere open in the default browser if they are `https:`,
  `http:` or `mailto:` without credentials; everything else (`file:`, custom schemes) is refused.
- `window.open` to the editor's origin opens another locked-down Bogen window; anything else as above.
- Subframes may load the editor's origin, `about:`, `blob:` and `data:` documents (code components and previews).
- Permissions: clipboard, fullscreen and notifications for the editor's origin, and since 0.2.0 the microphone
  (`media` with audio only) for speaking instead of typing in the chat and comment boxes. macOS asks the person once
  (`NSMicrophoneUsageDescription`); the recording goes only to the local server and is written out by a local speech
  model or kept as a voice note. Everything else is denied (camera, any request with video, location, HID, USB,
  serial, MIDI, screen capture), and nothing is granted to any other origin or to app-owned pages. No `<webview>`.
- Entitlements: `allow-jit` on every executable; `device.audio-input` additionally on Electron's app and helper
  executables only, which run the editor window. The bundled node, headless shell and esbuild do not get it. No
  camera entitlement, no App Sandbox, no library-validation exception.

## Network

- The backend listens on `127.0.0.1` only, as on Linux, with the existing Host/Origin checks. Tailnet sync and the
  phone listener stay off until turned on in the editor.
- No App Transport Security exceptions, in the app or any helper app. Electron's template `Info.plist` ships an
  `NSAppTransportSecurity` dictionary (arbitrary loads, local networking); packaging removes it with `plutil` before
  signing (`scripts/plist-policy.mjs`) and `verify-app.mjs` refuses an app that still has one. None is needed: the
  editor and renderers load through Chromium's network stack, which does not consult ATS; the backend is Node; the
  updater talks HTTPS to the feed, and Squirrel.Mac reads the verified zip from a one-shot `127.0.0.1` server with a
  random path, which ATS's defaults allow for IP addresses.

## Lifecycle

- The backend runs in its own process group with its stdin tied to the app: if the app dies, the server stops.
- Agent runs and the render browser run in groups of their own; the server records them with their start time in
  `children.json`, and after a backend crash the app ends exactly those groups whose leader still has the recorded pid
  and start time. A pid that now belongs to another program is left alone.
- The app ends an earlier server of its own only when both the pid and the random instance id it gave that launch
  match. It never ends a program on its port it did not start; it offers another port instead.

## Data and credentials

- Designs in `~/Library/Application Support/Bogen/data`, logs in `~/Library/Logs/Bogen`, both owner-only.
  `~/.local/share/bogen` is only read, to offer a copy, once.
- The app reads only `PATH` from the login shell. It does not read, copy or store API keys, tokens or other secrets;
  the agent CLIs use their own logins. The backend gets the app's whole environment, credentials included, with
  `BOGEN_NO_SANDBOX=0` forced (the render and export browser always keeps Chromium's sandbox) and `NODE_OPTIONS` and
  `ELECTRON_RUN_AS_NODE` removed (the bundled Node runs only the bundled server). `withAppRuntimePolicy` in
  `apps/macos/src/main/paths.ts` and the launcher do exactly this, and a test checks that credentials pass through.
- No credentials ship in the app: no GitHub token, no signing key, no Apple credentials, no payment keys.
