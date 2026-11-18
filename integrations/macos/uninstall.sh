#!/bin/bash
# Removes what install.sh added. Your designs in ~/.local/share/bogen are not touched.
# Pairings stay in there too, so a later install picks up where this left off.

set -u

APP_DIR=${BOGEN_APP_DIR:-$HOME/.local/share/bogen-app}
AGENT_LABEL=dev.bogen.server
AGENT_PLIST=$HOME/Library/LaunchAgents/$AGENT_LABEL.plist
BUNDLE=$HOME/Applications/Bogen.app
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
MANAGED='Managed by Bogen'

say() { printf '%s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || {
  say "This is for macOS." >&2
  exit 1
}

launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1 || launchctl bootout "user/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1
if [ -f "$AGENT_PLIST" ] && grep -q "$MANAGED" "$AGENT_PLIST"; then
  rm -f "$AGENT_PLIST"
  say "Removed $AGENT_PLIST"
fi

if [ -f "$BUNDLE/Contents/Resources/bogen-open" ]; then
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$BUNDLE" >/dev/null 2>&1
  rm -rf "$BUNDLE"
  say "Removed $BUNDLE"
fi

if [ -f "$HOME/.local/bin/bogen" ] && grep -q "$MANAGED" "$HOME/.local/bin/bogen"; then
  rm -f "$HOME/.local/bin/bogen"
  say "Removed ~/.local/bin/bogen"
fi

if [ -f "$APP_DIR/cli.js" ]; then
  rm -rf "$APP_DIR"
  say "Removed $APP_DIR"
fi

say "Your designs and pairings in ${BOGEN_HOME:-$HOME/.local/share/bogen} were not touched."
