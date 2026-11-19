import { connect, packages, test } from '@conformance/conformance';

for (const name of packages) {
  test(`${name}: isAllowed() on a site that is not connected`, async ({
    compare,
  }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'isAllowed');
    });
  });

  test(`${name}: isAllowed() on a connected site`, async ({ compare }) => {
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(name, 'isAllowed');
    });
  });
}

test('after switching account', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await wallet.call('freighter', 'isAllowed');
  });
});

test('after switching network', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchNetwork('futurenet');
    await wallet.call('freighter', 'isAllowed');
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call('freighter', 'isAllowed');
  });
});
