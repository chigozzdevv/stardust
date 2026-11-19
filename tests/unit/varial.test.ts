import {
  Asset,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { xlm } from '@/amounts';
import type { Account } from '@/funding/accounts';
import { Varial } from '@/protocols/varial/varial';
import { varialReplies, varialRequest } from '@/protocols/varial/schema';
import type { Policy } from '@/wallet/policy';
import { declined, internalError } from '@/wallet/prompts';
import type { WalletError } from '@/wallet/prompts';
import { Violations } from '@/wallet/strict';
import {
  FakeLedger,
  sacInstance,
  wasmInstance,
} from '@tests/fixtures/rpc/fake-ledger';
import {
  nativeSac,
  payment,
  preimage,
  sha256,
} from '@tests/fixtures/wallet/envelopes';
import { isPending, promptQueue } from '@tests/fixtures/wallet/prompt-queue';

interface BenchOptions {
  readonly policy?: Policy;
  readonly connected?: boolean;
  readonly allowHttp?: boolean;
  readonly send?: typeof fetch;
}

interface Signed {
  readonly signerAddress: string;
  readonly [field: string]: unknown;
}

type Signature = string | { type: 'Buffer'; data: number[] };

const site = 'https://app.test';
const localhost = 'http://localhost:5173';
const standalone = 'Standalone Network ; February 2017';
const plainToken = StrKey.encodeContract(Buffer.alloc(32, 7));
const usdc = new Asset('USDC', Keypair.random().publicKey());
const usdcSac = usdc.contractId(Networks.TESTNET);
const lockedText = 'The wallet is locked. Unlock Varial and try again.';

function varial({
  policy = 'manual',
  connected = false,
  allowHttp = true,
  send,
}: BenchOptions = {}) {
  const ledger = new FakeLedger();
  const { state, queue, landing, accounts } = promptQueue({
    policy,
    connected,
    send: send ?? ledger.fetch,
  });
  const violations = new Violations();
  const wallet = new Varial({ state, queue, landing, violations, allowHttp });
  const [main, other] = accounts as [Account, Account];
  const ask = (type: string, fields: object = {}, origin = site) =>
    wallet.handle(origin, { type, ...fields });
  return { state, queue, ledger, violations, wallet, main, other, ask };
}

function failure(error: WalletError) {
  return { apiError: error, error: error.message };
}

function signatureBytes(signature: Signature): Buffer {
  return typeof signature === 'string'
    ? Buffer.from(signature, 'base64')
    : Buffer.from(signature.data);
}

describe('answers from state', () => {
  it('reports the connection status, connected, locked or not', async () => {
    const { ask, state } = varial();
    await expect(ask('REQUEST_CONNECTION_STATUS')).resolves.toEqual({
      isConnected: true,
    });
    state.locked = true;
    await expect(ask('REQUEST_CONNECTION_STATUS')).resolves.toEqual({
      isConnected: true,
    });
  });

  it('shares the address only with a connected site, whatever its port', async () => {
    const { ask, state, other } = varial();
    await expect(ask('REQUEST_PUBLIC_KEY')).resolves.toEqual({ publicKey: '' });
    await expect(ask('REQUEST_USER_INFO')).resolves.toEqual({
      userInfo: { publicKey: '' },
    });
    await expect(ask('REQUEST_ALLOWED_STATUS')).resolves.toEqual({
      isAllowed: false,
    });

    state.connect('http://localhost:3000');
    await expect(ask('REQUEST_PUBLIC_KEY', {}, localhost)).resolves.toEqual({
      publicKey: state.address,
    });
    await expect(ask('REQUEST_USER_INFO', {}, localhost)).resolves.toEqual({
      userInfo: { publicKey: state.address },
    });
    await expect(ask('REQUEST_ALLOWED_STATUS', {}, localhost)).resolves.toEqual(
      { isAllowed: true },
    );

    state.switchAccount(other);
    await expect(ask('REQUEST_PUBLIC_KEY', {}, localhost)).resolves.toEqual({
      publicKey: '',
    });
  });

  it('hides the account while locked, even from a connected site', async () => {
    const { ask, state } = varial({ connected: true });
    state.locked = true;
    await expect(ask('REQUEST_PUBLIC_KEY')).resolves.toEqual({ publicKey: '' });
    await expect(ask('REQUEST_USER_INFO')).resolves.toEqual({
      userInfo: { publicKey: '' },
    });
    await expect(ask('REQUEST_ALLOWED_STATUS')).resolves.toEqual({
      isAllowed: false,
    });

    state.locked = false;
    await expect(ask('REQUEST_PUBLIC_KEY')).resolves.toEqual({
      publicKey: state.address,
    });
    await expect(ask('REQUEST_ALLOWED_STATUS')).resolves.toEqual({
      isAllowed: true,
    });
  });

  it("reports the network with Varial's details", async () => {
    const { ask, state } = varial();
    await expect(ask('REQUEST_NETWORK_DETAILS')).resolves.toEqual({
      networkDetails: {
        network: 'TESTNET',
        networkName: 'Test Net',
        networkUrl: 'https://horizon-testnet.stellar.org',
        networkPassphrase: Networks.TESTNET,
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org/',
        friendbotUrl: 'https://friendbot.stellar.org',
      },
    });
    await expect(ask('REQUEST_NETWORK')).resolves.toEqual({
      network: 'TESTNET',
    });

    state.switchNetwork('mainnet');
    await expect(ask('REQUEST_NETWORK_DETAILS')).resolves.toEqual({
      networkDetails: {
        network: 'PUBLIC',
        networkName: 'Main Net',
        networkUrl: 'https://horizon.stellar.org',
        networkPassphrase: Networks.PUBLIC,
        sorobanRpcUrl: 'http://stellar-rpc-pubnet-prd:8000',
      },
    });
    await expect(ask('REQUEST_NETWORK')).resolves.toEqual({
      network: 'PUBLIC',
    });
  });
});

describe('DISCONNECT', () => {
  it('removes the site for the active account and network', async () => {
    const { ask, state } = varial();
    state.connect(site);
    await expect(ask('DISCONNECT')).resolves.toEqual({});
    expect(state.isConnected(site)).toBe(false);
  });

  it('returns the Locked error while the wallet is locked', async () => {
    const { ask, state } = varial();
    state.connect(site);
    state.locked = true;
    await expect(ask('DISCONNECT')).resolves.toEqual({
      apiError: { code: -1, message: lockedText },
      error: lockedText,
    });
    expect(state.isConnected(site)).toBe(true);
  });
});

describe('connect prompts', () => {
  it('answers a connected site at once', async () => {
    const { ask, state, queue } = varial({ connected: true });
    await expect(ask('REQUEST_ACCESS')).resolves.toEqual({
      publicKey: state.address,
    });
    await expect(ask('SET_ALLOWED_STATUS')).resolves.toEqual({
      isAllowed: true,
    });
    expect(queue.prompts()).toEqual([]);
  });

  it.each([
    ['REQUEST_ACCESS', (address: string) => ({ publicKey: address })],
    ['SET_ALLOWED_STATUS', () => ({ isAllowed: true })],
  ])(
    'turns %s from a new site into a connect prompt',
    async (type, expected) => {
      const { ask, state, queue, other } = varial();
      const reply = ask(type);
      const prompt = await queue.nextPrompt('connect');
      expect(prompt).toMatchObject({
        id: 'p1',
        origin: site,
        networkPassphrase: null,
        blocked: null,
        status: 'pending',
      });
      expect(await isPending(reply)).toBe(true);

      await prompt.approve();
      await expect(reply).resolves.toEqual(expected(state.address));
      expect(state.isConnected('https://app.test:8443')).toBe(true);
      state.switchAccount(other);
      expect(state.isConnected(site)).toBe(false);
    },
  );

  it('replies Declined when the user rejects, and stays unconnected', async () => {
    const { ask, state } = varial({ policy: 'reject' });
    await expect(ask('REQUEST_ACCESS')).resolves.toEqual(failure(declined));
    await expect(ask('SET_ALLOWED_STATUS')).resolves.toEqual(failure(declined));
    expect(state.isConnected(site)).toBe(false);
  });

  it('replies the wallet error a test simulates', async () => {
    const { ask, queue } = varial();
    const reply = ask('REQUEST_ACCESS');
    await (await queue.nextPrompt()).fail({ code: -2 });
    await expect(reply).resolves.toEqual(
      failure({
        code: -2,
        message: 'Stardust: simulated wallet error (code -2)',
      }),
    );
  });

  it('never replies to a prompt that hangs', async () => {
    const { ask, queue } = varial();
    const reply = ask('REQUEST_ACCESS');
    (await queue.nextPrompt()).hang();
    expect(await isPending(reply)).toBe(true);
  });

  it('waits while the wallet is locked, under every policy', async () => {
    const { ask, state, queue } = varial({ policy: 'approve' });
    state.locked = true;
    const reply = ask('REQUEST_ACCESS');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      kind: 'connect',
      blocked: 'locked',
      status: 'pending',
    });
    expect(await isPending(reply)).toBe(true);

    state.locked = false;
    queue.resume();
    await expect(reply).resolves.toEqual({ publicKey: state.address });
  });

  it.each([
    ['REQUEST_ACCESS', (address: string) => ({ publicKey: address })],
    ['SET_ALLOWED_STATUS', () => ({ isAllowed: true })],
  ])(
    'turns %s from a connected site into a connect prompt while locked',
    async (type, expected) => {
      const { ask, state, queue } = varial({
        connected: true,
        policy: 'approve',
      });
      state.locked = true;
      const rejected = ask(type);
      const prompt = await queue.nextPrompt('connect');
      expect(prompt).toMatchObject({ blocked: 'locked', status: 'pending' });
      await prompt.reject();
      await expect(rejected).resolves.toEqual(failure(declined));

      const approved = ask(type);
      await queue.nextPrompt('connect');
      expect(await isPending(approved)).toBe(true);
      state.locked = false;
      queue.resume();
      await expect(approved).resolves.toEqual(expected(state.address));
      expect(state.isConnected(site)).toBe(true);
    },
  );

  it('takes the origin from the browser, never from the message', async () => {
    const { ask, state, queue } = varial({ policy: 'approve' });
    await ask('REQUEST_ACCESS', {
      origin: 'https://evil.test',
      url: 'https://evil.test/',
    });
    expect(queue.prompts()).toMatchObject([{ origin: site }]);
    expect(state.isConnected(site)).toBe(true);
    expect(state.isConnected('https://evil.test')).toBe(false);
  });
});

