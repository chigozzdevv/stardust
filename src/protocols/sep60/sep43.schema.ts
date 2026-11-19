import { z } from 'zod';

const optional = z
  .string()
  .nullish()
  .transform((value) => value || undefined);

const signOptions = z.object({
  networkPassphrase: optional,
  address: optional,
});

const transactionOptions = signOptions.extend({
  submit: z
    .boolean()
    .nullish()
    .transform((value) => value === true),
  submitUrl: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
});

const options = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value ?? {}, schema);

export const sep43Request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('getAddress') }),
  z.object({ method: z.literal('getNetwork') }),
  z.object({
    method: z.literal('signTransaction'),
    xdr: z.string(),
    opts: options(transactionOptions),
  }),
  z.object({
    method: z.literal('signAuthEntry'),
    authEntry: z.string(),
    opts: options(signOptions),
  }),
  z.object({
    method: z.literal('signMessage'),
    message: z.string(),
    opts: options(signOptions),
  }),
]);

export type Sep43Request = z.output<typeof sep43Request>;
export type Sep43Method = Sep43Request['method'];
export type SignOptions = z.output<typeof signOptions>;

const address = z.string().regex(/^G[A-Z2-7]{55}$/);
const signature = z.base64().length(88);

export const sep43Error = z.strictObject({
  code: z.literal([-1, -2, -3, -4]),
  message: z.string(),
  ext: z.array(z.string()).optional(),
});

export type Sep43Error = z.output<typeof sep43Error>;

export const sep43Failure = z.strictObject({ error: sep43Error });

export const sep43Replies = {
  getAddress: z.union([z.strictObject({ address }), sep43Failure]),
  getNetwork: z.union([
    z.strictObject({ network: z.string(), networkPassphrase: z.string() }),
    sep43Failure,
  ]),
  signTransaction: z.union([
    z.strictObject({ signedTxXdr: z.base64(), signerAddress: address }),
    sep43Failure,
  ]),
  signAuthEntry: z.union([
    z.strictObject({ signedAuthEntry: signature, signerAddress: address }),
    sep43Failure,
  ]),
  signMessage: z.union([
    z.strictObject({ signedMessage: signature, signerAddress: address }),
    sep43Failure,
  ]),
} satisfies Record<Sep43Method, z.ZodType>;

export type Sep43Reply = z.output<(typeof sep43Replies)[Sep43Method]>;

export const horizonProblem = z.object({
  extras: z
    .object({
      result_codes: z
        .object({
          transaction: z.string().optional(),
          operations: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});
