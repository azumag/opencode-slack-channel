#!/usr/bin/env bash
# Set up the opencode Slack bot on a Linux machine from a fresh clone.
#
#   deploy/linux/setup.sh install [--reconfigure]   Node + opencode CLI + configs + services; starts the
#                                            opencode server only (never the Slack bridge). --reconfigure
#                                            rewrites the configs from the templates (old ones kept as .bak-*)
#   deploy/linux/setup.sh keygen             print a one-line public key for the secrets handoff
#   deploy/linux/setup.sh import <blob>      open the sealed secrets (Slack tokens; an OpenCode Go/Zen API key goes
#                                            into the env file as OPENCODE_API_KEY and restarts opencode)
#   deploy/linux/setup.sh zen-logout         remove opencode's stored OpenCode Console login(s)
#   deploy/linux/setup.sh netcheck           compare this shell's proxy settings with the env file's and try
#                                            each against Slack/GitHub (names and status codes only)
#   deploy/linux/setup.sh net-refresh        copy this shell's proxy settings into the env file again (+ restart)
#   deploy/linux/setup.sh check [--no-model] verify everything without connecting to Slack's socket
#   deploy/linux/setup.sh git-identity "<name>" <email>   who the bot's commits are by (not ~/.gitconfig)
#   deploy/linux/setup.sh start --cutover    start the Slack bridge (only once the old bot is stopped)
#   deploy/linux/setup.sh start-saved        bring a started bot back when it is down (machine re-created) or its
#                                            proxy copy is refused; does nothing otherwise — for cron
#   deploy/linux/setup.sh stop [--all]       stop the bridge (--all: the opencode server too)
#   deploy/linux/setup.sh status | logs [bridge|opencode] | uninstall
#
# Everything the bot owns lives in $OSC_HOME (default ~/.opencode-slack). opencode gets its own config
# dir (OPENCODE_CONFIG_DIR) and data/state/cache dirs there, so an existing ~/.config/opencode on this
# machine is never read or changed. XDG_CONFIG_HOME itself stays as it is: the agent's tools (gh, git, …)
# inherit opencode's environment and must still find their own config in ~/.config.
#
# Environment overrides: OSC_HOME, OSC_PORT (default 4196), NODE_VERSION (v24.22.1),
# OPENCODE_VERSION (2.0.31), OSC_SUPERVISOR (user | system | manual).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$REPO_DIR/deploy/linux/setup.sh"
TEMPLATES="$REPO_DIR/deploy/linux/templates"
OSC_HOME="${OSC_HOME:-$HOME/.opencode-slack}"
OSC_PORT="${OSC_PORT:-4196}"
NODE_VERSION="${NODE_VERSION:-v24.22.1}"
OPENCODE_VERSION="${OPENCODE_VERSION:-2.0.31}"

XDG_DIR="$OSC_HOME/xdg"
OC_CONFIG="$XDG_DIR/config/opencode"
OC_BIN="$OSC_HOME/opencode-cli/bin/opencode2"
BOT_CONFIG_DIR="$HOME/.config/opencode-slack-channel"
BOT_CONFIG="$BOT_CONFIG_DIR/config.json"
BOT_TOKENS="$BOT_CONFIG_DIR/tokens.json"
HANDOFF_KEY="$OSC_HOME/handoff-key.json"
ENV_FILE="$OSC_HOME/env"
LOG_DIR="$OSC_HOME/logs"
UNIT_OPENCODE="opencode-slack-opencode"
UNIT_BRIDGE="opencode-slack-channel"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- environment

load_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run: $SELF install"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# Proxy and CA settings the services take over from the installing shell.
NET_VARS="http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY NODE_USE_ENV_PROXY
NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE"

# Append this shell's NET_VARS to the env file ($1) as NAME="value"; NET_NAMES gets the names.
# Loopback (bridge → opencode server, opencode CLI → server) never goes through the proxy, and Node
# ignores proxy variables unless NODE_USE_ENV_PROXY=1, so that is turned on whenever a proxy is set.
write_net_env() {
  local name value proxy=""
  NET_NAMES=()
  for name in $NET_VARS; do
    value="${!name:-}"
    [ -n "$value" ] || continue
    case "$value" in *[\"\\\$\`]*) say "warning: $name has a character the env file cannot carry; not copied"; continue ;; esac
    case "$name" in
      no_proxy|NO_PROXY) value="$value,127.0.0.1,localhost,::1" ;;
      *_proxy|*_PROXY) proxy=1 ;;
    esac
    printf '%s="%s"\n' "$name" "$value" >> "$1"
    NET_NAMES+=("$name")
  done
  [ -n "$proxy" ] || return 0
  if [ -z "${no_proxy:-}${NO_PROXY:-}" ]; then
    printf 'no_proxy="127.0.0.1,localhost,::1"\nNO_PROXY="127.0.0.1,localhost,::1"\n' >> "$1"
    NET_NAMES+=(no_proxy NO_PROXY)
  fi
  if [ -z "${NODE_USE_ENV_PROXY:-}" ]; then
    printf 'NODE_USE_ENV_PROXY=1\n' >> "$1"
    NET_NAMES+=(NODE_USE_ENV_PROXY)
  fi
}

