/**
 * Conventions codecs against the shared corpus
 * (testdata/vectors/client_conventions.json, vendored by scripts/vendor.sh).
 * Producers must emit the corpus byte-for-byte; parsers must accept every
 * valid vector and reject every invalid one — the CLIENT_CONVENTIONS.md
 * vector-pinning contract.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  encodeClaimUri,
  encodeFundUri,
  encodeRecipientUri,
  keyToMnemonic,
  mnemonicToKey,
  parseClaimUri,
  parseFundUri,
  parseRecipientUri,
  ConventionError,
  FUND_URI_PREFIX,
  RECIPIENT_URI_PREFIX,
} from '../conventions';

const CORPUS_FILE = path.join(__dirname, '..', '..', 'vendor', 'vectors', 'client_conventions.json');

interface Corpus {
  version: number;
  recipient_uri: { name: string; public_key_hex: string; uri: string }[];
  recipient_uri_invalid: { name: string; input: string; reason: string }[];
  claim_uri: {
    name: string;
    private_key_hex: string;
    secret_id: string | null;
    /** Present only on a funded kit; its absence is an unseeded (version 1) kit. */
    courier_key_hex?: string;
    version?: number;
    uri: string;
  }[];
  claim_uri_invalid: { name: string; input: string; reason: string }[];
  mnemonic: { name: string; private_key_hex: string; words: string }[];
  mnemonic_invalid: { name: string; words: string; reason: string }[];
  /** Amounts are corpus strings, not numbers: uveil exceeds exact double range. */
  fund_uri: { name: string; address: string; amount_uveil: string | null; uri: string }[];
  fund_uri_parse_only: {
    name: string;
    input: string;
    address: string;
    amount_uveil: string | null;
  }[];
  fund_uri_invalid: { name: string; input: string; reason: string }[];
}

function loadCorpus(): Corpus {
  if (!fs.existsSync(CORPUS_FILE)) {
    throw new Error(
      `vendored corpus missing at ${CORPUS_FILE} — run mobile-client/scripts/vendor.sh first`,
    );
  }
  return JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')) as Corpus;
}

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const corpus = loadCorpus();

