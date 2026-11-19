import { inspect, isDeepStrictEqual } from 'node:util';
import { StardustError } from '@/errors';
import { assetContract } from '@/network/events';
import type { ContractError, Landed } from '@/network/landing';
import { recordLanded, short, signedNetwork, xlmAmount } from '@/test/timeline';
import type { DecodedOperation, Invocation } from '@/wallet/decode';
import type {
  AuthEntryPrompt,
  TransactionPrompt,
  WaitOptions,
} from '@/wallet/prompts';

export interface MatcherState {
  readonly isNot: boolean;
}

export interface MatcherResult {
  readonly pass: boolean;
  readonly message: () => string;
}

export interface InvokeExpectation {
  readonly contract: string;
  readonly fn: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface OperationExpectation {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface FailExpectation {
  readonly resultCode?: string;
  readonly contractError?: string | number;
}

export type BalanceExpectation =
  bigint | { readonly min?: bigint; readonly max?: bigint };

export interface EmitExpectation {
  readonly contract: string;
  readonly topic: string;
}

type SignedPrompt = TransactionPrompt | AuthEntryPrompt;
type Failed = Extract<Landed, { status: 'failed' }>;
type Row = readonly [label: string, value: string];

const show = (value: unknown) =>
  typeof value === 'string'
    ? value
    : inspect(value, { breakLength: Infinity, depth: 4 });

export const matchers = {
  toInvoke(
    this: MatcherState,
    prompt: SignedPrompt,
    expected: InvokeExpectation,
  ): MatcherResult {
    const header = `expect(prompt).${this.isNot ? 'not.' : ''}toInvoke(...)`;
    const checked = signed(prompt, 'toInvoke(...)');
    const calls =
      checked.kind === 'signTransaction'
        ? checked.transaction.invocations
        : checked.preimage.invocations;
    const { contract, fn, args } = expected;
    const candidates = calls.filter(
      (call) => call.contract === contract && call.fn === fn,
    );
    const match = candidates.find((call) => !args || sameArgs(call, args));
    if (!match && args && candidates.some(({ namedArgs }) => !namedArgs)) {
      throw new StardustError(
        'UNSUPPORTED',
        `${header} can't compare args: Stardust couldn't read the argument names of ${short(contract)}.${fn} from the contract's spec. Leave out args, or compare the positional args in the prompt's invocations.`,
      );
    }
    if (match) {
      return result(
        true,
        `${header}\n  Expected no call to ${short(contract)}.${fn}${args ? ' with these args' : ''}, but ${prompt.id} makes it at depth ${match.depth}.`,
      );
    }
    return result(false, details(header, invokeRows(calls, expected)));
  },

  toHaveOperation(
    this: MatcherState,
    prompt: TransactionPrompt,
    expected: OperationExpectation,
  ): MatcherResult {
    const header = `expect(prompt).${this.isNot ? 'not.' : ''}toHaveOperation(...)`;
    if (kindOf(prompt) !== 'signTransaction') {
      throw unsupported(
        'toHaveOperation(...)',
        prompt,
        'signTransaction prompts',
      );
    }
    const { type, ...fields } = expected;
    const { operations } = prompt.transaction;
    const ofType = operations.flatMap((operation, index) =>
      operation.type === type
        ? [{ index, differences: differences(operation, fields) }]
        : [],
    );
    const match = ofType.find(({ differences }) => differences.length === 0);
    if (match) {
      return result(
        true,
        `${header}\n  Expected no ${type} operation with these fields, but operation ${match.index + 1} of ${prompt.id} is one.`,
      );
    }
    const [closest] = ofType.sort(
      (a, b) => a.differences.length - b.differences.length,
    );
    const rows: Row[] = closest
      ? closest.differences.flatMap(({ name, expected, actual }) => [
          [`Expected ${name}`, show(expected)],
          [`Actual ${name}`, show(actual)],
        ])
      : [
          ['Expected operation', type],
          [
            'Actual operations',
            operations.map((operation) => operation.type).join(', ') || 'none',
          ],
        ];
    return result(false, details(header, rows));
  },

  async toLand(
    this: MatcherState,
    prompt: SignedPrompt,
    options?: WaitOptions,
  ): Promise<MatcherResult> {
    const header = waiting(this, 'toLand()', prompt);
    const landed = await land(header, prompt, options);
    if ('pass' in landed) return landed;
    if (landed.status === 'success') return result(true, header);
    return result(
      false,
      [
        `${header} failed: transaction FAILED`,
        ...failure(landed),
        `  ${transaction(landed)}`,
      ].join('\n'),
    );
  },

  async toFail(
    this: MatcherState,
    prompt: SignedPrompt,
    expected: FailExpectation = {},
    options?: WaitOptions,
  ): Promise<MatcherResult> {
    const call = Object.keys(expected).length > 0 ? 'toFail(...)' : 'toFail()';
    const header = waiting(this, call, prompt);
    const landed = await land(header, prompt, options);
    if ('pass' in landed) return landed;
    if (landed.status === 'success') {
      return result(
        false,
        `${header} failed: transaction SUCCESS\n  ${transaction(landed)}`,
      );
    }
    const { resultCode, contractError } = expected;
    const rows: Row[] = [];
    if (resultCode !== undefined && resultCode !== landed.resultCode) {
      rows.push(
        ['Expected result code', resultCode],
        ['Actual result code', landed.resultCode],
      );
    }
    if (
      contractError !== undefined &&
      !sameError(landed.contractError, contractError)
    ) {
      rows.push(
        ['Expected contract error', String(contractError)],
        [
          'Actual contract error',
          errorText(landed.contractError, contractError),
        ],
      );
    }
    if (rows.length === 0) return result(true, header);
    return result(false, details(header, rows, [transaction(landed)]));
  },

  async toChangeBalance(
    this: MatcherState,
    prompt: SignedPrompt,
    address: string,
    asset: string,
    change: BalanceExpectation,
    options?: WaitOptions,
  ): Promise<MatcherResult> {
    const header = waiting(
      this,
      `toChangeBalance(${short(address)}, ${shortAsset(asset)}, ${show(change)})`,
      prompt,
    );
    const landed = await land(header, prompt, options);
    if ('pass' in landed) return landed;
    if (landed.status === 'failed') {
      return result(
        false,
        `${header} failed: transaction FAILED (${landed.resultCode}), so no balance changed\n  ${transaction(landed)}`,
      );
    }
    const contract = tokenContract(asset, prompt);
    const actual =
      landed.balanceChanges.find(
        (moved) => moved.address === address && moved.asset === contract,
      )?.change ?? 0n;
    if (within(actual, change)) return result(true, header);
    return result(
      false,
      details(
        header,
        [
          ['Expected change', expectedChange(change, asset)],
          ['Actual change', amount(actual, asset)],
        ],
        [transaction(landed)],
      ),
    );
  },

  async toEmit(
    this: MatcherState,
    prompt: SignedPrompt,
    expected: EmitExpectation,
    options?: WaitOptions,
  ): Promise<MatcherResult> {
    const header = waiting(this, 'toEmit(...)', prompt);
    const landed = await land(header, prompt, options);
    if ('pass' in landed) return landed;
    if (landed.status === 'failed') {
      return result(
        false,
        `${header} failed: transaction FAILED (${landed.resultCode}), so it emitted no events\n  ${transaction(landed)}`,
      );
    }
    const { contract, topic } = expected;
    const emitted = landed.events.some(
      (event) => event.contract === contract && event.topics[0] === topic,
    );
    if (emitted) return result(true, header);
    const actual = landed.events
      .map(({ contract, topics: [name] }) => `${short(contract)} ${show(name)}`)
      .join(', ');
    return result(
      false,
      details(
        header,
        [
          ['Expected event', `${topic} from ${short(contract)}`],
          ['Actual events', actual || 'none'],
        ],
        [transaction(landed)],
      ),
    );
  },
};

function result(pass: boolean, message: string): MatcherResult {
  return { pass, message: () => message };
}

function details(
  header: string,
  rows: readonly Row[],
  notes: readonly string[] = [],
): string {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [
    header,
    ...rows.map(([label, value]) => `  ${`${label}:`.padEnd(width)}${value}`),
    ...notes.map((note) => `  ${note}`),
  ].join('\n');
}

function signed(prompt: unknown, call: string): SignedPrompt {
  const kind = kindOf(prompt);
  if (kind === 'signTransaction' || kind === 'signAuthEntry') {
    return prompt as SignedPrompt;
  }
  throw unsupported(call, prompt, 'signTransaction and signAuthEntry prompts');
}

function kindOf(prompt: unknown): unknown {
  return (prompt as { kind?: unknown } | null | undefined)?.kind;
}

function unsupported(call: string, prompt: unknown, works: string) {
  const { id, kind } = (prompt ?? {}) as { id?: unknown; kind?: unknown };
  const got =
    typeof id === 'string' && typeof kind === 'string'
      ? `${id} is a ${kind} prompt`
      : `it got ${show(prompt)}`;
  return new StardustError(
    'UNSUPPORTED',
    `expect(prompt).${call} works on ${works}, but ${got}.`,
  );
}

function waiting(state: MatcherState, call: string, prompt: unknown): string {
  if (state.isNot) {
    const name = call.slice(0, call.indexOf('('));
    throw new StardustError(
      'UNSUPPORTED',
      `expect(prompt).not.${name}() isn't supported: .not works only on checks that don't wait, such as toInvoke and toHaveOperation.${name === 'toLand' ? ' Use toFail() instead of .not.toLand().' : ''}`,
    );
  }
  signed(prompt, call);
  return `expect(prompt).${call}`;
}

async function land(
  header: string,
  prompt: SignedPrompt,
  options?: WaitOptions,
): Promise<Landed | MatcherResult> {
  try {
    const landed = await prompt.landed(options);
    recordLanded(prompt, landed);
    return landed;
  } catch (error) {
    if (prompt.status !== 'approved') {
      return result(false, `${header} failed: ${unsigned(prompt, options)}`);
    }
    recordLanded(
      prompt,
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  }
}

function unsigned(prompt: SignedPrompt, options?: WaitOptions): string {
  const label = `${prompt.id} ${prompt.kind}`;
  if (prompt.status === 'pending') {
    const seconds = (options?.timeoutMs ?? 30_000) / 1000;
    return `${label} is still pending after ${seconds}s, so nothing was signed. Answer it with approve(), or pass a longer timeoutMs.`;
  }
  return `${label} is ${prompt.status}, so nothing was signed and there's nothing to wait for.`;
}

function sameArgs(
  { namedArgs }: Invocation,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return (
    namedArgs !== null &&
    Object.entries(args).every(
      ([name, value]) =>
        Object.hasOwn(namedArgs, name) &&
        isDeepStrictEqual(namedArgs[name], value),
    )
  );
}

function invokeRows(
  calls: readonly Invocation[],
  { contract, fn, args = {} }: InvokeExpectation,
): Row[] {
  const onContract = calls.filter((call) => call.contract === contract);
  const sameFn = onContract.find((call) => call.fn === fn);
  if (sameFn) {
    const actual = Object.fromEntries(
      Object.keys(args).map((name) => [name, sameFn.namedArgs?.[name]]),
    );
    return [
      ['Expected args', show(args)],
      ['Actual args', show(actual)],
    ];
  }
  if (onContract.length > 0) {
    return [
      ['Expected function', fn],
      ['Actual function', unique(onContract.map((call) => call.fn))],
    ];
  }
  return [
    ['Expected contract', contract],
    [
      'Actual contracts',
      unique(calls.map((call) => call.contract)) ||
        'none, it calls no contract',
    ],
  ];
}

function differences(
  operation: DecodedOperation,
  fields: Readonly<Record<string, unknown>>,
) {
  return Object.entries(fields).flatMap(([name, expected]) => {
    const actual = name === 'source' ? operation.source : operation.body[name];
    return isDeepStrictEqual(actual, expected)
      ? []
      : [{ name, expected, actual }];
  });
}

function failure({ resultCode, contractError }: Failed): string[] {
  return [
    `  result code: ${resultCode}`,
    ...(contractError ? [`  contract error: ${errorName(contractError)}`] : []),
  ];
}

function sameError(
  actual: ContractError | null,
  expected: string | number,
): boolean {
  if (!actual) return false;
  return typeof expected === 'number'
    ? actual.code === expected
    : actual.name === expected;
}

function errorText(
  actual: ContractError | null,
  expected: string | number,
): string {
  if (!actual) {
    return "none: the RPC returned no diagnostic events, so the contract error isn't known";
  }
  if (actual.name === null && typeof expected === 'string') {
    return `${errorName(actual)}: the contract's spec couldn't be read, so the error has no name. Compare the number instead, toFail({ contractError: ${actual.code} })`;
  }
  return errorName(actual);
}

function errorName({ contract, code, name }: ContractError): string {
  return `${name ?? 'unnamed'} (${short(contract)}, #${code})`;
}

function transaction({ hash, ledger }: Landed): string {
  return `Transaction ${short(hash)} in ledger ${ledger}`;
}

function tokenContract(asset: string, prompt: SignedPrompt): string {
  if (asset !== 'native' && !asset.includes(':')) return asset;
  const passphrase =
    signedNetwork(prompt) ??
    (prompt.kind === 'signAuthEntry'
      ? prompt.preimage.networkPassphrase
      : null) ??
    prompt.networkPassphrase;
  if (passphrase === null) {
    throw new StardustError(
      'UNSUPPORTED',
      `expect(prompt).toChangeBalance() can't find the contract of ${asset}, because ${prompt.id} doesn't say which network it was signed for. Pass the token's contract ID ('C...') instead.`,
    );
  }
  return assetContract(asset, passphrase);
}

function within(actual: bigint, change: BalanceExpectation): boolean {
  if (typeof change === 'bigint') return actual === change;
  const { min, max } = change;
  return (
    (min === undefined || actual >= min) && (max === undefined || actual <= max)
  );
}

function expectedChange(change: BalanceExpectation, asset: string): string {
  if (typeof change === 'bigint') return amount(change, asset);
  const { min, max } = change;
  if (min !== undefined && max !== undefined) {
    return `between ${amount(min, asset)} and ${amount(max, asset)}`;
  }
  if (min !== undefined) return `at least ${amount(min, asset)}`;
  return max === undefined ? 'any amount' : `at most ${amount(max, asset)}`;
}

function amount(value: bigint, asset: string): string {
  return asset === 'native' ? `${value} (${xlmAmount(value)})` : `${value}`;
}

function shortAsset(asset: string): string {
  return asset.replace(/[GC][A-Z2-7]{55}/g, short);
}

function unique(values: readonly string[]): string {
  return [...new Set(values)].join(', ');
}
