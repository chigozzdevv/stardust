import { connect, test } from '@conformance/conformance';

test('on a connected site', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call('varial', 'disconnect');
    await wallet.call('varial', 'getAddress');
    await wallet.call('varial', 'isAllowed');
  });
});

test('on a site that is not connected', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.call('varial', 'disconnect');
  });
});

test('only for the active account', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.switchAccount(1);
    await connect(wallet);
    await wallet.call('varial', 'disconnect');
    await wallet.switchAccount(0);
    await wallet.call('varial', 'getAddress');
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call('varial', 'disconnect');
  });
});
