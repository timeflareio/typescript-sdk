/**
 * Signing/broadcast over Tendermint RPC (port 26657) via cosmjs — the ruled
 * chain-access transport for transactions (build plan §1.3). Message types
 * come from the vendored generated protobuf codecs; this file never
 * hand-encodes protocol bytes.
 */

import { GasPrice, SigningStargateClient, DeliverTxResponse, TimeoutError } from '@cosmjs/stargate';
import { EncodeObject, OfflineSigner, Registry } from '@cosmjs/proto-signing';

import {
  GuardianInfo,
  MsgRecipientCollectRebate,
  MsgRecipientCommitRebate,
  MsgUserCancelSecret,
  MsgUserDistributeShares,
  MsgUserRequestGuardians,
  MsgUserRequestGuardiansResponse,
} from '../generated/timeflare/secrets/v1/tx';
import {
  dialErrors,
  cancelSecretGas,
  collectRebateGas,
  commitRebateGas,
  distributeSharesGas,
  gasFeeUveil,
  MIN_GAS_PRICE_TENTHS,
  MAX_PAYLOAD_CIPHERTEXT_BYTES,
  MAX_TOTAL_SHARES,
  requestGuardiansGas,
  SECRET_PUBLIC_KEY_BYTES,
} from './constants';

export const DENOM = 'uveil';
export const DEFAULT_GAS_PRICE = '0.1uveil';

/**
 * Build a cosmjs StdFee from a declared gas limit, priced at the consensus
 * floor. The chain charges the DECLARED limit, not the gas consumed, so this
 * is exactly what the signer pays — which is why a UI can quote it up front.
 */
function feeForGas(
  gas: bigint,
  priceTenths: number = MIN_GAS_PRICE_TENTHS,
): { amount: { denom: string; amount: string }[]; gas: string } {
  return {
    amount: [{ denom: DENOM, amount: gasFeeUveil(gas, priceTenths).toString() }],
    gas: gas.toString(),
  };
}

/**
 * A bank send is far cheaper than the protocol messages (no share arithmetic,
 * no guardian iteration), but priced on the same basis. A wallet UI must be
 * able to quote this before signing, so it is a constant, not an estimate.
 */
const SEND_GAS = 200_000n;

/**
 * Deterministic fees. Phase 2 is not here: its gas depends on the band ceiling
 * and the payload size, so it is computed per call from `distributeSharesGas`.
 * The entry retained below is the WORST CASE (a full 32-share band at the
 * maximum payload) — the figure a UI must reserve when the band is not yet
 * known, never the figure actually charged.
 */
export const FEES = {
  requestGuardiansWorstCase: feeForGas(requestGuardiansGas(MAX_TOTAL_SHARES)),
  distributeSharesWorstCase: feeForGas(distributeSharesGas(MAX_TOTAL_SHARES)),
  cancelSecretWorstCase: feeForGas(cancelSecretGas()),
  send: feeForGas(SEND_GAS),
} as const;

/** The flat fee a send costs, in uveil — what a UI must reserve from a balance. */
export const SEND_FEE_UVEIL = BigInt(FEES.send.amount[0].amount);

const TYPE_URLS = {
  requestGuardians: '/timeflare.secrets.v1.MsgUserRequestGuardians',
  distributeShares: '/timeflare.secrets.v1.MsgUserDistributeShares',
  cancelSecret: '/timeflare.secrets.v1.MsgUserCancelSecret',
  commitRebate: '/timeflare.secrets.v1.MsgRecipientCommitRebate',
  collectRebate: '/timeflare.secrets.v1.MsgRecipientCollectRebate',
} as const;

/** Wrap a ts-proto codec in the shape cosmjs's Registry expects. */
function registryType(codec: {
  encode(message: any): { finish(): Uint8Array };
  decode(input: Uint8Array): unknown;
  fromPartial(object: any): unknown;
}) {
  return {
    encode: (message: any) => ({ finish: () => codec.encode(message).finish() }),
    decode: (input: Uint8Array) => codec.decode(input),
    fromPartial: (object: any) => codec.fromPartial(object),
  } as any;
}

