import {
  Account,
  Address,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  buildAuthorizationEntryPreimage,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ContractSpecs } from '@/contracts/spec';
import { Rpc } from '@/network/network';
import {
  decodeAuthPreimage,
  decodeTransaction,
  nameArgs,
} from '@/wallet/decode';
import {
  answer,
  recordedResult,
  recording,
  replay,
} from '@tests/fixtures/rpc/replay';

const testnet = 'https://soroban-testnet.stellar.org';
const standalone = 'Standalone Network ; February 2017';
const nativeSac = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const vault = 'CDR4WRWLHN2KNAEWT4ZFOL42WDQAHF3N7TLYB7QA5IORUS7XP4UJGTHS';
const depositor = 'GDGAAJ6324CJNIWZUNAWGRA7V7F7FZV4J2V6IJDUQBQYT4WM6YTZOD7C';
const router = 'CDUDWXU3UBMW6NDXYJGLBOSJMAQE4ESVR2UF64SUJ45NOO6CAOQSQEMY';
const routerToken = 'CD4MP2QV4LABFU5OL6Y5RICCLQIX7TWT6T6J546EDYVUXHH6RS2V5S2O';
const orderBook = 'CDNT4MLYK7FDJJIPMAWZQZ2IM2OOTSP7UVCO6WFLX6MMSXC3MGEWT5F4';
const relayed = 'CCJTGNNWUZECCQIRQJ4F62XSFODODCKP5FKKX6ZQHNOFGHUPB5RWYWYW';

function envelope(name: string): string {
  return String(recordedResult(name).envelopeXdr);
}

function authOf(name: string): xdr.SorobanAuthorizationEntry {
  const parsed = xdr.TransactionEnvelope.fromXdr(envelope(name), 'base64');
  const transaction =
    parsed.type === 'envelopeTypeTxFeeBump'
      ? parsed.feeBump.tx.innerTx.v1.tx
      : parsed.type === 'envelopeTypeTx'
        ? parsed.v1.tx
        : null;
  const body = transaction?.operations[0]?.body;
  const [entry] =
    body?.type === 'invokeHostFunction' ? body.invokeHostFunctionOp.auth : [];
  if (!entry) throw new Error(`${name} has no auth entry`);
  return entry;
}

function specs(send: typeof fetch): ContractSpecs {
  return new ContractSpecs(new Rpc(testnet, send));
}

function signedBy(
  address: string,
  version: 'v1' | 'v2' = 'v1',
): xdr.SorobanCredentials {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(address).toScAddress(),
    nonce: 7n,
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  return version === 'v1'
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
    : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials);
}

function withCredentials(
  entry: xdr.SorobanAuthorizationEntry,
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: entry.rootInvocation,
  });
}

function preimageFor(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): string {
  return buildAuthorizationEntryPreimage(
    entry,
    5_795_776,
    networkPassphrase,
  ).toXdr('base64');
}

const assetSpecs = () => specs(replay(...recording('asset-instance')));

const authorizedCalls = [
  {
    contract: router,
    fn: 'forward_dynamic',
    args: [
      routerToken,
      2_000_000n,
      5_795_776n,
      'GBIBH5UV4Q5L7VVJIHWYBTCSUDHJQXQC2V6Y5LOW4D26XNU5NREMIKE4',
      'CC56K5I2HIPN5JWLM55V3YJ3QW64JQNU6MS5C4SS4A2VGZ6BKWXAUUIJ',
      'create_and_try_fill',
    ],
    namedArgs: null,
    depth: 0,
  },
  {
    contract: routerToken,
    fn: 'approve',
    args: [relayed, router, 2_000_000n, 5_795_776n],
    namedArgs: null,
    depth: 1,
  },
  {
    contract: orderBook,
    fn: 'create_order',
    args: [
      relayed,
      false,
      3n,
      170_141_183_460_469_231_731_687_303_715_884_105_727n,
      0n,
      0n,
      141_051_400_645_917_286n,
      5_795_795n,
    ],
    namedArgs: null,
    depth: 1,
  },
  {
    contract: routerToken,
    fn: 'transfer',
    args: [relayed, orderBook, 100_000n],
    namedArgs: null,
    depth: 2,
  },
];

