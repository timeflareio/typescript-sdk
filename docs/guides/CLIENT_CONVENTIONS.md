# Client Conventions — Keys, URIs & the Claim Kit

*The ecosystem interfaces every Timeflare client must share: how recipient
keys are exchanged, how identity keys are backed up, and how claim kits are
encoded. These are wire formats between clients — possibly separated by
years — not app internals.*

**Status**: pinned (rulings, July 2026 — decision record in
[planning/client-app/PENDING_MOBILE_APP_PLAN.md §16.2](../planning/client-app/PENDING_MOBILE_APP_PLAN.md)).
Consumers: the mobile client, the TypeScript SDK, the guardian daemon
(§5 — `guardian/custody/mnemonic.go`), and any future web app/CLI. Changes
to this document are versioned through the encodings' version bytes — never
by silently redefining an existing version.

## 1. Scope and principles

1. **Interfaces, not internals.** Anything one client produces and another
   may consume years later belongs here; anything one client keeps to
   itself does not.
2. **Versioned from day one.** Every binary payload begins with a version
   byte. A parser encountering an unknown version rejects with an
   "update your client" error — it never guesses.
3. **Vector-pinned.** Each convention gets entries in a
   `testdata/vectors/client_conventions.json` corpus (same append-only
   regime as the crypto vectors); every implementation asserts them in CI.
4. **Nothing here touches consensus.** These are client-side encodings of
   keys and identifiers the chain never sees (the recipient key never goes
   on chain) or already defines (the secret ID).

## 2. URI scheme — general rules

- **Scheme**: `timeflare:` (custom scheme for app deep-linking; an
  `https://` universal-link mirror is a possible later addition and must
  wrap, not replace, these forms).
- **Binary payloads** are encoded with **bech32m** (BIP-350): checksummed,
  QR-efficient, chain-idiomatic, case-insensitive to scan. Payloads are
  kept ≤ 90 characters total so bech32m's error-detection guarantees hold —
  anything variable-length (like the secret ID) rides as a query parameter
  instead of inside the bech32 payload.
- **Version byte first** in every bech32m payload (`0x01` initially, per
  path below). The exception is a payload the chain already defines and
  checksums: `timeflare:fund/` (§8) carries the bech32 account address
  verbatim, because re-encoding it would add a second checksum over a
  string that already has one and would stop the URI being recognisable as
  the address it is.
- **Lowercase on the wire.** Producers emit lowercase URIs and QR codes
  encode them in **byte mode**, not the denser alphanumeric mode.
  Alphanumeric mode would force uppercasing; bech32m survives that, but the
  claim URI's `id` parameter does not — a secret ID is matched as a
  lowercase UUID, so an uppercased claim URI silently loses its pointer and
  degrades to discovery.
- **A URI never expresses an outbound transfer.** The vocabulary addresses
  things (a key, a secret, an account) and may *request* a quantity that a
  person then confirms and signs for (§8's `amount`). There is no path that
  states a destination and a quantity for someone else's transaction, and
  none may be added: a scannable code must not be able to compose a transfer
  instruction.
- **A URI is untrusted input.** It can arrive from any message, page or
  printed sheet, so a client resolves it to a prefilled, clearly-labelled
  screen and waits for confirmation. Nothing that imports key material,
  creates an identity, moves a balance or signs may happen because a link
  was opened.

## 3. Recipient key exchange — `timeflare:recipient/`

The "send me a time-locked secret" link/QR (feature plan §4). Carries the
recipient's X25519 identity **public** key.

```
timeflare:recipient/<bech32m payload>

HRP:      tfid                      ("timeflare identity")
payload:  0x01 ‖ public_key (32B)   (33 bytes)
example shape: tfid1q… (~64 chars)
```

- Creators consume this in the recipient chooser (scan/paste); the saved
  address book stores the decoded key, not the URI.
- The bare bech32m string (without the `timeflare:recipient/` prefix) is
  also valid for manual paste — parsers accept both; producers always emit
  the full URI.

## 4. Claim URI — `timeflare:claim/`

The machine-readable heart of the claim kit (§6): the un-enrolled-recipient
flow's **private** key plus the pointer to the secret, in one scan (ruled:
combined, not separate QRs).

