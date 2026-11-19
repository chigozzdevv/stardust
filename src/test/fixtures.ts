import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { inspect } from 'node:util';
import { test as base } from '@playwright/test';
import type {
  BrowserContext,
  BrowserContextOptions,
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
  TestType,
} from '@playwright/test';
import { loadConfig, parseTestOptions } from '@/config/config';
import type { LoadedConfig } from '@/config/config';
import type { TestOptions } from '@/config/schema';
import { ContractSpecs } from '@/contracts/spec';
import { StardustError } from '@/errors';
import { createAccounts, mergeAccounts } from '@/funding/accounts';
import type { Account, AccountOptions } from '@/funding/accounts';
import { Funder } from '@/funding/funder';
import type { FundingContext, SubFunder } from '@/funding/funder';
import { Rpc, checkNetwork, resolveNetwork } from '@/network/network';
import { findWalletsKit, kitSession } from '@/protocols/wallets-kit';
import type { WalletsKit } from '@/protocols/wallets-kit';
import { pageHost } from '@/test/host';
import { Timeline, renderTimeline, short, timelineJson } from '@/test/timeline';
import type { Policy } from '@/wallet/policy';
import type { PromptKind, WaitOptions } from '@/wallet/prompts';
import { EmulatedWallet } from '@/wallet/wallet';
import type { Wallet } from '@/wallet/wallet';

export interface StardustTestOptions {
  users: Readonly<Record<string, UserOptions>>;
}

export interface UserOptions {
  wallet?: 'varial' | 'sep60' | 'none';
  connected?: boolean;
  policy?: Policy;
  accounts?: Readonly<Record<string, AccountOptions>>;
  allowHttp?: boolean;
  strict?: boolean;
}

export interface User {
  readonly name: string;
  readonly page: Page;
  readonly wallet: Wallet;
  readonly account: Account;
  readonly accounts: Readonly<Record<string, Account>>;
}

export type Users = Readonly<Record<string, User>>;

type Declared = TestOptions['users'][string];

interface Environment {
  readonly config: LoadedConfig;
  readonly context: FundingContext;
  readonly kit: WalletsKit | null;
}

interface Plan {
  readonly name: string;
  readonly options: Declared;
  readonly accounts: Readonly<Record<string, Account>>;
}

interface Opened {
  readonly user: User;
  readonly wallet: EmulatedWallet;
}

interface Report {
  timeline: Timeline | null;
  readonly problems: unknown[];
}

interface Fixtures {
  stardust: StardustTestOptions;
  users: Users;
}

interface InternalFixtures extends Fixtures {
  _stardustOptions: TestOptions;
  _stardustReport: Report;
}

interface WorkerFixtures {
  _stardustWorker: StardustWorker;
}

type StardustTest = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & Fixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

const send = globalThis.fetch.bind(globalThis);
const defaultAccounts: NonNullable<Declared['accounts']> = { main: {} };

class StardustWorker {
  private environment: Promise<Environment> | null = null;
  private funding: Promise<SubFunder> | null = null;

  constructor(private readonly projectDir: string) {}

  ready(): Promise<Environment> {
    this.environment ??= prepare(this.projectDir);
    return this.environment;
  }

  subFunder(): Promise<SubFunder> {
    this.funding ??= this.ready().then(({ context }) =>
      new Funder(context, { fetch: send }).createSubFunder(),
    );
    return this.funding;
  }

  async release(): Promise<void> {
    const subFunder = await this.funding?.catch(() => null);
    await subFunder?.release().catch(warn);
  }
}

export const test: StardustTest = base.extend<InternalFixtures, WorkerFixtures>(
  {
    stardust: [{ users: {} }, { option: true }],

    _stardustOptions: [
      async ({ stardust }, use, testInfo) => {
        await use(parseTestOptions(specFile(testInfo.file), stardust));
      },
      { box: true },
    ],

    _stardustReport: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, testInfo) => {
        const report: Report = { timeline: null, problems: [] };
        await use(report);
        if (report.timeline && testInfo.status !== testInfo.expectedStatus) {
          await printReport(report.timeline, report.problems, testInfo);
        }
      },
      { box: true },
    ],

    _stardustWorker: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const worker = new StardustWorker(process.cwd());
        await use(worker);
        await worker.release();
      },
      { scope: 'worker', box: true },
    ],

    users: async (
      {
        _stardustOptions: options,
        _stardustReport: report,
        _stardustWorker: worker,
        browser,
        baseURL,
      },
      use,
      testInfo,
    ) => {
      const file = specFile(testInfo.file);
      if (Object.keys(options.users).length === 0) {
        await use(usersView({}, file));
        return;
      }
      const environment = await worker.ready();
      const subFunder = await worker.subFunder();
      const created = await base.step('Stardust: create accounts', () =>
        createAccounts(subFunder, accountOptions(options)),
      );
      const timeline = new Timeline();
      report.timeline = timeline;
      const contexts: BrowserContext[] = [];
      try {
        const opened: Opened[] = [];
        for (const plan of plans(options, created)) {
          const context = await browser.newContext(
            contextOptions(plan, environment, baseURL),
          );
          contexts.push(context);
          opened.push(await openUser(plan, context, environment, timeline));
        }
        await use(
          usersView(
            Object.fromEntries(opened.map(({ user }) => [user.name, user])),
            file,
          ),
        );
        const problems = opened.flatMap(({ wallet }) => wallet.endOfTest());
        await timeline.settled();
        if (problems.length > 0) {
          report.problems.push(...problems.slice(1));
          throw problems[0];
        }
      } finally {
        await Promise.all(contexts.map((context) => context.close()));
        await base
          .step('Stardust: merge accounts', () =>
            mergeAccounts(subFunder, created),
          )
          .catch(warn);
      }
    },
  },
);

