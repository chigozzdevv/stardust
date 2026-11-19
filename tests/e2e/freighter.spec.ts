import { expect, test } from 'stardust-stellar/test';
import type { User } from 'stardust-stellar/test';
import { CONTRACTS } from '@tests/test-app/src/contracts';

test.use({
  stardust: {
    users: {
      trader: { wallet: 'varial', policy: { signTransaction: 'manual' } },
    },
  },
});

async function connect(user: User) {
  await user.page.getByRole('button', { name: 'Connect wallet' }).click();
}

async function signMessage(user: User, message: string) {
  await user.page.getByLabel('Message').fill(message);
  await user.page.getByRole('button', { name: 'Sign message' }).click();
}

test.beforeEach(async ({ users: { trader } }) => {
  await trader.page.goto('/');
});

test('connects and shows the address', async ({ users: { trader } }) => {
  await connect(trader);

  const prompt = await trader.wallet.nextPrompt('connect');
  expect(prompt.origin).toBe('http://localhost:3000');
  await expect(trader.page.getByTestId('address')).toHaveText(
    trader.account.address,
  );
});

test('handles the user rejecting', async ({ users: { trader } }) => {
  await connect(trader);
  await trader.page.getByLabel('Recipient').fill(trader.account.address);
  await trader.page.getByLabel('Amount (XLM)').fill('1');
  await trader.page.getByRole('button', { name: 'Send payment' }).click();

  const prompt = await trader.wallet.nextPrompt('signTransaction');
  await prompt.reject();

  await expect(trader.page.getByRole('status')).toHaveText(
    'Transaction cancelled',
  );
});

test('asks the user to switch network', async ({ users: { trader } }) => {
  await trader.wallet.switchNetwork('futurenet');
  await connect(trader);

  await expect(trader.page.getByRole('status')).toHaveText(
    'Switch your wallet to Testnet',
  );
});

test('signs a message', async ({ users: { trader } }) => {
  await connect(trader);
  await signMessage(trader, 'Hello from Stardust');

  const prompt = await trader.wallet.nextPrompt('signMessage');
  expect(prompt.message).toBe('Hello from Stardust');
  await expect(trader.page.getByRole('status')).toHaveText(
    'Signature verified',
  );
});

test('waits while the wallet is locked', async ({ users: { trader } }) => {
  await connect(trader);
  await trader.wallet.nextPrompt('connect');
  await expect(trader.page.getByTestId('address')).toHaveText(
    trader.account.address,
  );
  await trader.wallet.lock();
  await signMessage(trader, 'Signed after unlocking');

  const prompt = await trader.wallet.nextPrompt('connect');
  expect(prompt.blocked).toBe('locked');
  expect(prompt.status).toBe('pending');

  await trader.wallet.unlock();
  await expect(trader.page.getByRole('status')).toHaveText(
    'Signature verified',
  );
  expect(trader.wallet.prompts('signMessage')).toMatchObject([
    { status: 'approved' },
  ]);
});

test('refuses to add XLM twice', async ({ users: { trader } }) => {
  await connect(trader);
  await trader.page.getByRole('button', { name: 'Add XLM token' }).click();

  const prompt = await trader.wallet.nextPrompt('addToken');
  expect(prompt.contractId).toBe(CONTRACTS.testnet.xlmToken);
  expect(prompt.blocked).toBe('alreadyAdded');
  await expect(trader.page.getByRole('status')).toHaveText('Token not added');
});
