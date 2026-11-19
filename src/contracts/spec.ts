import { Contract, contract, xdr } from '@stellar/stellar-sdk';
import { assetSpec } from '@/contracts/asset-spec';
import type { Rpc } from '@/network/network';

export interface ContractSpec {
  readonly functions: ReadonlyMap<string, readonly string[]>;
  readonly errors: ReadonlyMap<number, string>;
}

export type SpecLookup = ContractSpec | 'unreadable';

export class ContractSpecs {
  private readonly byHash = new Map<string, SpecLookup>();

  constructor(private readonly rpc: Rpc) {}

  async get(contractId: string, signal?: AbortSignal): Promise<SpecLookup> {
    try {
      const instance = await this.entry(
        new Contract(contractId).getFootprint(),
        signal,
      );
      if (
        instance?.type !== 'contractData' ||
        instance.contractData.val.type !== 'scvContractInstance'
      ) {
        return 'unreadable';
      }
      const { executable } = instance.contractData.val.instance;
      if (executable.type === 'contractExecutableStellarAsset') {
        return assetSpec;
      }
      if (executable.type !== 'contractExecutableWasm') return 'unreadable';
      return await this.wasmSpec(executable.wasmHash, signal);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return 'unreadable';
    }
  }

  private async wasmSpec(
    hash: xdr.Hash,
    signal?: AbortSignal,
  ): Promise<SpecLookup> {
    const cached = this.byHash.get(hash.toString());
    if (cached) return cached;
    const code = await this.entry(
      xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash })),
      signal,
    );
    if (code?.type !== 'contractCode') return 'unreadable';
    const spec = readSpec(code.contractCode.code);
    this.byHash.set(hash.toString(), spec);
    return spec;
  }

  private async entry(
    key: xdr.LedgerKey,
    signal?: AbortSignal,
  ): Promise<xdr.LedgerEntryData | null> {
    const { entries } = await this.rpc.call(
      'getLedgerEntries',
      { keys: [key.toXdr('base64')] },
      signal,
    );
    const [entry] = entries;
    return entry ? xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64') : null;
  }
}

function readSpec(wasm: Uint8Array): SpecLookup {
  try {
    const spec = contract.Spec.fromWasm(wasm);
    return {
      functions: new Map(
        spec
          .funcs()
          .map((fn) => [
            fn.name.toString(),
            fn.inputs.map((input) => input.name.toString()),
          ]),
      ),
      errors: new Map(
        spec.errorCases().map((error) => [error.value, error.name.toString()]),
      ),
    };
  } catch {
    return 'unreadable';
  }
}
