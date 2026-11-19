import { describe, expect, it, vi } from 'vitest';
import { automatic } from '@/wallet/policy';
import type { Policy } from '@/wallet/policy';
import { declined } from '@/wallet/prompts';
import type { BlockedReason, Decision, Prompt } from '@/wallet/prompts';
import { PromptQueue } from '@/wallet/queue';
import {
  deferred,
  kinds,
  promptQueue,
  settled,
} from '@tests/helpers/prompt-queue';

const signing = kinds.filter((kind) => kind !== 'connect');
const reasons: readonly Exclude<BlockedReason, 'locked'>[] = [
  'notConnected',
  'networkMismatch',
  'insecureOrigin',
  'alreadyAdded',
];

async function answers(policy: Policy) {
  const bench = promptQueue({ policy });
  for (const kind of kinds) bench.arrive(kind);
  await Promise.all(kinds.map(() => bench.queue.nextPrompt()));
  return bench;
}

describe('policies', () => {
  it("approves every prompt as it arrives under 'approve'", async () => {
    const { queue, replies } = await answers('approve');
    expect(queue.prompts().map(({ status }) => status)).toEqual(
      kinds.map(() => 'approved'),
    );
    expect(replies).toHaveLength(kinds.length);
    expect(replies.every(({ reply }) => reply === 'approved')).toBe(true);
  });

  it('approves by default', async () => {
    const { state, landing, input } = promptQueue();
    const queue = new PromptQueue({ state, landing });
    queue.add(input('connect'));
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      status: 'approved',
    });
  });

  it("rejects every prompt as it arrives under 'reject', including connect", async () => {
    const { queue, replies } = await answers('reject');
    expect(queue.prompts().map(({ status }) => status)).toEqual(
      kinds.map(() => 'rejected'),
    );
    expect(replies.map(({ reply }) => reply)).toEqual(
      kinds.map(() => declined),
    );
  });

  it("leaves prompts for the test under 'manual'", async () => {
    const { queue, replies } = await answers('manual');
    expect(queue.prompts().map(({ status }) => status)).toEqual(
      kinds.map(() => 'pending'),
    );
    expect(replies).toEqual([]);
  });

  it("uses a mode per kind, and 'approve' for kinds left out", async () => {
    const { queue } = await answers({
      signTransaction: 'manual',
      signMessage: 'reject',
    });
    expect(
      Object.fromEntries(queue.prompts().map((p) => [p.kind, p.status])),
    ).toEqual({
      connect: 'approved',
      signTransaction: 'pending',
      signAuthEntry: 'approved',
      signMessage: 'rejected',
      addToken: 'approved',
    });
  });

  it('asks a function about each decoded prompt and applies its decision', async () => {
    const decisions: Record<string, Decision> = {
      connect: { action: 'approve' },
      signTransaction: { action: 'reject' },
      signAuthEntry: { action: 'fail', code: -2 },
      signMessage: { action: 'fail', code: -3, message: 'No messages today' },
      addToken: { action: 'hang' },
    };
    const asked: Prompt[] = [];
    const { queue, replies } = await answers(async (prompt) => {
      asked.push(prompt);
      await settled();
      return decisions[prompt.kind] ?? { action: 'hang' };
    });

    expect(asked.map(({ kind }) => kind)).toEqual(kinds);
    expect(asked[3]).toMatchObject({ message: 'Sign in to the test app' });
    expect(queue.prompts().map(({ status }) => status)).toEqual([
      'approved',
      'rejected',
      'failed',
      'failed',
      'hung',
    ]);
    expect(replies.map(({ reply }) => reply)).toEqual([
      'approved',
      declined,
      { code: -2, message: 'Stardust: simulated wallet error (code -2)' },
      { code: -3, message: 'No messages today' },
    ]);
  });

  it('returns the prompt from nextPrompt once the function has decided', async () => {
    const decision = deferred<Decision>();
    const { queue, arrive } = promptQueue({ policy: () => decision.promise });
    arrive('connect');
    const next = queue.nextPrompt();
    await settled();
    expect(queue.prompts()).toHaveLength(1);
    decision.resolve({ action: 'approve' });
    await expect(next).resolves.toMatchObject({ status: 'approved' });
  });

  it('keeps the prompt pending and the error when a function returns no decision', async () => {
    const { queue, arrive } = promptQueue({
      policy: (() => 'approve') as unknown as Policy,
    });
    arrive('signMessage');
    const prompt = await queue.nextPrompt();
    expect(prompt.status).toBe('pending');
    expect(queue.errors()).toEqual([
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message:
          "the policy function returned 'approve' for p1 signMessage. Return { action: 'approve' }, { action: 'reject' }, { action: 'fail', code: -1 | -2 | -3 } or { action: 'hang' }.",
      }),
    ]);
  });

  it('keeps the prompt pending and the error when a function throws', async () => {
    const failure = new Error('policy broke');
    const { queue, arrive } = promptQueue({
      policy: () => {
        throw failure;
      },
    });
    arrive('connect');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      status: 'pending',
    });
    expect(queue.errors()).toEqual([failure]);
  });

  it('keeps the prompt pending and the error for an unknown mode', async () => {
    const { queue, arrive } = promptQueue({
      policy: { connect: 'yes' } as unknown as Policy,
    });
    arrive('connect');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      status: 'pending',
    });
    expect(queue.errors()).toEqual([
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message:
          "the policy for connect is 'yes'. Use 'approve', 'reject' or 'manual'.",
      }),
    ]);
  });

  it('applies setPolicy to prompts that arrive afterwards', async () => {
    const { queue, arrive } = promptQueue({ policy: 'manual' });
    arrive('signTransaction');
    const waiting = await queue.nextPrompt();
    queue.setPolicy('reject');
    arrive('signTransaction');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(waiting.status).toBe('pending');
  });
});

