import { connect, packages, test } from '@conformance/conformance';

for (const name of packages) {
  test(`${name}: getAddress() on a site that is not connected`, async ({
    compare,
  }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'getAddress');
    });
  });

  test(`${name}: getAddress() on a connected site`, async ({ compare }) => {
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(name, 'getAddress');
    });
  });
}

test('after switching account', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await wallet.call('freighter', 'getAddress');
  });
});

test('after switching network', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchNetwork('futurenet');
    await wallet.call('freighter', 'getAddress');
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call('freighter', 'getAddress');
  });
});
