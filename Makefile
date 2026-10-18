UUID := chorus@jerrinot.github.io
PACKAGE := $(UUID).shell-extension.zip
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
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

enable: install
	gjs -m scripts/set-enabled.js enable $(UUID)

disable:
	gjs -m scripts/set-enabled.js disable $(UUID)

uninstall: disable
	rm -rf -- "$(EXTENSION_DIR)"
