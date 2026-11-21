import { xdr } from '@stellar/stellar-sdk';
import manifest from '@/../package.json' with { type: 'json' };
import type { Account } from '@/funding/accounts';
import { resultCode } from '@/network/landing';
import type { LandingContext } from '@/network/landing';
import { Rpc } from '@/network/rpc';
import {
  horizonProblem,
  sep43Failure,
  sep43Replies,
  sep43Request,
} from '@/protocols/sep60/schema';
import type {
  Sep43Error,
  Sep43Reply,
  Sep43Request,
  SignOptions,
} from '@/protocols/sep60/schema';
import {
  boundAddress,
  decodeAuthPreimage,
  decodeTransaction,
  nameArgs,
} from '@/wallet/decode';
import { internalError } from '@/wallet/prompts';
import type {
  BlockedReason,
  PromptInput,
  PromptKind,
  PromptRef,
} from '@/wallet/prompts';
import type { PromptQueue } from '@/wallet/queue';
import { signAuthEntry, signMessage, signTransaction } from '@/wallet/signer';
import type { WalletState } from '@/wallet/state';
import type { Violations } from '@/wallet/strict';

export const sep43Version = '1.2.1';
export const sep60Version = '0.1.0';

export interface ProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
  readonly version?: string;
}

export interface Sep60Options {
  readonly state: WalletState;
  readonly queue: PromptQueue;
  readonly violations: Violations;
  readonly landing: LandingContext;
  readonly allowHttp?: boolean;
  readonly fetch?: typeof fetch;
}

type Request<M extends Sep43Request['method']> = Extract<
  Sep43Request,
  { method: M }
>;

type SignKind = Exclude<PromptKind, 'connect' | 'addToken'>;

interface Signing<K extends SignKind> {
  readonly kind: K;
  readonly opts: SignOptions;
  readonly fields: PromptInput<K>['fields'];
  readonly entry?: {
    readonly networkPassphrase: string | null;
    readonly address: string | null;
  };
}

const icon = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#101a3a"/><path fill="#ffd34d" d="M48 20l7.3 19.9 21.2.8-16.6 13.2 5.7 20.4L48 62.5 30.4 74.3l5.7-20.4-16.6-13.2 21.2-.8z"/></svg>',
).toString('base64');

export const providerInfo: Omit<ProviderInfo, 'uuid'> = Object.freeze({
  name: 'Stardust (test wallet)',
  icon: `data:image/svg+xml;base64,${icon}`,
  rdns: 'io.github.stardust-stellar',
  version: manifest.version,
});

const horizonTimeoutMs = 60_000;

export class Sep60 {
  private readonly state: WalletState;
  private readonly queue: PromptQueue;
  private readonly violations: Violations;
  private readonly landing: LandingContext;
  private readonly allowHttp: boolean;
  private readonly send: typeof fetch;
  private readonly rpcs = new Map<string, Rpc>();
  private readonly probes = new Map<string, Promise<boolean>>();

  constructor({
    state,
    queue,
    violations,
    landing,
    allowHttp = true,
    fetch = globalThis.fetch.bind(globalThis),
  }: Sep60Options) {
    this.state = state;
    this.queue = queue;
    this.violations = violations;
    this.landing = landing;
    this.allowHttp = allowHttp;
    this.send = fetch;
    this.rpcs.set(landing.rpc.url, landing.rpc);
  }

  async handle(origin: string, payload: unknown): Promise<Sep43Reply> {
    const request = sep43Request.safeParse(payload);
    if (!request.success) {
      const issues = request.error.issues.map(
        ({ path, message }) => `${path.join('.') || 'request'}: ${message}`,
      );
      return sep43Failure.parse(failure(invalidRequest(...issues)));
    }
    const reply = await this.answer(request.data, origin);
    return sep43Replies[request.data.method].parse(reply);
  }

  private answer(
    request: Sep43Request,
    origin: string,
  ): Sep43Reply | Promise<Sep43Reply> {
    switch (request.method) {
      case 'getAddress':
        return this.state.isConnected(origin)
          ? { address: this.state.address }
          : this.connect(origin);
      case 'getNetwork':
        return {
          network: this.state.varialNetwork.network,
          networkPassphrase: this.passphrase,
        };
      case 'signTransaction':
        return this.signTransaction(request, origin);
      case 'signAuthEntry':
        return this.signAuthEntry(request, origin);
      case 'signMessage':
        return this.signMessage(request, origin);
    }
  }

