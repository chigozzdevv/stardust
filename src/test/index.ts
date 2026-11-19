import { expect as base } from '@playwright/test';
import { matchers } from '@/test/matchers';

export { units, xlm } from '@/amounts';
export { test } from '@/test/fixtures';
export type { StardustTestOptions, User, UserOptions } from '@/test/fixtures';

export const expect = base.extend(matchers);
