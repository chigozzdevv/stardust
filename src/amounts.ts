/**
 * Converts an XLM amount, written as a decimal string, to stroops.
 *
 * @param amount - The amount in XLM, such as `'10'` or `'0.5'`. At most 7 decimal places.
 * @returns The amount in stroops: `xlm('10')` is `100_000_000n`.
 * @throws RangeError when `amount` isn't a decimal amount or has more than 7 decimal places.
 */
export function xlm(amount: string): bigint {
  return units(amount, 7);
}

export function formatXlm(stroops: bigint): string {
  if (stroops < 0n) return `-${formatXlm(-stroops)}`;
  const digits = stroops.toString().padStart(8, '0');
  return `${digits.slice(0, -7)}.${digits.slice(-7)}`;
}

/**
 * Converts a token amount, written as a decimal string, to the token's smallest units.
 *
 * @param amount - The amount, such as `'9.8'`.
 * @param decimals - The token's number of decimals, such as `7`.
 * @returns The amount in units: `units('9.8', 7)` is `98_000_000n`.
 * @throws RangeError when `amount` isn't a decimal amount, or has more decimal places than `decimals`.
 */
export function units(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(
      `decimals is ${decimals}, but it must be a whole number of 0 or more, such as 7.`,
    );
  }
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new RangeError(
      `'${amount}' isn't an amount. Write one such as '10' or '10.5'.`,
    );
  }
  const fraction = amount.split('.')[1] ?? '';
  if (fraction.length > decimals) {
    throw new RangeError(
      `'${amount}' has ${fraction.length} decimal places, but at most ${decimals} are allowed.`,
    );
  }
  return BigInt(
    amount.replace('.', '') + '0'.repeat(decimals - fraction.length),
  );
}
