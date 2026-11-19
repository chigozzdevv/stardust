import { test } from '@conformance/conformance';

const legacy = { type: 'REQUEST_NETWORK' };

test('on testnet', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.send(legacy);
  });
});

test('on futurenet', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.switchNetwork('futurenet');
    await wallet.send(legacy);
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.lock();
    await wallet.send(legacy);
  });
});
