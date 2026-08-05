# TypeScript SDK Productionisation Plan

**Status**: Proposed (automated review, July 2026)
**Priority**: P3 — developer-adoption gateway (P2 if a testnet launches with no usable SDK)
**Components**: `typescript-sdk/`, `rust/` (WASM build), `make/client-build.mk`

## What this plan does

Takes `timeflare-sdk` from "works in this repo's examples" to a publishable, documented npm package that a developer outside the project can install and use against a public network — packaging, docs, runtime robustness, and release automation.

## Why

The SDK's functionality is complete (full three-phase creation, hint-based discovery, reconstruction — proven by `make e2e`), but as a *product* it is unshippable today:

- **Publishing would ship a broken package**: `wasm/` is git-ignored and only populated by an external `make` build; `package.json` has no `prepare`/`prepublishOnly` hook, so `npm publish` from a fresh checkout ships an empty `wasm/` directory. Version is 0.1.0, never published.
- **No README** in `typescript-sdk/` at all; `package.json`'s homepage points to a non-existent `/client#readme` path. API documentation exists only as JSDoc in source.
- **Runtime fragility**: the WASM loader branches on `typeof window === 'undefined'` — wrong or broken in web workers, Deno, Bun, edge runtimes, and some bundler configurations. Node loads the `.wasm` via `fs`; browsers via fetch — neither path is exercised by CI in a real browser.
- **Loose ends**: `examples/secret-lifecycle.js:18` imports a `NETWORK_CONFIGS` symbol that doesn't exist anywhere (silently `undefined`); `client.prepareSecret` validates `threshold <= 0` while the Rust floor is 2 (misleading error at the boundary); examples shell out to `timeflared keys` and assume a local devnet, so there is no example a third-party developer can actually run against a remote network.
- The since-deleted TODO.md's client-ecosystem section (Python SDK, Go SDK, component libraries) was aspirational noise until the one SDK that exists is publishable.

## How

### Phase 1 — Packaging correctness

1. Wire the WASM build into the npm lifecycle: `prepack` runs the wasm-pack build (or verifies artefacts exist and match the Rust source hash), failing loudly otherwise. Decide bundling strategy: inline the WASM as base64 in a JS module (simplest for consumers, ~size cost), or ship `.wasm` + robust multi-runtime loader.
2. Modernise the loader: feature-detect capabilities rather than environments where possible; explicit documented support matrix (Node ≥ 18, evergreen browsers, bundler notes for Vite/webpack); conditional `exports` map in `package.json` (`import`/`require`/`browser`).
3. Rename/scope decision: `timeflare-sdk` vs `@timeflare/sdk` — pick before first publish (renames after publication are painful).
4. Fix the loose ends: remove the phantom `NETWORK_CONFIGS` import (or implement named network presets — devnet/testnet endpoints — which the symbol name suggests was the intent and is genuinely useful); align the threshold validation floor with Rust's (2); fix the homepage URL.

### Phase 2 — Documentation

1. `typescript-sdk/README.md`: install, quickstart (create → discover → reconstruct against a public endpoint), the key-management caveats (recipient private key custody), support matrix, link to spec.md for protocol semantics.
2. Generated API reference (TypeDoc) published with the docs site or as part of releases.
3. A **standalone example** that runs against a testnet with only npm — no `timeflared` binary, no local keyring (CosmJS mnemonic signer): this is the real adoption test. (Depends on a public network existing — TESTNET_LAUNCH.)

### Phase 3 — CI & release automation

1. Browser-reality test: a headless-browser (playwright) smoke test that loads the WASM and round-trips seal/unseal — the current Jest suite mocks the WASM/chain layers and cannot catch loader regressions.
2. npm publish job in the release workflow (RELEASE_ENGINEERING), version-synchronised with the repo tag or independently versioned (see open questions); `npm pack` dry-run + install-from-tarball smoke test in CI so packaging can't silently rot.
3. Keep the SDK's generated protobuf types (`proto:gen`) verified against `proto/` in CI (drift check) — the proto-breaking launch switch will eventually protect consumers, but the SDK should fail fast on drift now.

## Open questions

1. **Package identity**: npm scope/name, and is the SDK versioned with the chain (one tag, one version — simpler) or independently (semver reflects SDK API, not protocol)?
2. **WASM delivery**: inline-base64 (zero-config for consumers, +~30% size, no streaming compile) vs. file-based (leaner, but every bundler/runtime combination is a support ticket)? Recommend inline for v0, revisit at size pressure.
3. **How much chain-query surface should the SDK wrap?** Today it wraps 8 of the 13 query RPCs; full parity (assignments, reveals, meta, pending) is easy and makes the SDK the canonical client — or keep it minimal and point advanced users at generated clients?
4. **Signer custody guidance**: examples currently normalise reading private keys from JSON files; published docs need a stated position (mnemonic/env for dev, wallet-adapter for browser). Browser wallet integration (Keplr — requires chain registry + suggest-chain config) is probably its own small plan; in scope here or deferred?
5. **Other-language SDKs** (Python/Go, from the since-deleted TODO.md): explicitly out of scope until this ships? (Recommended.)
6. **Client compatibility across chain upgrades** (absorbed from the deleted `docs/guides/UNSOLVED.md`, August 2026): what protocol-versioning does the SDK carry (message-format version fields? a chain-version handshake?), what backward-compatibility window is promised, how are breaking changes announced to SDK consumers and guardian operators (a chain-emitted upgrade notice clients can watch?), and what happens to a guardian daemon running an outdated binary across an upgrade height? Interlocks with question 1 (versioning scheme) and RELEASE_ENGINEERING.
