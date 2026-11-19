import { expect, test } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      trader: {
        wallet: 'varial',
        connected: true,
        accounts: { main: { fund: false }, savings: { fund: false } },
      },
    },
  },
});

test('the app follows an account switch', async ({ users: { trader } }) => {
  await trader.page.goto('/');
  const address = trader.page.getByTestId('address');
  await expect(address).toHaveText(trader.accounts.main.address);

  await trader.wallet.switchAccount(trader.accounts.savings);
  await expect(address).toHaveText(trader.accounts.savings.address);
});
