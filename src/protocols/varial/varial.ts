import { Networks, StrKey } from '@stellar/stellar-sdk';
import { StardustError } from '@/errors';
import type { Account } from '@/funding/accounts';
import type { LandingContext } from '@/network/landing';
import {
  varialReplies,
  varialRequest,
  varialType,
  versionPattern,
} from '@/protocols/varial/varial.schema';
import type {
  VarialReply,
  VarialRequest,
} from '@/protocols/varial/varial.schema';
import {
  boundAddress,
  decodeAuthPreimage,
  decodeTransaction,
  nameArgs,
} from '@/wallet/decode';
import { declined, internalError } from '@/wallet/prompts';
import type {
  BlockedReason,
  PromptInput,
  PromptKind,
  PromptRef,
  WalletError,
} from '@/wallet/prompts';
import type { PromptQueue } from '@/wallet/queue';
import {
  addTrustline,
  readToken,
  signAuthEntry,
  signMessage,
  signTransaction,
} from '@/wallet/signer';
import type { WalletState } from '@/wallet/state';
import type { Violations } from '@/wallet/strict';

export const varialVersion = '5.53.0';

export interface VarialOptions {
  readonly state: WalletState;
  readonly queue: PromptQueue;
  readonly violations: Violations;
  readonly landing: LandingContext;
  readonly allowHttp?: boolean;
}

type Request<T extends VarialRequest['type']> = Extract<
  VarialRequest,
  { type: T }
>;

type Reply = VarialReply | null;

interface Answers {
  readonly approve: () => VarialReply | Promise<VarialReply>;
  readonly error?: (error: WalletError) => VarialReply;
  readonly failed?: (cause: unknown) => Reply;
}

const lockedError: WalletError = {
  code: -1,
  message: 'The wallet is locked. Unlock Varial and try again.',
};

export class Varial {
  private readonly state: WalletState;
  private readonly queue: PromptQueue;
  private readonly violations: Violations;
  private readonly landing: LandingContext;
  private readonly allowHttp: boolean;

  constructor({
    state,
    queue,
    violations,
    landing,
    allowHttp = true,
  }: VarialOptions) {
    this.state = state;
    this.queue = queue;
    this.violations = violations;
    this.landing = landing;
    this.allowHttp = allowHttp;
  }

  async handle(origin: string, payload: unknown): Promise<Reply> {
    const known = varialType.safeParse(payload);
    if (!known.success) {
      this.violations.unknownMessage(typeOf(payload));
      return null;
    }
    const { type } = known.data;
    const request = varialRequest.safeParse(payload);
    const reply = request.success
      ? await this.answer(request.data, origin)
      : (type === 'SUBMIT_TOKEN' ? tokenError : errorReply)(internalError);
    return reply && varialReplies[type].parse(reply);
  }

  private answer(
    request: VarialRequest,
    origin: string,
  ): Reply | Promise<Reply> {
    const { state } = this;
    switch (request.type) {
      case 'REQUEST_CONNECTION_STATUS':
        return { isConnected: true };
      case 'REQUEST_ACCESS':
        return this.allowed(origin)
          ? { publicKey: state.address }
          : this.connect(origin, () => ({ publicKey: state.address }));
      case 'REQUEST_PUBLIC_KEY':
        return { publicKey: this.connectedAddress(origin) };
      case 'REQUEST_ALLOWED_STATUS':
        return { isAllowed: this.allowed(origin) };
      case 'SET_ALLOWED_STATUS':
        return this.allowed(origin)
          ? { isAllowed: true }
          : this.connect(origin, () => ({ isAllowed: true }));
      case 'REQUEST_NETWORK_DETAILS':
        return { networkDetails: state.varialNetwork };
      case 'SUBMIT_TRANSACTION':
        return this.signTransaction(request, origin);
      case 'SUBMIT_AUTH_ENTRY':
        return this.signAuthEntry(request, origin);
      case 'SUBMIT_BLOB':
        return this.signMessage(request, origin);
      case 'SUBMIT_TOKEN':
        return this.addToken(request, origin);
      case 'DISCONNECT':
        return this.disconnect(origin);
      case 'REQUEST_NETWORK':
        return { network: state.varialNetwork.network };
      case 'REQUEST_USER_INFO':
        return { userInfo: { publicKey: this.connectedAddress(origin) } };
    }
  }

