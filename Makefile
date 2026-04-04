SHELL := bash
TARGET := $(shell rustc --print host-tuple)
TAURI_ARGS ?=

# ---- Local builds ----

.PHONY: sidecars
sidecars: ## Build sidecar binaries (llama-server, whisper-server, koko)
	./scripts/build-sidecars.sh --target $(TARGET)

.PHONY: app
app: ## Build the Tauri app (requires sidecars)
	npm ci
ifeq ($(OS),Windows_NT)
	npm run tauri build -- --bundles nsis,msi $(TAURI_ARGS)
else ifeq ($(shell uname),Darwin)
	npm run tauri build -- $(TAURI_ARGS)
else
	NO_STRIP=1 LD_LIBRARY_PATH=$(CURDIR)/src-tauri/binaries/libs:$(CURDIR)/src-tauri/binaries npm run tauri build -- --bundles appimage,deb,rpm $(TAURI_ARGS)
endif

.PHONY: release-local
release-local: sidecars app ## Build everything: sidecars + app packages

# ---- CI testing with act ----

.PHONY: act-sidecars
act-sidecars: ## Run the sidecar build workflow locally via act
	act -W .github/workflows/build-sidecars.yml \
		-j build --matrix os:ubuntu-24.04

.PHONY: act-ci
act-ci: ## Run the CI checks workflow locally via act
	act -W .github/workflows/ci.yml

# ---- Dev ----

.PHONY: ensure-sidecars
ensure-sidecars: ## Check that all sidecar binaries are built
	@missing=""; \
	for bin in llama-server whisper-server koko; do \
		if [ ! -x src-tauri/binaries/$$bin-$(TARGET) ]; then \
			missing="$$missing $$bin"; \
		fi; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "ERROR: Missing sidecar binaries:$$missing"; \
		echo "Run 'make sidecars' or './scripts/dev-setup.sh' to build them."; \
		exit 1; \
	fi

.PHONY: dev
dev: ensure-sidecars ## Run the app in dev mode
	GDK_BACKEND=x11 npm run tauri dev; stty sane

.PHONY: check
check: ## Run all checks (lint, format, typecheck, test)
	npm run lint
	npm run format:check
	npm run check
	npm run test
	cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
	cargo test --manifest-path src-tauri/Cargo.toml

.PHONY: fmt
fmt: ## Auto-format all code
	npm run format
	cargo fmt --manifest-path src-tauri/Cargo.toml

# ---- Clean ----

.PHONY: clean
clean: ## Remove built sidecars, forcing rebuild on next make sidecars
	rm -f src-tauri/binaries/llama-server-*
	rm -f src-tauri/binaries/whisper-server-*
	rm -f src-tauri/binaries/koko-*
	rm -rf src-tauri/binaries/libs/*.so* src-tauri/binaries/libs/*.dylib src-tauri/binaries/libs/*.dll

.PHONY: clean-all
clean-all: clean ## Remove sidecars + Rust/frontend build artifacts
	rm -rf src-tauri/target
	rm -rf build node_modules

.PHONY: reset-data
reset-data: ## Remove all app data (models, db) for a fresh start
	rm -rf ~/.local/share/com.haruspex.app
	@echo "App data removed. Next launch will start fresh."

# ---- Help ----

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