  private connect(origin: string): Promise<Sep43Reply> {
    return this.ask(
      {
        kind: 'connect',
        origin,
        networkPassphrase: null,
        blocked: null,
        signer: this.state.address,
        fields: {},
      },
      () => {
        this.state.connect(origin);
        return { address: this.state.address };
      },
    ).reply;
  }

  private signTransaction(
    { xdr: envelope, opts }: Request<'signTransaction'>,
    origin: string,
  ): Sep43Reply | Promise<Sep43Reply> {
    const decoded = this.parse('transaction', () =>
      decodeTransaction(envelope, this.passphrase),
    );
    if (!decoded) return failure(invalidRequest('Invalid transaction XDR'));
    return this.sign(
      origin,
      {
        kind: 'signTransaction',
        opts,
        fields: nameArgs(decoded, this.landing.specs).then((transaction) => ({
          transaction,
        })),
      },
      async ({ address, keypair }) => {
        const signedTxXdr = signTransaction(envelope, keypair, this.passphrase);
        const refused = opts.submit
          ? await this.submit(signedTxXdr, opts.submitUrl)
          : null;
        return refused
          ? failure(refused)
          : { signedTxXdr, signerAddress: address };
      },
    );
  }

  private signAuthEntry(
    { authEntry, opts }: Request<'signAuthEntry'>,
    origin: string,
  ): Sep43Reply | Promise<Sep43Reply> {
    const decoded = this.parse('preimage', () =>
      decodeAuthPreimage(authEntry, this.passphrase),
    );
    if (!decoded) return failure(invalidRequest('Invalid auth entry XDR'));
    return this.sign(
      origin,
      {
        kind: 'signAuthEntry',
        opts,
        fields: nameArgs(decoded, this.landing.specs).then((preimage) => ({
          preimage,
        })),
        entry: {
          networkPassphrase: decoded.networkPassphrase,
          address: boundAddress(authEntry),
        },
      },
      ({ address, keypair }) => ({
        signedAuthEntry: signAuthEntry(
          authEntry,
          keypair,
          this.passphrase,
        ).toString('base64'),
        signerAddress: address,
      }),
    );
  }

  private signMessage(
    { message, opts }: Request<'signMessage'>,
    origin: string,
  ): Promise<Sep43Reply> {
    return this.sign(
      origin,
      { kind: 'signMessage', opts, fields: { message } },
      ({ address, keypair }) => ({
        signedMessage: signMessage(message, keypair, this.passphrase).toString(
          'base64',
        ),
        signerAddress: address,
      }),
    );
  }

  private async sign<K extends SignKind>(
    origin: string,
    { kind, opts, fields, entry }: Signing<K>,
    approve: (account: Account) => Sep43Reply | Promise<Sep43Reply>,
  ): Promise<Sep43Reply> {
    if (!this.state.isConnected(origin)) {
      const connected = await this.connect(origin);
      if ('error' in connected) return connected;
    }
    const account = this.state.account;
    const networks = [
      opts.networkPassphrase ?? this.passphrase,
      ...(entry ? [entry.networkPassphrase] : []),
    ];
    const { ref, reply } = this.ask(
      {
        kind,
        origin,
        networkPassphrase: opts.networkPassphrase ?? null,
        blocked: this.blocked(origin, networks),
        signer: account.address,
        fields,
      },
      () => approve(account),
    );
    this.checkNetwork(ref, networks);
    this.checkSigner(ref, account, [opts.address, entry?.address]);
    return reply;
  }

  private ask<K extends PromptKind>(
    input: Omit<PromptInput<K>, 'reply'>,
    approve: () => Sep43Reply | Promise<Sep43Reply>,
  ): { ref: PromptRef<K>; reply: Promise<Sep43Reply> } {
    let send: (reply: Sep43Reply) => void = () => {};
    const reply = new Promise<Sep43Reply>((resolve) => {
      send = resolve;
    });
    const ref = this.queue.add<K>({
      ...input,
      reply: {
        approve: async () => {
          try {
            send(await approve());
          } catch (cause) {
            send(failure(internalError));
            throw cause;
          }
        },
        error: async (error) => send(failure(error)),
      },
    });
    return { ref, reply };
  }

