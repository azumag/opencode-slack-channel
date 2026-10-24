#!/usr/bin/env bash
# Container test for deploy/linux/setup.sh, shaped like Muse's VM (after claude-slack-channel's):
# Ubuntu 24.04, systemd system services, commands run as root with HOME=/home/hatch, and no way out
# except an HTTP proxy. Slack is a mock behind that proxy (real Slack is never touched); the Node and
# opencode CLI downloads are real, through the proxy.
#
#   tests/linux-container/run.sh up      build the images, start proxy + VM, copy the working tree in
#   tests/linux-container/run.sh vm '<cmd>'   run a command in the VM as Muse would (proxy env set)
#   tests/linux-container/run.sh mock <path> [json]   GET (or POST json) the mock's control API
#   tests/linux-container/run.sh e2e     install → cutover → re-created VM → rotated proxy credentials (after up)
#   tests/linux-container/run.sh down    remove the containers, network and images this made
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
P=osckit
VM=$P-vm
PROXY=$P-proxy
NET=$P-int
IMG_VM=$P-vm:test
IMG_PROXY=$P-proxy:test
PX="${OSCKIT_PX:-http://$PROXY:8888}"
KIT=/home/hatch/opencode-slack-channel
SETUP=$KIT/deploy/linux/setup.sh

vm() { # run as Muse does: root, HOME=/home/hatch, the proxy in the shell's env
  docker exec -i -e HOME=/home/hatch -w /home/hatch \
    -e http_proxy=$PX -e https_proxy=$PX -e all_proxy=$PX -e HTTP_PROXY=$PX -e HTTPS_PROXY=$PX -e ALL_PROXY=$PX \
    -e no_proxy=localhost,127.0.0.1 -e NO_PROXY=localhost,127.0.0.1 \
    "$VM" bash -c "$1"
}

mock() { # path [json body]
  if [ -n "${2:-}" ]; then docker exec "$PROXY" curl -fsS -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:9100$1"
  else docker exec "$PROXY" curl -fsS "http://127.0.0.1:9100$1"; fi
}

copy_tree() {
  (cd "$REPO" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -cf -) |
    docker exec -i "$VM" bash -c "rm -rf $KIT && mkdir -p $KIT && tar -xf - -C $KIT"
}

up() {
  docker build -q -t "$IMG_VM" -f "$HERE/Dockerfile.vm" "$HERE" >/dev/null
  docker build -q -t "$IMG_PROXY" -f "$HERE/Dockerfile.proxy" "$HERE" >/dev/null
  docker network create --internal "$NET" >/dev/null
  docker run -d --name "$PROXY" --add-host slack.mock:127.0.0.1 "$IMG_PROXY" >/dev/null
  docker network connect "$NET" "$PROXY"
  docker run -d --name "$VM" --hostname muse-vm --network "$NET" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock "$IMG_VM" >/dev/null
  for _ in $(seq 1 30); do
    state="$(docker exec "$VM" systemctl is-system-running 2>/dev/null || true)"
    case "$state" in running|degraded) break ;; esac
    sleep 1
  done
  echo "VM systemd: $state"
  copy_tree
  echo "direct egress from the VM (must fail):"
  docker exec "$VM" curl -sS -m 5 -o /dev/null https://registry.npmjs.org/ 2>&1 | sed 's/^/  /' || true
  echo "egress through the proxy:"
  vm 'curl -sS -m 20 -o /dev/null -w "  HTTP %{http_code}\n" https://registry.npmjs.org/'
  echo "the real Slack through the proxy (must be refused):"
  vm 'curl -sS -m 10 -o /dev/null -w "  CONNECT %{http_connect}\n" https://slack.com/api/api.test 2>&1' | sed 's/^/  /' || true
}

down() {
  docker rm -f "$VM" "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMG_VM" "$IMG_PROXY" >/dev/null 2>&1 || true
  echo "removed $VM, $PROXY, $NET, $IMG_VM, $IMG_PROXY"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  vm) vm "$2" ;;
  mock) mock "$2" "${3:-}" ;;
  copy) copy_tree ;;
  e2e) . "$HERE/e2e.sh" ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
