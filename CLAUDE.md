# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

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

## 📋 Specification Authority

`docs/spec.md` **in the chain repository** is the single source of truth for
protocol behaviour. `docs/guides/CLIENT_CONVENTIONS.md` here covers client-side
conventions specifically, and defers to the spec wherever they meet.

If the spec is silent on something this package needs, **stop** and ask the owner
to clarify it. Do not infer protocol behaviour from this package's existing code
— the code may be what is wrong.

## 🚨 Plan-First Workflow (mandatory — everything)

All work is executed from an approved plan in `docs/planning/`. Discussion is not
approval — propose, wait for the ruling, fold it into a plan, then execute. The
only exception is a change the owner explicitly requests in the moment, and even
then the scope is exactly what was asked.

## Important Instructions for Claude

- Do what has been asked; nothing more, nothing less
- NEVER create files unless explicitly asked to implement or code a solution
- When asked to "elaborate", "explain", or give "feedback", give verbal
  explanations only
- ALWAYS prefer editing existing files over creating new ones
- **🚨 When asked to create a "plan", ONLY create the plan document**
- **Always wait for explicit approval** before moving from planning to
  implementation
- **🚨 Keep the architecture minimal.** No new component without arguing the case
  and getting explicit confirmation first
- NEVER create code in production code spaces purely for the purpose of tests
- **Documentation Language**: British English throughout, `-ise`/`-our`/`-sation`
- **🚨 VEIL is a token, never money.** Never "money", "cash", "funds" or
  "payment" — say "token", "VEIL", "uveil", "balance", "amount", "fee", "cost",
  "bond", "reward" or "rebate". Describing a token as money makes a regulatory
  claim the project does not make.
- **🚨 NEVER name the owner.** No personal name anywhere — code, comments, docs,
  plans, commit messages or fixtures. Decisions are attributed to **"the owner"**.
  This covers given name, surname, handle, email, and machine paths embedding a
  username.
