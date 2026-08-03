/**
 * Chain watchers: polling loops over the REST queries. Poll cadence is
 * caller-tunable (fast-block devnets poll quicker than production); every
 * watcher has a hard timeout — no silent forever-loops.
 */

import { Secret } from '../generated/timeflare/secrets/v1/secret';
import { AssignmentStatus, RevealedShare } from '../generated/timeflare/secrets/v1/secret';
import { RestError, TimeflareRestClient } from './rest';

/** The minimal AbortSignal shape (structurally satisfied by AbortSignal). */
export interface AbortLike {
  readonly aborted: boolean;
}

export interface WatchOptions {
  /** Poll interval in ms (default 2000). */
  pollMs?: number;
  /** Hard timeout in ms (default 300000). */
  timeoutMs?: number;
  /** Progress callback, invoked once per poll. */
  onProgress?: (note: string) => void;
  /**
   * Cancellation: once aborted, the watcher stops polling and rejects with
   * WatchAbortedError at the next iteration — a UI that unmounts mid-watch
   * must not leave a poll loop running against the chain.
   */
  signal?: AbortLike;
}

export class WatchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchTimeoutError';
  }
}

export class WatchAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchAbortedError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How many probes in a row may fail to REACH the chain before the watcher
 * gives up and re-throws. One dropped request must not fail a watch over a
 * healthy chain — a seal in flight survives a two-second connection blip —
 * but a persistently unreachable endpoint still surfaces quickly, and every
 * failed attempt burns the same overall deadline a successful one would.
 */
const MAX_CONSECUTIVE_PROBE_FAILURES = 3;

/**
 * Whether a probe failure is worth retrying.
 *
 * Only transport failures are: a dropped connection says nothing about the
 * chain's state, so asking again is the right move. Everything else is an
 * answer — a node-side error, a rejected query, or a probe that deliberately
 * threw because the state it watches has gone terminal — and retrying an
 * answer just delays it by three polls while pretending the connection is the
 * problem.
 */
function isRetryableProbeFailure(error: unknown): boolean {
  return error instanceof RestError && error.isTransport;
}

async function poll<T>(
  describe: string,
  probe: () => Promise<T | undefined>,
  options: WatchOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 300000;
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;
  for (;;) {
    if (options.signal?.aborted) {
      throw new WatchAbortedError(`aborted while waiting for ${describe}`);
    }
    let result: T | undefined;
    try {
      result = await probe();
      consecutiveFailures = 0;
    } catch (error) {
      // The last error is re-thrown (not wrapped in WatchTimeoutError) so the
      // caller sees WHY the chain was unreachable, at the threshold or when
      // the failures have exhausted the deadline — whichever comes first.
      if (!isRetryableProbeFailure(error)) {
        throw error;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_PROBE_FAILURES || Date.now() >= deadline) {
        throw error;
      }
      await sleep(pollMs);
      continue;
    }
    if (result !== undefined) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new WatchTimeoutError(`timed out after ${timeoutMs}ms waiting for ${describe}`);
    }
    await sleep(pollMs);
  }
}

/** Wait until the chain reaches (at least) a target height. */
export async function waitForHeight(
  rest: TimeflareRestClient,
  target: number,
  options?: WatchOptions,
): Promise<number> {
  return poll(
    `height ${target}`,
    async () => {
      const height = await rest.height();
      options?.onProgress?.(`height ${height}/${target}`);
      return height >= target ? height : undefined;
    },
    options,
  );
}

/** Wait until the secret reaches one of the given states. */
export async function waitForState(
  rest: TimeflareRestClient,
  secretId: string,
  states: string[],
  options?: WatchOptions,
): Promise<Secret> {
  return poll(
    `secret ${secretId} to reach ${states.join('/')}`,
    async () => {
      const secret = await rest.secretMeta(secretId);
      if (!secret) return undefined;
      options?.onProgress?.(`state ${secret.state}`);
      return states.includes(secret.state) ? secret : undefined;
    },
    options,
  );
}

/**
 * A poll of the acceptance watch, structured. `onProgress` renders the same
 * facts as a human-readable string; this carries them as data, so a UI can
 * phrase them itself instead of parsing prose.
 */
