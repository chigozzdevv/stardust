import { mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { Networks } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xlm } from '@/amounts';
import { createStardust } from '@/index';
import type { CoreConfig } from '@/index';
import { payment } from '@tests/helpers/envelopes';
import { FakeLedger } from '@tests/helpers/ledger';
import { FakeHost } from '@tests/helpers/page';
import type { RpcRequest } from '@tests/helpers/replay';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => home.dir,
}));

let ledger: FakeLedger;
let methods: string[];
let config: CoreConfig;

beforeEach(async () => {
  home.dir = await mkdtemp(join(os.tmpdir(), 'stardust-home-'));
  ledger = new FakeLedger();
  methods = [];
  config = {
    network: { rpcUrl: ledger.context().network.rpcUrl },
    fetch: (input, init) => {
      methods.push(
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as RpcRequest).method
          : 'friendbot',
      );
      return ledger.fetch(input, init);
    },
  };
});

afterEach(async () => {
  await rm(home.dir, { recursive: true, force: true });
});

function operations() {
  return ledger.transactions.map(({ source, operations: list }) => ({
    source,
    types: list.map(({ type }) => type),
  }));
}

describe('createStardust', () => {
  it('checks the network first and reports what it found', async () => {
    const stardust = await createStardust(config);
    expect(methods).toEqual(['getHealth', 'getNetwork']);
    expect(stardust.network).toEqual({
      name: 'testnet',
      rpcUrl: 'https://rpc.stardust.test',
      networkPassphrase: Networks.TESTNET,
      friendbotUrl: 'https://friendbot.stardust.test/',
      protocolVersion: 23,
    });
  });

  it('refuses a network that reports the mainnet passphrase', async () => {
    ledger.network = { ...ledger.network, passphrase: Networks.PUBLIC };
    await expect(createStardust(config)).rejects.toMatchObject({
      code: 'MAINNET_REFUSED',
      message:
        'refused: this network reports the mainnet passphrase. Stardust never runs on mainnet.',
    });
  });
});

describe('accounts', () => {
  it('creates every funded account in one transaction from a sub-funder', async () => {
    const stardust = await createStardust(config);
    const [main, savings, visitor] = await stardust.accounts.createMany([
      {},
      { fund: '500' },
      { fund: false },
    ]);

    expect(ledger.balance(main?.address ?? '')).toBe(xlm('100'));
    expect(ledger.balance(savings?.address ?? '')).toBe(xlm('500'));
    expect(ledger.balance(visitor?.address ?? '')).toBeUndefined();
    const [subFunder, created] = operations();
    expect(subFunder?.types).toEqual(['createAccount']);
    expect(created?.types).toEqual(['createAccount', 'createAccount']);
    expect(created?.source).not.toBe(subFunder?.source);
    expect(ledger.friendbotCalls).toHaveLength(1);
  });

  it("keeps the machine's funder in the home folder", async () => {
    const stardust = await createStardust(config);
    await stardust.accounts.create();
    const funders = await readdir(join(home.dir, '.stardust', 'funders'));
    expect(funders).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
  });

  it('reuses its sub-funder and creates one batch at a time', async () => {
    const stardust = await createStardust(config);
    const created = await Promise.all([
      stardust.accounts.create(),
      stardust.accounts.create({ fund: '5' }),
      stardust.accounts.createMany([{}, {}]),
    ]);

    const accounts = created.flat();
    expect(accounts).toHaveLength(4);
    for (const { address } of accounts) {
      expect(ledger.balance(address)).toBeGreaterThan(0n);
    }
    const [, ...batches] = operations();
    expect(batches).toHaveLength(3);
    expect(new Set(batches.map(({ source }) => source)).size).toBe(1);
  });

  it('checks the options before touching the network', async () => {
    const stardust = await createStardust(config);
    await expect(
      stardust.accounts.create({ fund: '5000' }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: [
        "options.fund is '5000', but the maximum per account is '1000'.",
        "Use '1000' or less, or spread the amount over several accounts.",
      ].join('\n'),
    });
    await expect(
      stardust.accounts.createMany([{}, { fund: '10.5.0' }]),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: [
        "options[1].fund is '10.5.0', which isn't an XLM amount.",
        "Write an amount such as '10' or '10.5', or use true or false.",
      ].join('\n'),
    });
    expect(methods).toEqual(['getHealth', 'getNetwork']);
  });

  it('fails with FUNDING_FAILED on a network without Friendbot', async () => {
    ledger.network = { passphrase: Networks.TESTNET, protocolVersion: 23 };
    const stardust = await createStardust(config);
    expect(stardust.network.friendbotUrl).toBeNull();
    await expect(stardust.accounts.create()).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
    });
  });
});

describe('wallet', () => {
  it("gives wallets on the checked network that use Stardust's RPC", async () => {
    const stardust = await createStardust(config);
    const [main, savings] = await stardust.accounts.createMany([
      {},
      { fund: false },
    ]);
    if (!main || !savings) throw new Error('createMany returned too few');
    const wallet = stardust.wallet({
      accounts: [main, savings],
      connected: true,
    });
    expect(wallet.address).toBe(main.address);
    expect(wallet.network).toEqual(stardust.network);

    const host = new FakeHost();
    await wallet.attach(host, { wallet: 'varial' });
    await host.bindings.get('__stardust')?.('https://app.test', {
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(main.address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    methods = [];
    await expect(prompt.landed({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(methods).toContain('getTransaction');
  });
});
