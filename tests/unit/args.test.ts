import { describe, expect, it } from 'vitest';
import { parseArgs } from '@/cli/args';

const unknownFlag = (flag: string) =>
  `unknown flag ${flag}. Put other flags after --, for example: stardust test -- --grep swap`;

describe('parseArgs', () => {
  it('runs every test with the browser hidden by default', () => {
    expect(parseArgs(['test'])).toEqual({
      files: [],
      show: false,
      playwright: [],
    });
  });

  it('takes files and --show in any order', () => {
    expect(
      parseArgs(['test', '--show', 'e2e/swap.spec.ts', 'e2e/pay']),
    ).toEqual({
      files: ['e2e/swap.spec.ts', 'e2e/pay'],
      show: true,
      playwright: [],
    });
  });

  it('passes everything after -- to Playwright unchanged', () => {
    expect(
      parseArgs(['test', 'e2e/swap.spec.ts', '--', '--grep', 'swap', '--show']),
    ).toEqual({
      files: ['e2e/swap.spec.ts'],
      show: false,
      playwright: ['--grep', 'swap', '--show'],
    });
    expect(parseArgs(['test', '--', '--', '-x']).playwright).toEqual([
      '--',
      '-x',
    ]);
  });

  it('names an unknown flag before -- and shows the fix', () => {
    expect(() => parseArgs(['test', '--grep', 'swap'])).toThrow(
      unknownFlag('--grep'),
    );
    expect(() => parseArgs(['test', '--grep=swap', '--', '-x'])).toThrow(
      unknownFlag('--grep'),
    );
    expect(() => parseArgs(['test', '-g', 'swap'])).toThrow(unknownFlag('-g'));
  });

  it('asks for the test command', () => {
    const usage = 'Run: stardust test [files] [--show] [-- flags]';
    expect(() => parseArgs([])).toThrow(`missing command. ${usage}`);
    expect(() => parseArgs(['run'])).toThrow(`unknown command run. ${usage}`);
    expect(() => parseArgs(['--show'])).toThrow(
      `unknown command --show. ${usage}`,
    );
  });
});
