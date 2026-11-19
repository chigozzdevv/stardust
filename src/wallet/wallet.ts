import { inspect } from 'node:util';
import { ContractSpecs } from '@/contracts/spec';
import { StardustError } from '@/errors';
import type { Account } from '@/funding/accounts';
import type { LandingContext } from '@/network/landing';
import { Rpc } from '@/network/network';
import type { NetworkInfo } from '@/network/network';
import { pageScript } from '@/protocols/page-script';
import { Sep60, providerInfo } from '@/protocols/sep60/sep60';
import { Varial } from '@/protocols/varial/varial';
import type { Policy } from '@/wallet/policy';
import type {
  Prompt,
  PromptKind,
  PromptOf,
  WaitOptions,
} from '@/wallet/prompts';
import { PromptQueue } from '@/wallet/queue';
import { WalletState } from '@/wallet/state';
import type { NetworkName } from '@/wallet/state';
import { Violations, pendingReport } from '@/wallet/strict';
import type { Violation, WalletKind } from '@/wallet/strict';

export interface WalletOptions {
  accounts: readonly Account[];
  connected?: boolean;
  policy?: Policy;
  strict?: boolean;
  allowHttp?: boolean;
}

export interface Wallet {
  readonly address: string;
  readonly network: NetworkInfo;

  attach(
    host: PageHost,
    options: { wallet: 'varial' | 'sep60' },
  ): Promise<void>;
  setPolicy(policy: Policy): void;

  nextPrompt<K extends PromptKind = PromptKind>(
    kind?: K,
    options?: WaitOptions,
  ): Promise<PromptOf<K>>;
  prompts<K extends PromptKind = PromptKind>(kind?: K): readonly PromptOf<K>[];
  violations(): readonly Violation[];
  subscribe(listener: (prompt: Prompt) => void): () => void;

  switchAccount(account: Account): Promise<void>;
  switchNetwork(network: 'testnet' | 'futurenet' | 'mainnet'): Promise<void>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface PageHost {
  exposeBinding(
    name: string,
    handler: (origin: string, payload: unknown) => Promise<unknown>,
  ): Promise<void>;
  addInitScript(source: string): Promise<void>;
}

export interface WalletContext {
  readonly network: NetworkInfo;
  readonly landing: LandingContext;
  readonly fetch: typeof fetch;
}

const binding = '__stardust';

const show = (value: unknown) => inspect(value, { breakLength: Infinity });

export class EmulatedWallet implements Wallet {
  private readonly state: WalletState;
  private readonly queue: PromptQueue;
  private readonly recorded = new Violations();
  private readonly landing: LandingContext;
  private readonly send: typeof fetch;
  private readonly strict: boolean;
  private readonly allowHttp: boolean;

  constructor(
    {
      accounts,
      connected = false,
      policy = 'approve',
      strict = true,
      allowHttp = true,
    }: WalletOptions,
    { network, landing, fetch }: WalletContext,
  ) {
    this.state = new WalletState({ accounts, network, connected });
    this.landing = followNetwork(this.state, landing, fetch);
    this.queue = new PromptQueue({
      state: this.state,
      landing: this.landing,
      policy,
    });
    this.send = fetch;
    this.strict = strict;
    this.allowHttp = allowHttp;
  }

  get address(): string {
    return this.state.address;
  }

  get network(): NetworkInfo {
    return this.state.network;
  }

  async attach(
    host: PageHost,
    { wallet }: { wallet: WalletKind },
  ): Promise<void> {
    const protocol = this.protocol(wallet);
    await host.exposeBinding(binding, (origin, payload) =>
      protocol.handle(origin, payload),
    );
    await host.addInitScript(
      pageScript(
        wallet === 'varial'
          ? { wallet, binding }
          : { wallet, binding, info: providerInfo },
      ),
    );
  }

  setPolicy(policy: Policy): void {
    this.queue.setPolicy(policy);
  }

  nextPrompt<K extends PromptKind = PromptKind>(
    kind?: K,
    options?: WaitOptions,
  ): Promise<PromptOf<K>> {
    return this.queue.nextPrompt(kind, options);
  }

  prompts<K extends PromptKind = PromptKind>(kind?: K): readonly PromptOf<K>[] {
    return this.queue.prompts(kind);
  }

  violations(): readonly Violation[] {
    return this.recorded.list();
  }

  subscribe(listener: (prompt: Prompt) => void): () => void {
    return this.queue.subscribe(listener);
  }

  async switchAccount(account: Account): Promise<void> {
    this.state.switchAccount(account);
  }

  async switchNetwork(network: NetworkName): Promise<void> {
    this.state.switchNetwork(network);
  }

  async lock(): Promise<void> {
    this.state.locked = true;
  }

  async unlock(): Promise<void> {
    this.state.locked = false;
    this.queue.resume();
  }

  async disconnect(): Promise<void> {
    this.state.disconnect();
  }

  // What fails the test at its end: errors the wallet had no caller to throw
  // to, then PROMPTS_PENDING, then PROTOCOL_VIOLATION when strict.
  endOfTest(): readonly unknown[] {
    const reports = [
      pendingReport(this.queue.unanswered()),
      this.strict ? this.recorded.report() : null,
    ];
    return [
      ...this.queue.errors(),
      ...reports.filter((report) => report !== null),
    ];
  }

  private protocol(wallet: WalletKind): Varial | Sep60 {
    const options = {
      state: this.state,
      queue: this.queue,
      violations: this.recorded,
      landing: this.landing,
      allowHttp: this.allowHttp,
    };
    switch (wallet) {
      case 'varial':
        return new Varial(options);
      case 'sep60':
        return new Sep60({ ...options, fetch: this.send });
      default:
        throw new StardustError(
          'CONFIG_INVALID',
          `attach() got wallet ${show(wallet)}. Use 'varial' or 'sep60'; a page without a wallet is one the wallet isn't attached to.`,
        );
    }
  }
}

// Lookups and landing use the RPC of the network the wallet is on. Mainnet
// gets no RPC: nothing is signed for it, so its lookups stay on the starting
// network.
function followNetwork(
  state: WalletState,
  starting: LandingContext,
  send: typeof fetch,
): LandingContext {
  const contexts = new Map([[state.network.rpcUrl, starting]]);
  const current = (): LandingContext => {
    const { name, rpcUrl } = state.network;
    if (name === 'mainnet') return starting;
    const known = contexts.get(rpcUrl);
    if (known) return known;
    const rpc = new Rpc(rpcUrl, send);
    const context = { rpc, specs: new ContractSpecs(rpc) };
    contexts.set(rpcUrl, context);
    return context;
  };
  return {
    get rpc() {
      return current().rpc;
    },
    get specs() {
      return current().specs;
    },
  };
}
