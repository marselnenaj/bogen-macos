# Distributing Bogen for macOS

Decision: **direct distribution first**, as a Developer ID signed, notarized and stapled app in a DMG, with the app's
own signed updater. The Mac App Store is a later, separate decision. The source is public; the signed OTA files are
served from a separate HTTPS feed.

## One command on the signing Mac

After `npm ci` at the repository root and in `apps/macos`, use the existing release key whose public half is in
`packages/server/src/release-key.ts`. Do not generate a replacement key for an installed app.

```sh
cd apps/macos
BOGEN_RELEASE_KEY_FILE=/outside/the/repository/bogen-release.pem npm run release -- \
  --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile bogen-notary --update-feed https://example.com/bogen/macos
```

This builds both architectures by default (`--arch arm64` for Apple Silicon only), signs and notarizes the apps and
DMGs, verifies the bundles and installers, and creates the signed OTA ZIPs and manifest under `release/updates`.
It first checks the key against the app's trusted public keys, the signing identity, the clean tracked tree and the
notarytool profile. It never uploads to the update feed or publishes a GitHub release. The command completed with production Developer ID credentials for 0.1.1 in
[run 42826731629](https://github.com/marselnenaj/bogen-macos/actions/runs/42826731629). The separate validation
workflow still builds development artifacts only. The verifier's `--gui` mode is deliberately development-only;
release verification checks signatures, tickets, Gatekeeper and the native bundled server/render path.

Before each OTA release, set a version newer than the installed app using the root `npm run version:set -- <version>`,
update the changelog and commit it. Upload all immutable versioned ZIPs first, then publish the matching manifest and
signature together; retain the previous release for rollback. The HTTPS feed must be reachable without credentials.
GitHub Actions artifacts and draft releases cannot themselves be this feed.

An existing ad-hoc development app cannot bootstrap into the signed OTA channel. Install the first Developer ID
signed, notarized DMG manually; later releases use the same signing team, bundle ID and trusted release key.

## Hosted signed build and live feed

The feed is configured at `https://bogen.dev/updates/macos/`. Its `health.json` reports `otaReady` and the current
version. The data lives on the feed server outside the website's deployment folder, so a website deployment does
not remove it. Metadata responses use `Cache-Control: no-store`; versioned ZIPs are immutable and may be cached.

[macos-release.yml](../../.github/workflows/macos-release.yml) is an owner-triggered workflow on a GitHub-hosted Mac.
It imports a Developer ID certificate into a temporary keychain, configures `notarytool` with the existing App Store
Connect API key, runs app/OTA regression tests, invokes the complete signed release command and saves all DMGs,
ZIPs and signed metadata into an unpublished draft release, which only the repository's maintainers can see. Temporary signing files and the keychain are removed.
It does not publish the draft or activate the public feed. No signing secrets are available to push/PR validation.

Configuration in `marselnenaj/bogen-macos`:

| Name | Kind | State on 10 November 2026 |
| --- | --- | --- |
| `BOGEN_MACOS_UPDATE_FEED` | Variable | Configured: `https://bogen.dev/updates/macos` |
| `BOGEN_RELEASE_KEY_PEM` | Secret | Existing Ed25519 key verified against the embedded public key and configured |
| `APPLE_NOTARY_API_KEY_P8`, `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID` | Secrets | Existing Apple API access verified for certificate listing and notary history; configured |
| `MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD` | Secrets | Configured with the owner-issued G2 certificate |
| `BOGEN_MACOS_SIGNING_IDENTITY` | Variable | Configured: Developer ID Application: Marsel Nenaj (S4676778F2) |

The Account Holder issued the correct Developer ID Application G2 certificate on 10 November 2026. It matches the
prepared private key and verifies against Apple's G2 intermediate. Its subject is
`Developer ID Application: Marsel Nenaj (S4676778F2)` and its expiry is 10 December 2027. The private key remains
outside the repository; the encrypted certificate bundle and its password are GitHub secrets. No existing certificate was revoked and no Ed25519 release key was replaced. To create the next release,
bump and commit its version/changelog, then run:

```sh
gh workflow run macos-release.yml --repo marselnenaj/bogen-macos --ref main -f include_x64=true
```

The API issuer and private keys are never printed or committed. A working API key does not itself grant
Account Holder certificate-issuance rights.

## Publish verified OTA files

After the signed workflow succeeds, check the draft and download its assets into a local folder:

```sh
gh run watch <RUN_ID> --repo marselnenaj/bogen-macos --exit-status
gh release view macos-signed-<RUN_ID> --repo marselnenaj/bogen-macos --json assets --jq '.assets[] | [.name, .size, .digest] | @tsv'
gh release download macos-signed-<RUN_ID> --repo marselnenaj/bogen-macos --dir apps/macos/release/signed-<VERSION>-<SHORT_SHA>
(cd apps/macos/release/signed-<VERSION>-<SHORT_SHA> && sha256sum * | tee SHA256SUMS)
```

Expect six assets, whose SHA-256 sums must match GitHub's digests: `Bogen-<VERSION>-arm64.dmg`,
`Bogen-<VERSION>-x64.dmg`, `Bogen-<VERSION>-arm64.zip`, `Bogen-<VERSION>-x64.zip`, `bogen-macos-release.json` and
`bogen-macos-release.json.sig`. Do not publish the draft. Before the feed, install the arm64 DMG over the previous
release on a real Mac and run the [smoke checklist](smoke-checklist.md). Then, from `apps/macos`:

```sh
export BOGEN_UPDATE_HOST=<ssh-alias-of-the-feed-server> BOGEN_UPDATE_ROOT=<absolute-path-of-the-feed-on-it>
npm run publish-update -- --from release/signed-<VERSION>-<SHORT_SHA> --ssh-config ~/.ssh/config --dry-run
npm run publish-update -- --from release/signed-<VERSION>-<SHORT_SHA> --ssh-config ~/.ssh/config
```

The publisher needs an SSH alias for the feed server (`--host` or `BOGEN_UPDATE_HOST`) and the feed's folder there
(`--remote-root` or `BOGEN_UPDATE_ROOT`), not a private signing key. Before network writes it verifies
the manifest signature against Bogen's embedded production keys, its schema and safe ZIP names, and every ZIP's
size and SHA-256. Only those verified files are uploaded to a fresh staging directory. A remote lock serializes
publication; existing versioned ZIPs and manifests cannot be replaced with different bytes. The new manifest and
signature are prepared together and activated through one atomic `current` symlink replacement. All earlier
ZIPs and manifests are retained. In-progress client requests crossing that switch can fail signature verification
and must retry; they never install unchecked bytes. Subsequent releases must use a higher version. Check the public
feed after publication:

```sh
curl -fsS https://bogen.dev/updates/macos/health.json            # otaReady: true and the new version
curl -fsS https://bogen.dev/updates/macos/bogen-macos-release.json | head -c 400
curl -fsSI https://bogen.dev/updates/macos/Bogen-<VERSION>-arm64.zip | head -5
```

Release the engine of the same version before, or together with, the Mac update, so that the two changelogs agree.

The relevant server route uses `handle_path /updates/macos/*`: metadata roots at `updates/macos/current`, other
files at `updates/macos/assets`. The website's global cache default uses `?Cache-Control` so it cannot override
the feed's no-store/immutable policies. A validated Caddyfile backup is retained beside the server's Caddyfile.

## Direct distribution (Developer ID)

What a release takes, in order. Each step is a script in `apps/macos/scripts`; none of them publishes anything.

1. A clean checkout of the release commit; `npm ci && npm run build`; `cd apps/macos && npm ci`.
2. `node scripts/fetch-runtime.mjs --arch arm64 --frozen` (and `x64`): only pinned, verified runtimes.
3. `node scripts/package.mjs --arch arm64 --release --identity "Developer ID Application: Name (TEAMID)" --update-feed https://…`
   signs every Mach-O inside out ([signing order](building.md#signing-order)) with the hardened runtime, a secure
   timestamp and `com.apple.security.cs.allow-jit` on executables; since 0.2.0 Electron's app and helper
   executables also get `com.apple.security.device.audio-input` for the editor's microphone.
4. `node scripts/verify-app.mjs --app release/release/arm64/Bogen.app --release`.
5. `node scripts/notarize.mjs --path release/release/arm64/Bogen.app --keychain-profile <profile>` submits with
   `notarytool`, waits, prints Apple's log on rejection, and staples the ticket.
6. `node scripts/make-dmg.mjs --arch arm64 --release --identity "…"` refuses an app not signed with Developer ID, signs
   the DMG; then `node scripts/notarize.mjs --path release/release/Bogen-<v>-arm64.dmg --keychain-profile <profile>`.
7. `node scripts/verify-app.mjs --app … --release --notarized` checks the staple and Gatekeeper's verdict
   (`source=Notarized Developer ID`); `node scripts/verify-dmg.mjs --dmg release/release/Bogen-<v>-arm64.dmg --release
   --notarized` checks the installer the same way and installs a copy into a stand-in folder.
8. `BOGEN_RELEASE_KEY_FILE=… node scripts/make-update.mjs` writes the update zips and the signed manifest.

The first signed release completed those steps for both architectures. All four Apple submissions (two apps and
two DMGs) were accepted, stapled and validated. The built-in release key, Developer ID identity, Apple API
notarization access and HTTPS feed are configured. The first signed DMG is installed manually; old ad-hoc development
builds cannot install signed OTA updates. Development builds remain available through the separate validation workflow.

## Updates

The updater, trusted public key and HTTPS feed are active since signed version 0.1.1. Existing development builds
still say "updates come with a new download" until replaced manually with the first signed DMG. With both in place, a release build **checks** by itself once a day (it can be
turned off in Settings) and **installs only after the person clicks**; there is no silent automatic install. The steps
(`src/main/update-core.ts`):

1. GET `bogen-macos-release.json` and its `.sig` from the feed (public HTTPS, no credentials, no identifiers sent),
   each read with a small size cap enforced while streaming.
2. Verify the Ed25519 signature against a key built into the app (the same key list as `bogen verify`).
3. If newer, built for this CPU, and this Mac's macOS is at least the release's `minimumSystemVersion` (otherwise it
   says which macOS it needs and downloads nothing): on the person's click, download the zip and require the exact
   size and SHA-256 from the signed manifest. A full disk or an unwritable folder removes the partial file and says so.
4. Hand it to Squirrel.Mac from a one-shot `127.0.0.1` server; Squirrel refuses it unless its code signature
   satisfies the running app's designated requirement (same Developer ID team).
5. Install on restart, after the person clicks. Squirrel.Mac's installer swaps the whole bundle after Bogen quits and
   puts the old one back if that fails; designs and settings in `~/Library/Application Support/Bogen` are never in the
   bundle, so neither an update nor a reinstall from the DMG touches them.

The feed is a separate public location (any static HTTPS host), not GitHub. The app never carries a GitHub token. The server's own `bogen update` (for npm installs) recognises the bundle and refuses to
touch it.

## Mac App Store: not now

| Requirement | Effect on Bogen |
| --- | --- |
| App Sandbox is mandatory | Bogen runs the person's own `claude` and `codex` from their PATH, reads their projects for live mode and code components, and writes `~/.claude.json`/`~/.codex/config.toml` when asked to connect an agent. A sandboxed app can do none of that without a different design (helper tools with security-scoped bookmarks, no arbitrary executables). |
| No downloading or running of code outside the bundle | Agent CLIs are exactly that. |
| Review of every update | Slower security updates of the bundled Chromium. |

So a Store version would be a reduced edition (no local agent runs) or need a sandbox-compatible agent design. That
is a product decision for later; it does not block direct distribution.
