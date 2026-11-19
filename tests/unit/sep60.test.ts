import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { version } from '@/../package.json';
import { xlm } from '@/amounts';
import type { Account } from '@/funding/accounts';
import { pageScript } from '@/protocols/page-script';
import {
  Sep60,
  providerInfo,
  sep43Version,
  sep60Version,
} from '@/protocols/sep60/sep60';
import type { ProviderInfo } from '@/protocols/sep60/sep60';
import type { Policy } from '@/wallet/policy';
import { declined } from '@/wallet/prompts';
import { Violations } from '@/wallet/strict';
import { FakeLedger } from '@tests/fixtures/rpc/fake-ledger';
import type { RpcRequest } from '@tests/fixtures/rpc/replay';
import { payment, preimage, sha256 } from '@tests/fixtures/wallet/envelopes';
import { FakeWindow } from '@tests/fixtures/wallet/fake-page';
import { isPending, promptQueue } from '@tests/fixtures/wallet/prompt-queue';

interface BenchOptions {
  readonly policy?: Policy;
  readonly connected?: boolean;
  readonly allowHttp?: boolean;
  readonly send?: typeof fetch;
}

interface Detail {
  readonly info: ProviderInfo;
  readonly provider: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

interface Signed {
  readonly signerAddress: string;
  readonly [field: string]: unknown;
}

const site = 'https://app.test';
const binding = '__stardust';
const standalone = 'Standalone Network ; February 2017';
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = 'Request is invalid. Please check the details and try again.';
const onTestnet = { networkPassphrase: Networks.TESTNET };

function sep60({
  policy = 'manual',
  connected = false,
  allowHttp = true,
  send,
}: BenchOptions = {}) {
  const ledger = new FakeLedger();
  const requests: { url: string; method: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (typeof init?.body === 'string') {
      const { method } = JSON.parse(init.body) as RpcRequest;
      requests.push({ url: String(input), method });
    }
    return (send ?? ledger.fetch)(input, init);
  };
  const { state, queue, landing, accounts } = promptQueue({
    policy,
    connected,
    send: fetch,
  });
  const violations = new Violations();
  const wallet = new Sep60({
    state,
    queue,
    landing,
    violations,
    allowHttp,
    fetch,
  });
  const [main, other] = accounts as [Account, Account];
  const ask = (method: string, fields: object = {}, origin = site) =>
    wallet.handle(origin, { method, ...fields });
  const fund = (address: string) =>
    ledger.accounts.set(address, { balance: xlm('100'), sequence: 7n });
  return {
    state,
    queue,
    ledger,
    requests,
    violations,
    wallet,
    main,
    other,
    ask,
    fund,
  };
}

function failure(code: number, message: string, ext?: string[]) {
  return { error: { code, message, ...(ext && { ext }) } };
}

function announcer({ framed = false } = {}) {
  const bench = sep60({ policy: 'approve', connected: true });
  const top = framed ? new FakeWindow('https://parent.test/') : undefined;
  const window = new FakeWindow(`${site}/`, top);
  const announced: Detail[] = [];
  window.addEventListener('sep0060:announceProvider', (event) => {
    announced.push((event as CustomEvent<Detail>).detail);
  });
  window.expose(binding, (origin, payload) =>
    bench.wallet.handle(origin, payload),
  );
  window.run(pageScript({ wallet: 'sep60', binding, info: providerInfo }));
  const request = () =>
    window.dispatchEvent(new Event('sep0060:requestProvider'));
  return { ...bench, window, announced, request };
}

function horizon(status: number, body: object) {
  const posts: { url: string; type: string | null; tx: string | null }[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith('/transactions')) {
      return new Response('Not Found', { status: 404 });
    }
    posts.push({
      url,
      type: new Headers(init?.headers).get('content-type'),
      tx: new URLSearchParams(String(init?.body)).get('tx'),
    });
    return Response.json(body, { status });
  };
  return { send, posts };
}

function verifies(account: Account, signed: string): boolean {
  const transaction = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
  const [signature] = transaction.signatures;
  return (
    transaction.signatures.length === 1 &&
    signature !== undefined &&
    account.keypair.verify(transaction.hash(), signature.signature)
  );
}

