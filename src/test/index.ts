import { expect as base } from '@playwright/test';
import { matchers } from '@/test/matchers';

export { units, xlm } from '@/amounts';
export { test } from '@/test/fixtures';
export type {
  StardustTestOptions,
  User,
  UserOptions,
  UserWallet,
} from '@/test/fixtures';
export type {
  BalanceExpectation,
  EmitExpectation,
  FailExpectation,
  InvokeExpectation,
  OperationExpectation,
  StardustMatchers,
} from '@/test/matchers';

/**
 * Playwright's `expect`, with Stardust's checks on prompts: `toInvoke` and
 * `toHaveOperation` read what the app asked to sign, and `toLand`, `toFail`,
 * `toChangeBalance` and `toEmit` wait for the transaction's outcome.
 */
export const expect = base.extend(matchers);
