# TypeScript SDK Productionisation — Plan

*Takes this package from "works in this repository's examples" to one a developer
outside the project can install and use against a public network: the WASM loader
and its support matrix, the documentation, and the CI that keeps packaging honest.*

> **Status: refining** — §4 carries the open questions; not executable until they
> are ruled and folded into the body.
> **Priority**: P3 — developer-adoption gateway. P2 if a testnet launches with no
> usable SDK.
> **Origin**: automated review, July 2026.
> **Components**: `package.json` (`exports`, `files`), `src/backends/wasm.ts`,
> `src/protocol/`, `examples/`, `README.md` (absent), `docs/`,
> `.github/workflows/ci.yml`.

## 1. Scope, and what belongs elsewhere

This plan covers **packaging correctness, documentation and CI**.

How the package is distributed, named and versioned belongs to
`PENDING_PUBLICATION_FOOTPRINT_PLAN.md`, which rules that the package is
`@timeflareio/typescript-sdk`, that consumers resolve it from a published release
asset rather than a registry, that the WASM arrives as a dependency on
`@timeflareio/crypto` rather than a directory synced by make, and that the release
asserts the package's `version` against the tag. This plan assumes that shape and
does not restate it.

The two interlock in one place: the loader. Resolving the WASM through a
dependency is the footprint plan's phase 3; making that resolution robust across
runtimes is §3 phase 1 here. Phase 3 there lands first.

## 2. Why

The functionality is complete — full three-phase creation, hint-based discovery,
reconstruction, all proven by the chain's `make e2e`. What is missing is
everything between "the code works" and "a stranger can use it":

- **No `README.md`.** API documentation exists only as JSDoc in source, so the
  entry point for a new consumer is reading the source tree.
- **The loader branches on the environment, not on capability.**
  `typeof window === 'undefined'` is wrong or broken in web workers, Deno, Bun,
  edge runtimes and several bundler configurations. Node loads the `.wasm` via
  `fs` and browsers via `fetch`, and neither path is exercised in a real browser.
- **The test suite cannot catch a loader regression.** Jest mocks the WASM and
  chain layers, which is right for protocol logic and useless for packaging: the
  failure mode this package is most likely to ship is one no test would see.
- **No example a third party can run.** The examples require a devnet and take
  `RECIPIENT_KEYPAIR` from the environment, which is correct for this repository
  and unusable for someone with only npm and a public endpoint.

## 3. Phases

**Phase 1 — the loader and the package surface.** Feature-detect capabilities
rather than environments; state a support matrix (Node, evergreen browsers,
bundler notes for Vite and webpack) and test against it; give `package.json` a
conditional `exports` map covering `import`, `require` and `browser`. The WASM is
resolved through the `@timeflareio/crypto` dependency, so this phase begins after
the footprint plan's phase 3.

**Phase 2 — documentation.** A `README.md` carrying install, a quickstart that
runs create → discover → reconstruct against a public endpoint, the key-custody
caveats for recipient private keys, the support matrix, and a link to the chain's
`docs/spec.md` for protocol semantics. A generated API reference (TypeDoc)
published with releases. A standalone example that needs nothing but npm and an
endpoint — no `timeflared` binary, no local keyring — which is the real adoption
test, and which depends on a public network existing.

**Phase 3 — CI that keeps packaging honest.** A headless-browser smoke test
(Playwright) that loads the WASM and round-trips seal/unseal, because the Jest
suite structurally cannot. An install-from-artefact smoke test, so that what
consumers actually resolve is exercised rather than assumed. A drift check holding
`src/generated/` against the chain's `proto/` at the pinned tag, so a proto change
fails here rather than at a consumer.

## 4. Open questions

1. **WASM delivery: inline or file?** Inline base64 is zero-configuration for
   consumers at roughly 30% size cost and no streaming compile; a file is leaner
   but every bundler and runtime combination becomes a support question. The
   decision now sits behind a package boundary — `@timeflareio/crypto` produces
   the artefact — so it may belong to `crypto` rather than here.
   *Recommendation*: inline for the first consumable release, revisited under size
   pressure; and if the artefact shape is what decides it, `crypto` owns the call.
2. **How much of the chain's query surface should this package wrap?** It wraps a
   subset today — 8 of 13 query RPCs at the last count. Full parity is
   straightforward and makes this the canonical client; staying minimal keeps the
   surface small and points advanced users at generated clients.
   *Recommendation*: parity, because a consumer who has to reach past the SDK for
   a query will reach past it for everything.
3. **Signer custody guidance.** Published documentation needs a stated position:
   mnemonic or environment for development, wallet adapter for the browser.
   Browser wallet integration needs a chain-registry entry and suggest-chain
   configuration, which is its own small plan.
   *Recommendation*: state the position here; defer the wallet integration.
4. **Client compatibility across chain upgrades.** What protocol versioning this
   package carries (a message-format version field, a chain-version handshake),
   what backward-compatibility window is promised, and how a breaking change
   reaches consumers. This is a protocol question before it is an SDK one, so it
   needs the chain's ruling first.

## 5. What this plan does not solve

- **Distribution, naming and versioning** — `PENDING_PUBLICATION_FOOTPRINT_PLAN.md`.
- **Proto distribution.** `src/generated/` stays committed and `proto-sync` stays,
  per that plan's §8; phase 3's drift check makes the current arrangement safe
  rather than replacing it.
- **Other-language SDKs.** Python and Go clients stay out of scope until this one
  ships; a second SDK before the first is usable would be a new component with no
  case made.
- **A public network.** Phase 2's standalone example cannot exist until one does.
