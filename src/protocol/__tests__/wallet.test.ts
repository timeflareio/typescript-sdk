/**
 * Wallet HD derivation against the shared corpus
 * (testdata/vectors/wallet_derivation.json, vendored by vendor:vectors):
 * every mnemonic must resolve to the pinned address at the chain path
 * m/44'/9733'/0'/0/0 (CLIENT_CONVENTIONS.md §9), never at cosmjs's Cosmos
 * Hub default.
 */
import * as fs from 'fs';
import * as path from 'path';

import { pathToString } from '@cosmjs/crypto';

import { CHAIN_HD_PATH, generateWallet, walletFromMnemonic } from '../wallet';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'wallet_derivation.json');

interface Corpus {
  hd_path: string;
  wrong_hd_path_cosmoshub: string;
  vectors: {
    name: string;
    mnemonic: string;
    address: string;
    wrong_address_cosmoshub: string;
  }[];
}

const corpus: Corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));

describe('CHAIN_HD_PATH', () => {
  test('matches the corpus path (spec.md coin type 9733)', () => {
    expect(pathToString(CHAIN_HD_PATH)).toBe(corpus.hd_path);
  });
});

describe('walletFromMnemonic', () => {
  test.each(corpus.vectors)('$name derives the pinned address', async (vector) => {
    const { address } = await walletFromMnemonic(vector.mnemonic);
    if (address === vector.wrong_address_cosmoshub) {
      throw new Error(
        `derivation regressed to cosmjs's Cosmos Hub default ${corpus.wrong_hd_path_cosmoshub} — pass CHAIN_HD_PATH explicitly`,
      );
    }
    expect(address).toBe(vector.address);
  });
});

describe('generateWallet', () => {
  test('generates on the chain path — restore round-trips the address', async () => {
    const generated = await generateWallet();
    const restored = await walletFromMnemonic(generated.mnemonic);
    // The vector suite pins the path walletFromMnemonic uses; this pins
    // generate/restore agreement, so generateWallet cannot drift alone.
    expect(restored.address).toBe(generated.address);
  });
});
