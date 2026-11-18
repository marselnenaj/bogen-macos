#!/bin/bash
# Run on the PC: puts Bogen on the Mac at <ssh-host> and pairs the two.
#   integrations/macos/deploy.sh <ssh-host> [--name <name for the Mac>]
# Builds if needed, copies the bundle and editor (no node_modules), runs install.sh over
# there, then pairs through `bogen peer`.

set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)
CLI_JS=${BOGEN_CLI_JS:-$REPO/packages/server/dist/cli.js}
DIST=$(dirname -- "$CLI_JS")
REMOTE_APP=.local/share/bogen-app

host=""
mac_name=""
while [ $# -gt 0 ]; do
  case $1 in
  --name)
    mac_name=${2:?--name needs a value}
    shift
    ;;
  -h | --help)
    echo "Usage: deploy.sh <ssh-host> [--name <name for the Mac>]"
    exit 0
    ;;
  -*)
    echo "Unknown option: $1" >&2
    exit 2
    ;;
  *) host=$1 ;;
  esac
  shift
done
[ -n "$host" ] || {
  echo "Usage: deploy.sh <ssh-host> [--name <name for the Mac>]" >&2
  exit 2
}

say() { printf '%s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die() {
  printf 'bogen: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null || die "Node is missing here."

# ---------------------------------------------------------------- build

step "Build"
stale=""
if [ ! -f "$CLI_JS" ] || [ ! -f "$DIST/editor/index.html" ]; then
  stale=missing
elif [ -z "${BOGEN_CLI_JS:-}" ] && [ -n "$(find "$REPO/packages/server/src" "$REPO/packages/core/src" "$REPO/apps/editor/src" -type f -newer "$CLI_JS" -print -quit)" ]; then
  stale=old
fi
if [ -n "$stale" ]; then
  if [ -n "${BOGEN_CLI_JS:-}" ]; then die "$CLI_JS or the editor next to it is missing."; fi
  say "  running npm run build"
  (cd "$REPO" && npm run build)
else
  say "  $CLI_JS is up to date"
fi

# ---------------------------------------------------------------- this side is ready to pair

step "This machine"
# Asked first, so that a server too old to pair stops this before anything changes on the Mac.
pair_json=$(node "$CLI_JS" peer pair --json) || die "Could not get pairing details from the Bogen server here. If it was built before device sync, restart it: systemctl --user restart bogen"
field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$pair_json" "$1"; }
pc_url=$(field url)
pc_token=$(field token)
pc_name=$(field name)
say "  $pc_name at $pc_url"

# ---------------------------------------------------------------- copy

step "Copy to $host"
stage=$(mktemp -d "${TMPDIR:-/tmp}/bogen-deploy.XXXXXX")
trap 'rm -rf "$stage"' EXIT
cp "$DIST/cli.js" "$DIST/shader-runtime.js" "$stage/"
cp -R "$DIST/editor" "$stage/editor"
# The portrait background plugin's own files, next to cli.js: where a flat deploy's server looks for them
# (pluginSourceDirFrom in packages/server/src/omarchy-portrait-runtime.ts). Its install stays refused on a Mac.
mkdir -p "$stage/integrations/omarchy/portrait-background"
cp "$REPO/integrations/omarchy/portrait-background/PortraitRuntime.js" "$REPO/integrations/omarchy/portrait-background/PortraitMapping.qml" "$stage/integrations/omarchy/portrait-background/"
mkdir "$stage/macos"
cp "$HERE/install.sh" "$HERE/uninstall.sh" "$HERE/bogen-open.in" "$HERE/document-types.plist" "$HERE/README.md" "$stage/macos/"
cp "$REPO/integrations/omarchy/assets/bogen.png" "$stage/macos/bogen.png"
chmod 755 "$stage/macos/install.sh" "$stage/macos/uninstall.sh"
# What the bundle leaves out or reads from disk at run time, pinned to what was built against.
deps=$(node -e 'const [r, ...n] = process.argv.slice(1); process.stdout.write(JSON.stringify(Object.fromEntries(n.map((d) => [d, require(`${r}/node_modules/${d}/package.json`).version]))))' "$REPO" puppeteer-core esbuild tailwindcss)
cat >"$stage/package.json" <<JSON
{ "name": "bogen-app", "private": true, "type": "module", "dependencies": $deps }
JSON

ssh "$host" "mkdir -p ~/$REMOTE_APP"
if command -v rsync >/dev/null && ssh "$host" 'command -v rsync' >/dev/null 2>&1; then
  rsync -az --delete --exclude node_modules "$stage/" "$host:$REMOTE_APP/"
else
  ssh "$host" "cd ~/$REMOTE_APP && find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +"
  tar -C "$stage" -cf - . | ssh "$host" "tar -C ~/$REMOTE_APP -xf -"
fi
say "  copied to ~/$REMOTE_APP"

# ---------------------------------------------------------------- install

step "Install on $host"
ssh "$host" "bash ~/$REMOTE_APP/macos/install.sh"

# ---------------------------------------------------------------- pair

step "Pair"
name_arg=""
if [ -n "$mac_name" ]; then
  # Quoted for the shell on the far side, then set before pairing so the PC sees it.
  quoted=$(printf '%s' "$mac_name" | sed "s/'/'\\\\''/g")
  name_arg="--name '$quoted'"
fi
if [ -n "$name_arg" ]; then
  ssh "$host" "~/$REMOTE_APP/bogen peer pair $name_arg >/dev/null"
fi
# On stdin, so the token shows up in no process list on either side.
printf '%s\n' "$pc_token" | ssh "$host" "BOGEN_PEER_TOKEN=\$(cat) ~/$REMOTE_APP/bogen peer add '$pc_url'"

step "Done"
ssh "$host" "~/$REMOTE_APP/bogen peer status"
say ""
say "Here: node $CLI_JS peer status"
