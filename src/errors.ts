/**
 * What went wrong in the test or its setup. Wallet errors the app receives are
 * never `StardustError`s.
 *
 * - `CONFIG_NOT_FOUND`: no `stardust.config.ts` in the current folder.
 * - `CONFIG_INVALID`: a setting in `stardust.config.ts` or `test.use` is missing or wrong.
 * - `NETWORK_NOT_SUPPORTED`: `network: 'local'`.
 * - `NETWORK_UNREACHABLE`: the RPC didn't answer or isn't healthy. Retryable.
 * - `MAINNET_REFUSED`: the network is mainnet, or a signature was requested for mainnet.
 * - `APP_NOT_REACHABLE`: nothing answers at `app.url`.
 * - `FUNDING_FAILED`: the funder couldn't create or refill accounts. Retryable.
 * - `NO_PROMPT`: no prompt of that kind arrived in time.
 * - `ALREADY_ANSWERED`: a prompt was answered twice.
 * - `PROMPT_BLOCKED`: `approve()` on a prompt the wallet would refuse.
 * - `WALLET_LOCKED`: `approve()` while the wallet is locked.
 * - `OUTCOME_UNKNOWN`: the transaction didn't appear on the network in time. Retryable.
 * - `UNKNOWN_ACCOUNT`: `switchAccount` got an account that isn't in the wallet.
 * - `UNSUPPORTED`: a feature isn't available here, such as an unreadable contract spec.
 * - `PROTOCOL_VIOLATION`: at the end of the test, strict mode recorded violations.
 * - `PROMPTS_PENDING`: at the end of the test, prompts were left unanswered.
 */
export type StardustErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'NETWORK_NOT_SUPPORTED'
  | 'NETWORK_UNREACHABLE'
  | 'MAINNET_REFUSED'
  | 'APP_NOT_REACHABLE'
  | 'FUNDING_FAILED'
  | 'NO_PROMPT'
  | 'ALREADY_ANSWERED'
  | 'PROMPT_BLOCKED'
  | 'WALLET_LOCKED'
  | 'OUTCOME_UNKNOWN'
  | 'UNKNOWN_ACCOUNT'
  | 'UNSUPPORTED'
  | 'PROTOCOL_VIOLATION'
  | 'PROMPTS_PENDING';

const retryableCodes: ReadonlySet<StardustErrorCode> = new Set([
  'NETWORK_UNREACHABLE',
  'FUNDING_FAILED',
  'OUTCOME_UNKNOWN',
]);

/**
 * The error Stardust throws when the test or its setup is wrong. The message
 * says what happened and what to do next.
 */
export class StardustError extends Error {
  /** What went wrong. */
  readonly code: StardustErrorCode;
  /** Whether the same step can succeed if run again, such as after a network problem. */
  readonly retryable: boolean;

  /**
   * @param code - What went wrong.
   * @param message - What happened and what to do next.
   * @param options - The standard `Error` options, such as `cause`.
   */
  constructor(
    code: StardustErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = `StardustError ${code}`;
    this.code = code;
    this.retryable = retryableCodes.has(code);
  }
}
