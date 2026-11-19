import * as freighterApi from '@stellar/freighter-api';
import * as varialSdk from '@stellar/varial-sdk';

export type PackageName = 'freighter' | 'varial';

export type Message = Record<string, unknown>;

export interface Exchange {
  readonly request: Message;
  reply: Message | null;
}

export interface Outcome {
  readonly value: unknown;
  readonly exchanges: readonly Exchange[];
}

export interface TestPage {
  call(
    name: PackageName,
    method: string,
    args: readonly unknown[],
  ): Promise<Outcome>;
  send(fields: Message, timeout: number): Promise<Outcome>;
}

declare global {
  interface Window {
    conformance: TestPage;
  }
}

type Method = (...args: unknown[]) => Promise<unknown>;

const requestSource = 'FREIGHTER_EXTERNAL_MSG_REQUEST';
const responseSource = 'FREIGHTER_EXTERNAL_MSG_RESPONSE';
const packages = { freighter: freighterApi, varial: varialSdk };
const pending = new Map<unknown, Exchange>();
let exchanges: Exchange[] = [];

window.addEventListener('message', ({ data, source }) => {
  if (source !== window || typeof data !== 'object' || data === null) return;
  if (data.source === requestSource) {
    const exchange = { request: without(data, 'messageId'), reply: null };
    pending.set(data.messageId, exchange);
    exchanges.push(exchange);
  } else if (data.source === responseSource) {
    const exchange = pending.get(data.messagedId);
    if (exchange) exchange.reply = without(data, 'messagedId');
  }
});

window.conformance = {
  async call(name, method, args) {
    exchanges = [];
    const run = (packages[name] as unknown as Record<string, Method>)[method];
    if (!run) throw new Error(`${name} has no ${method}().`);
    const value = await run(...args);
    return { value, exchanges };
  },
  async send(fields, timeout) {
    exchanges = [];
    const messageId = Date.now() + Math.random();
    const replied = new Promise<void>((resolve) => {
      const listen = ({ data }: MessageEvent) => {
        if (data?.source !== responseSource || data.messagedId !== messageId) {
          return;
        }
        window.removeEventListener('message', listen);
        resolve();
      };
      window.addEventListener('message', listen);
      setTimeout(resolve, timeout);
    });
    window.postMessage(
      { source: requestSource, messageId, ...fields },
      window.location.origin,
    );
    await replied;
    return { value: null, exchanges };
  },
};

// Message IDs are random, so they are left out of what gets compared.
function without(data: Message, id: string): Message {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== id));
}