export interface AcceptanceProgress {
  /** Assignments accepted so far. */
  accepted: number;
  /** The creator's band: activation needs `min`, and `max` is the ceiling. */
  minShares: number;
  maxShares: number;
  /** `accepted >= minShares` — activation at the deadline is now guaranteed. */
  lockedIn: boolean;
  /** The chain's FSM state verbatim. */
  state: string;
}

export interface AcceptanceWatchOptions extends WatchOptions {
  /** Structured per-poll progress, alongside `onProgress`'s string. */
  onAcceptance?: (progress: AcceptanceProgress) => void;
  /**
   * Resolve as soon as lock-in is inferred (`accepted ≥ min_shares`) instead of
   * waiting for activation. Default false.
   *
   * Safe because lock-in is a protocol guarantee, not a guess: acceptances are
   * never revoked, so once the count reaches `min_shares` the count can only
   * hold or grow and the secret is certain to reach `pending` at the deadline
   * (spec.md "Guardian Acceptance"). What a caller gives up is the *final
   * roster* — further guardians may still accept up to `max_shares` — and the
   * activated slim record: the returned secret is still `awaiting_acceptance`.
   *
   * Callers that act on activation (cancel, reveal, anything reading the final
   * accepted set) must leave this off and wait for `pending`.
   */
  resolveOnLockIn?: boolean;
}

/**
 * The acceptance watch (build plan §4.4): poll the assignment records until
 * the secret activates to `pending` — under the [min, max] band that happens
 * at the commit-deadline finalisation, once at least min_shares accepted.
 * Lock-in (accepted ≥ min_shares mid-window) is reported via progress, and
 * with `resolveOnLockIn` it also ends the watch. Terminal states short-circuit
 * with an error either way.
 */
export async function watchAcceptanceUntilPending(
  rest: TimeflareRestClient,
  secretId: string,
  options?: AcceptanceWatchOptions,
): Promise<Secret> {
  return poll(
    options?.resolveOnLockIn
      ? `secret ${secretId} to reach lock-in`
      : `secret ${secretId} acceptance to complete`,
    async () => {
      const [secret, assignments] = await Promise.all([
        rest.secretMeta(secretId),
        rest.secretAssignments(secretId),
      ]);
      if (!secret) return undefined;
      const accepted = assignments.filter(
        (a) => a.status === AssignmentStatus.ASSIGNMENT_STATUS_ACCEPTED,
      ).length;
      const lockedIn = accepted >= secret.minShares;
      options?.onProgress?.(
        `${accepted} accepted (band ${secret.minShares}-${secret.maxShares}${
          lockedIn ? ', locked in' : ''
        }, state ${secret.state})`,
      );
      options?.onAcceptance?.({
        accepted,
        minShares: secret.minShares,
        maxShares: secret.maxShares,
        lockedIn,
        state: secret.state,
      });
      if (['failed', 'cancelled'].includes(secret.state)) {
        throw new Error(`secret ${secretId} went terminal (${secret.state}) before activation`);
      }
      // Activation is checked first: past the deadline the state has moved on
      // regardless, and the activated view is the better answer to return.
      // pending or beyond (fast-block devnets can race straight past)
      if (['pending', 'reconstructable', 'revealed'].includes(secret.state)) {
        return secret;
      }
      return options?.resolveOnLockIn && lockedIn ? secret : undefined;
    },
    options,
  );
}

/**
 * The reveal watch (build plan §4.5): poll the reveal records during the
 * window until ≥ threshold shares are on chain.
 */
export async function watchRevealsUntilThreshold(
  rest: TimeflareRestClient,
  secretId: string,
  threshold: number,
  revealEndBlock: number,
  options?: WatchOptions,
): Promise<RevealedShare[]> {
  return poll(
    `secret ${secretId} to reach ${threshold} reveals`,
    async () => {
      const reveals = await rest.secretReveals(secretId);
      options?.onProgress?.(`${reveals.length}/${threshold} shares revealed`);
      if (reveals.length >= threshold) {
        return reveals;
      }
      const height = await rest.height();
      if (height > revealEndBlock + 10) {
        throw new Error(
          `reveal window closed at ${revealEndBlock} with only ${reveals.length}/${threshold} reveals`,
        );
      }
      return undefined;
    },
    options,
  );
}
