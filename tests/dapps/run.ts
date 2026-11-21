import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Dapp {
  readonly repository: string;
  readonly commit: string;
  readonly install: string;
  readonly add: string;
  readonly build?: string;
}

const folder = import.meta.dirname;
const root = join(folder, '..', '..');
const checkouts = join(folder, '.checkouts');
const names = readdirSync(folder, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();

const args = process.argv.slice(2);
const chosen = args.filter((arg) => names.includes(arg));
const forwarded = args.filter((arg) => !names.includes(arg));
const tarball = pack();
const failed = (chosen.length > 0 ? chosen : names).filter(
  (name) => !test(name),
);

if (failed.length > 0) {
  console.error(`\nFailed on: ${failed.join(', ')}`);
  process.exit(1);
}

function pack(): string {
  const destination = mkdtempSync(join(tmpdir(), 'stardust-pack-'));
  run('pnpm', ['pack', '--pack-destination', destination], { cwd: root });
  const [file] = readdirSync(destination).filter((name) =>
    name.endsWith('.tgz'),
  );
  if (!file) throw new Error(`pnpm pack wrote no tarball to ${destination}.`);
  return join(destination, file);
}

function test(name: string): boolean {
  const dapp = JSON.parse(
    readFileSync(join(folder, name, 'dapp.json'), 'utf8'),
  ) as Dapp;
  const dir = join(checkouts, name);
  console.log(`\n${name}: ${dapp.repository} at ${dapp.commit.slice(0, 7)}`);

  checkout(dapp, dir);
  if (existsSync(join(dir, 'e2e'))) {
    throw new Error(
      `${name} has its own e2e folder at ${dapp.commit.slice(0, 7)}, so its Stardust specs can't be copied there.`,
    );
  }
  shell(dapp.install, dir);
  shell(`${dapp.add} ${tarball}`, dir);
  if (dapp.build) shell(dapp.build, dir);
  cpSync(
    join(folder, name, 'stardust.config.ts'),
    join(dir, 'stardust.config.ts'),
  );
  cpSync(join(folder, name, 'e2e'), join(dir, 'e2e'), { recursive: true });

  const stardust = join(dir, 'node_modules', '.bin', 'stardust');
  return attempt(stardust, ['test', ...forwarded], { cwd: dir });
}

function checkout(dapp: Dapp, dir: string): void {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    run('git', ['init', '-q'], { cwd: dir });
    run('git', ['remote', 'add', 'origin', dapp.repository], { cwd: dir });
  }
  run('git', ['fetch', '-q', '--depth', '1', 'origin', dapp.commit], {
    cwd: dir,
  });
  run('git', ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'], {
    cwd: dir,
  });
  run('git', ['clean', '-q', '-fd'], { cwd: dir });
}

function shell(command: string, cwd: string): void {
  run(command, [], { cwd, shell: true });
}

function run(command: string, list: string[], options: SpawnSyncOptions): void {
  if (!attempt(command, list, options)) {
    throw new Error(
      `${[command, ...list].join(' ')} failed in ${options.cwd}.`,
    );
  }
}

function attempt(
  command: string,
  list: string[],
  options: SpawnSyncOptions,
): boolean {
  const { status, error } = spawnSync(command, list, {
    stdio: 'inherit',
    ...options,
  });
  if (error) throw error;
  return status === 0;
}