describe('decodeTransaction', () => {
  it('decodes a native payment', () => {
    const payment = envelope('classic-payment');
    expect(decodeTransaction(payment, Networks.TESTNET)).toEqual({
      xdr: payment,
      hash: 'c4c68a3c28df417d043d10aefded59d4e8b7c637db1fae0cbf986ad2ea42f287',
      source: 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH',
      fee: 100n,
      sequence: 8_409_546_444_930n,
      memo: { type: 'none', value: null },
      operations: [
        {
          type: 'payment',
          source: 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH',
          body: {
            destination:
              'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV',
            asset: 'native',
            amount: 20_000_000n,
          },
        },
      ],
      invocations: [],
      authEntries: [],
    });
  });

  it('writes a credit asset as CODE:ISSUER and reads a text memo', () => {
    const issuer = 'GD6IWDGCD55BG5UXQ5P24WKNATQB4DP2BRSFHKBJK775JR2WFI6GQ3BS';
    expect(
      decodeTransaction(envelope('issuer-payment'), Networks.TESTNET),
    ).toMatchObject({
      source: issuer,
      fee: 1_000_000n,
      memo: { type: 'text', value: 'Test Transaction' },
      operations: [
        {
          type: 'payment',
          source: null,
          body: {
            destination:
              'GBDB3YTERDZWOJNMJA2E72BLBOGRTTPDRVLZV34APVYDOSTJPRYZ7AVV',
            asset: `BBUCKS:${issuer}`,
            amount: 100_000_000n,
          },
        },
      ],
    });
  });

  it('decodes changeTrust with the asset field Operation.changeTrust takes', () => {
    const source = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const usdc = new Asset('USDC', issuer);
    const built = new TransactionBuilder(new Account(source, '41'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdc, limit: '1000' }))
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: usdc,
          sendAmount: '1.5',
          destination: issuer,
          destAsset: Asset.native(),
          destMin: '0.1',
          path: [new Asset('EURC', issuer)],
        }),
      )
      .addOperation(
        Operation.manageSellOffer({
          selling: usdc,
          buying: Asset.native(),
          amount: '3',
          price: '1.5',
        }),
      )
      .addMemo(Memo.id('42'))
      .setTimeout(0)
      .build();

    expect(decodeTransaction(built.toXDR(), Networks.TESTNET)).toEqual({
      xdr: built.toXDR(),
      hash: Buffer.from(built.hash()).toString('hex'),
      source,
      fee: 300n,
      sequence: 42n,
      memo: { type: 'id', value: '42' },
      operations: [
        {
          type: 'changeTrust',
          source: null,
          body: { asset: `USDC:${issuer}`, limit: 10_000_000_000n },
        },
        {
          type: 'pathPaymentStrictSend',
          source: null,
          body: {
            sendAsset: `USDC:${issuer}`,
            sendAmount: 15_000_000n,
            destination: issuer,
            destAsset: 'native',
            destMin: 1_000_000n,
            path: [`EURC:${issuer}`],
          },
        },
        {
          type: 'manageSellOffer',
          source: null,
          body: {
            selling: `USDC:${issuer}`,
            buying: 'native',
            amount: 30_000_000n,
            price: '1.5',
            offerId: '0',
          },
        },
      ],
      invocations: [],
      authEntries: [],
    });
  });

  it('writes hash and return memos in hex', () => {
    const source = Keypair.random().publicKey();
    const memoOf = (memo: Memo) =>
      decodeTransaction(
        new TransactionBuilder(new Account(source, '1'), {
          fee: '100',
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
          .addMemo(memo)
          .setTimeout(0)
          .build()
          .toXDR(),
        Networks.TESTNET,
      ).memo;

    expect(memoOf(Memo.hash('ab'.repeat(32)))).toEqual({
      type: 'hash',
      value: 'ab'.repeat(32),
    });
    expect(memoOf(Memo.return('cd'.repeat(32)))).toEqual({
      type: 'return',
      value: 'cd'.repeat(32),
    });
  });

  it('names the arguments of a Stellar Asset Contract transfer', async () => {
    const from = 'GCVVDPD4M4YOAXEKXJ6YQLPFO43F5MEMSG3J7FOVRBWSMYT7KT7QDHOS';
    const to = 'CDAM4O427TUPATTJXWYYMFX5UOLPTQXOLWGOB6DAH6I3EDS4RPUGR3JL';
    const transfer = {
      contract: nativeSac,
      fn: 'transfer',
      args: [from, to, 18_500_000n],
      depth: 0,
    };
    const decoded = decodeTransaction(
      envelope('sac-transfer'),
      Networks.TESTNET,
    );
    expect(decoded.invocations).toEqual([{ ...transfer, namedArgs: null }]);
    expect(decoded.authEntries).toEqual([]);

    const named = await nameArgs(decoded, assetSpecs());
    expect(named).toEqual({
      ...decoded,
      invocations: [
        { ...transfer, namedArgs: { from, to, amount: 18_500_000n } },
      ],
    });
  });

  it('lists authorized sub-calls after the top-level call', async () => {
    const decoded = decodeTransaction(
      envelope('vault-deposit'),
      Networks.TESTNET,
    );
    const named = await nameArgs(decoded, assetSpecs());
    expect(named.invocations).toEqual([
      {
        contract: vault,
        fn: 'deposit',
        args: [[10_000_000n], [9_950_000n], depositor, false],
        namedArgs: null,
        depth: 0,
      },
      {
        contract: nativeSac,
        fn: 'transfer',
        args: [depositor, vault, 10_000_000n],
        namedArgs: { from: depositor, to: vault, amount: 10_000_000n },
        depth: 1,
      },
    ]);
  });

  it('decodes a fee bump and the auth entries signed by an address', () => {
    const bump = envelope('failed-bump');
    const decoded = decodeTransaction(bump, Networks.TESTNET);
    expect(decoded).toMatchObject({
      xdr: bump,
      hash: 'fed9b39f92b118003f2baa5528e020e74af95ad878189a6fe9acaf51fda60128',
      source: 'GAK7RFP2DHT4EDXPDU7YTVBCXU2WDXM426DYHXL6ADDJKXQI6UPCYF66',
      fee: 1_049_594n,
      sequence: 19_404_688_013_133_205n,
      memo: { type: 'none', value: null },
      operations: [{ type: 'invokeHostFunction', source: null }],
    });
    expect(decoded.authEntries).toEqual([
      {
        xdr: authOf('failed-bump').toXdr('base64'),
        address: relayed,
        expirationLedger: 5_795_776,
        invocations: authorizedCalls,
      },
    ]);
  });

  it('lists an entry for the top-level call by its sub-calls only', () => {
    const [top, ...authorized] = decodeTransaction(
      envelope('failed-bump'),
      Networks.TESTNET,
    ).invocations;

    expect(top).toMatchObject({
      contract: router,
      fn: 'forward_dynamic',
      namedArgs: null,
      depth: 0,
    });
    expect(top?.args).toHaveLength(9);
    expect(top?.args.slice(0, 4)).toEqual([
      routerToken,
      442n,
      2_000_000n,
      5_795_776n,
    ]);
    expect(authorized).toEqual(authorizedCalls.slice(1));
  });

  it("fetches each contract's spec once", async () => {
    const send = vi.fn(answer(() => ({ latestLedger: 1, entries: [] })));
    const decoded = decodeTransaction(
      envelope('failed-bump'),
      Networks.TESTNET,
    );

    const named = await nameArgs(decoded, specs(send));
    expect(send).toHaveBeenCalledTimes(3);
    expect(named).toEqual(decoded);
  });

  it('throws on XDR that is not a transaction envelope', () => {
    const preimage = preimageFor(
      withCredentials(authOf('sac-transfer'), signedBy(depositor)),
      Networks.TESTNET,
    );
    for (const invalid of ['', 'not base64!', 'AAAA', preimage]) {
      expect(() => decodeTransaction(invalid, Networks.TESTNET)).toThrow();
    }
  });
});

