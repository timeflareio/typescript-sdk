/**
 * Broadcast-path error semantics: an ambiguous broadcast (accepted by CheckTx,
 * not yet observed in a block) must surface as TxPendingError — a distinct
 * type a caller reconciles by hash, never a failure it blindly retries — and
 * a node reporting an unexpected chain-id must be refused before anything can
 * be signed.
 *
 * Both paths are driven through instances whose cosmjs client is stubbed, so
 * no connection or signer is needed.
 */

import { SigningStargateClient, TimeoutError } from '@cosmjs/stargate';

import { TimeflareTxClient, TxError, TxPendingError } from '../txclient';

const ENDPOINT = 'http://localhost:26657';

/** An instance wired to a stubbed cosmjs client — validation and broadcast run for real. */
function clientWith(signAndBroadcast: (...args: unknown[]) => Promise<unknown>): TimeflareTxClient {
  const instance = Object.create(TimeflareTxClient.prototype) as TimeflareTxClient;
  Object.assign(instance, {
    client: { signAndBroadcast },
    address: 'tmflr1sender',
    endpoint: ENDPOINT,
    gasPriceTenths: 1,
  });
  return instance;
}

const SEND = { to: 'tmflr1recipient', amountUveil: 1n };

describe('broadcast pending-inclusion handling', () => {
  test("cosmjs's TimeoutError becomes TxPendingError carrying the hash and endpoint", async () => {
    const tx = clientWith(async () => {
      throw new TimeoutError('Transaction with ID ABC123 was submitted but was not yet found on the chain. You might want to check later.', 'ABC123');
    });
    const err = (await tx.sendVeil(SEND).catch((e: unknown) => e)) as TxPendingError;
    expect(err).toBeInstanceOf(TxPendingError);
    expect(err.txHash).toBe('ABC123');
    expect(err.endpoint).toBe(ENDPOINT);
    // The message must warn, not merely report: this outcome invites a retry.
    expect(err.message).toMatch(/MAY still land/);
    expect(err.message).toContain('ABC123');
    expect(err.message).toContain(ENDPOINT);
  });

  test('a cross-realm TimeoutError is caught by its message, not only instanceof', async () => {
    // A duplicated @cosmjs/stargate in a consumer's tree throws an error that
    // is NOT instanceof this package's TimeoutError — only the wording and
    // the txId property survive the realm boundary.
    const foreign = new Error(
      'Transaction with ID DEADBEEF was submitted but was not yet found on the chain. You might want to check later.',
    );
    (foreign as Error & { txId: string }).txId = 'DEADBEEF';
    const tx = clientWith(async () => {
      throw foreign;
    });
    const err = (await tx.sendVeil(SEND).catch((e: unknown) => e)) as TxPendingError;
    expect(err).toBeInstanceOf(TxPendingError);
    expect(err.txHash).toBe('DEADBEEF');
  });

  test('an on-chain rejection still throws TxError, never TxPendingError', async () => {
    const tx = clientWith(async () => ({
      code: 5,
      rawLog: 'insufficient fee',
      transactionHash: 'FEE125',
      height: 10,
      events: [],
      msgResponses: [],
    }));
    const err = (await tx.sendVeil(SEND).catch((e: unknown) => e)) as TxError;
    expect(err).toBeInstanceOf(TxError);
    expect(err).not.toBeInstanceOf(TxPendingError);
    expect(err.code).toBe(5);
  });

  test('other broadcast rejections pass through unchanged', async () => {
    const tx = clientWith(async () => {
      throw new Error('connection refused');
    });
    const err = (await tx.sendVeil(SEND).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(TxPendingError);
    expect(err.message).toBe('connection refused');
  });
});

describe('connect chain-id assertion', () => {
  const signer = {
    getAccounts: async () => [{ address: 'tmflr1sender' }],
  } as unknown as Parameters<typeof TimeflareTxClient.connect>[1];

  afterEach(() => jest.restoreAllMocks());

  function stubConnect(chainId: string) {
    const disconnect = jest.fn();
    const getChainId = jest.fn(async () => chainId);
    jest
      .spyOn(SigningStargateClient, 'connectWithSigner')
      .mockResolvedValue({ getChainId, disconnect } as unknown as SigningStargateClient);
    return { disconnect, getChainId };
  }

  test('a mismatching node is refused, naming both ids, and disconnected', async () => {
    const { disconnect } = stubConnect('othernet-1');
    const err = (await TimeflareTxClient.connect(ENDPOINT, signer, {
      expectedChainId: 'timeflare-1',
    }).catch((e: unknown) => e)) as TxError;
    expect(err).toBeInstanceOf(TxError);
    expect(err.message).toContain('othernet-1');
    expect(err.message).toContain('timeflare-1');
    expect(disconnect).toHaveBeenCalled();
  });

  test('a matching node connects normally', async () => {
    stubConnect('timeflare-1');
    const tx = await TimeflareTxClient.connect(ENDPOINT, signer, {
      expectedChainId: 'timeflare-1',
    });
    expect(tx.address).toBe('tmflr1sender');
  });

  test('without expectedChainId the node id is not consulted', async () => {
    const { getChainId } = stubConnect('anything');
    await TimeflareTxClient.connect(ENDPOINT, signer);
    expect(getChainId).not.toHaveBeenCalled();
  });
});
