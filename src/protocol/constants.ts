/**
 * Pinned v1 protocol constants — the client-side mirror of
 * x/secrets/types/constants.go.
 *
 * The chain's economic constants are compile-time immutable BY DESIGN: there
 * is no Params state, no MsgUpdateParams, and no query that returns them
 * (spec.md "Economic Parameters"). Clients therefore ship this pinned copy
 * and keep it honest across chain upgrades via the shared economics vector
 * discipline (alignment plan §7 Q4 ruling, July 2026): a vectors file
 * asserted by both the chain's Go tests and this package's TS tests, plus a
 * node-version check at connect that blocks sealing on mismatch.
 *
 * Values are v1 (spec.md "Economic Parameters", provisional ~6-second
 * blocks). If you are editing these outside a coordinated chain upgrade,
 * stop.
 */

/**
 * The chain's bech32 account-address prefix.
 *
 * Kept here rather than beside the tx client because it is a fact about the
 * chain, not about signing: the URI conventions validate addresses with it and
 * must not drag a Stargate client into every consumer that parses a link.
 */
export const CHAIN_PREFIX = 'tmflr';

/** 1 VEIL = 1,000,000 uveil. */
export const UVEIL_PER_VEIL = 1_000_000n;

// ── Economics ────────────────────────────────────────────────────────────────

/** Master reward price: uveil per guardian per block. */
export const RATE_UVEIL = 1n;
/** Guardian entry fee (rides the 90/10 fee split — 90% to validators, 10% burned): 1,000 VEIL in uveil. */
export const ENTRY_FEE_UVEIL = 1_000n * UVEIL_PER_VEIL;
/**
 * Consensus-enforced minimum gas price, as the integer fraction
 * MIN_GAS_PRICE_UVEIL_NUM / MIN_GAS_PRICE_UVEIL_DEN uveil per gas (0.1).
 * The ante chain rejects any tx paying under ⌈gas × num ÷ den⌉ uveil in
 * both CheckTx and DeliverTx — protocol law, not node configuration.
 */
export const MIN_GAS_PRICE_UVEIL_NUM = 1n;
export const MIN_GAS_PRICE_UVEIL_DEN = 10n;
/**
 * Creation fee (July 2026 — spec.md "Creation Fee"): a non-refundable fee
 * charged at MsgUserRequestGuardians on top of the escrowed pool P. The
 * percentage curve falls linearly from CREATION_FEE_MAX_BPS at zero
 * distance to CREATION_FEE_MIN_BPS at CREATION_FEE_CURVE_END_BLOCKS, flat
 * beyond; the floor is CREATION_FEE_FLOOR_GAS priced at the consensus gas
 * floor (60,000 uveil). The fee never enters escrow — no refund path
 * returns it.
 */
export const CREATION_FEE_MAX_BPS = 1_000n;
export const CREATION_FEE_MIN_BPS = 500n;
export const CREATION_FEE_CURVE_END_BLOCKS = 432_000n;
export const CREATION_FEE_FLOOR_GAS = 600_000n;
export const CREATION_FEE_FLOOR_UVEIL =
  (CREATION_FEE_FLOOR_GAS * MIN_GAS_PRICE_UVEIL_NUM + MIN_GAS_PRICE_UVEIL_DEN - 1n) /
  MIN_GAS_PRICE_UVEIL_DEN;

/**
 * A guardian's cost of doing the job, denominated in GAS and priced at the
 * consensus floor — the two transactions it must send. The creator funds both:
 * the accept leg in the secret's accept_fees, the reveal leg inside the pool.
 * Mirrors x/secrets/types.GuardianAcceptGas / GuardianRevealGas.
 */
export const GUARDIAN_ACCEPT_GAS = 120_000n;
export const GUARDIAN_REVEAL_GAS = 130_000n;
export const ACCEPT_LEG_UVEIL =
  (GUARDIAN_ACCEPT_GAS * MIN_GAS_PRICE_UVEIL_NUM + MIN_GAS_PRICE_UVEIL_DEN - 1n) /
  MIN_GAS_PRICE_UVEIL_DEN;
export const REVEAL_LEG_UVEIL =
  (GUARDIAN_REVEAL_GAS * MIN_GAS_PRICE_UVEIL_NUM + MIN_GAS_PRICE_UVEIL_DEN - 1n) /
  MIN_GAS_PRICE_UVEIL_DEN;
/**
 * bump is fixed-point with 2 decimals: stored hundredths ∈ [100, 1000].
 * BUMP_SCALE_HUNDREDTHS mirrors the chain's `BumpScale` — the divisor every
 * bump-scaled amount is normalised by (and the same scale the per-guardian
 * bond multiplier k reuses).
 */
export const BUMP_SCALE_HUNDREDTHS = 100;
export const BUMP_MIN_HUNDREDTHS = 100;
export const BUMP_MAX_HUNDREDTHS = 1000;
/**
 * Per-guardian bond multiplier k (dynamic bond economics, July 2026): a live
 * per-guardian reputation value in the same hundredths fixed point as bump.
 * New registrants start at the floor; ×1.26 per slash (ceiling-clamped),
 * ×0.963 per correct reveal (floor-clamped), truncating integer arithmetic.
 * The k frozen into a secret's bonds is each guardian's value at selection.
 */
