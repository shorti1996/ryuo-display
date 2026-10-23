.PHONY: help install install-udev uninstall run tray test test-python test-frontend lint format deps

MAKEFILE := $(abspath $(lastword $(MAKEFILE_LIST)))
# Absolute path of this checkout; the unit and launcher run the code from here.
APPDIR := $(patsubst %/,%,$(dir $(MAKEFILE)))

# The unit and launcher run on the system python, which has PySide6 for the tray.
PYTHON ?= /usr/bin/python3

# Overridable so install/uninstall can be exercised against a scratch HOME,
# e.g. make install HOME=$(mktemp -d) SYSTEMCTL=echo KBUILDSYCOCA=true
SYSTEMCTL ?= systemctl
KBUILDSYCOCA ?= kbuildsycoca6
SUDO ?= sudo
UDEVADM ?= udevadm
UDEV_RULES_DIR ?= /etc/udev/rules.d
HIDRAW_SYSFS ?= /sys/class/hidraw
DEVDIR ?= /dev

UNIT_DIR := $(HOME)/.config/systemd/user
APPS_DIR := $(HOME)/.local/share/applications
AUTOSTART_DIR := $(HOME)/.config/autostart
STATE_DIR := $(or $(XDG_CONFIG_HOME),$(HOME)/.config)/ryuo
UDEV_RULE := 70-rog-ryuo-iv.rules

# Rebuild the KDE menu cache when kbuildsycoca6 exists (Plasma only).
define rebuild-menu
	@if command -v $(firstword $(KBUILDSYCOCA)) >/dev/null 2>&1; then $(KBUILDSYCOCA); fi
endef

help:
	@# List the targets with what each does
	@awk '/^[a-z][a-z-]*:/ { t = $$1; sub(/:.*/, "", t); getline; \
		if (sub(/^\t@?# /, "")) printf "  %-14s %s\n", t, $$0 }' $(MAKEFILE)

install:
	# Install the ryuod user unit (enabled and started), the tray launcher and its autostart entry
	install -d $(UNIT_DIR) $(APPS_DIR) $(AUTOSTART_DIR)
	sed 's|@APPDIR@|$(APPDIR)|g' $(APPDIR)/packaging/ryuod.service > $(UNIT_DIR)/ryuod.service
	sed 's|@APPDIR@|$(APPDIR)|g' $(APPDIR)/packaging/ryuo-tray.desktop > $(APPS_DIR)/ryuo-tray.desktop
	install -m 644 $(APPS_DIR)/ryuo-tray.desktop $(AUTOSTART_DIR)/ryuo-tray.desktop
	chmod 644 $(UNIT_DIR)/ryuod.service $(APPS_DIR)/ryuo-tray.desktop
	$(SYSTEMCTL) --user daemon-reload
	$(SYSTEMCTL) --user enable ryuod.service
	# restart, not start: a running daemon would otherwise keep the old unit and code
	$(SYSTEMCTL) --user restart ryuod.service
	$(rebuild-menu)
	@uevent=$$(grep -liE '^HID_ID=[0-9a-f]+:0000(0b05|1c75):00001c76$$' $(HIDRAW_SYSFS)/hidraw*/device/uevent 2>/dev/null | head -n 1); \
	if [ -z "$$uevent" ]; then \
		echo "No RYUO IV hidraw node found (cooler off or not enumerated)."; \
		[ -f $(UDEV_RULES_DIR)/$(UDEV_RULE) ] || echo "The udev rule is not installed either: run 'make install-udev'."; \
	else \
		node=$(DEVDIR)/$$(basename $$(dirname $$(dirname $$uevent))); \
		if [ -r $$node ] && [ -w $$node ]; then echo "$$node is accessible."; \
		else echo "$$node is not readable and writable by $$(id -un): run 'make install-udev'."; fi; \
	fi