export function timeflareRegistry(): Registry {
  const registry = new Registry();
  registry.register(TYPE_URLS.requestGuardians, registryType(MsgUserRequestGuardians));
  registry.register(TYPE_URLS.distributeShares, registryType(MsgUserDistributeShares));
  registry.register(TYPE_URLS.cancelSecret, registryType(MsgUserCancelSecret));
  registry.register(TYPE_URLS.commitRebate, registryType(MsgRecipientCommitRebate));
  registry.register(TYPE_URLS.collectRebate, registryType(MsgRecipientCollectRebate));
  return registry;
}

export class TxError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly rawLog?: string,
  ) {
    super(message);
    this.name = 'TxError';
  }
}

/**
 * Thrown BEFORE broadcast when the SDK can already tell the chain will reject
 * a message.
 *
 * Throwing rather than returning is deliberate. A rejected transaction still
 * costs the caller its gas, so broadcasting input the SDK has recognised as
 * out of range charges the user to learn something the SDK knew for free. The
 * bounds checked here are the chain's own, mirrored through the DIALS
 * descriptors and pinned to testdata/vectors/dials.json — so this can never
 * refuse a message the chain would have accepted.
 */
export class TxValidationError extends TxError {
  constructor(
    message: string,
    /** Every violation found, not just the first — a UI can show them together. */
    public readonly violations: string[],
  ) {
    super(message);
    this.name = 'TxValidationError';
  }
}

/**
 * Thrown when a transaction passed CheckTx but was not observed in a block
 * within cosmjs's inclusion-polling window. This is NOT a failure: the
 * transaction is in the mempool and MAY still land. A caller that re-signs on
 * seeing this can execute the same transfer or escrow twice — reconcile by
 * `txHash` (poll getTx / re-derive state) before ever retrying.
 */
export class TxPendingError extends Error {
  constructor(
    message: string,
    /** The broadcast transaction's hash — the reconciliation handle. */
    public readonly txHash: string,
    /** The RPC endpoint the transaction was submitted to. */
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'TxPendingError';
  }
}

/**
 * cosmjs throws its TimeoutError for exactly the pending case above. The
 * instanceof check is primary; the name/message fallback covers a second
 * @cosmjs/stargate instance in a dependency tree (npm can install one for a
 * consumer and another for this package, and instanceof does not cross them).
 */
function isBroadcastTimeout(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /was submitted but was not yet found/i.test(error.message))
  );
}

/** One attribute of one event from a delivered transaction. */
export function eventAttr(
  events: readonly { type: string; attributes: readonly { key: string; value: string }[] }[],
  type: string,
  key: string,
): string | undefined {
  for (const event of events) {
    if (event.type !== type) continue;
    const attr = event.attributes.find((a) => a.key === key);
    if (attr) return attr.value;
  }
  return undefined;
}

/** All events of one type, as attribute maps (some types fire more than once). */
export function eventsOfType(
  events: readonly { type: string; attributes: readonly { key: string; value: string }[] }[],
  type: string,
): Record<string, string>[] {
  return events
    .filter((e) => e.type === type)
    .map((e) => Object.fromEntries(e.attributes.map((a) => [a.key, a.value])));
}

export class TimeflareTxClient {
  private constructor(
    private readonly client: SigningStargateClient,
    public readonly address: string,
    /** The RPC endpoint connected to — named in pending-broadcast errors. */
    private readonly endpoint: string,
    /**
     * Gas price in tenths of a uveil, at or above the consensus floor. Raise it
     * to buy mempool priority; the ante chain only ever rejects paying LESS, so
     * a higher price can never make a transaction invalid. Whatever a caller
     * quotes with (creationQuote's gasPriceTenths) must match what it signs
     * with, or the user is shown a number they do not pay.
     */
    public readonly gasPriceTenths: number = MIN_GAS_PRICE_TENTHS,
  ) {}

