/**
 * Block height ↔ wall clock, measured rather than assumed.
 *
 * The protocol is denominated in blocks; users think in dates. Converting
 * between them needs the chain's real block interval, and that is NOT the
 * configured one: the actual interval is `timeout_commit` plus round and
 * processing time, all of which move with validator count and load. Cosmos Hub
 * launched assuming 5 s and ran at ~6.5 s — a 30% error that governance had to
 * correct — and today runs at 5.73 s against a nominal 6. So a pinned constant
 * is wrong by an unbounded amount, and no ± drawn around a displaced centre
 * can rescue it.
 *
 * This clock therefore measures. It reads consensus timestamps off block
 * headers (never the device clock, which would bake local skew into every
 * date) and reports an interval plus an *earned* uncertainty:
 *
 * - **Unmeasured** (cold start, still on the seed): 5%. Nothing has been
 *   observed yet, and the Cosmos Hub launch error is the evidence that a wide
 *   band is the honest state.
 * - **Measured**: the statistical error of the mean over the baseline, plus a
 *   regime-drift floor of 2% per year scaled by how far ahead the estimate
 *   reaches. Calibrated against live chains (August 2026): at two months it
 *   predicts 0.33% against the 0.29% and 0.41% shifts measured on Cosmos Hub
 *   and Akash; at a year it gives 2%, above the Hub's ~1.7%/year long-run
 *   drift.
 *
 * Immutable, and pure given its samples — a React context can hold one as
 * state and every dependent surface re-renders when it is replaced.
 */

import { BLOCK_TIME_ESTIMATE_MS } from './constants';

/** One block header reduced to what the clock needs: height and consensus time. */
export interface BlockSample {
  height: number;
  /** CONSENSUS time in ms since epoch — the chain's account, not the device's. */
  timeMs: number;
}

export interface BlockEstimate {
  /** Best estimate of when the target height is reached. */
  at: Date;
  earliest: Date;
  latest: Date;
  /** Half-width of the window, in ms. */
  uncertaintyMs: number;
  /** False while the clock is still on the seed — the band is 5% and coarse. */
  measured: boolean;
}

/** Fractional uncertainty while nothing has been measured (§2.2). */
export const UNMEASURED_UNCERTAINTY_FRACTION = 0.05;

/**
 * Ruled regime-drift floor: 2% per year of horizon (2 August 2026). Not
 * derived — calibrated. Cosmos Hub and Akash moved 0.29% and 0.41% over
 * two-to-five-month windows against the 0.33% this predicts at two months,
 * and the Hub's seven-year drift averages ~1.7%/year against the 2% this
 * gives at one year.
 */
export const REGIME_DRIFT_PER_YEAR = 0.02;

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Shortest baseline worth calling a measurement (§2.1). */
export const MIN_MEASURED_BASELINE_BLOCKS = 1_000;

/** Samples retained per endpoint; the window is a baseline, not a history. */
export const MAX_SAMPLES = 32;

/**
 * Least-squares block interval over the samples, in ms.
 *
 * Ordinary least squares of time against height: the slope IS the interval.
 * With two samples this degenerates to the two-point mean, which is the
 * intended behaviour for a fresh anchor.
 */
function leastSquaresIntervalMs(samples: BlockSample[]): number {
  const n = samples.length;
  const meanH = samples.reduce((s, x) => s + x.height, 0) / n;
  const meanT = samples.reduce((s, x) => s + x.timeMs, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dh = s.height - meanH;
    num += dh * (s.timeMs - meanT);
    den += dh * dh;
  }
  // Every sample at one height carries no interval information.
  return den === 0 ? BLOCK_TIME_ESTIMATE_MS : num / den;
}

/**
 * Fractional standard error of the fitted interval — how much the samples
 * themselves disagree, which is the honest measurement term. Long baselines
 * with steady blocks drive this well under 0.1%; it is never the dominant
 * term, and is included because omitting it would overstate what a two-point
 * anchor knows.
 */
