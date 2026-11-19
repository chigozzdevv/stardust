import { createHash } from 'node:crypto';
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { xlm } from '@/amounts';
import { Rpc } from '@/network/network';
import { decodeTransaction } from '@/wallet/decode';
import {
  addTrustline,
  readToken,
  signAuthEntry,
  signMessage,
  signTransaction,
} from '@/wallet/signer';
import {
  FakeLedger,
  sacInstance,
  trustlineEntry,
} from '@tests/fixtures/rpc/fake-ledger';
import { answer, recording, replay } from '@tests/fixtures/rpc/replay';
import sep53 from '@tests/fixtures/sep53-vectors.json';

const testnet = 'https://soroban-testnet.stellar.org';
const nativeSac = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const soroswapPair = 'CDO5TKQUEGINSQMX4NE62AGR2FSANGTOVV5Z77AQHQBFT5VGV4DUTAX3';
const maxLimit = 9_223_372_036_854_775_807n;
const fast = { timeoutMs: 200, intervalMs: 1 };

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

function payment(source: Keypair, networkPassphrase: string): string {
  return new TransactionBuilder(new Account(source.publicKey(), '7'), {
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

function transferEntry(
  from: Keypair,
  version: 'v1' | 'v2' = 'v1',
): xdr.SorobanAuthorizationEntry {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(from.publicKey()).toScAddress(),
    nonce: 99n,
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      version === 'v1'
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(nativeSac).toScAddress(),
            functionName: 'transfer',
            args: [
              nativeToScVal(from.publicKey(), { type: 'address' }),
              nativeToScVal(Keypair.random().publicKey(), { type: 'address' }),
              nativeToScVal(10_000_000n, { type: 'i128' }),
            ],
          }),
        ),
      subInvocations: [],
    }),
  });
}

function preimageOf(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): string {
  return buildAuthorizationEntryPreimage(entry, 1_000, networkPassphrase).toXdr(
    'base64',
  );
}

function ledger(...data: xdr.LedgerEntryData[]): Rpc {
  return new Rpc(
    testnet,
    answer(({ params }) => {
      const [key = ''] = (params as { keys: string[] }).keys;
      const { type } = xdr.LedgerKey.fromXdr(key, 'base64');
      return {
        latestLedger: 1,
        entries: data
          .filter((entry) => entry.type === type)
          .map((entry) => ({
            key,
            xdr: entry.toXdr('base64'),
            lastModifiedLedgerSeq: 1,
          })),
      };
    }),
  );
}

describe('signMessage', () => {
  it.each(sep53.vectors)('matches the SEP-53 vector: $name', (vector) => {
    const signer = Keypair.fromSecret(vector.seed);
    const message =
      vector.messageBase64 === undefined
        ? vector.message
        : Buffer.from(vector.messageBase64, 'base64');
    expect(signer.publicKey()).toBe(vector.address);

    const signature = signMessage(message ?? '', signer, Networks.TESTNET);
    expect(signature.toString('base64')).toBe(vector.signature.base64);
    expect(signature.toString('hex')).toBe(vector.signature.hex);
  });

  it('signs sha256 of the prefixed UTF-8 message', () => {
    const signer = Keypair.random();
    const signature = signMessage(
      'Sign in to app.test',
      signer,
      Networks.TESTNET,
    );
    expect(signature).toHaveLength(64);
    expect(
      signer.verify(
        sha256(Buffer.from('Stellar Signed Message:\nSign in to app.test')),
        signature,
      ),
    ).toBe(true);
  });

  it('refuses to sign while the wallet is on mainnet', () => {
    expect(() =>
      signMessage('hello', Keypair.random(), Networks.PUBLIC),
    ).toThrow(expect.objectContaining({ code: 'MAINNET_REFUSED' }));
  });
});

