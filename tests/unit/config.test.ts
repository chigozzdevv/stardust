import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineConfig,
  loadConfig,
  parseConfig,
  parseTestOptions,
} from '@/config/config';
import { StardustError } from '@/errors';

const cwd = resolve('/projects/dapp');
const app = { url: 'http://localhost:3000' };

function thrown(run: () => unknown): StardustError {
  try {
    run();
  } catch (error) {
    if (error instanceof StardustError) return error;
    throw error;
  }
  throw new Error('expected a StardustError');
}

const configError = (input: unknown) =>
  thrown(() => parseConfig(input, cwd)).message;

const usersError = (users: unknown) =>
  thrown(() => parseTestOptions('e2e/orders.spec.ts', { users })).message;

const printed = (file: string, users: unknown) =>
  String(thrown(() => parseTestOptions(file, { users })));

describe('parseConfig', () => {
  it('resolves the tests folder, ./e2e by default', () => {
    expect(
      parseConfig(
        defineConfig({
          network: 'testnet',
          app: { url: 'http://localhost:3000', start: 'pnpm dev' },
        }),
        cwd,
      ),
    ).toEqual({
      network: 'testnet',
      app: { url: 'http://localhost:3000', start: 'pnpm dev' },
      tests: join(cwd, 'e2e'),
    });
    expect(
      parseConfig(
        {
          network: { rpcUrl: 'https://rpc-futurenet.stellar.org' },
          app,
          tests: './specs',
        },
        cwd,
      ),
    ).toEqual({
      network: { rpcUrl: 'https://rpc-futurenet.stellar.org' },
      app: { url: 'http://localhost:3000', start: null },
      tests: join(cwd, 'specs'),
    });
  });

  it("refuses network 'local' with NETWORK_NOT_SUPPORTED", () => {
    const error = thrown(() => parseConfig({ network: 'local', app }, cwd));
    expect(error.code).toBe('NETWORK_NOT_SUPPORTED');
    expect(error.message).toBe(
      "network 'local' isn't available in v1. Use 'testnet' or { rpcUrl }.",
    );
  });

  it('reports a missing app.url as in the spec', () => {
    const error = thrown(() =>
      parseConfig({ network: 'testnet', app: {} }, cwd),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe('app.url is missing in stardust.config.ts');
  });

  it.each([
    [{ app }, 'network is missing in stardust.config.ts'],
    [
      { network: 'mainnet', app },
      "network is 'mainnet' in stardust.config.ts. Use 'testnet' or { rpcUrl }.",
    ],
    [
      { network: {}, app },
      "network is {} in stardust.config.ts. Use 'testnet' or { rpcUrl }.",
    ],
    [
      { network: { rpcUrl: 'soroban-testnet.stellar.org' }, app },
      "network.rpcUrl is 'soroban-testnet.stellar.org' in stardust.config.ts. Use an http or https URL, such as 'https://rpc-futurenet.stellar.org'.",
    ],
    [
      { network: { rpcUrl: 'https://rpc.example.com', passphrase: 'x' }, app },
      "network.passphrase isn't a setting in stardust.config.ts. Use rpcUrl.",
    ],
    [{ network: 'testnet' }, 'app is missing in stardust.config.ts'],
    [
      { network: 'testnet', app: 'http://localhost:3000' },
      "app is 'http://localhost:3000' in stardust.config.ts. Use an object such as { url: 'http://localhost:3000', start: 'pnpm dev' }.",
    ],
    [
      { network: 'testnet', app: { url: 'localhost:3000' } },
      "app.url is 'localhost:3000' in stardust.config.ts. Use an http or https URL, such as 'http://localhost:3000'.",
    ],
    [
      { network: 'testnet', app: { url: 'ftp://localhost' } },
      "app.url is 'ftp://localhost' in stardust.config.ts. Use an http or https URL, such as 'http://localhost:3000'.",
    ],
    [
      { network: 'testnet', app: { ...app, start: '' } },
      "app.start is '' in stardust.config.ts. Use a command such as 'pnpm dev', or leave it out.",
    ],
    [
      { network: 'testnet', app: { ...app, port: 3000 } },
      "app.port isn't a setting in stardust.config.ts. Use url or start.",
    ],
    [
      { network: 'testnet', app, tests: 42 },
      "tests is 42 in stardust.config.ts. Use a folder relative to the project folder, such as './e2e'.",
    ],
    [
      { network: 'testnet', app, testDir: './e2e' },
      "testDir isn't a setting in stardust.config.ts. Use network, app or tests.",
    ],
    [
      undefined,
      'stardust.config.ts has no default export. Use export default defineConfig({ ... }).',
    ],
    [
      'testnet',
      "stardust.config.ts exports 'testnet'. Use export default defineConfig({ ... }).",
    ],
  ])('reports %j', (input, message) => {
    const error = thrown(() => parseConfig(input, cwd));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe(message);
  });

  it('lists every problem, one per line', () => {
    expect(configError({ network: 'mainnet', app: {} })).toBe(
      [
        "network is 'mainnet' in stardust.config.ts. Use 'testnet' or { rpcUrl }.",
        'app.url is missing in stardust.config.ts',
      ].join('\n'),
    );
  });
});

describe('parseTestOptions', () => {
  it('accepts the users declared in the spec and keeps their order', () => {
    const users = {
      maker: {
        wallet: 'varial',
        connected: true,
        accounts: { main: { fund: '1000' } },
      },
      saver: {
        wallet: 'varial',
        connected: true,
        accounts: { main: { fund: '1000' }, savings: { fund: '50' } },
      },
      trader: { wallet: 'sep60', connected: true },
      visitor: { wallet: 'none' },
      friend: {},
    };
    const parsed = parseTestOptions('e2e/swap.spec.ts', { users });
    expect(parsed).toEqual({ users });
    expect(Object.keys(parsed.users)).toEqual(Object.keys(users));
    expect(Object.keys(parsed.users.saver?.accounts ?? {})).toEqual([
      'main',
      'savings',
    ]);
  });

  it('accepts every policy form and the other settings', () => {
    const decide = () => ({ action: 'approve' as const });
    const users = {
      a: { policy: 'manual', allowHttp: false, strict: false },
      b: { policy: { signTransaction: 'manual', connect: 'reject' } },
      c: { policy: decide, accounts: { main: { fund: false } } },
      d: { accounts: { main: { fund: true }, spare: {} } },
    };
    expect(
      parseTestOptions('e2e/swap.spec.ts', { users }).users.c?.policy,
    ).toBe(decide);
  });

  it('prints the section 4 examples exactly', () => {
    expect(
      printed('e2e/orders.spec.ts', {
        maker: { accounts: { main: { fund: '5000' } } },
      }),
    ).toBe(
      [
        'StardustError CONFIG_INVALID: e2e/orders.spec.ts',
        "  users.maker.accounts.main.fund is '5000', but the maximum per account is '1000'.",
        "  Use '1000' or less, or spread the amount over several accounts.",
      ].join('\n'),
    );
    expect(
      printed('e2e/swap.spec.ts', { trader: { wallet: 'freighter' } }),
    ).toBe(
      [
        'StardustError CONFIG_INVALID: e2e/swap.spec.ts',
        "  users.trader.wallet is 'freighter'. Use 'varial', 'sep60' or 'none'.",
      ].join('\n'),
    );
    expect(
      printed('e2e/pay.spec.ts', {
        friend: { accounts: { main: { fund: '10.5.0' } } },
      }),
    ).toBe(
      [
        'StardustError CONFIG_INVALID: e2e/pay.spec.ts',
        "  users.friend.accounts.main.fund is '10.5.0', which isn't an XLM amount.",
        "  Write an amount such as '10' or '10.5', or use true or false.",
      ].join('\n'),
    );
  });

  it('checks amounts to the stroop', () => {
    expect(
      usersError({ maker: { accounts: { main: { fund: '1000.0000001' } } } }),
    ).toContain("is '1000.0000001', but the maximum per account is '1000'.");
    expect(
      usersError({ friend: { accounts: { main: { fund: '0.00000001' } } } }),
    ).toContain("is '0.00000001', which isn't an XLM amount.");
  });

  it.each([
    [
      { trader: { accounts: { main: { fund: 500 } } } },
      "users.trader.accounts.main.fund is 500. Use true, false or an amount in XLM such as '500'.",
    ],
    [
      { trader: { accounts: { main: { amount: '5' } } } },
      "users.trader.accounts.main.amount isn't a setting. Use fund.",
    ],
    [
      { trader: { accounts: {} } },
      'users.trader.accounts is {}. List at least one account, such as { main: {} }.',
    ],
    [
      { trader: { accounts: 'main' } },
      "users.trader.accounts is 'main'. Use an object of accounts by name, such as { main: { fund: '500' } }.",
    ],
    [
      { trader: { connected: 'yes' } },
      "users.trader.connected is 'yes'. Use true or false.",
    ],
    [
      { trader: { conected: true } },
      "users.trader.conected isn't a setting. Use wallet, connected, policy, accounts, allowHttp or strict.",
    ],
    [
      { trader: { policy: 'auto' } },
      "users.trader.policy is 'auto'. Use 'approve', 'reject', 'manual', an object such as { signTransaction: 'manual' }, or a function.",
    ],
    [
      { trader: { policy: { connect: 'yes' } } },
      "users.trader.policy is { connect: 'yes' }. Use 'approve', 'reject', 'manual', an object such as { signTransaction: 'manual' }, or a function.",
    ],
    [
      { trader: { policy: { connect: undefined } } },
      "users.trader.policy is { connect: undefined }. Use 'approve', 'reject', 'manual', an object such as { signTransaction: 'manual' }, or a function.",
    ],
    [
      { trader: { policy: { signTx: 'approve' } } },
      "users.trader.policy.signTx isn't a prompt kind. Use connect, signTransaction, signAuthEntry, signMessage or addToken.",
    ],
    [
      { trader: 'varial' },
      "users.trader is 'varial'. Use an object such as { wallet: 'varial', connected: true }.",
    ],
    [
      ['trader'],
      "users is [ 'trader' ]. Use an object of users by name, such as { trader: {} }.",
    ],
  ])('reports %j', (users, message) => {
    expect(usersError(users)).toBe(`e2e/orders.spec.ts\n  ${message}`);
  });

  it('reports the options object itself', () => {
    expect(thrown(() => parseTestOptions('e2e/a.spec.ts', {})).message).toBe(
      'e2e/a.spec.ts\n  users is missing',
    );
    expect(
      thrown(() => parseTestOptions('e2e/a.spec.ts', { users: {}, user: {} }))
        .message,
    ).toBe("e2e/a.spec.ts\n  user isn't a setting. Use users.");
  });

  it('lists every problem', () => {
    expect(
      usersError({
        maker: { wallet: 'freighter', accounts: { main: { fund: '5000' } } },
      }),
    ).toBe(
      [
        'e2e/orders.spec.ts',
        "  users.maker.wallet is 'freighter'. Use 'varial', 'sep60' or 'none'.",
        "  users.maker.accounts.main.fund is '5000', but the maximum per account is '1000'.",
        "  Use '1000' or less, or spread the amount over several accounts.",
      ].join('\n'),
    );
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stardust-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const typedConfig = [
    "import type { StardustConfig } from 'stardust-stellar';",
    '',
    'const config: StardustConfig = {',
    "  network: 'testnet',",
    "  app: { url: 'http://localhost:3000', start: 'pnpm dev' },",
    "  tests: './specs',",
    '};',
    '',
    'export default config;',
    '',
  ].join('\n');

  it('reports a folder without stardust.config.ts', async () => {
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
      message: `no stardust.config.ts in ${dir}. Run this from your project folder.`,
    });
  });

  it('loads and validates a TypeScript config', async () => {
    await writeFile(join(dir, 'stardust.config.ts'), typedConfig);
    await expect(loadConfig(dir)).resolves.toEqual({
      network: 'testnet',
      app: { url: 'http://localhost:3000', start: 'pnpm dev' },
      tests: join(dir, 'specs'),
    });
  });

  it('reports a config whose settings are wrong', async () => {
    await writeFile(
      join(dir, 'stardust.config.ts'),
      "export default { network: 'testnet', app: {} };\n",
    );
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: 'app.url is missing in stardust.config.ts',
    });
  });

  it('reports a config that fails to load', async () => {
    await writeFile(
      join(dir, 'stardust.config.ts'),
      "throw new Error('boom');\n",
    );
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: "stardust.config.ts couldn't be loaded: boom",
    });
  });

  it("loads in Node itself through Node's type stripping", async () => {
    const file = join(dir, 'stardust.config.ts');
    await writeFile(file, typedConfig);
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      'const { default: config } = await import(process.argv[1]); console.log(JSON.stringify(config));',
      pathToFileURL(file).href,
    ]);
    expect(JSON.parse(stdout)).toEqual({
      network: 'testnet',
      app: { url: 'http://localhost:3000', start: 'pnpm dev' },
      tests: './specs',
    });
  });
});
