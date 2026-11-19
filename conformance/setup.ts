import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { Account } from '@/funding/accounts';
import type { PromptKind } from '@/wallet/prompts';
import { noIndexer, standInIndexer } from '@conformance/indexer';

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

interface StoredNetworks {
  readonly active: string;
  readonly listed: readonly string[];
  readonly futurenet: boolean;
}

const repository = 'https://github.com/stellar/freighter.git';
const clones = join(import.meta.dirname, '.varial');
const password = 'Stardust-conformance1';
const futurenet: NetworkLabel = 'Future Net';

// A UI step that can't finish in time fails at once, naming the step.
const uiTimeoutMs = 10_000;
const homeTimeoutMs = 20_000;
const trustlineTimeoutMs = 45_000;

const views = {
  home: '/',
  importAccount: '/account/import',
  settings: '/settings',
  advancedSettings: '/settings/advanced-settings',
  networkSettings: '/manage-network/network-settings',
};

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
    context.setDefaultTimeout(uiTimeoutMs);
    context.setDefaultNavigationTimeout(homeTimeoutMs);
    // Only the unset backend's host is routed, so a real backend still works.
    await standInIndexer(context);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const home = await context.newPage();
    return new VarialExtension(context, id, tag, home);
  }

  async onboard(accounts: readonly Account[]): Promise<void> {
    const { home } = this;
    await this.open(views.home);
    await home.getByText('Import wallet').click({ timeout: homeTimeoutMs });
    await home.locator('#new-password-input').fill(password);
    await home.locator('#confirm-password-input').fill(password);
    await home.locator('#termsOfUse-input').check({ force: true });
    await home.getByText('Confirm').click();
    const words = this.mnemonic().split(' ');
    for (const [index, word] of words.entries()) {
      await home.locator(`#MnemonicPhrase-${index + 1}`).fill(word);
    }
    await home.getByRole('button', { name: 'Import' }).click();
    await expect(
      home.getByText('You’re all set!'),
      'Varial finishes importing the recovery phrase',
    ).toBeVisible({ timeout: homeTimeoutMs });
    await this.switchNetwork('Test Net');
    for (const account of accounts) await this.importAccount(account);
  }

  async importAccount({ address, keypair }: Account): Promise<void> {
    const { home } = this;
    await this.open(views.importAccount);
    await home.locator('#privateKey-input').fill(keypair.secret());
    await home.locator('#password-input').fill(password);
    await home.locator('#authorization-input').check({ force: true });
    await home.getByTestId('import-account-button').click();
    await this.homeReady();
    await this.switchAccount(address);
  }

  // Always clicked: a signing popup can switch Varial to the account it signs
  // for, so the active account isn't known here.
  async switchAccount(address: string): Promise<void> {
    const { home } = this;
    await this.open(views.home);
    await this.homeReady();
    await home.getByTestId('account-view-account-name').click();
    await home
      .getByTestId('wallet-row-select')
      .filter({ hasText: shortKey(address) })
      .click();
    await expect(
      home.getByTestId('AccountSheet'),
      `Varial switches to ${address} and closes the account list`,
    ).toBeHidden();
    await this.homeReady();
  }

  // Futurenet is listed only while "Use Futurenet" is on, which replaces
  // mainnet with it and makes it the active network.
  async switchNetwork(name: string): Promise<void> {
    const { home } = this;
    const useFuturenet = name === futurenet;
    if ((await this.networks()).futurenet !== useFuturenet) {
      await this.useFuturenet(useFuturenet);
    }
    if ((await this.networks()).active === name) return;
    await this.open(views.networkSettings);
    const select = home.getByTestId('network-settings-select');
    await expect(select, "Varial's network settings").toBeVisible();
    const { listed } = await this.networks();
    if (!listed.includes(name)) {
      throw new Error(
        `Varial lists no network named "${name}". It lists ${listed.join(', ')}.`,
      );
    }
    await select.selectOption(name);
    await this.expectNetwork(name);
  }

  async addNetwork(network: CustomNetwork): Promise<void> {
    const { home } = this;
    if ((await this.networks()).listed.includes(network.name)) {
      await this.switchNetwork(network.name);
      return;
    }
    await this.open(views.networkSettings);
    await home.getByRole('button', { name: 'Add custom network' }).click();
    await home.getByTestId('NetworkForm__networkName').fill(network.name);
    await home.getByTestId('NetworkForm__networkUrl').fill(network.url);
    await home.getByTestId('NetworkForm__sorobanRpcUrl').fill(network.rpcUrl);
    await home
      .getByTestId('NetworkForm__networkPassphrase')
      .fill(network.passphrase);
    await home.locator('#isSwitchSelected-input').check({ force: true });
    await home.getByTestId('NetworkForm__add').click();
    await this.expectNetwork(network.name);
  }

  async lock(): Promise<void> {
    await this.open(views.settings);
    await this.home.getByTestId('settings-lock-freighter').click();
    await expect(
      this.home.locator('#password-input'),
      'Varial shows its unlock screen',
    ).toBeVisible();
    this.locked = true;
  }

  async unlock(): Promise<void> {
    const { home } = this;
    await this.open(views.home);
    await home.locator('#password-input').fill(password);
    await home.getByRole('button', { name: 'Unlock' }).click();
    await this.homeReady();
    this.locked = false;
  }

  // Every scenario starts unlocked, on testnet, with the given account and
  // no popup left open.
  async reset(address: string): Promise<void> {
    await this.closePopups();
    if (this.locked) await this.unlock();
    await this.switchNetwork('Test Net');
    await this.switchAccount(address);
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
    const approvable = button !== null && (await isEnabled(popup.page, button));
    if (approve && approvable && button) {
      await button.click();
      if (popup.kind === 'addToken') await confirmTrustline(popup.page);
    } else {
      await popup.page.close();
    }
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

  // Reloaded when already there, so the view starts over with fresh data.
  private async open(view: string): Promise<void> {
    const url = `chrome-extension://${this.id}/index.html#${view}`;
    if (this.home.url() === url) await this.home.reload();
    else await this.home.goto(url);
  }

  private async useFuturenet(on: boolean): Promise<void> {
    const { home } = this;
    await this.open(views.advancedSettings);
    await home.getByText('I understand, continue').click();
    const toggle = home.locator('#isExperimentalModeEnabledValue');
    if ((await toggle.isChecked()) !== on) {
      await home.getByTestId('isExperimentalModeEnabledValue').click();
    }
    await expect
      .poll(async () => (await this.networks()).futurenet, {
        message: `Varial turns "Use Futurenet" ${on ? 'on' : 'off'}`,
        timeout: uiTimeoutMs,
      })
      .toBe(on);
  }

  private async expectNetwork(name: string): Promise<void> {
    await expect
      .poll(async () => (await this.networks()).active, {
        message: `Varial switches to the network "${name}"`,
        timeout: uiTimeoutMs,
      })
      .toBe(name);
  }

  // Read from Varial's storage, where its background keeps the networks.
  private networks(): Promise<StoredNetworks> {
    return this.home.evaluate(async () => {
      interface Network {
        readonly networkName?: string;
      }
      interface Stored {
        readonly network?: Network;
        readonly networksList?: readonly Network[];
        readonly isExperimentalMode?: boolean;
      }
      const { chrome } = globalThis as unknown as {
        chrome: {
          storage: { local: { get(keys: string[]): Promise<Stored> } };
        };
      };
      const {
        network,
        networksList = [],
        isExperimentalMode,
      } = await chrome.storage.local.get([
        'network',
        'networksList',
        'isExperimentalMode',
      ]);
      return {
        active: network?.networkName ?? '',
        listed: networksList.map(({ networkName = '' }) => networkName),
        futurenet: isExperimentalMode === true,
      };
    });
  }

  private async closePopups(): Promise<void> {
    this.clearPopups();
    for (const page of this.context.pages()) {
      if (this.isPopup(page)) await page.close();
    }
  }

  private async homeReady(): Promise<void> {
    await expect(
      this.home.getByTestId('account-view'),
      "Varial's home screen",
    ).toBeVisible({ timeout: homeTimeoutMs });
  }

  private isPopup(page: Page): boolean {
    return (
      page !== this.home &&
      page.url().startsWith(`chrome-extension://${this.id}/`)
    );
  }
}