export const BOND_K_MIN_HUNDREDTHS = 400;
export const BOND_K_MAX_HUNDREDTHS = 2400;
export const BOND_K_INITIAL_HUNDREDTHS = BOND_K_MIN_HUNDREDTHS;
/** No-reveal bond split (percent): burned / to creator / remainder returned. */
export const NO_REVEAL_SPLIT = { burnPct: 40, creatorPct: 10, returnedPct: 50 } as const;
/** Early-reveal bond split (percent): burned / to creator / remainder to reporter. */
export const EARLY_REVEAL_SPLIT = { burnPct: 40, creatorPct: 10, reporterPct: 50 } as const;

// ── Message validation bounds ────────────────────────────────────────────────

export const THRESHOLD_MIN = 2;
export const THRESHOLD_MAX = 16;
/** Band floor minimum (mirror of MinShares). */
export const SHARES_MIN = 2;
/** Absolute band ceiling — the SSS total (mirror of MaxTotalShares). */
export const MAX_TOTAL_SHARES = 32;
/**
 * The fixed commit window (mirror of CommitTimeoutBlocks). Not a dial: the
 * chain sets commit_deadline = creation height + this, on every secret.
 */
export const COMMIT_TIMEOUT_BLOCKS = 50;
/** The activation buffer between the commit deadline and the reveal window. */
export const REVEAL_START_OFFSET_BUFFER_BLOCKS = 50;
/**
 * The reveal offset floor — the commit window plus the buffer. A constant,
 * because the commit window no longer varies per secret.
 */
export const REVEAL_START_OFFSET_MIN_BLOCKS =
  COMMIT_TIMEOUT_BLOCKS + REVEAL_START_OFFSET_BUFFER_BLOCKS;
export const REVEAL_DURATION_MIN_BLOCKS = 100;
export const REVEAL_DURATION_MAX_BLOCKS = 14_400;
/** H — reveal_end_block ≤ created_at + H (≈ 1 year at ~6 s blocks). */
export const MAX_REVEAL_HORIZON_BLOCKS = 5_256_000;
/** Payload caps: plaintext input / stored ciphertext (two 60 B layers). */
export const MAX_PAYLOAD_PLAINTEXT_BYTES = 4_096;
export const MAX_PAYLOAD_CIPHERTEXT_BYTES = 4_216;
/** The per-secret public key is a fixed-width X25519 key. */
export const SECRET_PUBLIC_KEY_BYTES = 32;

// ── Retention and rebate collection ──────────────────────────────────────────

/**
 * How long a terminal secret's remaining records (reveal records, payload
 * ciphertext, slim record) stay in state after terminal_at: ~6 months at
 * ~6 s blocks (mirror of RetentionBlocks). Past terminal_at + this only the
 * permanent tombstone survives, so any client promise to reconstruct or
 * verify later must be graded against this height, never a wall clock.
 * Devnets may run a shorter window via the chain's test-only override;
 * this mirror is the protocol value.
 */
export const RETENTION_BLOCKS = 2_592_000;
/**
 * How long a credited rebate stays collectable after the settlement that
 * credited it: ~3 months at ~6 s blocks (mirror of RebateCollectionBlocks).
 * The last collectable height is terminal_at + this; after it the rebate is
 * void and its reservation returns to the pool. Deliberately below
 * RETENTION_BLOCKS — the proof of recipiency is verified against the
 * detection hint, which pruning takes with it — and the chain clamps the
 * live window to the retention value so the ordering holds by construction.
 */
export const REBATE_COLLECTION_BLOCKS = 1_296_000;

// ── Estimation (explicitly heuristic, never protocol truth) ─────────────────

/**
 * Spec Network Configuration: "~6 seconds" — an estimate, not a guarantee.
 *
 * COLD-START SEED ONLY: reach it through `BlockClock.seeded()`, never
 * directly. A chain's real interval is a property of the running network, not
 * of this constant, and the two diverge badly enough to matter — Cosmos Hub
 * launched assuming 5 s and ran at ~6.5 s, a 30% error governance had to
 * correct, and today runs at 5.73 s against a nominal 6. A date derived from
 * this number rather than from a measurement is wrong by an unbounded amount,
 * which is why `BlockClock` reports its widest uncertainty for as long as it
 * is still relying on the seed.
 */
export const BLOCK_TIME_ESTIMATE_MS = 6_000;

// ── Derived quantities (spec "Economic Parameters") ─────────────────────────

/**
 * Per-secret bond per guardian: B = rate × distance × bump × k, anchored to
 * the secret's own duration and priced by the guardian's live k (defaults to
 * the registration floor — the value every fresh guardian carries). The
 * authoritative amounts are the per-guardian bonds frozen on the secret at
 * selection (SecretView.guardianBondAmounts); this is the client-side
 * estimator for pre-creation display.
 */
