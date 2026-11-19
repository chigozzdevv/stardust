import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { findWalletsKit, kitSession } from '@/protocols/wallets-kit';

const kit = '@creit.tech/stellar-wallets-kit';
const folders: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stardust-kit-'));
  folders.push(dir);
  return dir;
}

function write(dir: string, file: string, contents: object | string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

// The layout dnt gives the kit: an exports map without ./package.json, and
// nested package.json files that only set the module type.
function installKit(root: string, version: string): void {
  const dir = join(root, 'node_modules', kit);
  write(dir, 'package.json', {
    name: kit,
    version,
    main: './script/mod.js',
    exports: {
      '.': { import: './esm/mod.js', require: './script/mod.js' },
    },
  });
  write(join(dir, 'script'), 'package.json', { type: 'commonjs' });
  write(join(dir, 'script'), 'mod.js', '');
  write(join(dir, 'esm'), 'package.json', { type: 'module' });
  write(join(dir, 'esm'), 'mod.js', '');
}

function project(): string {
  const dir = folder();
  write(dir, 'package.json', { name: 'app', private: true });
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('findWalletsKit', () => {
  it.each([
    ['1.9.5', 'freighter'],
    ['2.7.1', 'freighter'],
    ['2.8.0', 'varial'],
    ['2.10.0', 'varial'],
    ['3.0.0', 'varial'],
  ])('gives kit %s the module ID %s', (version, moduleId) => {
    const dir = project();
    installKit(dir, version);
    expect(findWalletsKit(dir)).toEqual({ version, moduleId });
  });

  it('reads the version even though the exports map hides package.json', () => {
    const dir = project();
    installKit(dir, '2.8.0');
    const require = createRequire(join(dir, 'package.json'));
    expect(() => require.resolve(`${kit}/package.json`)).toThrow(
      expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
    );
    expect(findWalletsKit(dir)?.version).toBe('2.8.0');
  });

  it('finds the kit where Node would, in a parent node_modules', () => {
    const root = folder();
    installKit(root, '2.7.1');
    const app = join(root, 'apps', 'web');
    write(app, 'package.json', { name: 'web' });
    expect(findWalletsKit(app)).toEqual({
      version: '2.7.1',
      moduleId: 'freighter',
    });
  });

  it("returns null when the kit isn't installed", () => {
    expect(findWalletsKit(project())).toBeNull();
    expect(findWalletsKit(folder())).toBeNull();
  });

  it('finds the kit installed in this repository', () => {
    const repository = fileURLToPath(new URL('../..', import.meta.url));
    expect(findWalletsKit(repository)).toEqual({
      version: '2.8.0',
      moduleId: 'varial',
    });
  });
});

describe('kitSession', () => {
  it("saves the module ID and address for the app's origin", () => {
    const address = Keypair.random().publicKey();
    expect(
      kitSession(
        { version: '2.8.0', moduleId: 'varial' },
        'http://localhost:3000/swap?pair=xlm',
        address,
      ),
    ).toEqual({
      origin: 'http://localhost:3000',
      localStorage: [
        { name: '@StellarWalletsKit/selectedModuleId', value: 'varial' },
        { name: '@StellarWalletsKit/activeAddress', value: address },
      ],
    });
  });
});
