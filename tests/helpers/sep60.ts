import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { xlm } from '@/amounts';
import type { Account } from '@/funding/accounts';
import { Sep60 } from '@/protocols/sep60/provider';
import type { Policy } from '@/wallet/policy';
import { Violations } from '@/wallet/strict';
import { FakeLedger } from '@tests/helpers/ledger';
import { promptQueue } from '@tests/helpers/prompt-queue';
import type { RpcRequest } from '@tests/helpers/replay';

interface BenchOptions {
  readonly policy?: Policy;
  readonly connected?: boolean;
  readonly allowHttp?: boolean;
  readonly send?: typeof fetch;
}

export interface Signed {
  readonly signerAddress: string;
  readonly [field: string]: unknown;
}

export const site = 'https://app.test';
export const invalid =
  'Request is invalid. Please check the details and try again.';
export const onTestnet = { networkPassphrase: Networks.TESTNET };

export function sep60({
  policy = 'manual',
  connected = false,
  allowHttp = true,
  send,
}: BenchOptions = {}) {
  const ledger = new FakeLedger();
  const requests: { url: string; method: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (typeof init?.body === 'string') {
      const { method } = JSON.parse(init.body) as RpcRequest;
      requests.push({ url: String(input), method });
    }
    return (send ?? ledger.fetch)(input, init);
  };
  const { state, queue, landing, accounts } = promptQueue({
    policy,
    connected,
    send: fetch,
  });
  const violations = new Violations();
  const wallet = new Sep60({
    state,
    queue,
    landing,
    violations,
    allowHttp,
    fetch,
  });
  const [main, other] = accounts as [Account, Account];
  const ask = (method: string, fields: object = {}, origin = site) =>
    wallet.handle(origin, { method, ...fields });
  const fund = (address: string) =>
    ledger.accounts.set(address, { balance: xlm('100'), sequence: 7n });
  return {
    state,
    queue,
    ledger,
    requests,
    violations,
    wallet,
    main,
    other,
    ask,
    fund,
  };
}

export function failure(code: number, message: string, ext?: string[]) {
  return { error: { code, message, ...(ext && { ext }) } };
}

export function verifies(account: Account, signed: string): boolean {
  const transaction = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
  const [signature] = transaction.signatures;
  return (
    transaction.signatures.length === 1 &&
    signature !== undefined &&
    account.keypair.verify(transaction.hash(), signature.signature)
  );
}
