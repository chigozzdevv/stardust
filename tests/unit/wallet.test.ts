import { Networks, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ContractSpecs } from '@/contracts/spec';
import type { Account } from '@/funding/accounts';
import { Rpc } from '@/network/network';
import { pageScript } from '@/protocols/page-script';
import { providerInfo } from '@/protocols/sep60/sep60';
import type { ProviderInfo } from '@/protocols/sep60/sep60';
import { declined } from '@/wallet/prompts';
import { EmulatedWallet } from '@/wallet/wallet';
import type { WalletOptions } from '@/wallet/wallet';
import { FakeLedger } from '@tests/fixtures/rpc/fake-ledger';
import type { RpcRequest } from '@tests/fixtures/rpc/replay';
import { payment } from '@tests/fixtures/wallet/envelopes';
import { FakeHost } from '@tests/fixtures/wallet/fake-page';
import {
  account,
  isPending,
  settled,
  testnet,
} from '@tests/fixtures/wallet/prompt-queue';

interface Detail {
  readonly info: ProviderInfo;
  readonly provider: Record<string, () => Promise<unknown>>;
}

const site = 'https://app.test';
const binding = '__stardust';
const futurenetRpc = 'https://rpc-futurenet.stellar.org';
const onTestnet = { networkPassphrase: Networks.TESTNET };

function bench(options: Partial<WalletOptions> = {}) {
  const ledger = new FakeLedger();
  const requests: { url: string; method: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const { method } = JSON.parse(String(init?.body)) as RpcRequest;
    requests.push({ url: String(input), method });
    return ledger.fetch(input, init);
  };
  const rpc = new Rpc(testnet.rpcUrl, fetch);
  const accounts = [account(), account()] as [Account, Account];
  const wallet = new EmulatedWallet(
    { accounts, ...options },
    {
      network: testnet,
      landing: { rpc, specs: new ContractSpecs(rpc) },
      fetch,
    },
  );
  return { wallet, accounts, requests, host: new FakeHost() };
}

async function attached(
  options: Partial<WalletOptions> = {},
  kind: 'varial' | 'sep60' = 'varial',
) {
  const setup = bench(options);
  await setup.wallet.attach(setup.host, { wallet: kind });
  const handler = setup.host.bindings.get(binding);
  if (!handler) throw new Error(`attach() exposed no ${binding} binding`);
  const call = (type: string, fields: object = {}, origin = site) =>
    handler(origin, { type, ...fields });
  return { ...setup, call };
}

function urls(requests: readonly { url: string }[]): string[] {
  return [...new Set(requests.map(({ url }) => url))];
}

describe('attach', () => {
  it('exposes one binding and installs the varial page script', async () => {
    const { wallet, host } = bench();
    await wallet.attach(host, { wallet: 'varial' });
    expect([...host.bindings.keys()]).toEqual([binding]);
    expect(host.scripts).toEqual([pageScript({ wallet: 'varial', binding })]);
  });

  it('answers @stellar/freighter-api in the page, with the origin the host gives', async () => {
    const { wallet, host } = await attached({ policy: 'approve' });
    const api = host.open(`${site}/`).load('@stellar/freighter-api');

    await expect(api.requestAccess()).resolves.toEqual({
      address: wallet.address,
    });
    await expect(api.getNetworkDetails()).resolves.toMatchObject({
      network: 'TESTNET',
      networkPassphrase: Networks.TESTNET,
    });
    expect(wallet.prompts()).toMatchObject([
      { id: 'p1', kind: 'connect', origin: site, status: 'approved' },
    ]);
  });

  it("takes the origin from the binding's caller, never from the message", async () => {
    const { wallet, call } = await attached();
    void call(
      'REQUEST_ACCESS',
      { origin: 'https://evil.test', url: 'https://evil.test/' },
      'http://localhost:3000',
    );
    const prompt = await wallet.nextPrompt('connect');
    expect(prompt.origin).toBe('http://localhost:3000');
  });

  it('installs and answers the sep60 provider', async () => {
    const { wallet, host } = await attached({ policy: 'approve' }, 'sep60');
    expect(host.scripts).toEqual([
      pageScript({ wallet: 'sep60', binding, info: providerInfo }),
    ]);

    const window = host.open(`${site}/`);
    const announced: Detail[] = [];
    window.addEventListener('sep0060:announceProvider', (event) => {
      announced.push((event as CustomEvent<Detail>).detail);
    });
    window.dispatchEvent(new Event('sep0060:requestProvider'));
    const [detail] = announced;

    expect(detail?.info).toMatchObject({
      name: 'Stardust (test wallet)',
      rdns: 'io.github.stardust-stellar',
    });
    await expect(detail?.provider.getAddress?.()).resolves.toEqual({
      address: wallet.address,
    });
    expect(wallet.prompts()).toMatchObject([
      { kind: 'connect', origin: site, status: 'approved' },
    ]);
  });

  it("refuses a wallet other than 'varial' or 'sep60'", async () => {
    const { wallet, host } = bench();
    await expect(
      wallet.attach(host, { wallet: 'none' as 'varial' }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message:
        "attach() got wallet 'none'. Use 'varial' or 'sep60'; a page without a wallet is one the wallet isn't attached to.",
    });
    expect(host.bindings.size).toBe(0);
    expect(host.scripts).toEqual([]);
  });
});

