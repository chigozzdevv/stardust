import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withLock } from '@/funding/lock-file';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stardust-lock-'));
  path = join(dir, 'funder.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  if (!pid) throw new Error('could not start a short-lived process');
  return pid;
}

function counter() {
  let inside = 0;
  let most = 0;
  return {
    get most() {
      return most;
    },
    async work() {
      inside += 1;
      most = Math.max(most, inside);
      await sleep(10);
      inside -= 1;
    },
  };
}

describe('withLock', () => {
  it("holds a lock file with the owner's PID while the work runs", async () => {
    await expect(withLock(path, () => readFile(path, 'utf8'))).resolves.toBe(
      `${process.pid}\n`,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('releases the lock when the work fails', async () => {
    const failure = new Error('funding failed');
    await expect(withLock(path, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('lets one holder in at a time', async () => {
    const holders = counter();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withLock(path, () => holders.work(), { intervalMs: 1 }),
      ),
    );
    expect(holders.most).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('gives up with FUNDING_FAILED while a live process holds the lock', async () => {
    await writeFile(path, `${process.pid}\n`);
    await expect(
      withLock(path, async () => 'acquired', { timeoutMs: 50, intervalMs: 5 }),
    ).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      retryable: true,
      message: `${path} is held by process ${process.pid} and wasn't released within 0.05s. Wait for the other Stardust run to finish, then try again.`,
    });
    expect(await readFile(path, 'utf8')).toBe(`${process.pid}\n`);
  });

  it('takes over a lock whose process no longer exists', async () => {
    await writeFile(path, `${deadPid()}\n`);
    await expect(withLock(path, () => readFile(path, 'utf8'))).resolves.toBe(
      `${process.pid}\n`,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('waits while the owner runs and takes over once it exits', async () => {
    const owner = spawn(process.execPath, [
      '-e',
      'setTimeout(() => {}, 60_000)',
    ]);
    try {
      await writeFile(path, `${owner.pid}\n`);
      const waiting = withLock(path, () => readFile(path, 'utf8'), {
        intervalMs: 5,
      });
      await sleep(50);
      expect(await readFile(path, 'utf8')).toBe(`${owner.pid}\n`);
      owner.kill();
      await once(owner, 'exit');
      await expect(waiting).resolves.toBe(`${process.pid}\n`);
    } finally {
      owner.kill();
    }
  });

  it('lets only one of several waiters take over a stale lock', async () => {
    await writeFile(path, `${deadPid()}\n`);
    const holders = counter();
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        sleep(index % 3).then(() =>
          withLock(path, () => holders.work(), { intervalMs: 1 }),
        ),
      ),
    );
    expect(holders.most).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('never removes a lock that names no process', async () => {
    await writeFile(path, 'not a pid');
    await expect(
      withLock(path, async () => 'acquired', { timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toMatchObject({
      code: 'FUNDING_FAILED',
      message: expect.stringContaining(`${path} is held by another process`),
    });
    expect(await readFile(path, 'utf8')).toBe('not a pid');
  });
});
