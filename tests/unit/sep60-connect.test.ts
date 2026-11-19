import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { declined } from '@/wallet/prompts';
import { isPending } from '@tests/helpers/prompt-queue';
import { sep60, site } from '@tests/helpers/sep60';

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
