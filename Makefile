# timeflare TypeScript SDK — Makefile
#
# This package implements none of the protocol itself. It is an assembly of
# three things owned elsewhere:
#
#   the primitives   compiled to WASM by timeflareio/crypto
#   the wire format  generated from timeflareio/chain's protobuf definitions
#   conformance      asserted against BOTH repositories' vector corpora
#
# Each arrives at a pinned version (versions.env) and is verifiable. None is
# built from a sibling directory, which is what makes this package buildable by
# someone who has only cloned this repository.
#
# npm scripts remain the inner loop (build, test, lint). Make owns the
# cross-repository edges, because those are the parts npm cannot express.

.DEFAULT_GOAL := help

include versions.env

# The corpora, split by which repository implements the behaviour each pins.
# crypto owns the primitives; the chain owns its own semantics. This package
# asserts some of both because it sits downstream of both.
CRYPTO_VECTORS := low_order_keys
CHAIN_VECTORS  := client_conventions creation_fee dials share_band tx_gas wallet_derivation
VECTORS_DIR    := src/vendor/vectors

CHAIN_RAW := https://raw.githubusercontent.com/timeflareio/chain

##@ Testing

.PHONY: test
test: vectors-verify ## Run the test suite against the pinned corpora
	@npm test

# `npm run lint` is deliberately NOT here. The script exists but has never been
# runnable: ESLint 9 requires a flat config file, and no eslint config exists in
# this package or the monorepo it came from — the monorepo's CI ran build and
# test only, so nobody hit it. Gating on it now would fail on debt that predates
# the lift and needs a rule set chosen, which is not a lift decision.
# docs/planning/PENDING_LINT_SETUP_PLAN.md tracks it.
.PHONY: verify
verify: vectors-verify ## Read-only checks: types and vendored corpora
	@npx tsc --noEmit
	@echo "✅ Type check and corpora OK"
	@echo "ℹ  ESLint not yet configured — docs/planning/PENDING_LINT_SETUP_PLAN.md"

##@ Build

.PHONY: build
build: wasm-sync ## Build the distributable (requires the WASM bundle)
	@npm run build

.PHONY: install
install: ## Install dependencies from the lockfile
	@npm ci

##@ Cross-repository artefacts

## fetch the WASM bundle from the pinned timeflareio/crypto release
wasm-sync:
	@set -e; \
	if [ -f wasm/timeflare_crypto.js ]; then \
		echo "📦 WASM already present (make clean-wasm to refetch)"; exit 0; \
	fi; \
	echo "📦 Fetching WASM from timeflareio/crypto@$(CRYPTO_VERSION)"; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	gh release download "$(CRYPTO_VERSION)" --repo timeflareio/crypto \
		--pattern 'timeflare-crypto-wasm-*.tgz' --dir "$$tmp"; \
	mkdir -p wasm; \
	tar -xzf "$$tmp"/timeflare-crypto-wasm-*.tgz -C wasm; \
	test -f wasm/timeflare_crypto.js || { echo "❌ bundle did not contain timeflare_crypto.js"; exit 1; }; \
	echo "✅ WASM $(CRYPTO_VERSION) ready"

.PHONY: clean-wasm
clean-wasm: ## Remove the fetched WASM bundle
	@rm -rf wasm

## refresh the vendored vector corpora from their owning repositories
vectors-sync:
	@set -e; \
	mkdir -p $(VECTORS_DIR); \
	echo "📐 Primitive vectors from timeflareio/crypto@$(CRYPTO_VERSION)"; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	gh release download "$(CRYPTO_VERSION)" --repo timeflareio/crypto \
		--pattern 'timeflare-crypto-vectors-*.tar.gz' \
		--pattern 'timeflare-crypto-vectors-*.sha256' --dir "$$tmp"; \
	tar -xzf "$$tmp"/timeflare-crypto-vectors-*.tar.gz -C "$$tmp"; \
	for v in $(CRYPTO_VECTORS); do \
		src=$$(find "$$tmp" -name "$$v.json" -print -quit); \
		[ -n "$$src" ] || { echo "❌ $$v.json absent from the crypto corpus"; exit 1; }; \
		want=$$(grep -E "[ /]$$v\.json$$" "$$tmp"/timeflare-crypto-vectors-*.sha256 | awk '{print $$1}'); \
		got=$$(shasum -a 256 "$$src" | awk '{print $$1}'); \
		[ "$$want" = "$$got" ] || { echo "❌ $$v.json fails crypto's manifest"; exit 1; }; \
		cp "$$src" "$(VECTORS_DIR)/$$v.json"; \
	done; \
	echo "📐 Chain-semantics vectors from timeflareio/chain@$(CHAIN_VERSION)"; \
	for v in $(CHAIN_VECTORS); do \
		curl -sSfL --retry 3 --retry-delay 2 --retry-all-errors \
			-o "$(VECTORS_DIR)/$$v.json" \
			"$(CHAIN_RAW)/$(CHAIN_VERSION)/testdata/vectors/$$v.json"; \
	done; \
	echo "✅ Corpora synced — review the diff, then run 'make test'"

