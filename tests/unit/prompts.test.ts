import { describe, expect, it } from 'vitest';
import { declined, internalError } from '@/wallet/prompts';
import type { BlockedReason, PromptKind } from '@/wallet/prompts';
import {
  deferred,
  fields,
  kinds,
  promptQueue,
  settled,
} from '@tests/helpers/prompt-queue';
import { answer, recording, replay } from '@tests/helpers/replay';

const signing = kinds.filter((kind) => kind !== 'connect');

describe('prompts', () => {
  it('numbers prompts p1, p2, … in arrival order and carries what the app sent', async () => {
    const { queue, arrive } = promptQueue();
    expect(arrive('connect')).toEqual({ id: 'p1', kind: 'connect' });
    expect(
      arrive('signMessage', {
        origin: 'https://app.example',
        networkPassphrase: null,
      }),
    ).toEqual({ id: 'p2', kind: 'signMessage' });

    await expect(queue.nextPrompt('signMessage')).resolves.toMatchObject({
      id: 'p2',
      kind: 'signMessage',
      origin: 'https://app.example',
      networkPassphrase: null,
      status: 'pending',
      blocked: null,
      message: fields.signMessage.message,
    });
  });

  it('exposes the decoded fields of each kind, and landed() only where something lands', async () => {
    const { queue, arrive } = promptQueue();
    for (const kind of kinds) arrive(kind);
    const [connect, transaction, authEntry, message, token] = await Promise.all(
      kinds.map((kind) => queue.nextPrompt(kind)),
    );

    expect(connect).not.toHaveProperty('landed');
    expect(transaction).toMatchObject(fields.signTransaction);
    expect(transaction).toHaveProperty('landed', expect.any(Function));
    expect(authEntry).toMatchObject(fields.signAuthEntry);
    expect(authEntry).toHaveProperty('landed', expect.any(Function));
    expect(message).toMatchObject(fields.signMessage);
    expect(message).not.toHaveProperty('landed');
    expect(token).toMatchObject(fields.addToken);
    expect(Object.isFrozen(token)).toBe(true);
  });

  it('resolves approve() once the reply has reached the page', async () => {
    const { queue, arrive } = promptQueue();
    const delivery = deferred();
    let delivered = false;
    arrive('signTransaction', {
      reply: {
        approve: async () => {
          await delivery.promise;
          delivered = true;
        },
        error: async () => {},
      },
    });
    const prompt = await queue.nextPrompt('signTransaction');

    let resolved = false;
    const approving = prompt.approve().then(() => {
      resolved = true;
    });
    await settled();
    expect(prompt.status).toBe('approved');
    expect(resolved).toBe(false);

    delivery.resolve();
    await approving;
    expect(delivered).toBe(true);
  });

  it('rejects with -4 and the text Varial uses', async () => {
    const { queue, arrive, replies } = promptQueue();
    arrive('connect');
    const prompt = await queue.nextPrompt();
    await prompt.reject();
    expect(prompt.status).toBe('rejected');
    expect(replies).toEqual([
      {
        prompt: 'p1',
        reply: { code: -4, message: 'The user rejected this request.' },
      },
    ]);
    expect(declined).toEqual({
      code: -4,
      message: 'The user rejected this request.',
    });
  });

  it('fails with wallet errors -1, -2 and -3 and their default messages', async () => {
    const { queue, arrive, replies } = promptQueue();
    for (let n = 0; n < 4; n += 1) arrive('signMessage');
    await settled();
    const [internal, external, invalid, custom] = queue.prompts();

    await internal?.fail({ code: -1 });
    await external?.fail({ code: -2 });
    await invalid?.fail({ code: -3 });
    await custom?.fail({ code: -3, message: 'Bad request from the app' });

    expect(internal?.status).toBe('failed');
    expect(replies.map(({ reply }) => reply)).toEqual([
      {
        code: -1,
        message:
          'The wallet encountered an internal error. Please try again or contact the wallet if the problem persists.',
      },
      { code: -2, message: 'Stardust: simulated wallet error (code -2)' },
      { code: -3, message: 'Stardust: simulated wallet error (code -3)' },
      { code: -3, message: 'Bad request from the app' },
    ]);
    expect(internalError.code).toBe(-1);
  });

  it('never replies to a prompt that hangs', async () => {
    const { queue, arrive, replies } = promptQueue();
    arrive('signTransaction');
    const prompt = await queue.nextPrompt();
    prompt.hang();
    await settled();
    expect(prompt.status).toBe('hung');
    expect(replies).toEqual([]);
  });

  it('throws ALREADY_ANSWERED on a second answer', async () => {
    const { queue, arrive, replies } = promptQueue();
    arrive('signTransaction');
    arrive('signMessage');
    const first = await queue.nextPrompt();
    const second = await queue.nextPrompt();

    await first.approve();
    const message =
      "p1 signTransaction is already answered (approved). Every prompt is answered once, by the test or by the policy; use policy 'manual' to answer it in the test.";
    await expect(first.approve()).rejects.toMatchObject({
      code: 'ALREADY_ANSWERED',
      message,
    });
    await expect(first.reject()).rejects.toMatchObject({
      code: 'ALREADY_ANSWERED',
    });
    await expect(first.fail({ code: -1 })).rejects.toMatchObject({
      code: 'ALREADY_ANSWERED',
    });
    expect(() => first.hang()).toThrow(
      expect.objectContaining({ code: 'ALREADY_ANSWERED' }),
    );

    second.hang();
    await expect(second.reject()).rejects.toMatchObject({
      code: 'ALREADY_ANSWERED',
      message: expect.stringContaining('already answered (hung)'),
    });
    expect(replies).toEqual([{ prompt: 'p1', reply: 'approved' }]);
  });
});

