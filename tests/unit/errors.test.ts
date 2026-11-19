import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { StardustError } from '@/errors';
import type { StardustErrorCode } from '@/errors';

const retryable = {
  CONFIG_NOT_FOUND: false,
  CONFIG_INVALID: false,
  NETWORK_NOT_SUPPORTED: false,
  NETWORK_UNREACHABLE: true,
  MAINNET_REFUSED: false,
  APP_NOT_REACHABLE: false,
  FUNDING_FAILED: true,
  NO_PROMPT: false,
  ALREADY_ANSWERED: false,
  PROMPT_BLOCKED: false,
  WALLET_LOCKED: false,
  OUTCOME_UNKNOWN: true,
  UNKNOWN_ACCOUNT: false,
  UNSUPPORTED: false,
  PROTOCOL_VIOLATION: false,
  PROMPTS_PENDING: false,
} satisfies Record<StardustErrorCode, boolean>;

describe('StardustError', () => {
  it('keeps its code and message', () => {
    const error = new StardustError(
      'NO_PROMPT',
      'no signTransaction prompt within 10s',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StardustError);
    expect(error.code).toBe('NO_PROMPT');
    expect(error.message).toBe('no signTransaction prompt within 10s');
  });

  it.each(Object.entries(retryable))('%s retryable is %s', (code, expected) => {
    const error = new StardustError(code as StardustErrorCode, 'detail');
    expect(error.retryable).toBe(expected);
  });

  it('keeps the cause', () => {
    const cause = new TypeError('fetch failed');
    const error = new StardustError('NETWORK_UNREACHABLE', 'no answer', {
      cause,
    });
    expect(error.cause).toBe(cause);
  });

  it('prints like the examples in the spec', () => {
    const error = new StardustError(
      'CONFIG_INVALID',
      [
        'e2e/orders.spec.ts',
        "  users.maker.accounts.main.fund is '5000', but the maximum per account is '1000'.",
        "  Use '1000' or less, or spread the amount over several accounts.",
      ].join('\n'),
    );
    const printed = [
      'StardustError CONFIG_INVALID: e2e/orders.spec.ts',
      "  users.maker.accounts.main.fund is '5000', but the maximum per account is '1000'.",
      "  Use '1000' or less, or spread the amount over several accounts.",
    ].join('\n');

    expect(String(error)).toBe(printed);
    expect(error.stack?.startsWith(`${printed}\n    at `)).toBe(true);
    expect(inspect(error).startsWith(`${printed}\n    at `)).toBe(true);
  });
});
