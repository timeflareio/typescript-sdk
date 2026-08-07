/**
 * The commit session: the two-signature creation flow (Phase 1 → seal →
 * Phase 2) with persistence and chain-state reconciliation — the session
 * survives being killed between phases and resumes idempotently, chain truth
 * winning on every resume (feature plan §5.2/§5.4).
 *
 * **Retry semantics.** Resumption is for an *interrupted* session, never a
 * FAILED secret. A secret that fails at `commit_deadline` is permanent: its
 * pool refunds automatically in the next block, and a retry starts a new
 * session from Phase 1 — new secret ID, new selection draw, new inner seal, new
 * per-secret keypair, new shares, new hint. Never carry a failed attempt's
 * sealed material into the next one: it cannot serve the new attempt, and a
 * reused inner seal would repeat `secret_commitment` byte-for-byte and publicly
 * link the attempts (spec.md, Common Attack Vectors #7). This falls out of the
 * design — one seal per secret ID, and a retry necessarily has a new one — so
 * the convention is a rule about what callers must not build around it.
 */

import { toBase64, fromBase64 } from '@cosmjs/encoding';

import { COMMIT_TIMEOUT_BLOCKS, defaultMaxShares, shareBandError } from './constants';
import { CryptoProvider, GuardianRecipient, toArrayBuffer, toUint8Array } from './crypto';
import { TimeflareRestClient } from './rest';
import { TimeflareTxClient } from './txclient';

/** Serialisable session state. Real apps encrypt this at rest. */
export interface CommitSessionState {
  version: 2;
  creator: string;
  /** Composed (pre-seal) payload, base64 — persisted so a killed session can re-seal. */
  payloadB64: string;
  /** The recipient's X25519 public key, base64 (client-side only, never on chain). */
  recipientPublicKeyB64: string;
  params: {
    threshold: number;
    /** Band floor: minimum acceptances for the secret to activate. */
    minShares: number;
    /** Band ceiling: candidates selected and shares distributed. */
    maxShares: number;
    bump: number;
    /** Blocks from creation until reveals open; the window's length follows from it. */
    revealStartOffset: number;
  };
  /** Set once Phase 1 lands. */
  secretId?: string;
  commitDeadline?: number;
  /**
   * The protocol-assigned guardian set (address + encryption key, base64),
   * captured from the Phase 1 response. Persisted because the chain does not
   * expose assignments until Phase 2 lands — a resumed session cannot
   * re-query them.
   */
  guardians?: { address: string; publicKeyB64: string }[];
  /** Set once Phase 2 lands. */
  distributed?: boolean;
}

/** Where session state persists between launches (app: encrypted storage). */
export interface SessionStore {
  save(state: CommitSessionState): Promise<void> | void;
  load(): Promise<CommitSessionState | null> | CommitSessionState | null;
  clear(): Promise<void> | void;
}

/** In-memory store — for tests and one-shot scripts. */
export class MemorySessionStore implements SessionStore {
  private state: CommitSessionState | null = null;
  save(state: CommitSessionState): void {
    this.state = JSON.parse(JSON.stringify(state));
  }
  load(): CommitSessionState | null {
    return this.state;
  }
  clear(): void {
    this.state = null;
  }
}

/** What a resumed client should do, per chain truth. */
export type ReconcileAction =
  /** No Phase 1 on chain — start (or restart) from the beginning. */
  | 'start'
  /** Phase 1 landed, commit window still open — seal and distribute now. */
  | 'resume-distribute'
  /** Phase 2 landed — watch acceptance until pending. */
  | 'await-acceptance'
  /** The secret activated (pending or beyond) — the session is complete. */
  | 'complete'
  /** The commit deadline passed; the chain auto-failed and refunded the pool. */
  | 'failed-commit-timeout'
  /** The creator cancelled it. */
  | 'cancelled';

