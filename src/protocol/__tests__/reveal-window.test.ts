/**
 * The client half of the reveal-window derivation corpus
 * (testdata/vectors/dials.json, `reveal_window_derivation`).
 *
 * The chain asserts the same block in x/secrets/types. The window's length is
 * derived rather than chosen, so a client that computes it differently quotes a
 * price the chain will not charge — and this is the only reason a client needs
 * the derivation at all. Once a secret exists, its window is a stored height
 * read back from the record.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  COMMIT_TIMEOUT_BLOCKS,
  MAX_REVEAL_HORIZON_BLOCKS,
  REVEAL_RAMP_END_BLOCKS,
  REVEAL_RAMP_START_BLOCKS,
  REVEAL_START_OFFSET_MAX_BLOCKS,
  REVEAL_WINDOW_CEILING_BLOCKS,
  REVEAL_WINDOW_FLOOR_BLOCKS,
  revealDistanceBlocks,
  revealHoldBlocks,
  revealWindowBlocks,
  revealWindowForStartOffset,
} from '../constants';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'dials.json');

interface DerivationCorpus {
  reveal_window_derivation: {
    constants: {
      window_floor: number;
      window_ceiling: number;
      ramp_start: number;
      ramp_end: number;
    };
    cases: { hold_blocks: number; window_blocks: number; reason?: string }[];
  };
}

function loadCorpus(): DerivationCorpus {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(`vendored corpus missing at ${CORPUS_FILE} — run make vectors-sync first`);
  }
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as DerivationCorpus;
}

describe('reveal window derivation — shared corpus', () => {
  const { reveal_window_derivation: corpus } = loadCorpus();

  test('corpus carries derivation cases', () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  test('the four corners match the chain', () => {
    expect(corpus.constants.window_floor).toBe(REVEAL_WINDOW_FLOOR_BLOCKS);
    expect(corpus.constants.window_ceiling).toBe(REVEAL_WINDOW_CEILING_BLOCKS);
    expect(corpus.constants.ramp_start).toBe(REVEAL_RAMP_START_BLOCKS);
    expect(corpus.constants.ramp_end).toBe(REVEAL_RAMP_END_BLOCKS);
  });

  test.each(corpus.cases.map((c) => [c.hold_blocks, c.window_blocks, c.reason ?? ''] as const))(
    'hold %i → window %i (%s)',
    (hold, want) => {
      expect(revealWindowBlocks(hold)).toBe(want);
    },
  );
});

describe('reveal window derivation — properties', () => {
  test('never leaves its bounds, never shrinks as the hold grows', () => {
    const holds = [0, 1, 50, 599, 600, 601, 602];
    for (let h = 1_000; h < REVEAL_RAMP_END_BLOCKS; h += 3_571) holds.push(h);
    holds.push(REVEAL_RAMP_END_BLOCKS - 1, REVEAL_RAMP_END_BLOCKS, REVEAL_RAMP_END_BLOCKS + 1);
    holds.push(MAX_REVEAL_HORIZON_BLOCKS);

    let prev = -1;
    for (const h of holds) {
      const w = revealWindowBlocks(h);
      expect(w).toBeGreaterThanOrEqual(REVEAL_WINDOW_FLOOR_BLOCKS);
      expect(w).toBeLessThanOrEqual(REVEAL_WINDOW_CEILING_BLOCKS);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  test('every window is a whole number of blocks', () => {
    for (const h of [601, 3_600, 14_400, 100_800, 216_000, 431_999]) {
      expect(Number.isInteger(revealWindowBlocks(h))).toBe(true);
    }
  });

  test('the offset ceiling closes exactly on the horizon', () => {
    // The bound MaxRevealStartOffset exists to guarantee: a secret's whole life,
    // its reveal window included, fits inside H.
    expect(
      REVEAL_START_OFFSET_MAX_BLOCKS + revealWindowForStartOffset(REVEAL_START_OFFSET_MAX_BLOCKS),
    ).toBe(MAX_REVEAL_HORIZON_BLOCKS);
  });

  test('the hold excludes the commit window', () => {
    expect(revealHoldBlocks(1_000)).toBe(1_000 - COMMIT_TIMEOUT_BLOCKS);
  });

  test('distance runs commit_deadline → settlement', () => {
    // distance = start_offset + window + 1 − CommitTimeoutBlocks. Priced to
    // reveal_end_block + 1, because the window is inclusive of its end block and
    // bonds release the block after.
    const offset = 432_000;
    expect(revealDistanceBlocks(offset)).toBe(
      offset + revealWindowForStartOffset(offset) + 1 - COMMIT_TIMEOUT_BLOCKS,
    );
  });
});
