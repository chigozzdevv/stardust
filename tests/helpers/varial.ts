import type { Account } from '@/funding/accounts';
import { Varial } from '@/protocols/varial/handler';
import type { Policy } from '@/wallet/policy';
import type { WalletError } from '@/wallet/prompts';
import { Violations } from '@/wallet/strict';
import { FakeLedger } from '@tests/helpers/ledger';
import { promptQueue } from '@tests/helpers/prompt-queue';

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
export const localhost = 'http://localhost:5173';

export function varial({
  policy = 'manual',
  connected = false,
  allowHttp = true,
  send,
}: BenchOptions = {}) {
  const ledger = new FakeLedger();
  const { state, queue, landing, accounts } = promptQueue({
    policy,
    connected,
    send: send ?? ledger.fetch,
  });
  const violations = new Violations();
  const wallet = new Varial({ state, queue, landing, violations, allowHttp });
  const [main, other] = accounts as [Account, Account];
  const ask = (type: string, fields: object = {}, origin = site) =>
    wallet.handle(origin, { type, ...fields });
  return { state, queue, ledger, violations, wallet, main, other, ask };
}

export function failure(error: WalletError) {
  return { apiError: error, error: error.message };
}
