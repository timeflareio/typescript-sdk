/**
 * Pins the client-side band rule (shareBandError) and the default preset to
 * the shared cross-implementation corpus
 * (testdata/vectors/share_band.json, vendored by `npm run vendor:vectors`).
 * The chain (x/secrets/types.ValidateShareBand) and every client assert the
 * same matrix, so the rule cannot drift between implementations.
 */

import * as fs from 'fs';
import * as path from 'path';

import { defaultMaxShares, shareBandError } from '../constants';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'share_band.json');

interface BandVector {
  name: string;
  threshold: number;
  min_shares: number;
  max_shares: number;
  reason?: string;
}

interface BandCorpus {
  valid: BandVector[];
  invalid: BandVector[];
}

function loadCorpus(): BandCorpus {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(`vendored corpus missing at ${CORPUS_FILE} — run npm run vendor:vectors first`);
  }
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as BandCorpus;
}

describe('guardian band validation — shared vector matrix', () => {
  const corpus = loadCorpus();

  test('corpus carries both verdicts', () => {
    expect(corpus.valid.length).toBeGreaterThan(0);
    expect(corpus.invalid.length).toBeGreaterThan(0);
  });

  test.each(loadCorpus().valid.map((v) => [v.name, v] as const))('valid: %s', (_name, v) => {
    expect(shareBandError(v.threshold, v.min_shares, v.max_shares)).toBeNull();
  });

  test.each(loadCorpus().invalid.map((v) => [v.name, v] as const))('invalid: %s', (_name, v) => {
    expect(shareBandError(v.threshold, v.min_shares, v.max_shares)).not.toBeNull();
  });
});

describe('default band preset', () => {
  test('always produces a valid band from any valid (threshold, min)', () => {
    for (let threshold = 2; threshold <= 16; threshold++) {
      for (let min = threshold; min <= 32; min++) {
        expect(shareBandError(threshold, min, defaultMaxShares(threshold, min))).toBeNull();
      }
    }
  });

  test('keeps the historical 30% spread when the gap bound allows it', () => {
    // ceil(15 × 30%) = 5 < threshold 9 → the full spread survives
    expect(defaultMaxShares(9, 15)).toBe(20);
    // ceil(5 × 30%) = 2, clamped by threshold 3 − 1 = 2 → 7
    expect(defaultMaxShares(3, 5)).toBe(7);
    // low threshold forces a narrow band: spread capped at threshold − 1 = 1
    expect(defaultMaxShares(2, 10)).toBe(11);
  });
});
