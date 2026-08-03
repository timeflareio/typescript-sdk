/**
 * REST decode path: the gateway emits proto (snake_case) field names with
 * base64 bytes and stringified int64s; `camelise` + ts-proto fromJSON must
 * decode both that and camelCase JSON identically.
 *
 * Transport behaviour rides here too: the per-request deadline, the
 * transport/HTTP error split, and store-key pagination — all against a
 * stubbed global fetch, no node needed.
 */
import { camelise, DEFAULT_REST_TIMEOUT_MS, RestError, TimeflareRestClient } from '../rest';
import { QuerySecretResponse } from '../../generated/timeflare/secrets/v1/query';

const SNAKE_BODY = {
  secret: {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    creator: 'tmflr1creator',
    reveal_start_block: '180',
    reveal_end_block: '280',
    threshold: 3,
    secret_commitment: Buffer.alloc(32, 7).toString('base64'),
    commit_deadline: '160',
    state: 'pending',
    active_assignments: ['tmflr1g1', 'tmflr1g2'],
    reward_pool: { denom: 'uveil', amount: '90000' },
    created_at: '100',
    min_shares: '5',
    max_shares: '7',
    bump: '100',
    guardian_bond_amounts: ['52000', '52000'],
    detection_hint: {
      version: 1,
      ephemeral_pub: Buffer.alloc(32, 1).toString('base64'),
      tag: Buffer.alloc(8, 2).toString('base64'),
    },
  },
};

describe('camelise + ts-proto fromJSON', () => {
  test('decodes gateway snake_case JSON', () => {
    const decoded = QuerySecretResponse.fromJSON(camelise(SNAKE_BODY)).secret!;
    expect(decoded.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(decoded.revealStartBlock).toBe(180);
    expect(decoded.commitDeadline).toBe(160);
    expect(decoded.state).toBe('pending');
    expect(decoded.rewardPool?.amount).toBe('90000');
    expect(decoded.guardianBondAmounts).toEqual([52000, 52000]);
    expect(decoded.secretCommitment).toEqual(new Uint8Array(32).fill(7));
    expect(decoded.detectionHint?.tag).toEqual(new Uint8Array(8).fill(2));
    expect(decoded.activeAssignments).toEqual(['tmflr1g1', 'tmflr1g2']);
  });

  test('camelCase JSON passes through unchanged', () => {
    const already = camelise({ revealStartBlock: '180', rewardPool: { amount: '1' } }) as any;
    expect(already.revealStartBlock).toBe('180');
    expect(already.rewardPool.amount).toBe('1');
  });

  test('arrays and scalars survive deep conversion', () => {
    expect(camelise([{ a_b: [1, 'x', null] }])).toEqual([{ aB: [1, 'x', null] }]);
    expect(camelise('leave_me')).toBe('leave_me');
  });
});

/** One canned page: what the stubbed gateway answers, in gateway JSON. */
interface StubPage {
  status?: number;
  body: unknown;
}

/** Replace global fetch with a page-per-call stub, recording every request URL. */
function stubFetch(pages: StubPage[]): { urls: string[] } {
  const urls: string[] = [];
  let call = 0;
  global.fetch = (async (url: string) => {
    urls.push(url);
    const page = pages[Math.min(call++, pages.length - 1)];
    const status = page.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(page.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { urls };
}

describe('TimeflareRestClient transport behaviour', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('a hung request is aborted at the deadline, named as a timeout', async () => {
    // A fetch that only ever settles when its signal aborts — the black-holed
    // connection the deadline exists for.
    global.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () =>
          reject(new Error('request aborted')),
        );
      })) as unknown as typeof fetch;
    const client = new TimeflareRestClient('http://node:1317', { timeoutMs: 25 });
    const err = (await client.height().catch((e: unknown) => e)) as RestError;
    expect(err).toBeInstanceOf(RestError);
    expect(err.message).toMatch(/timed out after 25ms/);
    expect(err.message).toContain('/cosmos/base/tendermint/v1beta1/blocks/latest');
    expect(err.httpStatus).toBeUndefined();
    expect(err.isTransport).toBe(true);
  });

  test('a rejected fetch classifies as transport, with no HTTP status', async () => {
    global.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const client = new TimeflareRestClient('http://node:1317');
    const err = (await client.height().catch((e: unknown) => e)) as RestError;
    expect(err).toBeInstanceOf(RestError);
    expect(err.httpStatus).toBeUndefined();
    expect(err.isTransport).toBe(true);
  });

  test('a node-side error is NOT transport — the endpoint answered', async () => {
    stubFetch([{ status: 500, body: { code: 13, message: 'panic in handler' } }]);
    const client = new TimeflareRestClient('http://node:1317');
    const err = (await client.height().catch((e: unknown) => e)) as RestError;
    expect(err).toBeInstanceOf(RestError);
    expect(err.httpStatus).toBe(500);
    expect(err.grpcCode).toBe(13);
    expect(err.isTransport).toBe(false);
  });

  test('the single-argument constructor keeps the default deadline', () => {
    expect(DEFAULT_REST_TIMEOUT_MS).toBe(10_000);
    expect(() => new TimeflareRestClient('http://node:1317')).not.toThrow();
  });

  test('secretsByCreator follows pagination.next_key to exhaustion', async () => {
    const nextKey = Buffer.from('page-two').toString('base64');
    const { urls } = stubFetch([
      { body: { secrets: [{ id: 's1' }], pagination: { next_key: nextKey } } },
      { body: { secrets: [{ id: 's2' }], pagination: { next_key: '' } } },
    ]);
    const client = new TimeflareRestClient('http://node:1317');
    const secrets = await client.secretsByCreator('tmflr1creator', 1);
    expect(secrets.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('pagination.limit=1');
    expect(urls[0]).not.toContain('pagination.key');
    expect(urls[1]).toContain(`pagination.key=${encodeURIComponent(nextKey)}`);
  });

  test('hintsSince surfaces the page key and passes it back verbatim', async () => {
    const nextKey = Buffer.from('dense-height').toString('base64');
    const { urls } = stubFetch([
      {
        body: {
          hints: [{ secret_id: 'a', created_at: '100' }],
          pagination: { next_key: nextKey },
        },
      },
      {
        body: {
          hints: [{ secret_id: 'b', created_at: '100' }],
          pagination: { next_key: '' },
        },
      },
    ]);
    const client = new TimeflareRestClient('http://node:1317');
    const first = await client.hintsSince(50, 1);
    expect(first.hints.map((h) => h.secretId)).toEqual(['a']);
    expect(first.nextKey).toEqual(new Uint8Array(Buffer.from('dense-height')));

    const second = await client.hintsSince(50, 1, first.nextKey);
    expect(second.hints.map((h) => h.secretId)).toEqual(['b']);
    expect(second.nextKey).toBeUndefined();

    // The height in the path never moves while paging — only the key does.
    expect(urls[0]).toContain('/hints/50?');
    expect(urls[1]).toContain('/hints/50?');
    expect(urls[1]).toContain(`pagination.key=${encodeURIComponent(nextKey)}`);
  });
});