  private async submit(
    transaction: string,
    submitUrl: string | undefined,
  ): Promise<Sep43Error | null> {
    const url = submitUrl ?? this.state.network.rpcUrl;
    const viaRpc = submitUrl === undefined || (await this.isRpc(submitUrl));
    const service = viaRpc ? 'Stellar RPC' : 'Horizon';
    try {
      const refusal = viaRpc
        ? await this.sendTransaction(url, transaction)
        : await this.postTransaction(url, transaction);
      return refusal && serviceError(service, refusal);
    } catch (error) {
      return serviceError(service, [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }

  private async sendTransaction(
    url: string,
    transaction: string,
  ): Promise<string[] | null> {
    const sent = await this.rpc(url).call('sendTransaction', { transaction });
    if (sent.status === 'PENDING' || sent.status === 'DUPLICATE') return null;
    return [
      sent.errorResultXdr
        ? resultCode(
            xdr.TransactionResult.fromXdr(sent.errorResultXdr, 'base64'),
          )
        : sent.status,
    ];
  }

  private async postTransaction(
    url: string,
    transaction: string,
  ): Promise<string[] | null> {
    const endpoint = `${url.replace(/\/+$/, '')}/transactions`;
    const response = await this.send(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: transaction }),
      signal: AbortSignal.timeout(horizonTimeoutMs),
    });
    if (response.ok) return null;
    const problem = horizonProblem.safeParse(
      await response.json().catch(() => null),
    );
    const codes = problem.data?.extras?.result_codes;
    return [
      `${endpoint} answered HTTP ${response.status}`,
      ...(codes?.transaction ? [codes.transaction] : []),
      ...(codes?.operations ?? []),
    ];
  }

  private isRpc(url: string): Promise<boolean> {
    let probe = this.probes.get(url);
    if (!probe) {
      probe = this.rpc(url)
        .call('getHealth')
        .then(
          () => true,
          () => false,
        );
      this.probes.set(url, probe);
    }
    return probe;
  }

  private rpc(url: string): Rpc {
    let rpc = this.rpcs.get(url);
    if (!rpc) {
      rpc = new Rpc(url, this.send);
      this.rpcs.set(url, rpc);
    }
    return rpc;
  }

  private blocked(
    origin: string,
    networks: readonly (string | null)[],
  ): Exclude<BlockedReason, 'locked'> | null {
    if (networks.some((network) => network !== this.passphrase)) {
      return 'networkMismatch';
    }
    if (!this.allowHttp && !origin.startsWith('https')) return 'insecureOrigin';
    return this.state.isConnected(origin) ? null : 'notConnected';
  }

  private parse<T>(field: string, read: () => T): T | null {
    try {
      return read();
    } catch (error) {
      this.violations.invalidXdr(null, field, error);
      return null;
    }
  }

  private checkNetwork(
    ref: PromptRef,
    networks: readonly (string | null)[],
  ): void {
    const wallet = this.passphrase;
    const asked = networks.find((network) => network !== wallet);
    if (asked !== undefined) {
      this.violations.networkMismatch(ref, asked, wallet, 'sep60');
    }
  }

  private checkSigner(
    ref: PromptRef,
    account: Account,
    named: readonly (string | null | undefined)[],
  ): void {
    for (const signer of new Set(named)) {
      if (signer && signer !== account.address) {
        this.violations.signerMismatch(ref, signer, account.address);
      }
    }
  }

  private get passphrase(): string {
    return this.state.network.networkPassphrase;
  }
}

function failure(error: Sep43Error): Sep43Reply {
  return { error };
}

function invalidRequest(...ext: string[]): Sep43Error {
  return {
    code: -3,
    message: 'Request is invalid. Please check the details and try again.',
    ext,
  };
}

function serviceError(service: string, ext: string[]): Sep43Error {
  return {
    code: -2,
    message: `An error occurred with ${service}. Please try again.`,
    ext,
  };
}
