/**
 * Recipient-side machinery (shared with creator-side verification):
 * reconstruction from revealed key shares with an explicit commitment check,
 * final recipient decrypt, detection-hint discovery scanning, and sweeping a
 * funded claim kit's courier key into the recipient's own wallet.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { toHex } from '@cosmjs/encoding';

import { SEND_FEE_UVEIL, TimeflareTxClient } from './txclient';
import { CryptoProvider, toArrayBuffer, toUint8Array } from './crypto';
import { TimeflareRestClient } from './rest';
import { walletFromPrivateKeyHex } from './wallet';
import { AbortLike, WatchAbortedError } from './watch';

export interface ReconstructionResult {
  /** C_r — the verified recipient-encrypted payload (the public result). */
  innerCiphertext: Uint8Array;
  /**
   * The explicit integrity tick: SHA256(innerCiphertext) was re-computed
   * OUTSIDE the crypto provider and matches the on-chain commitment —
   * "payload verified against creator's commitment".
   */
  commitmentVerified: boolean;
  revealsUsed: number;
  threshold: number;
}

/**
 * Reconstruct a revealed secret: fetch ≥t revealed key shares and the stored
 * payload ciphertext (Query/SecretPayload), combine into the per-secret key
 * (verified against pk_s), strip the outer layer, verify the commitment —
 * then assert the commitment once more independently of the crypto provider.
 * Any party can run this; only the recipient can decrypt the result.
 */
export async function reconstructSecret(
  crypto: CryptoProvider,
  rest: TimeflareRestClient,
  secretId: string,
): Promise<ReconstructionResult> {
  const secret = await rest.secretMeta(secretId);
  if (!secret) {
    throw new Error(`secret ${secretId} not found on chain (pruned or never existed)`);
  }
  const reveals = await rest.secretReveals(secretId);
  if (reveals.length < secret.threshold) {
    throw new Error(
      `only ${reveals.length}/${secret.threshold} shares revealed — not yet reconstructable`,
    );
  }
  const payloadCiphertext = await rest.secretPayload(secretId);
  if (!payloadCiphertext) {
    throw new Error(`secret ${secretId} has no payload ciphertext on chain`);
  }

  const inner = crypto.reconstruct(
    reveals.slice(0, secret.threshold).map((r) => toArrayBuffer(r.decryptedShare)),
    secret.threshold,
    toArrayBuffer(payloadCiphertext),
    secret.secretPublicKey.length === 32 ? toArrayBuffer(secret.secretPublicKey) : undefined,
    toArrayBuffer(secret.secretCommitment),
  );
  const innerCiphertext = toUint8Array(inner);

  // The crypto provider already verified the commitment; re-derive it here
  // independently so the integrity tick never rests on a single code path.
  const digest = sha256(innerCiphertext);
  const commitmentVerified =
    digest.length === secret.secretCommitment.length &&
    digest.every((byte, i) => byte === secret.secretCommitment[i]);
  if (!commitmentVerified) {
    throw new Error(
      'SHA256(reconstructed payload) does not match the on-chain commitment',
    );
  }

  return {
    innerCiphertext,
    commitmentVerified,
    revealsUsed: secret.threshold,
    threshold: secret.threshold,
  };
}

/** The recipient's final step: decrypt C_r with the identity private key. */
export function decryptReconstructed(
  crypto: CryptoProvider,
  innerCiphertext: Uint8Array,
  identityPrivateKey: Uint8Array,
): Uint8Array {
  return toUint8Array(
    crypto.decryptPayload(toArrayBuffer(innerCiphertext), toArrayBuffer(identityPrivateKey)),
  );
}

/**
 * Discovery scan (Query/HintsSince): test each hint record against the
 * identity private key — one X25519 op per new secret, incremental and
 * resumable via the returned cursor. Only the key holder can perform this
 * scan; there is no on-chain or third-party equivalent, by design.
 *
 * Pages are walked with the store's `pagination.key` against a FIXED
 * sinceHeight — never by rewinding the height cursor to a page's last
 * createdAt. Heights are not unique, so a height rewind cannot advance past a
 * creation height denser than one page: anyone able to land pageLimit
 * creations in one block could wedge every recipient's scan forever.
 *
 * A first scan consumes the whole hint backlog, so `signal` lets a caller
 * (an unmounting screen) stop the network and X25519 work between pages —
 * the scan throws WatchAbortedError and the caller resumes later from its
 * persisted cursor.
 */