export interface ReconcileResult {
  action: ReconcileAction;
  state: CommitSessionState;
  /** Chain state at reconcile time (null when no secret exists on chain). */
  chainState: string | null;
  /** For resume-distribute: blocks left before the commit deadline. */
  blocksRemaining?: number;
}

/**
 * Reconcile a persisted session against chain state — the relaunch entry
 * point. Pure decision logic: performs no transactions, so calling it any
 * number of times is safe (duplicate resume after success is a no-op).
 */
export async function reconcileSession(
  state: CommitSessionState,
  rest: TimeflareRestClient,
): Promise<ReconcileResult> {
  if (!state.secretId) {
    return { action: 'start', state, chainState: null };
  }
  const secret = await rest.secretMeta(state.secretId);
  if (!secret) {
    // Phase 1 never landed under this id (or the record is long pruned)
    return { action: 'start', state, chainState: null };
  }
  switch (secret.state) {
    case 'reserved': {
      const height = await rest.height();
      return {
        action: 'resume-distribute',
        state,
        chainState: secret.state,
        blocksRemaining: secret.commitDeadline - height,
      };
    }
    case 'awaiting_acceptance':
      return { action: 'await-acceptance', state, chainState: secret.state };
    case 'pending':
    case 'reconstructable':
    case 'revealed':
      return { action: 'complete', state, chainState: secret.state };
    case 'failed':
      return { action: 'failed-commit-timeout', state, chainState: secret.state };
    case 'cancelled':
      return { action: 'cancelled', state, chainState: secret.state };
    default:
      throw new Error(`unrecognised secret state '${secret.state}' — update your client`);
  }
}

export interface CommitSessionDeps {
  tx: TimeflareTxClient;
  rest: TimeflareRestClient;
  crypto: CryptoProvider;
  store: SessionStore;
}

export class CommitSession {
  private constructor(
    private readonly deps: CommitSessionDeps,
    public state: CommitSessionState,
  ) {}

  /**
   * Begin a new session from composed (pre-publish) inputs. minShares is the
   * creator's explicit guardian target; maxShares defaults to the band
   * preset (min + min(ceil(0.3 × min), threshold − 1) — the historical 30%
   * spread clamped to the gap bound). The band is validated with the chain's
   * rule before anything is signed.
   */
  static create(
    deps: CommitSessionDeps,
    input: {
      payload: Uint8Array;
      recipientPublicKey: Uint8Array;
      threshold: number;
      minShares: number;
      /** Override the default band ceiling (advanced; must satisfy the gap bound). */
      maxShares?: number;
      bump: number;
      revealStartOffset: number;
    },
  ): CommitSession {
    const maxShares = input.maxShares ?? defaultMaxShares(input.threshold, input.minShares);
    const bandError = shareBandError(input.threshold, input.minShares, maxShares);
    if (bandError) {
      throw new Error(`invalid guardian band: ${bandError}`);
    }
    return new CommitSession(deps, {
      version: 2,
      creator: deps.tx.address,
      payloadB64: toBase64(input.payload),
      recipientPublicKeyB64: toBase64(input.recipientPublicKey),
      params: {
        threshold: input.threshold,
        minShares: input.minShares,
        maxShares,
        bump: input.bump,
        revealStartOffset: input.revealStartOffset,
      },
    });
  }

  /** Rehydrate a persisted session (app relaunch). Reconcile before acting. */
  static resume(deps: CommitSessionDeps, state: CommitSessionState): CommitSession {
    if (state.version !== 2) {
      throw new Error(`unknown session version ${state.version} — update your client`);
    }
    return new CommitSession(deps, state);
  }

  /** Reconcile this session against chain truth. */
  async reconcile(): Promise<ReconcileResult> {
    return reconcileSession(this.state, this.deps.rest);
  }

