import {
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import type { Transaction, xdr } from '@stellar/stellar-sdk';
import { CONTRACTS } from '@tests/test-app/src/contracts';

export const network = {
  name: 'Testnet',
  passphrase: Networks.TESTNET,
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

const server = new rpc.Server(network.rpcUrl);

export async function payment(
  from: string,
  to: string,
  amount: string,
): Promise<string> {
  const operation = Operation.payment({
    destination: to,
    asset: Asset.native(),
    amount,
  });
  return (await build(from, operation)).toXDR();
}

export async function transfer(
  from: string,
  to: string,
  amount: string,
): Promise<string> {
  const call = new Contract(CONTRACTS.testnet.xlmToken).call(
    'transfer',
    nativeToScVal(from, { type: 'address' }),
    nativeToScVal(to, { type: 'address' }),
    nativeToScVal(stroops(amount), { type: 'i128' }),
  );
  const prepared = await server.prepareTransaction(await build(from, call));
  return prepared.toXDR();
}

export async function send(signedXdr: string): Promise<void> {
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, network.passphrase),
  );
  if (sent.status !== 'PENDING') {
    throw new Error(`sendTransaction answered ${sent.status}`);
  }
}

// SEP-53: the signature covers the SHA-256 of the prefixed message.
export function verified(
  address: string,
  message: string,
  signature: string,
): boolean {
  const signed = new TextEncoder().encode(
    `Stellar Signed Message:\n${message}`,
  );
  const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
  return Keypair.fromPublicKey(address).verify(hash(signed), bytes);
}

async function build(
  from: string,
  operation: xdr.Operation,
): Promise<Transaction> {
  return new TransactionBuilder(await server.getAccount(from), {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
}

function stroops(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match) throw new Error(`${amount} isn't an XLM amount`);
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}
