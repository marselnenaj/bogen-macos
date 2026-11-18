# Manual smoke checklist for Bogen.app

For a person on a real Mac, after `verify-app.mjs` passed. Use a test user account or a Mac whose Bogen data you can
lose, and write down the macOS version, the Mac (Apple silicon or Intel, memory), the app build and the result of each
line. Keep the browser security rules: never start a browser or the headless shell without its sandbox.

## Install and first launch

- [ ] Open the DMG: one window, no toolbar or sidebar, the background fills it (no white strip, no scroll bars), Bogen
      left and Applications right with the arrow between, both names readable on their plates in Light and in Dark
      Mode, the volume on the desktop and in the sidebar shows Bogen's icon. A development DMG says so in its window.
- [ ] Drag Bogen to Applications, open it from Launchpad. A release build opens without a Gatekeeper warning; a dev
      build is expected to warn and is only for Macs you control. No administrator password is asked.
- [ ] Open Bogen straight from the mounted DMG: it offers Move to Applications once; Move relaunches it from
      Applications. As a standard (non-admin) user it explains the home Applications folder instead and asks for no
      password.
- [ ] Drag a newer DMG's Bogen onto the installed one and Replace: designs and settings are all still there.
- [ ] The window shows "Starting Bogen…" and then the editor, never a blank window. Menu bar: Bogen, File, Edit, View,
      Window, Help, and Bogen's icon on the right.
- [ ] With designs in `~/.local/share/bogen` from the script install: the import offer appears once; "Copy My Designs"
      copies them, the originals are unchanged.
- [ ] `~/Library/Application Support/Bogen/data`, `~/Library/Logs/Bogen/backend.log` exist; nothing new in
      `~/.local/share/bogen`.

## Native behaviour

- [ ] ⌘N makes a design; ⌘O opens a `.bogen`; double-clicking a `.bogen` in Finder opens it, also while Bogen is closed.
- [ ] ⇧⌘S writes a `.bogen` through the save panel; it opens again on another Mac or on Omarchy.
- [ ] Export PNG, PDF, SVG and MP4 from the editor: each asks where to save with the native panel and opens correctly.
- [ ] ⌘Z / ⇧⌘Z undo and redo canvas edits (not just text fields); Edit › Undo from the menu does the same.
- [ ] ⌘C / ⌘V copy and paste layers, also between two designs and into another app as an image or text.
- [ ] ⌘A selects all layers on the canvas, and all text inside a text field.
- [ ] ⌘, opens Settings; Bogen › About shows the version, "free and open source software under GPL-3.0-or-later"
      and the source code address.
- [ ] Close the window (⌘W): the app stays in the Dock; clicking the Dock icon reopens it at the same size and place.
- [ ] Fullscreen (⌃⌘F) works; quitting and reopening restores the frame; unplugging the display it was on recentres it.
- [ ] A link to a website in a design opens in the default browser, not inside Bogen.

## Menu bar icon

- [ ] Bogen's mark (a folded page with a prompt) appears in the menu bar at launch. It is sharp on a Retina display and
      on a non-Retina external display, dark on a light menu bar and light on a dark one (switch System Settings ›
      Appearance, and try a light and a dark wallpaper with menu bar tinting), and highlighted while its menu is open.
- [ ] Hovering shows "Bogen: Server running on 127.0.0.1:<port>"; VoiceOver (⌘F5) reads the item and opens its menu
      with VO-Space.
- [ ] The menu: Open Bogen, New Design, the server line, the agent line, Settings…, Hide Menu Bar Icon, Quit Bogen.
      While a run is going, the agent line names the agent and the design; idle it says No agent is working.
- [ ] Open Bogen brings the window forward from another app, also after ⌘W closed it. New Design opens a new design
      in the window. With the server stopped or failing, New Design is greyed out and the line says so.
- [ ] Close the window, switch apps, click the Dock icon, open a `.bogen` from Finder, launch Bogen a second time:
      there is still exactly one Bogen icon in the menu bar.
- [ ] Hide Menu Bar Icon: the icon goes, a dialog says how to get it back, the Dock icon stays. Settings › General ›
      Show Bogen in the menu bar brings it back at once and after a relaunch. ⌘-drag it to another place: it is
      there again after a relaunch.
- [ ] Quit Bogen from the menu bar during a run: the same confirmation as ⌘Q; after quitting the icon is gone and
      Activity Monitor shows no `node`, `claude`, `codex` or `chrome-headless-shell` from Bogen. With a `bogen serve`
      started in Terminal on another port, quitting the app leaves that server running.
- [ ] Idle with the menu closed for ten minutes: Activity Monitor shows no CPU use from Bogen beyond noise, and
      `~/Library/Logs/Bogen/app.log` has no repeated status requests.

## Mac themes

- [ ] Home shows Design a Mac theme, not Design an Omarchy theme. New Mac theme opens a file with the banner "Mac
      theme New Mac theme: desktop and your apps".
