import type { ProviderInfo } from '@/protocols/sep60/sep60';

export type PageScriptOptions =
  | { readonly wallet: 'varial'; readonly binding: string }
  | {
      readonly wallet: 'sep60';
      readonly binding: string;
      readonly info: Omit<ProviderInfo, 'uuid'>;
    };

type Binding = (payload: object) => Promise<unknown>;

// Serialized into the page, so it must not use anything outside its body.
// Varial's content script and SEP-60's provider live in the top frame only.
export function install(options: PageScriptOptions): void {
  if (window.top !== window) return;
  const page = window as unknown as Record<string, unknown>;
  const call = (payload: object) => (page[options.binding] as Binding)(payload);

  if (options.wallet === 'varial') {
    page.freighter = true;
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.source !== 'FREIGHTER_EXTERNAL_MSG_REQUEST') return;
      const { messageId, ...request } = event.data;
      delete request.source;
      void call(request).then((reply) => {
        if (!reply) return;
        window.postMessage(
          {
            source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE',
            messagedId: messageId,
            ...reply,
          },
          window.location.origin,
        );
      });
    });
    return;
  }

  // crypto.randomUUID() needs a secure context, which http:// pages on a LAN
  // address aren't, so the UUIDv4 is built from random bytes.
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const uuid = hex.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
  const provider = Object.freeze({
    getAddress: () => call({ method: 'getAddress' }),
    getNetwork: () => call({ method: 'getNetwork' }),
    signTransaction: (xdr: string, opts?: object) =>
      call({ method: 'signTransaction', xdr, opts }),
    signAuthEntry: (authEntry: string, opts?: object) =>
      call({ method: 'signAuthEntry', authEntry, opts }),
    signMessage: (message: string, opts?: object) =>
      call({ method: 'signMessage', message, opts }),
  });
  const detail = Object.freeze({
    info: Object.freeze({ uuid, ...options.info }),
    provider,
  });
  const announce = () =>
    window.dispatchEvent(
      new window.CustomEvent('sep0060:announceProvider', { detail }),
    );
  window.addEventListener('sep0060:requestProvider', announce);
  announce();
}

export function pageScript(options: PageScriptOptions): string {
  return `(${install.toString()})(${JSON.stringify(options)});`;
}
