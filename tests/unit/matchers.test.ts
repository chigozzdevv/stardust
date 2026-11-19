import { describe, expect, it } from 'vitest';
import { xlm } from '@/amounts';
import { expect as check } from '@/test/index';
import type { DecodedTransaction, Invocation } from '@/wallet/decode';
import type { Policy } from '@/wallet/policy';
import type { PromptStatus, TransactionPrompt } from '@/wallet/prompts';
import { fields, promptQueue } from '@tests/helpers/prompt-queue';
import { answer, recording, replay } from '@tests/helpers/replay';

const native = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const router = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const payer = 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH';
const payee = 'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV';
const notFound = { status: 'NOT_FOUND', latestLedger: 5803362 };

const swap: Invocation = {
  contract: router,
  fn: 'swap_exact_in',
  args: [xlm('10'), xlm('9.9')],
  namedArgs: { amount_in: xlm('10'), min_out: xlm('9.9') },
  depth: 0,
};

const transfer: Invocation = {
  contract: native,
  fn: 'transfer',
  args: [payer, router, xlm('10')],
  namedArgs: { from: payer, to: router, amount: xlm('10') },
  depth: 1,
};

interface Options {
  readonly policy?: Policy;
  readonly send?: typeof fetch;
  readonly transaction?: Partial<DecodedTransaction>;
}

function hashOf(name: string): string {
  const [call] = recording(name);
  return (call?.params as { hash: string }).hash;
}

async function transactionPrompt({
  policy = 'approve',
  send,
  transaction = {},
}: Options = {}) {
  const bench = promptQueue({ policy, ...(send && { send }) });
  bench.arrive('signTransaction', {
    fields: {
      transaction: { ...fields.signTransaction.transaction, ...transaction },
    },
  });
  return bench.queue.nextPrompt('signTransaction');
}

function landing(name: string, ...extra: string[]) {
  return transactionPrompt({
    send: replay(...recording(name), ...extra.flatMap(recording)),
    transaction: { hash: hashOf(name) },
  });
}

async function answered(status: Exclude<PromptStatus, 'pending' | 'approved'>) {
  const prompt = await transactionPrompt({ policy: 'manual' });
  if (status === 'rejected') await prompt.reject();
  if (status === 'failed') await prompt.fail({ code: -1 });
  if (status === 'hung') prompt.hang();
  return prompt;
}

