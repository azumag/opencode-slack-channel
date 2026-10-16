#!/bin/sh
# Install (or reinstall) the LaunchAgent that keeps the bridge running.
#   ./launchd/install.sh            install + start
#   ./launchd/install.sh uninstall  stop + remove
set -eu

label="com.azumag.opencode-slack-channel"
plist="${HOME}/Library/LaunchAgents/${label}.plist"
root="$(cd "$(dirname "$0")/.." && pwd)"
node="${NODE:-$(command -v node)}"
log="${HOME}/Library/Logs/opencode-slack-channel.log"
domain="gui/$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "${domain}/${label}" 2>/dev/null || true
  rm -f "$plist"
  echo "removed ${label}"
  exit 0
fi

[ -x "$node" ] || { echo "error: node not found (set NODE=/path/to/node)" >&2; exit 1; }
[ -f "${HOME}/.config/opencode-slack-channel/tokens.json" ] || [ -n "${SLACK_BOT_TOKEN:-}" ] || { echo "error: run ./set-tokens.sh first" >&2; exit 1; }

mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${root}/bin/opencode-slack-channel.js</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
EOF
launchctl bootout "${domain}/${label}" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
echo "installed ${label} (node ${node}); log: ${log}"