describe('SUBMIT_TRANSACTION', () => {
  it("signs the transaction for the wallet's network", async () => {
    const { ask, state, queue } = varial({ connected: true });
    const transactionXdr = payment(state.address);
    const reply = ask('SUBMIT_TRANSACTION', {
      transactionXdr,
      network: undefined,
      networkPassphrase: Networks.TESTNET,
      accountToSign: undefined,
    });
    const prompt = await queue.nextPrompt('signTransaction');
    expect(prompt).toMatchObject({
      origin: site,
      networkPassphrase: Networks.TESTNET,
      blocked: null,
      transaction: { xdr: transactionXdr, source: state.address },
    });
    await prompt.approve();

    const { signedTransaction, signerAddress } = (await reply) as Signed;
    const signed = TransactionBuilder.fromXDR(
      String(signedTransaction),
      Networks.TESTNET,
    );
    const [signature] = signed.signatures;
    expect(signerAddress).toBe(state.address);
    expect(signed.signatures).toHaveLength(1);
    expect(
      signature &&
        state.account.keypair.verify(signed.hash(), signature.signature),
    ).toBe(true);
  });

  it("blocks a transaction from a site that isn't connected", async () => {
    const { ask, state, queue } = varial();
    const reply = ask('SUBMIT_TRANSACTION', {
      transactionXdr: payment(state.address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await queue.nextPrompt('signTransaction');
    expect(prompt.blocked).toBe('notConnected');
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'PROMPT_BLOCKED',
    });
    await prompt.reject();
    await expect(reply).resolves.toEqual(failure(declined));
  });

  it('holds a transaction while the wallet is locked, then signs it', async () => {
    const { ask, state, queue } = varial({
      connected: true,
      policy: 'approve',
    });
    state.locked = true;
    const reply = ask('SUBMIT_TRANSACTION', {
      transactionXdr: payment(state.address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await queue.nextPrompt('signTransaction');
    expect(prompt).toMatchObject({ blocked: 'locked', status: 'pending' });
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'WALLET_LOCKED',
    });
    expect(await isPending(reply)).toBe(true);

    state.locked = false;
    queue.resume();
    await expect(reply).resolves.toMatchObject({
      signerAddress: state.address,
    });
  });

  it('reads a transaction without networkPassphrase as mainnet, as Varial does', async () => {
    const { ask, state, queue, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('SUBMIT_TRANSACTION', { transactionXdr: payment(state.address) }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toMatchObject([
      {
        networkPassphrase: null,
        blocked: 'networkMismatch',
        status: 'rejected',
      },
    ]);
    expect(violations.list()).toEqual([
      {
        promptId: 'p1',
        kind: 'missingNetworkPassphrase',
        detail: [
          'The app sent signTransaction without networkPassphrase, so Varial reads it as mainnet.',
          `Pass the passphrase of the wallet's network, "${Networks.TESTNET}".`,
        ].join('\n'),
      },
    ]);
  });

  it('blocks a transaction for another network', async () => {
    const { ask, state, queue, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    await expect(
      ask('SUBMIT_TRANSACTION', {
        transactionXdr: payment(state.address, Networks.FUTURENET),
        networkPassphrase: Networks.FUTURENET,
      }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toMatchObject([{ blocked: 'networkMismatch' }]);
    expect(violations.list()).toEqual([
      {
        promptId: 'p1',
        kind: 'networkMismatch',
        detail: [
          `The app asked to sign for "${Networks.FUTURENET}",`,
          `but the wallet is on "${Networks.TESTNET}".`,
          'Varial refuses this, so Stardust refused it too.',
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
      const { ask, state, queue } = varial({ connected: true, allowHttp });
      void ask(
        'SUBMIT_TRANSACTION',
        {
          transactionXdr: payment(state.address),
          networkPassphrase: Networks.TESTNET,
        },
        localhost,
      );
      void ask('SUBMIT_TRANSACTION', {
        transactionXdr: payment(state.address),
        networkPassphrase: Networks.TESTNET,
      });
      await expect(queue.nextPrompt()).resolves.toMatchObject({ blocked });
      await expect(queue.nextPrompt()).resolves.toMatchObject({
        blocked: null,
      });
    },
  );

  it('switches to the account the app names when the wallet holds it', async () => {
    const { ask, state, other, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    const reply = await ask('SUBMIT_TRANSACTION', {
      transactionXdr: payment(other.address),
      networkPassphrase: Networks.TESTNET,
      accountToSign: other.address,
    });
    expect(state.address).toBe(other.address);
    expect(reply).toMatchObject({ signerAddress: other.address });
    expect(violations.list()).toEqual([]);
  });

  it("signs with the active account and records signerMismatch for an account it doesn't hold", async () => {
    const { ask, main, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    const stranger = Keypair.random().publicKey();
    const reply = await ask('SUBMIT_TRANSACTION', {
      transactionXdr: payment(stranger),
      networkPassphrase: Networks.TESTNET,
      accountToSign: stranger,
    });
    expect(reply).toMatchObject({ signerAddress: main.address });
    expect(violations.list()).toEqual([
      {
        promptId: 'p1',
        kind: 'signerMismatch',
        detail: [
          `The app asked for a signature from ${stranger},`,
          `but the wallet signs with ${main.address}.`,
          'Use the address the wallet reports from getAddress().',
        ].join('\n'),
      },
    ]);
  });

  it("answers XDR that doesn't parse with the internal error and no prompt", async () => {
    const { ask, queue, violations } = varial({ connected: true });
    await expect(
      ask('SUBMIT_TRANSACTION', {
        transactionXdr: 'not a transaction',
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toEqual(failure(internalError));
    expect(queue.prompts()).toEqual([]);
    expect(violations.list()).toMatchObject([
      {
        promptId: null,
        kind: 'invalidXdr',
        detail: expect.stringMatching(/^The app sent a transactionXdr that/),
      },
    ]);
  });

  it('refuses to sign while the wallet is on mainnet', async () => {
    const { ask, state, queue } = varial({ policy: 'approve' });
    state.switchNetwork('mainnet');
    state.connect(site);
    const request = {
      transactionXdr: payment(state.address, Networks.PUBLIC),
      networkPassphrase: Networks.PUBLIC,
    };
    await expect(ask('SUBMIT_TRANSACTION', request)).resolves.toEqual(
      failure(declined),
    );
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      blocked: null,
      status: 'rejected',
    });

    queue.setPolicy('manual');
    void ask('SUBMIT_TRANSACTION', request);
    await expect(
      (await queue.nextPrompt('signTransaction')).approve(),
    ).rejects.toMatchObject({ code: 'MAINNET_REFUSED' });
  });
});

describe('SUBMIT_AUTH_ENTRY', () => {
  it.each([
    ['7.0.0', 'string'],
    ['4.2.0', 'string'],
    ['4.2.0-beta.0', 'Buffer'],
    ['4.1.0', 'Buffer'],
    [undefined, 'Buffer'],
  ])(
    'signs sha256 of the entry and encodes it for apiVersion %s as a %s',
    async (apiVersion, encoding) => {
      const { ask, state } = varial({ connected: true, policy: 'approve' });
      const entryXdr = preimage(state.address);
      const reply = await ask('SUBMIT_AUTH_ENTRY', {
        entryXdr,
        apiVersion,
        networkPassphrase: Networks.TESTNET,
        accountToSign: state.address,
      });
      const { signedAuthEntry, signerAddress } = reply as Signed;
      const signature = signedAuthEntry as Signature;

      expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
      expect(typeof signature === 'string' ? 'string' : signature.type).toBe(
        encoding,
      );
      expect(signerAddress).toBe(state.address);
      expect(
        state.account.keypair.verify(
          sha256(Buffer.from(entryXdr, 'base64')),
          signatureBytes(signature),
        ),
      ).toBe(true);
    },
  );

  it('compares the network inside the entry, not the one the app sent', async () => {
    const { ask, state, queue, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    const asTestnet = {
      apiVersion: '7.0.0',
      networkPassphrase: Networks.TESTNET,
    };
    await expect(
      ask('SUBMIT_AUTH_ENTRY', {
        entryXdr: preimage(state.address, Networks.FUTURENET),
        ...asTestnet,
      }),
    ).resolves.toEqual(failure(declined));
    await ask('SUBMIT_AUTH_ENTRY', {
      entryXdr: preimage(state.address, standalone),
      ...asTestnet,
    });

    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: Networks.TESTNET, blocked: 'networkMismatch' },
      { blocked: 'networkMismatch' },
    ]);
    expect(
      violations.list().map(({ detail }) => detail.split('\n')[0]),
    ).toEqual([
      `The app asked to sign for "${Networks.FUTURENET}",`,
      'The app asked to sign for an unknown network,',
    ]);
  });

  it('records signerMismatch for an entry bound to another address', async () => {
    const { ask, main, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    const stranger = Keypair.random().publicKey();
    await ask('SUBMIT_AUTH_ENTRY', {
      entryXdr: preimage(stranger, Networks.TESTNET, 'v2'),
      apiVersion: '7.0.0',
      networkPassphrase: Networks.TESTNET,
    });
    await ask('SUBMIT_AUTH_ENTRY', {
      entryXdr: preimage(stranger, Networks.TESTNET, 'v1'),
      apiVersion: '7.0.0',
      networkPassphrase: Networks.TESTNET,
    });
    expect(violations.list()).toEqual([
      expect.objectContaining({
        promptId: 'p1',
        kind: 'signerMismatch',
        detail: expect.stringContaining(
          `${stranger},\nbut the wallet signs with ${main.address}.`,
        ),
      }),
    ]);
  });

  it("blocks an entry from a site that isn't connected", async () => {
    const { ask, state, queue } = varial({ policy: 'approve' });
    await expect(
      ask('SUBMIT_AUTH_ENTRY', {
        entryXdr: preimage(state.address),
        apiVersion: '7.0.0',
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toMatchObject([{ blocked: 'notConnected' }]);
  });

  it("answers an entry that doesn't parse with Declined and no prompt", async () => {
    const { ask, state, queue, violations } = varial({ connected: true });
    await expect(
      ask('SUBMIT_AUTH_ENTRY', {
        entryXdr: payment(state.address),
        apiVersion: '7.0.0',
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toEqual([]);
    expect(violations.list()).toMatchObject([
      { promptId: null, kind: 'invalidXdr' },
    ]);
  });
});

describe('SUBMIT_BLOB', () => {
  const message = 'Sign in to the test app';
  const payload = sha256(
    Buffer.concat([
      Buffer.from('Stellar Signed Message:\n'),
      Buffer.from(message),
    ]),
  );

  it.each([
    ['7.0.0', 'string'],
    ['4.0.0', 'string'],
    ['3.1.0', 'Buffer'],
  ])(
    'signs the message per SEP-53 and encodes it for apiVersion %s as a %s',
    async (apiVersion, encoding) => {
      const { ask, state, queue } = varial({ connected: true });
      const reply = ask('SUBMIT_BLOB', {
        blob: message,
        apiVersion,
        networkPassphrase: Networks.TESTNET,
      });
      const prompt = await queue.nextPrompt('signMessage');
      expect(prompt).toMatchObject({ message, blocked: null });
      await prompt.approve();

      const { signedBlob, signerAddress } = (await reply) as Signed;
      const signature = signedBlob as Signature;
      expect(typeof signature === 'string' ? 'string' : signature.type).toBe(
        encoding,
      );
      expect(signerAddress).toBe(state.address);
      expect(
        state.account.keypair.verify(payload, signatureBytes(signature)),
      ).toBe(true);
    },
  );

  it('compares the network only when the app sends one', async () => {
    const { ask, queue, violations } = varial({
      connected: true,
      policy: 'approve',
    });
    await ask('SUBMIT_BLOB', { blob: message, apiVersion: '7.0.0' });
    await expect(
      ask('SUBMIT_BLOB', {
        blob: message,
        apiVersion: '7.0.0',
        networkPassphrase: Networks.FUTURENET,
      }),
    ).resolves.toEqual(failure(declined));

    expect(queue.prompts()).toMatchObject([
      { networkPassphrase: null, blocked: null, status: 'approved' },
      { blocked: 'networkMismatch', status: 'rejected' },
    ]);
    expect(violations.list()).toMatchObject([
      { promptId: 'p2', kind: 'networkMismatch' },
    ]);
  });

  it("blocks a message from a site that isn't connected", async () => {
    const { ask, queue } = varial({ policy: 'approve' });
    await expect(
      ask('SUBMIT_BLOB', { blob: message, apiVersion: '7.0.0' }),
    ).resolves.toEqual(failure(declined));
    expect(queue.prompts()).toMatchObject([{ blocked: 'notConnected' }]);
  });

  it("answers an apiVersion that isn't a version with the internal error", async () => {
    const { ask, queue } = varial({ connected: true });
    await expect(
      ask('SUBMIT_BLOB', { blob: message, apiVersion: 'latest' }),
    ).resolves.toEqual(failure(internalError));
    expect(queue.prompts()).toEqual([]);
  });
});

describe('SUBMIT_TOKEN', () => {
  const onTestnet = { networkPassphrase: Networks.TESTNET };

  it('adds a plain token without sending anything', async () => {
    const { ask, ledger, queue } = varial({ connected: true });
    ledger.store(wasmInstance(plainToken));
    const reply = ask('SUBMIT_TOKEN', { contractId: plainToken, ...onTestnet });
    const prompt = await queue.nextPrompt('addToken');
    expect(prompt).toMatchObject({
      contractId: plainToken,
      networkPassphrase: Networks.TESTNET,
      blocked: null,
    });
    await prompt.approve();
    await expect(reply).resolves.toEqual({ contractId: plainToken });
    expect(ledger.transactions).toEqual([]);
  });

  it('adds a trustline for a Stellar Asset Contract before replying', async () => {
    const { ask, ledger, state, queue } = varial({
      connected: true,
      policy: 'approve',
    });
    ledger.accounts.set(state.address, { balance: xlm('100'), sequence: 100n });
    ledger.store(sacInstance(usdcSac, usdc.toString()));
    const request = { contractId: usdcSac, ...onTestnet };

    await expect(ask('SUBMIT_TOKEN', request)).resolves.toEqual({
      contractId: usdcSac,
    });
    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0]?.source).toBe(state.address);
    expect(ledger.transactions[0]?.operations).toMatchObject([
      { type: 'changeTrust' },
    ]);

    await expect(ask('SUBMIT_TOKEN', request)).resolves.toEqual({
      apiError: declined,
    });
    expect(queue.prompts().map(({ blocked }) => blocked)).toEqual([
      null,
      'alreadyAdded',
    ]);
  });

  it('shows native XLM as already added', async () => {
    const { ask, ledger, queue } = varial({ connected: true });
    ledger.store(sacInstance(nativeSac, 'native'));
    const reply = ask('SUBMIT_TOKEN', { contractId: nativeSac, ...onTestnet });
    const prompt = await queue.nextPrompt('addToken');
    expect(prompt.blocked).toBe('alreadyAdded');
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'PROMPT_BLOCKED',
    });
    await prompt.reject();
    await expect(reply).resolves.toEqual({ apiError: declined });
  });

  it('reads a token without networkPassphrase as mainnet, without looking it up', async () => {
    const { ask, queue, violations } = varial({
      connected: true,
      policy: 'approve',
      send: () => Promise.reject(new TypeError('no lookups in this test')),
    });
    await expect(ask('SUBMIT_TOKEN', { contractId: usdcSac })).resolves.toEqual(
      { apiError: declined },
    );
    expect(queue.prompts()).toMatchObject([{ blocked: 'networkMismatch' }]);
    expect(violations.list()).toMatchObject([
      {
        promptId: 'p1',
        kind: 'missingNetworkPassphrase',
        detail: expect.stringMatching(/^The app sent addToken without/),
      },
    ]);
  });

  it('needs a connected site, as the Add button does', async () => {
    const { ask, ledger, queue } = varial({ policy: 'approve' });
    ledger.store(wasmInstance(plainToken));
    await expect(
      ask('SUBMIT_TOKEN', { contractId: plainToken, ...onTestnet }),
    ).resolves.toEqual({ apiError: declined });
    expect(queue.prompts()).toMatchObject([{ blocked: 'notConnected' }]);
  });

  it("answers a contract ID that isn't one with Declined and no prompt", async () => {
    const { ask, queue } = varial({ connected: true });
    await expect(
      ask('SUBMIT_TOKEN', { contractId: 'USDC', ...onTestnet }),
    ).resolves.toEqual({ apiError: declined });
    expect(queue.prompts()).toEqual([]);
  });

  it('answers the internal error when the token lookup fails', async () => {
    const { ask, queue } = varial({
      connected: true,
      send: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(
      ask('SUBMIT_TOKEN', { contractId: usdcSac, ...onTestnet }),
    ).resolves.toEqual({ apiError: internalError });
    expect(queue.prompts()).toEqual([]);
    expect(queue.errors()).toHaveLength(1);
  });

  it('replies Declined and fails approve() when the trustline fails', async () => {
    const { ask, ledger, queue } = varial({ connected: true });
    ledger.store(sacInstance(usdcSac, usdc.toString()));
    const reply = ask('SUBMIT_TOKEN', { contractId: usdcSac, ...onTestnet });
    const prompt = await queue.nextPrompt('addToken');
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(reply).resolves.toEqual({ apiError: declined });
  });

  it("replies nothing while the trustline's outcome is unknown", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { ask, ledger, state, queue } = varial({ connected: true });
      ledger.lands = false;
      ledger.accounts.set(state.address, {
        balance: xlm('100'),
        sequence: 100n,
      });
      ledger.store(sacInstance(usdcSac, usdc.toString()));
      const reply = ask('SUBMIT_TOKEN', { contractId: usdcSac, ...onTestnet });
      const prompt = await queue.nextPrompt('addToken');
      const approved = expect(prompt.approve()).rejects.toMatchObject({
        code: 'OUTCOME_UNKNOWN',
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await approved;
      expect(await isPending(reply)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('messages Varial drops', () => {
  it('never answers an unknown type and records unknownMessage', async () => {
    const { wallet, violations } = varial();
    await expect(
      wallet.handle(site, { type: 'REQUEST_EVERYTHING' }),
    ).resolves.toBeNull();
    await expect(wallet.handle(site, 'REQUEST_ACCESS')).resolves.toBeNull();
    expect(violations.list()).toEqual([
      {
        promptId: null,
        kind: 'unknownMessage',
        detail: [
          "The app sent a message of type 'REQUEST_EVERYTHING', which Varial doesn't recognize.",
          'Use a message type that @stellar/freighter-api or @stellar/varial-sdk sends.',
        ].join('\n'),
      },
      expect.objectContaining({
        detail: expect.stringContaining('of type undefined,'),
      }),
    ]);
  });

  it('answers a request with malformed fields with the internal error', async () => {
    const { ask, queue } = varial({ connected: true });
    await expect(
      ask('SUBMIT_TRANSACTION', { transactionXdr: 42 }),
    ).resolves.toEqual(failure(internalError));
    await expect(ask('SUBMIT_TOKEN', {})).resolves.toEqual({
      apiError: internalError,
    });
    expect(queue.prompts()).toEqual([]);
  });
});

describe('schemas', () => {
  it('reads empty optional fields as missing, like Varial', () => {
    expect(
      varialRequest.parse({
        type: 'SUBMIT_BLOB',
        blob: 'hello',
        apiVersion: '',
        networkPassphrase: '',
        accountToSign: null,
        source: 'FREIGHTER_EXTERNAL_MSG_REQUEST',
      }),
    ).toMatchObject({
      type: 'SUBMIT_BLOB',
      blob: 'hello',
      apiVersion: undefined,
      networkPassphrase: undefined,
      accountToSign: undefined,
    });
  });

  it("lets no field out that Varial doesn't reply with", () => {
    const address = Keypair.random().publicKey();
    const signed = { signedTransaction: 'AAAA', signerAddress: address };
    expect(varialReplies.SUBMIT_TRANSACTION.safeParse(signed).success).toBe(
      true,
    );
    expect(
      varialReplies.SUBMIT_TRANSACTION.safeParse({
        ...signed,
        secret: Keypair.random().secret(),
      }).success,
    ).toBe(false);
    expect(
      varialReplies.REQUEST_ACCESS.safeParse({
        apiError: declined,
        error: 'another text',
      }).success,
    ).toBe(false);
  });
});