supervisor() {
  if [ -n "${OSC_SUPERVISOR:-}" ]; then printf '%s\n' "$OSC_SUPERVISOR"; return; fi
  if [ -f "$OSC_HOME/supervisor" ]; then cat "$OSC_HOME/supervisor"; return; fi
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$(id -u)" = 0 ]; then echo system; return; fi
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    if systemctl --user show-environment >/dev/null 2>&1; then echo user; return; fi
  fi
  echo manual
}

sctl() {
  if [ "$(supervisor)" = system ]; then systemctl "$@"; else
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    systemctl --user "$@"
  fi
}

download() { # url → stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else die "need curl or wget to download $1"; fi
}

node_major() { "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0; }

# A Node >= 22 with npm in the same directory (npm installs the opencode CLI). Images that keep npm
# elsewhere (e.g. node in /usr/bin, npm in /opt/…/bin) get our own Node instead of a mixed pair.
find_node() {
  local cand real
  for cand in "$OSC_HOME/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    [ "$(node_major "$cand")" -ge 22 ] || continue
    real="$(readlink -f "$cand")"
    if [ -x "$(dirname "$real")/npm" ]; then printf '%s\n' "$real"; return 0; fi
    if [ -x "$(dirname "$cand")/npm" ]; then printf '%s\n' "$cand"; return 0; fi
    printf 'not using %s: no npm next to it\n' "$cand" >&2
  done
  return 1
}

install_node() {
  local arch tarball url sums tmp
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m) — install Node >= 22 yourself and re-run" ;;
  esac
  tarball="node-$NODE_VERSION-linux-$arch.tar.gz"
  url="https://nodejs.org/dist/$NODE_VERSION"
  tmp="$(mktemp -d)"
  say "downloading $url/$tarball"
  download "$url/$tarball" > "$tmp/$tarball"
  download "$url/SHASUMS256.txt" > "$tmp/SHASUMS256.txt"
  sums="$(grep " $tarball\$" "$tmp/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$sums" ] || die "no checksum for $tarball in SHASUMS256.txt"
  [ "$(sha256sum "$tmp/$tarball" | awk '{print $1}')" = "$sums" ] || die "checksum mismatch for $tarball"
  rm -rf "$OSC_HOME/node"
  mkdir -p "$OSC_HOME/node"
  tar -xzf "$tmp/$tarball" -C "$OSC_HOME/node" --strip-components=1
  rm -rf "$tmp"
}

# Fill @OSC_HOME@ in a template. An existing file is kept, unless --reconfigure (then backed up).
RECONFIGURE=0
render() { # template dest [mode]
  local src="$1" dest="$2" mode="${3:-644}"
  if [ -e "$dest" ]; then
    if [ "$RECONFIGURE" = 0 ]; then say "kept existing $dest"; return; fi
    mv "$dest" "$dest.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$(dirname "$dest")"
  sed "s|@OSC_HOME@|$OSC_HOME|g" "$src" > "$dest.tmp"
  chmod "$mode" "$dest.tmp"
  mv "$dest.tmp" "$dest"
  say "wrote $dest"
}

# ---------------------------------------------------------------- services

write_units() {
  local mode="$1" node="$2" dir wanted user_line=""
  if [ "$mode" = system ]; then
    dir=/etc/systemd/system; wanted=multi-user.target; user_line="User=$(id -un)"
  else
    dir="$HOME/.config/systemd/user"; wanted=default.target
  fi
  mkdir -p "$dir"
  cat > "$dir/$UNIT_OPENCODE.service" <<EOF
[Unit]
Description=opencode v2 server for the opencode Slack bot
After=network-online.target

[Service]
Type=simple
$user_line
EnvironmentFile=$ENV_FILE
WorkingDirectory=$HOME
ExecStart=$OC_BIN serve --service
# opencode exits 130 on SIGTERM
SuccessExitStatus=130
Restart=always
RestartSec=10

[Install]
WantedBy=$wanted
EOF
  cat > "$dir/$UNIT_BRIDGE.service" <<EOF
[Unit]
Description=opencode Slack bot (Socket Mode bridge)
After=network-online.target $UNIT_OPENCODE.service
Wants=$UNIT_OPENCODE.service

[Service]
Type=simple
$user_line
EnvironmentFile=$ENV_FILE
WorkingDirectory=$REPO_DIR
ExecStart=$node $REPO_DIR/bin/opencode-slack-channel.js
# exit 2 = bad config or Slack rejected the tokens: restarting cannot help
RestartPreventExitStatus=2
Restart=always
RestartSec=15

[Install]
WantedBy=$wanted
EOF
  sctl daemon-reload
  say "wrote $dir/$UNIT_OPENCODE.service and $UNIT_BRIDGE.service"
}

pidfile() { printf '%s/%s.pid\n' "$OSC_HOME" "$1"; }

# Alive while any process of its group is (the loop leader can die before its child).
manual_running() { local p; p="$(pidfile "$1")"; [ -f "$p" ] && kill -0 -- "-$(cat "$p")" 2>/dev/null; }