export function specFile(file: string): string {
  return relative(process.cwd(), file);
}

export function usersView(users: Users, file: string): Users {
  return new Proxy(users, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key === 'then' || key in target) {
        return Reflect.get(target, key, receiver);
      }
      throw new StardustError(
        'CONFIG_INVALID',
        `${file}\n  The test uses users.${key}, but this file ${declared(key, Object.keys(target))}`,
      );
    },
  });
}

async function prepare(projectDir: string): Promise<Environment> {
  const config = await loadConfig(projectDir);
  const rpc = new Rpc(resolveNetwork(config.network), send);
  const network = await checkNetwork(rpc);
  return {
    config,
    context: { rpc, specs: new ContractSpecs(rpc), network },
    kit: findWalletsKit(projectDir),
  };
}

function accountOptions({ users }: TestOptions): AccountOptions[] {
  return Object.values(users).flatMap((user) =>
    Object.values(user.accounts ?? defaultAccounts).map(({ fund }) =>
      fund === undefined ? {} : { fund },
    ),
  );
}

function plans({ users }: TestOptions, created: readonly Account[]): Plan[] {
  let next = 0;
  return Object.entries(users).map(([name, options]) => ({
    name,
    options,
    accounts: Object.fromEntries(
      Object.keys(options.accounts ?? defaultAccounts).map((account) => [
        account,
        created[next++] as Account,
      ]),
    ),
  }));
}

function contextOptions(
  { options, accounts }: Plan,
  { config, kit }: Environment,
  baseURL: string | undefined,
): BrowserContextOptions {
  const [account] = Object.values(accounts);
  const wallet = options.wallet ?? 'varial';
  const session =
    kit && account && options.connected && wallet === 'varial'
      ? kitSession(kit, config.app.url, account.address)
      : null;
  return {
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(session ? { storageState: { cookies: [], origins: [session] } } : {}),
  };
}

async function openUser(
  { name, options, accounts }: Plan,
  context: BrowserContext,
  { context: landing }: Environment,
  timeline: Timeline,
): Promise<Opened> {
  const {
    wallet: kind = 'varial',
    connected = false,
    policy = 'approve',
    strict = true,
    allowHttp = true,
  } = options;
  const owned = Object.values(accounts);
  const wallet = new EmulatedWallet(
    { accounts: owned, connected, policy, strict, allowHttp },
    { network: landing.network, landing, fetch: send },
  );
  timeline.watch(name, wallet);
  if (kind !== 'none') {
    const host = pageHost(context, (payload) => timeline.call(name, payload));
    await wallet.attach(host, { wallet: kind });
  }
  context.on('requestfinished', (request) => timeline.request(name, request));
  context.on('requestfailed', (request) => timeline.request(name, request));
  const user: User = {
    name,
    page: await context.newPage(),
    wallet: withSteps(name, wallet),
    account: owned[0] as Account,
    accounts,
  };
  return { user, wallet };
}

function withSteps(user: string, wallet: Wallet): Wallet {
  const step = <T>(action: string, run: () => Promise<T>) =>
    base.step(`${user}: wallet.${action}`, run, { box: true });
  return {
    get address() {
      return wallet.address;
    },
    get network() {
      return wallet.network;
    },
    attach: (host, options) => wallet.attach(host, options),
    setPolicy: (policy) => wallet.setPolicy(policy),
    nextPrompt: <K extends PromptKind = PromptKind>(
      kind?: K,
      options?: WaitOptions,
    ) =>
      step(`nextPrompt(${kind ? `'${kind}'` : ''})`, () =>
        wallet.nextPrompt(kind, options),
      ),
    prompts: <K extends PromptKind = PromptKind>(kind?: K) =>
      wallet.prompts(kind),
    violations: () => wallet.violations(),
    subscribe: (listener) => wallet.subscribe(listener),
    switchAccount: (account) =>
      step(`switchAccount(${short(String(account?.address))})`, () =>
        wallet.switchAccount(account),
      ),
    switchNetwork: (network) =>
      step(`switchNetwork('${network}')`, () => wallet.switchNetwork(network)),
    lock: () => step('lock()', () => wallet.lock()),
    unlock: () => step('unlock()', () => wallet.unlock()),
    disconnect: () => step('disconnect()', () => wallet.disconnect()),
  };
}

async function printReport(
  timeline: Timeline,
  problems: readonly unknown[],
  testInfo: TestInfo,
): Promise<void> {
  const entries = await timeline.entries();
  const json = timelineJson(entries, timeline.startedAt);
  await writeFile(testInfo.outputPath('stardust-timeline.json'), json);
  await testInfo.attach('stardust-timeline', {
    body: json,
    contentType: 'application/json',
  });
  const folder = relative(process.cwd(), testInfo.outputDir);
  // Printed under the test's errors by Playwright's reporters.
  testInfo.errors.push(
    ...problems.map((problem) => ({ message: describe(problem) })),
    {
      message: `${renderTimeline(entries)}\nScreenshot, trace and timeline: ${folder}/`,
    },
  );
}

function declared(key: string, names: readonly string[]): string {
  if (names.length === 0) {
    return `declares no users. Declare them with test.use({ stardust: { users: { ${key}: {} } } }).`;
  }
  const last = names.at(-1);
  const listed =
    names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
  return `declares only ${listed}.`;
}

function describe(problem: unknown): string {
  return problem instanceof Error
    ? `${problem.name}: ${problem.message}`
    : inspect(problem);
}

function warn(error: unknown): void {
  console.warn(describe(error));
}
