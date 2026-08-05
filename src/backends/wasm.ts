/**
 * The WASM CryptoProvider backend — web and Node.
 *
 * This is the web/Node counterpart of the mobile client's JSI/N-API backends:
 * one CryptoProvider interface, three builds of the ONE Rust crate behind it.
 * It is a thin marshalling adapter over the existing `#[wasm_bindgen]` exports
 * in `rust/src/lib.rs` — the same core (`seal::seal_secret`, `unseal_secret`,
 * `sss`, `detect`) the UniFFI wrapper calls. No protocol crypto is
 * implemented in TypeScript; this only converts between the interface's
 * ArrayBuffer shapes and the WASM exports' Uint8Array/JsValue shapes.
 *
 * CryptoProvider methods are synchronous, but wasm-bindgen needs an async
 * init, so the module is loaded once by the `createWasmCryptoProvider`
 * factory which returns a ready, synchronous provider.
 */

import {
  CryptoProvider,
  CryptoKeypair,
  DetectionHintData,
  GuardianRecipient,
  SealedKeyShare,
  SealedSecret,
  toArrayBuffer,
  toUint8Array,
  UnusableGuardianKeyError,
} from '../protocol/crypto';

// DETECTION_HINT_VERSION in the Rust crate (detect.rs) — the WASM
// derive_detection_hint returns only ephemeral_pub ‖ tag, so the version is
// reattached here. Kept in lock-step with the chain via the vector corpus.
const DETECTION_HINT_VERSION = 1;

/** The subset of the wasm-bindgen module surface this adapter uses. */
interface WasmModule {
  default(input?: BufferSource): Promise<unknown>;
  generate_keypair(): Uint8Array;
  seal_secret(
    payload: Uint8Array,
    recipientPublicKey: Uint8Array,
    guardians: { address: string; public_key: Uint8Array }[],
    threshold: number,
    secretId: string,
  ): {
    payload_ciphertext: Uint8Array;
    secret_public_key: Uint8Array;
    commitment: Uint8Array;
    key_shares: { guardian_address: string; encrypted_share: Uint8Array; share_hmac: Uint8Array }[];
  };
  unseal_secret(
    revealedShares: Uint8Array[],
    threshold: number,
    payloadCiphertext: Uint8Array,
    commitment: Uint8Array,
    secretPublicKey: Uint8Array,
  ): Uint8Array;
  decrypt_with_private_key(privateKey: Uint8Array, encryptedData: Uint8Array): Uint8Array;
  public_key_from_private(privateKeyBytes: Uint8Array): Uint8Array;
  derive_detection_hint(recipientPublicKey: Uint8Array): Uint8Array;
  scan_detection_hint(privateKey: Uint8Array, ephemeralPub: Uint8Array, tag: Uint8Array): boolean;
  recipiency_proof(privateKey: Uint8Array, ephemeralPub: Uint8Array): Uint8Array;
  rebate_commitment(proof: Uint8Array, collectorAddressBytes: Uint8Array): Uint8Array;
  generate_guardian_hmac(secretId: string, guardianAddress: string, shareData: Uint8Array): Uint8Array;
  is_usable_x25519_public_key(publicKey: Uint8Array): boolean;
}

// A genuine ESM dynamic import that tsc (module: CommonJS) does NOT transform
// into require() and does NOT statically resolve. That is what lets the tsc
// build succeed while still loading the ESM wasm glue at runtime. Mobile
// consumers use the JSI backend and never reach here; only web/Node consumers
// of the `/wasm` entry point do.
const esmImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Load and initialise the wasm-bindgen module (Node reads the file; browser
 * fetches).
 *
 * The bundle is the `@timeflareio/crypto` dependency, so both paths name the
 * package rather than a directory beside this one: Node asks the resolver where
 * the package landed and reads the `.wasm` sitting next to its entry point, and
 * the browser leaves resolution to the bundler.
 */
async function loadWasm(): Promise<WasmModule> {
  if (typeof window === 'undefined') {
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');
    const jsPath = require.resolve('@timeflareio/crypto');
    const wasmPath = path.join(path.dirname(jsPath), 'timeflare_crypto_bg.wasm');
    const mod = (await esmImport(url.pathToFileURL(jsPath).href)) as WasmModule;
    await mod.default(fs.readFileSync(wasmPath));
    return mod;
  }
  // Browser: the bundler resolves the package and its wasm asset at build time.
  const mod = (await esmImport('@timeflareio/crypto')) as WasmModule;
  await mod.default();
  return mod;
}

/**
 * Build the WASM-backed CryptoProvider. Call once at startup (or let the
 * SDK's default factory call it) — the returned provider is synchronous.
 */
export async function createWasmCryptoProvider(): Promise<CryptoProvider> {
  const wasm = await loadWasm();
  return new WasmCryptoProvider(wasm);
}

class WasmCryptoProvider implements CryptoProvider {
  constructor(private readonly wasm: WasmModule) {}

