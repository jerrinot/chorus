UUID := chorus@jerrinot.github.io
PACKAGE := $(UUID).shell-extension.zip
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
AUTOSTART_DIR := $(HOME)/.config/autostart
AUTOSTART_FILE := $(AUTOSTART_DIR)/chorus-enable.desktop
EXTENSION_SOURCES := metadata.json extension.js menuView.js sonos.js refreshScheduler.js stylesheet.css
PACK_EXTRA_SOURCES := $(filter-out metadata.json extension.js stylesheet.css,$(EXTENSION_SOURCES)) LICENSE
UNIT_TESTS := tests/parser.test.js tests/client.test.js tests/refreshScheduler.test.js

.PHONY: test test-all test-unit test-live test-shell dev pack stage install enable disable uninstall

test: test-unit

test-all: test-unit test-live test-shell

test-unit:
	@for test in $(UNIT_TESTS); do gjs -m $$test || exit; done

test-live:
	gjs -m tests/live-read.js

test-shell:
	./scripts/test-shell.sh

dev: test-unit
	./scripts/dev-shell.sh

pack:
	gnome-extensions pack --force \
		$(addprefix --extra-source=,$(PACK_EXTRA_SOURCES)) .
	chmod 0644 $(PACKAGE)

stage:
	@test -n "$(DEST)" || { echo 'DEST is required' >&2; exit 2; }
	install -d "$(DEST)"
	for source in $(EXTENSION_SOURCES); do install -m 0644 "$$source" "$(DEST)/$$source"; done

install:
	$(MAKE) stage DEST="$(EXTENSION_DIR)"
	install -m 0755 scripts/enable-on-login.sh "$(EXTENSION_DIR)/enable-on-login.sh"

enable: install
	@if gnome-extensions info $(UUID) >/dev/null 2>&1; then \
		gnome-extensions enable $(UUID); \
	else \
		install -d "$(AUTOSTART_DIR)"; \
		sed 's|@EXTENSION_DIR@|$(EXTENSION_DIR)|g' \
			scripts/chorus-enable.desktop > "$(AUTOSTART_FILE)"; \
		chmod 0644 "$(AUTOSTART_FILE)"; \
	fi

disable:
	rm -f "$(AUTOSTART_FILE)"
	@if gnome-extensions info $(UUID) >/dev/null 2>&1; then \
		gnome-extensions disable $(UUID); \
	fi

uninstall: disable
	rm -rf -- "$(EXTENSION_DIR)"