describe('decodeAuthPreimage', () => {
  const signer = Keypair.random().publicKey();

  it('reads the network, nonce, expiration ledger and calls', () => {
    const preimage = preimageFor(authOf('failed-bump'), Networks.TESTNET);
    expect(decodeAuthPreimage(preimage, Networks.TESTNET)).toEqual({
      xdr: preimage,
      networkPassphrase: Networks.TESTNET,
      nonce: 5_808_154_227_419_720_189n,
      expirationLedger: 5_795_776,
      invocations: authorizedCalls,
    });
  });

  it('reads an address-bound preimage', () => {
    const entry = withCredentials(
      authOf('sac-transfer'),
      signedBy(signer, 'v2'),
    );
    const preimage = preimageFor(entry, Networks.TESTNET);
    expect(xdr.HashIdPreimage.fromXdr(preimage, 'base64').type).toBe(
      'envelopeTypeSorobanAuthorizationWithAddress',
    );
    expect(decodeAuthPreimage(preimage, Networks.TESTNET)).toMatchObject({
      networkPassphrase: Networks.TESTNET,
      nonce: 7n,
      expirationLedger: 5_795_776,
      invocations: [{ contract: nativeSac, fn: 'transfer', depth: 0 }],
    });
  });

  it("matches the embedded network ID with known networks and the wallet's", () => {
    const entry = withCredentials(authOf('sac-transfer'), signedBy(signer));
    const passphrase = (built: string, wallet: string) =>
      decodeAuthPreimage(preimageFor(entry, built), wallet).networkPassphrase;

    expect(passphrase(Networks.FUTURENET, Networks.TESTNET)).toBe(
      Networks.FUTURENET,
    );
    expect(passphrase(Networks.PUBLIC, Networks.TESTNET)).toBe(Networks.PUBLIC);
    expect(passphrase(standalone, Networks.TESTNET)).toBeNull();
    expect(passphrase(standalone, standalone)).toBe(standalone);
  });

  it('names the arguments of the authorized calls', async () => {
    const entry = withCredentials(authOf('sac-transfer'), signedBy(signer));
    const decoded = decodeAuthPreimage(
      preimageFor(entry, Networks.TESTNET),
      Networks.TESTNET,
    );
    const named = await nameArgs(decoded, assetSpecs());
    expect(named.invocations).toEqual([
      expect.objectContaining({
        namedArgs: {
          from: 'GCVVDPD4M4YOAXEKXJ6YQLPFO43F5MEMSG3J7FOVRBWSMYT7KT7QDHOS',
          to: 'CDAM4O427TUPATTJXWYYMFX5UOLPTQXOLWGOB6DAH6I3EDS4RPUGR3JL',
          amount: 18_500_000n,
        },
      }),
    ]);
  });

  it('throws on XDR that is not a Soroban authorization preimage', () => {
    const operationId = xdr.HashIdPreimage.envelopeTypeOpId(
      new xdr.HashIdPreimageOperationId({
        sourceAccount: Keypair.fromPublicKey(signer).xdrAccountId(),
        seqNum: 1n,
        opNum: 0,
      }),
    ).toXdr('base64');

    expect(() => decodeAuthPreimage(operationId, Networks.TESTNET)).toThrow(
      'the HashIdPreimage is envelopeTypeOpId, but signing an auth entry needs envelopeTypeSorobanAuthorization',
    );
    for (const invalid of ['', 'not base64!', envelope('sac-transfer')]) {
      expect(() => decodeAuthPreimage(invalid, Networks.TESTNET)).toThrow();
    }
  });
});
