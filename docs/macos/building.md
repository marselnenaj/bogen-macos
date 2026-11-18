# Building Bogen for macOS

The Mac app lives in [`apps/macos`](../../apps/macos). Why it is built this way is in
[ADR 0001](adr-0001-app-runtime.md). This page says how to build, test and package it, and which steps need a Mac.

## What runs where

| Step | Command (from the repository root unless noted) | Linux | macOS |
| --- | --- | --- | --- |
| Install | `npm ci`, then `cd apps/macos && npm ci` | yes (set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`) | yes |
| Typecheck | `npm run typecheck && npx tsc -p apps/macos/tsconfig.json` | yes | yes |
| Unit and lifecycle tests | `npx vitest run apps/macos` | yes | yes |
| Server and editor | `npm run build` | yes | yes |
| App folder (main, preload, pages) | `node apps/macos/scripts/build.mjs` | yes | yes |
| Pinned runtimes | `node scripts/fetch-runtime.mjs --arch arm64` (in `apps/macos`) | no | yes |
| Package `Bogen.app` | `node scripts/package.mjs --arch arm64 [--release --identity "…"]` | no | yes |
| Verify | `node scripts/verify-app.mjs --app release/dev/arm64/Bogen.app [--gui] [--release] [--notarized]` | no | yes |
| DMG (the installer) | `node scripts/make-dmg.mjs --arch arm64 [--release --identity "…"]` | no | yes |
| Verify the DMG | `node scripts/verify-dmg.mjs --dmg release/dev/Bogen-<v>-arm64-dev-unsigned.dmg [--release] [--notarized]` | no | yes |
| Notarize and staple | `node scripts/notarize.mjs --path <app or dmg> --keychain-profile <name>` | no | yes, with an Apple Developer account |
| Complete signed release | `cd apps/macos && BOGEN_RELEASE_KEY_FILE=… npm run release -- --identity "…" --keychain-profile <profile> --update-feed https://…` | no | yes |
| Update files | `BOGEN_RELEASE_KEY_FILE=… node scripts/make-update.mjs` | no | yes |

The macOS-only scripts stop at once on another OS with a message; they never half-run.

## Versions and pins

- `apps/macos/package.json` pins exact versions of Electron (45.2.3), `@electron/packager`, `@electron/osx-sign`,
  `@electron/notarize`, `@electron/fuses`, esbuild and TypeScript; `apps/macos/package-lock.json` locks the rest.
  The app is its own npm project, outside the root workspaces, so the Omarchy build and its lockfile are unchanged.
- `apps/macos/runtime.json` pins the bundled Node.js (26.13.0) and Chrome for Testing headless shell
  (156.0.8078.80), their download URLs and SHA-256 hashes, the bundle id, the minimum macOS (13.0) and the browser
  floor (156.0.8078.79). Electron 45.2.3 ships Chromium 156.0.8078.80.
- `fetch-runtime.mjs` checks Node against nodejs.org's `SHASUMS256.txt`, and both downloads against the pinned
  hashes. All four hashes (Node and headless shell, arm64 and x64) are pinned: Node's as listed in nodejs.org's
  `SHASUMS256.txt` for v26.13.0; the headless shell's (156.0.8078.80, revision 1706539, as listed in Chrome for
  Testing's `known-good-versions-with-downloads.json`) observed from the complete official archives over HTTPS. Chrome
  for Testing publishes no checksum file, so that hash is a pinned observation, not a Google-published checksum.
  CI and releases fetch with `--frozen`, which refuses any unpinned or different file. A hash not pinned yet (after a
  version bump) is printed as `UNPINNED` for review.
- Only a binary for the build machine's CPU is ever run during fetching or verification; the other architecture is
  checked by its digest alone.

## Architectures

Separate `arm64` and `x64` apps, not one universal app, which would double the ~500 MB bundle. Each is packaged
with `--arch`. The runtimes of the other CPU are downloaded and signed like the native ones; esbuild's binary for the
target CPU comes from the lock file's URL and is checked against the lock's integrity hash. `verify-app.mjs` runs the
functional checks only for the CPU it runs on and says so for the other one.

## Development run

```sh
npm ci && npm run build
cd apps/macos && npm ci && npx electron out/app   # after node scripts/build.mjs
```

A development run uses the `node` on your PATH and the checkout's `packages/server/dist/cli.js`. It keeps its data in
`~/Library/Application Support/Bogen` like the real app; set `BOGEN_APP_HOME=/some/temp/folder` (development builds
only, ignored by release builds) to keep a test away from your real designs.

## What the bundle contains

```text
Bogen.app/Contents/
  MacOS/Bogen                         Electron main (fuses: no RunAsNode, no NODE_OPTIONS, no inspect, asar only)
  Frameworks/                         Electron and its helpers
  Resources/app.asar                  main.cjs, preload.cjs, the app's own pages (integrity-checked)
  Resources/server/dist/              cli.js, shader-runtime.js, vectorize-worker.js, editor/
  Resources/server/node_modules/      puppeteer-core, esbuild (+ the target CPU's binary), tailwindcss and theirs
  Resources/runtime/node/bin/node     Node.js 26.13.0
  Resources/runtime/headless-shell/   Chromium 156 for exports and screenshots: chrome-headless-shell and every file
                                      of its archive (ABOUT, LICENSE.headless_shell, paks, ICU data, libraries)
  Resources/bin/bogen                 the command line launcher
  Resources/licenses/                 every license text that applies
```

## Signing order

`scripts/sign-lib.mjs` follows the plan in `scripts/sign-plan.mjs`, the same for a development (ad-hoc) and a
Developer ID build:

1. Refuse to start if any Mach-O outside a `.app`/`.framework` has its folder's name. codesign takes such a folder for a
   shallow bundle: the second native CI run failed exactly so, when the shell sat in
   `runtime/chrome-headless-shell/chrome-headless-shell` and its `ABOUT` file was reported as an unsigned
   "subcomponent". The shell now sits in `runtime/headless-shell/` (`runtime.json`, `layout`).
2. Sign Bogen's payload in `Contents/Resources` one file at a time, deepest first, libraries before executables:
   esbuild's binary, the bundled node, the shell's libraries, then the shell. Executables get `build/entitlements.plist`
   (only `allow-jit`); libraries get none. Release adds `--options runtime --timestamp`; development is ad-hoc with
   `--timestamp=none`.
3. Sign Electron's own code with `@electron/osx-sign`, which leaves the payload (already signed) and every non-Mach-O
   file alone, with explicit entitlements, never osx-sign's defaults: the app and its helper apps get
   `build/entitlements-shell.plist` (`allow-jit` and `device.audio-input`, for the editor's microphone), frameworks
   `build/entitlements.plist`.
4. Verify each payload file with `codesign --verify --strict`, then the app with `--verify --deep --strict`. `--deep`
   only ever verifies; nothing is signed with it.

Before any of this, packaging removes the App Transport Security exceptions of Electron's template `Info.plist` from
the app and every helper app (`scripts/plist-policy.mjs`; see [security](security.md#network)), so the signed plists are
the strict ones. `verify-app.mjs` checks the same again on the finished app, and that `ABOUT` and `LICENSE.headless_shell` are still next
to the shell. The plan is tested on any OS with Mach-O headers in an app-shaped tree (`apps/macos/test/sign-plan.test.ts`);
codesign itself runs only on macOS.

## The installer

Bogen installs the way Mac apps do: a disk image opens to one window with Bogen on the left, Applications on the
right, an arrow and a line on what comes next. Dragging is the install; nothing asks for an administrator password and
nothing runs from the image. `make-dmg.mjs` builds it, `verify-dmg.mjs` checks it, and the layout itself is plain data
in `scripts/dmg-layout.mjs`, tested on any OS (`apps/macos/test/dmg-layout.test.ts`).

| Part | What it is |
| --- | --- |
| Window | 660 × 400 points, no toolbar, sidebar, status or path bar, icon view with 128 pt icons, Bogen at (180, 200), Applications at (480, 200). Written as Finder's own `.DS_Store` records (`bwsp`, `icvp`, `Iloc`), without scripting Finder, so it needs no Automation permission or GUI session and is the same on every build. |
| Background | An SVG (`backgroundSvg`) in Bogen's colours, rendered by the pinned headless shell (sandbox on) at 1× and 2× and joined with `tiffutil -cathidpicheck` into `.background/background.tiff`; referenced by an alias record made from the mounted volume's real file IDs. Each icon name sits on a mid-grey plate, so Finder's black (Light) and white (Dark) labels both stay readable. |
| Words | Release: "Install Bogen", "Drag Bogen onto Applications", then open it from Applications, updating keeps designs and settings. Development: the same, plus that it is an ad-hoc signed development build for Macs you control and that a blocked first open is answered in System Settings › Privacy & Security (Open Anyway), never by disabling Gatekeeper. |
| Names | Volume `Bogen <version>` (release) or `Bogen <version> Dev`, file `Bogen-<version>-<arch>.dmg` or `…-dev-unsigned.dmg`. Version, architecture and product name are validated before any of them reaches a path or a tool; every tool gets arguments as an array, never a shell string. |
| Volume | HFS+, compressed read-only (ULFO), checksum verified; its own icon (`.VolumeIcon.icns`, kHasCustomIcon set); `Applications` a symbolic link to `/Applications`; nothing else at the top. |
| Build | A writable image mounted privately (`-nobrowse`, random mount point under `out/`), the app copied with `ditto` (signatures, symlinks, extended attributes), detached with retries and detached by force on any failure, then converted. A release DMG holds only an app signed with Developer ID and is signed itself before notarization. |

**First launch.** If Bogen is opened from the disk image, or from the read-only copy macOS makes of an app that was not
moved with Finder (App Translocation), it says so once and offers *Move to Applications*, where the person can write
`/Applications` without a password. Otherwise it explains dragging it to the Applications folder in their home folder.
It never asks for administrator rights (`src/main/install-location.ts`, `test/install-location.test.ts`).

**Updates keep data and are atomic.** Designs, settings and logs live in `~/Library/Application Support/Bogen` and
`~/Library/Logs/Bogen`, never inside the bundle. A manual update is dragging a newer Bogen onto the old one; Finder
replaces the bundle as a whole. The in-app updater hands a verified, signed zip to Squirrel.Mac, which unpacks it
beside the app, checks the code signature against the running app's designated requirement, and swaps the bundle only
after Bogen quits; if the swap fails the old bundle is put back and Bogen stays as it was ([distribution](distribution.md#updates)).

`verify-dmg.mjs` checks, on a Mac: the image's name, checksum and format; mounted read-only and privately, the top of
the volume, the Applications link, the background's 1× and 2× pictures, the volume icon flag, the window, view,
background alias and both icon positions; the app's bundle id, version and strict signature (ad-hoc for development,
Developer ID with `--release`); then an install by copying the app with `ditto` into a stand-in Applications folder
whose path has spaces and non-ASCII characters, the copy's signature, and a run of the copy's `bogen --version`.
`--notarized` adds the staple and Gatekeeper's verdict on the image. What it cannot judge is how the window looks:
that is on the [smoke checklist](smoke-checklist.md).

## CI

[`.github/workflows/macos.yml`](../../.github/workflows/macos.yml) runs on a GitHub-hosted arm64 Mac, by hand only
(`workflow_dispatch`), within 60 minutes, with no Apple credentials. Checkout credentials are not persisted; the job token is exposed only
to the opt-in draft upload step. It fetches and verifies
the runtimes, typechecks, runs a targeted set of tests that gate the app (not the whole suite), builds, packages a
development app, runs `verify-app.mjs --gui` (a real render in the bundled headless shell, a launch of the app in an
isolated home and a quit that must leave no process behind), builds the development DMG and checks it with
`verify-dmg.mjs` (layout, volume, signature, a drag install into a stand-in folder and a run of the copy), and keeps the
development DMG as a five-day private artifact. It does not sign for distribution, notarize or publish a release. With `private_draft=true`, it instead stores
the DMGs in an unpublished private draft, and refuses that upload if the repository is public. This is useful when
the Actions artifact quota is full. The job has `contents: write` for that optional final step.

Validation is fixture-only: `apps/macos/test/fixtures/offline-bin` holds stand-ins for `claude` and `codex` that report
"not installed", first on PATH in the test step and in every `verify-app.mjs` run (which also never asks the login
shell), so no real agent CLI starts and nothing reaches a model provider or telemetry. Tests that run an agent use
the repository's own stand-in CLIs.
