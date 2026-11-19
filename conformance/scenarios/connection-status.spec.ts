import { connect, packages, test } from '@conformance/conformance';

const status = { type: 'REQUEST_CONNECTION_STATUS' };

for (const name of packages) {
  test(`${name}: isConnected()`, async ({ compare }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'isConnected');
    });
  });
}

test('on a site that is not connected', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.send(status);
  });
});

test('on a connected site', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.send(status);
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.lock();
    await wallet.send(status);
  });
});