describe('toInvoke', () => {
  it('matches the top-level call or an authorized sub-call, comparing only the listed args', async () => {
    const prompt = await transactionPrompt({
      transaction: { invocations: [swap, transfer] },
    });
    check(prompt).toInvoke({ contract: router, fn: 'swap_exact_in' });
    check(prompt).toInvoke({
      contract: router,
      fn: 'swap_exact_in',
      args: { amount_in: xlm('10') },
    });
    check(prompt).toInvoke({
      contract: native,
      fn: 'transfer',
      args: { from: payer, amount: xlm('10') },
    });
  });

  it('names the function the transaction calls instead', async () => {
    const prompt = await transactionPrompt({
      transaction: { invocations: [{ ...swap, fn: 'swap_exact_out' }] },
    });
    expect(() =>
      check(prompt).toInvoke({ contract: router, fn: 'swap_exact_in' }),
    ).toThrow(
      [
        'expect(prompt).toInvoke(...)',
        '  Expected function: swap_exact_in',
        '  Actual function:   swap_exact_out',
      ].join('\n'),
    );
  });

  it('shows the listed args next to the ones the call has', async () => {
    const prompt = await transactionPrompt({
      transaction: { invocations: [swap] },
    });
    expect(() =>
      check(prompt).toInvoke({
        contract: router,
        fn: 'swap_exact_in',
        args: { amount_in: xlm('5') },
      }),
    ).toThrow(
      [
        'expect(prompt).toInvoke(...)',
        '  Expected args: { amount_in: 50000000n }',
        '  Actual args:   { amount_in: 100000000n }',
      ].join('\n'),
    );
  });

  it('lists the contracts called when the expected one is not', async () => {
    const prompt = await transactionPrompt({
      transaction: { invocations: [swap] },
    });
    expect(() =>
      check(prompt).toInvoke({ contract: native, fn: 'transfer' }),
    ).toThrow(
      [
        'expect(prompt).toInvoke(...)',
        `  Expected contract: ${native}`,
        `  Actual contracts:  ${router}`,
      ].join('\n'),
    );
  });

  it('works under .not', async () => {
    const prompt = await transactionPrompt({
      transaction: { invocations: [swap] },
    });
    check(prompt).not.toInvoke({ contract: native, fn: 'transfer' });
    expect(() =>
      check(prompt).not.toInvoke({ contract: router, fn: 'swap_exact_in' }),
    ).toThrow(
      'expect(prompt).not.toInvoke(...)\n  Expected no call to CADQ…P5KR.swap_exact_in, but p1 makes it at depth 0.',
    );
  });

  it("throws UNSUPPORTED for args when the contract's spec couldn't be read", async () => {
    const prompt = await transactionPrompt({
      transaction: { invocations: [{ ...swap, namedArgs: null }] },
    });
    check(prompt).toInvoke({ contract: router, fn: 'swap_exact_in' });
    expect(() =>
      check(prompt).toInvoke({
        contract: router,
        fn: 'swap_exact_in',
        args: { amount_in: xlm('10') },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED',
        message: expect.stringContaining(
          "couldn't read the argument names of CADQ…P5KR.swap_exact_in",
        ),
      }),
    );
  });

  it('reads the calls of an auth entry', async () => {
    const bench = promptQueue({ policy: 'approve' });
    bench.arrive('signAuthEntry', {
      fields: {
        preimage: { ...fields.signAuthEntry.preimage, invocations: [swap] },
      },
    });
    const prompt = await bench.queue.nextPrompt('signAuthEntry');
    check(prompt).toInvoke({
      contract: router,
      fn: 'swap_exact_in',
      args: { min_out: xlm('9.9') },
    });
  });

  it('refuses a prompt that signs no contract call', async () => {
    const bench = promptQueue({ policy: 'approve' });
    bench.arrive('connect');
    const prompt = await bench.queue.nextPrompt('connect');
    expect(() =>
      check(prompt as unknown as TransactionPrompt).toInvoke({
        contract: router,
        fn: 'swap',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED',
        message:
          'expect(prompt).toInvoke(...) works on signTransaction and signAuthEntry prompts, but p1 is a connect prompt.',
      }),
    );
  });
});

describe('toHaveOperation', () => {
  const pay = {
    type: 'payment',
    source: null,
    body: { destination: payee, asset: 'native', amount: xlm('5') },
  };

  it('matches the listed fields of a classic operation', async () => {
    const prompt = await transactionPrompt({
      transaction: { operations: [pay] },
    });
    check(prompt).toHaveOperation({ type: 'payment' });
    check(prompt).toHaveOperation({
      type: 'payment',
      destination: payee,
      asset: 'native',
      amount: xlm('5'),
    });
    check(prompt).not.toHaveOperation({ type: 'changeTrust' });
  });

  it('shows the fields that differ', async () => {
    const prompt = await transactionPrompt({
      transaction: { operations: [pay] },
    });
    expect(() =>
      check(prompt).toHaveOperation({
        type: 'payment',
        destination: payee,
        amount: xlm('50'),
      }),
    ).toThrow(
      [
        'expect(prompt).toHaveOperation(...)',
        '  Expected amount: 500000000n',
        '  Actual amount:   50000000n',
      ].join('\n'),
    );
  });

  it('lists the operations when none has the type', async () => {
    const prompt = await transactionPrompt({
      transaction: { operations: [pay] },
    });
    expect(() =>
      check(prompt).toHaveOperation({ type: 'changeTrust' }),
    ).toThrow(
      [
        'expect(prompt).toHaveOperation(...)',
        '  Expected operation: changeTrust',
        '  Actual operations:  payment',
      ].join('\n'),
    );
  });
});

