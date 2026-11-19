import { describe, expect, it, vi } from 'vitest';
import type { Prompt, PromptFields } from '@/wallet/prompts';
import { internalError } from '@/wallet/prompts';
import {
  deferred,
  fields,
  promptQueue,
  settled,
} from '@tests/fixtures/wallet/prompt-queue';

describe('nextPrompt', () => {
  it('returns prompts that arrived before the call, oldest first, each once', async () => {
    const { queue, arrive } = promptQueue();
    arrive('connect');
    arrive('signTransaction');
    arrive('signTransaction');
    await settled();

    await expect(queue.nextPrompt('signTransaction')).resolves.toMatchObject({
      id: 'p2',
    });
    await expect(queue.nextPrompt()).resolves.toMatchObject({ id: 'p1' });
    await expect(queue.nextPrompt()).resolves.toMatchObject({ id: 'p3' });
  });

  it('waits for a prompt that arrives later', async () => {
    const { queue, arrive } = promptQueue();
    const waiting = queue.nextPrompt('signMessage');
    arrive('connect');
    arrive('signMessage');
    await expect(waiting).resolves.toMatchObject({
      id: 'p2',
      kind: 'signMessage',
    });
  });

  it('returns a prompt only after it has been decoded, keeping arrival order', async () => {
    const { queue, arrive } = promptQueue();
    const decoding = deferred<PromptFields['signTransaction']>();
    arrive('signTransaction', { fields: decoding.promise });
    arrive('signTransaction');
    await settled();

    expect(queue.prompts().map(({ id }) => id)).toEqual(['p2']);
    const first = queue.nextPrompt('signTransaction');
    let returned: Prompt | null = null;
    void first.then((prompt) => {
      returned = prompt;
    });
    await settled();
    expect(returned).toBeNull();

    decoding.resolve(fields.signTransaction);
    await expect(first).resolves.toMatchObject({ id: 'p1' });
    await expect(queue.nextPrompt()).resolves.toMatchObject({ id: 'p2' });
    expect(queue.prompts().map(({ id }) => id)).toEqual(['p1', 'p2']);
  });

  it('returns a prompt only after its blocked reason is known, keeping its ID', async () => {
    const { queue, arrive } = promptQueue();
    const lookup = deferred<'alreadyAdded' | null>();
    arrive('addToken', { blocked: lookup.promise });
    arrive('connect');

    await expect(queue.nextPrompt('connect')).resolves.toMatchObject({
      id: 'p2',
    });
    expect(queue.prompts().map(({ id }) => id)).toEqual(['p2']);
    lookup.resolve('alreadyAdded');
    await expect(queue.nextPrompt()).resolves.toMatchObject({
      id: 'p1',
      blocked: 'alreadyAdded',
    });
  });

  it('serves waiters in the order they asked', async () => {
    const { queue, arrive } = promptQueue();
    const first = queue.nextPrompt('signMessage');
    const second = queue.nextPrompt('signMessage');
    arrive('signMessage');
    arrive('signMessage');
    await expect(first).resolves.toMatchObject({ id: 'p1' });
    await expect(second).resolves.toMatchObject({ id: 'p2' });
  });

  it('throws NO_PROMPT listing the prompts that did arrive', async () => {
    const { queue, arrive } = promptQueue({ policy: 'approve' });
    arrive('connect');
    arrive('signMessage');
    arrive('signTransaction', { fields: new Promise(() => {}) });
    await queue.nextPrompt('connect');

    await expect(
      queue.nextPrompt('addToken', { timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: 'NO_PROMPT',
      retryable: false,
      message: [
        'no addToken prompt within 0.05s',
        '  Prompts in this test:',
        '    p1 connect (approved, returned by an earlier nextPrompt)',
        '    p2 signMessage (approved)',
        '    p3 signTransaction (decoding)',
        '  Check that the test makes the app ask the wallet, or pass a longer timeoutMs.',
      ].join('\n'),
    });
  });

  it('says so when no prompt arrived at all', async () => {
    const { queue } = promptQueue();
    await expect(queue.nextPrompt(undefined, { timeoutMs: 1 })).rejects.toThrow(
      [
        'no prompt within 0.001s',
        '  No prompts arrived in this test.',
        '  Check that the test makes the app ask the wallet, or pass a longer timeoutMs.',
      ].join('\n'),
    );
  });

  it('waits 10 s by default', async () => {
    vi.useFakeTimers();
    try {
      const { queue } = promptQueue();
      const failure = expect(
        queue.nextPrompt('signTransaction'),
      ).rejects.toThrow(/^no signTransaction prompt within 10s\n/);
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the caller's abort reason through", async () => {
    const { queue, arrive } = promptQueue();
    const reason = new Error('test ended');
    await expect(
      queue.nextPrompt(undefined, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);

    const controller = new AbortController();
    const waiting = queue.nextPrompt('signMessage', {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);

    arrive('signMessage');
    await expect(queue.nextPrompt()).resolves.toMatchObject({ id: 'p1' });
  });
});

describe('prompts()', () => {
  it('lists decoded prompts, filtered by kind', async () => {
    const { queue, arrive } = promptQueue();
    arrive('connect');
    arrive('signMessage');
    arrive('connect');
    expect(queue.prompts()).toEqual([]);
    await settled();
    expect(queue.prompts().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
    expect(queue.prompts('connect').map(({ id }) => id)).toEqual(['p1', 'p3']);
    expect(queue.prompts('addToken')).toEqual([]);
  });

  it('lists unanswered prompts for the end-of-test check', async () => {
    const { queue, arrive } = promptQueue();
    arrive('connect');
    arrive('signMessage');
    await (await queue.nextPrompt()).approve();
    expect(queue.unanswered()).toEqual([{ id: 'p2', kind: 'signMessage' }]);
  });
});

describe('subscribe', () => {
  it('reports each prompt when it arrives and when it is answered', async () => {
    const { queue, arrive } = promptQueue({ policy: 'approve' });
    const seen: string[] = [];
    const unsubscribe = queue.subscribe(({ id, status }) =>
      seen.push(`${id} ${status}`),
    );
    arrive('connect');
    await queue.nextPrompt();
    unsubscribe();
    arrive('connect');
    await queue.nextPrompt();
    expect(seen).toEqual(['p1 pending', 'p1 approved']);
  });

  it('keeps going when a listener throws, and keeps the error', async () => {
    const { queue, arrive, replies } = promptQueue({ policy: 'approve' });
    const failure = new Error('listener broke');
    queue.subscribe(() => {
      throw failure;
    });
    arrive('connect');
    await queue.nextPrompt();
    expect(replies).toEqual([{ prompt: 'p1', reply: 'approved' }]);
    expect(queue.errors()).toEqual([failure, failure]);
  });
});

describe('decoding failures', () => {
  it('answers the page with an internal error and never shows the prompt', async () => {
    const { queue, arrive, replies } = promptQueue();
    const failure = new Error('decoder bug');
    arrive('signTransaction', { fields: Promise.reject(failure) });
    arrive('signTransaction');

    await expect(queue.nextPrompt()).resolves.toMatchObject({ id: 'p2' });
    expect(queue.prompts().map(({ id }) => id)).toEqual(['p2']);
    expect(queue.unanswered()).toEqual([{ id: 'p2', kind: 'signTransaction' }]);
    expect(replies).toEqual([{ prompt: 'p1', reply: internalError }]);
    expect(queue.errors()).toEqual([failure]);
  });

  it('treats a blocked reason that fails to load the same way', async () => {
    const { queue, arrive, replies } = promptQueue();
    const failure = new Error('lookup failed');
    arrive('addToken', { blocked: Promise.reject(failure) });
    await settled();

    expect(queue.prompts()).toEqual([]);
    expect(replies).toEqual([{ prompt: 'p1', reply: internalError }]);
    expect(queue.errors()).toEqual([failure]);
  });
});
