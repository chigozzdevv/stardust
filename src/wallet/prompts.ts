import { StardustError } from '@/errors';
import { authEntryLanded, landed } from '@/network/landing';
import type { Landed, LandingContext, LandingOptions } from '@/network/landing';
import type { DecodedAuthPreimage, DecodedTransaction } from '@/wallet/decode';
import type { WalletState } from '@/wallet/state';

/**
 * What a prompt asks for: `connect` (the address), `signTransaction`,
 * `signAuthEntry` (one contract call's authorization), `signMessage`, or
 * `addToken`. `addToken` exists only on `'varial'`.
 */
export type PromptKind =
  'connect' | 'signTransaction' | 'signAuthEntry' | 'signMessage' | 'addToken';

/** Where a prompt is in its life. `'pending'` until it's answered, then the answer. */
export type PromptStatus =
  'pending' | 'approved' | 'rejected' | 'failed' | 'hung';

/**
 * Why the real wallet would refuse a prompt: the site isn't connected, the app
 * asked for another network, the page isn't secure and `allowHttp` is off, the
 * token is already added, or the wallet is locked.
 */
export type BlockedReason =
  | 'notConnected'
  | 'networkMismatch'
  | 'insecureOrigin'
  | 'alreadyAdded'
  | 'locked';

/**
 * How a policy function answers a prompt: approve it, reject it (error -4),
 * fail it with a wallet error code, or never answer.
 */
export type Decision =
  | { action: 'approve' }
  | { action: 'reject' }
  | { action: 'fail'; code: -1 | -2 | -3; message?: string }
  | { action: 'hang' };

/** How long to wait. */
export interface WaitOptions {
  /** How long to wait, in milliseconds. Default 10 s for prompts, 30 s for a transaction to land. */
  timeoutMs?: number;
  /** Stops the wait early. */
  signal?: AbortSignal;
}

export interface WalletError {
  readonly code: -1 | -2 | -3 | -4;
  readonly message: string;
}

/** A wallet error to answer a prompt with. */
export interface Failure {
  /** `-1` for an internal error, `-2` for an external service, `-3` for an invalid request. */
  code: -1 | -2 | -3;
  /** The error message. Default: Varial's text for `-1`, `Stardust: simulated wallet error (code N)` otherwise. */
  message?: string;
}

/** What every prompt has. Each prompt is answered exactly once; a second answer throws `ALREADY_ANSWERED`. */
export interface BasePrompt<K extends PromptKind> {
  /** `'p1'`, `'p2'`, … in arrival order within a test. */
  readonly id: string;
  readonly kind: K;
  /** The site that sent it, taken from the browser, never from the page's message. */
  readonly origin: string;
  /** The network passphrase the app asked for, or `null` when it sent none. */
  readonly networkPassphrase: string | null;
  /** `'pending'` until the prompt is answered. */
  readonly status: PromptStatus;
  /** Why the real wallet would refuse this prompt, or `null` when it wouldn't. */
  readonly blocked: BlockedReason | null;

  /**
   * Approves the prompt, as a user clicking the wallet's approve button. The
   * app receives the real result. Resolves once the reply has reached the page.
   * Throws `PROMPT_BLOCKED` when the prompt is blocked, `WALLET_LOCKED` while
   * the wallet is locked, and `MAINNET_REFUSED` for a signature on mainnet.
   */
  approve(): Promise<void>;
  /** Rejects the prompt. The app receives error -4, `The user rejected this request.` */
  reject(): Promise<void>;
  /** Answers with a wallet error. */
  fail(error: Failure): Promise<void>;
  /** Never answers. The app's call waits forever, as when a user ignores the popup. */
  hang(): void;
}

/** The app asks for the user's address, on a site that isn't connected. */
export type ConnectPrompt = BasePrompt<'connect'>;

/** The app asks for a whole transaction to be signed. */
export interface TransactionPrompt extends BasePrompt<'signTransaction'> {
  readonly transaction: DecodedTransaction;
  /**
   * Waits for the signed transaction to land and returns its outcome. Throws
   * `OUTCOME_UNKNOWN` when it doesn't appear in time, `PROMPTS_PENDING` when
   * the prompt isn't answered in time, and `UNSUPPORTED` when it was rejected,
   * failed or hung.
   */
  landed(options?: WaitOptions): Promise<Landed>;
}

/** The app asks for one contract call to be authorized, while someone else sends the transaction. */
export interface AuthEntryPrompt extends BasePrompt<'signAuthEntry'> {
  readonly preimage: DecodedAuthPreimage;
  /**
   * Waits for a transaction that uses this authorization to land, and returns
   * its outcome. Throws `OUTCOME_UNKNOWN` when none appears in time,
   * `PROMPTS_PENDING` when the prompt isn't answered in time, and
   * `UNSUPPORTED` when it was rejected, failed or hung.
   */
  landed(options?: WaitOptions): Promise<Landed>;
}

