/**
 * Shared devnet wiring for the SDK examples — the one place endpoints,
 * wallets, the recipient keypair and the WASM crypto backend are assembled.
 * Everything here composes the PUBLIC timeflare-sdk surface (dist/), except
 * the raw-WASM escape hatch (loadWasmPrimitives), which exists only for the
 * scenario tooling's manual seal and is deliberately not part of the SDK API.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sdk = require('../dist');
const { createWasmCryptoProvider } = require('../dist/backends/wasm');

const CHAIN_ID = process.env.CHAIN_ID || 'timeflare-test';
const RPC = process.env.RPC_ENDPOINT || 'http://localhost:26657';
const REST = process.env.API_ENDPOINT || process.env.TIMEFLARE_REST || 'http://localhost:1317';
const TIMEFLARE_HOME = process.env.TIMEFLARE_HOME || `${process.env.HOME}/.timeflare`;

/** Block time (seconds) from TIMEFLARE_BLOCK_TIME; drives poll cadence. */
function blockSeconds() {
  const raw = String(process.env.TIMEFLARE_BLOCK_TIME || '6s').trim();
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 6;
  return raw.endsWith('ms') ? parsed / 1000 : parsed;
}

/** Load the devnet test user "george" as a signing wallet via the CLI export. */
async function loadGeorgeWallet() {
  const passphraseFile = `${TIMEFLARE_HOME}/user/keyring_passphrase`;
  const keyringDir = `${TIMEFLARE_HOME}/user/keyring`;
  if (!fs.existsSync(passphraseFile)) {
    throw new Error('user keyring not found — run: ./devnet/users/setup-test-users.sh fund');
  }
  // The file content IS the passphrase, verbatim (raw-only ruling — the
  // key-management consolidation plan; never base64-decoded).
  const passphrase = fs.readFileSync(passphraseFile, 'utf8').trim();
  const privKeyHex = execSync(
    `echo "${passphrase}" | timeflared keys export george --unarmored-hex --unsafe ` +
      `--keyring-backend file --keyring-dir ${keyringDir} -y 2>/dev/null | tail -1`,
    { encoding: 'utf8' },
  ).trim();
  return sdk.walletFromPrivateKeyHex(privKeyHex);
}

/**
 * Where the devnet's recipient keypair lives.
 *
 * This used to default to `<sdk>/../../.devnet/recipient-keypair.json`, which
 * worked only because the SDK sat inside the same tree as the devnet. It no
 * longer does, and a path derived from this file's position now points at
 * something unrelated — or nothing.
 *
 * There is no sensible default: the examples cannot guess where a devnet is.
 * The harness that runs them knows, and passes RECIPIENT_KEYPAIR. Failing
 * loudly beats reading a file that happens to exist at a guessed location.
 */
function recipientKeypairPath() {
  const p = process.env.RECIPIENT_KEYPAIR;
  if (!p) {
    throw new Error(
      'RECIPIENT_KEYPAIR is not set.\n' +
      'These examples run against a devnet, whose location this package cannot infer.\n' +
      "Set it to the devnet's recipient keypair, e.g.\n" +
      '  RECIPIENT_KEYPAIR=/path/to/chain/.devnet/recipient-keypair.json node examples/secret-lifecycle.js\n' +
      "The chain repository's `make e2e` sets this for you.",
    );
  }
  return p;
}

/** The recipient's X25519 public key from the devnet keypair file. */
function loadRecipientPublicKey() {
  const data = JSON.parse(fs.readFileSync(recipientKeypairPath(), 'utf8'));
  return new Uint8Array(Buffer.from(data.publicKey, 'hex'));
}

/** The recipient's full keypair (public + private) — for reconstruction/discovery. */
function loadRecipientKeypair() {
  const data = JSON.parse(fs.readFileSync(recipientKeypairPath(), 'utf8'));
  return {
    publicKey: new Uint8Array(Buffer.from(data.publicKey, 'hex')),
    privateKey: new Uint8Array(Buffer.from(data.privateKey, 'hex')),
  };
}

/** Build the connected clients + WASM crypto the examples share. */
async function connect() {
  const wallet = await loadGeorgeWallet();
  const rest = new sdk.TimeflareRestClient(REST);
  const tx = await sdk.TimeflareTxClient.connect(RPC, wallet.wallet);
  const crypto = await createWasmCryptoProvider();
  return { wallet, rest, tx, crypto, address: wallet.address };
}

/**
 * Escape hatch for the scenario tooling ONLY: the raw wasm-bindgen module,
 * exposing the audited low-level primitives (encrypt_with_public_key,
 * generate_keypair, split_secret, generate_guardian_hmac) the high-level
 * seal composes. Needed because the scenario suite must capture the PLAINTEXT
 * key-share envelopes (early-reveal evidence) that sealSecret discards. Not
 * part of the public SDK surface.
 */
async function loadWasmPrimitives() {
  // The wasm-bindgen (web target) module is ESM — dynamic import from CJS.
  const mod = await import('../wasm/timeflare_crypto.js');
  const wasmPath = path.resolve(__dirname, '../wasm/timeflare_crypto_bg.wasm');
  await mod.default(fs.readFileSync(wasmPath));
  return mod;
}

module.exports = {
  CHAIN_ID,
  RPC,
  REST,
  blockSeconds,
  loadGeorgeWallet,
  loadRecipientPublicKey,
  loadRecipientKeypair,
  connect,
  loadWasmPrimitives,
  sdk,
};
