import { inspect } from 'node:util';
import { ContractSpecs } from '@/contracts/spec';
import { StardustError } from '@/errors';
import type { Account } from '@/funding/accounts';
import type { LandingContext } from '@/network/landing';
import { Rpc } from '@/network/rpc';
import type { NetworkInfo } from '@/network/rpc';
import { pageScript } from '@/protocols/page-script';
import { Sep60, providerInfo } from '@/protocols/sep60/provider';
import { Varial } from '@/protocols/varial/handler';
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

/** The settings for one emulated wallet. */
export interface WalletOptions {
  /** The accounts in the wallet. The first is active. */
  accounts: readonly Account[];
  /** Start as if the user had already connected the site, for every account. Default `false`. */
  connected?: boolean;
  /** How the wallet answers prompts. Default `'approve'`. */
  policy?: Policy;
  /** Fail the test at its end when the app broke wallet rules. Default `true`. */
  strict?: boolean;
  /** Whether the wallet signs on `http://` pages. Default `true`. */
  allowHttp?: boolean;
}

/**
 * An emulated wallet in the page, with the accounts of one user. It answers
 * the app as the real wallet does, and records every prompt.
 */
export interface Wallet {
  /** The active account's address, as the wallet reports it to the app. */
  readonly address: string;
  /** The network the wallet reports to the app. */
  readonly network: NetworkInfo;

  /**
   * Puts the wallet in a page. The test fixtures do this for every user;
   * call it only in a custom setup built on `createStardust`.
   */
  attach(
    host: PageHost,
    options: { wallet: 'varial' | 'sep60' },
  ): Promise<void>;
  /** Changes how the wallet answers prompts from now on. */
  setPolicy(policy: Policy): void;

  /**
   * Returns the oldest prompt of `kind`, or of any kind, that this method
   * hasn't returned yet, waiting for one if needed. Under `'manual'` the test
   * answers it; under other policies it's already answered. Throws `NO_PROMPT`,
   * listing what did arrive, when none arrives in time (default 10 s).
   */
  nextPrompt<K extends PromptKind = PromptKind>(
    kind?: K,
    options?: WaitOptions,
  ): Promise<PromptOf<K>>;
  /** Every prompt so far in this test, or only those of `kind`, in arrival order. */
  prompts<K extends PromptKind = PromptKind>(kind?: K): readonly PromptOf<K>[];
  /** The wallet rules the app has broken so far. */
  violations(): readonly Violation[];
  /**
   * Calls `listener` when a prompt arrives and again when it's answered.
   * Returns a function that stops the calls.
   */
  subscribe(listener: (prompt: Prompt) => void): () => void;

  /**
   * Makes another of the wallet's accounts active, as the user switching
   * accounts. Throws `UNKNOWN_ACCOUNT` for an account that isn't in the wallet.
   */
  switchAccount(account: Account): Promise<void>;
  /**
   * Makes the wallet report another network, as the user switching networks.
   * On mainnet, nothing is signed.
   */
  switchNetwork(network: 'testnet' | 'futurenet' | 'mainnet'): Promise<void>;
  /** Locks the wallet, as the user pressing Lock. Prompts wait until `unlock()`. */
  lock(): Promise<void>;
  /** Unlocks the wallet. Waiting prompts go ahead under the policy. */
  unlock(): Promise<void>;
  /** Removes the site from the wallet's connected sites, as the user disconnecting it. */
  disconnect(): Promise<void>;
}

/**
 * Where a wallet lives: a browser page, or a stand-in for one. Stardust's
 * Playwright host builds it on a `BrowserContext`.
 */
export interface PageHost {
  /**
   * Makes `handler` callable from the page as `window[name]`. `origin` must
   * come from the browser, never from the page.
   */
  exposeBinding(
    name: string,
    handler: (origin: string, payload: unknown) => Promise<unknown>,
  ): Promise<void>;
  /** Runs `source` in every page before the page's own scripts. */
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
