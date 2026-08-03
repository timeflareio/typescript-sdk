/**
 * Wallet keys (secp256k1, chain prefix tmflr). The WALLET key signs
 * transactions and is distinct from the X25519 IDENTITY keys handled by the
 * crypto provider — two key domains, per the feature plan's key-storage
 * story. Secure storage (enclave/Keystore) is the app's concern; this module
 * only creates and restores signers.
 */

import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { fromHex, toHex } from '@cosmjs/encoding';
import { Random, stringToPath } from '@cosmjs/crypto';

import { CHAIN_PREFIX } from './constants';

/**
 * The chain's wallet HD path — BIP44 coin type 9733, account 0 (spec.md
 * "Network Configuration"; `ChainCoinType` in `x/secrets/types`;
 * CLIENT_CONVENTIONS.md §9). Passed explicitly on every HD wallet, because
 * cosmjs would otherwise default to Cosmos Hub's m/44'/118'/0'/0/0 and
 * resolve the same 24 words to a different, empty account. Exported so the
 * mobile client and any future web client can assert they are on the same
 * path; pinned across implementations by
 * testdata/vectors/wallet_derivation.json.
 */
export const CHAIN_HD_PATH = stringToPath("m/44'/9733'/0'/0/0");

export interface GeneratedWallet {
  wallet: DirectSecp256k1HdWallet;
  address: string;
  /** BIP39 mnemonic — the serialisable form (encrypt at rest in real apps). */
  mnemonic: string;
}

/** Generate a fresh 24-word wallet with the tmflr prefix. */
export async function generateWallet(): Promise<GeneratedWallet> {
  const wallet = await DirectSecp256k1HdWallet.generate(24, {
    prefix: CHAIN_PREFIX,
    hdPaths: [CHAIN_HD_PATH],
  });
  const [account] = await wallet.getAccounts();
  return { wallet, address: account.address, mnemonic: wallet.mnemonic };
}

/** Restore a wallet from its mnemonic (session resume, device migration). */
export async function walletFromMnemonic(mnemonic: string): Promise<GeneratedWallet> {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: CHAIN_PREFIX,
    hdPaths: [CHAIN_HD_PATH],
  });
  const [account] = await wallet.getAccounts();
  return { wallet, address: account.address, mnemonic };
}

/**
 * Restore a signer from a raw secp256k1 private key (hex).
 *
 * Path-free by design: the key IS the whole scalar, with no HD derivation —
 * this is how courier keys travel inside a claim URI. Never route raw-key
 * restores through CHAIN_HD_PATH (CLIENT_CONVENTIONS.md §9); the path applies
 * only to mnemonic-derived wallets.
 */
export async function walletFromPrivateKeyHex(privateKeyHex: string): Promise<{
  wallet: DirectSecp256k1Wallet;
  address: string;
}> {
  const wallet = await DirectSecp256k1Wallet.fromKey(fromHex(privateKeyHex), CHAIN_PREFIX);
  const [account] = await wallet.getAccounts();
  return { wallet, address: account.address };
}

/**
 * Generate a single-use COURIER key for a funded claim kit
 * (DONE_WALLET_BOOTSTRAPPING_PLAN §3).
 *
 * A raw key rather than an HD wallet because the whole key must fit in a claim
 * URI, and because a courier is deliberately not a wallet anyone keeps: the
 * sender funds it, the recipient sweeps it once, and it is abandoned. It is
 * never adopted as the recipient's wallet — the sender generated it and may
 * have kept a copy. For the same reasons, never "align" couriers to
 * CHAIN_HD_PATH: they are path-free on purpose, and a derivation change here
 * would break every outstanding funded kit (CLIENT_CONVENTIONS.md §9).
 */
export async function generateCourier(): Promise<{ privateKey: Uint8Array; address: string }> {
  // 32 random bytes are a valid secp256k1 scalar with overwhelming probability;
  // redrawing on the astronomically unlikely miss is cheaper than reasoning
  // about whether the signer validates the range.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const privateKey = Random.getBytes(32);
    try {
      const { address } = await walletFromPrivateKeyHex(toHex(privateKey));
      return { privateKey, address };
    } catch {
      continue;
    }
  }
  throw new Error('could not generate a usable courier key');
}
