import { inspect } from 'node:util';
import { StardustError } from '@/errors';
import type { PromptRef } from '@/wallet/prompts';

export type ViolationKind =
  | 'missingNetworkPassphrase'
  | 'networkMismatch'
  | 'invalidXdr'
  | 'signerMismatch'
  | 'unknownMessage';

export interface Violation {
  readonly promptId: string | null;
  readonly kind: ViolationKind;
  readonly detail: string;
}

export type WalletKind = 'varial' | 'sep60';

interface Recorded {
  readonly prompt: PromptRef | null;
  readonly kind: ViolationKind;
  readonly detail: string;
}

const show = (value: unknown) => inspect(value, { breakLength: Infinity });

export class Violations {
  private recorded: Recorded[] = [];

  list(): readonly Violation[] {
    return this.recorded.map(({ prompt, kind, detail }) => ({
      promptId: prompt?.id ?? null,
      kind,
      detail,
    }));
  }

  missingNetworkPassphrase(prompt: PromptRef, walletPassphrase: string): void {
    this.recorded = this.recorded.filter(
      (violation) => !isFor(violation, prompt, 'networkMismatch'),
    );
    this.record(prompt, 'missingNetworkPassphrase', [
      `The app sent ${prompt.kind} without networkPassphrase, so Varial reads it as mainnet.`,
      `Pass the passphrase of the wallet's network, "${walletPassphrase}".`,
    ]);
  }

  networkMismatch(
    prompt: PromptRef,
    asked: string | null,
    walletPassphrase: string,
    wallet: WalletKind,
  ): void {
    const missing = this.recorded.some((violation) =>
      isFor(violation, prompt, 'missingNetworkPassphrase'),
    );
    if (missing) return;
    const action = prompt.kind === 'addToken' ? 'add a token on' : 'sign for';
    this.record(prompt, 'networkMismatch', [
      `The app asked to ${action} ${asked === null ? 'an unknown network' : `"${asked}"`},`,
      `but the wallet is on "${walletPassphrase}".`,
      `${wallet === 'varial' ? 'Varial refuses' : 'A real wallet refuses'} this, so Stardust refused it too.`,
    ]);
  }

  invalidXdr(prompt: PromptRef | null, field: string, cause: unknown): void {
    const reason = cause instanceof Error ? cause.message : String(cause);
    this.record(prompt, 'invalidXdr', [
      `The app sent a ${field} that isn't valid XDR: ${reason}.`,
      'Send it as base64 XDR, for example from toXDR().',
    ]);
  }

  signerMismatch(prompt: PromptRef, signer: string, account: string): void {
    this.record(prompt, 'signerMismatch', [
      `The app asked for a signature from ${signer},`,
      `but the wallet signs with ${account}.`,
      'Use the address the wallet reports from getAddress().',
    ]);
  }

  unknownMessage(type: unknown): void {
    this.record(null, 'unknownMessage', [
      `The app sent a message of type ${show(type)}, which Varial doesn't recognize.`,
      'Use a message type that @stellar/freighter-api or @stellar/varial-sdk sends.',
    ]);
  }

  report(): StardustError | null {
    if (this.recorded.length === 0) return null;
    const entries = this.recorded.map(({ prompt, kind, detail }) =>
      [
        `  ${prompt ? `${prompt.id} ${prompt.kind}  ` : ''}${kind}`,
        ...detail.split('\n').map((line) => `  ${line}`),
      ].join('\n'),
    );
    return new StardustError(
      'PROTOCOL_VIOLATION',
      `Stardust: ${count(this.recorded.length, 'protocol violation')} in this test\n${entries.join('\n\n')}`,
    );
  }

  private record(
    prompt: PromptRef | null,
    kind: ViolationKind,
    lines: readonly string[],
  ): void {
    this.recorded.push({ prompt, kind, detail: lines.join('\n') });
  }
}

export function pendingReport(
  prompts: readonly PromptRef[],
): StardustError | null {
  if (prompts.length === 0) return null;
  return new StardustError(
    'PROMPTS_PENDING',
    [
      `Stardust: test ended with ${count(prompts.length, 'unanswered prompt')}`,
      ...prompts.map(({ id, kind }) => `  ${id} ${kind} (pending)`),
      '  Call approve(), reject(), fail() or hang() before the test ends.',
    ].join('\n'),
  );
}

function isFor(
  violation: Recorded,
  prompt: PromptRef,
  kind: ViolationKind,
): boolean {
  return violation.prompt?.id === prompt.id && violation.kind === kind;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
