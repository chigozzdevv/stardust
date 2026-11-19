import {
  Address,
  Asset as ClassicAsset,
  StrKey,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

export type Asset = 'native' | `${string}:${string}` | `C${string}`;

export interface ContractEvent {
  readonly contract: string;
  readonly topics: readonly unknown[];
  readonly data: unknown;
}

export interface BalanceChange {
  readonly address: string;
  readonly asset: Asset;
  readonly change: bigint;
}

export interface ContractFailure {
  readonly contract: string;
  readonly code: number;
}

type Movement = readonly [address: string, sign: bigint];

export function decodeEvents(
  contractEventsXdr: readonly (readonly string[])[],
): xdr.ContractEvent[] {
  return contractEventsXdr
    .flat()
    .map((event) => xdr.ContractEvent.fromXdr(event, 'base64'));
}

export function contractEvents(
  events: readonly xdr.ContractEvent[],
): ContractEvent[] {
  return events.flatMap((event) => {
    const contract = contractOf(event);
    if (!contract) return [];
    const { topics, data } = event.body.v0;
    return [
      {
        contract,
        topics: topics.map((topic) => scValToNative(topic)),
        data: scValToNative(data),
      },
    ];
  });
}

export function balanceChanges(
  events: readonly xdr.ContractEvent[],
): BalanceChange[] {
  const totals = new Map<string, BalanceChange>();
  for (const event of events) {
    const asset = contractOf(event);
    const amount = amountOf(event.body.v0.data);
    if (!asset || amount === null) continue;
    for (const [address, sign] of movements(event.body.v0.topics)) {
      const key = `${asset} ${address}`;
      const change = (totals.get(key)?.change ?? 0n) + sign * amount;
      totals.set(key, { address, asset, change });
    }
  }
  return [...totals.values()].filter(({ change }) => change !== 0n);
}

export function assetContract(
  asset: string,
  networkPassphrase: string,
): string {
  if (asset === 'native') {
    return ClassicAsset.native().contractId(networkPassphrase);
  }
  const separator = asset.indexOf(':');
  if (separator < 0) return asset;
  return new ClassicAsset(
    asset.slice(0, separator),
    asset.slice(separator + 1),
  ).contractId(networkPassphrase);
}

export function contractFailure(
  diagnosticEventsXdr: readonly string[],
): ContractFailure | null {
  for (const raw of diagnosticEventsXdr) {
    const { event } = xdr.DiagnosticEvent.fromXdr(raw, 'base64');
    const [name, error] = event.body.v0.topics;
    const contract = contractOf(event);
    if (
      contract &&
      symbol(name) === 'error' &&
      error?.type === 'scvError' &&
      error.error.type === 'sceContract'
    ) {
      return { contract, code: error.error.contractCode };
    }
  }
  return null;
}

function movements([
  name,
  ...topics
]: readonly xdr.ScVal[]): readonly Movement[] {
  const [first, second] = topics.slice(0, 2).map(address);
  if (!first) return [];
  // Older token SDKs emit [mint, admin, to] and [clawback, admin, from].
  const holder = second ?? first;
  switch (symbol(name)) {
    case 'transfer':
      return second
        ? [
            [first, -1n],
            [second, 1n],
          ]
        : [];
    case 'mint':
      return [[holder, 1n]];
    case 'burn':
      return [[first, -1n]];
    case 'clawback':
      return [[holder, -1n]];
    default:
      return [];
  }
}

function amountOf(data: xdr.ScVal): bigint | null {
  if (data.type === 'scvI128') return scValToNative(data);
  if (data.type !== 'scvMap') return null;
  const entry = data.map?.find(({ key }) => symbol(key) === 'amount');
  return entry?.val.type === 'scvI128' ? scValToNative(entry.val) : null;
}

function contractOf(event: xdr.ContractEvent): `C${string}` | null {
  return event.contractId
    ? (StrKey.encodeContract(event.contractId.toBytes()) as `C${string}`)
    : null;
}

function address(value: xdr.ScVal | undefined): string | null {
  return value?.type === 'scvAddress'
    ? Address.fromScAddress(value.address).toString()
    : null;
}

function symbol(value: xdr.ScVal | undefined): string | null {
  return value?.type === 'scvSymbol' ? value.sym.toString() : null;
}
