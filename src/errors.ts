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

export class StardustError extends Error {
  readonly code: StardustErrorCode;
  readonly retryable: boolean;

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
