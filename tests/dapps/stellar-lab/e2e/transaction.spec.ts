import {
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import { expect, test, xlm } from 'stardust-stellar/test';
import type { User } from 'stardust-stellar/test';

test.use({
  stardust: {
    users: {
      dev: { wallet: 'varial' },
      friend: {},
    },
  },
});

const short = (address: string) =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;

async function payment(from: User, to: User, amount: string): Promise<string> {
  const server = new rpc.Server('https://soroban-testnet.stellar.org');
  const source = await server.getAccount(from.account.address);
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: to.account.address,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

test('signs and submits an imported payment', async ({
  users: { dev, friend },
}) => {
  const { page, account } = dev;
  await page.goto('/transaction/import');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('listitem').filter({ hasText: 'Freighter' }).click();
  await page
    .getByRole('textbox', { name: 'Transaction envelope in XDR' })
    .fill(await payment(dev, friend, '5'));
  await page
    .getByRole('button', { name: 'Sign transaction', exact: true })
    .click();
  await page.getByText('Wallet extension', { exact: true }).click();
  await page
    .getByRole('button', { name: `Sign with ${short(account.address)}` })
    .click();

  const prompt = await dev.wallet.nextPrompt('signTransaction');
  expect(prompt).toHaveOperation({
    type: 'payment',
    destination: friend.account.address,
    asset: 'native',
    amount: xlm('5'),
  });

  await page
    .getByRole('button', { name: 'Submit transaction', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Submit transaction', level: 1 }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Submit transaction', exact: true })
    .click();

  await expect(prompt).toLand();
  await expect(prompt).toChangeBalance(
    friend.account.address,
    'native',
    xlm('5'),
  );
  await expect(
    page.getByRole('alert').filter({ hasText: 'Transaction submitted!' }),
  ).toBeVisible();
});
