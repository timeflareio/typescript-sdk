/**
 * BlockClock: the interval must be MEASURED, and the band it reports must be
 * earned rather than declared.
 *
 * The synthetic chains here use the figures actually measured on live
 * cosmos-sdk chains in August 2026 (Cosmos Hub at 5.730 s against a nominal 6)
 * — the whole point of the estimator is that a real chain does not run at the
 * constant its config names.
 */

import {
  ANCHOR_FALLBACK_BLOCKS,
  BlockClock,
  BlockSample,
  BlockSampleStore,
  MIN_MEASURED_BASELINE_BLOCKS,
  refreshBlockClock,
  REGIME_DRIFT_PER_YEAR,
  UNMEASURED_UNCERTAINTY_FRACTION,
} from '../blockclock';
import { BLOCK_TIME_ESTIMATE_MS } from '../constants';

const T0 = Date.parse('2026-08-02T12:00:00.000Z');
const HUB_INTERVAL = 5_730; // measured on Cosmos Hub, 2 August 2026
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

/** A chain running at a steady interval, sampled every `every` blocks. */
function steadyChain(intervalMs: number, count: number, every = 5_000): BlockSample[] {
  return Array.from({ length: count }, (_, i) => ({
    height: 1_000_000 + i * every,
    timeMs: T0 + i * every * intervalMs,
  }));
}

