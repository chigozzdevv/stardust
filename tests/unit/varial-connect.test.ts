import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { declined } from '@/wallet/prompts';
import { isPending } from '@tests/helpers/prompt-queue';
import { failure, localhost, site, varial } from '@tests/helpers/varial';

const lockedText = 'The wallet is locked. Unlock Varial and try again.';

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