function shortKey(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
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
// Varial warns before signing from an account without XLM for the fee, and a
// user can dismiss that warning to reach the button.
async function isEnabled(page: Page, button: Locator): Promise<boolean> {
  const warning = page.getByTestId('InsufficientBalanceWarning');
  try {
    await button
      .first()
      .or(warning)
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    if (await warning.isVisible()) {
      await page.getByRole('button', { name: 'Got it' }).click();
      await button.first().waitFor({ state: 'visible' });
    }
    await expect(button.first()).toBeEnabled({ timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// For a Stellar Asset Contract, Add opens a changeTrust review. Varial answers
// the app once it has submitted that transaction. A plain token's popup closes.
async function confirmTrustline(page: Page): Promise<void> {
  const reviewing = await page
    .getByTestId('ChangeTrustInternal__Body')
    .waitFor({ timeout: uiTimeoutMs })
    .then(
      () => true,
      () => false,
    );
  if (!reviewing) return;
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.getByTestId('SubmitTransaction__Title__Success'),
    'Varial adds the trustline on testnet',
  ).toBeVisible({ timeout: trustlineTimeoutMs });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect
    .poll(() => page.isClosed(), {
      message: 'Varial closes the popup after Done',
      timeout: uiTimeoutMs,
    })
    .toBe(true);
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
