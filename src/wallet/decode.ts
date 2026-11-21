import {
  Address,
  Asset,
  FeeBumpTransaction,
  LiquidityPoolAsset,
  Networks,
  TransactionBuilder,
  inspectAuthEntry,
  scValToNative,
  walkInvocationTree,
  xdr,
} from '@stellar/stellar-sdk';
import type { Memo, Operation, OperationRecord } from '@stellar/stellar-sdk';
import { units } from '@/amounts';
import type { ContractSpecs, SpecLookup } from '@/contracts/spec';
import { networkId } from '@/network/rpc';

/** A transaction the app asked the wallet to sign, decoded. */
export interface DecodedTransaction {
  /** The transaction envelope as the app sent it, base64 XDR. */
  readonly xdr: string;
  /** The transaction hash, hex. For a fee bump, the fee bump's hash. */
  readonly hash: string;
  /** The source account. For a fee bump, the account paying the fee. */
  readonly source: string;
  /** The declared maximum fee, in stroops. */
  readonly fee: bigint;
  readonly sequence: bigint;
  /** The memo. `value` is `null` for `'none'`, and hex for `'hash'` and `'return'`. */
  readonly memo: {
    type: 'none' | 'text' | 'id' | 'hash' | 'return';
    value: string | null;
  };
  readonly operations: readonly DecodedOperation[];
  /** The contract call and every sub-call it authorizes, flattened in order. Empty for a classic transaction. */
  readonly invocations: readonly Invocation[];
  /** The authorization entries attached to the contract call. */
  readonly authEntries: readonly DecodedAuthEntry[];
}

/** One operation of a transaction. */
export interface DecodedOperation {
  /** The operation type, as the Stellar SDK names it, such as `'payment'` or `'invokeHostFunction'`. */
  readonly type: string;
  /** The operation's own source account, or `null` when it uses the transaction's. */
  readonly source: string | null;
  /**
   * The operation's fields, named as in the Stellar SDK. Assets are written
   * `'native'` or `'CODE:ISSUER'`, and amounts are `bigint` stroops.
   */
  readonly body: Readonly<Record<string, unknown>>;
}

/** A contract call. */
export interface Invocation {
  /** The contract called, `C...`. */
  readonly contract: string;
  readonly fn: string;
  /** The arguments in order, converted from XDR. Integers are `bigint`, addresses are strings. */
  readonly args: readonly unknown[];
  /** The arguments by name, from the contract's spec, or `null` when the spec can't be read. */
  readonly namedArgs: Readonly<Record<string, unknown>> | null;
  /** How deep the call is: `0` for the top-level call. */
  readonly depth: number;
}

/** An authorization entry attached to a transaction, decoded. */
export interface DecodedAuthEntry {
  /** The entry, base64 XDR. */
  readonly xdr: string;
  /** Who must authorize it. */
  readonly address: string;
  /** The last ledger in which the authorization is valid. */
  readonly expirationLedger: number;
  /** The calls it authorizes, flattened in order. */
  readonly invocations: readonly Invocation[];
}

/** An authorization entry preimage the app asked the wallet to sign, decoded. */
export interface DecodedAuthPreimage {
  /** The preimage as the app sent it, base64 XDR. */
  readonly xdr: string;
  /** The network the preimage is for, matched from its network ID, or `null` when it's not a known network. */
  readonly networkPassphrase: string | null;
  readonly nonce: bigint;
  /** The last ledger in which the authorization is valid. */
  readonly expirationLedger: number;
  /** The calls it authorizes, flattened in order. */
  readonly invocations: readonly Invocation[];
}

export type AuthPreimage =
  | xdr.HashIdPreimageSorobanAuthorization
  | xdr.HashIdPreimageSorobanAuthorizationWithAddress;

const knownPassphrases = [
  Networks.TESTNET,
  Networks.FUTURENET,
  Networks.PUBLIC,
];

const amountFields = new Set([
  'amount',
  'buyAmount',
  'destAmount',
  'destMin',
  'limit',
  'maxAmountA',
  'maxAmountB',
  'minAmountA',
  'minAmountB',
  'sendAmount',
  'sendMax',
  'startingBalance',
]);

