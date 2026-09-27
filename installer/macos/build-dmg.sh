#!/usr/bin/env bash
# build-dmg.sh - build Relaymote.app, a DMG and a portable tarball for macOS.
#
#   installer/macos/build-dmg.sh            # arch of this Mac
#   ARCH=x64 installer/macos/build-dmg.sh   # or arm64; the app is plain JavaScript, so either
#                                           # arch can be built on either Mac
#   NODE_VERSION=22.x.y ...                 # pin Node (default: latest 22.x LTS)
#   (or: npm run build:mac)
#
# Output in dist/:
#   Relaymote-<version>-<arch>.dmg                   drag Relaymote.app to Applications
#   Relaymote-<version>-macos-<arch>-portable.tar.gz unpack anywhere, run ./baton or start-baton.command
#
# Unsigned and not notarized: see installer/RELEASE_NOTES.md for how to open it the first time.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$REPO/dist"
CACHE="$DIST/cache"
WORK="$DIST/build/mac"
NODE_MAJOR="${NODE_MAJOR:-22}"
case "${ARCH:-$(uname -m)}" in
  arm64|aarch64) ARCH=arm64 ;;
  x64|x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported ARCH ${ARCH:-}" >&2; exit 1 ;;
esac
VERSION="$(node -p "require('$REPO/package.json').version")"
say() { echo "[build-mac] $*"; }

# --- 1. Node.js runtime, verified -------------------------------------------------------------
mkdir -p "$CACHE"
BASE=https://nodejs.org/dist
if [ -z "${NODE_VERSION:-}" ]; then
  NODE_VERSION="$(curl -fsSL "$BASE/latest-v$NODE_MAJOR.x/SHASUMS256.txt" | sed -n "s/.*node-v\($NODE_MAJOR\.[0-9]*\.[0-9]*\)-darwin-$ARCH\.tar\.gz$/\1/p" | head -1)"
  [ -n "$NODE_VERSION" ] || { echo "could not find the latest Node $NODE_MAJOR.x release" >&2; exit 1; }
fi
NODE_NAME="node-v$NODE_VERSION-darwin-$ARCH"
TARBALL="$CACHE/$NODE_NAME.tar.gz"
EXPECTED="$(curl -fsSL "$BASE/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$NODE_NAME.tar.gz" '$2 == f { print $1 }')"
[ -n "$EXPECTED" ] || { echo "SHASUMS256.txt for v$NODE_VERSION has no entry for $NODE_NAME.tar.gz" >&2; exit 1; }
sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
if [ ! -f "$TARBALL" ] || [ "$(sha "$TARBALL")" != "$EXPECTED" ]; then
  say "downloading $NODE_NAME.tar.gz"
  curl -fsSL -o "$TARBALL" "$BASE/v$NODE_VERSION/$NODE_NAME.tar.gz"
fi
ACTUAL="$(sha "$TARBALL")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA256 mismatch for $NODE_NAME.tar.gz: expected $EXPECTED, got $ACTUAL" >&2
  rm -f "$CACHE/$NODE_NAME.tar.gz"
  exit 1
fi
say "Node $NODE_VERSION ($ARCH) verified"