  keygenX25519(): CryptoKeypair {
    const bytes = this.wasm.generate_keypair(); // 64 = private(32) ‖ public(32)
    if (bytes.length !== 64) {
      throw new Error(`unexpected keypair length ${bytes.length}, expected 64`);
    }
    return {
      privateKey: toArrayBuffer(bytes.slice(0, 32)),
      publicKey: toArrayBuffer(bytes.slice(32, 64)),
    };
  }

  publicKeyFromPrivate(privateKey: ArrayBuffer): ArrayBuffer {
    const out = this.wasm.public_key_from_private(toUint8Array(privateKey));
    return toArrayBuffer(new Uint8Array(out));
  }

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
  ): SealedSecret {
    // Validate every guardian's registered key BEFORE sealing. A small-order
    // X25519 key yields an all-zero shared secret, so the share would be
    // encrypted under a publicly computable key — the chain now refuses to
    // register such a key, and the WASM encryption path refuses to use one, but
    // that failure would surface here as an opaque crypto error part-way
    // through a seal the creator has already paid for at Phase 1. Checking up
    // front is what lets the error name the guardian at fault.
    for (const guardian of guardians) {
      if (!this.wasm.is_usable_x25519_public_key(toUint8Array(guardian.publicKey))) {
        throw new UnusableGuardianKeyError(guardian.address);
      }
    }

    const sealed = this.wasm.seal_secret(
      toUint8Array(payload),
      toUint8Array(recipientPublicKey),
      guardians.map((g) => ({ address: g.address, public_key: toUint8Array(g.publicKey) })),
      threshold,
      secretId,
    );
    const keyShares: SealedKeyShare[] = sealed.key_shares.map((ks) => ({
      guardianAddress: ks.guardian_address,
      encryptedShare: toArrayBuffer(new Uint8Array(ks.encrypted_share)),
      shareHmac: toArrayBuffer(new Uint8Array(ks.share_hmac)),
    }));
    return {
      payloadCiphertext: toArrayBuffer(new Uint8Array(sealed.payload_ciphertext)),
      secretPublicKey: toArrayBuffer(new Uint8Array(sealed.secret_public_key)),
      commitment: toArrayBuffer(new Uint8Array(sealed.commitment)),
      keyShares,
    };
  }

  reconstruct(
    keyShares: ArrayBuffer[],
    threshold: number,
    payloadCiphertext: ArrayBuffer,
    secretPublicKey: ArrayBuffer | undefined,
    commitment: ArrayBuffer,
  ): ArrayBuffer {
    // An empty secret-public-key array tells the Rust side to skip the pk_s
    // check (unseal_secret's documented contract).
    const pk = secretPublicKey ? toUint8Array(secretPublicKey) : new Uint8Array(0);
    const inner = this.wasm.unseal_secret(
      keyShares.map(toUint8Array),
      threshold,
      toUint8Array(payloadCiphertext),
      toUint8Array(commitment),
      pk,
    );
    return toArrayBuffer(new Uint8Array(inner));
  }

  decryptPayload(innerCiphertext: ArrayBuffer, identityPrivateKey: ArrayBuffer): ArrayBuffer {
    // WASM arg order is (privateKey, data) — the interface passes (data, key).
    const out = this.wasm.decrypt_with_private_key(
      toUint8Array(identityPrivateKey),
      toUint8Array(innerCiphertext),
    );
    return toArrayBuffer(new Uint8Array(out));
  }

  deriveHint(recipientPublicKey: ArrayBuffer): DetectionHintData {
    const bytes = this.wasm.derive_detection_hint(toUint8Array(recipientPublicKey));
    if (bytes.length !== 40) {
      throw new Error(`unexpected hint length ${bytes.length}, expected 40`);
    }
    return {
      version: DETECTION_HINT_VERSION,
      ephemeralPub: toArrayBuffer(bytes.slice(0, 32)),
      tag: toArrayBuffer(bytes.slice(32, 40)),
    };
  }

  scanHint(hint: DetectionHintData, identityPrivateKey: ArrayBuffer): boolean {
    return this.wasm.scan_detection_hint(
      toUint8Array(identityPrivateKey),
      toUint8Array(hint.ephemeralPub),
      toUint8Array(hint.tag),
    );
  }

  recipiencyProof(hint: DetectionHintData, identityPrivateKey: ArrayBuffer): ArrayBuffer {
    const out = this.wasm.recipiency_proof(
      toUint8Array(identityPrivateKey),
      toUint8Array(hint.ephemeralPub),
    );
    return toArrayBuffer(new Uint8Array(out));
  }

  rebateCommitment(proof: ArrayBuffer, collectorAddressBytes: ArrayBuffer): ArrayBuffer {
    const out = this.wasm.rebate_commitment(
      toUint8Array(proof),
      toUint8Array(collectorAddressBytes),
    );
    return toArrayBuffer(new Uint8Array(out));
  }

  hmacShare(shareEnvelope: ArrayBuffer, guardianAddress: string, secretId: string): ArrayBuffer {
    // WASM arg order is (secretId, guardianAddress, shareData).
    const out = this.wasm.generate_guardian_hmac(
      secretId,
      guardianAddress,
      toUint8Array(shareEnvelope),
    );
    return toArrayBuffer(new Uint8Array(out));
  }
}
