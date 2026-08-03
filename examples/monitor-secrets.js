#!/usr/bin/env node

/**
 * Timeflare secret monitoring tool — observe secrets on a running devnet
 * through the public timeflare-sdk surface (REST queries + CryptoProvider),
 * with no `timeflared` CLI shell-out.
 *
 *   --sender <addr>            secrets created by an address (Query/SecretsByCreator)
 *   --recipient-keypair <path> secrets addressed to a recipient (hint-scan discovery)
 *   --secret <id> [--follow]   one secret, optionally streamed until terminal
 *
 * A recipient keypair additionally attempts reconstruction + decrypt of any
 * secret that has reached its threshold. All output is JSON — pipe to `jq`.
 *
 * Read-only: needs only a REST endpoint (API_ENDPOINT, default :1317) and,
 * for recipient modes, WASM crypto. No signing wallet or keyring required.
 */

const fs = require('fs');

const { REST, blockSeconds, sdk } = require('./lib');
const { createWasmCryptoProvider } = require('../dist/backends/wasm');
const {
  TimeflareRestClient,
  reconstructSecret,
  decryptReconstructed,
  discoverSecrets,
  sleep,
} = require('../dist');

// Protocol assignment-status values (proto AssignmentStatus enum).
const ASSIGNMENT_STATUS = { 1: 'proposed', 2: 'accepted', 3: 'rejected' };

// Terminal states — follow mode stops once a secret reaches one of these.
const TERMINAL_STATES = ['reconstructable', 'revealed', 'failed', 'cancelled'];

/** Load a recipient keypair file: { publicKey, privateKey } as hex strings. */
function loadKeypair(path) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  return {
    publicKey: new Uint8Array(Buffer.from(data.publicKey, 'hex')),
    privateKey: new Uint8Array(Buffer.from(data.privateKey, 'hex')),
  };
}

/** Derive phase + assignment/reveal counts from a SecretView + chain height. */
async function analyseSecret(rest, secret, currentBlock) {
  const assignments = await rest.secretAssignments(secret.id);
  const breakdown = { proposed: 0, accepted: 0, rejected: 0 };
  for (const a of assignments) {
    const label = ASSIGNMENT_STATUS[a.status];
    if (label) breakdown[label]++;
  }

  const revealedShares = secret.revealedCount;
  const canReconstruct = revealedShares >= secret.threshold;

  let phase;
  const revealWindow = {
    start: secret.revealStartBlock,
    end: secret.revealEndBlock,
    current: currentBlock,
  };
  if (currentBlock < secret.revealStartBlock) {
    phase = 'PRE_REVEAL';
    revealWindow.blocksUntilReveal = secret.revealStartBlock - currentBlock;
  } else if (currentBlock <= secret.revealEndBlock) {
    phase = 'REVEAL_ACTIVE';
    revealWindow.blocksRemaining = secret.revealEndBlock - currentBlock;
  } else {
    phase = 'POST_REVEAL';
  }

  return {
    id: secret.id,
    state: secret.state,
    creator: secret.creator,
    threshold: secret.threshold,
    minShares: secret.minShares,
    maxShares: secret.maxShares,
    phase,
    assignments: breakdown,
    revealedShares,
    canReconstruct,
    revealWindow,
  };
}

/**
 * Attempt reconstruction of a threshold-reached secret. With a private key the
 * payload is decrypted to plaintext; without one it is only unsealed (the
 * recipient-encrypted ciphertext), with a note. Failures are returned, not thrown.
 */