describe('measurement', () => {
  test('recovers a real chain interval that differs from the seed', () => {
    const clock = BlockClock.fromSamples(steadyChain(HUB_INTERVAL, 8));
    expect(clock.measured).toBe(true);
    expect(clock.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
    // The seed would have been 4.7% wrong — the error this whole class exists
    // to remove.
    expect(Math.abs(BLOCK_TIME_ESTIMATE_MS - clock.intervalMs) / clock.intervalMs).toBeGreaterThan(
      0.04,
    );
  });

  test('a fresh clock is seeded, unmeasured, and says so', () => {
    const clock = BlockClock.seeded();
    expect(clock.measured).toBe(false);
    expect(clock.intervalMs).toBe(BLOCK_TIME_ESTIMATE_MS);
    expect(clock.uncertaintyFraction(YEAR_MS)).toBe(UNMEASURED_UNCERTAINTY_FRACTION);
  });

  test('a baseline shorter than the floor is not a measurement', () => {
    const short = [
      { height: 1_000_000, timeMs: T0 },
      { height: 1_000_000 + MIN_MEASURED_BASELINE_BLOCKS - 1, timeMs: T0 + 999 * HUB_INTERVAL },
    ];
    const clock = BlockClock.fromSamples(short);
    expect(clock.measured).toBe(false);
    expect(clock.intervalMs).toBe(BLOCK_TIME_ESTIMATE_MS);
    // The samples are kept — they may lengthen into a real baseline.
    expect(clock.samples).toHaveLength(2);
  });

  test('samples are ordered, deduplicated by height, and bounded', () => {
    const clock = BlockClock.fromSamples([
      { height: 1_010_000, timeMs: T0 + 10_000 * HUB_INTERVAL },
      { height: 1_000_000, timeMs: T0 },
      { height: 1_010_000, timeMs: T0 + 10_000 * HUB_INTERVAL },
    ]);
    expect(clock.samples.map((s) => s.height)).toEqual([1_000_000, 1_010_000]);

    const many = BlockClock.fromSamples(steadyChain(HUB_INTERVAL, 100));
    expect(many.samples.length).toBeLessThanOrEqual(32);
    expect(many.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
  });

  test('the window keeps its baseline when it overflows', () => {
    // Eviction used to keep the NEWEST samples, which discards the deep
    // anchor first — collapsing a long baseline to a few blocks and
    // un-measuring the clock. On a fast chain with frequent refreshes that
    // happened within a couple of minutes and then persisted, so every later
    // refresh re-fetched the anchor only to slice it off again.
    const anchor = { height: 1_000_000, timeMs: T0 };
    const recent = Array.from({ length: 60 }, (_, i) => ({
      height: 1_014_400 + i * 2,
      timeMs: T0 + (14_400 + i * 2) * HUB_INTERVAL,
    }));
    const clock = BlockClock.fromSamples([anchor, ...recent]);
    expect(clock.samples.length).toBeLessThanOrEqual(32);
    expect(clock.samples[0]).toEqual(anchor);
    expect(clock.measured).toBe(true);
    expect(clock.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
  });

  test('a reset chain discards the dead chain rather than fusing the two', () => {
    // `make dev-reset` restarts at height 1 behind the same URL, so the
    // persisted window briefly describes two unrelated chains. Time running
    // backwards as height rises is the proof; the old samples sort highest
    // and would otherwise never be evicted.
    const dead = steadyChain(HUB_INTERVAL, 4).map((s) => ({
      ...s,
      height: s.height + 5_000_000,
    }));
    const reborn = Array.from({ length: 5 }, (_, i) => ({
      height: 1 + i * 400,
      timeMs: T0 + DAY_MS + i * 400 * 1_000, // a fresh 1 s devnet, later in wall clock
    }));
    const clock = BlockClock.fromSamples([...dead, ...reborn]);
    expect(clock.samples.every((s) => s.height < 5_000_000)).toBe(true);
    expect(clock.measured).toBe(true);
    expect(clock.intervalMs).toBeCloseTo(1_000, 6);
  });

  test('inconsistent samples never project time backwards', () => {
    const clock = BlockClock.fromSamples([
      { height: 1_000_000, timeMs: T0 },
      { height: 1_020_000, timeMs: T0 - DAY_MS }, // a reset chain or a clock jump
    ]);
    expect(clock.measured).toBe(false);
    expect(clock.intervalMs).toBe(BLOCK_TIME_ESTIMATE_MS);
  });

  test('a mid-window shift moves the fitted interval', () => {
    const before = steadyChain(HUB_INTERVAL, 6);
    const pivot = before[before.length - 1];
    const after = Array.from({ length: 6 }, (_, i) => ({
      height: pivot.height + (i + 1) * 5_000,
      timeMs: pivot.timeMs + (i + 1) * 5_000 * 6_500, // regime change to 6.5 s
    }));
    const shifted = BlockClock.fromSamples([...before, ...after]);
    const steady = BlockClock.fromSamples(before);
    expect(shifted.intervalMs).toBeGreaterThan(steady.intervalMs);
    expect(shifted.intervalMs).toBeGreaterThan(HUB_INTERVAL);
    expect(shifted.intervalMs).toBeLessThan(6_500);
  });
});

describe('uncertainty (§2.2)', () => {
  const clock = BlockClock.fromSamples(steadyChain(HUB_INTERVAL, 12));

  test('a measured clock reports the 2%/year regime floor at a year', () => {
    // A steady synthetic chain has almost no measurement error, so the
    // fraction at a one-year horizon is the ruled floor itself.
    expect(clock.uncertaintyFraction(YEAR_MS)).toBeCloseTo(REGIME_DRIFT_PER_YEAR, 3);
  });

  test('the floor scales with how far ahead the estimate reaches', () => {
    const twoMonths = clock.uncertaintyFraction(61 * DAY_MS);
    // Calibration check: ~0.33% at two months, against the 0.29%/0.41%
    // half-to-half shifts measured on Cosmos Hub and Akash.
    expect(twoMonths).toBeGreaterThan(0.003);
    expect(twoMonths).toBeLessThan(0.004);
    expect(clock.uncertaintyFraction(DAY_MS)).toBeLessThan(twoMonths);
  });

  test('measuring beats asserting at every horizon', () => {
    const seeded = BlockClock.seeded();
    for (const horizon of [DAY_MS, 30 * DAY_MS, YEAR_MS]) {
      expect(clock.uncertaintyFraction(horizon)).toBeLessThan(
        seeded.uncertaintyFraction(horizon),
      );
    }
  });

  test('a one-year secret is ±7 days, not ±18', () => {
    const target = clock.heightAround(T0 + YEAR_MS);
    const estimate = clock.estimate(target, T0);
    const days = estimate.uncertaintyMs / DAY_MS;
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(8);

    const seededDays =
      (BlockClock.seeded().uncertaintyFraction(YEAR_MS) * YEAR_MS) / DAY_MS;
    expect(Math.round(seededDays)).toBe(18);
  });

  test('an unanchored clock refuses to place a height on a calendar', () => {
    // It does not know what height the chain is at, so both answers would be
    // fabricated: estimate() used to return "now, ± 0" for an arbitrary
    // future height, and heightAround() counted from genesis, not the tip.
    const seeded = BlockClock.seeded();
    expect(seeded.anchored).toBe(false);
    expect(() => seeded.estimate(5_000_000, T0)).toThrow(/needs at least one observed block/);
    expect(() => seeded.heightAround(T0 + YEAR_MS)).toThrow(/needs at least one observed block/);
    // A clock with a sample but too short a baseline is unmeasured yet
    // anchored — it can still place a height, with the wide honest band.
    const shortBaseline = BlockClock.fromSamples([{ height: 500, timeMs: T0 }]);
    expect(shortBaseline.measured).toBe(false);
    expect(shortBaseline.anchored).toBe(true);
    expect(() => shortBaseline.estimate(600, T0)).not.toThrow();
  });

  test('a block already due carries no uncertainty', () => {
    const past = clock.estimate(clock.samples[0].height - 10_000, T0 + YEAR_MS);
    expect(past.uncertaintyMs).toBe(0);
    expect(past.earliest.getTime()).toBe(past.latest.getTime());
  });
});

describe('estimate and inverse', () => {
  const clock = BlockClock.fromSamples(steadyChain(HUB_INTERVAL, 12));

  test('estimate brackets the point estimate symmetrically', () => {
    const anchor = clock.anchor as BlockSample;
    const target = anchor.height + 100_000;
    const e = clock.estimate(target, anchor.timeMs);
    expect(e.at.getTime()).toBe(anchor.timeMs + 100_000 * HUB_INTERVAL);
    expect(e.at.getTime() - e.earliest.getTime()).toBe(e.uncertaintyMs);
    expect(e.latest.getTime() - e.at.getTime()).toBe(e.uncertaintyMs);
    expect(e.measured).toBe(true);
  });

  test('heightAround inverts estimate', () => {
    const anchor = clock.anchor as BlockSample;
    const target = anchor.height + 250_000;
    const at = clock.estimate(target, anchor.timeMs).at.getTime();
    expect(clock.heightAround(at)).toBe(target);
  });

  test('blocksFor and msForBlocks use the measured interval, not the seed', () => {
    expect(clock.blocksFor(DAY_MS)).toBe(Math.round(DAY_MS / HUB_INTERVAL));
    expect(clock.msForBlocks(100)).toBeCloseTo(100 * HUB_INTERVAL, 6);
    expect(clock.blocksFor(1)).toBe(1); // never zero blocks
  });
});

describe('formatUncertainty rounding', () => {
  const clock = BlockClock.fromSamples(steadyChain(HUB_INTERVAL, 12));

  /** A horizon whose band is exactly `ms` wide, for boundary testing. */
  function horizonForBand(targetMs: number): number {
    // band = (err + 0.02 * h/year) * h — solve the quadratic for h.
    const err = clock.uncertaintyFraction(0);
    const a = REGIME_DRIFT_PER_YEAR / YEAR_MS;
    return (-err + Math.sqrt(err * err + 4 * a * targetMs)) / (2 * a);
  }

  test('minutes below an hour, hours below a week, days beyond', () => {
    expect(clock.formatUncertainty(horizonForBand(59 * 60_000))).toMatch(/^± 59 min$/);
    expect(clock.formatUncertainty(horizonForBand(60 * 60_000))).toMatch(/^± 1 hr$/);
    expect(clock.formatUncertainty(horizonForBand(6 * DAY_MS))).toMatch(/^± 144 hrs$/);
    expect(clock.formatUncertainty(horizonForBand(7 * DAY_MS))).toMatch(/^± 7 days$/);
  });

  test('never claims more precision than a minute', () => {
    expect(clock.formatUncertainty(0)).toBe('± 1 min');
    expect(clock.formatUncertainty(60_000)).toBe('± 1 min');
  });

  test('an unmeasured clock quotes the wide band', () => {
    expect(BlockClock.seeded().formatUncertainty(YEAR_MS)).toBe('± 18 days');
  });
});

describe('refreshBlockClock', () => {
  class MemoryStore implements BlockSampleStore {
    constructor(private samples: BlockSample[] = []) {}
    async load(): Promise<BlockSample[]> {
      return this.samples;
    }
    async save(_key: string, samples: BlockSample[]): Promise<void> {
      this.samples = samples;
    }
  }

  /**
   * A chain that serves headers only above `prunedBelow`. Times share
   * steadyChain's origin so a stored window and a live read describe one
   * coherent chain rather than two.
   */
  function node(intervalMs: number, latestHeight: number, prunedBelow = 0) {
    const calls: number[] = [];
    return {
      calls,
      async blockHeader(height?: number) {
        const h = height ?? latestHeight;
        calls.push(h);
        if (h < prunedBelow) {
          throw new Error(`height ${h} is not available, lowest height is ${prunedBelow}`);
        }
        return { height: h, timeMs: T0 + (h - 1_000_000) * intervalMs };
      },
    };
  }

  test('cold start measures via the long-baseline anchor', async () => {
    const rest = node(HUB_INTERVAL, 5_000_000);
    const clock = await refreshBlockClock(rest, new MemoryStore(), 'devnet');
    expect(clock.measured).toBe(true);
    expect(clock.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
    // Latest, the long anchor, then a mid point so the fit has residuals —
    // three calls, not a poll loop.
    expect(rest.calls).toEqual([
      5_000_000,
      5_000_000 - ANCHOR_FALLBACK_BLOCKS[0],
      5_000_000 - Math.round(ANCHOR_FALLBACK_BLOCKS[0] / 2),
    ]);
  });

  test('a pruned node steps down the baseline until one is served', async () => {
    const latest = 5_000_000;
    // Serves only the shortest fallback baseline.
    const shortest = ANCHOR_FALLBACK_BLOCKS[ANCHOR_FALLBACK_BLOCKS.length - 1];
    const rest = node(HUB_INTERVAL, latest, latest - shortest);
    const clock = await refreshBlockClock(rest, new MemoryStore(), 'devnet');
    expect(clock.measured).toBe(true);
    expect(clock.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
    expect(rest.calls.length).toBeGreaterThan(2);
  });

  test('a node pruned below every baseline leaves the clock honest', async () => {
    const latest = 5_000_000;
    const rest = node(HUB_INTERVAL, latest, latest); // serves only the tip
    const clock = await refreshBlockClock(rest, new MemoryStore(), 'devnet');
    expect(clock.measured).toBe(false);
    expect(clock.intervalMs).toBe(BLOCK_TIME_ESTIMATE_MS);
    expect(clock.uncertaintyFraction(YEAR_MS)).toBe(UNMEASURED_UNCERTAINTY_FRACTION);
  });

  test('a halted window is measured honestly, not confidently', async () => {
    // The real failure seen against a devnet that had been asleep: the chain
    // runs at 6 s, but a window spanning the halt averages far slower. The
    // clock cannot know the true rate — but it MUST NOT report a tight band
    // around the wrong one.
    const latest = 5_000_000;
    const halted = {
      async blockHeader(height?: number) {
        const h = height ?? latest;
        // 6 s per block, plus a six-hour halt 2,000 blocks back.
        const base = 1_800_000_000_000 + (h - latest) * 6_000;
        return { height: h, timeMs: h < latest - 2_000 ? base - 6 * 3600_000 : base };
      },
    };
    const clock = await refreshBlockClock(halted, new MemoryStore(), 'devnet');
    expect(clock.measured).toBe(true);
    // The fitted interval is dragged well off the true 6 s by the halt...
    expect(clock.intervalMs).toBeGreaterThan(6_000);
    // ...and the residuals say so: the band is far wider than a steady
    // chain's at the same horizon, instead of hiding the disagreement.
    const steady = BlockClock.fromSamples(steadyChain(6_000, 12));
    expect(clock.uncertaintyFraction(DAY_MS)).toBeGreaterThan(
      10 * steady.uncertaintyFraction(DAY_MS),
    );
  });

  test('a steady chain earns a genuinely tight short-horizon band', async () => {
    const rest = node(HUB_INTERVAL, 5_000_000);
    const clock = await refreshBlockClock(rest, new MemoryStore(), 'devnet');
    // Three collinear points: the measurement term all but vanishes, leaving
    // the regime floor, so a one-day estimate is minutes rather than the
    // seeded clock's 72.
    expect(clock.formatUncertainty(DAY_MS)).toBe('± 1 min');
    // The seeded clock's 5% of a day is 72 min, which the ruled rounding
    // presents as hours — the unit a user can act on.
    expect(BlockClock.seeded().formatUncertainty(DAY_MS)).toBe('± 1 hr');
  });

  test('an unreachable chain falls back to the stored window', async () => {
    const store = new MemoryStore(steadyChain(HUB_INTERVAL, 6));
    const dead = {
      async blockHeader(): Promise<{ height: number; timeMs: number }> {
        throw new Error('REST endpoint unreachable');
      },
    };
    const clock = await refreshBlockClock(dead, store, 'devnet');
    expect(clock.measured).toBe(true);
    expect(clock.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
  });

  test('a stored window is extended and persisted, not replaced', async () => {
    const store = new MemoryStore(steadyChain(HUB_INTERVAL, 4));
    const rest = node(HUB_INTERVAL, 1_000_000 + 3 * 5_000 + 50_000);
    const clock = await refreshBlockClock(rest, store, 'devnet');
    expect(clock.samples.length).toBe(5);
    expect(await store.load()).toHaveLength(5);
    // Already measurable from storage, so no anchor reach-back was needed.
    expect(rest.calls).toHaveLength(1);
  });

  test('windows are per endpoint — a 1 s devnet never pollutes a 6 s chain', async () => {
    const store = new MemoryStore();
    const devnet = node(1_000, 900_000);
    const mainnet = node(HUB_INTERVAL, 5_000_000);
    const perEndpoint = new Map<string, BlockSample[]>();
    const scoped: BlockSampleStore = {
      async load(key) {
        return perEndpoint.get(key) ?? [];
      },
      async save(key, samples) {
        perEndpoint.set(key, samples);
      },
    };
    void store;
    const a = await refreshBlockClock(devnet, scoped, 'http://10.0.2.2:1317');
    const b = await refreshBlockClock(mainnet, scoped, 'https://rest.main.timeflare.io');
    expect(a.intervalMs).toBeCloseTo(1_000, 6);
    expect(b.intervalMs).toBeCloseTo(HUB_INTERVAL, 6);
  });
});
