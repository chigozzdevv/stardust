import { describe, expect, it } from 'vitest';
import { formatXlm, units, xlm } from '@/amounts';

describe('xlm', () => {
  it('converts XLM to stroops', () => {
    expect(xlm('10')).toBe(100_000_000n);
    expect(xlm('10.5')).toBe(105_000_000n);
    expect(xlm('0')).toBe(0n);
    expect(xlm('0.0000001')).toBe(1n);
    expect(xlm('922337203685.4775807')).toBe(9_223_372_036_854_775_807n);
  });

  it.each(['10.5.0', '', '1e5', '-1', '+1', ' 1', '1,000', '.5', '5.', 'NaN'])(
    'rejects %j',
    (amount) => {
      expect(() => xlm(amount)).toThrow(/isn't an amount/);
    },
  );

  it('rejects more than 7 decimal places', () => {
    expect(() => xlm('0.00000001')).toThrow(
      "'0.00000001' has 8 decimal places, but at most 7 are allowed.",
    );
  });
});

describe('formatXlm', () => {
  it('writes stroops as an XLM amount with 7 decimal places', () => {
    expect(formatXlm(20_000_000_000n)).toBe('2000.0000000');
    expect(formatXlm(105_000_000n)).toBe('10.5000000');
    expect(formatXlm(1n)).toBe('0.0000001');
    expect(formatXlm(0n)).toBe('0.0000000');
    expect(formatXlm(-100_000_000n)).toBe('-10.0000000');
  });

  it('reads back with xlm', () => {
    for (const stroops of [0n, 1n, 99_999_999n, 9_223_372_036_854_775_807n]) {
      expect(xlm(formatXlm(stroops))).toBe(stroops);
    }
  });
});

describe('units', () => {
  it('scales by the given decimals', () => {
    expect(units('9.8', 7)).toBe(98_000_000n);
    expect(units('42', 0)).toBe(42n);
    expect(units('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(units('0.000001', 6)).toBe(1n);
  });

  it('rejects more fractional digits than decimals', () => {
    expect(() => units('1.5', 0)).toThrow(RangeError);
    expect(() => units('1.1234567', 6)).toThrow(/7 decimal places/);
  });

  it.each([-1, 1.5, Number.NaN])('rejects decimals %s', (decimals) => {
    expect(() => units('1', decimals)).toThrow(/decimals is/);
  });
});
