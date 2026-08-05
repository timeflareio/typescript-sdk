# Publication Footprint — Plan

*Reduces what this project publishes, and how consumers pin it. Every edge that
can move goes onto the resolver its language already has, and nothing is published
that no consumer asserts. This plan lives here because this package sits at the
centre of the edges it changes — it consumes the WASM bundle and both vector
corpora, and it is the artefact the mobile client vendors — but the footprint is
the sum of all five repositories, so all five are touched.*

> **Status: in progress** — created and ruled 5 August 2026 (§7). Phase 1 landed
> in `crypto` (#7, released `v0.0.2`) and `mobile-client` (#13); phase 2's chain
> half landed (chain #23, released `x/secrets/types/v0.0.3`); phase 4 landed
> (#7, released `v0.0.3`). Phase 2's guardian half and phases 3, 5 and 6 remain.
> **Priority**: P3 — maintenance burden and drift risk rather than correctness.
> P2 once a testnet needs an SDK a third party can install without vendoring a
> tarball by hand.
> **Origin**: design session, August 2026 — a walk of the versioning and release
> surface across all five repositories, followed by a per-file audit of what the
> vector corpora actually bind.
> **Components**: §6, which is the blast-radius checklist. Related plans:
> `PENDING_SDK_PRODUCTIONISATION_PLAN.md` in this repository.

## 1. What this plan does

Three things, in this order of value:

1. **Stops publishing three vector files that bind nothing across a repository
   boundary.** The audit in §3 shows which files earn distribution and which do
   not.
2. **Moves the TypeScript and Go artefact edges onto their language's own
   resolver**, so that fetching, hash-verifying and recording a pin are done by a
   toolchain rather than by a Makefile. No package registry is involved: npm
   resolves a published release asset directly, and the lockfile carries its
   integrity hash.
3. **Reduces the pins nothing checks from eight to three** (§2), and closes the
   one drift risk this survey found with no detection at all — mobile's crypto
   version in three places.

It deliberately leaves the largest single artefact alone; §8 says why.

## 2. Why

The project moves released artefacts between repositories by hand. Every edge
reimplements what a package manager does: fetch by version, verify by hash,
record the pin. Measured on 5 August 2026:

| | Today | After |
|---|---|---|
| Make targets whose only job is moving artefacts between repositories | **12** | **7** — five deleted, two reduced to one corpus each |
| Hand-written pins that no toolchain checks | **8** — `CRYPTO_VERSION`/`CHAIN_VERSION` ×2 in two `versions.env`, `SDK_VERSION` ×2, `GUARDIAN_VERSION`, `CHAIN_VECTORS_VERSION` | **3** — the SDK's `CHAIN_VERSION`, and the devnet's two |
| `versions.env` files | 3 | 2 — mobile's goes; this repository's reduces to one value |
| Bespoke vendoring shell | 260 lines in `mobile-client/scripts` | `sdk-sync.sh` (67) goes |
| Committed upstream artefacts | ~1.0 MB | ~0.75 MB — the vendored tarball (236K) and the guardian's corpus (20K) go |

Two consequences of the current shape are already visible in the tree:

- **A pin can name an artefact that does not exist.** The chain's
  `devnet/versions.env` pins `GUARDIAN_VERSION=v0.0.4`; the guardian's latest tag
  is `v0.0.3`. A dependency resolved by a toolchain fails at install time; a
  version in a shell variable fails later, during a devnet run, if at all.
- **A version can live in three places with nothing comparing them.**
  `mobile-client` records the crypto version in `versions.env`, in the `tag =` of
  `packages/crypto/rust/Cargo.toml`, and in `Cargo.lock`. The Cargo pair decides
  what is built; `versions.env` decides which vectors it is asserted against.
  Only a comment asks them to agree, so a drift would test one version of the
  primitives against another's expectations.

A third incoherence is cheap to close alongside: nothing compares this package's
`version` field with the tag it ships under, so it declares `0.1.0` inside a
release tagged `v0.0.2`, and the mobile lockfile records `0.1.0` as a result. The
release workflow asserts the two agree (§5, phase 4).

## 3. What the corpora actually bind

A vector file earns distribution only if the implementations it pins live in
different repositories. Audited by locating every assertion of every file:

| Vector | Independent implementations pinned | Asserted in | Crosses a boundary |
|---|---|---|---|
| `encryption.json` | Go, Rust — **both in `crypto/`** | `crypto/go`, `crypto/rust`, + the UniFFI wrapper | **No** |
| `detection_hint.json` | Go, Rust — both in `crypto/` | as above | **No** |
| `hmac.json` | Go, Rust — both in `crypto/` | as above | **No** |
| `low_order_keys.json` | Go, Rust, **+ TypeScript** | `crypto/`, this package (`UnusableGuardianKeyError` rejects before the WASM boundary) | Yes |
| `rebate_commitment.json` | Go, Rust, **+ TypeScript** | `crypto/`, `mobile-client/app/src/state/rebate.ts` (computed with `@noble`, not through the binding) | Yes |
| `share_band.json` | chain Go, SDK TS | `chain/x/secrets/types`, this package | Yes |
| `tx_gas.json` | chain Go, SDK TS | `chain/x/secrets/keeper`, this package | Yes |
| `creation_fee.json` | chain Go, SDK TS | `chain/x/secrets/types`, this package | Yes |
| `dials.json` | chain Go, SDK TS | `chain/x/secrets/keeper`, this package | Yes |
| `wallet_derivation.json` | chain Go, **guardian Go**, SDK TS | three repositories | Yes |
| `client_conventions.json` | guardian Go, SDK TS, mobile TS | three repositories, **none of them the chain, which owns it** | Yes |

**Eight of eleven earn distribution; three do not.** `encryption`,
`detection_hint` and `hmac` pin Go against Rust, both of which live in `crypto/`.
The only downstream run is `mobile-client`'s UniFFI wrapper exercising the *same*
crate, which tests marshalling across the FFI boundary — argument order, byte
arrays, truncation — not the algorithm. That coverage is worth keeping as one
small fixture held in the wrapper, whose test states plainly that it covers the
boundary and not the primitives; it does not need a versioned corpus.

Two findings shape the target shape rather than the corpus:

- `wallet_derivation.json` and `client_conventions.json` have **Go** consumers in
  the guardian, which already pins `x/secrets/types`. Those two need no new
  channel at all.
- `client_conventions.json` is asserted by three repositories and by none of its
  owner. The chain publishes it and never runs it.

## 4. Target shape

One resolver per language, each of which already verifies by hash and records the
pin in a file the toolchain reads. Packages are named for the organisation and
repository they come from: `@timeflareio/crypto` and
`@timeflareio/typescript-sdk`.

| Edge | Resolver | Pin lives in |
|---|---|---|
| crypto Go module → chain, guardian | Go proxy | `go.mod` — unchanged, already conventional |
| chain wire contract → guardian | Go proxy | `guardian/go.mod` — unchanged |
| **chain vectors → guardian** | inside `x/secrets/types` (`testdata/` is files in a module) | `guardian/go.mod` |
| crypto crate → mobile | Cargo git tag | `packages/crypto/rust/Cargo.toml` + `Cargo.lock`, and nowhere else |
| `@timeflareio/crypto` (WASM + travelling primitive vectors) → this package | npm, from the release asset | `package.json` + lockfile |
| `@timeflareio/typescript-sdk` → mobile | npm, from the release asset | `app/package.json` + lockfile |
| **chain vectors → TypeScript consumers** | inside `@timeflareio/typescript-sdk` | `app/package.json` + lockfile |
| guardian binaries → devnet | container image tag for the compose path | the chain's compose definition |
| SDK examples → devnet e2e | GitHub release asset, unchanged | the chain's devnet configuration |

Both npm edges resolve the tarball its release already publishes — the
`https://github.com/…/releases/download/<tag>/<name>-<tag>.tgz` asset — and npm
records that URL and the artefact's `integrity` hash in the consumer's lockfile.
Nothing is built on install, and nothing new is committed or published:
`timeflare-crypto-wasm-<tag>.tgz` and `timeflare-sdk-<tag>.tgz` exist today. Two
consequences are accepted: the pin is a URL carrying its own version, so these two
edges have no semver ranges and no automated dependency updates; and the guarantee
rests on a published release asset not being replaced after the fact, rather than
on the tarball being byte-reproducible.

That retires byte-reproducibility as a requirement on the dist-only artefact. The
two-artefact split survives on a different justification: the WASM is a declared
dependency rather than bundled content, and examples are not package content at
all. The examples bundle therefore stays exactly as it is — the devnet e2e harness
runs from it, and it is not part of the footprint that hurts.

**The chain-owned vectors that TypeScript asserts travel inside this package.**
The five files this package and the mobile app read are held here and shipped in
the released tarball, so the mobile client obtains `client_conventions.json` as an
ordinary consequence of depending on the SDK and stops fetching from the chain
altogether. This package keeps one chain pin for refreshing them. That makes this
package a carrier for data it does not own, which is the accepted cost: the
alternative is a new published TypeScript artefact from a Go repository, and that
belongs to the proto-distribution question in §8 rather than to five small JSON
files.

## 5. Phases

Ordered so that each phase is independently landable and no phase waits on a
decision that a later one makes. The order is forced where an edge points
downstream: crypto's artefact must be resolvable before this package depends on
it, and this package's before the mobile client consumes it.

**Phase 1 — stop publishing what nothing asserts.** `crypto` keeps
`encryption`, `detection_hint` and `hmac` in-repo and its release stops carrying
the corpus tarball; the UniFFI wrapper gains the boundary fixture described in
§3. No consumer changes, so this is the cheapest phase and it depends on nothing
else. Should `CRYPTO_ASSURANCE_PLAN.md` later need a corpus published for an
external reviewer, that is its call to make and its justification to state —
publishing for auditors is a different argument from publishing for consumers,
and the tagged source satisfies it today.

**Phase 2 — chain vectors reach their Go consumer through the module.** Move
`wallet_derivation.json` and `client_conventions.json` into `x/secrets/types`.
The guardian drops `CHAIN_VECTORS_VERSION`, `vectors-sync` and `vectors-verify`,
and asserts them from the module it already requires. Needs a wire-contract tag,
so it walks the chain's `PROTOCOL_CHANGE.md`.

**Phase 3 — `@timeflareio/crypto` becomes an npm dependency.** `crypto`'s WASM
package is renamed to match, and this repository depends on its release asset URL,
drops `wasm-sync` and its `wasm/` ignore rule, and imports the WASM through the
dependency in `src/backends/wasm.ts` rather than from a synced directory. The
crypto half of `vectors-sync` and `vectors-verify` goes with it, leaving both
targets covering the chain corpus only. Smallest blast radius of any resolver
change — one consumer — so it is where the mechanics get proven, including reading
the packed file list before anything depends on it.

**Phase 4 — `@timeflareio/typescript-sdk` becomes an npm dependency.** The
package is renamed; the published file list grows to carry the chain vectors the
mobile client asserts; and the release workflow asserts that the package's
`version` equals the tag being released, failing the release when they disagree.
The determinism machinery around the dist-only artefact comes out here, along with
the reasoning recorded for it in the workflow.

**Phase 5 — flip the mobile client.** `app/package.json` and `e2e/package.json`
depend on the tagged artefact; `versions.env`, `vendor/`, `sdk-sync.sh`,
`sdk-verify`, the CI byte-compare and the vendored copy of the chain corpus all
go, with the regenerated lockfile in the same change. The crypto version reduces
to the Cargo pair, which is the drift this plan set out to close.

**Phase 6 — the devnet and the record.** The guardian pin is expressed as the
container image tag on the compose path. A `COMPATIBILITY.md` row is appended only
after `make e2e` and `make e2e-scenarios` pass against those exact artefacts.

## 6. Components

- **`typescript-sdk/`** (this repository) — `package.json`, `versions.env`,
  `Makefile` (`wasm-sync`, `vectors-sync`, `vectors-verify`),
  `.github/workflows/release.yml`, `src/backends/wasm.ts`, `src/vendor/vectors/`,
  `.gitignore`, `src/protocol/__tests__/`.
- **`crypto/`** — `vectors/`, `.github/workflows/release.yml`, `rust/`
  packaging, `wasm/package.json` (name and version), `README.md` versioning
  section.
- **`chain/`** — `x/secrets/types/` (the new vector home), `testdata/vectors/`,
  `.github/workflows/release.yml`, `devnet/versions.env`, `make/devnet.mk`,
  `make/docker.mk`, the compose definition, `COMPATIBILITY.md`,
  `PROTOCOL_CHANGE.md`.
- **`guardian/`** — `testdata/vectors/`, `CHAIN_VECTORS_VERSION`, `Makefile`
  (`vectors-sync`, `vectors-verify`), `go.mod`,
  `internal/custody/mnemonic_vectors_test.go`,
  `internal/chain/wallet_key_test.go`.
- **`mobile-client/`** — `versions.env`, `vendor/`, `scripts/sdk-sync.sh`,
  `scripts/vendor.sh`, `Makefile`, `packages/crypto/vendor/vectors/`,
  `packages/crypto/rust/{Cargo.toml,tests}`, `app/package.json`,
  `e2e/package.json`, `package-lock.json`, `.github/workflows/ci.yml`.
- **Cross-cutting** — every `README.md` that documents a sync target, and the
  workspace-level description of which way things point.

## 7. Decisions — RULED (5 August 2026)

1. **npm resolves a published release asset; no registry publication.** The
   `timeflareio` npm organisation exists, which reserves the scope, but nothing is
   published to the registry. A git dependency was rejected on evidence: `dist/`
   and `wasm/` are git-ignored and there is no `prepare` script, so a
   `github:…#tag` dependency installs a package with no build output, and building
   on install would need `gh` authentication in the consumer's environment.
2. **Packages are named `@timeflareio/crypto` and `@timeflareio/typescript-sdk`**,
   mirroring the organisation and repository names.
3. **The chain-owned vectors that TypeScript asserts travel inside this package**
   (§4). The alternative — a TypeScript artefact published by the chain — is a new
   component whose real prize is the generated protobuf code, so it is argued on
   that basis in its own plan rather than settled here.
4. **FFI marshalling coverage is kept as one fixture in the UniFFI wrapper**, not
   as a versioned corpus.
5. **The examples bundle is unchanged**, and stays a GitHub release asset.
6. **If registry publication is ever adopted**, it goes through trusted publishing
   via GitHub Actions OIDC with provenance attestations, so that no long-lived
   credential exists to leak. Nothing in this plan requires it.
7. **The primitive corpus stops being published** without waiting on
   `CRYPTO_ASSURANCE_PLAN.md`. Publishing for an external reviewer is a different
   justification from publishing for consumers, and the tagged source satisfies it
   today.

## 8. What this plan does not solve

- **Proto distribution, and with it the largest committed artefact.**
  `proto-sync`, this repository's `CHAIN_VERSION` pin and the 704K of generated
  code in `src/generated/` are all untouched. Retiring them means the chain
  publishing a TypeScript artefact, which needs a Node build in a Go repository's
  release pipeline and a new-component case made under architectural minimalism.
  That is the single largest remaining reduction and it deserves its own plan.
- **The guardian's mirrored `replace` block shrinks; it does not go.** The gin
  pin can become a plain `require`, which MVS propagates to consumers. The
  goleveldb pin is a *downgrade*, which MVS cannot express, and
  `nhooyr.io/websocket → coder/websocket` is a module-path rewrite. Both need
  `replace`, so `verify-pins` stays with less to check.
- **The devnet's own pins.** `devnet/versions.env` survives: the compose path
  moves to an image tag, but the binary path and the examples bundle still need a
  version, and `guardiand-sync` and the devnet's `sdk-sync` stay.
  `mobile-client`'s `networks-sync` is unrelated to this plan — the fallback
  network list is pinned to nothing by design.
- **Binary and image release mechanics.** Whether `goreleaser` replaces the
  hand-written cross-compile matrices is a separate concern with its own
  new-component argument to make.
- **The chain's own publication** of two Go modules, node binaries and the
  container image, which is its `PENDING_RELEASE_STRATEGY_PLAN.md`'s subject.
- **This package's packaging correctness** — the loader, the exports map, the
  documentation and the runtime support matrix — which is
  `PENDING_SDK_PRODUCTIONISATION_PLAN.md`'s subject. That plan's phase 1 assumes
  the WASM is built here; phase 3 of this plan makes it a dependency instead, so
  that section needs rewriting in place before either plan executes.
- **`COMPATIBILITY.md` remains hand-appended.** The streams stay independent, so
  the matrix is still the only place they are related; its corpus columns narrow
  as vectors move inside modules.
- **The dangling `GUARDIAN_VERSION=v0.0.4` pin** is a defect to fix on its own,
  not by this plan. Phase 6 assumes the guardian has by then released the tag its
  content is already on.
- **Nothing here changes what the primitives produce, what the protocol
  requires, or any assertion any implementation makes.** Only where the bytes
  come from and where the version is written down.
