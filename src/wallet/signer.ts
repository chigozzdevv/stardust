import { createHash } from 'node:crypto';
import {
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  Account as SourceAccount,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { StardustError } from '@/errors';
import { loadAccount } from '@/funding/funder';
import { landed, resultCode } from '@/network/landing';
import type { LandingContext, LandingOptions } from '@/network/landing';
import { networkId, refuseMainnet } from '@/network/network';
import type { Rpc } from '@/network/network';
import { readPreimage } from '@/wallet/decode';

export type TokenCase =
  | { readonly kind: 'plain' }
  | { readonly kind: 'needsTrustline'; readonly asset: Asset }
  | { readonly kind: 'alreadyAdded' };

export interface TokenQuery {
  readonly contractId: string;
  readonly address: string;
  readonly networkPassphrase: string;
}

export interface TrustlineRequest {
  readonly signer: Keypair;
  readonly asset: Asset;
  readonly networkPassphrase: string;
}

const messagePrefix = 'Stellar Signed Message:\n';
const changeTrustFee = '10000';

export function signTransaction(
  envelope: string,
  signer: Keypair,
  networkPassphrase: string,
): string {
  refuseMainnet(networkPassphrase);
  const transaction = TransactionBuilder.fromXDR(envelope, networkPassphrase);
  transaction.sign(signer);
  return transaction.toXDR();
}

export function signAuthEntry(
  preimage: string,
  signer: Keypair,
  networkPassphrase: string,
): Buffer {
  refuseMainnet(networkPassphrase);
  const id = readPreimage(preimage).networkId.toBytes();
  if (networkId(Networks.PUBLIC).equals(id)) {
    throw new StardustError(
      'MAINNET_REFUSED',
      'refused: the auth entry is for mainnet. Stardust never signs for mainnet.',
    );
  }
  if (!networkId(networkPassphrase).equals(id)) {
    throw new StardustError(
      'PROMPT_BLOCKED',
      `the auth entry is for another network than the wallet's ("${networkPassphrase}"), so Stardust didn't sign it. Build the entry for the wallet's network, or answer the prompt with reject().`,
    );
  }
  return sign(signer, Buffer.from(preimage, 'base64'));
}

export function signMessage(
  message: string | Uint8Array,
  signer: Keypair,
  networkPassphrase: string,
): Buffer {
  refuseMainnet(networkPassphrase);
  const bytes = typeof message === 'string' ? Buffer.from(message) : message;
  return sign(signer, Buffer.concat([Buffer.from(messagePrefix), bytes]));
}

export async function readToken(
  rpc: Rpc,
  { contractId, address, networkPassphrase }: TokenQuery,
  signal?: AbortSignal,
): Promise<TokenCase> {
  const asset = await stellarAsset(rpc, contractId, networkPassphrase, signal);
  if (!asset) return { kind: 'plain' };
  if (asset.isNative() || (await hasTrustline(rpc, address, asset, signal))) {
    return { kind: 'alreadyAdded' };
  }
  return { kind: 'needsTrustline', asset };
}

export async function addTrustline(
  context: LandingContext,
  { signer, asset, networkPassphrase }: TrustlineRequest,
  options: LandingOptions = {},
): Promise<void> {
  refuseMainnet(networkPassphrase);
  const { rpc } = context;
  const address = signer.publicKey();
  const token = asset.toString();
  const account = await loadAccount(rpc, address);
  if (!account) {
    throw new StardustError(
      'UNSUPPORTED',
      `${address} doesn't exist on the network, so the wallet can't add a trustline for ${token}. Fund the account before the app adds the token.`,
    );
  }
  const transaction = new TransactionBuilder(
    new SourceAccount(address, account.sequence),
    { fee: changeTrustFee, networkPassphrase },
  )
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build();
  transaction.sign(signer);
  const sent = await rpc.call('sendTransaction', {
    transaction: transaction.toXDR(),
  });
  const what = `the wallet's changeTrust for ${token} (transaction ${sent.hash})`;
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    const code = sent.errorResultXdr
      ? resultCode(xdr.TransactionResult.fromXdr(sent.errorResultXdr, 'base64'))
      : sent.status;
    throw new StardustError(
      'UNSUPPORTED',
      `${rpc.url} rejected ${what} with ${code}. Check that ${address} holds enough XLM for the fee and the trustline's reserve, then run the test again.`,
    );
  }
  const { timeoutMs = 30_000 } = options;
  const result = await landed(context, sent.hash, {
    ...options,
    timeoutMs,
  }).catch((error: unknown) => {
    if (!(error instanceof StardustError) || error.code !== 'OUTCOME_UNKNOWN') {
      throw error;
    }
    throw new StardustError(
      'OUTCOME_UNKNOWN',
      `${what} didn't appear on the network within ${timeoutMs / 1000}s, so its outcome is unknown. Check ${rpc.url}, then run the test again.`,
      { cause: error },
    );
  });
  if (result.status === 'failed') {
    throw new StardustError(
      'UNSUPPORTED',
      `${what} failed with ${result.resultCode}. Check that ${address} holds enough XLM for the trustline's 0.5 XLM reserve.`,
    );
  }
}

function sign(signer: Keypair, payload: Uint8Array): Buffer {
  const digest = createHash('sha256').update(payload).digest();
  return Buffer.from(signer.sign(digest));
}

async function stellarAsset(
  rpc: Rpc,
  contractId: string,
  networkPassphrase: string,
  signal?: AbortSignal,
): Promise<Asset | null> {
  const [entry] = await ledgerEntries(
    rpc,
    new Contract(contractId).getFootprint(),
    signal,
  );
  if (
    entry?.type !== 'contractData' ||
    entry.contractData.val.type !== 'scvContractInstance'
  ) {
    return null;
  }
  const { executable, storage } = entry.contractData.val.instance;
  if (executable.type !== 'contractExecutableStellarAsset') return null;
  const asset = metadataAsset(storage ?? []);
  return asset?.contractId(networkPassphrase) === contractId ? asset : null;
}

function metadataAsset(storage: readonly xdr.ScMapEntry[]): Asset | null {
  const metadata = storage.find(({ key }) => scValToNative(key) === 'METADATA');
  const { name } = (metadata ? scValToNative(metadata.val) : {}) as {
    name?: unknown;
  };
  if (name === 'native') return Asset.native();
  if (typeof name !== 'string') return null;
  const [code = '', issuer = ''] = name.split(':');
  try {
    return new Asset(code, issuer);
  } catch {
    return null;
  }
}

async function hasTrustline(
  rpc: Rpc,
  address: string,
  asset: Asset,
  signal?: AbortSignal,
): Promise<boolean> {
  const key = xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: asset.toTrustLineXDRObject(),
    }),
  );
  return (await ledgerEntries(rpc, key, signal)).length > 0;
}

async function ledgerEntries(
  rpc: Rpc,
  key: xdr.LedgerKey,
  signal?: AbortSignal,
): Promise<xdr.LedgerEntryData[]> {
  const { entries } = await rpc.call(
    'getLedgerEntries',
    { keys: [key.toXdr('base64')] },
    signal,
  );
  return entries.map((entry) =>
    xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64'),
  );
}
