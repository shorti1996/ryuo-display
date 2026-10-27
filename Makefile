.PHONY: help install install-udev uninstall run tray receiver test test-python test-frontend build-frontend lint format deps

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
ICONS_DIR := $(HOME)/.local/share/icons
# The tray's icon theme files, relative to packaging/icons (hicolor/<size>/<context>/<name>.svg).
ICON_FILES := $(patsubst $(APPDIR)/packaging/icons/%,%,$(wildcard $(APPDIR)/packaging/icons/hicolor/*/*/*.svg))
STATE_DIR := $(or $(XDG_CONFIG_HOME),$(HOME)/.config)/ryuo
UDEV_RULE := 70-rog-ryuo-iv.rules

# The Android build tools and API jar for the receiver, downloaded on first build.
# The zips' own top-level directories are android-15/ (build-tools 35.0.1) and android-35/.
ANDROID_DIR ?= $(or $(XDG_CACHE_HOME),$(HOME)/.cache)/ryuo/android
ANDROID_REPO := https://dl.google.com/android/repository
BUILD_TOOLS_ZIP := build-tools_r35.0.1_linux.zip
BUILD_TOOLS_SHA1 := e009a9b188cfeb1d2b4c318ab5cb4f1ddc368861
PLATFORM_ZIP := platform-35_r02.zip
PLATFORM_SHA1 := 0bb560a90a7a2cbd0dd8348224d518b638fe7949
D8 := $(ANDROID_DIR)/android-15/d8
ANDROID_JAR := $(ANDROID_DIR)/android-35/android.jar
# A JRE with the jdk.compiler module is enough; no separate javac binary needed.
JAVAC ?= java -m jdk.compiler/com.sun.tools.javac.Main

# Rebuild the KDE menu cache when kbuildsycoca6 exists (Plasma only).
define rebuild-menu
	@if command -v $(firstword $(KBUILDSYCOCA)) >/dev/null 2>&1; then $(KBUILDSYCOCA); fi
endef

help:
	@# List the targets with what each does
	@awk '/^[a-z][a-z-]*:/ { t = $$1; sub(/:.*/, "", t); getline; \
		if (sub(/^\t@?# /, "")) printf "  %-14s %s\n", t, $$0 }' $(MAKEFILE)

install:
	# Install the ryuod user unit (enabled and started), the tray launcher, its autostart entry and icons
	install -d $(UNIT_DIR) $(APPS_DIR) $(AUTOSTART_DIR)
	# plasmashell does not pick up icon names that were missing when it looked them up, so a first
	# install can leave the tray icon blank until it restarts
	new=; for f in $(ICON_FILES); do [ -f $(ICONS_DIR)/$$f ] || new=1; \
		install -D -m 644 $(APPDIR)/packaging/icons/$$f $(ICONS_DIR)/$$f; done; \
	if [ -n "$$new" ]; then echo "New icons installed. If the tray icon is blank:" \
		"systemctl --user restart plasma-plasmashell.service"; fi
	# A newer mtime on the theme directory makes icon caches rescan it
	touch $(ICONS_DIR)/hicolor
	sed 's|@APPDIR@|$(APPDIR)|g' $(APPDIR)/packaging/ryuod.service > $(UNIT_DIR)/ryuod.service
	sed 's|@APPDIR@|$(APPDIR)|g' $(APPDIR)/packaging/ryuo-tray.desktop > $(APPS_DIR)/ryuo-tray.desktop
	install -m 644 $(APPS_DIR)/ryuo-tray.desktop $(AUTOSTART_DIR)/ryuo-tray.desktop
	chmod 644 $(UNIT_DIR)/ryuod.service $(APPS_DIR)/ryuo-tray.desktop
	$(SYSTEMCTL) --user daemon-reload
	$(SYSTEMCTL) --user enable ryuod.service
	# restart, not start: a running daemon would otherwise keep the old unit and code
	$(SYSTEMCTL) --user restart ryuod.service
	$(rebuild-menu)
	@if pgrep -f '[r]yuo_tray.py' >/dev/null 2>&1; then echo "The running tray keeps its old code:" \
		"quit it from its menu and start RYUO LCD again."; fi
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
	# Stop and disable ryuod, remove the unit, launcher, autostart entry and icons
	-$(SYSTEMCTL) --user disable --now ryuod.service
	rm -f $(UNIT_DIR)/ryuod.service $(APPS_DIR)/ryuo-tray.desktop $(AUTOSTART_DIR)/ryuo-tray.desktop
	rm -f $(addprefix $(ICONS_DIR)/,$(ICON_FILES))
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

receiver: receiver/receiver.jar
	@# Build the on-device stream receiver (downloads the Android build tools on first use)