manual_start() { # name final-exit-code command… (the loop gives up when the command exits with final-exit-code)
  local name="$1" final="$2"; shift 2
  if manual_running "$name"; then say "$name already running (pid $(cat "$(pidfile "$name")"))"; return; fi
  mkdir -p "$LOG_DIR"
  # setsid: own process group, so stop can take the restart loop and its child together.
  setsid bash -c 'final=$1; shift; while :; do "$@"; rc=$?; [ "$rc" = "$final" ] && { echo "$(date -u +%FT%TZ) exited with $rc; not restarting"; exit "$rc"; }; echo "$(date -u +%FT%TZ) exited with $rc; restarting in 10s"; sleep 10; done' \
    _ "$final" "$@" >> "$LOG_DIR/$name.log" 2>&1 < /dev/null 9>&- &
  echo $! > "$(pidfile "$name")"
  say "started $name (pid $!, log $LOG_DIR/$name.log)"
}

manual_stop() { # TERM the whole process group, wait for it to drain, KILL what is left
  local name="$1" p pgid _
  p="$(pidfile "$name")"
  if manual_running "$name"; then
    pgid="$(cat "$p")"
    kill -TERM -- "-$pgid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 -- "-$pgid" 2>/dev/null; then kill -KILL -- "-$pgid" 2>/dev/null || true; say "killed $name (did not exit within 15 s)"
    else say "stopped $name"; fi
  fi
  rm -f "$p"
}

service_start() { # opencode|bridge
  local unit; [ "$1" = opencode ] && unit=$UNIT_OPENCODE || unit=$UNIT_BRIDGE
  case "$(supervisor)" in
    manual)
      load_env
      if [ "$1" = opencode ]; then manual_start "$unit" none "$OC_BIN" serve --service
      else manual_start "$unit" 2 "$OSC_NODE" "$REPO_DIR/bin/opencode-slack-channel.js"; fi ;;
    *)
      # A machine re-created from its image keeps $OSC_HOME but not the units (Muse's VM: only /home survives).
      if [ ! -f "$(unit_dir)/$unit.service" ]; then
        local node; node="$(env_get OSC_NODE)"
        [ -x "$node" ] || die "node ($node) is gone — run: $SELF install"
        write_units "$(supervisor)" "$node"
      fi
      sctl enable --now "$unit.service"; say "enabled + started $unit" ;;
  esac
}

service_stop() {
  local unit; [ "$1" = opencode ] && unit=$UNIT_OPENCODE || unit=$UNIT_BRIDGE
  case "$(supervisor)" in
    manual) manual_stop "$unit" ;;
    *) sctl disable --now "$unit.service" 2>/dev/null || true; say "stopped + disabled $unit" ;;
  esac
}

service_restart_opencode() {
  case "$(supervisor)" in
    manual) manual_stop "$UNIT_OPENCODE"; service_start opencode ;;
    *) sctl restart "$UNIT_OPENCODE.service" ;;
  esac
}

service_restart_bridge() {
  case "$(supervisor)" in
    manual) manual_stop "$UNIT_BRIDGE"; service_start bridge ;;
    *) sctl restart "$UNIT_BRIDGE.service"; say "restarted $UNIT_BRIDGE" ;;
  esac
}

