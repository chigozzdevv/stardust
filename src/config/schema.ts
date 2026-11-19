import { inspect } from 'node:util';
import { z } from 'zod';
import { xlm } from '@/amounts';
import type { Policy } from '@/wallet/policy';
import type { Prompt } from '@/wallet/prompts';

interface Issue {
  readonly code?: string;
  readonly input?: unknown;
}

const maxFund = xlm('1000');
const promptKinds =
  'connect, signTransaction, signAuthEntry, signMessage or addToken';

const show = (value: unknown) => inspect(value, { breakLength: Infinity });

function messages(where: string) {
  const value = (allowed: string) => (issue: Issue) =>
    issue.input === undefined
      ? `is missing${where}`
      : `is ${show(issue.input)}${where}. ${allowed}`;
  const unknownKeys =
    (names: string, noun = 'a setting') =>
    (issue: Issue) =>
      issue.code === 'unrecognized_keys'
        ? `isn't ${noun}${where}. Use ${names}.`
        : undefined;
  const settings = (names: string, allowed: string) => (issue: Issue) =>
    unknownKeys(names)(issue) ?? value(allowed)(issue);
  return { value, unknownKeys, settings };
}

const inConfig = messages(' in stardust.config.ts');
const inTest = messages('');

function httpUrl(example: string) {
  const error = inConfig.value(
    `Use an http or https URL, such as '${example}'.`,
  );
  return z.string({ error }).refine(
    (value) => {
      const protocol = URL.parse(value)?.protocol;
      return protocol === 'http:' || protocol === 'https:';
    },
    { error },
  );
}

function text(allowed: string) {
  const error = inConfig.value(allowed);
  return z.string({ error }).min(1, { error });
}

export const stardustConfig = z.strictObject(
  {
    network: z.union(
      [
        z.literal('testnet'),
        z.strictObject(
          { rpcUrl: httpUrl('https://rpc-futurenet.stellar.org') },
          { error: inConfig.unknownKeys('rpcUrl') },
        ),
      ],
      { error: inConfig.value("Use 'testnet' or { rpcUrl }.") },
    ),
    app: z.strictObject(
      {
        url: httpUrl('http://localhost:3000'),
        start: text(
          "Use a command such as 'pnpm dev', or leave it out.",
        ).optional(),
      },
      {
        error: inConfig.settings(
          'url or start',
          "Use an object such as { url: 'http://localhost:3000', start: 'pnpm dev' }.",
        ),
      },
    ),
    tests: text(
      "Use a folder relative to the project folder, such as './e2e'.",
    ).optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? "isn't a setting in stardust.config.ts. Use network, app or tests."
        : issue.input === undefined
          ? 'stardust.config.ts has no default export. Use export default defineConfig({ ... }).'
          : `stardust.config.ts exports ${show(issue.input)}. Use export default defineConfig({ ... }).`,
  },
);

const flag = z.boolean({ error: inTest.value('Use true or false.') });

const policyMode = z.enum(['approve', 'reject', 'manual']);

const policy = z.union(
  [
    policyMode,
    z.strictObject(
      {
        connect: policyMode.exactOptional(),
        signTransaction: policyMode.exactOptional(),
        signAuthEntry: policyMode.exactOptional(),
        signMessage: policyMode.exactOptional(),
        addToken: policyMode.exactOptional(),
      },
      { error: inTest.unknownKeys(promptKinds, 'a prompt kind') },
    ),
    z.custom<Extract<Policy, (prompt: Prompt) => unknown>>(
      (value) => typeof value === 'function',
    ),
  ],
  {
    error: inTest.value(
      "Use 'approve', 'reject', 'manual', an object such as { signTransaction: 'manual' }, or a function.",
    ),
  },
);

const fund = z
  .union([z.boolean(), z.string()], {
    error: inTest.value("Use true, false or an amount in XLM such as '500'."),
  })
  .superRefine((value, context) => {
    if (typeof value === 'boolean') return;
    const stroops = toStroops(value);
    if (stroops === null) {
      context.addIssue({
        code: 'custom',
        message: `is ${show(value)}, which isn't an XLM amount.\nWrite an amount such as '10' or '10.5', or use true or false.`,
      });
    } else if (stroops > maxFund) {
      context.addIssue({
        code: 'custom',
        message: `is ${show(value)}, but the maximum per account is '1000'.\nUse '1000' or less, or spread the amount over several accounts.`,
      });
    }
  });

export const accountOptions = z.strictObject(
  { fund: fund.optional() },
  { error: inTest.settings('fund', "Use an object such as { fund: '500' }.") },
);

export const userOptions = z.strictObject(
  {
    wallet: z
      .enum(['varial', 'sep60', 'none'], {
        error: inTest.value("Use 'varial', 'sep60' or 'none'."),
      })
      .optional(),
    connected: flag.optional(),
    policy: policy.optional(),
    accounts: z
      .record(z.string(), accountOptions, {
        error: inTest.value(
          "Use an object of accounts by name, such as { main: { fund: '500' } }.",
        ),
      })
      .refine((accounts) => Object.keys(accounts).length > 0, {
        error: 'is {}. List at least one account, such as { main: {} }.',
      })
      .optional(),
    allowHttp: flag.optional(),
    strict: flag.optional(),
  },
  {
    error: inTest.settings(
      'wallet, connected, policy, accounts, allowHttp or strict',
      "Use an object such as { wallet: 'varial', connected: true }.",
    ),
  },
);

export const testOptions = z.strictObject(
  {
    users: z.record(z.string(), userOptions, {
      error: inTest.value(
        'Use an object of users by name, such as { trader: {} }.',
      ),
    }),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? "isn't a setting. Use users."
        : `stardust is ${show(issue.input)}. Use an object such as { users: { trader: {} } }.`,
  },
);

export type TestOptions = z.output<typeof testOptions>;

function toStroops(amount: string): bigint | null {
  try {
    return xlm(amount);
  } catch {
    return null;
  }
}
