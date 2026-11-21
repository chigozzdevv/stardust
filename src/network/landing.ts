import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { ContractSpecs } from '@/contracts/spec';
import { StardustError } from '@/errors';
import {
  balanceChanges,
  contractEvents,
  contractFailure,
  decodeEvents,
} from '@/network/events';
import type {
  BalanceChange,
  ContractEvent,
  ContractFailure,
} from '@/network/events';
import type { Rpc } from '@/network/rpc';
import type { TransactionInfo } from '@/network/schema';

/**
 * A transaction's outcome once it's in a ledger. A transaction that doesn't
 * appear in time throws `OUTCOME_UNKNOWN` instead.
 */
export type Landed =
  | {
      readonly status: 'success';
      /** The transaction hash, hex. */
      readonly hash: string;
      readonly ledger: number;
      /** The fee charged, in stroops. */
      readonly feeCharged: bigint;
      /** Whether the transaction landed inside a fee bump. */
      readonly feeBump: boolean;
      /** A contract call's return value, converted from XDR, or `undefined`. */
      readonly returnValue: unknown;
      /** The contract events the transaction emitted. */
      readonly events: readonly ContractEvent[];
      /** Every balance the transaction changed, read from its events. Fees aren't included. */
      readonly balanceChanges: readonly BalanceChange[];
    }
  | {
      readonly status: 'failed';
      /** The transaction hash, hex. */
      readonly hash: string;
      readonly ledger: number;
      /** The transaction's result code, such as `'txFAILED'`. */
      readonly resultCode: string;
      /** The contract error that made it fail, when a contract call failed with one. */
      readonly contractError: ContractError | null;
    };

/** An error a contract returned. */
export interface ContractError {
  /** The contract that returned the error, `C...`. */
  readonly contract: string;
  readonly code: number;
  /** The error's name from the contract's spec, or `null` when the spec can't be read. */
  readonly name: string | null;
}

export interface LandingContext {
  readonly rpc: Rpc;
  readonly specs: ContractSpecs;
}

export interface LandingOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface AuthEntryQuery {
  readonly address: string;
  readonly nonce: bigint;
  readonly fromLedger: number;
}

const pageLimit = 50;

export async function landed(
  context: LandingContext,
  hash: string,
  options: LandingOptions = {},
): Promise<Landed> {
  const info = await poll(
    async (signal) => {
      const result = await context.rpc.call('getTransaction', { hash }, signal);
      return result.status === 'NOT_FOUND' ? null : result;
    },
    options,
    (seconds) =>
      `transaction ${hash} didn't appear on the network within ${seconds}s, so its outcome is unknown. Check that the app sends it, or pass a longer timeoutMs.`,
  );
  return toLanded(context, info, options.signal);
}

export async function authEntryLanded(
  context: LandingContext,
  entry: AuthEntryQuery,
  options: LandingOptions = {},
): Promise<Landed> {
  let cursor: string | null = null;
  const info = await poll(
    async (signal) => {
      for (;;) {
        const page = await context.rpc.call(
          'getTransactions',
          cursor
            ? { pagination: { cursor, limit: pageLimit } }
            : {
                startLedger: entry.fromLedger,
                pagination: { limit: pageLimit },
              },
          signal,
        );
        cursor = page.cursor;
        const found = page.transactions.find((transaction) =>
          carriesAuthEntry(transaction.envelopeXdr, entry),
        );
        if (found) return found;
        if (page.transactions.length < pageLimit) return null;
      }
    },
    options,
    (seconds) =>
      `no transaction with the auth entry of ${entry.address} (nonce ${entry.nonce}) appeared on the network within ${seconds}s, so its outcome is unknown. Check that the app or its relayer sends it, or pass a longer timeoutMs.`,
  );
  return toLanded(context, info, options.signal);
}

async function poll<T>(
  attempt: (signal: AbortSignal) => Promise<T | null>,
  { timeoutMs = 30_000, intervalMs = 1_000, signal }: LandingOptions,
  message: (seconds: number) => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let cause: unknown;
  for (;;) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.max(deadline - Date.now(), 1));
    try {
      const found = await attempt(
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
      if (found) return found;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      cause = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StardustError('OUTCOME_UNKNOWN', message(timeoutMs / 1000), {
        cause,
      });
    }
    await sleep(Math.min(intervalMs, remaining), signal);
  }
}

async function toLanded(
  { specs }: LandingContext,
  info: TransactionInfo,
  signal?: AbortSignal,
): Promise<Landed> {
  const result = xdr.TransactionResult.fromXdr(info.resultXdr, 'base64');
  const where = { hash: info.txHash, ledger: info.ledger };
  if (info.status === 'FAILED') {
    const failure = contractFailure(info.diagnosticEventsXdr);
    return {
      status: 'failed',
      ...where,
      resultCode: resultCode(result),
      contractError: failure && {
        ...failure,
        name: await errorName(specs, failure, signal),
      },
    };
  }
  const events = decodeEvents(info.events.contractEventsXdr);
  return {
    status: 'success',
    ...where,
    feeCharged: result.feeCharged,
    feeBump: info.feeBump,
    returnValue: returnValue(info.resultMetaXdr),
    events: contractEvents(events),
    balanceChanges: balanceChanges(events),
  };
}

async function errorName(
  specs: ContractSpecs,
  { contract, code }: ContractFailure,
  signal?: AbortSignal,
): Promise<string | null> {
  const spec = await specs.get(contract, signal);
  return spec === 'unreadable' ? null : (spec.errors.get(code) ?? null);
}

export function resultCode({ result }: xdr.TransactionResult): string {
  const name =
    result.type === 'txFeeBumpInnerSuccess' ||
    result.type === 'txFeeBumpInnerFailed'
      ? result.innerResultPair.result.result.type
      : result.type;
  return `tx${name
    .slice(2)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase()}`;
}

function returnValue(resultMetaXdr: string): unknown {
  const meta = xdr.TransactionMeta.fromXdr(resultMetaXdr, 'base64');
  const value =
    meta.type === 'v3' || meta.type === 'v4'
      ? meta.value.sorobanMeta?.returnValue
      : null;
  return value ? scValToNative(value) : undefined;
}

function carriesAuthEntry(
  envelopeXdr: string,
  { address, nonce }: AuthEntryQuery,
): boolean {
  const envelope = xdr.TransactionEnvelope.fromXdr(envelopeXdr, 'base64');
  return operations(envelope).some(
    ({ body }) =>
      body.type === 'invokeHostFunction' &&
      body.invokeHostFunctionOp.auth.some(({ credentials }) => {
        const signer = addressCredentials(credentials);
        return (
          signer?.nonce === nonce &&
          Address.fromScAddress(signer.address).toString() === address
        );
      }),
  );
}

function operations(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  switch (envelope.type) {
    case 'envelopeTypeTx':
      return envelope.v1.tx.operations;
    case 'envelopeTypeTxFeeBump':
      return envelope.feeBump.tx.innerTx.v1.tx.operations;
    default:
      return [];
  }
}

function addressCredentials(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | null {
  switch (credentials.type) {
    case 'sorobanCredentialsAddress':
      return credentials.address;
    case 'sorobanCredentialsAddressV2':
      return credentials.addressV2;
    case 'sorobanCredentialsAddressWithDelegates':
      return credentials.addressWithDelegates.addressCredentials;
    default:
      return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