  static async connect(
    rpcEndpoint: string,
    signer: OfflineSigner,
    opts?: {
      gasPriceTenths?: number;
      /**
       * When set, the node's self-reported chain-id must match or the connect
       * throws before anything can be signed. cosmjs signs with whatever id
       * the node reports, so without this an endpoint typo means silently
       * signing for the wrong network.
       */
      expectedChainId?: string;
    },
  ): Promise<TimeflareTxClient> {
    const [account] = await signer.getAccounts();
    const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, signer, {
      registry: timeflareRegistry(),
      gasPrice: GasPrice.fromString(DEFAULT_GAS_PRICE),
    });
    if (opts?.expectedChainId !== undefined) {
      const reported = await client.getChainId();
      if (reported !== opts.expectedChainId) {
        client.disconnect();
        throw new TxError(
          `node at ${rpcEndpoint} reports chain-id "${reported}" but ` +
            `"${opts.expectedChainId}" was expected — refusing to sign for a different network`,
        );
      }
    }
    return new TimeflareTxClient(
      client,
      account.address,
      rpcEndpoint,
      Math.max(MIN_GAS_PRICE_TENTHS, Math.floor(opts?.gasPriceTenths ?? MIN_GAS_PRICE_TENTHS)),
    );
  }

  disconnect(): void {
    this.client.disconnect();
  }

  private async broadcast(
    msg: EncodeObject,
    fee: { amount: readonly { denom: string; amount: string }[]; gas: string },
    memo: string,
  ): Promise<DeliverTxResponse> {
    let result: DeliverTxResponse;
    try {
      result = await this.client.signAndBroadcast(
        this.address,
        [msg],
        { amount: [...fee.amount], gas: fee.gas },
        memo,
      );
    } catch (error) {
      if (isBroadcastTimeout(error)) {
        const txHash = (error as { txId?: string }).txId ?? '';
        throw new TxPendingError(
          `${msg.typeUrl} passed CheckTx on ${this.endpoint} but was not observed in a block ` +
            `within the polling window (tx ${txHash}). The transaction MAY still land — ` +
            `reconcile by hash before retrying; re-signing can execute it twice.`,
          txHash,
          this.endpoint,
        );
      }
      throw error;
    }
    if (result.code !== 0) {
      throw new TxError(
        `${msg.typeUrl} failed on-chain (code ${result.code}): ${result.rawLog}`,
        result.code,
        result.rawLog,
      );
    }
    return result;
  }

  /**
   * Move VEIL between wallet accounts — a plain bank send, deliberately the
   * dullest verb here.
   *
   * `to` must be a `tmflr1…` account address. It is NOT a `tfid…` identity key:
   * those are X25519 recipient keys for addressing secrets and cannot hold
   * funds. Callers are expected to have rejected that confusion already, with
   * copy that names it (send-VEIL plan §3); this method only reports the chain's
   * own refusal.
   *
   * The amount is uveil as a bigint — the caller never rounds through a float,
   * because at large balances that silently loses precision.
   */
  async sendVeil(params: { to: string; amountUveil: bigint; memo?: string }): Promise<{
    txHash: string;
    height: number;
  }> {
    if (params.amountUveil <= 0n) {
      throw new TxError(`send amount must be positive (got ${params.amountUveil} ${DENOM})`);
    }
    const result = await this.broadcast(
      {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: this.address,
          toAddress: params.to,
          amount: [{ denom: DENOM, amount: params.amountUveil.toString() }],
        },
      },
      feeForGas(SEND_GAS, this.gasPriceTenths),
      params.memo ?? '',
    );
    return { txHash: result.transactionHash, height: result.height };
  }

  /**
   * Phase 1 — MsgUserRequestGuardians. The secret ID and the assigned guardian
   * set (with encryption keys) are protocol-assigned and decoded back from
   * the MsgUserRequestGuardiansResponse; guardian selection is fully
   * protocol-controlled (the client supplies no selection input). The
   * assignments exist only in this response until Phase 2 lands, so the
   * caller must retain them — they cannot be re-queried from chain state.
   */
  async requestGuardians(params: {
    detectionHint: { version: number; ephemeralPub: Uint8Array; tag: Uint8Array };
    /** Blocks from now until reveals may open. The window's length is derived from it. */
    revealStartOffset: number;
    threshold: number;
    /** Band floor: minimum acceptances for the secret to activate (threshold ≤ min). */
    minShares: number;
    /** Band ceiling: candidates selected and shares distributed (min ≤ max ≤ 32, max − min < threshold). */
    maxShares: number;
    /** Security factor in hundredths (100–1000 = 1.00–10.00). */
    bump: number;
  }): Promise<{
    secretId: string;
    guardianAssignments: GuardianInfo[];
    height: number;
    txHash: string;
    result: DeliverTxResponse;
  }> {
    const violations = dialErrors({
      threshold: params.threshold,
      minShares: params.minShares,
      maxShares: params.maxShares,
      bumpHundredths: params.bump,
      revealStartOffsetBlocks: params.revealStartOffset,
    });
    if (violations.length > 0) {
      throw new TxValidationError(
        `phase 1 would be rejected by the chain: ${violations.join('; ')}`,
        violations,
      );
    }

    const msg: EncodeObject = {
      typeUrl: TYPE_URLS.requestGuardians,
      value: MsgUserRequestGuardians.fromPartial({
        creator: this.address,
        detectionHint: params.detectionHint,
        revealStartOffset: params.revealStartOffset,
        threshold: params.threshold,
        minShares: params.minShares,
        maxShares: params.maxShares,
        bump: params.bump,
      }),
    };
    const result = await this.broadcast(
      msg,
      feeForGas(requestGuardiansGas(params.maxShares), this.gasPriceTenths),
      'timeflare phase 1',
    );
    const responseAny = result.msgResponses.find(
      (r) => r.typeUrl === `${TYPE_URLS.requestGuardians}Response`,
    );
    if (!responseAny) {
      throw new TxError('no MsgUserRequestGuardiansResponse in the phase-1 transaction');
    }
    const response = MsgUserRequestGuardiansResponse.decode(responseAny.value);
    if (!response.secretId) {
      throw new TxError('phase-1 response carried no secret id');
    }
    // Cross-check against the emitted event (both are consensus outputs)
    const eventSecretId = eventAttr(result.events, 'secret_reserved', 'secret_id');
    if (eventSecretId && eventSecretId !== response.secretId) {
      throw new TxError(
        `secret id mismatch: response ${response.secretId} vs event ${eventSecretId}`,
      );
    }
    return {
      secretId: response.secretId,
      guardianAssignments: response.guardianAssignments,
      height: result.height,
      txHash: result.transactionHash,
      result,
    };
  }

  /** Phase 2 — MsgUserDistributeShares: ciphertext, pk_s, commitment + key shares. */
  async distributeShares(params: {
    secretId: string;
    shares: { guardianAddress: string; encryptedShare: Uint8Array; shareHmac: Uint8Array }[];
    secretCommitment: Uint8Array;
    payloadCiphertext: Uint8Array;
    secretPublicKey: Uint8Array;
  }): Promise<DeliverTxResponse> {
    const violations: string[] = [];
    if (params.shares.length === 0) {
      violations.push('shares array cannot be empty');
    }
    if (params.shares.length > MAX_TOTAL_SHARES) {
      violations.push(
        `shares (${params.shares.length}) must not exceed the band ceiling ${MAX_TOTAL_SHARES}`,
      );
    }
    const addresses = new Set(params.shares.map((s) => s.guardianAddress));
    if (addresses.size !== params.shares.length) {
      violations.push('duplicate guardian in shares — each assignment carries exactly one share');
    }
    if (params.payloadCiphertext.length === 0) {
      violations.push('payload ciphertext cannot be empty');
    }
    if (params.payloadCiphertext.length > MAX_PAYLOAD_CIPHERTEXT_BYTES) {
      violations.push(
        `payload ciphertext too large, maximum ${MAX_PAYLOAD_CIPHERTEXT_BYTES} bytes, ` +
          `got ${params.payloadCiphertext.length}`,
      );
    }
    if (params.secretCommitment.length === 0) {
      violations.push('secret commitment cannot be empty');
    }
    if (params.secretPublicKey.length !== SECRET_PUBLIC_KEY_BYTES) {
      violations.push(
        `secret public key must be exactly ${SECRET_PUBLIC_KEY_BYTES} bytes, ` +
          `got ${params.secretPublicKey.length}`,
      );
    }
    if (violations.length > 0) {
      throw new TxValidationError(
        `phase 2 would be rejected by the chain: ${violations.join('; ')}`,
        violations,
      );
    }

    const msg: EncodeObject = {
      typeUrl: TYPE_URLS.distributeShares,
      value: MsgUserDistributeShares.fromPartial({
        creator: this.address,
        secretId: params.secretId,
        shares: params.shares,
        secretCommitment: params.secretCommitment,
        payloadCiphertext: params.payloadCiphertext,
        secretPublicKey: params.secretPublicKey,
      }),
    };
    // Gas sized to the work this call actually does — one envelope per share
    // plus the payload stored once — not to a flat worst case.
    return this.broadcast(
      msg,
      feeForGas(
        distributeSharesGas(params.shares.length, params.payloadCiphertext.length),
        this.gasPriceTenths,
      ),
      'timeflare phase 2',
    );
  }

  /**
   * Cancel a pending secret (pre-window; pro-rata wages + creator remainder).
   *
   * `activeGuardians` sizes the gas: the handler pays a wage to and returns a
   * bond for every guardian that accepted, so the cost scales with them. Omit
   * it and the worst case is declared, which is safe but can be ten times the
   * fee a small band actually needs.
   */
  async cancelSecret(
    secretId: string,
    opts?: { activeGuardians?: number },
  ): Promise<DeliverTxResponse> {
    const msg: EncodeObject = {
      typeUrl: TYPE_URLS.cancelSecret,
      value: MsgUserCancelSecret.fromPartial({ secretId, creator: this.address }),
    };
    return this.broadcast(
      msg,
      feeForGas(cancelSecretGas(opts?.activeGuardians), this.gasPriceTenths),
      'timeflare cancel',
    );
  }

  /**
   * Step 1 of collecting a rebate: publish the commitment binding the
   * recipiency proof to this signer, WITHOUT revealing the proof.
   *
   * The proof is a bearer secret — once it is in a transaction anyone can read
   * it — so the reveal (step 2) must be preceded by this, in a strictly earlier
   * block. An observer who lifts the proof out of the mempool has no commitment
   * for it and cannot backdate one.
   */
  async commitRebate(params: {
    secretId: string;
    commitment: Uint8Array;
  }): Promise<DeliverTxResponse> {
    const msg: EncodeObject = {
      typeUrl: TYPE_URLS.commitRebate,
      value: MsgRecipientCommitRebate.fromPartial({
        recipient: this.address,
        secretId: params.secretId,
        commitment: params.commitment,
      }),
    };
    return this.broadcast(
      msg,
      feeForGas(commitRebateGas(), this.gasPriceTenths),
      'timeflare rebate commit',
    );
  }

  /**
   * Step 2: reveal the recipiency proof and collect the rebate. Must land in a
   * later block than the commitment, and pays this signer.
   */
  async collectRebate(params: { secretId: string; proof: Uint8Array }): Promise<DeliverTxResponse> {
    const msg: EncodeObject = {
      typeUrl: TYPE_URLS.collectRebate,
      value: MsgRecipientCollectRebate.fromPartial({
        recipient: this.address,
        secretId: params.secretId,
        z: params.proof,
      }),
    };
    return this.broadcast(
      msg,
      feeForGas(collectRebateGas(), this.gasPriceTenths),
      'timeflare rebate collect',
    );
  }
}
