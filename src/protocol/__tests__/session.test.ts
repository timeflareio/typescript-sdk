/**
 * Commit-session reconciliation: the relaunch decision logic against a
 * stubbed chain — chain truth wins, every path deterministic. The live-chain
 * behaviour of the same logic is exercised by the e2e resume suite.
 */
import { Secret } from '../../generated/timeflare/secrets/v1/secret';
import { TimeflareRestClient } from '../rest';
import {
  CommitSessionState,
  MemorySessionStore,
  reconcileSession,
} from '../session';

function fakeRest(secret: Partial<Secret> | null, height = 100): TimeflareRestClient {
  return {
    secretMeta: async () => (secret ? (secret as Secret) : null),
    height: async () => height,
  } as unknown as TimeflareRestClient;
}

function sessionState(overrides: Partial<CommitSessionState> = {}): CommitSessionState {
  return {
    version: 2,
    creator: 'tmflr1creator',
    payloadB64: Buffer.from('payload').toString('base64'),
    recipientPublicKeyB64: Buffer.alloc(32).toString('base64'),
    params: {
      threshold: 3,
      minShares: 5,
      maxShares: 7,
      bump: 100,
      revealStartOffset: 150,
    },
    ...overrides,
  };
}

describe('reconcileSession — chain truth wins on every resume', () => {
  test('no phase 1 yet → start', async () => {
    const result = await reconcileSession(sessionState(), fakeRest(null));
    expect(result.action).toBe('start');
    expect(result.chainState).toBeNull();
  });

  test('persisted id but nothing on chain (phase 1 never landed) → start', async () => {
    const result = await reconcileSession(sessionState({ secretId: 'gone' }), fakeRest(null));
    expect(result.action).toBe('start');
  });

  test('reserved with the window open → resume-distribute with blocks remaining', async () => {
    const result = await reconcileSession(
      sessionState({ secretId: 's1', commitDeadline: 160 }),
      fakeRest({ state: 'reserved', commitDeadline: 160 }, 120),
    );
    expect(result.action).toBe('resume-distribute');
    expect(result.blocksRemaining).toBe(40);
  });

  test('awaiting_acceptance (killed after phase 2) → await-acceptance', async () => {
    const result = await reconcileSession(
      sessionState({ secretId: 's1', distributed: true }),
      fakeRest({ state: 'awaiting_acceptance' }),
    );
    expect(result.action).toBe('await-acceptance');
  });

  test.each(['pending', 'reconstructable', 'revealed'])(
    'duplicate resume after success (%s) → complete, no re-send',
    async (state) => {
      const result = await reconcileSession(
        sessionState({ secretId: 's1', distributed: true }),
        fakeRest({ state }),
      );
      expect(result.action).toBe('complete');
      expect(result.chainState).toBe(state);
    },
  );

  test('deadline passed, chain auto-failed → failed-commit-timeout', async () => {
    const result = await reconcileSession(
      sessionState({ secretId: 's1' }),
      fakeRest({ state: 'failed' }),
    );
    expect(result.action).toBe('failed-commit-timeout');
  });

  test('cancelled elsewhere → cancelled', async () => {
    const result = await reconcileSession(
      sessionState({ secretId: 's1' }),
      fakeRest({ state: 'cancelled' }),
    );
    expect(result.action).toBe('cancelled');
  });

  test('unknown state fails loudly (never guesses)', async () => {
    await expect(
      reconcileSession(sessionState({ secretId: 's1' }), fakeRest({ state: 'quantum' })),
    ).rejects.toThrow(/update your client/);
  });
});

describe('MemorySessionStore', () => {
  test('save/load round-trips deep copies', () => {
    const store = new MemorySessionStore();
    const state = sessionState({ secretId: 'abc' });
    store.save(state);
    state.secretId = 'mutated-after-save';
    expect(store.load()?.secretId).toBe('abc');
    store.clear();
    expect(store.load()).toBeNull();
  });
});
