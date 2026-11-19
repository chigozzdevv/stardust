import { connect, packages, test } from '@conformance/conformance';

for (const name of packages) {
  test(`${name}: setAllowed() approved`, async ({ compare }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'setAllowed', [], ['approve']);
      await wallet.call(name, 'isAllowed');
    });
  });

  test(`${name}: setAllowed() rejected`, async ({ compare }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'setAllowed', [], ['reject']);
    });
  });
}

test('on a connected site', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call('freighter', 'setAllowed');
  });
});

test('after switching account', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await wallet.call('freighter', 'setAllowed', [], ['approve']);
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.lock();
    await wallet.call('freighter', 'setAllowed', [], ['reject']);
  });
});
