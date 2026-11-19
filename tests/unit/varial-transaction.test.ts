import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { declined, internalError } from '@/wallet/prompts';
import { payment } from '@tests/helpers/envelopes';
import { isPending } from '@tests/helpers/prompt-queue';
import { failure, localhost, site, varial } from '@tests/helpers/varial';
import type { Signed } from '@tests/helpers/varial';

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