wait_for_opencode() {
  local _
  for _ in $(seq 1 30); do
    if "$OSC_NODE" "$REPO_DIR/deploy/linux/check.mjs" opencode >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

unit_dir() { if [ "$(supervisor)" = system ]; then echo /etc/systemd/system; else echo "$HOME/.config/systemd/user"; fi; }

# One start / stop / start-saved at a time: a cron run and a person can overlap, and a stop must not be
# undone by a start-saved that read bridge-wanted just before it was removed. fd 9 is closed for the
# services themselves (manual_start), so the lock never outlives this script.
lock_kit() { # seconds to wait
  exec 9> "$OSC_HOME/.lock"
  command -v flock >/dev/null 2>&1 || return 0
  flock -w "$1" 9
}

# One value of the env file, without sourcing it (that would replace this shell's proxy settings).
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"//; s/"$//'; }

shell_has_net() { local name; for name in $NET_VARS; do [ -n "${!name:-}" ] && return 0; done; return 1; }

env_has_proxy() { grep -qE '^(https?_proxy|all_proxy|HTTPS?_PROXY|ALL_PROXY)=' "$ENV_FILE"; }

# Each Slack connection attempt of the bridge ends in one of these log lines, as "<ts> <what>" (only those
# logged at or after $1, an ISO time, when given).
socket_lines() {
  LINES_N=400 cmd_logs bridge 2>/dev/null |
    sed -nE 's/.*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z) +(info|warn|error) +(socket connected|socket closed|socket connect failed|apps\.connections\.open failed|auth\.test failed).*/\1 \3/p' |
    awk -v since="${1:-}" '$1 >= since' || true
}

# The bridge retries every few seconds, so three attempts in a row without "socket connected" = it
# cannot reach Slack (a dead proxy copy: refused CONNECT; or Slack itself is down).
socket_failing() {
  local last; last="$(socket_lines | tail -n 3)"
  [ "$(grep -c . <<<"$last")" -ge 3 ] && ! grep -q 'socket connected' <<<"$last"
}

connected_since() { grep -q 'socket connected' <<<"$(socket_lines "$1")"; }

slack_probe_url() {
  local base
  base="$("$(env_get OSC_NODE)" -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).slack?.apiBase ?? "") } catch {}' "$BOT_CONFIG" 2>/dev/null || true)"
  printf '%s/api.test\n' "${base:-https://slack.com/api}"
}

proxy_gets_through() { # proxy URL → 0 when Slack answers through it
  [ "$(curl -s -o /dev/null --max-time 20 -x "$1" -w '%{http_code}' "$(slack_probe_url)" 2>/dev/null || true)" = 200 ]
}

# Muse's VM hands out new proxy credentials, and the copy in the env file can stop working. A running
# bridge does not notice (its Slack socket was opened earlier) but every new connection of the opencode
# server (the models) is refused. 0 when the copy is refused and this shell's proxy gets through, i.e.
# when net-refresh helps.
env_proxy_stale() {
  command -v curl >/dev/null 2>&1 || return 1
  local f s
  f="$(env_get https_proxy)"; [ -n "$f" ] || f="$(env_get HTTPS_PROXY)"
  s="${https_proxy:-${HTTPS_PROXY:-}}"
  [ -n "$f" ] && [ -n "$s" ] && [ "$f" != "$s" ] || return 1
  ! proxy_gets_through "$f" && proxy_gets_through "$s"
}

# ---------------------------------------------------------------- commands

cmd_install() {
  [ "$(uname -s)" = Linux ] || die "this script is for Linux (on macOS use ./launchd/install.sh)"
  case "${1:-}" in --reconfigure) RECONFIGURE=1 ;; "") ;; *) die "usage: $SELF install [--reconfigure]" ;; esac
  mkdir -p "$OSC_HOME" "$LOG_DIR"
  chmod 700 "$OSC_HOME"
  # Even `opencode2 --version` writes logs: keep every call inside $OSC_HOME.
  export OPENCODE_CONFIG_DIR="$OC_CONFIG" XDG_DATA_HOME="$XDG_DIR/data" XDG_STATE_HOME="$XDG_DIR/state" XDG_CACHE_HOME="$XDG_DIR/cache"

  step "Node >= 22"
  local node
  if ! node="$(find_node)"; then install_node; node="$(find_node)" || die "Node install failed"; fi
  say "node $("$node" -v) at $node"

  step "opencode CLI $OPENCODE_VERSION"
  if [ -x "$OC_BIN" ] && [ "$("$OC_BIN" --version 2>/dev/null)" = "opencode v$OPENCODE_VERSION" ]; then
    say "already installed"
  else
    PATH="$(dirname "$node"):$PATH" npm_config_cache="$XDG_DIR/cache/npm" "$(dirname "$node")/npm" install -g --no-fund --no-audit --allow-scripts=@opencode/cli \
      --prefix "$OSC_HOME/opencode-cli" "@opencode/cli@$OPENCODE_VERSION"
  fi
  say "$("$OC_BIN" --version) at $OC_BIN"

  step "environment ($ENV_FILE)"
  local mode; mode="$(supervisor)"
  echo "$mode" > "$OSC_HOME/supervisor"
  # The agent's shell tools inherit this PATH: keep the installing user's PATH (git, gh, …) after ours.
  # HOME too: systemd gives a unit the passwd home of its User=, which is not always where this was
  # installed (root with HOME=/home/<user>), and the bridge and gh/git all look under HOME.
  # A git identity set with `git-identity` and an API key from `import` survive a re-install.
  local kept_git=""
  [ -f "$ENV_FILE" ] && kept_git="$(grep -E '^(GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|OPENCODE_API_KEY)=' "$ENV_FILE" || true)"
  cat > "$ENV_FILE" <<EOF