describe('toLand', () => {
  it('passes when the transaction succeeded', async () => {
    await check(await landing('classic-payment')).toLand();
  });

  it('names the result and the contract error of a failed transaction', async () => {
    const prompt = await landing('failed-call', 'asset-instance');
    await expect(check(prompt).toLand()).rejects.toThrow(
      [
        'expect(prompt).toLand() failed: transaction FAILED',
        '  result code: txFAILED',
        '  contract error: BalanceError (CDLZ…CYSC, #10)',
        '  Transaction ae10…30ec in ledger 5803340',
      ].join('\n'),
    );
  });

  it.each(['rejected', 'failed', 'hung'] as const)(
    'fails at once for a %s prompt',
    async (status) => {
      const prompt = await answered(status);
      await expect(check(prompt).toLand()).rejects.toThrow(
        `expect(prompt).toLand() failed: p1 signTransaction is ${status}, so nothing was signed and there's nothing to wait for.`,
      );
    },
  );

  it('waits for a pending prompt to be answered', async () => {
    const prompt = await transactionPrompt({
      policy: 'manual',
      send: replay(...recording('classic-payment')),
      transaction: { hash: hashOf('classic-payment') },
    });
    const landed = check(prompt).toLand({ timeoutMs: 5_000 });
    setTimeout(() => void prompt.approve(), 20);
    await landed;
    expect(prompt.status).toBe('approved');
  });

  it('fails naming the status when a pending prompt is not answered in time', async () => {
    const prompt = await transactionPrompt({ policy: 'manual' });
    await expect(check(prompt).toLand({ timeoutMs: 50 })).rejects.toThrow(
      'expect(prompt).toLand() failed: p1 signTransaction is still pending after 0.05s, so nothing was signed. Answer it with approve(), or pass a longer timeoutMs.',
    );
  });

  it('fails naming the status when a pending prompt is rejected while waiting', async () => {
    const prompt = await transactionPrompt({ policy: 'manual' });
    const landed = check(prompt).toLand({ timeoutMs: 5_000 });
    setTimeout(() => void prompt.reject(), 20);
    await expect(landed).rejects.toThrow('p1 signTransaction is rejected');
  });

  it('throws OUTCOME_UNKNOWN when the transaction never appears', async () => {
    const prompt = await transactionPrompt({ send: answer(() => notFound) });
    await expect(check(prompt).toLand({ timeoutMs: 50 })).rejects.toThrow(
      expect.objectContaining({ code: 'OUTCOME_UNKNOWN' }),
    );
  });

  it('throws UNSUPPORTED under .not', async () => {
    const prompt = await landing('classic-payment');
    await expect(check(prompt).not.toLand()).rejects.toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED',
        message:
          "expect(prompt).not.toLand() isn't supported: .not works only on checks that don't wait, such as toInvoke and toHaveOperation. Use toFail() instead of .not.toLand().",
      }),
    );
  });
});

describe('toFail', () => {
  it('passes for a failed transaction, with or without the expected error', async () => {
    const prompt = await landing('failed-call', 'asset-instance');
    await check(prompt).toFail();
    await check(prompt).toFail({}, { timeoutMs: 5_000 });
    await check(prompt).toFail({ resultCode: 'txFAILED' });
    await check(prompt).toFail({ contractError: 'BalanceError' });
    await check(prompt).toFail({ contractError: 10 });
  });

  it('fails for a transaction that succeeded', async () => {
    const prompt = await landing('classic-payment');
    await expect(check(prompt).toFail()).rejects.toThrow(
      'expect(prompt).toFail() failed: transaction SUCCESS\n  Transaction c4c6…f287 in ledger 5800305',
    );
  });

  it('shows the contract error that happened instead', async () => {
    const prompt = await landing('failed-call', 'asset-instance');
    await expect(
      check(prompt).toFail({ contractError: 'SlippageExceeded' }),
    ).rejects.toThrow(
      [
        'expect(prompt).toFail(...)',
        '  Expected contract error: SlippageExceeded',
        '  Actual contract error:   BalanceError (CDLZ…CYSC, #10)',
        '  Transaction ae10…30ec in ledger 5803340',
      ].join('\n'),
    );
  });

  it('says so when the RPC returned no contract error', async () => {
    const prompt = await landing('failed-auth');
    await expect(check(prompt).toFail({ contractError: 4 })).rejects.toThrow(
      "Actual contract error:   none: the RPC returned no diagnostic events, so the contract error isn't known",
    );
  });

  it('throws UNSUPPORTED under .not', async () => {
    const prompt = await landing('failed-auth');
    await expect(check(prompt).not.toFail()).rejects.toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED' }),
    );
  });
});

