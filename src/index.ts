import { checkAccountOptions } from '@/config/config';
import { ContractSpecs } from '@/contracts/spec';
import { createAccounts } from '@/funding/accounts';
import type { Account, AccountOptions } from '@/funding/accounts';
import { Funder } from '@/funding/funder';
import type { SubFunder } from '@/funding/funder';
import { Rpc, checkNetwork, resolveNetwork } from '@/network/network';
import type { CoreConfig, NetworkInfo } from '@/network/network';
import { EmulatedWallet } from '@/wallet/wallet';
import type { Wallet, WalletOptions } from '@/wallet/wallet';

export { units, xlm } from '@/amounts';
export { defineConfig } from '@/config/config';
export type { StardustConfig } from '@/config/config';
export { StardustError } from '@/errors';
export type { StardustErrorCode } from '@/errors';
export type { Account, AccountOptions } from '@/funding/accounts';
export type { Asset, BalanceChange, ContractEvent } from '@/network/events';
export type { ContractError, Landed } from '@/network/landing';
export type { CoreConfig, NetworkInfo } from '@/network/network';
export type {
  DecodedAuthEntry,
  DecodedAuthPreimage,
  DecodedOperation,
  DecodedTransaction,
  Invocation,
} from '@/wallet/decode';
export type { Policy, PolicyMode } from '@/wallet/policy';
export type {
  AddTokenPrompt,
  AuthEntryPrompt,
  BlockedReason,
  ConnectPrompt,
  Decision,
  MessagePrompt,
  Prompt,
  PromptKind,
  PromptOf,
  PromptStatus,
  TransactionPrompt,
  WaitOptions,
} from '@/wallet/prompts';
export type { Violation } from '@/wallet/strict';
export type { PageHost, Wallet, WalletOptions } from '@/wallet/wallet';

export interface Stardust {
  readonly network: NetworkInfo;
  readonly accounts: {
    create(options?: AccountOptions): Promise<Account>;
    createMany(options: readonly AccountOptions[]): Promise<Account[]>;
  };
  wallet(options: WalletOptions): Wallet;
}

export async function createStardust({
  network,
  fetch = globalThis.fetch.bind(globalThis),
}: CoreConfig): Promise<Stardust> {
  const rpc = new Rpc(resolveNetwork(network), fetch);
  const context = {
    rpc,
    specs: new ContractSpecs(rpc),
    network: await checkNetwork(rpc),
  };
  let subFunder: SubFunder | null = null;
  let previous: Promise<unknown> = Promise.resolve();

  // One at a time, since every creation is a transaction from the sub-funder.
  const fund = (options: readonly AccountOptions[]): Promise<Account[]> => {
    const created = previous.then(async () => {
      subFunder ??= await new Funder(context, { fetch }).createSubFunder();
      return createAccounts(subFunder, options);
    });
    previous = created.catch(() => undefined);
    return created;
  };

  return {
    network: context.network,
    accounts: {
      async create(options = {}) {
        checkAccountOptions('options', options);
        const [account] = await fund([options]);
        return account as Account;
      },
      async createMany(options) {
        options.forEach((option, index) =>
          checkAccountOptions(`options[${index}]`, option),
        );
        return fund(options);
      },
    },
    wallet: (options) =>
      new EmulatedWallet(options, {
        network: context.network,
        landing: context,
        fetch,
      }),
  };
}
