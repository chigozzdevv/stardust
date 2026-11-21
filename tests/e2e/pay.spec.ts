import { expect, test, xlm } from 'stardust-stellar/test';
import type { User } from 'stardust-stellar/test';
import { CONTRACTS } from '@tests/e2e/app/src/contracts';

const { xlmToken } = CONTRACTS.testnet;

test.use({
  stardust: {
    users: {
      payer: { wallet: 'varial', connected: true },
      friend: {},
    },
  },
});

async function fill(user: User, recipient: string, amount: string) {
  await user.page.getByLabel('Recipient').fill(recipient);
  await user.page.getByLabel('Amount (XLM)').fill(amount);
}

test.beforeEach(async ({ users: { payer } }) => {
  await payer.page.goto('/');
});

test('sends 5 XLM to a friend', async ({ users: { payer, friend } }) => {
  await fill(payer, friend.account.address, '5');
  await payer.page.getByRole('button', { name: 'Send payment' }).click();

  const prompt = await payer.wallet.nextPrompt('signTransaction');
  expect(prompt).toHaveOperation({
    type: 'payment',
    destination: friend.account.address,
    asset: 'native',
    amount: xlm('5'),
  });
  await expect(prompt).toLand();
  await expect(prompt).toChangeBalance(
    friend.account.address,
    'native',
    xlm('5'),
  );
  await expect(payer.page.getByRole('status')).toHaveText('Payment sent');
});

test('transfers 2 XLM through the token contract', async ({
  users: { payer, friend },
}) => {
  await fill(payer, friend.account.address, '2');
  await payer.page
    .getByRole('button', { name: 'Transfer with contract' })
    .click();

  const prompt = await payer.wallet.nextPrompt('signTransaction');
  expect(prompt).toInvoke({
    contract: xlmToken,
    fn: 'transfer',
    args: {
      from: payer.account.address,
      to: friend.account.address,
      amount: xlm('2'),
    },
  });
  await expect(prompt).toEmit({ contract: xlmToken, topic: 'transfer' });
  await expect(prompt).toChangeBalance(
    payer.account.address,
    xlmToken,
    -xlm('2'),
  );
  await expect(prompt).toChangeBalance(
    friend.account.address,
    'native',
    xlm('2'),
  );
  await expect(payer.page.getByRole('status')).toHaveText('Transfer sent');
});
