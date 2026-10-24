#!/usr/bin/env bash
# Set up the opencode Slack bot on a Linux machine from a fresh clone.
#
#   deploy/linux/setup.sh install            Node + opencode CLI + configs + services; starts the opencode
#                                            server only (never the Slack bridge)
#   deploy/linux/setup.sh keygen             print a one-line public key for the secrets handoff
#   deploy/linux/setup.sh import <blob>      open the sealed secrets (Slack tokens, opencode auth)
#   deploy/linux/setup.sh check [--no-model] verify everything without connecting to Slack's socket
#   deploy/linux/setup.sh start --cutover    start the Slack bridge (only once the old bot is stopped)
#   deploy/linux/setup.sh stop [--all]       stop the bridge (--all: the opencode server too)
#   deploy/linux/setup.sh status | logs [bridge|opencode] | uninstall
#
# Everything the bot owns lives in $OSC_HOME (default ~/.opencode-slack). opencode runs with its own
# XDG dirs there, so an existing ~/.config/opencode on this machine is never read or changed.
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
OC_AUTH="$XDG_DIR/data/opencode/auth.json"
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

# Fill @OSC_HOME@ in a template; never overwrite a file that already exists.
render() { # template dest [mode]
  local src="$1" dest="$2" mode="${3:-644}"
  if [ -e "$dest" ]; then say "kept existing $dest"; return; fi
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
    _ "$final" "$@" >> "$LOG_DIR/$name.log" 2>&1 < /dev/null &
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
    *) sctl enable --now "$unit.service"; say "enabled + started $unit" ;;
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

wait_for_opencode() {
  local _
  for _ in $(seq 1 30); do
    if "$OSC_NODE" "$REPO_DIR/deploy/linux/check.mjs" opencode >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------- commands

cmd_install() {
  [ "$(uname -s)" = Linux ] || die "this script is for Linux (on macOS use ./launchd/install.sh)"
  mkdir -p "$OSC_HOME" "$LOG_DIR"
  chmod 700 "$OSC_HOME"
  # Even `opencode2 --version` writes logs: keep every call inside $OSC_HOME.
  export XDG_CONFIG_HOME="$XDG_DIR/config" XDG_DATA_HOME="$XDG_DIR/data" XDG_STATE_HOME="$XDG_DIR/state" XDG_CACHE_HOME="$XDG_DIR/cache"

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
  cat > "$ENV_FILE" <<EOF
PATH=$OSC_HOME/opencode-cli/bin:$(dirname "$node"):$PATH
XDG_CONFIG_HOME=$XDG_DIR/config
XDG_DATA_HOME=$XDG_DIR/data
XDG_STATE_HOME=$XDG_DIR/state
XDG_CACHE_HOME=$XDG_DIR/cache
OSC_HOME=$OSC_HOME
OSC_NODE=$node
EOF
  chmod 600 "$ENV_FILE"
  say "supervisor: $mode"

  step "opencode config ($OC_CONFIG)"
  mkdir -p "$XDG_DIR"/{config,data,state,cache}/opencode
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
    say "reboot by themselves — add to crontab:  @reboot $SELF start-saved"
  fi
  service_start opencode
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
  "$OSC_NODE" "$REPO_DIR/deploy/secrets.mjs" open "$HANDOFF_KEY" "$1" --tokens-out "$BOT_TOKENS" --auth-out "$OC_AUTH"
  # opencode reads auth.json at startup; the bridge is not running yet, so nothing is interrupted.
  if ! bridge_running; then service_restart_opencode; wait_for_opencode || die "opencode did not come back after the restart"; say "opencode restarted with the new credentials"; fi
}

bridge_running() {
  case "$(supervisor)" in
    manual) manual_running "$UNIT_BRIDGE" ;;
    *) sctl is-active --quiet "$UNIT_BRIDGE.service" ;;
  esac
}

cmd_check() {
  load_env
  local args=()
  [ "${1:-}" = --no-model ] || args+=(--model)
  "$OSC_NODE" "$REPO_DIR/deploy/linux/check.mjs" all "${args[@]}" \
    --bot-config "$BOT_CONFIG" --tokens "$BOT_TOKENS" --auth "$OC_AUTH" --opencode-bin "$OC_BIN"
}

cmd_start() {
  [ "${1:-}" = --cutover ] || die "the old bot must be stopped first (two bridges on one Slack app split the events between them). Once it is: $SELF start --cutover"
  [ -f "$BOT_TOKENS" ] || die "no Slack tokens yet ($BOT_TOKENS) — run keygen + import first"
  load_env
  wait_for_opencode || die "opencode server is not up — $SELF logs opencode"
  service_start bridge
  echo started > "$OSC_HOME/bridge-wanted"
  sleep 5
  cmd_logs bridge | tail -n 8
}

cmd_start_saved() { # @reboot entry for the manual supervisor
  service_start opencode
  [ -f "$OSC_HOME/bridge-wanted" ] && service_start bridge
  return 0
}

cmd_stop() {
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
    *) sctl --no-pager status "$UNIT_OPENCODE.service" "$UNIT_BRIDGE.service" 2>&1 | grep -E '^(●|○|×)|Active:' || true ;;
  esac
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
    local dir; [ "$(supervisor)" = system ] && dir=/etc/systemd/system || dir="$HOME/.config/systemd/user"
    rm -f "$dir/$UNIT_OPENCODE.service" "$dir/$UNIT_BRIDGE.service"
    sctl daemon-reload
  fi
  say "services removed. Data and configs are kept: $OSC_HOME, $BOT_CONFIG_DIR, ~/.local/state/opencode-slack-channel"
}

case "${1:-}" in
  install) cmd_install ;;
  keygen) cmd_keygen ;;
  import) shift; cmd_import "$@" ;;
  check) shift; cmd_check "$@" ;;
  start) shift; cmd_start "$@" ;;
  start-saved) cmd_start_saved ;;
  stop) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