function fractionalStandardError(samples: BlockSample[], intervalMs: number): number {
  const n = samples.length;
  if (n < 3 || intervalMs <= 0) {
    // Two points fit a line exactly, so residuals say nothing at all — the
    // window could contain a halt and look immaculate. Fall back to a
    // baseline-length prior (longer anchor, more trust) rather than claim a
    // precision the sample count cannot support.
    const span = Math.abs(samples[n - 1].height - samples[0].height) || 1;
    return Math.min(UNMEASURED_UNCERTAINTY_FRACTION, 1 / Math.sqrt(span));
  }
  const meanH = samples.reduce((s, x) => s + x.height, 0) / n;
  const meanT = samples.reduce((s, x) => s + x.timeMs, 0) / n;
  const intercept = meanT - intervalMs * meanH;
  let sse = 0;
  let den = 0;
  for (const s of samples) {
    const residual = s.timeMs - (intercept + intervalMs * s.height);
    sse += residual * residual;
    den += (s.height - meanH) ** 2;
  }
  if (den === 0) return UNMEASURED_UNCERTAINTY_FRACTION;
  const slopeStdErr = Math.sqrt(sse / (n - 2) / den);
  return Math.abs(slopeStdErr / intervalMs);
}

/**
 * Drop samples left over from a superseded chain.
 *
 * `make dev-reset` restarts the chain at height 1 behind the same URL, so the
 * persisted window for that endpoint suddenly describes two unrelated chains.
 * Time running BACKWARDS as height increases is the proof: no single chain
 * does that. Everything at or above the first such break belongs to the older,
 * now-dead chain — it sorts to the top and would otherwise never be evicted,
 * pinning the clock to a permanently unmeasurable state (or, once the new
 * chain climbs past those heights, to a confident fit across two chains).
 */
function dropSupersededChain(ordered: BlockSample[]): BlockSample[] {
  // Sorted by height, the RESTARTED chain comes first — its heights begin
  // again near 1 while its timestamps are the most recent — and the dead chain
  // trails it at high heights bearing older times. The break is where time
  // steps backwards, so everything from there upward is what to discard.
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].timeMs < ordered[i - 1].timeMs) {
      return ordered.slice(0, i);
    }
  }
  return ordered;
}

/**
 * Cap the window WITHOUT discarding the baseline.
 *
 * Keeping the newest N would evict the deep anchor first — it is the oldest
 * sample — collapsing a 14,400-block baseline to a few dozen blocks and
 * un-measuring the clock. Worse, the truncated window then gets persisted, so
 * every later refresh re-fetches the anchor only to slice it off again. The
 * oldest sample IS the measurement, so it is always kept and the interior is
 * thinned instead.
 */
function thinPreservingBaseline(ordered: BlockSample[]): BlockSample[] {
  if (ordered.length <= MAX_SAMPLES) return ordered;
  const oldest = ordered[0];
  // Keep the newest MAX_SAMPLES-1 for recency, with the anchor pinned in front.
  return [oldest, ...ordered.slice(-(MAX_SAMPLES - 1))];
}

export class BlockClock {
  private constructor(
    readonly intervalMs: number,
    readonly measured: boolean,
    /** Newest-last, deduplicated by height. */
    readonly samples: readonly BlockSample[],
    private readonly measurementError: number,
  ) {}

  /** No measurement yet: the spec's ~6 s seed, carrying the widest band. */
  static seeded(): BlockClock {
    return new BlockClock(BLOCK_TIME_ESTIMATE_MS, false, [], UNMEASURED_UNCERTAINTY_FRACTION);
  }

  /**
   * Fit a clock to observed headers. A baseline shorter than
   * MIN_MEASURED_BASELINE_BLOCKS is not a measurement — the samples are kept
   * (they may lengthen into one) but the clock stays seeded and says so.
   */
  static fromSamples(samples: readonly BlockSample[]): BlockClock {
    const clean = [...samples]
      .filter((s) => Number.isFinite(s.height) && Number.isFinite(s.timeMs))
      .sort((a, b) => a.height - b.height)
      .filter((s, i, all) => i === 0 || s.height !== all[i - 1].height);
    const ordered = thinPreservingBaseline(dropSupersededChain(clean));
    if (ordered.length < 2) {
      return new BlockClock(
        BLOCK_TIME_ESTIMATE_MS,
        false,
        ordered,
        UNMEASURED_UNCERTAINTY_FRACTION,
      );
    }
    const baseline = ordered[ordered.length - 1].height - ordered[0].height;
    const intervalMs = leastSquaresIntervalMs(ordered);
    // A non-positive fit means the samples are inconsistent (a reset chain, a
    // clock jump); refusing it is better than projecting time backwards.
    if (baseline < MIN_MEASURED_BASELINE_BLOCKS || !(intervalMs > 0)) {
      return new BlockClock(
        BLOCK_TIME_ESTIMATE_MS,
        false,
        ordered,
        UNMEASURED_UNCERTAINTY_FRACTION,
      );
    }
    return new BlockClock(
      intervalMs,
      true,
      ordered,
      fractionalStandardError(ordered, intervalMs),
    );
  }