HOME=$HOME
PATH=$OSC_HOME/opencode-cli/bin:$(dirname "$node"):$PATH
OPENCODE_CONFIG_DIR=$OC_CONFIG
XDG_DATA_HOME=$XDG_DIR/data
XDG_STATE_HOME=$XDG_DIR/state
XDG_CACHE_HOME=$XDG_DIR/cache
OSC_HOME=$OSC_HOME
OSC_NODE=$node
EOF
  [ -n "$kept_git" ] && printf '%s\n' "$kept_git" >> "$ENV_FILE"
  # A service starts without this shell's proxy settings. Where direct egress is blocked (Muse's VM
  # answers https on :443 with plain text) opencode then reaches neither the models nor their catalog.
  write_net_env "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "supervisor: $mode"
  if [ "${#NET_NAMES[@]}" -gt 0 ]; then say "network settings taken from this shell (values not shown): ${NET_NAMES[*]}"
  else say "no proxy settings in this shell: the services connect directly"; fi

  step "opencode config ($OC_CONFIG)"
  mkdir -p "$OC_CONFIG" "$XDG_DIR"/{data,state,cache}/opencode
  rm -rf "$OSC_HOME/plugins/opencode-rate-limit-fallback" "$OSC_HOME/agent-guards"
  mkdir -p "$OSC_HOME/plugins"
  cp -R "$REPO_DIR/vendor/opencode-rate-limit-fallback" "$OSC_HOME/plugins/"
  cp -R "$REPO_DIR/vendor/agent-guards" "$OSC_HOME/"
  render "$TEMPLATES/opencode.json" "$OC_CONFIG/opencode.json"
  render "$TEMPLATES/rate-limit-fallback.json" "$OC_CONFIG/rate-limit-fallback.json"
  render "$TEMPLATES/rules/worktree-scope.md" "$OC_CONFIG/rules/worktree-scope.md"
  render "$TEMPLATES/rules/secrets-hygiene.md" "$OC_CONFIG/rules/secrets-hygiene.md"
  if [ ! -e "$OC_CONFIG/service.json" ]; then
    printf '{\n  "hostname": "127.0.0.1",\n  "port": %s\n}\n' "$OSC_PORT" > "$OC_CONFIG/service.json"
    chmod 600 "$OC_CONFIG/service.json"
    say "wrote $OC_CONFIG/service.json (127.0.0.1:$OSC_PORT; opencode adds the password on first start)"
  else
    say "kept existing $OC_CONFIG/service.json"
  fi

  step "bot config ($BOT_CONFIG)"
  mkdir -p "$BOT_CONFIG_DIR"; chmod 700 "$BOT_CONFIG_DIR"
  render "$TEMPLATES/bot-config.json" "$BOT_CONFIG" 600
  mkdir -p "$HOME/work"

  step "services"
  if [ "$mode" != manual ]; then
    write_units "$mode" "$node"
    if [ "$mode" = user ] && command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$(id -un)" 2>/dev/null || true
      if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
        say "WARNING: lingering is off — the services stop when you log out. Fix: sudo loginctl enable-linger $(id -un)"
      fi
    fi
  else
    say "no usable systemd: services run as background loops (logs in $LOG_DIR). They do NOT start again after a"
    say "reboot by themselves — add to crontab:  */10 * * * * $SELF start-saved"
  fi
  if opencode_running && ! bridge_running; then
    service_restart_opencode
  elif opencode_running; then
    say "the bridge is running: opencode keeps its old environment until the next restart"
  else
    service_start opencode
  fi
  load_env
  if wait_for_opencode; then say "opencode server is up"; else die "opencode server did not come up — see: $SELF logs opencode"; fi

  step "done"
  say "The Slack bridge is NOT running. Next:"
  [ -f "$BOT_TOKENS" ] || say "  1. $SELF keygen   (post the printed osc-pub1:… line; the owner answers with an osc-sealed1:… blob)"
  [ -f "$BOT_TOKENS" ] || say "  2. $SELF import <osc-sealed1:…>"
  say "  3. $SELF check"
  say "  4. only when told the old bot is stopped: $SELF start --cutover"
}

cmd_keygen() {
  load_env
  "$OSC_NODE" "$REPO_DIR/deploy/secrets.mjs" keygen "$HANDOFF_KEY"
}

cmd_import() {
  [ -n "${1:-}" ] || die "usage: $SELF import <osc-sealed1:…>"
  load_env
  local before after
  before="$(grep '^OPENCODE_API_KEY=' "$ENV_FILE" | cksum || true)"
  "$OSC_NODE" "$REPO_DIR/deploy/secrets.mjs" open "$HANDOFF_KEY" "$1" --tokens-out "$BOT_TOKENS" --env-out "$ENV_FILE"
  after="$(grep '^OPENCODE_API_KEY=' "$ENV_FILE" | cksum || true)"
  # An OpenCode (Go or Zen) API key lands in the env file, which opencode only reads when it starts.
  [ "$before" != "$after" ] || return 0
  if bridge_running; then
    say "the bridge is running: the API key takes effect at the next opencode restart"
  elif opencode_running; then
    service_restart_opencode
    wait_for_opencode || die "opencode did not come back after the restart"
    say "opencode restarted with the API key"
  fi
}

# Copy this shell's proxy settings into the env file again (the copy install made can stop working:
# Muse's VM hands out new proxy credentials) and restart what runs, so that it picks them up.
cmd_net_refresh() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run: $SELF install"
  local tmp="$ENV_FILE.tmp" pattern
  if ! shell_has_net && env_has_proxy; then
    die "this shell has no proxy settings but $ENV_FILE has some — run this from the shell whose proxy works"
  fi
  pattern="^($(printf '%s|' $NET_VARS | sed 's/|$//'))="
  : > "$tmp"; chmod 600 "$tmp"
  grep -vE "$pattern" "$ENV_FILE" >> "$tmp" || true
  write_net_env "$tmp"
  mv "$tmp" "$ENV_FILE"
  if [ "${#NET_NAMES[@]}" -gt 0 ]; then say "network settings taken from this shell (values not shown): ${NET_NAMES[*]}"
  else say "no proxy settings in this shell or the env file: direct connections"; fi
  load_env
  if opencode_running; then
    service_restart_opencode
    wait_for_opencode || die "opencode did not come back after the restart — see: $SELF logs opencode"
    say "restarted opencode"
  fi
  if bridge_running; then service_restart_bridge; fi
  return 0
}

