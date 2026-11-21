import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ContractSpecs } from '@/contracts/spec';
import type { Account } from '@/funding/accounts';
import { Rpc, networkName } from '@/network/network';
import type { NetworkInfo } from '@/network/network';
import { varialVersion } from '@/protocols/varial/varial';
import { EmulatedWallet } from '@/wallet/wallet';
import type { GoldenEntry, Step } from '@conformance/conformance';
import type { Exchange, Message } from '@conformance/test-page/page';
import { FakeHost } from '@tests/helpers/page';
import type { FakeWindow } from '@tests/helpers/page';
import { testnet } from '@tests/helpers/prompt-queue';

type Call = Extract<Step, { readonly call: string }>;
type Action = Exclude<Step, Call>;
type Valid = (signature: Uint8Array, hint?: Uint8Array) => boolean;
type Skip = (note: string) => never;

const folder = new URL('../fixtures/varial/', import.meta.url);
const scenarios = new URL('../../conformance/scenarios/', import.meta.url);
const files = existsSync(folder)
  ? readdirSync(folder).filter((file) => file.endsWith('.json'))
  : [];
const response = 'FREIGHTER_EXTERNAL_MSG_RESPONSE';
const waitMs = 1_000;
const verified = 'verified signature';
const sealers: Record<string, (value: unknown, valid: Valid) => unknown> = {
  signedTransaction: sealEnvelope,
  signedAuthEntry: sealBytes,
  signedBlob: sealBytes,
};

class Replay {
  private messageId = 0;
  private lookups = 0;
  private readonly signed: Uint8Array[] = [];
  private readonly host = new FakeHost();
  private readonly accounts: readonly Account[];
  private readonly wallet: EmulatedWallet;

  constructor(
    private readonly entry: GoldenEntry,
    private readonly skip: Skip,
  ) {
    const network = startingNetwork(entry.network);
    const fetch: typeof globalThis.fetch = async () => {
      this.lookups += 1;
      throw new TypeError('unit tests make no network calls');
    };
    const rpc = new Rpc(network.rpcUrl, fetch);
    this.accounts = entry.accounts.map((address) => this.standIn(address));
    this.wallet = new EmulatedWallet(
      { accounts: this.accounts, policy: 'manual' },
      { network, landing: { rpc, specs: new ContractSpecs(rpc) }, fetch },
    );
  }

  async run(): Promise<void> {
    await this.wallet.attach(this.host, { wallet: 'varial' });
    const page = this.host.open(`${this.entry.origin}/`);
    for (const step of this.entry.steps) {
      if ('call' in step) await this.call(page, step);
      else await this.act(step);
    }
  }

  private act(step: Action): Promise<void> {
    switch (step.action) {
      case 'switchAccount': {
        const account = this.accounts[step.account];
        if (!account) {
          throw new Error(`the entry has no account ${step.account}.`);
        }
        return this.wallet.switchAccount(account);
      }
      case 'switchNetwork':
        return this.wallet.switchNetwork(step.network);
      case 'lock':
        return this.wallet.lock();
      case 'unlock':
        return this.wallet.unlock();
    }
  }

  private async call(page: FakeWindow, step: Call): Promise<void> {
    // A call that sent nothing, or outlasted the suite's 30 s cap, recorded
    // no requests to replay.
    if (step.exchanges.length === 0) return;
    const prompts = this.answer(step.prompts);
    prompts.catch(() => undefined);
    const replayed: Exchange[] = [];
    const recorded: Exchange[] = [];
    for (const { request, reply } of step.exchanges) {
      const lookups = this.lookups;
      this.signed.length = 0;
      const answer = await this.post(page, request);
      if (request.type === 'SUBMIT_TOKEN' && this.lookups > lookups) {
        this.skip(
          'SUBMIT_TOKEN looks the token up on testnet, and unit tests make no network calls. pnpm test:conformance covers it.',
        );
      }
      const signed = this.signed.at(-1);
      replayed.push({ request, reply: seal(answer, this.key(answer), signed) });
      recorded.push({ request, reply: seal(reply, publicKey(reply), signed) });
    }
    expect({ ...step, prompts: await prompts, exchanges: replayed }).toEqual({
      ...step,
      exchanges: recorded,
    });
  }

  private async answer(recorded: Call['prompts']): Promise<Call['prompts']> {
    const seen: Call['prompts'][number][] = [];
    for (const { answer } of recorded) {
      const prompt = await this.wallet
        .nextPrompt(undefined, { timeoutMs: waitMs })
        .catch(() => null);
      if (!prompt) {
        seen.push({ kind: 'none', blocked: false, answer });
        continue;
      }
      const blocked = prompt.blocked !== null;
      if (answer === 'approve' && !blocked) await prompt.approve();
      else await prompt.reject();
      seen.push({ kind: prompt.kind, blocked, answer });
    }
    return seen;
  }