export async function discoverSecrets(
  crypto: CryptoProvider,
  rest: TimeflareRestClient,
  identityPrivateKey: Uint8Array,
  sinceHeight = 0,
  pageLimit = 1000,
  signal?: AbortLike,
): Promise<{ secretIds: string[]; nextSinceHeight: number }> {
  const secretIds: string[] = [];
  const seen = new Set<string>();
  const sk = toArrayBuffer(identityPrivateKey);
  let cursor = sinceHeight;
  let pageKey: Uint8Array | undefined;

  for (;;) {
    if (signal?.aborted) {
      throw new WatchAbortedError(`aborted while scanning hints from height ${sinceHeight}`);
    }
    const { hints, nextKey } = await rest.hintsSince(sinceHeight, pageLimit, pageKey);
    for (const record of hints) {
      if (record.detectionHint) {
        const match = crypto.scanHint(
          {
            version: record.detectionHint.version,
            ephemeralPub: toArrayBuffer(record.detectionHint.ephemeralPub),
            tag: toArrayBuffer(record.detectionHint.tag),
          },
          sk,
        );
        if (match && !seen.has(record.secretId)) {
          seen.add(record.secretId);
          secretIds.push(record.secretId);
        }
      }
      cursor = record.createdAt + 1;
    }
    if (nextKey === undefined) {
      break;
    }
    pageKey = nextKey;
  }

  return { secretIds, nextSinceHeight: cursor };
}

// ── Courier sweep (funded claim kits) ────────────────────────────────────────

/**
 * A courier holds so little that the send fee is a material fraction of it, so
 * the amount to move is the balance minus exactly one send fee — never the whole
 * balance, which would fail for want of gas.
 */
export function courierSweepAmountUveil(balanceUveil: bigint): bigint {
  const spendable = balanceUveil - SEND_FEE_UVEIL;
  return spendable > 0n ? spendable : 0n;
}

export interface CourierSweepResult {
  /** `swept` moved funds; `empty` found nothing worth moving and did nothing. */
  outcome: 'swept' | 'empty';
  amountUveil: bigint;
  txHash?: string;
}

/**
 * Sweep a funded claim kit's courier into the recipient's own wallet.
 *
 * This is what brings a brand-new recipient onto the chain: the sender funded the
 * courier, so the COURIER has an account and can sign — and the transfer it signs
 * is what creates the recipient's own account, which until then does not exist
 * and therefore cannot sign anything at all
 * (DONE_WALLET_BOOTSTRAPPING_PLAN §3).
 *
 * Idempotent by inspection rather than by bookkeeping: an already-swept courier
 * has nothing to move and returns `empty`. A second import is a no-op, not a
 * failure — the caller must not present it as one.
 *
 * The courier is abandoned afterwards. It is never adopted as a wallet: the
 * SENDER generated it and may have kept a copy, so it is a courier for one
 * transfer and nothing more.
 */
export async function sweepCourier(params: {
  rpcUrl: string;
  restUrl: string;
  courierPrivateKey: Uint8Array;
  /** The recipient's own wallet address — the sweep destination. */
  destination: string;
}): Promise<CourierSweepResult> {
  const { wallet, address } = await walletFromPrivateKeyHex(toHex(params.courierPrivateKey));
  if (address === params.destination) {
    throw new Error('courier and destination are the same address — refusing to sweep to itself');
  }

  const rest = new TimeflareRestClient(params.restUrl);
  const balance = await rest.balance(address);
  const amountUveil = courierSweepAmountUveil(balance);
  if (amountUveil <= 0n) {
    return { outcome: 'empty', amountUveil: 0n };
  }

  const tx = await TimeflareTxClient.connect(params.rpcUrl, wallet);
  try {
    const { txHash } = await tx.sendVeil({ to: params.destination, amountUveil });
    return { outcome: 'swept', amountUveil, txHash };
  } finally {
    tx.disconnect();
  }
}