export function bondUveil(
  distanceBlocks: number | bigint,
  bumpHundredths: number,
  kHundredths: number = BOND_K_INITIAL_HUNDREDTHS,
): bigint {
  return (
    (RATE_UVEIL * BigInt(distanceBlocks) * BigInt(bumpHundredths) * BigInt(kHundredths)) / 10_000n
  );
}

/**
 * The pool's time component: P_time = rate × distance × max_shares × bump,
 * where distance runs from commit_deadline to settlement (reveal_end_block +
 * 1) — it includes the reveal window and excludes the commit window. This is
 * the wage for holding a share, and the base the creation-fee curve prices.
 */
export function timeComponentUveil(
  distanceBlocks: number | bigint,
  maxShares: number,
  bumpHundredths: number,
): bigint {
  return (
    (RATE_UVEIL * BigInt(distanceBlocks) * BigInt(maxShares) * BigInt(bumpHundredths)) / 100n
  );
}

/**
 * Reward pool: P = max_shares × F_reveal + P_time. The pool prices both halves
 * of what a guardian gives up — the reveal transaction, whose gas is the same
 * at every distance, and the time it holds the share — so completing the job
 * never costs a guardian money. It prices the band ceiling and is fixed:
 * unfilled slots are never refunded.
 */
export function poolUveil(
  distanceBlocks: number | bigint,
  maxShares: number,
  bumpHundredths: number,
): bigint {
  return (
    REVEAL_LEG_UVEIL * BigInt(maxShares) +
    timeComponentUveil(distanceBlocks, maxShares, bumpHundredths)
  );
}

/**
 * Acceptance reimbursement: A = max_shares × F_accept, escrowed ALONGSIDE but
 * separately from the pool. Distributed at the secret's terminal state to the
 * guardians that did the job asked of them; unearned slices refund to the
 * creator. Not scaled by bump — gas does not get more expensive because more
 * security was bought.
 */
export function acceptFeesUveil(maxShares: number): bigint {
  return ACCEPT_LEG_UVEIL * BigInt(maxShares);
}

/**
 * On-chain cancellation wage per honest active guardian, derived from the
 * stored pool exactly as the chain does (floored per guardian):
 * P × elapsed ÷ (distance × max_shares). The max_shares denominator keeps
 * the per-guardian wage constant regardless of how many accepted — unfilled
 * band slots refund to the creator in the unearned remainder.
 */
export function cancelWagePerGuardianUveil(
  storedPoolUveil: bigint,
  elapsedBlocks: number | bigint,
  distanceBlocks: number | bigint,
  maxShares: number,
): bigint {
  const elapsed = BigInt(elapsedBlocks) < 0n ? 0n : BigInt(elapsedBlocks);
  return (storedPoolUveil * elapsed) / (BigInt(distanceBlocks) * BigInt(maxShares));
}

/**
 * Non-refundable creation fee charged at MsgUserRequestGuardians, mirroring
 * the chain's truncating integer arithmetic exactly
 * (x/secrets/types.CreationFee):
 *
 *   bps(d) = maxBps − (maxBps − minBps) × min(d, curveEnd) ÷ curveEnd
 *   fee    = max(floor, P_time × bps(d) ÷ 10,000)
 *
 * Charged on the pool's TIME component — never on the gas reimbursements the
 * creator also funds, which are a pass-through rather than part of what a
 * selection draw is worth.
 *
 * The creator's total Phase-1 debit is poolUveil(...) + acceptFeesUveil(...)
 * + creationFeeUveil(...) + gas.
 */
export function creationFeeUveil(
  timeComponentUveilAmount: bigint,
  distanceBlocks: number | bigint,
): bigint {
  let d = BigInt(distanceBlocks);
  if (d < 0n) d = 0n;
  if (d > CREATION_FEE_CURVE_END_BLOCKS) d = CREATION_FEE_CURVE_END_BLOCKS;
  const bps =
    CREATION_FEE_MAX_BPS -
    ((CREATION_FEE_MAX_BPS - CREATION_FEE_MIN_BPS) * d) / CREATION_FEE_CURVE_END_BLOCKS;
  const curve = (timeComponentUveilAmount * bps) / 10_000n;
  return curve > CREATION_FEE_FLOOR_UVEIL ? curve : CREATION_FEE_FLOOR_UVEIL;
}

// ── Transaction gas ──────────────────────────────────────────────────────────

