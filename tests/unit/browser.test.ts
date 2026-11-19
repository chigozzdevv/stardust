import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractSpecs } from '@/contracts/spec';
import type { Account } from '@/funding/accounts';
import { Rpc } from '@/network/network';
import type { ProviderInfo } from '@/protocols/sep60/sep60';
import { pageHost } from '@/test/host';
import { EmulatedWallet } from '@/wallet/wallet';
import type { WalletOptions } from '@/wallet/wallet';
import { payment, sha256 } from '@tests/fixtures/wallet/envelopes';
import type { WalletPackage } from '@tests/fixtures/wallet/fake-page';
import { account, testnet } from '@tests/fixtures/wallet/prompt-queue';

interface Provider {
  getAddress(): Promise<{ address: string }>;
  signMessage(
    message: string,
    opts?: object,
  ): Promise<{ signedMessage: string; signerAddress: string }>;
}

type PageWindow = typeof window & {
  freighterApi: WalletPackage;
  providers: { info: ProviderInfo; provider: Provider }[];
  __stardust(payload: object): Promise<unknown>;
};

interface Setup {
  readonly wallet?: 'varial' | 'sep60' | 'none';
  readonly options?: Partial<WalletOptions>;
  readonly api?: (typeof packages)[number];
  readonly script?: string;
  readonly body?: string;
  readonly origin?: string;
}

const require = createRequire(import.meta.url);
const packages = ['@stellar/freighter-api', '@stellar/varial-sdk'] as const;
const app = 'http://localhost:3000';
const message = 'Sign in to the test app';
const offline: typeof fetch = () =>
  Promise.reject(new TypeError('no network in this test'));

const discovery = `
  window.providers = [];
  window.addEventListener('sep0060:announceProvider', (event) => window.providers.push(event.detail));
  window.dispatchEvent(new Event('sep0060:requestProvider'));
`;

// One browser per test, so a crash stays in its test.
const browsers: Browser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});

