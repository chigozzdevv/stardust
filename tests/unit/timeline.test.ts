import {
  Asset,
  Networks,
  Operation,
  Account as SourceAccount,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { BrowserContext } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xlm } from '@/amounts';
import { ContractSpecs } from '@/contracts/spec';
import type { Account } from '@/funding/accounts';
import type { Landed } from '@/network/landing';
import { Rpc } from '@/network/network';
import { pageHost } from '@/test/host';
import { expect as check } from '@/test/index';
import {
  Timeline,
  recordLanded,
  renderTimeline,
  signedNetwork,
  timelineJson,
} from '@/test/timeline';
import type { PageRequest } from '@/test/timeline';
import type { Policy } from '@/wallet/policy';
import { EmulatedWallet } from '@/wallet/wallet';
import { answer, recordedResult } from '@tests/fixtures/rpc/replay';
import { account, testnet } from '@tests/fixtures/wallet/prompt-queue';

type Callback = (source: object, payload: unknown) => Promise<unknown>;

const start = Date.parse('2026-11-19T10:00:00.000Z');
const native = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const payee = 'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV';
const offline: typeof fetch = () =>
  Promise.reject(new TypeError('no network in this test'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
});

afterEach(() => {
  vi.useRealTimers();
});

function at(ms: number): void {
  vi.setSystemTime(start + ms);
}

async function bench(policy: Policy, connected = false, send = offline) {
  const timeline = new Timeline();
  const accounts = [account()] as [Account];
  const rpc = new Rpc(testnet.rpcUrl, send);
  const wallet = new EmulatedWallet(
    { accounts, policy, connected },
    {
      network: testnet,
      landing: { rpc, specs: new ContractSpecs(rpc) },
      fetch: send,
    },
  );
  const bindings = new Map<string, Callback>();
  const context = {
    exposeBinding: async (name: string, callback: Callback) => {
      bindings.set(name, callback);
    },
    addInitScript: async () => {},
  };
  const frame = { url: () => 'http://localhost:3000/swap' };
  const page = { mainFrame: () => frame };
  timeline.watch('trader', wallet);
  await wallet.attach(
    pageHost(context as unknown as BrowserContext, (payload) =>
      timeline.call('trader', payload),
    ),
    { wallet: 'varial' },
  );
  const call = (payload: object) =>
    bindings.get('__stardust')?.({ context, page, frame }, payload);
  return { timeline, wallet, call, address: accounts[0].address };
}

