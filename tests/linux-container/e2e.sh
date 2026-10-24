# Sourced by run.sh e2e (after run.sh up): install, cutover, and what start-saved must do on Muse's VM —
# nothing before the cutover or while healthy; bring the bot back after the VM is re-created (units gone,
# new proxy credentials); restart it when the env file's proxy copy is refused; nothing after stop.
# The bridge talks to the mock Slack; no model is called (the opencode server only has to run).

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }
state() { mock /control/state; }
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(JSON.stringify(eval(process.argv[1])))})' "$1"; }
LOGD="$(mktemp -d)"
trap 'rm -rf "$LOGD"' EXIT
UNITS="opencode-slack-opencode opencode-slack-channel"
units_gone() { # what a re-created VM looks like: /etc/systemd/system rebuilt from the image
  vm "systemctl stop $UNITS; for u in $UNITS; do rm -f /etc/systemd/system/\$u.service /etc/systemd/system/multi-user.target.wants/\$u.service; done; systemctl daemon-reload"
}
proxy_auth() { # user pass | off
  if [ "$1" = off ]; then docker exec "$PROXY" bash -c 'sed -i "/^BasicAuth/d" /etc/tinyproxy/tinyproxy.conf && kill -USR1 1'
  else docker exec "$PROXY" bash -c "sed -i '/^BasicAuth/d' /etc/tinyproxy/tinyproxy.conf && echo 'BasicAuth $1 $2' >> /etc/tinyproxy/tinyproxy.conf && kill -USR1 1"; fi
  sleep 1
}
env_has() { vm "grep -c '$1' /home/hatch/.opencode-slack/env" 2>/dev/null || true; }
main_pid() { vm "systemctl show -p MainPID --value $1"; }
slack_com_requests() { docker logs "$PROXY" 2>&1 | grep -c 'Request .*slack\.com' || true; }
slack_com_before="$(slack_com_requests)"

proxy_auth off
vm "$SETUP stop --all >/dev/null 2>&1 || true"
units_gone >/dev/null 2>&1 || true
vm "rm -rf /home/hatch/.opencode-slack /home/hatch/.config/opencode-slack-channel /home/hatch/.local/state/opencode-slack-channel /home/hatch/work"
copy_tree
docker cp "$HERE/mock-slack.mjs" "$PROXY:/mock/mock-slack.mjs" >/dev/null
docker exec "$PROXY" pkill -f '[n]ode /mock/mock-slack.mjs' || true
docker exec -d "$PROXY" bash -c 'exec node /mock/mock-slack.mjs > /var/log/mock.log 2>&1'
sleep 1
mock /control/reset '{}' >/dev/null || fail "mock reset"

echo "== install"
vm "$SETUP install" > "$LOGD/install.log" 2>&1 || { tail -20 "$LOGD/install.log"; fail install; }
grep -q 'opencode server is up' "$LOGD/install.log" || fail "install did not bring the opencode server up"
pass "install via the proxy, opencode server up"

echo "== sealed Slack tokens; test-only: the bridge talks to the mock Slack"
pub="$(vm "$SETUP keygen")"
printf '{"botToken":"%s","appToken":"%s"}' xoxb-test-bot xapp-test-app > "$LOGD/tokens.json"
sealed="$(node "$REPO/deploy/secrets.mjs" seal "$pub" --tokens "$LOGD/tokens.json" 2>/dev/null)"
out="$(vm "$SETUP import '$sealed'")"
grep -q 'handoff key deleted' <<<"$out" || fail import
vm "f=/home/hatch/.config/opencode-slack-channel/config.json; node -e 'const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(process.argv[1]));c.slack={apiBase:\"http://slack.mock:9100/api\"};fs.writeFileSync(process.argv[1],JSON.stringify(c,null,2))' \$f"
pass "keygen → seal on the host → import"

echo "== start-saved before the cutover does nothing"
out="$(vm "$SETUP start-saved")"
grep -q 'start-saved: not wanted' <<<"$out" || { echo "$out"; fail "start-saved before any cutover"; }
[ "$(state | jq_ 'v.connected')" = 0 ] || fail "start-saved started a bridge that was never cut over"
pass "start-saved before the cutover: not wanted"

echo "== start --cutover"
vm "$SETUP start --cutover" > "$LOGD/start.log" 2>&1 || { cat "$LOGD/start.log"; fail start; }
for _ in $(seq 1 30); do [ "$(state | jq_ 'v.connected')" = 1 ] && break; sleep 1; done
[ "$(state | jq_ 'v.connected')" = 1 ] || { cat "$LOGD/start.log"; fail "bridge did not connect to the mock Slack"; }
out="$(vm "$SETUP logs")"
grep -q 'socket connected (num_connections=1)' <<<"$out" || fail "no 'socket connected' line in the bridge log"
out="$(vm "$SETUP start-saved")"
grep -q 'start-saved: running — nothing to do' <<<"$out" || { echo "$out"; fail "start-saved on a healthy bot"; }
pass "bridge connected through the proxy, logs 'socket connected'; start-saved leaves it alone"

