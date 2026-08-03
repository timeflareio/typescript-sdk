/**
 * Pins the creator's total debit (creationQuote) — the single figure a client
 * may check a balance against.
 *
 * The defect this guards is not an arithmetic slip but an OMISSION: before
 * this helper existed the mobile client summed pool + accept fees + gas and
 * silently dropped the creation fee, so the user was quoted a number the chain
 * did not charge and the insufficient-funds check passed creators who could
 * not afford the secret. The tests below therefore assert composition — that
 * every charge is present and the parts reconstruct the whole — rather than
 * only re-deriving each component.
 */

import {
  ACCEPT_LEG_UVEIL,
  CREATION_FEE_FLOOR_UVEIL,
  creationQuote,
  creationFeeUveil,
  distributeSharesGas,
  gasFeeUveil,
  MAX_PAYLOAD_CIPHERTEXT_BYTES,
  poolUveil,
  requestGuardiansGas,
  REVEAL_LEG_UVEIL,
  timeComponentUveil,
} from '../constants';

const STANDARD = { distanceBlocks: 432_241, maxShares: 7, bumpHundredths: 100 };
const ONE_HOUR = { distanceBlocks: 841, maxShares: 7, bumpHundredths: 100 };

describe('creationQuote', () => {
  it('includes every charge the chain debits', () => {
    const q = creationQuote(STANDARD);
    // The five charges, each non-zero — the omission this helper exists to stop
    expect(q.poolUveil).toBeGreaterThan(0n);
    expect(q.acceptFeesUveil).toBeGreaterThan(0n);
    expect(q.creationFeeUveil).toBeGreaterThan(0n);
    expect(q.gasPhase1Uveil).toBeGreaterThan(0n);
    expect(q.gasPhase2Uveil).toBeGreaterThan(0n);
  });

  it('totals exactly the sum of its parts', () => {
    const q = creationQuote(STANDARD);
    expect(q.totalUveil).toBe(
      q.poolUveil + q.acceptFeesUveil + q.creationFeeUveil + q.gasPhase1Uveil + q.gasPhase2Uveil,
    );
  });

  it('agrees with the individual pinned estimators', () => {
    const q = creationQuote(STANDARD);
    const time = timeComponentUveil(
      STANDARD.distanceBlocks,
      STANDARD.maxShares,
      STANDARD.bumpHundredths,
    );
    expect(q.timeComponentUveil).toBe(time);
    expect(q.revealLegsUveil).toBe(REVEAL_LEG_UVEIL * BigInt(STANDARD.maxShares));
    expect(q.poolUveil).toBe(
      poolUveil(STANDARD.distanceBlocks, STANDARD.maxShares, STANDARD.bumpHundredths),
    );
    expect(q.acceptFeesUveil).toBe(ACCEPT_LEG_UVEIL * BigInt(STANDARD.maxShares));
    expect(q.creationFeeUveil).toBe(creationFeeUveil(time, STANDARD.distanceBlocks));
  });

  it('separates refundable escrow from what is spent for good', () => {
    const q = creationQuote(STANDARD);
    expect(q.refundableUveil).toBe(q.poolUveil + q.acceptFeesUveil);
    // The creation fee and both gas legs are never refundable, so the gap
    // between the total and the refundable subset is exactly those three.
    expect(q.totalUveil - q.refundableUveil).toBe(
      q.creationFeeUveil + q.gasPhase1Uveil + q.gasPhase2Uveil,
    );
  });

  it('reports the floor regime on a short secret and the curve on a long one', () => {
    // A one-hour secret's time component is tiny, so the flat gas-denominated
    // floor prices it — the whole reason its bill looks large next to its pool.
    const short = creationQuote(ONE_HOUR);
    expect(short.creationFeeRegime).toBe('floor');
    expect(short.creationFeeUveil).toBe(CREATION_FEE_FLOOR_UVEIL);

    const long = creationQuote(STANDARD);
    expect(long.creationFeeRegime).toBe('percent');
    expect(long.creationFeeUveil).toBeGreaterThan(CREATION_FEE_FLOOR_UVEIL);
  });

  it('prices BOTH gas legs from the band, not a flat worst case', () => {
    // Measured on the devnet: phase 1 climbs ~4,400 per selected guardian
    // (selection walks the candidate set and freezes one bond each) and phase 2
    // ~17,200 (one share envelope each). Treating either as flat is what put a
    // wide-band phase 1 out of gas.
    const small = creationQuote({ ...STANDARD, maxShares: 2 });
    const full = creationQuote({ ...STANDARD, maxShares: 32 });
    expect(full.gasPhase1Uveil).toBeGreaterThan(small.gasPhase1Uveil);
    expect(full.gasPhase2Uveil).toBeGreaterThan(small.gasPhase2Uveil);
    expect(full.gasPhase2Uveil).toBe(
      gasFeeUveil(distributeSharesGas(32, MAX_PAYLOAD_CIPHERTEXT_BYTES)),
    );
    expect(small.gasPhase1Uveil).toBe(gasFeeUveil(requestGuardiansGas(2)));
  });

  it('charges the creation fee on the time component, never on the gas cover', () => {
    // The reveal legs and accept fees are a pass-through to guardians; taxing
    // them would route part of every reimbursement to validators and the burn.
    const q = creationQuote(STANDARD);
    expect(q.creationFeeUveil).toBe(creationFeeUveil(q.timeComponentUveil, STANDARD.distanceBlocks));
    expect(q.creationFeeUveil).not.toBe(creationFeeUveil(q.poolUveil, STANDARD.distanceBlocks));
  });

  it('scales the whole bill with the band ceiling', () => {
    // max_shares drives pool, accept fees and phase-2 gas together — the cost
    // consequence a creator must see when they widen the band.
    const narrow = creationQuote({ ...STANDARD, maxShares: 5 });
    const wide = creationQuote({ ...STANDARD, maxShares: 9 });
    expect(wide.poolUveil).toBeGreaterThan(narrow.poolUveil);
    expect(wide.acceptFeesUveil).toBeGreaterThan(narrow.acceptFeesUveil);
    expect(wide.totalUveil).toBeGreaterThan(narrow.totalUveil);
  });
});
