import { Script } from 'node:vm';
import { Networks } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { install, pageScript } from '@/protocols/page-script';
import type { PageScriptOptions } from '@/protocols/page-script';
import { providerInfo } from '@/protocols/sep60/sep60';
import { Varial } from '@/protocols/varial/varial';
import type { Policy } from '@/wallet/policy';
import { declined } from '@/wallet/prompts';
import { Violations } from '@/wallet/strict';
import { preimage, sha256 } from '@tests/fixtures/wallet/envelopes';
import { FakeWindow } from '@tests/fixtures/wallet/fake-page';
import { promptQueue, settled } from '@tests/fixtures/wallet/prompt-queue';

interface PageOptions {
  readonly policy?: Policy;
  readonly connected?: boolean;
}

interface Call {
  readonly origin: string;
  readonly payload: unknown;
}

const binding = '__stardust';
const request = 'FREIGHTER_EXTERNAL_MSG_REQUEST';
const response = 'FREIGHTER_EXTERNAL_MSG_RESPONSE';
const packages = [
  ['@stellar/freighter-api', '6.0.1'],
  ['@stellar/varial-sdk', '7.0.0'],
] as const;
const lockedError = {
  code: -1,
  message: 'The wallet is locked. Unlock Varial and try again.',
};
const internalError = {
  code: -1,
  message:
    'The wallet encountered an internal error. Please try again or contact the wallet if the problem persists.',
};

function page({ policy = 'manual', connected = false }: PageOptions = {}) {
  const { state, queue, landing, accounts } = promptQueue({
    policy,
    connected,
  });
  const violations = new Violations();
  const varial = new Varial({ state, queue, landing, violations });
  const window = new FakeWindow();
  const calls: Call[] = [];
  window.expose(binding, (origin, payload) => {
    calls.push({ origin, payload });
    return varial.handle(origin, payload);
  });
  window.run(pageScript({ wallet: 'varial', binding }));
  const types = () =>
    calls.map(({ payload }) => (payload as { type: string }).type);
  return { state, queue, violations, accounts, window, calls, types };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pageScript', () => {
  const scripts: readonly PageScriptOptions[] = [
    { wallet: 'varial', binding },
    { wallet: 'sep60', binding, info: providerInfo },
  ];

  it.each(scripts)(
    'serializes install with its $wallet options into one script that parses',
    (options) => {
      const source = pageScript(options);
      expect(source).toBe(
        `(${install.toString()})(${JSON.stringify(options)});`,
      );
      expect(() => new Script(source)).not.toThrow();
    },
  );

  it.each(scripts)(
    'runs the $wallet script with window as its only global',
    (options) => {
      const window = new FakeWindow();
      expect(() => window.run(pageScript(options))).not.toThrow();
    },
  );

  it('carries no secret key', () => {
    const { accounts } = promptQueue();
    for (const options of scripts) {
      const source = pageScript(options);
      expect(source).not.toMatch(/S[A-Z2-7]{55}/);
      for (const { keypair } of accounts) {
        const seed = Buffer.from(keypair.rawSecretKey());
        expect(source).not.toContain(keypair.secret());
        expect(source).not.toContain(seed.toString('hex'));
        expect(source).not.toContain(seed.toString('base64'));
      }
    }
  });
});