```
timeflare:claim/<bech32m payload>?id=<secret-id>[&seed=<bech32m courier>]

HRP:      tfsk                      ("timeflare secret key" — the HRP
                                     itself signals sensitivity)
payload:  0x01 ‖ private_key (32B)  (33 bytes) — unseeded kit
          0x02 ‖ private_key (32B)  (33 bytes) — FUNDED kit (§4.1)
id:       the protocol-assigned secret ID, lowercase UUID string,
          as a query parameter (keeps the bech32m ≤ 90 chars and reuses
          the chain's existing ID format verbatim)
seed:     present iff the version byte is 0x02 (§4.1)

HRP:      tfck                      ("timeflare courier key" — a
                                     single-use secp256k1 WALLET key)
payload:  0x01 ‖ private_key (32B)  (33 bytes)
```

- Scanning imports the identity key (mandatory backup ceremony first,
  feature plan §4) and jumps straight to the named secret.
- The `id` is a bootstrap convenience only: renewal cycles mint new secret
  IDs, so the **key** is the durable anchor — after import, discovery
  scanning finds whichever cycle is live. A missing/stale `id` degrades
  gracefully to discovery.
- Parsers MUST treat the payload as key material: no logging, no clipboard
  echo, wipe intermediate buffers best-effort.

### 4.1 Funded kits — the `seed` parameter

A claim kit may carry a **courier key**: a single-use secp256k1 wallet the
sender has funded, so a recipient whose own address has never received
anything can sweep it and transact for the first time. Without this a new
recipient cannot sign at all — Cosmos writes an account record only on first
receipt — and so cannot collect the rebate the protocol credited them
(`docs/planning/done/DONE_WALLET_BOOTSTRAPPING_PLAN.md`).

- **The version byte carries the promise, not the parameter.** A funded kit is
  `0x02`. This is what makes seeding safe to hand to an older client: parsers
  reject unknown versions (§1), so a pre-change client refuses the kit whole
  instead of importing the identity and abandoning the seed in a courier
  nobody is tracking. An unseeded kit stays `0x01`, so nothing regresses.
- **The two MUST agree.** `0x02` without a `seed`, or a `seed` on `0x01`, is a
  link that was truncated or rewritten in transit. Parsers MUST reject rather
  than trust either half — guessing risks abandoning funds.
- **A damaged `seed` MUST fail the import.** Unlike a stale `id`, which
  degrades to discovery, an undecodable seed is not recoverable by other
  means: failing keeps the funds reachable from an undamaged copy of the kit.
- **`tfck` is deliberately not `tfsk`.** A courier is a secp256k1 wallet key;
  an identity is an X25519 key. They have different curves and different jobs,
  and the encoding makes conflating them impossible rather than merely
  discouraged. In particular a courier is **never** the per-secret key — that
  scalar is split across guardians and published when the reveal window closes.
- **A courier is swept once and abandoned.** It is never adopted as the
  recipient's wallet: the *sender* generated it and may have kept a copy.
- Separate payloads rather than one longer one because bech32m's guarantees
  hold only to 90 characters, which two 32-byte keys would exceed.

## 5. Identity-key backup — BIP39 mnemonic over the raw key

Ruled: the mnemonic encodes the **raw 32-byte X25519 private key directly**
as BIP39 entropy — one mnemonic per identity key, self-contained, no
derivation scheme to standardise.

```
entropy:   the raw 32-byte X25519 private scalar, exactly as stored
           (clamping applies at Diffie–Hellman time, per spec.md —
           the mnemonic round-trips the stored bytes byte-exactly)
encoding:  BIP39, English wordlist → 24 words
```

