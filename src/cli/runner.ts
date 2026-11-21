import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandArgs } from '@/cli/args';
import type { LoadedConfig } from '@/config/load';

const require = createRequire(import.meta.url);

export function playwrightCli(): string {
  return require.resolve('@playwright/test/cli');
}

export function settingsFile(projectDir: string): string {
  return join(
    projectDir,
    'node_modules',
    '.cache',
    'stardust',
    'playwright.config.mjs',
  );
}

export function playwrightSettings(
  projectDir: string,
  config: LoadedConfig,
  show: boolean,
): object {
  return {
    testDir: config.tests,
    fullyParallel: true,
    timeout: 120_000,
    expect: { timeout: 15_000 },
    outputDir: join(projectDir, 'stardust-results'),
    reporter: 'list',
    use: {
      baseURL: config.app.url,
      browserName: 'chromium',
      headless: !show,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
    },
  };
}

export async function writeSettings(
  projectDir: string,
  config: LoadedConfig,
  show: boolean,
): Promise<string> {
  const file = settingsFile(projectDir);
  const settings = playwrightSettings(projectDir, config, show);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `export default ${JSON.stringify(settings, null, 2)};\n`,
  );
  return file;
}

export function testArgs(
  settings: string,
  { files, show, playwright }: CommandArgs,
): string[] {
  return [
    'test',
    '--config',
    settings,
    ...files,
    ...(show ? ['--headed'] : []),
    ...playwright,
  ];
}

export function playwright(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(process.execPath, [playwrightCli(), ...args], {
      cwd,
      stdio: 'inherit',
    });
    // The terminal already sends SIGINT to Playwright, and a second one skips its teardown.
    const forward = () => {
      if (signal?.reason !== 'SIGINT') child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', forward, { once: true });
    child.once('error', reject);
    child.once('exit', (code, name) => {
      signal?.removeEventListener('abort', forward);
      resolve(code ?? 128 + (name ? constants.signals[name] : 0));
    });
  });
}

export async function runTests(
  projectDir: string,
  config: LoadedConfig,
  args: CommandArgs,
  signal?: AbortSignal,
): Promise<number> {
  const settings = await writeSettings(projectDir, config, args.show);
  return playwright(testArgs(settings, args), projectDir, signal);
}