describe('blocked prompts', () => {
  const reasons: readonly [Exclude<BlockedReason, 'locked'>, string][] = [
    [
      'notConnected',
      "http://localhost:3000 isn't connected to the wallet. Have the app connect first, use connected: true, or answer it with reject().",
    ],
    [
      'networkMismatch',
      `the app asked for a different network than the wallet's ("Test SDF Network ; September 2015"). Use the wallet's network in the app, or answer it with reject().`,
    ],
    [
      'insecureOrigin',
      "http://localhost:3000 isn't an https page and allowHttp is false. Serve the app over https, use allowHttp: true, or answer it with reject().",
    ],
    [
      'alreadyAdded',
      'the wallet shows "This token already has a trustline added." with Add disabled, so the user can only close it. Answer it with reject().',
    ],
  ];

  it.each(reasons)(
    'refuses approve() with PROMPT_BLOCKED for %s, and still lets the test reject',
    async (reason, explanation) => {
      const { queue, arrive, replies } = promptQueue();
      arrive('addToken', { blocked: reason });
      const prompt = await queue.nextPrompt();
      expect(prompt.blocked).toBe(reason);

      await expect(prompt.approve()).rejects.toMatchObject({
        code: 'PROMPT_BLOCKED',
        message: `p1 addToken is blocked (${reason}): ${explanation}`,
      });
      expect(prompt.status).toBe('pending');

      await prompt.reject();
      expect(prompt.status).toBe('rejected');
      expect(prompt.blocked).toBe(reason);
      expect(replies).toEqual([{ prompt: 'p1', reply: declined }]);
    },
  );

  it('reports locked while the wallet is locked and refuses approve() with WALLET_LOCKED', async () => {
    const { queue, arrive, state, replies } = promptQueue();
    arrive('signTransaction', { blocked: 'notConnected' });
    const earlier = await queue.nextPrompt();
    state.locked = true;
    arrive('connect');
    const later = await queue.nextPrompt();

    expect(earlier.blocked).toBe('locked');
    expect(later.blocked).toBe('locked');
    await expect(later.approve()).rejects.toMatchObject({
      code: 'WALLET_LOCKED',
      message:
        "the wallet is locked, so p2 connect can't be approved. Call wallet.unlock() first, or answer it with reject().",
    });

    state.locked = false;
    expect(earlier.blocked).toBe('notConnected');
    expect(later.blocked).toBeNull();
    await later.approve();
    expect(replies).toEqual([{ prompt: 'p2', reply: 'approved' }]);
  });

  it('keeps the reason a prompt had when it was answered', async () => {
    const { queue, arrive, state } = promptQueue();
    state.locked = true;
    arrive('signMessage');
    const prompt = await queue.nextPrompt();
    await prompt.reject();
    state.locked = false;
    expect(prompt.blocked).toBe('locked');
  });
});