# Run from the shell whose proxy works: compare its proxy settings with the copy in the env file the
# services use, and try each one against Slack and GitHub. Prints names, same/different and status codes
# only, never a value.
cmd_netcheck() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run: $SELF install"
  local v s f e label c rc out tried=" " any=0 node
  step "proxy settings: this shell vs $ENV_FILE (and /etc/environment)"
  for v in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; do
    s="${!v-}"
    f="$(sed -n "s/^$v=//p" "$ENV_FILE" | tail -n 1)"; f="${f#\"}"; f="${f%\"}"
    e="$(sed -n "s/^$v=//p" /etc/environment 2>/dev/null | tail -n 1)"; e="${e#\"}"; e="${e%\"}"
    case "$v" in no_proxy|NO_PROXY) f="${f%,127.0.0.1,localhost,::1}" ;; esac   # install appends loopback
    [ -n "$s$f" ] || continue
    any=1
    if [ -z "$f" ]; then out="not in the env file"
    elif [ -z "$s" ]; then out="only in the env file"
    elif [ "$s" = "$f" ]; then out="same"
    else out="DIFFERENT"; fi
    case "$s" in *://*@*) out="$out; shell value has user:pass@" ;; esac
    case "$f" in *://*@*) out="$out; env file value has user:pass@" ;; esac
    if [ -z "$e" ]; then out="$out; not in /etc/environment"
    elif [ "$e" = "$s" ]; then out="$out; /etc/environment = shell"
    else out="$out; /etc/environment differs from the shell"; fi
    say "$v: $out"
  done
  [ "$any" = 1 ] || say "no proxy settings in this shell or the env file"

  step "CONNECT through each proxy (slack.com, api.github.com)"
  for v in https_proxy HTTPS_PROXY all_proxy ALL_PROXY; do
    for label in shell envfile; do
      if [ "$label" = shell ]; then s="${!v-}"; else s="$(sed -n "s/^$v=//p" "$ENV_FILE" | tail -n 1)"; s="${s#\"}"; s="${s%\"}"; fi
      [ -n "$s" ] || continue
      case "$tried" in *" $label:$v "*) continue ;; esac
      tried="$tried$label:$v "
      for f in https://slack.com/api/api.test https://api.github.com/zen; do
        c="$(curl -s -o /dev/null --max-time 20 -x "$s" -w '%{http_connect} %{http_code}' "$f" 2>/dev/null)" && rc=0 || rc=$?
        say "$label $v → ${f#https://}: CONNECT ${c% *} → HTTP ${c#* } (curl exit $rc)"
      done
    done
  done

  # curl is not what the services use: the bridge and check are Node (NODE_USE_ENV_PROXY), the agent's
  # tools include gh (Go). Each may read the same proxy URL differently.
  step "Node fetch and gh through the env file (as the services) and through this shell"
  node="$(sed -n 's/^OSC_NODE=//p' "$ENV_FILE" | tail -n 1)"
  local probe='fetch("https://slack.com/api/api.test",{signal:AbortSignal.timeout(20000)}).then((r)=>console.log("HTTP "+r.status),(e)=>console.log("failed: "+(e.cause?.code??"")+" "+(e.cause?.message??e.message)))'
  local scrub='s#[a-z][a-z0-9+.-]*://[^ ]*#<url>#g; s#[^ ]*@[^ ]*#<…>#g; s#[A-Za-z0-9._-]*:[0-9]{2,5}#<host:port>#g'
  say "envfile node fetch → slack.com: $(env -i bash -c 'set -a; . "$0"; set +a; exec "$OSC_NODE" -e "$1"' "$ENV_FILE" "$probe" 2>&1 | tail -n 1 | sed -E "$scrub")"
  say "shell   node fetch → slack.com: $(NODE_USE_ENV_PROXY=1 "$node" -e "$probe" 2>&1 | tail -n 1 | sed -E "$scrub")"
  if command -v gh >/dev/null 2>&1; then
    env -i bash -c 'set -a; . "$0"; set +a; exec gh api user --jq .login' "$ENV_FILE" >/dev/null 2>&1 && rc=0 || rc=$?
    say "envfile gh api user: exit $rc"
    gh api user --jq .login >/dev/null 2>&1 && rc=0 || rc=$?
    say "shell   gh api user: exit $rc"
  else
    say "gh not on this shell's PATH"
  fi

  step "where this shell's proxy settings come from (file names and change times only)"
  out="$(grep -lsE '^[^#]*(https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY)' /etc/environment /etc/profile /etc/profile.d/* /etc/bash.bashrc \
    "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zshrc" 2>/dev/null || true)"
  if [ -n "$out" ]; then
    while IFS= read -r f; do say "$f (changed $(date -u -r "$f" '+%Y-%m-%d %H:%M:%S UTC'))"; done <<< "$out"
    say "now: $(date -u '+%Y-%m-%d %H:%M:%S UTC'); env file changed $(date -u -r "$ENV_FILE" '+%Y-%m-%d %H:%M:%S UTC')"
  else
    say "none of the usual profile files set them (the environment that runs this shell does)"
  fi
}

