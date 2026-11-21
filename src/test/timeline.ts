import { inspect } from 'node:util';
import { Networks } from '@stellar/stellar-sdk';
import { formatXlm } from '@/amounts';
import { assetContract } from '@/network/events';
import type { BalanceChange, ContractEvent } from '@/network/events';
import type { Landed } from '@/network/landing';
import type { DecodedOperation, Invocation } from '@/wallet/decode';
import type {
  BlockedReason,
  Prompt,
  PromptKind,
  PromptStatus,
} from '@/wallet/prompts';
import type { ViolationKind } from '@/wallet/strict';
import type { Wallet } from '@/wallet/emulated';

export interface PageRequest {
  url(): string;
  method(): string;
  postData(): string | null;
  timing(): { readonly startTime: number; readonly responseEnd: number };
  failure(): { readonly errorText: string } | null;
  response(): Promise<{ json(): Promise<unknown> } | null>;
}

interface Moment {
  readonly at: number;
  readonly user: string;
}

export type TimelineEntry = Moment &
  (
    | {
        readonly type: 'prompt';
        readonly id: string;
        readonly kind: PromptKind;
        readonly origin: string;
        readonly summary: string;
        readonly status: PromptStatus;
        readonly blocked: BlockedReason | null;
        readonly answeredAfterMs: number | null;
      }
    | { readonly type: 'read'; readonly method: string }
    | {
        readonly type: 'rpc';
        readonly method: string;
        readonly durationMs: number | null;
        readonly status: string | null;
        readonly hash: string | null;
        readonly error: string | null;
      }
    | {
        readonly type: 'landed';
        readonly promptId: string;
        readonly networkPassphrase: string | null;
        readonly outcome: Landed | null;
        readonly explorer: string | null;
        readonly error: string | null;
      }
    | {
        readonly type: 'violation';
        readonly promptId: string | null;
        readonly kind: ViolationKind;
        readonly detail: string;
      }
  );

type Entry<T extends TimelineEntry['type']> = Extract<
  TimelineEntry,
  { type: T }
>;

interface Stamp {
  readonly at: number;
  readonly order: number;
}

interface Stamped {
  readonly order: number;
  readonly entry: TimelineEntry;
}

interface PromptRecord {
  readonly stamp: Stamp;
  readonly user: string;
  readonly prompt: Prompt;
  answeredAt: number | null;
  signedFor: string | null;
  landed: { readonly stamp: Stamp; readonly result: Landed | Error } | null;
}

interface Watched {
  readonly wallet: Wallet;
  readonly rpcUrl: string;
  seen: number;
}

const reads: Readonly<Record<string, string>> = {
  REQUEST_CONNECTION_STATUS: 'isConnected',
  REQUEST_ALLOWED_STATUS: 'isAllowed',
  REQUEST_PUBLIC_KEY: 'getAddress',
  REQUEST_NETWORK_DETAILS: 'getNetworkDetails',
  REQUEST_NETWORK: 'getNetwork',
  REQUEST_USER_INFO: 'getUserInfo',
  DISCONNECT: 'disconnect',
  getAddress: 'getAddress',
  getNetwork: 'getNetwork',
};

const owners = new WeakMap<
  Prompt,
  { readonly record: PromptRecord; readonly stamp: () => Stamp }
>();

export class Timeline {
  readonly startedAt = Date.now();
  private readonly records: PromptRecord[] = [];
  private readonly events: Stamped[] = [];
  private readonly watched = new Map<string, Watched>();
  private readonly reading = new Set<Promise<void>>();
  private order = 0;

  watch(user: string, wallet: Wallet): void {
    this.watched.set(user, { wallet, rpcUrl: wallet.network.rpcUrl, seen: 0 });
    wallet.subscribe((prompt) => this.observe(user, wallet, prompt));
  }

  // The host calls this right after the wallet starts handling the message,
  // so any violation the message caused is already recorded.
  call(user: string, payload: unknown): void {
    const method = readOf(payload);
    if (method) this.push({ at: this.now(), user, type: 'read', method });
    this.scan(user);
  }

  request(user: string, request: PageRequest): void {
    const rpcUrl = this.watched.get(user)?.rpcUrl;
    if (!rpcUrl || request.method() !== 'POST') return;
    if (endpoint(request.url()) !== endpoint(rpcUrl)) return;
    const method = text(field(json(request.postData()), 'method'));
    if (!method) return;
    const { startTime, responseEnd } = request.timing();
    const order = this.order++;
    const call = {
      at: Math.max(Math.round(startTime - this.startedAt), 0),
      user,
      type: 'rpc',
      method,
      durationMs: responseEnd >= 0 ? Math.round(responseEnd) : null,
    } as const;
    const failure = request.failure();
    const reply = failure
      ? Promise.resolve({ status: null, hash: null, error: failure.errorText })
      : request
          .response()
          .then((response) => response?.json())
          .catch(() => null)
          .then(rpcReply);
    this.track(
      reply.then((fields) => this.push({ ...call, ...fields }, order)),
    );
  }

