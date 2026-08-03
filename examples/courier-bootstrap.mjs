/**
 * Funded-claim-kit bootstrapping, against a live chain
 * (docs/planning/PENDING_WALLET_BOOTSTRAPPING_PLAN.md §3).
 *
 * Proves the one claim no other suite can: a NEVER-FUNDED address cannot sign,
 * and sweeping a funded courier is what brings it into existence. Every existing
 * path — including the rebate collection drill — transacts as a pre-funded devnet
 * account, which is precisely how the defect survived into a merged release.
 *
 * Two phases, because funding the courier is the caller's job (the devnet's user
 * key lives in a file keyring the CLI owns):
 *
 *   node examples/courier-bootstrap.mjs setup   # prints the courier address
 *   <fund that address with the printed seed>
 *   node examples/courier-bootstrap.mjs verify
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SDK = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { generateCourier, generateWallet, sweepCourier, courierSeedUveil,
        TimeflareRestClient, TimeflareTxClient, encodeClaimUri, parseClaimUri,
        walletFromMnemonic } = await import(SDK);
const fs = await import('node:fs');

const RPC = process.env.TIMEFLARE_RPC ?? 'http://localhost:26657';
const REST = process.env.TIMEFLARE_REST ?? 'http://localhost:1317';
const STATE = process.env.COURIER_DRILL_STATE ?? '/tmp/courier-bootstrap-state.json';
const rest = new TimeflareRestClient(REST);
const phase = process.argv[2];

const accountExists = async (addr) => {
  const r = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${addr}`);
  return r.ok;
};

if (phase === 'setup') {
  const courier = await generateCourier();
  const recipient = await generateWallet();
  // The kit the recipient will actually scan — the courier key travels only here.
  const uri = encodeClaimUri(new Uint8Array(32).fill(9), undefined, courier.privateKey);
  fs.writeFileSync(STATE, JSON.stringify({
    courierAddress: courier.address,
    recipientAddress: recipient.address,
    recipientMnemonic: recipient.mnemonic,
    uri, seed: courierSeedUveil().toString(),
  }));
  console.log(JSON.stringify({
    courier: courier.address, recipient: recipient.address, seed: courierSeedUveil().toString(),
    recipientBalance: (await rest.balance(recipient.address)).toString(),
    recipientAccountExists: await accountExists(recipient.address),
    kitVersion: parseClaimUri(uri).version,
  }, null, 1));
  process.exit(0);
}

// phase: verify
const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const parsed = parseClaimUri(s.uri);
parsed.version === 2 ? ok('kit is version 2 — an old client refuses it whole') : bad('wrong version');

const courierBal = await rest.balance(s.courierAddress);
courierBal === BigInt(s.seed) ? ok(`courier funded with ${courierBal} uveil`) : bad(`courier holds ${courierBal}, want ${s.seed}`);

(await accountExists(s.recipientAddress))
  ? bad('the recipient account already exists — the drill proves nothing')
  : ok('recipient still has NO on-chain account, so it cannot sign anything');

const result = await sweepCourier({
  rpcUrl: RPC, restUrl: REST,
  courierPrivateKey: parsed.courierKey,
  destination: s.recipientAddress,
});
result.outcome === 'swept' ? ok(`swept ${result.amountUveil} uveil`) : bad(`outcome ${result.outcome}`);

const after = await rest.balance(s.recipientAddress);
after === result.amountUveil ? ok(`recipient now holds ${after} uveil`) : bad(`recipient holds ${after}`);
after > 23000n ? ok('which covers a full rebate collection (23,000 uveil)') : bad('below the collection cost');
(await accountExists(s.recipientAddress)) ? ok('the recipient account now EXISTS on chain') : bad('still no account');

try {
  const w = await walletFromMnemonic(s.recipientMnemonic);
  const tx = await TimeflareTxClient.connect(RPC, w.wallet);
  await tx.sendVeil({ to: s.courierAddress, amountUveil: 1n });
  tx.disconnect();
  ok('the recipient SIGNED a transaction — the whole point of the exercise');
} catch (e) { bad('the recipient still cannot sign: ' + e.message); }

const again = await sweepCourier({
  rpcUrl: RPC, restUrl: REST,
  courierPrivateKey: parsed.courierKey, destination: s.recipientAddress,
});
again.outcome === 'empty' ? ok('a second import sweeps nothing and does not fail') : bad(`second sweep: ${again.outcome}`);

console.log(`\n  courier drill: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
