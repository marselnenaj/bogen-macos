# ADR 0001: Runtime and shell of Bogen for macOS

- Status: accepted, 2026-11-05
- Scope: `apps/macos` (the app), small platform adapters in `packages/server`, packaging in `apps/macos/scripts`
- Supersedes: the script install in `integrations/macos` (LaunchAgent + AppleScript applet + an installed Chrome),
  which stays in the tree for existing script users but is no longer the product path on a Mac.

## Context

What the source actually is, read before deciding:

- **Editor**: a React app (`apps/editor`) built by Vite, served by the server over `http://127.0.0.1:<port>`. It renders
  every layer as a real DOM element with real CSS (`NodeView.tsx`), talks Yjs over `WS /sync/:fileId` and JSON over
  `WS /events`. Its CSP is set by the server (`http/static.ts`). Its whole test suite (`apps/editor/test/e2e`) runs in
  Chromium.
- **Server**: one esbuild bundle, `packages/server/dist/cli.js`, that needs Node ≥ 22.18. It owns storage, rooms,
  MCP (`/mcp` Streamable HTTP, and `bogen mcp` as a stdio relay), agent runs (spawns the person's own `claude` and
  `codex` by name from `PATH`), device sync over Tailscale, phone listener, updates for npm installs.
- **Renders and exports** (`render.ts`, `video.ts`, `capture*.ts`, `media.ts`, `replay.ts`, `avif.ts`): a shared,
  lazily started, idle-closed headless Chromium driven by `puppeteer-core` over a pipe, with request interception,
  per-capture browser contexts, CDP screenshots and PDF. `render.ts` is 937 lines and the core promise of the product
  is "canvas, screenshot and export agree", because one engine draws all three.
- **Memory protection**: `memory-pressure.ts` read only Linux `/proc` and cgroup files, so on a Mac it always said "ok".
- **Security**: loopback Host + same-origin Origin check (`http/security.ts`), owner checks per route, opt-in tailnet
  and phone listeners with tokens.

Constraints from the commission: a real `.app` that opens from Finder and Dock without a global Node, Homebrew,
browser or npm; formats and core compatible with Omarchy; a browser security floor of Chromium **156.0.8078.79**;
agents and large files must work; no wrapped hosted website; safe native/web boundary; signed updates; direct
distribution first.

## Options

| | A. SwiftUI/AppKit + WKWebView + bundled Node + headless Chromium | B. Electron (renderer sandbox) + bundled Node + headless Chromium | C. Tauri + Node sidecar + headless Chromium |
| --- | --- | --- | --- |
| Canvas engine | WebKit (Safari 26.x) | Chromium 156 (Electron 45.2.3) | WebKit (WKWebView) |
| Exports engine | Chromium 156 (`chrome-headless-shell`) | Chromium 156 (`chrome-headless-shell`), **same major as the canvas** | Chromium 156 |
| Canvas = export fidelity | Two engines: text metrics, subpixel layout, `backdrop-filter`, shaders, form controls differ. Breaks the product's core promise. | One engine family and major version for both. | Same problem as A. |
| Editor test coverage | None of the e2e suites run in WebKit | All existing Chromium suites apply | None |
| Node/agent/server integration | Same child process either way | Same child process | Sidecar; same |
| Native UX | Best | Good: real `Menu`, `dialog`, `shell`, Dock, window state, Services-free | Good |
| Memory | Lowest idle (WebKit shares system frameworks) | Highest idle (~150-250 MB for the shell process tree) | Low idle |
| Maintenance | New Swift codebase + JS editor, two languages, two web engines | One language (TypeScript) for app, server and editor | Rust + TS, two web engines |
| Security patch cadence | WebKit follows macOS updates (outside our control) | We ship Chromium; must follow Electron's stable line | WebKit, outside our control |
| Signing/notarization | Standard | Standard; Electron's hardened-runtime path is well documented | Standard |

## Decision

**B: Electron 45.2.3 (Chromium 156.0.8078.80, ≥ the 156.0.8078.79 floor) as the shell, the unchanged Bogen server as a
supervised child process on a bundled official Node.js runtime, and a bundled Chrome for Testing
`chrome-headless-shell` of the same Chromium major for renders and exports.**

Why:

1. **Fidelity is the product.** With A or C the canvas would draw in WebKit and every export in Chromium; the canvas
   would stop being a truthful preview. B keeps one engine and one major version for the canvas and the exports.
2. **No canvas rewrite.** The editor, the server and every e2e suite are reused as they are. The macOS-specific code
   is the shell, the supervisor and a handful of adapters.
3. **The server is not embedded in Electron.** It runs on its own Node, exactly as on Linux. That keeps
   `process.execPath` meaningful for `bogen mcp` and agent runs, keeps the shell's Node features off (fuses), and
   keeps the Omarchy and Mac builds of the server identical.
4. **puppeteer stays.** Electron cannot be driven by puppeteer over a pipe as a headless browser, and re-implementing
   `render.ts` on `webContents.capturePage` would be a costly second render path. `chrome-headless-shell` is launched
   by the existing `Renderer` with `pipe: true` and its own sandbox on, only when a render needs it, closed when idle,
   and refused under memory pressure.

Costs we accept and how we limit them:

- **Size**: about 500 MB installed per architecture (Electron ~230 MB, Node ~110 MB, headless shell ~170 MB). We ship
  separate arm64 and x64 builds rather than a universal one, which would double it.
- **Two Chromium process trees during an export.** The headless shell runs only while rendering (idle close 60 s),
  never starts under memory pressure (`launchGuard`), and is limited to 3 pages.
- **Patch cadence**: Electron's stable line must be followed. `apps/macos/runtime.json` pins Electron, Node and the
  headless shell, and CI fails the build when Electron's Chromium is below the floor in `runtime.json`.

## Boundaries that follow from the decision

- **Process tree**: `Bogen` (Electron main) → `node cli.js serve` (backend, own process group) → `claude` / `codex`
  runs and `chrome-headless-shell` (owned by the backend, which closes them on `SIGTERM`). Quit sends `SIGTERM` to the
  backend's process group, waits, then `SIGKILL`s the group, so no Chromium or agent outlives the app.
- **Data**: `~/Library/Application Support/Bogen` (designs, `BOGEN_HOME`), `~/Library/Caches/Bogen`,
  `~/Library/Logs/Bogen`. Never `~/.local/share/bogen` unless the person imports from it (copy, never move).
- **Web/native boundary**: the editor window loads only `http://127.0.0.1:<port>`; its preload exposes static facts
  and nothing that reaches files or a shell. App-owned pages (welcome, error, settings, licenses) load from a custom
  `bogen-shell://app` scheme inside `app.asar`, and only frames from that origin may use the narrow, validated IPC.
- **Network**: loopback only by default; tailnet sync and the phone listener are off until turned on in Settings.
- **Updates**: the app's own updater (Ed25519-signed manifest, SHA-256, then Squirrel.Mac's code-signature check)
  replaces the app; the server's npm updater detects the bundle and refuses (`installation().kind === 'app'`).
- **Omarchy**: themes are designed and exported on a Mac; install and apply are refused off Linux, and the editor
  points to paired Omarchy devices instead.

## Revisit when

- Electron's stable line falls behind the browser floor for more than one release: reconsider C with a Chromium
  sidecar, or pin to Electron's newest stable branch immediately.
- `render.ts` gains a backend abstraction: then a single Chromium (Electron offscreen rendering) could replace the
  headless shell and save ~170 MB.
- Mac App Store: see [distribution](distribution.md); the App Sandbox conflicts with spawning the person's own agent
  CLIs, which is why direct distribution comes first.