install-udev:
	# Install the hidraw udev rule (sudo) so the logged-in user can open the cooler's HID interface
	$(SUDO) install -m 644 $(APPDIR)/$(UDEV_RULE) $(UDEV_RULES_DIR)/
	$(SUDO) $(UDEVADM) control --reload
	$(SUDO) $(UDEVADM) trigger --subsystem-match=hidraw

uninstall:
	# Stop and disable ryuod, remove the unit, launcher and autostart entry
	-$(SYSTEMCTL) --user disable --now ryuod.service
	rm -f $(UNIT_DIR)/ryuod.service $(APPS_DIR)/ryuo-tray.desktop $(AUTOSTART_DIR)/ryuo-tray.desktop
	$(SYSTEMCTL) --user daemon-reload
	$(rebuild-menu)
	@if [ -f $(UDEV_RULES_DIR)/$(UDEV_RULE) ]; then echo "Kept: $(UDEV_RULES_DIR)/$(UDEV_RULE)" \
		"(remove: sudo rm $(UDEV_RULES_DIR)/$(UDEV_RULE) && sudo $(UDEVADM) control --reload)"; fi
	@if [ -f $(STATE_DIR)/state.json ]; then echo "Kept: $(STATE_DIR)/state.json" \
		"(remove: rm -r $(STATE_DIR))"; fi
	@echo "A running tray keeps running until you quit it from its menu."

run:
	# Run ryuod in the foreground with frame logging (stop ryuod.service first)
	@if $(SYSTEMCTL) --user is-active --quiet ryuod.service 2>/dev/null; then \
		echo "ryuod.service is running and holds port 8746: systemctl --user stop ryuod first."; exit 1; fi
	$(PYTHON) -u $(APPDIR)/ryuod.py -v

tray:
	# Start the tray icon on the system python (PySide6 comes from python3-pyside6)
	$(PYTHON) $(APPDIR)/ryuo_tray.py

test: test-python test-frontend
	@# Run the Python and web page test suites

test-python:
	# Run the Python tests
	uv run pytest

test-frontend:
	# Run the web page tests
	cd web && npm ci && npm test

lint:
	# Check lint and formatting without changing files
	uv run ruff check .
	uv run ruff format --check .

format:
	# Reformat and apply safe lint fixes
	uv run ruff format .
	uv run ruff check --fix .

deps:
	# Check runtime deps (exit 1 if one is missing) and dev tools, naming the Fedora package
	@rc=0; \
	ok() { printf '  ok       %s\n' "$$1"; }; \
	need() { printf '  MISSING  %-34s dnf install %s\n' "$$1" "$$2"; rc=1; }; \
	want() { printf '  missing  %-34s dnf install %s  (dev only)\n' "$$1" "$$2"; }; \
	echo "runtime:"; \
	if [ -x $(PYTHON) ]; then ok "$(PYTHON)"; else need "$(PYTHON)" python3; fi; \
	if command -v adb >/dev/null 2>&1; then ok adb; else need adb android-tools; fi; \
	if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then \
		need "ffmpeg, ffprobe" "ffmpeg  (RPM Fusion)"; \
	elif ffmpeg -hide_banner -encoders 2>/dev/null | grep -qE '^ *V[^ ]* +(libx265|hevc_nvenc) '; then \
		ok "ffmpeg, ffprobe"; \
	else \
		printf '  MISSING  %-34s dnf swap ffmpeg-free ffmpeg --allowerasing  (RPM Fusion)\n' "libx265 in ffmpeg"; rc=1; \
	fi; \
	if $(PYTHON) -c 'import PySide6' >/dev/null 2>&1; then ok "PySide6 for $(PYTHON)"; \
	else need "PySide6 for $(PYTHON)" python3-pyside6; fi; \
	echo "dev:"; \
	if command -v uv >/dev/null 2>&1; then ok uv; else want uv uv; fi; \
	if command -v node >/dev/null 2>&1; then ok node; else want node nodejs; fi; \
	if command -v npm >/dev/null 2>&1; then ok npm; else want npm nodejs-npm; fi; \
	exit $$rc
