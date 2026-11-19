import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { Account } from '@/funding/accounts';
import type { PromptKind } from '@/wallet/prompts';

export type NetworkLabel = 'Test Net' | 'Future Net' | 'Main Net';

export interface CustomNetwork {
  readonly name: string;
  readonly url: string;
  readonly rpcUrl: string;
  readonly passphrase: string;
}

export interface Popup {
  readonly kind: PromptKind | 'unknown';
  readonly page: Page;
}

const repository = 'https://github.com/stellar/freighter.git';
const clones = join(import.meta.dirname, '.varial');
const password = 'Stardust-conformance1';

const routes: Record<string, PromptKind> = {
  'grant-access': 'connect',
  'sign-transaction': 'signTransaction',
  'sign-auth-entry': 'signAuthEntry',
  'sign-message': 'signMessage',
  'add-token': 'addToken',
};

const approveButtons: Record<PromptKind, string[]> = {
  connect: [
    'grant-access-connect-button',
    'grant-access-connect-anyway-button',
  ],
  signTransaction: ['sign-transaction-sign'],
  signAuthEntry: ['sign-auth-entry-approve-button'],
  signMessage: [
    'sign-message-approve-button',
    'sign-message-confirm-anyway-button',
  ],
  addToken: ['add-token-approve'],
};

// Varial's own CI builds with this host when no backend is configured.
const noIndexer = 'http://indexer.invalid';

export default async function globalSetup(): Promise<void> {
  const tag = process.env.VARIAL_TAG || (await latestTag());
  process.env.VARIAL_TAG = tag;
  process.env.VARIAL_BUILD = await buildVarial(tag);
}

async function latestTag(): Promise<string> {
  const response = await fetch(
    'https://api.github.com/repos/stellar/freighter/releases/latest',
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} for Varial's latest release. Set VARIAL_TAG to a stellar/freighter release tag.`,
    );
  }
  const { tag_name: tag } = (await response.json()) as { tag_name: string };
  return tag;
}

async function buildVarial(tag: string): Promise<string> {
  const folder = varialFolder(tag);
  const build = join(folder, 'extension', 'build');
  if (existsSync(join(build, 'manifest.json'))) return build;
  if (!existsSync(folder)) {
    await run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      tag,
      repository,
      folder,
    ]);
  }
  const env = {
    ...process.env,
    INDEXER_URL: process.env.INDEXER_URL || noIndexer,
    INDEXER_V2_URL: process.env.INDEXER_V2_URL || noIndexer,
  };
  await run('yarn', ['install', '--immutable'], { cwd: folder, env });
  await run('yarn', ['build:extension'], { cwd: folder, env });
  return build;
}

function varialFolder(tag: string): string {
  return join(clones, tag);
}

// Varial's e2e token on testnet, kept up to date with each release.
export function varialTestToken(tag: string): string | null {
  const source = join(
    varialFolder(tag),
    'extension/e2e-tests/helpers/test-token.ts',
  );
  if (!existsSync(source)) return null;
  const text = readFileSync(source, 'utf8');
  return /TEST_TOKEN_ADDRESS\s*=\s*"(C[A-Z2-7]{55})"/.exec(text)?.[1] ?? null;
}

export class VarialExtension {
  private readonly popups: Page[] = [];
  private readonly waiting: ((page: Page) => void)[] = [];
  private network = '';
  private account = '';
  private locked = false;

  private constructor(
    readonly context: BrowserContext,
    readonly id: string,
    readonly tag: string,
    private readonly home: Page,
  ) {
    context.on('page', (page) => {
      if (!this.isPopup(page)) return;
      const waiter = this.waiting.shift();
      if (waiter) waiter(page);
      else this.popups.push(page);
    });
  }

