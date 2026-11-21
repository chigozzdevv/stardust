import { Address, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { assetSpec } from '@/contracts/asset-spec';
import { ContractSpecs } from '@/contracts/spec';
import { Rpc } from '@/network/rpc';
import { answer, recording, replay } from '@tests/helpers/replay';

const testnet = 'https://soroban-testnet.stellar.org';
const nativeSac = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const soroswapPair = 'CDO5TKQUEGINSQMX4NE62AGR2FSANGTOVV5Z77AQHQBFT5VGV4DUTAX3';
const [pairInstance, pairCode] = recording('wasm-spec');

function specs(send: typeof fetch): ContractSpecs {
  return new ContractSpecs(new Rpc(testnet, send));
}

function entries(...data: xdr.LedgerEntryData[]) {
  return {
    latestLedger: 5803363,
    entries: data.map((entry) => ({
      key: '',
      xdr: entry.toXdr('base64'),
      lastModifiedLedgerSeq: 1,
    })),
  };
}

function instance(executable: xdr.ContractExecutable): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(soroswapPair).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({ executable, storage: null }),
      ),
    }),
  );
}

describe('ContractSpecs', () => {
  it('uses the built-in spec for a Stellar Asset Contract', async () => {
    const spec = await specs(replay(...recording('asset-instance'))).get(
      nativeSac,
    );
    expect(spec).toBe(assetSpec);
  });

  it('reads a Wasm spec and caches it by code hash', async () => {
    const send = vi.fn(replay(...recording('wasm-spec')));
    const pair = specs(send);

    const spec = await pair.get(soroswapPair);
    expect(spec).not.toBe('unreadable');
    if (spec === 'unreadable') return;
    expect(spec.functions.get('transfer')).toEqual(['from', 'to', 'amount']);
    expect(spec.functions.get('swap')).toEqual([
      'amount_0_out',
      'amount_1_out',
      'to',
    ]);
    expect(spec.errors.get(101)).toBe('InitializeAlreadyInitialized');
    expect(spec.errors.get(1)).toBeUndefined();

    await expect(pair.get(soroswapPair)).resolves.toBe(spec);
    expect(
      send.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).params),
    ).toEqual([pairInstance?.params, pairCode?.params, pairInstance?.params]);
  });

  it('reports a contract without an instance as unreadable', async () => {
    await expect(
      specs(answer(() => entries())).get(soroswapPair),
    ).resolves.toBe('unreadable');
  });

  it('reports an invalid contract ID as unreadable without asking the RPC', async () => {
    const send = vi.fn(answer(() => entries()));
    await expect(specs(send).get('GABC')).resolves.toBe('unreadable');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports an executable other than Wasm or a Stellar Asset as unreadable', async () => {
    const external = xdr.ContractExecutable.contractExecutableExternalRef(
      new xdr.ContractExecutableExternalRef({
        executableOwner: new Address(nativeSac).toScAddress(),
        tag: 'pair',
      }),
    );
    await expect(
      specs(answer(() => entries(instance(external)))).get(soroswapPair),
    ).resolves.toBe('unreadable');
  });

  it('caches Wasm without a spec as unreadable', async () => {
    const hash = new Uint8Array(32).fill(7);
    const code = xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: xdr.ContractCodeEntryExt.v0(),
        hash,
        code: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      }),
    );
    const wasm = instance(xdr.ContractExecutable.contractExecutableWasm(hash));
    const send = vi.fn(
      answer(({ params }) => {
        const [key] = (params as { keys: string[] }).keys;
        const { type } = xdr.LedgerKey.fromXdr(String(key), 'base64');
        return entries(type === 'contractCode' ? code : wasm);
      }),
    );
    const noSpec = specs(send);

    await expect(noSpec.get(soroswapPair)).resolves.toBe('unreadable');
    await expect(noSpec.get(soroswapPair)).resolves.toBe('unreadable');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('reports an RPC failure as unreadable without caching it', async () => {
    const working = replay(...recording('wasm-spec'));
    let down = true;
    const send: typeof fetch = (url, init) =>
      down ? Promise.reject(new TypeError('fetch failed')) : working(url, init);
    const pair = specs(send);

    await expect(pair.get(soroswapPair)).resolves.toBe('unreadable');
    down = false;
    await expect(pair.get(soroswapPair)).resolves.toMatchObject({
      errors: expect.any(Map),
    });
  });

  it("passes the caller's abort reason through", async () => {
    const controller = new AbortController();
    const reason = new Error('test ended');
    controller.abort(reason);
    await expect(
      specs(replay(...recording('wasm-spec'))).get(
        soroswapPair,
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });
});

describe('assetSpec', () => {
  it('names the Stellar Asset Contract functions and arguments', () => {
    expect([...assetSpec.functions.keys()].sort()).toEqual([
      'admin',
      'allowance',
      'approve',
      'authorized',
      'balance',
      'burn',
      'burn_from',
      'clawback',
      'decimals',
      'mint',
      'name',
      'set_admin',
      'set_authorized',
      'symbol',
      'transfer',
      'transfer_from',
      'trust',
    ]);
    expect(assetSpec.functions.get('transfer')).toEqual([
      'from',
      'to',
      'amount',
    ]);
    expect(assetSpec.functions.get('approve')).toEqual([
      'from',
      'spender',
      'amount',
      'live_until_ledger',
    ]);
    expect(assetSpec.functions.get('set_authorized')).toEqual([
      'id',
      'authorize',
    ]);
  });

  it('names the Stellar Asset Contract errors by code', () => {
    expect([...assetSpec.errors.keys()]).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(assetSpec.errors.get(8)).toBe('NegativeAmountError');
    expect(assetSpec.errors.get(10)).toBe('BalanceError');
    expect(assetSpec.errors.get(13)).toBe('TrustlineMissingError');
  });
});