describe('signTransaction', () => {
  it("signs the transaction's hash for the wallet's network", () => {
    const signer = Keypair.random();
    const unsigned = payment(signer, Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(
      signTransaction(unsigned, signer, Networks.TESTNET),
      Networks.TESTNET,
    );

    const [signature] = signed.signatures;
    expect(Buffer.from(signed.hash()).toString('hex')).toBe(
      decodeTransaction(unsigned, Networks.TESTNET).hash,
    );
    expect(signed.signatures).toHaveLength(1);
    expect(signature && signer.verify(signed.hash(), signature.signature)).toBe(
      true,
    );
  });

  it('refuses to sign for mainnet', () => {
    const signer = Keypair.random();
    expect(() =>
      signTransaction(
        payment(signer, Networks.PUBLIC),
        signer,
        Networks.PUBLIC,
      ),
    ).toThrow(expect.objectContaining({ code: 'MAINNET_REFUSED' }));
  });
});

describe('signAuthEntry', () => {
  it.each(['v1', 'v2'] as const)(
    'signs sha256 of the preimage bytes (%s credentials)',
    async (version) => {
      const signer = Keypair.random();
      const entry = transferEntry(signer, version);
      const preimage = preimageOf(entry, Networks.TESTNET);

      const signature = signAuthEntry(preimage, signer, Networks.TESTNET);
      expect(signature).toHaveLength(64);
      expect(
        signer.verify(sha256(Buffer.from(preimage, 'base64')), signature),
      ).toBe(true);
      await expect(
        authorizeEntry(
          entry,
          async () => ({ signature, publicKey: signer.publicKey() }),
          1_000,
          Networks.TESTNET,
        ),
      ).resolves.toBeInstanceOf(xdr.SorobanAuthorizationEntry);
    },
  );

  it("refuses an entry whose network ID isn't the wallet's", () => {
    const signer = Keypair.random();
    const preimage = preimageOf(transferEntry(signer), Networks.FUTURENET);
    expect(() => signAuthEntry(preimage, signer, Networks.TESTNET)).toThrow(
      expect.objectContaining({
        code: 'PROMPT_BLOCKED',
        message: `the auth entry is for another network than the wallet's ("${Networks.TESTNET}"), so Stardust didn't sign it. Build the entry for the wallet's network, or answer the prompt with reject().`,
      }),
    );
  });

  it('refuses an entry for mainnet', () => {
    const signer = Keypair.random();
    const preimage = preimageOf(transferEntry(signer), Networks.PUBLIC);
    expect(() => signAuthEntry(preimage, signer, Networks.TESTNET)).toThrow(
      expect.objectContaining({
        code: 'MAINNET_REFUSED',
        message:
          'refused: the auth entry is for mainnet. Stardust never signs for mainnet.',
      }),
    );
    expect(() => signAuthEntry(preimage, signer, Networks.PUBLIC)).toThrow(
      expect.objectContaining({ code: 'MAINNET_REFUSED' }),
    );
  });

  it("throws on XDR that isn't a Soroban authorization preimage", () => {
    const signer = Keypair.random();
    expect(() =>
      signAuthEntry(
        payment(signer, Networks.TESTNET),
        signer,
        Networks.TESTNET,
      ),
    ).toThrow();
  });
});

describe('readToken', () => {
  const holder = Keypair.random().publicKey();
  const usdc = new Asset('USDC', Keypair.random().publicKey());
  const usdcSac = usdc.contractId(Networks.TESTNET);
  const query = (contractId: string) => ({
    contractId,
    address: holder,
    networkPassphrase: Networks.TESTNET,
  });

  it('reads a Wasm token as a plain token', async () => {
    const rpc = new Rpc(testnet, replay(...recording('wasm-spec')));
    await expect(readToken(rpc, query(soroswapPair))).resolves.toEqual({
      kind: 'plain',
    });
  });

  it('reads native XLM as already added', async () => {
    const rpc = new Rpc(testnet, replay(...recording('asset-instance')));
    await expect(readToken(rpc, query(nativeSac))).resolves.toEqual({
      kind: 'alreadyAdded',
    });
  });

  it('needs a trustline for a Stellar Asset Contract the account has none for', async () => {
    const rpc = ledger(sacInstance(usdcSac, usdc.toString()));
    await expect(readToken(rpc, query(usdcSac))).resolves.toEqual({
      kind: 'needsTrustline',
      asset: usdc,
    });
  });

  it('reads a Stellar Asset Contract with a trustline as already added', async () => {
    const rpc = ledger(
      sacInstance(usdcSac, usdc.toString()),
      trustlineEntry(holder, usdc),
    );
    await expect(readToken(rpc, query(usdcSac))).resolves.toEqual({
      kind: 'alreadyAdded',
    });
  });

  it("doesn't trust asset metadata that doesn't derive the contract ID", async () => {
    const other = new Asset('EURC', Keypair.random().publicKey());
    const rpc = ledger(sacInstance(usdcSac, other.toString()));
    await expect(readToken(rpc, query(usdcSac))).resolves.toEqual({
      kind: 'plain',
    });
  });
});

describe('addTrustline', () => {
  const usdc = new Asset('USDC', Keypair.random().publicKey());

  function wallet(balance: bigint | null) {
    const fake = new FakeLedger();
    const signer = Keypair.random();
    if (balance !== null) {
      fake.accounts.set(signer.publicKey(), { balance, sequence: 100n });
    }
    const add = (networkPassphrase: string = Networks.TESTNET) =>
      addTrustline(
        fake.context(),
        { signer, asset: usdc, networkPassphrase },
        fast,
      );
    const hash = () =>
      Buffer.from(fake.transactions[0]?.hash() ?? []).toString('hex');
    return { fake, signer, add, hash, rpcUrl: fake.context().rpc.url };
  }

  it('submits a changeTrust from the account and waits until it lands', async () => {
    const { fake, signer, add } = wallet(xlm('100'));
    await add();

    const [sent] = fake.transactions;
    expect(fake.transactions).toHaveLength(1);
    expect(
      decodeTransaction(sent?.toXDR() ?? '', Networks.TESTNET),
    ).toMatchObject({
      source: signer.publicKey(),
      sequence: 101n,
      operations: [
        {
          type: 'changeTrust',
          source: null,
          body: { asset: usdc.toString(), limit: maxLimit },
        },
      ],
    });
    expect(fake.accounts.get(signer.publicKey())).toMatchObject({
      sequence: 101n,
      subentries: 1,
    });
  });

  it("reports an account that doesn't exist without sending anything", async () => {
    const { fake, signer, add } = wallet(null);
    await expect(add()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: `${signer.publicKey()} doesn't exist on the network, so the wallet can't add a trustline for ${usdc.toString()}. Fund the account before the app adds the token.`,
    });
    expect(fake.transactions).toEqual([]);
  });

  it('reports a changeTrust the network rejects', async () => {
    const { signer, add, hash, rpcUrl } = wallet(xlm('1.0005'));
    const added = add();
    await expect(added).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(added).rejects.toThrow(
      `${rpcUrl} rejected the wallet's changeTrust for ${usdc.toString()} (transaction ${hash()}) with txINSUFFICIENT_BALANCE. Check that ${signer.publicKey()} holds enough XLM for the fee and the trustline's reserve, then run the test again.`,
    );
  });

  it('reports a changeTrust that fails in its ledger', async () => {
    const { signer, add, hash } = wallet(xlm('1.2'));
    const added = add();
    await expect(added).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(added).rejects.toThrow(
      `the wallet's changeTrust for ${usdc.toString()} (transaction ${hash()}) failed with txFAILED. Check that ${signer.publicKey()} holds enough XLM for the trustline's 0.5 XLM reserve.`,
    );
  });

  it("keeps a changeTrust that doesn't appear as OUTCOME_UNKNOWN", async () => {
    const { fake, add, hash, rpcUrl } = wallet(xlm('100'));
    fake.lands = false;
    const added = add();
    await expect(added).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      retryable: true,
    });
    await expect(added).rejects.toThrow(
      `the wallet's changeTrust for ${usdc.toString()} (transaction ${hash()}) didn't appear on the network within 0.2s, so its outcome is unknown. Check ${rpcUrl}, then run the test again.`,
    );
  });

  it('refuses mainnet before reading the network', async () => {
    const { fake, add } = wallet(xlm('100'));
    await expect(add(Networks.PUBLIC)).rejects.toMatchObject({
      code: 'MAINNET_REFUSED',
    });
    expect(fake.transactions).toEqual([]);
  });
});
