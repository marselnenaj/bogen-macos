# Bogen on a Mac

> **Superseded by the Mac app in [apps/macos](../../apps/macos)**, which needs no Node, Homebrew or browser and keeps
> its own data folder; see [docs/macos](../../docs/macos/building.md). These scripts stay for existing script
> installs. The app offers once to copy designs from `~/.local/share/bogen`, and refuses to share port 29990 with a
> running script install instead of stopping it.

The same Bogen as on the PC, syncing with it over Tailscale. Edit on either, also while
the other is asleep or offline; edits merge.

> **Not yet run on a real Mac.** These scripts were written without one. They pass
> `bash -n`, and their steps ran on Linux against stand-ins for `launchctl`, `osacompile`
> and `plutil`. Expect to fix something small the first time. Tell apart what failed
> with `~/Library/Logs/Bogen/server.log` and `bogen doctor`.

## You need

- Tailscale, signed in on both machines. The CLI may be `tailscale` on the PATH or inside
  `/Applications/Tailscale.app`; both are found.
- Node 22.18 or newer on the Mac: `brew install node@22`.
- Chrome, Chromium, Edge or Brave for the app window and for exports. Without one, Bogen
  opens in the default browser and exports do not work.

## Install from the PC

With SSH access to the Mac, from a checkout on the PC:

```bash
systemctl --user restart bogen           # after a build that has device sync
integrations/macos/deploy.sh my-macbook --name MacBook
```

That builds if needed, copies the bundle and editor to `~/.local/share/bogen-app` on the
Mac, runs `install.sh` there, and pairs the two. Run it again to update.

## Install on the Mac itself

From a checkout, after `npm install && npm run build`:

```bash
integrations/macos/install.sh
bogen peer add <url> --token <t>         # the command `bogen peer pair` printed on the PC
```

## What goes where

| What | Where |
|------|-------|
| Bundle, editor, `puppeteer-core` for exports | `~/.local/share/bogen-app/` |
| `bogen` wrapper | `~/.local/bin/bogen` |
| LaunchAgent running `bogen serve --tailnet` | `~/Library/LaunchAgents/dev.bogen.server.plist` |
| Logs | `~/Library/Logs/Bogen/server.log` |
| App, opens the window and `.bogen` files | `~/Applications/Bogen.app` |
| Your designs, device id and pairings | `~/.local/share/bogen/` |

## First-run prompts to expect

macOS may ask once whether Node may accept incoming connections, and on recent versions
whether it may reach the local network. Sync needs the first. `export_file` writes to
`~/Downloads/Bogen`, which macOS may also ask about.

## Uninstall

```bash
~/.local/share/bogen-app/macos/uninstall.sh
```

Your designs and pairings stay.
