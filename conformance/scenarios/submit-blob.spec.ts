import { Keypair, Networks } from '@stellar/stellar-sdk';
import { connect, packages, test } from '@conformance/conformance';

const message = 'Stardust conformance';
const testnet = { networkPassphrase: Networks.TESTNET };
const promptMs = 60_000;

for (const name of packages) {
  test(`${name}: signMessage() approved`, async ({ compare }) => {
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(name, 'signMessage', [message, testnet], ['approve']);
    });
  });

  test(`${name}: signMessage() on a site that is not connected`, async ({
    compare,
  }) => {
    await compare(async (wallet) => {
      await wallet.call(
        name,
        'signMessage',
        [message, testnet],
        ['approve', 'approve'],
      );
    });
  });
}

test('access rejected', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.call(
      'freighter',
      'signMessage',
      [message, testnet],
      ['reject'],
    );
  });
});

test('signature rejected', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signMessage',
      [message, testnet],
      ['reject'],
    );
  });
});

test('without networkPassphrase', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call('freighter', 'signMessage', [message], ['approve']);
  });
});

test('for another network', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signMessage',
      [message, { networkPassphrase: Networks.FUTURENET }],
      ['approve'],
    );
  });
});

test('accountToSign is another account in the wallet', async ({
  accounts,
  compare,
}) => {
  const other = accounts[1].address;
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await connect(wallet);
    await wallet.switchAccount(0);
    await wallet.call(
      'freighter',
      'signMessage',
      [message, { ...testnet, address: other }],
      ['approve'],
    );
  });
});

test('accountToSign is an unknown account', async ({ compare }) => {
  const unknown = Keypair.random().publicKey();
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signMessage',
      [message, { ...testnet, address: unknown }],
      ['approve'],
    );
  });
});

for (const apiVersion of ['3.1.0', '4.0.0', undefined]) {
  test(`apiVersion ${apiVersion ?? 'missing'}`, async ({
    accounts,
    compare,
  }) => {
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.send(
        {
          type: 'SUBMIT_BLOB',
          blob: message,
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

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call(
      'freighter',
      'signMessage',
      [message, testnet],
      ['approve'],
    );
  });
});