describe('versions', () => {
  it('match SEP-43 v1.2.1 and SEP-60 v0.1.0', () => {
    expect(sep43Version).toBe('1.2.1');
    expect(sep60Version).toBe('0.1.0');
  });
});

describe('announcement', () => {
  it('announces once ready, with the info SEP-60 asks for', () => {
    const { announced } = announcer();
    expect(announced).toHaveLength(1);
    const [{ info }] = announced as [Detail];
    expect(info).toEqual({
      uuid: expect.stringMatching(uuidV4),
      name: 'Stardust (test wallet)',
      icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      rdns: 'io.github.stardust-stellar',
      version,
    });
    const svg = Buffer.from(info.icon.split(',')[1] ?? '', 'base64');
    expect(svg.toString()).toMatch(/^<svg [^>]*width="96" height="96"/);
    const label = '[a-z0-9]([a-z0-9-]*[a-z0-9])?';
    expect(info.rdns).toMatch(new RegExp(`^${label}(\\.${label})+$`));
  });

  it('freezes detail, info and provider', () => {
    const { announced } = announcer();
    const [detail] = announced as [Detail];
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.info)).toBe(true);
    expect(Object.isFrozen(detail.provider)).toBe(true);
    expect(Object.keys(detail.provider).sort()).toEqual([
      'getAddress',
      'getNetwork',
      'signAuthEntry',
      'signMessage',
      'signTransaction',
    ]);
  });

  it('announces again with the same detail on every sep0060:requestProvider', () => {
    const { announced, request } = announcer();
    request();
    request();
    expect(announced).toHaveLength(3);
    expect(new Set(announced).size).toBe(1);
  });

  it('keeps one uuid per page session, and a new document gets a new one', () => {
    const first = announcer();
    const second = announcer();
    first.request();
    expect(first.announced[1]?.info.uuid).toBe(first.announced[0]?.info.uuid);
    expect(second.announced[0]?.info.uuid).not.toBe(
      first.announced[0]?.info.uuid,
    );
  });

  it('announces only in the top-level frame', () => {
    const { announced, request } = announcer({ framed: true });
    request();
    expect(announced).toEqual([]);
  });

  it('bridges provider methods to the wallet in Node', async () => {
    const { announced, state } = announcer();
    const [{ provider }] = announced as [Detail];
    await expect(provider.getNetwork?.()).resolves.toEqual({
      network: 'TESTNET',
      networkPassphrase: Networks.TESTNET,
    });
    await expect(provider.getAddress?.()).resolves.toEqual({
      address: state.address,
    });
    const signed = (await provider.signMessage?.('Sign in')) as Signed;
    expect(signed.signerAddress).toBe(state.address);
  });
});

describe('getAddress', () => {
  it('answers a connected site at once', async () => {
    const { ask, state, queue } = sep60({ connected: true });
    await expect(ask('getAddress')).resolves.toEqual({
      address: state.address,
    });
    expect(queue.prompts()).toEqual([]);
  });

  it('turns a new site into a connect prompt, scoped to its hostname', async () => {
    const { ask, state, queue } = sep60();
    const reply = ask('getAddress', { origin: 'https://evil.test' });
    const prompt = await queue.nextPrompt('connect');
    expect(prompt).toMatchObject({
      id: 'p1',
      origin: site,
      networkPassphrase: null,
      blocked: null,
    });
    expect(await isPending(reply)).toBe(true);
    await prompt.approve();
    await expect(reply).resolves.toEqual({ address: state.address });
    expect(state.isConnected('https://app.test:8443')).toBe(true);
    expect(state.isConnected('https://evil.test')).toBe(false);
  });

  it('replies -4 when the user rejects', async () => {
    const { ask, state } = sep60({ policy: 'reject' });
    await expect(ask('getAddress')).resolves.toEqual({ error: declined });
    expect(state.isConnected(site)).toBe(false);
  });

  it('keeps the address known while locked, and holds a new connection until unlock', async () => {
    const { ask, state, queue } = sep60({ policy: 'approve' });
    state.connect('https://known.test');
    state.locked = true;
    await expect(ask('getAddress', {}, 'https://known.test')).resolves.toEqual({
      address: state.address,
    });
    const reply = ask('getAddress');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      kind: 'connect',
      blocked: 'locked',
    });
    expect(await isPending(reply)).toBe(true);
    state.locked = false;
    queue.resume();
    await expect(reply).resolves.toEqual({ address: state.address });
  });
});