describe('mainnet', () => {
  it.each(signing)(
    'refuses approve() on %s with MAINNET_REFUSED after switchNetwork("mainnet")',
    async (kind: PromptKind) => {
      const { queue, arrive, state, replies } = promptQueue();
      state.switchNetwork('mainnet');
      arrive(kind);
      const prompt = await queue.nextPrompt();
      await expect(prompt.approve()).rejects.toMatchObject({
        code: 'MAINNET_REFUSED',
        message: `refused: the wallet is on mainnet, so p1 ${kind} can't be approved. Stardust never signs for mainnet. Switch back with wallet.switchNetwork('testnet'), or answer it with reject().`,
      });
      expect(prompt.status).toBe('pending');
      await prompt.reject();
      expect(replies).toEqual([{ prompt: 'p1', reply: declined }]);
    },
  );

  it('still approves connect, which only shares the address', async () => {
    const { queue, arrive, state, replies } = promptQueue();
    state.switchNetwork('mainnet');
    arrive('connect');
    await (await queue.nextPrompt()).approve();
    expect(replies).toEqual([{ prompt: 'p1', reply: 'approved' }]);
  });

  it('refuses a prompt that arrived on testnet once the wallet is on mainnet', async () => {
    const { queue, arrive, state } = promptQueue();
    arrive('signTransaction');
    const prompt = await queue.nextPrompt();
    state.switchNetwork('mainnet');
    await expect(prompt.approve()).rejects.toMatchObject({
      code: 'MAINNET_REFUSED',
    });
  });
});

describe('landed()', () => {
  const pages = recording('auth-scan');
  const signer = 'CDA3Y7I3BLJVY35MT3IO6KJXYXQSWXPEXOGB3JAL4MMEIMK27GYCN5H4';

  it('waits for an approved transaction to land', async () => {
    const { queue, arrive } = promptQueue({
      send: replay(...recording('classic-payment')),
    });
    arrive('signTransaction');
    const prompt = await queue.nextPrompt('signTransaction');
    await prompt.approve();
    await expect(prompt.landed()).resolves.toMatchObject({
      status: 'success',
      hash: fields.signTransaction.transaction.hash,
      ledger: 5800305,
    });
  });

  it('waits for a pending prompt to be approved within the same timeout', async () => {
    const { queue, arrive } = promptQueue({
      send: replay(...recording('classic-payment')),
    });
    arrive('signTransaction');
    const prompt = await queue.nextPrompt('signTransaction');
    const landing = prompt.landed();
    await settled();
    await prompt.approve();
    await expect(landing).resolves.toMatchObject({ status: 'success' });
  });

  it('throws OUTCOME_UNKNOWN when the prompt is still pending at the timeout', async () => {
    const { queue, arrive } = promptQueue();
    arrive('signTransaction');
    const prompt = await queue.nextPrompt('signTransaction');
    await expect(prompt.landed({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message:
        'p1 signTransaction is still pending after 0.02s, so nothing was signed. Answer it before waiting for it to land, or pass a longer timeoutMs.',
    });
  });

  it.each(['rejected', 'failed', 'hung'] as const)(
    'fails at once on a %s prompt',
    async (status) => {
      const { queue, arrive } = promptQueue();
      arrive('signTransaction');
      const prompt = await queue.nextPrompt('signTransaction');
      if (status === 'rejected') await prompt.reject();
      if (status === 'failed') await prompt.fail({ code: -1 });
      if (status === 'hung') prompt.hang();
      await expect(prompt.landed()).rejects.toMatchObject({
        code: 'UNSUPPORTED',
        message: `p1 signTransaction is ${status}, so nothing was signed and there's nothing to wait for. Call landed() only on approved prompts.`,
      });
    },
  );

  it('fails when the prompt is answered with something other than approve() while waiting', async () => {
    const { queue, arrive } = promptQueue();
    arrive('signTransaction');
    const prompt = await queue.nextPrompt('signTransaction');
    const landing = prompt.landed();
    await prompt.reject();
    await expect(landing).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it("passes the caller's abort reason through", async () => {
    const { queue, arrive } = promptQueue();
    arrive('signTransaction');
    const prompt = await queue.nextPrompt('signTransaction');
    const reason = new Error('test ended');
    await expect(
      prompt.landed({ signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  it('scans for an auth entry from the ledger where the prompt was approved', async () => {
    const requests: unknown[] = [];
    const found = pages.at(-1)?.result;
    const { queue, arrive } = promptQueue({
      send: answer(({ method, params }) => {
        requests.push({ method, params });
        return method === 'getLatestLedger'
          ? { sequence: 5_802_974, protocolVersion: 30 }
          : found;
      }),
    });
    arrive('signAuthEntry', { signer });
    const prompt = await queue.nextPrompt('signAuthEntry');
    await prompt.approve();

    await expect(prompt.landed()).resolves.toMatchObject({
      status: 'success',
      hash: '0a3741fa1f4bb5384cee379e3f0736c24f864be6270420fe35010321ce06bcdd',
    });
    expect(requests).toEqual([
      { method: 'getLatestLedger' },
      {
        method: 'getTransactions',
        params: { startLedger: 5_802_974, pagination: { limit: 50 } },
      },
    ]);
  });
});
