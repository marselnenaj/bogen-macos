# Bogen for macOS as a product

## Free and open source

- Bogen for macOS is free, like Bogen for Omarchy. There is nothing to buy, no account, no activation and nothing
  locked. Every feature works.
- The source is public at [github.com/marselnenaj/bogen-macos](https://github.com/marselnenaj/bogen-macos).
- Distribution: direct download, Developer ID signed and notarized, with the app's own signed updater
  ([distribution](distribution.md)).
- People use their own agents and their own plans (Claude Code, Codex, OpenCode). Bogen includes no model access
  and needs no Bogen account.

## What the app says

- Settings and the About panel say: "Bogen for macOS is free and open source software under GPL-3.0-or-later." and
  where the source code is.
- Help › Acknowledgements lists the licence of Bogen and of every bundled component.
- `apps/macos/test/app-units.test.ts` checks that this copy stays free of prices, purchases and activation.

## Licensing of the code

- The whole repository, the Mac app included, is licensed under GPL-3.0-or-later ([LICENSE](../../LICENSE)), with
  the additional permission for exported work in [LICENSE-EXCEPTION.md](../../LICENSE-EXCEPTION.md): the code Bogen
  writes into your exported designs, sites and themes is yours to license as you like. Earlier MIT notices remain
  applicable to their respective code.
- `LICENSE`, `LICENSE-EXCEPTION.md` and `THIRD_PARTY_NOTICES.md` ship inside the app (`Resources/licenses`),
  alongside the licenses of Electron, Chromium, Node.js and the headless shell.
- FFmpeg is not bundled (its licensing and codec patents are a separate matter). GIF replays, AVIF with
  transparency and voice transcription use the person's own ffmpeg when there is one, and say so when there is not.