async function attemptReconstruction(crypto, rest, secretId, keypair) {
  try {
    const result = await reconstructSecret(crypto, rest, secretId);
    if (!keypair || !keypair.privateKey) {
      return {
        success: true,
        commitmentVerified: result.commitmentVerified,
        encryptedPayloadBytes: result.innerCiphertext.length,
        note: 'payload unsealed but still recipient-encrypted — supply --recipient-keypair to decrypt',
        sharesUsed: result.revealsUsed,
        reconstructedAt: new Date().toISOString(),
      };
    }
    const plaintext = decryptReconstructed(crypto, result.innerCiphertext, keypair.privateKey);
    return {
      success: true,
      commitmentVerified: result.commitmentVerified,
      reconstructedText: new TextDecoder().decode(plaintext),
      sharesUsed: result.revealsUsed,
      reconstructedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** List/analyse secrets by creator, or by recipient hint-scan discovery. */
async function listSecrets(rest, crypto, criteria) {
  let secrets;
  if (criteria.sender) {
    secrets = await rest.secretsByCreator(criteria.sender);
  } else {
    // Recipient discovery: hint-scan with the PRIVATE key, then load each view.
    const { secretIds } = await discoverSecrets(crypto, rest, criteria.keypair.privateKey);
    const views = await Promise.all(secretIds.map((id) => rest.secretMeta(id)));
    secrets = views.filter((s) => s !== null);
  }

  if (criteria.states) {
    secrets = secrets.filter((s) => criteria.states.includes(s.state.toLowerCase()));
  }

  const currentBlock = await rest.height();
  const results = [];
  for (const secret of secrets) {
    const analysis = await analyseSecret(rest, secret, currentBlock);
    let reconstruction = null;
    if (criteria.keypair && analysis.canReconstruct) {
      reconstruction = await attemptReconstruction(crypto, rest, secret.id, criteria.keypair);
    }
    results.push({ secret: analysis, reconstruction });
  }

  return { success: true, count: results.length, currentBlock, secrets: results };
}

/** Monitor one secret by ID; --follow streams JSON per poll until terminal. */
async function monitorSecret(rest, crypto, secretId, options) {
  for (;;) {
    const secret = await rest.secretMeta(secretId);
    if (!secret) {
      return { error: `secret ${secretId} not found on chain (pruned or never existed)` };
    }
    const currentBlock = await rest.height();
    const analysis = await analyseSecret(rest, secret, currentBlock);

    let reconstruction = null;
    if (options.keypair && analysis.canReconstruct) {
      reconstruction = await attemptReconstruction(crypto, rest, secretId, options.keypair);
    }

    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      currentBlock,
      secret: analysis,
      reconstruction,
    };

    if (!options.follow) {
      return result;
    }

    console.log(JSON.stringify(result, null, 2));
    if (TERMINAL_STATES.includes(secret.state)) {
      return undefined;
    }
    await sleep(Math.max(1000, blockSeconds() * 1000));
  }
}

function showUsage() {
  console.log(`Timeflare secret monitoring tool

Usage:
  node monitor-secrets.js --sender <address> [--state <states>]
  node monitor-secrets.js --recipient-keypair <path> [--state <states>]
  node monitor-secrets.js --secret <secret-id> [--follow] [--recipient-keypair <path>]

Options:
  --sender <address>           List secrets created by this address
  --recipient-keypair <path>   List secrets for a recipient (hint scan) + reconstruction
  --secret <secret-id>         Monitor a specific secret by ID
  --state <states>             Filter by states (comma-separated), e.g. pending,reconstructable
  --follow                     Stream a specific secret (with --secret) until it goes terminal
  --help                       Show this help

Environment:
  API_ENDPOINT   REST endpoint (default http://localhost:1317)

Examples:
  node monitor-secrets.js --sender tmflr1abc...def
  node monitor-secrets.js --recipient-keypair ../.devnet/recipient-keypair.json
  node monitor-secrets.js --secret secret-123abc --follow | jq

Note:
  Recipient lookup requires the recipient's PRIVATE key — a public key alone can
  no longer identify a secret's recipient (that linkability was removed by design).
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showUsage();
    process.exit(0);
  }

  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sender': parsed.sender = args[++i]; break;
      case '--recipient-keypair': parsed.keypairPath = args[++i]; break;
      case '--secret': parsed.secretId = args[++i]; break;
      case '--state': parsed.states = args[++i].split(',').map((s) => s.trim().toLowerCase()); break;
      case '--follow': parsed.follow = true; break;
    }
  }

  if (!parsed.sender && !parsed.keypairPath && !parsed.secretId) {
    console.error(JSON.stringify({
      error: 'Must specify one of: --sender, --recipient-keypair, or --secret',
    }, null, 2));
    process.exit(1);
  }

  const rest = new TimeflareRestClient(REST);

  // WASM crypto is only needed when a recipient keypair drives discovery or
  // reconstruction — plain --sender / --secret monitoring stays crypto-free.
  const keypair = parsed.keypairPath ? loadKeypair(parsed.keypairPath) : null;
  const crypto = keypair ? await createWasmCryptoProvider() : null;

  let result;
  if (parsed.secretId) {
    result = await monitorSecret(rest, crypto, parsed.secretId, {
      follow: parsed.follow,
      keypair,
    });
  } else {
    result = await listSecrets(rest, crypto, {
      sender: parsed.sender,
      keypair,
      states: parsed.states,
    });
  }

  // Follow mode already streamed each poll; nothing left to print.
  if (result !== undefined) {
    console.log(JSON.stringify(result, null, 2));
  }
}

process.on('SIGINT', () => {
  console.error('\n{"message": "Monitoring stopped by user"}');
  process.exit(0);
});

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exit(1);
});
