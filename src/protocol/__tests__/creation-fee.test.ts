/**
 * Pins the client-side creation-fee estimator (creationFeeUveil) to the
 * shared cross-implementation corpus
 * (testdata/vectors/creation_fee.json, vendored by `npm run vendor:vectors`).
 * The chain (x/secrets/types.CreationFee) asserts the same matrix, so the
 * fee cannot drift between implementations.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CREATION_FEE_FLOOR_UVEIL, creationFeeUveil } from '../constants';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'creation_fee.json');

interface CreationFeeVector {
  name: string;
  pool_uveil: string;
  distance_blocks: number;
  fee_uveil: string;
  regime: 'floor' | 'percent';
}

interface CreationFeeCorpus {
  vectors: CreationFeeVector[];
}

function loadCorpus(): CreationFeeCorpus {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(`vendored corpus missing at ${CORPUS_FILE} — run npm run vendor:vectors first`);
  }
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as CreationFeeCorpus;
}

describe('creation fee — shared vector matrix', () => {
  const corpus = loadCorpus();

  test('corpus is non-empty', () => {
    expect(corpus.vectors.length).toBeGreaterThan(0);
  });

  test.each(corpus.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const fee = creationFeeUveil(BigInt(v.pool_uveil), v.distance_blocks);
    expect(fee.toString()).toBe(v.fee_uveil);
    if (v.regime === 'floor') {
      expect(fee).toBe(CREATION_FEE_FLOOR_UVEIL);
    }
  });

  test('the floor constant matches the gas derivation', () => {
    expect(CREATION_FEE_FLOOR_UVEIL).toBe(60_000n);
  });
});