describe('toChangeBalance', () => {
  it('compares the change, fees excluded, by asset name or contract', async () => {
    const prompt = await landing('classic-payment');
    await check(prompt).toChangeBalance(payer, 'native', -xlm('2'));
    await check(prompt).toChangeBalance(payee, native, xlm('2'));
    await check(prompt).toChangeBalance(payee, 'native', {
      min: xlm('1'),
      max: xlm('2'),
    });
    await check(prompt).toChangeBalance(router, 'native', 0n, {
      timeoutMs: 5_000,
    });
  });

  it('shows the expected and actual change', async () => {
    const prompt = await landing('classic-payment');
    await expect(
      check(prompt).toChangeBalance(payer, 'native', -xlm('10')),
    ).rejects.toThrow(
      [
        'expect(prompt).toChangeBalance(GB5F…RLCH, native, -100000000n)',
        '  Expected change: -100000000 (-10 XLM)',
        '  Actual change:   -20000000 (-2 XLM)',
        '  Transaction c4c6…f287 in ledger 5800305',
      ].join('\n'),
    );
    await expect(
      check(prompt).toChangeBalance(payee, 'native', { min: xlm('5') }),
    ).rejects.toThrow('Expected change: at least 50000000 (5 XLM)');
  });

  it('fails for a failed transaction', async () => {
    const prompt = await landing('failed-auth');
    await expect(
      check(prompt).toChangeBalance(payer, 'native', 0n),
    ).rejects.toThrow(
      'failed: transaction FAILED (txFAILED), so no balance changed',
    );
  });

  it('throws UNSUPPORTED under .not', async () => {
    const prompt = await landing('classic-payment');
    await expect(
      check(prompt).not.toChangeBalance(payer, 'native', 0n),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED',
        message: expect.stringContaining(
          'expect(prompt).not.toChangeBalance()',
        ),
      }),
    );
  });

  it("needs the prompt's network to find a classic asset's contract", async () => {
    const bench = promptQueue({
      policy: 'approve',
      send: replay(...recording('classic-payment')),
    });
    bench.arrive('signTransaction', {
      networkPassphrase: null,
      fields: {
        transaction: {
          ...fields.signTransaction.transaction,
          hash: hashOf('classic-payment'),
        },
      },
    });
    const prompt = await bench.queue.nextPrompt('signTransaction');
    await check(prompt).toChangeBalance(payer, native, -xlm('2'));
    await expect(
      check(prompt).toChangeBalance(payer, 'native', -xlm('2')),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED',
        message:
          "expect(prompt).toChangeBalance() can't find the contract of native, because p1 doesn't say which network it was signed for. Pass the token's contract ID ('C...') instead.",
      }),
    );
  });
});

describe('toEmit', () => {
  it("matches the event's first topic", async () => {
    const prompt = await landing('classic-payment');
    await check(prompt).toEmit({ contract: native, topic: 'transfer' });
  });

  it('lists the events emitted instead', async () => {
    const prompt = await landing('classic-payment');
    await expect(
      check(prompt).toEmit({ contract: native, topic: 'mint' }),
    ).rejects.toThrow(
      [
        'expect(prompt).toEmit(...)',
        '  Expected event: mint from CDLZ…CYSC',
        '  Actual events:  CDLZ…CYSC transfer',
        '  Transaction c4c6…f287 in ledger 5800305',
      ].join('\n'),
    );
  });

  it('throws UNSUPPORTED under .not', async () => {
    const prompt = await landing('classic-payment');
    await expect(
      check(prompt).not.toEmit({ contract: native, topic: 'transfer' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'UNSUPPORTED' }));
  });
});
