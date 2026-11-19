import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { test as base, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { format, resolveConfig } from 'prettier';
import { ContractSpecs } from '@/contracts/spec';
import type { Account } from '@/funding/accounts';
import { createStardust } from '@/index';
import type { Stardust } from '@/index';
import { Rpc, resolveNetwork } from '@/network/network';
import { pageHost } from '@/test/host';
import type { Wallet } from '@/wallet/wallet';
import { addTrustline } from '@/wallet/signer';
import { testnet } from '@conformance/indexer';
import { VarialExtension } from '@conformance/setup';
import type { CustomNetwork, NetworkLabel } from '@conformance/setup';
import type {
  Exchange,
  Message,
  Outcome,
  PackageName,
} from '@conformance/test-page/page';
import { serveTestPage } from '@conformance/test-page/server';
import type { PageServer } from '@conformance/test-page/server';

export type Answer = 'approve' | 'reject';
export type Network = 'testnet' | 'futurenet' | 'mainnet';

export interface Seen {
  readonly kind: string;
  readonly blocked: boolean;
}

export type Step =
  | { readonly action: 'switchAccount'; readonly account: number }
  | { readonly action: 'switchNetwork'; readonly network: Network }
  | { readonly action: 'lock' | 'unlock' }
  | {
      readonly call: string;
      readonly args: readonly unknown[];
      readonly prompts: readonly (Seen & { readonly answer: Answer })[];
      readonly value: unknown;
      readonly exchanges: readonly Exchange[];
    };

export interface GoldenEntry {
  readonly varial: string;
  readonly origin: string;
  readonly accounts: readonly string[];
  readonly network: 'testnet' | CustomNetwork;
  readonly steps: readonly Step[];
}

export interface CompareOptions {
  readonly funded?: boolean;
  readonly trustline?: Asset;
  readonly network?: CustomNetwork;
}

export type Scenario = (session: Session) => Promise<void>;

interface Driver {
  readonly page: Page;
  readonly accounts: readonly Account[];
  switchAccount(account: Account): Promise<void>;
  switchNetwork(network: Network): Promise<void>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  clearPrompts(): void;
  answer(answer: Answer): Promise<Seen>;
  close(): Promise<void>;
}

interface Fixtures {
  compare(scenario: Scenario, options?: CompareOptions): Promise<void>;
}

interface WorkerFixtures {
  accounts: readonly [Account, Account];
  stardust: Stardust;
  server: PageServer;
  varial: VarialExtension;
}

const promptTimeoutMs = 20_000;
const replyTimeoutMs = 30_000;
const trustlineFee = '10000';
const goldenFolder = join(import.meta.dirname, '../tests/fixtures/varial');
const labels: Record<Network, NetworkLabel> = {
  testnet: 'Test Net',
  futurenet: 'Future Net',
  mainnet: 'Main Net',
};
let sites = 0;

export class Session {
  readonly steps: Step[] = [];

  constructor(private readonly driver: Driver) {}

  call(
    name: PackageName,
    method: string,
    args: readonly unknown[] = [],
    answers: readonly Answer[] = [],
  ): Promise<Outcome> {
    return this.exchange(`${name}.${method}`, args, answers, (page) =>
      page.evaluate(
        ([name, method, args]) => window.conformance.call(name, method, args),
        [name, method, [...args]] as const,
      ),
    );
  }

  send(
    fields: Message,
    answers: readonly Answer[] = [],
    timeoutMs = 3_000,
  ): Promise<Outcome> {
    return this.exchange('postMessage', [fields], answers, (page) =>
      page.evaluate(
        ([fields, timeoutMs]) => window.conformance.send(fields, timeoutMs),
        [fields, timeoutMs] as const,
      ),
    );
  }

  async switchAccount(index: number): Promise<void> {
    const account = this.driver.accounts[index];
    if (!account) throw new Error(`the wallet has no account ${index}.`);
    await this.driver.switchAccount(account);
    this.steps.push({ action: 'switchAccount', account: index });
  }

  async switchNetwork(network: Network): Promise<void> {
    await this.driver.switchNetwork(network);
    this.steps.push({ action: 'switchNetwork', network });
  }

  async lock(): Promise<void> {
    await this.driver.lock();
    this.steps.push({ action: 'lock' });
  }

  async unlock(): Promise<void> {
    await this.driver.unlock();
    this.steps.push({ action: 'unlock' });
  }

  private async exchange(
    call: string,
    args: readonly unknown[],
    answers: readonly Answer[],
    start: (page: Page) => Promise<Outcome>,
  ): Promise<Outcome> {
    this.driver.clearPrompts();
    const outcome = start(this.driver.page);
    outcome.catch(() => undefined);
    const prompts = [];
    for (const answer of answers) {
      prompts.push({ ...(await this.driver.answer(answer)), answer });
    }
    const { value, exchanges } = await within(outcome, replyTimeoutMs);
    this.steps.push({ call, args, prompts, value, exchanges });
    return { value, exchanges };
  }
}

export const packages = ['freighter', 'varial'] as const;

export function connect(session: Session): Promise<Outcome> {
  return session.call('freighter', 'requestAccess', [], ['approve']);
}

class VarialDriver implements Driver {
  private constructor(
    readonly page: Page,
    readonly accounts: readonly Account[],
    private readonly varial: VarialExtension,
  ) {}

  static async open(
    varial: VarialExtension,
    accounts: readonly Account[],
    url: string,
  ): Promise<VarialDriver> {
    const page = await varial.context.newPage();
    await page.goto(url);
    return new VarialDriver(page, accounts, varial);
  }

  switchAccount(account: Account): Promise<void> {
    return this.varial.switchAccount(account.address);
  }

  switchNetwork(network: Network): Promise<void> {
    return this.varial.switchNetwork(labels[network]);
  }

  lock(): Promise<void> {
    return this.varial.lock();
  }

  unlock(): Promise<void> {
    return this.varial.unlock();
  }

  clearPrompts(): void {
    this.varial.clearPopups();
  }

  async answer(answer: Answer): Promise<Seen> {
    const popup = await this.varial
      .nextPopup(promptTimeoutMs)
      .catch(() => null);
    if (!popup) return { kind: 'none', blocked: false };
    const blocked = await this.varial.answer(popup, answer === 'approve');
    return { kind: popup.kind, blocked };
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

class StardustDriver implements Driver {
  private constructor(
    readonly page: Page,
    readonly accounts: readonly Account[],
    private readonly wallet: Wallet,
    private readonly context: BrowserContext,
  ) {}

  static async open(
    browser: Browser,
    stardust: Stardust,
    accounts: readonly Account[],
    url: string,
  ): Promise<StardustDriver> {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const wallet = stardust.wallet({ accounts, policy: 'manual' });
    await wallet.attach(pageHost(context), { wallet: 'varial' });
    const page = await context.newPage();
    await page.goto(url);
    return new StardustDriver(page, accounts, wallet, context);
  }

  switchAccount(account: Account): Promise<void> {
    return this.wallet.switchAccount(account);
  }

  switchNetwork(network: Network): Promise<void> {
    return this.wallet.switchNetwork(network);
  }

  lock(): Promise<void> {
    return this.wallet.lock();
  }

  unlock(): Promise<void> {
    return this.wallet.unlock();
  }

  clearPrompts(): void {}

  async answer(answer: Answer): Promise<Seen> {
    const prompt = await this.wallet
      .nextPrompt(undefined, { timeoutMs: promptTimeoutMs })
      .catch(() => null);
    if (!prompt) return { kind: 'none', blocked: false };
    const blocked = prompt.blocked !== null;
    if (answer === 'approve' && !blocked) await prompt.approve();
    else await prompt.reject();
    return { kind: prompt.kind, blocked };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  accounts: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use([randomAccount(), randomAccount()]);
    },
    { scope: 'worker' },
  ],
  stardust: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(await createStardust({ network: 'testnet' }));
    },
    { scope: 'worker' },
  ],
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await serveTestPage();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  varial: [
    async ({ accounts }, use) => {
      const { VARIAL_BUILD: build, VARIAL_TAG: tag } = process.env;
      if (!build || !tag) {
        throw new Error(
          'VARIAL_BUILD is unset. Run the suite with pnpm test:conformance, whose global setup builds Varial.',
        );
      }
      const varial = await VarialExtension.launch(build, tag);
      await varial.onboard(accounts);
      await varial.reset(accounts[0].address);
      await use(varial);
      await varial.close();
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  compare: async (
    { accounts, browser, server, stardust, varial },
    use,
    testInfo,
  ) => {
    await use(async (scenario, options = {}) => {
      const url = server.url(`site${++sites}.localhost`);
      const funded = options.funded
        ? await fundedAccount(stardust, options)
        : undefined;
      const wallet = withFirst(funded, accounts);
      const custom = options.network;

      if (funded) await varial.importAccount(funded);
      if (custom) await varial.addNetwork(custom);
      const real = await VarialDriver.open(varial, wallet, url);
      const recorded = await play(real, scenario).finally(() => real.close());
      await varial.reset(accounts[0].address);
      if (funded) await removeTrustlines(funded, options);

      const wallets = custom ? await customStardust(custom) : stardust;
      const emulated = await StardustDriver.open(browser, wallets, wallet, url);
      const replayed = await play(emulated, scenario).finally(() =>
        emulated.close(),
      );

      await attach(testInfo, 'varial', recorded);
      await attach(testInfo, 'stardust', replayed);
      if (process.env.CONFORMANCE_RECORD) {
        await record(testInfo, {
          varial: varial.tag,
          origin: new URL(url).origin,
          accounts: wallet.map(({ address }) => address),
          network: custom ?? 'testnet',
          steps: recorded,
        });
      }
      expect(replayed).toEqual(recorded);
    });
  },
});

export { expect };

async function play(driver: Driver, scenario: Scenario): Promise<Step[]> {
  const session = new Session(driver);
  await scenario(session);
  return session.steps;
}

async function fundedAccount(
  stardust: Stardust,
  { trustline }: CompareOptions,
): Promise<Account> {
  const account = await stardust.accounts.create();
  if (trustline) {
    const rpc = new Rpc(resolveNetwork('testnet'));
    await addTrustline(
      { rpc, specs: new ContractSpecs(rpc) },
      {
        signer: account.keypair,
        asset: trustline,
        networkPassphrase: Networks.TESTNET,
      },
    );
  }
  return account;
}

// Varial's run may add a trustline on testnet. Removing it lets Stardust's run
// start from the same account in the same state.
async function removeTrustlines(
  { address, keypair }: Account,
  { trustline }: CompareOptions,
): Promise<void> {
  const horizon = new Horizon.Server(testnet.horizonUrl);
  const account = await horizon.loadAccount(address);
  const held = account.balances.flatMap((line) =>
    line.asset_type === 'credit_alphanum4' ||
    line.asset_type === 'credit_alphanum12'
      ? [new Asset(line.asset_code, line.asset_issuer)]
      : [],
  );
  const added = held.filter((asset) => !trustline?.equals(asset));
  if (added.length === 0) return;
  const builder = new TransactionBuilder(account, {
    fee: trustlineFee,
    networkPassphrase: Networks.TESTNET,
  });
  for (const asset of added) {
    builder.addOperation(Operation.changeTrust({ asset, limit: '0' }));
  }
  const transaction = builder.setTimeout(30).build();
  transaction.sign(keypair);
  await horizon.submitTransaction(transaction).catch((error: unknown) => {
    throw new Error(
      `Horizon didn't confirm the changeTrust that removes ${added.join(', ')} from ${address}, so Stardust's run can't start from the same state.`,
      { cause: error },
    );
  });
}

// The wallet's network comes from getNetwork, so a custom network is an RPC
// stand-in that reports the custom passphrase.
function customStardust({
  rpcUrl,
  passphrase,
}: CustomNetwork): Promise<Stardust> {
  const answers: Record<string, unknown> = {
    getHealth: { status: 'healthy', latestLedger: 1 },
    getNetwork: { passphrase, protocolVersion: 23 },
  };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const { id, method } = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    return Response.json({ jsonrpc: '2.0', id, result: answers[method] });
  };
  return createStardust({ network: { rpcUrl }, fetch });
}

