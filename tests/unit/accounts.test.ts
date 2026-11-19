import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthImmutableFlag } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { xlm } from '@/amounts';
import { createAccounts, mergeAccounts } from '@/funding/accounts';
import type { Account } from '@/funding/accounts';
import { Funder } from '@/funding/funder';
import type { SubFunder } from '@/funding/funder';
import { FakeLedger } from '@tests/fixtures/rpc/fake-ledger';
import type { AccountState } from '@tests/fixtures/rpc/fake-ledger';

const fee = 100n;

let dir: string;
let ledger: FakeLedger;
let subFunder: SubFunder;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stardust-accounts-'));
  ledger = new FakeLedger();
  const funder = new Funder(ledger.context(), { dir, fetch: ledger.fetch });
  subFunder = await funder.createSubFunder();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sentSince(count: number) {
  return ledger.transactions.slice(count);
}

function change(account: Account, state: Partial<AccountState>): void {
  const onLedger = ledger.accounts.get(account.address);
  if (!onLedger) throw new Error(`${account.address} isn't on the fake ledger`);
  Object.assign(onLedger, state);
}

describe('createAccounts', () => {
  it('creates every funded account in one transaction from the sub-funder', async () => {
    const before = ledger.transactions.length;
    const accounts = await createAccounts(subFunder, [
      {},
      { fund: '500' },
      { fund: true },
      { fund: false },
    ]);

    expect(new Set(accounts.map(({ address }) => address)).size).toBe(4);
    for (const { address, keypair } of accounts) {
      expect(keypair.publicKey()).toBe(address);
    }
    const [transaction, ...others] = sentSince(before);
    expect(others).toEqual([]);
    expect(transaction?.source).toBe(subFunder.address);
    const [first, second, third] = accounts as [Account, Account, Account];
    expect(transaction?.operations).toEqual([
      {
        type: 'createAccount',
        destination: first.address,
        startingBalance: '100.0000000',
      },
      {
        type: 'createAccount',
        destination: second.address,
        startingBalance: '500.0000000',
      },
      {
        type: 'createAccount',
        destination: third.address,
        startingBalance: '100.0000000',
      },
    ]);
    expect(accounts.map(({ address }) => ledger.balance(address))).toEqual([
      xlm('100'),
      xlm('500'),
      xlm('100'),
      undefined,
    ]);
    expect(ledger.balance(subFunder.address)).toBe(
      xlm('2000') - xlm('700') - 3n * fee,
    );
  });

  it('only generates keypairs when no account is funded', async () => {
    const before = ledger.transactions.length;
    const accounts = await createAccounts(subFunder, [
      { fund: false },
      { fund: false },
    ]);

    expect(accounts).toHaveLength(2);
    expect(sentSince(before)).toEqual([]);
  });

  it('tops up the sub-funder first when it holds less than the total plus 10 XLM', async () => {
    const before = ledger.transactions.length;
    await createAccounts(subFunder, [{ fund: '1000' }, { fund: '1000' }]);

    const sent = sentSince(before);
    expect(sent).toHaveLength(2);
    const [topUp, create] = sent;
    expect(topUp?.operations).toMatchObject([
      {
        type: 'payment',
        destination: subFunder.address,
        amount: '2000.0000000',
      },
    ]);
    expect(create?.source).toBe(subFunder.address);
    expect(ledger.balance(subFunder.address)).toBe(
      xlm('2000') + xlm('2000') - xlm('2000') - 2n * fee,
    );
  });

  it('fails with FUNDING_FAILED when the creation transaction fails', async () => {
    await expect(
      createAccounts(subFunder, [{ fund: '0.5' }]),
    ).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      retryable: true,
      message: expect.stringMatching(
        /^Stardust's funding transaction [0-9a-f]{64} failed with txFAILED\./,
      ),
    });
  });
});

describe('mergeAccounts', () => {
  it("merges the test's accounts back into the sub-funder in one transaction signed by each account", async () => {
    const accounts = await createAccounts(subFunder, [{}, { fund: '50' }]);
    const before = ledger.transactions.length;
    const held = ledger.balance(subFunder.address) ?? 0n;
    await mergeAccounts(subFunder, accounts);

    const [merge, ...others] = sentSince(before);
    expect(others).toEqual([]);
    expect(merge?.source).toBe(subFunder.address);
    expect(merge?.operations).toEqual(
      accounts.map(({ address }) => ({
        type: 'accountMerge',
        source: address,
        destination: subFunder.address,
      })),
    );
    expect(merge?.signatures).toHaveLength(3);
    for (const { address } of accounts) {
      expect(ledger.accounts.has(address)).toBe(false);
    }
    expect(ledger.balance(subFunder.address)).toBe(
      held + xlm('150') - 2n * fee,
    );
  });

  it('pays the fee from the sub-funder, so accounts left at their reserve still merge', async () => {
    const accounts = await createAccounts(subFunder, [{ fund: '1' }]);
    await mergeAccounts(subFunder, accounts);

    expect(ledger.accounts.has(accounts[0]?.address ?? '')).toBe(false);
  });

  it('leaves out accounts that cannot be merged', async () => {
    const accounts = await createAccounts(subFunder, [
      {},
      {},
      {},
      {},
      {},
      { fund: false },
    ]);
    const [mergeable, trustline, sponsor, multisig, issuer, unfunded] =
      accounts as [Account, Account, Account, Account, Account, Account];
    change(trustline, { subentries: 1 });
    change(sponsor, { sponsoring: 1 });
    change(multisig, { thresholds: [1, 0, 0, 2] });
    change(issuer, { flags: AuthImmutableFlag });
    const before = ledger.transactions.length;
    await mergeAccounts(subFunder, accounts);

    const [merge, ...others] = sentSince(before);
    expect(others).toEqual([]);
    expect(merge?.operations).toEqual([
      {
        type: 'accountMerge',
        source: mergeable.address,
        destination: subFunder.address,
      },
    ]);
    expect(ledger.accounts.has(mergeable.address)).toBe(false);
    for (const kept of [trustline, sponsor, multisig, issuer]) {
      expect(ledger.balance(kept.address)).toBe(xlm('100'));
    }
    expect(ledger.accounts.has(unfunded.address)).toBe(false);
  });

  it('sends nothing when no account can be merged', async () => {
    const accounts = await createAccounts(subFunder, [
      { fund: false },
      { fund: false },
    ]);
    const before = ledger.transactions.length;
    await mergeAccounts(subFunder, accounts);
    await mergeAccounts(subFunder, []);

    expect(sentSince(before)).toEqual([]);
  });
});