describe('options', () => {
  it('starts on the first account and the network it was given, and approves by default', async () => {
    const { wallet, accounts, call } = await attached();
    expect(wallet.address).toBe(accounts[0].address);
    expect(wallet.network).toBe(testnet);
    await expect(call('REQUEST_ACCESS')).resolves.toEqual({
      publicKey: accounts[0].address,
    });
  });

  it('connected: true connects the site for every account', async () => {
    const { wallet, accounts, call } = await attached({ connected: true });
    await expect(call('REQUEST_PUBLIC_KEY')).resolves.toEqual({
      publicKey: accounts[0].address,
    });
    await wallet.switchAccount(accounts[1]);
    await expect(call('REQUEST_PUBLIC_KEY')).resolves.toEqual({
      publicKey: accounts[1].address,
    });
  });

  it('allowHttp: false blocks signing on http:// pages', async () => {
    const message = { blob: 'Sign in', ...onTestnet };
    const page = 'http://localhost:3000';
    const allowed = await attached({ connected: true, policy: 'manual' });
    void allowed.call('SUBMIT_BLOB', message, page);
    await expect(allowed.wallet.nextPrompt()).resolves.toMatchObject({
      blocked: null,
    });

    const refused = await attached({
      connected: true,
      policy: 'manual',
      allowHttp: false,
    });
    void refused.call('SUBMIT_BLOB', message, page);
    await expect(refused.wallet.nextPrompt()).resolves.toMatchObject({
      blocked: 'insecureOrigin',
    });
  });
});

