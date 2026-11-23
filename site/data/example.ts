export const exampleFile = 'e2e/wallet.spec.ts';

export const exampleTest = `import { expect, test, units, xlm } from 'stardust-stellar/test';
import { CONTRACTS } from '../src/contracts';

const { router, usdc } = CONTRACTS.testnet;

test.use({
  stardust: {
    users: {
      trader: {
        wallet: 'varial',
        connected: true,
        accounts: { main: { fund: '500' } },
      },
      friend: {},
    },
  },
});

test('swaps 10 XLM for USDC', async ({ users: { trader } }) => {
  await trader.page.goto('/swap');
  await trader.page.getByLabel('You pay').fill('10');
  await trader.page.getByRole('button', { name: 'Swap' }).click();

  const prompt = await trader.wallet.nextPrompt('signTransaction');
  expect(prompt).toInvoke({
    contract: router,
    fn: 'swap_exact_in',
    args: { amount_in: xlm('10') },
  });
  await expect(prompt).toLand();
  await expect(prompt).toChangeBalance(trader.account.address, usdc, {
    min: units('1', 7),
  });
});

test('asks to switch to testnet', async ({ users: { trader } }) => {
  await trader.wallet.switchNetwork('futurenet');
  await trader.page.goto('/swap');

  await expect(trader.page.getByText('Switch to testnet')).toBeVisible();
});

test('sends 5 XLM on testnet', async ({ users: { trader, friend } }) => {
  await trader.page.goto('/send');
  await trader.page.getByLabel('To').fill(friend.account.address);
  await trader.page.getByLabel('Amount').fill('5');
  await trader.page.getByRole('button', { name: 'Send' }).click();

  const prompt = await trader.wallet.nextPrompt('signTransaction');
  expect(prompt).toHaveOperation({
    type: 'payment',
    destination: friend.account.address,
    amount: xlm('5'),
  });
});`;

const location = (name: string) =>
  `${exampleFile}:${exampleTest.split('\n').findIndex((line) => line.startsWith(`test('${name}'`)) + 1}:1`;

const failed = 'sends 5 XLM on testnet';

export const exampleRun = {
  command: 'npx stardust test',
  steps: [
    {
      tag: 'network',
      text: 'testnet (https://soroban-testnet.stellar.org, protocol 30) ready',
    },
    { tag: 'browser', text: 'chromium ready' },
    { tag: 'app', text: 'pnpm dev -> http://localhost:3000 ready' },
    { tag: 'wallets', text: 'Varial 5.53.0, SEP-43 1.2.1, SEP-60 0.1.0' },
  ],
  running: 'Running 3 tests using 3 workers',
  results: [
    { name: 'swaps 10 XLM for USDC', time: '17.2s', passed: true },
    { name: 'asks to switch to testnet', time: '4.1s', passed: true },
    { name: failed, time: '6.3s', passed: false },
  ].map((test, i) => ({ ...test, id: i + 1, location: location(test.name) })),
  failure: {
    title: `1) ${location(failed)} › ${failed}`,
    error: [
      'StardustError PROTOCOL_VIOLATION: Stardust: 1 protocol violation in this test',
      '  p1 signTransaction  missingNetworkPassphrase',
      '  The app sent signTransaction without networkPassphrase, so Varial reads it as mainnet.',
      '  Pass the passphrase of the wallet\'s network, "Test SDF Network ; September 2015".',
    ],
    timeline: [
      { time: '0.0s', label: 'getAddress', lines: [] },
      {
        time: '0.8s',
        label: 'signTransaction',
        lines: [
          'payment(destination: GD7Q…NX4E, asset: native, amount: 50000000)  rejected (networkMismatch)',
        ],
      },
      {
        time: '0.8s',
        label: 'violation',
        lines: ['p1 missingNetworkPassphrase'],
      },
    ],
    user: 'trader',
    folder:
      'Screenshot, trace and timeline: stardust-results/wallet-sends-5-XLM-on-testnet/',
  },
  summary: {
    failed: '1 failed',
    passed: '2 passed (18.4s)',
  },
  end: { tag: 'app', text: 'stopped' },
};
