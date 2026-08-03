/**
 * Pins the declared gas model against the measured devnet sweep.
 *
 * The failure this guards is specific and expensive: Cosmos charges the
 * DECLARED gas limit, and a transaction that declares less than it consumes
 * aborts. For phase 2 that abort leaves the creator having already paid the
 * non-refundable creation fee in phase 1. So "the model must never declare
 * less than reality" is the property, and it has to hold across the whole
 * band, not at the sizes someone happened to try.
 *
 * Both provisional guesses that preceded these measurements were wrong, in
 * opposite directions — a flat phase 1 was insufficient above fifteen
 * guardians, and a first-pass phase-2 model fell short at the ceiling. Neither
 * would have been caught by a test that only checked the arithmetic.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  cancelSecretGas,
  distributeSharesGas,
  MAX_PAYLOAD_CIPHERTEXT_BYTES,
  MAX_TOTAL_SHARES,
  requestGuardiansGas,
} from '../constants';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'tx_gas.json');

interface GasCorpus {
  cancel_secret: { active_guardians: number; gas_used: number }[];
  fit: {
    request_guardians: { base: number; per_share: number };
    distribute_shares: { base: number; per_share: number; per_byte: number };
  };
  request_guardians: { max_shares: number; gas_used: number }[];
  distribute_shares: { max_shares: number; ciphertext_bytes: number; gas_used: number }[];
}

function loadCorpus(): GasCorpus {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(`vendored corpus missing at ${CORPUS_FILE} — run npm run vendor:vectors first`);
  }
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as GasCorpus;
}

/** Headroom the declared model is expected to keep over a measured point. */
const MIN_MARGIN = 1.1;
/** Above this the declaration is wasteful — the creator pays the limit, not the usage. */
const MAX_MARGIN = 1.6;

describe('phase-1 declared gas covers every measured band', () => {
  const corpus = loadCorpus();

  test.each(corpus.request_guardians.map((p) => [p.max_shares, p.gas_used] as const))(
    'max_shares=%i consumed %i',
    (maxShares, gasUsed) => {
      const declared = Number(requestGuardiansGas(maxShares));
      expect(declared).toBeGreaterThan(gasUsed * MIN_MARGIN);
      expect(declared).toBeLessThan(gasUsed * MAX_MARGIN);
    },
  );

  test('scales with the band rather than sitting flat', () => {
    // A flat declaration is what put phase 1 out of gas above fifteen
    // guardians: consumption climbs ~4,400 per selected guardian.
    expect(requestGuardiansGas(32)).toBeGreaterThan(requestGuardiansGas(2));
  });
});

describe('phase-2 declared gas covers every measured band and payload', () => {
  const corpus = loadCorpus();

  test.each(
    corpus.distribute_shares.map(
      (p) => [p.max_shares, p.ciphertext_bytes, p.gas_used] as const,
    ),
  )('max_shares=%i, %i ciphertext bytes consumed %i', (maxShares, bytes, gasUsed) => {
    const declared = Number(distributeSharesGas(maxShares, bytes));
    expect(declared).toBeGreaterThan(gasUsed * MIN_MARGIN);
    expect(declared).toBeLessThan(gasUsed * MAX_MARGIN);
  });

  test('the worst case stays inside a sane block gas budget', () => {
    // The ceiling case is the one that must not silently become unsealable.
    const worst = distributeSharesGas(Number(MAX_TOTAL_SHARES), MAX_PAYLOAD_CIPHERTEXT_BYTES);
    expect(worst).toBeLessThan(2_000_000n);
  });

  test('both the band and the payload move it', () => {
    const base = distributeSharesGas(2, 152);
    expect(distributeSharesGas(32, 152)).toBeGreaterThan(base);
    expect(distributeSharesGas(2, 4216)).toBeGreaterThan(base);
  });
});

describe('cancel declared gas covers every measured roster', () => {
  const corpus = loadCorpus();

  test.each(
    corpus.cancel_secret.map((p) => [p.active_guardians, p.gas_used] as const),
  )('%i active guardians consumed %i', (active, gasUsed) => {
    const declared = Number(cancelSecretGas(active));
    expect(declared).toBeGreaterThan(gasUsed * MIN_MARGIN);
    expect(declared).toBeLessThan(gasUsed * MAX_MARGIN);
  });

  test('cancel scales with the roster — it is not a flat state transition', () => {
    // The handler walks the active guardians twice: a pro-rata wage each, and
    // a bond returned each. Declaring a flat figure aborted a real cancel.
    expect(cancelSecretGas(32)).toBeGreaterThan(cancelSecretGas(2) * 5n);
  });

  test('defaults to the worst case when the roster is unknown', () => {
    expect(cancelSecretGas()).toBe(cancelSecretGas(Number(MAX_TOTAL_SHARES)));
  });
});

describe('the declared model tracks the recorded fit', () => {
  const corpus = loadCorpus();

  test('phase-1 declaration exceeds the fitted line at both ends', () => {
    const { base, per_share: perShare } = corpus.fit.request_guardians;
    for (const n of [2, 32]) {
      expect(Number(requestGuardiansGas(n))).toBeGreaterThan(base + perShare * n);
    }
  });

  test('phase-2 declaration exceeds the fitted surface at the corners', () => {
    const { base, per_share: perShare, per_byte: perByte } = corpus.fit.distribute_shares;
    for (const [n, b] of [
      [2, 152],
      [32, 152],
      [2, 4216],
      [32, 4216],
    ]) {
      expect(Number(distributeSharesGas(n, b))).toBeGreaterThan(base + perShare * n + perByte * b);
    }
  });
});