# Drop the OpenCode Console logins (device login) stored in the bot's opencode, so that Zen sees only the
# API key from `import`, or no credential at all. Account labels are not printed.
cmd_zen_logout() {
  load_env
  opencode_running || die "the opencode server is not running — run: $SELF install"
  local ids id n=0
  ids="$("$OC_BIN" auth list --format json | "$OSC_NODE" -e '
    for (const i of JSON.parse(require("fs").readFileSync(0, "utf8")))
      if (i.id === "opencode") for (const c of i.connections ?? []) if (c.type === "credential") console.log(c.id)')" \
    || die "could not list opencode's credentials"
  for id in $ids; do
    "$OC_BIN" auth logout opencode "$id" >/dev/null || die "logout failed"
    n=$((n + 1))
  done
  say "removed $n OpenCode Console login(s)"
  [ "$n" -gt 0 ] || return 0
  if bridge_running; then
    say "the bridge is running: opencode drops the login at its next restart"
  else
    service_restart_opencode
    wait_for_opencode || die "opencode did not come back after the restart"
    say "opencode restarted"
  fi
}

# The bot's commits only: GIT_AUTHOR_*/GIT_COMMITTER_* in the env file. ~/.gitconfig is not touched,
# so whoever else uses git on this machine keeps their own identity.
cmd_git_identity() {
  local name="${1:-}" email="${2:-}" kind tmp
  [ -n "$name" ] && [ -n "$email" ] || die "usage: $SELF git-identity \"<name>\" <email>"
  case "$name$email" in *[\"\\\$\`]*|*$'\n'*) die "name/email must not contain quotes, backslashes, \$, backticks or newlines" ;; esac
  load_env
  tmp="$ENV_FILE.tmp"
  grep -vE '^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=' "$ENV_FILE" > "$tmp" || true
  for kind in AUTHOR COMMITTER; do
    printf 'GIT_%s_NAME="%s"\nGIT_%s_EMAIL="%s"\n' "$kind" "$name" "$kind" "$email" >> "$tmp"
  done
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  say "bot git identity: $name <$email> (in $ENV_FILE; ~/.gitconfig untouched)"
  if bridge_running; then
    say "the bridge is running: this takes effect at the next opencode restart"
  else
    service_restart_opencode
    wait_for_opencode || die "opencode did not come back after the restart"
    say "opencode restarted with the identity"
  fi
}

bridge_running() {
  case "$(supervisor)" in
    manual) manual_running "$UNIT_BRIDGE" ;;
    *) sctl is-active --quiet "$UNIT_BRIDGE.service" ;;
  esac
}

opencode_running() {
  case "$(supervisor)" in
    manual) manual_running "$UNIT_OPENCODE" ;;
    *) sctl is-active --quiet "$UNIT_OPENCODE.service" ;;
  esac
}

cmd_check() {
  load_env
  local args=()
  [ "${1:-}" = --no-model ] || args+=(--model)
  # With nothing but the env file, as the services see it: a setting only this shell has would
  # otherwise pass here and fail after start.
  env -i "$BASH" -c 'set -a; . "$0"; set +a; exec "$@"' "$ENV_FILE" \
    "$OSC_NODE" "$REPO_DIR/deploy/linux/check.mjs" all "${args[@]}" \
    --bot-config "$BOT_CONFIG" --tokens "$BOT_TOKENS" --opencode-bin "$OC_BIN" --opencode-log "$XDG_DIR/data/opencode/log/opencode.log"
}

cmd_start() {
  [ "${1:-}" = --cutover ] || die "the old bot must be stopped first (two bridges on one Slack app split the events between them). Once it is: $SELF start --cutover"
  [ -f "$BOT_TOKENS" ] || die "no Slack tokens yet ($BOT_TOKENS) — run keygen + import first"
  load_env
  lock_kit 120 || die "another start/stop/start-saved is running ($OSC_HOME/.lock)"
  opencode_running || service_start opencode
  wait_for_opencode || die "opencode server is not up — $SELF logs opencode"
  service_start bridge
  echo started > "$OSC_HOME/bridge-wanted"
  sleep 5
  cmd_logs bridge | tail -n 8
}

