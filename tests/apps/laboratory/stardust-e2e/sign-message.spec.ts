import { Keypair, hash } from '@stellar/stellar-sdk';
import { expect, test } from 'stardust-stellar/test';
import type { User } from 'stardust-stellar/test';

const message = 'Hello from Stardust';

test.use({
  stardust: {
    users: {
      dev: { wallet: 'varial', accounts: { main: { fund: false } } },
    },
  },
});

const short = (address: string) =>
  `${address.slice(0, 4)}...${address.slice(-4)}`;

async function connect({ page, account }: User) {
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('listitem').filter({ hasText: 'Freighter' }).click();
  await expect(
    page
      .getByRole('banner')
      .getByRole('button', { name: short(account.address) }),
  ).toBeVisible();
}

test('connects through Wallets Kit', async ({ users: { dev } }) => {
  await dev.page.goto('/sign-message');
  await connect(dev);

  const [prompt] = dev.wallet.prompts('connect');
  expect(prompt?.status).toBe('approved');
  expect(prompt?.origin).toBe('http://localhost:3000');
});

test('signs a message with the wallet extension', async ({
  users: { dev },
}) => {
  const { page, account } = dev;
  await page.goto('/sign-message');
  await connect(dev);
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: /^Wallet extension/ }).click();
  await page
    .getByRole('button', { name: `Sign with ${short(account.address)}` })
    .click();

  const prompt = await dev.wallet.nextPrompt('signMessage');
  expect(prompt.message).toBe(message);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Message signed' }),
  ).toBeVisible();

  const signature = await page
    .getByText('Signature (base64):', { exact: true })
    .locator('xpath=following-sibling::div[1]')
    .textContent();
  const signed = hash(Buffer.from(`Stellar Signed Message:\n${message}`));
  expect(
    Keypair.fromPublicKey(account.address).verify(
      Buffer.from(signed),
      Buffer.from(signature ?? '', 'base64'),
    ),
  ).toBe(true);
});
