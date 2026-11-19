import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp } from '@/cli/app';

const node = JSON.stringify(process.execPath);

const server = `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync('server.pid', String(process.pid));
createServer((request, response) => response.end('ok')).listen(Number(process.argv[2]));
`;

// Starts the server as its own child, as pnpm dev starts next dev.
const dev = `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['server.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
`;

let dir: string;
let port: number;
let url: string;

beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'stardust-app-')));
  await writeFile(join(dir, 'server.mjs'), server);
  await writeFile(join(dir, 'dev.mjs'), dev);
  port = await freePort();
  url = `http://localhost:${port}`;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer().listen(0);
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function serverPid(): Promise<number> {
  const file = join(dir, 'server.pid');
  while (!existsSync(file)) await sleep(20);
  return Number(await readFile(file, 'utf8'));
}

describe('startApp', () => {
  it('starts the app, waits for it and stops the whole process tree', async () => {
    const start = `${node} dev.mjs ${port}`;
    const app = await startApp({ url, start }, dir, { timeoutMs: 10_000 });
    expect(app?.command).toBe(start);
    expect(await (await fetch(url)).text()).toBe('ok');
    const pid = await serverPid();
    await app?.stop();
    expect(alive(pid)).toBe(false);
    await expect(fetch(url)).rejects.toThrow();
  }, 20_000);

  it('starts nothing when something already answers', async () => {
    const running = createServer((request, response) => response.end('ok'));
    await new Promise<void>((resolve) => running.listen(port, resolve));
    try {
      const start = `${node} -e "require('fs').writeFileSync('started', '')"`;
      await expect(startApp({ url, start }, dir)).resolves.toBeNull();
      await sleep(200);
      expect(existsSync(join(dir, 'started'))).toBe(false);
    } finally {
      await new Promise((resolve) => running.close(resolve));
    }
  });

  it('says when nothing answers and app.start is not set', async () => {
    await expect(startApp({ url, start: null }, dir)).rejects.toThrow(
      `nothing answers at ${url} and app.start is not set. Start your app, or set app.start.`,
    );
  });

  it('stops the app when it does not respond in time', async () => {
    const start = `${node} dev.mjs ${await freePort()}`;
    await expect(
      startApp({ url, start }, dir, { timeoutMs: 1_500 }),
    ).rejects.toMatchObject({
      code: 'APP_NOT_REACHABLE',
      message: `${url} did not respond within 1.5s after "${start}"`,
    });
    expect(alive(await serverPid())).toBe(false);
  }, 10_000);

  it('fails at once when the start command exits with an error', async () => {
    await expect(
      startApp({ url, start: 'exit 3' }, dir, { timeoutMs: 10_000 }),
    ).rejects.toThrow(`"exit 3" exited with code 3 before ${url} responded`);
  });

  it('stops the app when the wait is interrupted', async () => {
    const interrupt = new AbortController();
    const start = `${node} dev.mjs ${await freePort()}`;
    const starting = startApp({ url, start }, dir, {
      signal: interrupt.signal,
    });
    const pid = await serverPid();
    interrupt.abort('SIGINT');
    await expect(starting).rejects.toBeDefined();
    expect(alive(pid)).toBe(false);
  }, 10_000);
});
