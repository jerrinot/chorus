#!/bin/sh

set -eu

uuid='sonos-groups@jara.local'
driver_uuid='chorus-shell-test@jara.local'
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_base=${XDG_RUNTIME_DIR:-/tmp}
test_root=$(mktemp -d "$runtime_base/chorus-shell-test.XXXXXX")
data_home="$test_root/data"
config_home="$test_root/config"
extension_dir="$data_home/gnome-shell/extensions/$uuid"
driver_dir="$data_home/gnome-shell/extensions/$driver_uuid"
shell_log="$test_root/shell.log"
session_log="$test_root/session.log"

cleanup() {
    find "$test_root" -depth -delete
}
trap cleanup EXIT HUP INT TERM

install -d "$extension_dir" "$driver_dir" "$config_home"
for source in metadata.json extension.js menuView.js sonos.js state.js stylesheet.css; do
    install -m 0644 "$project_dir/$source" "$extension_dir/$source"
done
install -m 0644 "$project_dir/tests/shell-driver/metadata.json" \
    "$driver_dir/metadata.json"
install -m 0644 "$project_dir/tests/shell-driver/extension.js" \
    "$driver_dir/extension.js"

env \
    XDG_CONFIG_HOME="$config_home" \
    XDG_DATA_HOME="$data_home" \
    GSETTINGS_BACKEND=keyfile \
    gsettings set org.gnome.shell enabled-extensions \
        "['$uuid', '$driver_uuid']"

export CHORUS_TEST_CONFIG_HOME="$config_home"
export CHORUS_TEST_DATA_HOME="$data_home"
export CHORUS_TEST_LOG="$shell_log"
export CHORUS_TEST_UUID="$uuid"

set +e
dbus-run-session -- sh -eu > "$session_log" 2>&1 <<'EOF'
env \
    XDG_CONFIG_HOME="$CHORUS_TEST_CONFIG_HOME" \
    XDG_DATA_HOME="$CHORUS_TEST_DATA_HOME" \
    GSETTINGS_BACKEND=keyfile \
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x720 \
    > "$CHORUS_TEST_LOG" 2>&1 &
shell_pid=$!

stop_shell() {
    kill "$shell_pid" 2>/dev/null || true
    wait "$shell_pid" 2>/dev/null || true
}
trap stop_shell EXIT HUP INT TERM

gdbus wait --session --timeout 10 org.gnome.Shell

attempt=0
while [ "$attempt" -lt 50 ]; do
    if env \
            XDG_CONFIG_HOME="$CHORUS_TEST_CONFIG_HOME" \
            XDG_DATA_HOME="$CHORUS_TEST_DATA_HOME" \
            GSETTINGS_BACKEND=keyfile \
            gnome-extensions info "$CHORUS_TEST_UUID" 2>/dev/null |
            grep -q 'State: ACTIVE'; then
        break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done

if [ "$attempt" -eq 50 ]; then
    echo 'Chorus did not become active in the headless Shell.' >&2
    exit 1
fi

# Let the driver open Quick Settings and the initial topology request render
# either the room view or its normal unavailable state.
sleep 2

env \
    XDG_CONFIG_HOME="$CHORUS_TEST_CONFIG_HOME" \
    XDG_DATA_HOME="$CHORUS_TEST_DATA_HOME" \
    GSETTINGS_BACKEND=keyfile \
    gnome-extensions disable "$CHORUS_TEST_UUID"
env \
    XDG_CONFIG_HOME="$CHORUS_TEST_CONFIG_HOME" \
    XDG_DATA_HOME="$CHORUS_TEST_DATA_HOME" \
    GSETTINGS_BACKEND=keyfile \
    gnome-extensions enable "$CHORUS_TEST_UUID"

env \
    XDG_CONFIG_HOME="$CHORUS_TEST_CONFIG_HOME" \
    XDG_DATA_HOME="$CHORUS_TEST_DATA_HOME" \
    GSETTINGS_BACKEND=keyfile \
    gnome-extensions info "$CHORUS_TEST_UUID" |
    grep -q 'State: ACTIVE'
EOF
session_status=$?
set -e

if [ "$session_status" -ne 0 ]; then
    cat "$session_log" >&2
    exit "$session_status"
fi

if grep -Eq 'Gjs-(CRITICAL|ERROR)|JS ERROR' "$shell_log" "$session_log"; then
    grep -En -C 3 'Gjs-(CRITICAL|ERROR)|JS ERROR' \
        "$shell_log" "$session_log" >&2
    exit 1
fi

echo 'GNOME Shell lifecycle test passed'
