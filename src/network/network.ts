import { createHash } from 'node:crypto';
import { Networks } from '@stellar/stellar-sdk';
import type { z } from 'zod';
import { StardustError } from '@/errors';
import { rpcEnvelope, rpcResults } from '@/network/schema';
import type { RpcMethod, RpcResult } from '@/network/schema';

/** The settings for `createStardust`. */
export interface CoreConfig {
  /** The network: `'testnet'`, or `{ rpcUrl }` for another RPC endpoint. Mainnet is refused. */
  network: 'testnet' | { rpcUrl: string };
  /** The `fetch` used for RPC and Friendbot requests. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** A network, as Stardust read it from its RPC. */
export interface NetworkInfo {
  /**
   * The network's name, from its passphrase. `'mainnet'` appears only on
   * `wallet.network`, after `switchNetwork('mainnet')`.
   */
  readonly name: 'testnet' | 'futurenet' | 'mainnet' | 'custom';
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  /** The network's Friendbot, or `null` when it has none. */
  readonly friendbotUrl: string | null;
  readonly protocolVersion: number;
}

export interface HealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const testnetRpcUrl = 'https://soroban-testnet.stellar.org';
const requestTimeoutMs = 20_000;

const names = new Map<string, NetworkInfo['name']>([
  [Networks.TESTNET, 'testnet'],
  [Networks.FUTURENET, 'futurenet'],
  [Networks.PUBLIC, 'mainnet'],
]);

export class Rpc {
  private lastId = 0;

  constructor(
    readonly url: string,
    private readonly send: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async call<M extends RpcMethod>(
    method: M,
    params?: object,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>> {
    const id = ++this.lastId;
    const body = await this.post(
      method,
      { jsonrpc: '2.0', id, method, params },
      signal,
    );
    const envelope = rpcEnvelope.safeParse(body);
    if (!envelope.success || envelope.data.id !== id) {
      throw this.unreadable(method, envelope.error);
    }
    const { error, result } = envelope.data;
    if (error) {
      throw this.failure(
        `returned an error for ${method}: ${error.message} (code ${error.code}).`,
        error,
      );
    }
    const parsed = rpcResults[method].safeParse(result);
    if (!parsed.success) throw this.unreadable(method, parsed.error);
    return parsed.data;
  }

  private async post(
    method: string,
    request: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const response = await this.send(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error: unknown) => {
      throw signal?.aborted
        ? signal.reason
        : this.failure(
            `didn't answer ${method}. Check the RPC URL and your connection.`,
            error,
          );
    });
    if (!response.ok) {
      throw this.failure(
        `answered ${method} with HTTP ${response.status}. Check the RPC URL, or try again later.`,
      );
    }
    return response.json().catch(() => {
      if (signal?.aborted) throw signal.reason;
      return undefined;
    });
  }

  private unreadable(method: string, cause?: z.ZodError): StardustError {
    return this.failure(
      `sent a ${method} response Stardust can't read. Check that the RPC URL points to a Stellar RPC server.`,
      cause,
    );
  }

  private failure(problem: string, cause?: unknown): StardustError {
    return new StardustError('NETWORK_UNREACHABLE', `${this.url} ${problem}`, {
      cause,
    });
  }
}

export function resolveNetwork(network: CoreConfig['network']): string {
  return network === 'testnet' ? testnetRpcUrl : network.rpcUrl;
}

export async function waitForHealth(
  rpc: Rpc,
  { timeoutMs = 60_000, intervalMs = 1_000 }: HealthOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cause: unknown;
  for (;;) {
    const signal = AbortSignal.timeout(Math.max(deadline - Date.now(), 1));
    try {
      const { status } = await rpc.call('getHealth', undefined, signal);
      if (status === 'healthy') return;
      cause = new Error(`getHealth reported '${status}'`);
    } catch (error) {
      cause = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StardustError(
        'NETWORK_UNREACHABLE',
        `${rpc.url} not reachable after ${timeoutMs / 1000}s`,
        { cause },
      );
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export async function checkNetwork(
  rpc: Rpc,
  options?: HealthOptions,
): Promise<NetworkInfo> {
  await waitForHealth(rpc, options);
  const { passphrase, friendbotUrl, protocolVersion } =
    await rpc.call('getNetwork');
  refuseMainnet(passphrase);
  return {
    name: networkName(passphrase),
    rpcUrl: rpc.url,
    networkPassphrase: passphrase,
    friendbotUrl: friendbotUrl || null,
    protocolVersion,
  };
}

export function refuseMainnet(passphrase: string): void {
  if (passphrase === Networks.PUBLIC) {
    throw new StardustError(
      'MAINNET_REFUSED',
      'refused: this network reports the mainnet passphrase. Stardust never runs on mainnet.',
    );
  }
}

export function networkName(passphrase: string): NetworkInfo['name'] {
  return names.get(passphrase) ?? 'custom';
}

export function networkId(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase).digest();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