describe("'varial' in the page", () => {
  it('sets window.freighter, so isConnected() sends nothing', async () => {
    const { window, calls } = page();
    expect(window.freighter).toBe(true);
    const api = window.load('@stellar/freighter-api');
    await expect(api.isConnected()).resolves.toEqual({ isConnected: true });
    expect(calls).toEqual([]);
    expect(window.posted).toEqual([]);
  });

  it('forwards { type, ...fields } with the frame origin and posts the reply as messagedId', async () => {
    const { window, calls } = page();
    window.postMessage(
      {
        source: request,
        messageId: 42.5,
        type: 'REQUEST_PUBLIC_KEY',
        origin: 'https://evil.test',
      },
      'https://app.test',
    );
    await settled();
    expect(calls).toEqual([
      {
        origin: 'https://app.test',
        payload: { type: 'REQUEST_PUBLIC_KEY', origin: 'https://evil.test' },
      },
    ]);
    expect(window.posted[1]).toEqual({
      data: { source: response, messagedId: 42.5, publicKey: '' },
      targetOrigin: 'https://app.test',
    });
  });

  it('answers only messages from its own window', async () => {
    const { window, calls } = page();
    const message = { source: request, messageId: 1, type: 'REQUEST_NETWORK' };
    window.receive(message, new FakeWindow());
    window.receive({ ...message, source: response }, window);
    window.receive('REQUEST_NETWORK', window);
    await settled();
    expect(calls).toEqual([]);

    window.receive(message, window);
    await settled();
    expect(calls).toHaveLength(1);
  });

  it("stays out of frames other than the top one, as Varial's content script does", async () => {
    const frame = new FakeWindow('https://widget.test/', new FakeWindow());
    const calls: unknown[] = [];
    frame.expose(binding, async (_origin, payload) => {
      calls.push(payload);
      return { publicKey: '' };
    });
    frame.run(pageScript({ wallet: 'varial', binding }));
    expect('freighter' in frame).toBe(false);

    frame.postMessage(
      { source: request, messageId: 1, type: 'REQUEST_PUBLIC_KEY' },
      'https://widget.test',
    );
    await settled();
    expect(calls).toEqual([]);
    expect(frame.posted).toHaveLength(1);
  });

  it.each(packages)(
    'lets %s connect first, then sign an auth entry',
    async (name, apiVersion) => {
      const { window, queue, state, types } = page();
      const api = window.load(name);
      const entry = preimage(state.address);
      const signed = api.signAuthEntry(entry, {
        networkPassphrase: Networks.TESTNET,
      });

      await (await queue.nextPrompt('connect')).approve();
      const prompt = await queue.nextPrompt('signAuthEntry');
      expect(prompt.origin).toBe('https://app.test');
      await prompt.approve();

      const { signedAuthEntry, signerAddress } = await signed;
      expect(types()).toEqual([
        'REQUEST_ALLOWED_STATUS',
        'REQUEST_ACCESS',
        'SUBMIT_AUTH_ENTRY',
      ]);
      expect(window.posted).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ apiVersion }),
        }),
      );
      expect(signerAddress).toBe(state.address);
      expect(
        state.account.keypair.verify(
          sha256(Buffer.from(entry, 'base64')),
          Buffer.from(String(signedAuthEntry), 'base64'),
        ),
      ).toBe(true);
    },
  );

  it('passes on a rejected connection as the error the package returns', async () => {
    const { window, state, queue, types } = page({ policy: 'reject' });
    const api = window.load('@stellar/varial-sdk');
    await expect(
      api.signMessage('Sign in', { networkPassphrase: Networks.TESTNET }),
    ).resolves.toEqual({
      signedMessage: null,
      signerAddress: '',
      error: declined,
    });
    expect(types()).toEqual(['REQUEST_ALLOWED_STATUS', 'REQUEST_ACCESS']);
    expect(queue.prompts()).toMatchObject([{ kind: 'connect' }]);
    expect(state.isConnected('https://app.test')).toBe(false);
  });

  it("answers getAddress well inside the package's 2 s timeout", async () => {
    vi.useFakeTimers();
    const { window, state } = page({ connected: true });
    const api = window.load('@stellar/freighter-api');
    await expect(api.getAddress()).resolves.toEqual({
      address: state.address,
    });
  });

  it("leaves isConnected and getAddress to the package's 2 s timeout without a wallet", async () => {
    vi.useFakeTimers();
    const window = new FakeWindow();
    const api = window.load('@stellar/freighter-api');
    const status = api.isConnected();
    const address = api.getAddress();
    let answered = false;
    void status.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(status).resolves.toMatchObject({ isConnected: false });
    await expect(address).resolves.toMatchObject({ address: '' });
  });

  it('disconnects through varial-sdk, and returns the Locked error while locked', async () => {
    const { window, state } = page({ connected: true });
    const api = window.load('@stellar/varial-sdk');
    state.locked = true;
    await expect(api.disconnect()).resolves.toEqual({ error: lockedError });
    expect(state.isConnected('https://app.test')).toBe(true);

    state.locked = false;
    await expect(api.disconnect()).resolves.toEqual({});
    expect(state.isConnected('https://app.test')).toBe(false);
  });

  it("leaves DISCONNECT to the package's 2 s timeout without a wallet", async () => {
    vi.useFakeTimers();
    const api = new FakeWindow().load('@stellar/varial-sdk');
    const disconnected = api.disconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(disconnected).resolves.toEqual({ error: internalError });
  });

  it('posts nothing for an unknown type or a prompt that hangs', async () => {
    const { window, violations, queue } = page();
    window.postMessage(
      { source: request, messageId: 1, type: 'REQUEST_SECRET_KEY' },
      'https://app.test',
    );
    window.postMessage(
      { source: request, messageId: 2, type: 'REQUEST_ACCESS' },
      'https://app.test',
    );
    (await queue.nextPrompt('connect')).hang();
    await settled();
    expect(window.posted.map(({ data }) => data)).toEqual([
      expect.objectContaining({ source: request, messageId: 1 }),
      expect.objectContaining({ source: request, messageId: 2 }),
    ]);
    expect(violations.list()).toMatchObject([{ kind: 'unknownMessage' }]);
  });

  it('never writes the Wallets Kit session and never sets window.stellar', async () => {
    const { window } = page({ policy: 'approve' });
    const api = window.load('@stellar/freighter-api');
    await expect(api.requestAccess()).resolves.toMatchObject({
      address: expect.stringMatching(/^G/),
    });
    expect(window.storage.size).toBe(0);
    expect('stellar' in window).toBe(false);
  });
});