async function attach(
  testInfo: TestInfo,
  name: string,
  steps: readonly Step[],
): Promise<void> {
  await testInfo.attach(`${name}.json`, {
    body: JSON.stringify(steps, null, 2),
    contentType: 'application/json',
  });
}

async function record(testInfo: TestInfo, entry: GoldenEntry): Promise<void> {
  const file = join(
    goldenFolder,
    `${basename(testInfo.file, '.spec.ts')}.json`,
  );
  const golden = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch((): Record<string, unknown> => ({}));
  golden[testInfo.title] = entry;
  const options = await resolveConfig(file);
  await mkdir(goldenFolder, { recursive: true });
  await writeFile(
    file,
    await format(JSON.stringify(golden), { ...options, filepath: file }),
  );
}

// A call still waiting on a prompt nobody answered is part of the result.
function within(
  outcome: Promise<Outcome>,
  timeoutMs: number,
): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Outcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ value: `no reply within ${timeoutMs} ms`, exchanges: [] }),
      timeoutMs,
    );
  });
  return Promise.race([outcome, late]).finally(() => clearTimeout(timer));
}

function withFirst(
  account: Account | undefined,
  accounts: readonly Account[],
): readonly Account[] {
  return account ? [account, ...accounts] : accounts;
}

function randomAccount(): Account {
  const keypair = Keypair.random();
  return { address: keypair.publicKey(), keypair };
}