describe('blockHeader — header via RPC, whole block only as fallback', () => {
  const REST = 'http://node:1317';
  const RPC = 'http://node:26657';
  const TIME = '2026-08-03T09:16:57.123456789Z';

  /** Records every URL fetched, answering per a handler map. */
  function stubFetch(handler: (url: string) => { status?: number; body: string }) {
    const calls: string[] = [];
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      const { status = 200, body } = handler(String(url));
      return { ok: status < 400, status, text: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  const rpcHeader = (height: number) =>
    JSON.stringify({ jsonrpc: '2.0', result: { header: { height: String(height), time: TIME } } });
  const restBlock = (height: number) =>
    JSON.stringify({ block: { header: { height: String(height), time: TIME } } });

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('reads the header from RPC and never touches the block route', async () => {
    const calls = stubFetch(() => ({ body: rpcHeader(500) }));
    const client = new TimeflareRestClient(REST, { rpcUrl: RPC });
    expect(await client.blockHeader(500)).toEqual({ height: 500, timeMs: Date.parse(TIME) });
    expect(calls).toEqual([`${RPC}/header?height=500`]);
    // The 89 KB-per-call route the RPC exists to avoid.
    expect(calls.some((c) => c.includes('/blocks/'))).toBe(false);
  });

  test('latest omits the height parameter', async () => {
    const calls = stubFetch(() => ({ body: rpcHeader(900) }));
    const client = new TimeflareRestClient(REST, { rpcUrl: RPC });
    expect((await client.blockHeader()).height).toBe(900);
    expect(calls).toEqual([`${RPC}/header`]);
  });

  test('height() rides the same cheap path', async () => {
    const calls = stubFetch(() => ({ body: rpcHeader(1234) }));
    const client = new TimeflareRestClient(REST, { rpcUrl: RPC });
    expect(await client.height()).toBe(1234);
    expect(calls).toEqual([`${RPC}/header`]);
  });

  test('no rpcUrl configured falls straight to REST', async () => {
    const calls = stubFetch(() => ({ body: restBlock(700) }));
    const client = new TimeflareRestClient(REST);
    expect((await client.blockHeader(700)).height).toBe(700);
    expect(calls).toEqual([`${REST}/cosmos/base/tendermint/v1beta1/blocks/700`]);
  });

  test('an unexposed RPC falls back to REST, and stops retrying it', async () => {
    const calls = stubFetch((url) =>
      url.startsWith(RPC) ? { status: 404, body: 'not found' } : { body: restBlock(800) },
    );
    const client = new TimeflareRestClient(REST, { rpcUrl: RPC });
    expect((await client.blockHeader(800)).height).toBe(800);
    await client.blockHeader(801);
    // One probe of the dead RPC, then REST only — not a doubled request count
    // for the rest of the session.
    expect(calls.filter((c) => c.startsWith(RPC))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/blocks/'))).toHaveLength(2);
  });

  test("a load balancer's error envelope is not the node talking", async () => {
    // Observed against a public rotating proxy: `{"error": "<string>"}` with no
    // `jsonrpc` field. Reading that as CometBFT's "height pruned" would report
    // a healthy chain's block missing and halt the anchor ladder, so it counts
    // as the RPC being unusable and REST answers instead.
    const calls = stubFetch((url) =>
      url.startsWith(RPC)
        ? { status: 200, body: JSON.stringify({ error: 'failed relay, insufficient results' }) }
        : { body: restBlock(4242) },
    );
    const client = new TimeflareRestClient(REST, { rpcUrl: RPC });
    expect((await client.blockHeader(4242)).height).toBe(4242);
    expect(calls.some((c) => c.includes('/blocks/4242'))).toBe(true);
  });

  test('a pruned height throws rather than pay for a doomed REST retry', async () => {
    const calls = stubFetch(() => ({
      status: 500,
      body: JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, data: 'height 100 is not available, lowest height is 31679000' },
      }),
    }));
    const client = new TimeflareRestClient(REST, { rpcUrl: RPC });
    await expect(client.blockHeader(100)).rejects.toThrow(/not available/);
    // The node answered authoritatively; REST would only say the same thing.
    expect(calls.some((c) => c.includes('/blocks/'))).toBe(false);
  });
});