/** The app asks for a message to be signed, as proof of owning the address. Nothing moves on chain. */
export interface MessagePrompt extends BasePrompt<'signMessage'> {
  /** The message, as the app sent it. */
  readonly message: string;
}

/** The app asks the wallet to add a token. `'varial'` only. */
export interface AddTokenPrompt extends BasePrompt<'addToken'> {
  /** The token contract, `C...`. */
  readonly contractId: string;
}

/** Anything a real wallet shows the user as a popup. */
export type Prompt =
  | ConnectPrompt
  | TransactionPrompt
  | AuthEntryPrompt
  | MessagePrompt
  | AddTokenPrompt;

/** The prompt type for one kind, such as `PromptOf<'signTransaction'>`. */
export type PromptOf<K extends PromptKind> = Extract<Prompt, { kind: K }>;

export interface PromptFields {
  connect: Record<never, never>;
  signTransaction: { readonly transaction: DecodedTransaction };
  signAuthEntry: { readonly preimage: DecodedAuthPreimage };
  signMessage: { readonly message: string };
  addToken: { readonly contractId: string };
}

export interface PromptRef<K extends PromptKind = PromptKind> {
  readonly id: string;
  readonly kind: K;
}

export interface PromptReply {
  approve(): Promise<void>;
  error(error: WalletError): Promise<void>;
}

export interface PromptInput<K extends PromptKind = PromptKind> {
  readonly kind: K;
  readonly origin: string;
  readonly networkPassphrase: string | null;
  readonly blocked:
    | Exclude<BlockedReason, 'locked'>
    | null
    | Promise<Exclude<BlockedReason, 'locked'> | null>;
  readonly signer: string;
  readonly fields: PromptFields[K] | Promise<PromptFields[K]>;
  readonly reply: PromptReply;
}

export interface PromptHooks {
  readonly state: WalletState;
  readonly landing: LandingContext;
  readonly onAnswer: (prompt: Prompt) => void;
}

type Track = (options: LandingOptions) => Promise<Landed>;

export const declined: WalletError = {
  code: -4,
  message: 'The user rejected this request.',
};

export const internalError: WalletError = {
  code: -1,
  message:
    'The wallet encountered an internal error. Please try again or contact the wallet if the problem persists.',
};

const statuses = {
  approve: 'approved',
  reject: 'rejected',
  fail: 'failed',
  hang: 'hung',
} as const satisfies Record<Decision['action'], PromptStatus>;