describe('getNetwork', () => {
  it.each([
    ['testnet', 'TESTNET', Networks.TESTNET],
    ['futurenet', 'FUTURENET', Networks.FUTURENET],
    ['mainnet', 'PUBLIC', Networks.PUBLIC],
  ] as const)(
    'reports %s as %s with its passphrase',
    async (name, network, networkPassphrase) => {
      const { ask, state } = sep60();
      state.switchNetwork(name);
      await expect(ask('getNetwork')).resolves.toEqual({
        network,
        networkPassphrase,
      });
    },
  );
});

describe('signTransaction', () => {
  it("signs for the wallet's network and replies { signedTxXdr, signerAddress }", async () => {
    const { ask, state, queue, main } = sep60({ connected: true });
    const xdr = payment(main.address);
    const reply = ask('signTransaction', { xdr, opts: onTestnet });
    const prompt = await queue.nextPrompt('signTransaction');
    expect(prompt).toMatchObject({
      origin: site,
      networkPassphrase: Networks.TESTNET,
      blocked: null,
      transaction: { xdr, source: main.address },
    });
    await prompt.approve();
    const { signedTxXdr, signerAddress } = (await reply) as Signed;
    expect(signerAddress).toBe(state.address);
    expect(verifies(main, String(signedTxXdr))).toBe(true);
  });

  it("uses the wallet's network when the app sends no networkPassphrase", async () => {
    const { ask, queue, main, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('signTransaction', { xdr: payment(main.address) }),
    ).resolves.toMatchObject({ signerAddress: main.address });
    await ask('signTransaction', { xdr: payment(main.address), opts: null });
    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: null, blocked: null, status: 'approved' },
      { networkPassphrase: null, blocked: null, status: 'approved' },
    ]);
    expect(violations.list()).toEqual([]);
  });

  it("shows a connect prompt first on a site that isn't connected", async () => {
    const { ask, queue, main } = sep60();
    const reply = ask('signTransaction', {
      xdr: payment(main.address),
      opts: onTestnet,
    });
    await (await queue.nextPrompt()).approve();
    const sign = await queue.nextPrompt();
    expect(sign).toMatchObject({
      id: 'p2',
      kind: 'signTransaction',
      blocked: null,
    });
    await sign.approve();
    await expect(reply).resolves.toMatchObject({ signerAddress: main.address });
    expect(queue.prompts().map(({ kind }) => kind)).toEqual([
      'connect',
      'signTransaction',
    ]);
  });

  it('stops at a rejected connection, with no sign prompt', async () => {
    const { ask, queue, main } = sep60({ policy: 'reject' });
    await expect(
      ask('signTransaction', { xdr: payment(main.address) }),
    ).resolves.toEqual({ error: declined });
    expect(queue.prompts().map(({ kind }) => kind)).toEqual(['connect']);
  });

  it('blocks a transaction for another network and records networkMismatch', async () => {
    const { ask, queue, main, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address, Networks.FUTURENET),
        opts: { networkPassphrase: Networks.FUTURENET },
      }),
    ).resolves.toEqual({ error: declined });
    expect(queue.prompts()).toMatchObject([
      { blocked: 'networkMismatch', status: 'rejected' },
    ]);
    expect(violations.list()).toEqual([
      {
        promptId: 'p1',
        kind: 'networkMismatch',
        detail: [
          `The app asked to sign for "${Networks.FUTURENET}",`,
          `but the wallet is on "${Networks.TESTNET}".`,
          'A real wallet refuses this, so Stardust refused it too.',
        ].join('\n'),
      },
    ]);
  });

  it('signs with the active account and records signerMismatch for any other address', async () => {
    const { ask, state, main, other, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { address: other.address },
      }),
    ).resolves.toMatchObject({ signerAddress: main.address });
    expect(state.address).toBe(main.address);
    expect(violations.list()).toEqual([
      {
        promptId: 'p1',
        kind: 'signerMismatch',
        detail: [
          `The app asked for a signature from ${other.address},`,
          `but the wallet signs with ${main.address}.`,
          'Use the address the wallet reports from getAddress().',
        ].join('\n'),
      },
    ]);
  });

  it.each([
    [true, null],
    [false, 'insecureOrigin'],
  ])(
    'with allowHttp: %s, an http page gets blocked %s',
    async (allowHttp, blocked) => {
      const { ask, queue, main } = sep60({ connected: true, allowHttp });
      const request = { xdr: payment(main.address) };
      void ask('signTransaction', request, 'http://localhost:5173');
      void ask('signTransaction', request);
      await expect(queue.nextPrompt()).resolves.toMatchObject({ blocked });
      await expect(queue.nextPrompt()).resolves.toMatchObject({
        blocked: null,
      });
    },
  );

  it('holds a transaction while the wallet is locked', async () => {
    const { ask, state, queue, main } = sep60({
      connected: true,
      policy: 'approve',
    });
    state.locked = true;
    const reply = ask('signTransaction', { xdr: payment(main.address) });
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      blocked: 'locked',
      status: 'pending',
    });
    expect(await isPending(reply)).toBe(true);
    state.locked = false;
    queue.resume();
    await expect(reply).resolves.toMatchObject({ signerAddress: main.address });
  });

  it('answers -4 instead of signing while the wallet is on mainnet', async () => {
    const { ask, state, main } = sep60({ policy: 'approve' });
    state.switchNetwork('mainnet');
    state.connect(site);
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address, Networks.PUBLIC),
        opts: { networkPassphrase: Networks.PUBLIC },
      }),
    ).resolves.toEqual({ error: declined });
  });

  it("answers XDR that doesn't parse with -3 and no prompt", async () => {
    const { ask, queue, violations } = sep60({ connected: true });
    await expect(
      ask('signTransaction', { xdr: 'not a transaction' }),
    ).resolves.toEqual(failure(-3, invalid, ['Invalid transaction XDR']));
    expect(queue.prompts()).toEqual([]);
    expect(violations.list()).toMatchObject([
      {
        promptId: null,
        kind: 'invalidXdr',
        detail: expect.stringMatching(/^The app sent a transaction that/),
      },
    ]);
  });

  it('replies the wallet error a test simulates, and nothing for a hung prompt', async () => {
    const { ask, queue, main } = sep60({ connected: true });
    const failed = ask('signTransaction', { xdr: payment(main.address) });
    await (await queue.nextPrompt()).fail({ code: -2 });
    await expect(failed).resolves.toEqual(
      failure(-2, 'Stardust: simulated wallet error (code -2)'),
    );

    const hung = ask('signTransaction', { xdr: payment(main.address) });
    (await queue.nextPrompt()).hang();
    expect(await isPending(hung)).toBe(true);
  });
});