export function decodeTransaction(
  envelope: string,
  networkPassphrase: string,
): DecodedTransaction {
  const outer = TransactionBuilder.fromXDR(envelope, networkPassphrase);
  const bumped = outer instanceof FeeBumpTransaction;
  const transaction = bumped ? outer.innerTransaction : outer;
  const invoke = transaction.operations.find(
    (operation) => operation.type === 'invokeHostFunction',
  );
  return {
    xdr: envelope,
    hash: Buffer.from(outer.hash()).toString('hex'),
    source: bumped ? outer.feeSource : outer.source,
    fee: BigInt(outer.fee),
    sequence: BigInt(transaction.sequence),
    memo: memo(transaction.memo),
    operations: transaction.operations.map(operation),
    invocations: invoke ? contractCalls(invoke) : [],
    authEntries: invoke?.auth?.flatMap(authEntry) ?? [],
  };
}

export function decodeAuthPreimage(
  preimage: string,
  walletPassphrase: string,
): DecodedAuthPreimage {
  const {
    networkId: id,
    nonce,
    signatureExpirationLedger,
    invocation,
  } = readPreimage(preimage);
  return {
    xdr: preimage,
    networkPassphrase: passphraseOf(id, walletPassphrase),
    nonce,
    expirationLedger: signatureExpirationLedger,
    invocations: calls(invocation, 0),
  };
}

export function readPreimage(preimage: string): AuthPreimage {
  const parsed = xdr.HashIdPreimage.fromXdr(preimage, 'base64');
  switch (parsed.type) {
    case 'envelopeTypeSorobanAuthorization':
      return parsed.sorobanAuthorization;
    case 'envelopeTypeSorobanAuthorizationWithAddress':
      return parsed.sorobanAuthorizationWithAddress;
    default:
      throw new TypeError(
        `the HashIdPreimage is ${parsed.type}, but signing an auth entry needs envelopeTypeSorobanAuthorization`,
      );
  }
}

export function boundAddress(preimage: string): string | null {
  const parsed = readPreimage(preimage);
  return 'address' in parsed
    ? Address.fromScAddress(parsed.address).toString()
    : null;
}

export function nameArgs(
  decoded: DecodedTransaction,
  specs: ContractSpecs,
  signal?: AbortSignal,
): Promise<DecodedTransaction>;
export function nameArgs(
  decoded: DecodedAuthPreimage,
  specs: ContractSpecs,
  signal?: AbortSignal,
): Promise<DecodedAuthPreimage>;
export async function nameArgs(
  decoded: DecodedTransaction | DecodedAuthPreimage,
  specs: ContractSpecs,
  signal?: AbortSignal,
): Promise<DecodedTransaction | DecodedAuthPreimage> {
  const entries = 'authEntries' in decoded ? decoded.authEntries : [];
  const name = await argNames(
    specs,
    [...decoded.invocations, ...entries.flatMap((entry) => entry.invocations)],
    signal,
  );
  const invocations = decoded.invocations.map(name);
  if (!('authEntries' in decoded)) return { ...decoded, invocations };
  return {
    ...decoded,
    invocations,
    authEntries: entries.map((entry) => ({
      ...entry,
      invocations: entry.invocations.map(name),
    })),
  };
}

async function argNames(
  specs: ContractSpecs,
  invocations: readonly Invocation[],
  signal?: AbortSignal,
): Promise<(invocation: Invocation) => Invocation> {
  const contracts = [...new Set(invocations.map(({ contract }) => contract))];
  const found = new Map(
    await Promise.all(
      contracts.map(
        async (contract) =>
          [contract, await specs.get(contract, signal)] as const,
      ),
    ),
  );
  return (invocation) => ({
    ...invocation,
    namedArgs: named(found.get(invocation.contract), invocation),
  });
}

