import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Asset,
  AuthImmutableFlag,
  Keypair,
  Operation,
  Account as SourceAccount,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { formatXlm, xlm } from '@/amounts';
import { StardustError } from '@/errors';
import { withLock } from '@/funding/lock-file';
import type { LockOptions } from '@/funding/lock-file';
import { landed, resultCode } from '@/network/landing';
import type { LandingContext, LandingOptions } from '@/network/landing';
import { networkId, refuseMainnet } from '@/network/rpc';
import type { NetworkInfo, Rpc } from '@/network/rpc';

export interface FundingContext extends LandingContext {
  readonly network: NetworkInfo;
  readonly wait?: LandingOptions;
}

export interface FunderOptions {
  dir?: string;
  fetch?: typeof fetch;
  lock?: LockOptions;
}

export interface LedgerAccount {
  readonly address: string;
  readonly sequence: string;
  readonly balance: bigint;
  readonly canMerge: boolean;
}

const subFunderBalance = xlm('2000');
const refillBelow = xlm('1000');
const spare = xlm('10');
const feePerOperation = '10000';
const friendbotTimeoutMs = 30_000;

export class Funder {
  private readonly friendbot: URL;
  private readonly dir: string;
  private readonly keyFile: string;
  private readonly lockFile: string;
  private readonly fetch: typeof fetch;
  private readonly lockOptions: LockOptions;

  constructor(
    readonly context: FundingContext,
    options: FunderOptions = {},
  ) {
    const { networkPassphrase, friendbotUrl, rpcUrl } = context.network;
    refuseMainnet(networkPassphrase);
    const friendbot = friendbotUrl ? URL.parse(friendbotUrl) : null;
    if (!friendbot) {
      throw new StardustError(
        'FUNDING_FAILED',
        `${rpcUrl} reports no Friendbot, so Stardust has no funder for test accounts on this network. Use 'testnet', or an RPC for a network with a Friendbot.`,
      );
    }
    const name = networkId(networkPassphrase).toString('hex');
    this.friendbot = friendbot;
    this.dir = options.dir ?? join(homedir(), '.stardust', 'funders');
    this.keyFile = join(this.dir, `${name}.json`);
    this.lockFile = join(this.dir, `${name}.lock`);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.lockOptions = options.lock ?? {};
  }

  async createSubFunder(): Promise<SubFunder> {
    const keypair = Keypair.random();
    const funder = await this.spend(
      subFunderBalance,
      Operation.createAccount({
        destination: keypair.publicKey(),
        startingBalance: formatXlm(subFunderBalance),
      }),
    );
    return new SubFunder(this, keypair, funder);
  }

  async pay(destination: string, amount: bigint): Promise<void> {
    await this.spend(
      amount,
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: formatXlm(amount),
      }),
    );
  }

  private async spend(
    amount: bigint,
    operation: xdr.Operation,
  ): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    return withLock(
      this.lockFile,
      async () => {
        const keypair = await this.key();
        const account = await this.funded(keypair.publicKey(), amount);
        if (account.balance - amount < spare) {
          throw new StardustError(
            'FUNDING_FAILED',
            `the funder ${account.address} holds ${formatXlm(account.balance)} XLM, which isn't enough to send ${formatXlm(amount)} XLM. Declare less XLM per test, or run the tests again to refill it.`,
          );
        }
        await submit(this.context, account, [operation], [keypair]);
        return account.address;
      },
      this.lockOptions,
    );
  }

  private async key(): Promise<Keypair> {
    const saved = await readFile(this.keyFile, 'utf8').catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      },
    );
    if (saved === null) {
      const keypair = Keypair.random();
      const file = {
        network: this.context.network.networkPassphrase,
        address: keypair.publicKey(),
        secretKey: keypair.secret(),
      };
      await writeFile(this.keyFile, `${JSON.stringify(file, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      return keypair;
    }
    const keypair = readKey(saved);
    if (!keypair) {
      throw new StardustError(
        'FUNDING_FAILED',
        `${this.keyFile} isn't a funder key Stardust can read. Move it out of ${this.dir}, then run the tests again to create a new funder.`,
      );
    }
    return keypair;
  }

  private async funded(
    address: string,
    amount: bigint,
  ): Promise<LedgerAccount> {
    const account = await loadAccount(this.context.rpc, address);
    if (!account) return this.fromFriendbot(address);
    return account.balance - amount < refillBelow
      ? this.refill(address)
      : account;
  }

  private async refill(address: string): Promise<LedgerAccount> {
    const extra = Keypair.random();
    const source = await this.fromFriendbot(extra.publicKey());
    await submit(
      this.context,
      source,
      [Operation.accountMerge({ destination: address })],
      [extra],
    );
    return this.visible(address);
  }

  private async fromFriendbot(address: string): Promise<LedgerAccount> {
    const url = new URL(this.friendbot);
    url.searchParams.set('addr', address);
    const response = await this.fetch(url, {
      signal: AbortSignal.timeout(friendbotTimeoutMs),
    }).catch((error: unknown) => {
      throw new StardustError(
        'FUNDING_FAILED',
        `Friendbot at ${this.friendbot.href} didn't answer. Check your connection, then run the tests again.`,
        { cause: error },
      );
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new StardustError(
        'FUNDING_FAILED',
        `Friendbot at ${this.friendbot.href} refused to fund ${address} with HTTP ${response.status}. It's rate limited, so wait a few minutes, then run the tests again.`,
      );
    }
    return this.visible(address);
  }

  private async visible(address: string): Promise<LedgerAccount> {
    const { timeoutMs = 30_000, intervalMs = 1_000 } = this.context.wait ?? {};
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const account = await loadAccount(this.context.rpc, address);
      if (account) return account;
      if (Date.now() >= deadline) {
        throw new StardustError(
          'FUNDING_FAILED',
          `${address} was funded, but ${this.context.network.rpcUrl} didn't show the account within ${timeoutMs / 1000}s. Check the RPC, then run the tests again.`,
        );
      }
      await sleep(intervalMs);
    }
  }
}

