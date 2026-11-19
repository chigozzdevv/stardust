import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { declined } from '@/wallet/prompts';
import { payment } from '@tests/helpers/envelopes';
import { isPending } from '@tests/helpers/prompt-queue';
import {
  failure,
  invalid,
  onTestnet,
  sep60,
  site,
  verifies,
} from '@tests/helpers/sep60';
import type { Signed } from '@tests/helpers/sep60';

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
