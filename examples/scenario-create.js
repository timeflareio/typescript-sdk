#!/usr/bin/env node

/**
 * Scenario creator for `make e2e-scenarios` (test strategy plan §3 tier 3).
 *
 * Creates a secret (Phases 1 + 2) against the running devnet and writes a
 * manifest with everything a scenario script needs — including each guardian's
 * PLAINTEXT key-share envelope in hex, which doubles as valid early-reveal
 * evidence (the HMAC commits to it).
 *
 * The high-level sealSecret discards those plaintext envelopes by design, so
 * this tooling does the seal manually through the raw-WASM primitives escape
 * hatch (lib.loadWasmPrimitives) — deliberately NOT part of the SDK's public
 * surface, only the audited low-level functions the seal composes.
 *
 * Usage: node scenario-create.js <manifest-path> [startOffset] [duration] [bump]
 */

const fs = require('fs');
const nodeCrypto = require('crypto');

const { connect, loadRecipientPublicKey, loadWasmPrimitives } = require('./lib');
const { toUint8Array, toArrayBuffer } = require('../dist');

const THRESHOLD = 3;
// Zero-width band by default: every selected guardian must accept — the shape
// the scenario suite's exact-amount assertions are anchored to.
//
// The 5th argument overrides it, as "N" (zero-width) or "MIN:MAX" (a real band,
// subject to the protocol's max − min < threshold). A secret's economics scale
// with the band, so the rebate scenario needs a wider one to reach a spend whose
// 30% clears the dust floor. Zero-width at 15 is NOT the way to get there: all
// 15 selected guardians must then accept before the deadline, and the suite
// deliberately damages guardians before this point (S1 kills one, S3 slashes
// one), so a wide zero-width band cannot activate reliably.
const DEFAULT_SHARES = 5;

async function main() {
  const [manifestPath, startOffsetArg, durationArg, bumpArg, sharesArg] = process.argv.slice(2);
  if (!manifestPath) {
    console.error('usage: scenario-create.js <manifest-path> [startOffset] [duration] [bump] [shares]');
    process.exit(1);
  }
  const startOffset = parseInt(startOffsetArg || '150', 10);
  const duration = parseInt(durationArg || '100', 10);
  const bump = parseInt(bumpArg || '100', 10);
  const [minArg, maxArg] = String(sharesArg || DEFAULT_SHARES).split(':');
  const MAX_SHARES = parseInt(maxArg || minArg, 10);
  const MIN_SHARES = parseInt(minArg, 10);

  const { rest, tx, crypto, address } = await connect();
  const recipientPublicKey = loadRecipientPublicKey();
  const wasm = await loadWasmPrimitives();

  // Phase 1 — request guardians (pool escrowed, protocol-priced). The
  // recipient's key never goes on chain — only the derived discovery hint.
  const hint = crypto.deriveHint(toArrayBuffer(recipientPublicKey));
  const { secretId, guardianAssignments } = await tx.requestGuardians({
    detectionHint: {
      version: hint.version,
      ephemeralPub: toUint8Array(hint.ephemeralPub),
      tag: toUint8Array(hint.tag),
    },
    revealWindow: { startOffset, duration },
    threshold: THRESHOLD,
    minShares: MIN_SHARES,
    maxShares: MAX_SHARES,
    bump,
  });
  console.log(`Secret reserved: ${secretId}`);

  // Phase 2 — manual key-share seal so the PLAINTEXT envelopes stay in hand.
  const payload = new TextEncoder().encode('e2e-scenario secret payload — conformance material');
  // Inner layer: payload → C_r (recipient-encrypted)
  const innerCiphertext = new Uint8Array(wasm.encrypt_with_public_key(payload, recipientPublicKey));
  // The time-lock: a fresh per-secret keypair ([priv|pub] from generate_keypair)
  const secretKeypair = new Uint8Array(wasm.generate_keypair());
  const skS = secretKeypair.slice(0, 32);
  const pkS = secretKeypair.slice(32, 64);
  // Outer layer: C_r → C, stored on chain once
  const payloadCiphertext = new Uint8Array(wasm.encrypt_with_public_key(innerCiphertext, pkS));
  // Split the per-secret PRIVATE key t-of-n
  const keyShares = wasm.split_secret(skS, THRESHOLD, guardianAssignments.length);

  const plaintextShares = {};
  const shares = [];
  for (let i = 0; i < guardianAssignments.length; i++) {
    const addr = guardianAssignments[i].address;
    const encKey = guardianAssignments[i].publicKey; // guardian encryption key
    // v1 key-share envelope: version(1B) | sss_id(1B) | share(32B)
    const envelope = new Uint8Array(2 + keyShares[i].data.length);
    envelope[0] = 1;
    envelope[1] = keyShares[i].id;
    envelope.set(keyShares[i].data, 2);
    plaintextShares[addr] = Buffer.from(envelope).toString('hex');
    shares.push({
      guardianAddress: addr,
      encryptedShare: new Uint8Array(wasm.encrypt_with_public_key(envelope, encKey)),
      shareHmac: new Uint8Array(wasm.generate_guardian_hmac(secretId, addr, envelope)),
    });
  }

  const secretCommitment = new Uint8Array(nodeCrypto.createHash('sha256').update(innerCiphertext).digest());

  await tx.distributeShares({
    secretId,
    shares,
    secretCommitment,
    payloadCiphertext,
    secretPublicKey: pkS,
  });
  console.log('Shares distributed — guardians will accept shortly');

  const final = await rest.secretMeta(secretId);
  const manifest = {
    secretId,
    creator: address,
    threshold: THRESHOLD,
    minShares: MIN_SHARES,
    maxShares: MAX_SHARES,
    bump,
    commitDeadline: final.commitDeadline,
    revealStartBlock: final.revealStartBlock,
    revealEndBlock: final.revealEndBlock,
    rewardPool: final.rewardPool,
    // A — escrowed apart from the pool and settled at the terminal state; the
    // scenarios assert the per-guardian slice against it
    acceptFees: final.acceptFees,
    // Per-guardian frozen bonds (uveil), aligned with selectedGuardians —
    // priced by each guardian's own bond multiplier k at selection
    selectedGuardians: final.selectedGuardians,
    guardianBondAmounts: final.guardianBondAmounts,
    plaintextShares, // hex per guardian — valid early-reveal evidence
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written: ${manifestPath}`);
  tx.disconnect();
}

main().catch((err) => {
  console.error(`scenario-create failed: ${err.stack || err.message}`);
  process.exit(1);
});
