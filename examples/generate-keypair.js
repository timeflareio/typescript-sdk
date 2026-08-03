#!/usr/bin/env node

/**
 * Generate a recipient X25519 identity keypair and write it as hex JSON.
 * The recipient never signs a transaction — only the keypair is needed
 * (public key for the detection hint + seal, private key to reconstruct).
 *
 * Usage: node examples/generate-keypair.js [output-file]
 * Requires the SDK to be built first (make build-sdk).
 */

const fs = require('fs');
const path = require('path');

const { createWasmCryptoProvider } = require('../dist/backends/wasm');

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

async function main() {
  const outputFile = path.resolve(process.argv[2] || 'keypair.json');
  if (fs.existsSync(outputFile)) {
    console.log(`✅ Keypair already exists at ${outputFile} — delete it to regenerate`);
    return;
  }

  console.log('🔐 Generating recipient X25519 identity keypair...');
  const crypto = await createWasmCryptoProvider();
  const keypair = crypto.keygenX25519();

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        publicKey: toHex(new Uint8Array(keypair.publicKey)),
        privateKey: toHex(new Uint8Array(keypair.privateKey)),
        created: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(`💾 Keypair saved to ${outputFile}`);
  console.log('⚠️  Contains a private key — never commit this file');
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