export class SubFunder {
  readonly context: FundingContext;
  readonly address: string;

  constructor(
    private readonly funder: Funder,
    readonly keypair: Keypair,
    private readonly funderAddress: string,
  ) {
    this.context = funder.context;
    this.address = keypair.publicKey();
  }

  async load(): Promise<LedgerAccount> {
    const account = await loadAccount(this.context.rpc, this.address);
    if (!account) {
      throw new StardustError(
        'FUNDING_FAILED',
        `the sub-funder ${this.address} no longer exists on the network, for example after a testnet reset. Run the tests again.`,
      );
    }
    return account;
  }

  async topUp(total: bigint): Promise<LedgerAccount> {
    const account = await this.load();
    const amount = topUpAmount(account.balance, total);
    if (amount > 0n) await this.funder.pay(this.address, amount);
    return { ...account, balance: account.balance + amount };
  }

  async release(): Promise<void> {
    const account = await loadAccount(this.context.rpc, this.address);
    if (!account) return;
    await submit(
      this.context,
      account,
      [Operation.accountMerge({ destination: this.funderAddress })],
      [this.keypair],
    );
  }
}

export function topUpAmount(balance: bigint, total: bigint): bigint {
  const shortfall = total + spare - balance;
  if (shortfall <= 0n) return 0n;
  return ((shortfall - 1n) / subFunderBalance + 1n) * subFunderBalance;
}

export async function submit(
  context: FundingContext,
  source: LedgerAccount,
  operations: readonly xdr.Operation[],
  signers: readonly Keypair[],
): Promise<void> {
  const { networkPassphrase, rpcUrl } = context.network;
  refuseMainnet(networkPassphrase);
  const builder = new TransactionBuilder(
    new SourceAccount(source.address, source.sequence),
    { fee: feePerOperation, networkPassphrase },
  );
  for (const operation of operations) builder.addOperation(operation);
  const transaction = builder.setTimeout(30).build();
  transaction.sign(...signers);
  const sent = await context.rpc.call('sendTransaction', {
    transaction: transaction.toXDR(),
  });
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    const code = sent.errorResultXdr
      ? resultCode(xdr.TransactionResult.fromXdr(sent.errorResultXdr, 'base64'))
      : sent.status;
    throw new StardustError(
      'FUNDING_FAILED',
      `${rpcUrl} rejected Stardust's funding transaction ${sent.hash} with ${code}. Run the tests again, and report it if it keeps happening.`,
    );
  }
  const { timeoutMs = 30_000 } = context.wait ?? {};
  const result = await landed(context, sent.hash, {
    ...context.wait,
    timeoutMs,
  }).catch((error: unknown) => {
    if (!(error instanceof StardustError) || error.code !== 'OUTCOME_UNKNOWN') {
      throw error;
    }
    throw new StardustError(
      'OUTCOME_UNKNOWN',
      `Stardust's funding transaction ${sent.hash} didn't appear on the network within ${timeoutMs / 1000}s, so its outcome is unknown. Check ${rpcUrl}, then run the tests again.`,
      { cause: error },
    );
  });
  if (result.status === 'failed') {
    throw new StardustError(
      'FUNDING_FAILED',
      `Stardust's funding transaction ${result.hash} failed with ${result.resultCode}. Run the tests again, and report it if it keeps happening.`,
    );
  }
}

export async function loadAccounts(
  rpc: Rpc,
  addresses: readonly string[],
): Promise<Map<string, LedgerAccount>> {
  if (addresses.length === 0) return new Map();
  const { entries } = await rpc.call('getLedgerEntries', {
    keys: addresses.map(accountKey),
  });
  const accounts = entries.flatMap((entry) => {
    const data = xdr.LedgerEntryData.fromXdr(entry.xdr, 'base64');
    return data.type === 'account' ? [ledgerAccount(data.account)] : [];
  });
  return new Map(accounts.map((account) => [account.address, account]));
}

export async function loadAccount(
  rpc: Rpc,
  address: string,
): Promise<LedgerAccount | null> {
  return (await loadAccounts(rpc, [address])).get(address) ?? null;
}

function accountKey(address: string): string {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId })).toXdr(
    'base64',
  );
}

// accountMerge fails for an account with subentries (trustlines, offers, data,
// signers), one that sponsors reserves, an immutable issuer, and one whose
// master key doesn't meet its high threshold.
function ledgerAccount(entry: xdr.AccountEntry): LedgerAccount {
  const [master = 0, , , high = 0] = entry.thresholds.value;
  const { ext } = entry;
  const sponsoring =
    ext.type === 'v1' && ext.v1.ext.type === 'v2'
      ? ext.v1.ext.v2.numSponsoring
      : 0;
  return {
    address: StrKey.encodeEd25519PublicKey(entry.accountId.ed25519.value),
    sequence: entry.seqNum.toString(),
    balance: entry.balance,
    canMerge:
      entry.numSubEntries === 0 &&
      sponsoring === 0 &&
      (entry.flags & AuthImmutableFlag) === 0 &&
      master > 0 &&
      master >= high,
  };
}

function readKey(text: string): Keypair | null {
  try {
    const { secretKey } = JSON.parse(text) as { secretKey?: unknown };
    return typeof secretKey === 'string' ? Keypair.fromSecret(secretKey) : null;
  } catch {
    return null;
  }
}
