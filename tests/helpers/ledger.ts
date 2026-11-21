import {
  Address,
  Asset,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import { xlm } from '@/amounts';
import { ContractSpecs } from '@/contracts/spec';
import type { FundingContext } from '@/funding/funder';
import { Rpc } from '@/network/rpc';
import type { NetworkInfo } from '@/network/rpc';
import { answer } from '@tests/helpers/replay';
import type { RpcRequest } from '@tests/helpers/replay';

export interface AccountState {
  balance: bigint;
  sequence: bigint;
  subentries?: number;
  sponsoring?: number;
  thresholds?: readonly number[];
  flags?: number;
}

export interface NetworkState {
  passphrase: string;
  friendbotUrl?: string;
  protocolVersion: number;
}

const rpcUrl = 'https://rpc.stardust.test';
const friendbotUrl = 'https://friendbot.stardust.test/';
const baseFee = 100n;
const minimumBalance = xlm('1');
const subentryReserve = xlm('0.5');
const maxLimit = 9_223_372_036_854_775_807n;

// A small in-memory stand-in for an RPC and its Friendbot: it applies
// createAccount, payment, accountMerge and changeTrust (which stores the
// trustline), checks sequence numbers, fee balances, reserves and signatures,
// and answers getTransaction once a transaction lands.
export class FakeLedger {
  readonly accounts = new Map<string, AccountState>();
  readonly transactions: Transaction[] = [];
  readonly friendbotCalls: string[] = [];
  friendbot: (address: string) => Response = (address) => this.fund(address);
  network: NetworkState = {
    passphrase: Networks.TESTNET,
    friendbotUrl,
    protocolVersion: 23,
  };
  lands = true;
  private readonly results = new Map<string, object>();
  private readonly stored = new Map<string, xdr.LedgerEntryData>();
  private ledger = 5_000;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.href.startsWith(friendbotUrl)) {
      const address = url.searchParams.get('addr') ?? '';
      this.friendbotCalls.push(address);
      return this.friendbot(address);
    }
    return answer((request) => this.answer(request))(input, init);
  };

  context(network: Partial<NetworkInfo> = {}): FundingContext {
    const rpc = new Rpc(rpcUrl, this.fetch);
    return {
      rpc,
      specs: new ContractSpecs(rpc),
      network: {
        name: 'testnet',
        rpcUrl,
        networkPassphrase: Networks.TESTNET,
        friendbotUrl,
        protocolVersion: 23,
        ...network,
      },
      wait: { timeoutMs: 200, intervalMs: 1 },
    };
  }

  balance(address: string): bigint | undefined {
    return this.accounts.get(address)?.balance;
  }

  store(...entries: readonly xdr.LedgerEntryData[]): void {
    for (const entry of entries) {
      this.stored.set(ledgerKey(entry).toXdr('base64'), entry);
    }
  }

  private answer({ method, params }: RpcRequest): unknown {
    switch (method) {
      case 'getHealth':
        return { status: 'healthy', latestLedger: this.ledger };
      case 'getNetwork':
        return this.network;
      case 'getLedgerEntries':
        return this.entries((params as { keys: string[] }).keys);
      case 'sendTransaction':
        return this.send((params as { transaction: string }).transaction);
      case 'getTransaction':
        return (
          this.results.get((params as { hash: string }).hash) ?? {
            status: 'NOT_FOUND',
            latestLedger: this.ledger,
          }
        );
      default:
        throw new Error(`the fake ledger doesn't answer ${method}`);
    }
  }

  private entries(keys: readonly string[]) {
    return {
      latestLedger: this.ledger,
      entries: keys.flatMap((key) => {
        const entry = this.entry(key);
        if (!entry) return [];
        return [
          {
            key,
            xdr: entry.toXdr('base64'),
            lastModifiedLedgerSeq: this.ledger,
          },
        ];
      }),
    };
  }

  private entry(key: string): xdr.LedgerEntryData | undefined {
    const parsed = xdr.LedgerKey.fromXdr(key, 'base64');
    if (parsed.type !== 'account') return this.stored.get(key);
    const address = StrKey.encodeEd25519PublicKey(
      parsed.account.accountId.ed25519.value,
    );
    const state = this.accounts.get(address);
    return state && accountEntry(address, state);
  }

  private send(envelopeXdr: string) {
    const transaction = TransactionBuilder.fromXDR(
      envelopeXdr,
      Networks.TESTNET,
    ) as Transaction;
    const hash = Buffer.from(transaction.hash()).toString('hex');
    this.transactions.push(transaction);
    const source = this.accounts.get(transaction.source);
    const rejection = source
      ? this.rejection(transaction, source)
      : xdr.TransactionResultResult.txNoAccount();
    if (rejection) {
      return {
        status: 'ERROR',
        hash,
        latestLedger: this.ledger,
        errorResultXdr: transactionResult(rejection, 0n),
      };
    }
    if (source && this.lands) this.land(transaction, source, envelopeXdr);
    return { status: 'PENDING', hash, latestLedger: this.ledger };
  }

  private land(
    transaction: Transaction,
    source: AccountState,
    envelopeXdr: string,
  ): void {
    const hash = Buffer.from(transaction.hash()).toString('hex');
    const fee = baseFee * BigInt(transaction.operations.length);
    source.sequence += 1n;
    source.balance -= fee;
    this.ledger += 1;
    const applied = this.apply(transaction);
    this.results.set(hash, {
      status: applied ? 'SUCCESS' : 'FAILED',
      txHash: hash,
      ledger: this.ledger,
      latestLedger: this.ledger,
      feeBump: false,
      envelopeXdr,
      resultXdr: transactionResult(
        applied
          ? xdr.TransactionResultResult.txSuccess([])
          : xdr.TransactionResultResult.txFailed([]),
        fee,
      ),
      resultMetaXdr: xdr.TransactionMeta.operations([]).toXdr('base64'),
      events: {},
    });
  }

  private rejection(
    transaction: Transaction,
    source: AccountState,
  ): xdr.TransactionResultResult | null {
    if (BigInt(transaction.sequence) !== source.sequence + 1n) {
      return xdr.TransactionResultResult.txBadSeq();
    }
    if (source.balance - BigInt(transaction.fee) < minimumBalance) {
      return xdr.TransactionResultResult.txInsufficientBalance();
    }
    const signers = new Set([
      transaction.source,
      ...transaction.operations.map(
        (operation) => operation.source ?? transaction.source,
      ),
    ]);
    const hash = transaction.hash();
    const signed = [...signers].every((address) =>
      transaction.signatures.some(({ signature }) =>
        Keypair.fromPublicKey(address).verify(hash, signature),
      ),
    );
    if (!signed) return xdr.TransactionResultResult.txBadAuth();
    if (transaction.signatures.length > signers.size) {
      return xdr.TransactionResultResult.txBadAuthExtra();
    }
    return null;
  }

  private apply(transaction: Transaction): boolean {
    const next = new Map(
      [...this.accounts].map(([address, state]) => [address, { ...state }]),
    );
    const trustlines: xdr.LedgerEntryData[] = [];
    for (const operation of transaction.operations) {
      const sourceAddress = operation.source ?? transaction.source;
      const from = next.get(sourceAddress);
      if (!from) return false;
      if (operation.type === 'createAccount') {
        const amount = xlm(operation.startingBalance);
        if (
          next.has(operation.destination) ||
          amount < minimumBalance ||
          from.balance < amount
        ) {
          return false;
        }
        from.balance -= amount;
        next.set(operation.destination, {
          balance: amount,
          sequence: BigInt(this.ledger) << 32n,
        });
      } else if (operation.type === 'payment') {
        const to = next.get(operation.destination);
        const amount = xlm(operation.amount);
        if (!to || from.balance < amount) return false;
        from.balance -= amount;
        to.balance += amount;
      } else if (operation.type === 'accountMerge') {
        const to = next.get(operation.destination);
        if (!to || from.subentries || from.sponsoring) return false;
        to.balance += from.balance;
        next.delete(sourceAddress);
      } else if (operation.type === 'changeTrust') {
        const subentries = (from.subentries ?? 0) + 1;
        if (
          from.balance <
          minimumBalance + subentryReserve * BigInt(subentries)
        ) {
          return false;
        }
        from.subentries = subentries;
        if (operation.line instanceof Asset) {
          trustlines.push(trustlineEntry(sourceAddress, operation.line));
        }
      } else {
        return false;
      }
    }
    this.accounts.clear();
    next.forEach((state, address) => this.accounts.set(address, state));
    this.store(...trustlines);
    return true;
  }

  private fund(address: string): Response {
    if (this.accounts.has(address)) {
      return Response.json(
        { detail: 'createAccountAlreadyExist' },
        { status: 400 },
      );
    }
    this.ledger += 1;
    this.accounts.set(address, {
      balance: xlm('10000'),
      sequence: BigInt(this.ledger) << 32n,
    });
    return Response.json({ successful: true });
  }
}

