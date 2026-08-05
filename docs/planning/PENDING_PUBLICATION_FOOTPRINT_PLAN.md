# Publication Footprint — Plan

*Reduces what this project publishes, and how consumers pin it. Every edge moves
to the distribution channel its language already has, and nothing is published
that no consumer asserts. This plan lives here because this package sits at the
centre of the edges it changes — it consumes the WASM bundle and both vector
corpora, and it is the artefact the mobile client vendors — but the footprint is
the sum of all five repositories, so all five are touched.*

> **Status: refining** — created 5 August 2026. The questions in §7 are
> unresolved; this plan is not executable until they are ruled and folded into
> the body.
> **Priority**: P3 — maintenance burden and drift risk rather than correctness.
> P2 once a testnet needs an SDK a third party can install without vendoring a
> tarball by hand.
> **Origin**: design session, August 2026 — a walk of the versioning and release
> surface across all five repositories, followed by a per-file audit of what the
> vector corpora actually bind.
> **Components**: §6, which is the blast-radius checklist. Related plans:
> `PENDING_SDK_PRODUCTIONISATION_PLAN.md` in this repository, and
> `PENDING_RELEASE_STRATEGY_PLAN.md` §6 in `timeflareio/chain`.

## 1. What this plan does

Three things, in this order of value:

1. **Stops publishing three vector files that bind nothing across a repository
   boundary.** The audit in §3 shows which files earn distribution and which do
   not.
2. **Moves each surviving edge onto its language's own channel** — Go modules for
   Go consumers, npm for TypeScript consumers, Cargo for the Rust consumer — so
   that fetching, hash-verifying and recording a pin are done by a toolchain
   rather than by a Makefile.
