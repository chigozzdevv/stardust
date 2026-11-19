import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Rpc,
  checkNetwork,
  networkId,
  networkName,
  refuseMainnet,
  resolveNetwork,
  waitForHealth,
} from '@/network/network';

const testnet = 'https://soroban-testnet.stellar.org';
const mainnetPassphrase = 'Public Global Stellar Network ; September 2015';
const testnetPassphrase = 'Test SDF Network ; September 2015';
const healthy = { status: 'healthy', latestLedger: 100 };
const failedTransaction = {
  status: 'FAILED',
  txHash: 'ab',
  ledger: 5,
  feeBump: false,
  envelopeXdr: 'AAAA',
  resultXdr: 'AAAA',
  resultMetaXdr: 'AAAA',
  latestLedger: 6,
};

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

function fakeFetch(answer: (request: Request) => unknown): typeof fetch {
  return async (_url, init) => {
    init?.signal?.throwIfAborted();
    const request = JSON.parse(String(init?.body)) as Request;
    const reply = await answer(request);
    return reply instanceof Response
      ? reply
      : new Response(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result: reply }),
        );
  };
}

function network(result: object, health: unknown = healthy): Rpc {
  return new Rpc(
    testnet,
    fakeFetch(({ method }) => (method === 'getHealth' ? health : result)),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveNetwork', () => {
  it('maps testnet to SDF testnet RPC and keeps any other URL', () => {
    expect(resolveNetwork('testnet')).toBe(testnet);
    expect(
      resolveNetwork({ rpcUrl: 'https://rpc-futurenet.stellar.org' }),
    ).toBe('https://rpc-futurenet.stellar.org');
  });
});

describe('Rpc', () => {
  it('posts a JSON-RPC request and returns the validated result', async () => {
    const send = vi.fn(fakeFetch(() => ({ sequence: 7, protocolVersion: 30 })));
    const rpc = new Rpc(testnet, send);

    await expect(rpc.call('getLatestLedger')).resolves.toEqual({
      sequence: 7,
      protocolVersion: 30,
    });
    await rpc.call('getLatestLedger', { extra: true });

    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe(testnet);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestLedger',
    });
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toMatchObject({
      id: 2,
      params: { extra: true },
    });
  });

  it('fills in lists the RPC leaves out', async () => {
    const rpc = network({ ...failedTransaction, events: {} });
    await expect(
      rpc.call('getTransaction', { hash: 'ab' }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      diagnosticEventsXdr: [],
      events: { transactionEventsXdr: [], contractEventsXdr: [] },
    });
    await expect(
      network({
        status: 'NOT_FOUND',
        txHash: 'ab',
        ledger: 0,
        feeBump: false,
        events: {},
        latestLedger: 6,
      }).call('getTransaction', { hash: 'ab' }),
    ).resolves.toEqual({ status: 'NOT_FOUND', latestLedger: 6 });
    await expect(
      network({ latestLedger: 6, entries: null }).call('getLedgerEntries', {
        keys: [],
      }),
    ).resolves.toEqual({ latestLedger: 6, entries: [] });
  });

  it.each([
    [
      'a result without a field',
      'getNetwork',
      fakeFetch(() => ({ protocolVersion: 30 })),
    ],
    [
      'a status the schema does not know',
      'getTransaction',
      fakeFetch(() => ({ status: 'PENDING', latestLedger: 1 })),
    ],
    [
      'a transaction without events',
      'getTransaction',
      fakeFetch(() => failedTransaction),
    ],
    [
      'a body that is not JSON',
      'getNetwork',
      fakeFetch(() => new Response('<html>')),
    ],
    [
      'a reply to another request',
      'getNetwork',
      fakeFetch(
        () =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} })),
      ),
    ],
  ] as const)('rejects %s', async (_case, method, send) => {
    await expect(new Rpc(testnet, send).call(method)).rejects.toMatchObject({
      code: 'NETWORK_UNREACHABLE',
      retryable: true,
      message: `${testnet} sent a ${method} response Stardust can't read. Check that the RPC URL points to a Stellar RPC server.`,
    });
  });

  it('reports JSON-RPC errors, HTTP errors and failed requests', async () => {
    const rpcError = new Rpc(
      testnet,
      fakeFetch(
        ({ id }) =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'unexpected hash length (2)' },
            }),
          ),
      ),
    );
    await expect(
      rpcError.call('getTransaction', { hash: 'zz' }),
    ).rejects.toMatchObject({
      code: 'NETWORK_UNREACHABLE',
      message: `${testnet} returned an error for getTransaction: unexpected hash length (2) (code -32602).`,
      cause: { code: -32602 },
    });

    const httpError = new Rpc(
      testnet,
      fakeFetch(() => new Response('busy', { status: 503 })),
    );
    await expect(httpError.call('getHealth')).rejects.toMatchObject({
      code: 'NETWORK_UNREACHABLE',
      message: `${testnet} answered getHealth with HTTP 503. Check the RPC URL, or try again later.`,
    });

    const cause = new TypeError('fetch failed');
    const down = new Rpc(testnet, () => Promise.reject(cause));
    await expect(down.call('getHealth')).rejects.toMatchObject({
      code: 'NETWORK_UNREACHABLE',
      message: `${testnet} didn't answer getHealth. Check the RPC URL and your connection.`,
      cause,
    });
  });

  it("passes the caller's abort reason through", async () => {
    const controller = new AbortController();
    const reason = new Error('test ended');
    controller.abort(reason);
    const rpc = new Rpc(
      testnet,
      fakeFetch(() => healthy),
    );
    await expect(
      rpc.call('getHealth', undefined, controller.signal),
    ).rejects.toBe(reason);
  });
});