function accountEntry(
  address: string,
  {
    balance,
    sequence,
    subentries = 0,
    sponsoring = 0,
    thresholds = [1, 0, 0, 0],
    flags = 0,
  }: AccountState,
): xdr.LedgerEntryData {
  const ext =
    sponsoring === 0
      ? xdr.AccountEntryExt.v0()
      : xdr.AccountEntryExt.v1(
          new xdr.AccountEntryExtensionV1({
            liabilities: new xdr.Liabilities({ buying: 0n, selling: 0n }),
            ext: xdr.AccountEntryExtensionV1Ext.v2(
              new xdr.AccountEntryExtensionV2({
                numSponsored: 0,
                numSponsoring: sponsoring,
                signerSponsoringIDs: [],
                ext: xdr.AccountEntryExtensionV2Ext.v0(),
              }),
            ),
          }),
        );
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      balance,
      seqNum: sequence,
      numSubEntries: subentries,
      inflationDest: null,
      flags,
      homeDomain: '',
      thresholds: new Uint8Array(thresholds),
      signers: [],
      ext,
    }),
  );
}

function transactionResult(
  result: xdr.TransactionResultResult,
  feeCharged: bigint,
): string {
  return new xdr.TransactionResult({
    feeCharged,
    result,
    ext: xdr.TransactionResultExt.v0(),
  }).toXdr('base64');
}

