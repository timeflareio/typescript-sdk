# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

**It is not the whole picture.** The project-wide rules — the working agreement,
the writing conventions (British English, VEIL is a token, never name the owner),
the plan-first mandate, specification authority, and how a change crosses a
repository boundary — are stated once in the workspace root `CLAUDE.md`, at
`~/dev/timeflareio/CLAUDE.md`, which loads alongside this file. Read it if you
are in a checkout that cannot see it.

## Project Overview

**timeflare TypeScript SDK** is the client library for the timeflare protocol:
creating secrets, distributing shares to guardians, reconstructing, and
recipient discovery.

It implements **none of the protocol itself**. It is an assembly of three things
owned elsewhere, each pinned in `versions.env`:

| What | From | Fetched by |
|---|---|---|
| primitives (WASM) | `timeflareio/crypto` | `make wasm-sync` |
| wire format (`src/generated/`) | `timeflareio/chain` protobufs | `make proto-sync` |
| conformance vectors | **both** repositories | `make vectors-sync` |

That last row is the one to hold in mind: this package sits downstream of both,
so it vendors from both.

## 🚨 Never hand-edit `src/vendor/vectors/`

Those files belong to the repositories that *implement* what they pin — crypto
owns the primitive vectors, the chain owns its own semantics. Editing one here
would make this package assert a convention nothing implements, which is the
precise failure the corpora exist to catch.

`make vectors-verify` re-reads both sources and runs as part of `verify` and
`test`. Change them with `make vectors-sync` after the owning repository has
moved, never by hand.

## 🚨 No path may be derived from where this package sits

`examples/lib.js` used to default the devnet keypair to
`<sdk>/../../.devnet/recipient-keypair.json`. That worked only because the SDK
sat inside the same tree as the devnet; it now resolves to something unrelated.

It requires `RECIPIENT_KEYPAIR` and fails loudly if unset. That is deliberate:
the examples cannot know where a devnet is, and reading whatever happens to
exist at a guessed path is worse than stopping. The chain's `make e2e` sets it.

When adding an example or test that needs an external file, take the path from
the environment or an argument. A relative path that escapes this package is a
bug waiting for someone to move a directory.

## Essential Commands

- `make test` — jest, after verifying both vendored corpora
- `make verify` — lint, type-check, corpora
- `make build` — fetch WASM if needed, then `tsc`
- `make wasm-sync` / `vectors-sync` / `proto-sync` — the cross-repository edges
- `make doctor` — toolchain check
- `make help` — grouped target list

**No Rust toolchain is needed.** The WASM bundle is a released artefact from
`timeflareio/crypto`; this package never builds it. If you find yourself adding
`wasm-pack` to a workflow here, something has gone wrong.

npm scripts remain the inner loop. Make owns the cross-repository edges, because
those are the parts npm cannot express.

## Releases

Two tarballs per tag, because the consumers differ:

- **dist-only, byte-deterministic** — vendored by the mobile client, which
  commits a lockfile whose integrity hash covers it. `tsc` output is
  reproducible; `wasm-opt` output is not, which is why WASM is excluded here.
- **dist + examples + WASM** — for the chain's e2e harness.

Registry publication is deliberately deferred. See
`docs/planning/PENDING_RELEASE_STRATEGY_PLAN.md`.

## Specific to this repository

- **The spec is not here.** `docs/spec.md` in the chain repository is the
  authority for protocol behaviour; `docs/guides/CLIENT_CONVENTIONS.md` here
  covers client-side conventions only, and defers to the spec wherever they meet.
  The rules for consulting it are in the workspace root `CLAUDE.md` — including
  the one that bites hardest for a consumer: never infer protocol behaviour from
  this package's existing code, because the code may be what is wrong.
- Plans live in `docs/planning/`, per its `README.md`.