describe('blocked prompts answered automatically', () => {
  it.each(reasons)("answers -4 under 'approve' for %s", async (blocked) => {
    const { queue, arrive, replies } = promptQueue({ policy: 'approve' });
    arrive('addToken', { blocked });
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      status: 'rejected',
      blocked,
    });
    expect(replies).toEqual([{ prompt: 'p1', reply: declined }]);
  });

  it('answers -4 when a per-kind mode or a function approves', async () => {
    for (const policy of [
      { signTransaction: 'approve' },
      () => ({ action: 'approve' }),
    ] as const satisfies readonly Policy[]) {
      const { queue, arrive, replies } = promptQueue({ policy });
      arrive('signTransaction', { blocked: 'notConnected' });
      await expect(queue.nextPrompt()).resolves.toMatchObject({
        status: 'rejected',
      });
      expect(replies).toEqual([{ prompt: 'p1', reply: declined }]);
    }
  });
});

describe('locked wallet', () => {
  it.each(['approve', 'reject'] as const)(
    "keeps prompts waiting under '%s' until unlock",
    async (policy) => {
      const { queue, arrive, state, replies } = promptQueue({ policy });
      state.locked = true;
      arrive('signTransaction');
      arrive('connect');
      const prompt = await queue.nextPrompt();
      expect(prompt).toMatchObject({ status: 'pending', blocked: 'locked' });
      expect(replies).toEqual([]);

      state.locked = false;
      queue.resume();
      await settled();
      const status = policy === 'approve' ? 'approved' : 'rejected';
      expect(queue.prompts().map((p) => p.status)).toEqual([status, status]);
    },
  );

  it('asks a function about a locked prompt only after unlock', async () => {
    const decide = vi.fn((): Decision => ({ action: 'approve' }));
    const { queue, arrive, state } = promptQueue({ policy: decide });
    state.locked = true;
    arrive('signAuthEntry');
    const prompt = await queue.nextPrompt();
    expect(decide).not.toHaveBeenCalled();

    state.locked = false;
    queue.resume();
    await settled();
    expect(decide).toHaveBeenCalledWith(prompt);
    expect(prompt.status).toBe('approved');
  });

  it('lets the test reject a locked prompt', async () => {
    const { queue, arrive, state, replies } = promptQueue({
      policy: 'approve',
    });
    state.locked = true;
    arrive('signMessage');
    await (await queue.nextPrompt()).reject();
    state.locked = false;
    queue.resume();
    await settled();
    expect(replies).toEqual([{ prompt: 'p1', reply: declined }]);
  });

  it('uses the policy in force at unlock', async () => {
    const { queue, arrive, state } = promptQueue({ policy: 'approve' });
    state.locked = true;
    arrive('signMessage');
    const prompt = await queue.nextPrompt();
    queue.setPolicy('reject');
    state.locked = false;
    queue.resume();
    await settled();
    expect(prompt.status).toBe('rejected');
  });

  it('asks again at unlock when the wallet locked while a function was deciding', async () => {
    const first = deferred<Decision>();
    const decide = vi
      .fn<(prompt: Prompt) => Promise<Decision>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ action: 'approve' });
    const { queue, arrive, state } = promptQueue({ policy: decide });
    arrive('signTransaction');
    await settled();
    state.locked = true;
    first.resolve({ action: 'approve' });
    const prompt = await queue.nextPrompt();
    expect(prompt).toMatchObject({ status: 'pending', blocked: 'locked' });

    state.locked = false;
    queue.resume();
    await settled();
    expect(prompt.status).toBe('approved');
    expect(decide).toHaveBeenCalledTimes(2);
  });
});

describe('mainnet', () => {
  it("answers -4 instead of approving signing prompts under 'approve'", async () => {
    const { queue, state, replies, arrive } = promptQueue({
      policy: 'approve',
    });
    state.switchNetwork('mainnet');
    for (const kind of kinds) arrive(kind);
    await Promise.all(kinds.map(() => queue.nextPrompt()));
    expect(
      Object.fromEntries(queue.prompts().map((p) => [p.kind, p.status])),
    ).toEqual({
      connect: 'approved',
      signTransaction: 'rejected',
      signAuthEntry: 'rejected',
      signMessage: 'rejected',
      addToken: 'rejected',
    });
    expect(replies.filter(({ reply }) => reply === 'approved')).toEqual([
      { prompt: 'p1', reply: 'approved' },
    ]);
  });

  it('answers -4 when a function approves on mainnet', async () => {
    const { queue, state, replies, arrive } = promptQueue({
      policy: () => ({ action: 'approve' }),
    });
    state.switchNetwork('mainnet');
    arrive('signTransaction');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(replies).toEqual([{ prompt: 'p1', reply: declined }]);
  });
});

describe('automatic', () => {
  const prompt = (kind: Prompt['kind'], blocked: BlockedReason | null) =>
    ({ kind, blocked }) as Prompt;

  it('turns an approval into a rejection only when the wallet must refuse', () => {
    const approve: Decision = { action: 'approve' };
    expect(automatic(approve, prompt('signMessage', null), false)).toBe(
      approve,
    );
    expect(automatic(approve, prompt('connect', null), true)).toBe(approve);
    for (const kind of signing) {
      expect(automatic(approve, prompt(kind, null), true)).toEqual({
        action: 'reject',
      });
    }
    expect(
      automatic(approve, prompt('connect', 'notConnected'), false),
    ).toEqual({ action: 'reject' });
    const hang: Decision = { action: 'hang' };
    expect(automatic(hang, prompt('signMessage', 'alreadyAdded'), true)).toBe(
      hang,
    );
  });
});