describe('user actions', () => {
  it('switchAccount changes the address the app sees, within the wallet only', async () => {
    const { wallet, accounts, call } = await attached({ connected: true });
    await wallet.switchAccount(accounts[1]);
    expect(wallet.address).toBe(accounts[1].address);
    await expect(call('REQUEST_PUBLIC_KEY')).resolves.toEqual({
      publicKey: accounts[1].address,
    });

    await expect(wallet.switchAccount(account())).rejects.toMatchObject({
      code: 'UNKNOWN_ACCOUNT',
    });
    expect(wallet.address).toBe(accounts[1].address);
  });

  it('switchNetwork changes the network the app sees, and the site must connect again', async () => {
    const { wallet, call } = await attached({ connected: true });
    await wallet.switchNetwork('futurenet');
    expect(wallet.network).toMatchObject({
      name: 'futurenet',
      rpcUrl: futurenetRpc,
      networkPassphrase: Networks.FUTURENET,
    });
    await expect(call('REQUEST_NETWORK_DETAILS')).resolves.toMatchObject({
      networkDetails: { network: 'FUTURENET' },
    });
    await expect(call('REQUEST_PUBLIC_KEY')).resolves.toEqual({
      publicKey: '',
    });

    await wallet.switchNetwork('testnet');
    expect(wallet.network).toBe(testnet);
    await expect(call('REQUEST_PUBLIC_KEY')).resolves.toEqual({
      publicKey: wallet.address,
    });
  });

  it('lock holds prompts under every policy until unlock lets the policy answer', async () => {
    const { wallet, accounts, call } = await attached({ connected: true });
    await wallet.lock();
    const signed = call('SUBMIT_BLOB', { blob: 'Sign in', ...onTestnet });
    const prompt = await wallet.nextPrompt('signMessage');
    expect(prompt).toMatchObject({ status: 'pending', blocked: 'locked' });
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'WALLET_LOCKED',
    });
    expect(await isPending(signed)).toBe(true);

    await wallet.unlock();
    await expect(signed).resolves.toMatchObject({
      signerAddress: accounts[0].address,
    });
    expect(prompt).toMatchObject({ status: 'approved', blocked: null });
  });

  it('lock hides the account until unlock, so the app connects again before signing', async () => {
    const { wallet, host } = await attached({ connected: true });
    const api = host.open(`${site}/`).load('@stellar/freighter-api');
    await wallet.lock();
    await expect(api.isConnected()).resolves.toEqual({ isConnected: true });
    await expect(api.getAddress()).resolves.toEqual({ address: '' });
    await expect(api.isAllowed()).resolves.toEqual({ isAllowed: false });

    const signed = api.signMessage('Sign in', onTestnet);
    const connect = await wallet.nextPrompt('connect');
    expect(connect).toMatchObject({ status: 'pending', blocked: 'locked' });
    expect(wallet.prompts('signMessage')).toEqual([]);

    await wallet.unlock();
    await expect(signed).resolves.toMatchObject({
      signerAddress: wallet.address,
    });
    expect(wallet.prompts()).toMatchObject([
      { kind: 'connect', status: 'approved' },
      { kind: 'signMessage', status: 'approved' },
    ]);
    await expect(api.getAddress()).resolves.toEqual({
      address: wallet.address,
    });
  });

  it('reject() answers a prompt while the wallet is locked', async () => {
    const { wallet, call } = await attached({ connected: true });
    await wallet.lock();
    const signed = call('SUBMIT_BLOB', { blob: 'Sign in', ...onTestnet });
    await (await wallet.nextPrompt('signMessage')).reject();
    await expect(signed).resolves.toEqual({
      apiError: declined,
      error: declined.message,
    });
  });

  it('disconnect removes the site for the active account on the active network', async () => {
    const { wallet, accounts, call } = await attached({ connected: true });
    await wallet.disconnect();
    await expect(call('REQUEST_ALLOWED_STATUS')).resolves.toEqual({
      isAllowed: false,
    });
    await wallet.switchAccount(accounts[1]);
    await expect(call('REQUEST_ALLOWED_STATUS')).resolves.toEqual({
      isAllowed: true,
    });
  });
});

describe('prompts', () => {
  it('setPolicy changes how later prompts are answered', async () => {
    const { wallet, call } = await attached();
    await call('REQUEST_ACCESS');
    await wallet.disconnect();
    wallet.setPolicy('reject');
    await expect(call('REQUEST_ACCESS')).resolves.toEqual({
      apiError: declined,
      error: declined.message,
    });
    expect(wallet.prompts('connect').map(({ status }) => status)).toEqual([
      'approved',
      'rejected',
    ]);
  });

  it('subscribe hears each prompt arrive and get answered, until unsubscribed', async () => {
    const { wallet, call } = await attached({ policy: 'manual' });
    const seen: string[] = [];
    const unsubscribe = wallet.subscribe(({ id, status }) =>
      seen.push(`${id} ${status}`),
    );
    void call('REQUEST_ACCESS');
    await (await wallet.nextPrompt()).approve();
    unsubscribe();
    await wallet.disconnect();
    void call('REQUEST_ACCESS');
    await wallet.nextPrompt();
    expect(seen).toEqual(['p1 pending', 'p1 approved']);
  });

  it('nextPrompt and prompts filter by kind', async () => {
    const { wallet, call } = await attached({
      connected: true,
      policy: 'manual',
    });
    void call('SUBMIT_BLOB', { blob: 'Sign in', ...onTestnet });
    void call('SUBMIT_TRANSACTION', {
      transactionXdr: payment(wallet.address),
      ...onTestnet,
    });
    await expect(wallet.nextPrompt('signTransaction')).resolves.toMatchObject({
      id: 'p2',
    });
    expect(wallet.prompts('signMessage')).toMatchObject([{ id: 'p1' }]);
    expect(wallet.prompts()).toHaveLength(2);
  });
});

