import { expect, test } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      trader: {
        wallet: 'varial',
        connected: true,
        accounts: { main: { fund: false } },
      },
    },
  },
});

test('starts connected from the saved kit session', async ({
  users: { trader },
}) => {
  await trader.page.goto('/kit');

  await expect(trader.page.getByTestId('address')).toHaveText(
    trader.account.address,
  );
  expect(trader.wallet.prompts('connect')).toHaveLength(0);
});