echo "== VM re-created (units + enable links gone, services down) and new proxy credentials → start-saved"
units_gone
sleep 2
[ "$(state | jq_ 'v.connected')" = 0 ] || fail "socket still connected after the simulated re-provision"
out="$(vm "$SETUP check --no-model" 2>&1 || true)"
grep -q '✗ opencode server — not running (no .*service.json) — start it again with: setup.sh install' <<<"$out" || { echo "$out"; fail "check did not say the server is not running"; }
proxy_auth user2 pass2
plain_px="$PX"; PX="http://user2:pass2@$PROXY:8888"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved recovery"; }
grep '^start-saved:' <<<"$out" | sed 's/^/  /'
grep -q 'start-saved: RECOVERING' <<<"$out" || fail "start-saved did not see the bot down"
grep -q 'start-saved: done' <<<"$out" || fail "start-saved recovery not done"
for u in $UNITS; do
  vm "test -f /etc/systemd/system/$u.service" || fail "$u unit not rewritten"
  vm "systemctl is-active --quiet $u && systemctl is-enabled --quiet $u" || fail "$u not active + enabled"
done
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "not connected after recovery"
[ "$(env_has 'user2:pass2@')" -ge 1 ] || fail "env file did not take the new proxy credentials"
out="$(vm "$SETUP check --no-model" 2>&1 || true)"
for line in 'opencode server' 'Slack bot token' 'Slack app token' 'Slack socket host'; do
  grep -q "^✓ $line" <<<"$out" || { echo "$out"; fail "check after recovery: no ✓ $line"; }
done
out="$(vm "$SETUP start-saved")"
grep -q 'start-saved: running — nothing to do' <<<"$out" || { echo "$out"; fail "second start-saved was not a no-op"; }
pass "start-saved rewrote both units, took the new proxy credentials, reconnected; then no-op"

echo "== proxy credentials rotate under a running bot (its Slack socket stays up) → start-saved restarts both"
pid_before="$(main_pid opencode-slack-opencode)"
proxy_auth user3 pass3
sleep 2
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "test premise: the open socket should survive the credential change"
PX="http://user3:pass3@$PROXY:8888"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved restart"; }
grep '^start-saved:' <<<"$out" | sed 's/^/  /'
grep -q "start-saved: RESTARTING — the env file's proxy settings are refused" <<<"$out" || fail "start-saved did not see the refused proxy copy"
grep -q 'start-saved: done' <<<"$out" || fail "start-saved restart not done"
[ "$(main_pid opencode-slack-opencode)" != "$pid_before" ] || fail "opencode server was not restarted"
[ "$(env_has 'user3:pass3@')" -ge 1 ] && [ "$(env_has 'user2:pass2@')" = 0 ] || fail "env file did not swap to the new proxy credentials"
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "not connected after the restart"
pass "refused proxy copy under a running bot → both restarted with this shell's settings"

echo "== a shell whose proxy is refused too: start-saved does not touch a working bot"
proxy_auth user4 pass4
PX="http://user3:pass3@$PROXY:8888"
out="$(vm "$SETUP start-saved" 2>&1 || true)"
grep -q 'start-saved: running — nothing to do' <<<"$out" || { echo "$out"; fail "start-saved acted on equal (both refused) settings"; }
proxy_auth user3 pass3
pass "same settings in shell and env file → no restart (it would not help)"

echo "== net-refresh back to the plain proxy"
PX="$plain_px"
proxy_auth off
vm "$SETUP net-refresh" > "$LOGD/refresh.log" 2>&1 || { cat "$LOGD/refresh.log"; fail net-refresh; }
grep -q 'restarted opencode' "$LOGD/refresh.log" && grep -q 'restarted opencode-slack-channel' "$LOGD/refresh.log" || { cat "$LOGD/refresh.log"; fail "net-refresh did not restart both"; }
[ "$(env_has 'user3:pass3@')" = 0 ] || fail "net-refresh kept the old credentials"
for _ in $(seq 1 30); do [ "$(state | jq_ 'v.connected')" = 1 ] && break; sleep 1; done
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "not connected after net-refresh"
pass "net-refresh rewrote the proxy lines and restarted both"

echo "== stop"
vm "$SETUP stop" >/dev/null
sleep 2
[ "$(state | jq_ 'v.connected')" = 0 ] || fail "socket still connected after stop"
out="$(vm "$SETUP start-saved")"
grep -q 'start-saved: not wanted' <<<"$out" || { echo "$out"; fail "start-saved after stop"; }
sleep 2
[ "$(state | jq_ 'v.connected')" = 0 ] || fail "start-saved revived a stopped bridge"
pass "start-saved after stop leaves it stopped"

echo "== nothing tried to reach the real Slack (the proxy also refuses it)"
attempts="$(slack_com_requests)"
[ "$attempts" = "$slack_com_before" ] || { docker logs "$PROXY" 2>&1 | grep 'slack\.com' | tail -5; fail "requests for slack.com during e2e: $((attempts - slack_com_before))"; }
pass "no request for slack.com during e2e (check and the probes used the mock)"

echo; echo "e2e: all passed"
