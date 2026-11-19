import {
  Address,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  assetContract,
  balanceChanges,
  contractEvents,
  contractFailure,
  decodeEvents,
} from '@/network/events';
import { transactionInfo } from '@/network/schema';
import { recordedResult } from '@tests/fixtures/rpc/replay';

const native = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const usdc = 'CBM44TNMCPYIFJO4PSMDZA7IXKJRRNHA6EOWNWI3X4V47DDC7WQXXD3E';
const token = StrKey.encodeContract(new Uint8Array(32).fill(9));
const account = (seed: number) =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();
const alice = account(1);
const bob = account(2);
const admin = account(3);

function recorded(name: string) {
  return transactionInfo.parse(recordedResult(name));
}

function changes(name: string) {
  return balanceChanges(decodeEvents(recorded(name).events.contractEventsXdr));
}

function event(
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  contract: string | null = token,
): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: contract
      ? new xdr.ContractId(StrKey.decodeContract(contract))
      : null,
    type: xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data })),
  });
}

const symbol = (name: string) => xdr.ScVal.scvSymbol(name);
const address = (value: string) => new Address(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const map = (entries: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(entries).map(
      ([key, val]) => new xdr.ScMapEntry({ key: symbol(key), val }),
    ),
  );

describe('balanceChanges on recorded testnet transactions', () => {
  it('reads a classic payment and leaves the fee out', () => {
    const payment = recorded('classic-payment');
    expect(payment.events.transactionEventsXdr).toHaveLength(1);
    expect(changes('classic-payment')).toEqual([
      {
        address: 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH',
        asset: native,
        change: -20_000_000n,
      },
      {
        address: 'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV',
        asset: native,
        change: 20_000_000n,
      },
    ]);
  });

  it('reads a Stellar Asset Contract transfer and ignores the fee and refund events', () => {
    expect(recorded('sac-transfer').events.transactionEventsXdr).toHaveLength(
      2,
    );
    expect(changes('sac-transfer')).toEqual([
      {
        address: 'GCVVDPD4M4YOAXEKXJ6YQLPFO43F5MEMSG3J7FOVRBWSMYT7KT7QDHOS',
        asset: native,
        change: -18_500_000n,
      },
      {
        address: 'CDAM4O427TUPATTJXWYYMFX5UOLPTQXOLWGOB6DAH6I3EDS4RPUGR3JL',
        asset: native,
        change: 18_500_000n,
      },
    ]);
  });

  it('credits a payment to a muxed account to its base address', () => {
    expect(changes('muxed-payment')).toEqual([
      {
        address: 'GC7WUTOE6JPIB7N7YCDLOMTEXR7ESICBFSTBF7EQQESJGHLANNTGHAUJ',
        asset: native,
        change: -1_000_000_000n,
      },
      {
        address: 'GAW2Z4LBVIZMDWANIPCYD7HXEF34VZYFQCQFJBHTB73HVSESVN6OKBGF',
        asset: native,
        change: 1_000_000_000n,
      },
    ]);
  });

  it('reads a mint whose data is a map with an amount', () => {
    expect(changes('issuer-payment')).toEqual([
      {
        address: 'GBDB3YTERDZWOJNMJA2E72BLBOGRTTPDRVLZV34APVYDOSTJPRYZ7AVV',
        asset: 'CCBBNJE3KXO7TSIROSAKOK3FZPULDDOXMYTQEFPGWTOG7DFZ3J2ZYFU4',
        change: 100_000_000n,
      },
    ]);
  });

  it('reads mints and burns among other contract events', () => {
    expect(changes('sac-swap')).toEqual([
      {
        address: 'CDO5TKQUEGINSQMX4NE62AGR2FSANGTOVV5Z77AQHQBFT5VGV4DUTAX3',
        asset: usdc,
        change: 3_934_596_543_077n,
      },
      {
        address: 'CDO5TKQUEGINSQMX4NE62AGR2FSANGTOVV5Z77AQHQBFT5VGV4DUTAX3',
        asset: 'CBVJ6GYJJ55ALTHN32OJEFGUZWWTMDFGIBCM42SPYQ4GWLKX2XARAP2N',
        change: -322_693_536_773n,
      },
      {
        address: 'CBLKPKQEGPLPJNRGJFCE2JLRNGWZATG4WI55AA77UYNZXLLYNVNOFHBS',
        asset: usdc,
        change: 1_237_391_262_645n,
      },
      {
        address: 'CBLKPKQEGPLPJNRGJFCE2JLRNGWZATG4WI55AA77UYNZXLLYNVNOFHBS',
        asset: 'CAEXCVZUCB6FGYKU6YAEUJMVCLS74SPSQ2TTEOLJ27A3C6C627OQON47',
        change: -4_555_341_765n,
      },
      {
        address: 'CDPBZ6XXEUSH2QZ5F4OZMCBUQKK4TITKC3XMNVAGQBVMRSO3MWMASDOW',
        asset: usdc,
        change: 462_985_802n,
      },
      {
        address: 'CDPBZ6XXEUSH2QZ5F4OZMCBUQKK4TITKC3XMNVAGQBVMRSO3MWMASDOW',
        asset: native,
        change: -9_290_241_500n,
      },
      {
        address: 'GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX',
        asset: native,
        change: 9_290_241_500n,
      },
    ]);
  });

  it('reads a clawback', () => {
    expect(changes('classic-clawback')).toEqual([
      {
        address: 'GCH723QSRPVPL4XUDCR7FRWI2KYQX6O7VEKZGP4AQNPNMQJKTQXENDVC',
        asset: 'CCSUGTEIS6I6CTQMYSUMSY4WGTBFSMGMOWNXOCTWDG2DRFTAD7RKTUCQ',
        change: -2_868_763_456n,
      },
    ]);
  });

  it('takes the third topic as the holder of a two-address mint', () => {
    const vault = 'CDR4WRWLHN2KNAEWT4ZFOL42WDQAHF3N7TLYB7QA5IORUS7XP4UJGTHS';
    const depositor =
      'GDGAAJ6324CJNIWZUNAWGRA7V7F7FZV4J2V6IJDUQBQYT4WM6YTZOD7C';
    expect(changes('vault-deposit')).toEqual([
      { address: depositor, asset: native, change: -10_000_000n },
      { address: vault, asset: native, change: 10_000_000n },
      { address: depositor, asset: vault, change: 10_000_000n },
    ]);
  });
});

describe('balanceChanges on built events', () => {
  it('takes the third topic as the holder of a two-address clawback', () => {
    expect(
      balanceChanges([
        event([symbol('clawback'), address(admin), address(alice)], i128(5n)),
      ]),
    ).toEqual([{ address: alice, asset: token, change: -5n }]);
  });

  it('allows extra topics after the SEP-41 layout', () => {
    expect(
      balanceChanges([
        event(
          [
            symbol('transfer'),
            address(alice),
            address(bob),
            xdr.ScVal.scvString('native'),
            symbol('extra'),
          ],
          i128(3n),
        ),
        event(
          [symbol('mint'), address(bob), xdr.ScVal.scvString('X')],
          i128(4n),
        ),
        event(
          [symbol('burn'), address(alice), xdr.ScVal.scvString('X')],
          i128(1n),
        ),
      ]),
    ).toEqual([
      { address: alice, asset: token, change: -4n },
      { address: bob, asset: token, change: 7n },
    ]);
  });

  it('ignores the other keys of a map and skips events without an amount', () => {
    expect(
      balanceChanges([
        event(
          [symbol('mint'), address(alice)],
          map({ amount: i128(9n), to_muxed_id: nativeToScVal(4n) }),
        ),
        event(
          [symbol('burn'), address(alice)],
          map({ token_id: nativeToScVal(7, { type: 'u32' }) }),
        ),
        event(
          [symbol('burn'), address(alice)],
          map({ amount: nativeToScVal(2n, { type: 'u64' }) }),
        ),
        event(
          [symbol('burn'), address(alice)],
          nativeToScVal(2n, { type: 'u64' }),
        ),
      ]),
    ).toEqual([{ address: alice, asset: token, change: 9n }]);
  });

  it('skips events that do not follow the SEP-41 layouts', () => {
    expect(
      balanceChanges([
        event([symbol('transfer'), address(alice)], i128(1n)),
        event([xdr.ScVal.scvString('mint'), address(alice)], i128(1n)),
        event([symbol('mint'), xdr.ScVal.scvString(alice)], i128(1n)),
        event([symbol('approve'), address(alice), address(bob)], i128(1n)),
        event([symbol('mint'), address(alice)], i128(1n), null),
        event([], i128(1n)),
      ]),
    ).toEqual([]);
  });

  it('sums events per token and address and drops changes that net to zero', () => {
    const other = StrKey.encodeContract(new Uint8Array(32).fill(8));
    expect(
      balanceChanges([
        event([symbol('mint'), address(alice)], i128(10n)),
        event([symbol('mint'), address(alice)], i128(10n), other),
        event([symbol('transfer'), address(alice), address(bob)], i128(4n)),
        event([symbol('transfer'), address(bob), address(alice)], i128(4n)),
      ]),
    ).toEqual([
      { address: alice, asset: token, change: 10n },
      { address: alice, asset: other, change: 10n },
    ]);
  });
});

describe('contractEvents', () => {
  it('decodes topics and data to native values', () => {
    expect(
      contractEvents(
        decodeEvents(recorded('muxed-payment').events.contractEventsXdr),
      ),
    ).toEqual([
      {
        contract: native,
        topics: [
          'transfer',
          'GC7WUTOE6JPIB7N7YCDLOMTEXR7ESICBFSTBF7EQQESJGHLANNTGHAUJ',
          'GAW2Z4LBVIZMDWANIPCYD7HXEF34VZYFQCQFJBHTB73HVSESVN6OKBGF',
          'native',
        ],
        data: { amount: 1_000_000_000n, to_muxed_id: 10_120_291n },
      },
    ]);
  });

  it('keeps the order of the operations and skips events without a contract', () => {
    expect(
      contractEvents([
        event([symbol('first')], xdr.ScVal.scvVoid()),
        event([symbol('second')], xdr.ScVal.scvVoid(), null),
        event([symbol('third')], i128(1n)),
      ]),
    ).toEqual([
      { contract: token, topics: ['first'], data: null },
      { contract: token, topics: ['third'], data: 1n },
    ]);
  });
});

describe('assetContract', () => {
  it('maps classic assets to their Stellar Asset Contract', () => {
    expect(assetContract('native', Networks.TESTNET)).toBe(native);
    expect(
      assetContract(
        'USDC:GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX',
        Networks.TESTNET,
      ),
    ).toBe(usdc);
    expect(assetContract(usdc, Networks.TESTNET)).toBe(usdc);
  });

  it('depends on the network', () => {
    expect(assetContract('native', Networks.FUTURENET)).not.toBe(native);
  });
});

describe('contractFailure', () => {
  it('reads the first contract error from the diagnostic events', () => {
    expect(
      contractFailure(recorded('failed-call').diagnosticEventsXdr),
    ).toEqual({ contract: native, code: 10 });
  });

  it('finds none when the failure is not a contract error', () => {
    const auth = recorded('failed-auth');
    expect(auth.diagnosticEventsXdr.length).toBeGreaterThan(0);
    expect(contractFailure(auth.diagnosticEventsXdr)).toBeNull();
    expect(
      contractFailure(recorded('failed-classic').diagnosticEventsXdr),
    ).toBeNull();
  });
});
