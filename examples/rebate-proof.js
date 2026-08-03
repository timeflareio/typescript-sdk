/**
 * Print the two values a recipient needs to collect a secret's rebate:
 * the recipiency proof z, and the commitment binding it to a collector address.
 *
 * Collection is commit–reveal (docs/spec.md "Recipient Rebate"): the commitment
 * goes on chain first, the proof one block later. Both derive from the devnet
 * recipient keypair and the secret's own detection hint, so this is exactly the
 * computation a wallet performs — the scenario suite just needs it on stdout.
 *
 * Usage: node rebate-proof.js <secret-id> <collector-bech32-address>
 * Output: {"proof":"<hex>","commitment":"<hex>","rebate":"<uveil>","collected":bool}
 */

const { connect, loadRecipientKeypair } = require('./lib');

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addressBytes(bech32) {
  // The commitment hashes the raw account bytes, not the bech32 rendering, so
  // it does not depend on a prefix a future network might change.
  const { fromBech32 } = require('@cosmjs/encoding');
  return fromBech32(bech32).data;
}

async function main() {
  const [secretId, collector] = process.argv.slice(2);
  if (!secretId || !collector) {
    console.error('usage: rebate-proof.js <secret-id> <collector-bech32-address>');
    process.exit(2);
  }

  const { rest, crypto } = await connect();
  const secret = await rest.secretMeta(secretId);
  if (!secret) {
    console.error(`secret ${secretId} not found`);
    process.exit(3);
  }

  const hint = {
    version: Number(secret.detectionHint.version),
    ephemeralPub: toArrayBuffer(Buffer.from(secret.detectionHint.ephemeralPub, 'base64')),
    tag: toArrayBuffer(Buffer.from(secret.detectionHint.tag, 'base64')),
  };

  const { privateKey } = loadRecipientKeypair();
  if (!crypto.scanHint(hint, toArrayBuffer(privateKey))) {
    console.error(`secret ${secretId} is not addressed to the devnet recipient key`);
    process.exit(4);
  }

  const proof = new Uint8Array(crypto.recipiencyProof(hint, toArrayBuffer(privateKey)));
  const commitment = new Uint8Array(
    crypto.rebateCommitment(toArrayBuffer(proof), toArrayBuffer(addressBytes(collector))),
  );

  console.log(
    JSON.stringify({
      proof: Buffer.from(proof).toString('hex'),
      commitment: Buffer.from(commitment).toString('hex'),
      rebate: String(secret.rebateAmount ?? '0'),
      collected: Boolean(secret.rebateCollected),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
