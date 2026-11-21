import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  playwrightCli,
  runTests,
  settingsFile,
  testArgs,
  writeSettings,
} from '@/cli/runner';
import type { LoadedConfig } from '@/config/load';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const playwrightTest = createRequire(import.meta.url).resolve(
  '@playwright/test',
);

let dir: string;
let config: LoadedConfig;

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'stardust-runner-')));
  config = {
    network: 'testnet',
    app: { url: 'http://localhost:3000', start: 'pnpm dev' },
    tests: join(dir, 'e2e'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeSettings', () => {
  it("writes Playwright's settings as a plain object with absolute paths", async () => {
    const file = await writeSettings(dir, config, false);
    expect(file).toBe(
      join(dir, 'node_modules/.cache/stardust/playwright.config.mjs'),
    );
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/^export default \{\n/);
    expect(text).not.toContain('import');
    const { default: settings } = await import(pathToFileURL(file).href);
    expect(settings).toEqual({
      testDir: join(dir, 'e2e'),
      fullyParallel: true,
      timeout: 120_000,
      expect: { timeout: 15_000 },
      outputDir: join(dir, 'stardust-results'),
      reporter: 'list',
      use: {
        baseURL: 'http://localhost:3000',
        browserName: 'chromium',
        headless: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
      },
    });
  });

  it('shows the browser for --show', async () => {
    const file = await writeSettings(dir, config, true);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('"headless": false');
  });
});

describe('testArgs', () => {
  it('passes the settings, the files, --headed and then the Playwright flags', () => {
    expect(
      testArgs('/p/settings.mjs', {
        files: ['e2e/swap.spec.ts', 'e2e/pay'],
        show: true,
        playwright: ['--grep', 'swap', '--headed'],
      }),
    ).toEqual([
      'test',
      '--config',
      '/p/settings.mjs',
      'e2e/swap.spec.ts',
      'e2e/pay',
      '--headed',
      '--grep',
      'swap',
      '--headed',
    ]);
    expect(
      testArgs('/p/settings.mjs', { files: [], show: false, playwright: [] }),
    ).toEqual(['test', '--config', '/p/settings.mjs']);
  });
});

describe('playwrightCli', () => {
  it("resolves Playwright's CLI from Stardust's own package folder", () => {
    expect(playwrightCli()).toBe(
      realpathSync(join(repo, 'node_modules/@playwright/test/cli.js')),
    );
  });
});

describe('runTests', () => {
  it('runs Playwright in the project folder and returns its exit code', async () => {
    await mkdir(config.tests);
    await writeFile(
      join(config.tests, 'list.spec.cjs'),
      [
        `const { writeFileSync } = require('node:fs');`,
        `const { test } = require(${JSON.stringify(playwrightTest)});`,
        `writeFileSync(${JSON.stringify(join(dir, 'cwd.txt'))}, process.cwd());`,
        `test('is listed', () => {});`,
      ].join('\n'),
    );
    const args = { files: [], show: false, playwright: ['--list'] };
    await expect(runTests(dir, config, args)).resolves.toBe(0);
    expect(await readFile(join(dir, 'cwd.txt'), 'utf8')).toBe(dir);
    await expect(readFile(settingsFile(dir), 'utf8')).resolves.toContain(
      '"fullyParallel": true',
    );
    await expect(
      runTests(dir, config, { ...args, files: ['missing.spec.cjs'] }),
    ).resolves.toBe(1);
  }, 60_000);
});