export function sacInstance(
  contractId: string,
  name: string,
): xdr.LedgerEntryData {
  const metadata = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('name'),
      val: xdr.ScVal.scvString(name),
    }),
  ]);
  return contractInstance(
    contractId,
    xdr.ContractExecutable.contractExecutableStellarAsset(),
    [
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('METADATA'),
        val: metadata,
      }),
    ],
  );
}

export function wasmInstance(contractId: string): xdr.LedgerEntryData {
  return contractInstance(
    contractId,
    xdr.ContractExecutable.contractExecutableWasm(new Uint8Array(32)),
    [],
  );
}

export function trustlineEntry(
  address: string,
  asset: Asset,
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      asset: asset.toTrustLineXDRObject(),
      balance: 0n,
      limit: maxLimit,
      flags: 1,
      ext: xdr.TrustLineEntryExt.v0(),
    }),
  );
}

function contractInstance(
  contractId: string,
  executable: xdr.ContractExecutable,
  storage: xdr.ScMapEntry[],
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({ executable, storage }),
      ),
    }),
  );
}

function ledgerKey(entry: xdr.LedgerEntryData): xdr.LedgerKey {
  switch (entry.type) {
    case 'contractData': {
      const { contract, key, durability } = entry.contractData;
      return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({ contract, key, durability }),
      );
    }
    case 'trustline': {
      const { accountId, asset } = entry.trustLine;
      return xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({ accountId, asset }),
      );
    }
    default:
      throw new Error(`the fake ledger doesn't store ${entry.type} entries`);
  }
}