## verify the vendored corpora still match their pinned sources
vectors-verify:
	@set -e; \
	missing=""; \
	for v in $(CRYPTO_VECTORS) $(CHAIN_VECTORS); do \
		[ -f "$(VECTORS_DIR)/$$v.json" ] || missing="$$missing $$v"; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "❌ Vendored vectors missing:$$missing"; \
		echo "   Run 'make vectors-sync'."; exit 1; \
	fi; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	fail=0; \
	gh release download "$(CRYPTO_VERSION)" --repo timeflareio/crypto \
		--pattern 'timeflare-crypto-vectors-*.sha256' --dir "$$tmp" >/dev/null 2>&1 || { \
		echo "❌ could not read crypto@$(CRYPTO_VERSION)'s manifest"; exit 1; }; \
	for v in $(CRYPTO_VECTORS); do \
		want=$$(grep -E "[ /]$$v\.json$$" "$$tmp"/*.sha256 | awk '{print $$1}'); \
		got=$$(shasum -a 256 "$(VECTORS_DIR)/$$v.json" | awk '{print $$1}'); \
		[ "$$want" = "$$got" ] || { echo "❌ $$v.json differs from crypto@$(CRYPTO_VERSION)"; fail=1; }; \
	done; \
	for v in $(CHAIN_VECTORS); do \
		curl -sSfL --retry 3 -o "$$tmp/$$v.json" \
			"$(CHAIN_RAW)/$(CHAIN_VERSION)/testdata/vectors/$$v.json" || { \
			echo "❌ could not read chain@$(CHAIN_VERSION)'s $$v.json"; fail=1; continue; }; \
		cmp -s "$$tmp/$$v.json" "$(VECTORS_DIR)/$$v.json" || { \
			echo "❌ $$v.json differs from chain@$(CHAIN_VERSION)"; fail=1; }; \
	done; \
	if [ $$fail -ne 0 ]; then \
		echo "   Run 'make vectors-sync' — never hand-edit $(VECTORS_DIR)."; \
		echo "   These files belong to the repositories that implement what they pin;"; \
		echo "   editing them here would assert conventions nothing implements."; \
		exit 1; \
	fi; \
	echo "✅ Vendored corpora match crypto@$(CRYPTO_VERSION) and chain@$(CHAIN_VERSION)"

## regenerate src/generated/ from the pinned chain's protobuf definitions
proto-sync:
	@set -e; \
	command -v buf >/dev/null 2>&1 || { echo "❌ buf is required (https://buf.build)"; exit 1; }; \
	echo "🔌 Fetching protobuf definitions from timeflareio/chain@$(CHAIN_VERSION)"; \
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	curl -sSfL --retry 3 \
		"https://github.com/timeflareio/chain/archive/refs/tags/$(CHAIN_VERSION).tar.gz" \
		| tar -xz -C "$$tmp" --strip-components=1 '*/proto' '*/buf.yaml' '*/buf.lock'; \
	mkdir -p src/generated; \
	( cd "$$tmp" && buf generate --template proto/buf.gen.ts.yaml \
		--output "$(CURDIR)/src/generated" ); \
	echo "✅ Regenerated from chain@$(CHAIN_VERSION) — review the diff and commit it"

##@ Misc

.PHONY: clean
clean: ## Remove build output, dependencies and fetched artefacts
	@rm -rf dist wasm node_modules dist-release
	@echo "✅ Cleaned"

.PHONY: doctor
doctor: ## Check the local toolchain
	@ok=0; \
	for t in node npm gh curl shasum; do \
		if command -v $$t >/dev/null 2>&1; then printf "  ✅ %-8s %s\n" "$$t" "$$(command -v $$t)"; \
		else printf "  ❌ %-8s MISSING\n" "$$t"; ok=1; fi; \
	done; \
	printf "  ℹ️  %-8s only needed for 'make proto-sync'\n" "buf"; \
	exit $$ok

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@echo ""

.PHONY: wasm-sync vectors-sync vectors-verify proto-sync