  /** This clock plus one more observation. */
  withSample(sample: BlockSample): BlockClock {
    return BlockClock.fromSamples([...this.samples, sample]);
  }

  /** The most recent observation, or undefined on a seeded clock. */
  get anchor(): BlockSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /**
   * Fractional uncertainty in the interval when projecting `horizonMs` ahead
   * (§2.2). Unmeasured is a flat 5%; measured is the samples' own error plus
   * the ruled regime floor, which grows with how far ahead we reach.
   */
  uncertaintyFraction(horizonMs: number): number {
    if (!this.measured) return UNMEASURED_UNCERTAINTY_FRACTION;
    const horizonYears = Math.max(0, horizonMs) / YEAR_MS;
    return this.measurementError + REGIME_DRIFT_PER_YEAR * horizonYears;
  }

  /** Estimated wall-clock ms at `targetHeight`, extrapolated from the anchor. */
  private atMs(targetHeight: number, nowMs: number): number {
    const anchor = this.anchor;
    if (anchor === undefined) return nowMs;
    return anchor.timeMs + (targetHeight - anchor.height) * this.intervalMs;
  }

  /**
   * A clock with no sample cannot place a height on a calendar at all: it does
   * not know what height the chain is at. Callers must say so rather than
   * receive a confident-looking answer built from nothing — the seeded clock
   * used to report "now, ± 0" for an arbitrary future height, and a height
   * counted from genesis rather than from the tip.
   */
  private requireAnchor(method: string): BlockSample {
    const anchor = this.anchor;
    if (anchor === undefined) {
      throw new Error(
        `BlockClock.${method} needs at least one observed block; this clock has none ` +
          '(refreshBlockClock has not run, or the chain was unreachable)',
      );
    }
    return anchor;
  }

  /** Whether estimate()/heightAround() can answer — i.e. a block was observed. */
  get anchored(): boolean {
    return this.anchor !== undefined;
  }

  /**
   * When `targetHeight` is reached, with the window earned by §2.2.
   *
   * The horizon is measured from now rather than from the anchor: uncertainty
   * is about the future, and a block already in the past carries none of it.
   */
  estimate(targetHeight: number, nowMs: number = Date.now()): BlockEstimate {
    this.requireAnchor('estimate');
    // Whole milliseconds throughout: a Date holds integral ms, so a fractional
    // band would not survive the round trip and `at − earliest` would stop
    // equalling the uncertainty it is supposed to be.
    const atMs = Math.round(this.atMs(targetHeight, nowMs));
    const horizonMs = Math.max(0, atMs - nowMs);
    const uncertaintyMs = Math.round(this.uncertaintyFraction(horizonMs) * horizonMs);
    return {
      at: new Date(atMs),
      earliest: new Date(atMs - uncertaintyMs),
      latest: new Date(atMs + uncertaintyMs),
      uncertaintyMs,
      measured: this.measured,
    };
  }

  /**
   * Height expected around `targetMs` — the wizard's date → blocks inverse.
   * Measured from the anchor, never from "now": the anchor is the only point
   * at which a height and a time are known to correspond.
   */
  heightAround(targetMs: number): number {
    const anchor = this.requireAnchor('heightAround');
    return Math.round(anchor.height + (targetMs - anchor.timeMs) / this.intervalMs);
  }

  /** Blocks spanning `durationMs` at the measured interval, at least one. */
  blocksFor(durationMs: number): number {
    return Math.max(1, Math.round(durationMs / this.intervalMs));
  }

  /** Wall-clock ms spanned by `blocks` at the measured interval. */
  msForBlocks(blocks: number): number {
    return blocks * this.intervalMs;
  }

