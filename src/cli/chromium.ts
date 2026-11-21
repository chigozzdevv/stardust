import { existsSync } from 'node:fs';
import { playwright } from '@/cli/runner';

export function installArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['install', 'chromium', ...(env.CI === 'true' ? ['--with-deps'] : [])];
}

export async function chromiumInstalled(): Promise<boolean> {
  const { chromium } = await import('@playwright/test');
  return existsSync(chromium.executablePath());
}

export async function ensureChromium(cwd: string): Promise<void> {
  if (await chromiumInstalled()) return;
  const args = installArgs();
  const code = await playwright(args, cwd);
  if (code !== 0) {
    throw new Error(
      `playwright ${args.join(' ')} exited with code ${code}. Check your connection and run stardust test again.`,
    );
  }
}