/**
 * Declared gas per creator transaction.
 *
 * Deterministic by design, never simulated: Cosmos charges the DECLARED gas
 * limit rather than the gas consumed, and a wallet must be able to quote the
 * exact number before the user signs. Simulation would forfeit that, so these
 * are measured constants with headroom.
 *
 * BOTH phases scale with the band, which a flat figure cannot express. Phase 1
 * walks the candidate set and freezes one bond per selected guardian; phase 2
 * carries one encrypted share envelope each, plus the payload stored once. The
 * coefficients below are fitted to a devnet sweep across the whole band at two
 * payload sizes (testdata/vectors/tx_gas.json), which came out almost exactly
 * linear in both variables:
 *
 *   phase 1 ≈ 133,402 + 4,336 × max_shares   (40 eligible guardians, July 2026)
 *   phase 2 ≈  72,166 + 17,160 × max_shares + 40 × ciphertext_bytes
 *
 * Declared values carry ~25% over those fits.
 *
 * ⚠️ The phase-1 base is NOT band-independent *or* network-independent. It
 * covers candidate enumeration, which reads the ELIGIBLE guardian set: 360 gas
 * each, measured at 40. The model treats that as constant, so the margin is
 * finite headroom rather than immunity — phase 1 begins aborting out of gas once
 * the eligible set passes roughly 139 guardians at max_shares = 2, 154 at 7, and
 * 228 at 32.
 *
 * Band for band that is a 2.2–2.9× improvement on the walk it replaced (2,092
 * gas per REGISTERED guardian, boundary at 62–78 against the 250,000 + 5,500
 * model declared then). Deliberately not quoted as the 5.8× drop in per-guardian
 * cost: the same live re-measurement lowered the declared base by a third, so
 * absolute headroom shrank as the slope fell. The change of driver is the larger
 * win — healthy participation rather than dead registrations piling up forever,
 * since registrations that cannot be selected now cost nothing at all. It is not
 * a closed problem.
 *
 * Do NOT widen the margin to buy room: Cosmos charges the declared limit, so
 * that taxes every creator today to defer a boundary. The fix is for the
 * declaration to scale with the eligible count. Query/Guardians already returns
 * every field the predicate needs, but there is no eligible-count query and no
 * server-side filter, so the client must page the registry and filter itself.
 * A model change needing its own plan.
 *
 * Pinned by `gas-model.test.ts`, which fails in BOTH directions — under 1.1×
 * a measured point (the transaction would abort) and over 1.6× (the creator is
 * being overcharged). Re-measuring means a live-chain sweep, as the vectors'
 * `basis` fields insist; it cannot be done by arithmetic here.
 */
export const REQUEST_GUARDIANS_GAS_BASE = 167_000n;
const REQUEST_GUARDIANS_PER_SHARE_GAS = 5_400n;
const DISTRIBUTE_SHARES_BASE_GAS = 95_000n;
const DISTRIBUTE_SHARES_PER_SHARE_GAS = 21_500n;
const DISTRIBUTE_SHARES_PER_BYTE_GAS = 50n;
const CANCEL_SECRET_BASE_GAS = 120_000n;
const CANCEL_SECRET_PER_GUARDIAN_GAS = 80_000n;
// Rebate collection (spec.md "Recipient Rebate"): the commitment is one store
// write; the reveal is a SHA256 check, a store delete and one coin transfer.
// Generous relative to the work, because under-declaring aborts a collection
// while over-declaring only wastes a fraction of a uveil.
const COMMIT_REBATE_GAS = 90_000n;
const COLLECT_REBATE_GAS = 140_000n;

/**
 * Phase 1 declared gas. Scales with the band: selection walks the candidate
 * set and freezes one bond per guardian, so it is NOT band-independent as a
 * flat figure would imply.
 */
export function requestGuardiansGas(maxShares: number = Number(MAX_TOTAL_SHARES)): bigint {
  return REQUEST_GUARDIANS_GAS_BASE + REQUEST_GUARDIANS_PER_SHARE_GAS * BigInt(maxShares);
}

/**
 * Cancel declared gas.
 *
 * Cancelling is NOT a flat state transition, though it reads like one: the
 * handler walks the active guardians twice — once paying each a pro-rata wage
 * for the blocks it held, once returning each bond — so its cost is
 * proportional to how many accepted. Measured against a real chain at ~61,800
 * gas per active guardian, which dwarfs the ~90,700 base: a 32-guardian cancel
 * costs 2,067,532 gas where a 2-guardian one costs 214,281.
 *
 * Measure this one against a CHAIN, never the keeper test harness. The harness
 * injects a mock bank keeper, so the coin transfers this handler makes per
 * guardian cost almost nothing there — it read ~45% low and shipped an
 * out-of-gas defect twice before that was understood.
 *
 * `activeGuardians` defaults to the band ceiling because the caller may not
 * know the accepted count, and over-declaring only wastes gas while
 * under-declaring aborts the cancellation. Pass the real count when it is
 * known — on a small band it is the difference between 0.14 and 0.01 VEIL.
 */
export function cancelSecretGas(
  activeGuardians: number = Number(MAX_TOTAL_SHARES),
): bigint {
  return CANCEL_SECRET_BASE_GAS + CANCEL_SECRET_PER_GUARDIAN_GAS * BigInt(activeGuardians);
}

/**
 * Rebate collection is two flat-cost transactions: the commitment is one small
 * store write, and the reveal is a hash check plus one coin transfer. Neither
 * scales with anything, so both are constants rather than functions of a band.
 */
export function commitRebateGas(): bigint {
  return COMMIT_REBATE_GAS;
}

