/**
 * Client conventions — the pinned ecosystem wire formats from
 * docs/guides/CLIENT_CONVENTIONS.md (rulings, July 2026):
 *
 *   §3 recipient key exchange   timeflare:recipient/<bech32m tfid…>
 *   §4 claim URI                timeflare:claim/<bech32m tfsk…>?id=<secret-id>
 *   §5 identity-key backup      BIP39 (English, 24 words) over the raw
 *                               32-byte X25519 private key
 *   §8 receiving VEIL           timeflare:fund/<tmflr1…>[?amount=<uveil>]
 *
 * Every bech32m payload starts with a version byte; parsers encountering an
 * unknown version reject with an "update your client" error — they never
 * guess. The fund URI is the exception and carries no wrapper at all: the
 * chain's address is already checksummed, and re-encoding it would checksum a
 * checksum. All encodings are pinned by testdata/vectors/client_conventions.json
 * (append-only corpus; asserted by this package's tests).
 */

import { bech32m } from 'bech32';
import { Bip39, EnglishMnemonic } from '@cosmjs/crypto';
import { fromBech32 } from '@cosmjs/encoding';

import { CHAIN_PREFIX } from './constants';

export const RECIPIENT_URI_PREFIX = 'timeflare:recipient/';
export const CLAIM_URI_PREFIX = 'timeflare:claim/';
export const FUND_URI_PREFIX = 'timeflare:fund/';
/** "timeflare identity" — recipient public keys. */
export const RECIPIENT_HRP = 'tfid';
/** "timeflare secret key" — the HRP itself signals sensitivity. */
export const CLAIM_HRP = 'tfsk';
/**
 * "timeflare courier key" — the single-use secp256k1 WALLET key that carries a
 * seed to a new recipient (DONE_WALLET_BOOTSTRAPPING_PLAN §3).
 *
 * A distinct HRP from `tfsk` on purpose: an identity key and a courier key are
 * different curves with different jobs, and conflating them is the specific
 * mistake that would fund an address whose private key the protocol publishes.
 * The encoding makes it impossible rather than merely documented.
 */
export const COURIER_HRP = 'tfck';
/** The baseline payload version: every format except a seeded claim kit. */
export const CONVENTION_VERSION = 0x01;
/**
 * A claim kit carrying a courier key is version 2, and only then.
 *
 * The version byte is what makes a seeded kit SAFE to hand to an old client:
 * parsers reject unknown versions outright (see `decodePayload`), so a
 * pre-change app refuses the whole kit rather than importing the identity and
 * silently abandoning the seed in a courier address nobody is tracking.
 * Refusing keeps the kit a complete, re-importable artefact.
 *
 * An unseeded kit stays version 1, so nothing regresses for the existing flow.
 */
export const CLAIM_SEEDED_VERSION = 0x02;

const KEY_LENGTH = 32;
/** bech32m guarantees hold to 90 characters; anything longer is rejected. */
const BECH32M_LIMIT = 90;
/** The chain's secret ID format, verbatim: lowercase UUID. */
const SECRET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ConventionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConventionError';
  }
}

