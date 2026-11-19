import { z } from 'zod';

export const varialTypes = [
  'REQUEST_CONNECTION_STATUS',
  'REQUEST_ACCESS',
  'REQUEST_PUBLIC_KEY',
  'REQUEST_ALLOWED_STATUS',
  'SET_ALLOWED_STATUS',
  'REQUEST_NETWORK_DETAILS',
  'SUBMIT_TRANSACTION',
  'SUBMIT_AUTH_ENTRY',
  'SUBMIT_BLOB',
  'SUBMIT_TOKEN',
  'DISCONNECT',
  'REQUEST_NETWORK',
  'REQUEST_USER_INFO',
] as const;

export type VarialType = (typeof varialTypes)[number];

export const versionPattern =
  /^[v=]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const optional = z
  .string()
  .nullish()
  .transform((value) => value || undefined);

const apiVersion = optional.refine(
  (value) => value === undefined || versionPattern.test(value),
);

const signing = {
  accountToSign: optional,
  address: optional,
  networkPassphrase: optional,
};

const bare = <T extends VarialType>(type: T) =>
  z.object({ type: z.literal(type) });

export const varialType = z.object({ type: z.enum(varialTypes) });

export const varialRequest = z.discriminatedUnion('type', [
  bare('REQUEST_CONNECTION_STATUS'),
  bare('REQUEST_ACCESS'),
  bare('REQUEST_PUBLIC_KEY'),
  bare('REQUEST_ALLOWED_STATUS'),
  bare('SET_ALLOWED_STATUS'),
  bare('REQUEST_NETWORK_DETAILS'),
  z.object({
    type: z.literal('SUBMIT_TRANSACTION'),
    transactionXdr: z.string(),
    ...signing,
  }),
  z.object({
    type: z.literal('SUBMIT_AUTH_ENTRY'),
    entryXdr: z.string(),
    apiVersion,
    ...signing,
  }),
  z.object({
    type: z.literal('SUBMIT_BLOB'),
    blob: z.string(),
    apiVersion,
    ...signing,
  }),
  z.object({
    type: z.literal('SUBMIT_TOKEN'),
    contractId: z.string(),
    networkPassphrase: optional,
  }),
  bare('DISCONNECT'),
  bare('REQUEST_NETWORK'),
  bare('REQUEST_USER_INFO'),
]);

export type VarialRequest = z.output<typeof varialRequest>;

const address = z.string().regex(/^G[A-Z2-7]{55}$/);
const publicKey = z.union([address, z.literal('')]);

const signature = z.union([
  z.base64().length(88),
  z.strictObject({
    type: z.literal('Buffer'),
    data: z.array(z.number().int().min(0).max(255)).length(64),
  }),
]);

const walletError = z.strictObject({
  code: z.number().int(),
  message: z.string(),
});

const failure = z
  .strictObject({ apiError: walletError, error: z.string() })
  .refine(({ apiError, error }) => error === apiError.message);

const tokenFailure = z.strictObject({ apiError: walletError });

const networkDetails = z.strictObject({
  network: z.string(),
  networkName: z.string(),
  networkUrl: z.string(),
  networkPassphrase: z.string(),
  sorobanRpcUrl: z.string(),
  friendbotUrl: z.string().optional(),
});

const allowed = z.strictObject({ isAllowed: z.boolean() });

export const varialReplies = {
  REQUEST_CONNECTION_STATUS: z.strictObject({ isConnected: z.boolean() }),
  REQUEST_ACCESS: z.union([z.strictObject({ publicKey: address }), failure]),
  REQUEST_PUBLIC_KEY: z.strictObject({ publicKey }),
  REQUEST_ALLOWED_STATUS: allowed,
  SET_ALLOWED_STATUS: z.union([allowed, failure]),
  REQUEST_NETWORK_DETAILS: z.strictObject({ networkDetails }),
  SUBMIT_TRANSACTION: z.union([
    z.strictObject({ signedTransaction: z.base64(), signerAddress: address }),
    failure,
  ]),
  SUBMIT_AUTH_ENTRY: z.union([
    z.strictObject({ signedAuthEntry: signature, signerAddress: address }),
    failure,
  ]),
  SUBMIT_BLOB: z.union([
    z.strictObject({ signedBlob: signature, signerAddress: address }),
    failure,
  ]),
  SUBMIT_TOKEN: z.union([
    z.strictObject({ contractId: z.string().regex(/^C[A-Z2-7]{55}$/) }),
    tokenFailure,
  ]),
  DISCONNECT: z.union([z.strictObject({}), failure]),
  REQUEST_NETWORK: z.strictObject({ network: z.string() }),
  REQUEST_USER_INFO: z.strictObject({
    userInfo: z.strictObject({ publicKey }),
  }),
} satisfies Record<VarialType, z.ZodType>;

export type VarialReply = z.output<(typeof varialReplies)[VarialType]>;
