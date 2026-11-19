import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import type * as varialSdk from '@stellar/varial-sdk';
import type { PageHost } from '@/wallet/wallet';

export type Binding = (origin: string, payload: unknown) => Promise<unknown>;

export type WalletPackage = typeof varialSdk;

export interface Posted {
  readonly data: unknown;
  readonly targetOrigin: string;
}

const require = createRequire(import.meta.url);

// A browser window with only what the page script and the wallet packages
// use. Each script runs in a vm context whose only global is `window`.
export class FakeWindow extends EventTarget {
  [name: string]: unknown;
  readonly location: URL;
  readonly top: FakeWindow;
  readonly crypto = globalThis.crypto;
  readonly CustomEvent = CustomEvent;
  readonly posted: Posted[] = [];
  readonly storage = new Map<string, string>();
  readonly localStorage = {
    getItem: (name: string) => this.storage.get(name) ?? null,
    setItem: (name: string, value: string) =>
      void this.storage.set(name, value),
    removeItem: (name: string) => void this.storage.delete(name),
  };

  constructor(url = 'https://app.test/', top?: FakeWindow) {
    super();
    this.location = new URL(url);
    this.top = top ?? this;
  }

  run(source: string): void {
    runInContext(source, createContext({ window: this }));
  }

  load(name: '@stellar/freighter-api' | '@stellar/varial-sdk'): WalletPackage {
    const module = { exports: {} };
    runInContext(
      readFileSync(require.resolve(name), 'utf8'),
      createContext({
        window: this,
        module,
        exports: module.exports,
        setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
        clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
      }),
    );
    return module.exports as WalletPackage;
  }

  expose(name: string, binding: Binding): void {
    this[name] = async (payload: unknown) =>
      structuredClone(
        await binding(this.location.origin, structuredClone(payload)),
      );
  }

  postMessage(data: unknown, targetOrigin: string): void {
    this.posted.push({ data, targetOrigin });
    if (targetOrigin === this.location.origin) this.receive(data, this);
  }

  receive(data: unknown, source: unknown): void {
    const message = structuredClone(data);
    queueMicrotask(() =>
      this.dispatchEvent(
        Object.assign(new Event('message'), { data: message, source }),
      ),
    );
  }
}

// Keeps what the wallet attaches and, as Playwright does, applies every
// binding and init script to each page opened after.
export class FakeHost implements PageHost {
  readonly bindings = new Map<string, Binding>();
  readonly scripts: string[] = [];

  async exposeBinding(name: string, handler: Binding): Promise<void> {
    this.bindings.set(name, handler);
  }

  async addInitScript(source: string): Promise<void> {
    this.scripts.push(source);
  }

  open(url?: string, top?: FakeWindow): FakeWindow {
    const window = new FakeWindow(url, top);
    this.bindings.forEach((handler, name) => window.expose(name, handler));
    this.scripts.forEach((source) => window.run(source));
    return window;
  }
}
