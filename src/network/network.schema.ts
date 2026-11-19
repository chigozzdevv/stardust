import { z } from 'zod';

const ledger = z.number().int().nonnegative();

const list = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((items) => items ?? []);

export const rpcEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export const healthResult = z.object({
  status: z.string(),
  latestLedger: ledger,
});

export const networkResult = z.object({
  passphrase: z.string().min(1),
  friendbotUrl: z.string().optional(),
  protocolVersion: z.number().int(),
});

export const latestLedgerResult = z.object({
  sequence: ledger,
  protocolVersion: z.number().int(),
});

export const ledgerEntriesResult = z.object({
  latestLedger: ledger,
  entries: list(
    z.object({
      key: z.string(),
      xdr: z.string(),
      lastModifiedLedgerSeq: ledger,
      liveUntilLedgerSeq: ledger.optional(),
    }),
  ),
});

export const transactionInfo = z.object({
  status: z.enum(['SUCCESS', 'FAILED']),
  txHash: z.string(),
  ledger,
  feeBump: z.boolean(),
  envelopeXdr: z.string(),
  resultXdr: z.string(),
  resultMetaXdr: z.string(),
  diagnosticEventsXdr: list(z.string()),
  events: z.object({
    transactionEventsXdr: list(z.string()),
    contractEventsXdr: list(z.array(z.string())),
  }),
});

export const transactionResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('NOT_FOUND'), latestLedger: ledger }),
  transactionInfo.extend({ latestLedger: ledger }),
]);

export const transactionsResult = z.object({
  transactions: list(transactionInfo),
  latestLedger: ledger,
  cursor: z.string(),
});

export const sendTransactionResult = z.object({
  status: z.enum(['PENDING', 'DUPLICATE', 'TRY_AGAIN_LATER', 'ERROR']),
  hash: z.string(),
  latestLedger: ledger,
  errorResultXdr: z.string().optional(),
  diagnosticEventsXdr: list(z.string()),
});

const results = {
  getHealth: healthResult,
  getNetwork: networkResult,
  getLatestLedger: latestLedgerResult,
  getLedgerEntries: ledgerEntriesResult,
  getTransaction: transactionResult,
  getTransactions: transactionsResult,
  sendTransaction: sendTransactionResult,
};

export type RpcMethod = keyof typeof results;
export type RpcResult<M extends RpcMethod> = z.output<(typeof results)[M]>;
export type TransactionInfo = z.output<typeof transactionInfo>;

export const rpcResults: {
  readonly [M in RpcMethod]: z.ZodType<RpcResult<M>>;
} = results;
