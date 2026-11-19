import { expect, test } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      trader: { wallet: 'varial', connected: true },
    },
  },
});

// Strict mode fails this test when it ends, which test.fail() expects.
test.fail(
  'a transaction without networkPassphrase fails the test',
  async ({ users: { trader } }) => {
    await trader.page.goto('/');
    await trader.page.getByLabel('Recipient').fill(trader.account.address);
    await trader.page.getByLabel('Amount (XLM)').fill('1');
    await trader.page
      .getByRole('button', { name: 'Send without network passphrase' })
      .click();

    const prompt = await trader.wallet.nextPrompt('signTransaction');
    expect(prompt.networkPassphrase).toBeNull();
    expect(prompt.blocked).toBe('networkMismatch');
    expect(trader.wallet.violations()).toMatchObject([
      { promptId: prompt.id, kind: 'missingNetworkPassphrase' },
    ]);
    await expect(trader.page.getByRole('status')).toHaveText(
      'Transaction cancelled',
    );
  },
);
