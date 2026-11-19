import { inspect } from 'node:util';
import { StardustError } from '@/errors';
import type { Decision, Prompt, PromptKind } from '@/wallet/prompts';

export type PolicyMode = 'approve' | 'reject' | 'manual';

export type Policy =
  | PolicyMode
  | Partial<Record<PromptKind, PolicyMode>>
  | ((prompt: Prompt) => Decision | Promise<Decision>);

const modes = new Map<unknown, Decision | null>([
  ['approve', { action: 'approve' }],
  ['reject', { action: 'reject' }],
  ['manual', null],
]);

const show = (value: unknown) => inspect(value, { breakLength: Infinity });

export function decide(
  policy: Policy,
  prompt: Prompt,
): Decision | null | Promise<Decision> {
  if (typeof policy === 'function') {
    return Promise.resolve(policy(prompt)).then((decision) =>
      checked(decision, prompt),
    );
  }
  const mode =
    typeof policy === 'string' ? policy : (policy[prompt.kind] ?? 'approve');
  const decision = modes.get(mode);
  if (decision === undefined) {
    throw new StardustError(
      'CONFIG_INVALID',
      `the policy for ${prompt.kind} is ${show(mode)}. Use 'approve', 'reject' or 'manual'.`,
    );
  }
  return decision;
}

export function automatic(
  decision: Decision,
  prompt: Prompt,
  onMainnet: boolean,
): Decision {
  if (decision.action !== 'approve') return decision;
  const refused =
    prompt.blocked !== null || (onMainnet && prompt.kind !== 'connect');
  return refused ? { action: 'reject' } : decision;
}

function checked(decision: unknown, prompt: Prompt): Decision {
  if (isDecision(decision)) return decision;
  throw new StardustError(
    'CONFIG_INVALID',
    `the policy function returned ${show(decision)} for ${prompt.id} ${prompt.kind}. Return { action: 'approve' }, { action: 'reject' }, { action: 'fail', code: -1 | -2 | -3 } or { action: 'hang' }.`,
  );
}

function isDecision(value: unknown): value is Decision {
  if (typeof value !== 'object' || value === null) return false;
  const { action, code, message } = value as Record<string, unknown>;
  if (action === 'fail') {
    return (
      (code === -1 || code === -2 || code === -3) &&
      (message === undefined || typeof message === 'string')
    );
  }
  return action === 'approve' || action === 'reject' || action === 'hang';
}