export function collectRebateGas(): bigint {
  return COLLECT_REBATE_GAS;
}

/**
 * What collecting a rebate costs in fees, both transactions together — paid
 * BEFORE the rebate arrives, which is why a wallet with nothing in it cannot
 * collect at all.
 *
 * Derived rather than written down so a gas retune moves every figure built on
 * it (the sponsor ask a recipient shows, and the courier seed a sender pays)
 * instead of leaving stale numbers that quietly under-fund people.
 */
export function rebateCollectionCostUveil(): bigint {
  return gasFeeUveil(commitRebateGas()) + gasFeeUveil(collectRebateGas());
}

/** Headroom over the bare cost: absorbs a retry of either step, and a node priced above the floor. */
export const REBATE_FUNDING_MULTIPLE = 4n;

function roundUpTo(value: bigint, granularity: bigint): bigint {
  return ((value + granularity - 1n) / granularity) * granularity;
}

/**
 * What to ask a sponsor for when a wallet cannot pay its own collection:
 * the cost with headroom, rounded to a figure a person can say out loud.
 */
export function sponsorAskUveil(): bigint {
  return roundUpTo(rebateCollectionCostUveil() * REBATE_FUNDING_MULTIPLE, 10_000n);
}

/**
 * What a sender seeds a funded claim kit's courier with.
 *
 * The sponsor ask is what must SURVIVE the sweep, so the seed carries one send
 * fee on top — sweeping the whole balance would fail for want of gas. Rounded to
 * 0.1 VEIL, which at today's constants gives 0.2 VEIL.
 */
export function courierSeedUveil(): bigint {
  return roundUpTo(sponsorAskUveil() + gasFeeUveil(SEND_GAS_FOR_SEED), 100_000n);
}

/** Mirrors txclient's SEND_GAS; declared here so this module stays import-free of it. */
const SEND_GAS_FOR_SEED = 200_000n;

/**
 * Phase 2 declared gas: base + per-share envelope + per-byte payload.
 * `payloadCiphertextBytes` is the stored ciphertext length, bounded by
 * MAX_PAYLOAD_CIPHERTEXT_BYTES.
 */
export function distributeSharesGas(
  maxShares: number,
  payloadCiphertextBytes: number = MAX_PAYLOAD_CIPHERTEXT_BYTES,
): bigint {
  return (
    DISTRIBUTE_SHARES_BASE_GAS +
    DISTRIBUTE_SHARES_PER_SHARE_GAS * BigInt(maxShares) +
    DISTRIBUTE_SHARES_PER_BYTE_GAS * BigInt(payloadCiphertextBytes)
  );
}

/**
 * Gas price expressed in TENTHS of a uveil per gas — the consensus floor is
 * exactly 1 (0.1 uveil/gas), so the floor is representable as an integer and
 * no price below it can be expressed by construction.
 *
 * Paying above the floor buys mempool priority on a congested chain. It cannot
 * break anything: the ante chain only ever rejects paying LESS. A guardian's
 * reimbursement is denominated at the floor, so a creator raising their own
 * price affects only their own two transactions.
 */
export const MIN_GAS_PRICE_TENTHS = 1;

/** The fee a declared gas limit costs, at the floor price or above it. */
export function gasFeeUveil(gas: bigint, priceTenths: number = MIN_GAS_PRICE_TENTHS): bigint {
  const tenths = BigInt(Math.max(MIN_GAS_PRICE_TENTHS, Math.floor(priceTenths)));
  return (gas * tenths + MIN_GAS_PRICE_UVEIL_DEN - 1n) / MIN_GAS_PRICE_UVEIL_DEN;
}

// ── The creator's total debit ────────────────────────────────────────────────

/** Which side of the creation fee's `max()` priced this secret. */
export type CreationFeeRegime = 'floor' | 'percent';

/**
 * Every charge a creator incurs to seal a secret, and their sum.
 *
 * Assembled here, once, because assembling it per call site is how the
 * creation fee came to be missing from the mobile quote while the chain
 * charged it anyway — a client that under-quotes has the user paying a number
 * they never saw, and a sufficiency check computed from a subtotal passes
 * creators who cannot actually afford the secret.
 *
 * `refundable` is the honest framing of what a creator is committing: pool and
 * accept fees are ESCROW and can come back (pro-rata on cancellation, in full
 * if nobody reveals); the creation fee and the gas never do.
 */
export interface CreationQuote {
  /** Wage base — the only component the creation-fee percentage is charged on. */
  timeComponentUveil: bigint;
  /** max_shares × F_reveal, riding inside the pool. */
  revealLegsUveil: bigint;
  /** P = revealLegs + timeComponent. Escrowed, refundable. */
  poolUveil: bigint;
  /** A = max_shares × F_accept. Escrowed alongside P, refundable. */
  acceptFeesUveil: bigint;
  /** Non-refundable; rides the fee collector's 90/10 split. */
  creationFeeUveil: bigint;
  creationFeeRegime: CreationFeeRegime;
  gasPhase1Uveil: bigint;
  gasPhase2Uveil: bigint;
  /** The sum, and the ONLY figure a sufficiency check may be computed from. */
  totalUveil: bigint;
  /** The refundable subset, for honest presentation — never a sufficiency base. */
  refundableUveil: bigint;
}