function named(
  spec: SpecLookup | undefined,
  { fn, args }: Invocation,
): Record<string, unknown> | null {
  const names = spec === 'unreadable' ? undefined : spec?.functions.get(fn);
  if (names?.length !== args.length) return null;
  return Object.fromEntries(names.map((name, index) => [name, args[index]]));
}

function contractCalls({
  func,
  auth = [],
}: Operation.InvokeHostFunction): Invocation[] {
  const top =
    func.type === 'hostFunctionTypeInvokeContract' ? func.invokeContract : null;
  // An entry for the top-level call may cover only some of its arguments
  // (require_auth_for_args), so it is matched by contract and function name.
  const authorized = auth.flatMap(({ rootInvocation: root }) =>
    top && isCallTo(root, top)
      ? root.subInvocations.flatMap((sub) => calls(sub, 1))
      : calls(root, top ? 1 : 0),
  );
  return top ? [call(top, 0), ...authorized] : authorized;
}

function isCallTo(
  { function: fn }: xdr.SorobanAuthorizedInvocation,
  { contractAddress, functionName }: xdr.InvokeContractArgs,
): boolean {
  return (
    fn.type === 'sorobanAuthorizedFunctionTypeContractFn' &&
    fn.contractFn.contractAddress.equals(contractAddress) &&
    fn.contractFn.functionName.toString() === functionName.toString()
  );
}

function calls(
  root: xdr.SorobanAuthorizedInvocation,
  rootDepth: number,
): Invocation[] {
  const found: Invocation[] = [];
  walkInvocationTree(root, ({ function: fn }, depth) => {
    if (fn.type === 'sorobanAuthorizedFunctionTypeContractFn') {
      found.push(call(fn.contractFn, rootDepth + depth - 1));
    }
  });
  return found;
}

function call(
  { contractAddress, functionName, args }: xdr.InvokeContractArgs,
  depth: number,
): Invocation {
  return {
    contract: Address.fromScAddress(contractAddress).toString(),
    fn: functionName.toString(),
    args: args.map(native),
    namedArgs: null,
    depth,
  };
}

function native(value: xdr.ScVal): unknown {
  switch (value.type) {
    case 'scvU32':
      return BigInt(value.u32);
    case 'scvI32':
      return BigInt(value.i32);
    case 'scvVec':
      return (value.vec ?? []).map(native);
    case 'scvMap':
      return Object.fromEntries(
        (value.map ?? []).map(({ key, val }) => [
          String(native(key)),
          native(val),
        ]),
      );
    default:
      return scValToNative(value);
  }
}

function authEntry(entry: xdr.SorobanAuthorizationEntry): DecodedAuthEntry[] {
  const { address, signatureExpirationLedger } = inspectAuthEntry(entry);
  if (address === null || signatureExpirationLedger === null) return [];
  return [
    {
      xdr: entry.toXdr('base64'),
      address,
      expirationLedger: signatureExpirationLedger,
      invocations: calls(entry.rootInvocation, 0),
    },
  ];
}

function operation({
  type,
  source,
  ...fields
}: OperationRecord): DecodedOperation {
  return {
    type,
    source: source ?? null,
    body: Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        // changeTrust decodes its asset as `line`; Operation.changeTrust() takes `asset`.
        .map(([name, value]) => [
          name === 'line' ? 'asset' : name,
          field(name, value),
        ]),
    ),
  };
}

function field(name: string, value: unknown): unknown {
  if (value instanceof Asset || value instanceof LiquidityPoolAsset) {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map((item) => field(name, item));
  return typeof value === 'string' && amountFields.has(name)
    ? units(value, 7)
    : value;
}

function memo({ type, value }: Memo): DecodedTransaction['memo'] {
  if (value === null || typeof value === 'string') return { type, value };
  return {
    type,
    value: Buffer.from(value).toString(type === 'text' ? 'utf8' : 'hex'),
  };
}

function passphraseOf(id: xdr.Hash, walletPassphrase: string): string | null {
  const bytes = id.toBytes();
  return (
    [walletPassphrase, ...knownPassphrases].find((passphrase) =>
      networkId(passphrase).equals(bytes),
    ) ?? null
  );
}