receiver/receiver.jar: receiver/RyuoDisplay.java $(D8) $(ANDROID_JAR)
	rm -rf $(ANDROID_DIR)/classes && mkdir -p $(ANDROID_DIR)/classes
	$(JAVAC) -nowarn -Xlint:none -source 17 -target 17 -cp $(ANDROID_JAR) \
		-d $(ANDROID_DIR)/classes $(APPDIR)/receiver/RyuoDisplay.java
	$(D8) --min-api 33 --lib $(ANDROID_JAR) --output $(APPDIR)/$@ $(ANDROID_DIR)/classes/*.class

$(D8):
	mkdir -p $(ANDROID_DIR)
	curl -fL -o $(ANDROID_DIR)/$(BUILD_TOOLS_ZIP) $(ANDROID_REPO)/$(BUILD_TOOLS_ZIP)
	echo "$(BUILD_TOOLS_SHA1)  $(ANDROID_DIR)/$(BUILD_TOOLS_ZIP)" | sha1sum -c -
	unzip -q -o $(ANDROID_DIR)/$(BUILD_TOOLS_ZIP) -d $(ANDROID_DIR)
	rm $(ANDROID_DIR)/$(BUILD_TOOLS_ZIP)
	touch $@

$(ANDROID_JAR):
	mkdir -p $(ANDROID_DIR)
	curl -fL -o $(ANDROID_DIR)/$(PLATFORM_ZIP) $(ANDROID_REPO)/$(PLATFORM_ZIP)
	echo "$(PLATFORM_SHA1)  $(ANDROID_DIR)/$(PLATFORM_ZIP)" | sha1sum -c -
	unzip -q -o $(ANDROID_DIR)/$(PLATFORM_ZIP) -d $(ANDROID_DIR)
	rm $(ANDROID_DIR)/$(PLATFORM_ZIP)
	touch $@

test: test-python test-frontend
	@# Run the Python and web page test suites

test-python:
	# Run the Python tests
	uv run pytest

test-frontend:
	# Typecheck and test the control page, then fail if the committed web/dist/ differs from a fresh build
	npm --prefix $(APPDIR)/web ci
	npm --prefix $(APPDIR)/web run typecheck
	npm --prefix $(APPDIR)/web test
	npm --prefix $(APPDIR)/web run build
	@git -C $(APPDIR) diff --stat --exit-code -- web/dist || \
		{ echo "web/dist/ is stale: commit the rebuilt files (make build-frontend)"; exit 1; }
	@new=$$(git -C $(APPDIR) ls-files --others --exclude-standard -- web/dist); \
		if [ -n "$$new" ]; then echo "web/dist/ has files git does not track: $$new"; exit 1; fi

build-frontend:
	# Build the control page from web/src/ into web/dist/, which ryuod serves; commit the result
	npm --prefix $(APPDIR)/web ci
	npm --prefix $(APPDIR)/web run build

lint:
	# Check lint and formatting without changing files
	uv run ruff check .
	uv run ruff format --check .
	npm --prefix $(APPDIR)/web run lint

format:
	# Reformat and apply safe lint fixes
	uv run ruff format .
	uv run ruff check --fix .
	npm --prefix $(APPDIR)/web run format

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
	echo "second display (optional; Plasma on Wayland, NVIDIA GPU):"; \
	opt() { printf '  missing  %-34s dnf install %s\n' "$$1" "$$2"; }; \
	for t in krfb-virtualmonitor:krfb unshare:util-linux-core pw-dump:pipewire-utils pw-link:pipewire-utils \
		gst-launch-1.0:gstreamer1; do \
		if command -v $${t%%:*} >/dev/null 2>&1; then ok $${t%%:*}; else opt $${t%%:*} $${t#*:}; fi; \
	done; \
	for e in pipewiresrc:pipewire-gstreamer glupload:gstreamer1-plugins-base \
		nvh265enc:gstreamer1-plugins-bad-free gdppay:gstreamer1-plugins-bad-free; do \
		if gst-inspect-1.0 --exists $${e%%:*} >/dev/null 2>&1; then ok "GStreamer $${e%%:*}"; \
		else opt "GStreamer $${e%%:*}" $${e#*:}; fi; \
	done; \
	if $(PYTHON) -c 'import gi' >/dev/null 2>&1; then ok "PyGObject for $(PYTHON)"; \
	else opt "PyGObject for $(PYTHON)" python3-gobject-base; fi; \
	if [ -f $(APPDIR)/receiver/receiver.jar ]; then ok receiver/receiver.jar; \
	else printf '  missing  %-34s make receiver\n' receiver/receiver.jar; fi; \
	echo "dev:"; \
	if command -v uv >/dev/null 2>&1; then ok uv; else want uv uv; fi; \
	if command -v node >/dev/null 2>&1; then ok node; else want node nodejs; fi; \
	if command -v npm >/dev/null 2>&1; then ok npm; else want npm nodejs-npm; fi; \
	exit $$rc