  private post(page: FakeWindow, request: Message): Promise<Message | null> {
    const messageId = ++this.messageId;
    return new Promise((resolve) => {
      const listen = (event: Event) => {
        const { data } = event as MessageEvent<Message>;
        if (data.source !== response || data.messagedId !== messageId) return;
        const reply = { ...data };
        delete reply.messagedId;
        finish(reply);
      };
      const finish = (reply: Message | null) => {
        clearTimeout(timer);
        page.removeEventListener('message', listen);
        resolve(reply);
      };
      const timer = setTimeout(() => finish(null), waitMs);
      page.addEventListener('message', listen);
      page.postMessage({ ...request, messageId }, page.location.origin);
    });
  }

  private key(reply: Message | null): Keypair | undefined {
    const signer = reply?.signerAddress;
    return this.accounts.find(({ address }) => address === signer)?.keypair;
  }

  // Keys aren't recorded, so each recorded address signs with a fresh key
  // that keeps what it signs.
  private standIn(address: string): Account {
    const keypair = Keypair.random();
    const sign = keypair.sign.bind(keypair);
    keypair.sign = (data) => {
      this.signed.push(data);
      return sign(data);
    };
    return { address, keypair };
  }
}

describe('golden Varial replies', () => {
  it('are named after the conformance scenario that records them', () => {
    const recorders = readdirSync(scenarios).map((file) =>
      file.replace(/\.spec\.ts$/, '.json'),
    );
    for (const file of files) expect(recorders).toContain(file);
  });

  it(`come from Varial ${varialVersion}, the release Stardust says it matches`, () => {
    const others = files.flatMap((file) =>
      Object.entries(golden(file))
        .filter(([, entry]) => entry.varial !== varialVersion)
        .map(([title, entry]) => `${file} > ${title}: Varial ${entry.varial}`),
    );
    expect(others).toEqual([]);
  });
});

for (const file of files) {
  describe(file, () => {
    for (const [title, entry] of Object.entries(golden(file))) {
      it(title, ({ skip }) => new Replay(entry, skip).run(), 30_000);
    }
  });
}

function golden(file: string): Record<string, GoldenEntry> {
  return JSON.parse(readFileSync(new URL(file, folder), 'utf8')) as Record<
    string,
    GoldenEntry
  >;
}

function startingNetwork(network: GoldenEntry['network']): NetworkInfo {
  if (network === 'testnet') return testnet;
  const { rpcUrl, passphrase } = network;
  return {
    ...testnet,
    name: networkName(passphrase),
    rpcUrl,
    networkPassphrase: passphrase,
    friendbotUrl: null,
  };
}

function publicKey(reply: Message | null): Keypair | undefined {
  const address = reply?.signerAddress;
  return typeof address === 'string' && StrKey.isValidEd25519PublicKey(address)
    ? Keypair.fromPublicKey(address)
    : undefined;
}

// A signature that verifies over what Stardust signed, under the reply's
// signer, becomes a marker. Every other field is compared as recorded.
function seal(
  reply: Message | null,
  key: Keypair | undefined,
  signed: Uint8Array | undefined,
): Message | null {
  if (!reply) return reply;
  const valid: Valid = (signature, hint) =>
    key !== undefined &&
    signed !== undefined &&
    (hint === undefined || Buffer.from(hint).equals(key.signatureHint())) &&
    key.verify(signed, signature);
  return Object.fromEntries(
    Object.entries(reply).map(([field, value]) => {
      const sealer = sealers[field];
      return [field, sealer ? sealer(value, valid) : value];
    }),
  );
}

function sealEnvelope(value: unknown, valid: Valid): unknown {
  if (typeof value !== 'string') return value;
  const { type, value: envelope } = xdr.TransactionEnvelope.fromXdr(
    value,
    'base64',
  );
  return {
    type,
    tx: envelope.tx.toXdr('base64'),
    signatures: envelope.signatures.map(({ hint, signature }) =>
      valid(signature.toBytes(), hint.toBytes())
        ? verified
        : signature.toString(),
    ),
  };
}

function sealBytes(value: unknown, valid: Valid): unknown {
  if (typeof value === 'string') {
    return valid(Buffer.from(value, 'base64')) ? verified : value;
  }
  if (isBuffer(value)) {
    return valid(Buffer.from(value.data))
      ? { ...value, data: verified }
      : value;
  }
  return value;
}

function isBuffer(value: unknown): value is { type: 'Buffer'; data: number[] } {
  const { type, data } = (value ?? {}) as { type?: unknown; data?: unknown };
  return type === 'Buffer' && Array.isArray(data);
}