describe('signTransaction with submit: true', () => {
  it("sends to the wallet's RPC with sendTransaction, then replies", async () => {
    const { ask, queue, ledger, requests, main, fund } = sep60({
      connected: true,
      policy: 'approve',
    });
    fund(main.address);
    const reply = (await ask('signTransaction', {
      xdr: payment(main.address),
      opts: { submit: true },
    })) as Signed;
    expect(verifies(main, String(reply.signedTxXdr))).toBe(true);
    expect(requests).toEqual([
      { url: 'https://soroban-testnet.stellar.org', method: 'sendTransaction' },
    ]);
    expect(ledger.transactions).toHaveLength(1);
    const [prompt] = queue.prompts('signTransaction');
    await expect(prompt?.landed({ timeoutMs: 1_000 })).resolves.toMatchObject({
      hash: prompt?.transaction.hash,
    });
  });

  it('replies -2 when the RPC refuses the transaction', async () => {
    const { ask, queue, main } = sep60({ connected: true, policy: 'approve' });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { submit: true },
      }),
    ).resolves.toEqual(
      failure(-2, 'An error occurred with Stellar RPC. Please try again.', [
        'txNO_ACCOUNT',
      ]),
    );
    expect(queue.prompts()).toMatchObject([{ status: 'approved' }]);
  });

  it('probes submitUrl with getHealth once, and uses sendTransaction when it answers', async () => {
    const { ask, requests, main, fund } = sep60({
      connected: true,
      policy: 'approve',
    });
    const submitUrl = 'https://rpc.other.test';
    fund(main.address);
    const opts = { submit: true, submitUrl };
    await ask('signTransaction', { xdr: payment(main.address), opts });
    await ask('signTransaction', { xdr: payment(main.address), opts });
    expect(requests).toEqual([
      { url: submitUrl, method: 'getHealth' },
      { url: submitUrl, method: 'sendTransaction' },
      { url: submitUrl, method: 'sendTransaction' },
    ]);
  });

  it('treats a submitUrl without getHealth as Horizon and POSTs to /transactions', async () => {
    const { send, posts } = horizon(200, { successful: true });
    const { ask, main } = sep60({ connected: true, policy: 'approve', send });
    const reply = (await ask('signTransaction', {
      xdr: payment(main.address),
      opts: { submit: true, submitUrl: 'https://horizon.test/' },
    })) as Signed;
    expect(posts).toEqual([
      {
        url: 'https://horizon.test/transactions',
        type: 'application/x-www-form-urlencoded',
        tx: reply.signedTxXdr,
      },
    ]);
  });

  it('replies -2 with the result codes when Horizon refuses the transaction', async () => {
    const { send } = horizon(400, {
      title: 'Transaction Failed',
      extras: {
        result_codes: {
          transaction: 'tx_failed',
          operations: ['op_no_destination'],
        },
      },
    });
    const { ask, main } = sep60({ connected: true, policy: 'approve', send });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { submit: true, submitUrl: 'https://horizon.test' },
      }),
    ).resolves.toEqual(
      failure(-2, 'An error occurred with Horizon. Please try again.', [
        'https://horizon.test/transactions answered HTTP 400',
        'tx_failed',
        'op_no_destination',
      ]),
    );
  });

  it("refuses a submitUrl that isn't http or https with -3", async () => {
    const { ask, queue, main } = sep60({ connected: true });
    await expect(
      ask('signTransaction', {
        xdr: payment(main.address),
        opts: { submit: true, submitUrl: 'file:///etc/passwd' },
      }),
    ).resolves.toMatchObject({ error: { code: -3, message: invalid } });
    expect(queue.prompts()).toEqual([]);
  });
});