  static async launch(build: string, tag: string): Promise<VarialExtension> {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      ignoreHTTPSErrors: true,
      args: [
        '--headless=new',
        `--disable-extensions-except=${build}`,
        `--load-extension=${build}`,
      ],
    });
    if (!process.env.INDEXER_URL) await stubIndexer(context);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const home = await context.newPage();
    return new VarialExtension(context, id, tag, home);
  }

  async onboard(accounts: readonly Account[]): Promise<void> {
    const { home } = this;
    await this.open('');
    await home.getByText('Import wallet').click();
    await home.locator('#new-password-input').fill(password);
    await home.locator('#confirm-password-input').fill(password);
    await home.locator('#termsOfUse-input').check({ force: true });
    await home.getByText('Confirm').click();
    const words = this.mnemonic().split(' ');
    for (const [index, word] of words.entries()) {
      await home.locator(`#MnemonicPhrase-${index + 1}`).fill(word);
    }
    await home.getByRole('button', { name: 'Import' }).click();
    await expect(home.getByText('You’re all set!')).toBeVisible({
      timeout: 20_000,
    });
    await this.switchNetwork('Test Net');
    for (const account of accounts) await this.importAccount(account);
  }

  async importAccount({ address, keypair }: Account): Promise<void> {
    const { home } = this;
    await this.open('/account/import');
    await home.locator('#privateKey-input').fill(keypair.secret());
    await home.locator('#password-input').fill(password);
    await home.locator('#authorization-input').check({ force: true });
    await home.getByTestId('import-account-button').click();
    await this.homeReady();
    await this.switchAccount(address);
  }

  async switchAccount(address: string): Promise<void> {
    const { home } = this;
    await this.open('');
    await home.getByTestId('account-view-account-name').click();
    await home
      .getByTestId('wallet-row-select')
      .filter({ hasText: `${address.slice(0, 4)}…${address.slice(-4)}` })
      .click();
    await this.homeReady();
    this.account = address;
  }

  async switchNetwork(label: NetworkLabel): Promise<void> {
    const { home } = this;
    await this.networkSettings();
    await home.getByTestId('network-settings-select').selectOption(label);
    await home.getByTestId('BackButton').click();
    await home.getByTestId('BackButton').click();
    await this.homeReady();
    this.network = label;
  }

  async addNetwork(network: CustomNetwork): Promise<void> {
    const { home } = this;
    await this.networkSettings();
    await home.getByText('Add custom network').click();
    await home.getByTestId('NetworkForm__networkName').fill(network.name);
    await home.getByTestId('NetworkForm__networkUrl').fill(network.url);
    await home.getByTestId('NetworkForm__sorobanRpcUrl').fill(network.rpcUrl);
    await home
      .getByTestId('NetworkForm__networkPassphrase')
      .fill(network.passphrase);
    await home.getByTestId('NetworkForm__add').click();
    await home.getByTestId('BackButton').click();
    await home.getByTestId('BackButton').click();
    await this.homeReady();
    this.network = network.name;
  }

  async lock(): Promise<void> {
    await this.settings();
    await this.home.getByTestId('settings-lock-freighter').click();
    await expect(this.home.locator('#password-input')).toBeVisible();
    this.locked = true;
  }

  async unlock(): Promise<void> {
    const { home } = this;
    await this.open('');
    await home.locator('#password-input').fill(password);
    await home.getByRole('button', { name: 'Unlock' }).click();
    await this.homeReady();
    this.locked = false;
  }

  // Every scenario starts unlocked, on testnet, with the given account.
  async reset(address: string): Promise<void> {
    if (this.locked) await this.unlock();
    if (this.network !== 'Test Net') await this.switchNetwork('Test Net');
    if (this.account !== address) await this.switchAccount(address);
  }

  clearPopups(): void {
    this.popups.length = 0;
  }

  nextPopup(timeout = 30_000): Promise<Popup> {
    const queued = this.popups.shift();
    const page = queued
      ? Promise.resolve(queued)
      : new Promise<Page>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.waiting.splice(this.waiting.indexOf(waiter), 1);
            reject(new Error(`Varial opened no popup within ${timeout} ms.`));
          }, timeout);
          const waiter = (opened: Page) => {
            clearTimeout(timer);
            resolve(opened);
          };
          this.waiting.push(waiter);
        });
    return page.then((opened) => ({ kind: popupKind(opened), page: opened }));
  }

  // What a user can do: approve when the popup offers an enabled approve
  // button, otherwise only close it.
  async answer(popup: Popup, approve: boolean): Promise<boolean> {
    const button = approveButton(popup);
    const approvable = button !== null && (await isEnabled(button));
    if (approve && approvable && button) await button.click();
    else await popup.page.close();
    return !approvable;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  private mnemonic(): string {
    const require = createRequire(
      join(varialFolder(this.tag), 'extension', 'package.json'),
    );
    const { default: wallet } = require('stellar-hd-wallet') as {
      default: { generateMnemonic(options: { entropyBits: number }): string };
    };
    return wallet.generateMnemonic({ entropyBits: 128 });
  }

  private async open(route: string): Promise<void> {
    await this.home.goto(
      `chrome-extension://${this.id}/index.html#${route || '/'}`,
    );
  }

  private async settings(): Promise<void> {
    const { home } = this;
    await this.open('');
    await home.getByTestId('account-chip').click();
    await home.getByTestId('account-sheet-settings').click();
  }

  private async networkSettings(): Promise<void> {
    await this.settings();
    await this.home.getByTestId('settings-network-link').click();
  }

  private async homeReady(): Promise<void> {
    await expect(this.home.getByTestId('account-view')).toBeVisible({
      timeout: 30_000,
    });
  }

  private isPopup(page: Page): boolean {
    return (
      page !== this.home &&
      page.url().startsWith(`chrome-extension://${this.id}/`)
    );
  }
}

function popupKind(page: Page): Popup['kind'] {
  const route = /#\/([a-z-]+)/.exec(page.url())?.[1] ?? '';
  return routes[route] ?? 'unknown';
}

function approveButton({ kind, page }: Popup): Locator | null {
  if (kind === 'unknown') return null;
  const [first, ...others] = approveButtons[kind].map((id) =>
    page.getByTestId(id),
  );
  return others.reduce((either, other) => either.or(other), first as Locator);
}

// Popups load their data after they open, so a button may start disabled.
async function isEnabled(button: Locator): Promise<boolean> {
  try {
    await button.first().waitFor({ state: 'visible', timeout: 15_000 });
    await expect(button.first()).toBeEnabled({ timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// The answers Varial's own e2e stubs give for the backend calls every screen
// makes, so an unconfigured backend shows no error toasts over the buttons.
async function stubIndexer(context: BrowserContext): Promise<void> {
  const answers: Record<string, unknown> = {
    'rpc-health': { status: 'healthy' },
    'feature-flags': { useSorobanPublic: true },
    'user-notification': { enabled: false, message: '' },
    'subscription/account': { data: {}, error: null },
  };
  await context.route(`${noIndexer}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const answer = Object.entries(answers).find(([path]) =>
      pathname.endsWith(path),
    );
    if (answer) await route.fulfill({ json: answer[1] });
    else await route.abort();
  });
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} ${args.join(' ')} exited with ${code}.`),
          ),
    );
  });
}
