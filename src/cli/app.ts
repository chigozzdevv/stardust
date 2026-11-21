import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LoadedConfig } from '@/config/load';
import { StardustError } from '@/errors';

export interface AppOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StartedApp {
  readonly command: string;
  stop(): Promise<void>;
}

const probeTimeoutMs = 10_000;
const pollMs = 250;

export async function startApp(
  { url, start }: LoadedConfig['app'],
  cwd: string,
  { timeoutMs = 60_000, signal }: AppOptions = {},
): Promise<StartedApp | null> {
  if (await answers(url, probeTimeoutMs, signal)) return null;
  if (start === null) {
    throw new StardustError(
      'APP_NOT_REACHABLE',
      `nothing answers at ${url} and app.start is not set. Start your app, or set app.start.`,
    );
  }
  const app = new AppProcess(start, cwd);
  try {
    await app.waitFor(url, timeoutMs, signal);
    return app;
  } catch (error) {
    await app.stop();
    throw error;
  }
}

class AppProcess implements StartedApp {
  private readonly child: ChildProcess;
  private failure: string | null = null;

  constructor(
    readonly command: string,
    cwd: string,
  ) {
    this.child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    });
    this.child.once('error', (error) => {
      this.failure = `couldn't start: ${error.message}`;
    });
    this.child.once('exit', (code, signal) => {
      if (code === 0) return;
      this.failure =
        code === null ? `was stopped by ${signal}` : `exited with code ${code}`;
    });
  }

  async waitFor(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await answers(url, deadline - Date.now(), signal)) return;
      if (this.failure) {
        throw new StardustError(
          'APP_NOT_REACHABLE',
          `"${this.command}" ${this.failure} before ${url} responded`,
        );
      }
      await sleep(pollMs, undefined, { signal });
    }
    throw new StardustError(
      'APP_NOT_REACHABLE',
      `${url} did not respond within ${timeoutMs / 1000}s after "${this.command}"`,
    );
  }

  async stop(): Promise<void> {
    const { pid } = this.child;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      await new Promise((resolve) =>
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
        }).once('close', resolve),
      );
      return;
    }
    signalGroup(pid, 'SIGTERM');
    if (await groupExits(pid, 5_000)) return;
    signalGroup(pid, 'SIGKILL');
    await groupExits(pid, 1_000);
  }
}

async function answers(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(Math.max(timeoutMs, 1));
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await response.body?.cancel();
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function groupExits(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}
