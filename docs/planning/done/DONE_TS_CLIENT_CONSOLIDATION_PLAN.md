# TypeScript Client Consolidation — One Authoritative Protocol Layer

*The repo carries **two** independent TypeScript implementations of chain
access and protocol orchestration over the same generated protobuf types:
`typescript-sdk/` and `mobile-client/packages/protocol-client/`. They have
already drifted. This plan traces the overlap, records why the split
happened, and sets out what consolidation would take.*

> **Status: IMPLEMENTED (23 July 2026).** All §7 phases are done; the §6
> decisions (including rulings 6–8 on packaging) are recorded there. The
> trace in §2 remains the measured baseline. One protocol implementation
> (`timeflare-sdk`) with per-platform crypto backends (WASM in the core;
> JSI in the public companion `@timeflare/sdk-native`); `protocol-client`
> is gone. Locally verified end-to-end; native device build is CI-verified.

## Contents

1. [Why this is priority](#1-why-this-is-priority)
2. [The trace — measured overlap](#2-the-trace--measured-overlap)
3. [Why the split happened](#3-why-the-split-happened)
4. [The one real constraint, and what it does *not* imply](#4-the-one-real-constraint-and-what-it-does-not-imply)
5. [Proposed target architecture](#5-proposed-target-architecture)
6. [Decisions required before any work starts](#6-decisions-required-before-any-work-starts)
7. [Phasing sketch](#7-phasing-sketch)
8. [Explicitly out of scope](#8-explicitly-out-of-scope)

---

## 1. Why this is priority

**The duplication has already produced a live defect.** The two clients
disagree with each other and with the chain on a validation bound:

| Constant | `x/secrets/types/constants.go` | `typescript-sdk` | `protocol-client` |
|---|---|---|---|
| max requested shares | `MaxShares = 24` | `MAX_SHARES: 32` ❌ | `SHARES_MAX = 24` ✅ |

The SDK has conflated `MaxShares` (24, what a creator may request) with
`MaxTotalShares` (32, the SSS ceiling including the selection buffer). An
SDK consumer requesting 25–32 shares builds a transaction the chain rejects
at `ValidateBasic`. This is exactly the class of drift the mobile side's
vector discipline exists to prevent — and the SDK has no equivalent guard.

Second signal, from the dynamic bond economics change (PR #94): a single
protocol change required hand-edits to **both** clients — SDK test fixtures
*and* `protocol-client/src/constants.ts` plus the app's mapping layer. Every
protocol change pays this tax twice, and only one of the two payers has a
drift guard.

## 1a. Known defects to fix during execution

Found by the §2 trace. **Deliberately not fixed ahead of this plan** (owner
ruling, July 2026): they are fixed as part of executing the consolidation,
so the fix lands in the surviving component rather than being applied twice.

### D1 — `typescript-sdk` enforces the wrong share ceiling

| | Value | Source |
|---|---|---|
| Chain (authoritative) | `MaxShares = 24` | `x/secrets/types/constants.go:67` |
| Chain, SSS total incl. buffer | `MaxTotalShares = 32` | `x/secrets/types/constants.go:69` |
| `typescript-sdk` | `MAX_SHARES: 32` ❌ | `src/types.ts:278` |
| `protocol-client` | `SHARES_MAX = 24` ✅ | `src/constants.ts:44` |

**Cause**: the SDK conflates `MaxShares` (the creator-requestable count)
with `MaxTotalShares` (the SSS ceiling *including* the ~30 % selection
buffer the protocol adds on top).

**Not a dormant constant — it is actively enforced.**
`typescript-sdk/src/client.ts:211`:

```ts
if (shareCount < Constants.MIN_SHARES || shareCount > Constants.MAX_SHARES) {
  throw new TimeflareClientError(ErrorCodes.INVALID_PARAMETERS, ...);
}
```

**Impact**: an SDK consumer requesting 25–32 shares passes client-side
validation, has the secret split into that many SSS shares, and then has
`MsgRequestGuardians` rejected by the chain's `ValidateBasic`. Wasted work,
a confusing failure far from its cause, and a client-side guarantee the
chain does not honour. It cannot corrupt chain state — the chain is the
authority and rejects correctly.

**Fix**: `MAX_SHARES: 32 → 24` in the surviving constants mirror, with a
regression assertion in whatever vector discipline D2 establishes.

### D2 — the SDK's constants mirror is unguarded *and* incomplete

Beyond the wrong value, the SDK mirrors only a subset of the chain's
validation bounds. Missing entirely: `MinRevealStartOffset`,
`Min/MaxRevealDuration`, `Min/MaxCommitTimeout` (it ships only a
`DEFAULT_COMMIT_TIMEOUT: 30`), `Min/MaxBump` (only a `DEFAULT_BUMP: 100`),
`MaxRevealHorizon`, `MinEvidenceLength`, `MaxRevealedKeyShareSize`.
`protocol-client` carries all of them, correctly.

So the SDK both under-validates (bounds it cannot check) and
mis-validates (D1). With no vector corpus and no connect-time version check
(§2.4), nothing catches either mechanically. **D1 is a symptom; D2 is the
cause.** Any fix that corrects the value without establishing the guard
leaves the next drift equally undetectable.

### D3 — a *third* copy of `rate` (already fixed, retained as evidence)

Found while getting PR #94 green, not by the trace.
`mobile-client/e2e/test/cancel.test.ts:25` declared:

```ts
/** RatePerGuardianBlock — the chain's master price level (constants.go). */
const RATE = 100n;
const BUMP_SCALE = 100n;
```

— a private copy of `RatePerGuardianBlock` in the **e2e suite**, independent
of both `constants.go` and protocol-client's mirror, in a file that already
imported from `@timeflare/protocol-client`. It survived the rate 100 → 1
change and failed CI asserting an 1,100 uveil cancellation wage where the
chain correctly paid 11.

Fixed in PR #94 (it was blocking CI) by importing `RATE_UVEIL` rather than
editing the literal. Doing so exposed a further mirror gap: the chain's
`BumpScale` had **no client-side counterpart at all**, so
`BUMP_SCALE_HUNDREDTHS` was added to protocol-client.

**Why this matters to the plan.** The count of independent copies of one
chain constant was **three** (chain, protocol-client mirror, e2e literal),
of which one was guarded. Consolidation must therefore target more than the
two client packages: the rule the surviving L1 has to enforce is that
protocol constants exist in exactly one place and every consumer —
including test suites — imports them. A grep for numeric literals matching
known constants across `typescript-sdk/`, `mobile-client/` and the e2e
suites belongs in the §7.4 vector-discipline step.

## 2. The trace — measured overlap

Measured against `main`.

**Size**: `typescript-sdk/src` = 2,313 LOC; `protocol-client/src` = 1,446 LOC.

### 2.1 Duplicated concerns

| Concern | `typescript-sdk` | `protocol-client` | Notes |
|---|---|---|---|
| Chain queries | `blockchain.ts` (611 LOC, 7 query methods) | `rest.ts` (193 LOC, 10 methods) | **Different transport**: SDK uses cosmjs Stargate over Tendermint RPC; protocol-client uses the grpc-gateway REST gateway (:1317) with a `camelise` shim. 7 methods are 1:1 equivalents (`querySecret`/`secret`, `queryHintsSince`/`hintsSince`, `querySecretPayload`/`secretPayload`, `querySecretTombstone`/`secretTombstone`, `queryGuardian`/`guardian`, `getCurrentBlockHeight`/`height`, `getBalance`/`balance`) |
| Transaction construction | `blockchain.ts`: `requestGuardians`, `distributeShares` | `txclient.ts` (225 LOC): same two, plus `cancelSecret` | Both sign via cosmjs. Both build the same messages from the same generated types |
| Protocol constants mirror | `types.ts` → `Constants` (payload caps, key sizes, share framing, threshold/share bounds, retention, defaults) | `constants.ts` (115 LOC: economics, validation bounds, payload caps, derived helpers) | Both hand-mirror `x/secrets/types/constants.go`. **Already disagree** (§1) |
| Creator orchestration | `sdk.ts` (767 LOC) — three-phase flow, validation, error handling | `session.ts` (286 LOC) — `CommitSession`, `reconcileSession`, `SessionStore` | Same protocol, different shape: the SDK is stateless call-sequencing; protocol-client models a resumable session |

### 2.2 Unique to `protocol-client` (no SDK equivalent)

- `recipient.ts` (135) — `discoverSecrets`, `reconstructSecret`, `decryptReconstructed`: the **entire recipient side**
- `conventions.ts` (186) — `timeflare:recipient/` + `timeflare:claim/` URIs, `tfid`/`tfsk` bech32 HRPs, vector-pinned against `client_conventions.json`
- `watch.ts` (169) — polling/inbox
- `wallet.ts` (43)
- `crypto.ts` (79) — the **`CryptoProvider` interface** (see §4)
- Query methods the SDK lacks: `secretAssignments`, `secretReveals`, `secretsByCreator`; tx: `cancelSecret`

### 2.3 Unique to `typescript-sdk`

- `client.ts` (480) — WASM crypto, **hard-wired** (see §4)
- `types.ts` share-framing helpers (`SHARE_ID_SIZE`/`SHARE_LENGTH_SIZE` envelope packing)

### 2.4 Drift guards — asymmetric

| | Vector corpus consumed | Runtime guard | Test suite |
|---|---|---|---|
| `protocol-client` | ✅ `testdata/vectors/` vendored by `scripts/vendor.sh` | ✅ node-version check at connect blocks sealing on mismatch | 4 suites, incl. `conventions.test.ts` asserting the shared corpus |
| `typescript-sdk` | ❌ none | ❌ none | 1 file, `sdk.test.ts`, fully mocked (`jest.mock` of `../client` and `../blockchain`) |

The SDK's only test suite mocks both boundaries, so it validates
orchestration wiring and nothing about protocol truth. It caught the PR #94
proto change only because its fixtures are *typed* against the generated
protos — a compile error, not an assertion.

### 2.5 Summary

Roughly **1,400 LOC of SDK** and **700 LOC of protocol-client** address the
same concerns (chain access, tx building, constants, creator
orchestration). The genuinely platform-specific remainder is small: the
SDK's WASM loader (480) and protocol-client's recipient/conventions/watch
surface (~490), the latter being *missing functionality* in the SDK rather
than duplication.

## 3. Why the split happened

Not a design decision — a sequence of constraints, recorded here so the
consolidation does not relitigate settled ground:

1. **The SDK predates the mobile client** and was written WASM-first for
   browsers.
2. **React Native cannot run the SDK's crypto.** `PENDING_MOBILE_APP_BUILD_PLAN.md`
   §111: *"The existing WASM crypto route is out regardless (Hermes has no
   WASM)"*. The mobile plan flagged crypto packaging as the first technical
   spike for this reason.
3. **The SDK was explicitly fenced off.** The same plan required the existing
   WASM/SDK build stay untouched during the mobile spike, so protocol-client
   was built alongside rather than the SDK refactored.
4. **Different consumer shape.** The SDK exposes the creator's three-phase
   flow; mobile additionally needs recipient discovery, session resumption
   and inbox watching.

## 4. The one real constraint, and what it does *not* imply

The constraint is narrow: **Hermes has no WebAssembly**, so the SDK's crypto
implementation cannot run on device. The SDK compounds it by reaching for
Node built-ins on its load path:

```ts
// typescript-sdk/src/client.ts
private wasmModule: TimeflareWasmModule | null = null;
const wasmImport = await import('../wasm/timeflare_crypto');
const wasmPath = path.resolve(__dirname, '../wasm/timeflare_crypto_bg.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
```

WASM is baked into the class; there is no seam to swap it.

**What the constraint does not imply** is that mobile needs its own chain
access, its own tx builder, its own constants mirror, or its own
orchestration. Those are RN-compatible today (protocol-client proves it —
it uses cosmjs). The crypto constraint was allowed to fork the whole stack.

Crucially, **the seam already exists** — in the wrong package:

```ts
// mobile-client/packages/protocol-client/src/crypto.ts
export interface CryptoProvider {
  keygenX25519(); sealSecret(...); reconstruct(...);
  decryptPayload(...); deriveHint(...); scanHint(...); hmacShare(...);
}
```

with implementations injected per runtime (N-API under Node, JSI on device).
**`protocol-client` is the conforming component; `typescript-sdk` is the
non-conforming one.**

## 5. Proposed target architecture

One protocol layer, pluggable crypto backends:

```
proto/ ──buf──→ generated types            (L0 — already shared)
                     │
                     ▼
        protocol core: chain access, tx building,
        constants, orchestration — crypto-agnostic,
        depends only on CryptoProvider          (L1 — ONE implementation)
                     │
     ┌───────────────┼───────────────┬──────────────────┐
     ▼               ▼               ▼                  ▼
  WASM (web)     JSI (device)   N-API (Node tests)   future        (L2 — backends)
     │               │               │
     └───────────────┴───────────────┴──→ thin per-platform facades (L3)
```

L1 is essentially today's `protocol-client` generalised. The SDK becomes an
L3 facade over it that binds the WASM backend, keeping its published API
shape for existing consumers.

**Consequences worth stating plainly:**

- The constants mirror exists **once**, and inherits protocol-client's
  vector discipline — the §1 defect becomes structurally impossible.
- A protocol change touches one TypeScript surface, not two.
- The SDK gains the recipient side (discovery, reconstruction) it currently
  lacks entirely.
- Transport must be reconciled: RPC (SDK) vs REST gateway (mobile). See §6.3.

## 6. Decisions — RULED (22 July 2026)

Answered by the owner; recorded here as the basis for §7.

1. **Is the SDK a published artefact?** **Yes — it becomes the one public
   asset.** `timeflare-sdk` is the single TypeScript component external
   consumers use to talk to the chain and perform crypto. (It is not
   published *today* — 404 on npm, no publish workflow — but the target is a
   public package.) The mobile client is **not** public.
2. **Which package survives?** **`typescript-sdk` keeps the package identity
   (name, publish-readiness); `protocol-client`'s implementation becomes its
   guts.** protocol-client is the better-architected base (injected crypto,
   REST, correct + guarded constants, recipient side) — its code moves into
   `typescript-sdk/src`, the old WASM-wired internals
   (`client.ts`/`sdk.ts`/`blockchain.ts`) are deleted, and
   `protocol-client` is removed. No component may duplicate what the SDK
   does for the mobile app.
3. **Transport?** **REST for queries, cosmjs for tx — one story across
   browser, Node and React Native.** RPC is dropped (RN-hostile; the only
   thing it adds — WebSocket event subscriptions — is deferred until we
   decide we need it, and would slot in additively behind a watcher
   interface, not as a transport base).
4. **`vendor.sh` boundary?** The SDK becomes a top-level dependency the
   mobile client consumes; `mobile-client/` keeps only mobile-specific code
   (UI, storage, app-lock, identity). `vendor.sh`'s protos/vectors/native
   bindings role is absorbed by the SDK's own build.
5. **Backends?** **Crypto is one `CryptoProvider` interface with backends
   compiled from the one Rust crate: WASM (web/Node) and JSI (React
   Native), both folded into the SDK.** N-API stays only as the headless
   test binding. No pure-JS crypto, ever.
6. **How does mobile-client resolve the SDK?** (ruled 22 July, on finding
   mobile-client is documented as *"its own npm tree, never joined to
   typescript-sdk's, built for lift-out"*): **the SDK is a published npm
   package; mobile depends on it as an external consumer would.** This
   honours "public asset others use" AND preserves the lift-out boundary —
   mobile depends on an artifact, never on the repo tree. Dev/CI resolves it
   via a locally-built tarball (`npm pack`) or a registry, not a repo
   cross-link. The `vendor.sh` one-way boundary is unchanged.
7. **How does the SDK expose its backends?** **Separate entry points**, so
   React Native never resolves the fs/path/WASM path: `timeflare-sdk` is the
   core (protocol + the `CryptoProvider` interface, no crypto impl);
   `timeflare-sdk/wasm` is the web/Node backend. Each consumer imports the
   backend for its platform.
8. **Where does the JSI native backend live?** (ruled 23 July, on finding
   the SDK is public + web-consumed): **a separate published companion
   package `@timeflare/sdk-native`, NOT folded into the core.** Folding a
   React Native TurboModule (podspec/gradle/C++/`react-native` peer dep)
   into the public web SDK would make every web `npm install timeflare-sdk`
   download RN native code and risk peer-dependency failures. The companion
   implements the SDK's `CryptoProvider` over the one Rust crate; the core
   stays web-clean; mobile depends on both. This is not duplication — the
   companion is one of the three backends of the single crate, not a second
   protocol client.

### Key de-risking finding (22 July 2026)

The WASM `CryptoProvider` backend needs **no Rust changes**. `rust/src/lib.rs`
already exposes the same core (`seal::seal_secret`, `seal::unseal_secret`,
`sss`, `detect`) the UniFFI wrapper uses — only the marshalling differs
(`JsValue`/byte-splitting vs typed structs). So the WASM backend is a **thin
TypeScript adapter** mapping the existing WASM exports to `CryptoProvider`,
exactly as the mobile `native.ts` maps JSI (there the identity; here a
marshalling shim). This is what makes the web/Node path verifiable in-session
without native toolchains.

## 7. Execution phases

Ordered so every stage that *can* be verified in Node/jest is, and the
native-toolchain work (JSI device build) is isolated to CI. Progress marked.

1. ✅ **§6 rulings** — recorded above.
2. **Unified SDK core** — move protocol-client's src into `typescript-sdk/src`
   (constants, crypto interface, conventions, rest, txclient, wallet, watch,
   session, recipient), repointing `../vendor/generated/*` →
   `./generated/*` (the SDK's committed buf output). The ported constants are
   already correct — **D1/D2/D3 resolve by construction** (protocol-client's
   mirror is the complete, correct one). *Verify: jest.*
3. **WASM `CryptoProvider` backend** — thin adapter over the built WASM
   (`src/crypto/wasm.ts`), plus a default factory that wires it. *Verify:
   Node + built WASM.*
4. **Vector discipline in the SDK** — port `conventions.test.ts`; assert the
   constants mirror against `testdata/vectors/`; carry the version check.
   *Verify: jest.*
5. **Delete old SDK internals** (`client.ts`/`sdk.ts`/`blockchain.ts`, the
   redundant `types.ts` constants) and rewrite the four `examples/` against
   the new API. *Verify: `make e2e` + `e2e-scenarios`.*
6. ✅ **Repoint mobile app + e2e** — all 46 files moved to `timeflare-sdk`;
   the SDK is consumed as a packed artefact (`vendor/timeflare-sdk.tgz` via
   `scripts/pack-sdk.sh`), preserving the lift-out boundary. 285 app tests
   pass against the SDK.
7. ✅ **Companion native package** — `@timeflare/mobile-crypto` repositioned
   as the public `@timeflare/sdk-native` (ruling 8); the core SDK stays
   web-clean. Native device build is CI-verified.
8. ✅ **Delete `protocol-client`**; `vendor.sh`, workspace scripts and CI
   (`ci.yml`, `mobile-client.yml`) rewired; SDK `tsc` decoupled from
   wasm-pack so the tarball packs without a Rust toolchain.

**All phases implemented.** Locally verified: SDK build + 53 tests; the full
lifecycle e2e end-to-end against a live devnet (both `secret-lifecycle` and
`scenario-create`); 285 mobile app tests; chain build + module boundaries
intact. CI-verified (on push): the JSI native device build and the mobile
headless e2e.

## 8. Explicitly out of scope

- **The Go/Rust crypto split.** Two implementations (pure-Go `crypto/` for
  chain and guardian, Rust for clients) pinned by `testdata/vectors/`. That
  is deliberate and load-bearing — the chain must not carry cgo.
- **Guardian client work.** `guardian/` imports `x/secrets/types` + `crypto`
  only and is unaffected.
- **The generated-proto seam.** buf fanning out to Go and TypeScript is
  working correctly and is the model the rest of this plan aspires to.
