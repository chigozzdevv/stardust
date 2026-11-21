import { Keypair, Networks } from '@stellar/stellar-sdk';
import { connect, packages, test } from '@conformance/fixture';
import { preimage } from '@tests/helpers/envelopes';

const testnet = { networkPassphrase: Networks.TESTNET };
const promptMs = 60_000;

for (const name of packages) {
  test(`${name}: signAuthEntry() approved`, async ({ accounts, compare }) => {
    const entry = preimage(accounts[0].address);
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(name, 'signAuthEntry', [entry, testnet], ['approve']);
    });
  });

  test(`${name}: signAuthEntry() on a site that is not connected`, async ({
    accounts,
    compare,
  }) => {
    const entry = preimage(accounts[0].address);
    await compare(async (wallet) => {
      await wallet.call(
        name,
        'signAuthEntry',
        [entry, testnet],
        ['approve', 'approve'],
      );
    });
  });
}

test('access rejected', async ({ accounts, compare }) => {
  const entry = preimage(accounts[0].address);
  await compare(async (wallet) => {
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, testnet],
      ['reject'],
    );
  });
});

test('signature rejected', async ({ accounts, compare }) => {
  const entry = preimage(accounts[0].address);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, testnet],
      ['reject'],
    );
  });
});

test('as the Stellar SDK sends it, without networkPassphrase', async ({
  accounts,
  compare,
}) => {
  const entry = preimage(accounts[0].address);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, { address: accounts[0].address }],
      ['approve'],
    );
  });
});

test('an entry for another network', async ({ accounts, compare }) => {
  const entry = preimage(accounts[0].address, Networks.FUTURENET);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, testnet],
      ['approve'],
    );
  });
});

test('accountToSign is another account in the wallet', async ({
  accounts,
  compare,
}) => {
  const other = accounts[1].address;
  const entry = preimage(other);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await connect(wallet);
    await wallet.switchAccount(0);
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, { ...testnet, address: other }],
      ['approve'],
    );
  });
});

test('accountToSign is an unknown account', async ({ accounts, compare }) => {
  const entry = preimage(accounts[0].address);
  const unknown = Keypair.random().publicKey();
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, { ...testnet, address: unknown }],
      ['approve'],
    );
  });
});

for (const apiVersion of ['4.1.0', '4.2.0', undefined]) {
  test(`apiVersion ${apiVersion ?? 'missing'}`, async ({
    accounts,
    compare,
  }) => {
    const entryXdr = preimage(accounts[0].address);
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.send(
        {
          type: 'SUBMIT_AUTH_ENTRY',
          entryXdr,
          accountToSign: accounts[0].address,
          networkPassphrase: Networks.TESTNET,
          ...(apiVersion && { apiVersion }),
        },
        ['approve'],
        promptMs,
      );
    });
  });
}

test('while locked', async ({ accounts, compare }) => {
  const entry = preimage(accounts[0].address);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call(
      'freighter',
      'signAuthEntry',
      [entry, testnet],
      ['approve'],
    );
  });
});
