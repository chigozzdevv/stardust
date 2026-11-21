import { packages, test } from '@conformance/fixture';
import type { CustomNetwork } from '@conformance/varial-extension';

const standalone: CustomNetwork = {
  name: 'Custom Network',
  url: 'https://localhost:8000/',
  rpcUrl: 'https://localhost:8000/',
  passphrase: 'Standalone Network ; February 2017',
};

for (const name of packages) {
  test(`${name}: getNetworkDetails() and getNetwork() on testnet`, async ({
    compare,
  }) => {
    await compare(async (wallet) => {
      await wallet.call(name, 'getNetworkDetails');
      await wallet.call(name, 'getNetwork');
    });
  });
}

for (const network of ['futurenet', 'mainnet'] as const) {
  test(`on ${network}`, async ({ compare }) => {
    await compare(async (wallet) => {
      await wallet.switchNetwork(network);
      await wallet.call('freighter', 'getNetworkDetails');
    });
  });
}

test('on a custom network', async ({ compare }) => {
  await compare(
    async (wallet) => {
      await wallet.call('freighter', 'getNetworkDetails');
    },
    { network: standalone },
  );
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await wallet.lock();
    await wallet.call('freighter', 'getNetworkDetails');
  });
});
