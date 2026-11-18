#!/bin/bash
# Installs Bogen on a Mac from an app folder (~/.local/share/bogen-app) that holds the
# built cli.js and editor. deploy.sh puts it there. From a repository checkout this
# copies packages/server/dist there first. Safe to run again. Your designs in
# ~/.local/share/bogen are not touched.
#
# Written for the bash 3.2 and BSD tools that a Mac ships with.

set -u

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=${BOGEN_APP_DIR:-$HOME/.local/share/bogen-app}
BIN_DIR=$HOME/.local/bin
AGENT_LABEL=dev.bogen.server
AGENT_PLIST=$HOME/Library/LaunchAgents/$AGENT_LABEL.plist
LOG_DIR=$HOME/Library/Logs/Bogen
BUNDLE=$HOME/Applications/Bogen.app
PORT=${BOGEN_PORT:-29990}
MANAGED='Managed by Bogen'
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
PLISTBUDDY=${PLISTBUDDY:-/usr/libexec/PlistBuddy}
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

WITH_SERVICE=1
WITH_APP=1
while [ $# -gt 0 ]; do
  case $1 in
  --no-service) WITH_SERVICE=0 ;;
  --no-app) WITH_APP=0 ;;
  -h | --help)
    echo "Usage: install.sh [--no-service] [--no-app]"
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 2
    ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'bogen: %s\n' "$*" >&2
  exit 1
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

[ "$(uname -s)" = Darwin ] || die "This installer is for macOS. On Omarchy, use integrations/omarchy/install.sh."

# ---------------------------------------------------------------- Node

node_ok() {
  local version major minor
  version=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${version%%.*}
  minor=${version#*.}
  minor=${minor%%.*}
  case $major$minor in *[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$MIN_NODE_MAJOR" ] || { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }
}

# A command over ssh and a LaunchAgent both get a short PATH, so this looks where Node
# managers put it, and through the login shell. The first new enough one wins.
find_node() {
  local candidate login
  login=$("${SHELL:-/bin/zsh}" -lc 'command -v node' 2>/dev/null | tail -n 1)
  for candidate in "$(command -v node 2>/dev/null)" "$login" /opt/homebrew/bin/node /usr/local/bin/node \
    /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node "$HOME/.volta/bin/node" \
    "$HOME"/.local/share/mise/installs/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if node_ok "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

step "Node"
NODE=$(find_node) || die "Bogen needs Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer, and none was found. Install it, for example: brew install node@22"
say "  using $NODE ($("$NODE" -v))"
NODE_DIR=$(dirname -- "$NODE")

# ---------------------------------------------------------------- app folder

step "App folder"
REPO_DIST=$HERE/../../packages/server/dist
if [ ! -f "$APP_DIR/cli.js" ] && [ -f "$REPO_DIST/cli.js" ]; then
  mkdir -p "$APP_DIR"
  cp -R "$REPO_DIST/." "$APP_DIR/" || die "Could not copy $REPO_DIST to $APP_DIR"
  say "  copied $REPO_DIST"
fi
[ -f "$APP_DIR/cli.js" ] || die "$APP_DIR/cli.js is missing. Run deploy.sh from your other machine, or run npm run build in a checkout."
[ -f "$APP_DIR/editor/index.html" ] || warn "$APP_DIR/editor is missing, so the canvas will not open."

# cli.js is an ES module, which Node only knows from this file. puppeteer-core is left out
# of the bundle by design: it is what exports and screenshots run on.
if [ ! -f "$APP_DIR/package.json" ]; then
  cat >"$APP_DIR/package.json" <<JSON
{ "name": "bogen-app", "private": true, "type": "module", "dependencies": { "puppeteer-core": "*" } }
JSON
fi
if [ -d "$APP_DIR/node_modules/puppeteer-core" ]; then
  say "  puppeteer-core is there"
elif [ -x "$NODE_DIR/npm" ]; then
  say "  installing puppeteer-core, for exports and screenshots"
  (cd "$APP_DIR" && PATH="$NODE_DIR:$PATH" "$NODE_DIR/npm" install --omit=dev --no-audit --no-fund --silent) ||
    warn "npm install failed. Sync and the editor work; exports and screenshots do not until: cd $APP_DIR && npm install"
else
  warn "no npm next to $NODE. Sync and the editor work; exports and screenshots do not until: cd $APP_DIR && npm install"
fi

# ---------------------------------------------------------------- CLI

step "CLI"
wrapper_body="#!/bin/sh
# $MANAGED integrations/macos.
exec '$NODE' '$APP_DIR/cli.js' \"\$@\""
printf '%s\n' "$wrapper_body" >"$APP_DIR/bogen"
chmod 755 "$APP_DIR/bogen"
mkdir -p "$BIN_DIR"
if [ -e "$BIN_DIR/bogen" ] && ! grep -q "$MANAGED" "$BIN_DIR/bogen" 2>/dev/null; then
  warn "$BIN_DIR/bogen is not ours, so it was left alone. This one is at $APP_DIR/bogen"
else
  printf '%s\n' "$wrapper_body" >"$BIN_DIR/bogen"
  chmod 755 "$BIN_DIR/bogen"
  say "  wrote $BIN_DIR/bogen"
fi
case :$PATH: in
*":$BIN_DIR:"*) ;;
*) warn "$BIN_DIR is not on your PATH. Add it in ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# ---------------------------------------------------------------- service

if [ "$WITH_SERVICE" = 1 ]; then
  step "LaunchAgent"
  mkdir -p "$(dirname -- "$AGENT_PLIST")" "$LOG_DIR"
  port_args=""
  if [ "$PORT" != 29990 ]; then port_args="    <string>--port</string>
    <string>$PORT</string>
"
  fi
  cat >"$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- $MANAGED integrations/macos -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$APP_DIR/cli.js")</string>
    <string>serve</string>
    <string>--tailnet</string>
