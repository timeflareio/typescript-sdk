/**
 * The client half of the shared dial corpus (testdata/vectors/dials.json).
 *
 * The chain asserts the same file through both of its validation layers
 * (x/secrets/keeper/dial_vectors_test.go). Together the two suites pin the
 * property that matters: the range a client OFFERS is exactly the range the
 * chain ACCEPTS. Offering more spends the user's gas on transactions that
 * cannot land; offering less silently removes protocol capability.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  BUMP_MAX_HUNDREDTHS,
  BUMP_MIN_HUNDREDTHS,
  COMMIT_TIMEOUT_BLOCKS,
  clampDial,
  defaultMaxShares,
  DIALS,
  DialId,
  DialValues,
  dialErrors,
  MAX_TOTAL_SHARES,
  REVEAL_DURATION_MAX_BLOCKS,
  REVEAL_DURATION_MIN_BLOCKS,
  REVEAL_START_OFFSET_BUFFER_BLOCKS,
  REVEAL_START_OFFSET_MIN_BLOCKS,
  shareBandError,
  SHARES_MIN,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from '../constants';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'dials.json');

interface DialCase {
  name: string;
  threshold: number;
  min_shares: number;
  max_shares: number;
  bump_hundredths: number;
  reveal_start_offset_blocks: number;
  reveal_duration_blocks: number;
  valid: boolean;
  reason?: string;
}

interface DialCorpus {
  bounds: Record<string, { min?: number; max?: number; absolute_max?: number }>;
  cases: DialCase[];
}

function loadCorpus(): DialCorpus {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(`vendored corpus missing at ${CORPUS_FILE} — run npm run vendor:vectors first`);
  }
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as DialCorpus;
}

function valuesOf(c: DialCase): DialValues {
  return {
    threshold: c.threshold,
    minShares: c.min_shares,
    maxShares: c.max_shares,
    bumpHundredths: c.bump_hundredths,
    revealStartOffsetBlocks: c.reveal_start_offset_blocks,
    revealDurationBlocks: c.reveal_duration_blocks,
  };
}

describe('dial bounds — shared vector matrix', () => {
  const corpus = loadCorpus();

  test('corpus carries both verdicts', () => {
    expect(corpus.cases.some((c) => c.valid)).toBe(true);
    expect(corpus.cases.some((c) => !c.valid)).toBe(true);
  });

  test.each(loadCorpus().cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const errors = dialErrors(valuesOf(c));
    if (c.valid) {
      expect(errors).toEqual([]);
    } else {
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  test('declared bounds match the descriptors', () => {
    expect(corpus.bounds.threshold).toMatchObject({ min: THRESHOLD_MIN, max: THRESHOLD_MAX });
    expect(corpus.bounds.min_shares).toMatchObject({ min: SHARES_MIN, max: MAX_TOTAL_SHARES });
    expect(corpus.bounds.max_shares.absolute_max).toBe(MAX_TOTAL_SHARES);
    expect(corpus.bounds.bump_hundredths).toMatchObject({
      min: BUMP_MIN_HUNDREDTHS,
      max: BUMP_MAX_HUNDREDTHS,
    });
    expect(corpus.bounds.reveal_start_offset_blocks.min).toBe(REVEAL_START_OFFSET_MIN_BLOCKS);
    expect(corpus.bounds.reveal_duration_blocks).toMatchObject({
      min: REVEAL_DURATION_MIN_BLOCKS,
      max: REVEAL_DURATION_MAX_BLOCKS,
    });
  });
});

describe('dial descriptors', () => {
  const base: DialValues = {
    threshold: 3,
    minShares: 5,
    maxShares: 7,
    bumpHundredths: 100,
    revealStartOffsetBlocks: 432_000,
    revealDurationBlocks: 300,
  };

  test('every descriptor default lands inside its own range', () => {
    for (const id of Object.keys(DIALS) as DialId[]) {
      const d = DIALS[id];
      const def = d.default(base);
      expect(def).toBeGreaterThanOrEqual(d.min(base));
      expect(def).toBeLessThanOrEqual(d.max(base));
    }
  });

  test('the max_shares ceiling is the chain gap bound, not the 30% preset', () => {
    // The preset picks a narrow band; the protocol often permits a wider one,
    // and the dial must offer the whole legal range or it is deciding for the
    // user. The divergence grows with the threshold: at the Maximum tier
    // (9-of-15) the preset stops at 20 while the chain allows 23.
    const maximumTier = { ...base, threshold: 9, minShares: 15, maxShares: 20 };
    const ceiling = DIALS.maxShares.max(maximumTier);
    expect(ceiling).toBe(Math.min(MAX_TOTAL_SHARES, 15 + 9 - 1));
    expect(ceiling).toBeGreaterThan(defaultMaxShares(9, 15));
    expect(shareBandError(9, 15, ceiling)).toBeNull();
    // One past the ceiling must be rejected by the authoritative band rule.
    expect(shareBandError(9, 15, ceiling + 1)).not.toBeNull();
  });

  test('at the Standard tier the preset already sits on the gap bound', () => {
    // Worth pinning rather than assuming: 3-of-5 leaves exactly two spare
    // slots either way, so exposing the dial buys a Standard creator nothing.
    // The dial earns its place at the higher tiers, not this one.
    expect(DIALS.maxShares.max(base)).toBe(defaultMaxShares(base.threshold, base.minShares));
    expect(DIALS.maxShares.isPinned({ ...base, maxShares: DIALS.maxShares.max(base) })).toBe(false);
  });

  test('descriptors agree with shareBandError across the whole band space', () => {
    for (let threshold = THRESHOLD_MIN; threshold <= THRESHOLD_MAX; threshold++) {
      for (let minShares = threshold; minShares <= MAX_TOTAL_SHARES; minShares++) {
        const v = { ...base, threshold, minShares, maxShares: minShares };
        const lo = DIALS.maxShares.min(v);
        const hi = DIALS.maxShares.max(v);
        for (const maxShares of [lo, hi]) {
          expect(shareBandError(threshold, minShares, maxShares)).toBeNull();
        }
        expect(shareBandError(threshold, minShares, hi + 1)).not.toBeNull();
      }
    }
  });

  test('reveal offset floor is the fixed commit window plus the buffer', () => {
    // The floor used to depend on a creator-chosen commit window. It is now a
    // constant, and this pins what it is made of: a UI that hardcoded a
    // different number would offer a value the chain rejects.
    expect(REVEAL_START_OFFSET_MIN_BLOCKS).toBe(
      COMMIT_TIMEOUT_BLOCKS + REVEAL_START_OFFSET_BUFFER_BLOCKS,
    );
    expect(DIALS.revealStartOffset.min(base)).toBe(REVEAL_START_OFFSET_MIN_BLOCKS);
    // Independent of every other dial, which is the simplification.
    expect(DIALS.revealStartOffset.min({ ...base, revealDurationBlocks: 14_400 })).toBe(
      REVEAL_START_OFFSET_MIN_BLOCKS,
    );
  });

  test('clampDial never returns an illegal value', () => {
    for (const id of Object.keys(DIALS) as DialId[]) {
      const d = DIALS[id];
      expect(clampDial(id, -1_000_000, base)).toBe(d.min(base));
      expect(clampDial(id, 100_000_000, base)).toBe(d.max(base));
    }
  });

  test('a pinned dial reports itself as pinned', () => {
    // threshold 2 with min_shares 32 leaves max_shares no room to move: the
    // ceiling and the gap bound coincide. A stepper must say so rather than
    // render a control that cannot change anything.
    const pinned = { ...base, threshold: 2, minShares: MAX_TOTAL_SHARES, maxShares: 32 };
    expect(DIALS.maxShares.isPinned(pinned)).toBe(true);
    expect(DIALS.maxShares.isPinned(base)).toBe(false);
  });

  test('every dial declares what it moves', () => {
    for (const id of Object.keys(DIALS) as DialId[]) {
      expect(DIALS[id].affects.length).toBeGreaterThan(0);
    }
    // Band width and bump both move the bill; a UI reads this rather than
    // hardcoding which dials to re-quote on.
    expect(DIALS.maxShares.affects).toContain('cost');
    expect(DIALS.bump.affects).toContain('cost');
  });
});
