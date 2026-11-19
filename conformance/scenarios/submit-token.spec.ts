import { Asset, Networks } from '@stellar/stellar-sdk';
import { connect, packages, test } from '@conformance/conformance';
import { varialTestToken } from '@conformance/setup';
import { nativeSac } from '@tests/helpers/envelopes';

const usdc = new Asset(
  'USDC',
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
);
const usdcSac = usdc.contractId(Networks.TESTNET);

function token(contractId: string, networkPassphrase?: string): object {
  return networkPassphrase ? { contractId, networkPassphrase } : { contractId };
}

function plainToken(): string {
  const contractId = varialTestToken(process.env.VARIAL_TAG ?? '');
  test.skip(!contractId, "Varial's release has no e2e test token.");
  return contractId as string;
}

for (const name of packages) {
  test(`${name}: native XLM`, async ({ compare }) => {
    await compare(async (wallet) => {
      await connect(wallet);
      await wallet.call(
        name,
        'addToken',
        [token(nativeSac, Networks.TESTNET)],
        ['approve'],
      );
    });
  });
}

test('a plain Soroban token', async ({ compare }) => {
  const contractId = plainToken();
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'addToken',
      [token(contractId, Networks.TESTNET)],
      ['approve'],
    );
  });
});

test('a plain Soroban token on a site that is not connected', async ({
  compare,
}) => {
  const contractId = plainToken();
  await compare(async (wallet) => {
    await wallet.call(
      'freighter',
      'addToken',
      [token(contractId, Networks.TESTNET)],
      ['approve'],
    );
  });
});

test('a plain Soroban token, rejected', async ({ compare }) => {
  const contractId = plainToken();
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'addToken',
      [token(contractId, Networks.TESTNET)],
      ['reject'],
    );
  });
});

test('a Stellar Asset Contract without a trustline', async ({ compare }) => {
  await compare(
    async (wallet) => {
      await connect(wallet);
      await wallet.call(
        'freighter',
        'addToken',
        [token(usdcSac, Networks.TESTNET)],
        ['approve'],
      );
    },
    { funded: true },
  );
});

test('a Stellar Asset Contract with a trustline', async ({ compare }) => {
  await compare(
    async (wallet) => {
      await connect(wallet);
      await wallet.call(
        'freighter',
        'addToken',
        [token(usdcSac, Networks.TESTNET)],
        ['approve'],
      );
    },
    { funded: true, trustline: usdc },
  );
});

test('without networkPassphrase', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call('freighter', 'addToken', [token(usdcSac)], ['approve']);
  });
});

test('for another network', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.call(
      'freighter',
      'addToken',
      [token(usdcSac, Networks.FUTURENET)],
      ['approve'],
    );
  });
});

test('while locked', async ({ compare }) => {
  await compare(async (wallet) => {
    await connect(wallet);
    await wallet.lock();
    await wallet.call(
      'freighter',
      'addToken',
      [token(nativeSac, Networks.TESTNET)],
      ['approve'],
    );
  });
});
