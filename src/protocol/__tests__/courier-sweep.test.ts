/**
 * Sweeping a funded claim kit's courier into the recipient's own wallet
 * (DONE_WALLET_BOOTSTRAPPING_PLAN §3).
 *
 * The arithmetic is the whole risk surface here: a courier holds so little that
 * the send fee is a material fraction of it, so sweeping the *whole* balance
 * would fail for want of gas and sweeping too little would strand dust in an
 * address nobody will ever look at again.
 */

import { courierSweepAmountUveil } from '../recipient';
import { SEND_FEE_UVEIL } from '../txclient';

describe('courierSweepAmountUveil', () => {
  it('reserves exactly one send fee', () => {
    expect(courierSweepAmountUveil(200_000n)).toBe(200_000n - SEND_FEE_UVEIL);
  });

  it('sweeps nothing from an already-swept courier', () => {
    // A second import must be a no-op, not a failed transaction.
    expect(courierSweepAmountUveil(0n)).toBe(0n);
  });

  it('sweeps nothing when the balance cannot even cover its own fee', () => {
    expect(courierSweepAmountUveil(SEND_FEE_UVEIL)).toBe(0n);
    expect(courierSweepAmountUveil(SEND_FEE_UVEIL - 1n)).toBe(0n);
  });

  it('sweeps the single uveil above the fee rather than rounding it away', () => {
    expect(courierSweepAmountUveil(SEND_FEE_UVEIL + 1n)).toBe(1n);
  });

  it('never returns a negative amount', () => {
    for (const balance of [0n, 1n, 100n, SEND_FEE_UVEIL / 2n]) {
      expect(courierSweepAmountUveil(balance)).toBeGreaterThanOrEqual(0n);
    }
  });

  it('leaves the courier empty, not fee-short, at the plan seed of 0.2 VEIL', () => {
    const seed = 200_000n;
    const swept = courierSweepAmountUveil(seed);
    expect(swept + SEND_FEE_UVEIL).toBe(seed);
    // And what lands must still cover a full rebate collection (23,000 uveil)
    // with room to spare — the reason the seed is 0.2 VEIL and not the exact cost.
    expect(swept).toBeGreaterThan(23_000n * 4n);
  });
});