# For cron (every few minutes, from the shell whose proxy works) or @reboot: bring back a bot that was
# started with start --cutover and not stopped since (bridge-wanted), using only what survives in
# $OSC_HOME. Prints "start-saved:" lines saying what it did; exit 1 only when it tried and failed.
#  - not wanted: nothing. A stopped bot stays stopped.
#  - wanted, both services running, Slack connected, the proxy copy works: nothing.
#  - wanted, a service not running (machine re-created: units gone): install again with this shell's
#    proxy settings (configs, API key and the installed opencode version kept), then start the bridge.
#  - wanted, running, but the env file's proxy copy is refused while this shell's gets through, or the
#    last Slack connection attempts all failed: take this shell's proxy settings and restart both.
cmd_start_saved() {
  local want="$OSC_HOME/bridge-wanted" ver since why _
  [ -d "$OSC_HOME" ] || die "start-saved: $OSC_HOME not found — run it as the user who installed the bot (HOME=$HOME)"
  [ -f "$want" ] || { say "start-saved: not wanted (stopped, or never started with --cutover) — nothing to do"; return 0; }
  lock_kit 5 || { say "start-saved: another start/stop/start-saved is running — nothing to do"; return 0; }
  [ -f "$want" ] || { say "start-saved: stopped meanwhile — nothing to do"; return 0; }
  mkdir -p "$LOG_DIR"
  since="$(date -u +%FT%T)"
  if bridge_running && opencode_running; then
    if env_proxy_stale; then why="the env file's proxy settings are refused (this shell's get through)"
    elif socket_failing; then why="the bridge cannot reach Slack (last connection attempts failed)"
    else say "start-saved: running — nothing to do"; return 0; fi
    shell_has_net || die "start-saved: $why and this shell has no proxy settings to give it"
    say "start-saved: RESTARTING — $why; taking this shell's proxy settings"
    cmd_net_refresh
  else
    if ! shell_has_net && env_has_proxy; then
      say "start-saved: RECOVERING — the bot should run but does not; this shell has no proxy settings, so the env file's are kept"
      opencode_running || service_start opencode
      load_env
      wait_for_opencode || die "start-saved: the opencode server did not come up — $SELF logs opencode"
    else
      say "start-saved: RECOVERING — the bot should run but does not; install again (configs kept, log $LOG_DIR/start-saved.log), then start"
      ver="$(OPENCODE_CONFIG_DIR="$OC_CONFIG" XDG_DATA_HOME="$XDG_DIR/data" XDG_STATE_HOME="$XDG_DIR/state" XDG_CACHE_HOME="$XDG_DIR/cache" \
        "$OC_BIN" --version 2>/dev/null | sed -n 's/^opencode v//p' || true)"
      if ! OPENCODE_VERSION="${ver:-$OPENCODE_VERSION}" "$SELF" install > "$LOG_DIR/start-saved.log" 2>&1; then
        tail -n 15 "$LOG_DIR/start-saved.log"
        die "start-saved: install failed"
      fi
    fi
    if bridge_running; then service_restart_bridge; else service_start bridge; fi
  fi
  for _ in $(seq 1 45); do connected_since "$since" && break; sleep 1; done
  cmd_logs bridge | tail -n 4
  bridge_running || die "start-saved: the bridge is not running after the start"
  connected_since "$since" || die "start-saved: started, but not connected to Slack within 45 s"
  say "start-saved: done — the bot is running and connected"
}

cmd_stop() {
  [ -d "$OSC_HOME" ] && { lock_kit 120 || die "another start/stop/start-saved is running ($OSC_HOME/.lock)"; }
  service_stop bridge
  rm -f "$OSC_HOME/bridge-wanted"
  [ "${1:-}" = --all ] && service_stop opencode
  return 0
}

cmd_status() {
  say "supervisor: $(supervisor)"
  case "$(supervisor)" in
    manual)
      for u in "$UNIT_OPENCODE" "$UNIT_BRIDGE"; do
        if manual_running "$u"; then say "$u: running (pid $(cat "$(pidfile "$u")"))"; else say "$u: stopped"; fi
      done ;;
    *) sctl --no-pager status "$UNIT_OPENCODE.service" "$UNIT_BRIDGE.service" 2>&1 | grep -E '^(●|○|×)|Active:|could not be found' || true ;;
  esac
  if [ -f "$OSC_HOME/bridge-wanted" ]; then say "start-saved: brings the bot back (started with --cutover, not stopped since)"
  else say "start-saved: does nothing (the bridge was not started with --cutover, or was stopped)"; fi
}

cmd_logs() {
  local unit; [ "${1:-bridge}" = opencode ] && unit=$UNIT_OPENCODE || unit=$UNIT_BRIDGE
  case "$(supervisor)" in
    manual) tail -n "${LINES_N:-60}" "$LOG_DIR/$unit.log" 2>/dev/null || say "(no log yet)" ;;
    system) journalctl -u "$unit.service" -n "${LINES_N:-60}" --no-pager ;;
    *) journalctl --user -u "$unit.service" -n "${LINES_N:-60}" --no-pager ;;
  esac
}

cmd_uninstall() {
  cmd_stop --all
  if [ "$(supervisor)" != manual ]; then
    local dir; dir="$(unit_dir)"
    rm -f "$dir/$UNIT_OPENCODE.service" "$dir/$UNIT_BRIDGE.service"
    sctl daemon-reload
  fi
  say "services removed. Data and configs are kept: $OSC_HOME, $BOT_CONFIG_DIR, ~/.local/state/opencode-slack-channel"
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  keygen) cmd_keygen ;;
  import) shift; cmd_import "$@" ;;
  git-identity) shift; cmd_git_identity "$@" ;;
  zen-logout) cmd_zen_logout ;;
  netcheck) cmd_netcheck ;;
  net-refresh) cmd_net_refresh ;;
  check) shift; cmd_check "$@" ;;
  start) shift; cmd_start "$@" ;;
  start-saved) cmd_start_saved ;;
  stop) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
