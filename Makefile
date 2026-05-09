# StellaX — build, test and deployment orchestration.
#
# All commands are written to be run from the repository root.

SHELL          := /bin/bash
CARGO          := cargo
STELLAR        := stellar
WASM_TARGET    := wasm32v1-none
WASM_DIR       := target/$(WASM_TARGET)/release
CONTRACT_NAMES := stellax_oracle stellax_vault stellax_perp_engine stellax_funding \
                  stellax_risk stellax_options stellax_structured stellax_bridge \
				  stellax_governor stellax_treasury stellax_rwa_issuer \
				  stellax_referrals

.PHONY: help
help:
	@echo "StellaX make targets:"
	@echo "  install         - install required toolchain components"
	@echo "  fmt             - format all Rust + TS code"
	@echo "  fmt-check       - check formatting (CI)"
	@echo "  lint            - run cargo clippy with -D warnings"
	@echo "  build           - cargo build all contracts to $(WASM_TARGET)"
	@echo "  test            - run all cargo unit tests"
	@echo "  optimize        - run 'stellar contract optimize' on every WASM"
	@echo "  bindings        - regenerate TS bindings for SDK + frontend"
	@echo "  deploy-testnet  - deploy contracts to Stellar testnet"
	@echo "  deploy-mainnet  - deploy contracts to Stellar mainnet (interactive)"
	@echo "  demo-preflight  - validate testnet manifests before demo smoke"
	@echo "  demo-e2e-write  - run opt-in mutating RWA write-side e2e"
	@echo "  clean           - remove build artifacts"

.PHONY: install
install:
	rustup toolchain install 1.84.0
	rustup target add $(WASM_TARGET) --toolchain 1.84.0
	rustup component add rustfmt clippy --toolchain 1.84.0
	@command -v stellar >/dev/null || (echo "Install stellar-cli: brew install stellar-cli" && exit 1)
	@command -v wasm-opt >/dev/null || (echo "Install binaryen for wasm-opt" && exit 1)

.PHONY: fmt
fmt:
	$(CARGO) fmt --all

.PHONY: fmt-check
fmt-check:
	$(CARGO) fmt --all -- --check

.PHONY: lint
lint:
	$(CARGO) clippy --workspace --all-targets -- -D warnings

.PHONY: build
build:
	$(STELLAR) contract build

.PHONY: test
test:
	$(CARGO) test --workspace

.PHONY: optimize
optimize: build
	@for c in $(CONTRACT_NAMES); do \
		echo "Optimizing $$c.wasm"; \
		$(STELLAR) contract optimize --wasm $(WASM_DIR)/$$c.wasm; \
	done

.PHONY: bindings
bindings: optimize
	bash scripts/generate-bindings.sh

.PHONY: deploy-testnet
deploy-testnet: optimize
	bash scripts/deploy.sh testnet

.PHONY: deploy-mainnet
deploy-mainnet: optimize
	@read -p "Deploy to MAINNET? Type 'yes' to continue: " ans && [ "$$ans" = "yes" ]
	bash scripts/deploy.sh mainnet

.PHONY: clean
clean:
	$(CARGO) clean
	rm -rf packages/sdk/src/generated packages/frontend/src/generated

# ── Phase Ω8: demo smoke gate ────────────────────────────────────────────────
# Runs the full pre-demo verification suite. Exit non-zero on any failure.
.PHONY: demo-preflight
demo-preflight:
	node scripts/testnet-preflight.mjs

.PHONY: demo-smoke
demo-smoke:
	@echo "▸ cargo workspace tests"
	$(CARGO) test --workspace --quiet
	@echo "▸ sdk build"
	pnpm -F @stellax/sdk build
	@echo "▸ telegram-bot build"
	pnpm -F @stellax/telegram-bot build
	@echo "▸ frontend production build"
	pnpm -F @stellax/frontend build
	@echo "▸ e2e read-only smoke (Phase S/T/U/V)"
	pnpm -F @stellax/e2e exec vitest run src/flows/phase-stuv-smoke.test.ts
	@echo "▸ e2e read-only smoke (RWA oracle + markets)"
	pnpm -F @stellax/e2e exec vitest run src/flows/rwa-smoke.test.ts
	@echo "✅ demo smoke green"

.PHONY: demo-e2e-write
demo-e2e-write:
	@echo "▸ opt-in mutating RWA write-side e2e"
	pnpm -F @stellax/e2e test:rwa:write