  private connect(origin: string, approved: () => VarialReply): Promise<Reply> {
    return this.ask(
      {
        kind: 'connect',
        origin,
        networkPassphrase: null,
        blocked: null,
        signer: this.state.address,
        fields: {},
      },
      {
        approve: () => {
          this.state.connect(origin);
          return approved();
        },
      },
    ).reply;
  }

  private signTransaction(
    request: Request<'SUBMIT_TRANSACTION'>,
    origin: string,
  ): Reply | Promise<Reply> {
    const { transactionXdr, networkPassphrase } = request;
    const decoded = this.parse('transactionXdr', () =>
      decodeTransaction(transactionXdr, this.passphrase),
    );
    if (!decoded) return errorReply(internalError);
    const asked = networkPassphrase ?? Networks.PUBLIC;
    const requested = request.accountToSign ?? request.address;
    const account = this.signFor(requested);
    const { ref, reply } = this.ask(
      {
        kind: 'signTransaction',
        origin,
        networkPassphrase: networkPassphrase ?? null,
        blocked: this.blocked(origin, asked),
        signer: account.address,
        fields: nameArgs(decoded, this.landing.specs).then((transaction) => ({
          transaction,
        })),
      },
      {
        approve: () => ({
          signedTransaction: signTransaction(
            transactionXdr,
            account.keypair,
            this.passphrase,
          ),
          signerAddress: account.address,
        }),
      },
    );
    this.checkNetwork(ref, asked, networkPassphrase === undefined);
    this.checkSigner(ref, account, [requested]);
    return reply;
  }

  private signAuthEntry(
    request: Request<'SUBMIT_AUTH_ENTRY'>,
    origin: string,
  ): Reply | Promise<Reply> {
    const { entryXdr, networkPassphrase, apiVersion } = request;
    const decoded = this.parse('entryXdr', () =>
      decodeAuthPreimage(entryXdr, this.passphrase),
    );
    if (!decoded) return errorReply(declined);
    const requested = request.accountToSign ?? request.address;
    const account = this.signFor(requested);
    const { ref, reply } = this.ask(
      {
        kind: 'signAuthEntry',
        origin,
        networkPassphrase: networkPassphrase ?? null,
        blocked: this.blocked(origin, decoded.networkPassphrase),
        signer: account.address,
        fields: nameArgs(decoded, this.landing.specs).then((preimage) => ({
          preimage,
        })),
      },
      {
        approve: () => ({
          signedAuthEntry: encoded(
            signAuthEntry(entryXdr, account.keypair, this.passphrase),
            apiVersion,
            '4.2.0',
          ),
          signerAddress: account.address,
        }),
      },
    );
    this.checkNetwork(ref, decoded.networkPassphrase);
    this.checkSigner(ref, account, [requested, boundAddress(entryXdr)]);
    return reply;
  }

  private signMessage(
    request: Request<'SUBMIT_BLOB'>,
    origin: string,
  ): Promise<Reply> {
    const { blob, networkPassphrase, apiVersion } = request;
    const asked = networkPassphrase ?? this.passphrase;
    const requested = request.accountToSign ?? request.address;
    const account = this.signFor(requested);
    const { ref, reply } = this.ask(
      {
        kind: 'signMessage',
        origin,
        networkPassphrase: networkPassphrase ?? null,
        blocked: this.blocked(origin, asked),
        signer: account.address,
        fields: { message: blob },
      },
      {
        approve: () => ({
          signedBlob: encoded(
            signMessage(blob, account.keypair, this.passphrase),
            apiVersion,
            '4.0.0',
          ),
          signerAddress: account.address,
        }),
      },
    );
    this.checkNetwork(ref, asked);
    this.checkSigner(ref, account, [requested]);
    return reply;
  }

  private addToken(
    request: Request<'SUBMIT_TOKEN'>,
    origin: string,
  ): Reply | Promise<Reply> {
    const { contractId, networkPassphrase } = request;
    if (!StrKey.isValidContract(contractId)) return tokenError(declined);
    const asked = networkPassphrase ?? Networks.PUBLIC;
    const account = this.state.account;
    const reason = this.blocked(origin, asked);
    const token = reason
      ? null
      : readToken(this.landing.rpc, {
          contractId,
          address: account.address,
          networkPassphrase: this.passphrase,
        });
    const { ref, reply } = this.ask(
      {
        kind: 'addToken',
        origin,
        networkPassphrase: networkPassphrase ?? null,
        blocked: token
          ? token.then(({ kind }) => (kind === 'alreadyAdded' ? kind : null))
          : reason,
        signer: account.address,
        fields: { contractId },
      },
      {
        approve: async () => {
          const found = await token;
          if (found?.kind === 'needsTrustline') {
            await addTrustline(this.landing, {
              signer: account.keypair,
              asset: found.asset,
              networkPassphrase: this.passphrase,
            });
          }
          return { contractId };
        },
        error: tokenError,
        // Varial keeps the popup open after a failed trustline; closing it
        // declines. An unknown outcome leaves it open, so nothing is sent.
        failed: (cause) =>
          cause instanceof StardustError && cause.code === 'OUTCOME_UNKNOWN'
            ? null
            : tokenError(declined),
      },
    );
    this.checkNetwork(ref, asked, networkPassphrase === undefined);
    return reply;
  }

