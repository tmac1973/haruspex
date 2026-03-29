TARGET := $(shell rustc --print host-tuple)

# ---- Local builds ----

.PHONY: sidecars
sidecars: ## Build sidecar binaries (llama-server, whisper-server, koko)
	./scripts/build-sidecars.sh --target $(TARGET)

.PHONY: app
app: ## Build the Tauri app (requires sidecars)
	npm ci
	npm run tauri build -- --bundles deb,rpm

.PHONY: release-local
release-local: sidecars app ## Build everything: sidecars + app packages (DEB/RPM)

# ---- CI testing with act ----

.PHONY: act-sidecars
act-sidecars: ## Run the sidecar build workflow locally via act
	act -W .github/workflows/build-sidecars.yml \
		-j build --matrix os:ubuntu-24.04

.PHONY: act-ci
act-ci: ## Run the CI checks workflow locally via act
	act -W .github/workflows/ci.yml

# ---- Dev ----

.PHONY: dev
dev: ## Run the app in dev mode
	GDK_BACKEND=x11 npm run tauri dev

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

# ---- Help ----

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