describe('waitForHealth', () => {
  it('retries until the RPC reports healthy', async () => {
    const replies: unknown[] = [
      new TypeError('fetch failed'),
      new Response('starting', { status: 503 }),
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          error: { code: -32603, message: 'data stores are not initialized' },
        }),
      ),
      { status: 'unhealthy', latestLedger: 1 },
      healthy,
    ];
    const send = vi.fn(
      fakeFetch(() => {
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      }),
    );
    await waitForHealth(new Rpc(testnet, send), { intervalMs: 1 });
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('gives up with NETWORK_UNREACHABLE after 60s', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const waiting = waitForHealth(new Rpc(testnet, send));
    const failure = expect(waiting).rejects.toMatchObject({
      code: 'NETWORK_UNREACHABLE',
      retryable: true,
      message: `${testnet} not reachable after 60s`,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(send.mock.calls.length).toBeGreaterThan(50);
  });
});

describe('checkNetwork', () => {
  it('reads testnet from getNetwork', async () => {
    const rpc = network({
      friendbotUrl: 'https://friendbot.stellar.org/',
      passphrase: testnetPassphrase,
      protocolVersion: 30,
    });
    await expect(checkNetwork(rpc)).resolves.toEqual({
      name: 'testnet',
      rpcUrl: testnet,
      networkPassphrase: testnetPassphrase,
      friendbotUrl: 'https://friendbot.stellar.org/',
      protocolVersion: 30,
    });
  });

  it('names futurenet and any other network', async () => {
    const futurenet = network({
      friendbotUrl: 'https://friendbot-futurenet.stellar.org/',
      passphrase: 'Test SDF Future Network ; October 2022',
      protocolVersion: 30,
    });
    await expect(checkNetwork(futurenet)).resolves.toMatchObject({
      name: 'futurenet',
    });

    const custom = network({
      passphrase: 'Standalone Network ; February 2017',
      protocolVersion: 30,
    });
    await expect(checkNetwork(custom)).resolves.toMatchObject({
      name: 'custom',
      friendbotUrl: null,
    });
  });

  it('refuses a network that reports the mainnet passphrase', async () => {
    const rpc = network({ passphrase: mainnetPassphrase, protocolVersion: 30 });
    await expect(checkNetwork(rpc)).rejects.toMatchObject({
      code: 'MAINNET_REFUSED',
      retryable: false,
      message:
        'refused: this network reports the mainnet passphrase. Stardust never runs on mainnet.',
    });
  });

  it('waits for health before reading the network', async () => {
    vi.useFakeTimers();
    const rpc = network(
      { passphrase: testnetPassphrase, protocolVersion: 30 },
      {
        status: 'unhealthy',
        latestLedger: 1,
      },
    );
    const checking = checkNetwork(rpc, { timeoutMs: 5_000 });
    const failure = expect(checking).rejects.toMatchObject({
      message: `${testnet} not reachable after 5s`,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
  });
});

describe('passphrases', () => {
  it('refuses only the mainnet passphrase', () => {
    expect(() => refuseMainnet(mainnetPassphrase)).toThrow(
      expect.objectContaining({ code: 'MAINNET_REFUSED' }),
    );
    expect(() => refuseMainnet(testnetPassphrase)).not.toThrow();
  });

  it('names networks by passphrase', () => {
    expect(networkName(testnetPassphrase)).toBe('testnet');
    expect(networkName('Test SDF Future Network ; October 2022')).toBe(
      'futurenet',
    );
    expect(networkName(mainnetPassphrase)).toBe('mainnet');
    expect(networkName('constructor')).toBe('custom');
  });

  it('derives the network ID as the SHA-256 of the passphrase', () => {
    expect(networkId(testnetPassphrase).toString('hex')).toBe(
      'cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472',
    );
  });
});