  private disconnect(origin: string): VarialReply {
    if (this.state.locked) return errorReply(lockedError);
    this.state.disconnect(origin);
    return {};
  }

  private ask<K extends PromptKind>(
    input: Omit<PromptInput<K>, 'reply'>,
    {
      approve,
      error = errorReply,
      failed = () => errorReply(internalError),
    }: Answers,
  ): { ref: PromptRef<K>; reply: Promise<Reply> } {
    let send: (reply: Reply) => void = () => {};
    const reply = new Promise<Reply>((resolve) => {
      send = resolve;
    });
    const ref = this.queue.add<K>({
      ...input,
      reply: {
        approve: async () => {
          try {
            send(await approve());
          } catch (cause) {
            const fallback = failed(cause);
            if (fallback) send(fallback);
            throw cause;
          }
        },
        error: async (wallet) => send(error(wallet)),
      },
    });
    return { ref, reply };
  }

  private blocked(
    origin: string,
    asked: string | null,
  ): Exclude<BlockedReason, 'locked'> | null {
    if (asked !== this.passphrase) return 'networkMismatch';
    if (!this.allowHttp && !origin.startsWith('https')) return 'insecureOrigin';
    return this.state.isConnected(origin) ? null : 'notConnected';
  }

  private parse<T>(field: string, read: () => T): T | null {
    try {
      return read();
    } catch (error) {
      this.violations.invalidXdr(null, field, error);
      return null;
    }
  }

  private signFor(requested: string | undefined): Account {
    const account = requested ? this.state.findAccount(requested) : undefined;
    if (account) this.state.switchAccount(account);
    return this.state.account;
  }

  private checkNetwork(
    ref: PromptRef,
    asked: string | null,
    missing = false,
  ): void {
    const wallet = this.passphrase;
    if (missing) {
      this.violations.missingNetworkPassphrase(ref, wallet);
    } else if (asked !== wallet) {
      this.violations.networkMismatch(ref, asked, wallet, 'varial');
    }
  }

  private checkSigner(
    ref: PromptRef,
    account: Account,
    named: readonly (string | null | undefined)[],
  ): void {
    for (const signer of new Set(named)) {
      if (signer && signer !== account.address) {
        this.violations.signerMismatch(ref, signer, account.address);
      }
    }
  }

  // The Lock button empties Varial's session public key, so no site is allowed
  // until unlock. blocked() doesn't use this: signing prompts wait for unlock.
  private allowed(origin: string): boolean {
    return !this.state.locked && this.state.isConnected(origin);
  }

  private connectedAddress(origin: string): string {
    return this.allowed(origin) ? this.state.address : '';
  }

  private get passphrase(): string {
    return this.state.network.networkPassphrase;
  }
}

function errorReply({ code, message }: WalletError): VarialReply {
  return { apiError: { code, message }, error: message };
}

// Varial's SUBMIT_TOKEN errors carry apiError only.
function tokenError({ code, message }: WalletError): VarialReply {
  return { apiError: { code, message } };
}

// Older packages get the Buffer as Varial's runtime messaging serializes it.
function encoded(
  signature: Buffer,
  apiVersion: string | undefined,
  base64From: string,
): string | ReturnType<Buffer['toJSON']> {
  return apiVersion && rank(apiVersion) >= rank(base64From)
    ? signature.toString('base64')
    : signature.toJSON();
}

function rank(version: string): number {
  const [, major, minor, patch, prerelease] =
    versionPattern.exec(version) ?? [];
  const release = (Number(major) * 1e6 + Number(minor)) * 1e6 + Number(patch);
  return prerelease === undefined ? release : release - 0.5;
}

function typeOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as { type?: unknown }).type
    : undefined;
}