export class PromptEntry {
  status: PromptStatus = 'pending';
  prompt: Prompt | null = null;
  private arrival: Exclude<BlockedReason, 'locked'> | null = null;
  private final: BlockedReason | null = null;
  private signedOn: LandingContext | null = null;
  private fromLedger: Promise<number | null> = Promise.resolve(null);
  private settle: () => void = () => {};
  private readonly answered = new Promise<void>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly id: string,
    private readonly input: PromptInput,
    private readonly hooks: PromptHooks,
  ) {}

  get kind(): PromptKind {
    return this.input.kind;
  }

  get blocked(): BlockedReason | null {
    if (this.status !== 'pending') return this.final;
    return this.hooks.state.locked ? 'locked' : this.arrival;
  }

  reveal(
    fields: PromptFields[PromptKind],
    blocked: Exclude<BlockedReason, 'locked'> | null,
  ): Prompt {
    this.arrival = blocked;
    const prompt = {
      id: this.id,
      kind: this.input.kind,
      origin: this.input.origin,
      networkPassphrase: this.input.networkPassphrase,
      approve: () => this.approve(),
      reject: () => this.reject(),
      fail: (error: Failure) => this.fail(error),
      hang: () => this.hang(),
      ...fields,
    } as Prompt;
    Object.defineProperties(prompt, {
      status: { get: () => this.status, enumerable: true },
      blocked: { get: () => this.blocked, enumerable: true },
    });
    const track = this.tracker(prompt);
    if (track) {
      Object.assign(prompt, {
        landed: (options?: WaitOptions) => this.landed(track, options),
      });
    }
    this.prompt = Object.freeze(prompt);
    return prompt;
  }

  async approve(): Promise<void> {
    this.unanswered();
    if (
      this.kind !== 'connect' &&
      this.hooks.state.network.name === 'mainnet'
    ) {
      throw new StardustError(
        'MAINNET_REFUSED',
        `refused: the wallet is on mainnet, so ${this.label} can't be approved. Stardust never signs for mainnet. Switch back with wallet.switchNetwork('testnet'), or answer it with reject().`,
      );
    }
    const blocked = this.blocked;
    if (blocked === 'locked') {
      throw new StardustError(
        'WALLET_LOCKED',
        `the wallet is locked, so ${this.label} can't be approved. Call wallet.unlock() first, or answer it with reject().`,
      );
    }
    if (blocked) {
      throw new StardustError(
        'PROMPT_BLOCKED',
        `${this.label} is blocked (${blocked}): ${this.blockedReason(blocked)}`,
      );
    }
    await this.answer({ action: 'approve' });
  }

  reject(): Promise<void> {
    return this.answer({ action: 'reject' });
  }

  fail(error: Failure): Promise<void> {
    return this.answer({ action: 'fail', ...error });
  }

  hang(): void {
    this.unanswered();
    void this.answer({ action: 'hang' });
  }

  async answer(decision: Decision): Promise<void> {
    this.unanswered();
    this.final = this.blocked;
    this.status = statuses[decision.action];
    this.settle();
    if (this.prompt) this.hooks.onAnswer(this.prompt);
    await this.send(decision);
  }

  private send(decision: Decision): Promise<void> {
    const { reply } = this.input;
    switch (decision.action) {
      case 'approve': {
        // hooks.landing follows the wallet's network; keep the one signed for.
        const { rpc, specs } = this.hooks.landing;
        this.signedOn = { rpc, specs };
        if (this.kind === 'signAuthEntry') {
          this.fromLedger = this.latestLedger().catch(() => null);
        }
        return reply.approve();
      }
      case 'reject':
        return reply.error(declined);
      case 'fail':
        return reply.error(walletFailure(decision));
      case 'hang':
        return Promise.resolve();
    }
  }

  private tracker(prompt: Prompt): Track | null {
    switch (prompt.kind) {
      case 'signTransaction':
        return (options) =>
          landed(this.landing, prompt.transaction.hash, options);
      case 'signAuthEntry':
        return async (options) =>
          authEntryLanded(
            this.landing,
            {
              address: this.input.signer,
              nonce: prompt.preimage.nonce,
              fromLedger: await this.startLedger(options.signal),
            },
            options,
          );
      default:
        return null;
    }
  }

  private async landed(
    track: Track,
    { timeoutMs = 30_000, signal }: WaitOptions = {},
  ): Promise<Landed> {
    const started = Date.now();
    const waited = this.status === 'pending';
    if (waited) await this.answeredWithin(timeoutMs, signal);
    if (this.status !== 'approved') {
      throw new StardustError(
        'UNSUPPORTED',
        `${this.label} is ${this.status}, so nothing was signed and there's nothing to wait for. Call landed() only on approved prompts.`,
      );
    }
    const remaining = waited
      ? Math.max(timeoutMs - (Date.now() - started), 1)
      : timeoutMs;
    return track({ timeoutMs: remaining, ...(signal && { signal }) });
  }

  private answeredWithin(timeoutMs: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        settle();
      };
      const abort = () => finish(() => reject(signal?.reason));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new StardustError(
                'PROMPTS_PENDING',
                `${this.label} is still pending after ${timeoutMs / 1000}s, so nothing was signed. Answer it before waiting for it to land, or pass a longer timeoutMs.`,
              ),
            ),
          ),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      void this.answered.then(() => finish(resolve));
    });
  }

  private async startLedger(signal?: AbortSignal): Promise<number> {
    return (await this.fromLedger) ?? this.latestLedger(signal);
  }

  private async latestLedger(signal?: AbortSignal): Promise<number> {
    const { sequence } = await this.landing.rpc.call(
      'getLatestLedger',
      undefined,
      signal,
    );
    return sequence;
  }

  private get landing(): LandingContext {
    return this.signedOn ?? this.hooks.landing;
  }

  private unanswered(): void {
    if (this.status !== 'pending') {
      throw new StardustError(
        'ALREADY_ANSWERED',
        `${this.label} is already answered (${this.status}). Every prompt is answered once, by the test or by the policy; use policy 'manual' to answer it in the test.`,
      );
    }
  }

  private blockedReason(reason: Exclude<BlockedReason, 'locked'>): string {
    const { origin } = this.input;
    switch (reason) {
      case 'notConnected':
        return `${origin} isn't connected to the wallet. Have the app connect first, use connected: true, or answer it with reject().`;
      case 'networkMismatch':
        return `the app asked for a different network than the wallet's ("${this.hooks.state.network.networkPassphrase}"). Use the wallet's network in the app, or answer it with reject().`;
      case 'insecureOrigin':
        return `${origin} isn't an https page and allowHttp is false. Serve the app over https, use allowHttp: true, or answer it with reject().`;
      case 'alreadyAdded':
        return 'the wallet shows "This token already has a trustline added." with Add disabled, so the user can only close it. Answer it with reject().';
    }
  }

  private get label(): string {
    return `${this.id} ${this.kind}`;
  }
}

function walletFailure({ code, message }: Failure): WalletError {
  return {
    code,
    message:
      message ??
      (code === -1
        ? internalError.message
        : `Stardust: simulated wallet error (code ${code})`),
  };
}
