# Chorus

A deliberately small GNOME Shell Quick Settings integration for changing
Sonos room groups. It does not control playback, queues, music services, or
volume.

When exactly one Sonos group is playing, the menu opens directly as a simple
room checklist for that sound. Check a room to include it; uncheck one to let
it go. If several sounds are playing—or none is—the menu first shows a small
overview so you can choose one. **Everywhere** includes every room, while
**Only _Room_** keeps the sound in just the room named in the header.

The interface presents Sonos rooms rather than physical players, so bonded
stereo and surround components remain hidden.

## Requirements

- GNOME Shell 50
- Avahi running on the system bus
- Sonos speakers reachable on the local network
- `mutter-dev-bin` on Ubuntu when using the nested development shell

The extension uses the local Sonos UPnP interfaces directly and does not need
a cloud account or background service.

## Install

```sh
make test
make enable
```

Open GNOME Quick Settings and select **Sonos**.

GNOME Shell discovers newly installed extensions when the desktop session
starts. The first install therefore requires one logout/login. A one-time
autostart entry enables the extension after that login and then removes
itself. Treat this as the final installation smoke test, not as the
development loop.

## Development

`make test` (or `make test-unit`) runs deterministic parsing, action-planning,
refresh-scheduling, and topology-convergence tests without touching real
speakers. `make test-live` is an explicit read-only integration probe that
discovers the current Sonos system and reads transport state. `make test-all`
runs both. Group-changing actions are intentionally never run by any test
target.

For UI work, run:

```sh
make dev
```

This starts GNOME Shell's nested devkit in a window, with isolated extension
settings and a fresh copy of the source. It does not restart or modify the
running desktop session. Close the devkit window and run `make dev` again to
load code changes; GNOME Shell JavaScript modules cannot be reliably unloaded
from an existing process.

The intended feedback loop is therefore:

1. Keep protocol and topology behavior in `sonos.js` and exercise it with
   `make test-unit`.
2. Use `make dev` for Quick Settings layout and interaction changes.
3. Use a real logout/login only once, for the final installed-session smoke
   test.

`make dev` enables verbose Shell diagnostics by default. Override them when a
quieter run is useful, for example with `SHELL_DEBUG=backtrace-warnings make
dev`.

`make pack` creates an installable extension ZIP and includes the separate
Sonos protocol module.

## License

Chorus is free software under the GNU General Public License, version 3 or
later. See `LICENSE`.