async function open({
  wallet: kind = 'varial',
  options = {},
  api,
  script = '',
  body = '',
  origin = app,
}: Setup = {}) {
  const browser = await chromium.launch();
  browsers.push(browser);
  const context = await browser.newContext();
  const accounts = [account()] as [Account];
  const rpc = new Rpc(testnet.rpcUrl, offline);
  const wallet = new EmulatedWallet(
    { accounts, policy: 'approve', ...options },
    {
      network: testnet,
      landing: { rpc, specs: new ContractSpecs(rpc) },
      fetch: offline,
    },
  );
  if (kind !== 'none') await wallet.attach(pageHost(context), { wallet: kind });
  const scripts = [
    api ? '<script src="/wallet.js"></script>' : '',
    script ? `<script>${script}</script>` : '',
  ].join('');
  const pages: Record<string, { type: string; body: string }> = {
    '/': { type: 'text/html', body: `<!doctype html>${scripts}${body}` },
    '/frame': {
      type: 'text/html',
      body: '<!doctype html><title>frame</title>',
    },
    '/wallet.js': {
      type: 'text/javascript',
      body: api ? readFileSync(require.resolve(api), 'utf8') : '',
    },
  };
  await context.route(`${origin}/**`, (route) => {
    const page = pages[new URL(route.request().url()).pathname];
    return page
      ? route.fulfill({ contentType: page.type, body: page.body })
      : route.fulfill({ status: 404 });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  return { page, wallet, keypair: accounts[0].keypair };
}

function signedMessage(text: string): Buffer {
  return sha256(Buffer.from(`Stellar Signed Message:\n${text}`));
}

describe.each(packages)('%s in Chromium', (api) => {
  it('sees the wallet without sending a message', async () => {
    const { page } = await open({ api });
    await expect(
      page.evaluate(() => (window as PageWindow).freighterApi.isConnected()),
    ).resolves.toEqual({ isConnected: true });
  });

  it('connects through a prompt from the page origin', async () => {
    const { page, wallet } = await open({ api });
    await expect(
      page.evaluate(() => (window as PageWindow).freighterApi.requestAccess()),
    ).resolves.toEqual({ address: wallet.address });
    expect(wallet.prompts()).toMatchObject([
      { id: 'p1', kind: 'connect', origin: app, status: 'approved' },
    ]);
  });

  it('reads the address and network of a connected wallet', async () => {
    const { page, wallet } = await open({ api, options: { connected: true } });
    await expect(
      page.evaluate(() => (window as PageWindow).freighterApi.getAddress()),
    ).resolves.toEqual({ address: wallet.address });
    await expect(
      page.evaluate(() =>
        (window as PageWindow).freighterApi.getNetworkDetails(),
      ),
    ).resolves.toMatchObject({
      network: 'TESTNET',
      networkPassphrase: Networks.TESTNET,
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org/',
    });
    expect(wallet.prompts()).toEqual([]);
  });

  it('signs a transaction in Node', async () => {
    const { page, wallet, keypair } = await open({
      api,
      options: { connected: true },
    });
    const xdr = payment(wallet.address);
    const { signedTxXdr, signerAddress } = await page.evaluate(
      ([envelope, networkPassphrase]) =>
        (window as PageWindow).freighterApi.signTransaction(envelope, {
          networkPassphrase,
        }),
      [xdr, Networks.TESTNET] as const,
    );
    expect(signerAddress).toBe(wallet.address);
    const signed = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
    const [signature] = signed.signatures;
    expect(signed.signatures).toHaveLength(1);
    expect(
      signature && keypair.verify(signed.hash(), signature.signature),
    ).toBe(true);
    expect(wallet.prompts('signTransaction')).toMatchObject([
      { origin: app, status: 'approved' },
    ]);
  });

  it('signs a message as SEP-53 describes', async () => {
    const { page, wallet, keypair } = await open({
      api,
      options: { connected: true },
    });
    const { signedMessage: signature, signerAddress } = await page.evaluate(
      ([text, networkPassphrase]) =>
        (window as PageWindow).freighterApi.signMessage(text, {
          networkPassphrase,
        }),
      [message, Networks.TESTNET] as const,
    );
    expect(signerAddress).toBe(wallet.address);
    expect(
      keypair.verify(
        signedMessage(message),
        Buffer.from(String(signature), 'base64'),
      ),
    ).toBe(true);
  });

  it('gives up after 2 s on a page without a wallet', async () => {
    const { page, wallet } = await open({ api, wallet: 'none' });
    const { result, elapsed } = await page.evaluate(async () => {
      const started = performance.now();
      const result = await (window as PageWindow).freighterApi.isConnected();
      return { result, elapsed: performance.now() - started };
    });
    expect(result).toMatchObject({ isConnected: false });
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(wallet.prompts()).toEqual([]);
  }, 15_000);
});

describe('the Playwright host', () => {
  it("takes the origin from the frame's URL, not from the message", async () => {
    const origin = 'http://app.test:4000';
    const { page, wallet } = await open({ origin });
    await page.evaluate(() =>
      window.postMessage(
        {
          source: 'FREIGHTER_EXTERNAL_MSG_REQUEST',
          messageId: 1,
          type: 'REQUEST_ACCESS',
          origin: 'https://evil.test',
          url: 'https://evil.test/',
        },
        '*',
      ),
    );
    const prompt = await wallet.nextPrompt('connect');
    expect(prompt.origin).toBe(origin);
  });

  it('refuses calls from an iframe and installs nothing there', async () => {
    const { page, wallet } = await open({
      body: '<iframe src="/frame"></iframe>',
    });
    const frame = page.frames().find((child) => child.url().endsWith('/frame'));
    if (!frame) throw new Error('the iframe did not load');
    await expect(frame.evaluate(() => 'freighter' in window)).resolves.toBe(
      false,
    );
    await expect(
      frame.evaluate(() =>
        (window as PageWindow).__stardust({ type: 'REQUEST_ACCESS' }),
      ),
    ).rejects.toThrow("__stardust answers only the page's top frame.");
    await expect(page.evaluate(() => 'freighter' in window)).resolves.toBe(
      true,
    );
    expect(wallet.prompts()).toEqual([]);
  });
});

describe('sep60 in Chromium', () => {
  it('is found through SEP-60 discovery and answers SEP-43 calls', async () => {
    const { page, wallet, keypair } = await open({
      wallet: 'sep60',
      script: discovery,
    });
    await expect(
      page.evaluate(() =>
        (window as PageWindow).providers.map(({ info }) => info.name),
      ),
    ).resolves.toEqual(['Stardust (test wallet)']);
    await expect(
      page.evaluate(() =>
        (window as PageWindow).providers[0]?.provider.getAddress(),
      ),
    ).resolves.toEqual({ address: wallet.address });

    const { signedMessage: signature, signerAddress } = await page.evaluate(
      ([text, networkPassphrase]) => {
        const [found] = (window as PageWindow).providers;
        if (!found) throw new Error('no provider');
        return found.provider.signMessage(text, { networkPassphrase });
      },
      [message, Networks.TESTNET] as const,
    );
    expect(signerAddress).toBe(wallet.address);
    expect(
      keypair.verify(signedMessage(message), Buffer.from(signature, 'base64')),
    ).toBe(true);
    expect(wallet.prompts()).toMatchObject([
      { kind: 'connect', origin: app, status: 'approved' },
      { kind: 'signMessage', origin: app, status: 'approved' },
    ]);
  });
});
