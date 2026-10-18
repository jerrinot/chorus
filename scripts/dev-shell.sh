#!/bin/sh

set -eu

uuid='sonos-groups@jara.local'
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_base=${XDG_RUNTIME_DIR:-/tmp}

if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
    echo 'No graphical session found. Run this from a terminal in GNOME.' >&2
    exit 1
fi

dev_root=$(mktemp -d "$runtime_base/chorus-dev.XXXXXX")
data_home="$dev_root/data"
config_home="$dev_root/config"
extension_dir="$data_home/gnome-shell/extensions/$uuid"

cleanup() {
    rm -rf -- "$dev_root"
}
trap cleanup EXIT HUP INT TERM

install -d "$config_home"
make -s -C "$project_dir" stage DEST="$extension_dir"

# Keep the development Shell's extension settings separate from the desktop
# session. The keyfile backend lets us enable the extension before Shell starts.
env \
    XDG_CONFIG_HOME="$config_home" \
    XDG_DATA_HOME="$data_home" \
    GSETTINGS_BACKEND=keyfile \
    gsettings set org.gnome.shell enabled-extensions "['$uuid']"

echo 'Starting Chorus in an isolated GNOME Shell devkit window.'
echo 'Close the window when finished; run `make dev` again after code changes.'

dbus-run-session -- env \
    XDG_CONFIG_HOME="$config_home" \
    XDG_DATA_HOME="$data_home" \
    GSETTINGS_BACKEND=keyfile \
    SHELL_DEBUG="${SHELL_DEBUG:-all}" \
    gnome-shell --devkit --wayland