describe('signAuthEntry', () => {
  it('signs sha256 of the preimage and replies the signature in base64', async () => {
    const { ask, state } = sep60({ connected: true, policy: 'approve' });
    const authEntry = preimage(state.address);
    const { signedAuthEntry, signerAddress } = (await ask('signAuthEntry', {
      authEntry,
      opts: { address: state.address },
    })) as Signed;
    const signature = Buffer.from(String(signedAuthEntry), 'base64');
    expect(signature).toHaveLength(64);
    expect(signerAddress).toBe(state.address);
    expect(
      state.account.keypair.verify(
        sha256(Buffer.from(authEntry, 'base64')),
        signature,
      ),
    ).toBe(true);
  });

  it('checks the network inside the entry when the app sends none, as the SDK does', async () => {
    const { ask, state, queue, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('signAuthEntry', {
        authEntry: preimage(state.address, Networks.FUTURENET),
      }),
    ).resolves.toEqual({ error: declined });
    await ask('signAuthEntry', {
      authEntry: preimage(state.address, standalone),
    });
    await ask('signAuthEntry', {
      authEntry: preimage(state.address),
      opts: { networkPassphrase: Networks.FUTURENET },
    });
    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: null, blocked: 'networkMismatch' },
      { blocked: 'networkMismatch' },
      { networkPassphrase: Networks.FUTURENET, blocked: 'networkMismatch' },
    ]);
    expect(
      violations.list().map(({ detail }) => detail.split('\n')[0]),
    ).toEqual([
      `The app asked to sign for "${Networks.FUTURENET}",`,
      'The app asked to sign for an unknown network,',
      `The app asked to sign for "${Networks.FUTURENET}",`,
    ]);
  });

  it('records signerMismatch for an entry bound to another address', async () => {
    const { ask, main, violations } = sep60({
      connected: true,
      policy: 'approve',
    });
    const stranger = Keypair.random().publicKey();
    await ask('signAuthEntry', {
      authEntry: preimage(stranger, Networks.TESTNET, 'v2'),
      opts: { address: stranger },
    });
    expect(violations.list()).toMatchObject([
      {
        kind: 'signerMismatch',
        detail: expect.stringContaining(
          `but the wallet signs with ${main.address}.`,
        ),
      },
    ]);
  });

  it("answers XDR that isn't an auth preimage with -3 and no prompt", async () => {
    const { ask, queue, violations, main } = sep60({ connected: true });
    await expect(
      ask('signAuthEntry', { authEntry: payment(main.address) }),
    ).resolves.toEqual(failure(-3, invalid, ['Invalid auth entry XDR']));
    expect(queue.prompts()).toEqual([]);
    expect(violations.list()).toMatchObject([
      { kind: 'invalidXdr', detail: expect.stringMatching(/a preimage that/) },
    ]);
  });
});

