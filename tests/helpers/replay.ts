import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
  readonly result: unknown;
}

export interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export function recording(name: string): readonly RecordedCall[] {
  const file = new URL(`../fixtures/rpc/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { calls: RecordedCall[] })
    .calls;
}

export function recordedResult(name: string): Record<string, unknown> {
  const [call] = recording(name);
  return call?.result as Record<string, unknown>;
}

export function answer(reply: (request: RpcRequest) => unknown): typeof fetch {
  return async (_url, init) => {
    init?.signal?.throwIfAborted();
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    const result = await reply(request);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    );
  };
}

export function replay(...calls: readonly RecordedCall[]): typeof fetch {
  return answer(({ method, params }) => {
    const call = calls.find(
      (recorded) =>
        recorded.method === method &&
        isDeepStrictEqual(recorded.params, params),
    );
    if (!call) {
      throw new Error(`no recording for ${method} ${JSON.stringify(params)}`);
    }
    return call.result;
  });
}
