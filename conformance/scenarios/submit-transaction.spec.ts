import { Keypair, Networks } from '@stellar/stellar-sdk';
import { connect, packages, test } from '@conformance/conformance';
import type { Session } from '@conformance/conformance';
import { payment } from '@tests/helpers/envelopes';

const testnet = { networkPassphrase: Networks.TESTNET };

async function connectBoth(wallet: Session): Promise<void> {
  await connect(wallet);
  await wallet.switchAccount(1);
  await connect(wallet);
  await wallet.switchAccount(0);
}

for (const name of packages) {
  test(`${name}: signTransaction() approved`, async ({ accounts, compare }) => {
    const xdr = payment(accounts[0].address);
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(name, 'signTransaction', [xdr, testnet], ['approve']);
    });
  });

  test(`${name}: signTransaction() rejected`, async ({ accounts, compare }) => {
    const xdr = payment(accounts[0].address);
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(name, 'signTransaction', [xdr, testnet], ['reject']);
    });
  });
}

test('on a site that is not connected', async ({ accounts, compare }) => {
  const xdr = payment(accounts[0].address);
  await compare(async (wallet) => {
    await wallet.call(
      'freighter',
      'signTransaction',
      [xdr, testnet],
      ['approve'],
    );
  });
});

test('without networkPassphrase', async ({ accounts, compare }) => {
  const xdr = payment(accounts[0].address);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call('freighter', 'signTransaction', [xdr], ['approve']);
  });
});

test('for another network', async ({ accounts, compare }) => {
  const xdr = payment(accounts[0].address, Networks.FUTURENET);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signTransaction',
      [xdr, { networkPassphrase: Networks.FUTURENET }],
      ['approve'],
    );
  });
});

test('after switching network to the one the app asks for', async ({
  accounts,
  compare,
}) => {
  const xdr = payment(accounts[0].address, Networks.FUTURENET);
  await compare(async (wallet) => {
    await wallet.switchNetwork('futurenet');
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signTransaction',
      [xdr, { networkPassphrase: Networks.FUTURENET }],
      ['approve'],
    );
  });
});

test('accountToSign is another account in the wallet', async ({
  accounts,
  compare,
}) => {
  const other = accounts[1].address;
  const xdr = payment(other);
  await compare(async (wallet) => {
    await connectBoth(wallet);
    await wallet.call(
      'freighter',
      'signTransaction',
      [xdr, { ...testnet, address: other }],
      ['approve'],
    );
    await wallet.call('freighter', 'getAddress');
  });
});

test('accountToSign is an unknown account', async ({ accounts, compare }) => {
  const xdr = payment(accounts[0].address);
  const unknown = Keypair.random().publicKey();
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'signTransaction',
      [xdr, { ...testnet, address: unknown }],
      ['approve'],
    );
  });
});

test('while locked', async ({ accounts, compare }) => {
  const xdr = payment(accounts[0].address);
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call(
      'freighter',
      'signTransaction',
      [xdr, testnet],
      ['approve'],
    );
  });
});