describe('signMessage', () => {
  it('signs per SEP-53 and replies the signature in base64', async () => {
    const { ask, state, queue } = sep60();
    const reply = ask('signMessage', { message: 'Sign in to the test app' });
    await (await queue.nextPrompt('connect')).approve();
    const prompt = await queue.nextPrompt('signMessage');
    expect(prompt).toMatchObject({
      message: 'Sign in to the test app',
      networkPassphrase: null,
      blocked: null,
    });
    await prompt.approve();
    const { signedMessage, signerAddress } = (await reply) as Signed;
    const signature = Buffer.from(String(signedMessage), 'base64');
    expect(signature).toHaveLength(64);
    expect(signerAddress).toBe(state.address);
    expect(
      state.account.keypair.verify(
        sha256(Buffer.from('Stellar Signed Message:\nSign in to the test app')),
        signature,
      ),
    ).toBe(true);
  });

  it('compares networkPassphrase only when the app sends one', async () => {
    const { ask, queue } = sep60({ connected: true, policy: 'approve' });
    await ask('signMessage', { message: 'hi', opts: onTestnet });
    await ask('signMessage', {
      message: 'hi',
      opts: { networkPassphrase: Networks.FUTURENET },
    });
    expect(queue.prompts()).toMatchObject([
      { blocked: null, status: 'approved' },
      { blocked: 'networkMismatch', status: 'rejected' },
    ]);
  });
});

describe('requests and replies', () => {
  it.each([
    ['a method SEP-43 lacks', { method: 'addToken', contractId: 'C' }],
    ['a payload that is not an object', 'getAddress'],
    ['a non-string xdr', { method: 'signTransaction', xdr: 42 }],
    [
      'a non-boolean submit',
      { method: 'signTransaction', xdr: 'AAAA', opts: { submit: 'yes' } },
    ],
    ['a non-string message', { method: 'signMessage', message: null }],
  ])('answers %s with -3 and no prompt', async (_, payload) => {
    const { wallet, queue } = sep60();
    await expect(wallet.handle(site, payload)).resolves.toMatchObject({
      error: { code: -3, message: invalid, ext: [expect.any(String)] },
    });
    expect(queue.prompts()).toEqual([]);
  });

  it("never sends a field SEP-43 doesn't define", async () => {
    const { ask, main } = sep60({ connected: true, policy: 'approve' });
    const replies = [
      await ask('getAddress'),
      await ask('getNetwork'),
      await ask('signTransaction', { xdr: payment(main.address) }),
      await ask('signAuthEntry', { authEntry: preimage(main.address) }),
      await ask('signMessage', { message: 'hi' }),
    ];
    expect(replies.map((reply) => Object.keys(reply).sort())).toEqual([
      ['address'],
      ['network', 'networkPassphrase'],
      ['signedTxXdr', 'signerAddress'],
      ['signedAuthEntry', 'signerAddress'],
      ['signedMessage', 'signerAddress'],
    ]);
  });
});
