import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface WalletsKit {
  readonly version: string;
  readonly moduleId: 'freighter' | 'varial';
}

export interface KitSession {
  origin: string;
  localStorage: { name: string; value: string }[];
}

const kitPackage = '@creit.tech/stellar-wallets-kit';

export function findWalletsKit(projectDir: string): WalletsKit | null {
  let entry: string;
  try {
    entry = createRequire(join(projectDir, 'package.json')).resolve(kitPackage);
  } catch {
    return null;
  }
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = readManifest(dir);
    if (manifest.name === kitPackage && typeof manifest.version === 'string') {
      return {
        version: manifest.version,
        moduleId: moduleId(manifest.version),
      };
    }
  }
  return null;
}

export function kitSession(
  kit: WalletsKit,
  appUrl: string,
  address: string,
): KitSession {
  return {
    origin: new URL(appUrl).origin,
    localStorage: [
      { name: '@StellarWalletsKit/selectedModuleId', value: kit.moduleId },
      { name: '@StellarWalletsKit/activeAddress', value: address },
    ],
  };
}

function moduleId(version: string): WalletsKit['moduleId'] {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 2 || (major === 2 && minor >= 8) ? 'varial' : 'freighter';
}

function readManifest(dir: string): { name?: unknown; version?: unknown } {
  try {
    return Object(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
  } catch {
    return {};
  }
}