  /**
   * Phase 1 — sign and broadcast MsgUserRequestGuardians; the detection hint is
   * derived client-side from the recipient's public key, which never leaves
   * the device. Persists the protocol-assigned secret ID and guardian set
   * before returning — the guardians exist only in the Phase 1 response
   * until distribution, so losing them would strand the session.
   */
  async requestGuardians(): Promise<{ secretId: string; commitDeadline: number }> {
    if (this.state.secretId) {
      throw new Error('phase 1 already completed for this session — reconcile instead');
    }
    const recipientKey = fromBase64(this.state.recipientPublicKeyB64);
    const hint = this.deps.crypto.deriveHint(toArrayBuffer(recipientKey));
    const { secretId, guardianAssignments, height } = await this.deps.tx.requestGuardians({
      detectionHint: {
        version: hint.version,
        ephemeralPub: toUint8Array(hint.ephemeralPub),
        tag: toUint8Array(hint.tag),
      },
      revealStartOffset: this.state.params.revealStartOffset,
      threshold: this.state.params.threshold,
      minShares: this.state.params.minShares,
      maxShares: this.state.params.maxShares,
      bump: this.state.params.bump,
    });
    if (guardianAssignments.length === 0) {
      throw new Error(`phase 1 for ${secretId} returned no guardian assignments`);
    }
    for (const guardian of guardianAssignments) {
      if (guardian.publicKey.length !== 32) {
        throw new Error(`guardian ${guardian.address} has no valid encryption key`);
      }
    }
    this.state.secretId = secretId;
    this.state.commitDeadline = height + COMMIT_TIMEOUT_BLOCKS;
    this.state.guardians = guardianAssignments.map((guardian) => ({
      address: guardian.address,
      publicKeyB64: toBase64(guardian.publicKey),
    }));
    await this.deps.store.save(this.state);
    return { secretId, commitDeadline: this.state.commitDeadline };
  }

  /**
   * Seal on-device and distribute (Phase 2): seal to the guardian set
   * persisted from the Phase 1 response (the chain does not expose
   * assignments until this message lands, so the persisted set is the only
   * source), run the one audited seal path in the crypto provider (inner
   * encrypt → commitment → per-secret keypair → outer encrypt → t-of-n key
   * split → per-guardian encrypt + HMAC), then sign and broadcast
   * MsgUserDistributeShares inside the commit window.
   */
  async sealAndDistribute(): Promise<{ secretId: string }> {
    const secretId = this.state.secretId;
    if (!secretId) {
      throw new Error('phase 1 has not completed — call requestGuardians first');
    }
    const secret = await this.deps.rest.secretMeta(secretId);
    if (!secret) {
      throw new Error(`secret ${secretId} not found on chain`);
    }
    if (secret.state !== 'reserved') {
      throw new Error(
        `secret ${secretId} is '${secret.state}', not 'reserved' — reconcile instead of re-distributing`,
      );
    }

    if (!this.state.guardians || this.state.guardians.length === 0) {
      throw new Error(
        `session for ${secretId} has no persisted guardian assignments — ` +
          'phase 1 state is incomplete and the chain cannot re-supply them; start a new session',
      );
    }
    const guardians: GuardianRecipient[] = this.state.guardians.map((guardian) => ({
      address: guardian.address,
      publicKey: toArrayBuffer(fromBase64(guardian.publicKeyB64)),
    }));

    const sealed = this.deps.crypto.sealSecret(
      toArrayBuffer(fromBase64(this.state.payloadB64)),
      toArrayBuffer(fromBase64(this.state.recipientPublicKeyB64)),
      guardians,
      this.state.params.threshold,
      secretId,
    );

    await this.deps.tx.distributeShares({
      secretId,
      shares: sealed.keyShares.map((share) => ({
        guardianAddress: share.guardianAddress,
        encryptedShare: toUint8Array(share.encryptedShare),
        shareHmac: toUint8Array(share.shareHmac),
      })),
      secretCommitment: toUint8Array(sealed.commitment),
      payloadCiphertext: toUint8Array(sealed.payloadCiphertext),
      secretPublicKey: toUint8Array(sealed.secretPublicKey),
    });

    this.state.distributed = true;
    await this.deps.store.save(this.state);
    return { secretId };
  }
}
