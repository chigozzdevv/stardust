import { Asset, Networks } from '@stellar/stellar-sdk';
import { expect, test, xlm } from 'stardust-stellar/test';
import type { User } from 'stardust-stellar/test';

const xlmToken = Asset.native().contractId(Networks.TESTNET);

test.use({ stardust: { users: { lender: { wallet: 'varial' } } } });

const short = (address: string) =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;

async function supply({ page, account }: User, amount: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  const dashboard = page.getByRole('link', { name: 'Dashboard' });
  await expect(dashboard).toHaveAttribute('href', /poolId=C/);
  const href = (await dashboard.getAttribute('href')) ?? '';
  const pool = new URL(href, page.url()).searchParams.get('poolId') ?? '';

  await page.goto(`/supply/?poolId=${pool}&assetId=${xlmToken}`);
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await page.getByRole('listitem').filter({ hasText: 'Freighter' }).click();
  await expect(
    page.getByRole('button', { name: short(account.address) }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: '0' }).fill(amount);
  await expect(
    page.getByRole('heading', { name: `${amount} XLM`, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Supply', exact: true }).click();
  return pool;
}

test('supplies 10 XLM to the default pool', async ({ users: { lender } }) => {
  const pool = await supply(lender, '10');
  const { address } = lender.account;

  const prompt = await lender.wallet.nextPrompt('signTransaction');
  expect(prompt).toInvoke({
    contract: pool,
    fn: 'submit',
    args: { from: address, spender: address, to: address },
  });
  expect(prompt).toInvoke({
    contract: xlmToken,
    fn: 'transfer',
    args: { from: address, to: pool, amount: xlm('10') },
  });
  await expect(prompt).toLand();
  await expect(prompt).toChangeBalance(address, 'native', -xlm('10'));
  await expect(prompt).toChangeBalance(pool, 'native', xlm('10'));
  await expect(
    lender.page.getByRole('heading', {
      name: 'Transaction submitted successfully!',
    }),
  ).toBeVisible();
});

test('shows the wallet error when the lender rejects', async ({
  users: { lender },
}) => {
  lender.wallet.setPolicy({ signTransaction: 'reject' });
  await supply(lender, '10');

  const prompt = await lender.wallet.nextPrompt('signTransaction');
  expect(prompt.status).toBe('rejected');
  await expect(
    lender.page.getByRole('heading', {
      name: 'Stellar Error: The user rejected this request.',
    }),
  ).toBeVisible();
});