- [ ] The wallpaper boards are named after this Mac's displays (Built-in Retina Display, external ones). Change the
      display's scaled resolution in System Settings › Displays and make another theme: its size follows (these are
      backing pixels; the panel says so). Presets added by an agent show "native resolution".
- [ ] "What it changes, export" lists each capability before any click; nothing says the menu bar, Dock or Finder
      change. Export saves `<name>-mac-theme.zip` through the save panel; Finder opens it to a folder with the
      manifest, README, PNG wallpapers and the app tokens. The wallpaper PNGs have the listed sizes (Preview › Tools ›
      Show Inspector).
- [ ] Set one wallpaper by hand in System Settings › Wallpaper › Add Photo…: it fills the display. Bogen itself
      changed no setting (System Settings shows your previous appearance and accent until you change them).
- [ ] Drag `app/Colors.xcassets` into an Xcode project: each colour set shows an Any and a Dark appearance.
- [ ] Open a synced Omarchy theme file: its banner says "Omarchy theme for Omarchy Linux", it is not converted, and the
      Mac theme dialog is not offered for it.

## Agents

- [ ] With `claude` installed through npm, Homebrew or the Claude installer, and Bogen opened from the Dock: the chat
      beside the canvas lists Claude as available. Same for `codex` and `opencode`.
- [ ] Ask the agent for a change in the chat (⌘K focuses it, ⌥⌘3 shows or hides it): it draws, the answer renders as
      markdown, Stop shows the time, and Undo for that agent reverts it in one step.
- [ ] Settings › Connect Claude Code, then in Terminal `claude` with the Bogen MCP server: it reaches this app's
      designs. Quit Bogen and run it again: `bogen mcp` opens Bogen in the background. The same with Connect Codex
      and Connect OpenCode (`~/.config/opencode/opencode.json` names the app's launcher).
- [ ] After Settings › Command line tool, `bogen setup` in Terminal lists the agents, says which have Bogen, and
      nothing it prints mentions install.sh or Omarchy.
- [ ] Quit (⌘Q) during a run: Bogen asks first; after quitting, Activity Monitor shows no `claude`, `codex`, `node` or
      `chrome-headless-shell` from Bogen.
- [ ] `kill -9` the backend `node` in Activity Monitor during a run: Bogen restarts it, and the agent's process is gone.

## Engine 0.2.0 features

- [ ] Speak instead of typing, without a model: the chat's microphone shows "Speech needs a local model" with the
      Homebrew line (`brew install whisper-cpp ffmpeg`), and nothing about Voxtype or Omarchy.
- [ ] With whisper.cpp and ffmpeg from Homebrew and `ggml-base.bin` in `~/.local/share/whisper.cpp/models`, Check
      again finds whisper.cpp. The first recording brings up macOS's microphone prompt naming Bogen with its usage
      text; after Allow, the words land in the field. In a release build too (hardened runtime, audio input).
- [ ] Don't Allow (or turn Bogen off in System Settings › Privacy & Security › Microphone): the editor says the
      microphone is blocked and points to System Settings. Bogen never asks for the camera.
- [ ] `icon_search` with `set: "tabler"` and `"all"` from an agent, and icon_insert of `tabler:home`: icons appear.
- [ ] A font from an agent (`font_create`, `font_glyphs_set`, `font_build`): the WOFF2 is used by text and in a PNG
      export. A release build especially, since WebAssembly compiles under the hardened runtime.
- [ ] Accessibility and legal check on a page: the report lists axe-core's version and exports as HTML and PDF.
- [ ] Code export to Vue, Svelte and SwiftUI writes files; the SwiftUI file opens in Xcode.

## Large files and memory

- [ ] Make the big fixture in a checkout: `npx tsx scripts/gen-perf-fixture.ts <folder> --artboards=24` writes a data
      folder of about 10,000 layers. Copy it to `<tmp>/Library/Application Support/Bogen/data` and start a development
      build with `BOGEN_APP_HOME=<tmp> /path/to/Bogen.app/Contents/MacOS/Bogen` (or open a `.bogen` export of such a
      file with ⌘O in a release build). Artboards appear progressively, panning stays smooth, edits save.
- [ ] Edit while previews render; Activity Monitor shows at most one headless shell, gone a minute after the last render.
- [ ] Under memory pressure (Activity Monitor's graph yellow or red, for example with a memory-hungry app on an 8 GB
      Mac): background previews pause (the server log says so) and resume when it is green; nothing freezes.

## Sync and Omarchy

- [ ] Turn on device sync under Devices, pair with an Omarchy PC over Tailscale, edit on both, also with one offline:
      edits merge. macOS may ask whether Bogen may find devices on the local network.
- [ ] Filter Home by Omarchy themes, then design an Omarchy theme on the Mac: Install and Apply are not offered; the dialog names the paired Omarchy
      device; the theme file appears there, and Install and Apply work on the PC.

## Updates (release builds with a feed only)

- [ ] Check for Updates with a newer signed release on the feed: it downloads, asks to restart, and the new version
      runs. With a tampered zip or manifest it refuses and keeps the old app.
