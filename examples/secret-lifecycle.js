#!/usr/bin/env node

/**
 * Full secret lifecycle against a running devnet (`make e2e`), driven through
 * the public timeflare-sdk surface:
 *
 *   george wallet → Phase 1 (MsgUserRequestGuardians) → seal (WASM crypto) →
 *   Phase 2 (MsgUserDistributeShares) → acceptance watch to `pending` → hold →
 *   reveal watch (≥ t shares) → reconstruct (+ commitment assert) →
 *   recipient decrypt (byte-identical) → discovery via HintsSince.
 *
 * Requires: a live devnet and .devnet/recipient-keypair.json (make e2e
 * generates the latter via generate-keypair.js).
 */

const {
  connect,
  loadRecipientKeypair,
  blockSeconds,
} = require('./lib');
const {
  CommitSession,
  MemorySessionStore,
  reconstructSecret,
  decryptReconstructed,
  discoverSecrets,
  waitForHeight,
  watchAcceptanceUntilPending,
  watchRevealsUntilThreshold,
} = require('../dist');

const PARAMS = {
  threshold: 3,
  // Zero-width band: the 5-guardian devnet must staff every slot, and the
  // roster finalises at the commit deadline with exactly the accepted set
  minShares: 5,
  maxShares: 5,
  bump: 100,
  revealWindow: { startOffset: 150, duration: 100 },
};

function watchOpts(blocks, onProgress) {
  const bs = blockSeconds();
  return { pollMs: Math.max(1000, bs * 1000), timeoutMs: (blocks * bs + 120) * 1000, onProgress };
}

function makePayload(bytes = 2048) {
  const seed = 'lorem ipsum dolor sit amet · timeflare lifecycle e2e · ';
  let text = '';
  while (text.length < bytes) text += seed;
  return new TextEncoder().encode(text.slice(0, bytes));
}

async function main() {
  const { rest, tx, crypto, address } = await connect();
  const recipient = loadRecipientKeypair();
  const payload = makePayload(2048);
  console.log(`👤 Creator (george): ${address}`);

  const session = CommitSession.create(
    { tx, rest, crypto, store: new MemorySessionStore() },
    { payload, recipientPublicKey: recipient.publicKey, ...PARAMS },
  );

  // Phase 1
  const { secretId, commitDeadline } = await session.requestGuardians();
  console.log(`📌 Phase 1: secret ${secretId} reserved (commit deadline ${commitDeadline})`);
  const reserved = await rest.secretMeta(secretId);
  if (!reserved || reserved.state !== 'reserved') throw new Error('secret not reserved after phase 1');
  console.log(`💰 Reward pool ${reserved.rewardPool.amount}${reserved.rewardPool.denom} (protocol-derived)`);

  // Phase 2
  await session.sealAndDistribute();
  console.log('📦 Phase 2: payload ciphertext + key shares distributed');

  // Acceptance → pending
  const pending = await watchAcceptanceUntilPending(
    rest,
    secretId,
    watchOpts(120, (note) => console.log(`  acceptance: ${note}`)),
  );
  if (pending.acceptedCount !== PARAMS.minShares) {
    throw new Error(`expected ${PARAMS.minShares} active guardians, got ${pending.acceptedCount}`);
  }
  console.log(`✅ Activated: ${pending.acceptedCount} guardians holding bonds`);

  // Hold until the reveal window opens
  await waitForHeight(rest, pending.revealStartBlock, watchOpts(PARAMS.revealWindow.startOffset + 20));
  console.log(`🔓 Reveal window open (blocks ${pending.revealStartBlock}–${pending.revealEndBlock})`);

  // Reveal watch
  const reveals = await watchRevealsUntilThreshold(
    rest,
    secretId,
    PARAMS.threshold,
    pending.revealEndBlock,
    watchOpts(PARAMS.revealWindow.duration + 20, (note) => console.log(`  reveals: ${note}`)),
  );
  console.log(`🔑 ${reveals.length}/${PARAMS.threshold} shares revealed`);

  // Reconstruct + commitment assert
  const reconstruction = await reconstructSecret(crypto, rest, secretId);
  if (!reconstruction.commitmentVerified) throw new Error('commitment verification FAILED');
  console.log('✅ On-chain commitment verified: SHA256(reconstructed payload) matches');

  // Recipient decrypt
  const plaintext = decryptReconstructed(crypto, reconstruction.innerCiphertext, recipient.privateKey);
  const identical = Buffer.compare(Buffer.from(plaintext), Buffer.from(payload)) === 0;
  if (!identical) throw new Error('decrypted payload is NOT byte-identical to the original');
  console.log(`✅ Decrypted payload byte-identical (${plaintext.length} bytes)`);

  // Discovery
  const scan = await discoverSecrets(crypto, rest, recipient.privateKey);
  if (!scan.secretIds.includes(secretId)) throw new Error('discovery scan did not find the secret');
  console.log(`✅ Discovery scan found the secret (cursor ${scan.nextSinceHeight})`);

  console.log('\n✅ FULL LIFECYCLE VERIFIED: create → distribute → accept → reveal → reconstruct → decrypt → discover');
  tx.disconnect();
}

main().catch((err) => {
  console.error(`❌ secret-lifecycle failed: ${err.stack || err.message}`);
  process.exit(1);
});
