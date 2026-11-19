import { connect, test } from '@conformance/conformance';

const legacy = { type: 'REQUEST_USER_INFO' };

test('on a site that is not connected', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.send(legacy);
  });
});

test('on a connected site', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.send(legacy);
  });
});

test('after switching account', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await wallet.send(legacy);
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.send(legacy);
  });
});