3. **Leaves one pin per edge, in the manifest the toolchain already reads**,
   which closes the one drift risk this survey found with no detection at all
   (§2, mobile's crypto version in three places).

## 2. Why

The project distributes released artefacts between repositories by hand, because
nothing is published to a package registry. Every edge therefore reimplements
what a package manager does: fetch by version, verify by hash, record the pin.
Measured on 5 August 2026:

| | Today |
|---|---|
| Make targets whose only job is moving artefacts between repositories | **12** — `wasm-sync`, `proto-sync`, `vectors-sync` ×2, `vectors-verify` ×2, `verify-pins`, `sdk-sync` ×2, `sdk-verify`, `guardiand-sync`, `networks-sync` |
| Share of a Makefile that is this machinery | roughly half of `typescript-sdk` (104 of 201 lines), about a quarter of `guardian` (85 of 334) |
| Bespoke vendoring shell | 260 lines in `mobile-client/scripts` |
| Release workflow | 677 lines across the four `release.yml` files |
| Pin mechanisms | **4** — `go.mod` requires, three `versions.env` files, a bare `CHAIN_VECTORS_VERSION` file, a Cargo git tag |
| Pinned values | **13** across those mechanisms |
| Committed upstream artefacts | ~1.0 MB — `typescript-sdk/src/generated` (704K), `mobile-client/vendor/timeflare-sdk.tgz` (236K), `typescript-sdk/src/vendor/vectors` (44K), `guardian/testdata/vectors` (20K) |

Two consequences are already visible in the tree:

- **A pin can name an artefact that does not exist.** The chain's
  `devnet/versions.env` pins `GUARDIAN_VERSION=v0.0.4`; the guardian's latest tag
  is `v0.0.3`. A manifest resolved by a toolchain fails at resolve time; a
  version in a shell variable fails later, during a devnet run, if at all.
- **A version can live in three places with nothing comparing them.**
  `mobile-client` records the crypto version in `versions.env`, in the `tag =` of
  `packages/crypto/rust/Cargo.toml`, and in `Cargo.lock`. The Cargo pair decides
  what is built; `versions.env` decides which vectors it is asserted against.
  Only a comment asks them to agree, so a drift would test one version of the
  primitives against another's expectations.

Publishing also fixes a smaller incoherence for free: a registry refuses a
duplicate version, so the package's own version number must equal the release
tag. Today this package ships `0.1.0` inside a release tagged `v0.0.2`, and the
mobile lockfile records `0.1.0` as a result.

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
arrays, truncation — not the algorithm. That is real but narrow, and §7 Q4 asks
what to keep of it.

Two findings shape the target shape rather than the corpus:

- `wallet_derivation.json` and `client_conventions.json` have **Go** consumers in
  the guardian, which already pins `x/secrets/types`. Those two need no new
  channel at all.
- `client_conventions.json` is asserted by three repositories and by none of its
  owner. The chain publishes it and never runs it.

## 4. Target shape

One channel per language, each of which already verifies by hash and records the
pin in a file the toolchain reads:

| Edge | Channel | Pin lives in |
|---|---|---|
| crypto Go module → chain, guardian | Go proxy | `go.mod` — unchanged, already conventional |
| chain wire contract → guardian | Go proxy | `guardian/go.mod` — unchanged |
| **chain vectors → guardian** | inside `x/secrets/types` (`testdata/` is files in a module) | `guardian/go.mod` |
| crypto crate → mobile | Cargo git tag | `packages/crypto/rust/Cargo.toml` + `Cargo.lock`, and nowhere else |
| crypto WASM + travelling primitive vectors → this package | npm | `package.json` + lockfile |
| this package → mobile | npm | `app/package.json` + lockfile |
| chain vectors → this package, mobile | §7 Q3 | — |
| guardian binaries → devnet | compose image tag | the chain's compose file |
| SDK examples → devnet e2e | §7 Q5 | — |

What that deletes: three `versions.env` files, `CHAIN_VECTORS_VERSION`, ten of
the twelve sync/verify targets, `mobile-client/scripts/sdk-sync.sh`, the vendored
tarball and the CI byte-compare that guards it, and the deterministic dist
tarball whose only purpose is to make that byte-compare possible.

## 5. Phases

Ordered so that each phase is independently landable and no phase waits on a
decision that a later one makes. The order is forced where an edge points
downstream: crypto publishes before this package depends on it, which publishes
before the mobile client consumes it.

**Phase 1 — stop publishing what nothing asserts.** `crypto` keeps
`encryption`, `detection_hint` and `hmac` in-repo; its release stops carrying
them (subject to Q4 and Q7). No consumer changes, so this is the cheapest phase
and it needs no registry.

**Phase 2 — chain vectors reach their Go consumer through the module.** Move
`wallet_derivation.json` and `client_conventions.json` into `x/secrets/types`.
The guardian drops `CHAIN_VECTORS_VERSION`, `vectors-sync` and `vectors-verify`,
and asserts them from the module it already requires. Needs a wire-contract tag,
so it walks the chain's `PROTOCOL_CHANGE.md`.

**Phase 3 — publish `@timeflareio/crypto`.** The WASM bundle plus the primitive
vectors that travel. Smallest blast radius of any publishing step (one consumer),
so it is where the publish mechanics get proven: version stamped from the tag,
`--access public`, provenance, and the packed file list read before the first
real publish. This repository drops `wasm-sync` and its `wasm/` ignore rule.

**Phase 4 — publish `@timeflareio/sdk`.** Version derived from the tag, with the
release failing if the manifest and the tag disagree. The dist-only deterministic
tarball retires here.

**Phase 5 — flip the mobile client.** `app/package.json` takes a version range;
`versions.env`, `vendor/`, `sdk-sync.sh`, `sdk-verify` and the CI byte-compare
go, with the regenerated lockfile in the same change. The crypto version reduces
to the Cargo pair.

**Phase 6 — devnet pins and the record.** The guardian pin becomes the compose
image tag; the SDK pin becomes whatever Q5 settles. A `COMPATIBILITY.md` row is
appended only after `make e2e` and `make e2e-scenarios` pass against those exact
published artefacts.

## 6. Components

- **`typescript-sdk/`** (this repository) — `package.json`, `versions.env`,
  `Makefile` (`wasm-sync`, `proto-sync`, `vectors-sync`, `vectors-verify`),
  `.github/workflows/release.yml`, `src/vendor/vectors/`, `.gitignore`,
  `src/protocol/__tests__/`.
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
  `packages/crypto/rust/Cargo.toml`, `app/package.json`, `e2e/package.json`,
  `package-lock.json`, `.github/workflows/ci.yml`.
- **Cross-cutting** — every `README.md` that documents a sync target, and the
  workspace-level description of which way things point.

## 7. Open questions

**Q1 — registry, or npm git dependencies?** A git dependency
(`github:timeflareio/typescript-sdk#v0.0.2`) pins by tag with the resolved commit
in the lockfile, needs no registry, and behaves almost exactly like a Go module;
consumers must build the package or the repository must commit `dist/`. A
registry is what an outside integrator expects and the only route that makes this
package installable by someone who is not us.
*Recommendation*: registry. The `timeflareio` npm organisation exists as of
August 2026, which removes the obstacle that made deferral sensible. Migration
between the two routes is a one-line dependency change for consumers, so this is
reversible in the direction that matters.

**Q2 — scoped or unscoped names?** `timeflare-sdk`, `timeflare-crypto`,
`@timeflareio/sdk` and `@timeflareio/crypto` were all unclaimed on 5 August 2026.
Keeping `timeflare-sdk` renames nothing. A scope namespaces every future package
in one move and cannot be typosquatted into a dependency-confusion attack.
*Recommendation*: scoped, decided now while exactly one consumer exists. The
rename then carries the cross-component sweep every rename here carries.

**Q3 — who carries the chain vectors for TypeScript consumers?** Either this
package ships them as package data, or the chain publishes a package carrying
protos and vectors together — which would also retire this repository's committed
`src/generated/` (704K) and its `proto-sync`. The second is a new published
artefact and belongs to the chain's `PENDING_RELEASE_STRATEGY_PLAN.md` §6.
*Recommendation*: settle that §6 first; this package carrying them is the smaller
step and does not foreclose the other.

**Q4 — keep FFI marshalling coverage?** If the three retiring vectors stop being
published, the UniFFI wrapper loses its cross-checked expected outputs. A
`uniffi` bump changing what crosses the boundary is the specific risk.
*Recommendation*: keep one small fixture in the wrapper rather than a versioned
corpus, and say plainly in the wrapper's test what it covers and what it does
not.

**Q5 — does the examples tarball survive?** The devnet e2e harness runs from the
examples bundle, and an npm package should not carry examples.
*Recommendation*: keep publishing it as a release asset, unchanged. It is not
part of the footprint that hurts.

**Q6 — publish authentication.** Trusted publishing via GitHub Actions OIDC
leaves no long-lived secret; an automation token is simpler and bypasses the
organisation's 2FA policy by design.
*Recommendation*: OIDC, with provenance attestations, verified against the
current npm behaviour rather than assumed.

**Q7 — is the primitive corpus an audit artefact independent of its consumers?**
Phase 1 argues from "no consumer asserts it". An external reviewer reading
`crypto`'s `CRYPTO_ASSURANCE_PLAN.md` may want the corpus published regardless.
*Recommendation*: ask what the assurance plan needs before deleting a published
asset; publishing for auditors is a different justification from publishing for
consumers, and it would be satisfied by the tagged source alone.

## 8. What this plan does not solve

- **The guardian's mirrored `replace` block shrinks; it does not go.** The gin
  pin can become a plain `require`, which MVS propagates to consumers. The
  goleveldb pin is a *downgrade*, which MVS cannot express, and
  `nhooyr.io/websocket → coder/websocket` is a module-path rewrite. Both need
  `replace`, so `verify-pins` stays with less to check.
- **Binary and image release mechanics.** Whether `goreleaser` replaces the
  hand-written cross-compile matrices is a separate concern with its own
  new-component argument to make.
- **The chain's own publication** of two Go modules, node binaries and the
  container image, which is its `PENDING_RELEASE_STRATEGY_PLAN.md`'s subject.
- **This package's packaging correctness** — the loader, the exports map, the
  documentation and the runtime support matrix — which is
  `PENDING_SDK_PRODUCTIONISATION_PLAN.md`'s subject. That plan's phase 1 assumes
  the WASM is built here; phase 3 of this plan makes it a dependency instead, so
  that section needs rewriting in place when this plan is ruled.
- **`COMPATIBILITY.md` remains hand-appended.** The streams stay independent, so
  the matrix is still the only place they are related; its corpus columns narrow
  as vectors move inside modules.
- **The dangling `GUARDIAN_VERSION=v0.0.4` pin** is a defect to fix on its own,
  not by this plan. Phase 6 assumes the guardian has by then released the tag its
  content is already on.
- **Nothing here changes what the primitives produce, what the protocol
  requires, or any assertion any implementation makes.** Only where the bytes
  come from and where the version is written down.
