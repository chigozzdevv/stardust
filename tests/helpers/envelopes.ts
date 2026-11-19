import { createHash } from 'node:crypto';
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  Account as SourceAccount,
  TransactionBuilder,
  buildAuthorizationEntryPreimage,
  xdr,
} from '@stellar/stellar-sdk';

export const nativeSac =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export function payment(
  source: string,
  networkPassphrase: string = Networks.TESTNET,
): string {
  return new TransactionBuilder(new SourceAccount(source, '7'), {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(0)
    .build()
    .toXDR();
}

export function preimage(
  address: string,
  networkPassphrase: string = Networks.TESTNET,
  version: 'v1' | 'v2' = 'v1',
): string {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(address).toScAddress(),
    nonce: 7n,
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials:
      version === 'v1'
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(nativeSac).toScAddress(),
            functionName: 'balance',
            args: [],
          }),
        ),
      subInvocations: [],
    }),
  });
  return buildAuthorizationEntryPreimage(entry, 1_000, networkPassphrase).toXdr(
    'base64',
  );
}

export function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}
