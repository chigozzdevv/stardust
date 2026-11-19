#!/usr/bin/env node
import { constants } from 'node:os';
import { startApp } from '@/cli/app';
import type { StartedApp } from '@/cli/app';
import { parseArgs } from '@/cli/args';
import { ensureChromium } from '@/cli/browser';
import { runTests } from '@/cli/runner';
import { loadConfig } from '@/config/config';
import { Rpc, checkNetwork, resolveNetwork } from '@/network/network';
import { sep43Version, sep60Version } from '@/protocols/sep60/sep60';
import { varialVersion } from '@/protocols/varial/varial';

type Area = 'command' | 'config' | 'network' | 'browser' | 'app' | 'wallets';

class StartFailure extends Error {
  constructor(
    readonly area: Area,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function line(area: Area, message: string): string {
  return `stardust  ${area.padEnd(7)}  ${message}`;
}

async function step<T>(area: Area, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new StartFailure(area, error);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const projectDir = process.cwd();
  const args = await step('command', () => parseArgs(argv));
  const config = await step('config', () => loadConfig(projectDir));
  const { name, rpcUrl, protocolVersion } = await step('network', () =>
    checkNetwork(new Rpc(resolveNetwork(config.network))),
  );
  console.log(
    line('network', `${name} (${rpcUrl}, protocol ${protocolVersion}) ready`),
  );
  await step('browser', () => ensureChromium(projectDir));
  console.log(line('browser', 'chromium ready'));

  const interrupt = new AbortController();
  const stop = (signal: NodeJS.Signals) => interrupt.abort(signal);
  process.on('SIGINT', stop).on('SIGTERM', stop);
  let app: StartedApp | null = null;
  try {
    app = await step('app', () =>
      startApp(config.app, projectDir, { signal: interrupt.signal }),
    );
    console.log(
      line(
        'app',
        app
          ? `${app.command} -> ${config.app.url} ready`
          : `${config.app.url} already running`,
      ),
    );
    console.log(
      line(
        'wallets',
        `Varial ${varialVersion}, SEP-43 ${sep43Version}, SEP-60 ${sep60Version}`,
      ),
    );
    return await runTests(projectDir, config, args, interrupt.signal);
  } catch (error) {
    if (!interrupt.signal.aborted) throw error;
    return 128 + constants.signals[interrupt.signal.reason as NodeJS.Signals];
  } finally {
    if (app) {
      await app.stop();
      console.log(`\n${line('app', 'stopped')}`);
    }
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (!(error instanceof StartFailure)) throw error;
    for (const text of error.message.split('\n')) {
      console.error(line(error.area, text));
    }
    process.exit(1);
  },
);
