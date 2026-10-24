# Sourced by run.sh e2e (after run.sh up): install, cutover, and what start-saved must do on Muse's VM —
# nothing before the cutover or while healthy; bring the bot back after the VM is re-created (units gone,
# new proxy credentials); restart it when the env file's proxy copy is refused; nothing after stop.
# Proxy credentials as on Muse's VM: /etc/environment's (written at boot) keep working, while each shell
# (each cron run) has its own that the proxy soon refuses — so the services must get /etc/environment's.
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
proxy_auth() { # off | user pass [user pass]… — the proxy accepts each pair, nothing else
  local lines=""
  if [ "$1" != off ]; then while [ $# -ge 2 ]; do lines="${lines}BasicAuth $1 $2"$'\n'; shift 2; done; fi
  printf '%s' "$lines" | docker exec -i "$PROXY" bash -c 'sed -i "/^BasicAuth/d" /etc/tinyproxy/tinyproxy.conf && cat >> /etc/tinyproxy/tinyproxy.conf && kill -USR1 1'
  sleep 1
}
px() { printf 'http://%s:%s@%s:8888' "$1" "$1" "$PROXY"; } # user → proxy URL with user:user@
etc_env() { # proxy URL | off → the proxy lines of the VM's /etc/environment (as Muse's VM writes them at boot)
  docker exec -i "$VM" bash -s "$1" <<'EOS'
sed -i '/^[A-Za-z_]*_\(proxy\|PROXY\)=/d' /etc/environment
[ "$1" = off ] && exit 0
for v in http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY; do printf '%s="%s"\n' "$v" "$1" >> /etc/environment; done
EOS
}
env_has() { vm "grep -c '$1' /home/hatch/.opencode-slack/env" 2>/dev/null || true; }
main_pid() { vm "systemctl show -p MainPID --value $1"; }
slack_com_requests() { docker logs "$PROXY" 2>&1 | grep -c 'Request .*slack\.com' || true; }
slack_com_before="$(slack_com_requests)"

proxy_auth off
etc_env off
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

echo "== VM re-created (units + enable links gone, new boot credentials in /etc/environment) → start-saved from a cron run"
units_gone
sleep 2
[ "$(state | jq_ 'v.connected')" = 0 ] || fail "socket still connected after the simulated re-provision"
out="$(vm "$SETUP check --no-model" 2>&1 || true)"
grep -q '✗ opencode server — not running (no .*service.json) — start it again with: setup.sh install' <<<"$out" || { echo "$out"; fail "check did not say the server is not running"; }
proxy_auth boot1 boot1 job1 job1
etc_env "$(px boot1)"
plain_px="$PX"; PX="$(px job1)"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved recovery"; }
grep '^start-saved:' <<<"$out" | sed 's/^/  /'
grep -q 'start-saved: RECOVERING .*proxy settings from /etc/environment' <<<"$out" || fail "start-saved did not see the bot down (or not take /etc/environment)"
grep -q 'start-saved: done' <<<"$out" || fail "start-saved recovery not done"
for u in $UNITS; do
  vm "test -f /etc/systemd/system/$u.service" || fail "$u unit not rewritten"
  vm "systemctl is-active --quiet $u && systemctl is-enabled --quiet $u" || fail "$u not active + enabled"
done
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "not connected after recovery"
[ "$(env_has 'boot1:boot1@')" -ge 1 ] && [ "$(env_has 'job1:job1@')" = 0 ] || fail "env file did not take /etc/environment's credentials (or took the cron run's)"
out="$(vm "$SETUP check --no-model" 2>&1 || true)"
for line in 'opencode server' 'Slack bot token' 'Slack app token' 'Slack socket host'; do
  grep -q "^✓ $line" <<<"$out" || { echo "$out"; fail "check after recovery: no ✓ $line"; }
done
pass "start-saved rewrote both units, took /etc/environment's credentials (not the cron run's), reconnected"

echo "== the cron run's credentials expire, the next run has new ones: the bot is left alone (no restart loop)"
pid_before="$(main_pid opencode-slack-opencode)"
proxy_auth boot1 boot1 job2 job2
PX="$(px job2)"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved after the cron credentials expired"; }
grep -q 'start-saved: running — nothing to do' <<<"$out" || { echo "$out"; fail "start-saved restarted although the env file's (boot) credentials still work"; }
[ "$(main_pid opencode-slack-opencode)" = "$pid_before" ] || fail "opencode restarted"
pass "env file holds the boot credentials: expiring cron credentials do not restart anything"

echo "== the proxy refuses the copy, /etc/environment has working ones → start-saved restarts both with them"
proxy_auth boot2 boot2 job3 job3
etc_env "$(px boot2)"
sleep 2
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "test premise: the open socket should survive the credential change"
PX="$(px job3)"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved restart"; }
grep '^start-saved:' <<<"$out" | sed 's/^/  /'
grep -q "start-saved: RESTARTING — the proxy refuses the env file's settings (env file's: CONNECT/HTTP 000 401; /etc/environment's pass); taking /etc/environment's proxy settings" <<<"$out" || fail "start-saved did not see (or did not show the codes of) the refused proxy copy"
grep -q 'start-saved: done' <<<"$out" || fail "start-saved restart not done"
[ "$(main_pid opencode-slack-opencode)" != "$pid_before" ] || fail "opencode server was not restarted"
[ "$(env_has 'boot2:boot2@')" -ge 1 ] && [ "$(env_has 'boot1:boot1@')" = 0 ] && [ "$(env_has 'job3:job3@')" = 0 ] || fail "env file did not swap to /etc/environment's new credentials"
[ "$(state | jq_ 'v.connected')" = 1 ] || fail "not connected after the restart"
status="$(vm "$SETUP status")"
grep -q 'start-saved acted (last 5, UTC):' <<<"$status" && grep -q 'RESTARTING — the proxy refuses' <<<"$status" || { echo "$status"; fail "status does not show what start-saved did"; }
pass "refused copy → both restarted with /etc/environment's credentials; status shows it"

echo "== /etc/environment refused too, this shell's pass → this shell's settings"
proxy_auth job4 job4
PX="$(px job4)"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved with only the shell's credentials working"; }
grep '^start-saved:' <<<"$out" | sed 's/^/  /'
grep -q "start-saved: RESTARTING — the proxy refuses the env file's settings (env file's: CONNECT/HTTP 000 401; this shell's: 000 200); taking this shell's proxy settings" <<<"$out" || fail "start-saved did not fall back to this shell's settings"
[ "$(env_has 'job4:job4@')" -ge 1 ] || fail "env file did not take this shell's credentials"
pass "/etc/environment refused → falls back to this shell's settings"

echo "== a copy that only times out / cannot connect is not a refusal: no restart"
vm "sed -i 's#^https_proxy=.*#https_proxy=\"http://$PROXY:1\"#' /home/hatch/.opencode-slack/env"
pid_before="$(main_pid opencode-slack-opencode)"
out="$(vm "$SETUP start-saved" 2>&1)" || { echo "$out"; fail "start-saved with an unreachable proxy copy"; }
grep -q 'start-saved: running — nothing to do' <<<"$out" || { echo "$out"; fail "start-saved restarted on a copy that was not refused"; }
[ "$(main_pid opencode-slack-opencode)" = "$pid_before" ] || fail "opencode restarted on a copy that was not refused"
vm "$SETUP net-refresh" >/dev/null
pass "an unreachable (not refusing) proxy copy does not restart the bot"

echo "== nothing would help (copy, /etc/environment and this shell all refused): start-saved leaves the bot alone"
proxy_auth job5 job5
out="$(vm "$SETUP start-saved" 2>&1 || true)"
grep -q 'start-saved: running — nothing to do' <<<"$out" || { echo "$out"; fail "start-saved acted although no settings get through"; }
pass "no working settings anywhere → no restart"

echo "== net-refresh back to the plain proxy"
PX="$plain_px"
proxy_auth off
etc_env off
vm "$SETUP net-refresh" > "$LOGD/refresh.log" 2>&1 || { cat "$LOGD/refresh.log"; fail net-refresh; }
grep -q 'network settings taken from this shell' "$LOGD/refresh.log" || { cat "$LOGD/refresh.log"; fail "net-refresh did not say where the settings came from"; }
grep -q 'restarted opencode' "$LOGD/refresh.log" && grep -q 'restarted opencode-slack-channel' "$LOGD/refresh.log" || { cat "$LOGD/refresh.log"; fail "net-refresh did not restart both"; }
[ "$(env_has ":8888")" -ge 1 ] && [ "$(env_has "@$PROXY")" = 0 ] || fail "net-refresh kept old credentials"
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