  async settled(): Promise<void> {
    await Promise.all(this.reading);
  }

  async entries(): Promise<TimelineEntry[]> {
    await this.settled();
    for (const user of this.watched.keys()) this.scan(user);
    return [...this.records.flatMap(promptEntries), ...this.events]
      .sort((a, b) => a.entry.at - b.entry.at || a.order - b.order)
      .map(({ entry }) => entry);
  }

  private observe(user: string, wallet: Wallet, prompt: Prompt): void {
    const record = owners.get(prompt)?.record ?? this.add(user, prompt);
    if (record.answeredAt === null && prompt.status !== 'pending') {
      record.answeredAt = this.now();
      if (prompt.status === 'approved') {
        record.signedFor = wallet.network.networkPassphrase;
      }
    }
    this.scan(user);
  }

  private add(user: string, prompt: Prompt): PromptRecord {
    const record: PromptRecord = {
      stamp: this.stamp(),
      user,
      prompt,
      answeredAt: null,
      signedFor: null,
      landed: null,
    };
    this.records.push(record);
    owners.set(prompt, { record, stamp: () => this.stamp() });
    return record;
  }

  private scan(user: string): void {
    const watched = this.watched.get(user);
    if (!watched) return;
    const violations = watched.wallet.violations();
    for (const { promptId, kind, detail } of violations.slice(watched.seen)) {
      this.push({
        at: this.now(),
        user,
        type: 'violation',
        promptId,
        kind,
        detail,
      });
    }
    watched.seen = violations.length;
  }

  private push(entry: TimelineEntry, order = this.order++): void {
    this.events.push({ order, entry });
  }

  private track(task: Promise<void>): void {
    this.reading.add(task);
    void task.finally(() => this.reading.delete(task));
  }

  private stamp(): Stamp {
    return { at: this.now(), order: this.order++ };
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }
}

export function recordLanded(prompt: Prompt, result: Landed | Error): void {
  const owner = owners.get(prompt);
  if (!owner) return;
  const { record } = owner;
  if (record.landed && !(record.landed.result instanceof Error)) return;
  record.landed = { stamp: owner.stamp(), result };
}

export function signedNetwork(prompt: Prompt): string | null {
  return owners.get(prompt)?.record.signedFor ?? null;
}

export function renderTimeline(entries: readonly TimelineEntry[]): string {
  if (entries.length === 0) return 'Timeline: nothing reached the wallet.';
  const rows = entries.map((entry) => ({
    entry,
    time: `${seconds(entry.at)}s`,
    lines: describe(entry),
  }));
  const timeWidth = Math.max(...rows.map(({ time }) => time.length));
  const userWidth = Math.max(...entries.map(({ user }) => user.length));
  const lines = rows.flatMap(
    ({ entry, time, lines: [label, first, ...more] }) => {
      const head = `  ${time.padStart(timeWidth)}  ${entry.user.padEnd(userWidth)}  ${label.padEnd(16)}  `;
      const indent = ' '.repeat(head.length);
      return [
        `${head}${first ?? ''}`.trimEnd(),
        ...more.map((line) => indent + line),
      ];
    },
  );
  return ['Timeline:', ...lines].join('\n');
}

