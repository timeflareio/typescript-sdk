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
owned elsewhere, and they arrive by two different routes:

| What | From | How it arrives | Pinned in |
|---|---|---|---|
| primitives (WASM) | `timeflareio/crypto` | the `@timeflareio/crypto` dependency | `package.json` + lockfile |
| primitive vectors | `timeflareio/crypto` | inside that same dependency | `package.json` + lockfile |
| wire format (`src/generated/`) | `timeflareio/chain` protobufs | `make proto-sync`, committed | `versions.env` |
| chain-semantics vectors | `timeflareio/chain` | `make vectors-sync`, committed | `versions.env` |

The distinction to hold in mind: what npm can express is a dependency, and npm
verifies it. What it cannot — generated code and a corpus published as a release
tarball — is fetched by make and pinned in `versions.env`.

## 🚨 Never hand-edit `src/vendor/vectors/`

Those files are the chain's, and they pin what the chain *implements*. Editing one
here would make this package assert a convention nothing implements, which is the
precise failure the corpus exists to catch.

`make vectors-verify` re-reads the chain's release and runs as part of `verify`
and `test`. Change them with `make vectors-sync` after the chain has moved, never
by hand.

The primitive vectors are not here: they arrive inside `@timeflareio/crypto`, and
the tests that assert them resolve them from the package.

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

- `make test` — jest, after verifying the vendored chain corpus
- `make verify` — lint, type-check, corpus
- `make build` — `tsc`, plus the chain vectors the package ships
- `make vectors-sync` / `proto-sync` — the cross-repository edges make still owns
- `make doctor` — toolchain check
- `make help` — grouped target list

**No Rust toolchain is needed.** The WASM bundle is a released artefact from
`timeflareio/crypto`, installed as a dependency; this package never builds it. If
you find yourself adding `wasm-pack` to a workflow here, something has gone wrong.

npm scripts remain the inner loop. Make owns the edges npm cannot express —
generated protobuf code, and a corpus published as a release tarball.

## Releases

Two tarballs per tag, because the consumers differ:

- **dist-only** — the package a consumer resolves as
  `@timeflareio/typescript-sdk`. It carries package content and nothing else:
  WASM is a declared dependency rather than bundled here, and examples are not
  package content. It also carries the chain-semantics vectors under
  `dist/vendor/vectors/`, exposed as `@timeflareio/typescript-sdk/vectors/*.json`,
  because the mobile client asserts one of them and has no other source for it.
- **dist + examples + WASM** — for the chain's e2e harness, which runs the
  examples.

**The manifest version must equal the tag.** `release.yml` refuses a release
where they disagree, so the version is bumped in the commit that gets tagged.

Nothing is published to a registry. Consumers resolve the dist tarball by its
release-asset URL and npm records its integrity hash in their lockfile — see
`docs/planning/done/DONE_PUBLICATION_FOOTPRINT_PLAN.md`.

## Specific to this repository

- **The spec is not here.** `docs/spec.md` in the chain repository is the
  authority for protocol behaviour; `docs/guides/CLIENT_CONVENTIONS.md` here
  covers client-side conventions only, and defers to the spec wherever they meet.
  The rules for consulting it are in the workspace root `CLAUDE.md` — including
  the one that bites hardest for a consumer: never infer protocol behaviour from
  this package's existing code, because the code may be what is wrong.
- Plans live in `docs/planning/`, per its `README.md`.