function encodePayload(hrp: string, key: Uint8Array, version = CONVENTION_VERSION): string {
  if (key.length !== KEY_LENGTH) {
    throw new ConventionError(`key must be exactly ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const payload = new Uint8Array(1 + KEY_LENGTH);
  payload[0] = version;
  payload.set(key, 1);
  return bech32m.encode(hrp, bech32m.toWords(payload), BECH32M_LIMIT);
}

function decodePayload(
  hrp: string,
  encoded: string,
  accepted: readonly number[] = [CONVENTION_VERSION],
): { version: number; key: Uint8Array } {
  // bech32m is case-insensitive to scan; normalise before decoding (the
  // library itself rejects mixed case, as the spec requires)
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(encoded.toLowerCase(), BECH32M_LIMIT);
  } catch (error) {
    throw new ConventionError(`invalid bech32m payload: ${(error as Error).message}`);
  }
  if (decoded.prefix !== hrp) {
    throw new ConventionError(`wrong HRP: expected '${hrp}', got '${decoded.prefix}'`);
  }
  const payload = new Uint8Array(bech32m.fromWords(decoded.words));
  if (payload.length !== 1 + KEY_LENGTH) {
    throw new ConventionError(`payload must be ${1 + KEY_LENGTH} bytes, got ${payload.length}`);
  }
  const version = payload[0];
  if (!accepted.includes(version)) {
    throw new ConventionError(
      `unknown payload version ${version} — update your client to read this code`,
    );
  }
  return { version, key: payload.subarray(1) };
}

// ── §3 recipient key exchange ────────────────────────────────────────────────

/** Produce the full `timeflare:recipient/…` URI for an identity PUBLIC key. */
export function encodeRecipientUri(publicKey: Uint8Array): string {
  return RECIPIENT_URI_PREFIX + encodePayload(RECIPIENT_HRP, publicKey);
}

/**
 * Parse a recipient URI. Accepts the full URI or the bare bech32m string
 * (manual paste); producers always emit the full URI.
 */
export function parseRecipientUri(input: string): { version: number; publicKey: Uint8Array } {
  const trimmed = input.trim();
  const encoded = trimmed.toLowerCase().startsWith(RECIPIENT_URI_PREFIX)
    ? trimmed.slice(RECIPIENT_URI_PREFIX.length)
    : trimmed;
  const { version, key } = decodePayload(RECIPIENT_HRP, encoded);
  return { version, publicKey: key };
}

// ── §4 claim URI ─────────────────────────────────────────────────────────────

/**
 * Produce the combined claim URI: identity PRIVATE key + the pointer to the
 * secret, in one scan. Callers must treat the result as key material.
 *
 * A `courierKey` makes it a SEEDED kit — the sender has funded a single-use
 * wallet whose key travels here, so a recipient with no on-chain account can
 * sweep it to their own wallet and transact for the first time
 * (DONE_WALLET_BOOTSTRAPPING_PLAN §3). Seeded kits are version 2 so that an
 * old client refuses them whole; unseeded kits are unchanged.
 *
 * The courier is a separate payload rather than a longer one: bech32m's
 * error-detection guarantees hold only to 90 characters, which two 32-byte keys
 * in one payload would exceed.
 */
export function encodeClaimUri(
  privateKey: Uint8Array,
  secretId?: string,
  courierKey?: Uint8Array,
): string {
  const seeded = courierKey !== undefined;
  const base =
    CLAIM_URI_PREFIX +
    encodePayload(CLAIM_HRP, privateKey, seeded ? CLAIM_SEEDED_VERSION : CONVENTION_VERSION);

  const params: string[] = [];
  if (secretId !== undefined) {
    if (!SECRET_ID_RE.test(secretId)) {
      throw new ConventionError(`secret id must be a lowercase UUID, got '${secretId}'`);
    }
    params.push(`id=${secretId}`);
  }
  if (courierKey !== undefined) {
    params.push(`seed=${encodePayload(COURIER_HRP, courierKey)}`);
  }
  return params.length === 0 ? base : `${base}?${params.join('&')}`;
}

/**
 * Parse a claim URI. The `id` is a bootstrap convenience only — a missing
 * or malformed id degrades gracefully to key-based discovery (the key is the
 * durable anchor across renewal cycles), so `secretId` may be undefined.
 * The returned private key is key material: no logging, no clipboard echo.
 *
 * A `courierKey` comes back for a seeded kit, and is key material that can MOVE
 * FUNDS — the caller sweeps it once and abandons it.
 *
 * Unlike `id`, a malformed seed does NOT degrade: the version byte has already
 * promised a courier is present, so a seed that will not decode means the URI
 * is damaged in a way that would silently lose money. Failing the import keeps
 * the funds recoverable from an undamaged copy of the kit.
 */
export function parseClaimUri(input: string): {
  version: number;
  privateKey: Uint8Array;
  secretId?: string;
  courierKey?: Uint8Array;
} {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(CLAIM_URI_PREFIX)) {
    throw new ConventionError(`not a claim URI (expected '${CLAIM_URI_PREFIX}…')`);
  }
  const rest = trimmed.slice(CLAIM_URI_PREFIX.length);
  const queryIndex = rest.indexOf('?');
  const encoded = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const { version, key } = decodePayload(CLAIM_HRP, encoded, [
    CONVENTION_VERSION,
    CLAIM_SEEDED_VERSION,
  ]);

  let secretId: string | undefined;
  let seedParam: string | null = null;
  if (queryIndex !== -1) {
    const params = new URLSearchParams(rest.slice(queryIndex + 1));
    const id = params.get('id');
    // Stale/absent/malformed ids degrade to discovery rather than failing
    // the key import — the key is the durable anchor
    if (id !== null && SECRET_ID_RE.test(id)) {
      secretId = id;
    }
    seedParam = params.get('seed');
  }

  // The version byte and the seed parameter must agree. Either way round, a
  // disagreement means the URI was truncated or rewritten in transit, and
  // guessing which half to trust risks abandoning funds.
  if (version === CLAIM_SEEDED_VERSION && seedParam === null) {
    throw new ConventionError(
      'claim URI declares a funded kit but carries no seed — the link is incomplete, ' +
        'ask the sender for it again',
    );
  }
  if (version === CONVENTION_VERSION && seedParam !== null) {
    throw new ConventionError(
      'claim URI carries a seed but is not marked as a funded kit — the link is damaged',
    );
  }

  let courierKey: Uint8Array | undefined;
  if (seedParam !== null) {
    courierKey = decodePayload(COURIER_HRP, seedParam).key;
  }
  return { version, privateKey: key, secretId, courierKey };
}

// ── §8 receiving VEIL ────────────────────────────────────────────────────────

/**
 * Produce the `timeflare:fund/…` receive URI for a wallet address.
 *
 * The address rides verbatim — no bech32m wrapper and no version byte, unlike
 * every other payload here. It is already a checksummed bech32 string the
 * chain defines, so re-encoding it would checksum a checksum, lengthen the
 * code, and leave a URI whose user cannot read their own address back out.
 *
 * `amountUveil` is a REQUEST. It exists so a wallet too empty to pay its first
 * fee can ask for a specific quantity; the sender's client prefills it and the
 * sender confirms and signs. Nothing about this URI authorises a transfer.
 */
export function encodeFundUri(address: string, amountUveil?: bigint): string {
  const trimmed = address.trim();
  let prefix: string;
  try {
    ({ prefix } = fromBech32(trimmed));
  } catch {
    throw new ConventionError(`not a valid bech32 account address: '${trimmed}'`);
  }
  if (prefix !== CHAIN_PREFIX) {
    throw new ConventionError(
      `address belongs to another chain ('${prefix}'), expected '${CHAIN_PREFIX}'`,
    );
  }
  if (amountUveil === undefined) return FUND_URI_PREFIX + trimmed;
  if (amountUveil <= 0n) {
    throw new ConventionError(`requested amount must be positive, got ${amountUveil}`);
  }
  return `${FUND_URI_PREFIX}${trimmed}?amount=${amountUveil}`;
}

/**
 * Parse a fund URI. Accepts the full URI or the bare `tmflr1…` (manual paste);
 * producers always emit the full URI.
 *
 * A malformed `amount` comes back undefined rather than throwing. The address
 * is the load-bearing half: a garbled quantity leaves a hand-off that still
 * works — the sender types the number — whereas refusing the whole URI strands
 * it for no gain. A bad ADDRESS does throw, because there is nothing usable
 * left and sending to a mistyped address is unrecoverable.
 */
export function parseFundUri(input: string): { address: string; amountUveil?: bigint } {
  const trimmed = input.trim();
  const body = trimmed.toLowerCase().startsWith(FUND_URI_PREFIX)
    ? trimmed.slice(FUND_URI_PREFIX.length)
    : trimmed;
  const queryIndex = body.indexOf('?');
  const address = (queryIndex === -1 ? body : body.slice(0, queryIndex)).toLowerCase();

  let prefix: string;
  try {
    ({ prefix } = fromBech32(address));
  } catch {
    throw new ConventionError(
      'not a valid account address — addresses are checksummed, so a single wrong ' +
        'character is caught here',
    );
  }
  if (prefix !== CHAIN_PREFIX) {
    throw new ConventionError(
      `address belongs to another chain ('${prefix}'), expected '${CHAIN_PREFIX}'`,
    );
  }

  let amountUveil: bigint | undefined;
  if (queryIndex !== -1) {
    const raw = new URLSearchParams(body.slice(queryIndex + 1)).get('amount');
    // Digits only: BigInt() would happily accept '0x10', ' 12 ' and '1e3'.
    if (raw !== null && /^[0-9]+$/.test(raw)) {
      const parsed = BigInt(raw);
      if (parsed > 0n) amountUveil = parsed;
    }
  }
  return { address, amountUveil };
}

// ── §5 identity-key backup mnemonic ─────────────────────────────────────────

/**
 * Encode the raw 32-byte X25519 private key directly as BIP39 entropy —
 * 24 English words, one mnemonic per identity key, no derivation scheme.
 * The mnemonic round-trips the stored bytes byte-exactly (clamping applies
 * at Diffie–Hellman time, per spec.md).
 */
export function keyToMnemonic(privateKey: Uint8Array): string {
  if (privateKey.length !== KEY_LENGTH) {
    throw new ConventionError(
      `identity private key must be exactly ${KEY_LENGTH} bytes, got ${privateKey.length}`,
    );
  }
  return Bip39.encode(privateKey).toString();
}

/**
 * Decode 24 words back to the 32-byte private key. Whitespace is normalised
 * and case folded; the BIP39 checksum is enforced. Callers verify success by
 * re-deriving the public key before declaring the restore complete.
 */
export function mnemonicToKey(words: string): Uint8Array {
  const normalised = words.trim().toLowerCase().split(/\s+/).join(' ');
  if (normalised.split(' ').length !== 24) {
    throw new ConventionError(
      `identity backup mnemonics are exactly 24 words, got ${normalised.split(' ').length}`,
    );
  }
  let mnemonic: EnglishMnemonic;
  try {
    mnemonic = new EnglishMnemonic(normalised);
  } catch (error) {
    throw new ConventionError(`invalid mnemonic: ${(error as Error).message}`);
  }
  const entropy = Bip39.decode(mnemonic);
  if (entropy.length !== KEY_LENGTH) {
    throw new ConventionError(`mnemonic decoded to ${entropy.length} bytes, expected ${KEY_LENGTH}`);
  }
  return entropy;
}