export function creationQuote(params: {
  distanceBlocks: number | bigint;
  maxShares: number;
  bumpHundredths: number;
  payloadCiphertextBytes?: number;
  /** Gas price in tenths of a uveil; defaults to the consensus floor. */
  gasPriceTenths?: number;
}): CreationQuote {
  const { distanceBlocks, maxShares, bumpHundredths } = params;
  const timeComponent = timeComponentUveil(distanceBlocks, maxShares, bumpHundredths);
  const revealLegs = REVEAL_LEG_UVEIL * BigInt(maxShares);
  const pool = revealLegs + timeComponent;
  const acceptFees = acceptFeesUveil(maxShares);
  const creationFee = creationFeeUveil(timeComponent, distanceBlocks);
  const priceTenths = params.gasPriceTenths ?? MIN_GAS_PRICE_TENTHS;
  const gasPhase1 = gasFeeUveil(requestGuardiansGas(maxShares), priceTenths);
  const gasPhase2 = gasFeeUveil(
    distributeSharesGas(maxShares, params.payloadCiphertextBytes ?? MAX_PAYLOAD_CIPHERTEXT_BYTES),
    priceTenths,
  );
  return {
    timeComponentUveil: timeComponent,
    revealLegsUveil: revealLegs,
    poolUveil: pool,
    acceptFeesUveil: acceptFees,
    creationFeeUveil: creationFee,
    creationFeeRegime: creationFeeIsFloorPriced(timeComponent, distanceBlocks)
      ? 'floor'
      : 'percent',
    gasPhase1Uveil: gasPhase1,
    gasPhase2Uveil: gasPhase2,
    totalUveil: pool + acceptFees + creationFee + gasPhase1 + gasPhase2,
    refundableUveil: pool + acceptFees,
  };
}

/**
 * Whether the flat floor rather than the percentage curve priced the fee —
 * the same distinction the chain emits as `creation_fee_regime` on the
 * reservation event. Worth surfacing: on a short secret the floor is the whole
 * explanation for why the bill looks large next to a small pool.
 */
export function creationFeeIsFloorPriced(
  timeComponentUveilAmount: bigint,
  distanceBlocks: number | bigint,
): boolean {
  let d = BigInt(distanceBlocks);
  if (d < 0n) d = 0n;
  if (d > CREATION_FEE_CURVE_END_BLOCKS) d = CREATION_FEE_CURVE_END_BLOCKS;
  const bps =
    CREATION_FEE_MAX_BPS -
    ((CREATION_FEE_MAX_BPS - CREATION_FEE_MIN_BPS) * d) / CREATION_FEE_CURVE_END_BLOCKS;
  return CREATION_FEE_FLOOR_UVEIL > (timeComponentUveilAmount * bps) / 10_000n;
}

// ── Guardian band ────────────────────────────────────────────────────────────

/**
 * Client-side mirror of the chain's authoritative band rule
 * (x/secrets/types.ValidateShareBand — spec.md "The [min_shares, max_shares]
 * band"), for pre-submission UX:
 *
 *   THRESHOLD_MIN ≤ threshold ≤ min_shares ≤ max_shares ≤ 32
 *   max_shares − min_shares < threshold                    (strict)
 *
 * Returns null when valid, or the reason the chain would reject. Pinned
 * against drift by testdata/vectors/share_band.json, asserted by the chain
 * and every client.
 */
export function shareBandError(
  threshold: number,
  minShares: number,
  maxShares: number,
): string | null {
  if (threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX) {
    return `threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}, got ${threshold}`;
  }
  if (minShares < SHARES_MIN) {
    return `min_shares must be at least ${SHARES_MIN}, got ${minShares}`;
  }
  if (minShares < threshold) {
    return `min_shares (${minShares}) must be >= threshold (${threshold})`;
  }
  if (maxShares < minShares) {
    return `max_shares (${maxShares}) must be >= min_shares (${minShares})`;
  }
  if (maxShares > MAX_TOTAL_SHARES) {
    return `max_shares must not exceed ${MAX_TOTAL_SHARES}, got ${maxShares}`;
  }
  if (maxShares - minShares >= threshold) {
    return (
      `band width max_shares − min_shares (${maxShares - minShares}) must be strictly below ` +
      `threshold (${threshold}): never-confirmed candidates must stay a sub-threshold set`
    );
  }
  return null;
}

/**
 * The default band preset (variable-quorum plan §5, resolved July 2026):
 * min_shares is the creator's explicit guardian target; the client derives
 * the ceiling by keeping the historical 30% spread, clamped to the gap
 * bound — max = min + min(ceil(0.3 × min), threshold − 1).
 */