function payment(source: string): string {
  return new TransactionBuilder(new SourceAccount(source, '7'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: payee,
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(0)
    .build()
    .toXDR();
}

function rpcCall(
  method: string,
  {
    startTime = start,
    responseEnd = 100,
    result = {},
    url = testnet.rpcUrl,
  } = {},
): PageRequest {
  return {
    url: () => url,
    method: () => 'POST',
    postData: () => JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    timing: () => ({ startTime, responseEnd }),
    failure: () => null,
    response: async () => ({
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    }),
  };
}

describe('Timeline', () => {
  it('renders prompts, wallet reads, RPC calls and outcomes by user', async () => {
    const { timeline, wallet, call, address } = await bench({
      connect: 'approve',
      signTransaction: 'manual',
    });
    await call({ type: 'REQUEST_ALLOWED_STATUS' });
    await call({ type: 'REQUEST_ACCESS' });
    timeline.request(
      'trader',
      rpcCall('simulateTransaction', {
        startTime: start + 1_000,
        responseEnd: 220,
      }),
    );

    at(2_100);
    const signing = call({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    at(2_500);
    await prompt.approve();
    await signing;
    const { hash } = prompt.transaction;
    timeline.request(
      'trader',
      rpcCall('sendTransaction', {
        startTime: start + 2_600,
        result: { status: 'PENDING', hash },
      }),
    );

    at(8_100);
    recordLanded(prompt, {
      status: 'success',
      hash,
      ledger: 5_757_773,
      feeCharged: 100n,
      feeBump: false,
      returnValue: undefined,
      events: [
        {
          contract: native,
          topics: ['transfer', address, payee, 'native'],
          data: xlm('1'),
        },
      ],
      balanceChanges: [
        { address, asset: native, change: -xlm('1') },
        { address: payee, asset: native, change: xlm('1') },
      ],
    });

    const pad = ' '.repeat(34);
    expect(renderTimeline(await timeline.entries())).toBe(
      [
        'Timeline:',
        '  0.0s  trader  isAllowed',
        '  0.0s  trader  connect           approved (localhost)',
        '  1.0s  trader  simulateTransaction  220ms',
        `  2.1s  trader  signTransaction   payment(destination: GBTO…JJZV, asset: native, amount: 10000000)  approved after 0.4s`,
        `  2.6s  trader  sendTransaction   PENDING  ${hash.slice(0, 8)}…`,
        `  8.1s  trader  landed            SUCCESS  https://stellar.expert/explorer/testnet/tx/${hash}`,
        `${pad}ledger 5757773`,
        `${pad}balance  ${address.slice(0, 4)}…${address.slice(-4)}  -1 XLM`,
        `${pad}balance  GBTO…JJZV  +1 XLM`,
        `${pad}event    CDLZ…CYSC  transfer`,
      ].join('\n'),
    );
    expect(signedNetwork(prompt)).toBe(Networks.TESTNET);
  });

  it('records strict-mode violations and blocked answers', async () => {
    const { timeline, wallet, call, address } = await bench('reject', true);
    at(1_000);
    await call({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(address),
    });
    expect(wallet.prompts()).toHaveLength(1);
    expect(renderTimeline(await timeline.entries())).toBe(
      [
        'Timeline:',
        '  1.0s  trader  violation         p1 missingNetworkPassphrase',
        '  1.0s  trader  signTransaction   payment(destination: GBTO…JJZV, asset: native, amount: 10000000)  rejected (networkMismatch)',
      ].join('\n'),
    );
  });

  it('shows the result code and contract error of a failed transaction', async () => {
    const { timeline, wallet, call, address } = await bench('approve', true);
    await call({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    at(3_000);
    recordLanded(prompt, {
      status: 'failed',
      hash: prompt.transaction.hash,
      ledger: 5_803_340,
      resultCode: 'txFAILED',
      contractError: { contract: native, code: 10, name: 'BalanceError' },
    });

    const pad = ' '.repeat(34);
    expect(renderTimeline(await timeline.entries())).toContain(
      [
        `  3.0s  trader  landed            FAILED   https://stellar.expert/explorer/testnet/tx/${prompt.transaction.hash}`,
        `${pad}ledger 5803340, txFAILED`,
        `${pad}contract error: BalanceError (CDLZ…CYSC, #10)`,
      ].join('\n'),
    );
  });

  it('keeps an outcome once known and shows an unknown one as UNKNOWN', async () => {
    const { timeline, wallet, call, address } = await bench('approve', true);
    await call({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    recordLanded(
      prompt,
      new Error(
        `transaction ${prompt.transaction.hash} didn't appear within 30s`,
      ),
    );
    expect(renderTimeline(await timeline.entries())).toContain(
      `landed            UNKNOWN  transaction ${prompt.transaction.hash} didn't appear within 30s`,
    );

    const landed: Landed = {
      status: 'failed',
      hash: prompt.transaction.hash,
      ledger: 1,
      resultCode: 'txBAD_SEQ',
      contractError: null,
    };
    recordLanded(prompt, landed);
    recordLanded(prompt, new Error('later'));
    const text = renderTimeline(await timeline.entries());
    expect(text).toContain('ledger 1, txBAD_SEQ');
    expect(text).not.toContain('UNKNOWN');
  });

  it('reads only POST calls to the wallet network RPC, and failed ones', async () => {
    const { timeline } = await bench('approve');
    timeline.request(
      'trader',
      rpcCall('getLatestLedger', { url: 'https://rpc.elsewhere.test' }),
    );
    timeline.request('trader', {
      ...rpcCall('getHealth'),
      method: () => 'OPTIONS',
    });
    timeline.request('trader', {
      ...rpcCall('getHealth'),
      postData: () => 'not json',
    });
    timeline.request(
      'trader',
      rpcCall('getHealth', { url: `${testnet.rpcUrl}/` }),
    );
    timeline.request('trader', {
      ...rpcCall('getNetwork'),
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    });
    expect(renderTimeline(await timeline.entries())).toBe(
      [
        'Timeline:',
        '  0.0s  trader  getHealth         100ms',
        '  0.0s  trader  getNetwork        failed: net::ERR_FAILED',
      ].join('\n'),
    );
  });

  it('gets outcomes from the checks that wait', async () => {
    const recorded = recordedResult('classic-payment');
    const { timeline, wallet, call, address } = await bench(
      'approve',
      true,
      answer(() => recorded),
    );
    await call({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    at(4_000);
    await check(prompt).toLand();
    at(5_000);
    await check(prompt).toChangeBalance(payee, 'native', xlm('2'));

    expect(renderTimeline(await timeline.entries())).toContain(
      `  4.0s  trader  landed            SUCCESS  https://stellar.expert/explorer/testnet/tx/${String(recorded.txHash)}`,
    );
  });

  it('says so when nothing happened', async () => {
    expect(renderTimeline(await new Timeline().entries())).toBe(
      'Timeline: nothing reached the wallet.',
    );
  });

  it('writes JSON with the start time and bigints as strings', async () => {
    const { timeline, wallet, call, address } = await bench('approve', true);
    await call({ type: 'REQUEST_PUBLIC_KEY' });
    await call({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: payment(address),
      networkPassphrase: Networks.TESTNET,
    });
    const prompt = await wallet.nextPrompt('signTransaction');
    at(1_500);
    recordLanded(prompt, {
      status: 'success',
      hash: prompt.transaction.hash,
      ledger: 7,
      feeCharged: 100n,
      feeBump: false,
      returnValue: undefined,
      events: [],
      balanceChanges: [{ address, asset: native, change: -xlm('1') }],
    });

    const file = JSON.parse(
      timelineJson(await timeline.entries(), timeline.startedAt),
    );
    expect(file).toEqual({
      startedAt: '2026-11-19T10:00:00.000Z',
      entries: [
        { at: 0, user: 'trader', type: 'read', method: 'getAddress' },
        {
          at: 0,
          user: 'trader',
          type: 'prompt',
          id: 'p1',
          kind: 'signTransaction',
          origin: 'http://localhost:3000',
          summary:
            'payment(destination: GBTO…JJZV, asset: native, amount: 10000000)',
          status: 'approved',
          blocked: null,
          answeredAfterMs: 0,
        },
        {
          at: 1_500,
          user: 'trader',
          type: 'landed',
          promptId: 'p1',
          networkPassphrase: Networks.TESTNET,
          outcome: {
            status: 'success',
            hash: prompt.transaction.hash,
            ledger: 7,
            feeCharged: '100',
            feeBump: false,
            events: [],
            balanceChanges: [{ address, asset: native, change: '-10000000' }],
          },
          explorer: `https://stellar.expert/explorer/testnet/tx/${prompt.transaction.hash}`,
          error: null,
        },
      ],
    });
  });
});
