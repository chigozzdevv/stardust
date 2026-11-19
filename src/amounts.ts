export function xlm(amount: string): bigint {
  return units(amount, 7);
}

export function formatXlm(stroops: bigint): string {
  if (stroops < 0n) return `-${formatXlm(-stroops)}`;
  const digits = stroops.toString().padStart(8, '0');
  return `${digits.slice(0, -7)}.${digits.slice(-7)}`;
}

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
