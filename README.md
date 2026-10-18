# Chorus

Chorus adds Sonos room grouping to GNOME Quick Settings. It does not control
playback, queues, music services, or volume.

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
autostart entry enables the extension after that login and removes itself once
the extension is available.

Run `make enable` again to update the installed files, then log out and back in
to load them. To remove Chorus:

```sh
make uninstall
```

## Development

- `make test` runs deterministic tests without touching real speakers.
- `make test-live` discovers the current Sonos system and reads its state. It
  never changes room groups.
- `make test-shell` loads Chorus in an isolated headless GNOME Shell and checks
  menu interaction state plus the enable, disable, and shutdown lifecycle.
- `make test-all` runs all three test suites.
- `make dev` starts an isolated GNOME Shell devkit window with a fresh copy of
  the extension.

The devkit does not restart or modify the running desktop session. Close its
window and run `make dev` again to load JavaScript changes; GNOME Shell modules
cannot be reliably unloaded from an existing process. A real logout/login is
only needed for the final installed-session smoke test.

`make dev` enables verbose Shell diagnostics by default. Override them when a
quieter run is useful, for example with `SHELL_DEBUG=backtrace-warnings make
dev`.

`make pack` creates an installable extension ZIP.

Chorus is an independent project and is not affiliated with or endorsed by
Sonos, Inc.

## License

Chorus is free software under the GNU General Public License, version 3 or
later. See `LICENSE`.
