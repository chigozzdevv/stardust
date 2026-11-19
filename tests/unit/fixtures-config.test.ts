import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTestOptions } from '@/config/config';
import { specFile, usersView } from '@/test/fixtures';
import type { User, Users } from '@/test/fixtures';

const file = join(process.cwd(), 'e2e', 'orders.spec.ts');

function users(...names: string[]): Users {
  return Object.fromEntries(
    names.map((name) => [name, { name } as unknown as User]),
  );
}

describe('test.use({ stardust })', () => {
  it('names the spec file relative to the project folder', () => {
    expect(specFile(file)).toBe('e2e/orders.spec.ts');
  });

  it('fails with CONFIG_INVALID naming the file, the setting and its value', () => {
    expect(() =>
      parseTestOptions(specFile(file), {
        users: { maker: { accounts: { main: { fund: '5000' } } } },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: [
          'e2e/orders.spec.ts',
          "  users.maker.accounts.main.fund is '5000', but the maximum per account is '1000'.",
          "  Use '1000' or less, or spread the amount over several accounts.",
        ].join('\n'),
      }),
    );
    expect(() =>
      parseTestOptions(specFile(join(process.cwd(), 'e2e/swap.spec.ts')), {
        users: { trader: { wallet: 'freighter' } },
      }),
    ).toThrow(
      "e2e/swap.spec.ts\n  users.trader.wallet is 'freighter'. Use 'varial', 'sep60' or 'none'.",
    );
  });
});

describe('users', () => {
  it('gives the declared users by name', () => {
    const view = usersView(users('maker', 'trader'), 'e2e/orders.spec.ts');
    expect(view.maker?.name).toBe('maker');
    expect(Object.keys(view)).toEqual(['maker', 'trader']);
    const { trader } = view;
    expect(trader?.name).toBe('trader');
  });

  it('fails with CONFIG_INVALID for a user the file does not declare', () => {
    const view = usersView(users('maker', 'trader'), 'e2e/orders.spec.ts');
    expect(() => view.taker).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message:
          'e2e/orders.spec.ts\n  The test uses users.taker, but this file declares only maker and trader.',
      }),
    );
    expect(() => usersView(users('maker'), 'e2e/a.spec.ts').taker).toThrow(
      'but this file declares only maker.',
    );
    expect(
      () => usersView(users('maker', 'saver', 'trader'), 'e2e/a.spec.ts').taker,
    ).toThrow('but this file declares only maker, saver and trader.');
    expect(() => usersView({}, 'e2e/a.spec.ts').taker).toThrow(
      'e2e/a.spec.ts\n  The test uses users.taker, but this file declares no users. Declare them with test.use({ stardust: { users: { taker: {} } } }).',
    );
  });

  it("isn't mistaken for a promise and still prints", () => {
    const view = usersView(users('maker'), 'e2e/a.spec.ts');
    expect((view as { then?: unknown }).then).toBeUndefined();
    expect(String(view)).toBe('[object Object]');
    expect(Reflect.get(view, Symbol.iterator)).toBeUndefined();
  });
});