# --- 2. Stage the app -------------------------------------------------------------------------
rm -rf "$REPO/dist/build/mac"
APPDIR="$WORK/app"            # the app itself; becomes Relaymote.app/Contents/Resources/app
mkdir -p "$APPDIR/runtime"
# Everything at the top level ships except development-only folders and files.
for f in "$REPO"/* "$REPO"/.[!.]*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    .git|.github|.claude|.graphify|node_modules|dist|installer|test|docs|scratchpad|.gitignore|.gitattributes|.env|*.log|*.bak*) continue ;;
  esac
  cp -R "$f" "$APPDIR/"
done
(cd "$APPDIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
tar -xzf "$TARBALL" -C "$WORK" "$NODE_NAME/bin/node" "$NODE_NAME/LICENSE"
mv "$WORK/$NODE_NAME/bin/node" "$APPDIR/runtime/node"
mv "$WORK/$NODE_NAME/LICENSE" "$APPDIR/runtime/LICENSE-node.txt"
rm -rf "$WORK/$NODE_NAME"
chmod +x "$APPDIR/runtime/node"

cat > "$APPDIR/baton" <<'EOF'
#!/bin/sh
# baton - the Relaymote command line, run with the Node.js bundled next to it.
D="$(cd "$(dirname "$0")" && pwd)"
exec "$D/runtime/node" "$D/bin/baton.js" "$@"
EOF
cat > "$APPDIR/start-baton.command" <<'EOF'
#!/bin/sh
# Double-click in Finder: starts Relaymote in the background and opens it in your browser.
D="$(cd "$(dirname "$0")" && pwd)"
"$D/runtime/node" "$D/bin/baton.js" open
EOF
chmod +x "$APPDIR/baton" "$APPDIR/start-baton.command"

# --- 3. Relaymote.app -----------------------------------------------------------------------------
BUNDLE="$WORK/dmg/Relaymote.app"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cat > "$BUNDLE/Contents/MacOS/Relaymote" <<'EOF'
#!/bin/bash
# Relaymote.app launcher: the first launch runs `baton setup` (turns on Claude Desktop's Developer Mode,
# registers the tools, starts Relaymote); later launches start Relaymote if needed and open it.
APP="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
DATA="${BATON_HOME:-$HOME/.baton}"
# Finder starts apps with a bare PATH; add the usual places the `claude` CLI lives.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.claude/local:$PATH"
mkdir -p "$DATA/state"
LOG="$DATA/state/launcher.log"
echo "--- $(date) Relaymote.app" >>"$LOG"
if [ ! -f "$DATA/state/app-setup-done" ]; then
  "$APP/runtime/node" "$APP/bin/baton.js" setup >>"$LOG" 2>&1 && touch "$DATA/state/app-setup-done"
else
  "$APP/runtime/node" "$APP/bin/baton.js" open >>"$LOG" 2>&1
fi
EOF
chmod +x "$BUNDLE/Contents/MacOS/Relaymote"
cp -R "$APPDIR" "$BUNDLE/Contents/Resources/app"

ICON_KEY=""
if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  SET="$WORK/baton.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$REPO/assets/logo-1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d "$REPO/assets/logo-1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$BUNDLE/Contents/Resources/baton.icns"
  ICON_KEY="<key>CFBundleIconFile</key><string>baton</string>"
else
  say "iconutil/sips not found - Relaymote.app will use the generic icon"
fi

cat > "$BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Relaymote</string>
  <key>CFBundleDisplayName</key><string>Relaymote</string>
  <key>CFBundleIdentifier</key><string>org.baton-cc.baton</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Relaymote</string>
  $ICON_KEY
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHumanReadableCopyright</key><string>MIT License, Relaymote contributors</string>
</dict>
</plist>
EOF

cat > "$WORK/dmg/If macOS will not open Relaymote.txt" <<'EOF'
Relaymote is not signed with an Apple Developer ID, so macOS blocks the first launch.

1. Drag Relaymote.app into Applications.
2. Either right-click Relaymote.app > Open > Open (macOS 14 and older), or try to open it once and then
   go to System Settings > Privacy & Security and click "Open Anyway" (macOS 15 and newer).
   Or, in Terminal:  xattr -dr com.apple.quarantine /Applications/Relaymote.app

The command line lives inside the app:
   /Applications/Relaymote.app/Contents/Resources/app/baton status
EOF
ln -s /Applications "$WORK/dmg/Applications"

# --- 4. DMG and portable tarball ----------------------------------------------------------------
DMG="$DIST/Relaymote-$VERSION-$ARCH.dmg"
PORTABLE="$DIST/Relaymote-$VERSION-macos-$ARCH-portable.tar.gz"
rm -f "$DMG" "$PORTABLE"
if command -v hdiutil >/dev/null 2>&1; then
  hdiutil create -volname "Relaymote $VERSION" -srcfolder "$WORK/dmg" -ov -format UDZO "$DMG" >/dev/null
  say "dmg: $DMG"
else
  say "hdiutil not found (not a Mac?) - skipped the DMG"
fi
mv "$APPDIR" "$WORK/Relaymote"
tar -czf "$PORTABLE" -C "$WORK" Relaymote
say "portable: $PORTABLE"
