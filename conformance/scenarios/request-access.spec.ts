import { connect, packages, test } from '@conformance/fixture';

for (const name of packages) {
  test(`${name}: requestAccess() approved`, async ({ compare }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'requestAccess', [], ['approve']);
      await wallet.call(name, 'getAddress');
    });
  });

  test(`${name}: requestAccess() rejected`, async ({ compare }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'requestAccess', [], ['reject']);
    });
  });
}

test('on a connected site', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call('freighter', 'requestAccess');
  });
});

test('after switching account', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await wallet.call('freighter', 'requestAccess', [], ['approve']);
  });
});

test('after switching network', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchNetwork('futurenet');
    await wallet.call('freighter', 'requestAccess', [], ['approve']);
  });
});

test('while locked, on a connected site', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call('freighter', 'requestAccess', [], ['reject']);
  });
});

test('while locked, on a site that is not connected', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.lock();
    await wallet.call('freighter', 'requestAccess', [], ['reject']);
  });
});