describe('endOfTest', () => {
  it('reports nothing when every prompt was answered and the app kept the rules', async () => {
    const { wallet, call } = await attached({ connected: true });
    await call('SUBMIT_BLOB', { blob: 'Sign in', ...onTestnet });
    expect(wallet.endOfTest()).toEqual([]);
  });

  it('reports unanswered prompts, then violations under strict mode', async () => {
    const { wallet, call } = await attached({
      connected: true,
      policy: 'manual',
    });
    void call('SUBMIT_TRANSACTION', {
      transactionXdr: payment(wallet.address),
    });
    await wallet.nextPrompt('signTransaction');

    expect(wallet.violations()).toMatchObject([
      { promptId: 'p1', kind: 'missingNetworkPassphrase' },
    ]);
    expect(wallet.endOfTest()).toMatchObject([
      {
        code: 'PROMPTS_PENDING',
        message: [
          'Stardust: test ended with 1 unanswered prompt',
          '  p1 signTransaction (pending)',
          '  Call approve(), reject(), fail() or hang() before the test ends.',
        ].join('\n'),
      },
      {
        code: 'PROTOCOL_VIOLATION',
        message: expect.stringMatching(
          /^Stardust: 1 protocol violation in this test\n {2}p1 signTransaction {2}missingNetworkPassphrase\n/,
        ),
      },
    ]);
  });

  it('lists violations without reporting them when strict is false', async () => {
    const { wallet, call } = await attached({ strict: false });
    await call('REQUEST_SECRET_KEY');
    expect(wallet.violations()).toMatchObject([{ kind: 'unknownMessage' }]);
    expect(wallet.endOfTest()).toEqual([]);
  });

  it('reports errors the wallet had no caller to throw to first', async () => {
    const broken = new Error('the policy broke');
    const { wallet, call } = await attached({
      policy: () => {
        throw broken;
      },
    });
    void call('REQUEST_ACCESS');
    await settled();
    expect(wallet.endOfTest()).toMatchObject([
      broken,
      { code: 'PROMPTS_PENDING' },
    ]);
  });
});

describe('networks', () => {
  it("lands a transaction signed on futurenet through futurenet's RPC", async () => {
    const { wallet, accounts, call, requests } = await attached();
    await wallet.switchNetwork('futurenet');
    await call('REQUEST_ACCESS');
    await expect(
      call('SUBMIT_TRANSACTION', {
        transactionXdr: payment(accounts[0].address, Networks.FUTURENET),
        networkPassphrase: Networks.FUTURENET,
      }),
    ).resolves.toMatchObject({ signerAddress: accounts[0].address });

    const prompt = await wallet.nextPrompt('signTransaction');
    await expect(prompt.landed({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(urls(requests)).toEqual([futurenetRpc]);
  });

  it('keeps landing on the network a prompt was signed for after a switch', async () => {
    const { wallet, call, requests } = await attached({ connected: true });
    await call('SUBMIT_TRANSACTION', {
      transactionXdr: payment(wallet.address),
      ...onTestnet,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    await wallet.switchNetwork('futurenet');

    await expect(prompt.landed({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(urls(requests)).toEqual([testnet.rpcUrl]);
  });

  it('never sends a request to a mainnet RPC', async () => {
    const { wallet, call, requests } = await attached();
    await wallet.switchNetwork('mainnet');
    await expect(call('REQUEST_ACCESS')).resolves.toEqual({
      publicKey: wallet.address,
    });
    await expect(
      call('SUBMIT_TOKEN', {
        contractId: StrKey.encodeContract(Buffer.alloc(32, 7)),
        networkPassphrase: Networks.PUBLIC,
      }),
    ).resolves.toEqual({ apiError: declined });
    expect(urls(requests)).toEqual([testnet.rpcUrl]);
  });
});
