/**
 * Pins that the transaction path REFUSES input the chain would reject, rather
 * than broadcasting it and letting the user pay for the rejection.
 *
 * The guard runs before any network access, so these tests drive the real
 * methods on a bare prototype instance — no connection, no signer. If a guard
 * ever moved below the first `await` on the client, the corresponding test
 * would fail with a connection error instead of a TxValidationError, which is
 * the signal we want.
 */

import { TimeflareTxClient, TxValidationError } from '../txclient';
import { MAX_PAYLOAD_CIPHERTEXT_BYTES, SECRET_PUBLIC_KEY_BYTES } from '../constants';

/** An instance whose validation runs but whose client is never reached. */
function client(): TimeflareTxClient {
  return Object.create(TimeflareTxClient.prototype) as TimeflareTxClient;
}

const HINT = {
  version: 1,
  ephemeralPub: new Uint8Array(32).fill(0x42),
  tag: new Uint8Array(8).fill(0x07),
};

const LEGAL_PHASE1 = {
  detectionHint: HINT,
  revealWindow: { startOffset: 432_000, duration: 300 },
  threshold: 3,
  minShares: 5,
  maxShares: 7,
  bump: 100,
};

const LEGAL_PHASE2 = {
  secretId: 'a1b2c3d4-0000-5000-8000-000000000000',
  shares: [
    {
      guardianAddress: 'tmflr1aaa',
      encryptedShare: new Uint8Array(94),
      shareHmac: new Uint8Array(32),
    },
  ],
  secretCommitment: new Uint8Array(32).fill(1),
  payloadCiphertext: new Uint8Array(128).fill(2),
  secretPublicKey: new Uint8Array(SECRET_PUBLIC_KEY_BYTES).fill(3),
};

describe('requestGuardians refuses what the chain would reject', () => {
  const cases: [string, Partial<typeof LEGAL_PHASE1>][] = [
    ['threshold below the floor', { threshold: 1, minShares: 2, maxShares: 2 }],
    ['threshold above the ceiling', { threshold: 17, minShares: 17, maxShares: 17 }],
    ['min_shares below threshold', { threshold: 5, minShares: 4, maxShares: 6 }],
    ['max_shares below min_shares', { minShares: 7, maxShares: 5 }],
    ['max_shares past the absolute ceiling', { threshold: 4, minShares: 32, maxShares: 33 }],
    ['band width equal to the threshold', { threshold: 3, minShares: 5, maxShares: 8 }],
    ['bump below the floor', { bump: 99 }],
    ['bump above the ceiling', { bump: 1001 }],
    [
      'reveal offset below the fixed floor',
      { revealWindow: { startOffset: 99, duration: 100 } },
    ],
    ['reveal duration too short', { revealWindow: { startOffset: 432_000, duration: 99 } }],
    ['reveal duration too long', { revealWindow: { startOffset: 432_000, duration: 14_401 } }],
    ['window past the horizon', { revealWindow: { startOffset: 5_255_901, duration: 100 } }],
  ];

  test.each(cases)('%s', async (_name, override) => {
    await expect(
      client().requestGuardians({ ...LEGAL_PHASE1, ...override }),
    ).rejects.toBeInstanceOf(TxValidationError);
  });

  it('reports every violation, not just the first', async () => {
    const err: unknown = await client()
      .requestGuardians({
        ...LEGAL_PHASE1,
        bump: 5,
        revealWindow: { startOffset: 99, duration: 100 },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxValidationError);
    expect((err as TxValidationError).violations.length).toBeGreaterThanOrEqual(2);
  });

  it('lets a legal draft through to the transport', async () => {
    // No client is wired, so a legal draft must fail on the BROADCAST rather
    // than on validation — proving the guard is not over-refusing.
    const err = await client()
      .requestGuardians(LEGAL_PHASE1)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TxValidationError);
  });
});

describe('distributeShares refuses what the chain would reject', () => {
  const cases: [string, Partial<typeof LEGAL_PHASE2>][] = [
    ['no shares', { shares: [] }],
    [
      'duplicate guardian',
      {
        shares: [
          {
            guardianAddress: 'tmflr1dup',
            encryptedShare: new Uint8Array(94),
            shareHmac: new Uint8Array(32),
          },
          {
            guardianAddress: 'tmflr1dup',
            encryptedShare: new Uint8Array(94),
            shareHmac: new Uint8Array(32),
          },
        ],
      },
    ],
    ['empty payload', { payloadCiphertext: new Uint8Array(0) }],
    [
      'payload over the cap',
      { payloadCiphertext: new Uint8Array(MAX_PAYLOAD_CIPHERTEXT_BYTES + 1) },
    ],
    ['empty commitment', { secretCommitment: new Uint8Array(0) }],
    ['wrong-width secret public key', { secretPublicKey: new Uint8Array(31) }],
  ];

  test.each(cases)('%s', async (_name, override) => {
    await expect(
      client().distributeShares({ ...LEGAL_PHASE2, ...override }),
    ).rejects.toBeInstanceOf(TxValidationError);
  });

  it('lets a legal distribution through to the transport', async () => {
    const err = await client()
      .distributeShares(LEGAL_PHASE2)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TxValidationError);
  });
});