describe('client_conventions.json corpus', () => {
  test('corpus is populated (all six sections)', () => {
    expect(corpus.version).toBe(1);
    expect(corpus.recipient_uri.length).toBeGreaterThan(0);
    expect(corpus.recipient_uri_invalid.length).toBeGreaterThan(0);
    expect(corpus.claim_uri.length).toBeGreaterThan(0);
    expect(corpus.claim_uri_invalid.length).toBeGreaterThan(0);
    expect(corpus.mnemonic.length).toBeGreaterThan(0);
    expect(corpus.mnemonic_invalid.length).toBeGreaterThan(0);
  });

  describe('recipient URI (§3)', () => {
    test.each(corpus.recipient_uri)('produce + parse: $name', (v) => {
      expect(encodeRecipientUri(fromHex(v.public_key_hex))).toBe(v.uri);
      const parsed = parseRecipientUri(v.uri);
      expect(parsed.version).toBe(1);
      expect(toHex(parsed.publicKey)).toBe(v.public_key_hex);
      // ≤ 90-char bech32m guarantee holds
      expect(v.uri.length - RECIPIENT_URI_PREFIX.length).toBeLessThanOrEqual(90);
    });

    test.each(corpus.recipient_uri)('bare payload accepted for manual paste: $name', (v) => {
      const bare = v.uri.slice(RECIPIENT_URI_PREFIX.length);
      expect(toHex(parseRecipientUri(bare).publicKey)).toBe(v.public_key_hex);
      // …and case-insensitively (QR alphanumeric mode scans upper-case)
      expect(toHex(parseRecipientUri(bare.toUpperCase()).publicKey)).toBe(v.public_key_hex);
    });

    test.each(corpus.recipient_uri_invalid)('reject: $name', (v) => {
      expect(() => parseRecipientUri(v.input)).toThrow(ConventionError);
    });
  });

  describe('claim URI (§4)', () => {
    test.each(corpus.claim_uri)('produce + parse: $name', (v) => {
      const courier = v.courier_key_hex ? fromHex(v.courier_key_hex) : undefined;
      expect(encodeClaimUri(fromHex(v.private_key_hex), v.secret_id ?? undefined, courier)).toBe(
        v.uri,
      );
      const parsed = parseClaimUri(v.uri);
      // A seeded kit is version 2 precisely so an old client refuses it whole
      // rather than importing the identity and abandoning the seed.
      expect(parsed.version).toBe(v.version ?? 1);
      expect(toHex(parsed.privateKey)).toBe(v.private_key_hex);
      expect(parsed.secretId).toBe(v.secret_id ?? undefined);
      if (v.courier_key_hex) {
        expect(toHex(parsed.courierKey!)).toBe(v.courier_key_hex);
      } else {
        expect(parsed.courierKey).toBeUndefined();
      }
    });

    test('the courier key is a DIFFERENT key from the identity, under its own HRP', () => {
      const seeded = corpus.claim_uri.find((v) => v.courier_key_hex)!;
      expect(seeded.courier_key_hex).not.toBe(seeded.private_key_hex);
      expect(seeded.uri).toContain('seed=tfck1');
      const parsed = parseClaimUri(seeded.uri);
      expect(toHex(parsed.courierKey!)).not.toBe(toHex(parsed.privateKey));
    });

    test.each(corpus.claim_uri_invalid)('reject: $name', (v) => {
      expect(() => parseClaimUri(v.input)).toThrow(ConventionError);
    });

    test('stale/malformed id degrades to key-based discovery, not failure', () => {
      const good = corpus.claim_uri.find((v) => v.secret_id !== null)!;
      const base = good.uri.slice(0, good.uri.indexOf('?'));
      const parsed = parseClaimUri(`${base}?id=NOT-A-UUID`);
      expect(toHex(parsed.privateKey)).toBe(good.private_key_hex);
      expect(parsed.secretId).toBeUndefined();
    });
  });

  describe('identity-key backup mnemonic (§5)', () => {
    test.each(corpus.mnemonic)('produce + parse: $name', (v) => {
      expect(keyToMnemonic(fromHex(v.private_key_hex))).toBe(v.words);
      expect(toHex(mnemonicToKey(v.words))).toBe(v.private_key_hex);
      expect(v.words.split(' ')).toHaveLength(24);
    });

    test.each(corpus.mnemonic)('restore normalises whitespace and case: $name', (v) => {
      const messy = `  ${v.words.toUpperCase().split(' ').join('   ')}\n`;
      expect(toHex(mnemonicToKey(messy))).toBe(v.private_key_hex);
    });

    test.each(corpus.mnemonic_invalid)('reject: $name', (v) => {
      expect(() => mnemonicToKey(v.words)).toThrow(ConventionError);
    });
  });

  describe('fund URI (§8)', () => {
    test.each(corpus.fund_uri)('produce: $name', (v) => {
      const amount = v.amount_uveil === null ? undefined : BigInt(v.amount_uveil);
      expect(encodeFundUri(v.address, amount)).toBe(v.uri);
    });

    test.each(corpus.fund_uri)('round-trip: $name', (v) => {
      const parsed = parseFundUri(v.uri);
      expect(parsed.address).toBe(v.address);
      expect(parsed.amountUveil ?? null).toBe(
        v.amount_uveil === null ? null : BigInt(v.amount_uveil),
      );
    });

    test.each(corpus.fund_uri_parse_only)('parse: $name', (v) => {
      const parsed = parseFundUri(v.input);
      expect(parsed.address).toBe(v.address);
      expect(parsed.amountUveil ?? null).toBe(
        v.amount_uveil === null ? null : BigInt(v.amount_uveil),
      );
    });

    test.each(corpus.fund_uri_invalid)('reject: $name', (v) => {
      expect(() => parseFundUri(v.input)).toThrow(ConventionError);
    });

    test('the address is carried verbatim — no wrapper, no version byte', () => {
      const v = corpus.fund_uri[0];
      expect(v.uri).toBe(FUND_URI_PREFIX + v.address);
      expect(v.uri).toContain(v.address);
    });

    test('a garbled amount never costs the address', () => {
      // The asymmetry that matters: a bad quantity degrades, a bad address
      // throws. Sending to a mistyped address is unrecoverable; retyping a
      // number is not.
      const { address } = corpus.fund_uri[0];
      expect(parseFundUri(`${FUND_URI_PREFIX}${address}?amount=-5`).address).toBe(address);
      expect(() => parseFundUri(`${FUND_URI_PREFIX}${address.slice(0, -1)}`)).toThrow(
        ConventionError,
      );
    });

    test('an amount is refused at production time rather than emitted unusable', () => {
      const { address } = corpus.fund_uri[0];
      expect(() => encodeFundUri(address, 0n)).toThrow(ConventionError);
      expect(() => encodeFundUri(address, -1n)).toThrow(ConventionError);
      expect(() => encodeFundUri('tmflr1notanaddress')).toThrow(ConventionError);
    });
  });
});
