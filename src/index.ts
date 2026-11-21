import { checkAccountOptions } from '@/config/load';
import { ContractSpecs } from '@/contracts/spec';
import { createAccounts } from '@/funding/accounts';
import type { Account, AccountOptions } from '@/funding/accounts';
import { Funder } from '@/funding/funder';
import type { SubFunder } from '@/funding/funder';
import { Rpc, checkNetwork, resolveNetwork } from '@/network/rpc';
import type { CoreConfig, NetworkInfo } from '@/network/rpc';
import { EmulatedWallet } from '@/wallet/emulated';
import type { Wallet, WalletOptions } from '@/wallet/emulated';

export { units, xlm } from '@/amounts';
export { defineConfig } from '@/config/load';
export type { StardustConfig } from '@/config/load';
export { StardustError } from '@/errors';
export type { StardustErrorCode } from '@/errors';
export type { Account, AccountOptions } from '@/funding/accounts';
export type { Asset, BalanceChange, ContractEvent } from '@/network/events';
export type { ContractError, Landed } from '@/network/landing';
export type { CoreConfig, NetworkInfo } from '@/network/rpc';
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
export type { PageHost, Wallet, WalletOptions } from '@/wallet/emulated';

/** Stardust's core, for setups that don't use `stardust-stellar/test`. */
export interface Stardust {
  /** The network, as checked by `createStardust`. */
  readonly network: NetworkInfo;
  /** Creates throwaway accounts, funded from the machine's testnet funder. */
  readonly accounts: {
    create(options?: AccountOptions): Promise<Account>;
    /** Creates several accounts in one transaction. */
    createMany(options: readonly AccountOptions[]): Promise<Account[]>;
  };
  /** Creates an emulated wallet. Call `attach` on it to put it in a page. */
  wallet(options: WalletOptions): Wallet;
}

/**
 * Checks the network and returns Stardust's core: accounts and wallets. Use
 * it directly only for custom setups; tests normally use
 * `stardust-stellar/test`. Throws `NETWORK_UNREACHABLE` when the RPC isn't
 * healthy and `MAINNET_REFUSED` on mainnet.
 */
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
