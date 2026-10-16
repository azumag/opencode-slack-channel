#!/bin/sh
# Store the two Slack tokens for opencode-slack-channel without echoing them
# or leaving them in shell history. Writes ~/.config/opencode-slack-channel/tokens.json (mode 600).
set -eu

dir="${HOME}/.config/opencode-slack-channel"
file="${dir}/tokens.json"
mkdir -p "$dir"
chmod 700 "$dir"

trap 'stty echo 2>/dev/null || true' EXIT INT TERM
printf 'App-Level Token (xapp-…, Basic Information → App-Level Tokens): '
stty -echo; read -r app; stty echo; echo
printf 'Bot User OAuth Token (xoxb-…, OAuth & Permissions): '
stty -echo; read -r bot; stty echo; echo

case "$app" in xapp-*) ;; *) echo "error: the app token must start with xapp-" >&2; exit 1 ;; esac
case "$bot" in xoxb-*) ;; *) echo "error: the bot token must start with xoxb-" >&2; exit 1 ;; esac

umask 077
tmp="${file}.tmp"
printf '{\n  "botToken": "%s",\n  "appToken": "%s"\n}\n' "$bot" "$app" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$file"
echo "saved ${file} (600)"
