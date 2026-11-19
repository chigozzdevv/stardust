import { expect, test } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      visitor: { wallet: 'none', accounts: { main: { fund: false } } },
    },
  },
});

test('offers to install Varial', async ({ users: { visitor } }) => {
  await visitor.page.goto('/');
  await visitor.page.getByRole('button', { name: 'Connect wallet' }).click();

  await expect(
    visitor.page.getByRole('link', { name: 'Install Varial' }),
  ).toBeVisible();
});

test('finds no SEP-60 wallet', async ({ users: { visitor } }) => {
  await visitor.page.goto('/sep60');

  await expect(visitor.page.getByText('No Stellar wallet found')).toBeVisible();
});
