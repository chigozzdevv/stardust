import { Keypair, Operation } from '@stellar/stellar-sdk';
import { formatXlm, xlm } from '@/amounts';
import { loadAccounts, submit } from '@/funding/funder';
import type { SubFunder } from '@/funding/funder';

export interface Account {
  readonly address: string;
  readonly keypair: Keypair;
}

export interface AccountOptions {
  fund?: boolean | string;
}

const defaultBalance = xlm('100');

export async function createAccounts(
  subFunder: SubFunder,
  options: readonly AccountOptions[],
): Promise<Account[]> {
  const created = options.map((option) => ({
    account: randomAccount(),
    balance: startingBalance(option),
  }));
  const funded = created.flatMap(({ account, balance }) =>
    balance === null ? [] : [{ destination: account.address, balance }],
  );
  if (funded.length > 0) {
    const total = funded.reduce((sum, { balance }) => sum + balance, 0n);
    const source = await subFunder.topUp(total);
    await submit(
      subFunder.context,
      source,
      funded.map(({ destination, balance }) =>
        Operation.createAccount({
          destination,
          startingBalance: formatXlm(balance),
        }),
      ),
      [subFunder.keypair],
    );
  }
  return created.map(({ account }) => account);
}

export async function mergeAccounts(
  subFunder: SubFunder,
  accounts: readonly Account[],
): Promise<void> {
  const { context, address: destination } = subFunder;
  const onLedger = await loadAccounts(
    context.rpc,
    accounts.map(({ address }) => address),
  );
  const mergeable = accounts.filter(
    ({ address }) => onLedger.get(address)?.canMerge,
  );
  if (mergeable.length === 0) return;
  await submit(
    context,
    await subFunder.load(),
    mergeable.map(({ address }) =>
      Operation.accountMerge({ destination, source: address }),
    ),
    [subFunder.keypair, ...mergeable.map(({ keypair }) => keypair)],
  );
}

function randomAccount(): Account {
  const keypair = Keypair.random();
  return { address: keypair.publicKey(), keypair };
}

function startingBalance({ fund = true }: AccountOptions): bigint | null {
  if (fund === false) return null;
  return fund === true ? defaultBalance : xlm(fund);
}
