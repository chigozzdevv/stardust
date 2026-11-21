import { Keypair, Networks } from '@stellar/stellar-sdk';
import { ContractSpecs } from '@/contracts/spec';
import type { Account } from '@/funding/accounts';
import { Rpc } from '@/network/rpc';
import type { NetworkInfo } from '@/network/rpc';
import type { Policy } from '@/wallet/policy';
import type {
  PromptFields,
  PromptInput,
  PromptKind,
  PromptRef,
  WalletError,
} from '@/wallet/prompts';
import { PromptQueue } from '@/wallet/queue';
import { WalletState } from '@/wallet/state';

export interface Reply {
  readonly prompt: string;
  readonly reply: 'approved' | WalletError;
}

export interface BenchOptions {
  readonly policy?: Policy;
  readonly connected?: boolean;
  readonly send?: typeof fetch;
}

export const testnet: NetworkInfo = {
  name: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  friendbotUrl: 'https://friendbot.stellar.org/',
  protocolVersion: 30,
};

export const fields: PromptFields = {
  connect: {},
  signTransaction: {
    transaction: {
      xdr: 'AAAA',
      hash: 'c4c68a3c28df417d043d10aefded59d4e8b7c637db1fae0cbf986ad2ea42f287',
      source: 'GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH',
      fee: 100n,
      sequence: 1n,
      memo: { type: 'none', value: null },
      operations: [],
      invocations: [],
      authEntries: [],
    },
  },
  signAuthEntry: {
    preimage: {
      xdr: 'AAAA',
      networkPassphrase: Networks.TESTNET,
      nonce: 5_170_948_945_941_724_719n,
      expirationLedger: 5_803_000,
      invocations: [],
    },
  },
  signMessage: { message: 'Sign in to the test app' },
  addToken: {
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  },
};

export const kinds: readonly PromptKind[] = [
  'connect',
  'signTransaction',
  'signAuthEntry',
  'signMessage',
  'addToken',
];

const offline: typeof fetch = () =>
  Promise.reject(new TypeError('no network in this test'));

export function account(): Account {
  const keypair = Keypair.random();
  return { address: keypair.publicKey(), keypair };
}

export function promptQueue({
  policy = 'manual',
  connected = false,
  send = offline,
}: BenchOptions = {}) {
  const accounts = [account(), account()];
  const state = new WalletState({ accounts, network: testnet, connected });
  const rpc = new Rpc(testnet.rpcUrl, send);
  const landing = { rpc, specs: new ContractSpecs(rpc) };
  const queue = new PromptQueue({ state, landing, policy });
  const replies: Reply[] = [];

  function input<K extends PromptKind>(
    kind: K,
    overrides: Partial<PromptInput<K>> = {},
    ref = { id: '' },
  ): PromptInput<K> {
    return {
      kind,
      origin: 'http://localhost:3000',
      networkPassphrase: Networks.TESTNET,
      blocked: null,
      signer: state.address,
      fields: fields[kind],
      reply: {
        approve: async () => {
          replies.push({ prompt: ref.id, reply: 'approved' });
        },
        error: async (error) => {
          replies.push({ prompt: ref.id, reply: error });
        },
      },
      ...overrides,
    };
  }

  function arrive<K extends PromptKind>(
    kind: K,
    overrides: Partial<PromptInput<K>> = {},
  ): PromptRef<K> {
    const ref = { id: '' };
    const added = queue.add(input(kind, overrides, ref));
    ref.id = added.id;
    return added;
  }

  return { accounts, state, landing, queue, replies, input, arrive };
}

export function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const first = await Promise.race([promise, settled().then(() => marker)]);
  return first === marker;
}
