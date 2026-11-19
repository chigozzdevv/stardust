import { StardustError } from '@/errors';
import type { LandingContext } from '@/network/landing';
import { automatic, decide } from '@/wallet/policy';
import type { Policy } from '@/wallet/policy';
import { PromptEntry } from '@/wallet/prompts';
import type {
  BlockedReason,
  Prompt,
  PromptFields,
  PromptInput,
  PromptKind,
  PromptOf,
  PromptRef,
  WaitOptions,
} from '@/wallet/prompts';
import type { WalletState } from '@/wallet/state';

export interface QueueOptions {
  readonly state: WalletState;
  readonly landing: LandingContext;
  readonly policy?: Policy;
}

interface Slot {
  readonly entry: PromptEntry;
  ready: boolean;
  returned: boolean;
  deferred: boolean;
  dropped: boolean;
}

interface Waiter {
  readonly kind: PromptKind | undefined;
  readonly take: (prompt: Prompt) => void;
}

export class PromptQueue {
  private policy: Policy;
  private readonly state: WalletState;
  private readonly landing: LandingContext;
  private readonly slots: Slot[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<(prompt: Prompt) => void>();
  private readonly failures: unknown[] = [];

  constructor({ state, landing, policy = 'approve' }: QueueOptions) {
    this.state = state;
    this.landing = landing;
    this.policy = policy;
  }

  add<K extends PromptKind>(input: PromptInput<K>): PromptRef<K> {
    const entry = new PromptEntry(`p${this.slots.length + 1}`, input, {
      state: this.state,
      landing: this.landing,
      onAnswer: (prompt) => this.notify(prompt),
    });
    const slot: Slot = {
      entry,
      ready: false,
      returned: false,
      deferred: false,
      dropped: false,
    };
    this.slots.push(slot);
    Promise.all([input.fields, input.blocked]).then(
      ([fields, blocked]) => this.reveal(slot, fields, blocked),
      (error: unknown) => this.drop(slot, error),
    );
    return { id: entry.id, kind: input.kind };
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  nextPrompt<K extends PromptKind = PromptKind>(
    kind?: K,
    { timeoutMs = 10_000, signal }: WaitOptions = {},
  ): Promise<PromptOf<K>> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter);
        settle();
      };
      const waiter: Waiter = {
        kind,
        take: (prompt) => finish(() => resolve(prompt as PromptOf<K>)),
      };
      const abort = () => finish(() => reject(signal?.reason));
      const timer = setTimeout(
        () => finish(() => reject(this.noPrompt(kind, timeoutMs))),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (!this.give(waiter)) this.waiters.add(waiter);
    });
  }

  prompts<K extends PromptKind = PromptKind>(kind?: K): readonly PromptOf<K>[] {
    return this.slots.flatMap(({ entry: { prompt } }) =>
      prompt && matches(prompt.kind, kind) ? [prompt as PromptOf<K>] : [],
    );
  }

  subscribe(listener: (prompt: Prompt) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resume(): void {
    for (const slot of this.slots) {
      if (slot.deferred && slot.entry.status === 'pending') {
        slot.deferred = false;
        void this.run(slot);
      }
    }
  }

  unanswered(): readonly PromptRef[] {
    return this.slots.flatMap(({ entry, dropped }) =>
      !dropped && entry.status === 'pending'
        ? [{ id: entry.id, kind: entry.kind }]
        : [],
    );
  }

  errors(): readonly unknown[] {
    return [...this.failures];
  }

  private reveal(
    slot: Slot,
    fields: PromptFields[PromptKind],
    blocked: Exclude<BlockedReason, 'locked'> | null,
  ): void {
    this.notify(slot.entry.reveal(fields, blocked));
    void this.run(slot).finally(() => {
      slot.ready = true;
      this.serve();
    });
  }

  private drop(slot: Slot, error: unknown): void {
    slot.dropped = true;
    this.failures.push(error);
    slot.entry
      .answer({ action: 'fail', code: -1 })
      .catch((failure: unknown) => this.failures.push(failure));
    this.serve();
  }

  private async run(slot: Slot): Promise<void> {
    const { entry } = slot;
    const prompt = entry.prompt;
    if (!prompt) return;
    if (this.state.locked) {
      slot.deferred = true;
      return;
    }
    try {
      const decision = await decide(this.policy, prompt);
      if (decision === null || entry.status !== 'pending') return;
      if (this.state.locked) {
        slot.deferred = true;
        return;
      }
      const onMainnet = this.state.network.name === 'mainnet';
      entry
        .answer(automatic(decision, prompt, onMainnet))
        .catch((error: unknown) => this.failures.push(error));
    } catch (error) {
      this.failures.push(error);
    }
  }

  private serve(): void {
    for (const waiter of [...this.waiters]) this.give(waiter);
  }

  private give(waiter: Waiter): boolean {
    const slot = this.slots.find(
      ({ entry, returned, dropped }) =>
        !returned && !dropped && matches(entry.kind, waiter.kind),
    );
    const prompt = slot?.ready ? slot.entry.prompt : null;
    if (!slot || !prompt) return false;
    slot.returned = true;
    waiter.take(prompt);
    return true;
  }

  private notify(prompt: Prompt): void {
    for (const listener of this.listeners) {
      try {
        listener(prompt);
      } catch (error) {
        this.failures.push(error);
      }
    }
  }

  private noPrompt(
    kind: PromptKind | undefined,
    timeoutMs: number,
  ): StardustError {
    const arrived = this.slots
      .filter(({ dropped }) => !dropped)
      .map(({ entry, returned }) => {
        const status = entry.prompt ? entry.status : 'decoding';
        const note = returned ? ', returned by an earlier nextPrompt' : '';
        return `    ${entry.id} ${entry.kind} (${status}${note})`;
      });
    return new StardustError(
      'NO_PROMPT',
      [
        `no ${kind ? `${kind} ` : ''}prompt within ${timeoutMs / 1000}s`,
        ...(arrived.length > 0
          ? ['  Prompts in this test:', ...arrived]
          : ['  No prompts arrived in this test.']),
        '  Check that the test makes the app ask the wallet, or pass a longer timeoutMs.',
      ].join('\n'),
    );
  }
}

function matches(kind: PromptKind, wanted: PromptKind | undefined): boolean {
  return wanted === undefined || kind === wanted;
}