export function defaultMaxShares(threshold: number, minShares: number): number {
  // Integer ceil(min × 30%), matching the chain-side integer arithmetic
  // exactly (float 0.3 rounds differently, e.g. 10 × 0.3 → 3.0000000000000004)
  const spread = Math.min(Math.floor((minShares * 30 + 99) / 100), threshold - 1);
  return Math.min(minShares + spread, MAX_TOTAL_SHARES);
}

// ── Dials — the settable protocol surface ────────────────────────────────────

/**
 * Every field a creator may set on MsgUserRequestGuardians, described once.
 *
 * A UI that retypes a bound is a drift surface: the chain moves the limit and
 * the stepper keeps the old one. So bounds are not restated anywhere — they
 * are read from here, and here they are read from the pinned constants above.
 * The same descriptors back the SDK's pre-broadcast validation, so what the UI
 * offers and what the SDK accepts cannot disagree.
 *
 * Dependent bounds are functions rather than prose. `maxShares.max` really is
 * `min(32, minShares + threshold − 1)`. Writing them as code is what stops the
 * relationship living only in a comment. `revealStartOffset.min` is a plain
 * constant: the commit window it used to depend on is fixed by the protocol.
 *
 * `detectionHint` is deliberately absent: the client always derives it from
 * the recipient's public key, and a "no discovery" mode was ruled rejected in
 * July 2026.
 */

/** What moves when a dial moves — lets a UI explain a dial without hardcoding it. */
export type DialEffect = 'security' | 'reliability' | 'cost';

export type DialId =
  | 'threshold'
  | 'minShares'
  | 'maxShares'
  | 'bump'
  | 'revealStartOffset'
  | 'revealDuration';

/**
 * The dial values a bound may depend on. Every field is required: a bound that
 * silently defaulted a dependency would compute a limit for a draft that does
 * not exist.
 */
export interface DialValues {
  threshold: number;
  minShares: number;
  maxShares: number;
  bumpHundredths: number;
  revealStartOffsetBlocks: number;
  revealDurationBlocks: number;
}

export interface DialDescriptor {
  id: DialId;
  /** Short human label — UI copy may override, but never the bounds. */
  label: string;
  /** Inclusive lower bound, given the rest of the draft. */
  min: (v: DialValues) => number;
  /** Inclusive upper bound, given the rest of the draft. */
  max: (v: DialValues) => number;
  /**
   * Coarse increment for thumb-driven steppers. NOT a legality constraint:
   * every integer within [min, max] is a legal value, reachable by exact
   * entry. A stepper that could only reach multiples of its step was the
   * reason most of each range was unreachable.
   */
  step: number;
  /** Value used when the creator expresses no preference. */
  default: (v: DialValues) => number;
  affects: readonly DialEffect[];
  /** True when the bounds pin this dial to a single legal value. */
  isPinned: (v: DialValues) => boolean;
}

export const DIALS: Record<DialId, DialDescriptor> = {
  threshold: {
    id: 'threshold',
    label: 'Guardians required to reveal',
    min: () => THRESHOLD_MIN,
    max: () => THRESHOLD_MAX,
    step: 1,
    default: () => THRESHOLD_MIN + 1,
    affects: ['security'],
    isPinned: () => false,
  },
  minShares: {
    id: 'minShares',
    // The band floor is what must accept for the secret to activate at all.
    label: 'Guardian target',
    min: (v) => Math.max(SHARES_MIN, v.threshold),
    max: () => MAX_TOTAL_SHARES,
    step: 1,
    default: (v) => Math.max(SHARES_MIN, v.threshold),
    affects: ['security', 'cost'],
    isPinned: (v) => Math.max(SHARES_MIN, v.threshold) >= MAX_TOTAL_SHARES,
  },
  maxShares: {
    id: 'maxShares',
    label: 'Guardians selected',
    min: (v) => v.minShares,
    // The gap bound keeps the never-confirmed set sub-threshold, so the band
    // can never be wider than the threshold the creator already chose.
    max: (v) => Math.min(MAX_TOTAL_SHARES, v.minShares + v.threshold - 1),
    step: 1,
    default: (v) => defaultMaxShares(v.threshold, v.minShares),
    // Band width buys no-show tolerance; the ceiling is what the pool and the
    // accept fees are priced on, so it moves the bill too.
    affects: ['reliability', 'cost'],
    isPinned: (v) => v.minShares >= Math.min(MAX_TOTAL_SHARES, v.minShares + v.threshold - 1),
  },
  bump: {
    id: 'bump',
    label: 'Stake multiplier',
    min: () => BUMP_MIN_HUNDREDTHS,
    max: () => BUMP_MAX_HUNDREDTHS,
    step: 50,
    default: () => BUMP_MIN_HUNDREDTHS,
    affects: ['security', 'cost'],
    isPinned: () => false,
  },
  revealStartOffset: {
    id: 'revealStartOffset',
    label: 'Opens after',
    // The chain requires a buffer between the commit deadline and the window;
    // with the commit window fixed, the floor is a constant.
    min: () => REVEAL_START_OFFSET_MIN_BLOCKS,
    // reveal_end_block must sit inside the horizon, so the offset's ceiling
    // depends on how long the window itself runs.
    max: (v) => MAX_REVEAL_HORIZON_BLOCKS - v.revealDurationBlocks,
    step: 1,
    default: () => REVEAL_START_OFFSET_MIN_BLOCKS,
    affects: ['cost'],
    isPinned: (v) =>
      REVEAL_START_OFFSET_MIN_BLOCKS >= MAX_REVEAL_HORIZON_BLOCKS - v.revealDurationBlocks,
  },
  revealDuration: {
    id: 'revealDuration',
    label: 'Open for',
    min: () => REVEAL_DURATION_MIN_BLOCKS,
    max: (v) =>
      Math.min(REVEAL_DURATION_MAX_BLOCKS, MAX_REVEAL_HORIZON_BLOCKS - v.revealStartOffsetBlocks),
    step: 100,
    default: () => 300,
    affects: ['reliability', 'cost'],
    isPinned: (v) =>
      REVEAL_DURATION_MIN_BLOCKS >=
      Math.min(REVEAL_DURATION_MAX_BLOCKS, MAX_REVEAL_HORIZON_BLOCKS - v.revealStartOffsetBlocks),
  },
};