- Restore = decode 24 words → 32 bytes → verify by re-deriving the public
  key (and, where a registered context exists, checking it against
  expectations) before declaring success.
- **A key the client GENERATES owes the backup ceremony; a key RESTORED from
  its 24 words does not.** The ceremony (reveal the words, then a confirm-back
  test) exists to establish that the phrase has left the device and been
  written down. A restore begins with the user supplying that phrase, so the
  fact is already established — re-running the ceremony asks them to write down
  what they just typed in, and until they humour it the key wears a
  "not backed up" warning and cannot be shared. Clients therefore mark a
  mnemonic restore backed up on arrival, and gate only generated keys. The
  wallet domain has always worked this way; the identity domain matches it.
- **A claim kit is not a restore.** The kit carries no mnemonic (§6), so it
  proves nothing about recovery: an identity that arrives by claiming still
  owes the ceremony.
- The seed-derivation alternative (one master mnemonic, many keys via
  paths) was considered and set aside — revisit only with a new version
  of this convention, never by reinterpreting existing mnemonics.

## 6. The claim kit

The estate/inheritance artefact (feature plan §5.5). Ruled July 2026:
**digital-first and channel-agnostic** — a shareable artefact for email,
messaging, or QR scan, handed over through the device's own share sheet. Print
is not a targeted workflow: the kit is a link, and a printed link that has to be
retyped is the worst way to move key material.

**Canonical contents** (any rendering — image, PDF, text block — carries
all of these):

1. The **claim URI** (§4), rendered as a QR code and as text — carrying the
   `seed` parameter when the kit is funded (§4.1).
2. The **secret ID** and **estimated reveal date**, in plain text.

The kit does **not** carry the identity key's 24-word mnemonic (§5). The words
encode only the identity key, so they are strictly less than the URI: they lose
the secret pointer and, on a funded kit, the courier holding the recipient's
starter funds. Printing both invites someone to keep the incomplete one — and
made a claim look like a backup of the identity, which it is not. A recipient
therefore backs their claimed identity up like any other key, through the §5
mnemonic and the confirm-back test, after claiming.
4. **Instructions**: install the app, scan or type the words; and the
   renewal caveat — "this paper finds your secret by *key*; the ID may be
   superseded by renewals".

**Security copy is part of the format**: the kit IS the key — whoever
holds it can decrypt the secret at reveal time, and sending it through
email or a messaging platform entrusts that channel with the key. The
artefact must carry this warning, and the sharing UX should prefer
end-to-end-encrypted channels or physical delivery. Nothing about a kit is
ever stored server-side; the generating app offers to wipe its local copy
of the private key after export confirmation.

## 7. Quoting a creation price

Binding on any client that shows a creator what a secret will cost.

**Quote every non-refundable charge.** A creation debits five amounts: the
reward pool, the guardians' acceptance cover, the creation fee, and two
transaction fees. The first two are escrow and can come back; the last three
cannot. A quote that omits any of them shows the user a number they will not
pay — and the creation fee is the one most easily missed, because unlike the
others it never enters module escrow and no refund path mentions it again.

**Never compute a sufficiency check from a subtotal.** Compare the balance
against the full debit, in the chain's own units. A creator holding just over
an under-stated quote clears the check and fails on chain; worse, one who
clears phase 1 and cannot fund phase 2 has already spent the creation fee and
never gets it back. The SDK's `creationQuote` returns `totalUveil` for exactly
this comparison, and `refundableUveil` for honest presentation — the latter is
never a sufficiency base.

**Break the total down, and make the parts sum to it.** A user deciding
whether a price is fair needs to see what each charge buys and which of them
they might get back. A card whose visible lines do not reconcile to its own
total is worse than no breakdown.

**Quote and sign at the same gas price.** A client that offers a gas-price
override must pass the same value to its quote and to its transactions.
`creationQuote({ gasPriceTenths })` and `TimeflareTxClient.connect(…, {
gasPriceTenths })` take it for that reason.

