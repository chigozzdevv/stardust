import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noIndexer } from '@conformance/indexer';

const repository = 'https://github.com/stellar/freighter.git';
const clones = join(import.meta.dirname, '.varial');

export default async function globalSetup(): Promise<void> {
  const tag = process.env.VARIAL_TAG || (await latestTag());
  process.env.VARIAL_TAG = tag;
  process.env.VARIAL_BUILD = await buildVarial(tag);
}

async function latestTag(): Promise<string> {
  const response = await fetch(
    'https://api.github.com/repos/stellar/freighter/releases/latest',
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} for Varial's latest release. Set VARIAL_TAG to a stellar/freighter release tag.`,
    );
  }
  const { tag_name: tag } = (await response.json()) as { tag_name: string };
  return tag;
}

async function buildVarial(tag: string): Promise<string> {
  const folder = varialFolder(tag);
  const build = join(folder, 'extension', 'build');
  if (existsSync(join(build, 'manifest.json'))) return build;
  if (!existsSync(folder)) {
    await run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      tag,
      repository,
      folder,
    ]);
  }
  const env = {
    ...process.env,
    INDEXER_URL: process.env.INDEXER_URL || noIndexer,
    INDEXER_V2_URL: process.env.INDEXER_V2_URL || noIndexer,
  };
  await run('yarn', ['install', '--immutable'], { cwd: folder, env });
  await run('yarn', ['build:extension'], { cwd: folder, env });
  return build;
}

export function varialFolder(tag: string): string {
  return join(clones, tag);
}

// Varial's e2e token on testnet, kept up to date with each release.
export function varialTestToken(tag: string): string | null {
  const source = join(
    varialFolder(tag),
    'extension/e2e-tests/helpers/test-token.ts',
  );
  if (!existsSync(source)) return null;
  const text = readFileSync(source, 'utf8');
  return /TEST_TOKEN_ADDRESS\s*=\s*"(C[A-Z2-7]{55})"/.exec(text)?.[1] ?? null;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} ${args.join(' ')} exited with ${code}.`),
          ),
    );
  });
}