/**
 * The chain's own rejection wording for a dial that is out of range, or null
 * when it is legal. Mirrors x/secrets/types (ValidateShareBand, ValidateBump,
 * validateUserRequestGuardiansMessage, validateRevealWindow) so a client tells
 * the user what the chain would have told them.
 */
export function dialError(id: DialId, values: DialValues): string | null {
  const d = DIALS[id];
  const value = dialValue(id, values);
  const [min, max] = [d.min(values), d.max(values)];
  if (Number.isInteger(value) === false) {
    return `${id} must be a whole number, got ${value}`;
  }
  if (value < min || value > max) {
    switch (id) {
      case 'threshold':
        return `threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}, got ${value}`;
      case 'minShares':
        return value < SHARES_MIN
          ? `min_shares must be at least ${SHARES_MIN}, got ${value}`
          : value < values.threshold
            ? `min_shares (${value}) must be >= threshold (${values.threshold})`
            : `max_shares must not exceed ${MAX_TOTAL_SHARES}, got ${value}`;
      case 'maxShares':
        return value < values.minShares
          ? `max_shares (${value}) must be >= min_shares (${values.minShares})`
          : value > MAX_TOTAL_SHARES
            ? `max_shares must not exceed ${MAX_TOTAL_SHARES}, got ${value}`
            : `band width max_shares − min_shares (${value - values.minShares}) must be ` +
              `strictly below threshold (${values.threshold}): never-confirmed candidates ` +
              `must stay a sub-threshold set`;
      case 'bump':
        return (
          `bump must be between ${BUMP_MIN_HUNDREDTHS} and ${BUMP_MAX_HUNDREDTHS} hundredths ` +
          `(${(BUMP_MIN_HUNDREDTHS / 100).toFixed(2)}–${(BUMP_MAX_HUNDREDTHS / 100).toFixed(2)}), got ${value}`
        );
      case 'revealStartOffset':
        return value < min
          ? `reveal start offset too small: ${value} blocks (minimum ${min} blocks = ` +
              `${COMMIT_TIMEOUT_BLOCKS} commit + ${REVEAL_START_OFFSET_BUFFER_BLOCKS} buffer)`
          : `reveal window ends too far in the future: maximum ${MAX_REVEAL_HORIZON_BLOCKS} ` +
              `blocks from now (the guardian availability cap)`;
      case 'revealDuration':
        return value < REVEAL_DURATION_MIN_BLOCKS
          ? `reveal duration too short: ${value} blocks (minimum ${REVEAL_DURATION_MIN_BLOCKS})`
          : value > REVEAL_DURATION_MAX_BLOCKS
            ? `reveal duration too long: ${value} blocks (maximum ${REVEAL_DURATION_MAX_BLOCKS})`
            : `reveal window ends too far in the future: maximum ${MAX_REVEAL_HORIZON_BLOCKS} ` +
              `blocks from now (the guardian availability cap)`;
    }
  }
  return null;
}

function dialValue(id: DialId, v: DialValues): number {
  switch (id) {
    case 'threshold':
      return v.threshold;
    case 'minShares':
      return v.minShares;
    case 'maxShares':
      return v.maxShares;
    case 'bump':
      return v.bumpHundredths;
    case 'revealStartOffset':
      return v.revealStartOffsetBlocks;
    case 'revealDuration':
      return v.revealDurationBlocks;
  }
}

/** Every dial's rejection, in declaration order. Empty when the draft is legal. */
export function dialErrors(values: DialValues): string[] {
  return (Object.keys(DIALS) as DialId[])
    .map((id) => dialError(id, values))
    .filter((e): e is string => e !== null);
}

/** Clamp a dial into its legal range, for steppers that must not overshoot. */
export function clampDial(id: DialId, value: number, values: DialValues): number {
  const d = DIALS[id];
  return Math.min(d.max(values), Math.max(d.min(values), Math.round(value)));
}
