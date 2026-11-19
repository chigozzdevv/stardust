import type { BrowserContext } from '@playwright/test';
import type { PageHost } from '@/wallet/wallet';

export type CallObserver = (payload: unknown) => void;

// Real wallets answer the top frame only. A script in an iframe can still call
// the binding directly, so those calls are refused here.
export function pageHost(
  context: BrowserContext,
  onCall?: CallObserver,
): PageHost {
  return {
    async exposeBinding(name, handler) {
      await context.exposeBinding(name, ({ page, frame }, payload: unknown) => {
        if (frame !== page.mainFrame()) {
          throw new Error(`${name} answers only the page's top frame.`);
        }
        const reply = handler(new URL(frame.url()).origin, payload);
        onCall?.(payload);
        return reply;
      });
    },
    async addInitScript(source) {
      await context.addInitScript(source);
    },
  };
}
