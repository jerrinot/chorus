#!/bin/sh

uuid='chorus@jerrinot.github.io'
autostart_file="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/chorus-enable.desktop"
attempt=0

while [ "$attempt" -lt 10 ]; do
    if gnome-extensions info "$uuid" >/dev/null 2>&1 &&
            gnome-extensions enable "$uuid"; then
        rm -f "$autostart_file"
        exit 0
    fi

    attempt=$((attempt + 1))
    sleep 2
done

exit 1