  /**
   * "± 40 min" / "± 8 hrs" / "± 7 days" for an estimate `horizonMs` ahead.
   *
   * Rounded to the unit the user can act on — minutes below an hour, hours
   * below a week, days beyond — because a band is a planning aid, and
   * "± 18.2 days" claims a precision the underlying guess does not have.
   */
  formatUncertainty(horizonMs: number): string {
    const ms = this.uncertaintyFraction(horizonMs) * Math.max(0, horizonMs);
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return `± ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24 * 7) return `± ${hours} ${hours === 1 ? 'hr' : 'hrs'}`;
    const days = Math.round(hours / 24);
    return `± ${days} ${days === 1 ? 'day' : 'days'}`;
  }
}

/** Persistence seam: kv-backed in the app, in-memory under test. */
export interface BlockSampleStore {
  load(endpointKey: string): Promise<BlockSample[]>;
  save(endpointKey: string, samples: BlockSample[]): Promise<void>;
}

/** What `refreshBlockClock` needs of a REST client — the header query alone. */
export interface BlockHeaderSource {
  blockHeader(height?: number): Promise<{ height: number; timeMs: number }>;
}

/**
 * Baseline the anchor reaches for: ~1 day of blocks at the seed interval.
 * Long enough to average out per-block jitter, short enough that a node with
 * even modest retention still holds it.
 */
export const ANCHOR_TARGET_BLOCKS = Math.round((24 * 60 * 60 * 1000) / BLOCK_TIME_ESTIMATE_MS);

/**
 * Anchor baselines tried in order, longest first; a pruned node pushes us down
 * the list. Nothing below MIN_MEASURED_BASELINE_BLOCKS appears: reaching for a
 * baseline the clock would then refuse to call a measurement spends a round
 * trip to learn nothing.
 */
export const ANCHOR_FALLBACK_BLOCKS = [
  ...new Set(
    [
      ANCHOR_TARGET_BLOCKS,
      Math.round(ANCHOR_TARGET_BLOCKS / 4),
      Math.round(ANCHOR_TARGET_BLOCKS / 16),
      MIN_MEASURED_BASELINE_BLOCKS,
    ].filter((blocks) => blocks >= MIN_MEASURED_BASELINE_BLOCKS),
  ),
].sort((a, b) => b - a);

/**
 * Measure the chain directly, with no persistence — the anchor walk on its own.
 *
 * Exists for callers that must not proceed on the seed: sealing converts the
 * creator's chosen date into an on-chain reveal HEIGHT, so an unmeasured clock
 * there does not mislabel a date, it commits the secret to the wrong block. An
 * app that launched while the node was unreachable holds a seeded clock for
 * the whole session, and by seal time it is demonstrably online — so the seal
 * measures rather than inherit that.
 *
 * `existing` contributes any samples already held. Returns the best clock it
 * can build, seeded and openly unmeasured if the chain will not answer.
 */
export async function measureBlockClock(
  rest: BlockHeaderSource,
  existing: BlockClock = BlockClock.seeded(),
): Promise<BlockClock> {
  const samples = [...existing.samples];
  let latest: BlockSample;
  try {
    latest = await rest.blockHeader();
  } catch {
    return BlockClock.fromSamples(samples);
  }
  samples.push(latest);
  let clock = BlockClock.fromSamples(samples);
  if (clock.measured) return clock;

  for (const back of ANCHOR_FALLBACK_BLOCKS) {
    const height = latest.height - back;
    if (height < 1) continue;
    try {
      samples.push(await rest.blockHeader(height));
    } catch {
      // Pruned below this height — try a shorter baseline.
      continue;
    }
    // A MID-baseline third point, because two points cannot disagree: any
    // pair fits a line exactly, so a window containing a chain halt (or a
    // laptop asleep on a devnet) yields a wildly wrong interval reported
    // with a confident band. Observed for real against a halted devnet,
    // which read 21.5 s for a 6 s chain. A third point makes the residual
    // visible, so an unrepresentative baseline widens the band instead of
    // lying about it. Best-effort: its absence costs honesty, not function.
    const mid = latest.height - Math.round(back / 2);
    if (mid > height && mid < latest.height) {
      try {
        samples.push(await rest.blockHeader(mid));
      } catch {
        // Leave the two-point fit; fromSamples falls back to its prior.
      }
    }
    clock = BlockClock.fromSamples(samples);
    break;
  }
  return clock;
}

/**
 * Read the chain and return a clock for it, persisting the widened window.
 *
 * Always reads the latest header; then, when the stored window is too short to
 * be a measurement on its own, reaches back for a long-baseline anchor. Pruned
 * nodes are the normal case rather than the exception — ours will prune too —
 * so a refused height steps down the baseline list instead of failing.
 *
 * Every failure mode degrades to "fewer samples", never to a throw: a date
 * with a wide honest band beats no date at all, and the seeded clock says
 * plainly that it has measured nothing.
 */
export async function refreshBlockClock(
  rest: BlockHeaderSource,
  store: BlockSampleStore,
  endpointKey: string,
): Promise<BlockClock> {
  let stored: BlockSample[] = [];
  try {
    stored = await store.load(endpointKey);
  } catch {
    // An unreadable window is a cold start, not a failure.
  }

  // One anchor walk, shared with the seal path, so the two cannot drift.
  const clock = await measureBlockClock(rest, BlockClock.fromSamples(stored));

  try {
    await store.save(endpointKey, [...clock.samples]);
  } catch {
    // A window that cannot be persisted still serves this session.
  }
  return clock;
}
