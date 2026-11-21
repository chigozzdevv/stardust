import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ZodError } from 'zod';
import { accountOptions, stardustConfig, testOptions } from '@/config/schema';
import type { TestOptions } from '@/config/schema';
import { StardustError } from '@/errors';

export interface StardustConfig {
  network: 'testnet' | { rpcUrl: string };
  app: {
    url: string;
    start?: string;
  };
  tests?: string;
}

export interface LoadedConfig {
  readonly network: StardustConfig['network'];
  readonly app: { readonly url: string; readonly start: string | null };
  readonly tests: string;
}

export function defineConfig(config: StardustConfig): StardustConfig {
  return config;
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const file = join(cwd, 'stardust.config.ts');
  if (!(await isFile(file))) {
    throw new StardustError(
      'CONFIG_NOT_FOUND',
      `no stardust.config.ts in ${cwd}. Run this from your project folder.`,
    );
  }
  const loaded = await load(file).catch((error: unknown) => {
    throw new StardustError(
      'CONFIG_INVALID',
      `stardust.config.ts couldn't be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  return parseConfig(defaultExport(loaded), cwd);
}

// In a test worker of a project without "type": "module", Playwright compiles
// the config to CommonJS, and on Node 22 import() then fails as soon as the
// config imports stardust-stellar. require() works there, and everywhere else
// except a config with top-level await.
async function load(file: string): Promise<{ default?: unknown }> {
  try {
    return createRequire(file)(file) as { default?: unknown };
  } catch (error) {
    if (codeOf(error) !== 'ERR_REQUIRE_ASYNC_MODULE') throw error;
    return import(pathToFileURL(file).href) as Promise<{ default?: unknown }>;
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

// Inside Playwright's test workers the config is compiled to CommonJS, which
// can wrap the default export in one more object.
function defaultExport({ default: value }: { default?: unknown }): unknown {
  return typeof value === 'object' &&
    value !== null &&
    '__esModule' in value &&
    'default' in value
    ? value.default
    : value;
}

export function parseConfig(input: unknown, cwd: string): LoadedConfig {
  if (
    typeof input === 'object' &&
    input !== null &&
    'network' in input &&
    input.network === 'local'
  ) {
    throw new StardustError(
      'NETWORK_NOT_SUPPORTED',
      "network 'local' isn't available in v1. Use 'testnet' or { rpcUrl }.",
    );
  }
  const result = stardustConfig.safeParse(input);
  if (!result.success) {
    throw new StardustError('CONFIG_INVALID', explain(result.error).join('\n'));
  }
  const { network, app, tests = './e2e' } = result.data;
  return {
    network,
    app: { url: app.url, start: app.start ?? null },
    tests: resolve(cwd, tests),
  };
}

export function parseTestOptions(file: string, input: unknown): TestOptions {
  const result = testOptions.safeParse(input);
  if (result.success) return result.data;
  const lines = explain(result.error).map((line) => `  ${line}`);
  throw new StardustError('CONFIG_INVALID', [file, ...lines].join('\n'));
}

export function checkAccountOptions(setting: string, input: unknown): void {
  const result = accountOptions.safeParse(input);
  if (!result.success) {
    throw new StardustError(
      'CONFIG_INVALID',
      explain(result.error, [setting]).join('\n'),
    );
  }
}

function explain(error: ZodError, root: readonly PropertyKey[] = []): string[] {
  return error.issues.flatMap((issue) => {
    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    return paths.flatMap((path) => {
      const setting = [...root, ...path].map(String).join('.');
      return (setting ? `${setting} ${issue.message}` : issue.message).split(
        '\n',
      );
    });
  });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
}
