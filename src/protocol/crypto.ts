/**
 * The crypto seam: the §3.2 surface of the UniFFI bindings package
 * (packages/crypto), expressed as an interface so this package stays
 * platform-neutral. Under Node (headless tests, e2e) the caller injects the
 * ubrn-generated N-API bindings; in the app it injects the JSI module — both
 * expose exactly this generated API shape, so the adapter is the identity.
 *
 * Crypto source of truth lives in the chain repo's rust/ crate; this package
 * consumes, never forks, and never implements protocol crypto in TypeScript.
 */

export interface CryptoKeypair {
  privateKey: ArrayBuffer;
  publicKey: ArrayBuffer;
}

export interface GuardianRecipient {
  address: string;
  publicKey: ArrayBuffer;
}

export interface SealedKeyShare {
  guardianAddress: string;
  /** The 34B envelope encrypted to the guardian's public key. */
  encryptedShare: ArrayBuffer;
  /** HMAC over the PLAINTEXT envelope — the chain's reveal/slash commitment. */
  shareHmac: ArrayBuffer;
}

export interface SealedSecret {
  /** C — the recipient-encrypted payload, encrypted once more to pk_s. */
  payloadCiphertext: ArrayBuffer;
  /** pk_s — stored on the secret record for public fault attribution. */
  secretPublicKey: ArrayBuffer;
  /** SHA256(C_r) — verifies reconstruction without the recipient's key. */
  commitment: ArrayBuffer;
  /** One sealed key share per guardian, in input order. */
  keyShares: SealedKeyShare[];
}

export interface DetectionHintData {
  version: number;
  /** R — fresh X25519 ephemeral public key (32 bytes). */
  ephemeralPub: ArrayBuffer;
  /** SHA256("timeflare/detect/v1" ‖ X25519(e, A))[:8] (8 bytes). */
  tag: ArrayBuffer;
}

/**
 * A guardian's registered X25519 encryption key cannot be used for encryption.
 *
 * Thrown before sealing rather than during it. The only way to hit this is a
 * small-order public key: an X25519 exchange against one yields an all-zero
 * shared secret, so the share would be encrypted under a publicly computable
 * key. The chain rejects such keys at registration and rotation, so a guardian
 * selected today cannot carry one — this remains as defence in depth for keys
 * registered before that validation existed, and so the failure names the
 * guardian instead of surfacing as an opaque crypto error mid-seal.
 *
 * Recoverable: the secret can be retried, and a creator holding a wide enough
 * band can exclude this guardian (distribution to fewer than `max_shares` is
 * legal down to `threshold`).
 */
export class UnusableGuardianKeyError extends Error {
  constructor(public readonly guardianAddress: string) {
    super(
      `guardian ${guardianAddress} has an unusable X25519 encryption key ` +
        `(small-order point): a share encrypted to it would be readable by anyone`,
    );
    this.name = 'UnusableGuardianKeyError';
  }
}

export interface CryptoProvider {
  keygenX25519(): CryptoKeypair;
  /**
   * X25519 public key from a stored (unclamped) private scalar — clamping
   * applies inside the Diffie–Hellman op, so the stored bytes round-trip
   * exactly. Restores carry only the private key (24 words / claim URI), and
   * CLIENT_CONVENTIONS.md §5 requires re-deriving the public key before a
   * restore is declared complete — this member is what closes that path
   * through the one Rust crate instead of a TypeScript re-implementation.
   */
  publicKeyFromPrivate(privateKey: ArrayBuffer): ArrayBuffer;
  /**
   * Seal a payload for a set of assigned guardians.
   *
   * **Retry semantics** — a failed secret is never resumed. Retry by starting a
   * NEW session: every attempt must be sealed fresh, and a previous attempt's
   * sealed output must never be persisted and re-submitted. Each call already
   * generates a fresh per-secret keypair and randomised inner encryption, so
   * honouring this costs nothing; reusing an inner seal would repeat
   * `secret_commitment` byte-for-byte and publicly link the two attempts on
   * chain (spec.md, Common Attack Vectors #7).
   */
  sealSecret(
    payload: ArrayBuffer,
    recipientPublicKey: ArrayBuffer,
    guardians: GuardianRecipient[],
    threshold: number,
    secretId: string,
  ): SealedSecret;
  reconstruct(
    keyShares: ArrayBuffer[],
    threshold: number,
    payloadCiphertext: ArrayBuffer,
    secretPublicKey: ArrayBuffer | undefined,
    commitment: ArrayBuffer,
  ): ArrayBuffer;
  decryptPayload(innerCiphertext: ArrayBuffer, identityPrivateKey: ArrayBuffer): ArrayBuffer;
  deriveHint(recipientPublicKey: ArrayBuffer): DetectionHintData;
  scanHint(hint: DetectionHintData, identityPrivateKey: ArrayBuffer): boolean;
  /**
   * Recompute the recipiency proof z = X25519(a, R) for a secret's hint — the
   * value the chain checks when collecting that secret's rebate. Throws if the
   * hint's ephemeral key is a small-order point (it would address everyone).
   *
   * OPTIONAL: rebate collection needs one X25519 exchange and one SHA256, which
   * a client can perform without any binding at all — the mobile app does
   * exactly that (`state/rebate.ts`, pinned to the same vector corpus). So a
   * backend may legitimately not offer it; the JSI/uniffi native module does
   * not, and adding it there would mean a native rebuild for arithmetic the
   * caller can already do. Check before calling.
   */
  recipiencyProof?(hint: DetectionHintData, identityPrivateKey: ArrayBuffer): ArrayBuffer;
  /**
   * Bind a recipiency proof to the address collecting with it:
   * SHA256("timeflare/rebate-commit/v1" ‖ z ‖ address bytes). Published one
   * block before the proof, this is what stops an observer lifting the proof
   * out of the mempool and taking the rebate.
   *
   * OPTIONAL, for the same reason as `recipiencyProof`.
   */
  rebateCommitment?(proof: ArrayBuffer, collectorAddressBytes: ArrayBuffer): ArrayBuffer;
  hmacShare(shareEnvelope: ArrayBuffer, guardianAddress: string, secretId: string): ArrayBuffer;
}

/** Uint8Array (protobuf side) → ArrayBuffer (bindings side). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** ArrayBuffer (bindings side) → Uint8Array (protobuf side). */
export function toUint8Array(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}