**Do not offer values the chain will reject.** Dial bounds are published as
`DIALS` and pinned to `testdata/vectors/dials.json`, which the chain asserts
against its own validators. Read bounds from there rather than restating them:
a retyped limit goes stale the moment the chain's moves, and several bounds
depend on other dials (the band ceiling on the threshold and target, the
reveal offset on the commit window). Submitting out-of-range input costs the
user gas to learn something the client already knew — which is why the SDK
throws `TxValidationError` before broadcasting rather than letting it through.

## 8. Receiving VEIL — `timeflare:fund/`

The "send me VEIL" link/QR: a wallet's receive code, and the actionable form
of the request a dormant wallet makes when it cannot pay its own first fee.

```
timeflare:fund/<bech32 account address>[?amount=<uveil>]

payload:  the chain's account address verbatim (tmflr1…), NOT re-encoded
amount:   optional, integer uveil, no decimal point and no unit suffix
example shape: timeflare:fund/tmflr1… (~59 chars)
```

- **The address is carried as the chain writes it.** Unlike §3 and §4 this
  payload has no bech32m wrapper and no version byte: the address is already
  a checksummed bech32 string with its own HRP, and wrapping it would add a
  second checksum, lengthen the code, and make the URI unrecognisable as the
  address a user can read back.
- **The bare `tmflr1…` is also valid for manual paste**, as in §3; producers
  always emit the full URI.
- **`amount` is a request, never an instruction.** A client prefills it and
  leaves it editable, and the sender confirms and signs as they would for
  any transfer. A malformed or out-of-range value degrades to a blank amount
  rather than failing the parse — the address is the load-bearing part, and
  refusing the whole URI over a garbled quantity would strand a hand-off
  that is still perfectly usable.
- **This is the only path that carries a quantity**, and §2's rule bounds
  what that may ever mean: there is no `timeflare:send/`, because a code
  that names both a destination and a quantity for someone else's
  transaction is a transfer instruction in scannable form.

## 9. Wallet HD path — the chain's BIP44 coin type

The WALLET key (secp256k1, signs transactions) is a separate domain from the
identity key (§5): it is HD-derived from its own 24-word mnemonic, and the
derivation path is a chain parameter, not a client choice. Ruled 1 August
2026: every client that generates or restores a wallet mnemonic derives at

```
m/44'/9733'/0'/0/0
```

- **The authority is spec.md** ("Configuration & Parameters" → Network
  Configuration): coin type 9733, the shared constant `ChainCoinType`
  (`x/secrets/types`), applied on-chain in `app/config.go`. This section is a
  pointer, not a second source.
- **Never accept a library default.** cosmjs defaults to Cosmos Hub's
  `m/44'/118'/0'/0/0`; the same 24 words restored at 118 resolve to a
  different, empty account — the "my tokens are gone" failure.
- **Vector-pinned** (principle 3): `testdata/vectors/wallet_derivation.json`
  maps mnemonic → address at the chain path, and records the 118-derived
  address as a negative assertion so a regression to the library default
  fails with a recognisable message rather than an opaque mismatch.
- **Courier keys are deliberately path-free** (§6): a claim kit carries a raw
  secp256k1 scalar because the whole key must fit in the claim URI, and a
  courier is not a wallet anyone keeps. Never "align" courier keys to this
  path — it would break every outstanding kit.

## 10. Reserved / not yet pinned

- **Bulletin-board key registry** (feature plan §16.2.3): the well-known
  public-disclosure key list (signed JSON, hosted + mirrorable). Deferred —
  the paste-a-key pattern needs no registry to work.
- Additional `timeflare:` paths (e.g. `timeflare:secret/<id>` for plain
  secret deep-links) — unreserved today; any addition lands in this
  document first.
- **`https://` universal-link mirror** (§2): deferred, and bounded when it
  arrives — it leads to an install page and nothing else. No browser-side
  path ever resolves a recipient key, a claim kit or an address.