export function timelineJson(
  entries: readonly TimelineEntry[],
  startedAt: number,
): string {
  const file = { startedAt: new Date(startedAt).toISOString(), entries };
  const json = JSON.stringify(
    file,
    (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    2,
  );
  return `${json}\n`;
}

export function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

export function xlmAmount(stroops: bigint): string {
  return `${formatXlm(stroops).replace(/\.?0+$/, '')} XLM`;
}

function promptEntries(record: PromptRecord): Stamped[] {
  const { stamp, user, prompt, answeredAt, signedFor, landed } = record;
  const entry: TimelineEntry = {
    at: stamp.at,
    user,
    type: 'prompt',
    id: prompt.id,
    kind: prompt.kind,
    origin: prompt.origin,
    summary: summarize(prompt),
    status: prompt.status,
    blocked: prompt.blocked,
    answeredAfterMs: answeredAt === null ? null : answeredAt - stamp.at,
  };
  if (!landed) return [{ order: stamp.order, entry }];
  const { result } = landed;
  const outcome = result instanceof Error ? null : result;
  return [
    { order: stamp.order, entry },
    {
      order: landed.stamp.order,
      entry: {
        at: landed.stamp.at,
        user,
        type: 'landed',
        promptId: prompt.id,
        networkPassphrase: signedFor,
        outcome,
        explorer:
          outcome && signedFor === Networks.TESTNET
            ? `https://stellar.expert/explorer/testnet/tx/${outcome.hash}`
            : null,
        error: result instanceof Error ? result.message : null,
      },
    },
  ];
}

function describe(entry: TimelineEntry): [string, ...string[]] {
  switch (entry.type) {
    case 'prompt':
      return [entry.kind, promptLine(entry)];
    case 'read':
      return [entry.method];
    case 'rpc':
      return [entry.method, rpcLine(entry)];
    case 'landed':
      return ['landed', ...landedLines(entry)];
    case 'violation':
      return [
        'violation',
        `${entry.promptId ? `${entry.promptId} ` : ''}${entry.kind}`,
      ];
  }
}

function promptLine(entry: Entry<'prompt'>): string {
  const { kind, origin, summary, status, blocked, answeredAfterMs } = entry;
  const after = answeredAfterMs === null ? '0.0' : seconds(answeredAfterMs);
  const answer = [
    status,
    blocked ? ` (${blocked})` : '',
    after === '0.0' ? '' : ` after ${after}s`,
  ].join('');
  return kind === 'connect'
    ? `${answer} (${URL.parse(origin)?.hostname || origin})`
    : `${summary}  ${answer}`;
}

function rpcLine({ method, durationMs, status, hash, error }: Entry<'rpc'>) {
  if (error) return `failed: ${error}`;
  if (method === 'sendTransaction') {
    return [status ?? 'no status', hash && `${hash.slice(0, 8)}…`]
      .filter(Boolean)
      .join('  ');
  }
  return durationMs === null ? '' : `${durationMs}ms`;
}

function landedLines(entry: Entry<'landed'>): string[] {
  const { outcome, explorer, error, networkPassphrase } = entry;
  if (!outcome) return [`UNKNOWN  ${error?.split('\n')[0] ?? ''}`];
  const where = explorer ?? outcome.hash;
  if (outcome.status === 'failed') {
    const { ledger, resultCode, contractError } = outcome;
    return [
      `FAILED   ${where}`,
      `ledger ${ledger}, ${resultCode}`,
      ...(contractError
        ? [
            `contract error: ${contractError.name ?? 'unnamed'} (${short(contractError.contract)}, #${contractError.code})`,
          ]
        : []),
    ];
  }
  const native =
    networkPassphrase && assetContract('native', networkPassphrase);
  return [
    `SUCCESS  ${where}`,
    `ledger ${outcome.ledger}`,
    ...outcome.balanceChanges.map((change) => balanceLine(change, native)),
    ...outcome.events.map(eventLine),
  ];
}

function balanceLine(
  { address, asset, change }: BalanceChange,
  native: string | null,
): string {
  const sign = change > 0n ? '+' : '';
  const amount =
    asset === native
      ? `${sign}${xlmAmount(change)}`
      : `${sign}${change} ${short(asset)}`;
  return `balance  ${short(address)}  ${amount}`;
}

function eventLine({ contract, topics: [name] }: ContractEvent): string {
  return `event    ${short(contract)}  ${typeof name === 'string' ? name : display(name)}`;
}

function summarize(prompt: Prompt): string {
  switch (prompt.kind) {
    case 'connect':
      return '';
    case 'signTransaction': {
      const [call] = prompt.transaction.invocations;
      return call
        ? invocation(call)
        : prompt.transaction.operations.map(operation).join(', ');
    }
    case 'signAuthEntry': {
      const [call] = prompt.preimage.invocations;
      return call ? invocation(call) : 'auth entry';
    }
    case 'signMessage':
      return JSON.stringify(
        prompt.message.length > 40
          ? `${prompt.message.slice(0, 40)}…`
          : prompt.message,
      );
    case 'addToken':
      return short(prompt.contractId);
  }
}

function invocation({ contract, fn, args, namedArgs }: Invocation): string {
  const listed = namedArgs
    ? Object.entries(namedArgs).map(
        ([name, value]) => `${name}: ${display(value)}`,
      )
    : args.map(display);
  return `${short(contract)}.${fn}(${listed.join(', ')})`;
}

function operation({ type, body }: DecodedOperation): string {
  const fields = Object.entries(body)
    .filter(([, value]) =>
      ['string', 'bigint', 'number', 'boolean'].includes(typeof value),
    )
    .map(([name, value]) => `${name}: ${display(value)}`);
  return `${type}(${fields.join(', ')})`;
}

function display(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    return value.replace(/\b(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})\b/g, short);
  }
  return inspect(value, {
    breakLength: Infinity,
    depth: 1,
    maxArrayLength: 5,
    maxStringLength: 40,
  });
}

function readOf(payload: unknown): string | null {
  const name = text(field(payload, 'type')) ?? text(field(payload, 'method'));
  return name !== null && Object.hasOwn(reads, name)
    ? (reads[name] ?? null)
    : null;
}

function rpcReply(body: unknown) {
  const result = field(body, 'result');
  return {
    status: text(field(result, 'status')),
    hash: text(field(result, 'hash')),
    error: text(field(field(body, 'error'), 'message')),
  };
}

function endpoint(url: string): string | null {
  const parsed = URL.parse(url);
  return parsed && `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function json(body: string | null): unknown {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
