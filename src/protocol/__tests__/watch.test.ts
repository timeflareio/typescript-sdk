/**
 * Watcher polling semantics against a stubbed REST client: resolution,
 * timeout, and cancellation (the app's screens abort watchers on unmount —
 * no poll loop may outlive its screen).
 */
import { Secret } from '../../generated/timeflare/secrets/v1/secret';
import { AssignmentStatus } from '../../generated/timeflare/secrets/v1/secret';
import { RestError, TimeflareRestClient } from '../rest';
import {
  AcceptanceProgress,
  WatchAbortedError,
  WatchTimeoutError,
  waitForState,
  watchAcceptanceUntilPending,
} from '../watch';

function restWithStates(states: (string | null)[]): TimeflareRestClient {
  let call = 0;
  return {
    secretMeta: async () => {
      const state = states[Math.min(call++, states.length - 1)];
      return state === null ? null : ({ state } as Secret);
    },
  } as unknown as TimeflareRestClient;
}

/** Like restWithStates, but a step may be an Error the probe throws instead. */
function restWithFlakyStates(steps: (string | Error)[]): {
  rest: TimeflareRestClient;
  calls: () => number;
} {
  let call = 0;
  const rest = {
    secretMeta: async () => {
      const step = steps[Math.min(call++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return { state: step } as Secret;
    },
  } as unknown as TimeflareRestClient;
  return { rest, calls: () => call };
}

/**
 * One step per poll: the secret's state and how many of its assignments have
 * been accepted. A rejected assignment rides along on every step, so a watcher
 * that counted rows instead of accepted rows would fail these.
 */
function restWithAcceptance(
  steps: { state: string; accepted: number }[],
  band: { minShares: number; maxShares: number } = { minShares: 3, maxShares: 5 },
): TimeflareRestClient {
  let call = 0;
  const step = () => steps[Math.min(call, steps.length - 1)];
  return {
    secretMeta: async () => ({ ...band, state: step().state }) as Secret,
    secretAssignments: async () => {
      const { accepted } = step();
      call++;
      return [
        ...Array.from({ length: accepted }, () => ({
          status: AssignmentStatus.ASSIGNMENT_STATUS_ACCEPTED,
        })),
        { status: AssignmentStatus.ASSIGNMENT_STATUS_REJECTED },
      ];
    },
  } as unknown as TimeflareRestClient;
}

describe('waitForState', () => {
  test('resolves once the secret reaches a wanted state', async () => {
    const rest = restWithStates(['reserved', 'reserved', 'pending']);
    const secret = await waitForState(rest, 's1', ['pending'], { pollMs: 1, timeoutMs: 1000 });
    expect(secret.state).toBe('pending');
  });

  test('times out with WatchTimeoutError when the state never arrives', async () => {
    const rest = restWithStates(['reserved']);
    await expect(
      waitForState(rest, 's1', ['pending'], { pollMs: 1, timeoutMs: 15 }),
    ).rejects.toThrow(WatchTimeoutError);
  });

  test('a pre-aborted signal rejects without polling the chain', async () => {
    let polled = false;
    const rest = {
      secretMeta: async () => {
        polled = true;
        return { state: 'pending' } as Secret;
      },
    } as unknown as TimeflareRestClient;
    await expect(
      waitForState(rest, 's1', ['pending'], { signal: { aborted: true } }),
    ).rejects.toThrow(WatchAbortedError);
    expect(polled).toBe(false);
  });

  test('aborting mid-watch stops the loop at the next iteration', async () => {
    const controller = new AbortController();
    const rest = restWithStates(['reserved']);
    const watch = waitForState(rest, 's1', ['pending'], {
      pollMs: 5,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(watch).rejects.toThrow(WatchAbortedError);
  });
});

describe('probe-failure tolerance', () => {
  const fast = { pollMs: 1, timeoutMs: 1000 };
  // A blip is a TRANSPORT failure — the shape a dropped connection actually
  // produces. Only these are retried: anything else is an answer from the
  // chain, and retrying an answer merely delays it.
  const blip = (message = 'network request failed') => RestError.transportFailure(message);

  test('a single dropped probe does not fail the watch', async () => {
    const { rest } = restWithFlakyStates([blip(), 'pending']);
    const secret = await waitForState(rest, 's1', ['pending'], fast);
    expect(secret.state).toBe('pending');
  });

  test('two consecutive blips survive; the third probe succeeds', async () => {
    const { rest } = restWithFlakyStates([blip(), blip(), 'pending']);
    const secret = await waitForState(rest, 's1', ['pending'], fast);
    expect(secret.state).toBe('pending');
  });

  test('three consecutive failures re-throw the last error', async () => {
    const { rest, calls } = restWithFlakyStates([
      blip('blip one'),
      blip('blip two'),
      blip('blip three'),
      'pending',
    ]);
    await expect(waitForState(rest, 's1', ['pending'], fast)).rejects.toThrow('blip three');
    expect(calls()).toBe(3);
  });

  test('a successful probe resets the failure counter', async () => {
    // Two blips, a clean (non-matching) poll, two more blips: five failures in
    // total but never three in a row — the watch must ride through all of it.
    const { rest } = restWithFlakyStates([blip(), blip(), 'reserved', blip(), blip(), 'pending']);
    const secret = await waitForState(rest, 's1', ['pending'], fast);
    expect(secret.state).toBe('pending');
  });

  test('a non-transport failure is an answer, not a blip — it surfaces at once', async () => {
    // A node-side error or a probe that threw because the state went terminal
    // is information. Riding three polls over it would report the same thing
    // later while implying the connection was at fault.
    const { rest, calls } = restWithFlakyStates([new Error('secret is cancelled'), 'pending']);
    await expect(waitForState(rest, 's1', ['pending'], fast)).rejects.toThrow('secret is cancelled');
    expect(calls()).toBe(1);
  });

  test('failed probes burn the shared deadline rather than extending it', async () => {
    // The deadline expires during the failure run, so the watch gives up with
    // the probe's error BEFORE reaching the three-failure threshold.
    const { rest, calls } = restWithFlakyStates([blip()]);
    await expect(
      waitForState(rest, 's1', ['pending'], { pollMs: 20, timeoutMs: 10 }),
    ).rejects.toThrow('network request failed');
    expect(calls()).toBeLessThan(3);
  });
});

describe('watchAcceptanceUntilPending', () => {
  const fast = { pollMs: 1, timeoutMs: 1000 };

  describe('by default, waits for activation', () => {
    test('lock-in alone does not end the watch — the chain activates at the deadline', async () => {
      // min_shares is 3 and 4 have accepted, so this secret is locked in; the
      // state deliberately stays awaiting_acceptance until finalisation
      // (spec.md "Guardian Acceptance"), and the default watch must respect it.
      const rest = restWithAcceptance([{ state: 'awaiting_acceptance', accepted: 4 }]);
      await expect(
        watchAcceptanceUntilPending(rest, 's1', { pollMs: 1, timeoutMs: 15 }),
      ).rejects.toThrow(WatchTimeoutError);
    });

    test('resolves on activation', async () => {
      const rest = restWithAcceptance([
        { state: 'awaiting_acceptance', accepted: 1 },
        { state: 'awaiting_acceptance', accepted: 4 },
        { state: 'pending', accepted: 4 },
      ]);
      const secret = await watchAcceptanceUntilPending(rest, 's1', fast);
      expect(secret.state).toBe('pending');
    });
  });

  describe('with resolveOnLockIn', () => {
    test('resolves as soon as accepted reaches min_shares, still awaiting_acceptance', async () => {
      const rest = restWithAcceptance([
        { state: 'awaiting_acceptance', accepted: 1 },
        { state: 'awaiting_acceptance', accepted: 3 },
      ]);
      const secret = await watchAcceptanceUntilPending(rest, 's1', {
        ...fast,
        resolveOnLockIn: true,
      });
      // The caller trades the final roster for an early answer: this view is
      // pre-activation by design.
      expect(secret.state).toBe('awaiting_acceptance');
    });

    test('does not resolve below min_shares', async () => {
      const rest = restWithAcceptance([{ state: 'awaiting_acceptance', accepted: 2 }]);
      await expect(
        watchAcceptanceUntilPending(rest, 's1', {
          pollMs: 1,
          timeoutMs: 15,
          resolveOnLockIn: true,
        }),
      ).rejects.toThrow(WatchTimeoutError);
    });

    test('prefers the activated view when the chain has already moved on', async () => {
      // Fast-block devnets can race past the deadline between polls; the
      // activated state is the better answer even when lock-in also holds.
      const rest = restWithAcceptance([{ state: 'pending', accepted: 4 }]);
      const secret = await watchAcceptanceUntilPending(rest, 's1', {
        ...fast,
        resolveOnLockIn: true,
      });
      expect(secret.state).toBe('pending');
    });

    test('a terminal state still short-circuits, even once locked in', async () => {
      const rest = restWithAcceptance([{ state: 'cancelled', accepted: 4 }]);
      await expect(
        watchAcceptanceUntilPending(rest, 's1', { ...fast, resolveOnLockIn: true }),
      ).rejects.toThrow(/went terminal \(cancelled\)/);
    });
  });

  test('progress reports the count, the band and lock-in', async () => {
    const notes: string[] = [];
    const rest = restWithAcceptance([
      { state: 'awaiting_acceptance', accepted: 1 },
      { state: 'pending', accepted: 3 },
    ]);
    await watchAcceptanceUntilPending(rest, 's1', {
      ...fast,
      onProgress: (note) => notes.push(note),
    });
    expect(notes[0]).toBe('1 accepted (band 3-5, state awaiting_acceptance)');
    expect(notes[1]).toBe('3 accepted (band 3-5, locked in, state pending)');
  });

  test('onAcceptance carries the same facts as data, so a UI need not parse prose', async () => {
    const seen: AcceptanceProgress[] = [];
    const rest = restWithAcceptance([
      { state: 'awaiting_acceptance', accepted: 2 },
      { state: 'awaiting_acceptance', accepted: 3 },
    ]);
    await watchAcceptanceUntilPending(rest, 's1', {
      ...fast,
      resolveOnLockIn: true,
      onAcceptance: (p) => seen.push(p),
    });
    expect(seen).toEqual([
      { accepted: 2, minShares: 3, maxShares: 5, lockedIn: false, state: 'awaiting_acceptance' },
      { accepted: 3, minShares: 3, maxShares: 5, lockedIn: true, state: 'awaiting_acceptance' },
    ]);
  });
});
