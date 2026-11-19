import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { StardustError } from '@/errors';

export interface LockOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export async function withLock<T>(
  path: string,
  work: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  await acquire(path, options);
  try {
    return await work();
  } finally {
    await rm(path, { force: true });
  }
}

async function acquire(path: string, options: LockOptions): Promise<void> {
  const { timeoutMs = 60_000, intervalMs = 250 } = options;
  const deadline = Date.now() + timeoutMs;
  while (!(await create(path))) {
    const owner = await readOwner(path);
    if (owner !== null && !running(owner)) {
      await takeOver(path, options);
    } else if (Date.now() < deadline) {
      await sleep(intervalMs);
    } else {
      const holder = owner === null ? 'another process' : `process ${owner}`;
      throw new StardustError(
        'FUNDING_FAILED',
        `${path} is held by ${holder} and wasn't released within ${timeoutMs / 1000}s. Wait for the other Stardust run to finish, then try again.`,
      );
    }
  }
}

// Linking a complete file, rather than opening the lock with 'wx', means the
// lock never exists without its owner's PID.
async function create(path: string): Promise<boolean> {
  const draft = `${path}.${randomUUID()}`;
  await writeFile(draft, `${process.pid}\n`, { mode: 0o600 });
  try {
    await link(draft, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(draft, { force: true });
  }
}

// Processes that find the same stale lock take turns, so none of them can
// remove a lock another one has just taken.
async function takeOver(path: string, options: LockOptions): Promise<void> {
  await withLock(
    `${path}.takeover`,
    async () => {
      const owner = await readOwner(path);
      if (owner !== null && !running(owner)) await rm(path, { force: true });
    },
    options,
  );
}

async function readOwner(path: string): Promise<number | null> {
  const text = (await readFile(path, 'utf8').catch(() => '')).trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