${port_args}  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$NODE_DIR"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/server.log")</string>
</dict>
</plist>
PLIST
  plutil -lint "$AGENT_PLIST" >/dev/null || die "$AGENT_PLIST is not valid"
  DOMAIN=gui/$(id -u)
  launchctl bootout "$DOMAIN/$AGENT_LABEL" >/dev/null 2>&1
  if ! launchctl bootstrap "$DOMAIN" "$AGENT_PLIST"; then
    # Over ssh with nobody logged in at the Mac there is no gui domain.
    DOMAIN=user/$(id -u)
    launchctl bootstrap "$DOMAIN" "$AGENT_PLIST" || die "launchctl could not load $AGENT_PLIST"
  fi
  say "  loaded $AGENT_LABEL in $DOMAIN"
  up=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then
      up=1
      break
    fi
    sleep 1
  done
  [ "$up" = 1 ] || die "The server did not answer on port $PORT. See $LOG_DIR/server.log"
  say "  the server answers on http://127.0.0.1:$PORT"
fi

# ---------------------------------------------------------------- app

make_bundle() {
  local stage script icon_source icons
  stage=$(mktemp -d "${TMPDIR:-/tmp}/bogen-app.XXXXXX") || return 1
  script=$stage/applet.applescript
  # An app bundle gets a double-clicked document as an Apple Event and not as an argument,
  # so a plain shell script could not open .bogen files. An applet can.
  cat >"$script" <<'APPLESCRIPT'
on run
	do shell script quoted form of (POSIX path of (path to me) & "Contents/Resources/bogen-open")
end run

on open theFiles
	repeat with oneFile in theFiles
		do shell script quoted form of (POSIX path of (path to me) & "Contents/Resources/bogen-open") & " " & quoted form of (POSIX path of oneFile)
	end repeat
end open
APPLESCRIPT
  osacompile -o "$stage/Bogen.app" "$script" || return 1
  sed -e "s|@PORT@|$PORT|" "$HERE/bogen-open.in" >"$stage/Bogen.app/Contents/Resources/bogen-open"
  chmod 755 "$stage/Bogen.app/Contents/Resources/bogen-open"

  icon_source=$HERE/bogen.png
  [ -f "$icon_source" ] || icon_source=$HERE/../omarchy/assets/bogen.png
  if [ -f "$icon_source" ] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
    icons=$stage/bogen.iconset
    mkdir -p "$icons"
    for size in 16 32 128 256 512; do
      sips -z "$size" "$size" "$icon_source" --out "$icons/icon_${size}x${size}.png" >/dev/null 2>&1
      sips -z $((size * 2)) $((size * 2)) "$icon_source" --out "$icons/icon_${size}x${size}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns -o "$stage/Bogen.app/Contents/Resources/applet.icns" "$icons" 2>/dev/null || warn "could not make the icon"
  fi

  if [ -x "$PLISTBUDDY" ]; then
    "$PLISTBUDDY" -c "Delete :CFBundleIdentifier" "$stage/Bogen.app/Contents/Info.plist" >/dev/null 2>&1
    "$PLISTBUDDY" -c "Add :CFBundleIdentifier string dev.bogen.app" "$stage/Bogen.app/Contents/Info.plist" ||
      warn "could not set the bundle id"
    "$PLISTBUDDY" -c "Merge $HERE/document-types.plist" "$stage/Bogen.app/Contents/Info.plist" ||
      warn "could not add the .bogen document type"
  else
    warn "no PlistBuddy, so Bogen.app does not claim .bogen files"
  fi
  # Editing the bundle broke the signature osacompile made.
  command -v codesign >/dev/null && codesign --force --deep -s - "$stage/Bogen.app" >/dev/null 2>&1

  mkdir -p "$(dirname -- "$BUNDLE")"
  rm -rf "$BUNDLE"
  mv "$stage/Bogen.app" "$BUNDLE" || return 1
  rm -rf "$stage"
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$BUNDLE" >/dev/null 2>&1
  return 0
}

if [ "$WITH_APP" = 1 ]; then
  step "Bogen.app"
  if ! command -v osacompile >/dev/null; then
    warn "no osacompile, so no Bogen.app. Open http://127.0.0.1:$PORT in a browser"
  elif make_bundle; then
    say "  wrote $BUNDLE"
  else
    warn "could not make Bogen.app. Open http://127.0.0.1:$PORT in a browser"
  fi
fi

step "Done"
say "Sync with another device: bogen peer pair, or bogen peer add <url> --token <t>"
say "Undo with: $APP_DIR/macos/uninstall.sh"
