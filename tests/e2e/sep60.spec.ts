import { expect, test } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      trader: { wallet: 'sep60', accounts: { main: { fund: false } } },
    },
  },
});

test('discovers the wallet and signs a message', async ({
  users: { trader },
}) => {
  await trader.page.goto('/sep60');
  await trader.page
    .getByRole('button', { name: 'Stardust (test wallet)' })
    .click();

  const connect = await trader.wallet.nextPrompt('connect');
  expect(connect.status).toBe('approved');
  await expect(trader.page.getByTestId('address')).toHaveText(
    trader.account.address,
  );

  await trader.page.getByLabel('Message').fill('Hello over SEP-43');
  await trader.page.getByRole('button', { name: 'Sign message' }).click();

  const prompt = await trader.wallet.nextPrompt('signMessage');
  expect(prompt.message).toBe('Hello over SEP-43');
  await expect(trader.page.getByRole('status')).toHaveText(
    'Signature verified',
  );
});
