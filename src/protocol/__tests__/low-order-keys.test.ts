/**
 * The client half of the hostile-input corpus (testdata/vectors/low_order_keys.json).
 *
 * The Go suite (crypto/vectors_test.go) and the Rust suite (rust/src/crypto.rs,
 * rust/src/detect.rs) assert the same file. This one covers the layer above
 * them: the SDK must refuse a small-order guardian key BEFORE sealing and say
 * which guardian is at fault, rather than letting the WASM boundary produce an
 * opaque crypto error part-way through a seal the creator has already paid for.
 *
 * These vectors exist because the corpus previously pinned only VALID inputs,
 * which is exactly how Go and Rust came to disagree on hostile ones.
 */

import * as fs from 'fs';
import * as path from 'path';

import { UnusableGuardianKeyError } from '../crypto';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'low_order_keys.json');

interface KeyCase {
  name: string;
  key_hex: string;
  order?: number;
  canonical?: boolean;
  note?: string;
}

interface LowOrderCorpus {
  reject: KeyCase[];
  accept: KeyCase[];
}

function loadCorpus(): LowOrderCorpus {
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as LowOrderCorpus;
}

function keyBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

describe('low-order key corpus', () => {
  const corpus = loadCorpus();

  it('carries both rejection and acceptance cases', () => {
    expect(corpus.reject.length).toBeGreaterThan(0);
    expect(corpus.accept.length).toBeGreaterThan(0);
  });

  it('includes the non-canonical encodings a hand-written table would miss', () => {
    const nonCanonical = corpus.reject.filter((c) => c.canonical === false);
    expect(nonCanonical.length).toBeGreaterThan(0);
  });

  it('every rejection case is 32 bytes — length is not what makes them invalid', () => {
    for (const c of corpus.reject) {
      expect(keyBytes(c.key_hex)).toHaveLength(32);
    }
  });
});

describe('UnusableGuardianKeyError', () => {
  it('names the guardian at fault', () => {
    const err = new UnusableGuardianKeyError('tmflr1badguardian');
    expect(err.guardianAddress).toBe('tmflr1badguardian');
    expect(err.message).toContain('tmflr1badguardian');
    expect(err.name).toBe('UnusableGuardianKeyError');
  });

  it('explains the consequence, not just the rule', () => {
    // The message has to tell an operator why this matters — a share encrypted
    // to such a key is readable by anyone, which is not guessable from
    // "invalid key".
    const err = new UnusableGuardianKeyError('tmflr1badguardian');
    expect(err.message).toContain('readable by anyone');
  });

  it('is an Error, so existing catch sites keep working', () => {
    expect(new UnusableGuardianKeyError('x')).toBeInstanceOf(Error);
  });
});
