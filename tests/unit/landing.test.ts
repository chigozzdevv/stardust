import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractSpecs } from '@/contracts/spec';
import { authEntryLanded, landed } from '@/network/landing';
import type { LandingContext } from '@/network/landing';
import { Rpc } from '@/network/network';
import {
  answer,
  recordedResult,
  recording,
  replay,
} from '@tests/helpers/replay';
import type { RecordedCall } from '@tests/helpers/replay';

const testnet = 'https://soroban-testnet.stellar.org';
const native = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const notFound = { status: 'NOT_FOUND', latestLedger: 5803362 };
const fast = { intervalMs: 1 };

function context(send: typeof fetch): LandingContext {
  const rpc = new Rpc(testnet, send);
  return { rpc, specs: new ContractSpecs(rpc) };
}

function hashOf(name: string): string {
  const [call] = recording(name);
  return (call?.params as { hash: string }).hash;
}

function landing(name: string, ...extra: RecordedCall[]) {
  return landed(
    context(replay(...recording(name), ...extra)),
    hashOf(name),
    fast,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('landed', () => {
  it('polls until the transaction is in a ledger', async () => {
    const result = recordedResult('classic-payment');
    let polls = 0;
    const send = vi.fn(answer(() => (++polls < 3 ? notFound : result)));
    const hash = hashOf('classic-payment');

    await expect(landed(context(send), hash, fast)).resolves.toEqual({
      status: 'success',
      hash,
      ledger: 5800305,
      feeCharged: 100n,
      feeBump: false,
      returnValue: undefined,
      events: [
        {
          contract: native,
          topics: [
            'transfer',
            'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH',
            'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV',
            'native',
          ],
          data: 20_000_000n,
        },
      ],
      balanceChanges: [
        {
          address: 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH',
          asset: native,
          change: -20_000_000n,
        },
        {
          address: 'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV',
          asset: native,
          change: 20_000_000n,
        },
      ],
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('decodes the return value of a contract call', async () => {
    await expect(landing('vault-deposit')).resolves.toMatchObject({
      status: 'success',
      feeCharged: 15_243n,
      returnValue: [[10_000_000n], 10_000_000n, null],
    });
    await expect(landing('sac-transfer')).resolves.toMatchObject({
      status: 'success',
      returnValue: null,
    });
  });

  it('finds a fee-bumped transaction by its inner hash', async () => {
    const inner = hashOf('fee-bump');
    await expect(landing('fee-bump')).resolves.toMatchObject({
      status: 'success',
      hash: inner,
      ledger: 5802969,
      feeBump: true,
      feeCharged: 41_553n,
      events: [],
      balanceChanges: [],
    });
  });

  it('names a contract error through the contract spec', async () => {
    await expect(
      landing('failed-call', ...recording('asset-instance')),
    ).resolves.toEqual({
      status: 'failed',
      hash: hashOf('failed-call'),
      ledger: 5803340,
      resultCode: 'txFAILED',
      contractError: { contract: native, code: 10, name: 'BalanceError' },
    });
  });

  it('keeps the error number when the spec cannot be read', async () => {
    const result = recordedResult('failed-call');
    const send = answer(({ method }) =>
      method === 'getTransaction' ? result : { latestLedger: 1, entries: [] },
    );
    await expect(
      landed(context(send), hashOf('failed-call'), fast),
    ).resolves.toMatchObject({
      contractError: { contract: native, code: 10, name: null },
    });
  });

  it('gives no contract error when the failure has none', async () => {
    await expect(landing('failed-auth')).resolves.toMatchObject({
      status: 'failed',
      resultCode: 'txFAILED',
      contractError: null,
    });
    await expect(landing('failed-classic')).resolves.toEqual({
      status: 'failed',
      hash: hashOf('failed-classic'),
      ledger: 5802966,
      resultCode: 'txFAILED',
      contractError: null,
    });
  });

  it('reports the inner result code of a failed fee bump', async () => {
    await expect(landing('failed-bump')).resolves.toMatchObject({
      status: 'failed',
      ledger: 5795677,
      resultCode: 'txFAILED',
      contractError: null,
    });
  });

  it('throws OUTCOME_UNKNOWN, never failed, when the transaction is not found in time', async () => {
    vi.useFakeTimers();
    const send = vi.fn(answer(() => notFound));
    const hash = hashOf('classic-payment');
    const waiting = landed(context(send), hash);
    const failure = expect(waiting).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      retryable: true,
      message: `transaction ${hash} didn't appear on the network within 30s, so its outcome is unknown. Check that the app sends it, or pass a longer timeoutMs.`,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(30);
  });

  it('keeps polling through RPC errors and reports them as the cause', async () => {
    const cause = new TypeError('fetch failed');
    const down = vi.fn(() => Promise.reject(cause));
    await expect(
      landed(context(down), hashOf('classic-payment'), {
        timeoutMs: 50,
        intervalMs: 5,
      }),
    ).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: expect.stringContaining('within 0.05s'),
      cause: { code: 'NETWORK_UNREACHABLE', cause },
    });
    expect(down.mock.calls.length).toBeGreaterThan(1);
  });

  it("passes the caller's abort reason through", async () => {
    const hash = hashOf('classic-payment');
    const reason = new Error('test ended');
    const send = answer(() => notFound);

    await expect(
      landed(context(send), hash, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);

    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 20);
    await expect(
      landed(context(send), hash, {
        intervalMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});

describe('authEntryLanded', () => {
  const pages = recording('auth-scan').map(
    ({ result }) => result as { cursor: string; transactions: unknown[] },
  );
  const entry = {
    address: 'CDA3Y7I3BLJVY35MT3IO6KJXYXQSWXPEXOGB3JAL4MMEIMK27GYCN5H4',
    nonce: 5_170_948_945_941_724_719n,
    fromLedger: 5802974,
  };

  function scan(served: unknown[]) {
    const requests: unknown[] = [];
    const send = answer(({ params }) => {
      requests.push(params);
      return served.shift() ?? { ...pages.at(-1), transactions: [] };
    });
    return { requests, send };
  }

  it('finds the transaction carrying the auth entry, keeping the cursor between polls', async () => {
    const { requests, send } = scan([...pages]);
    await expect(
      authEntryLanded(context(send), entry, fast),
    ).resolves.toMatchObject({
      status: 'success',
      hash: '0a3741fa1f4bb5384cee379e3f0736c24f864be6270420fe35010321ce06bcdd',
      ledger: 5802974,
      feeBump: true,
    });
    expect(requests).toEqual([
      { startLedger: 5802974, pagination: { limit: 50 } },
      { pagination: { cursor: pages[0]?.cursor, limit: 50 } },
      { pagination: { cursor: pages[1]?.cursor, limit: 50 } },
    ]);
  });

  it('reads the next page at once when a page is full', async () => {
    const [first, , last] = pages;
    if (!first) throw new Error('auth-scan has no pages');
    const full = {
      ...first,
      transactions: Array.from({ length: 50 }, () => first.transactions[0]),
    };
    const { requests, send } = scan([full, last]);
    await expect(
      authEntryLanded(context(send), entry, { intervalMs: 60_000 }),
    ).resolves.toMatchObject({ status: 'success' });
    expect(requests).toEqual([
      { startLedger: 5802974, pagination: { limit: 50 } },
      { pagination: { cursor: first.cursor, limit: 50 } },
    ]);
  });

  it('matches the nonce as well as the address', async () => {
    const { send } = scan([...pages]);
    await expect(
      authEntryLanded(
        context(send),
        { ...entry, nonce: 1n },
        { timeoutMs: 50, intervalMs: 1 },
      ),
    ).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message: `no transaction with the auth entry of ${entry.address} (nonce 1) appeared on the network within 0.05s, so its outcome is unknown. Check that the app or its relayer sends it, or pass a longer timeoutMs.`,
    });
  });
});
