/**
 * Discovery-scan paging semantics against a stubbed REST client. The critical
 * regression pinned here: a creation height denser than one page must be
 * walked with the store's page key at a FIXED since-height — a height-rewind
 * cursor cannot advance past it, and anyone able to land a page's worth of
 * creations in one block could wedge every recipient's scan forever.
 */

import { CryptoProvider } from '../crypto';
import { discoverSecrets } from '../recipient';
import { TimeflareRestClient } from '../rest';
import { WatchAbortedError } from '../watch';

/** A hint record whose tag's first byte encodes whether the stub crypto matches it. */
function hint(secretId: string, createdAt: number, matches = true) {
  return {
    secretId,
    createdAt,
    detectionHint: {
      version: 1,
      ephemeralPub: new Uint8Array(32),
      tag: new Uint8Array(8).fill(matches ? 1 : 0),
    },
  };
}

/** scanHint reads the match bit the fixtures planted — no real X25519 needed. */
const stubCrypto = {
  scanHint: (h: { tag: ArrayBuffer }) => new Uint8Array(h.tag)[0] === 1,
} as unknown as CryptoProvider;

type HintPage = { hints: ReturnType<typeof hint>[]; nextKey: Uint8Array | undefined };

/** Serve canned pages, recording every (sinceHeight, limit, pageKey) request. */
function restWithHintPages(pages: HintPage[]): {
  rest: TimeflareRestClient;
  requests: { sinceHeight: number; limit?: number; pageKey?: Uint8Array }[];
} {
  const requests: { sinceHeight: number; limit?: number; pageKey?: Uint8Array }[] = [];
  let call = 0;
  const rest = {
    hintsSince: async (sinceHeight: number, limit?: number, pageKey?: Uint8Array) => {
      requests.push({ sinceHeight, limit, pageKey });
      return pages[Math.min(call++, pages.length - 1)];
    },
  } as unknown as TimeflareRestClient;
  return { rest, requests };
}

const KEY = (label: string) => new Uint8Array(Buffer.from(label));
const SK = new Uint8Array(32).fill(9);

describe('discoverSecrets', () => {
  test('pages a dense creation height by key with a fixed since-height', async () => {
    // Every record shares createdAt 100 — the exact shape a height-rewind
    // cursor can never cross.
    const { rest, requests } = restWithHintPages([
      { hints: [hint('a', 100), hint('b', 100)], nextKey: KEY('k1') },
      { hints: [hint('c', 100), hint('d', 100, false)], nextKey: undefined },
    ]);
    const result = await discoverSecrets(stubCrypto, rest, SK, 0, 2);
    expect(result.secretIds).toEqual(['a', 'b', 'c']);
    expect(result.nextSinceHeight).toBe(101);
    expect(requests).toEqual([
      { sinceHeight: 0, limit: 2, pageKey: undefined },
      { sinceHeight: 0, limit: 2, pageKey: KEY('k1') },
    ]);
  });

  test('a record repeated across pages is reported once', async () => {
    const { rest } = restWithHintPages([
      { hints: [hint('dup', 100)], nextKey: KEY('k1') },
      { hints: [hint('dup', 100)], nextKey: undefined },
    ]);
    const result = await discoverSecrets(stubCrypto, rest, SK, 0, 1);
    expect(result.secretIds).toEqual(['dup']);
  });

  test('an empty feed returns the caller cursor unchanged', async () => {
    const { rest } = restWithHintPages([{ hints: [], nextKey: undefined }]);
    const result = await discoverSecrets(stubCrypto, rest, SK, 42);
    expect(result.secretIds).toEqual([]);
    expect(result.nextSinceHeight).toBe(42);
  });

  test('a pre-aborted signal scans nothing', async () => {
    const { rest, requests } = restWithHintPages([{ hints: [hint('a', 100)], nextKey: undefined }]);
    await expect(
      discoverSecrets(stubCrypto, rest, SK, 0, 1000, { aborted: true }),
    ).rejects.toThrow(WatchAbortedError);
    expect(requests).toHaveLength(0);
  });

  test('aborting mid-backlog stops between pages', async () => {
    // The signal flips during the first page; the walk must stop before
    // fetching the second even though a next key is on offer.
    const signal = { aborted: false };
    const requests: unknown[] = [];
    const rest = {
      hintsSince: async () => {
        requests.push(true);
        signal.aborted = true;
        return { hints: [hint('a', 100)], nextKey: KEY('k1') };
      },
    } as unknown as TimeflareRestClient;
    await expect(discoverSecrets(stubCrypto, rest, SK, 0, 1, signal)).rejects.toThrow(
      WatchAbortedError,
    );
    expect(requests).toHaveLength(1);
  });
});
